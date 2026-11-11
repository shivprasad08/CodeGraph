# What it does: FastAPI routes, SSE progress stream, and the analysis pipeline run by the job worker
# Module 6: Backend/Frontend Integration (Hardened for Module 10)
#
# Storage (store.py): Postgres when DATABASE_URL is set — analyses and jobs survive restarts —
# else process memory. The /tmp cache (cache.py) is only an L1 read-through cache in front of it.
# Jobs are run by an in-process worker (worker.py) that claims them from the store.
# Access (auth.py): with Postgres, every analysis is private to the session that ran it (or a
# share link). Without Postgres (local dev, tests) there are no accounts and no access checks.

import hmac
import os
import time
import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, Request, HTTPException
from prometheus_fastapi_instrumentator import Instrumentator
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from contextlib import asynccontextmanager
from starlette.middleware.base import BaseHTTPMiddleware
import httpx
import psycopg
import psycopg_pool

import ingestion
import parser
import graph_builder
import enrichment
import architecture
import cache
import config
import chat
import impact
import db
import auth
import accounts
import auth_store
import github_pr
import pr_impact
import store as store_mod
import worker as worker_mod
from graph_builder import GRAPH_SCHEMA_VERSION
from models import AnalyzeRequest, GraphResponse, ImpactRequest
from ingestion import RepoNotFoundError, FileLimitError, NoSourceError, RepoPrivateError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S"
)
logger = logging.getLogger("codegraph")
# Never let a token or connection string reach the logs (see log_safety.py)
import log_safety  # noqa: E402
log_safety.install()

# ---------------------------------------------------------------------------
# Storage and worker (replaced with Postgres at startup when DATABASE_URL is set)
# ---------------------------------------------------------------------------
store = store_mod.MemoryStore()
jobs = store.jobs  # the memory store's jobs (tests use it directly)
worker: worker_mod.Worker | None = None
chat_message_counts: dict[str, list[datetime]] = {}
analyze_counts: dict[str, list[datetime]] = {}  # ip -> /analyze request times (last hour)
SSE_POLL_SECONDS = 1.0
MAINTENANCE_DELAY_SECONDS = 60
STORAGE_UNAVAILABLE = "Storage is temporarily unavailable. Try again in a minute."


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _require_admin(request: Request) -> None:
    """Admin endpoints: X-Admin-Key must equal ADMIN_KEY. Without ADMIN_KEY they do not exist (404)."""
    expected = os.environ.get("ADMIN_KEY") or ""
    if not expected:
        raise HTTPException(status_code=404, detail="Not Found")
    provided = request.headers.get("X-Admin-Key")
    if not provided:
        raise HTTPException(status_code=401, detail="Admin key required")
    if not hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=403, detail="Invalid admin key")


async def _maintenance_loop():
    """Memory store: prune old jobs every 10 minutes. Postgres: retention once a day."""
    await asyncio.sleep(MAINTENANCE_DELAY_SECONDS)
    while True:
        try:
            await store.maintenance()
        except Exception as e:
            logger.error(f"[maintenance] {type(e).__name__}: {e}")
        await asyncio.sleep(store.maintenance_interval)


# ---------------------------------------------------------------------------
# Timeout Middleware
# ---------------------------------------------------------------------------
class TimeoutMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith("/jobs/"):
            return await call_next(request)
        try:
            return await asyncio.wait_for(call_next(request), timeout=300)
        except asyncio.TimeoutError:
            return JSONResponse(
                {"error": "Request timed out after 300 seconds", "detail": None},
                status_code=504
            )


# ---------------------------------------------------------------------------
# Lifespan and App initialization
# ---------------------------------------------------------------------------
def _check_grammar_cache() -> None:
    """Grammars are fetched at build time (scripts/fetch_grammars.py); say so loudly if that step was skipped."""
    from languages import registry

    missing = sorted(set(registry.GRAMMARS) - registry.cached_grammars())
    if missing:
        logger.warning(
            f"[languages] {len(missing)} grammar(s) missing from {registry.grammar_dir()}: {', '.join(missing)}. "
            "Files in those languages will be skipped. Run `python scripts/fetch_grammars.py` in the build step."
        )
    else:
        logger.info(f"[languages] all {len(registry.GRAMMARS)} grammars cached in {registry.grammar_dir()}")


def _log_allowed_origins(origins: list[str]) -> None:
    """Origins are not secrets: log them, and warn if the deployed frontend is missing on Render."""
    logger.info(f"[cors] allowed origins: {', '.join(origins) or '(none)'}")
    if os.getenv("RENDER") and config.PRODUCTION_ORIGIN not in origins:
        logger.warning(
            f"[cors] ALLOWED_ORIGINS does not include {config.PRODUCTION_ORIGIN}; "
            "the deployed frontend will be blocked by CORS."
        )


