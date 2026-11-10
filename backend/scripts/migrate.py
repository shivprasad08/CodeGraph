"""
Apply database migrations (backend/migrations/*.sql) and exit.

The server also runs them at startup; this is for doing it by hand:

    cd backend
    python scripts/migrate.py            # uses DATABASE_URL_DIRECT (falls back to DATABASE_URL)
    python scripts/migrate.py --status   # list applied / pending versions

Connection strings come from the environment or backend/.env and are never printed.
"""

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402  (loads .env)
import db  # noqa: E402  (selector event loop on Windows)
import psycopg  # noqa: E402


async def status(url: str) -> None:
    async with await psycopg.AsyncConnection.connect(url, **db.CONNECT_KWARGS, connect_timeout=30) as conn:
        exists = await (await conn.execute("select to_regclass('schema_migrations') is not null")).fetchone()
        applied = set()
        if exists[0]:
            applied = {r[0] for r in await (await conn.execute("select version from schema_migrations")).fetchall()}
    for version, _sql in db.migration_files():
        print(f"{'applied' if version in applied else 'pending'}  {version}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--status", action="store_true", help="show applied and pending migrations")
    args = parser.parse_args()
    url = config.DATABASE_URL_DIRECT or config.DATABASE_URL
    if not url:
        print("DATABASE_URL_DIRECT (or DATABASE_URL) is not set", file=sys.stderr)
        return 1
    if args.status:
        asyncio.run(status(url))
        return 0
    applied = asyncio.run(db.run_migrations(url))
    print(f"applied: {', '.join(applied)}" if applied else "up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
