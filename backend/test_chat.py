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

    def test_methods_listed_by_qualified_name(self):
        # Ids are path::Class.method, so the model must see Class.method to cite them
        graph = {"repo": "o/r", "nodes": [
            {"id": "m.py", "type": "file", "label": "m.py"},
            {"id": "m.py::A.get", "type": "function", "label": "get", "qualified_name": "A.get", "file": "m.py"},
            {"id": "m.py::B.get", "type": "function", "label": "get", "qualified_name": "B.get", "file": "m.py"},
        ], "edges": []}
        prompt = chat.build_system_prompt("o/r", graph)
        assert "def A.get" in prompt and "def B.get" in prompt

    def test_qualified_method_ids_are_referenced(self):
        graph = {"nodes": [{"id": "src/store.py::Store.get"}]}
        text = "It reads via `src/store.py::Store.get`.\nNODE: src/store.py::Store.get\n"
        assert chat._referenced_nodes(text, graph) == ["src/store.py::Store.get"]


class TestReferencedNodes:
    GRAPH = {"nodes": [
        {"id": "src/auth.py::verify_token"},
        {"id": "src/auth.py::TokenVerifier"},
        {"id": "src/db.py::connect"},
    ]}

    def test_node_lines_with_bullets_and_whitespace(self):
        text = (
            "Answer.\n\nReferences:\n"
            "NODE: src/auth.py::verify_token\n"
            "- NODE: src/db.py::connect\n"
            "  * NODE: `src/auth.py::TokenVerifier`\n"
            "NODE: src/missing.py::nope\n"
        )
        assert chat._referenced_nodes(text, self.GRAPH) == [
            "src/auth.py::verify_token",
            "src/db.py::connect",
            "src/auth.py::TokenVerifier",
        ]

    def test_backticked_ids_anywhere_in_order_and_deduped(self):
        text = (
            "`src/db.py::connect` opens the pool; `src/auth.py::verify_token` "
            "checks tokens via `src/db.py::connect`. `src/fake.py::ghost` is "
            "not real, nor is `connect`.\nNODE: src/auth.py::verify_token"
        )
        assert chat._referenced_nodes(text, self.GRAPH) == [
            "src/db.py::connect",
            "src/auth.py::verify_token",
        ]

    def test_capped_at_ten(self):
        graph = {"nodes": [{"id": f"m.py::f{i}"} for i in range(15)]}
        text = " ".join(f"`m.py::f{i}`" for i in range(15))
        assert chat._referenced_nodes(text, graph) == [f"m.py::f{i}" for i in range(10)]


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
        assert events[-1] == {"token": "", "done": True, "nodes": ["a.py::foo"], "diagram": None}
        mistral.chat.stream_async.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_groq_empty_content_falls_back_to_mistral(self):
        graph = {"repo": "o/r", "nodes": [], "edges": []}

        async def _empty_stream():
            for _ in range(3):
                yield SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content=None))]
                )

        groq = MagicMock()
        groq.chat.completions.create = AsyncMock(return_value=_empty_stream())
        mistral = _mistral_client(["From Mistral."])

        with patch.object(chat, "groq_client", groq), \
             patch.object(chat, "GROQ_CHAT_MODEL", "openai/gpt-oss-120b"), \
             patch.object(chat, "mistral_client", mistral):
            events = _events(await _collect(
                chat.stream_chat_response("o/r", graph, "hi", [])
            ))

        assert events[0] == {"token": "From Mistral.", "done": False}
        assert events[-1] == {"token": "", "done": True, "nodes": [], "diagram": None}
        mistral.chat.stream_async.assert_awaited_once()
        kwargs = groq.chat.completions.create.call_args.kwargs
        assert kwargs["extra_body"] == {"reasoning_effort": "low"}

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


