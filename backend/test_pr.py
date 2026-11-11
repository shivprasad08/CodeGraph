# What it does: PR impact analysis — diff parsing, line→node mapping, blast radius, breaking
# signals, the risk formula, the job flow, access control and the L1 cache refill.
# The database tests need TEST_DATABASE_URL (skipped without it); the rest are pure.

import os
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

import auth
import auth_store
import config  # noqa: F401  (loads backend/.env)
import db
import github_pr
import main
import pr_impact
import store as store_mod
from graph_builder import GRAPH_SCHEMA_VERSION
from pr_diff import parse_patch
from pr_impact import GraphIndex, blast_radius, breaking_signals, map_changes, risk_score

TEST_URL = os.environ.get("TEST_DATABASE_URL")
needs_db = pytest.mark.skipif(not TEST_URL, reason="TEST_DATABASE_URL is not set")


# ---------------------------------------------------------------------------
# Graph fixtures
# ---------------------------------------------------------------------------
def make_graph(symbols, calls=(), imports=(), modules=None, repo="acme/app", sha="aaaaaaaa"):
    """symbols: (file, qualified name, start, end, params | None for a class)."""
    nodes, edges, files = [], [], []
    for f, q, start, end, params in symbols:
        if f not in files:
            files.append(f)
        node = {"id": f"{f}::{q}", "label": q.split(".")[-1], "type": "class" if params is None else "function",
                "file": f, "qualified_name": q, "lines": [start, end], "lang": "python", "kind": "class" if params is None else "function"}
        if params is not None:
            node["params"] = params
        nodes.append(node)
        edges.append({"source": f, "target": node["id"], "type": "defines", "confidence": "exact"})
    nodes = [{"id": f, "label": f, "type": "file", "file": f, "lines": []} for f in files] + nodes
    for c in calls:
        src, dst = c[0], c[1]
        edges.append({"source": src, "target": dst, "type": "calls", "confidence": c[2] if len(c) > 2 else "exact"})
    for src, dst in imports:
        edges.append({"source": src, "target": dst, "type": "imports", "confidence": "exact"})
    mods = modules or {"core": files}
    arch = {"modules": [{"id": f"mod:{k}", "label": k, "files": v} for k, v in mods.items()], "edges": [], "method": "directories"}
    return {"repo": repo, "commit_sha": sha, "nodes": nodes, "edges": edges, "architecture": arch}


def patch_text(*hunks):
    return "\n".join(hunks)


# ---------------------------------------------------------------------------
# PR URLs
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("url", [
    "https://github.com/pallets/flask/pull/5432",
    "https://github.com/pallets/flask/pull/5432/",
    "https://github.com/pallets/flask/pull/5432/files",
    "https://github.com/pallets/flask/pull/5432/commits",
    "github.com/pallets/flask/pull/5432?diff=split",
    "https://www.github.com/pallets/flask/pull/5432#discussion_r1",
])
def test_pr_urls_are_recognised(url):
    assert github_pr.parse_pr_url(url) == ("pallets", "flask", 5432)


@pytest.mark.parametrize("url", ["https://github.com/pallets/flask", "https://github.com/pallets/flask/issues/5", "https://gitlab.com/a/b/pull/1", "pallets/flask"])
def test_other_urls_are_not_prs(url):
    assert github_pr.parse_pr_url(url) is None


# ---------------------------------------------------------------------------
# Hunk parsing
# ---------------------------------------------------------------------------
def test_parse_patch_multiple_hunks():
    p = patch_text(
        "@@ -1,4 +1,5 @@",
        " a", "-b", "+B", "+B2", " c", " d",
        "@@ -20 +21,2 @@ def tail():",
        "-old", "+new", "+extra",
        "\\ No newline at end of file",
    )
    d = parse_patch(p)
    assert d["removed"] == {2, 20}
    assert d["added"] == {2, 3, 21, 22}
    assert d["hunks"] == [(1, 4, 1, 5), (20, 1, 21, 2)]


