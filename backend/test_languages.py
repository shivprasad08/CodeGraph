# What it does: Tests for multi-language support (registry, generic parser, generic resolver, ingestion)

import json
import textwrap

import pytest

from architecture import build_architecture
from graph_builder import build_graph
from ingestion import FileLimitError, NoSourceError, select_files
from languages import registry
from parser import parse_file, parse_repo


@pytest.fixture(scope="module", autouse=True)
def grammars():
    """These tests need the grammar cache; fetch it once if missing (same as the build step)."""
    if registry.cached_grammars() != set(registry.GRAMMARS):
        registry.fetch()
    missing = set(registry.GRAMMARS) - registry.cached_grammars()
    if missing:
        pytest.fail(f"grammars unavailable: {sorted(missing)} — run python scripts/fetch_grammars.py")


def build(files: dict, manifests=None) -> dict:
    return build_graph(parse_repo({
        "repo": "o/r",
        "commit_sha": "abc",
        "files": [{"path": p, "content": textwrap.dedent(c)} for p, c in files.items()],
        "manifests": manifests or {},
    }))


def calls(graph) -> set:
    return {(e["source"], e["target"], e["confidence"]) for e in graph["edges"] if e["type"] == "calls"}


def ids(graph) -> set:
    return {n["id"] for n in graph["nodes"]}


def entry(graph) -> set:
    return {n["id"] for n in graph["nodes"] if n.get("is_entry_point")}


class TestJavaScript:
    FILES = {
        "src/store.js": """
            /** Key-value storage. */
            export function save(key, value) { return write(key, value); }
            function write(k, v) {}
            export class Store {
              get(k) { return this.read(k); }
              read(k) { return k; }
            }
        """,
        "src/app.jsx": """
            import { save as persist, Store } from './store';
            import Editor from './Editor';
            export function App() {
              persist('a', 1);
              const s = new Store();
              return <Editor store={s} />;
            }
        """,
        "src/Editor.jsx": """
            export default function Editor({ store }) { return null; }
        """,
    }

    def test_symbols_methods_and_resolved_calls(self):
        g = build(self.FILES)
        assert {"src/store.js::save", "src/store.js::Store", "src/store.js::Store.get", "src/app.jsx::App"} <= ids(g)
        node = next(n for n in g["nodes"] if n["id"] == "src/store.js::Store.get")
        assert node["kind"] == "method" and node["class_name"] == "Store" and node["lang"] == "javascript"
        c = calls(g)
        assert ("src/store.js::save", "src/store.js::write", "inferred") in c            # same file
        assert ("src/store.js::Store.get", "src/store.js::Store.read", "inferred") in c   # this.read()
        assert ("src/app.jsx::App", "src/store.js::save", "inferred") in c               # aliased named import
        assert ("src/app.jsx::App", "src/store.js::Store", "inferred") in c              # new Store()
        assert ("src/app.jsx::App", "src/Editor.jsx::Editor", "inferred") in c           # <Editor /> via default import
        assert ("src/app.jsx", "src/store.js") in {(e["source"], e["target"]) for e in g["edges"] if e["type"] == "imports"}

    def test_entry_points_from_package_json_and_file_names(self):
        g = build({**self.FILES, "bin/cli.js": "function main() {}\nfunction usage() {}\n"},
                  manifests={"package.json": json.dumps({"bin": {"tool": "bin/cli.js"}})})
        # Entry files: package.json bin, src/app.*; inside them only an explicit main()/start()
        assert {"bin/cli.js", "bin/cli.js::main", "src/app.jsx"} <= entry(g)
        assert not {"bin/cli.js::usage", "src/app.jsx::App", "src/store.js"} & entry(g)


