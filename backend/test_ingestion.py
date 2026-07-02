# What it does: Tests for GitHub API ingestion module
# Module 1: Ingestion Tests

import pytest
import httpx
from ingestion import _parse_url, fetch_repo, FileLimitError, _get_python_files

@pytest.mark.asyncio
async def test_parse_url():
    owner, repo = await _parse_url("https://github.com/owner/repo")
    assert owner == "owner"
    assert repo == "repo"
    
    owner, repo = await _parse_url("https://github.com/owner/repo.git")
    assert owner == "owner"
    assert repo == "repo"
    
    owner, repo = await _parse_url("github.com/owner/repo")
    assert owner == "owner"
    assert repo == "repo"
    
    with pytest.raises(ValueError):
        await _parse_url("https://gitlab.com/owner/repo")
    
    with pytest.raises(ValueError):
        await _parse_url("not_a_url")

@pytest.mark.asyncio
@pytest.mark.integration
async def test_fetch_repo_integration():
    # psf/requests is a relatively small repo, avoiding FileLimitError
    result = await fetch_repo("https://github.com/psf/requests")
    assert "repo" in result
    assert result["repo"] == "psf/requests"
    assert "commit_sha" in result
    assert len(result["commit_sha"]) == 8
    assert "files" in result
    assert isinstance(result["files"], list)
    assert len(result["files"]) > 0
    assert "path" in result["files"][0]
    assert "content" in result["files"][0]

@pytest.mark.asyncio
async def test_file_limit_error(monkeypatch):
    from config import MAX_FILES
    
    class MockResponse:
        def __init__(self, json_data, status_code=200):
            self._json_data = json_data
            self.status_code = status_code
        def json(self):
            return self._json_data
            
    async def mock_get(url, *args, **kwargs):
        tree = []
        for i in range(MAX_FILES + 1):
            tree.append({
                "type": "blob",
                "path": f"src/file_{i}.py",
                "size": 100
            })
        return MockResponse({"tree": tree})
        
    client = httpx.AsyncClient()
    monkeypatch.setattr(client, "get", mock_get)
    
    with pytest.raises(FileLimitError) as exc_info:
        await _get_python_files("owner", "repo", "sha", client)
        
    assert "limit is" in str(exc_info.value)
    assert str(MAX_FILES) in str(exc_info.value)
