# What it does: PR risk calibration — docs-only and format-only changes, containers not counted
# for their methods, real logic changes, mixed PRs and plural wording. Uses the real parsers and
# graph builder with real unified diffs, so line ranges, docstrings and decorators behave as on
# a live PR.

import difflib
import re

import pytest

import graph_builder
import parser
import pr_impact

META = {"owner": "acme", "repo": "app", "full_name": "acme/app", "number": 9, "title": "Tidy", "author": "dev",
        "state": "open", "html_url": "https://github.com/acme/app/pull/9", "base_sha": "a" * 40, "head_sha": "b" * 40,
        "head_repo": "acme/app", "is_fork": False}

PY = '''class Scaffold:
    """Base."""

    def __init__(self, name):
        self.name = name

    @setupmethod
    def get(self, rule):
        """Register GET."""
        return self.route(rule, methods=["GET"])

    def route(self, rule, methods=None):
        # build the route
        return (rule, methods)


def helper(x):
    """Help."""
    return x + 1


def caller():
    return helper(2) + Scaffold("a").get("/")
'''


def build(files: dict, sha: str) -> dict:
    ingested = {"repo": "acme/app", "commit_sha": sha, "manifests": {},
                "files": [{"path": p, "content": c} for p, c in files.items()]}
    graph = graph_builder.build_graph(parser.parse_repo(ingested))
    return graph


def run(before: dict, after: dict, extra_files=()):
    pr_files = []
    for path in sorted(set(before) | set(after)):
        a, b = before.get(path, ""), after.get(path, "")
        if a == b:
            continue
        patch = "".join(difflib.unified_diff(a.splitlines(True), b.splitlines(True), n=3))
        pr_files.append({"filename": path, "status": "modified", "additions": patch.count("\n+"),
                         "deletions": patch.count("\n-"), "patch": patch})
    pr_files += list(extra_files)
    result = pr_impact.analyse(META, pr_files, build(before, "aaaaaaaa"), build(after, "bbbbbbbb"),
                               sources={"base": before, "head": after})
    return result


def kinds(result):
    return {c["qualified_name"]: c["kind"] for c in result["changes"]}


def points(result):
    return {f["key"]: f["points"] for f in result["risk"]["factors"]}


def test_docstring_only_change_is_docs_and_scores_near_zero():
    after = PY.replace('"""Register GET."""', '"""Register GET.\n\n        .. versionchanged:: 3.1\n            Accepts a rule.\n        """')
    result = run({"app/scaffold.py": PY}, {"app/scaffold.py": after})
    assert kinds(result) == {"Scaffold.get": "docs"}
    assert result["risk"]["score"] <= 5
    p = points(result)
    assert p["changed"] == 0 and p["hubs"] == 0 and p["tests"] == 0 and p["blast"] == 0
    tests = next(f for f in result["risk"]["factors"] if f["key"] == "tests")
    assert tests["reason"] == "Documentation or formatting only"
    assert result["impacted"] == [] and result["stats"]["changed"] == 0 and result["stats"]["docs"] == 1
    assert all(not n.get("pr_change") for n in result["subgraph"]["nodes"])  # not traced


def test_comment_only_js_change_is_docs():
    js = "function add(a, b) {\n  // add numbers\n  return a + b;\n}\n\nfunction twice(x) {\n  return add(x, x);\n}\n"
    after = js.replace("// add numbers", "// add two numbers, see the docs")
    result = run({"src/math.js": js}, {"src/math.js": after})
    assert kinds(result) == {"add": "docs"}
    assert result["risk"]["score"] == 0


def test_whitespace_only_change_is_format():
    after = PY.replace("    return x + 1", "    return  x+1\n")
    result = run({"app/scaffold.py": PY}, {"app/scaffold.py": after})
    assert kinds(result) == {"helper": "format"}
    assert result["risk"]["score"] == 0


def test_adding_a_method_does_not_mark_its_class():
    method = '\n    @setupmethod\n    def query(self, rule):\n        return self.route(rule, methods=["QUERY"])\n'
    after = PY.replace('        return self.route(rule, methods=["GET"])\n', '        return self.route(rule, methods=["GET"])\n' + method)
    result = run({"app/scaffold.py": PY}, {"app/scaffold.py": after})
    assert kinds(result) == {"Scaffold.query": "added"}
    assert result["stats"]["changed"] == 1