async def _open_store():
    """Postgres when configured: migrations first (direct URL), then the pooled connection."""
    if not config.DATABASE_URL:
        logger.warning("[db] DATABASE_URL is not set: jobs and graphs are kept in memory and lost on restart")
        return store_mod.MemoryStore()
    await db.run_migrations(config.DATABASE_URL_DIRECT or config.DATABASE_URL)
    pg = await store_mod.PgStore.open(config.DATABASE_URL)
    logger.info("[db] connected to Postgres")
    return pg


async def _graph_by_analysis(analysis_id, repo, sha, schema_version) -> dict | None:
    """A stored graph by analysis id, through the L1 cache when it is of the current schema."""
    current = bool(repo and sha) and schema_version == GRAPH_SCHEMA_VERSION
    if current:
        graph = cache.read_cache(repo, sha)
        if graph:
            return graph
    graph = await store.analysis_graph(analysis_id)
    if graph and current:
        _write_l1(repo, sha, graph)
    return graph


@asynccontextmanager
async def lifespan(app: FastAPI):
    global store, worker
    config.validate_config()
    _check_grammar_cache()
    _log_allowed_origins(config.ALLOWED_ORIGINS)
    store = await _open_store()
    if store.kind == "postgres":
        auth.runtime.auth = auth_store.AuthStore(store.pool)
        auth.runtime.load_graph = _graph_by_analysis
        auth.runtime.load_pr = store.pr_result
        if not (config.GITHUB_OAUTH_CLIENT_ID and config.GITHUB_OAUTH_CLIENT_SECRET and config.SESSION_SECRET):
            logger.warning("[auth] GitHub sign-in is not configured: analyses stay anonymous (per browser session)")
    else:
        logger.warning("[auth] no database: accounts are off and analyses are not access-controlled")
    # Jobs left running by a previous process are re-claimed once their lock expires
    worker = worker_mod.Worker(store, _run_pipeline)
    tasks = [asyncio.create_task(worker.run_forever()), asyncio.create_task(_maintenance_loop())]
    yield
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    auth.runtime.auth = None
    await store.close()

app = FastAPI(title="CodeGraph API", version="1.0.0", lifespan=lifespan)
Instrumentator().instrument(app).expose(app)

# Force wildcard CORS to ensure Vercel frontend can always connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "Authorization", "X-Admin-Key", "X-CodeGraph", "X-Share-Token"],
)
app.add_middleware(auth.CSRFMiddleware)
app.add_middleware(TimeoutMiddleware)
app.include_router(auth.router)
app.include_router(accounts.router)


# ---------------------------------------------------------------------------
# Exception Handlers
# ---------------------------------------------------------------------------
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"error": "Validation error", "detail": exc.errors()}
    )

@app.exception_handler(psycopg.Error)
@app.exception_handler(psycopg_pool.PoolTimeout)
async def storage_exception_handler(request: Request, exc: Exception):
    logger.error(f"[db] {type(exc).__name__} during {request.method} {request.url.path}: {exc}")
    return JSONResponse(status_code=503, content={"error": STORAGE_UNAVAILABLE, "detail": None})

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"[error] Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error", "detail": None}
    )


# ---------------------------------------------------------------------------
# Graph reads: L1 (/tmp) first, then the store (authoritative)
# ---------------------------------------------------------------------------
L1_STATS = {"writes": 0, "write_errors": 0, "last_error": None}


def _write_l1(repo: str, sha: str, graph: dict) -> None:
    """Refills the /tmp cache after a database read or a finished analysis (best effort)."""
    try:
        cache.write_cache(repo, sha, graph)
        L1_STATS["writes"] += 1
    except Exception as e:  # the L1 cache is optional
        L1_STATS["write_errors"] += 1
        L1_STATS["last_error"] = f"{type(e).__name__}: {str(e)[:200]}"
        logger.warning(f"[cache] L1 write failed for {repo}@{sha}: {type(e).__name__}: {e}")


async def _load_graph(repo: str, sha: str) -> dict | None:
    graph = cache.read_cache(repo, sha)
    if graph:
        return graph
    graph = await store.load_graph(repo, sha)
    if graph:
        _write_l1(repo, sha, graph)
    return graph


async def _job_graph(job: dict) -> dict | None:
    if job.get("graph"):  # memory store
        return job["graph"]
    repo, sha = job.get("repo"), job.get("commit_sha")
    current = bool(repo and sha) and job.get("schema_version") == GRAPH_SCHEMA_VERSION
    if current:
        graph = cache.read_cache(repo, sha)
        if graph:
            return graph
    graph = await store.analysis_graph(job.get("analysis_id"))
    if graph and current:
        _write_l1(repo, sha, graph)
    return graph


async def _latest_pr(owner: str, repo: str, number: int) -> dict | None:
    """The PR's current metadata (base/head commits), or None when GitHub cannot tell us quickly."""
    try:
        return await asyncio.wait_for(github_pr.fetch_pr_meta(owner, repo, number), timeout=10)
    except Exception as e:
        logger.info(f"[analyze] PR lookup failed for {owner}/{repo}#{number}: {type(e).__name__}")
        return None


