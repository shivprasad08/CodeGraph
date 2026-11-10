# What it does: shared pytest setup for the backend tests
#
# - psycopg's async driver needs the selector event loop on Windows.
# - POST /analyze asks GitHub for the latest commit (to reuse a finished analysis); tests do
#   not touch the network, so that lookup returns None unless a test patches it.

import asyncio
import sys

import pytest

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


@pytest.fixture(autouse=True)
def _no_latest_commit_lookup(monkeypatch):
    import main

    async def none(_repo_url):
        return None

    monkeypatch.setattr(main, "_latest_commit", none)

    async def no_pr(*_args):
        return None

    monkeypatch.setattr(main, "_latest_pr", no_pr)
