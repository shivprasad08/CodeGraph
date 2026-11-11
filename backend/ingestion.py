# What it does: GitHub API file fetcher
# Module 1: Ingestion

import asyncio
import re
import httpx
from collections import Counter

from config import GITHUB_TOKEN, MAX_FILES
from languages import registry

class RepoNotFoundError(Exception): pass
class RepoPrivateError(Exception):
    """The repo is private (error_code "private_repo"). The server's GitHub token may be able
    to read it, which is exactly why it must not be analysed or served."""
    error_code = "private_repo"
    message = "Private repositories aren't supported."
class FileLimitError(Exception): pass
class NoSourceError(Exception):
    """The repo has no file in a supported language (error_code "no_source")."""
    error_code = "no_source"

# Python selection rules: no test file (registry.is_test: real test conventions, never a
# substring), no path containing any of these substrings, and no empty __init__.py (a non-empty
# one is parsed: it often re-exports the package's public API)
PYTHON_EXCLUDE = ["migrations", "__pycache__", ".venv", "node_modules", "setup.py"]
MAX_FILE_BYTES = 100000
# Read for entry points / import resolution; not counted as source files
MANIFEST_NAMES = frozenset({"package.json", "go.mod", "Cargo.toml"})
MAX_MANIFEST_DEPTH = 3


def select_files(tree: list[dict]) -> tuple[list[dict], list[str]]:
    """
    Source files to analyse ({path, size, lang}) and manifest paths, from a git tree listing.
    Raises NoSourceError when no supported source file exists, FileLimitError above MAX_FILES.
    """
    files, manifests = [], []
    extensions = Counter()
    for item in tree:
        if item.get("type") != "blob":
            continue
        path = item.get("path", "")
        size = item.get("size", 0)
        name = path.split("/")[-1]
        ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else name
        extensions[ext] += 1
        if name in MANIFEST_NAMES and path.count("/") < MAX_MANIFEST_DEPTH and not registry.is_ignored(path):
            manifests.append(path)
            continue
        lang = registry.language_of(path)
        if lang is None or size > MAX_FILE_BYTES:
            continue
        if lang == "python":
            if (name == "__init__.py" and size == 0) or registry.is_test(path) or any(ex in path for ex in PYTHON_EXCLUDE):
                continue
        elif registry.is_ignored(path) or registry.is_test(path):
            continue
        files.append({"path": path, "size": size, "lang": lang})

    if not files:
        top = ", ".join(f"{ext} ({n})" for ext, n in extensions.most_common(5)) or "none"
        raise NoSourceError(
            f"No supported source files found. Most common file types: {top}. "
            "CodeGraph reads Python, JavaScript, TypeScript, Java, Go, Rust, C/C++, C#, Ruby, PHP, "
            "Kotlin, Swift, Scala and Lua."
        )
    if len(files) > MAX_FILES:
        counts = Counter(registry.label(f["lang"]) for f in files)
        breakdown = ", ".join(f"{label} {n}" for label, n in counts.most_common())
        raise FileLimitError(
            f"Repo has {len(files)} source files ({breakdown}), limit is {MAX_FILES}. Try a smaller repo."
        )
    return files, manifests

async def _parse_url(url: str) -> tuple[str, str]:
    """Returns (owner, repo_name). Raises ValueError on bad format."""
    url = url.strip().rstrip("/")
    pattern = r"^(?:https?://)?(?:www\.)?github\.com/([^/]+)/([^/]+)$"
    match = re.match(pattern, url)
    if not match:
        raise ValueError(f"Invalid GitHub URL format: {url}")
    owner = match.group(1)
    repo = match.group(2)
    if repo.endswith(".git"):
        repo = repo[:-4]
    return owner, repo

async def _get_default_branch_and_sha(owner: str, repo: str, client: httpx.AsyncClient) -> tuple[str, str]:
    """Returns (branch_name, commit_sha)."""
    url = f"https://api.github.com/repos/{owner}/{repo}"
    print(f"[ingestion] GET {url}")
    response = await client.get(url, timeout=HTTP_TIMEOUT)
    
    if response.status_code == 404:
        raise RepoNotFoundError(f"Repository not found: {owner}/{repo}")
    if response.status_code == 403:
        raise RepoPrivateError(f"Repository is private or API limit reached: {owner}/{repo}")
    if response.status_code != 200:
        raise RuntimeError(f"GitHub API error {response.status_code}: {url}")
        
    data = response.json()
    if data.get("private"):
        raise RepoPrivateError(RepoPrivateError.message)
    default_branch = data.get("default_branch")
    
    commits_url = f"https://api.github.com/repos/{owner}/{repo}/commits/{default_branch}"
    print(f"[ingestion] GET {commits_url}")
    commits_response = await client.get(commits_url, timeout=HTTP_TIMEOUT)
    
    if commits_response.status_code != 200:
        raise RuntimeError(f"GitHub API error {commits_response.status_code}: {commits_url}")
        
    commits_data = commits_response.json()
    sha = commits_data["sha"][:8]
    return default_branch, sha