def test_parse_patch_missing_or_empty():
    assert parse_patch(None) == {"removed": set(), "added": set(), "hunks": []}
    assert parse_patch("")["hunks"] == []


# ---------------------------------------------------------------------------
# Mapping
# ---------------------------------------------------------------------------
BASE = make_graph([
    ("app/a.py", "Store", 1, 30, None),
    ("app/a.py", "Store.get", 3, 10, 1),
    ("app/a.py", "Store.drop", 12, 20, 0),
    ("app/a.py", "helper", 32, 40, 2),
    ("app/old.py", "moved", 1, 9, 0),
])
HEAD = make_graph([
    ("app/a.py", "Store", 1, 28, None),
    ("app/a.py", "Store.get", 3, 12, 2),
    ("app/a.py", "Store.fresh", 14, 26, 0),
    ("app/a.py", "helper", 30, 38, 2),
    ("app/new.py", "moved", 1, 10, 0),
], sha="bbbbbbbb")


def test_mapping_added_modified_removed_and_nested_methods():
    files = [{
        "filename": "app/a.py", "status": "modified", "additions": 4, "deletions": 3,
        # base 5 changed in get; base 13-14 removed from drop; head 4-5 in get; head 15 in fresh
        "patch": patch_text("@@ -4,3 +4,4 @@", " x", "-y", "+Y", "+Y2", " z",
                            "@@ -12,4 +14,3 @@", " def", "-gone1", "-gone2", "+fresh_line", " end"),
    }]
    changes, report, partial = map_changes(files, GraphIndex(BASE), GraphIndex(HEAD))
    kinds = {e["qualified_name"]: e["kind"] for e in changes.values()}
    assert kinds == {"Store.get": "modified", "Store.drop": "removed", "Store.fresh": "added"}
    assert "Store" not in kinds  # method changes are not class changes
    get = next(e for e in changes.values() if e["qualified_name"] == "Store.get")
    assert (get["lines_added"], get["lines_removed"]) == (2, 1)
    assert get["signature_changed"] and (get["params_before"], get["params_after"]) == (1, 2)
    assert report[0]["mapped"] and report[0]["nodes"] == 3 and not partial


def test_mapping_class_body_change_marks_the_class():
    files = [{"filename": "app/a.py", "status": "modified", "patch": patch_text("@@ -11 +13 @@", "-x", "+y")}]
    changes, _, _ = map_changes(files, GraphIndex(BASE), GraphIndex(HEAD))
    assert {e["qualified_name"] for e in changes.values()} == {"Store"}


def test_mapping_renamed_files_match_by_previous_filename():
    files = [{"filename": "app/new.py", "previous_filename": "app/old.py", "status": "renamed", "additions": 1, "deletions": 0,
              "patch": patch_text("@@ -3,2 +3,3 @@", " a", "+b", " c")}]
    changes, report, _ = map_changes(files, GraphIndex(BASE), GraphIndex(HEAD))
    (e,) = changes.values()
    assert e["kind"] == "modified" and e["base_id"] == "app/old.py::moved" and e["head_id"] == "app/new.py::moved"


def test_mapping_missing_patch_and_non_source_files():
    files = [
        {"filename": "app/a.py", "status": "modified", "additions": 900, "deletions": 10, "patch": None},
        {"filename": "README.md", "status": "modified", "patch": "@@ -1 +1 @@\n-a\n+b"},
        {"filename": "tests/test_a.py", "status": "modified", "patch": "@@ -1 +1 @@\n-a\n+b"},
    ]
    changes, report, partial = map_changes(files, GraphIndex(BASE), GraphIndex(HEAD))
    assert partial and not changes
    assert "diff" in report[0]["note"] and not report[0]["mapped"]
    assert report[1]["note"].startswith("Not source code") and report[2]["test"]


