# What it does: Tests for the LLM enrichment module
# Module 4: Enrichment Tests

import asyncio
import json
import copy
import pytest
import pytest_asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch, MagicMock

from enrichment import (
    _build_prompt,
    _parse_llm_response,
    _group_nodes_by_file,
    _enrich_file,
    enrich_graph,
    MAX_ITEMS_PER_FILE,
    MistralRateLimitError,
)
from groq import RateLimitError


# ---------------------------------------------------------------------------
# Helpers: sample graph data
# ---------------------------------------------------------------------------
def _make_graph(nodes=None, edges=None):
    return {
        "repo": "owner/repo",
        "commit_sha": "abc12345",
        "nodes": nodes or [],
        "edges": edges or [],
    }


def _make_node(id, label, type, file, summary="", lines=None):
    return {
        "id": id,
        "label": label,
        "type": type,
        "file": file,
        "summary": summary,
        "lines": lines or [1, 10],
    }


# ---------------------------------------------------------------------------
# Test: _build_prompt
# ---------------------------------------------------------------------------
class TestBuildPrompt:
    def test_contains_file_path_and_names(self):
        nodes = [
            _make_node("f1::foo", "foo", "function", "f1.py", lines=[5, 15]),
            _make_node("f1::Bar", "Bar", "class", "f1.py", lines=[20, 40]),
        ]
        prompt = _build_prompt("f1.py", nodes)

        assert "f1.py" in prompt
        assert "foo" in prompt
        assert "Bar" in prompt
        # Should contain a JSON items block
        assert '"name"' in prompt
        assert '"type"' in prompt

    def test_includes_docstring_when_present(self):
        nodes = [
            {
                "id": "f::foo",
                "label": "foo",
                "type": "function",
                "file": "f.py",
                "summary": "",
                "lines": [1],
                "docstring": "Does something useful.",
            }
        ]
        prompt = _build_prompt("f.py", nodes)
        assert "Does something useful." in prompt

    def test_omits_docstring_when_absent(self):
        nodes = [_make_node("f::foo", "foo", "function", "f.py")]
        prompt = _build_prompt("f.py", nodes)
        assert "docstring" not in prompt

    def test_items_json_is_compact(self):
        nodes = [
            _make_node("f::foo", "foo", "function", "f.py"),
            _make_node("f::Bar", "Bar", "class", "f.py"),
        ]
        prompt = _build_prompt("f.py", nodes)
        items_line = prompt.split("Functions and classes to explain:\n")[1].split("\n")[0]

        assert json.loads(items_line) == [
            {"name": "foo", "type": "function"},
            {"name": "Bar", "type": "class"},
        ]
        assert ", " not in items_line and ": " not in items_line
        assert "start_line" not in prompt

    def test_docstring_truncated(self):
        node = _make_node("f::foo", "foo", "function", "f.py")
        node["docstring"] = "x" * 500
        prompt = _build_prompt("f.py", [node])
        assert "x" * 200 in prompt
        assert "x" * 201 not in prompt


# ---------------------------------------------------------------------------
# Test: _parse_llm_response
# ---------------------------------------------------------------------------
class TestParseLlmResponse:
    def test_valid_json(self):
        raw = json.dumps({
            "foo": "Validates input data.",
            "Bar": "Manages user sessions.",
        })
        result = _parse_llm_response(raw, "test.py")
        assert result == {
            "foo": "Validates input data.",
            "Bar": "Manages user sessions.",
        }

    def test_json_with_markdown_fences(self):
        raw = '```json\n{"foo": "Does things."}\n```'
        result = _parse_llm_response(raw, "test.py")
        assert result == {"foo": "Does things."}

    def test_invalid_json(self):
        raw = "this is not json at all"
        result = _parse_llm_response(raw, "test.py")
        assert result == {}

    def test_non_string_values_dropped(self):
        raw = json.dumps({
            "foo": "Valid summary.",
            "bar": 123,
            "baz": ["not", "a", "string"],
            "qux": None,
        })
        result = _parse_llm_response(raw, "test.py")
        assert result == {"foo": "Valid summary."}

    def test_long_summary_truncated(self):
        long_text = " ".join([f"word{i}" for i in range(50)])
        raw = json.dumps({"foo": long_text})
        result = _parse_llm_response(raw, "test.py")
        words = result["foo"].split()
        # 30 words + "..." appended
        assert words[-1] == "..."
        assert len(words) == 31  # 30 words + "..."


