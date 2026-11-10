# What it does: graph building for non-Python languages (basic support)
#
# Works on the language-neutral IR from languages/generic.py:
#   imports  per-language path resolution (JS/TS relative + baseUrl, Go package dirs,
#            Rust crate/mod paths, C/C++ local includes, Java packages, Ruby/PHP requires)
#   calls    1. self/this method of the caller's class, or a same-file definition
#            2. a name bound by an import (named import, namespace/package alias, wildcard)
#            3. the only definition with that name in the language family, unless stoplisted
#            Every edge is confidence "inferred" (resolved by name); a name that matches
#            several definitions links to none of them.
#   entry    per-language rules (package.json, main functions, index/main/server/app files)

import json
import posixpath
import re

from languages.registry import EXTENSIONS

INFERRED = "inferred"

# Names too common to link by name alone (on top of graph_builder's generic stoplist)
CROSS_LANGUAGE_STOPLIST = frozenset({
    "log", "print", "push", "map", "filter", "then", "catch", "new", "toString", "length",
    "size", "len", "forEach", "reduce", "find", "some", "every", "includes", "indexOf", "slice",
    "splice", "concat", "keys", "values", "entries", "assign", "parse", "stringify", "resolve",
    "reject", "emit", "on", "off", "next", "require", "import", "equals", "hashCode", "String",
    "Println", "Printf", "Sprintf", "Errorf", "unwrap", "expect", "clone", "into", "to_string",
    "iter", "collect", "format", "main", "init", "setState", "useState", "useEffect", "useRef",
    "useMemo", "useCallback", "useContext",
})
SELF_RECEIVERS = frozenset({"this", "self", "$this", "@", "base", "Self"})
FAMILY = {"typescript": "js", "javascript": "js", "c": "c", "cpp": "c"}
CLASS_KINDS = frozenset({"class", "interface", "struct", "module"})
FUNCTION_KINDS = frozenset({"function", "method"})
JS_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts")
ENTRY_STEMS = frozenset({"index", "main", "server", "app"})
ENTRY_FUNCTION_NAMES = frozenset({"main", "start", "run", "bootstrap"})
# Languages where every file of a directory shares one namespace (package), without imports
PACKAGE_DIR_LANGS = frozenset({"go", "java", "kotlin", "scala"})
_CTOR_RECEIVER = re.compile(r"^([A-Za-z_]\w*)\(.*\)$", re.DOTALL)


def family(lang: str) -> str:
    return FAMILY.get(lang, lang)