def test_mapping_caps_the_number_of_files():
    files = [{"filename": f"docs/{i}.md", "status": "added", "patch": "@@ -0,0 +1 @@\n+x"} for i in range(301)]
    _, report, partial = map_changes(files, GraphIndex(BASE), GraphIndex(HEAD), truncated=True)
    assert partial and "first 300" in report[300]["note"]


def test_added_and_removed_files_without_patch():
    base = make_graph([("x.py", "f", 1, 5, 0)])
    head = make_graph([("y.py", "g", 1, 5, 0)])
    files = [{"filename": "x.py", "status": "removed", "patch": None}, {"filename": "y.py", "status": "added", "patch": None}]
    changes, _, _ = map_changes(files, GraphIndex(base), GraphIndex(head))
    assert {e["qualified_name"]: e["kind"] for e in changes.values()} == {"f": "removed", "g": "added"}


# ---------------------------------------------------------------------------
# Blast radius
# ---------------------------------------------------------------------------
def chain_graph(n):
    syms = [("c.py", f"f{i}", i * 10, i * 10 + 5, 0) for i in range(n)]
    calls = [(f"c.py::f{i + 1}", f"c.py::f{i}") for i in range(n - 1)]  # f1 calls f0, f2 calls f1…
    return make_graph(syms, calls)


def test_blast_radius_depth_labels_and_depth_cap():
    g = GraphIndex(chain_graph(8))
    hit, capped = blast_radius(g, {"c.py::f0"}, set())
    assert {k: v["depth"] for k, v in hit.items()} == {"c.py::f1": 1, "c.py::f2": 2, "c.py::f3": 3, "c.py::f4": 4}
    assert not capped


def test_blast_radius_node_cap_and_inferred_edges():
    syms = [("s.py", "target", 1, 2, 0)] + [("s.py", f"c{i}", 10 + i * 3, 11 + i * 3, 0) for i in range(600)]
    calls = [(f"s.py::c{i}", "s.py::target", "inferred" if i % 2 else "exact") for i in range(600)]
    hit, capped = blast_radius(GraphIndex(make_graph(syms, calls)), {"s.py::target"}, set())
    assert len(hit) == 500 and capped
    assert hit["s.py::c0"]["exact"] and not hit["s.py::c1"]["exact"]


def test_inferred_link_makes_everything_behind_it_inferred():
    g = make_graph([("c.py", f"f{i}", i * 10, i * 10 + 5, 0) for i in range(3)],
                   [("c.py::f1", "c.py::f0", "inferred"), ("c.py::f2", "c.py::f1")])
    hit, _ = blast_radius(GraphIndex(g), {"c.py::f0"}, set())
    assert not hit["c.py::f1"]["exact"] and not hit["c.py::f2"]["exact"]


# ---------------------------------------------------------------------------
# Breaking signals
# ---------------------------------------------------------------------------
def test_removed_but_called_and_signature_change():
    base = make_graph(
        [("m.py", "old", 1, 5, 1), ("m.py", "api", 10, 15, 1), ("m.py", "user", 20, 25, 0), ("m.py", "updated", 30, 35, 0)],
        [("m.py::user", "m.py::old"), ("m.py::user", "m.py::api"), ("m.py::updated", "m.py::api")],
    )
    head = make_graph([("m.py", "api", 10, 15, 2), ("m.py", "user", 20, 25, 0), ("m.py", "updated", 30, 35, 0)])
    files = [{"filename": "m.py", "status": "modified",
              "patch": patch_text("@@ -1,5 +0,0 @@", "-a", "-b", "-c", "-d", "-e", "@@ -11 +11 @@", "-x", "+y", "@@ -31 +31 @@", "-p", "+q")}]
    b, h = GraphIndex(base), GraphIndex(head)
    changes, _, _ = map_changes(files, b, h)
    signals = breaking_signals(changes, b, h)
    by_kind = {s["kind"]: s for s in signals}
    assert by_kind["removed_but_called"]["callers"] == ["m.py::user"]
    # "updated" was changed in the PR, so only "user" counts as a caller left behind
    assert by_kind["signature_change"]["callers"] == ["m.py::user"] and "now takes 2 parameters (was 1)" in by_kind["signature_change"]["message"]


