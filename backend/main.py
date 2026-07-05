# What it does: FastAPI routes, SSE progress stream, and background job runner
# Module 6: Backend/Frontend Integration (Hardened for Module 10)

import os
import uuid
import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, BackgroundTasks, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from contextlib import asynccontextmanager
from starlette.middleware.base import BaseHTTPMiddleware

import ingestion
import parser
import graph_builder
import enrichment
import cache
import config
import chat
import impact
from models import AnalyzeRequest, GraphResponse, ImpactRequest
from ingestion import RepoNotFoundError, FileLimitError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S"
)
logger = logging.getLogger("codegraph")

# ---------------------------------------------------------------------------
# In-memory job store
# ---------------------------------------------------------------------------
jobs: dict[str, dict] = {}
chat_message_counts: dict[str, list[datetime]] = {}

async def _cleanup_old_jobs():
    """Background task to remove jobs older than 1 hour every 10 minutes."""
    while True:
        try:
            now = datetime.now(timezone.utc)
            to_delete = []
            for j_id, j_data in jobs.items():
                created_at = j_data.get("created_at")
                if created_at and (now - created_at) > timedelta(hours=1):
                    to_delete.append(j_id)
            for j_id in to_delete:
                if "source_files" in jobs[j_id]:
                    del jobs[j_id]["source_files"]
                del jobs[j_id]
        except Exception as e:
            logger.error(f"[cleanup] Error cleaning old jobs: {e}")
        await asyncio.sleep(600)  # 10 minutes


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
@asynccontextmanager
async def lifespan(app: FastAPI):
    config.validate_config()
    task = asyncio.create_task(_cleanup_old_jobs())
    yield
    task.cancel()

app = FastAPI(title="CodeGraph API", version="1.0.0", lifespan=lifespan)

ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,http://127.0.0.1:3000"
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)
app.add_middleware(TimeoutMiddleware)


# ---------------------------------------------------------------------------
# Exception Handlers
# ---------------------------------------------------------------------------
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"error": "Validation error", "detail": exc.errors()}
    )

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"[error] Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error", "detail": None}
    )


# ---------------------------------------------------------------------------
# Pipeline Background Task
# ---------------------------------------------------------------------------
async def _run_pipeline(job_id: str, repo_url: str) -> None:
    """Runs the full analysis pipeline. Updates jobs[job_id] state."""
    job = jobs.get(job_id)
    if not job:
        return
    
    try:
        # 1. Ingestion
        job.update({
            "status": "running",
            "stage": "ingestion",
            "progress": 10,
            "message": "Fetching repo from GitHub..."
        })
        logger.info(f"Starting ingestion for {repo_url}")
        try:
            ingestion_result = await ingestion.fetch_repo(repo_url)
        except RepoNotFoundError:
            logger.warning(f"Repository not found or private: {repo_url}")
            job.update({"status": "error", "error": "Repository not found or is private"})
            return
        except FileLimitError as e:
            logger.warning(f"File limit error for {repo_url}: {e}")
            job.update({"status": "error", "error": str(e)})
            return
        except Exception as e:
            logger.error(f"Ingestion failed for {repo_url}: {e}", exc_info=True)
            job.update({"status": "error", "error": f"Ingestion failed: {str(e)}"})
            return

        repo = ingestion_result["repo"]
        sha = ingestion_result["commit_sha"]

        # Store raw file contents keyed by path for the /source endpoint
        job["source_files"] = {
            f["path"]: f["content"]
            for f in ingestion_result["files"]
        }

        # 3. Check Cache
        cached = cache.read_cache(repo, sha)
        if cached:
            logger.info(f"Cache hit for {repo} @ {sha}")
            job.update({
                "graph": cached,
                "analysis": cached.get("analysis"),
                "status": "done",
                "stage": "done",
                "progress": 100,
                "message": "Loaded from cache"
            })
            return

        # 4. Parsing
        logger.info(f"Starting parser for {repo} @ {sha}")
        job.update({
            "stage": "parsing",
            "progress": 30,
            "message": "Parsing code structure..."
        })
        try:
            parse_output = parser.parse_repo(ingestion_result)
        except Exception as e:
            logger.error(f"Parsing failed for {repo}: {e}", exc_info=True)
            job.update({"status": "error", "error": f"Parsing failed: {str(e)}"})
            return

        # 5. Graph building
        logger.info(f"Starting graph builder for {repo}")
        job.update({
            "stage": "graph",
            "progress": 55,
            "message": "Building knowledge graph..."
        })
        try:
            graph = graph_builder.build_graph(parse_output)
        except Exception as e:
            logger.error(f"Graph build failed for {repo}: {e}", exc_info=True)
            job.update({"status": "error", "error": f"Graph build failed: {str(e)}"})
            return

        # 6. Enrichment
        logger.info(f"Starting enrichment for {repo}")
        job.update({
            "stage": "enrichment",
            "progress": 70,
            "message": "Generating explanations..."
        })
        try:
            graph = await enrichment.enrich_graph(graph)
        except Exception as e:
            logger.warning(f"Enrichment failed (non-fatal) for {repo}: {e}")
            # Non-fatal, continue with un-enriched graph

        # Step 7: Static analysis
        try:
            import analyzer
            analysis = analyzer.analyze_repo(parse_output, job.get("source_files", {}), graph)
            # Merge analysis results onto graph nodes (severity badges)
            for node in graph["nodes"]:
                file_analysis = analysis["by_file"].get(node.get("file", ""), {})
                node["issue_count"] = file_analysis.get("issue_count", 0)
                node["issue_severity"] = file_analysis.get("severity", None)
            jobs[job_id]["analysis"] = analysis
            graph["analysis"] = analysis # Add it to graph so it gets cached
            logger.info(f"[analyzer] Score: {analysis['score']}{analysis['grade']}")
        except Exception as e:
            logger.warning(f"[analyzer] Analysis failed (non-fatal): {e}")
            jobs[job_id]["analysis"] = None

        # 8. Write Cache
        logger.info(f"Writing cache for {repo} @ {sha}")
        cache.write_cache(repo, sha, graph)

        # 8. Done
        logger.info(f"Pipeline complete for {repo}")
        job.update({
            "graph": graph,
            "status": "done",
            "stage": "done",
            "progress": 100,
            "message": "Analysis complete"
        })

    except Exception as e:
        logger.error(f"Pipeline failed critically: {e}", exc_info=True)
        job.update({"status": "error", "error": f"Pipeline failed: {str(e)}"})


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

