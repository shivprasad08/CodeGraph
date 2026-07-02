import json
import logging
from groq import AsyncGroq, RateLimitError
from config import GROQ_API_KEY

logger = logging.getLogger(__name__)

# Initialize Groq client
if GROQ_API_KEY:
    groq_client = AsyncGroq(api_key=GROQ_API_KEY)
else:
    groq_client = None

def build_system_prompt(job_id: str, graph: dict) -> str:
    """
    Builds the grounding context from graph data.
    This is injected as the system message.
    """
    repo = graph.get("repo", "unknown/repo")
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    
    # File list with function/class inventory
    file_summaries = []
    file_nodes = [n for n in nodes if n.get("type") == "file"]
    
    # Cap at 40 files to stay within reasonable context window
    for fn in file_nodes[:40]:   
        path = fn["id"]
        children = [
            n for n in nodes 
            if n.get("file") == path and n.get("type") in ("function", "class")
        ]
        
        # Sort children by line number if possible
        children.sort(key=lambda x: (x.get("lines") or [0])[0])
        
        child_lines = []
        for c in children:
            summary = f" — {c['summary']}" if c.get("summary") else ""
            prefix = "def" if c['type'] == "function" else "class"
            child_lines.append(f"    {prefix} {c['label']}{summary}")
        
        file_summaries.append(f"  {path}\n" + "\n".join(child_lines))
    
    # Entry points
    entry_points = [
        n for n in nodes if n.get("is_entry_point") and n.get("type") != "file"
    ]
    entry_point_lines = [
        f"  {n['id']}: {n.get('summary', '')}" for n in entry_points[:10]
    ]
    
    # Key relationships (most important call edges)
    call_edges = [e for e in edges if e.get("type") == "calls"][:50]
    edge_lines = [
        f"  {e['source']} → {e['target']}" for e in call_edges
    ]
    
    # Construct the final prompt
    prompt = f"""You are an expert software engineer helping a developer understand 
the codebase of the GitHub repository: {repo}

You have been given a structured analysis of this repository including every 
file, function, class, and their relationships.

REPOSITORY STRUCTURE:
{chr(10).join(file_summaries)}

ENTRY POINTS (most important functions/classes):
{chr(10).join(entry_point_lines)}

KEY CALL RELATIONSHIPS:
{chr(10).join(edge_lines)}

RULES — follow these exactly:
1. Only reference files, functions, and classes that exist in the structure above.
   Never invent names.
2. When answering, cite specific node ids like `src/auth.py::verify_token`
   — wrap them in backticks. The frontend will make them clickable.
3. If you're unsure which file handles something, say so and suggest 
   the most likely candidates based on the structure.
4. Keep answers concise — 3-6 sentences unless a longer explanation is needed.
5. If asked for code, you may quote short snippets but remind the user 
   to check the Code Inspector for the full implementation.
6. End every answer with a "References:" section listing the node ids
   you explicitly mentioned, one per line, prefixed with NODE:
   Example:
   References:
   NODE: src/auth.py::verify_token
   NODE: src/auth.py::TokenVerifier
   The frontend parses these to highlight nodes on the graph.
"""
    return prompt

def generate_suggestions(graph: dict) -> list[str]:
    nodes = graph.get("nodes", [])
    entry_points = [n for n in nodes if n.get("is_entry_point") and n.get("type") != "file"][:3]
    file_nodes = [n for n in nodes if n.get("type") == "file"]
    
    suggestions = [
        "Explain the overall architecture of this project",
        "What are the entry points and how do they connect?",
    ]
    
    if entry_points:
        ep = entry_points[0]
        label = ep.get("label", ep["id"])
        suggestions.append(f"What does `{label}` do and what calls it?")
    
    if len(file_nodes) > 3:
        f1 = file_nodes[0]["id"].split("/")[-1]
        f2 = file_nodes[1]["id"].split("/")[-1]
        suggestions.append(f"How does `{f1}` relate to `{f2}`?")
    
    return suggestions[:4]

async def stream_chat_response(job_id: str, graph: dict, message: str, history: list[dict]):
    """
    Streams the Groq response as SSE events.
    Yields strings in SSE format.
    """
    if not groq_client:
        yield f"data: {json.dumps({'token': 'Error: Groq API key not configured.', 'done': True, 'nodes': []})}\n\n"
        return
        
    system_prompt = build_system_prompt(job_id, graph)
    
    # Cap history to last 3 exchanges (6 messages)
    history_capped = history[-6:]
    
    messages = [
        {"role": "system", "content": system_prompt},
        *history_capped,
        {"role": "user", "content": message}
    ]
    
    full_response = ""
    
    try:
        stream = await groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=messages,
            max_tokens=600,
            temperature=0.3,    # low temperature = more factual, less creative
            stream=True
        )
        
        async for chunk in stream:
            token = chunk.choices[0].delta.content or ""
            if token:
                full_response += token
                yield f"data: {json.dumps({'token': token, 'done': False})}\n\n"
        
        # Parse NODE: references from the complete response
        referenced_nodes = []
        for line in full_response.split("\n"):
            line = line.strip()
            if line.startswith("NODE:"):
                node_id = line[5:].strip()
                # Validate: node must actually exist in the graph
                if any(n["id"] == node_id for n in graph.get("nodes", [])):
                    referenced_nodes.append(node_id)
        
        yield f"data: {json.dumps({'token': '', 'done': True, 'nodes': referenced_nodes})}\n\n"
        
    except RateLimitError:
        error_data = {'token': '\n\n**Rate limit hit.** Please wait a moment and try again.', 'done': True, 'nodes': []}
        yield f"data: {json.dumps(error_data)}\n\n"
    
    except Exception as e:
        logger.error(f"Chat error: {e}")
        error_msg = f'\n\n**Sorry, I encountered an error:** {str(e)}'
        error_data = {'token': error_msg, 'done': True, 'nodes': []}
        yield f"data: {json.dumps(error_data)}\n\n"
