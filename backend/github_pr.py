# What it does: pull request input — URL parsing, PR metadata and its changed files from GitHub
#
# Only public repositories: the base repo and, for a fork PR, the head repo must both be public
# (the server's token could read private ones, which must never be analysed or shown).
# Files come from /pulls/{n}/files (100 per page). GitHub leaves out the patch of very large
# or binary files; past MAX_MAPPED_FILES files, or when a patch is missing, the result is
# marked partial and the unmapped files are listed with the reason.

import re

import httpx

from ingestion import HTTP_TIMEOUT, RepoNotFoundError, _github_headers, repo_info

PR_URL_RE = re.compile(
    r"^(?:https?://)?(?:www\.)?github\.com/([A-Za-z0-9-_.]+)/([A-Za-z0-9-_.]+)/pull/(\d+)"
    r"(?:/(?:files|commits|checks|changes)(?:/[^\s?#]*)?)?/?(?:[?#]\S*)?$"
)
FILES_PER_PAGE = 100
MAX_FILE_PAGES = 30      # GitHub lists at most 3000 files
MAX_MAPPED_FILES = 300   # beyond this a PR is analysed partially


class PRNotFoundError(Exception):
    error_code = "pr_not_found"


def parse_pr_url(url: str) -> tuple[str, str, int] | None:
    """(owner, repo, number) for a GitHub pull request URL, else None."""
    m = PR_URL_RE.match((url or "").strip())
    if not m:
        return None
    repo = m.group(2)[:-4] if m.group(2).endswith(".git") else m.group(2)
    return m.group(1), repo, int(m.group(3))


def pr_url(owner: str, repo: str, number: int) -> str:
    return f"https://github.com/{owner}/{repo}/pull/{number}"


async def _get_json(client: httpx.AsyncClient, url: str, params=None):
    response = await client.get(url, params=params, timeout=HTTP_TIMEOUT)
    if response.status_code == 404:
        raise PRNotFoundError(url)
    if response.status_code != 200:
        raise RuntimeError(f"GitHub API error {response.status_code}: {url}")
    return response.json()


def _meta(owner: str, repo: str, number: int, pr: dict) -> dict:
    head_repo = (pr.get("head") or {}).get("repo") or {}
    return {
        "owner": owner,
        "repo": repo,
        "full_name": f"{owner}/{repo}",
        "number": number,
        "title": pr.get("title") or f"#{number}",
        "author": (pr.get("user") or {}).get("login"),
        "author_avatar": (pr.get("user") or {}).get("avatar_url"),
        "state": "merged" if pr.get("merged") or pr.get("merged_at") else pr.get("state", "open"),
        "html_url": pr.get("html_url") or pr_url(owner, repo, number),
        "base_sha": pr["base"]["sha"],
        "head_sha": pr["head"]["sha"],
        "base_ref": pr["base"].get("ref"),
        "head_ref": pr["head"].get("ref"),
        "head_repo": head_repo.get("full_name"),
        "head_private": bool(head_repo.get("private")),
        "is_fork": bool(head_repo) and head_repo.get("full_name", "").lower() != f"{owner}/{repo}".lower(),
        "additions": pr.get("additions", 0),
        "deletions": pr.get("deletions", 0),
        "changed_files": pr.get("changed_files", 0),
    }


async def fetch_pr_meta(owner: str, repo: str, number: int, client: httpx.AsyncClient | None = None) -> dict:
    """PR metadata; checks that the base repo (and a fork's head repo) is public."""
    if client is None:
        async with httpx.AsyncClient(headers=_github_headers(), follow_redirects=True, timeout=HTTP_TIMEOUT) as own:
            return await fetch_pr_meta(owner, repo, number, own)
    await repo_info(owner, repo, client)  # RepoNotFoundError / RepoPrivateError
    pr = await _get_json(client, f"https://api.github.com/repos/{owner}/{repo}/pulls/{number}")
    meta = _meta(owner, repo, number, pr)
    if not meta["head_repo"]:
        raise RepoNotFoundError("The pull request's source repository was deleted")
    if meta["is_fork"]:
        head_owner, head_name = meta["head_repo"].split("/", 1)
        await repo_info(head_owner, head_name, client)  # a private fork is refused too
    return meta


async def fetch_pr_files(owner: str, repo: str, number: int, client: httpx.AsyncClient) -> tuple[list[dict], bool]:
    """([{filename, status, previous_filename, additions, deletions, patch}], truncated)."""
    files: list[dict] = []
    for page in range(1, MAX_FILE_PAGES + 1):
        batch = await _get_json(
            client, f"https://api.github.com/repos/{owner}/{repo}/pulls/{number}/files",
            params={"per_page": FILES_PER_PAGE, "page": page},
        )
        files.extend(
            {
                "filename": f["filename"],
                "status": f.get("status", "modified"),
                "previous_filename": f.get("previous_filename"),
                "additions": f.get("additions", 0),
                "deletions": f.get("deletions", 0),
                "patch": f.get("patch"),
            }
            for f in batch
        )
        if len(batch) < FILES_PER_PAGE:
            break
    truncated = len(files) > MAX_MAPPED_FILES
    return files, truncated


async def fetch_pr(owner: str, repo: str, number: int) -> dict:
    """{meta, files, truncated}."""
    async with httpx.AsyncClient(headers=_github_headers(), follow_redirects=True, timeout=HTTP_TIMEOUT) as client:
        meta = await fetch_pr_meta(owner, repo, number, client)
        files, truncated = await fetch_pr_files(owner, repo, number, client)
    return {"meta": meta, "files": files, "truncated": truncated}
