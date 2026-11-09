# What it does: Tests for call/import resolution in graph_builder.py
# Synthetic Python sources run through parse_repo + build_graph.

import json
import random
import textwrap

from graph_builder import GRAPH_SCHEMA_VERSION, build_graph
from parser import parse_repo


def build(files: dict, repo="o/r") -> dict:
    return build_graph(parse_repo({
        "repo": repo,
        "commit_sha": "abc",
        "files": [{"path": p, "content": textwrap.dedent(c)} for p, c in files.items()],
    }))


def calls(graph) -> set:
    return {(e["source"], e["target"], e["confidence"]) for e in graph["edges"] if e["type"] == "calls"}


def call_pairs(graph) -> set:
    return {(s, t) for s, t, _ in calls(graph)}


def imports(graph) -> set:
    return {(e["source"], e["target"]) for e in graph["edges"] if e["type"] == "imports"}


def node(graph, node_id) -> dict:
    return next(n for n in graph["nodes"] if n["id"] == node_id)


class TestQualifiedIds:
    def test_same_named_methods_are_distinct_nodes_and_self_resolves_to_own_class(self):
        g = build({"pkg/m.py": """
            class A:
                def get(self):
                    return self.close()
                def close(self):
                    pass

            class B:
                def get(self):
                    return 1
                def close(self):
                    pass
        """})
        ids = {n["id"] for n in g["nodes"]}
        assert {"pkg/m.py::A.get", "pkg/m.py::B.get", "pkg/m.py::A.close", "pkg/m.py::B.close"} <= ids
        assert node(g, "pkg/m.py::A.get")["label"] == "get"
        assert node(g, "pkg/m.py::A.get")["class_name"] == "A"
        assert node(g, "pkg/m.py::A.get")["qualified_name"] == "A.get"
        assert call_pairs(g) == {("pkg/m.py::A.get", "pkg/m.py::A.close")}  # never B.close
        assert g["schema_version"] == GRAPH_SCHEMA_VERSION

    def test_nested_class_and_closure_ids(self):
        g = build({"m.py": """
            class Outer:
                class Inner:
                    def run(self):
                        pass

            def outer():
                def helper():
                    pass
                helper()
        """})
        ids = {n["id"] for n in g["nodes"]}
        assert {"m.py::Outer.Inner", "m.py::Outer.Inner.run", "m.py::outer.helper"} <= ids
        assert ("m.py::outer", "m.py::outer.helper") in call_pairs(g)


class TestCallResolution:
    FILES = {
        "app/__init__.py": "",
        "app/storage.py": """
            class Store:
                def __init__(self):
                    self.data = {}
                def get(self, key):
                    return self.data.get(key)
                def snapshot_all(self):
                    return dict(self.data)
        """,
        "app/service.py": """
            import json
            from .storage import Store

            def direct():
                return Store().get("k")

            def via_variable():
                s = Store()
                s.get("k")
                return s.snapshot_all()

            def plain_dict():
                d = {}
                return d.get("k")

            def stdlib():
                return json.loads("{}")
        """,
    }

    def test_constructor_then_method_resolves_exactly(self):
        g = build(self.FILES)
        c = calls(g)
        assert ("app/service.py::direct", "app/storage.py::Store", "exact") in c
        assert ("app/service.py::direct", "app/storage.py::Store.__init__", "exact") in c
        assert ("app/service.py::direct", "app/storage.py::Store.get", "exact") in c

    def test_unknown_receiver_get_is_not_linked_but_unique_name_is_inferred(self):
        g = build(self.FILES)
        c = calls(g)
        # s = Store(); s.get() → unknown receiver; "get" is generic → no edge
        assert not any(s == "app/service.py::via_variable" and t.endswith("Store.get") for s, t, _ in c)
        # s.snapshot_all() → unknown receiver, but exactly one snapshot_all in the repo → inferred
        assert ("app/service.py::via_variable", "app/storage.py::Store.snapshot_all", "inferred") in c

    def test_dict_get_and_stdlib_create_no_edges(self):
        g = build(self.FILES)
        sources = {s for s, _ in call_pairs(g)}
        assert "app/service.py::plain_dict" not in sources
        assert "app/service.py::stdlib" not in sources
        # self.data.get inside Store.get is a dict call too
        assert not any(s == "app/storage.py::Store.get" for s, _ in call_pairs(g))

    def test_ambiguous_unknown_receiver_is_not_inferred(self):
        g = build({
            "a.py": "class A:\n    def refresh(self):\n        pass\n",
            "b.py": "class B:\n    def refresh(self):\n        pass\n",
            "c.py": "def go(x):\n    x.refresh()\n",
        })
        assert not any(s == "c.py::go" for s, _ in call_pairs(g))

    def test_base_class_methods_through_self_and_super(self):
        g = build({
            "pkg/__init__.py": "",
            "pkg/base.py": """
                class Base:
                    def save(self):
                        pass
                    def close(self):
                        pass
            """,
            "pkg/child.py": """
                from pkg.base import Base

                class Child(Base):
                    def close(self):
                        super().close()
                    def work(self):
                        self.save()
                        self.close()
            """,
        })
        pairs = call_pairs(g)
        assert ("pkg/child.py::Child.work", "pkg/base.py::Base.save") in pairs     # inherited via self
        assert ("pkg/child.py::Child.work", "pkg/child.py::Child.close") in pairs  # own override wins
        assert ("pkg/child.py::Child.work", "pkg/base.py::Base.close") not in pairs
        assert ("pkg/child.py::Child.close", "pkg/base.py::Base.close") in pairs  # super()

    def test_class_name_method_call(self):
        g = build({"m.py": """
            class Tools:
                @staticmethod
                def build():
                    pass

            def use():
                Tools.build()
        """})
        assert ("m.py::use", "m.py::Tools.build", "exact") in calls(g)