# ---------------------------------------------------------------------------
# Test: _group_nodes_by_file
# ---------------------------------------------------------------------------
class TestGroupNodesByFile:
    def test_groups_correctly_and_excludes_file_nodes(self):
        nodes = [
            _make_node("a.py::foo", "foo", "function", "a.py"),
            _make_node("a.py::bar", "bar", "function", "a.py"),
            _make_node("b.py::Baz", "Baz", "class", "b.py"),
            _make_node("a.py", "a.py", "file", "a.py"),
        ]
        graph = _make_graph(nodes=nodes)
        groups = _group_nodes_by_file(graph)

        assert "a.py" in groups
        assert "b.py" in groups
        assert len(groups["a.py"]) == 2
        assert len(groups["b.py"]) == 1
        # File node should not be included
        file_types = [n["type"] for n in groups["a.py"]]
        assert "file" not in file_types

    def test_empty_graph(self):
        graph = _make_graph(nodes=[])
        groups = _group_nodes_by_file(graph)
        assert groups == {}


# ---------------------------------------------------------------------------
# Test: _enrich_file (mocked LLM calls)
# ---------------------------------------------------------------------------
class TestEnrichFile:
    @pytest.mark.asyncio
    async def test_groq_success(self):
        nodes = [_make_node("f::foo", "foo", "function", "f.py")]
        mock_response = json.dumps({"foo": "Validates tokens."})

        with patch(
            "enrichment._call_groq", new_callable=AsyncMock
        ) as mock_groq:
            mock_groq.return_value = mock_response
            result = await _enrich_file("f.py", nodes)

        assert result == {"foo": "Validates tokens."}
        mock_groq.assert_called_once()

    @pytest.mark.asyncio
    async def test_groq_rate_limit_falls_to_mistral(self):
        nodes = [_make_node("f::foo", "foo", "function", "f.py")]
        mock_response = json.dumps({"foo": "Handles auth."})

        with patch(
            "enrichment._call_groq", new_callable=AsyncMock
        ) as mock_groq, patch(
            "enrichment._call_mistral", new_callable=AsyncMock
        ) as mock_mistral, patch(
            "enrichment.asyncio.sleep", new_callable=AsyncMock
        ) as mock_sleep:
            # Groq always raises RateLimitError
            mock_groq.side_effect = RateLimitError(
                message="rate limited",
                response=MagicMock(status_code=429, headers={}),
                body=None,
            )
            mock_mistral.return_value = mock_response

            result = await _enrich_file("f.py", nodes)

        assert result == {"foo": "Handles auth."}
        mock_groq.assert_called_once()
        mock_mistral.assert_called_once()
        mock_sleep.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_groq_timeout_falls_to_mistral(self):
        nodes = [_make_node("f::foo", "foo", "function", "f.py")]
        mock_response = json.dumps({"foo": "Handles auth."})

        async def _hang(*args, **kwargs):
            await asyncio.Event().wait()

        with patch("enrichment.LLM_TIMEOUT_S", 0.05), patch(
            "enrichment._call_groq", side_effect=_hang
        ), patch(
            "enrichment._call_mistral", new_callable=AsyncMock
        ) as mock_mistral:
            mock_mistral.return_value = mock_response
            result = await _enrich_file("f.py", nodes)

        assert result == {"foo": "Handles auth."}
        mock_mistral.assert_called_once()

    @pytest.mark.asyncio
    async def test_mistral_timeout_returns_empty(self):
        nodes = [_make_node("f::foo", "foo", "function", "f.py")]

        async def _hang(*args, **kwargs):
            await asyncio.Event().wait()

        with patch("enrichment.LLM_TIMEOUT_S", 0.05), patch(
            "enrichment._call_groq", side_effect=RuntimeError("Groq down")
        ), patch("enrichment._call_mistral", side_effect=_hang):
            result = await _enrich_file("f.py", nodes)

        assert result == {}

    @pytest.mark.asyncio
    async def test_groq_empty_content_falls_to_mistral(self):
        nodes = [_make_node("f::foo", "foo", "function", "f.py")]
        groq = MagicMock()
        groq.chat.completions.create = AsyncMock(return_value=SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=None))]
        ))

        with patch("enrichment.groq_client", groq), patch(
            "config.GROQ_SUMMARY_MODEL", "openai/gpt-oss-20b"
        ), patch(
            "enrichment._call_mistral", new_callable=AsyncMock
        ) as mock_mistral:
            mock_mistral.return_value = json.dumps({"foo": "Handles auth."})
            result = await _enrich_file("f.py", nodes)

        assert result == {"foo": "Handles auth."}
        mock_mistral.assert_called_once()
        kwargs = groq.chat.completions.create.call_args.kwargs
        assert kwargs["model"] == "openai/gpt-oss-20b"
        assert kwargs["extra_body"] == {"reasoning_effort": "low"}

    @pytest.mark.asyncio
    async def test_mistral_rate_limit_retried_once_then_empty(self):
        nodes = [_make_node("f::foo", "foo", "function", "f.py")]

        with patch(
            "enrichment._call_groq", side_effect=RuntimeError("Groq down")
        ), patch(
            "enrichment._call_mistral", new_callable=AsyncMock
        ) as mock_mistral, patch(
            "enrichment.asyncio.sleep", new_callable=AsyncMock
        ) as mock_sleep:
            mock_mistral.side_effect = MistralRateLimitError("429")
            result = await _enrich_file("f.py", nodes)

        assert result == {}
        assert mock_mistral.call_count == 2
        mock_sleep.assert_awaited_once_with(2)

    @pytest.mark.asyncio
    async def test_both_fail_returns_empty(self):
        nodes = [_make_node("f::foo", "foo", "function", "f.py")]

        with patch(
            "enrichment._call_groq", new_callable=AsyncMock
        ) as mock_groq, patch(
            "enrichment._call_mistral", new_callable=AsyncMock
        ) as mock_mistral, patch(
            "enrichment.asyncio.sleep", new_callable=AsyncMock
        ):
            mock_groq.side_effect = RuntimeError("Groq down")
            mock_mistral.side_effect = RuntimeError("Mistral down")

            result = await _enrich_file("f.py", nodes)

        assert result == {}

    @pytest.mark.asyncio
    async def test_empty_nodes_returns_empty(self):
        result = await _enrich_file("f.py", [])
        assert result == {}


