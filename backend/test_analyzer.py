# What it does: Tests for the size-normalized health score in analyzer.py

from analyzer import compute_health_score, grade_for_score


def _graph(functions: int, classes: int = 0, files: int = 1, fn_length: int = 10) -> dict:
    nodes = [{"id": f"f{i}.py", "type": "file"} for i in range(files)]
    nodes += [{"id": f"f0.py::fn{i}", "type": "function", "lines": [1, 1 + fn_length]} for i in range(functions)]
    nodes += [{"id": f"f0.py::C{i}", "type": "class", "lines": [1, 5]} for i in range(classes)]
    return {"nodes": nodes, "edges": []}


def _issues(high: int = 0, medium: int = 0, low: int = 0) -> list[dict]:
    out = []
    for sev, n in (("high", high), ("medium", medium), ("low", low)):
        out += [{"severity": sev, "type": "quality", "message": f"{sev} issue"} for _ in range(n)]
    return out


def test_mini_redis_like_repo_scores_b_or_better():
    # mini_redis: 0 high / 37 medium / 33 low over 700 functions + 87 classes
    result = compute_health_score(_issues(0, 37, 33), _graph(700, 87, files=41), [])
    assert result["grade"] in ("A", "B")
    assert result["score"] >= 80


def test_tiny_file_with_five_high_issues_is_f():
    result = compute_health_score(_issues(high=5), _graph(3), [])
    assert result["grade"] == "F"
    assert result["score"] < 60


def test_empty_repo_scores_100():
    result = compute_health_score([], {"nodes": [], "edges": []}, [])
    assert result["score"] == 100
    assert result["grade"] == "A"


def test_same_issue_density_gives_same_score_regardless_of_size():
    small = compute_health_score(_issues(medium=2), _graph(20), [])
    large = compute_health_score(_issues(medium=20), _graph(200), [])
    assert small["score"] == large["score"]


def test_pattern_bonus_is_capped_at_five():
    base = compute_health_score(_issues(medium=20), _graph(100), [])
    boosted = compute_health_score(_issues(medium=20), _graph(100), [{"name": "Factory"}] * 12)
    assert boosted["score"] - base["score"] == 5


def test_score_is_clamped_and_metrics_kept():
    result = compute_health_score(_issues(high=500), _graph(10), [])
    assert result["score"] == 0
    assert set(result["metrics"]) >= {"total_files", "total_functions", "total_classes", "avg_function_length"}


def test_grade_boundaries():
    assert [grade_for_score(s) for s in (100, 90, 89, 80, 79, 70, 69, 60, 59, 0)] == [
        "A", "A", "B", "B", "C", "C", "D", "D", "F", "F",
    ]


# ---------------------------------------------------------------------------
# Dead code, parameter count, God objects (IR-based, every language)
# ---------------------------------------------------------------------------
import textwrap  # noqa: E402

from analyzer import analyze_repo  # noqa: E402
from graph_builder import build_graph  # noqa: E402
from parser import parse_repo  # noqa: E402


def _analyze(files: dict) -> dict:
    files = {p: textwrap.dedent(c) for p, c in files.items()}
    po = parse_repo({"repo": "o/r", "commit_sha": "abc", "files": [{"path": p, "content": c} for p, c in files.items()]})
    return analyze_repo(po, files, build_graph(po))


def _dead(result) -> dict:
    return {i["function"]: i for i in result["issues"] if i["type"] == "dead_code"}


class TestDeadCode:
    def test_python_unused_function_is_flagged_and_used_ones_are_not(self):
        r = _analyze({"app/svc.py": """
            import threading
            from flask import Flask
            app = Flask(__name__)

            def used():
                return 1

            def caller():
                return used()

            def forgotten_helper():
                return 2

            @app.route("/items")
            def list_items():
                return []

            class Store:
                def __init__(self):
                    self.x = 1
                def __repr__(self):
                    return "Store"
                @property
                def size(self):
                    return 0
                def stale_method(self):
                    return 3

            class Worker(threading.Thread):
                def run(self):
                    pass
                def on_stop(self):
                    pass

            def main():
                caller()

            if __name__ == "__main__":
                main()
        """})
        dead = _dead(r)
        assert set(dead) == {"forgotten_helper", "stale_method"}
        assert dead["forgotten_helper"]["message"] == "No callers found — may be unused"
        assert dead["forgotten_helper"]["severity"] == "low" and dead["forgotten_helper"]["confidence"] == "likely"
        # not flagged: called, decorated route, dunders, @property, override of a third-party base, entry point
        assert r["metrics"]["dead_code_count"] == 2

    def test_referenced_by_name_is_not_dead(self):
        r = _analyze({"m.py": """
            def on_message(msg):
                return msg

            HANDLERS = {"message": on_message}
        """})
        assert _dead(r) == {}

    def test_basic_support_languages_say_possibly_and_skip_exported(self):
        r = _analyze({
            "src/util.js": """
                export function publicApi() {}
                function privateUnused() {}
                function privateUsed() {}
                export const run = () => privateUsed();
            """,
            "pkg/lib.go": "package lib\nfunc Exported() {}\nfunc unexported() {}\n",
        })
        dead = _dead(r)
        assert set(dead) == {"privateUnused", "unexported"}
        assert dead["privateUnused"]["message"] == "No callers found — possibly unused"
        assert dead["privateUnused"]["confidence"] == "possible"


class TestParametersAndGodObjects:
    def test_more_than_six_parameters_in_any_language(self):
        r = _analyze({
            "a.py": "class C:\n    def ok(self, a, b, c, d, e, f):\n        pass\n    def many(self, a, b, c, d, e, f, g):\n        pass\n",
            "b.ts": "export function wide(a, b, c, d, e, f, g, h) {}\nexport function narrow(this: Foo, a: number) {}\n",
            "c.go": "package c\nfunc Wide(a, b, c, d int, e, f, g string) {}\n",
        })
        flagged = {i["function"]: i["message"] for i in r["issues"] if "parameters" in i["message"]}
        assert flagged == {
            "many": "Function many has 7 parameters — may indicate poor design",   # self not counted
            "wide": "Function wide has 8 parameters — may indicate poor design",
            "Wide": "Function Wide has 7 parameters — may indicate poor design",    # a, b, c, d int = 4
        }
        assert all(i["severity"] == "medium" for i in r["issues"] if "parameters" in i["message"])

    def test_god_object_by_methods_or_lines(self):
        many = "class Big:\n" + "".join(f"    def m{i}(self):\n        return {i}\n" for i in range(26))
        long_body = "class Long:\n    def one(self):\n" + "        x = 1\n" * 610
        small = "class Small:\n" + "".join(f"    def m{i}(self):\n        return {i}\n" for i in range(25))
        r = _analyze({"big.py": many, "long.py": long_body, "small.py": small})
        gods = {i["file"]: i["message"] for i in r["issues"] if "God Object" in i["message"]}
        assert gods["big.py"] == "Class Big has 26 methods across 53 lines — possible God Object"
        assert gods["long.py"].startswith("Class Long has 1 methods across 612 lines")
        assert "small.py" not in gods