async def _latest_commit(repo_url: str) -> tuple[str, str] | None:
    """(owner/repo, sha) of the default branch, or None when GitHub cannot tell us quickly."""
    try:
        return await asyncio.wait_for(ingestion.latest_commit(repo_url), timeout=10)
    except Exception as e:
        logger.info(f"[analyze] latest commit lookup failed for {repo_url}: {type(e).__name__}")
        return None


# ---------------------------------------------------------------------------
# Pipeline (run by the worker)
# ---------------------------------------------------------------------------
class PipelineFailure(Exception):
    """An expected failure with a message for the user (and an error_code for the frontend)."""

    def __init__(self, message: str, error_code: str | None = None):
        super().__init__(message)
        self.message = message
        self.error_code = error_code


async def _run_pipeline(job_id: str, repo_url: str) -> None:
    """Runs one job (a repository, or a pull request) and records the outcome in the store."""
    if github_pr.parse_pr_url(repo_url):
        await _run_pr_pipeline(job_id, repo_url)
        return
    handle = store.job_handle(job_id)
    try:
        outcome = await _pipeline(job_id, handle, repo_url)
    except PipelineFailure as f:
        await handle.close()
        await store.fail_job(job_id, f.message, f.error_code)
        return
    except asyncio.CancelledError:
        await handle.close()
        raise
    except Exception as e:
        logger.error(f"Pipeline failed critically: {e}", exc_info=True)
        await handle.close()
        await store.fail_job(job_id, f"Pipeline failed: {str(e)}")
        return
    await handle.close()
    if outcome is None:  # an existing analysis of this commit was reused
        return
    repo, sha, graph = outcome
    await store.complete_job(job_id, repo, sha, graph)
    _write_l1(repo, sha, graph)
    logger.info(f"Pipeline complete for {repo}")


async def _pipeline(job_id: str, handle, repo_url: str) -> tuple[str, str, dict] | None:
    """(repo, sha, graph), or None when the job finished on an existing analysis. Raises PipelineFailure."""
    # 1. Ingestion
    handle.set(status="running", stage="ingestion", progress=10, message="Fetching repo from GitHub...")
    logger.info(f"Starting ingestion for {repo_url}")
    try:
        ingestion_result = await ingestion.fetch_repo(repo_url)
    except RepoPrivateError:
        logger.warning(f"Private repository rejected: {repo_url}")
        raise PipelineFailure(RepoPrivateError.message, RepoPrivateError.error_code)
    except RepoNotFoundError:
        logger.warning(f"Repository not found or private: {repo_url}")
        raise PipelineFailure("Repository not found or is private")
    except FileLimitError as e:
        logger.warning(f"File limit error for {repo_url}: {e}")
        raise PipelineFailure(str(e), "file_limit")
    except NoSourceError as e:
        logger.warning(f"No supported source files in {repo_url}: {e}")
        raise PipelineFailure(str(e), NoSourceError.error_code)
    except Exception as e:
        logger.error(f"Ingestion failed for {repo_url}: {e}", exc_info=True)
        raise PipelineFailure(f"Ingestion failed: {str(e)}")

    repo = ingestion_result["repo"]
    sha = ingestion_result["commit_sha"]

    # 2. Already analysed (this commit, this graph schema)?
    if await store.resolve_commit(job_id, repo, sha):
        logger.info(f"Cache hit for {repo} @ {sha}")
        return None

    # 3–6. Parse, build, group, summarise, check
    def progress(step: str, fraction: float, message: str) -> None:
        handle.set(stage=step, progress=30 + int(65 * fraction), message=message)

    graph = await _build_graph(ingestion_result, progress)
    handle.set(stage="saving", progress=95, message="Saving analysis...")
    return repo, sha, graph


