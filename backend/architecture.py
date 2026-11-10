# What it does: groups a repo's files into architecture modules (no LLM)
#
# build_architecture(graph) respects real directories:
#   1. Root: the files' common directory; a folder holding >60% of the files becomes the root.
#   2. Depth: the shallowest depth with ≥3 real folders (≥2 source files each, none >60% of
#      files), else the shallowest with at least one. Each real folder is a module.
#   3. Loose files directly in the root join the folder they are most connected to
#      (weight ≥3, ≥2× the next best folder, ≥ their weight to other loose files).
#   4. Other loose files are clustered among themselves with Louvain (~√n groups); the
#      smallest clusters merge into "core" when there would be more than 15 modules.
#   Without any real folder, the whole repo is clustered with Louvain.
#   5. Multi-app repos (fewer than 4 modules, or no links between them): each top-level
#      folder is grouped again inside, by the same rules (at most 2 more levels). Its
#      modules get "parent" = the group id; "groups" lists the containers.
# A folder counts when it has ≥2 source files, or one file defining ≥3 functions/classes.
# method: "directories" (folders only), "hybrid" (folders + clusters), "communities".
# Tests, scripts, examples, docs, migrations, setup and config files are listed as "hidden".

import posixpath
import re
from collections import Counter, defaultdict

import networkx as nx

from languages import registry

HIDDEN_DIRS = frozenset({"tests", "test", "scripts", "examples", "docs", "migrations"})
HIDDEN_FILES = frozenset({"setup.py", "conftest.py", "gulpfile.js", "Gruntfile.js"})
# Tooling config (vite.config.js, tailwind.config.ts, jest.config.cjs…) is not architecture
CONFIG_FILE_RE = re.compile(r"\.config\.[cm]?[jt]s$|^\.[\w-]+rc\.[cm]?[jt]s$")
MAX_MODULES = 15
MAX_SHARE = 0.6
MIN_DIR_FILES = 2        # a folder with fewer source files is not a module…
MIN_SINGLE_FILE_SYMBOLS = 3  # …unless its one file defines this many functions/classes
MIN_TOP_MODULES = 4      # fewer top-level modules (or no links between them): group inside
MAX_EXTRA_LEVELS = 2     # how far a group may look below its own folder
MIN_DIR_MODULES = 3      # preferred number of folder modules when choosing the depth
ATTACH_MIN_WEIGHT = 3    # a loose root file joins a folder at this edge weight…
ATTACH_RATIO = 2         # …if it is at least this many times the next best folder
INFERRED_WEIGHT = 0.5    # name-only (inferred) calls count half when deciding attachment
CORE = "core"
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
    if name.startswith("test_") or name.endswith("_test.py"):
        return True
    if CONFIG_FILE_RE.search(name):
        return True
    # Other languages: __tests__/, *.test.*, *.spec.*, src/test/, *_test.go…
    return not name.endswith(".py") and registry.is_test(path)


# Files named after their package rather than themselves
PACKAGE_FILE_STEMS = frozenset({"__init__", "mod", "index"})
GENERIC_DIR_NAMES = frozenset({"src", "lib", "app", "pkg", "source"})


def _stem(path: str) -> str:
    """File name without extension; a package file (__init__.py, mod.rs, index.js) is named after its directory."""
    name = posixpath.basename(path)
    stem = posixpath.splitext(name)[0] if registry.language_of(name) else name
    if stem in PACKAGE_FILE_STEMS:
        parent = posixpath.dirname(path)
        name = posixpath.basename(parent) or stem
        if name in GENERIC_DIR_NAMES and posixpath.dirname(parent):
            name = f"{posixpath.basename(posixpath.dirname(parent))}/{name}"  # server/src, not src
        return name
    return stem


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
    pairs = defaultdict(lambda: {"calls": 0, "imports": 0, "strength": 0.0})
    for e in graph.get("edges", []):
        if e.get("type") not in ("calls", "imports"):
            continue
        a, b = file_of.get(e["source"]), file_of.get(e["target"])
        if not a or not b or a == b:
            continue
        pairs[(a, b)]["calls" if e["type"] == "calls" else "imports"] += 1
        # Evidence strength: a call linked only by name (inferred) counts half
        pairs[(a, b)]["strength"] += INFERRED_WEIGHT if e.get("confidence") == "inferred" else 1.0
    return pairs


