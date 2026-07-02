# What it does: Tests for the FastAPI entry point
# Module 6: Backend/Frontend Integration Tests

import pytest
import asyncio
from httpx import AsyncClient, ASGITransport
from unittest.mock import patch

from main import app, jobs
from backend.ingestion import RepoNotFoundError


# ---------------------------------------------------------------------------
# Fixture for tests
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def reset_jobs():
    """Clear the in-memory jobs store before each test."""
    jobs.clear()


@pytest.fixture
def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# ---------------------------------------------------------------------------
# Tests for POST /analyze
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_analyze_valid_url(client):
    with patch("main.BackgroundTasks.add_task") as mock_add_task:
        response = await client.post("/analyze", json={"repo_url": "https://github.com/a/b"})
        assert response.status_code == 200
        data = response.json()
        assert "job_id" in data
        assert data["status"] == "queued"
        
        job_id = data["job_id"]
        assert job_id in jobs
        assert jobs[job_id]["status"] == "queued"
        
        mock_add_task.assert_called_once()


@pytest.mark.asyncio
async def test_analyze_missing_url(client):
    response = await client.post("/analyze", json={})
    assert response.status_code == 422
    assert "error" in response.json()


@pytest.mark.asyncio
async def test_analyze_rate_limit(client):
    # Insert 5 fake jobs for IP "testclient"
    for i in range(5):
        jobs[f"fake_{i}"] = {"status": "running", "ip": "testclient"}
    
    response = await client.post(
        "/analyze", 
        json={"repo_url": "https://github.com/a/b"},
        headers={"X-Forwarded-For": "testclient"}
    )
    assert response.status_code == 429
    assert "Too many active jobs" in response.json()["error"]


# ---------------------------------------------------------------------------
# Tests for GET /jobs/{job_id} (SSE)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_job_sse_done(client):
    # Mock _run_pipeline to immediately set status to "done"
    jobs["test-job"] = {
        "job_id": "test-job",
        "status": "queued",
        "progress": 0,
        "stage": "queued",
        "message": "Queued",
        "error": None
    }
    
    async def mock_run_pipeline(*args):
        jobs["test-job"]["status"] = "done"
        jobs["test-job"]["progress"] = 100
        jobs["test-job"]["stage"] = "done"

    with patch("main._run_pipeline", side_effect=mock_run_pipeline):
        # Fire off the pipeline artificially for the test
        await mock_run_pipeline()
        
        async with client.stream("GET", "/jobs/test-job") as response:
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")
            assert response.headers["cache-control"] == "no-cache"
            
            events = []
            async for line in response.aiter_lines():
                if line.startswith("data:"):
                    events.append(line)
            
            assert len(events) > 0
            last_event = events[-1]
            assert "done" in last_event
            assert "100" in last_event


@pytest.mark.asyncio
async def test_get_job_not_found(client):
    response = await client.get("/jobs/nonexistent")
    assert response.status_code == 404
    assert response.json()["error"] == "Job not found"


# ---------------------------------------------------------------------------
# Tests for GET /graph/{job_id}
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_graph_done(client):
    jobs["done-job"] = {
        "status": "done",
        "graph": {"repo": "a/b", "commit_sha": "123", "nodes": [], "edges": []}
    }
    response = await client.get("/graph/done-job")
    assert response.status_code == 200
    assert response.json()["repo"] == "a/b"
    assert "public" in response.headers["cache-control"]


@pytest.mark.asyncio
async def test_get_graph_running(client):
    jobs["running-job"] = {"status": "running"}
    response = await client.get("/graph/running-job")
    assert response.status_code == 202
    assert response.json()["status"] == "running"


# ---------------------------------------------------------------------------
# Tests for GET /health
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_health(client):
    with patch("backend.cache.cache_stats", return_value={"total_entries": 0}):
        response = await client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "active_jobs" in data


# ---------------------------------------------------------------------------
# Tests for _run_pipeline internals
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_run_pipeline_cache_hit():
    from main import _run_pipeline
    
    job_id = "cache-job"
    jobs[job_id] = {"status": "queued"}
    
    mock_ingestion = {"repo": "a/b", "commit_sha": "123"}
    mock_graph = {"nodes": [], "edges": []}
    
    with patch("backend.ingestion.fetch_repo", return_value=mock_ingestion), \
         patch("backend.cache.read_cache", return_value=mock_graph), \
         patch("backend.enrichment.enrich_graph") as mock_enrich:
        
        await _run_pipeline(job_id, "https://github.com/a/b")
        
        assert mock_enrich.call_count == 0
        assert jobs[job_id]["status"] == "done"
        assert jobs[job_id]["graph"] == mock_graph


@pytest.mark.asyncio
async def test_run_pipeline_enrichment_failure_is_non_fatal():
    from main import _run_pipeline
    
    job_id = "enrich-fail-job"
    jobs[job_id] = {"status": "queued"}
    
    mock_ingestion = {"repo": "a/b", "commit_sha": "123"}
    mock_parse = {"parsed": True}
    mock_graph = {"nodes": [], "edges": []}
    
    with patch("backend.ingestion.fetch_repo", return_value=mock_ingestion), \
         patch("backend.cache.read_cache", return_value=None), \
         patch("backend.parser.parse_repo", return_value=mock_parse), \
         patch("backend.graph_builder.build_graph", return_value=mock_graph, create=True), \
         patch("backend.enrichment.enrich_graph", side_effect=RuntimeError("LLM failed")), \
         patch("backend.cache.write_cache") as mock_write:
        
        await _run_pipeline(job_id, "https://github.com/a/b")
        
        assert jobs[job_id]["status"] == "done"
        assert jobs[job_id]["graph"] == mock_graph
        mock_write.assert_called_once()
