# What it does: PR impact — which functions a pull request changes, what depends on them,
# breaking-change signals, a transparent risk score and a short summary.
#
# Inputs: the PR's file list (with patches) and the code graphs of its base and head commits.
#   1. Mapping: each changed line goes to the innermost function/class containing it — removed
#      lines in the BASE graph, added lines in the HEAD graph. Same qualified name on both
#      sides (renamed files matched by previous_filename) = modified; base only = removed;
#      head only = added. A different parameter count = signature change.
#   2. Blast radius: callers of the changed code, breadth-first over "calls" edges (BASE graph
#      from modified + removed nodes, HEAD graph from added nodes that are called), depth 1 =
#      direct callers, at most depth 4 and 500 nodes. A node reached only through name-matched
#      (inferred) calls is marked inferred and counts half in the score.
#   3. Breaking-change signals: a removed function whose callers remain; a signature change
#      whose callers were not updated; a new import cycle (files or modules); a new dependency
#      between modules.
#   4. Risk 0–100 from named factors (each with points and a reason); Low < 30 ≤ Medium ≤ 60 < High.

import asyncio
import logging
import math
from collections import defaultdict

import networkx as nx

from languages import registry
from pr_diff import parse_patch

logger = logging.getLogger("codegraph.pr")

MAX_DEPTH = 4
MAX_IMPACTED = 500
MAX_MAPPED_FILES = 300
HUB_SHARE = 0.05          # top 5% by call degree…
HUB_MIN_DEGREE = 3        # …with at least this many calls in or out
SUMMARY_WORDS = 120
AI_TIMEOUT_S = 25

# Breaking-change signal weights (risk points each; the factor is capped)
SIGNAL_POINTS = {"removed_but_called": 15, "signature_change": 12, "new_cycle": 12, "new_module_dependency": 6}
FACTOR_MAX = {"changed": 15, "blast": 25, "hubs": 15, "breaking": 40, "spread": 10, "tests": 10}

CODE_TYPES = ("function", "class")


# ---------------------------------------------------------------------------
# Graph helpers
# ---------------------------------------------------------------------------
def is_test_path(path: str) -> bool:
    parts = path.lower().split("/")
    name = parts[-1]
    if any(p in ("test", "tests", "__tests__", "spec", "specs", "testing") for p in parts[:-1]):
        return True
    if name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py":
        return True
    return registry.is_test(path)


class GraphIndex:
    """Lookups over one code graph."""

    def __init__(self, graph: dict | None):
        graph = graph or {"nodes": [], "edges": []}
        self.graph = graph
        self.nodes = {n["id"]: n for n in graph.get("nodes", [])}
        self.files = {n["id"] for n in graph.get("nodes", []) if n.get("type") == "file"}
        self.by_file = defaultdict(list)  # file → [(start, end, id)]
        self.by_qual = {}                 # (file, qualified name) → id
        for n in graph.get("nodes", []):
            if n.get("type") in CODE_TYPES and len(n.get("lines") or []) == 2:
                self.by_file[n["file"]].append((n["lines"][0], n["lines"][1], n["id"]))
                self.by_qual[(n["file"], n.get("qualified_name") or n.get("label"))] = n["id"]
        self.callers = defaultdict(list)  # target → [(source, exact)]
        self.degree = defaultdict(int)
        for e in graph.get("edges", []):
            if e.get("type") != "calls":
                continue
            self.callers[e["target"]].append((e["source"], e.get("confidence") != "inferred"))
            self.degree[e["source"]] += 1
            self.degree[e["target"]] += 1
        code = [nid for nid, n in self.nodes.items() if n.get("type") in CODE_TYPES]
        self.code_count = len(code)
        ranked = sorted(code, key=lambda nid: -self.degree[nid])
        top = ranked[: max(1, math.ceil(len(ranked) * HUB_SHARE))] if ranked else []
        self.hubs = {nid for nid in top if self.degree[nid] >= HUB_MIN_DEGREE}

    def innermost(self, path: str, line: int) -> str | None:
        """The smallest function/class span in `path` containing `line`."""
        best = None
        for start, end, nid in self.by_file.get(path, ()):
            if start <= line <= end and (best is None or (end - start, -start) < (best[0], best[1])):
                best = (end - start, -start, nid)
        return best[2] if best else None

    def counterpart(self, node: dict, path: str) -> str | None:
        return self.by_qual.get((path, node.get("qualified_name") or node.get("label")))

    def module_of(self) -> dict:
        arch = self.graph.get("architecture") or {}
        return {f: m["label"] for m in arch.get("modules", []) for f in m.get("files", [])}


