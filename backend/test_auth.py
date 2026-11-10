# What it does: sign-in, sessions, access control, share links, CSRF and rate limits (Postgres)
#
# Needs TEST_DATABASE_URL (tables are truncated between tests); skipped without it.
# Each AsyncClient is one browser (its own cookie jar). GitHub is replaced by a fake client.

import os
from datetime import timedelta
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

import auth
import auth_store
import config  # noqa: F401  (loads backend/.env)
import db
import main
import store as store_mod
from graph_builder import GRAPH_SCHEMA_VERSION

TEST_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="TEST_DATABASE_URL is not set")

APP = "https://app.codegraph.test"
GITHUB_TOKEN = "gho_" + "T0kenThatMustNeverBeStored" * 2
GRAPH = {
    "repo": "acme/widgets", "commit_sha": "abc12345", "schema_version": GRAPH_SCHEMA_VERSION,
    "nodes": [{"id": "src/app.py", "type": "file", "lang": "python"},
              {"id": "src/app.py::main", "type": "function", "file": "src/app.py"}],
    "edges": [], "stats": {"files": 1}, "languages": {"python": 1},
    "analysis": {"score": 81, "grade": "B", "issues": [], "patterns": [], "by_file": {}},
}
PROFILES = {
    "alice-code": {"id": 1001, "login": "alice", "name": "Alice", "avatar_url": "https://avatars.test/a"},
    "bob-code": {"id": 1002, "login": "bob", "name": None, "avatar_url": "https://avatars.test/b"},
}


class FakeGitHub:
    """Stands in for httpx.AsyncClient inside auth.py: token exchange + /user."""
    calls = []

    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, data=None):
        FakeGitHub.calls.append(("post", url, dict(data or {})))
        if data.get("code") not in PROFILES:
            return httpx.Response(200, json={"error": "bad_verification_code"})
        return httpx.Response(200, json={"access_token": GITHUB_TOKEN, "token_type": "bearer", "scope": "read:user"})

    async def get(self, url, headers=None):
        FakeGitHub.calls.append(("get", url, dict(headers or {})))
        code = next(c for c in PROFILES)  # the last exchanged code decides the profile
        for kind, _url, payload in reversed(FakeGitHub.calls):
            if kind == "post":
                code = payload["code"]
                break
        return httpx.Response(200, json=PROFILES[code])