def test_new_import_cycle_and_new_module_dependency():
    syms = [("a/x.py", "f", 1, 2, 0), ("b/y.py", "g", 1, 2, 0)]
    mods = {"a": ["a/x.py"], "b": ["b/y.py"]}
    base = make_graph(syms, imports=[("a/x.py", "b/y.py")], modules=mods)
    head = make_graph(syms, imports=[("a/x.py", "b/y.py"), ("b/y.py", "a/x.py")], modules=mods)
    head["architecture"]["edges"] = [{"source": "mod:b", "target": "mod:a", "calls": 0, "imports": 1, "weight": 2}]
    signals = breaking_signals({}, GraphIndex(base), GraphIndex(head))
    kinds = [(s["kind"], s.get("level")) for s in signals]
    assert ("new_cycle", "file") in kinds and ("new_cycle", "module") in kinds
    assert any(s["kind"] == "new_module_dependency" and (s["source"], s["target"]) == ("b", "a") for s in signals)
    assert breaking_signals({}, GraphIndex(base), GraphIndex(base)) == []


# ---------------------------------------------------------------------------
# Risk formula
# ---------------------------------------------------------------------------
def _risk(**kw):
    defaults = dict(changes={}, impacted={}, graph_size=100, hubs_touched=[], signals=[], modules=[], source_changed=False, tests_changed=0)
    return risk_score(**{**defaults, **kw})


def _changes(n, kind="modified"):
    return {f"n{i}": {"kind": kind} for i in range(n)}


def test_risk_formula_points():
    r = _risk(
        changes=_changes(4),
        impacted={**{f"i{k}": {"depth": 1, "exact": True} for k in range(8)}, **{f"j{k}": {"depth": 2, "exact": False} for k in range(4)}},
        graph_size=100, hubs_touched=["main"], signals=[{"kind": "signature_change", "message": "x"}],
        modules=["core", "api", "cli"], source_changed=True, tests_changed=0,
    )
    points = {f["key"]: f["points"] for f in r["factors"]}
    # changed 4; blast (8 + 4×0.5)/100 = 10%; one hub 5; signature 12; 3 modules 6; no tests 10
    assert points == {"changed": 4, "blast": 10, "hubs": 5, "breaking": 12, "spread": 6, "tests": 10}
    assert r["score"] == 47 and r["level"] == "medium"
    assert all(f["reason"] for f in r["factors"])


def test_risk_levels_and_caps():
    assert _risk()["score"] == 0 and _risk()["level"] == "low"
    low = _risk(changes=_changes(29))
    assert low["score"] == 15 and low["level"] == "low"
    many = [{"kind": "removed_but_called", "message": "m"}] * 5
    high = _risk(changes=_changes(40), impacted={f"i{k}": {"depth": 1, "exact": True} for k in range(90)}, graph_size=100,
                 hubs_touched=list("abcd"), signals=many, modules=list("abcdef"), source_changed=True)
    pts = {f["key"]: f["points"] for f in high["factors"]}
    assert pts == {"changed": 15, "blast": 25, "hubs": 15, "breaking": 40, "spread": 10, "tests": 10}
    assert high["score"] == 100 and high["level"] == "high"
    assert _risk(changes=_changes(15), impacted={f"i{k}": {"depth": 1, "exact": True} for k in range(15)})["score"] == 30
    assert _risk(changes=_changes(15), impacted={f"i{k}": {"depth": 1, "exact": True} for k in range(15)})["level"] == "medium"
    tested = _risk(changes=_changes(1), source_changed=True, tests_changed=2)
    assert next(f for f in tested["factors"] if f["key"] == "tests")["points"] == 0