# ---------------------------------------------------------------------------
# 1. Mapping
# ---------------------------------------------------------------------------
def map_changes(pr_files: list[dict], base: GraphIndex, head: GraphIndex, truncated: bool = False) -> tuple[dict, list, bool]:
    """
    (changes {key: entry}, files report, partial). Entry: id, base_id, head_id, kind
    (added|modified|removed), lines_added, lines_removed, signature_changed, params_before/after.
    """
    changes: dict[str, dict] = {}
    report: list[dict] = []
    partial = truncated

    def entry(key, **fields):
        e = changes.setdefault(key, {"id": key, "base_id": None, "head_id": None, "kind": None, "lines_added": 0, "lines_removed": 0})
        for k, v in fields.items():
            if k in ("lines_added", "lines_removed"):
                e[k] += v
            elif v is not None:
                e[k] = v
        return e

    for i, f in enumerate(pr_files):
        head_path = f["filename"]
        base_path = f.get("previous_filename") or f["filename"]
        status = f.get("status", "modified")
        row = {
            "filename": head_path, "previous_filename": f.get("previous_filename"), "status": status,
            "additions": f.get("additions", 0), "deletions": f.get("deletions", 0),
            "test": is_test_path(head_path), "mapped": False, "nodes": 0, "note": None,
        }
        report.append(row)
        if i >= MAX_MAPPED_FILES:
            row["note"] = f"Not mapped: only the first {MAX_MAPPED_FILES} files of a PR are analysed"
            partial = True
            continue
        in_base = base_path in base.files and status != "added"
        in_head = head_path in head.files and status != "removed"
        if not in_base and not in_head:
            if row["test"]:
                row["note"] = "Test file (not part of the graph)"
            elif registry.language_of(head_path):
                row["note"] = "Source file left out of the graph by the file selection rules (e.g. test-like names, generated or oversized files)"
            else:
                row["note"] = "Not source code CodeGraph analyses (docs, config or an unsupported language)"
            continue
        patch = f.get("patch")
        base_hits: dict[str, int] = defaultdict(int)
        head_hits: dict[str, int] = defaultdict(int)
        if patch is None and status == "added":
            for start, end, nid in head.by_file.get(head_path, ()):
                head_hits[nid] += end - start + 1
        elif patch is None and status == "removed":
            for start, end, nid in base.by_file.get(base_path, ()):
                base_hits[nid] += end - start + 1
        elif patch is None:
            if status == "renamed" and not row["additions"] and not row["deletions"]:
                row["mapped"] = True
                row["note"] = "Renamed without code changes"
            else:
                row["note"] = "Not mapped: GitHub didn't include this file's diff (too large or binary)"
                partial = True
            continue
        else:
            diff = parse_patch(patch)
            if in_base:
                for line in diff["removed"]:
                    nid = base.innermost(base_path, line)
                    if nid:
                        base_hits[nid] += 1
            if in_head:
                for line in diff["added"]:
                    nid = head.innermost(head_path, line)
                    if nid:
                        head_hits[nid] += 1

        touched = set()
        for nid, count in base_hits.items():
            twin = head.counterpart(base.nodes[nid], head_path) if in_head else None
            key = twin or nid
            entry(key, base_id=nid, head_id=twin, kind="modified" if twin else "removed", lines_removed=count)
            touched.add(key)
        for nid, count in head_hits.items():
            twin = base.counterpart(head.nodes[nid], base_path) if in_base else None
            e = entry(nid, head_id=nid, base_id=twin, lines_added=count)
            e["kind"] = "modified" if twin else "added"
            touched.add(nid)
        row["mapped"] = True
        row["nodes"] = len(touched)
        if not touched:
            row["note"] = "Changes outside functions and classes (imports, module-level code or comments)"

    for e in changes.values():
        b = base.nodes.get(e["base_id"]) if e["base_id"] else None
        h = head.nodes.get(e["head_id"]) if e["head_id"] else None
        node = h or b
        e.update({
            "label": node.get("label"), "qualified_name": node.get("qualified_name") or node.get("label"),
            "type": node.get("type"), "node_kind": node.get("kind"), "file": node.get("file"),
            "summary": (h or {}).get("summary") or (b or {}).get("summary") or "",
            "lines": node.get("lines"), "is_entry_point": bool((b or {}).get("is_entry_point") or (h or {}).get("is_entry_point")),
            "params_before": (b or {}).get("params"), "params_after": (h or {}).get("params"),
        })
        e["signature_changed"] = (
            e["kind"] == "modified" and node.get("type") == "function"
            and e["params_before"] is not None and e["params_after"] is not None
            and e["params_before"] != e["params_after"]
        )
    return changes, report, partial


