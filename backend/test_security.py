# What it does: Tests for security hardening (private repos, admin auth, CORS, rate limits,
# /source restrictions, removed routes, log redaction) and the ingestion __init__.py rule.

import logging
from unittest.mock import patch

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

import ingestion
import log_safety
import main
from main import analyze_counts, app, jobs


@pytest.fixture(autouse=True)
def reset_state():
    jobs.clear()
    main.store.graphs.clear()
    analyze_counts.clear()
    main.chat_message_counts.clear()


@pytest.fixture
def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# ---------------------------------------------------------------------------
# 1. Private repositories
# ---------------------------------------------------------------------------
class _Resp:
    def __init__(self, data, status=200):
        self._data, self.status_code = data, status

    def json(self):
        return self._data


@pytest.mark.asyncio
async def test_private_repo_is_rejected_by_ingestion():
    class Client:
        async def get(self, url, timeout=None):
            return _Resp({"private": True, "default_branch": "main"})

    with pytest.raises(ingestion.RepoPrivateError) as err:
        await ingestion._get_default_branch_and_sha("me", "secret", Client())
    assert str(err.value) == "Private repositories aren't supported."
    assert ingestion.RepoPrivateError.error_code == "private_repo"


@pytest.mark.asyncio
async def test_private_repo_job_gets_error_code():
    jobs["j1"] = {"job_id": "j1", "status": "queued", "progress": 0, "stage": "queued", "message": "", "error": None}
    with patch("main.ingestion.fetch_repo", side_effect=ingestion.RepoPrivateError(ingestion.RepoPrivateError.message)):
        await main._run_pipeline("j1", "https://github.com/me/secret")
    assert jobs["j1"]["status"] == "error"
    assert jobs["j1"]["error_code"] == "private_repo"
    assert jobs["j1"]["error"] == "Private repositories aren't supported."


# ---------------------------------------------------------------------------
# 2. Admin endpoints
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_cache_endpoints_do_not_exist_without_admin_key(client, monkeypatch):
    monkeypatch.delenv("ADMIN_KEY", raising=False)
    assert (await client.get("/cache")).status_code == 404
    assert (await client.delete("/cache/a/b")).status_code == 404


@pytest.mark.asyncio
async def test_cache_endpoints_need_the_right_key(client, monkeypatch):
    monkeypatch.setenv("ADMIN_KEY", "s3cret-admin-key-123")
    assert (await client.get("/cache")).status_code == 401
    assert (await client.get("/cache", headers={"X-Admin-Key": "wrong"})).status_code == 403
    assert (await client.delete("/cache/a/b", headers={"X-Admin-Key": "wrong"})).status_code == 403
    with patch("main.cache.list_cached", return_value=[]):
        ok = await client.get("/cache", headers={"X-Admin-Key": "s3cret-admin-key-123"})
        assert ok.status_code == 200 and ok.json() == []
        deleted = await client.delete("/cache/a/b", headers={"X-Admin-Key": "s3cret-admin-key-123"})
        assert deleted.status_code == 200 and deleted.json() == {"deleted": 0, "repo": "a/b"}


# ---------------------------------------------------------------------------
# 3. Auto-analyse-by-URL routes are gone
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_repo_routes_removed(client):
    assert (await client.get("/repo/pallets/flask")).status_code == 404
    assert (await client.get("/repo/pallets/flask/meta")).status_code == 404


# ---------------------------------------------------------------------------
# 4. CORS
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_cors_allows_listed_origins_only(client):
    preflight = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"}
    good = await client.options("/analyze", headers={"Origin": "https://code-graph-ashy.vercel.app", **preflight})
    assert good.status_code == 200
    assert good.headers["access-control-allow-origin"] == "https://code-graph-ashy.vercel.app"
    bad = await client.options("/analyze", headers={"Origin": "https://evil.example", **preflight})
    assert bad.status_code == 400
    assert "access-control-allow-origin" not in bad.headers
    simple = await client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in simple.headers


def test_allowed_origins_default_and_env(monkeypatch):
    import importlib

    import config
    monkeypatch.setenv("ALLOWED_ORIGINS", " https://a.example/ , http://localhost:5173 ,")
    reloaded = importlib.reload(config)
    assert reloaded.ALLOWED_ORIGINS == ["https://a.example", "http://localhost:5173"]
    monkeypatch.delenv("ALLOWED_ORIGINS")
    assert importlib.reload(config).ALLOWED_ORIGINS == ["https://code-graph-ashy.vercel.app", "http://localhost:5173"]


def test_allowed_origins_parsing_is_forgiving(monkeypatch):
    import importlib

    import config
    monkeypatch.setenv("ALLOWED_ORIGINS", " https://code-graph-ashy.vercel.app/ ,http://localhost:5173")
    assert importlib.reload(config).ALLOWED_ORIGINS == ["https://code-graph-ashy.vercel.app", "http://localhost:5173"]
    assert config.parse_origins(" , / ,https://a.example//, https://a.example ,,") == ["https://a.example"]
    monkeypatch.delenv("ALLOWED_ORIGINS")
    importlib.reload(config)


def test_startup_logs_origins_and_warns_on_render(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="codegraph")
    monkeypatch.delenv("RENDER", raising=False)
    main._log_allowed_origins(["http://localhost:5173"])
    assert "allowed origins: http://localhost:5173" in caplog.text
    assert not [r for r in caplog.records if r.levelno == logging.WARNING]

    caplog.clear()
    monkeypatch.setenv("RENDER", "true")
    main._log_allowed_origins(["http://localhost:5173"])
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and "https://code-graph-ashy.vercel.app" in warnings[0].getMessage()

    caplog.clear()
    main._log_allowed_origins(["https://code-graph-ashy.vercel.app", "http://localhost:5173"])
    assert not [r for r in caplog.records if r.levelno == logging.WARNING]


