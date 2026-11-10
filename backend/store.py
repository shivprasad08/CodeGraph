# What it does: where jobs and analyses live — Postgres (durable) or memory (tests, local without DB)
#
# Both stores expose the same async API. Job dicts returned by get_job() use the API's
# vocabulary: status is queued | running | done | error (the database says 'failed').
#
#   create_job / create_done_job      POST /analyze (a done analysis for the latest commit → instant job)
#   claim_job / heartbeat / release   the worker (worker.py)
#   job_handle(id).set(...)           progress, written at most twice a second
#   resolve_commit / complete / fail  the pipeline's outcomes
#   load_graph / analysis_graph       reads (main.py adds the /tmp L1 cache in front)

import asyncio
import hashlib
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone

import db
from graph_builder import GRAPH_SCHEMA_VERSION

logger = logging.getLogger("codegraph.store")

MAX_ATTEMPTS = 3
LOCK_SECONDS = 120
PROGRESS_INTERVAL = 0.5  # ≤ 2 progress writes per second per job
RETRIES_EXHAUSTED = "retries_exhausted"
RETRIES_EXHAUSTED_MESSAGE = "The analysis was interrupted too many times. Try again."
CACHED_MESSAGE = "Loaded from cache"

_API_STATUS = {"queued": "queued", "running": "running", "done": "done", "failed": "error"}


def hash_ip(ip: str) -> str:
    return hashlib.sha256(f"codegraph-ip:{ip}".encode()).hexdigest()[:32]


def repo_from_url(repo_url: str) -> str:
    """owner/repo from a GitHub URL (best effort; ingestion sets the real name later)."""
    m = re.search(r"github\.com/([^/\s]+)/([^/\s?#]+)", repo_url or "")
    if not m:
        return (repo_url or "").strip()[:200]
    name = m.group(2)
    return f"{m.group(1)}/{name[:-4] if name.endswith('.git') else name}"


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Memory store
# ---------------------------------------------------------------------------
class _MemoryHandle:
    def __init__(self, job: dict | None):
        self.job = job

    def set(self, **fields) -> None:
        if self.job is not None:
            self.job.update(fields)

    async def close(self) -> None:
        return None