async def _build_graph(ingestion_result: dict, progress) -> dict:
    """
    Parse → graph → architecture → AI summaries → static analysis for one commit's files.
    progress(step, fraction 0–1, message). Raises PipelineFailure when parsing or building fails.
    """
    repo, sha = ingestion_result["repo"], ingestion_result["commit_sha"]
    source_files = {f["path"]: f["content"] for f in ingestion_result["files"]}

    # 3. Parsing
    logger.info(f"Starting parser for {repo} @ {sha}")
    progress("parsing", 0.0, "Parsing code structure...")
    try:
        parse_output = parser.parse_repo(ingestion_result)
    except Exception as e:
        logger.error(f"Parsing failed for {repo}: {e}", exc_info=True)
        raise PipelineFailure(f"Parsing failed: {str(e)}")

    # 4. Graph building
    logger.info(f"Starting graph builder for {repo}")
    progress("graph", 0.38, "Building knowledge graph...")
    try:
        graph = graph_builder.build_graph(parse_output)
    except Exception as e:
        logger.error(f"Graph build failed for {repo}: {e}", exc_info=True)
        raise PipelineFailure(f"Graph build failed: {str(e)}")

    # 4b. Architecture modules (deterministic; stored with the graph)
    try:
        graph["architecture"] = architecture.build_architecture(graph)
    except Exception as e:
        logger.warning(f"Architecture grouping failed (non-fatal) for {repo}: {e}")

    # 5. Enrichment
    logger.info(f"Starting enrichment for {repo}")
    progress("enrichment", 0.62, "Generating explanations...")
    try:
        def _on_enrich_progress(done: int, total: int) -> None:
            progress("enrichment", 0.62 + 0.3 * done / max(total, 1), f"Summarizing files {done}/{total}...")

        graph = await enrichment.enrich_graph(graph, on_progress=_on_enrich_progress)
    except Exception as e:
        logger.warning(f"Enrichment failed (non-fatal) for {repo}: {e}")
        # Non-fatal, continue with un-enriched graph

    # 6. Static analysis
    try:
        import analyzer
        analysis = analyzer.analyze_repo(parse_output, source_files, graph)
        # Merge analysis results onto graph nodes (severity badges)
        for node in graph["nodes"]:
            file_analysis = analysis["by_file"].get(node.get("file", ""), {})
            node["issue_count"] = file_analysis.get("issue_count", 0)
            node["issue_severity"] = file_analysis.get("severity", None)
        graph["analysis"] = analysis  # stored with the graph
        logger.info(f"[analyzer] Score: {analysis['score']}{analysis['grade']}")
    except Exception as e:
        logger.warning(f"[analyzer] Analysis failed (non-fatal): {e}")
    return graph


# ---------------------------------------------------------------------------
# Pull request pipeline (run by the worker): PR → base and head graphs → impact
# ---------------------------------------------------------------------------
PR_NOT_FOUND = "Pull request not found. Check the link: CodeGraph reads public repositories only."


async def _run_pr_pipeline(job_id: str, pr_url: str) -> None:
    handle = store.job_handle(job_id)
    try:
        outcome = await _pr_pipeline(job_id, handle, pr_url)
    except PipelineFailure as f:
        await handle.close()
        await store.fail_job(job_id, f.message, f.error_code)
        return
    except asyncio.CancelledError:
        await handle.close()
        raise
    except Exception as e:
        logger.error(f"PR pipeline failed critically: {e}", exc_info=True)
        await handle.close()
        await store.fail_job(job_id, f"Pull request analysis failed: {str(e)}")
        return
    await handle.close()
    if outcome is None:  # this PR at these commits was analysed before
        return
    meta, base_id, head_id, result = outcome
    await store.complete_pr_job(job_id, meta, base_id, head_id, result)
    logger.info(f"PR analysis complete for {meta['full_name']}#{meta['number']}")


async def _ensure_analysis(owner: str, repo: str, sha: str, handle, stage: str, lo: int, hi: int, label: str):
    """(analysis id, graph, reused) for owner/repo@sha: a stored analysis, or one built now."""
    full, sha8 = f"{owner}/{repo}", sha[:8]
    handle.set(stage=stage, progress=lo, message=f"{label}…")
    existing = await store.find_done_analysis(full, sha8)
    if existing is not None:
        graph = cache.read_cache(full, sha8) or await store.analysis_graph(existing)
        if graph:
            _write_l1(full, sha8, graph)
            return existing, graph, True
    try:
        ingested = await ingestion.fetch_repo_at(owner, repo, sha)
    except FileLimitError as e:
        raise PipelineFailure(f"The {stage} commit ({sha8}) is too large to analyse: {e}", "pr_too_large")
    except NoSourceError as e:
        raise PipelineFailure(f"The {stage} commit ({sha8}) has no source files CodeGraph can read. {e}", NoSourceError.error_code)
    except Exception as e:
        logger.error(f"Fetching {full}@{sha8} failed: {e}", exc_info=True)
        raise PipelineFailure(f"Couldn't fetch the {stage} commit from GitHub: {e}")

    def progress(step: str, fraction: float, message: str) -> None:
        handle.set(stage=stage, progress=lo + int((hi - lo) * fraction), message=f"{label}: {message[0].lower()}{message[1:]}")

    graph = await _build_graph(ingested, progress)
    analysis_id = await store.save_analysis(full, sha8, graph)
    _write_l1(full, sha8, graph)
    return analysis_id, graph, False


MAX_SOURCE_FILES = 80  # files fetched at each commit to tell code changes from docs/format ones