# ---------------------------------------------------------------------------
# 5. /analyze: 10 per hour per IP
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_eleventh_analysis_in_an_hour_is_429(client):
    for i in range(10):
        r = await client.post("/analyze", json={"repo_url": f"https://github.com/a/r{i}"}, headers={"X-Forwarded-For": "9.9.9.9"})
        assert r.status_code == 200, i
        jobs[r.json()["job_id"]]["status"] = "done"  # not "active": only the hourly limit applies
    r = await client.post("/analyze", json={"repo_url": "https://github.com/a/r10"}, headers={"X-Forwarded-For": "9.9.9.9"})
    assert r.status_code == 429
    body = r.json()
    assert body["error_code"] == "rate_limited"
    assert body["error"].startswith("You've started 10 analyses in the last hour. Try again in ")
    # Another IP is not affected
    other = await client.post("/analyze", json={"repo_url": "https://github.com/a/x"}, headers={"X-Forwarded-For": "1.2.3.4"})
    assert other.status_code == 200


# ---------------------------------------------------------------------------
# 6. /source only serves files of the analysed graph
# ---------------------------------------------------------------------------
GRAPH = {"nodes": [
    {"id": "src/app.ts", "type": "file", "lang": "typescript"},
    {"id": "src/app.ts::main", "type": "function", "file": "src/app.ts"},
], "edges": []}


class _FakeAsyncClient:
    requested = []

    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url):
        _FakeAsyncClient.requested.append(url)
        return httpx.Response(200, text="export function main() {}")


@pytest.mark.asyncio
async def test_source_refuses_paths_not_in_the_graph(client):
    _FakeAsyncClient.requested = []
    with patch("main.cache.read_cache", return_value=GRAPH), patch("main.httpx.AsyncClient", _FakeAsyncClient):
        for path in ("src/other.ts", ".env", "src/app.ts::main"):
            r = await client.get(f"/source/o/r/abc12345/{path}")
            assert r.status_code == 404, path
        # ".." is normalised away before routing; whatever it resolves to, nothing is served
        assert (await client.get("/source/o/r/abc12345/../../etc/passwd")).status_code != 200
        assert _FakeAsyncClient.requested == []  # nothing was fetched for refused paths
        ok = await client.get("/source/o/r/abc12345/src/app.ts")
        assert ok.status_code == 200
        assert ok.json() == {"path": "src/app.ts", "content": "export function main() {}", "language": "typescript"}


@pytest.mark.asyncio
async def test_source_refuses_repos_that_were_not_analysed(client):
    with patch("main.cache.read_cache", return_value=None):
        assert (await client.get("/source/me/private-repo/abc12345/secrets.py")).status_code == 404


# ---------------------------------------------------------------------------
# 7. Secrets never reach the logs
# ---------------------------------------------------------------------------
def test_log_redaction(monkeypatch, caplog):
    monkeypatch.setenv("GROQ_API_KEY", "groq-value-that-is-long-enough")
    assert log_safety.redact("token ghp_" + "a" * 36 + " end") == "token [redacted] end"
    assert log_safety.redact("Authorization: Bearer abc.def.ghi-123") == "[redacted]"
    assert log_safety.redact("headers X-Admin-Key: k3y-value-123 sent") == "headers [redacted] sent"
    assert log_safety.redact("got bearer abcdefgh12345 back") == "got [redacted] back"
    assert "groq-value" not in log_safety.redact("failed with key groq-value-that-is-long-enough")
    logger = logging.getLogger("codegraph.test")
    logger.addFilter(log_safety.RedactSecrets())
    with caplog.at_level(logging.INFO, logger="codegraph.test"):
        logger.info("calling GitHub with %s", "github_pat_" + "B" * 30)
    assert "github_pat_" not in caplog.text and "[redacted]" in caplog.text


def test_log_redaction_of_database_urls(monkeypatch):
    url = "postgresql://neondb_owner:npg_S3cretPassw0rd@ep-cool-name-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require"
    assert log_safety.redact(f"connect failed: {url} timeout") == "connect failed: [redacted] timeout"
    assert log_safety.redact("dsn host=x password=npg_S3cret dbname=y") == "dsn host=x [redacted] dbname=y"
    monkeypatch.setenv("DATABASE_URL", url)
    assert "npg_S3cretPassw0rd" not in log_safety.redact(f"value was '{url}'")


# ---------------------------------------------------------------------------
# Impact endpoint used an undefined job_id (500 on every request)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_impact_endpoint_no_longer_crashes(client):
    async def fake_stream(*args, **kwargs):
        yield 'data: {"done": true}\n\n'

    graph = {"nodes": [{"id": "a.py::f", "type": "function"}], "edges": []}
    with patch("main.cache.read_cache", return_value=graph), patch("main.impact.stream_impact_analysis", fake_stream):
        r = await client.post("/impact/o/r/abc", json={"source_node_id": "a.py::f", "change_description": "", "blast_radius": {}})
    assert r.status_code == 200
    assert '"done": true' in r.text


# ---------------------------------------------------------------------------
# 10. Non-empty __init__.py files are ingested
# ---------------------------------------------------------------------------
def test_non_empty_init_py_is_ingested_empty_is_skipped():
    tree = [
        {"type": "blob", "path": "pkg/__init__.py", "size": 120},
        {"type": "blob", "path": "pkg/sub/__init__.py", "size": 0},
        {"type": "blob", "path": "pkg/core.py", "size": 300},
    ]
    files, _ = ingestion.select_files(tree)
    assert [f["path"] for f in files] == ["pkg/__init__.py", "pkg/core.py"]
