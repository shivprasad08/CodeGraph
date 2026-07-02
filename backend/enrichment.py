# What it does: Groq/Mistral LLM enrichment — fills in "summary" fields
# on function and class nodes in the graph
# Module 4: Enrichment
#
# Input:  graph dict from graph_builder.py's build_graph() with empty summaries
# Output: same graph dict with "summary" filled in on every function/class node

import asyncio
import copy
import json
import re

import config
from groq import AsyncGroq, RateLimitError
from mistralai.async_client import MistralAsyncClient
from mistralai.models.chat_completion import ChatMessage

# ---------------------------------------------------------------------------
# Module-level LLM clients (initialized once)
# ---------------------------------------------------------------------------
groq_client = AsyncGroq(api_key=config.GROQ_API_KEY)
mistral_client = MistralAsyncClient(api_key=config.MISTRAL_API_KEY)

GROQ_MODEL = "llama-3.3-70b-versatile"
MISTRAL_MODEL = "mistral-small-latest"

MAX_ITEMS_PER_FILE = 25

SYSTEM_PROMPT = (
    "You are a senior software engineer explaining code to a new team member.\n"
    "You will receive a list of functions and classes from a Python file.\n"
    "For each one, write a single plain English sentence (max 20 words) that "
    "explains what it does — not how it does it.\n"
    "Be specific. Avoid filler like \"This function...\" or \"This class...\".\n"
    "Respond ONLY with a valid JSON object. No markdown, no backticks, no explanation."
)


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------
def _build_prompt(file_path: str, nodes: list[dict]) -> str:
    """Builds the user prompt string from file path and node list."""
    items = []
    for node in nodes:
        item = {
            "name": node.get("label", node.get("name", "")),
            "type": node.get("type", "function"),
            "start_line": node.get("lines", [0])[0] if node.get("lines") else 0,
        }
        # Include parameters if present (functions have them in the id or
        # we extract from the node dict)
        if "parameters" in node:
            item["parameters"] = node["parameters"]
        # Include docstring if present and non-empty
        if node.get("docstring"):
            item["docstring"] = node["docstring"]
        items.append(item)

    return (
        f"File: {file_path}\n\n"
        f"Functions and classes to explain:\n"
        f"{json.dumps(items, indent=2)}\n\n"
        f"Respond with a JSON object where each key is the exact function/class name\n"
        f"and the value is a one-sentence plain English summary (max 20 words).\n"
        f"Example format:\n"
        f'{{\n'
        f'  "verify_token": "Checks if a JWT is valid and returns the decoded payload.",\n'
        f'  "UserManager": "Manages CRUD operations for user accounts in the database."\n'
        f'}}'
    )


# ---------------------------------------------------------------------------
# LLM response parsing
# ---------------------------------------------------------------------------
def _parse_llm_response(raw: str, file_path: str) -> dict:
    """Parses and validates LLM JSON response. Returns {} on failure."""
    # Strip accidental markdown fences
    cleaned = raw.strip()
    cleaned = re.sub(r"^```(?:json)?\s*\n?", "", cleaned)
    cleaned = re.sub(r"\n?```\s*$", "", cleaned)
    cleaned = cleaned.strip()

    try:
        data = json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        print(f"[enrichment] Failed to parse LLM response for {file_path}")
        print(f"[enrichment] Raw response: {raw[:500]}")
        return {}

    if not isinstance(data, dict):
        print(f"[enrichment] LLM response is not a JSON object for {file_path}")
        return {}

    # Validate: every key and value must be a string
    result = {}
    for key, value in data.items():
        if isinstance(key, str) and isinstance(value, str):
            # Truncate summaries longer than 30 words
            words = value.split()
            if len(words) > 30:
                value = " ".join(words[:30]) + " ..."
            result[key] = value

    return result


# ---------------------------------------------------------------------------
# Group graph nodes by file
# ---------------------------------------------------------------------------
def _group_nodes_by_file(graph: dict) -> dict[str, list[dict]]:
    """
    Groups all function/class nodes by their file attribute.
    Returns { "src/auth/utils.py": [node, node, ...], ... }
    Skips file-type nodes.
    """
    groups: dict[str, list[dict]] = {}
    for node in graph.get("nodes", []):
        if node.get("type") == "file":
            continue
        if node.get("type") not in ("function", "class"):
            continue
        file_path = node.get("file", "")
        if file_path not in groups:
            groups[file_path] = []
        groups[file_path].append(node)
    return groups