class TestGo:
    def test_methods_receivers_and_package_calls(self):
        g = build({
            "store/store.go": """
                package store
                // Store keeps values.
                type Store struct{}
                func (s *Store) Get(k string) string { return s.lookup(k) }
                func (s *Store) lookup(k string) string { return k }
                func Open() *Store { return &Store{} }
            """,
            "cmd/app/main.go": """
                package main
                import "example.com/kv/store"
                func main() { st := store.Open(); st.Get("a") }
            """,
        })
        assert {"store/store.go::Store", "store/store.go::Store.Get", "store/store.go::Open", "cmd/app/main.go::main"} <= ids(g)
        c = calls(g)
        assert ("store/store.go::Store.Get", "store/store.go::Store.lookup", "inferred") in c
        assert ("cmd/app/main.go::main", "store/store.go::Open", "inferred") in c   # package alias store.Open
        assert ("cmd/app/main.go::main", "store/store.go::Store.Get", "inferred") in c  # unique method name
        assert "cmd/app/main.go::main" in entry(g)
        assert next(n for n in g["nodes"] if n["id"] == "store/store.go::Store")["kind"] == "struct"


class TestGoModulesAndPackages:
    def test_go_mod_root_package_and_same_package_calls(self):
        g = build(
            {
                "command.go": "package cobra\nfunc (c *Command) Execute() { run(c) }\ntype Command struct{}\n",
                "util.go": "package cobra\nfunc run(c *Command) {}\n",
                "doc/gen.go": 'package doc\nimport "github.com/spf13/cobra"\nfunc Gen() { cobra.Helper() }\n',
                "helper.go": "package cobra\nfunc Helper() {}\n",
            },
            manifests={"go.mod": "module github.com/spf13/cobra\n\ngo 1.20\n"},
        )
        imports = {(e["source"], e["target"]) for e in g["edges"] if e["type"] == "imports"}
        assert ("doc/gen.go", "command.go") in imports and ("doc/gen.go", "helper.go") in imports
        c = calls(g)
        assert ("command.go::Command.Execute", "util.go::run", "inferred") in c   # same package, other file
        assert ("doc/gen.go::Gen", "helper.go::Helper", "inferred") in c         # cobra.Helper() via go.mod


class TestRust:
    def test_impl_methods_mod_and_path_calls(self):
        g = build({
            "src/main.rs": """
                mod store;
                use crate::store::Store;
                fn main() { let s = Store::new(); s.put(1); }
            """,
            "src/store.rs": """
                pub struct Store { n: u32 }
                impl Store {
                    pub fn new() -> Self { Store { n: 0 } }
                    pub fn put(&mut self, v: u32) { self.bump(); }
                    fn bump(&mut self) {}
                }
            """,
        })
        assert {"src/store.rs::Store", "src/store.rs::Store.new", "src/store.rs::Store.put", "src/main.rs::main"} <= ids(g)
        c = calls(g)
        assert ("src/main.rs::main", "src/store.rs::Store.new", "inferred") in c   # Store::new() via use
        assert ("src/store.rs::Store.put", "src/store.rs::Store.bump", "inferred") in c  # self.bump()
        assert ("src/main.rs", "src/store.rs") in {(e["source"], e["target"]) for e in g["edges"] if e["type"] == "imports"}
        assert "src/main.rs::main" in entry(g)


class TestJava:
    def test_class_methods_and_calls(self):
        g = build({
            "src/main/java/com/x/App.java": """
                package com.x;
                import com.x.store.Store;
                public class App {
                  public static void main(String[] args) { new App().run(); }
                  void run() { helper(); new Store().save(); }
                  private void helper() {}
                }
            """,
            "src/main/java/com/x/store/Store.java": """
                package com.x.store;
                public class Store { public void save() {} }
            """,
        })
        c = calls(g)
        app = "src/main/java/com/x/App.java::App"
        assert (f"{app}.main", f"{app}.run", "inferred") in c                 # new App().run()
        assert (f"{app}.run", f"{app}.helper", "inferred") in c               # implicit this
        assert (f"{app}.run", "src/main/java/com/x/store/Store.java::Store.save", "inferred") in c
        assert f"{app}.main" in entry(g)


class TestResolutionSafety:
    def test_same_name_in_two_files_is_not_linked(self):
        g = build({
            "a.js": "export function render() {}\n",
            "b.js": "export function render() {}\n",
            "c.js": "function go() { render(); }\n",
        })
        assert not any(s == "c.js::go" for s, _, _ in calls(g))

    def test_stoplisted_names_are_not_linked_by_name(self):
        g = build({
            "a.js": "export function log(x) {}\nexport function filter(x) {}\n",
            "c.js": "function go(items) { log(1); items.filter(1); console.log(2); }\n",
        })
        assert not any(s == "c.js::go" for s, _, _ in calls(g))