def test_changing_class_attributes_still_marks_the_class():
    after = PY.replace('    """Base."""\n', '    """Base."""\n\n    default_methods = ("GET",)\n')
    result = run({"app/scaffold.py": PY}, {"app/scaffold.py": after})
    assert kinds(result) == {"Scaffold": "modified"}


def test_real_logic_change_is_still_modified():
    after = PY.replace("return x + 1", "return x + 2")
    result = run({"app/scaffold.py": PY}, {"app/scaffold.py": after})
    assert kinds(result) == {"helper": "modified"}
    assert [i["id"] for i in result["impacted"]] == ["app/scaffold.py::caller"]
    assert points(result)["tests"] == 10  # code changed, no tests


def test_mixed_pr_scores_only_the_logic_change():
    funcs = "".join(f'\n\ndef f{i}(v):\n    """Doc {i}."""\n    return v * {i}\n' for i in range(5))
    before = PY + funcs
    after = before.replace("return x + 1", "return x + 2")
    for i in range(5):
        after = after.replace(f'"""Doc {i}."""', f'"""Doc {i}, now clearer."""')
    result = run({"app/scaffold.py": before}, {"app/scaffold.py": after})
    k = kinds(result)
    assert k["helper"] == "modified" and sum(v == "docs" for v in k.values()) == 5 and len(k) == 6
    changed = next(f for f in result["risk"]["factors"] if f["key"] == "changed")
    assert changed["points"] == 1
    assert changed["reason"] == "1 function changed (0 added, 1 modified, 0 removed); 5 documentation or formatting changes not counted"


def test_without_sources_a_change_stays_modified():
    after = PY.replace('"""Help."""', '"""Help me."""')
    files = [{"filename": "app/scaffold.py", "status": "modified",
              "patch": "".join(difflib.unified_diff(PY.splitlines(True), after.splitlines(True)))}]
    result = pr_impact.analyse(META, files, build({"app/scaffold.py": PY}, "a"), build({"app/scaffold.py": after}, "b"))
    assert kinds(result) == {"helper": "modified"}  # never under-reported when the source is missing


@pytest.mark.parametrize("entries,expected", [
    ([{"type": "function"}], "1 function"),
    ([{"type": "function"}] * 2, "2 functions"),
    ([{"type": "class"}], "1 class"),
    ([{"type": "class"}] * 3, "3 classes"),
    ([{"type": "class"}, {"type": "function"}], "2 functions or classes"),
])
def test_plural_wording(entries, expected):
    assert pr_impact._what(entries) == expected


def test_no_generated_text_says_classs_or_mismatched_plurals():
    texts = []
    variants = [
        PY.replace("return x + 1", "return x + 2"),
        PY.replace('    """Base."""\n', '    """Base."""\n    attr = 1\n').replace("return x + 1", "return x + 2"),
        PY.replace('"""Help."""', '"""Help!"""'),
        PY.replace("# build the route", "# build it"),
    ]
    for after in variants:
        result = run({"app/scaffold.py": PY}, {"app/scaffold.py": after})
        changes = {c["id"]: c for c in result["changes"]}
        impacted = {i["id"]: i for i in result["impacted"]}
        texts += [f["reason"] for f in result["risk"]["factors"]]
        texts.append(pr_impact.deterministic_summary(result["pr"], changes, impacted, [m["label"] for m in result["modules"]],
                                                     result["signals"], result["risk"]))
    blob = "\n".join(texts)
    assert "classs" not in blob
    assert not re.search(r"\b1 (functions|classes|callers|modules|signals|test files)\b", blob)
    assert not re.search(r"\b([02-9]|\d\d+) (function|class|caller|module|signal|test file)\b(?! or)", blob)


# ---------------------------------------------------------------------------
# AI summary must not contradict the analysis
# ---------------------------------------------------------------------------
from unittest.mock import patch  # noqa: E402


@pytest.mark.asyncio
@pytest.mark.parametrize("ai_text,kept", [
    ("Updates helper to add one instead of two. Reviewers should check callers.", True),
    ("Updates helper, changing its signature and error handling.", False),
    ("helper now takes a new parameter for the offset.", False),
    ("This is a breaking change for callers of helper.", False),
])
async def test_ai_summary_that_contradicts_the_facts_is_replaced(ai_text, kept):
    result = run({"app/scaffold.py": PY}, {"app/scaffold.py": PY.replace("return x + 1", "return x + 2")})
    with patch("pr_impact.ai_summary", return_value=ai_text):
        out = await pr_impact.summarise(result)
    assert out["summary"]["source"] == ("ai" if kept else "rules")
    assert (out["summary"]["text"] == ai_text) is kept


