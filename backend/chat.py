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
MAX_EDGES_PER_TARGET = 2
MIN_CALL_EDGES = 10

FIRST_TOKEN_TIMEOUT_S = 30
CHAT_MAX_TOKENS = 1100  # chat replies only; enrichment keeps its own limit
BUSY_MESSAGE = "The AI is busy right now — try again in a minute."


def _node_degrees(edges: list[dict]) -> Counter:
    """Counts the edges where each node id is the source or the target."""
    degrees: Counter = Counter()
    for edge in edges:
        degrees[edge.get("source")] += 1
        degrees[edge.get("target")] += 1
    return degrees


# Sentence end: . ! ? not preceded by a digit ("1." in a numbered list) and followed by a capital
_SENTENCE_END_RE = re.compile(r"(?<!\d)[.!?](?=\s+[A-Z(`*]|$)")
MAX_ABOUT_CHARS = 160
MIN_SENTENCE_CHARS = 60


def _first_sentence(text: str, limit: int = MAX_ABOUT_CHARS) -> str:
    """
    First sentence of a docstring, at most `limit` chars. A very short first sentence
    ("Mutex managers for M16: ...") is extended so the useful part is not lost.
    """
    text = " ".join((text or "").split())
    if not text:
        return ""
    m = _SENTENCE_END_RE.search(text)
    sentence = text[: m.end()] if m else text
    if len(sentence) < MIN_SENTENCE_CHARS:
        sentence = text
    if len(sentence) > limit:
        sentence = sentence[: limit - 1].rsplit(" ", 1)[0].rstrip(",;:—-") + "…"
    return sentence


# Keyword a definition is introduced with, per language (functions); types use their kind
FUNCTION_WORDS = {
    "python": "def", "ruby": "def", "scala": "def", "javascript": "function", "typescript": "function",
    "php": "function", "lua": "function", "go": "func", "swift": "func", "rust": "fn", "kotlin": "fun",
}
TYPE_WORDS = {"class", "interface", "struct", "module"}


def _definition_word(node: dict) -> str:
    """"def" / "function" / "func" / "fn" / "class" / "struct"… for one function or class node."""
    lang = node.get("lang", "python")
    if node.get("type") == "function":
        return FUNCTION_WORDS.get(lang, "function")
    kind = node.get("kind", "class")
    if lang == "rust" and kind == "interface":
        return "trait"
    return kind if kind in TYPE_WORDS else "class"


def _languages_line(graph: dict) -> str:
    langs = graph.get("languages") or []
    if not langs:
        return ""
    parts = [f"{row.get('label') or row['lang']} ({row['files']} {'file' if row['files'] == 1 else 'files'})" for row in langs]
    return "Languages: " + ", ".join(parts) + "\n"


