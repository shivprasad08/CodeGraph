# What it does: Tests for the JSON cache module
# Module 5: Cache Tests

import json
import time
import pytest
from unittest.mock import patch

import cache
from cache import (
    _make_cache_key,
    _cache_path,
    write_cache,
    read_cache,
    cache_exists,
    invalidate_cache,
    list_cached,
    cache_stats,
)


# ---------------------------------------------------------------------------
# Fixture: redirect CACHE_DIR to a tmp_path for every test
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def use_tmp_cache(tmp_path, monkeypatch):
    """Override config.CACHE_DIR so all tests write to a temp directory."""
    monkeypatch.setattr(cache.config, "CACHE_DIR", str(tmp_path))
    return tmp_path


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _minimal_graph(repo="owner/repo", sha="abc12345"):
    return {
        "repo": repo,
        "commit_sha": sha,
        "nodes": [],
        "edges": [],
    }


# ---------------------------------------------------------------------------
# Test: _make_cache_key
# ---------------------------------------------------------------------------
class TestMakeCacheKey:
    def test_basic(self):
        key = _make_cache_key("owner/repo", "abc12345")
        assert key == "owner__repo__abc12345.json"

    def test_uppercase_lowered(self):
        key = _make_cache_key("Owner/Repo", "ABC12345")
        # repo is lowered, sha is also sanitized
        assert key == "owner__repo__ABC12345.json"

    def test_special_chars_replaced(self):
        key = _make_cache_key("my.org/some+repo!", "sha@1")
        assert ".." not in key
        assert "+" not in key
        assert "!" not in key
        assert "@" not in key
        assert key.endswith(".json")
        # All special chars should be underscores
        assert "my_org__some_repo___sha_1.json" == key


# ---------------------------------------------------------------------------
# Test: write_cache → read_cache round-trip
# ---------------------------------------------------------------------------
class TestWriteReadRoundTrip:
    def test_round_trip(self, use_tmp_cache):
        graph = _minimal_graph()
        write_cache("owner/repo", "abc12345", graph)
        result = read_cache("owner/repo", "abc12345")
        assert result == graph

    def test_tmp_file_cleaned_up(self, use_tmp_cache):
        graph = _minimal_graph()
        write_cache("owner/repo", "abc12345", graph)

        # The .tmp file should not exist after a successful write
        key = _make_cache_key("owner/repo", "abc12345")
        tmp_path = _cache_path(key).with_suffix(".tmp")
        assert not tmp_path.exists()

    def test_round_trip_preserves_content(self, use_tmp_cache):
        graph = _minimal_graph()
        graph["nodes"] = [
            {"id": "f::foo", "label": "foo", "type": "function",
             "file": "f.py", "summary": "Does things.", "lines": [1, 10]}
        ]
        graph["edges"] = [
            {"source": "f.py", "target": "f::foo", "type": "defines"}
        ]
        write_cache("owner/repo", "abc12345", graph)
        result = read_cache("owner/repo", "abc12345")
        assert result == graph


# ---------------------------------------------------------------------------
# Test: read_cache on non-existent key
# ---------------------------------------------------------------------------
class TestReadCacheMiss:
    def test_returns_none(self):
        result = read_cache("nonexistent/repo", "00000000")
        assert result is None


# ---------------------------------------------------------------------------
# Test: read_cache on corrupt JSON file
# ---------------------------------------------------------------------------
class TestReadCacheCorrupt:
    def test_corrupt_json_returns_none_and_deletes(self, use_tmp_cache):
        key = _make_cache_key("owner/repo", "abc12345")
        path = _cache_path(key)
        path.write_text("this is not valid json!!!", encoding="utf-8")

        result = read_cache("owner/repo", "abc12345")
        assert result is None
        assert not path.exists()  # corrupt file deleted

    def test_zero_byte_file_returns_none_and_deletes(self, use_tmp_cache):
        key = _make_cache_key("owner/repo", "abc12345")
        path = _cache_path(key)
        path.write_text("", encoding="utf-8")

        result = read_cache("owner/repo", "abc12345")
        assert result is None
        assert not path.exists()