# ---------------------------------------------------------------------------
# 2. Blast radius
# ---------------------------------------------------------------------------
def blast_radius(index: GraphIndex, seeds: set[str], exclude: set[str], max_depth: int = MAX_DEPTH, cap: int = MAX_IMPACTED) -> tuple[dict, bool]:
    """({node id: {depth, exact, via}}, capped). Callers of `seeds`, breadth first."""
    seen: dict[str, dict] = {}
    exact_of = {s: True for s in seeds}
    frontier = list(seeds)
    capped = False
    for depth in range(1, max_depth + 1):
        nxt = []
        for target in frontier:
            for source, exact in index.callers.get(target, ()):
                if source in seeds or source in exclude:
                    continue
                path_exact = exact and exact_of.get(target, True)
                hit = seen.get(source)
                if hit is None:
                    if len(seen) >= cap:
                        capped = True
                        continue
                    seen[source] = {"depth": depth, "exact": path_exact, "via": target}
                    exact_of[source] = path_exact
                    nxt.append(source)
                elif hit["depth"] == depth and path_exact and not hit["exact"]:
                    hit["exact"] = True
                    exact_of[source] = True
        frontier = nxt
        if not frontier:
            break
    return seen, capped


# ---------------------------------------------------------------------------
# 3. Breaking-change signals
# ---------------------------------------------------------------------------
def _still_there(base: GraphIndex, head: GraphIndex, caller_id: str) -> bool:
    node = base.nodes.get(caller_id)
    if not node:
        return False
    if caller_id in head.nodes:
        return True
    return head.counterpart(node, node.get("file")) is not None


def _file_of(index: GraphIndex, nid: str) -> str | None:
    n = index.nodes.get(nid)
    return n.get("file") if n else None


def _import_sccs(index: GraphIndex, module_of: dict | None = None) -> list[frozenset]:
    g = nx.DiGraph()
    for e in index.graph.get("edges", []):
        if e.get("type") != "imports":
            continue
        a, b = _file_of(index, e["source"]), _file_of(index, e["target"])
        if module_of is not None:
            a, b = module_of.get(a), module_of.get(b)
        if a and b and a != b:
            g.add_edge(a, b)
    return [frozenset(c) for c in nx.strongly_connected_components(g) if len(c) > 1]


