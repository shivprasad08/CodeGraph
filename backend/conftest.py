# What it does: shared pytest setup for the backend tests
#
# - psycopg's async driver needs the selector event loop on Windows.
# - No real network: any socket connection outside loopback fails at once with a clear error
#   (Postgres is not affected: psycopg connects through libpq's own C sockets; the database
#   tests use TEST_DATABASE_URL and skip without it).
# - POST /analyze asks GitHub for the latest commit / PR (to reuse a finished analysis), and
#   a PR job fetches the touched files' source: stubbed here unless a test patches them.
# - LLM calls (Groq, Mistral) fail fast unless a test patches them: the clients are set to
#   None ("not configured"), so summaries fall back to the rule-based text.
# - Tests marked "integration" (real GitHub calls) are skipped unless CODEGRAPH_INTEGRATION=1;
#   only they may use the network.

import asyncio
import ipaddress
import os
import socket
import sys

import pytest

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


class NetworkBlocked(RuntimeError):
    pass


def _is_local(address) -> bool:
    if not isinstance(address, tuple):
        return True  # AF_UNIX path
    host = str(address[0])
    if host in ("localhost", ""):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


RUN_INTEGRATION = os.environ.get("CODEGRAPH_INTEGRATION") == "1"


def pytest_collection_modifyitems(config, items):
    if RUN_INTEGRATION:
        return
    skip = pytest.mark.skip(reason="integration test (real network): set CODEGRAPH_INTEGRATION=1 to run")
    for item in items:
        if item.get_closest_marker("integration"):
            item.add_marker(skip)


@pytest.fixture(autouse=True)
def _block_network(request, monkeypatch):
    if request.node.get_closest_marker("integration"):
        return  # only runs with CODEGRAPH_INTEGRATION=1
    real_connect, real_connect_ex = socket.socket.connect, socket.socket.connect_ex

    def guard(address):
        if not _is_local(address):
            raise NetworkBlocked(f"Network access is blocked in tests (tried to connect to {address!r}); mock the call")

    def connect(self, address):
        guard(address)
        return real_connect(self, address)

    def connect_ex(self, address):
        guard(address)
        return real_connect_ex(self, address)

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", connect_ex)


@pytest.fixture(autouse=True)
def _no_llm(monkeypatch):
    import chat
    import enrichment

    for module in (enrichment, chat):
        monkeypatch.setattr(module, "groq_client", None)
        monkeypatch.setattr(module, "mistral_client", None)


@pytest.fixture(autouse=True)
def _no_latest_commit_lookup(monkeypatch):
    import main

    async def none(_repo_url):
        return None

    monkeypatch.setattr(main, "_latest_commit", none)

    async def no_pr(*_args):
        return None

    monkeypatch.setattr(main, "_latest_pr", no_pr)

    async def no_sources(*_args):
        return {}

    monkeypatch.setattr(main, "_pr_sources", no_sources)  # no GitHub file fetches in tests