class MemoryStore:
    """Process memory: lost on restart. Used by tests and when DATABASE_URL is not set."""

    kind = "memory"
    maintenance_interval = 600  # prune finished jobs older than an hour every 10 minutes

    def __init__(self):
        self.jobs: dict[str, dict] = {}
        self.graphs: dict[tuple[str, str], dict] = {}

    async def close(self) -> None:
        return None

    async def ping(self) -> bool:
        return True

    def _new_job(self, repo_url: str, ip: str, **fields) -> str:
        job_id = str(uuid.uuid4())
        self.jobs[job_id] = {
            "job_id": job_id, "repo_url": repo_url, "status": "queued", "progress": 0, "stage": "queued",
            "message": "Queued", "error": None, "error_code": None, "graph": None, "ip": ip,
            "attempts": 0, "created_at": datetime.now(timezone.utc), **fields,
        }
        return job_id

    async def create_job(self, repo_url: str, ip: str) -> str:
        return self._new_job(repo_url, ip)

    async def create_done_job(self, repo_url: str, ip: str, analysis_id) -> str:
        graph = self.graphs.get(analysis_id)
        return self._new_job(repo_url, ip, status="done", stage="done", progress=100, message=CACHED_MESSAGE,
                             graph=graph, analysis=(graph or {}).get("analysis"))

    async def find_done_analysis(self, repo: str, sha: str):
        key = (repo.lower(), sha)
        return key if key in self.graphs else None

    async def get_job(self, job_id: str) -> dict | None:
        return self.jobs.get(job_id)

    def job_handle(self, job_id: str) -> _MemoryHandle:
        return _MemoryHandle(self.jobs.get(job_id))

    async def resolve_commit(self, job_id: str, repo: str, sha: str) -> bool:
        graph = self.graphs.get((repo.lower(), sha))
        if graph is None:
            return False
        self.jobs.get(job_id, {}).update(status="done", stage="done", progress=100, message=CACHED_MESSAGE,
                                         graph=graph, analysis=graph.get("analysis"))
        return True

    async def complete_job(self, job_id: str, repo: str, sha: str, graph: dict) -> None:
        self.graphs[(repo.lower(), sha)] = graph
        self.jobs.get(job_id, {}).update(status="done", stage="done", progress=100, message="Analysis complete",
                                         graph=graph, analysis=graph.get("analysis"))

    async def fail_job(self, job_id: str, error: str, error_code: str | None = None) -> None:
        self.jobs.get(job_id, {}).update(status="error", error=error, error_code=error_code)

    async def claim_job(self, worker_id: str) -> dict | None:
        queued = sorted((j for j in self.jobs.values() if j.get("status") == "queued"),
                        key=lambda j: j.get("created_at") or datetime.min.replace(tzinfo=timezone.utc))
        if not queued:
            return None
        job = queued[0]
        job.update(status="running", attempts=job.get("attempts", 0) + 1, locked_by=worker_id)
        return {"id": job["job_id"], "repo_url": job["repo_url"], "attempts": job["attempts"]}

    async def heartbeat(self, job_id: str, worker_id: str) -> bool:
        return True

    async def release_job(self, job_id: str, worker_id: str) -> None:
        job = self.jobs.get(job_id)
        if job and job.get("status") == "running":
            job.update(status="queued", attempts=max(0, job.get("attempts", 1) - 1))

    async def load_graph(self, repo: str, sha: str) -> dict | None:
        return self.graphs.get((repo.lower(), sha))

    async def analysis_graph(self, analysis_id) -> dict | None:
        return self.graphs.get(analysis_id)

    async def active_jobs_for_ip(self, ip: str) -> int:
        return sum(1 for j in self.jobs.values() if j.get("ip") == ip and j.get("status") in ("queued", "running"))

    async def queue_stats(self) -> dict:
        statuses = [j.get("status") for j in self.jobs.values()]
        return {"queued": statuses.count("queued"), "running": statuses.count("running")}

    async def maintenance(self) -> None:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
        for job_id in [k for k, j in self.jobs.items() if j.get("created_at") and j["created_at"] < cutoff]:
            del self.jobs[job_id]


# ---------------------------------------------------------------------------
# Postgres store
# ---------------------------------------------------------------------------
class _PgHandle:
    """Collects progress and writes it at most every PROGRESS_INTERVAL seconds."""

    def __init__(self, pool, job_id: str):
        self.pool = pool
        self.job_id = job_id
        self.pending: dict = {}
        self.wake = asyncio.Event()
        self.task = asyncio.create_task(self._flush_loop())

    def set(self, **fields) -> None:
        self.pending.update({k: v for k, v in fields.items() if k in ("stage", "progress", "message")})
        self.wake.set()

    async def _flush_loop(self) -> None:
        while True:
            await self.wake.wait()
            self.wake.clear()
            fields, self.pending = self.pending, {}
            if fields:
                try:
                    async with self.pool.connection() as conn:
                        # Only while running: a late write never overwrites a finished job
                        await conn.execute(
                            "update jobs set stage = coalesce(%(stage)s, stage), progress = coalesce(%(progress)s, progress),"
                            " message = coalesce(%(message)s, message), updated_at = now()"
                            " where id = %(id)s and status = 'running'",
                            {"stage": fields.get("stage"), "progress": fields.get("progress"),
                             "message": fields.get("message"), "id": self.job_id},
                        )
                except Exception as e:  # progress is best effort
                    logger.warning(f"[store] progress write failed for {self.job_id}: {type(e).__name__}")
            await asyncio.sleep(PROGRESS_INTERVAL)

    async def close(self) -> None:
        """Stops writing (pending progress is dropped: a terminal write follows)."""
        self.task.cancel()
        try:
            await self.task
        except asyncio.CancelledError:
            pass