class GenericLinker:
    """Adds nodes and edges for non-Python files to a graph_builder._Builder."""

    def __init__(self, builder, files, manifests, stoplist):
        self.b = builder
        self.files = files
        self.manifests = manifests or {}
        self.stoplist = stoplist | CROSS_LANGUAGE_STOPLIST
        self.paths = {f["path"] for f in files}
        self.by_file = {}       # path → [symbol]
        self.by_name = {}       # (family, name) → [symbol ids]
        self.methods = {}       # (path, class qualified name) → {name: id}
        self.classes = {}       # (family, name) → [class ids]
        self.symbol = {}        # id → symbol
        self.go_modules = self._go_modules()  # [(module path, directory)] from go.mod
        self.bindings = {}      # path → {local name: (files, original name | None)}
        self.wildcards = {}     # path → [files whose top-level names are in scope]
        self.sites_total = 0
        self.sites_resolved = 0

    # -- nodes ----------------------------------------------------------------------
    def collect(self):
        b = self.b
        for f in self.files:
            path = f["path"]
            node = {
                "id": path, "label": path, "type": "file", "file": path, "lang": f["lang"],
                "summary": "", "lines": [], "centrality": 0.0, "is_entry_point": False,
            }
            if f.get("doc"):
                node["doc"] = f["doc"]
            b.nodes[path] = node
            syms = f.get("symbols", [])
            self.by_file[path] = syms
            for s in syms:
                sid = s["id"]
                is_class = s["kind"] in CLASS_KINDS
                n = {
                    "id": sid, "label": s["name"], "type": "class" if is_class else "function", "kind": s["kind"],
                    "lang": s["lang"], "file": path, "qualified_name": s["qualified_name"],
                    "summary": "", "lines": [s["start_line"], s["end_line"]], "centrality": 0.0, "is_entry_point": False,
                }
                if s.get("class_name"):
                    n["class_name"] = s["class_name"]
                if not is_class:
                    n["params"] = s.get("param_count", 0)
                if s.get("doc"):
                    n["doc"] = s["doc"]
                b.nodes[sid] = n
                b.add_edge(path, sid, "defines")
                self.symbol[sid] = s
                fam = family(s["lang"])
                if s.get("top_level", True):
                    self.by_name.setdefault((fam, s["name"]), []).append(sid)
                if is_class:
                    self.classes.setdefault((fam, s["name"]), []).append(sid)
                if s.get("class_name"):
                    self.methods.setdefault((path, s["class_name"]), {}).setdefault(s["name"], sid)

    # -- imports --------------------------------------------------------------------
    def _go_modules(self):
        out = []
        for mpath, content in self.manifests.items():
            if mpath.endswith("go.mod"):
                m = re.search(r"^module\s+(\S+)", content or "", re.MULTILINE)
                if m:
                    out.append((m.group(1), posixpath.dirname(mpath)))
        return sorted(out, key=lambda x: -len(x[0]))

    def _go_package_files(self, dir_path):
        return sorted(p for p in self.paths if p.endswith(".go") and posixpath.dirname(p) == dir_path)

    def _resolve_import(self, path, lang, module):
        """Repo files an import refers to ([] when external or unknown)."""
        d = posixpath.dirname(path)
        fam = family(lang)
        if fam == "js":
            candidates = []
            if module.startswith("."):
                candidates.append(posixpath.normpath(posixpath.join(d, module)))
            elif module.startswith(("@/", "~/")):
                candidates += [f"src/{module[2:]}", module[2:]]
            else:
                candidates += [module, f"src/{module}"]  # baseUrl-style imports
            for c in candidates:
                found = self._first_existing([c] + [c + e for e in JS_EXTS] + [f"{c}/index{e}" for e in JS_EXTS])
                if found:
                    return [found]
            return []
        if lang == "go":
            # Package = directory. go.mod maps the module path to a directory; otherwise
            # match the import path's tail against repo directories.
            for mod_path, mod_dir in self.go_modules:
                if module == mod_path or module.startswith(mod_path + "/"):
                    rest = module[len(mod_path):].lstrip("/")
                    files = self._go_package_files(posixpath.join(mod_dir, rest) if mod_dir else rest)
                    if files:
                        return files
            dirs = {}
            for p in self.paths:
                if p.endswith(".go"):
                    dirs.setdefault(posixpath.dirname(p), []).append(p)
            best = None
            for dir_path, members in dirs.items():
                if dir_path and (module == dir_path or module.endswith("/" + dir_path)):
                    if best is None or len(dir_path) > len(best[0]):
                        best = (dir_path, members)
            return sorted(best[1]) if best else []
        if lang == "rust":
            return self._resolve_rust(path, module)
        if fam == "c":
            local = posixpath.normpath(posixpath.join(d, module))
            if local in self.paths:
                return [local]
            matches = [p for p in self.paths if p == module or p.endswith("/" + module)]
            return matches if len(matches) == 1 else []
        if lang == "java":
            rel = module.replace(".", "/")
            exact = [p for p in self.paths if p.endswith(f"/{rel}.java") or p == f"{rel}.java"]
            if exact:
                return exact[:1]
            return sorted(p for p in self.paths if posixpath.dirname(p).endswith(rel) and p.endswith(".java"))
        if lang == "ruby":
            rel = posixpath.normpath(posixpath.join(d, module)) if module.startswith(".") else module
            return [c for c in (f"{rel}.rb", f"lib/{rel}.rb", rel) if c in self.paths][:1]
        if lang == "php":
            if module.startswith("./"):
                rel = posixpath.normpath(posixpath.join(d, module))
                return [rel] if rel in self.paths else []
            tail = "/".join(module.split("\\")[-2:]) + ".php"
            matches = [p for p in self.paths if p.endswith("/" + tail) or p == tail]
            return matches if len(matches) == 1 else []
        return []

    def _first_existing(self, candidates):
        return next((c for c in candidates if c in self.paths), None)

    def _resolve_rust(self, path, module):
        d = posixpath.dirname(path)
        stem = posixpath.splitext(posixpath.basename(path))[0]
        # Directory that holds this file's child modules
        mod_dir = d if stem in ("main", "lib", "mod") else posixpath.join(d, stem)
        crate_root = path[: path.index("src/") + 3] if "src/" in path else d

        def module_file(base, parts):
            for i in range(len(parts), 0, -1):  # longest module path first; the rest are items
                rel = posixpath.join(base, *parts[:i]) if base else posixpath.join(*parts[:i])
                found = self._first_existing([f"{rel}.rs", f"{rel}/mod.rs"])
                if found:
                    return found
            return None

        if module.startswith("mod::"):
            found = self._first_existing([posixpath.join(mod_dir, module[5:] + ".rs"), posixpath.join(mod_dir, module[5:], "mod.rs")])
            return [found] if found else []
        parts = [p for p in module.split("::") if p]
        if not parts:
            return []
        if parts[0] == "crate":
            found = module_file(crate_root, parts[1:]) if len(parts) > 1 else None
        elif parts[0] == "self":
            found = module_file(mod_dir, parts[1:]) if len(parts) > 1 else None
        elif parts[0] == "super":
            found = module_file(posixpath.dirname(mod_dir), parts[1:]) if len(parts) > 1 else None
        else:
            found = module_file(crate_root, parts)
        return [found] if found and found != path else []

    def link_imports(self):
        for f in self.files:
            path, lang = f["path"], f["lang"]
            bindings, wild = {}, []
            for imp in f.get("imports", []):
                targets = [t for t in self._resolve_import(path, lang, imp["module"]) if t != path]
                for t in targets:
                    self.b.add_edge(path, t, "imports")
                if not targets:
                    continue
                for local, orig in (imp.get("aliases") or {}).items():
                    bindings[local] = (targets, orig)
                if imp.get("alias"):
                    bindings[imp["alias"]] = (targets, None)  # namespace / package alias
                elif lang == "go":
                    bindings[imp["module"].rsplit("/", 1)[-1]] = (targets, None)  # package name = last segment
                names = imp.get("names") or []
                if "*" in names and not imp.get("alias"):
                    wild.extend(targets)
                for n in names:
                    if n not in ("*", "default") and n not in bindings:
                        bindings[n] = (targets, n)
            if lang in PACKAGE_DIR_LANGS:
                # Same package: the other files of the directory are in scope without imports
                wild.extend(p for p in sorted(self.paths)
                            if p != path and posixpath.dirname(p) == posixpath.dirname(path)
                            and posixpath.splitext(p)[1] == posixpath.splitext(path)[1])
            self.bindings[path] = bindings
            self.wildcards[path] = wild

    # -- calls ----------------------------------------------------------------------
    def _top_level_in(self, files, name, want_class=False):
        out = []
        for p in files:
            for s in self.by_file.get(p, []):
                if s["name"] == name and s.get("top_level", True) and not s.get("class_name"):
                    if not want_class or s["kind"] in CLASS_KINDS:
                        out.append(s["id"])
        return out

    def _class_method(self, path, class_qual, name):
        return self.methods.get((path, class_qual), {}).get(name)

    def _method_of_class_named(self, fam, class_name, name, prefer_files=()):
        ids = self.classes.get((fam, class_name), [])
        preferred = [c for c in ids if self.symbol[c]["file"] in prefer_files]
        ids = preferred or ids
        if len(ids) != 1:
            return None
        cls = self.symbol[ids[0]]
        return self._class_method(cls["file"], cls["qualified_name"], name)

    def _link(self, caller, target):
        return bool(target) and self.b.add_edge(caller, target, "calls", INFERRED)

    def resolve(self, f, call):
        b = self.b
        caller = call["caller_id"]
        if caller not in b.nodes:
            return False
        path, lang = f["path"], f["lang"]
        fam = family(lang)
        name, recv = call["callee_text"], call.get("receiver")
        is_new = call.get("kind") == "new"
        caller_class = b.nodes[caller].get("class_name") if caller != path else None
        bindings = self.bindings.get(path, {})

        # 1a. this.m() / self.m() → the caller's class
        if recv in SELF_RECEIVERS and caller_class:
            m = self._class_method(path, caller_class, name)
            if m:
                return self._link(caller, m)
        # Foo().m() / new Foo().m() → method of Foo
        ctor = _CTOR_RECEIVER.match(recv or "")
        if ctor:
            return self._link(caller, self._method_of_class_named(fam, ctor.group(1), name, prefer_files=(path,)))
        if recv and recv not in SELF_RECEIVERS:
            head = re.split(r"\.|::|->", recv)[0]
            # Package / namespace / module alias: pkg.Func(), util.fmt(), store::open()
            if head in bindings and head == recv:
                files, orig = bindings[head]
                if orig is None:
                    ids = self._top_level_in(files, name)
                    return self._link(caller, ids[0]) if len(ids) == 1 else False
                # Imported class: Store.open() / Store::new()
                return self._link(caller, self._method_of_class_named(fam, orig, name, prefer_files=files))
            # Static call on a class defined in this repo: Store::new(), Utils.slugify()
            if (fam, recv) in self.classes:
                return self._link(caller, self._method_of_class_named(fam, recv, name, prefer_files=(path,)))
            if name in self.stoplist:
                return False  # obj.map(), arr.push(), fmt.Println()…

        # 1b. Same-file definition
        local = [s for s in self.by_file.get(path, []) if s["name"] == name]
        if is_new:
            local = [s for s in local if s["kind"] in CLASS_KINDS]
        if recv is None and caller_class:
            own = self._class_method(path, caller_class, name)  # implicit this (Java, C#, Kotlin)
            if own:
                return self._link(caller, own)
        if recv is None:
            top = [s for s in local if not s.get("class_name")]
            if len(top) == 1:
                return self._link(caller, top[0]["id"])
        if len(local) == 1:
            return self._link(caller, local[0]["id"])
        if len(local) > 1:
            return False  # ambiguous inside the file

        # 2. Names bound by imports
        if recv is None and name in bindings:
            files, orig = bindings[name]
            target_name = name if orig in (None, "default") else orig
            ids = self._top_level_in(files, target_name)
            if not ids and orig == "default":
                ids = [s["id"] for p in files for s in self.by_file.get(p, [])
                       if s.get("top_level", True) and not s.get("class_name")]
            if len(ids) == 1:
                return self._link(caller, ids[0])
            if ids:
                return False
        wild = self.wildcards.get(path, [])
        if wild and recv is None:
            ids = self._top_level_in(wild, name, want_class=is_new)
            if len(ids) == 1:
                return self._link(caller, ids[0])
            if ids:
                return False

        # 3. The only definition with this name in the language family
        if name in self.stoplist:
            return False
        if is_new:
            ids = self.classes.get((fam, name), [])
        else:
            ids = self.by_name.get((fam, name), [])
            if recv is not None:  # obj.m(): any method of that name
                ids = ids + [sid for sid, s in self.symbol.items()
                             if s["name"] == name and s.get("class_name") and family(s["lang"]) == fam]
        ids = sorted(set(ids))
        return self._link(caller, ids[0]) if len(ids) == 1 else False

    def link_calls(self):
        for f in self.files:
            for call in f.get("calls", []):
                self.sites_total += 1
                if self.resolve(f, call):
                    self.sites_resolved += 1

    # -- entry points -----------------------------------------------------------------
    def _manifest_entries(self):
        """Files named by package.json main / module / bin / scripts."""
        out = set()
        for mpath, content in self.manifests.items():
            if not mpath.endswith("package.json"):
                continue
            try:
                pkg = json.loads(content)
            except (ValueError, TypeError):
                continue
            base = posixpath.dirname(mpath)
            refs = [pkg.get("main"), pkg.get("module")]
            bins = pkg.get("bin")
            refs += list(bins.values()) if isinstance(bins, dict) else [bins]
            for script in (pkg.get("scripts") or {}).values():
                refs += [tok for tok in str(script).split() if posixpath.splitext(tok)[1] in EXTENSIONS]
            for ref in refs:
                if not isinstance(ref, str) or not ref:
                    continue
                rel = posixpath.normpath(posixpath.join(base, ref)) if base else posixpath.normpath(ref)
                stem, _ = posixpath.splitext(rel)
                variants = [rel, stem]
                for build_dir in ("dist/", "build/", "lib/", "out/"):
                    if stem.startswith(build_dir):
                        variants.append("src/" + stem[len(build_dir):])
                for v in variants:
                    found = self._first_existing([v] + [v + e for e in JS_EXTS])
                    if found:
                        out.add(found)
                        break
        return out

    def mark_entry_points(self, callers):
        """callers: id → number of resolved non-file callers."""
        b = self.b
        js_entries = self._manifest_entries()
        for f in self.files:
            path, lang = f["path"], f["lang"]
            d, name = posixpath.split(path)
            stem = posixpath.splitext(name)[0].lower()
            if family(lang) == "js" and (path in js_entries or (stem in ENTRY_STEMS and (d in ("", "src") or d.endswith("/src")))):
                # The file is the entry point; helpers in it are often called only from
                # anonymous callbacks, so only an explicit main()/start()… is marked as well
                b.nodes[path]["is_entry_point"] = True
                for s in self.by_file.get(path, []):
                    if s["name"] in ENTRY_FUNCTION_NAMES and s.get("top_level", True) and not s.get("class_name") \
                            and not callers.get(s["id"]):
                        b.nodes[s["id"]]["is_entry_point"] = True
                continue
            for s in self.by_file.get(path, []):
                if callers.get(s["id"]) or s["kind"] not in FUNCTION_KINDS:
                    continue
                sig = s.get("signature", "")
                top = s.get("top_level", True) and not s.get("class_name")
                if (
                    (lang in ("java", "csharp", "scala") and s["name"] in ("main", "Main") and ("static" in sig or lang == "scala"))
                    or (lang == "go" and top and s["name"] == "main" and f.get("go_package") == "main")
                    or (lang == "rust" and top and s["name"] == "main" and (name == "main.rs" or "/bin/" in f"/{path}"))
                    or (family(lang) == "c" and top and s["name"] == "main")
                    or (lang == "kotlin" and top and s["name"] == "main")
                ):
                    b.nodes[s["id"]]["is_entry_point"] = True
