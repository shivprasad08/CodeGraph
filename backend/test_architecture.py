# What it does: Tests for adaptive architecture grouping (architecture.py)

import random
import time

from architecture import build_architecture, is_hidden


def make_graph(files, links=(), entry=()):
    """files: paths; links: (file_a, file_b, n_calls). Each file gets one function `run`."""
    nodes, edges = [], []
    for f in files:
        nodes.append({"id": f, "type": "file", "file": f})
        nodes.append({"id": f"{f}::run", "type": "function", "file": f, "is_entry_point": f in entry})
        edges.append({"source": f, "target": f"{f}::run", "type": "defines"})
    for a, b, n in links:
        edges.extend({"source": f"{a}::run", "target": f"{b}::run", "type": "calls"} for _ in range(n))
    return {"nodes": nodes, "edges": edges}


def labels(arch):
    return sorted(m["label"] for m in arch["modules"])


def module_files(arch):
    return sorted(tuple(m["files"]) for m in arch["modules"])


def clustered(prefix, names, strength=5):
    """Fully connected cluster of files."""
    files = [f"{prefix}{n}.py" for n in names]
    return files, [(a, b, strength) for i, a in enumerate(files) for b in files[i + 1:]]


class TestDirectories:
    def test_nested_package_groups_by_directory(self):
        files = [f"src/pkg/{d}/{n}.py" for d in ("api", "core", "db", "ui") for n in ("a", "b")]
        links = [
            ("src/pkg/api/a.py", "src/pkg/core/a.py", 3),
            ("src/pkg/api/b.py", "src/pkg/core/b.py", 2),
            ("src/pkg/core/a.py", "src/pkg/db/a.py", 1),   # weight 1 → dropped
            ("src/pkg/api/a.py", "src/pkg/api/b.py", 9),   # inside one module → no self-loop
        ]
        arch = build_architecture(make_graph(files, links, entry={"src/pkg/api/a.py"}))
        assert arch["method"] == "directories"
        assert labels(arch) == ["api", "core", "db", "ui"]
        assert arch["edges"] == [{"source": "mod:api", "target": "mod:core", "calls": 5, "imports": 0, "weight": 5}]
        api = next(m for m in arch["modules"] if m["label"] == "api")
        assert api["files"] == ["src/pkg/api/a.py", "src/pkg/api/b.py"]
        assert api["function_count"] == 2 and api["class_count"] == 0 and api["has_entry_points"]


class TestCommunities:
    def test_flat_repo_with_three_clusters(self):
        a, la = clustered("", ["auth", "users", "tokens", "sessions"])
        b, lb = clustered("", ["search", "index", "rank", "query"])
        c, lc = clustered("", ["db", "models", "migrate", "seed"])
        bridges = [("auth.py", "db.py", 1), ("search.py", "db.py", 1)]
        arch = build_architecture(make_graph(a + b + c, la + lb + lc + bridges))
        assert arch["method"] == "communities"
        assert len(arch["modules"]) == 3
        assert module_files(arch) == sorted(tuple(sorted(x)) for x in (a, b, c))
        for m in arch["modules"]:
            assert m["label"].endswith(" + 3 files")

    def test_isolated_files_go_to_standalone(self):
        a, la = clustered("", ["a1", "a2", "a3"])
        b, lb = clustered("", ["b1", "b2", "b3"])
        c, lc = clustered("", ["c1", "c2", "c3"])
        arch = build_architecture(make_graph(a + b + c + ["lonely.py", "alone.py"], la + lb + lc))
        standalone = next(m for m in arch["modules"] if m["label"] == "standalone")
        assert standalone["files"] == ["alone.py", "lonely.py"]

    def test_duplicate_hub_stems_get_their_parent_directory(self):
        a, la = clustered("x/", ["app", "a2", "a3"], strength=9)
        b, lb = clustered("y/", ["app", "b2", "b3"], strength=9)
        c, lc = clustered("", ["c1", "c2", "c3"])
        hubs = [("x/app.py", "x/a2.py", 4), ("x/app.py", "x/a3.py", 4), ("y/app.py", "y/b2.py", 4), ("y/app.py", "y/b3.py", 4)]  # app.py is the best-connected file in each
        arch = build_architecture(make_graph(a + b + c, la + lb + lc + hubs))
        assert {"x/app + 2 files", "y/app + 2 files"} <= set(labels(arch))


class TestHybrid:
    def test_lopsided_directory_is_split_into_communities(self):
        core_a, la = clustered("pkg/core/", ["a1", "a2", "a3", "a4"])
        core_b, lb = clustered("pkg/core/", ["b1", "b2", "b3", "b4"])
        others = ["pkg/api/x.py", "pkg/cli/y.py", "pkg/db/z.py"]
        arch = build_architecture(make_graph(core_a + core_b + others, la + lb + [("pkg/core/a1.py", "pkg/core/b1.py", 1)]))
        assert arch["method"] == "hybrid"
        assert {"api", "cli", "db"} <= set(labels(arch))
        assert tuple(sorted(core_a)) in module_files(arch)
        assert tuple(sorted(core_b)) in module_files(arch)
        assert len(arch["modules"]) == 5


class TestHidden:
    def test_tests_scripts_and_setup_files_are_hidden(self):
        hidden = [
            "tests/test_api.py", "pkg/test_util.py", "pkg/util_test.py", "scripts/run.py",
            "examples/demo.py", "docs/conf.py", "migrations/0001.py", "setup.py", "conftest.py",
        ]
        for f in hidden:
            assert is_hidden(f), f
        files = [f"pkg/{d}/m.py" for d in ("a", "b", "c", "d")] + hidden
        arch = build_architecture(make_graph(files, [("tests/test_api.py", "pkg/a/m.py", 5)]))
        assert arch["hidden"] == sorted(hidden)
        shown = {f for m in arch["modules"] for f in m["files"]}
        assert not shown & set(hidden)
        assert arch["edges"] == []  # edges to hidden files are not module edges


class TestDeterminismAndSpeed:
    def test_same_output_for_shuffled_input(self):
        a, la = clustered("", ["a1", "a2", "a3", "a4"])
        b, lb = clustered("", ["b1", "b2", "b3", "b4"])
        c, lc = clustered("", ["c1", "c2", "c3", "c4"])
        graph = make_graph(a + b + c + ["solo.py"], la + lb + lc + [("a1.py", "b1.py", 2)])
        first = build_architecture(graph)
        rng = random.Random(7)
        for _ in range(3):
            shuffled = {"nodes": rng.sample(graph["nodes"], len(graph["nodes"])), "edges": rng.sample(graph["edges"], len(graph["edges"]))}
            assert build_architecture(shuffled) == first

    def test_sixty_files_under_200ms(self):
        rng = random.Random(1)
        files = [f"m{i:02d}.py" for i in range(60)]
        links = [(rng.choice(files), rng.choice(files), rng.randint(1, 4)) for _ in range(400)]
        graph = make_graph(files, [l for l in links if l[0] != l[1]])
        start = time.perf_counter()
        build_architecture(graph)
        assert time.perf_counter() - start < 0.2
