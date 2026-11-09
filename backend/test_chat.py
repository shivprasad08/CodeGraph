# What it does: Tests for the repository chat module (prompt budget, provider fallback)

import json
import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import chat
from groq import RateLimitError


def _big_graph(n_files=50, n_funcs=30):
    nodes, edges = [], []
    for i in range(n_files):
        path = f"package/subpackage/module_{i:02d}.py"
        nodes.append({"id": path, "label": path, "type": "file", "file": path})
        for j in range(n_funcs):
            nodes.append({
                "id": f"{path}::function_with_long_name_{j:02d}",
                "label": f"function_with_long_name_{j:02d}",
                "type": "function",
                "file": path,
                "summary": "Validates the incoming request payload and returns a normalized dictionary of settings.",
                "is_entry_point": j == 0,
            })
            if j:
                edges.append({
                    "source": f"{path}::function_with_long_name_00",
                    "target": f"{path}::function_with_long_name_{j:02d}",
                    "type": "calls",
                })
    return {"repo": "owner/repo", "nodes": nodes, "edges": edges}


def _events(chunks):
    """Parses SSE strings into dicts."""
    return [json.loads(c[len("data: "):].strip()) for c in chunks]


async def _collect(gen):
    return [chunk async for chunk in gen]


def _rate_limit_error():
    return RateLimitError(
        message="rate limited",
        response=MagicMock(status_code=429, headers={}),
        body=None,
    )


def _mistral_client(tokens):
    async def _stream():
        for t in tokens:
            yield SimpleNamespace(
                data=SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content=t))]
                )
            )

    client = MagicMock()
    client.chat.stream_async = AsyncMock(return_value=_stream())
    return client


def _failing_groq_client(exc):
    client = MagicMock()
    client.chat.completions.create = AsyncMock(side_effect=exc)
    return client


class TestBuildSystemPrompt:
    def test_prompt_under_budget_for_large_graph(self):
        prompt = chat.build_system_prompt("owner/repo", _big_graph())
        assert len(prompt) <= 12_000
        assert "RULES" in prompt
        assert "KEY CALL RELATIONSHIPS" in prompt

    def test_children_capped_per_file(self):
        graph = _big_graph(n_files=1, n_funcs=30)
        prompt = chat.build_system_prompt("owner/repo", graph)
        assert "...and 22 more" in prompt
        # The highest-degree child (the caller of all others) is listed
        assert "def function_with_long_name_00" in prompt


class TestStreamChatResponse:
    @pytest.mark.asyncio
    async def test_groq_rate_limit_falls_back_to_mistral(self):
        graph = {"repo": "o/r", "nodes": [{"id": "a.py::foo", "type": "function"}], "edges": []}
        mistral = _mistral_client(["Hello ", "there.\nNODE: a.py::foo"])

        with patch.object(chat, "groq_client", _failing_groq_client(_rate_limit_error())), \
             patch.object(chat, "mistral_client", mistral):
            events = _events(await _collect(
                chat.stream_chat_response("o/r", graph, "hi", [])
            ))

        assert [e["token"] for e in events[:-1]] == ["Hello ", "there.\nNODE: a.py::foo"]
        assert all(e["done"] is False for e in events[:-1])
        assert events[-1] == {"token": "", "done": True, "nodes": ["a.py::foo"]}
        mistral.chat.stream_async.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_both_fail_sends_friendly_message(self):
        graph = {"repo": "o/r", "nodes": [], "edges": []}
        mistral = MagicMock()
        mistral.chat.stream_async = AsyncMock(side_effect=RuntimeError("secret internal detail"))

        with patch.object(chat, "groq_client", _failing_groq_client(_rate_limit_error())), \
             patch.object(chat, "mistral_client", mistral):
            events = _events(await _collect(
                chat.stream_chat_response("o/r", graph, "hi", [])
            ))

        assert events == [{"token": chat.BUSY_MESSAGE, "done": True, "nodes": []}]
        assert "secret internal detail" not in json.dumps(events)
