# What it does: groups a repo's files into architecture modules (no LLM)
#
# build_architecture(graph) picks the grouping that fits the repo:
#   directories  the shallowest directory depth giving 4–15 groups, none holding >60% of files
#   hybrid       directories, but the one oversized group is split into communities
#   communities  Louvain on the file call/import graph (flat or deeply lopsided repos)
# Tests, scripts, examples, docs, migrations and setup files are listed as "hidden".

import posixpath
import re
from collections import Counter, defaultdict

import networkx as nx

HIDDEN_DIRS = frozenset({"tests", "test", "scripts", "examples", "docs", "migrations"})
HIDDEN_FILES = frozenset({"setup.py", "conftest.py"})
MIN_GROUPS, MAX_GROUPS = 4, 15
MAX_SHARE = 0.6
MAX_DEPTH = 4
MIN_COMMUNITIES, MAX_COMMUNITIES = 3, 12
RESOLUTIONS = (0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0)
SEED = 42
MIN_EDGE_WEIGHT = 2
MAX_EDGES = 25
STANDALONE = "standalone"


def is_hidden(path: str) -> bool:
    parts = path.split("/")
    name = parts[-1]
    if any(p in HIDDEN_DIRS for p in parts[:-1]) or name in HIDDEN_FILES:
        return True
    return name.startswith("test_") or name.endswith("_test.py")


def _stem(path: str) -> str:
    name = posixpath.basename(path)
    if name == "__init__.py":
        return posixpath.basename(posixpath.dirname(path)) or "__init__"
    return name[:-3] if name.endswith(".py") else name


def _common_dir(paths: list[str]) -> list[str]:
    dirs = [p.split("/")[:-1] for p in paths]
    if not dirs:
        return []
    common = dirs[0]
    for d in dirs[1:]:
        n = 0
        while n < min(len(common), len(d)) and common[n] == d[n]:
            n += 1
        common = common[:n]
    return common


def _file_graph(graph: dict):
    """Undirected-ready weighted file graph + per-pair call/import counts (file → file)."""
    file_of = {n["id"]: n.get("file") or n["id"] for n in graph.get("nodes", [])}
    pairs = defaultdict(lambda: {"calls": 0, "imports": 0})
    for e in graph.get("edges", []):
        if e.get("type") not in ("calls", "imports"):
            continue
        a, b = file_of.get(e["source"]), file_of.get(e["target"])
        if not a or not b or a == b:
            continue
        pairs[(a, b)]["calls" if e["type"] == "calls" else "imports"] += 1
    return pairs


# ---------------------------------------------------------------------------
# Grouping strategies
# ---------------------------------------------------------------------------
def _directory_groups(files: list[str], depth: int) -> tuple[dict, int]:
    """
    Group by path prefix `depth` levels below the common directory; files shallower
    than that are grouped by their stem. Returns ({key: [files]}, number of real directory groups).
    """
    common = _common_dir(files)
    groups = defaultdict(list)
    dir_keys = set()
    for f in files:
        parts = f.split("/")
        rel_dirs = parts[len(common):-1]
        if len(rel_dirs) >= depth:
            key = "/".join(parts[: len(common) + depth])
            dir_keys.add(key)
        else:
            key = "/".join(parts[: len(common) + len(rel_dirs)] + [_stem(f)]) + ".py"
        groups[key].append(f)
    return dict(groups), len(dir_keys)


def _groups_ok(groups: dict, dir_count: int, total: int, check_share: bool = True) -> bool:
    n = len(groups)
    if not (MIN_GROUPS <= n <= MAX_GROUPS):
        return False
    # Mostly real directories: one-box-per-file is not an architecture
    if dir_count < 2 or dir_count * 2 < n:
        return False
    return not check_share or max(len(v) for v in groups.values()) <= MAX_SHARE * total


def _communities(files: list[str], pairs: dict, lo: int = MIN_COMMUNITIES, hi: int = MAX_COMMUNITIES) -> list[list[str]]:
    """Louvain communities of connected files (resolution searched for lo..hi groups) + standalone files."""
    G = nx.Graph()
    members = set(files)
    for f in sorted(files):
        G.add_node(f)
    for (a, b), w in sorted(pairs.items()):
        if a in members and b in members:
            weight = w["calls"] + w["imports"]
            if G.has_edge(a, b):
                G[a][b]["weight"] += weight
            else:
                G.add_edge(a, b, weight=weight)
    standalone = sorted(f for f in G.nodes if G.degree(f) == 0)
    G.remove_nodes_from(standalone)

    # Every resolution is tried; the result closest to ~sqrt(n) communities (inside lo..hi when
    # possible) wins, lowest resolution first on ties
    best = None
    n = G.number_of_nodes()
    if n:
        target = min(hi, max(lo, round(n ** 0.5)))
        best_score = None
        for res in RESOLUTIONS:
            comms = [sorted(c) for c in nx.community.louvain_communities(G, weight="weight", resolution=res, seed=SEED)]
            k = len(comms)
            outside = lo - k if k < lo else k - hi if k > hi else 0
            score = (outside, abs(k - target))
            if best_score is None or score < best_score:
                best, best_score = comms, score
    groups = sorted(best or [], key=lambda c: (-len(c), c[0]))
    if standalone:
        groups.append(standalone)
    return groups