class TestExtractDiagram:
    GRAPH = {"nodes": [
        {"id": "src/node.py::start", "label": "start"},
        {"id": "src/node.py::_build", "label": "_build"},
        {"id": "src/server.py::run_server", "label": "run_server"},
    ]}

    @staticmethod
    def _answer(spec_text):
        return f"Prose answer.\n\n```diagram\n{spec_text}\n```\n\nReferences:\nNODE: src/node.py::start"

    def test_valid_spec_passes(self):
        spec = {
            "direction": "LR",
            "nodes": [
                {"id": "n1", "ref": "src/node.py::start", "label": "Start node"},
                {"id": "n2", "ref": "src/node.py::_build", "label": "Build services"},
                {"id": "n3", "ref": "src/server.py::run_server", "label": "Run server"},
            ],
            "edges": [{"source": "n1", "target": "n2", "label": "calls"}, {"source": "n2", "target": "n3"}],
        }
        out = chat.extract_diagram(self._answer(json.dumps(spec)), self.GRAPH)
        assert out == spec

    def test_invented_refs_are_dropped_with_their_edges(self):
        spec = {
            "nodes": [
                {"id": "n1", "ref": "src/node.py::start", "label": "Start"},
                {"id": "n2", "ref": "src/made_up.py::ghost", "label": "Ghost"},
                {"id": "n3", "ref": "src/server.py::run_server", "label": "Run"},
            ],
            "edges": [{"source": "n1", "target": "n2"}, {"source": "n2", "target": "n3"}, {"source": "n1", "target": "n3"}],
        }
        out = chat.extract_diagram(self._answer(json.dumps(spec)), self.GRAPH)
        assert [n["id"] for n in out["nodes"]] == ["n1", "n3"]
        assert out["edges"] == [{"source": "n1", "target": "n3"}]
        assert out["direction"] == "TB"

    def test_fewer_than_two_valid_nodes_is_discarded(self):
        spec = {
            "nodes": [
                {"id": "n1", "ref": "src/node.py::start", "label": "Start"},
                {"id": "n2", "ref": "nope::nope", "label": "Nope"},
            ],
            "edges": [{"source": "n1", "target": "n2"}],
        }
        assert chat.extract_diagram(self._answer(json.dumps(spec)), self.GRAPH) is None

    def test_malformed_json_is_ignored(self):
        assert chat.extract_diagram(self._answer('{"nodes": [ {"id": "n1", '), self.GRAPH) is None
        assert chat.extract_diagram(self._answer('[1, 2, 3]'), self.GRAPH) is None
        assert chat.extract_diagram("No diagram here.", self.GRAPH) is None

    def test_caps_nodes_and_defaults_labels(self):
        graph = {"nodes": [{"id": f"m.py::f{i}", "label": f"f{i}"} for i in range(15)]}
        spec = {"nodes": [{"id": f"n{i}", "ref": f"m.py::f{i}"} for i in range(15)], "edges": []}
        out = chat.extract_diagram(self._answer(json.dumps(spec)), graph)
        assert len(out["nodes"]) == 10
        assert out["nodes"][0]["label"] == "f0"

    @pytest.mark.asyncio
    async def test_final_event_carries_validated_diagram(self):
        graph = {"repo": "o/r", "nodes": self.GRAPH["nodes"], "edges": []}
        spec = {
            "nodes": [
                {"id": "n1", "ref": "src/node.py::start", "label": "Start"},
                {"id": "n2", "ref": "src/node.py::_build", "label": "Build"},
                {"id": "n9", "ref": "invented.py::x", "label": "Invented"},
            ],
            "edges": [{"source": "n1", "target": "n2"}, {"source": "n2", "target": "n9"}],
        }
        answer = self._answer(json.dumps(spec))
        mistral = _mistral_client([answer[:20], answer[20:]])
        with patch.object(chat, "groq_client", _failing_groq_client(_rate_limit_error())), \
             patch.object(chat, "mistral_client", mistral):
            events = _events(await _collect(chat.stream_chat_response("o/r", graph, "How does start work?", [])))

        final = events[-1]
        assert final["done"] is True
        assert final["diagram"] == {
            "direction": "TB",
            "nodes": [
                {"id": "n1", "ref": "src/node.py::start", "label": "Start"},
                {"id": "n2", "ref": "src/node.py::_build", "label": "Build"},
            ],
            "edges": [{"source": "n1", "target": "n2"}],
        }
        assert final["nodes"] == ["src/node.py::start"]

    def test_prompt_contains_diagram_rule_with_literal_braces(self):
        prompt = chat.build_system_prompt("o/r", {"repo": "o/r", "nodes": [], "edges": []})
        assert '```diagram' in prompt
        assert '{"direction":"TB","nodes":[{"id":"n1"' in prompt