class TestIngestionSelection:
    def tree(self, *paths):
        return [{"type": "blob", "path": p, "size": 10} for p in paths]

    def test_vendored_generated_and_test_files_ignored(self):
        files, manifests = select_files(self.tree(
            "src/app.ts", "src/types.d.ts", "node_modules/x/index.js", "dist/app.js", "public/vendor/jquery.min.js",
            "src/app.test.ts", "src/__tests__/a.js", "src/test/java/ATest.java", "pkg/x_test.go", "build/gen.go",
            "src/generated/api.ts", "package.json", "README.md", "app/models.py", "app/tests/test_x.py",
        ))
        assert [f["path"] for f in files] == ["src/app.ts", "app/models.py"]
        assert [f["lang"] for f in files] == ["typescript", "python"]
        assert manifests == ["package.json"]

    def test_no_source_lists_top_extensions(self):
        with pytest.raises(NoSourceError) as err:
            select_files(self.tree("README.md", "docs/a.md", "docs/b.md", "data.json"))
        assert NoSourceError.error_code == "no_source"
        assert ".md (3)" in str(err.value) and ".json (1)" in str(err.value)

    def test_file_limit_counts_languages(self, monkeypatch):
        import ingestion
        monkeypatch.setattr(ingestion, "MAX_FILES", 3)
        with pytest.raises(FileLimitError) as err:
            select_files(self.tree("a.ts", "b.ts", "c.ts", "d.js", "e.py"))
        assert "5 source files (TypeScript 3, JavaScript 1, Python 1), limit is 3" in str(err.value)


class TestMixedRepo:
    def test_python_and_javascript_in_one_graph(self):
        g = build({
            "api/server.py": "def handle():\n    return helper()\n\ndef helper():\n    return 1\n",
            "web/src/index.js": "import { fetchData } from './api';\nfetchData();\n",
            "web/src/api.js": "export function fetchData() {}\n",
        })
        c = calls(g)
        assert ("api/server.py::handle", "api/server.py::helper", "exact") in c    # Python resolver unchanged
        assert ("web/src/index.js", "web/src/api.js::fetchData", "inferred") in c   # module-level JS call
        assert {row["lang"]: row["files"] for row in g["languages"]} == {"python": 1, "javascript": 2}
        assert {n["lang"] for n in g["nodes"]} == {"python", "javascript"}
        arch = build_architecture(g)
        assert sorted(f for m in arch["modules"] for f in m["files"]) == sorted(
            ["api/server.py", "web/src/index.js", "web/src/api.js"])


class TestAnalyzer:
    def analyze(self, files):
        import analyzer
        files = {p: textwrap.dedent(c) for p, c in files.items()}
        po = parse_repo({"repo": "o/r", "commit_sha": "abc", "files": [{"path": p, "content": c} for p, c in files.items()]})
        return analyzer.analyze_repo(po, files, build_graph(po))

    def messages(self, result):
        return {(i["file"], i["severity"], i["message"]) for i in result["issues"]}

    def test_js_rule_pack(self):
        r = self.analyze({"src/ui.js": """
            function show(el, html, cmd) {
              el.innerHTML = html;
              eval(cmd);
              const f = new Function(cmd);
              exec(`ls ${cmd}`);
              debugger;
              // TODO: sanitize
              return <div dangerouslySetInnerHTML={{ __html: html }} />;
            }
        """})
        found = {m for _, _, m in self.messages(r)}
        assert "Use of eval() — arbitrary code execution risk" in found
        assert "new Function() — arbitrary code execution risk" in found
        assert "Assigning innerHTML/outerHTML — XSS risk unless the value is sanitized" in found
        assert "dangerouslySetInnerHTML — XSS risk unless the value is sanitized" in found
        assert "Shell command built from a template string — command injection risk" in found
        assert "Debug statement left in production code" in found
        assert "TODO/FIXME comment: sanitize" in found

    def test_language_agnostic_structure_checks(self):
        deep = "func walk(x int) {\n" + "".join("  " * i + "if x > 0 {\n" for i in range(1, 6)) + "".join("  " * i + "}\n" for i in range(5, 0, -1)) + "}\n"
        r = self.analyze({
            "a/util.go": "package a\nfunc Slug() {}\n" + deep,
            "b/util.go": "package b\nfunc Slug() {}\n",
            "big.rs": "fn f() {}\n" + "\n".join(f"fn g{i}() {{}}" for i in range(620)),
        })
        msgs = self.messages(r)
        assert ("a/util.go", "low", "walk nests control flow 5 levels deep") in msgs
        assert ("a/util.go", "info", "Slug is also defined in b/util.go — the same name in 2 files") in msgs
        assert any(f == "big.rs" and m.startswith("Large file: 621 lines") for f, _, m in msgs)
        # info findings are listed but do not lower the score
        assert all(i["severity"] in ("high", "medium", "low", "info") for i in r["issues"])