# ---------------------------------------------------------------------------
# Module assembly
# ---------------------------------------------------------------------------
def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.+-]+", "-", text).strip("-") or "module"


def build_architecture(graph: dict) -> dict:
    nodes = graph.get("nodes", [])
    all_files = sorted(n["id"] for n in nodes if n.get("type") == "file")
    hidden = [f for f in all_files if is_hidden(f)]
    files = [f for f in all_files if not is_hidden(f)]
    pairs = _file_graph(graph)

    degree = Counter()
    for (a, b), w in pairs.items():
        degree[a] += w["calls"] + w["imports"]
        degree[b] += w["calls"] + w["imports"]

    # (key, kind, files): kind is "dir", "file" (stem group) or "community"
    raw_groups = []
    method = "communities"
    lopsided = None
    for depth in range(1, MAX_DEPTH + 1):
        groups, dir_count = _directory_groups(files, depth)
        if _groups_ok(groups, dir_count, len(files)):
            method = "directories"
            raw_groups = [(k, "file" if k.endswith(".py") else "dir", v) for k, v in sorted(groups.items())]
            break
        if lopsided is None and _groups_ok(groups, dir_count, len(files), check_share=False):
            lopsided = groups
    if method != "directories":
        if lopsided is not None:
            method = "hybrid"
            big = max(lopsided, key=lambda k: (len(lopsided[k]), k))
            for key, members in sorted(lopsided.items()):
                if key == big:
                    for comm in _communities(members, pairs, lo=2):
                        raw_groups.append((key, "community", comm))
                else:
                    raw_groups.append((key, "file" if key.endswith(".py") else "dir", members))
        elif files:
            raw_groups = [("", "community", c) for c in _communities(files, pairs)]

    # Labels. Communities are named after their best-connected file; when two hubs share a
    # stem (flask: app.py and sansio/app.py) the parent directory is added
    hubs = {}
    for i, (_key, kind, members) in enumerate(raw_groups):
        connected = [m for m in members if degree[m] > 0]
        if kind == "community" and connected:
            hubs[i] = min(connected, key=lambda m: (-degree[m], m))
    hub_stems = Counter(_stem(h) for h in hubs.values())
    modules = []
    for i, (key, kind, members) in enumerate(raw_groups):
        members = sorted(members)
        if kind == "community":
            hub = hubs.get(i)
            if hub is None:
                label = STANDALONE
            else:
                name = _stem(hub)
                parent = posixpath.basename(posixpath.dirname(hub))
                if hub_stems[name] > 1 and parent:
                    name = f"{parent}/{name}"
                others = len(members) - 1
                label = name + (f" + {others} files" if others > 1 else " + 1 file" if others == 1 else "")
        elif kind == "file":
            label = _stem(key)
        else:
            label = key.rsplit("/", 1)[-1]
        modules.append({"key": key, "label": label, "files": members})

    # Unique labels: qualify duplicates with their parent directory, then number them
    counts = Counter(m["label"] for m in modules)
    for m in modules:
        if counts[m["label"]] > 1 and m["key"] and "/" in m["key"].rstrip("/"):
            parent = m["key"].rsplit("/", 1)[0].rsplit("/", 1)[-1]
            m["label"] = f"{parent}/{m['label']}"
    seen = Counter()
    for m in modules:
        seen[m["label"]] += 1
        if seen[m["label"]] > 1:
            m["label"] = f"{m['label']} ({seen[m['label']]})"

    # Stats + ids
    by_file = defaultdict(lambda: {"functions": 0, "classes": 0, "entry": False})
    for n in nodes:
        f = n.get("file")
        if n.get("type") == "function":
            by_file[f]["functions"] += 1
        elif n.get("type") == "class":
            by_file[f]["classes"] += 1
        if n.get("is_entry_point") and n.get("type") != "file":
            by_file[f]["entry"] = True
    module_of = {}
    out_modules = []
    used_ids = set()
    for m in modules:
        mid = f"mod:{_slug(m['label'])}"
        while mid in used_ids:
            mid += "_"
        used_ids.add(mid)
        for f in m["files"]:
            module_of[f] = mid
        out_modules.append({
            "id": mid,
            "label": m["label"],
            "files": m["files"],
            "function_count": sum(by_file[f]["functions"] for f in m["files"]),
            "class_count": sum(by_file[f]["classes"] for f in m["files"]),
            "has_entry_points": any(by_file[f]["entry"] for f in m["files"]),
        })

    # Module edges: summed file-pair weights, no self-loops, weight ≥ 2, strongest 25
    agg = defaultdict(lambda: {"calls": 0, "imports": 0})
    for (a, b), w in pairs.items():
        ma, mb = module_of.get(a), module_of.get(b)
        if not ma or not mb or ma == mb:
            continue
        agg[(ma, mb)]["calls"] += w["calls"]
        agg[(ma, mb)]["imports"] += w["imports"]
    edges = [
        {"source": a, "target": b, "calls": w["calls"], "imports": w["imports"], "weight": w["calls"] + w["imports"]}
        for (a, b), w in agg.items()
        if w["calls"] + w["imports"] >= MIN_EDGE_WEIGHT
    ]
    edges.sort(key=lambda e: (-e["weight"], e["source"], e["target"]))

    return {"modules": out_modules, "edges": edges[:MAX_EDGES], "method": method, "hidden": hidden}
