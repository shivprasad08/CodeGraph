# What it does: builds the code graph (nodes + calls/imports/defines edges) from parser output
# Module 3: Graph builder
#
# Calls are resolved through each file's scope (local definitions, imports, the
# enclosing class and its bases) instead of by bare name, so `x.get()` no longer
# links to every function called `get`. Each call edge carries a confidence:
#   exact     resolved through scope
#   inferred  unknown receiver, but exactly one non-generic function/method has that name

import posixpath
from collections import OrderedDict

import networkx as nx

# Bump when node ids or edge semantics change; part of the cache key so old graphs are not reused
GRAPH_SCHEMA_VERSION = 2

# Method names too common to infer from an unknown receiver (dict.get, list.append, file.close…)
GENERIC_METHOD_STOPLIST = frozenset({
    "get", "set", "add", "append", "update", "pop", "remove", "items", "keys", "values",
    "copy", "clear", "close", "open", "read", "write", "start", "stop", "run", "send",
    "recv", "join", "split", "format", "encode", "decode", "load", "dump", "loads",
    "dumps", "put", "delete", "query", "execute", "connect", "handle", "process", "call",
    "apply", "wait", "acquire", "release", "lock", "info", "debug", "warning", "error",
})

ROUTE_VERBS = frozenset({"get", "post", "put", "delete", "patch", "head", "options", "route", "websocket", "api_route"})
CLI_DECORATOR_ENDINGS = frozenset({"command", "group", "callback"})
TASK_DECORATOR_ENDINGS = frozenset({"task", "shared_task", "periodic_task"})
MAX_BINDING_DEPTH = 6

EXACT, INFERRED = "exact", "inferred"


def _is_dunder(name: str) -> bool:
    return name.startswith("__") and name.endswith("__")


