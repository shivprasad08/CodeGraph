# What it does: Pydantic models for request/response schemas
# Module: Setup

from pydantic import BaseModel
from typing import Literal, List, Optional

class AnalyzeRequest(BaseModel):
    repo_url: str

class JobStatus(BaseModel):
    job_id: str
    status: Literal["queued", "running", "done", "error"]
    progress: int
    message: str

class GraphNode(BaseModel):
    id: str
    label: str
    type: Literal["file", "function", "class"]
    file: str
    summary: str
    lines: List[int]

class GraphEdge(BaseModel):
    source: str
    target: str
    type: Literal["calls", "imports", "defines"]

class GraphResponse(BaseModel):
    repo: str
    commit_sha: str
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    schema_version: Optional[int] = None
    architecture: Optional[dict] = None  # modules, edges, method, hidden (architecture.py)

class ImpactRequest(BaseModel):
    source_node_id: str
    change_description: str
    blast_radius: dict