# ---------------------------------------------------------------------------
# Whole result and summary fallback
# ---------------------------------------------------------------------------
META = {"owner": "acme", "repo": "app", "full_name": "acme/app", "number": 7, "title": "Tidy store", "author": "dev",
        "state": "open", "html_url": "https://github.com/acme/app/pull/7", "base_sha": "a" * 40, "head_sha": "b" * 40,
        "head_repo": "acme/app", "is_fork": False}
PR_FILES = [{"filename": "app/a.py", "status": "modified", "additions": 1, "deletions": 1,
             "patch": patch_text("@@ -5 +5 @@", "-y", "+Y")}]


def test_analyse_builds_a_complete_result():
    base = dict(BASE, edges=BASE["edges"] + [{"source": "app/a.py::helper", "target": "app/a.py::Store.get", "type": "calls", "confidence": "exact"}])
    result = pr_impact.analyse(META, PR_FILES, base, HEAD)
    assert [c["qualified_name"] for c in result["changes"]] == ["Store.get"]
    assert [i["id"] for i in result["impacted"]] == ["app/a.py::helper"] and result["impacted"][0]["depth"] == 1
    assert result["modules"] == [{"label": "core", "changed": 1, "impacted": 1, "docs": 0}]
    sub_ids = {n["id"] for n in result["subgraph"]["nodes"]}
    assert {"app/a.py::Store.get", "app/a.py::helper", "app/a.py"} <= sub_ids
    assert result["stats"]["changed"] == 1 and result["risk"]["level"] in ("low", "medium", "high")


@pytest.mark.asyncio
async def test_summary_falls_back_to_rules_when_the_model_is_unavailable():
    result = pr_impact.analyse(META, PR_FILES, BASE, HEAD)
    with patch("pr_impact.ai_summary", return_value=None):
        out = await pr_impact.summarise(result)
    assert out["summary"]["source"] == "rules" and "Store.get" in out["summary"]["text"]
    empty = pr_impact.analyse(META, [{"filename": "README.md", "status": "modified", "patch": "@@ -1 +1 @@\n-a\n+b"}], BASE, HEAD)
    out = await pr_impact.summarise(empty)
    assert out["summary"]["text"].startswith("This PR doesn't change any analysed")


@pytest.mark.asyncio
async def test_ai_summary_is_clipped_and_uses_only_facts():
    long_text = "word " * 300

    async def fake_groq(prompt, system):
        assert "Tidy store" in prompt and "ONLY the facts" in system
        return long_text

    with patch("enrichment._call_groq", fake_groq):
        text = await pr_impact.ai_summary("PR #7: Tidy store")
    assert len(text.split()) == 120


# ---------------------------------------------------------------------------
# Database: job flow, access, history, L1 cache
# ---------------------------------------------------------------------------
@pytest_asyncio.fixture
async def pg(tmp_path, monkeypatch):
    await db.run_migrations(TEST_URL)
    s = await store_mod.PgStore.open(TEST_URL)
    async with s.pool.connection() as conn:
        await conn.execute("truncate jobs, analyses, pr_analyses, users, sessions, user_analyses, share_links, rate_events cascade")
    monkeypatch.setattr(main, "store", s)
    monkeypatch.setattr(auth.runtime, "auth", auth_store.AuthStore(s.pool))
    monkeypatch.setattr(auth.runtime, "load_graph", main._graph_by_analysis)
    monkeypatch.setattr(auth.runtime, "load_pr", s.pr_result)
    monkeypatch.setattr(main.cache.config, "CACHE_DIR", str(tmp_path))
    main.analyze_counts.clear()
    try:
        yield s
    finally:
        await s.close()


def browser(ip="10.1.1.1"):
    return AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test", headers={"X-CodeGraph": "1", "X-Forwarded-For": ip})