def build_system_prompt(job_id: str, graph: dict) -> str:
    """
    Builds the grounding context from graph data.
    This is injected as the system message. Kept under MAX_PROMPT_CHARS.
    """
    repo = graph.get("repo", "unknown/repo")
    languages_line = _languages_line(graph)
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    degrees = _node_degrees(edges)

    children_by_file: dict[str, list[dict]] = {}
    for n in nodes:
        if n.get("type") in ("function", "class"):
            children_by_file.setdefault(n.get("file"), []).append(n)

    # File list: every file, its documentation ("about:"), and its most-connected children
    files = []  # {"path", "about", "weight", "children": [(kind, degree, line)], "total"}
    for fn in (n for n in nodes if n.get("type") == "file"):
        path = fn["id"]
        children = sorted(
            children_by_file.get(path, []), key=lambda c: -degrees[c["id"]]
        )
        child_items = []
        for c in children[:MAX_CHILDREN_PER_FILE]:
            prefix = "def" if c["type"] == "function" else "class"  # trimming category
            word = _definition_word(c)
            if c.get("summary"):
                tail = f" — {c['summary']}"
            elif c["type"] == "class" and c.get("doc"):
                tail = f" — {_first_sentence(c['doc'])}"
            else:
                tail = ""
            child_items.append((prefix, degrees[c["id"]], f"    {word} {c.get('qualified_name') or c['label']}{tail}"))
        files.append({
            "path": path,
            "about": _first_sentence(fn.get("doc", "")),
            "weight": degrees[path] + sum(degrees[c["id"]] for c in children),
            "children": child_items,
            "total": len(children),
        })

    # Entry points
    entry_points = [
        n for n in nodes if n.get("is_entry_point") and n.get("type") != "file"
    ]
    entry_point_lines = [
        f"  {n['id']}: {n.get('summary', '')}" for n in entry_points[:MAX_ENTRY_POINTS]
    ]

    # Key relationships: call edges between the most-connected nodes, at most
    # MAX_EDGES_PER_TARGET into one target (a hub like a clock's tick() would fill the list)
    call_edges, per_target = [], Counter()
    for e in sorted(
        (e for e in edges if e.get("type") == "calls"),
        key=lambda e: (-(degrees[e["source"]] + degrees[e["target"]]), e["source"], e["target"]),
    ):
        if per_target[e["target"]] < MAX_EDGES_PER_TARGET:
            per_target[e["target"]] += 1
            call_edges.append(e)
            if len(call_edges) == MAX_CALL_EDGES:
                break
    edge_lines = [f"  {e['source']} → {e['target']}" for e in call_edges]

    # Budget trimming state: what is still shown
    shown_children = [list(range(len(f["children"]))) for f in files]
    shown_about = [bool(f["about"]) for f in files]
    shown_files = [True] * len(files)

    def sections() -> list[str]:
        out = []
        for i, f in enumerate(files):
            if not shown_files[i]:
                continue
            lines = [f"  {f['path']}"]
            if shown_about[i]:
                lines.append(f"    about: {f['about']}")
            lines.extend(f["children"][j][2] for j in shown_children[i])
            if f["total"] > len(shown_children[i]):
                lines.append(f"    ...and {f['total'] - len(shown_children[i])} more")
            out.append("\n".join(lines))
        return out

    def render(sections: list[str], omitted: int) -> str:
        structure = "\n".join(sections)
        if omitted:
            structure += f"\n  ...and {omitted} more files (omitted for length)"
        return f"""You are an expert software engineer helping a developer understand
the codebase of the GitHub repository: {repo}
{languages_line}
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
2. Name algorithms and protocols exactly as the file documentation ("about:") states
   (e.g. Bully, Chang–Roberts, Ricart–Agrawala, Chandy–Lamport). Never guess an
   algorithm from a filename. If the structure doesn't say, say you're not sure.
3. Use the terminology of the repo's language (for example method, struct, trait,
   interface, module, package) rather than Python terms for non-Python code.
4. When answering, cite specific node ids exactly as they appear in the structure,
   for example `src/auth.py::verify_token`, `server/src/index.js::createRoom`,
   `cmd/api/main.go::main` or a file id such as `server/src/codeRunner.js`
   — wrap them in backticks. The frontend will make them clickable.
5. When a short name is ambiguous in the repo (main, start, get…), always cite the full id.
6. When two files implement different mechanisms, never merge them into one bullet.
7. If you're unsure which file handles something, say so and suggest
   the most likely candidates based on the structure.
8. Keep answers concise — 3-6 sentences unless a longer explanation is needed.
9. If asked for code, you may quote short snippets but remind the user
   to check the Code Inspector for the full implementation.
10. End every answer with a "References:" section listing the node ids
   you explicitly mentioned, one per line, prefixed with NODE:
   Example:
   References:
   NODE: src/auth.py::verify_token
   NODE: server/src/index.js::createRoom
   NODE: server/src/codeRunner.js
   The frontend parses these to highlight nodes on the graph.
11. If the question is about a process, flow or sequence ("how does X work",
   "what happens when", "flow of"), then after the prose answer and before
   References output ONE fenced block like this, with 3-10 nodes:
   ```diagram
   {{"direction":"TB","nodes":[{{"id":"n1","ref":"<exact node id from the structure>","label":"short label"}}],"edges":[{{"source":"n1","target":"n2","label":"optional"}}]}}
   ```
   Every "ref" MUST be an exact node id from the structure above. If you
   cannot ground the flow in real node ids, omit the block entirely.
"""

    # Trim until the prompt fits. Documentation goes last:
    #   1. function lines, lowest degree first (each file's best-connected definition is kept)
    #   2. call relationships beyond the strongest MIN_CALL_EDGES
    #   3. class lines, lowest degree first (same exception)
    #   4. undocumented files, lowest weight first
    #   5. each file's remaining definition   6. "about:" lines   7. the remaining files
    def child_steps(kinds, top):
        return [
            ("child", i, j)
            for _, _, i, j in sorted(
                (c[1], f["weight"], i, j)
                for i, f in enumerate(files)
                for j, c in enumerate(f["children"])
                if c[0] in kinds and (j == 0) == top
            )
        ]

    by_weight = sorted(range(len(files)), key=lambda i: (files[i]["weight"], files[i]["path"]))
    plan = (
        child_steps({"def"}, top=False)
        + [("edge", None, None)] * max(0, len(edge_lines) - MIN_CALL_EDGES)
        + child_steps({"class"}, top=False)
        + [("file", i, None) for i in by_weight if not files[i]["about"]]
        + child_steps({"def", "class"}, top=True)
        + [("about", i, None) for i in by_weight if files[i]["about"]]
        + [("file", i, None) for i in by_weight if files[i]["about"]]
    )

    def current() -> str:
        return render(sections(), shown_files.count(False))

    prompt = current()
    for kind, i, j in plan:
        if len(prompt) <= MAX_PROMPT_CHARS:
            break
        if kind == "child":
            shown_children[i].remove(j)
        elif kind == "edge":
            edge_lines.pop()
        elif kind == "about":
            shown_about[i] = False
        else:
            shown_files[i] = False
        prompt = current()
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