@pytest.mark.asyncio
async def test_real_signature_change_may_be_mentioned():
    after = PY.replace("def helper(x):", "def helper(x, step=1):").replace("return x + 1", "return x + step")
    result = run({"app/scaffold.py": PY}, {"app/scaffold.py": after})
    assert result["changes"][0]["signature_changed"]
    with patch("pr_impact.ai_summary", return_value="helper's signature gains a step parameter."):
        out = await pr_impact.summarise(result)
    assert out["summary"]["source"] == "ai"


def test_prompt_states_when_there_are_no_signature_changes():
    result = run({"app/scaffold.py": PY}, {"app/scaffold.py": PY.replace("return x + 1", "return x + 2")})
    changes = {c["id"]: c for c in result["changes"]}
    prompt = pr_impact.summary_prompt(result["pr"], changes, {}, [], [], result["risk"])
    assert "Signature changes: none" in prompt and "Breaking-change signals: none" in prompt


# ---------------------------------------------------------------------------
# Fact check: paraphrased claims (the #6168 sentence and friends)
# ---------------------------------------------------------------------------
FLASK_6168 = {
    "changes": [
        {"id": "src/flask/helpers.py::_CollectErrors.raise_any", "qualified_name": "_CollectErrors.raise_any", "label": "raise_any",
         "kind": "modified", "signature_changed": False, "file": "src/flask/helpers.py", "type": "function"},
        {"id": "src/flask/sessions.py::SessionInterface.get_expiration_time", "qualified_name": "SessionInterface.get_expiration_time",
         "label": "get_expiration_time", "kind": "modified", "signature_changed": False, "file": "src/flask/sessions.py", "type": "function"},
        {"id": "src/flask/cli.py::SeparatedPathType.convert", "qualified_name": "SeparatedPathType.convert", "label": "convert",
         "kind": "docs", "signature_changed": False, "file": "src/flask/cli.py", "type": "function"},
    ],
    "impacted": [{"id": f"i{k}", "depth": 1} for k in range(4)] + [{"id": "i4", "depth": 2}],
    "modules": [{"label": "app + 3 files", "changed": 1, "impacted": 5}, {"label": "helpers + 2 files", "changed": 2, "impacted": 0}],
    "signals": [],
    "files": [{"mapped": True, "test": False}] * 3 + [{"mapped": False, "test": True}] * 4 + [{"mapped": False, "test": False}] * 5,
}


@pytest.mark.parametrize("text,rule", [
    ("In src/flask/helpers.py the _CollectErrors.raise_any method now raises a single exception instead of a list, "
     "changing its signature and error handling.", "signature"),
    ("This changes the signature of _CollectErrors.raise_any.", "signature"),
    ("_CollectErrors.raise_any's parameters were updated.", "signature"),
    ("get_expiration_time now accepts a timeout argument.", "signature"),
    ("Five modules call the altered helpers.", "count"),
    ("This is a backwards-incompatible change for session handling.", "breaking"),
])
def test_fact_check_rejects_paraphrased_claims(text, rule):
    problem = pr_impact.contradicts_facts(text, FLASK_6168)
    assert problem is not None and problem[0] == rule


@pytest.mark.parametrize("text", [
    "This PR removes Python 3.10 support and updates two runtime functions: _CollectErrors.raise_any now raises a single "
    "exception, and SessionInterface.get_expiration_time returns the expiry directly. Five callers depend on them across "
    "two modules, 4 of them direct. Reviewers should check error collection and session expiry. No signatures changed.",
    "Updates _CollectErrors.raise_any and SessionInterface.get_expiration_time. This is not a breaking change.",
])
def test_fact_check_accepts_a_correct_summary(text):
    assert pr_impact.contradicts_facts(text, FLASK_6168) is None