# ---------------------------------------------------------------------------
# Module path resolution
# ---------------------------------------------------------------------------
class _ModuleIndex:
    """Maps dotted module names to repo file paths."""

    def __init__(self, paths):
        self.paths = set(paths)
        prefixes = ["", "src/"]
        # Common package roots: parent directory of every top-level package (dir with __init__.py
        # whose parent has none), e.g. "backend/" for backend/app/__init__.py
        init_dirs = {posixpath.dirname(p) for p in self.paths if p.endswith("__init__.py")}
        for d in sorted(init_dirs):
            top = d
            while posixpath.dirname(top) in init_dirs:
                top = posixpath.dirname(top)
            parent = posixpath.dirname(top)
            prefix = f"{parent}/" if parent else ""
            if prefix not in prefixes:
                prefixes.append(prefix)
        self.prefixes = prefixes

    def _try(self, rel: str) -> str | None:
        for cand in (f"{rel}.py", f"{rel}/__init__.py"):
            if cand in self.paths:
                return cand
        return None

    def resolve_absolute(self, importer: str, dotted: str) -> str | None:
        if not dotted:
            return None
        rel = dotted.replace(".", "/")
        # Repo prefixes first, then the importing file's own directory (script-style imports)
        importer_dir = posixpath.dirname(importer)
        for prefix in self.prefixes + ([f"{importer_dir}/"] if importer_dir else []):
            found = self._try(f"{prefix}{rel}")
            if found:
                return found
        return None

    def package_dir(self, importer: str, level: int) -> str | None:
        """Directory that `level` leading dots refer to, from `importer`."""
        base = posixpath.dirname(importer)
        for _ in range(level - 1):
            if not base:
                return None
            base = posixpath.dirname(base)
        return base

    def resolve_relative(self, importer: str, level: int, module: str) -> str | None:
        base = self.package_dir(importer, level)
        if base is None:
            return None
        rel = posixpath.join(base, module.replace(".", "/")) if module else base
        if not module:
            return f"{rel}/__init__.py" if f"{rel}/__init__.py" in self.paths else None
        return self._try(rel)

    def submodule(self, module_file: str, name: str) -> str | None:
        """pkg/__init__.py + name → pkg/name.py (or pkg/name/__init__.py)."""
        if not module_file.endswith("__init__.py"):
            return None
        return self._try(posixpath.join(posixpath.dirname(module_file), name))


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
class _Builder:
    def __init__(self, parsed_files):
        self.files = sorted(parsed_files, key=lambda f: f["path"])
        self.index = _ModuleIndex(f["path"] for f in self.files)
        self.nodes = OrderedDict()   # id -> node dict
        self.edges = OrderedDict()   # (source, target, type) -> confidence
        self.top_level = {}          # file -> {name: node id}  (top-level functions and classes)
        self.raw_bindings = {}       # file -> {local name: binding tuple}
        self.wildcards = {}          # file -> [import specs for `from x import *`]
        self.classes = {}            # class id -> {"file", "bases", "methods": {name: id}}
        self.functions = {}          # function id -> parser record (+ file)
        self.by_name = {}            # short name -> [function/method ids]  (for inferred edges)
        self._binding_memo = {}
        self._linked = []            # call targets linked by the call site being resolved
        self.sites_total = 0
        self.sites_resolved = 0

    # -- edges ------------------------------------------------------------------
    def add_edge(self, source, target, etype, confidence=EXACT):
        if source not in self.nodes or target not in self.nodes:
            return False
        key = (source, target, etype)
        if self.edges.get(key) != EXACT:  # exact wins over inferred
            self.edges[key] = confidence
        if etype == "calls":
            self._linked.append(target)
        return True

    # -- pass 1: nodes, symbols, bindings --------------------------------------
    def collect(self):
        for f in self.files:
            path = f["path"]
            self.nodes[path] = {
                "id": path, "label": path, "type": "file", "file": path,
                "summary": "", "lines": [], "centrality": 0.0, "is_entry_point": False,
            }
            symbols = {}
            for cls in f.get("classes", []):
                cid = cls["id"]
                self.nodes[cid] = {
                    "id": cid, "label": cls["name"], "type": "class", "file": path,
                    "qualified_name": cls.get("qualified_name", cls["name"]),
                    "summary": "", "lines": [cls["start_line"], cls["end_line"]],
                    "centrality": 0.0, "is_entry_point": False,
                }
                self.classes[cid] = {"file": path, "bases": cls.get("base_classes", []), "methods": {}}
                self.add_edge(path, cid, "defines")
                if not cls.get("is_nested") and "." not in cls.get("qualified_name", cls["name"]):
                    symbols[cls["name"]] = cid
            for fn in f.get("functions", []):
                fid = fn["id"]
                node = {
                    "id": fid, "label": fn["name"], "type": "function", "file": path,
                    "qualified_name": fn.get("qualified_name", fn["name"]),
                    "summary": "", "lines": [fn["start_line"], fn["end_line"]],
                    "centrality": 0.0, "is_entry_point": False,
                }
                if fn.get("class_name"):
                    node["class_name"] = fn["class_name"]
                    cid = f"{path}::{fn['class_name']}"
                    if cid in self.classes:
                        self.classes[cid]["methods"].setdefault(fn["name"], fid)
                self.nodes[fid] = node
                self.functions[fid] = {**fn, "file": path}
                self.add_edge(path, fid, "defines")
                if not fn.get("is_method") and not fn.get("is_nested"):
                    symbols[fn["name"]] = fid
                if not fn.get("is_nested"):
                    self.by_name.setdefault(fn["name"], []).append(fid)
            self.top_level[path] = symbols
            self.raw_bindings[path], self.wildcards[path] = self._bindings_for(f.get("imports", []))

    @staticmethod
    def _bindings_for(imports):
        bindings, wildcards = {}, []
        for imp in imports:
            alias_of = {a["name"]: a["alias"] for a in imp.get("aliases", []) if a.get("alias")}
            if imp.get("kind") == "import" or ("kind" not in imp and not imp.get("is_relative") and imp.get("names") == [imp.get("module")]):
                module = imp["module"]
                alias = imp.get("alias") or alias_of.get(module)
                if alias:
                    bindings[alias] = ("module", 0, module)
                else:
                    head = module.split(".")[0]
                    bindings.setdefault(head, ("namespace", head))
            else:
                level = imp.get("level", 1 if imp.get("is_relative") else 0)
                for name in imp.get("names", []):
                    if name == "*":
                        wildcards.append((level, imp.get("module", "")))
                        continue
                    bindings[alias_of.get(name, name)] = ("from", level, imp.get("module", ""), name)
        return bindings, wildcards

    # -- symbol lookup ------------------------------------------------------------
    def _module_file(self, importer, level, module):
        if level:
            return self.index.resolve_relative(importer, level, module)
        return self.index.resolve_absolute(importer, module)

    def lookup(self, file, name, depth=0):
        """
        Resolve `name` in `file` scope →
          ("node", id) | ("module", file) | ("namespace", dotted) | ("external",) | None (unknown)
        """
        if name in self.top_level.get(file, {}):
            return ("node", self.top_level[file][name])
        binding = self.raw_bindings.get(file, {}).get(name)
        if binding is not None:
            if depth >= MAX_BINDING_DEPTH:
                return ("external",)
            memo_key = (file, name)
            if memo_key not in self._binding_memo:
                self._binding_memo[memo_key] = None  # cycle guard
                self._binding_memo[memo_key] = self._resolve_binding(file, binding, depth + 1)
            return self._binding_memo[memo_key] or ("external",)
        for level, module in self.wildcards.get(file, []):
            target = self._module_file(file, level, module)
            if target and depth < MAX_BINDING_DEPTH:
                found = self.lookup(target, name, depth + 1)
                if found and found[0] in ("node", "module"):
                    return found
        return None

    def _resolve_binding(self, file, binding, depth):
        kind = binding[0]
        if kind == "namespace":
            head = binding[1]
            target = self.index.resolve_absolute(file, head)
            return ("module", target) if target else ("namespace", head) if self._namespace_exists(file, head) else None
        if kind == "module":
            _, level, module = binding
            target = self._module_file(file, level, module)
            return ("module", target) if target else None
        # from-import
        _, level, module, name = binding
        target = self._module_file(file, level, module) if (module or level) else None
        if target:
            found = self.lookup(target, name, depth)
            if found and found[0] in ("node", "module"):
                return found
            sub = self.index.submodule(target, name)
            if sub:
                return ("module", sub)
        # `from . import x` / `from pkg import submodule` when the package has no __init__.py
        if level:
            sub = self.index.resolve_relative(file, level, f"{module}.{name}" if module else name)
        else:
            sub = self.index.resolve_absolute(file, f"{module}.{name}") if module else None
        return ("module", sub) if sub else None

    def _namespace_exists(self, file, head):
        """A dotted prefix (namespace package) that leads to at least one repo module."""
        rel = head.replace(".", "/")
        dirs = [f"{p}{rel}/" for p in self.index.prefixes] + [f"{posixpath.dirname(file)}/{rel}/"]
        return any(p.startswith(d) for p in self.index.paths for d in dirs)

    def step(self, file, current, part):
        """Follow one dotted segment from a resolved value."""
        if current is None or current[0] == "external":
            return current
        kind = current[0]
        if kind == "module":
            module_file = current[1]
            found = self.lookup(module_file, part)
            if found and found[0] in ("node", "module"):
                return found
            sub = self.index.submodule(module_file, part)
            return ("module", sub) if sub else None
        if kind == "namespace":
            dotted = f"{current[1]}.{part}"
            target = self.index.resolve_absolute(file, dotted)
            if target:
                return ("module", target)
            return ("namespace", dotted) if self._namespace_exists(file, dotted) else None
        if kind == "node":
            node_id = current[1]
            if node_id in self.classes:
                nested = f"{node_id}.{part}"
                if nested in self.classes:
                    return ("node", nested)
                method = self.find_method(node_id, part)
                return ("node", method) if method else None
            return None
        return None

    def resolve_chain(self, file, parts):
        current = self.lookup(file, parts[0])
        for part in parts[1:]:
            current = self.step(file, current, part)
        return current

    def resolve_class(self, file, text):
        found = self.resolve_chain(file, text.split("."))
        if found and found[0] == "node" and found[1] in self.classes:
            return found[1]
        return None

    def find_method(self, class_id, method, seen=None):
        """Method in the class, else in its in-repo bases (left-to-right, depth-first)."""
        seen = seen if seen is not None else set()
        if class_id in seen or class_id not in self.classes:
            return None
        seen.add(class_id)
        info = self.classes[class_id]
        if method in info["methods"]:
            return info["methods"][method]
        for base in info["bases"]:
            base_id = self.resolve_class(info["file"], base)
            if base_id:
                found = self.find_method(base_id, method, seen)
                if found:
                    return found
        return None

    def base_classes(self, class_id):
        info = self.classes.get(class_id)
        if not info:
            return []
        return [b for b in (self.resolve_class(info["file"], base) for base in info["bases"]) if b]

    # -- pass 2: imports and calls ------------------------------------------------
    def link_imports(self):
        for f in self.files:
            path = f["path"]
            for imp in f.get("imports", []):
                level = imp.get("level", 1 if imp.get("is_relative") else 0)
                module = imp.get("module", "")
                targets = []
                if imp.get("kind") == "import":
                    targets.append(self.index.resolve_absolute(path, module))
                else:
                    target = self._module_file(path, level, module) if (module or level) else None
                    targets.append(target)
                    for name in imp.get("names", []):
                        if name == "*":
                            continue
                        if target:
                            targets.append(self.index.submodule(target, name))
                        elif level:
                            targets.append(self.index.resolve_relative(path, level, f"{module}.{name}" if module else name))
                for target in targets:
                    if target and target != path:
                        self.add_edge(path, target, "imports")

    def _class_call(self, caller, class_id, confidence=EXACT):
        linked = self.add_edge(caller, class_id, "calls", confidence)
        init = self.find_method(class_id, "__init__")
        if init:
            self.add_edge(caller, init, "calls", confidence)
        return linked

    def _callable(self, caller, found):
        """Edge for a resolved callable value (function, method or class)."""
        if not found or found[0] != "node":
            return False
        target = found[1]
        if target in self.classes:
            return self._class_call(caller, target)
        return self.add_edge(caller, target, "calls")

    def _inferred(self, caller, method):
        if method in GENERIC_METHOD_STOPLIST or _is_dunder(method):
            return False
        candidates = self.by_name.get(method, [])
        if len(candidates) == 1:
            return self.add_edge(caller, candidates[0], "calls", INFERRED)
        return False

    def resolve_call(self, path, site):
        caller = site.get("caller_id") or (path if site.get("caller_function") == "__module__" else f"{path}::{site.get('caller_function')}")
        if caller not in self.nodes:
            return False
        target = site.get("target") or {"kind": "name", "name": site.get("callee", "")}
        kind = target["kind"]
        cls = f"{path}::{site['enclosing_class']}" if site.get("enclosing_class") else None

        if kind == "name":
            name = target["name"]
            # a. closure defined inside the caller, then same-file / imported symbol
            nested = f"{caller}.{name}" if caller != path else None
            if nested in self.functions:
                return self.add_edge(caller, nested, "calls")
            return self._callable(caller, self.lookup(path, name))

        if kind == "self":
            # b. method on the enclosing class or its in-repo bases
            method = self.find_method(cls, target["attr"]) if cls in self.classes else None
            return self.add_edge(caller, method, "calls") if method else False

        if kind == "super":
            for base in self.base_classes(cls):
                method = self.find_method(base, target["attr"])
                if method:
                    return self.add_edge(caller, method, "calls")
            return False

        if kind in ("dotted", "instance"):
            base_text = target["base"] if kind == "dotted" else target["ctor"]
            parts = base_text.split(".")
            found = self.resolve_chain(path, parts)
            if found and found[0] == "external":
                return False  # third-party / stdlib (json.loads, jwt.decode…)
            if kind == "dotted" and found and found[0] in ("module", "namespace", "node"):
                # c. module.f() / pkg.mod.f()   d. ClassName.m()
                if found[0] == "node" and found[1] in self.classes:
                    nested = f"{found[1]}.{target['attr']}"
                    if nested in self.classes:
                        return self._class_call(caller, nested)
                    method = self.find_method(found[1], target["attr"])
                    return self.add_edge(caller, method, "calls") if method else False
                if found[0] == "node":
                    return self._inferred(caller, target["attr"])  # attribute of a function's result
                return self._callable(caller, self.step(path, found, target["attr"]))
            if kind == "instance" and found and found[0] == "node" and found[1] in self.classes:
                method = self.find_method(found[1], target["attr"])  # Store().get()
                return self.add_edge(caller, method, "calls") if method else False
            if found is None and parts[0] in self.raw_bindings.get(path, {}):
                return False  # imported name we could not resolve: external
            # e. unknown receiver
            return self._inferred(caller, target["attr"])

        if kind == "unknown":
            return self._inferred(caller, target["attr"])
        return False

    def link_calls(self):
        self.module_level_targets = set()  # called at module scope or under `if __name__ == "__main__"`
        for f in self.files:
            path = f["path"]
            for site in f.get("call_sites", []):
                self.sites_total += 1
                self._linked = []
                self.resolve_call(path, site)
                if self._linked:
                    self.sites_resolved += 1
                    if site.get("module_scope") or site.get("in_main_guard"):
                        self.module_level_targets.update(self._linked)

    # -- entry points ---------------------------------------------------------------
    @staticmethod
    def _entry_decorator(decorators):
        for dec in decorators:
            low = dec.lower()
            if "fixture" in low:
                continue
            last = low.split(".")[-1]
            if "." in low and last in ROUTE_VERBS:
                return True  # app.get / router.post / bp.route
            if low in ("click.command", "click.group") or ("." in low and last in CLI_DECORATOR_ENDINGS):
                return True  # click / typer app.command
            if "typer" in low:
                return True
            if last in TASK_DECORATOR_ENDINGS:
                return True  # celery.task / shared_task
        return False

    def mark_entry_points(self):
        fn_callers = {}
        for (s, t, etype) in self.edges:
            if etype == "calls" and s != t and self.nodes[s]["type"] != "file":
                fn_callers[t] = fn_callers.get(t, 0) + 1
        for fid, fn in self.functions.items():
            name = fn["name"]
            if _is_dunder(name) or fn_callers.get(fid):
                continue
            top_level = not fn.get("is_method") and not fn.get("is_nested")
            if (
                (top_level and fid in self.module_level_targets)
                or self._entry_decorator(fn.get("decorator_names", []))
                or (top_level and name == "main")
            ):
                self.nodes[fid]["is_entry_point"] = True

    # -- output -----------------------------------------------------------------------
    def build(self, repo, commit_sha):
        self.collect()
        self.link_imports()
        self.link_calls()
        self.mark_entry_points()

        G = nx.DiGraph()
        G.add_nodes_from(self.nodes)
        G.add_edges_from((s, t) for (s, t, _etype) in self.edges)
        if len(G) > 0:
            try:
                for node_id, cent in nx.pagerank(G, alpha=0.85).items():
                    self.nodes[node_id]["centrality"] = round(cent, 4)
            except Exception:
                pass

        edges = [
            {"source": s, "target": t, "type": etype, "confidence": conf}
            for (s, t, etype), conf in self.edges.items()
        ]
        calls = [e for e in edges if e["type"] == "calls"]
        return {
            "repo": repo,
            "commit_sha": commit_sha,
            "schema_version": GRAPH_SCHEMA_VERSION,
            "nodes": list(self.nodes.values()),
            "edges": edges,
            "stats": {
                "call_sites_total": self.sites_total,
                "call_sites_resolved": self.sites_resolved,
                "calls_exact": sum(1 for e in calls if e["confidence"] == EXACT),
                "calls_inferred": sum(1 for e in calls if e["confidence"] == INFERRED),
                "entry_points": sum(1 for n in self.nodes.values() if n.get("is_entry_point")),
            },
        }


def build_graph(parse_output: dict) -> dict:
    builder = _Builder(parse_output.get("parsed_files", []))
    return builder.build(parse_output.get("repo", ""), parse_output.get("commit_sha", ""))