# ---------------------------------------------------------------------------
# Grouping strategies
# ---------------------------------------------------------------------------
DIR, FILE, COMMUNITY = "dir", "file", "community"


def _folders_at(files: list[str], root: list[str], depth: int, symbols: dict) -> tuple[dict, list[str]]:
    """
    Folders `depth` levels below `root` with ≥MIN_DIR_FILES files, or one file defining
    ≥MIN_SINGLE_FILE_SYMBOLS functions/classes ({key: [files]}), and the loose files:
    files outside the root, shallower than `depth`, or in a smaller folder.
    """
    groups = defaultdict(list)
    loose = []
    for f in files:
        parts = f.split("/")
        if parts[: len(root)] != root or len(parts) - 1 - len(root) < depth:
            loose.append(f)
        else:
            groups["/".join(parts[: len(root) + depth])].append(f)
    real = {}
    for key, members in groups.items():
        if len(members) >= MIN_DIR_FILES or symbols.get(members[0], 0) >= MIN_SINGLE_FILE_SYMBOLS:
            real[key] = sorted(members)
        else:
            loose.extend(members)
    return real, sorted(loose)


def _choose_folders(files: list[str], symbols: dict, root: list[str] | None = None,
                    max_levels: int = MAX_DEPTH) -> tuple[list[str], dict, list[str]] | None:
    """
    (root, folder modules, loose files) at the chosen depth, or None when there is no real
    folder. `root` and `max_levels` bound the search inside a group (levels below `root`).
    """
    total = len(files)
    start = root if root is not None else _common_dir(files)
    root = start
    for _ in range(max_levels):  # descend into a folder that holds most of the files
        top, _loose = _folders_at(files, root, 1, symbols)
        dominant = sorted(k for k, v in top.items() if len(v) > MAX_SHARE * total)
        if not dominant or len(dominant[0].split("/")) - len(start) >= max_levels:
            break
        root = dominant[0].split("/")
    fallback = None
    for depth in range(1, max_levels - (len(root) - len(start)) + 1):
        real, loose = _folders_at(files, root, depth, symbols)
        if not real or max(len(v) for v in real.values()) > MAX_SHARE * total:
            continue
        if len(real) >= MIN_DIR_MODULES:
            return root, real, loose
        fallback = fallback or (root, real, loose)
    return fallback


def _attach_loose(root: list[str], real: dict, loose: list[str], pairs: dict, total: int) -> tuple[dict, list[str]]:
    """
    Loose files directly in the root join their most-connected folder when the link is clear
    (weights are evidence strength: an inferred call counts half):
    weight ≥ ATTACH_MIN_WEIGHT, ≥ ATTACH_RATIO × the next-best folder, and at least the file's
    weight to the other loose files (otherwise it belongs with them: cobra's root package is
    not part of doc/ just because doc/ calls it). No folder grows past MAX_SHARE of the files.
    """
    folder_of = {f: key for key, members in real.items() for f in members}
    loose_set = set(loose)
    to_folder = defaultdict(Counter)  # loose file → {folder: weight}
    to_loose = Counter()              # loose file → weight to other loose files
    imports_folder = set()            # (loose file, folder) pairs linked by any import
    for (a, b), w in pairs.items():
        n = w["strength"]
        calls_only = n - w["imports"]
        if a in folder_of and b in loose_set:
            to_folder[b][folder_of[a]] += calls_only
            if w["imports"]:
                imports_folder.add((b, folder_of[a]))
        elif b in folder_of and a in loose_set:
            to_folder[a][folder_of[b]] += calls_only
            if w["imports"]:
                imports_folder.add((a, folder_of[b]))
        elif a in loose_set and b in loose_set:
            to_loose[a] += n
            to_loose[b] += n
    # Imports count once per (file, folder): a Go package import links every file of the
    # package, so "doc/ imports cobra" must not read as 8 links to each root file
    for f, folder in imports_folder:
        to_folder[f][folder] += 1
    candidates = []
    for f in loose:
        ranked = sorted(to_folder[f].items(), key=lambda kv: (-kv[1], kv[0]))
        if not ranked or f.split("/")[:-1] != root:
            continue
        best_folder, best = ranked[0]
        runner_up = ranked[1][1] if len(ranked) > 1 else 0
        if best >= ATTACH_MIN_WEIGHT and best >= ATTACH_RATIO * runner_up and best >= to_loose[f]:
            candidates.append((-best, f, best_folder))
    attached = {key: list(members) for key, members in real.items()}
    joined = set()
    for _neg, f, folder in sorted(candidates):  # strongest links first, so the size cap keeps them
        if len(attached[folder]) + 1 <= MAX_SHARE * total:
            attached[folder].append(f)
            joined.add(f)
    remaining = [f for f in loose if f not in joined]
    return {k: sorted(v) for k, v in attached.items()}, remaining


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


