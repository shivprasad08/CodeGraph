# What it does: Tests for adaptive architecture grouping (architecture.py)

import random
import time

from architecture import build_architecture, is_hidden


def make_graph(files, links=(), entry=(), symbols=None):
    """
    files: paths; links: (file_a, file_b, n_calls). Each file gets one function `run`,
    plus extra functions to reach symbols[path] when given.
    """
    nodes, edges = [], []
    for f in files:
        nodes.append({"id": f, "type": "file", "file": f})
        nodes.append({"id": f"{f}::run", "type": "function", "file": f, "is_entry_point": f in entry})
        edges.append({"source": f, "target": f"{f}::run", "type": "defines"})
        for i in range(1, (symbols or {}).get(f, 1)):
            nodes.append({"id": f"{f}::extra{i}", "type": "function", "file": f})
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
        # x/ and y/ hold one file each, so they are not folder modules: the repo is clustered
        a, la = clustered("", ["a2", "a3"], strength=9)
        b, lb = clustered("", ["b2", "b3"], strength=9)
        c, lc = clustered("", ["c1", "c2", "c3"])
        hubs = [("x/app.py", "a2.py", 12), ("x/app.py", "a3.py", 12), ("y/app.py", "b2.py", 12), ("y/app.py", "b3.py", 12)]  # app.py is each hub
        arch = build_architecture(make_graph(a + b + c + ["x/app.py", "y/app.py"], la + lb + lc + hubs))
        assert arch["method"] == "communities"
        assert {"x/app + 2 files", "y/app + 2 files"} <= set(labels(arch))


def module(arch, label):
    return next(m for m in arch["modules"] if m["label"] == label)


