# What it does: Postgres storage tests (migrations, job queue, restart, graph round-trip, API on Postgres)
#
# Needs TEST_DATABASE_URL (a disposable Neon branch: tables are truncated between tests).
# Without it every test here is skipped.

import asyncio
import os
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

import config  # noqa: F401  (loads backend/.env)
import db
import main
import store as store_mod
import worker as worker_mod
from graph_builder import GRAPH_SCHEMA_VERSION

TEST_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="TEST_DATABASE_URL is not set")

GRAPH = {
    "repo": "acme/widgets", "commit_sha": "abc12345", "schema_version": GRAPH_SCHEMA_VERSION,
    "nodes": [{"id": "src/app.py", "type": "file", "lang": "python", "summary": "Entrée — ünïcode ✓"},
              {"id": "src/app.py::main", "type": "function", "file": "src/app.py"}],
    "edges": [{"source": "src/app.py", "target": "src/app.py::main", "type": "defines"}],
    "stats": {"files": 1, "functions": 1}, "languages": {"python": 1},
    "analysis": {"score": 90, "grade": "A", "issues": [], "patterns": [], "by_file": {}},
}


@pytest_asyncio.fixture
async def pg():
    await db.run_migrations(TEST_URL)
    s = await store_mod.PgStore.open(TEST_URL)
    async with s.pool.connection() as conn:
        await conn.execute("truncate jobs, analyses, users, sessions, user_analyses, share_links, rate_events cascade")
    try:
        yield s
    finally:
        await s.close()