# ---------------------------------------------------------------------------
# LLM call wrappers
# ---------------------------------------------------------------------------
async def _call_groq(prompt: str, system: str) -> str:
    """
    Calls Groq API. Returns raw response text.
    Raises groq.RateLimitError on 429.
    Raises RuntimeError on any other failure.
    """
    try:
        response = await groq_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            max_tokens=2048,
        )
        return response.choices[0].message.content
    except RateLimitError:
        raise
    except Exception as e:
        raise RuntimeError(f"Groq API error: {e}") from e


async def _call_mistral(prompt: str, system: str) -> str:
    """
    Calls Mistral API. Returns raw response text.
    Raises RuntimeError on any failure.
    """
    try:
        response = await mistral_client.chat(
            model=MISTRAL_MODEL,
            messages=[
                ChatMessage(role="system", content=system),
                ChatMessage(role="user", content=prompt),
            ],
        )
        return response.choices[0].message.content
    except Exception as e:
        raise RuntimeError(f"Mistral API error: {e}") from e


# ---------------------------------------------------------------------------
# Per-file enrichment (Groq first, Mistral fallback)
# ---------------------------------------------------------------------------
async def _enrich_file(file_path: str, nodes: list[dict]) -> dict:
    """
    Takes file path and list of function/class nodes for that file.
    Returns dict mapping name → summary string.
    Tries Groq first, falls back to Mistral.
    """
    if not nodes:
        return {}

    # Truncate to MAX_ITEMS_PER_FILE to stay within context limits
    if len(nodes) > MAX_ITEMS_PER_FILE:
        print(
            f"[enrichment] Warning: {file_path} has {len(nodes)} items, "
            f"truncating to {MAX_ITEMS_PER_FILE}"
        )
        nodes = nodes[:MAX_ITEMS_PER_FILE]

    prompt = _build_prompt(file_path, nodes)

    # Try Groq first
    try:
        print(f"[enrichment] Using Groq for {file_path}")
        raw = await _call_groq(prompt, SYSTEM_PROMPT)
        return _parse_llm_response(raw, file_path)
    except RateLimitError:
        # 429: wait 60 seconds, retry once on Groq
        print(f"[enrichment] Groq rate limited, waiting 60s before retry...")
        await asyncio.sleep(60)
        try:
            raw = await _call_groq(prompt, SYSTEM_PROMPT)
            return _parse_llm_response(raw, file_path)
        except RateLimitError:
            # Still rate limited: fall through to Mistral
            print(
                f"[enrichment] Groq rate limited, switching to Mistral "
                f"for {file_path}"
            )
        except Exception as e:
            print(f"[enrichment] Groq retry failed: {e}, trying Mistral")
    except RuntimeError as e:
        # Any other Groq error: immediately try Mistral
        print(f"[enrichment] Groq error: {e}, trying Mistral for {file_path}")

    # Mistral fallback
    try:
        print(f"[enrichment] Using Mistral for {file_path}")
        raw = await _call_mistral(prompt, SYSTEM_PROMPT)
        return _parse_llm_response(raw, file_path)
    except Exception as e:
        print(f"[enrichment] Mistral also failed for {file_path}: {e}")
        return {}


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
async def enrich_graph(graph: dict) -> dict:
    """
    Takes the full graph dict from build_graph().
    Returns the same dict with summary fields filled in.
    Does NOT mutate the input — makes a deep copy first.
    """
    graph = copy.deepcopy(graph)

    if not graph.get("nodes"):
        return graph

    # Group function/class nodes by file
    file_groups = _group_nodes_by_file(graph)
    total = len(file_groups)

    if total == 0:
        return graph

    # Collect all summaries: { file_path: { name: summary } }
    all_summaries: dict[str, dict[str, str]] = {}
    enriched = 0

    for i, (file_path, nodes) in enumerate(file_groups.items(), start=1):
        print(f"[enrichment] Processing file {i}/{total}: {file_path}")

        summaries = await _enrich_file(file_path, nodes)
        if summaries:
            all_summaries[file_path] = summaries
            enriched += 1

        # 2-second delay between calls to stay under rate limits
        if i < total:
            await asyncio.sleep(2)

    # Merge summaries back onto graph nodes
    for node in graph["nodes"]:
        if node.get("type") not in ("function", "class"):
            continue
        file_path = node.get("file", "")
        label = node.get("label", "")
        file_summaries = all_summaries.get(file_path, {})
        if label in file_summaries:
            node["summary"] = file_summaries[label]

    print(
        f"[enrichment] Done. {enriched}/{total} files enriched successfully."
    )

    return graph