class TestFolders:
    """Real folders are modules; loose root files attach or are clustered (fix 3)."""

    def mini_redis_like(self):
        folders = ["election", "health", "membership", "mutex", "replication", "sharding", "time_sync", "txn"]
        files, links = [], []
        for d in folders:
            members, inner = clustered(f"src/pkg/{d}/", ["a", "b"], strength=3)
            files += members
            links += inner
        # 20 loose root files: two connected groups of 8, plus 4 files tied to one folder each
        g1, l1 = clustered("src/pkg/", [f"net{i}" for i in range(8)], strength=2)
        g2, l2 = clustered("src/pkg/", [f"store{i}" for i in range(8)], strength=2)
        tied = ["src/pkg/ring_helpers.py", "src/pkg/quorum.py", "src/pkg/clock.py", "src/pkg/weak.py"]
        links += l1 + l2 + [
            ("src/pkg/ring_helpers.py", "src/pkg/election/a.py", 5),   # clear: 5 vs 0 → joins election
            ("src/pkg/quorum.py", "src/pkg/membership/a.py", 4),       # clear: 4 vs 1 → joins membership
            ("src/pkg/quorum.py", "src/pkg/txn/a.py", 1),
            ("src/pkg/clock.py", "src/pkg/time_sync/a.py", 3),         # ambiguous: 3 vs 2 → stays loose
            ("src/pkg/clock.py", "src/pkg/mutex/a.py", 2),
            ("src/pkg/weak.py", "src/pkg/txn/a.py", 2),                # too weak (<3) → stays loose
            ("src/pkg/clock.py", "src/pkg/weak.py", 1),
        ]
        return files + g1 + g2 + tied, links, folders

    def test_all_folders_are_modules_and_loose_files_cluster(self):
        files, links, folders = self.mini_redis_like()
        arch = build_architecture(make_graph(files, links))
        assert arch["method"] == "hybrid"
        assert set(folders) <= set(labels(arch))
        assert "src/pkg/ring_helpers.py" in module(arch, "election")["files"]
        assert "src/pkg/quorum.py" in module(arch, "membership")["files"]
        loose_modules = [m for m in arch["modules"] if m["label"] not in folders]
        assert {"src/pkg/clock.py", "src/pkg/weak.py"} <= {f for m in loose_modules for f in m["files"]}
        assert {tuple(sorted(f"src/pkg/net{i}.py" for i in range(8))), tuple(sorted(f"src/pkg/store{i}.py" for i in range(8)))} \
            <= {tuple(m["files"]) for m in loose_modules}
        assert any(m["label"].endswith(" + 7 files") for m in loose_modules)

    def test_only_folders_means_directories(self):
        files = [f"pkg/{d}/{n}.py" for d in ("api", "core", "db") for n in ("a", "b")]
        arch = build_architecture(make_graph(files, [("pkg/api/a.py", "pkg/core/a.py", 2)]))
        assert arch["method"] == "directories" and labels(arch) == ["api", "core", "db"]

    def test_smallest_loose_clusters_merge_into_core_above_15_modules(self):
        files, links = [], []
        for i in range(13):
            members, inner = clustered(f"pkg/f{i:02d}/", ["a", "b"])
            files += members
            links += inner
        for i in range(6):  # six separate loose pairs → six clusters
            members, inner = clustered("pkg/", [f"l{i}a", f"l{i}b"])
            files += members
            links += inner
        arch = build_architecture(make_graph(files, links))
        assert len(arch["modules"]) == 15
        assert "core" in labels(arch)
        assert sum(len(m["files"]) for m in arch["modules"]) == len(files)

    def test_a_folder_holding_most_files_is_treated_as_the_root(self):
        # Briefly-like: everything in backend/, one script at the root → clustered, not one box
        a, la = clustered("backend/", ["auth", "users", "tokens"])
        b, lb = clustered("backend/", ["db", "models", "migrate"])
        c, lc = clustered("backend/", ["search", "rank", "index_docs"])
        arch = build_architecture(make_graph(a + b + c + ["check_db.py"], la + lb + lc))
        assert arch["method"] == "communities"
        assert len(arch["modules"]) == 4 and "standalone" in labels(arch)

    def test_javascript_repo_with_loose_root_files(self):
        comps, lc = clustered("src/components/", ["Editor", "Toolbar", "Sidebar"])
        libs, ll = clustered("src/lib/", ["socket", "rooms"])
        files = [p.replace(".py", ".jsx") for p in comps] + [p.replace(".py", ".js") for p in libs] + ["src/App.jsx", "src/main.jsx"]
        rename = lambda p: p.replace(".py", ".jsx") if "components" in p else p.replace(".py", ".js")
        links = [(rename(a), rename(b), n) for a, b, n in lc + ll] + [
            ("src/App.jsx", "src/components/Editor.jsx", 3), ("src/App.jsx", "src/components/Toolbar.jsx", 2),
            ("src/main.jsx", "src/App.jsx", 1),
        ]
        arch = build_architecture(make_graph(files, links))
        assert {"components", "lib"} <= set(labels(arch))
        assert "src/App.jsx" in module(arch, "components")["files"]  # 5 to components, 0 elsewhere
        assert all(not m["label"].endswith(".jsx") for m in arch["modules"])

    def test_rust_repo_with_loose_root_files(self):
        walk, lw = clustered("src/walk/", ["mod", "filter"])
        exe, le = clustered("src/exec/", ["mod", "job"])
        files = [p.replace(".py", ".rs") for p in walk + exe] + ["src/main.rs", "src/cli.rs", "src/output.rs"]
        rs = lambda p: p.replace(".py", ".rs")
        links = [(rs(a), rs(b), n) for a, b, n in lw + le] + [
            ("src/main.rs", "src/walk/mod.rs", 4), ("src/main.rs", "src/exec/mod.rs", 4),  # tie → stays loose
            ("src/main.rs", "src/cli.rs", 3), ("src/cli.rs", "src/output.rs", 2),
        ]
        arch = build_architecture(make_graph(files, links))
        assert arch["method"] == "hybrid"
        assert {"walk", "exec"} <= set(labels(arch))
        loose = [m for m in arch["modules"] if m["label"] not in ("walk", "exec")]
        assert sorted(f for m in loose for f in m["files"]) == ["src/cli.rs", "src/main.rs", "src/output.rs"]


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