async def _pr_sources(meta: dict, files: list[dict], base_graph: dict, head_graph: dict) -> dict:
    """
    {"base": {path: text}, "head": {path: text}} for the PR's modified/renamed source files in
    the graphs. Best effort: a file that can't be fetched stays "modified" (never under-reported).
    """
    graph_files = lambda g: {n["id"] for n in g.get("nodes", []) if n.get("type") == "file"}  # noqa: E731
    base_files, head_files = graph_files(base_graph), graph_files(head_graph)
    edited = [f for f in files if f.get("status") in ("modified", "renamed", "changed")]
    want_base = [p for p in ((f.get("previous_filename") or f["filename"]) for f in edited) if p in base_files][:MAX_SOURCE_FILES]
    want_head = [f["filename"] for f in edited if f["filename"] in head_files][:MAX_SOURCE_FILES]
    head_owner, head_repo = meta["head_repo"].split("/", 1)
    try:
        async with httpx.AsyncClient(headers=ingestion._github_headers(), follow_redirects=True, timeout=ingestion.HTTP_TIMEOUT) as client:
            base_rows, head_rows = await asyncio.gather(
                ingestion._fetch_file_contents(meta["owner"], meta["repo"], meta["base_sha"], [{"path": p} for p in want_base], client),
                ingestion._fetch_file_contents(head_owner, head_repo, meta["head_sha"], [{"path": p} for p in want_head], client),
            )
    except Exception as e:
        logger.warning(f"[pr] source fetch failed: {type(e).__name__}")
        return {}
    return {"base": {r["path"]: r["content"] for r in base_rows}, "head": {r["path"]: r["content"] for r in head_rows}}


async def _pr_pipeline(job_id: str, handle, url: str):
    """(meta, base analysis id, head analysis id, result), or None when a stored result was reused."""
    owner, repo, number = github_pr.parse_pr_url(url)
    started = time.monotonic()
    handle.set(status="running", stage="fetch_pr", progress=5, message="Fetching PR")
    try:
        pr = await github_pr.fetch_pr(owner, repo, number)
    except RepoPrivateError:
        raise PipelineFailure(RepoPrivateError.message, RepoPrivateError.error_code)
    except (RepoNotFoundError, github_pr.PRNotFoundError):
        raise PipelineFailure(PR_NOT_FOUND, "pr_not_found")
    except Exception as e:
        logger.error(f"Fetching PR {owner}/{repo}#{number} failed: {e}", exc_info=True)
        raise PipelineFailure(f"Couldn't read the pull request from GitHub: {e}")
    meta = pr["meta"]
    if await store.resolve_pr(job_id, meta):
        logger.info(f"PR {owner}/{repo}#{number} already analysed at these commits")
        return None

    head_owner, head_repo = meta["head_repo"].split("/", 1)
    base_id, base_graph, base_reused = await _ensure_analysis(owner, repo, meta["base_sha"], handle, "base", 10, 45, "Analyzing base")
    head_id, head_graph, head_reused = await _ensure_analysis(head_owner, head_repo, meta["head_sha"], handle, "head", 45, 80, "Analyzing head")

    handle.set(stage="mapping", progress=82, message="Mapping changes")
    sources = await _pr_sources(meta, pr["files"], base_graph, head_graph)
    result = pr_impact.analyse(meta, pr["files"], base_graph, head_graph, pr["truncated"], sources)
    handle.set(stage="scoring", progress=88, message="Scoring")
    handle.set(stage="summary", progress=92, message="Summarizing")
    result = await pr_impact.summarise(result)
    result["timing"] = {
        "seconds": round(time.monotonic() - started, 1),
        "base_reused": base_reused,
        "head_reused": head_reused,
    }
    return meta, base_id, head_id, result


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/")
async def root():
    return {
        "name": "CodeGraph API",
        "version": "1.0.0",
        "docs": "/docs",
        "health": "/health"
    }