async def _seed_pr(pg):
    """Base and head analyses already stored (so the PR job must not fetch anything)."""
    base = dict(BASE, repo="acme/app", commit_sha="aaaaaaaa")
    base["edges"] = BASE["edges"] + [{"source": "app/a.py::helper", "target": "app/a.py::Store.get", "type": "calls", "confidence": "exact"}]
    await pg.save_analysis("acme/app", "aaaaaaaa", base)
    await pg.save_analysis("acme/app", "bbbbbbbb", dict(HEAD, repo="acme/app", commit_sha="bbbbbbbb"))


async def _run_pr_job(pg, client) -> dict:
    r = await client.post("/analyze", json={"repo_url": "https://github.com/acme/app/pull/7/files"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "pr" and body["pr"] == {"owner": "acme", "repo": "app", "number": 7}

    async def fake_fetch_pr(owner, repo, number):
        return {"meta": META, "files": PR_FILES, "truncated": False}

    async def no_fetch(*a, **k):
        raise AssertionError("base and head were cached; nothing should be fetched")

    with patch("github_pr.fetch_pr", fake_fetch_pr), patch("ingestion.fetch_repo_at", no_fetch), \
         patch("pr_impact.ai_summary", return_value="AI summary text."):
        claimed = await pg.claim_job("w1")
        assert claimed["id"] == body["job_id"]
        await main._run_pipeline(body["job_id"], claimed["repo_url"])
    return body


@needs_db
@pytest.mark.asyncio
async def test_pr_job_flow_with_cached_base_and_head(pg):
    await _seed_pr(pg)
    async with browser() as client:
        body = await _run_pr_job(pg, client)
        job = (await client.get(f"/pr/{body['job_id']}")).json()
        assert job["pr"]["number"] == 7 and job["summary"] == {"text": "AI summary text.", "source": "ai"}
        assert [c["qualified_name"] for c in job["changes"]] == ["Store.get"]
        assert job["timing"]["base_reused"] and job["timing"]["head_reused"]
        assert job["risk"]["score"] == sum(f["points"] for f in job["risk"]["factors"])
        async with client.stream("GET", f"/jobs/{body['job_id']}") as resp:
            events = [line async for line in resp.aiter_lines() if line.startswith("data:")]
        assert '"status": "done"' in events[-1]
        head = await client.get(f"/pr/{body['job_id']}/graph/head")
        assert head.status_code == 200 and head.json()["commit_sha"] == "bbbbbbbb"
        listed = (await client.get("/me/analyses")).json()["analyses"]
        assert listed[0]["kind"] == "pr" and listed[0]["pr_number"] == 7 and listed[0]["risk_level"] == job["risk"]["level"]
        assert listed[0]["pr_title"] == "Tidy store"

        # Same PR, same commits: the next request reuses the result at once
        async def meta_now(*_a):
            return META

        with patch.object(main, "_latest_pr", meta_now):
            again = (await client.post("/analyze", json={"repo_url": "https://github.com/acme/app/pull/7"})).json()
        assert again["status"] == "done"
        assert (await client.get(f"/pr/{again['job_id']}")).json()["changes"] == job["changes"]
    rows = await _sql(pg, "select count(*) as n from pr_analyses where status = 'done'")
    assert rows[0]["n"] == 1


async def _sql(pg, q, params=None):
    async with pg.pool.connection() as conn:
        cur = await conn.execute(q, params)
        return await cur.fetchall() if cur.description else None


@needs_db
@pytest.mark.asyncio
async def test_pr_access_control_and_share_links(pg, monkeypatch):
    await _seed_pr(pg)
    user = await auth.runtime.auth.upsert_user(5001, "owner", None, None)
    token, _ = await auth.runtime.auth.create_session(user["id"])
    async with browser("10.1.1.1") as owner, browser("10.2.2.2") as stranger:
        owner.cookies.set(auth.SESSION_COOKIE, token)
        body = await _run_pr_job(pg, owner)
        job_id = body["job_id"]
        assert (await owner.get(f"/pr/{job_id}")).status_code == 200
        for path in (f"/pr/{job_id}", f"/jobs/{job_id}", f"/pr/{job_id}/graph/head", f"/pr/{job_id}/graph/base"):
            r = await stranger.get(path)
            assert r.status_code == 403 and r.json()["error_code"] == "private_analysis", path

        share = (await owner.post("/shares", json={"user_analysis_id": body["user_analysis_id"], "expires_in_days": 7})).json()
        tok = share["url"].removeprefix("/s/")
        opened = (await stranger.get(f"/shares/{tok}")).json()
        assert opened["kind"] == "pr" and opened["share"]["pr_number"] == 7 and opened["result"]["pr"]["title"] == "Tidy store"
        assert opened["job_id"] == job_id
        assert (await stranger.get(f"/pr/{job_id}/graph/head", headers={"X-Share-Token": tok})).status_code == 200
        assert (await stranger.get(f"/pr/{job_id}", headers={"X-Share-Token": tok})).status_code == 200
        await owner.delete(f"/shares/{share['id']}")
        assert (await stranger.get(f"/shares/{tok}")).status_code == 404
        assert (await stranger.get(f"/pr/{job_id}", headers={"X-Share-Token": tok})).status_code == 403


@needs_db
@pytest.mark.asyncio
async def test_a_pr_counts_toward_the_hourly_limit(pg, monkeypatch):
    monkeypatch.setattr(config, "ANALYZE_LIMIT_PER_HOUR", 1)
    async with browser("10.3.3.3") as client:
        assert (await client.post("/analyze", json={"repo_url": "https://github.com/acme/app"})).status_code == 200
        r = await client.post("/analyze", json={"repo_url": "https://github.com/acme/app/pull/7"})
        assert r.status_code == 429 and r.json()["error_code"] == "rate_limited"


@needs_db
@pytest.mark.asyncio
async def test_pr_too_large_fails_with_counts(pg):
    async with browser() as client:
        r = await client.post("/analyze", json={"repo_url": "https://github.com/acme/app/pull/7"})
        job_id = r.json()["job_id"]

        async def fake_fetch_pr(*_a):
            return {"meta": META, "files": PR_FILES, "truncated": False}

        async def too_big(*_a, **_k):
            raise main.FileLimitError("Repo has 99 source files (Python 99), limit is 60. Try a smaller repo.")

        with patch("github_pr.fetch_pr", fake_fetch_pr), patch("ingestion.fetch_repo_at", too_big):
            claimed = await pg.claim_job("w1")
            await main._run_pipeline(job_id, claimed["repo_url"])
        job = await pg.get_job(job_id)
        assert job["status"] == "error" and job["error_code"] == "pr_too_large" and "99 source files" in job["error"]


@needs_db
@pytest.mark.asyncio
async def test_l1_cache_is_refilled_after_database_reads(pg, tmp_path):
    graph = dict(HEAD, repo="acme/app", commit_sha="cccccccc")
    async with browser() as client:
        r = await client.post("/analyze", json={"repo_url": "https://github.com/acme/app"})
        job_id = r.json()["job_id"]
        await pg.complete_job(job_id, "acme/app", "cccccccc", graph)
        assert not list(tmp_path.glob("*.json"))  # nothing cached yet (complete_job is the store only)
        before = main.L1_STATS["writes"]
        assert (await client.get(f"/graph/{job_id}")).status_code == 200
        assert main.cache.read_cache("acme/app", "cccccccc") == graph
        health = (await client.get("/health")).json()["cache"]
        assert health["total_entries"] == 1 and health["l1_writes"] == before + 1
        # A second read is served from L1 (no new write)
        assert (await client.get(f"/graph/{job_id}")).status_code == 200
        assert main.L1_STATS["writes"] == before + 1
        # Chat/source path (commit lookup) also refills after the file is gone
        for f in tmp_path.glob("*.json"):
            f.unlink()
        assert (await client.get("/chat/acme/app/cccccccc/suggestions")).status_code == 200
        assert main.cache.read_cache("acme/app", "cccccccc") == graph