class PgStore:
    kind = "postgres"
    maintenance_interval = 24 * 3600  # retention once a day

    def __init__(self, pool):
        self.pool = pool

    @classmethod
    async def open(cls, url: str) -> "PgStore":
        return cls(await db.open_pool(url))

    async def close(self) -> None:
        await self.pool.close()

    async def ping(self) -> bool:
        try:
            async with self.pool.connection(timeout=5) as conn:
                await conn.execute("select 1")
            return True
        except Exception:
            return False

    async def _fetchone(self, sql: str, params=None) -> dict | None:
        async with self.pool.connection() as conn:
            cur = await conn.execute(sql, params)
            return await cur.fetchone()

    # -- creating jobs ------------------------------------------------------
    async def create_job(self, repo_url: str, ip: str) -> str:
        async with self.pool.connection() as conn:
            async with conn.transaction():
                cur = await conn.execute(
                    "insert into analyses (repo, schema_version, status) values (%s, %s, 'queued') returning id",
                    (repo_from_url(repo_url), GRAPH_SCHEMA_VERSION),
                )
                analysis_id = (await cur.fetchone())["id"]
                cur = await conn.execute(
                    "insert into jobs (analysis_id, repo_url, status, stage, progress, message, client_ip_hash)"
                    " values (%s, %s, 'queued', 'queued', 0, 'Queued', %s) returning id",
                    (analysis_id, repo_url, hash_ip(ip)),
                )
                return str((await cur.fetchone())["id"])

    async def create_done_job(self, repo_url: str, ip: str, analysis_id) -> str:
        row = await self._fetchone(
            "insert into jobs (analysis_id, repo_url, status, stage, progress, message, stats, client_ip_hash)"
            " select id, %s, 'done', 'done', 100, %s, stats, %s from analyses where id = %s returning id",
            (repo_url, CACHED_MESSAGE, hash_ip(ip), analysis_id),
        )
        return str(row["id"])

    async def find_done_analysis(self, repo: str, sha: str):
        row = await self._fetchone(
            "select id from analyses where lower(repo) = lower(%s) and commit_sha = %s"
            " and schema_version = %s and status = 'done'",
            (repo, sha, GRAPH_SCHEMA_VERSION),
        )
        return row["id"] if row else None

    # -- reading jobs -------------------------------------------------------
    async def get_job(self, job_id: str) -> dict | None:
        jid = _uuid(job_id)
        if jid is None:
            return None
        row = await self._fetchone(
            "select j.id, j.repo_url, j.status, j.stage, j.progress, j.message, j.attempts, j.analysis_id,"
            " a.repo, a.commit_sha, a.schema_version, a.error, a.error_code"
            " from jobs j left join analyses a on a.id = j.analysis_id where j.id = %s",
            (jid,),
        )
        if row is None:
            return None
        return {
            "job_id": str(row["id"]),
            "repo_url": row["repo_url"],
            "status": _API_STATUS.get(row["status"], row["status"]),
            "progress": row["progress"],
            "stage": row["stage"],
            "message": row["message"],
            "error": row["error"] if row["status"] == "failed" else None,
            "error_code": row["error_code"] if row["status"] == "failed" else None,
            "attempts": row["attempts"],
            "analysis_id": row["analysis_id"],
            "repo": row["repo"],
            "commit_sha": row["commit_sha"],
            "schema_version": row["schema_version"],
        }

    def job_handle(self, job_id: str) -> _PgHandle:
        return _PgHandle(self.pool, job_id)

    # -- pipeline outcomes ----------------------------------------------------
    async def resolve_commit(self, job_id: str, repo: str, sha: str) -> bool:
        """
        The commit is known: when a done analysis exists, the job points at it and finishes (True);
        otherwise the job's own analysis records repo@sha and is marked running (False).
        """
        existing = await self.find_done_analysis(repo, sha)
        async with self.pool.connection() as conn:
            async with conn.transaction():
                cur = await conn.execute("select analysis_id from jobs where id = %s", (job_id,))
                own = (await cur.fetchone() or {}).get("analysis_id")
                if existing is None:
                    await conn.execute(
                        "update analyses set repo = %s, commit_sha = %s, schema_version = %s, status = 'running',"
                        " updated_at = now() where id = %s and status <> 'done'",
                        (repo, sha, GRAPH_SCHEMA_VERSION, own),
                    )
                    return False
                await self._finish_on(conn, job_id, existing, CACHED_MESSAGE)
                if own and own != existing:
                    await self._drop_placeholder(conn, own, existing)
                return True

    async def _drop_placeholder(self, conn, placeholder, target) -> None:
        """The job now uses `target`: owners of the placeholder move with it, then it is deleted."""
        await conn.execute("update user_analyses set analysis_id = %s where analysis_id = %s", (target, placeholder))
        await conn.execute("delete from analyses where id = %s and status <> 'done'", (placeholder,))

    async def _finish_on(self, conn, job_id: str, analysis_id, message: str) -> None:
        await conn.execute(
            "update jobs set analysis_id = %s, status = 'done', stage = 'done', progress = 100, message = %s,"
            " stats = (select stats from analyses where id = %s), locked_by = null, locked_until = null,"
            " updated_at = now() where id = %s",
            (analysis_id, message, analysis_id, job_id),
        )

    async def complete_job(self, job_id: str, repo: str, sha: str, graph: dict) -> None:
        from psycopg import errors
        from psycopg.types.json import Jsonb

        blob = db.compress_graph(graph)
        stats, languages = graph.get("stats"), graph.get("languages")
        health = graph.get("analysis") or {}
        async with self.pool.connection() as conn:
            async with conn.transaction():
                cur = await conn.execute("select analysis_id from jobs where id = %s", (job_id,))
                own = (await cur.fetchone() or {}).get("analysis_id")
                target = own
                try:
                    async with conn.transaction():  # savepoint: another job may have finished this commit first
                        await conn.execute(
                            "update analyses set repo = %s, commit_sha = %s, schema_version = %s, status = 'done',"
                            " graph_gz = %s, stats = %s, languages = %s, health_score = %s, health_grade = %s,"
                            " error = null, error_code = null, finished_at = now(), updated_at = now() where id = %s",
                            (repo, sha, GRAPH_SCHEMA_VERSION, blob, Jsonb(stats), Jsonb(languages),
                             health.get("score"), health.get("grade"), own),
                        )
                except errors.UniqueViolation:
                    cur = await conn.execute(
                        "select id from analyses where lower(repo) = lower(%s) and commit_sha = %s"
                        " and schema_version = %s and status = 'done'",
                        (repo, sha, GRAPH_SCHEMA_VERSION),
                    )
                    target = (await cur.fetchone())["id"]
                await self._finish_on(conn, job_id, target, "Analysis complete")
                if own and target != own:
                    await self._drop_placeholder(conn, own, target)
        logger.info(f"[store] saved {repo}@{sha}: {len(blob) / 1024:.1f} KB compressed")

    async def fail_job(self, job_id: str, error: str, error_code: str | None = None) -> None:
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute(
                    "update jobs set status = 'failed', locked_by = null, locked_until = null, updated_at = now()"
                    " where id = %s",
                    (job_id,),
                )
                await conn.execute(
                    "update analyses set status = 'failed', error = %s, error_code = %s, finished_at = now(),"
                    " updated_at = now() where id = (select analysis_id from jobs where id = %s) and status <> 'done'",
                    (error, error_code, job_id),
                )

    # -- worker ---------------------------------------------------------------
    async def claim_job(self, worker_id: str) -> dict | None:
        """Next queued job, or a running one whose lock expired (its worker died). Exclusive."""
        async with self.pool.connection() as conn:
            async with conn.transaction():
                cur = await conn.execute(
                    "update jobs set status = 'running', locked_by = %(w)s,"
                    " locked_until = now() + make_interval(secs => %(lock)s), attempts = attempts + 1, updated_at = now()"
                    " where id = (select id from jobs where status = 'queued'"
                    "   or (status = 'running' and locked_until < now())"
                    "   order by created_at for update skip locked limit 1)"
                    " returning id, repo_url, attempts, analysis_id",
                    {"w": worker_id, "lock": LOCK_SECONDS},
                )
                row = await cur.fetchone()
                if row:
                    await conn.execute(
                        "update analyses set status = 'running', updated_at = now() where id = %s and status = 'queued'",
                        (row["analysis_id"],),
                    )
        if row is None:
            return None
        return {"id": str(row["id"]), "repo_url": row["repo_url"], "attempts": row["attempts"]}

    async def heartbeat(self, job_id: str, worker_id: str) -> bool:
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "update jobs set locked_until = now() + make_interval(secs => %s)"
                " where id = %s and locked_by = %s and status = 'running'",
                (LOCK_SECONDS, job_id, worker_id),
            )
            return cur.rowcount == 1

    async def release_job(self, job_id: str, worker_id: str) -> None:
        """Shutdown mid-job: back to the queue now (not after the lock expires); the attempt is not counted."""
        async with self.pool.connection() as conn:
            await conn.execute(
                "update jobs set status = 'queued', locked_by = null, locked_until = null,"
                " attempts = greatest(attempts - 1, 0), updated_at = now()"
                " where id = %s and locked_by = %s and status = 'running'",
                (job_id, worker_id),
            )

    # -- reads ----------------------------------------------------------------
    async def load_graph(self, repo: str, sha: str) -> dict | None:
        row = await self._fetchone(
            "select graph_gz from analyses where lower(repo) = lower(%s) and commit_sha = %s"
            " and schema_version = %s and status = 'done'",
            (repo, sha, GRAPH_SCHEMA_VERSION),
        )
        return db.decompress_graph(row["graph_gz"]) if row and row["graph_gz"] is not None else None

    async def analysis_graph(self, analysis_id) -> dict | None:
        if analysis_id is None:
            return None
        row = await self._fetchone("select graph_gz from analyses where id = %s and status = 'done'", (analysis_id,))
        return db.decompress_graph(row["graph_gz"]) if row and row["graph_gz"] is not None else None

    async def active_jobs_for_ip(self, ip: str) -> int:
        row = await self._fetchone(
            "select count(*) as n from jobs where client_ip_hash = %s and status in ('queued', 'running')",
            (hash_ip(ip),),
        )
        return row["n"]

    async def queue_stats(self) -> dict:
        row = await self._fetchone(
            "select count(*) filter (where status = 'queued') as queued,"
            " count(*) filter (where status = 'running') as running from jobs"
        )
        return {"queued": row["queued"], "running": row["running"]}

    async def maintenance(self) -> dict:
        """Retention: unfinished/failed analyses after 7 days, graphs of older schemas after 30 days."""
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "delete from analyses where status <> 'done' and created_at < now() - interval '7 days'"
            )
            unfinished = cur.rowcount
            cur = await conn.execute(
                "delete from analyses where status = 'done' and schema_version < %s"
                " and created_at < now() - interval '30 days'",
                (GRAPH_SCHEMA_VERSION,),
            )
            old_schema = cur.rowcount
            cur = await conn.execute("delete from sessions where expires_at < now()")
            sessions = cur.rowcount
            cur = await conn.execute("delete from rate_events where at < now() - interval '1 day'")
            rate_events = cur.rowcount
        logger.info(
            f"[retention] deleted {unfinished} unfinished and {old_schema} old-schema analyses,"
            f" {sessions} expired sessions, {rate_events} old rate events"
        )
        return {"unfinished": unfinished, "old_schema": old_schema}