@app.get("/repo/{owner}/{repo:path}/meta")
async def get_repo_meta(owner: str, repo: str):
    repo_full = f"{owner}/{repo}"
    cached_entries = cache.find_cached_by_repo(repo_full)
    if not cached_entries:
        return {"repo": repo_full, "cached": False}
    
    most_recent = cached_entries[0]
    graph = cache.read_cache(most_recent["repo"], most_recent["commit_sha"])
    if not graph:
        return {"repo": repo_full, "cached": False}
    
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    entry_points = [n["id"] for n in nodes if n.get("is_entry_point")]
    
    return {
        "repo": repo_full,
        "cached": True,
        "commit_sha": most_recent["commit_sha"],
        "cached_at": most_recent["cached_at"],
        "node_count": len(nodes),
        "edge_count": len(edges),
        "entry_points": entry_points
    }

@app.get("/repo/{owner}/{repo:path}")
async def get_or_analyze_repo(owner: str, repo: str, background_tasks: BackgroundTasks, request: Request):
    repo_full = f"{owner}/{repo}"
    
    cached_entries = cache.find_cached_by_repo(repo_full)
    if cached_entries:
        most_recent = cached_entries[0]
        graph = cache.read_cache(most_recent["repo"], most_recent["commit_sha"])
        if graph:
            return JSONResponse(
                content={
                    "status": "cached",
                    "graph": graph,
                    "cached_at": most_recent["cached_at"]
                },
                headers={"Cache-Control": "public, max-age=3600"}
            )
    
    job_id = str(uuid.uuid4())
    repo_url = f"https://github.com/{repo_full}"
    
    ip = request.headers.get("X-Forwarded-For")
    if not ip:
        ip = request.client.host if request.client else "unknown"
    else:
        ip = ip.split(",")[0].strip()
        
    jobs[job_id] = {
        "job_id": job_id,
        "repo_url": repo_url,
        "status": "queued",
        "progress": 0,
        "stage": "queued",
        "message": "Queued",
        "error": None,
        "graph": None,
        "ip": ip,
        "created_at": datetime.now(timezone.utc)
    }
    background_tasks.add_task(_run_pipeline, job_id, repo_url)
    
    return JSONResponse(
        content={
            "status": "analyzing",
            "job_id": job_id,
            "message": f"Starting analysis of {repo_full}..."
        },
        status_code=202
    )


@app.post("/analyze")
async def analyze(request: Request, body: AnalyzeRequest, background_tasks: BackgroundTasks):
    if not body.repo_url or not body.repo_url.strip():
        raise HTTPException(status_code=422, detail="repo_url cannot be empty")
    
    # Get request IP
    ip = request.headers.get("X-Forwarded-For")
    if not ip:
        ip = request.client.host if request.client else "unknown"
    else:
        ip = ip.split(",")[0].strip()

    # Rate limiting: max 5 active jobs per IP
    active_jobs = sum(
        1 for j in jobs.values() 
        if j.get("ip") == ip and j.get("status") in ("queued", "running")
    )
    if active_jobs >= 5:
        return JSONResponse(
            status_code=429,
            content={
                "error": "Too many active jobs from this IP. Wait for existing jobs to complete.",
                "detail": None
            }
        )

    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "job_id": job_id,
        "repo_url": body.repo_url,
        "status": "queued",
        "progress": 0,
        "stage": "queued",
        "message": "Queued",
        "error": None,
        "graph": None,
        "ip": ip,
        "created_at": datetime.now(timezone.utc)
    }

    background_tasks.add_task(_run_pipeline, job_id, body.repo_url)
    return {"job_id": job_id, "status": "queued"}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    if job_id not in jobs:
        return JSONResponse(status_code=404, content={"error": "Job not found", "detail": None})
    
    async def event_generator():
        last_status = None
        while True:
            job = jobs.get(job_id)
            if not job:
                break
            
            data = {
                "job_id": job["job_id"],
                "status": job["status"],
                "progress": job["progress"],
                "stage": job["stage"],
                "message": job["message"],
                "error": job["error"]
            }
            yield f"data: {json.dumps(data)}\n\n"

            if job["status"] in ("done", "error"):
                break
            
            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
            "Transfer-Encoding": "chunked"
        }
    )