@pytest_asyncio.fixture
async def api(pg, tmp_path, monkeypatch):
    """The app on the Postgres store, with an empty L1 cache dir."""
    monkeypatch.setattr(main, "store", pg)
    monkeypatch.setattr(main.cache.config, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(main, "SSE_POLL_SECONDS", 0.1)
    main.analyze_counts.clear()
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test", headers={"X-CodeGraph": "1"}) as client:
        yield client


async def _sql(pg, sql, params=None):
    async with pg.pool.connection() as conn:
        cur = await conn.execute(sql, params)
        return await cur.fetchall() if cur.description else None


async def _finished_job(pg, repo="acme/widgets", sha="abc12345", graph=GRAPH) -> str:
    job_id = await pg.create_job(f"https://github.com/{repo}", "1.1.1.1")
    claimed = await pg.claim_job("w-test")
    assert claimed["id"] == job_id
    await pg.complete_job(job_id, repo, sha, graph)
    return job_id


# ---------------------------------------------------------------------------
# Migrations
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_migrations_are_idempotent(pg):
    assert await db.run_migrations(TEST_URL) == []  # already applied by the fixture
    await asyncio.gather(db.run_migrations(TEST_URL), db.run_migrations(TEST_URL))  # concurrent: lock
    rows = await _sql(pg, "select version from schema_migrations order by version")
    assert [r["version"] for r in rows] == [v for v, _ in db.migration_files()]
    tables = {r["tablename"] for r in await _sql(pg, "select tablename from pg_tables where schemaname = 'public'")}
    assert {"analyses", "jobs", "schema_migrations"} <= tables


# ---------------------------------------------------------------------------
# Queue
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_claims_are_exclusive_under_concurrency(pg):
    created = {await pg.create_job(f"https://github.com/o/r{i}", "1.1.1.1") for i in range(5)}
    claims = await asyncio.gather(*(pg.claim_job(f"w{i}") for i in range(10)))
    claimed = [c["id"] for c in claims if c]
    assert sorted(claimed) == sorted(created)  # every job once, none twice
    assert await pg.claim_job("late") is None
    owners = await _sql(pg, "select count(distinct locked_by) as n from jobs where status = 'running'")
    assert owners[0]["n"] == 5


@pytest.mark.asyncio
async def test_expired_lock_is_reclaimed(pg):
    job_id = await pg.create_job("https://github.com/o/r", "1.1.1.1")
    assert (await pg.claim_job("w1"))["attempts"] == 1
    assert await pg.claim_job("w2") is None  # lock still held
    await _sql(pg, "update jobs set locked_until = now() - interval '1 second' where id = %s", (job_id,))
    again = await pg.claim_job("w2")
    assert again["id"] == job_id and again["attempts"] == 2
    assert (await _sql(pg, "select locked_by from jobs where id = %s", (job_id,)))[0]["locked_by"] == "w2"
    assert await pg.heartbeat(job_id, "w2") and not await pg.heartbeat(job_id, "w1")


@pytest.mark.asyncio
async def test_attempts_are_capped(pg):
    job_id = await pg.create_job("https://github.com/o/r", "1.1.1.1")
    await _sql(pg, "update jobs set status = 'running', attempts = %s, locked_until = now() - interval '1 second'"
                   " where id = %s", (store_mod.MAX_ATTEMPTS, job_id))
    ran = []

    async def run(*args):
        ran.append(args)

    assert await worker_mod.Worker(pg, run).run_once()
    assert ran == []
    job = await pg.get_job(job_id)
    assert job["status"] == "error" and job["error_code"] == store_mod.RETRIES_EXHAUSTED


@pytest.mark.asyncio
async def test_progress_is_written_and_throttled(pg):
    job_id = await pg.create_job("https://github.com/o/r", "1.1.1.1")
    await pg.claim_job("w1")
    handle = pg.job_handle(job_id)
    for i in range(50):  # a burst becomes a couple of writes; the last value wins
        handle.set(stage="enrichment", progress=70 + i // 5, message=f"Summarizing files {i}/49...")
    await asyncio.sleep(store_mod.PROGRESS_INTERVAL * 2.5)
    await handle.close()
    job = await pg.get_job(job_id)
    assert (job["stage"], job["progress"], job["message"]) == ("enrichment", 79, "Summarizing files 49/49...")


# ---------------------------------------------------------------------------
# Graph storage
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_graph_gzip_bytea_round_trip(pg):
    job_id = await _finished_job(pg)
    job = await pg.get_job(job_id)
    assert job["status"] == "done" and job["progress"] == 100
    assert await pg.analysis_graph(job["analysis_id"]) == GRAPH
    assert await pg.load_graph("ACME/Widgets", "abc12345") == GRAPH  # repo names are case-insensitive
    row = (await _sql(pg, "select octet_length(graph_gz) as n, stats, languages from analyses"))[0]
    assert row["stats"] == GRAPH["stats"] and row["languages"] == GRAPH["languages"]
    assert db.decompress_graph(db.compress_graph(GRAPH)) == GRAPH and row["n"] > 0


@pytest.mark.asyncio
async def test_second_job_for_the_same_commit_reuses_the_analysis(pg):
    first = await _finished_job(pg)
    second = await pg.create_job("https://github.com/acme/widgets", "1.1.1.1")
    await pg.claim_job("w2")
    assert await pg.resolve_commit(second, "acme/widgets", "abc12345")
    a, b = await pg.get_job(first), await pg.get_job(second)
    assert b["status"] == "done" and b["analysis_id"] == a["analysis_id"]
    assert (await _sql(pg, "select count(*) as n from analyses"))[0]["n"] == 1  # placeholder removed


@pytest.mark.asyncio
async def test_failed_job_reports_error_like_before(pg):
    job_id = await pg.create_job("https://github.com/o/r", "1.1.1.1")
    await pg.claim_job("w1")
    await pg.fail_job(job_id, "Private repositories aren't supported.", "private_repo")
    job = await pg.get_job(job_id)
    assert (job["status"], job["error"], job["error_code"]) == ("error", "Private repositories aren't supported.", "private_repo")


@pytest.mark.asyncio
async def test_retention(pg):
    await _finished_job(pg)  # current schema, recent: kept
    await _sql(pg, "insert into analyses (repo, schema_version, status, created_at) values"
                   " ('o/old-failed', %(v)s, 'failed', now() - interval '8 days'),"
                   " ('o/new-failed', %(v)s, 'failed', now() - interval '1 day'),"
                   " ('o/old-schema', %(old)s, 'done', now() - interval '31 days'),"
                   " ('o/old-schema-recent', %(old)s, 'done', now() - interval '5 days'),"
                   " ('o/current-old', %(v)s, 'done', now() - interval '90 days')",
               {"v": GRAPH_SCHEMA_VERSION, "old": GRAPH_SCHEMA_VERSION - 1})
    assert await pg.maintenance() == {"unfinished": 1, "old_schema": 1}
    left = {r["repo"] for r in await _sql(pg, "select repo from analyses")}
    assert left == {"acme/widgets", "o/new-failed", "o/old-schema-recent", "o/current-old"}


# ---------------------------------------------------------------------------
# Restart
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_job_running_when_the_server_died_finishes_after_restart(pg):
    job_id = await pg.create_job("https://github.com/acme/widgets", "1.1.1.1")
    # Process 1 claims the job and dies without releasing it
    dead = await store_mod.PgStore.open(TEST_URL)
    assert (await dead.claim_job("dead-worker"))["id"] == job_id
    await dead.close()
    # ...its lock runs out (2 minutes in real life)
    await _sql(pg, "update jobs set locked_until = now() - interval '1 second' where id = %s", (job_id,))

    # Process 2 starts: a fresh pool and worker pick the job up again
    restarted = await store_mod.PgStore.open(TEST_URL)
    try:
        async def run(jid, repo_url):
            await restarted.complete_job(jid, "acme/widgets", "abc12345", GRAPH)

        assert await worker_mod.Worker(restarted, run).run_once()
        job = await restarted.get_job(job_id)
        assert job["status"] == "done" and job["attempts"] == 2
        assert await restarted.analysis_graph(job["analysis_id"]) == GRAPH
    finally:
        await restarted.close()


@pytest.mark.asyncio
async def test_clean_shutdown_releases_the_running_job(pg):
    job_id = await pg.create_job("https://github.com/o/r", "1.1.1.1")
    started = asyncio.Event()

    async def run(jid, repo_url):
        started.set()
        await asyncio.sleep(3600)

    w = worker_mod.Worker(pg, run)
    task = asyncio.create_task(w.run_forever())
    await asyncio.wait_for(started.wait(), 10)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    row = (await _sql(pg, "select status, attempts, locked_by from jobs where id = %s", (job_id,)))[0]
    assert (row["status"], row["attempts"], row["locked_by"]) == ("queued", 0, None)


# ---------------------------------------------------------------------------
# API on Postgres
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_analyze_reuses_a_done_analysis_instantly(pg, api):
    await _finished_job(pg)

    async def latest(_url):
        return ("acme/widgets", "abc12345")

    with patch.object(main, "_latest_commit", latest):
        r = await api.post("/analyze", json={"repo_url": "https://github.com/acme/widgets"})
    assert r.status_code == 200 and r.json()["status"] == "done"
    job_id = r.json()["job_id"]
    async with api.stream("GET", f"/jobs/{job_id}") as resp:
        events = [line async for line in resp.aiter_lines() if line.startswith("data:")]
    assert len(events) == 1 and '"status": "done"' in events[0] and '"progress": 100' in events[0]
    graph = await api.get(f"/graph/{job_id}")
    assert graph.status_code == 200 and graph.json()["nodes"] == GRAPH["nodes"]
    assert (await api.get(f"/analysis/{job_id}")).json()["score"] == 90


@pytest.mark.asyncio
async def test_api_streams_progress_and_reads_graphs_from_the_database(pg, api):
    r = await api.post("/analyze", json={"repo_url": "https://github.com/acme/widgets"})
    assert r.status_code == 200 and r.json()["status"] == "queued"
    job_id = r.json()["job_id"]

    async def finish_later():
        await asyncio.sleep(0.3)
        await pg.claim_job("w1")
        handle = pg.job_handle(job_id)
        handle.set(stage="parsing", progress=30, message="Parsing code structure...")
        await asyncio.sleep(0.8)
        await handle.close()
        await pg.complete_job(job_id, "acme/widgets", "abc12345", GRAPH)

    finisher = asyncio.create_task(finish_later())
    async with api.stream("GET", f"/jobs/{job_id}") as resp:
        events = [line async for line in resp.aiter_lines() if line.startswith("data:")]
    await finisher
    assert '"status": "queued"' in events[0] and '"stage": "parsing"' in "".join(events)
    assert '"status": "done"' in events[-1]

    # Reads load from the database (the L1 dir is empty), then fill L1
    assert (await api.get(f"/graph/{job_id}")).json()["edges"] == GRAPH["edges"]
    suggestions = await api.get("/chat/acme/widgets/abc12345/suggestions")
    assert suggestions.status_code == 200
    assert (await api.get("/chat/acme/widgets/0000000/suggestions")).status_code == 404
    assert main.cache.read_cache("acme/widgets", "abc12345") == GRAPH


@pytest.mark.asyncio
async def test_unknown_or_malformed_job_ids_are_404(api):
    assert (await api.get("/jobs/not-a-uuid")).status_code == 404
    assert (await api.get("/graph/00000000-0000-0000-0000-000000000000")).status_code == 404


@pytest.mark.asyncio
async def test_health_reports_db_and_queue(pg, api):
    await pg.create_job("https://github.com/o/r", "1.1.1.1")
    body = (await api.get("/health")).json()
    assert body["status"] == "ok" and body["db"] == "ok"
    assert body["queue_depth"] == 1 and body["active_jobs"] == 1
