import asyncio
import json
import logging
import re
from collections import Counter
from groq import AsyncGroq
from mistralai.client.sdk import Mistral
from config import GROQ_API_KEY, MISTRAL_API_KEY, GROQ_CHAT_MODEL, MISTRAL_MODEL

logger = logging.getLogger(__name__)

# Initialize LLM clients
if GROQ_API_KEY:
    groq_client = AsyncGroq(api_key=GROQ_API_KEY)
else:
    groq_client = None

if MISTRAL_API_KEY:
    mistral_client = Mistral(api_key=MISTRAL_API_KEY)
else:
    mistral_client = None

# Prompt budget: ~3,000 tokens at ~4 chars/token
MAX_PROMPT_CHARS = 12_000
MAX_CHILDREN_PER_FILE = 8
MAX_ENTRY_POINTS = 10
MAX_CALL_EDGES = 25

FIRST_TOKEN_TIMEOUT_S = 30
CHAT_MAX_TOKENS = 600
BUSY_MESSAGE = "The AI is busy right now — try again in a minute."


def _node_degrees(edges: list[dict]) -> Counter:
    """Counts the edges where each node id is the source or the target."""
    degrees: Counter = Counter()
    for edge in edges:
        degrees[edge.get("source")] += 1
        degrees[edge.get("target")] += 1
    return degrees


