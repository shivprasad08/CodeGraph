# CodeGraph

CodeGraph is a full-stack AI-powered codebase visualizer. Paste any public GitHub repository URL into the website, and the system fetches every Python file, parses the entire codebase using AST analysis, builds a knowledge graph of every function, class, and dependency, enriches each node with a plain-English AI summary, and renders it as an interactive force-directed graph in the browser.

## Features

- **Interactive Force-Directed Graph**: WebGL-backed graph rendering handles 500+ nodes at 60fps, built on d3-force.
- **VSCode-Style File Tree**: Navigate the codebase intuitively. Click any file to highlight its nodes in the graph.
- **Code Inspector**: Syntax-highlighted source code viewer with clickable function names that seamlessly navigate the graph.
- **AI Chatbot**: Ask questions about the codebase in plain English, grounded directly in the graph data for accurate, hallucination-free answers.
- **Health Score Dashboard**: Static analysis panel showing an A-F grade, color-coded issues (red/yellow/green), security findings, dead code, and anti-pattern detection.
- **Directory Hull Clustering**: Nodes are grouped by top-level directory with colored convex hull backgrounds drawn behind each cluster.
- **Blast Radius Simulator**: Type "What if I change auth.py?" and the graph animates to show every affected node colored by impact severity. It provides an LLM-generated impact analysis and risk level (SAFE/CAUTION/RISKY/DANGEROUS).
- **Shareable URLs**: `/graph/owner/repo` always shows the latest cached graph for that repo. Share by link with no login required.

## Tech Stack

### Backend
- **FastAPI (Python)**: Async-native, automatic OpenAPI docs, Pydantic validation.
- **tree-sitter**: Deterministic AST parser, handles syntactically broken Python files without crashing.
- **networkx**: Out-of-the-box graph algorithms (in-degree centrality, topological sort, weakly connected components, cycle detection).
- **Groq API (llama-3.3-70b)**: Lightning-fast free-tier LLM inference (~500 tokens/sec).
- **Mistral API**: Fallback provider when Groq rate-limits (429) to ensure pipeline reliability.
- **httpx**: Async HTTP client for concurrent GitHub API calls with semaphore-based rate limiting.
- **Server-Sent Events (SSE)**: Real-time progress streaming to the frontend.
- **JSON File Cache**: Fast cache keyed by repo + commit SHA, resolving identical repos in <100ms.

### Frontend
- **React 18 + Vite**: Fast HMR in dev, tree-shakeable production builds.
- **react-force-graph**: WebGL force-directed graph simulation.
- **Tailwind CSS**: Utility-first styling with a custom dark theme.
- **highlight.js**: Lightweight syntax highlighting matching the CodeGraph palette.
- **React Router v6**: Shareable graph routing.
- **Graham Scan Convex Hull**: Implemented from scratch for directory cluster backgrounds.

## Pipeline Architecture

1. **Ingestion**: Fetches the GitHub repository's recursive file tree (up to a 60-file cap) and retrieves raw file contents concurrently.
2. **Parsing**: Uses `tree-sitter` to extract functions, classes, imports, and call sites, ignoring syntax errors in broken files.
3. **Graph Building**: Uses `networkx` to build nodes and edges (defines, calls, imports, contains), resolving callees across files and computing centrality metrics.
4. **LLM Enrichment**: Batches prompts per-file to reduce API calls. Groq generates plain-English summaries for each node.
5. **Cache & Serve**: The generated graph JSON is written atomically to disk. Future requests for the same commit load instantly from the cache.
6. **Static Analysis**: Runs non-fatally after enrichment to detect security issues, code quality concerns, and design patterns, ultimately generating a Health Score.

## Development

The project is split into a `frontend` and `backend` directory.

**Backend Setup:**
```bash
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

**Frontend Setup:**
```bash
cd frontend
npm install
npm run dev
```

## Deployment
- **Backend**: Deployed on Railway via a Procfile.
- **Frontend**: Deployed on Vercel with zero-config Vite deploy and SPA rewrites.