def breaking_signals(changes: dict, base: GraphIndex, head: GraphIndex) -> list[dict]:
    signals = []
    changed_ids = {i for e in changes.values() for i in (e["base_id"], e["head_id"]) if i}

    def untouched_callers(base_id):
        out = []
        for source, _exact in base.callers.get(base_id, ()):
            if source not in changed_ids and _still_there(base, head, source) and base.nodes.get(source, {}).get("type") != "file":
                out.append(source)
        return sorted(set(out))

    for e in sorted(changes.values(), key=lambda x: x["id"]):
        if e["kind"] == "removed":
            callers = untouched_callers(e["base_id"])
            if callers:
                signals.append({
                    "kind": "removed_but_called", "node": e["id"], "label": e["qualified_name"], "callers": callers[:5],
                    "count": len(callers),
                    "message": f"{e['qualified_name']} was removed but {len(callers)} caller{'s' if len(callers) != 1 else ''} not changed in this PR still call{'s' if len(callers) == 1 else ''} it",
                })
        elif e.get("signature_changed"):
            callers = untouched_callers(e["base_id"])
            if callers:
                signals.append({
                    "kind": "signature_change", "node": e["id"], "label": e["qualified_name"], "callers": callers[:5],
                    "count": len(callers),
                    "message": f"{e['qualified_name']} now takes {e['params_after']} parameter{'s' if e['params_after'] != 1 else ''} (was {e['params_before']}); {len(callers)} caller{'s' if len(callers) != 1 else ''} weren't updated",
                })

    base_files = _import_sccs(base)
    for cycle in _import_sccs(head):
        if not any(cycle <= c for c in base_files):
            members = sorted(cycle)
            signals.append({"kind": "new_cycle", "level": "file", "members": members[:6], "count": len(members),
                            "message": f"New circular import between {len(members)} files: {', '.join(members[:3])}{'…' if len(members) > 3 else ''}"})
    base_mods = _import_sccs(base, base.module_of())
    for cycle in _import_sccs(head, head.module_of()):
        if not any(cycle <= c for c in base_mods):
            members = sorted(cycle)
            signals.append({"kind": "new_cycle", "level": "module", "members": members[:6], "count": len(members),
                            "message": f"New circular dependency between modules {', '.join(members[:4])}"})

    def arch_edges(index):
        arch = index.graph.get("architecture") or {}
        label = {m["id"]: m["label"] for m in arch.get("modules", [])}
        return {(label.get(e["source"]), label.get(e["target"])) for e in arch.get("edges", [])} - {(None, None)}

    base_edges = arch_edges(base)
    for source, target in sorted(arch_edges(head) - base_edges):
        if source and target:
            signals.append({"kind": "new_module_dependency", "source": source, "target": target,
                            "message": f"New dependency: {source} → {target}"})
    return signals


# ---------------------------------------------------------------------------
# 4. Risk
# ---------------------------------------------------------------------------
IRREGULAR = {"function or class": "functions or classes"}


def _plural(n, word):
    return f"{n} {word if n == 1 else IRREGULAR.get(word, word + 's')}"


def risk_score(*, changes: dict, impacted: dict, graph_size: int, hubs_touched: list[str], signals: list[dict],
               modules: list[str], source_changed: bool, tests_changed: int) -> dict:
    """{score, level, factors: [{key, label, points, max, reason}]}. Pure function of its inputs."""
    counts = defaultdict(int)
    for e in changes.values():
        counts[e["kind"]] += 1
    n = len(changes)
    factors = []

    factors.append({
        "key": "changed", "label": "Changed code", "max": FACTOR_MAX["changed"],
        "points": min(FACTOR_MAX["changed"], n),
        "reason": (f"{_plural(n, 'function or class')} changed ({counts['added']} added, {counts['modified']} modified, {counts['removed']} removed)"
                   if n else "No functions or classes changed"),
    })

    weighted = sum(1 if v["exact"] else 0.5 for v in impacted.values())
    share = weighted / max(graph_size, 1)
    direct = sum(1 for v in impacted.values() if v["depth"] == 1)
    factors.append({
        "key": "blast", "label": "Blast radius", "max": FACTOR_MAX["blast"],
        "points": min(FACTOR_MAX["blast"], round(100 * share)),
        "reason": (f"{_plural(len(impacted), 'function')} depend on the changes ({direct} direct) — {share:.0%} of the codebase"
                   + ("; name-matched links count half" if any(not v["exact"] for v in impacted.values()) else "")
                   if impacted else "Nothing else in the codebase calls the changed code"),
    })

    factors.append({
        "key": "hubs", "label": "Entry points and hubs", "max": FACTOR_MAX["hubs"],
        "points": min(FACTOR_MAX["hubs"], 5 * len(hubs_touched)),
        "reason": (f"Touches {', '.join(hubs_touched[:3])}{'…' if len(hubs_touched) > 3 else ''} (entry point or one of the most-connected 5%)"
                   if hubs_touched else "No entry points or highly connected functions changed"),
    })

    breaking_points = sum(SIGNAL_POINTS.get(s["kind"], 0) for s in signals)
    factors.append({
        "key": "breaking", "label": "Breaking-change signals", "max": FACTOR_MAX["breaking"],
        "points": min(FACTOR_MAX["breaking"], breaking_points),
        "reason": f"{_plural(len(signals), 'signal')}: " + "; ".join(s["message"] for s in signals[:2]) + ("…" if len(signals) > 2 else "")
        if signals else "None found",
    })

    m = len(modules)
    factors.append({
        "key": "spread", "label": "Cross-module spread", "max": FACTOR_MAX["spread"],
        "points": min(FACTOR_MAX["spread"], 3 * (m - 1)) if m > 1 else 0,
        "reason": f"Affects {_plural(m, 'module')}: {', '.join(modules[:4])}{'…' if m > 4 else ''}" if m else "No modules affected",
    })

    no_tests = source_changed and tests_changed == 0
    factors.append({
        "key": "tests", "label": "Tests", "max": FACTOR_MAX["tests"],
        "points": FACTOR_MAX["tests"] if no_tests else 0,
        "reason": ("Source code changed but no test files did" if no_tests
                   else f"{_plural(tests_changed, 'test file')} changed" if tests_changed else "No source code changed"),
    })

    score = min(100, sum(f["points"] for f in factors))
    level = "low" if score < 30 else "medium" if score <= 60 else "high"
    return {"score": score, "level": level, "factors": factors}


# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------
def deterministic_summary(meta: dict, changes: dict, impacted: dict, modules: list[str], signals: list[dict], risk: dict) -> str:
    if not changes:
        return "This PR doesn't change any analysed functions or classes, so nothing else in the code graph depends on it."
    counts = defaultdict(int)
    for e in changes.values():
        counts[e["kind"]] += 1
    parts = [f"{counts[k]} {k}" for k in ("modified", "added", "removed") if counts[k]]
    top = sorted(changes.values(), key=lambda e: -(e["lines_added"] + e["lines_removed"]))[:3]
    text = f"Changes {_plural(len(changes), 'function or class')} ({', '.join(parts)}), mainly {', '.join(e['qualified_name'] for e in top)}."
    if impacted:
        direct = sum(1 for v in impacted.values() if v["depth"] == 1)
        text += f" {_plural(len(impacted), 'function')} depend on them ({direct} direct callers)"
        text += f" across {', '.join(modules[:3])}." if modules else "."
    else:
        text += " Nothing else calls the changed code."
    if signals:
        text += " Review carefully: " + "; ".join(s["message"] for s in signals[:2]) + "."
    else:
        hot = max(risk["factors"], key=lambda f: f["points"])
        if hot["points"]:
            text += f" Main risk: {hot['reason'][0].lower()}{hot['reason'][1:]}."
    return text


SUMMARY_SYSTEM = (
    "You summarise pull requests for code reviewers. Use ONLY the facts given; never guess at code you "
    f"were not shown. Plain prose, at most {SUMMARY_WORDS} words, no lists, no headings. Say what changed, "
    "what depends on it, and what a reviewer should check carefully."
)


def summary_prompt(meta: dict, changes: dict, impacted: dict, modules: list[str], signals: list[dict], risk: dict) -> str:
    lines = [f"PR #{meta['number']}: {meta['title']}", f"Risk: {risk['level']} ({risk['score']}/100)", "Changed code:"]
    for e in sorted(changes.values(), key=lambda x: -(x["lines_added"] + x["lines_removed"]))[:15]:
        sig = f", signature {e['params_before']}→{e['params_after']} params" if e.get("signature_changed") else ""
        about = f" — {e['summary'][:160]}" if e.get("summary") else ""
        lines.append(f"- {e['kind']} {e['qualified_name']} in {e['file']} (+{e['lines_added']}/-{e['lines_removed']}{sig}){about}")
    direct = sum(1 for v in impacted.values() if v["depth"] == 1)
    lines.append(f"Dependents: {len(impacted)} functions ({direct} direct callers)")
    if modules:
        lines.append(f"Affected modules: {', '.join(modules[:8])}")
    for s in signals[:6]:
        lines.append(f"Signal: {s['message']}")
    for f in risk["factors"]:
        if f["points"]:
            lines.append(f"Risk factor {f['label']} (+{f['points']}): {f['reason']}")
    return "\n".join(lines)