MAX_DIAGRAM_NODES = 10
MAX_DIAGRAM_LABEL = 40
_DIAGRAM_RE = re.compile(r"```diagram[ \t]*\n?(?P<body>.*?)```", re.DOTALL)


def extract_diagram(full_response: str, graph: dict) -> dict | None:
    """
    Validates the model's ```diagram block against the graph. Nodes whose
    ref is not a real node id are dropped (with their edges); fewer than 2
    remaining nodes, or malformed JSON, means no diagram.
    """
    match = _DIAGRAM_RE.search(full_response or "")
    if not match:
        return None
    try:
        spec = json.loads(match.group("body").strip())
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(spec, dict) or not isinstance(spec.get("nodes"), list):
        return None

    by_id = {n["id"]: n for n in graph.get("nodes", [])}
    nodes, seen = [], set()
    for raw in spec["nodes"]:
        if not isinstance(raw, dict):
            continue
        node_id, ref = raw.get("id"), raw.get("ref")
        if not isinstance(node_id, str) or not isinstance(ref, str) or node_id in seen or ref not in by_id:
            continue
        label = raw.get("label") if isinstance(raw.get("label"), str) and raw["label"].strip() else by_id[ref].get("label", ref)
        nodes.append({"id": node_id, "ref": ref, "label": label.strip()[:MAX_DIAGRAM_LABEL]})
        seen.add(node_id)
        if len(nodes) == MAX_DIAGRAM_NODES:
            break
    if len(nodes) < 2:
        return None

    edges = []
    for raw in spec.get("edges") or []:
        if not isinstance(raw, dict):
            continue
        source, target = raw.get("source"), raw.get("target")
        if source in seen and target in seen and source != target:
            edge = {"source": source, "target": target}
            if isinstance(raw.get("label"), str) and raw["label"].strip():
                edge["label"] = raw["label"].strip()[:MAX_DIAGRAM_LABEL]
            edges.append(edge)

    direction = spec.get("direction") if spec.get("direction") in ("TB", "LR") else "TB"
    return {"direction": direction, "nodes": nodes, "edges": edges}


MAX_REFERENCED_NODES = 10

# "NODE: <id>" lines (optionally prefixed by "-", "*" or whitespace), or backticked ids
# anywhere in the text: `path::Name` in any language (`server/src/index.js::createRoom`,
# `cmd/main.go::main`, `src/store.rs::Store.new`) or a file id (`server/src/codeRunner.js`).
# Every match is checked against the graph's node ids, so stray code spans are dropped.
_NODE_REF_RE = re.compile(
    r"^[ \t*-]*NODE:[ \t]*(?P<line>[^\n]+?)[ \t]*$"
    r"|`(?P<tick>[^`\s]+::[^`\s]+|[^`\s:]+\.[A-Za-z0-9]+)`",
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

        final = {
            'token': '',
            'done': True,
            'nodes': _referenced_nodes(full_response, graph),
            'diagram': extract_diagram(full_response, graph),
        }
        yield f"data: {json.dumps(final)}\n\n"
        return

    error_data = {'token': BUSY_MESSAGE, 'done': True, 'nodes': []}
    yield f"data: {json.dumps(error_data)}\n\n"