async def _list_tree(owner: str, repo: str, sha: str, client: httpx.AsyncClient) -> list[dict]:
    url = f"https://api.github.com/repos/{owner}/{repo}/git/trees/{sha}?recursive=1"
    print(f"[ingestion] GET {url}")
    response = await client.get(url, timeout=HTTP_TIMEOUT)
    if response.status_code != 200:
        raise RuntimeError(f"GitHub API error {response.status_code}: {url}")
    return response.json().get("tree", [])


async def _get_source_files(owner: str, repo: str, sha: str, client: httpx.AsyncClient) -> tuple[list[dict], list[str]]:
    """Returns ([{path, size, lang}], [manifest paths])."""
    return select_files(await _list_tree(owner, repo, sha, client))


async def _get_python_files(owner: str, repo: str, sha: str, client: httpx.AsyncClient) -> list[dict]:
    """Kept for compatibility: the source-file list (all supported languages)."""
    files, _ = await _get_source_files(owner, repo, sha, client)
    return files

async def _fetch_single_file(owner: str, repo: str, sha: str, file_info: dict, client: httpx.AsyncClient, sem: asyncio.Semaphore) -> dict | None:
    path = file_info["path"]
    url = f"https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}"
    async with sem:
        print(f"[ingestion] GET {url}")
        try:
            response = await client.get(url, timeout=HTTP_TIMEOUT)
            if response.status_code == 200:
                out = {"path": path, "content": response.text}
                if file_info.get("lang"):
                    out["lang"] = file_info["lang"]
                return out
            else:
                print(f"[ingestion] Warning: Failed to fetch {path}, status {response.status_code}")
                return None
        except Exception as e:
            print(f"[ingestion] Warning: Exception fetching {path}: {e}")
            return None

async def _fetch_file_contents(owner: str, repo: str, sha: str, files: list[dict], client: httpx.AsyncClient) -> list[dict]:
    """Returns list of {path, content} dicts. Skips failed files."""
    sem = asyncio.Semaphore(10)
    tasks = [_fetch_single_file(owner, repo, sha, f, client, sem) for f in files]
    results = await asyncio.gather(*tasks)
    return [r for r in results if r is not None]

# Every GitHub request: 10 s to connect, 20 s to read/write (never an open-ended wait)
HTTP_TIMEOUT = httpx.Timeout(20.0, connect=10.0)


def _github_headers() -> dict:
    headers = {"Accept": "application/vnd.github.v3+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    return headers


async def latest_commit(repo_url: str) -> tuple[str, str]:
    """(owner/repo, short sha of the default branch) — two API calls, no file contents."""
    owner, repo = await _parse_url(repo_url)
    async with httpx.AsyncClient(headers=_github_headers(), follow_redirects=True, timeout=HTTP_TIMEOUT) as client:
        _branch, sha = await _get_default_branch_and_sha(owner, repo, client)
    return f"{owner}/{repo}", sha


async def repo_info(owner: str, repo: str, client: httpx.AsyncClient) -> dict:
    """GitHub's repo JSON. Raises RepoNotFoundError, RepoPrivateError (private repos are never read)."""
    url = f"https://api.github.com/repos/{owner}/{repo}"
    response = await client.get(url, timeout=HTTP_TIMEOUT)
    if response.status_code == 404:
        raise RepoNotFoundError(f"Repository not found: {owner}/{repo}")
    if response.status_code == 403:
        raise RepoPrivateError(f"Repository is private or API limit reached: {owner}/{repo}")
    if response.status_code != 200:
        raise RuntimeError(f"GitHub API error {response.status_code}: {url}")
    data = response.json()
    if data.get("private"):
        raise RepoPrivateError(RepoPrivateError.message)
    return data


async def fetch_repo_at(owner: str, repo: str, sha: str, client: httpx.AsyncClient | None = None) -> dict:
    """
    The repo's source files at one commit (full or short sha); same dict as fetch_repo, with
    commit_sha shortened to 8 characters (the analysis cache key).
    Raises FileLimitError, NoSourceError. The caller checks that the repo is public.
    """
    if client is None:
        async with httpx.AsyncClient(headers=_github_headers(), follow_redirects=True, timeout=HTTP_TIMEOUT) as own:
            return await fetch_repo_at(owner, repo, sha, own)
    files, manifest_paths = await _get_source_files(owner, repo, sha, client)
    file_contents = await _fetch_file_contents(owner, repo, sha, files, client)
    # An __init__.py with only whitespace adds nothing to the graph
    file_contents = [f for f in file_contents if not (f["path"].endswith("__init__.py") and not f["content"].strip())]
    manifest_contents = await _fetch_file_contents(owner, repo, sha, [{"path": p} for p in manifest_paths], client)
    return {
        "repo": f"{owner}/{repo}",
        "commit_sha": sha[:8],
        "files": file_contents,
        "manifests": {m["path"]: m["content"] for m in manifest_contents},
    }


async def fetch_repo(repo_url: str) -> dict:
    """
    Main entry point. Takes a raw URL string, returns the structured dict above.
    Raises: ValueError, RepoNotFoundError, RepoPrivateError, FileLimitError, NoSourceError
    """
    owner, repo = await _parse_url(repo_url)
    async with httpx.AsyncClient(headers=_github_headers(), follow_redirects=True, timeout=HTTP_TIMEOUT) as client:
        _branch, sha = await _get_default_branch_and_sha(owner, repo, client)
        return await fetch_repo_at(owner, repo, sha, client)
