# CodeGraph 🕸️

**CodeGraph** is an open-source, AI-powered tool that transforms any public GitHub repository into an interactive, 2D force-directed knowledge graph in seconds. 

By analyzing the Abstract Syntax Trees (AST) of the repository's source code and leveraging state-of-the-art Large Language Models, CodeGraph enables developers to instantly visualize and understand complex codebases.

## 🚀 Features

- **Interactive Dependency Visualization:** Explore codebases as a graph where nodes represent Files, Classes, and Functions, and edges represent relationships (`calls`, `defines`, `imports`, `contains`).
- **AI Code Summarization:** Automatically generates plain-English summaries for every function and class using **Groq (llama-3.3-70b)** and **Mistral AI**.
- **PageRank Centrality:** Automatically calculates node centrality using NetworkX to visually highlight the most important core functions (entry points and heavily utilized utilities).
- **Deep Syntax Parsing:** Uses `tree-sitter` for precise, multi-language structural code parsing (Python currently optimized).
- **Shareable Links:** Send your analyzed graph URL to your team for instant collaboration.

## 🛠️ Tech Stack

### Backend
- **Framework:** FastAPI (Python)
- **Code Parsing:** `tree-sitter`
- **Graph Processing:** NetworkX
- **AI Providers:** Groq API, Mistral API

### Frontend
- **Framework:** React + Vite
- **Styling:** TailwindCSS
- **Graph Renderer:** `react-force-graph-2d`

## ⚙️ Getting Started

### 1. Prerequisites
- Node.js (v18+)
- Python (3.11+)
- GitHub Personal Access Token
- Groq API Key
- Mistral API Key

### 2. Backend Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Create a `.env` file in the `backend/` directory:
```env
GITHUB_TOKEN=your_github_token
GROQ_API_KEY=your_groq_api_key
MISTRAL_API_KEY=your_mistral_api_key
MAX_FILES=60
CACHE_DIR=./cache
```

Start the backend server:
```bash
uvicorn main:app --reload --port 8000
```

### 3. Frontend Setup

```bash
cd frontend
npm install
```

Start the development server:
```bash
npm run dev
```

Navigate to `http://localhost:5173/` in your browser. Paste a GitHub repository URL and click **Analyze Repo**.

## 🧠 How it Works
1. **Ingestion:** Downloads the target repository structure from the GitHub API.
2. **Parsing:** Extracts functions, classes, docstrings, parameters, and dependencies using tree-sitter.
3. **Graph Building:** Constructs a directed graph of the entire repository ecosystem using NetworkX, identifying isolated entry points and calculating mathematical centrality for UI scaling.
4. **AI Enrichment:** Processes the abstract syntax data through Groq/Mistral to produce high-level human-readable summaries.
5. **Rendering:** Sends the heavily optimized payload via SSE (Server-Sent Events) to the React frontend, which simulates a force-directed d3 layout in HTML5 Canvas.

## 📝 License
This project is open-source and free to use.