def _group(files: list[str], pairs: dict, symbols: dict, root: list[str] | None = None,
           max_levels: int = MAX_DEPTH, communities_lo: int = MIN_COMMUNITIES) -> tuple[str, list]:
    """(method, [(key, kind, files)]) for a set of files: folders, attached loose files, clusters."""
    chosen = _choose_folders(files, symbols, root, max_levels) if files else None
    if chosen is None:
        return "communities", [("", COMMUNITY, c) for c in _communities(files, pairs, lo=communities_lo)] if files else []
    folder_root, real, loose = chosen
    folders, remaining = _attach_loose(folder_root, real, loose, pairs, len(files))
    clusters = _communities(remaining, pairs, lo=1) if remaining else []
    raw = [(k, DIR, v) for k, v in sorted(folders.items())]
    raw += [("", COMMUNITY, c) for c in clusters]
    return ("hybrid" if clusters else "directories"), raw


def _merge_into_core(raw: list, keep_total: int) -> list:
    """Merge the smallest COMMUNITY entries into one CORE entry until len(raw) ≤ keep_total."""
    communities = [g for g in raw if g[1] == COMMUNITY]
    if len(raw) <= keep_total or len(communities) < 2:
        return raw
    others = [g for g in raw if g[1] != COMMUNITY]
    keep = max(0, keep_total - len(others) - 1)
    by_size = sorted(communities, key=lambda g: (-len(g[2]), g[2][0]))
    merged = sorted(f for g in by_size[keep:] for f in g[2])
    return others + by_size[:keep] + [("", CORE, merged)]


def _labels(raw: list, degree: Counter, core_label: str = CORE) -> list[str]:
    """Unique labels within one scope: folder name, hub file stem + " + N files", "standalone", core."""
    hubs = {}
    for i, (_key, kind, members) in enumerate(raw):
        connected = [m for m in members if degree[m] > 0]
        if kind == COMMUNITY and connected:
            hubs[i] = min(connected, key=lambda m: (-degree[m], m))
    hub_stems = Counter(_stem(h) for h in hubs.values())
    entries = []
    for i, (key, kind, members) in enumerate(raw):
        members = sorted(members)
        if kind == CORE:
            label = core_label
        elif kind == COMMUNITY:
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
        elif kind == FILE:
            label = _stem(members[0])  # one file grouped on its own
        else:
            label = key.rsplit("/", 1)[-1]
        entries.append({"key": key, "kind": kind, "label": label})

    # Unique labels: qualify duplicates with their parent directory, then number them
    counts = Counter(m["label"] for m in entries)
    for m in entries:
        if counts[m["label"]] > 1 and m["key"] and "/" in m["key"].rstrip("/"):
            parent = m["key"].rsplit("/", 1)[0].rsplit("/", 1)[-1]
            m["label"] = f"{parent}/{m['label']}"
    # Still the same (client/src/lib vs server/src/lib): the whole path tells them apart
    counts = Counter(m["label"] for m in entries)
    for m in entries:
        if counts[m["label"]] > 1 and m["kind"] == DIR and "/" in m["key"].rstrip("/"):
            m["label"] = m["key"].rstrip("/")
    seen = Counter()
    for m in entries:
        seen[m["label"]] += 1
        if seen[m["label"]] > 1:
            m["label"] = f"{m['label']} ({seen[m['label']]})"
    return [m["label"] for m in entries]