@app.get("/graph/{job_id}", response_model=GraphResponse)
async def get_graph(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return JSONResponse(status_code=404, content={"error": "Job not found", "detail": None})
    
    if job["status"] != "done":
        return JSONResponse(
            status_code=202,
            content={"status": job["status"], "message": "Analysis still in progress"}
        )
    
    if not job.get("graph"):
        return JSONResponse(
            status_code=500,
            content={"error": "Graph data missing, re-run analysis", "detail": None}
        )
    
    return JSONResponse(
        status_code=200,
        content=job["graph"],
        headers={"Cache-Control": "public, max-age=3600"}
    )


@app.get("/analysis/{job_id}")
async def get_analysis(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return JSONResponse(status_code=404, content={"error": "Job not found", "detail": None})
    
    if job["status"] != "done":
        return JSONResponse(
            status_code=202,
            content={"status": job["status"], "message": "Analysis still in progress"}
        )
    
    if "analysis" not in job or job["analysis"] is None:
        return JSONResponse(
            status_code=404,
            content={"error": "Analysis data missing or failed", "detail": None}
        )
        
    return JSONResponse(
        status_code=200,
        content=job["analysis"]
    )


@app.get("/source/{job_id}/{file_path:path}")
async def get_file_source(job_id: str, file_path: str):
    """
    Returns the raw source content of a file from an analyzed job.
    File content is stored in the job's parse output during pipeline.
    """
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    
    job = jobs[job_id]
    if job["status"] != "done":
        raise HTTPException(202, "Analysis not complete")
    
    # Source is stored in job["source_files"]
    source_files = job.get("source_files", {})
    if file_path not in source_files:
        raise HTTPException(404, f"File not found: {file_path}")
    
    return JSONResponse({
        "path": file_path,
        "content": source_files[file_path],
        "language": "python"
    })


@app.get("/chat/{job_id}/suggestions")
async def get_suggestions(job_id: str):
    if job_id not in jobs or jobs[job_id]["status"] != "done":
        raise HTTPException(404, "Job not found or not complete")
    graph = jobs[job_id]["graph"]
    return { "suggestions": chat.generate_suggestions(graph) }


@app.post("/chat/{job_id}")
async def chat_with_repo(job_id: str, request: Request):
    """
    Accepts a user question and conversation history.
    Returns a streamed AI response grounded in the repo's graph data.
    """
    if job_id not in jobs or jobs[job_id]["status"] != "done":
        raise HTTPException(404, "Job not found or not complete")
        
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON body")
        
    message = body.get("message")
    history = body.get("history", [])
    
    if not message:
        raise HTTPException(400, "Message cannot be empty")
        
    # Rate Limiting
    counts = chat_message_counts.get(job_id, [])
    one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    counts = [t for t in counts if t > one_hour_ago]
    
    if len(counts) >= 20:
        chat_message_counts[job_id] = counts
        raise HTTPException(429, "Chat limit reached. Max 20 messages per hour.")
        
    counts.append(datetime.now(timezone.utc))
    chat_message_counts[job_id] = counts
    
    graph = jobs[job_id]["graph"]
    
    return StreamingResponse(
        chat.stream_chat_response(job_id, graph, message, history),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
        }
    )

@app.post("/impact/{job_id}")
async def analyze_impact(job_id: str, request: Request, body: ImpactRequest):
    """
    Given a changed file/function and blast radius data,
    returns a streaming LLM analysis of the impact.
    """
    if job_id not in jobs or jobs[job_id]["status"] != "done":
        raise HTTPException(404, "Job not found or not complete")
        
    graph = jobs[job_id]["graph"]
    
    # Simple rate limit logic similar to chat
    ip = request.headers.get("X-Forwarded-For")
    if not ip:
        ip = request.client.host if request.client else "unknown"
    else:
        ip = ip.split(",")[0].strip()
        
    # Reuse chat counts or use separate impact counts
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
async def get_cache():
    return cache.list_cached()


@app.delete("/cache/{repo:path}")
async def delete_cache(repo: str, commit_sha: str = None):
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
    active_jobs = sum(
        1 for j in jobs.values() 
        if j.get("status") in ("queued", "running")
    )
    return {
        "status": "ok",
        "cache": cache.cache_stats(),
        "active_jobs": active_jobs
    }
