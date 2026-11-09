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