def _linked(groups: list[list[str]], pairs: dict) -> bool:
    """Any module edge (weight ≥ MIN_EDGE_WEIGHT) between two of these file groups."""
    index = {f: i for i, members in enumerate(groups) for f in members}
    weight = Counter()
    for (a, b), w in pairs.items():
        ia, ib = index.get(a), index.get(b)
        if ia is not None and ib is not None and ia != ib:
            weight[(ia, ib)] += w["calls"] + w["imports"]
    return any(v >= MIN_EDGE_WEIGHT for v in weight.values())


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

    by_file = defaultdict(lambda: {"functions": 0, "classes": 0, "entry": False})
    for n in nodes:
        f = n.get("file")
        if n.get("type") == "function":
            by_file[f]["functions"] += 1
        elif n.get("type") == "class":
            by_file[f]["classes"] += 1
        if n.get("is_entry_point"):  # file nodes count too (JS/TS entry files)
            by_file[f]["entry"] = True
    symbols = {f: v["functions"] + v["classes"] for f, v in by_file.items()}

    # Top level. raw: (key, kind, files); kind is DIR (a real folder), COMMUNITY or CORE
    method, raw = _group(files, pairs, symbols)
    top_labels = _labels(raw, degree)

    # Two levels for multi-app repos: group inside each top-level folder
    units = []  # (label, files, parent group label | None) in output order
    groups = []  # (label, files)
    two_level = method != "communities" and (
        len(raw) < MIN_TOP_MODULES or not _linked([g[2] for g in raw], pairs)
    )
    if two_level:
        inner = {}
        for i, (key, kind, members) in enumerate(raw):
            if kind != DIR:
                continue
            sub_method, sub = _group(members, pairs, symbols, root=key.split("/"), max_levels=MAX_EXTRA_LEVELS, communities_lo=1)
            # Only a folder with real subfolders becomes a group; a plain folder stays one module
            if sub_method != "communities" and len(sub) >= 2:
                inner[i] = sub
        if not inner:
            two_level = False
    if two_level:
        # Module cap: the smallest clusters of the largest groups merge into "<group> core"
        total = sum(len(inner.get(i, [None])) for i in range(len(raw)))
        for i in sorted(inner, key=lambda i: -len(inner[i])):
            if total <= MAX_MODULES:
                break
            before = len(inner[i])
            inner[i] = _merge_into_core(inner[i], max(1, before - (total - MAX_MODULES)))
            total -= before - len(inner[i])
        for i, (key, kind, members) in enumerate(raw):
            if i in inner:
                groups.append((top_labels[i], sorted(members)))
                for label, (_k, _kind, sub_members) in zip(_labels(inner[i], degree, f"{top_labels[i]} core"), inner[i]):
                    units.append((label, sorted(sub_members), top_labels[i]))
            else:
                units.append((top_labels[i], sorted(members), None))
    else:
        raw = _merge_into_core(raw, MAX_MODULES)
        units = [(label, sorted(g[2]), None) for label, g in zip(_labels(raw, degree), raw)]

    # Ids
    group_ids = {}
    used_ids = set()

    def unique(base):
        out = base
        while out in used_ids:
            out += "_"
        used_ids.add(out)
        return out

    out_groups = []
    for label, members in groups:
        gid = unique(f"grp:{_slug(label)}")
        group_ids[label] = gid
        out_groups.append({"id": gid, "label": label, "files": members})
    module_of = {}
    out_modules = []
    for label, members, parent in units:
        base = f"mod:{_slug(parent)}--{_slug(label)}" if parent else f"mod:{_slug(label)}"
        mid = unique(base)
        for f in members:
            module_of[f] = mid
        module = {
            "id": mid,
            "label": label,
            "files": members,
            "function_count": sum(by_file[f]["functions"] for f in members),
            "class_count": sum(by_file[f]["classes"] for f in members),
            "has_entry_points": any(by_file[f]["entry"] for f in members),
        }
        if parent:
            module["parent"] = group_ids[parent]
        out_modules.append(module)

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

    result = {"modules": out_modules, "edges": edges[:MAX_EDGES], "method": method, "hidden": hidden}
    if out_groups:
        result["groups"] = out_groups
    return result