def build_system_prompt(job_id: str, graph: dict) -> str:
    """
    Builds the grounding context from graph data.
    This is injected as the system message. Kept under MAX_PROMPT_CHARS.
    """
    repo = graph.get("repo", "unknown/repo")
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    degrees = _node_degrees(edges)

    children_by_file: dict[str, list[dict]] = {}
    for n in nodes:
        if n.get("type") in ("function", "class"):
            children_by_file.setdefault(n.get("file"), []).append(n)

    # File list: every file, with only its most-connected children
    file_sections = []  # (weight, text)
    for fn in (n for n in nodes if n.get("type") == "file"):
        path = fn["id"]
        children = sorted(
            children_by_file.get(path, []), key=lambda c: -degrees[c["id"]]
        )
        child_lines = []
        for c in children[:MAX_CHILDREN_PER_FILE]:
            summary = f" — {c['summary']}" if c.get("summary") else ""
            prefix = "def" if c["type"] == "function" else "class"
            child_lines.append(f"    {prefix} {c['label']}{summary}")
        if len(children) > MAX_CHILDREN_PER_FILE:
            child_lines.append(f"    ...and {len(children) - MAX_CHILDREN_PER_FILE} more")
        weight = degrees[path] + sum(degrees[c["id"]] for c in children)
        file_sections.append((weight, "\n".join([f"  {path}", *child_lines])))

    # Entry points
    entry_points = [
        n for n in nodes if n.get("is_entry_point") and n.get("type") != "file"
    ]
    entry_point_lines = [
        f"  {n['id']}: {n.get('summary', '')}" for n in entry_points[:MAX_ENTRY_POINTS]
    ]

    # Key relationships: call edges between the most-connected nodes
    call_edges = sorted(
        (e for e in edges if e.get("type") == "calls"),
        key=lambda e: -(degrees[e["source"]] + degrees[e["target"]]),
    )[:MAX_CALL_EDGES]
    edge_lines = [f"  {e['source']} → {e['target']}" for e in call_edges]

    def render(sections: list[str], omitted: int) -> str:
        structure = "\n".join(sections)
        if omitted:
            structure += f"\n  ...and {omitted} more files (omitted for length)"
        return f"""You are an expert software engineer helping a developer understand
the codebase of the GitHub repository: {repo}

You have been given a structured analysis of this repository including its
files, their most-connected functions and classes, and key relationships.

REPOSITORY STRUCTURE:
{structure}

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

    # Drop the lowest-weight file sections until the prompt fits the budget
    kept = list(range(len(file_sections)))
    drop_order = sorted(kept, key=lambda i: file_sections[i][0])
    prompt = render([s for _, s in file_sections], 0)
    while len(prompt) > MAX_PROMPT_CHARS and drop_order:
        kept.remove(drop_order.pop(0))
        prompt = render(
            [file_sections[i][1] for i in kept], len(file_sections) - len(kept)
        )
    return prompt[:MAX_PROMPT_CHARS]


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


async def _groq_tokens(messages: list[dict]):
    stream = await groq_client.chat.completions.create(
        model=GROQ_CHAT_MODEL,
        messages=messages,
        max_tokens=CHAT_MAX_TOKENS,
        temperature=0.3,    # low temperature = more factual, less creative
        stream=True,
        # gpt-oss models reason first; keep reasoning from eating max_tokens.
        # Sent via extra_body (groq SDK 0.9.0 has no reasoning_effort kwarg),
        # and only for gpt-oss, since other models reject the parameter.
        **(
            {"extra_body": {"reasoning_effort": "low"}}
            if "gpt-oss" in GROQ_CHAT_MODEL
            else {}
        ),
    )
    got_content = False
    async for chunk in stream:
        token = chunk.choices[0].delta.content or ""
        if token:
            got_content = True
            yield token
    if not got_content:
        raise RuntimeError("Groq returned empty content")


async def _mistral_tokens(messages: list[dict]):
    stream = await mistral_client.chat.stream_async(
        model=MISTRAL_MODEL,
        messages=messages,
        max_tokens=CHAT_MAX_TOKENS,
        temperature=0.3,
    )
    async for event in stream:
        token = event.data.choices[0].delta.content
        if isinstance(token, str) and token:
            yield token


MAX_REFERENCED_NODES = 10

# "NODE: <id>" lines (optionally prefixed by "-", "*" or whitespace), or
# backticked ids like `src/auth.py::verify_token` anywhere in the text.
_NODE_REF_RE = re.compile(
    r"^[ \t*-]*NODE:[ \t]*(?P<line>[^\n]+?)[ \t]*$"
    r"|`(?P<tick>[^`\s]+\.py::[^`\s]+)`",
    re.MULTILINE,
)


def _referenced_nodes(full_response: str, graph: dict) -> list[str]:
    """
    Parses node references in order of appearance, keeping only ids that
    exist in the graph. Deduped and capped at MAX_REFERENCED_NODES.
    """
    node_ids = {n["id"] for n in graph.get("nodes", [])}
    referenced = []
    seen = set()
    for match in _NODE_REF_RE.finditer(full_response):
        node_id = (match.group("line") or match.group("tick")).strip(" \t\r`")
        if node_id in node_ids and node_id not in seen:
            seen.add(node_id)
            referenced.append(node_id)
            if len(referenced) >= MAX_REFERENCED_NODES:
                break
    return referenced


async def stream_chat_response(job_id: str, graph: dict, message: str, history: list[dict]):
    """
    Streams the chat response as SSE events: Groq first, then Mistral if
    Groq fails before streaming any token.
    Yields strings in SSE format.
    """
    system_prompt = build_system_prompt(job_id, graph)

    # Cap history to last 3 exchanges (6 messages)
    history_capped = history[-6:]

    messages = [
        {"role": "system", "content": system_prompt},
        *history_capped,
        {"role": "user", "content": message}
    ]

    providers = [
        ("Groq", groq_client, _groq_tokens),
        ("Mistral", mistral_client, _mistral_tokens),
    ]
    for name, client, token_stream in providers:
        if client is None:
            logger.warning(f"Chat: {name} API key not configured, skipping")
            continue

        tokens = token_stream(messages)
        try:
            first = await asyncio.wait_for(
                tokens.__anext__(), timeout=FIRST_TOKEN_TIMEOUT_S
            )
        except StopAsyncIteration:
            logger.warning(f"Chat: {name} returned an empty response")
            continue
        except Exception as e:
            logger.warning(f"Chat: {name} failed before first token: {type(e).__name__}: {e}")
            try:
                await tokens.aclose()
            except Exception:
                pass
            continue

        # Committed to this provider: stream the rest
        full_response = first
        yield f"data: {json.dumps({'token': first, 'done': False})}\n\n"
        try:
            async for token in tokens:
                full_response += token
                yield f"data: {json.dumps({'token': token, 'done': False})}\n\n"
        except Exception as e:
            logger.error(f"Chat: {name} stream interrupted: {type(e).__name__}: {e}")

        yield f"data: {json.dumps({'token': '', 'done': True, 'nodes': _referenced_nodes(full_response, graph)})}\n\n"
        return

    error_data = {'token': BUSY_MESSAGE, 'done': True, 'nodes': []}
    yield f"data: {json.dumps(error_data)}\n\n"
