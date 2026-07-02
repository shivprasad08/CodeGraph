# What it does: GitHub API file fetcher
# Module 1: Ingestion

import asyncio
import re
import httpx
from config import GITHUB_TOKEN, MAX_FILES

class RepoNotFoundError(Exception): pass
class RepoPrivateError(Exception): pass
class FileLimitError(Exception): pass

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
    response = await client.get(url, timeout=10)
    
    if response.status_code == 404:
        raise RepoNotFoundError(f"Repository not found: {owner}/{repo}")
    if response.status_code == 403:
        raise RepoPrivateError(f"Repository is private or API limit reached: {owner}/{repo}")
    if response.status_code != 200:
        raise RuntimeError(f"GitHub API error {response.status_code}: {url}")
        
    data = response.json()
    default_branch = data.get("default_branch")
    
    commits_url = f"https://api.github.com/repos/{owner}/{repo}/commits/{default_branch}"
    print(f"[ingestion] GET {commits_url}")
    commits_response = await client.get(commits_url, timeout=10)
    
    if commits_response.status_code != 200:
        raise RuntimeError(f"GitHub API error {commits_response.status_code}: {commits_url}")
        
    commits_data = commits_response.json()
    sha = commits_data["sha"][:8]
    return default_branch, sha

async def _get_python_files(owner: str, repo: str, sha: str, client: httpx.AsyncClient) -> list[dict]:
    """Returns filtered list of {path, size} dicts."""
    url = f"https://api.github.com/repos/{owner}/{repo}/git/trees/{sha}?recursive=1"
    print(f"[ingestion] GET {url}")
    response = await client.get(url, timeout=10)
    
    if response.status_code != 200:
        raise RuntimeError(f"GitHub API error {response.status_code}: {url}")
        
    data = response.json()
    tree = data.get("tree", [])
    
    filtered_files = []
    exclude_paths = ["test", "tests", "migrations", "__pycache__", ".venv", "node_modules", "setup.py", "conftest.py"]
    
    for item in tree:
        if item.get("type") != "blob":
            continue
            
        path = item.get("path", "")
        if not path.endswith(".py"):
            continue
            
        filename = path.split("/")[-1]
        if filename == "__init__.py":
            continue
            
        size = item.get("size", 0)
        if size > 100000:
            continue
            
        if any(ex in path for ex in exclude_paths):
            continue
            
        filtered_files.append({"path": path, "size": size})
        
    if len(filtered_files) > MAX_FILES:
        raise FileLimitError(f"Repo has {len(filtered_files)} Python files, limit is {MAX_FILES}. Try a smaller repo.")
        
    return filtered_files

async def _fetch_single_file(owner: str, repo: str, sha: str, file_info: dict, client: httpx.AsyncClient, sem: asyncio.Semaphore) -> dict | None:
    path = file_info["path"]
    url = f"https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}"
    async with sem:
        print(f"[ingestion] GET {url}")
        try:
            response = await client.get(url, timeout=10)
            if response.status_code == 200:
                return {"path": path, "content": response.text}
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

async def fetch_repo(repo_url: str) -> dict:
    """
    Main entry point. Takes a raw URL string, returns the structured dict above.
    Raises: ValueError, RepoNotFoundError, RepoPrivateError, FileLimitError
    """
    owner, repo = await _parse_url(repo_url)
    
    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json"
    }
    
    async with httpx.AsyncClient(headers=headers) as client:
        branch, sha = await _get_default_branch_and_sha(owner, repo, client)
        files = await _get_python_files(owner, repo, sha, client)
        file_contents = await _fetch_file_contents(owner, repo, sha, files, client)
        
    return {
        "repo": f"{owner}/{repo}",
        "commit_sha": sha,
        "files": file_contents
    }