def test_fact_check_allows_a_real_signature_change_on_the_named_node():
    facts = {**FLASK_6168, "changes": [dict(FLASK_6168["changes"][0], signature_changed=True)] + FLASK_6168["changes"][1:]}
    assert pr_impact.contradicts_facts("_CollectErrors.raise_any now takes an extra argument.", facts) is None
    # ...but not on another node in the same sentence
    assert pr_impact.contradicts_facts("get_expiration_time's signature changed.", facts)[0] == "signature"


@pytest.mark.asyncio
async def test_rejected_summary_falls_back_to_rules_and_logs_only_node_ids(caplog):
    result = run({"app/scaffold.py": PY}, {"app/scaffold.py": PY.replace("return x + 1", "return x + 2")})
    bad = "Changing the signature of helper, this breaks callers."
    with patch("pr_impact.ai_summary", return_value=bad), caplog.at_level("INFO", logger="codegraph.pr"):
        out = await pr_impact.summarise(result)
    assert out["summary"]["source"] == "rules"
    log = "\n".join(r.getMessage() for r in caplog.records)
    assert "signature check" in log and "app/scaffold.py::helper" in log and bad not in log



# ---------------------------------------------------------------------------
# Production sentences: #6176 and #6168 must fail, #6133 (an added method) must pass
# ---------------------------------------------------------------------------
FLASK_6176 = {
    "changes": [
        {"id": "src/flask/app.py::Flask.__init_subclass__", "qualified_name": "Flask.__init_subclass__", "label": "__init_subclass__",
         "kind": "modified", "signature_changed": False, "file": "src/flask/app.py", "type": "function"},
    ] + [
        {"id": f"src/flask/app.py::Flask.m{i}", "qualified_name": f"Flask.m{i}", "label": f"m{i}", "kind": "docs",
         "signature_changed": False, "file": "src/flask/app.py", "type": "function"} for i in range(13)
    ],
    "impacted": [], "modules": [{"label": "app + 3 files", "changed": 1, "impacted": 0}], "signals": [],
    "files": [{"mapped": True, "test": False}],
}
FLASK_6133 = {
    "changes": [{"id": "src/flask/sansio/scaffold.py::Scaffold.query", "qualified_name": "Scaffold.query", "label": "query",
                 "kind": "added", "signature_changed": False, "file": "src/flask/sansio/scaffold.py", "type": "function"}],
    "impacted": [], "modules": [{"label": "sansio", "changed": 1, "impacted": 0}], "signals": [],
    "files": [{"mapped": True, "test": False}, {"mapped": False, "test": True}],
}


def test_production_6176_signature_claim_fails():
    text = ("This pull request updates the Flask application class to reflect a change in the `__init_subclass__` signature, "
            "adding a `versionchanged` note to the documentation.")
    assert pr_impact.contradicts_facts(text, FLASK_6176) == ("signature", ["src/flask/app.py::Flask.__init_subclass__"])


def test_production_6168_sentences_fail():
    assert pr_impact.contradicts_facts(
        "_CollectErrors.raise_any now raises a single exception instead of a list, changing its signature.", FLASK_6168)[0] == "signature"
    assert pr_impact.contradicts_facts("Five modules call the altered helpers.", FLASK_6168)[0] == "count"


def test_production_6133_new_method_signature_passes():
    text = ("The PR adds a new `query` route decorator to the `Scaffold` class. Also confirm that the new method’s signature "
            "and behavior match the intended design and that any documentation or examples are updated accordingly.")
    assert pr_impact.contradicts_facts(text, FLASK_6133) is None
    assert pr_impact.contradicts_facts("Verify the new method's signature matches the design.", FLASK_6133) is None
    assert pr_impact.contradicts_facts("Scaffold.query's signature is new.", FLASK_6133) is None


def test_stored_ai_summary_is_checked_when_served():
    result = run({"app/scaffold.py": PY}, {"app/scaffold.py": PY.replace("return x + 1", "return x + 2")})
    result["summary"] = {"text": "helper now raises instead, changing its signature.", "source": "ai"}
    served = pr_impact.checked_summary(result)
    assert served["summary"]["source"] == "rules" and "helper" in served["summary"]["text"]
    assert result["summary"]["source"] == "ai"  # the stored result itself is untouched
    good = dict(result, summary={"text": "helper now adds two instead of one.", "source": "ai"})
    assert pr_impact.checked_summary(good) is good
    old_shape = {"summary": {"text": "changing its signature", "source": "ai"}}  # missing fields: served as is
    assert pr_impact.checked_summary(old_shape) is old_shape