@pytest_asyncio.fixture
async def pg(tmp_path, monkeypatch):
    await db.run_migrations(TEST_URL)
    s = await store_mod.PgStore.open(TEST_URL)
    async with s.pool.connection() as conn:
        await conn.execute("truncate jobs, analyses, users, sessions, user_analyses, share_links, rate_events cascade")
    monkeypatch.setattr(main, "store", s)
    monkeypatch.setattr(auth.runtime, "auth", auth_store.AuthStore(s.pool))
    monkeypatch.setattr(auth.runtime, "load_graph", main._graph_by_analysis)
    monkeypatch.setattr(main.cache.config, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(config, "PUBLIC_APP_URL", APP)
    monkeypatch.setattr(config, "GITHUB_OAUTH_CLIENT_ID", "client-id-123")
    monkeypatch.setattr(config, "GITHUB_OAUTH_CLIENT_SECRET", "client-secret-456")
    monkeypatch.setattr(config, "SESSION_SECRET", "s" * 40)
    monkeypatch.setattr(auth.httpx, "AsyncClient", FakeGitHub)
    main.analyze_counts.clear()
    FakeGitHub.calls = []
    try:
        yield s
    finally:
        await s.close()


def browser(ip="10.0.0.1", csrf=True) -> AsyncClient:
    headers = {"X-Forwarded-For": ip}
    if csrf:
        headers["X-CodeGraph"] = "1"
    return AsyncClient(transport=ASGITransport(app=main.app), base_url=APP, headers=headers)


async def sql(pg, query, params=None):
    async with pg.pool.connection() as conn:
        cur = await conn.execute(query, params)
        return await cur.fetchall() if cur.description else None


async def sign_in(client: AsyncClient, code="alice-code", next_path="/analyses") -> httpx.Response:
    login = await client.get("/auth/github/login", params={"next": next_path})
    state = parse_qs(urlsplit(login.headers["location"]).query)["state"][0]
    return await client.get("/auth/github/callback", params={"code": code, "state": state})


async def analyze_and_finish(pg, client, repo="acme/widgets", sha="abc12345") -> dict:
    r = await client.post("/analyze", json={"repo_url": f"https://github.com/{repo}"})
    assert r.status_code == 200, r.text
    body = r.json()
    await pg.complete_job(body["job_id"], repo, sha, {**GRAPH, "repo": repo, "commit_sha": sha})
    return body


def set_cookie_header(response, name) -> str:
    return next(h for h in response.headers.get_list("set-cookie") if h.startswith(f"{name}="))


# ---------------------------------------------------------------------------
# Sign-in
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_login_redirects_to_github_with_read_user_state_and_pkce(pg):
    async with browser() as client:
        r = await client.get("/auth/github/login", params={"next": "/analyses"})
    assert r.status_code == 302
    url = urlsplit(r.headers["location"])
    q = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert f"{url.scheme}://{url.netloc}{url.path}" == "https://github.com/login/oauth/authorize"
    assert q["scope"] == "read:user" and q["client_id"] == "client-id-123"
    assert q["redirect_uri"] == f"{APP}/api/auth/github/callback"
    assert q["code_challenge_method"] == "S256" and len(q["code_challenge"]) == 43 and len(q["state"]) >= 32
    cookie = set_cookie_header(r, auth.STATE_COOKIE).lower()
    assert "httponly" in cookie and "secure" in cookie and "samesite=lax" in cookie and "max-age=600" in cookie


@pytest.mark.asyncio
async def test_callback_signs_in_sets_a_strict_cookie_and_never_stores_the_github_token(pg):
    async with browser() as client:
        r = await sign_in(client)
        assert r.status_code == 302 and r.headers["location"] == "/analyses"
        cookie = set_cookie_header(r, auth.SESSION_COOKIE)
        flags = [p.strip().lower() for p in cookie.split(";")]
        assert {"httponly", "secure", "samesite=lax", "path=/", f"max-age={30 * 86400}"} <= set(flags)
        me = await client.get("/auth/me")
        assert me.status_code == 200 and me.json()["user"]["login"] == "alice"
    # The PKCE verifier went to GitHub with the code; the token went nowhere
    exchange = next(c for c in FakeGitHub.calls if c[0] == "post")[2]
    assert exchange["code_verifier"] and exchange["redirect_uri"] == f"{APP}/api/auth/github/callback"
    dump = await sql(pg, "select (select json_agg(u)::text from users u) || (select json_agg(s)::text from sessions s) as t")
    assert GITHUB_TOKEN not in dump[0]["t"] and "T0kenThatMustNeverBeStored" not in dump[0]["t"]
    token = cookie.split(";")[0].split("=", 1)[1]
    hashes = await sql(pg, "select token_hash from sessions")
    assert [bytes(h["token_hash"]) for h in hashes] == [auth_store.token_hash(token)]  # only the hash


@pytest.mark.asyncio
async def test_state_mismatch_is_rejected(pg):
    async with browser() as client:
        await client.get("/auth/github/login")
        r = await client.get("/auth/github/callback", params={"code": "alice-code", "state": "forged-state"})
        assert r.status_code == 302 and r.headers["location"] == "/?signin=failed"
        assert not any(h.startswith(f"{auth.SESSION_COOKIE}=") for h in r.headers.get_list("set-cookie"))
        assert (await client.get("/auth/me")).status_code == 401
    # Without the state cookie at all (e.g. a link forged elsewhere)
    async with browser() as other:
        r = await other.get("/auth/github/callback", params={"code": "alice-code", "state": "x"})
        assert r.headers["location"] == "/?signin=failed"
    assert not [c for c in FakeGitHub.calls if c[0] == "post"]  # the code was never exchanged


@pytest.mark.asyncio
@pytest.mark.parametrize("evil", ["https://evil.test/x", "//evil.test", "/\\evil.test", "javascript:alert(1)", "/\r\nx", "evil"])
async def test_open_redirect_next_is_rejected(pg, evil):
    async with browser() as client:
        r = await sign_in(client, next_path=evil)
    assert r.headers["location"] == "/analyses"


def test_safe_next():
    assert auth.safe_next("/graph/a/b/jobs/1?tab=health#x") == "/graph/a/b/jobs/1?tab=health#x"
    for bad in (None, "", "//x", "/\\x", "http://x", "x", "/a\\b", "/" + "a" * 600):
        assert auth.safe_next(bad) == "/analyses", bad


@pytest.mark.asyncio
async def test_anonymous_analyses_move_to_the_user_on_sign_in(pg):
    async with browser() as client:
        r = await client.post("/analyze", json={"repo_url": "https://github.com/acme/widgets"})
        anon_cookie = set_cookie_header(r, auth.SESSION_COOKIE).lower()
        assert f"max-age={7 * 86400}" in anon_cookie and "httponly" in anon_cookie and "samesite=lax" in anon_cookie
        listed = (await client.get("/me/analyses")).json()
        assert listed["signed_in"] is False and len(listed["analyses"]) == 1
        await sign_in(client)
        listed = (await client.get("/me/analyses")).json()
        assert listed["signed_in"] is True and [a["repo"] for a in listed["analyses"]] == ["acme/widgets"]
    rows = await sql(pg, "select anon, count(*) as n from sessions group by anon")
    assert [(r["anon"], r["n"]) for r in rows] == [(False, 1)]  # the anonymous session is gone


@pytest.mark.asyncio
async def test_logout_ends_the_session(pg):
    async with browser() as client:
        await sign_in(client)
        r = await client.post("/auth/logout")
        assert r.status_code == 200 and 'cg_session=""' in set_cookie_header(r, auth.SESSION_COOKIE)
        assert (await client.get("/auth/me")).status_code == 401
    assert (await sql(pg, "select count(*) as n from sessions"))[0]["n"] == 0


# ---------------------------------------------------------------------------
# Access control
# ---------------------------------------------------------------------------
async def _expect_private(client, job_id, repo="acme/widgets", sha="abc12345"):
    for method, path, kw in (
        ("GET", f"/jobs/{job_id}", {}),
        ("GET", f"/graph/{job_id}", {}),
        ("GET", f"/analysis/{job_id}", {}),
        ("GET", f"/chat/{repo}/{sha}/suggestions", {}),
        ("GET", f"/source/{repo}/{sha}/src/app.py", {}),
        ("POST", f"/chat/{repo}/{sha}", {"json": {"message": "hi"}}),
        ("POST", f"/impact/{repo}/{sha}", {"json": {"source_node_id": "src/app.py::main", "change_description": "", "blast_radius": {}}}),
    ):
        r = await client.request(method, path, **kw)
        assert r.status_code == 403 and r.json()["error_code"] == "private_analysis", (method, path, r.status_code)


@pytest.mark.asyncio
async def test_access_matrix(pg):
    async with browser("10.0.0.1") as alice, browser("10.0.0.2") as bob, browser("10.0.0.3") as stranger:
        await sign_in(alice, "alice-code")
        await sign_in(bob, "bob-code")
        job = await analyze_and_finish(pg, alice)

        # Owner
        assert (await alice.get(f"/graph/{job['job_id']}")).status_code == 200
        assert (await alice.get(f"/analysis/{job['job_id']}")).json()["score"] == 81
        assert (await alice.get("/chat/acme/widgets/abc12345/suggestions")).status_code == 200
        async with alice.stream("GET", f"/jobs/{job['job_id']}") as resp:
            assert resp.status_code == 200

        # Another account, and an anonymous browser: private — the same as a repo nobody analysed
        await _expect_private(bob, job["job_id"])
        await stranger.post("/analyze", json={"repo_url": "https://github.com/o/other"})  # has its own session
        await _expect_private(stranger, job["job_id"])
        await _expect_private(bob, "00000000-0000-0000-0000-000000000000", "nobody/analysed", "deadbeef")

        # Share link: the token unlocks this analysis only
        share = (await alice.post("/shares", json={"user_analysis_id": job["user_analysis_id"], "expires_in_days": 7})).json()
        token = share["url"].removeprefix("/s/")
        opened = await stranger.get(f"/shares/{token}")
        assert opened.status_code == 200
        body = opened.json()
        assert body["graph"]["nodes"] == GRAPH["nodes"]
        assert body["share"]["shared_by"]["login"] == "alice" and body["share"]["repo"] == "acme/widgets"
        assert (await stranger.get("/chat/acme/widgets/abc12345/suggestions", headers={"X-Share-Token": token})).status_code == 200
        assert (await stranger.get(f"/graph/{job['job_id']}")).status_code == 403  # no token, no access
        other = await analyze_and_finish(pg, bob, "bob/repo", "11111111")
        r = await stranger.get(f"/graph/{other['job_id']}", headers={"X-Share-Token": token})
        assert r.status_code == 403  # a token is scoped to its own analysis

        # Revoked → gone (same 404 as unknown and expired)
        assert (await alice.delete(f"/shares/{share['id']}")).status_code == 200
        gone = await stranger.get(f"/shares/{token}")
        assert gone.status_code == 404 and gone.json()["error_code"] == "share_unavailable"
        assert (await stranger.get("/chat/acme/widgets/abc12345/suggestions", headers={"X-Share-Token": token})).status_code == 403
        assert (await stranger.get("/shares/not-a-real-token")).json() == gone.json()

        expiring = (await alice.post("/shares", json={"user_analysis_id": job["user_analysis_id"], "expires_in_days": 30})).json()
        await sql(pg, "update share_links set expires_at = now() - interval '1 second' where id = %s", (expiring["id"],))
        expired = await stranger.get(f"/shares/{expiring['url'].removeprefix('/s/')}")
        assert expired.status_code == 404 and expired.json() == gone.json()


@pytest.mark.asyncio
async def test_two_users_analysing_the_same_repo_each_get_a_private_entry(pg):
    async with browser("10.0.0.1") as alice, browser("10.0.0.2") as bob:
        await sign_in(alice, "alice-code")
        await sign_in(bob, "bob-code")
        a = await analyze_and_finish(pg, alice)
        r = await bob.post("/analyze", json={"repo_url": "https://github.com/acme/widgets"})
        await pg.resolve_commit(r.json()["job_id"], "acme/widgets", "abc12345")  # reuses alice's analysis
        assert (await bob.get(f"/graph/{r.json()['job_id']}")).status_code == 200
        assert (await alice.get(f"/graph/{a['job_id']}")).status_code == 200
        assert len((await bob.get("/me/analyses")).json()["analyses"]) == 1
    assert (await sql(pg, "select count(*) as n from analyses where status = 'done'"))[0]["n"] == 1
    assert (await sql(pg, "select count(*) as n from user_analyses"))[0]["n"] == 2


@pytest.mark.asyncio
async def test_share_links_count_views_and_need_an_owner_who_is_signed_in(pg):
    async with browser("10.0.0.1") as alice, browser("10.0.0.2") as bob, browser("10.0.0.3") as anon:
        await sign_in(alice, "alice-code")
        await sign_in(bob, "bob-code")
        job = await analyze_and_finish(pg, alice)
        share = (await alice.post("/shares", json={"user_analysis_id": job["user_analysis_id"], "expires_in_days": None})).json()
        assert share["expires_at"] is None and share["url"].startswith("/s/")
        token = share["url"].removeprefix("/s/")
        assert len(token) == 43  # 32 random bytes, base64url
        for _ in range(3):
            assert (await anon.get(f"/shares/{token}")).status_code == 200
        listed = (await alice.get("/me/shares", params={"user_analysis_id": job["user_analysis_id"]})).json()["shares"]
        assert [(s["view_count"], s["active"]) for s in listed] == [(3, True)]
        assert (await alice.get("/me/analyses")).json()["analyses"][0]["shares"] == 1
        assert (await sql(pg, "select count(*) as n from share_links where token_hash = %s", (auth_store.token_hash(token),)))[0]["n"] == 1

        # Anonymous: "Sign in to share"; someone else's analysis: not found
        anon_job = (await anon.post("/analyze", json={"repo_url": "https://github.com/o/r"})).json()
        r = await anon.post("/shares", json={"user_analysis_id": anon_job["user_analysis_id"], "expires_in_days": 7})
        assert r.status_code == 401 and r.json()["error_code"] == "sign_in_required"
        r = await bob.post("/shares", json={"user_analysis_id": job["user_analysis_id"], "expires_in_days": 7})
        assert r.status_code == 404
        assert (await bob.delete(f"/shares/{share['id']}")).status_code == 404  # only the owner revokes
        r = await alice.post("/shares", json={"user_analysis_id": job["user_analysis_id"], "expires_in_days": 365})
        assert r.status_code == 422


@pytest.mark.asyncio
async def test_removing_an_analysis_from_the_list_revokes_access_and_its_links(pg):
    async with browser("10.0.0.1") as alice, browser("10.0.0.3") as anon:
        await sign_in(alice)
        job = await analyze_and_finish(pg, alice)
        token = (await alice.post("/shares", json={"user_analysis_id": job["user_analysis_id"], "expires_in_days": 7})).json()["url"][3:]
        assert (await alice.delete(f"/me/analyses/{job['user_analysis_id']}")).status_code == 200
        assert (await alice.get("/me/analyses")).json()["analyses"] == []
        assert (await alice.get(f"/graph/{job['job_id']}")).status_code == 403
        assert (await anon.get(f"/shares/{token}")).status_code == 404
        assert (await alice.delete(f"/me/analyses/{job['user_analysis_id']}")).status_code == 404


# ---------------------------------------------------------------------------
# CSRF
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_state_changing_requests_need_the_app_origin_or_the_csrf_header(pg):
    async with browser(csrf=False) as client:
        body = {"repo_url": "https://github.com/acme/widgets"}
        r = await client.post("/analyze", json=body)
        assert r.status_code == 403 and r.json()["error_code"] == "csrf"
        r = await client.post("/analyze", json=body, headers={"Origin": "https://evil.test"})
        assert r.status_code == 403 and r.json()["error_code"] == "csrf"
        r = await client.post("/analyze", json=body, headers={"Referer": "https://evil.test/page"})
        assert r.status_code == 403
        assert (await client.post("/auth/logout")).status_code == 403
        assert (await client.delete("/shares/00000000-0000-0000-0000-000000000000")).status_code == 403
        # From the app: its Origin, its Referer, or the X-CodeGraph header
        assert (await client.post("/analyze", json=body, headers={"Origin": APP})).status_code == 200
        assert (await client.post("/analyze", json=body, headers={"Referer": f"{APP}/graph/x"})).status_code == 200
        assert (await client.post("/analyze", json=body, headers={"X-CodeGraph": "1"})).status_code == 200
        assert (await client.get("/auth/me")).status_code == 401  # reads are not blocked


# ---------------------------------------------------------------------------
# Rate limits (database-backed)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_anonymous_limit_is_per_session_and_per_ip(pg, monkeypatch):
    monkeypatch.setattr(config, "ANALYZE_LIMIT_PER_HOUR", 2)
    async with browser("10.9.9.9") as client:
        for i in range(2):
            assert (await client.post("/analyze", json={"repo_url": f"https://github.com/o/r{i}"})).status_code == 200
        r = await client.post("/analyze", json={"repo_url": "https://github.com/o/r2"})
        assert r.status_code == 429 and r.json()["error_code"] == "rate_limited"
        assert r.json()["error"].startswith("You've started 2 analyses in the last hour. Try again in ")
    async with browser("10.9.9.9") as fresh_cookies:  # a new session from the same IP is still limited
        assert (await fresh_cookies.post("/analyze", json={"repo_url": "https://github.com/o/r3"})).status_code == 429
    async with browser("10.8.8.8") as elsewhere:
        assert (await elsewhere.post("/analyze", json={"repo_url": "https://github.com/o/r4"})).status_code == 200


@pytest.mark.asyncio
async def test_signed_in_limit_is_per_user(pg, monkeypatch):
    monkeypatch.setattr(config, "ANALYZE_LIMIT_SIGNED_IN", 3)
    monkeypatch.setattr(config, "ANALYZE_LIMIT_PER_HOUR", 1)
    async with browser("10.7.7.7") as client:
        await sign_in(client)
        for i in range(3):  # more than the anonymous limit
            assert (await client.post("/analyze", json={"repo_url": f"https://github.com/o/s{i}"})).status_code == 200
        r = await client.post("/analyze", json={"repo_url": "https://github.com/o/s3"})
        assert r.status_code == 429 and "3 analyses" in r.json()["error"]
    rows = await sql(pg, "select key, count(*) as n from rate_events group by key")
    assert [(r["key"].split(":")[1], r["n"]) for r in rows] == [("user", 3)]


@pytest.mark.asyncio
async def test_rate_events_are_pruned(pg):
    await sql(pg, "insert into rate_events (key, at) values ('k', now() - interval '2 days'), ('k', now())")
    await pg.maintenance()
    assert (await sql(pg, "select count(*) as n from rate_events"))[0]["n"] == 1


@pytest.mark.asyncio
async def test_rate_hit_window(pg):
    store = auth.runtime.auth
    assert await store.rate_hit(["x"], 2, timedelta(hours=1)) is None
    assert await store.rate_hit(["x"], 2, timedelta(hours=1)) is None
    wait = await store.rate_hit(["x"], 2, timedelta(hours=1))
    assert 3500 < wait <= 3600