class TestSingleFileFolders:
    def test_a_one_file_folder_with_three_definitions_is_a_module(self):
        files, links = [], []
        for d in ("election", "mutex", "txn"):
            members, inner = clustered(f"pkg/{d}/", ["a", "b"])
            files += members
            links += inner
        files += ["pkg/health/heartbeat.py", "pkg/sharding/hashring.py", "pkg/node.py", "pkg/server.py"]
        links += [("pkg/node.py", "pkg/server.py", 3)]
        arch = build_architecture(make_graph(files, links, symbols={"pkg/health/heartbeat.py": 3, "pkg/sharding/hashring.py": 2}))
        assert "health" in labels(arch)          # 1 file, 3 definitions → a module
        assert "sharding" not in labels(arch)    # 1 file, 2 definitions → loose
        assert any("pkg/sharding/hashring.py" in m["files"] for m in arch["modules"])


def codeeditor_like():
    """client/src/{components,lib}, server/services/{a,b,c}, server/src/{lib,routes}: three apps."""
    files, links = [], []
    for folder, names in (
        ("client/src/components/", ["Editor", "Toolbar", "Sidebar"]),
        ("client/src/lib/", ["socket", "rooms"]),
        ("server/services/submit/", ["api", "store"]),
        ("server/services/worker/", ["run", "queue"]),
        ("server/services/ws/", ["hub", "rooms"]),
        ("server/src/lib/", ["mongo", "cache"]),
        ("server/src/routes/", ["rooms", "health"]),
    ):
        members, inner = clustered(folder, names)
        files += members
        links += inner
    files += ["client/src/App.py", "client/src/main.py"]
    links += [
        ("client/src/App.py", "client/src/components/Editor.py", 4),
        ("client/src/components/Editor.py", "client/src/lib/socket.py", 2),
        ("server/src/routes/rooms.py", "server/src/lib/mongo.py", 3),
        ("server/services/submit/api.py", "server/services/worker/queue.py", 2),
    ]
    return files, links


class TestTwoLevels:
    def test_multi_app_repo_gets_one_group_per_app(self):
        files, links = codeeditor_like()
        arch = build_architecture(make_graph(files, links))
        groups = {g["label"]: g for g in arch["groups"]}
        assert set(groups) == {"client/src", "services", "server/src"}
        for g in groups.values():
            members = [m for m in arch["modules"] if m.get("parent") == g["id"]]
            assert len(members) >= 2, g["label"]
            assert sorted(f for m in members for f in m["files"]) == g["files"]
        client = {m["label"] for m in arch["modules"] if m.get("parent") == groups["client/src"]["id"]}
        assert {"components", "lib"} <= client
        server = {m["label"] for m in arch["modules"] if m.get("parent") == groups["server/src"]["id"]}
        assert server == {"lib", "routes"}  # "lib" may repeat: the group tells them apart
        assert len({m["id"] for m in arch["modules"]}) == len(arch["modules"])
        # Edges between modules of different groups are still listed
        assert any(e["source"].startswith("mod:client") and e["target"].startswith("mod:client") for e in arch["edges"])

    def test_single_app_repos_have_no_groups(self):
        files, links, folders = TestFolders().mini_redis_like()
        arch = build_architecture(make_graph(files, links))
        assert "groups" not in arch and not any("parent" in m for m in arch["modules"])
        flat, flat_links = clustered("", ["a", "b", "c", "d"])
        assert "groups" not in build_architecture(make_graph(flat, flat_links))

    def test_group_core_merge_keeps_the_module_cap(self):
        files, links = [], []
        for app in ("alpha", "beta", "gamma"):
            for i in range(3):
                members, inner = clustered(f"{app}/f{i}/", ["a", "b"])
                files += members
                links += inner
            for i in range(8):  # eight unlinked pairs of loose files per app → eight clusters
                members, inner = clustered(f"{app}/", [f"l{i}a", f"l{i}b"])
                files += members
                links += inner
        arch = build_architecture(make_graph(files, links))
        assert {g["label"] for g in arch["groups"]} == {"alpha", "beta", "gamma"}
        assert len(arch["modules"]) <= 15  # 3 × (3 folders + 8 clusters) = 33 before merging
        assert {"alpha core", "beta core", "gamma core"} & set(labels(arch))
        assert sorted(f for m in arch["modules"] for f in m["files"]) == sorted(files)

