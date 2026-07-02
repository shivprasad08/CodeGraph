# What it does: JSON cache read/write for computed graphs
# Module 5: Cache
#
# Sits between FastAPI routes (Module 6) and the pipeline (Modules 1-4).
# Before running the expensive pipeline, the router checks the cache.
# Cache key: repo full name (owner/repo) + commit_sha
# Cache storage: one JSON file per cached graph in CACHE_DIR

from pathlib import Path
import json
import re
from datetime import datetime, timezone

import config


# ---------------------------------------------------------------------------
# Cache key and path helpers
# ---------------------------------------------------------------------------
def _make_cache_key(repo: str, commit_sha: str) -> str:
    """
    Produces a safe filesystem key from repo + commit_sha.
    repo format is "owner/repo" — the slash is escaped to "__".
    Lowercase the repo (GitHub is case-insensitive).
    Replace any character that's not alphanumeric, dash, or underscore with "_".
    Return format: "{owner}__{repo}__{commit_sha}.json"
    """
    safe = repo.lower().replace("/", "__")
    safe = re.sub(r"[^a-z0-9_\-]", "_", safe)
    sha_safe = re.sub(r"[^a-zA-Z0-9_\-]", "_", commit_sha)
    return f"{safe}__{sha_safe}.json"


def _cache_path(key: str) -> Path:
    """Returns full Path: CACHE_DIR / key. Creates CACHE_DIR if needed."""
    cache_dir = Path(config.CACHE_DIR)
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / key


# ---------------------------------------------------------------------------
# Write to cache
# ---------------------------------------------------------------------------
def write_cache(repo: str, commit_sha: str, graph: dict) -> None:
    """
    Serializes graph dict to JSON and writes to disk atomically.
    Writes to a .tmp file first, then renames to the final path.
    """
    key = _make_cache_key(repo, commit_sha)
    path = _cache_path(key)
    tmp_path = path.with_suffix(".tmp")

    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(graph, f, indent=2, ensure_ascii=False)

    tmp_path.replace(path)
    print(f"[cache] Written: {path}")


# ---------------------------------------------------------------------------
# Read from cache
# ---------------------------------------------------------------------------
def read_cache(repo: str, commit_sha: str) -> dict | None:
    """
    Returns the cached graph dict if it exists, None otherwise.
    Validates the file contains "nodes" and "edges" keys.
    Deletes corrupt or invalid files automatically.
    """
    key = _make_cache_key(repo, commit_sha)
    path = _cache_path(key)

    if not path.exists():
        return None

    # Treat 0-byte files as corrupt
    if path.stat().st_size == 0:
        path.unlink(missing_ok=True)
        print(f"[cache] Corrupt cache deleted: {path}")
        return None

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, ValueError):
        path.unlink(missing_ok=True)
        print(f"[cache] Corrupt cache deleted: {path}")
        return None

    # Validate required keys
    if "nodes" not in data or "edges" not in data:
        path.unlink(missing_ok=True)
        print(f"[cache] Warning: cache file missing nodes/edges, deleted: {path}")
        return None

    print(f"[cache] Hit: {path}")
    return data


# ---------------------------------------------------------------------------
# Check existence without reading
# ---------------------------------------------------------------------------
def cache_exists(repo: str, commit_sha: str) -> bool:
    """
    Returns True if a cache file exists for this repo+sha.
    Does NOT read or parse the file — just checks existence.
    """
    key = _make_cache_key(repo, commit_sha)
    path = _cache_path(key)
    return path.exists()


# ---------------------------------------------------------------------------
# Delete a cache entry
# ---------------------------------------------------------------------------
def invalidate_cache(repo: str, commit_sha: str) -> bool:
    """
    Deletes the cache file for this repo+sha if it exists.
    Returns True if file was deleted, False if it didn't exist.
    """
    key = _make_cache_key(repo, commit_sha)
    path = _cache_path(key)

    if path.exists():
        path.unlink()
        print(f"[cache] Invalidated: {path}")
        return True

    return False


# ---------------------------------------------------------------------------
# List all cached repos
# ---------------------------------------------------------------------------
def list_cached() -> list[dict]:
    """
    Returns metadata about all currently cached graphs.
    Reads only the "repo" and "commit_sha" fields from each JSON file.
    Returns list sorted by cached_at descending (most recent first).
    """
    cache_dir = Path(config.CACHE_DIR)
    if not cache_dir.exists():
        return []

    entries = []
    for file_path in cache_dir.glob("*.json"):
        try:
            size_kb = round(file_path.stat().st_size / 1024, 1)
            mtime = datetime.fromtimestamp(
                file_path.stat().st_mtime, tz=timezone.utc
            )
            cached_at = mtime.isoformat()

            # Partial read: only extract repo and commit_sha
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            entries.append({
                "repo": data.get("repo", ""),
                "commit_sha": data.get("commit_sha", ""),
                "cached_at": cached_at,
                "size_kb": size_kb,
            })
        except Exception as e:
            print(f"[cache] Warning: could not read {file_path}: {e}")
            continue

    # Sort by cached_at descending (most recent first)
    entries.sort(key=lambda x: x["cached_at"], reverse=True)
    return entries


# ---------------------------------------------------------------------------
# Cache stats
# ---------------------------------------------------------------------------
def cache_stats() -> dict:
    """
    Returns summary stats about the cache directory.
    If CACHE_DIR is empty or doesn't exist, return zeros and null dates.
    """
    cache_dir = Path(config.CACHE_DIR)

    result = {
        "total_entries": 0,
        "total_size_kb": 0,
        "cache_dir": str(cache_dir.resolve()),
        "oldest_entry": None,
        "newest_entry": None,
    }

    if not cache_dir.exists():
        return result

    json_files = list(cache_dir.glob("*.json"))
    if not json_files:
        return result

    total_size = 0
    mtimes = []

    for file_path in json_files:
        try:
            stat = file_path.stat()
            total_size += stat.st_size
            mtimes.append(stat.st_mtime)
        except OSError:
            continue

    result["total_entries"] = len(json_files)
    result["total_size_kb"] = round(total_size / 1024, 1)

    if mtimes:
        oldest = datetime.fromtimestamp(min(mtimes), tz=timezone.utc)
        newest = datetime.fromtimestamp(max(mtimes), tz=timezone.utc)
        result["oldest_entry"] = oldest.isoformat()
        result["newest_entry"] = newest.isoformat()

    return result

# ---------------------------------------------------------------------------
# Find by repo name
# ---------------------------------------------------------------------------
def find_cached_by_repo(repo: str) -> list[dict]:
    """
    Returns all cache entries matching this repo name (case-insensitive).
    Used by the /repo/{owner}/{repo} route to find cached graphs
    without knowing the commit sha.
    """
    all_entries = list_cached()
    return [
        e for e in all_entries
        if e["repo"].lower() == repo.lower()
    ]