@app.post("/analyze")
async def analyze(request: Request, body: AnalyzeRequest):
    if not body.repo_url or not body.repo_url.strip():
        raise HTTPException(status_code=422, detail="repo_url cannot be empty")

    ip = _client_ip(request)
    pr_ref = github_pr.parse_pr_url(body.repo_url)
    if pr_ref and store.kind != "postgres":
        return JSONResponse(status_code=503, content={
            "error": "Pull request analysis isn't available on this server (it needs the database).",
            "error_code": "pr_unavailable", "detail": None,
        })
    session = await auth.ensure_session(request)  # anonymous session on a first visit

    # Rate limiting: analyses started per hour (signed in: per user; anonymous: per session and IP)
    if auth.access_control_enabled():
        if auth.signed_in(session):
            limit, keys = config.ANALYZE_LIMIT_SIGNED_IN, [f"analyze:user:{session['user_id']}"]
        else:
            limit = config.ANALYZE_LIMIT_PER_HOUR
            keys = [f"analyze:session:{session['id']}", f"analyze:ip:{store_mod.hash_ip(ip)}"]
        wait_s = await auth.runtime.auth.rate_hit(keys, limit, timedelta(hours=1))
    else:
        limit = config.ANALYZE_LIMIT_PER_HOUR
        now = datetime.now(timezone.utc)
        recent = [t for t in analyze_counts.get(ip, []) if t > now - timedelta(hours=1)]
        wait_s = None
        if len(recent) >= limit:
            wait_s = (recent[0] + timedelta(hours=1) - now).total_seconds()
        else:
            recent.append(now)
        analyze_counts[ip] = recent
    if wait_s is not None:
        wait_min = max(1, int(wait_s // 60) + 1)
        return auth.attach_new_session(request, JSONResponse(
            status_code=429,
            content={
                "error": (
                    f"You've started {limit} analyses in the last hour. "
                    f"Try again in {wait_min} minute{'s' if wait_min != 1 else ''}."
                ),
                "error_code": "rate_limited",
                "detail": None,
            },
        ))

    # Rate limiting: max 5 active jobs per IP
    if await store.active_jobs_for_ip(ip) >= 5:
        return auth.attach_new_session(request, JSONResponse(
            status_code=429,
            content={
                "error": "Too many active jobs from this IP. Wait for existing jobs to complete.",
                "detail": None
            }
        ))

    if pr_ref:
        return await _analyze_pr(request, session, ip, *pr_ref)

    # Latest commit already analysed with this graph schema: a job that is done straight away
    status = "queued"
    job_id = None
    latest = await _latest_commit(body.repo_url)
    if latest:
        analysis_id = await store.find_done_analysis(*latest)
        if analysis_id is not None:
            job_id = await store.create_done_job(body.repo_url, ip, analysis_id)
            status = "done"
            logger.info(f"[analyze] {latest[0]}@{latest[1]} already analysed: job {job_id} done")
    if job_id is None:
        job_id = await store.create_job(body.repo_url, ip)
        if worker:
            worker.wake()

    # The analysis is private to this session (or user)
    user_analysis_id = None
    if auth.access_control_enabled():
        job = await store.get_job(job_id)
        user_analysis_id = await auth.runtime.auth.add_user_analysis(session, job["analysis_id"], job_id)
    return auth.attach_new_session(request, JSONResponse(
        {"job_id": job_id, "status": status, "kind": "repo", "user_analysis_id": user_analysis_id}
    ))


async def _analyze_pr(request: Request, session, ip: str, owner: str, repo: str, number: int):
    """A PR job: done at once when this PR at its current commits was analysed before."""
    url = github_pr.pr_url(owner, repo, number)
    status, job_id = "queued", None
    meta = await _latest_pr(owner, repo, number)
    if meta:
        existing = await store.find_done_pr(meta["full_name"], number, meta["base_sha"][:8], meta["head_sha"][:8])
        if existing is not None:
            job_id = await store.create_done_pr_job(url, ip, existing)
            status = "done"
    if job_id is None:
        job_id = await store.create_pr_job(url, ip, f"{owner}/{repo}", number)
        if worker:
            worker.wake()
    user_analysis_id = None
    if auth.access_control_enabled():
        job = await store.get_job(job_id)
        user_analysis_id = await auth.runtime.auth.add_user_analysis(session, None, job_id, pr_analysis_id=job["pr_analysis_id"])
    return auth.attach_new_session(request, JSONResponse({
        "job_id": job_id, "status": status, "kind": "pr", "user_analysis_id": user_analysis_id,
        "pr": {"owner": owner, "repo": repo, "number": number},
    }))


async def _viewable_job(request: Request, job_id: str):
    """(job, None) when the caller may see this job, else (None, error response)."""
    job = await store.get_job(job_id)
    if auth.access_control_enabled():
        if not job:
            return None, auth.private_response()
        if job.get("kind") == "pr":
            allowed = await auth.can_view_pr(request, job.get("pr_analysis_id"))
        else:
            allowed = await auth.can_view_analysis(request, job.get("analysis_id"))
        if not allowed:
            return None, auth.private_response()
    elif not job:
        return None, JSONResponse(status_code=404, content={"error": "Job not found", "detail": None})
    return job, None


async def _commit_graph(request: Request, owner: str, repo: str, commit_sha: str):
    """(graph, None) for repo@sha when the caller may read it, else (None, error response)."""
    if not auth.access_control_enabled():
        return await _load_graph(f"{owner}/{repo}", commit_sha), None
    found = await auth.commit_analysis(request, f"{owner}/{repo}", commit_sha)
    graph = None
    if found:
        graph = await _graph_by_analysis(found["id"], found["repo"], found["commit_sha"], found["schema_version"])
    if not graph:
        return None, auth.private_response()
    return graph, None


def _job_event(job: dict) -> dict:
    return {
        "job_id": job.get("job_id"),
        "status": job.get("status"),
        "progress": job.get("progress"),
        "stage": job.get("stage"),
        "message": job.get("message"),
        "error": job.get("error"),
        "error_code": job.get("error_code"),
    }


@app.get("/jobs/{job_id}")
async def get_job(job_id: str, request: Request):
    _job, denied = await _viewable_job(request, job_id)
    if denied:
        return denied

    async def event_generator():
        while True:
            try:
                job = await store.get_job(job_id)
            except (psycopg.Error, psycopg_pool.PoolTimeout) as e:
                # A database blip should not end the stream: try again on the next tick
                logger.warning(f"[jobs] poll failed for {job_id}: {type(e).__name__}")
                await asyncio.sleep(SSE_POLL_SECONDS)
                continue
            if not job:
                break
            yield f"data: {json.dumps(_job_event(job))}\n\n"
            if job.get("status") in ("done", "error"):
                break
            await asyncio.sleep(SSE_POLL_SECONDS)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
            "Transfer-Encoding": "chunked"
        }
    )


