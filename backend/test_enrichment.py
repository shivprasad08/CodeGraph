# What it does: Tests for the LLM enrichment module
# Module 4: Enrichment Tests

import json
import copy
import pytest
import pytest_asyncio
from unittest.mock import AsyncMock, patch, MagicMock

from enrichment import (
    _build_prompt,
    _parse_llm_response,
    _group_nodes_by_file,
    _enrich_file,
    enrich_graph,
    MAX_ITEMS_PER_FILE,
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
        ):
            # Groq always raises RateLimitError
            mock_groq.side_effect = RateLimitError(
                message="rate limited",
                response=MagicMock(status_code=429, headers={}),
                body=None,
            )
            mock_mistral.return_value = mock_response

            result = await _enrich_file("f.py", nodes)

        assert result == {"foo": "Handles auth."}
        mock_mistral.assert_called_once()

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