# ---------------------------------------------------------------------------
# Test: enrich_graph integration (mocked LLM calls)
# ---------------------------------------------------------------------------
class TestEnrichGraph:
    @pytest.mark.asyncio
    async def test_enriches_nodes_and_deep_copies(self):
        nodes = [
            _make_node("a.py::foo", "foo", "function", "a.py"),
            _make_node("a.py::bar", "bar", "function", "a.py"),
        ]
        original_graph = _make_graph(nodes=nodes)
        original_copy = copy.deepcopy(original_graph)

        mock_response = json.dumps({
            "foo": "Validates user input.",
            "bar": "Formats output data.",
        })

        with patch(
            "enrichment._call_groq", new_callable=AsyncMock
        ) as mock_groq, patch(
            "enrichment.asyncio.sleep", new_callable=AsyncMock
        ):
            mock_groq.return_value = mock_response

            result = await enrich_graph(original_graph)

        # Summaries should be filled in
        result_nodes = {n["label"]: n for n in result["nodes"]}
        assert result_nodes["foo"]["summary"] == "Validates user input."
        assert result_nodes["bar"]["summary"] == "Formats output data."

        # Input graph was NOT mutated (deep copy check)
        assert original_graph == original_copy
        assert original_graph["nodes"][0]["summary"] == ""
        assert original_graph["nodes"][1]["summary"] == ""

    @pytest.mark.asyncio
    async def test_empty_graph_returned_unchanged(self):
        graph = _make_graph(nodes=[])
        result = await enrich_graph(graph)
        assert result["nodes"] == []

    @pytest.mark.asyncio
    async def test_file_nodes_not_enriched(self):
        nodes = [
            _make_node("a.py", "a.py", "file", "a.py"),
            _make_node("a.py::foo", "foo", "function", "a.py"),
        ]
        original_graph = _make_graph(nodes=nodes)

        mock_response = json.dumps({"foo": "Does something."})

        with patch(
            "enrichment._call_groq", new_callable=AsyncMock
        ) as mock_groq, patch(
            "enrichment.asyncio.sleep", new_callable=AsyncMock
        ):
            mock_groq.return_value = mock_response
            result = await enrich_graph(original_graph)

        file_node = next(n for n in result["nodes"] if n["type"] == "file")
        assert file_node["summary"] == ""

    @pytest.mark.asyncio
    async def test_on_progress_called_once_per_file(self):
        nodes = [
            _make_node(f"f{i}.py::foo", "foo", "function", f"f{i}.py")
            for i in range(5)
        ]
        calls = []

        with patch(
            "enrichment._call_groq", new_callable=AsyncMock
        ) as mock_groq:
            mock_groq.return_value = json.dumps({"foo": "Does something."})
            result = await enrich_graph(
                _make_graph(nodes=nodes),
                on_progress=lambda done, total: calls.append((done, total)),
            )

        assert calls == [(i, 5) for i in range(1, 6)]
        assert all(n["summary"] == "Does something." for n in result["nodes"])

    @pytest.mark.asyncio
    async def test_one_file_failure_does_not_kill_job(self):
        nodes = [
            _make_node("a.py::foo", "foo", "function", "a.py"),
            _make_node("b.py::bar", "bar", "function", "b.py"),
        ]

        async def _fake_enrich(file_path, nodes, stats=None):
            if file_path == "a.py":
                raise ValueError("boom")
            return {"bar": "Formats output."}

        with patch("enrichment._enrich_file", side_effect=_fake_enrich):
            result = await enrich_graph(_make_graph(nodes=nodes))

        by_label = {n["label"]: n for n in result["nodes"]}
        assert by_label["foo"]["summary"] == ""
        assert by_label["foo"]["summary_status"] == "failed"
        assert by_label["bar"]["summary"] == "Formats output."
        assert by_label["bar"]["summary_status"] == "ok"

    @pytest.mark.asyncio
    async def test_only_top_degree_nodes_enriched(self):
        # call degree (exact 1.0, inferred 0.5): hub=4, mid=2, low=1, ep=0, iso=0
        nodes = [
            _make_node("a.py::iso", "iso", "function", "a.py"),
            _make_node("a.py::low", "low", "function", "a.py"),
            _make_node("b.py::hub", "hub", "function", "b.py"),
            _make_node("b.py::mid", "mid", "class", "b.py"),
            _make_node("c.py::ep", "ep", "function", "c.py"),
        ]
        nodes[4]["is_entry_point"] = True
        edges = [
            {"source": "b.py::hub", "target": "b.py::mid", "type": "calls", "confidence": "exact"},
            {"source": "b.py::hub", "target": "b.py::mid", "type": "calls", "confidence": "exact"},
            {"source": "b.py::hub", "target": "x", "type": "calls", "confidence": "exact"},
            {"source": "a.py::low", "target": "b.py::hub", "type": "calls", "confidence": "exact"},
            {"source": "c.py", "target": "c.py::ep", "type": "defines"},  # defines never counts
        ]
        sent = []

        async def _fake_enrich(file_path, file_nodes, stats=None):
            sent.extend(n["label"] for n in file_nodes)
            return {n["label"]: f"Summary of {n['label']}." for n in file_nodes}

        with patch("config.MAX_ENRICH_NODES", 3), patch(
            "enrichment._enrich_file", side_effect=_fake_enrich
        ):
            result = await enrich_graph(_make_graph(nodes=nodes, edges=edges))

        # Ranked by call degree; the entry point (degree 0) no longer jumps the queue
        assert sorted(sent) == ["hub", "low", "mid"]
        by_label = {n["label"]: n for n in result["nodes"]}
        for label in ("hub", "low", "mid"):
            assert by_label[label]["summary_status"] == "ok"
        for label in ("iso", "ep"):
            assert by_label[label]["summary_status"] == "skipped"
            assert by_label[label]["summary"] == ""

    def test_ranking_weights_inferred_edges_and_breaks_ties_with_entry_points(self):
        from enrichment import _select_nodes_for_enrichment
        nodes = [
            _make_node("m.py::exact2", "exact2", "function", "m.py"),
            _make_node("m.py::inferred3", "inferred3", "function", "m.py"),
            _make_node("m.py::tie_plain", "tie_plain", "function", "m.py"),
            _make_node("m.py::tie_entry", "tie_entry", "function", "m.py"),
            _make_node("m.py::C.__repr__", "__repr__", "function", "m.py"),
            _make_node("m.py::C.__init__", "__init__", "function", "m.py"),
        ]
        nodes[3]["is_entry_point"] = True
        e = lambda s, t, c="exact": {"source": s, "target": t, "type": "calls", "confidence": c}
        edges = [
            e("x", "m.py::exact2"), e("y", "m.py::exact2"),                       # 2.0
            e("x", "m.py::inferred3", "inferred"), e("y", "m.py::inferred3", "inferred"),
            e("z", "m.py::inferred3", "inferred"),                                 # 1.5
            e("x", "m.py::tie_plain"), e("x", "m.py::tie_entry"),                  # 1.0 each
            e("x", "m.py::C.__repr__"), e("y", "m.py::C.__repr__"), e("z", "m.py::C.__repr__"),  # dunder: excluded
            e("x", "m.py::C.__init__"), e("y", "m.py::C.__init__"), e("z", "m.py::C.__init__"),  # 3.0, kept
        ]
        graph = _make_graph(nodes=nodes, edges=edges)
        assert _select_nodes_for_enrichment(graph, 3) == {"m.py::C.__init__", "m.py::exact2", "m.py::inferred3"}
        # the tie at 1.0 goes to the entry point
        assert "m.py::tie_entry" in _select_nodes_for_enrichment(graph, 4)
        assert "m.py::C.__repr__" not in _select_nodes_for_enrichment(graph, 10)

    @pytest.mark.asyncio
    async def test_same_named_methods_get_their_own_summaries(self):
        nodes = [
            {**_make_node("f.py::A.get", "get", "function", "f.py"), "qualified_name": "A.get"},
            {**_make_node("f.py::B.get", "get", "function", "f.py"), "qualified_name": "B.get"},
        ]
        prompts = []

        async def _fake_groq(prompt, system):
            prompts.append(prompt)
            return json.dumps({"A.get": "Reads from A.", "B.get": "Reads from B."})

        with patch("enrichment._call_groq", side_effect=_fake_groq):
            result = await enrich_graph(_make_graph(nodes=nodes))
        by_id = {n["id"]: n["summary"] for n in result["nodes"]}
        assert by_id == {"f.py::A.get": "Reads from A.", "f.py::B.get": "Reads from B."}
        assert '"name":"A.get"' in prompts[0]


# ---------------------------------------------------------------------------
# Test: truncation warning for large files
# ---------------------------------------------------------------------------
class TestTruncation:
    @pytest.mark.asyncio
    async def test_truncates_to_max_items(self, capsys):
        # Create more than MAX_ITEMS_PER_FILE nodes
        n_items = MAX_ITEMS_PER_FILE + 5
        nodes = [
            _make_node(f"f::func{i}", f"func{i}", "function", "f.py")
            for i in range(n_items)
        ]

        mock_response = json.dumps(
            {f"func{i}": f"Summary {i}." for i in range(MAX_ITEMS_PER_FILE)}
        )

        with patch(
            "enrichment._call_groq", new_callable=AsyncMock
        ) as mock_groq:
            mock_groq.return_value = mock_response

            result = await _enrich_file("f.py", nodes)

        # Should have called _build_prompt with only MAX_ITEMS_PER_FILE items
        captured = capsys.readouterr()
        assert f"has {n_items} items" in captured.out
        assert f"truncating to {MAX_ITEMS_PER_FILE}" in captured.out

        # Should still return valid summaries for the truncated set
        assert len(result) == MAX_ITEMS_PER_FILE