# ---------------------------------------------------------------------------
# Test: read_cache on JSON missing "nodes" key
# ---------------------------------------------------------------------------
class TestReadCacheMissingKeys:
    def test_missing_nodes_returns_none(self, use_tmp_cache):
        key = _make_cache_key("owner/repo", "abc12345")
        path = _cache_path(key)
        # Valid JSON but missing required keys
        path.write_text(
            json.dumps({"repo": "x", "commit_sha": "y"}),
            encoding="utf-8",
        )

        result = read_cache("owner/repo", "abc12345")
        assert result is None
        assert not path.exists()  # invalid file deleted

    def test_missing_edges_returns_none(self, use_tmp_cache):
        key = _make_cache_key("owner/repo", "abc12345")
        path = _cache_path(key)
        path.write_text(
            json.dumps({"repo": "x", "commit_sha": "y", "nodes": []}),
            encoding="utf-8",
        )

        result = read_cache("owner/repo", "abc12345")
        assert result is None
        assert not path.exists()


# ---------------------------------------------------------------------------
# Test: cache_exists
# ---------------------------------------------------------------------------
class TestCacheExists:
    def test_false_before_write(self):
        assert cache_exists("owner/repo", "abc12345") is False

    def test_true_after_write(self, use_tmp_cache):
        write_cache("owner/repo", "abc12345", _minimal_graph())
        assert cache_exists("owner/repo", "abc12345") is True

    def test_false_after_invalidate(self, use_tmp_cache):
        write_cache("owner/repo", "abc12345", _minimal_graph())
        invalidate_cache("owner/repo", "abc12345")
        assert cache_exists("owner/repo", "abc12345") is False


# ---------------------------------------------------------------------------
# Test: invalidate_cache
# ---------------------------------------------------------------------------
class TestInvalidateCache:
    def test_returns_true_when_file_existed(self, use_tmp_cache):
        write_cache("owner/repo", "abc12345", _minimal_graph())
        result = invalidate_cache("owner/repo", "abc12345")
        assert result is True

    def test_returns_false_when_file_missing(self):
        result = invalidate_cache("nonexistent/repo", "00000000")
        assert result is False

    def test_file_gone_after_invalidation(self, use_tmp_cache):
        write_cache("owner/repo", "abc12345", _minimal_graph())
        key = _make_cache_key("owner/repo", "abc12345")
        path = _cache_path(key)
        assert path.exists()

        invalidate_cache("owner/repo", "abc12345")
        assert not path.exists()


# ---------------------------------------------------------------------------
# Test: list_cached
# ---------------------------------------------------------------------------
class TestListCached:
    def test_two_entries(self, use_tmp_cache):
        write_cache("owner/repo1", "sha11111", _minimal_graph("owner/repo1", "sha11111"))
        # Small delay so mtimes differ
        time.sleep(0.05)
        write_cache("owner/repo2", "sha22222", _minimal_graph("owner/repo2", "sha22222"))

        entries = list_cached()
        assert len(entries) == 2

        # Each entry has required keys
        for entry in entries:
            assert "repo" in entry
            assert "commit_sha" in entry
            assert "cached_at" in entry
            assert "size_kb" in entry

        # Sorted by cached_at descending → repo2 should be first
        assert entries[0]["repo"] == "owner/repo2"
        assert entries[1]["repo"] == "owner/repo1"

    def test_empty_cache_dir(self):
        entries = list_cached()
        assert entries == []


# ---------------------------------------------------------------------------
# Test: cache_stats on empty directory
# ---------------------------------------------------------------------------
class TestCacheStatsEmpty:
    def test_empty_dir(self):
        stats = cache_stats()
        assert stats["total_entries"] == 0
        assert stats["total_size_kb"] == 0
        assert stats["oldest_entry"] is None
        assert stats["newest_entry"] is None
        assert "cache_dir" in stats


# ---------------------------------------------------------------------------
# Test: cache_stats with entries
# ---------------------------------------------------------------------------
class TestCacheStatsWithEntries:
    def test_two_entries(self, use_tmp_cache):
        g1 = _minimal_graph("owner/repo1", "sha11111")
        g2 = _minimal_graph("owner/repo2", "sha22222")
        write_cache("owner/repo1", "sha11111", g1)
        write_cache("owner/repo2", "sha22222", g2)

        stats = cache_stats()
        assert stats["total_entries"] == 2
        assert stats["total_size_kb"] > 0
        assert stats["oldest_entry"] is not None
        assert stats["newest_entry"] is not None
        assert "cache_dir" in stats

        # total_size_kb should be sum of both file sizes
        key1 = _make_cache_key("owner/repo1", "sha11111")
        key2 = _make_cache_key("owner/repo2", "sha22222")
        p1 = _cache_path(key1)
        p2 = _cache_path(key2)
        expected_kb = round((p1.stat().st_size + p2.stat().st_size) / 1024, 1)
        assert stats["total_size_kb"] == expected_kb