@app.get("/graph/{job_id}", response_model=GraphResponse)
async def get_graph(job_id: str, request: Request):
    job, denied = await _viewable_job(request, job_id)
    if denied:
        return denied

    if job.get("status") != "done":
        return JSONResponse(
            status_code=202,
            content={"status": job.get("status"), "message": "Analysis still in progress"}
        )

    graph = await _job_graph(job)
    if not graph:
        return JSONResponse(
            status_code=500,
            content={"error": "Graph data missing, re-run analysis", "detail": None}
        )

    # Private data: never stored by the CDN (the /api rewrite) or other shared caches
    return JSONResponse(
        status_code=200,
        content=graph,
        headers={"Cache-Control": "private, max-age=3600"}
    )


@app.get("/analysis/{job_id}")
async def get_analysis(job_id: str, request: Request):
    job, denied = await _viewable_job(request, job_id)
    if denied:
        return denied

    if job.get("status") != "done":
        return JSONResponse(
            status_code=202,
            content={"status": job.get("status"), "message": "Analysis still in progress"}
        )

    analysis = job.get("analysis") or ((await _job_graph(job)) or {}).get("analysis")
    if analysis is None:
        return JSONResponse(
            status_code=404,
            content={"error": "Analysis data missing or failed", "detail": None}
        )

    return JSONResponse(
        status_code=200,
        content=analysis
    )


@app.get("/pr/{job_id}")
async def get_pr_result(job_id: str, request: Request):
    """A PR analysis result (owner, or a share token for it)."""
    job, denied = await _viewable_job(request, job_id)
    if denied:
        return denied
    if job.get("kind") != "pr":
        return JSONResponse(status_code=404, content={"error": "Not a pull request analysis", "detail": None})
    if job.get("status") != "done":
        return JSONResponse(status_code=202, content={"status": job.get("status"), "message": "Analysis still in progress"})
    result = await store.pr_result(job.get("pr_analysis_id"))
    if not result:
        return JSONResponse(status_code=500, content={"error": "PR result missing, run the analysis again", "detail": None})
    return JSONResponse({**result, "job_id": job_id}, headers={"Cache-Control": "private, no-store"})


@app.get("/pr/{job_id}/graph/{side}")
async def get_pr_graph(job_id: str, side: str, request: Request):
    """The full base or head graph of a PR analysis ("show full graph")."""
    if side not in ("base", "head"):
        return JSONResponse(status_code=404, content={"error": "Not found", "detail": None})
    job, denied = await _viewable_job(request, job_id)
    if denied:
        return denied
    if job.get("kind") != "pr" or job.get("status") != "done":
        return JSONResponse(status_code=404, content={"error": "Not found", "detail": None})
    row = await store.pr_row(job.get("pr_analysis_id"))
    analysis_id = row and row[f"{side}_analysis_id"]
    repo = row and (row["base_repo"] if side == "base" else row["head_repo_name"])
    graph = analysis_id and await _graph_by_analysis(analysis_id, repo, row[f"{side}_sha"], row[f"{side}_schema"])
    if not graph:
        return JSONResponse(status_code=404, content={"error": "This graph is no longer stored", "detail": None})
    return JSONResponse(graph, headers={"Cache-Control": "private, max-age=3600"})


@app.get("/source/{owner}/{repo}/{commit_sha}/{file_path:path}")
async def get_file_source(owner: str, repo: str, commit_sha: str, file_path: str, request: Request):
    """
    Raw source of one file of an analysed repo, fetched from GitHub. Only paths that are file
    nodes of the stored graph for that repo@sha are served: private repos are never analysed,
    so this cannot be used to read them (or any other file) through the server's token.
    """
    graph, denied = await _commit_graph(request, owner, repo, commit_sha)
    if denied:
        return denied
    if not graph:
        raise HTTPException(404, "File not found")
    node = next((n for n in graph.get("nodes", []) if n.get("type") == "file" and n.get("id") == file_path), None)
    if node is None:
        raise HTTPException(404, "File not found")
    url = f"https://raw.githubusercontent.com/{owner}/{repo}/{commit_sha}/{file_path}"
    async with httpx.AsyncClient(follow_redirects=True, timeout=ingestion.HTTP_TIMEOUT) as client:
        resp = await client.get(url)
        if resp.status_code != 200:
            raise HTTPException(404, "File not found")
        return JSONResponse({
            "path": file_path,
            "content": resp.text,
            "language": node.get("lang") or "python",
        })