def _clip_words(text: str, limit: int = SUMMARY_WORDS) -> str:
    words = text.split()
    return text.strip() if len(words) <= limit else " ".join(words[:limit]).rstrip(",;:") + "…"


async def ai_summary(prompt: str) -> str | None:
    """Groq, then Mistral; None when neither answers in time (the caller falls back to rules)."""
    import enrichment

    for call in (enrichment._call_groq, enrichment._call_mistral):
        try:
            text = await asyncio.wait_for(call(prompt, SUMMARY_SYSTEM), timeout=AI_TIMEOUT_S)
        except Exception as e:  # rate limits, timeouts, missing keys: try the next one
            logger.info(f"[pr] summary model unavailable: {type(e).__name__}")
            continue
        text = (text or "").strip()
        if text:
            return _clip_words(" ".join(text.split()))
    return None


# ---------------------------------------------------------------------------
# Everything together
# ---------------------------------------------------------------------------
def _slim(node: dict, **extra) -> dict:
    keep = ("id", "label", "type", "kind", "lang", "file", "qualified_name", "lines", "centrality", "is_entry_point", "summary", "params")
    out = {k: node[k] for k in keep if k in node}
    out.update(extra)
    return out


def analyse(meta: dict, pr_files: list[dict], base_graph: dict, head_graph: dict, truncated: bool = False) -> dict:
    """The PR result (without the summary text, which may need the LLM)."""
    base, head = GraphIndex(base_graph), GraphIndex(head_graph)
    changes, files, partial = map_changes(pr_files, base, head, truncated)
    changed_ids = {i for e in changes.values() for i in (e["base_id"], e["head_id"]) if i}

    base_seeds = {e["base_id"] for e in changes.values() if e["kind"] in ("modified", "removed") and e["base_id"]}
    head_seeds = {e["head_id"] for e in changes.values() if e["kind"] == "added" and head.callers.get(e["head_id"])}
    impacted_base, capped_a = blast_radius(base, base_seeds, changed_ids)
    impacted_head, capped_b = blast_radius(head, head_seeds, changed_ids, cap=max(0, MAX_IMPACTED - len(impacted_base)))
    impacted = {nid: {**v, "side": "base"} for nid, v in impacted_base.items()}
    for nid, v in impacted_head.items():
        if nid not in impacted or v["depth"] < impacted[nid]["depth"]:
            impacted[nid] = {**v, "side": "head"}

    # Callers per changed node (direct, in the graph of its side)
    for e in changes.values():
        side, nid = (base, e["base_id"]) if e["base_id"] else (head, e["head_id"])
        e["callers"] = len({s for s, _ in side.callers.get(nid, ()) if s not in changed_ids})

    signals = breaking_signals(changes, base, head)
    breaking_nodes = {s["node"] for s in signals if s.get("node")}
    for e in changes.values():
        e["breaking"] = e["id"] in breaking_nodes

    # Modules: of the changed and impacted code
    head_mod, base_mod = head.module_of(), base.module_of()
    module_counts = defaultdict(lambda: {"changed": 0, "impacted": 0})
    for e in changes.values():
        label = head_mod.get(e["file"]) or base_mod.get(e["file"])
        e["module"] = label
        if label:
            module_counts[label]["changed"] += 1
    for nid, v in impacted.items():
        index = base if v["side"] == "base" else head
        f = _file_of(index, nid)
        label = (base_mod if v["side"] == "base" else head_mod).get(f)
        v["module"] = label
        if label:
            module_counts[label]["impacted"] += 1
    modules = sorted(module_counts, key=lambda m: (-module_counts[m]["changed"], -module_counts[m]["impacted"], m))

    hubs_touched = sorted({
        e["qualified_name"] for e in changes.values()
        if e["is_entry_point"] or (e["base_id"] in base.hubs) or (e["head_id"] in head.hubs)
    })
    source_rows = [r for r in files if r["mapped"] and r["nodes"] and not r["test"]]
    tests_changed = sum(1 for r in files if r["test"])
    risk = risk_score(
        changes=changes, impacted=impacted, graph_size=max(base.code_count, head.code_count),
        hubs_touched=hubs_touched, signals=signals, modules=modules,
        source_changed=bool(source_rows), tests_changed=tests_changed,
    )

    # Subgraph for the blast-radius canvas: changed + impacted nodes, their files, calls between them
    sub_nodes: dict[str, dict] = {}
    for e in changes.values():
        index, nid = (head, e["head_id"]) if e["head_id"] else (base, e["base_id"])
        sub_nodes[nid] = _slim(index.nodes[nid], pr_change=e["kind"], pr_breaking=e["breaking"], pr_signature=e["signature_changed"])
    for nid, v in impacted.items():
        index = base if v["side"] == "base" else head
        if nid in index.nodes and nid not in sub_nodes:
            sub_nodes[nid] = _slim(index.nodes[nid], pr_depth=v["depth"], pr_exact=v["exact"])
    for node in list(sub_nodes.values()):
        f = node.get("file")
        if f and f not in sub_nodes:
            src = head.nodes.get(f) or base.nodes.get(f)
            if src:
                sub_nodes[f] = _slim(src, pr_file=True)
    sub_edges, seen_edges = [], set()
    for index in (base, head):
        for e in index.graph.get("edges", []):
            if e.get("type") not in ("calls", "defines"):
                continue
            key = (e["source"], e["target"], e["type"])
            if key in seen_edges or e["source"] not in sub_nodes or e["target"] not in sub_nodes:
                continue
            seen_edges.add(key)
            sub_edges.append({"source": e["source"], "target": e["target"], "type": e["type"], "confidence": e.get("confidence", "exact")})

    def arch_view(index):
        arch = index.graph.get("architecture") or {}
        return {"modules": arch.get("modules", []), "edges": arch.get("edges", []), "groups": arch.get("groups", []),
                "hidden": arch.get("hidden", []), "method": arch.get("method")}

    counts = defaultdict(int)
    for e in changes.values():
        counts[e["kind"]] += 1
    return {
        "pr": meta,
        "partial": partial,
        "changes": sorted(changes.values(), key=lambda e: (e.get("module") or "", e["file"] or "", (e.get("lines") or [0])[0])),
        "impacted": [{"id": nid, "label": (base.nodes.get(nid) or head.nodes.get(nid) or {}).get("label", nid), **v} for nid, v in
                     sorted(impacted.items(), key=lambda kv: (kv[1]["depth"], kv[0]))],
        "impacted_capped": capped_a or capped_b,
        "modules": [{"label": m, **module_counts[m]} for m in modules],
        "signals": signals,
        "risk": risk,
        "files": files,
        "subgraph": {
            "repo": meta["full_name"], "commit_sha": meta["head_sha"][:8], "nodes": list(sub_nodes.values()), "edges": sub_edges,
            "architecture": (head_graph or {}).get("architecture"),
        },
        "architecture": {"base": arch_view(base), "head": arch_view(head)},
        "stats": {
            "changed": len(changes), "added": counts["added"], "modified": counts["modified"], "removed": counts["removed"],
            "impacted": len(impacted), "direct_callers": sum(1 for v in impacted.values() if v["depth"] == 1),
            "graph_size": max(base.code_count, head.code_count),
            "files": len(files), "files_mapped": sum(1 for r in files if r["mapped"]),
            "tests_changed": tests_changed,
        },
    }


async def summarise(result: dict) -> dict:
    """Adds result["summary"] = {text, source: "ai" | "rules"}; never raises."""
    changes = {e["id"]: e for e in result["changes"]}
    impacted = {i["id"]: i for i in result["impacted"]}
    modules = [m["label"] for m in result["modules"]]
    facts = (result["pr"], changes, impacted, modules, result["signals"], result["risk"])
    text = None
    if changes:
        try:
            text = await ai_summary(summary_prompt(*facts))
        except Exception as e:
            logger.warning(f"[pr] summary failed: {type(e).__name__}")
    result["summary"] = {"text": text, "source": "ai"} if text else {"text": deterministic_summary(*facts), "source": "rules"}
    return result
