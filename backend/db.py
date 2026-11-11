# What it does: Postgres connection pool (Neon, pooled), migrations (direct URL), graph compression
#
# Neon's pooler is PgBouncer in transaction mode: no prepared statements
# (prepare_threshold=None), no LISTEN/NOTIFY, no session state (SET, session advisory locks).
# Migrations run in one transaction under pg_advisory_xact_lock, so they are safe to start
# from several instances at once and work over either URL.
# Connection strings are secrets: never print or log them (log_safety redacts them anyway).

import asyncio
import gzip
import logging
import sys
from pathlib import Path

import orjson
import psycopg
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

logger = logging.getLogger("codegraph.db")

# psycopg's async driver cannot use the Proactor loop (the Windows default)
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
MIGRATION_LOCK_ID = 7_310_442_001  # arbitrary, constant: one migrator at a time
CONNECT_KWARGS = {"prepare_threshold": None, "autocommit": True}


# ---------------------------------------------------------------------------
# Graph compression (bytea)
# ---------------------------------------------------------------------------
def compress_graph(graph: dict) -> bytes:
    return gzip.compress(orjson.dumps(graph), compresslevel=6)


def decompress_graph(blob: bytes | memoryview) -> dict:
    return orjson.loads(gzip.decompress(bytes(blob)))


# ---------------------------------------------------------------------------
# Pool
# ---------------------------------------------------------------------------
async def open_pool(url: str, min_size: int = 1, max_size: int = 5) -> AsyncConnectionPool:
    pool = AsyncConnectionPool(
        url,
        min_size=min_size,
        max_size=max_size,
        # connect_timeout: an unreachable host fails after 10 s instead of hanging
        kwargs={**CONNECT_KWARGS, "row_factory": dict_row, "connect_timeout": 10},
        # Neon closes idle connections (scale to zero): check before handing one out
        check=AsyncConnectionPool.check_connection,
        open=False,
        name="codegraph",
    )
    await pool.open(wait=True, timeout=30)
    return pool


# ---------------------------------------------------------------------------
# Migrations
# ---------------------------------------------------------------------------
def migration_files() -> list[tuple[str, str]]:
    """[(version, sql)] in order; the version is the file stem (0001_init)."""
    return [(p.stem, p.read_text(encoding="utf-8")) for p in sorted(MIGRATIONS_DIR.glob("*.sql"))]


async def run_migrations(url: str) -> list[str]:
    """Applies pending migrations; returns the versions applied now (empty when up to date)."""
    applied_now = []
    async with await psycopg.AsyncConnection.connect(url, **CONNECT_KWARGS, connect_timeout=30) as conn:
        async with conn.transaction():
            await conn.execute("select pg_advisory_xact_lock(%s)", (MIGRATION_LOCK_ID,))
            await conn.execute(
                "create table if not exists schema_migrations ("
                " version text primary key, applied_at timestamptz not null default now())"
            )
            cur = await conn.execute("select version from schema_migrations")
            done = {row[0] for row in await cur.fetchall()}
            for version, sql in migration_files():
                if version in done:
                    continue
                await conn.execute(sql)
                await conn.execute("insert into schema_migrations (version) values (%s)", (version,))
                applied_now.append(version)
    if applied_now:
        logger.info(f"[db] applied migrations: {', '.join(applied_now)}")
    else:
        logger.info("[db] migrations up to date")
    return applied_now