@app.get("/chat/{owner}/{repo}/{commit_sha}/suggestions")
async def get_suggestions(owner: str, repo: str, commit_sha: str, request: Request):
    graph, denied = await _commit_graph(request, owner, repo, commit_sha)
    if denied:
        return denied
    if not graph:
        raise HTTPException(404, "Graph data not found in cache")
    return { "suggestions": chat.generate_suggestions(graph) }


@app.post("/chat/{owner}/{repo}/{commit_sha}")
async def chat_with_repo(owner: str, repo: str, commit_sha: str, request: Request):
    """
    Accepts a user question and conversation history.
    Returns a streamed AI response grounded in the repo's graph data.
    """
    graph, denied = await _commit_graph(request, owner, repo, commit_sha)
    if denied:
        return denied
    if not graph:
        raise HTTPException(404, "Graph data not found in cache. Please re-analyze the repo.")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON body")

    message = body.get("message")
    history = body.get("history", [])

    if not message:
        raise HTTPException(400, "Message cannot be empty")

    # Rate Limiting
    ip = request.headers.get("X-Forwarded-For")
    if not ip:
        ip = request.client.host if request.client else "unknown"
    else:
        ip = ip.split(",")[0].strip()

    rate_key = f"chat_{ip}"
    counts = chat_message_counts.get(rate_key, [])
    one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    counts = [t for t in counts if t > one_hour_ago]

    if len(counts) >= 20:
        chat_message_counts[rate_key] = counts
        raise HTTPException(429, "Chat limit reached. Max 20 messages per hour.")

    counts.append(datetime.now(timezone.utc))
    chat_message_counts[rate_key] = counts

    return StreamingResponse(
        chat.stream_chat_response(f"{owner}/{repo}", graph, message, history),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
        }
    )

@app.post("/impact/{owner}/{repo}/{commit_sha}")
async def analyze_impact(owner: str, repo: str, commit_sha: str, request: Request, body: ImpactRequest):
    """
    Given a changed file/function and blast radius data,
    returns a streaming LLM analysis of the impact.
    """
    graph, denied = await _commit_graph(request, owner, repo, commit_sha)
    if denied:
        return denied
    if not graph:
        raise HTTPException(404, "Graph data not found in cache")

    # Simple rate limit logic similar to chat
    ip = _client_ip(request)
    job_id = f"{owner}/{repo}@{commit_sha}"  # was undefined here: every request failed with a 500
    impact_key = f"impact_{ip}_{job_id}"
    counts = chat_message_counts.get(impact_key, [])
    one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    counts = [t for t in counts if t > one_hour_ago]

    if len(counts) >= 10:
        chat_message_counts[impact_key] = counts
        raise HTTPException(429, "Impact analysis limit reached. Max 10 requests per hour.")

    counts.append(datetime.now(timezone.utc))
    chat_message_counts[impact_key] = counts

    # Locate the node in graph
    source_node = None
    for n in graph.get("nodes", []):
        if n["id"] == body.source_node_id:
            source_node = n
            break

    if not source_node:
        raise HTTPException(404, f"Source node {body.source_node_id} not found in graph")

    return StreamingResponse(
        impact.stream_impact_analysis(
            job_id, graph, source_node, body.change_description, body.blast_radius
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
        }
    )


@app.get("/cache", response_model=list[dict])
async def get_cache(request: Request):
    _require_admin(request)
    return cache.list_cached()


@app.delete("/cache/{repo:path}")
async def delete_cache(repo: str, request: Request, commit_sha: str = None):
    _require_admin(request)
    if commit_sha:
        deleted = cache.invalidate_cache(repo, commit_sha)
        return {"deleted": deleted, "key": f"{repo}@{commit_sha}"}

    # Delete all entries for this repo
    all_cached = cache.list_cached()
    count = 0
    for entry in all_cached:
        if entry.get("repo") == repo:
            if cache.invalidate_cache(repo, entry.get("commit_sha")):
                count += 1

    return {"deleted": count, "repo": repo}


@app.get("/health")
async def health():
    db_status = "memory"
    queue = {"queued": 0, "running": 0}
    if store.kind == "postgres":
        db_status = "ok" if await store.ping() else "fail"
    if db_status != "fail":
        try:
            queue = await store.queue_stats()
        except Exception as e:
            logger.warning(f"[health] queue stats failed: {type(e).__name__}")
            db_status = "fail"
    return {
        "status": "ok" if db_status != "fail" else "degraded",
        "db": db_status,
        "queue_depth": queue["queued"],
        "active_jobs": queue["queued"] + queue["running"],
        "cache": {**cache.cache_stats(), "l1_writes": L1_STATS["writes"], "l1_write_errors": L1_STATS["write_errors"],
                  "l1_last_error": L1_STATS["last_error"]},
    }