class TestRegistry:
    def test_languages_and_docs(self):
        assert registry.language_of("a/b.tsx") == "typescript"
        assert registry.grammar_of("a/b.tsx", "typescript") == "tsx"
        assert registry.language_of("x.unknown") is None
        r = parse_file("pkg/server.go", "// Package server serves the API.\npackage server\n")
        assert r["doc"] == "Package server serves the API." and r["lang"] == "go"

    def test_every_grammar_loads_with_its_queries(self):
        assert sorted(registry.prefetch()) == sorted(registry.GRAMMARS)


# ---------------------------------------------------------------------------
# Runtime never downloads: parse from the project cache with networking cut off
# ---------------------------------------------------------------------------
OFFLINE_SCRIPT = r"""
import json, sys
from parser import parse_file
from languages import registry
fixtures = {
    "src/app.js": "export class Editor { open(p) { return this.render(p); } render(p) {} }",
    "pkg/server.go": "package server\ntype Server struct{}\nfunc (s *Server) Start() { s.handle() }\nfunc (s *Server) handle() {}",
    "src/store.rs": "pub struct Store {}\nimpl Store { pub fn new() -> Self { Store {} } fn put(&self) { self.bump(); } fn bump(&self) {} }",
}
out = {path: [s["id"] for s in parse_file(path, src)["symbols"]] for path, src in fixtures.items()}
# A language CodeGraph never fetches: downloading it needs the network
try:
    registry._pack().download(["elixir"])
    out["download_attempt"], out["download_error"] = True, ""
except Exception as e:
    out["download_attempt"], out["download_error"] = False, str(e)
print(json.dumps(out))
"""


def _offline_env(grammar_dir):
    import os
    env = dict(os.environ)
    dead = "http://127.0.0.1:9"  # nothing listens on the discard port: every connection is refused
    env.update({
        "CODEGRAPH_GRAMMAR_DIR": str(grammar_dir),
        "HTTP_PROXY": dead, "HTTPS_PROXY": dead, "ALL_PROXY": dead,
        "http_proxy": dead, "https_proxy": dead, "all_proxy": dead, "NO_PROXY": "", "no_proxy": "",
        "TREE_SITTER_LANGUAGE_PACK_MANIFEST_URL": "file:///nonexistent/parsers.json",
    })
    return env


def _run_offline(grammar_dir):
    import subprocess
    import sys
    from pathlib import Path
    result = subprocess.run(
        [sys.executable, "-c", OFFLINE_SCRIPT], cwd=Path(__file__).resolve().parent,
        env=_offline_env(grammar_dir), capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


class TestOfflineRuntime:
    def test_js_go_rust_parse_from_cache_with_network_disabled(self):
        out = _run_offline(registry.grammar_dir())
        assert "src/app.js::Editor.render" in out["src/app.js"]
        assert "pkg/server.go::Server.handle" in out["pkg/server.go"]
        assert "src/store.rs::Store.bump" in out["src/store.rs"]

    def test_missing_grammar_is_skipped_not_downloaded(self, tmp_path):
        out = _run_offline(tmp_path)  # empty cache, same network-blocked environment
        assert out["src/app.js"] == [] and out["pkg/server.go"] == [] and out["src/store.rs"] == []
        assert not list(tmp_path.rglob("*tree_sitter_*")), "a grammar library was written at runtime"
        # Proof the environment has no network: an explicit download fails
        assert out["download_attempt"] is False and "Download error" in out["download_error"]