class TestImports:
    def test_relative_imports_one_and_two_dots_src_layout_and_aliases(self):
        g = build({
            "src/pkg/__init__.py": "",
            "src/pkg/core/__init__.py": "",
            "src/pkg/core/util.py": "def helper():\n    pass\n",
            "src/pkg/core/engine.py": """
                from .util import helper as h
                from ..config import load_config

                def run():
                    h()
                    load_config()
            """,
            "src/pkg/config.py": "def load_config():\n    pass\n",
            "src/pkg/cli.py": """
                import pkg.core.util as u
                from pkg.core import engine
                from pkg import config

                def main():
                    u.helper()
                    engine.run()
                    config.load_config()
            """,
        })
        imp = imports(g)
        assert ("src/pkg/core/engine.py", "src/pkg/core/util.py") in imp       # 1 dot
        assert ("src/pkg/core/engine.py", "src/pkg/config.py") in imp          # 2 dots
        assert ("src/pkg/cli.py", "src/pkg/core/util.py") in imp               # src/ layout + alias
        assert ("src/pkg/cli.py", "src/pkg/core/engine.py") in imp             # submodule via package
        assert ("src/pkg/cli.py", "src/pkg/config.py") in imp

        pairs = call_pairs(g)
        assert ("src/pkg/core/engine.py::run", "src/pkg/core/util.py::helper") in pairs      # from-import alias
        assert ("src/pkg/core/engine.py::run", "src/pkg/config.py::load_config") in pairs
        assert ("src/pkg/cli.py::main", "src/pkg/core/util.py::helper") in pairs             # module alias
        assert ("src/pkg/cli.py::main", "src/pkg/core/engine.py::run") in pairs              # module object
        assert ("src/pkg/cli.py::main", "src/pkg/config.py::load_config") in pairs

    def test_package_reexport_and_plain_dotted_import(self):
        g = build({
            "lib/__init__.py": "from .models import User\n",
            "lib/models.py": "class User:\n    def save(self):\n        pass\n",
            "app.py": """
                import lib.models
                from lib import User

                def create():
                    u = User()
                    lib.models.User.save(u)
            """,
        })
        pairs = call_pairs(g)
        assert ("app.py::create", "lib/models.py::User") in pairs          # re-exported through __init__
        assert ("app.py::create", "lib/models.py::User.save") in pairs     # pkg.mod.Class.method
        assert ("app.py", "lib/models.py") in imports(g)

    def test_third_party_imports_make_no_edges(self):
        g = build({"m.py": "import requests\nfrom jose import jwt\n\ndef f():\n    requests.get('x')\n    jwt.decode('t')\n"})
        assert imports(g) == set()
        assert call_pairs(g) == set()


class TestEntryPoints:
    def test_entry_point_rules(self):
        g = build({
            "tool.py": """
                import click
                from fastapi import FastAPI
                import pytest

                app = FastAPI()

                def main():
                    helper()

                def helper():
                    pass

                def cli_run():
                    pass

                @app.get("/items")
                def list_items():
                    pass

                @click.command()
                def sync():
                    pass

                @pytest.fixture
                def client():
                    pass

                def never_called():
                    pass

                class Service:
                    def __init__(self):
                        pass
                    def public(self):
                        pass

                cli_run()

                if __name__ == "__main__":
                    main()
            """,
        })
        entry = {n["label"] for n in g["nodes"] if n.get("is_entry_point")}
        assert entry == {"main", "cli_run", "list_items", "sync"}
        assert g["stats"]["entry_points"] == 4


class TestDeterminism:
    def test_same_output_regardless_of_file_order(self):
        files = dict(TestCallResolution.FILES)
        first = json.dumps(build(files), sort_keys=True)
        items = list(files.items())
        random.Random(3).shuffle(items)
        second = json.dumps(build(dict(items)), sort_keys=True)
        assert first == second
