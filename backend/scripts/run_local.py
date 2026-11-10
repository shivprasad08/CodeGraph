"""
Run the API locally with auto-reload: works on Windows too.

    cd backend
    python scripts/run_local.py            # http://127.0.0.1:8000
    python scripts/run_local.py --port 9000

psycopg's async driver cannot use the Proactor event loop (the Windows default), so plain
`uvicorn main:app` fails there once DATABASE_URL is set. This sets the selector event loop
policy first, then starts uvicorn on main:app with reload.
"""

import argparse
import asyncio
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import uvicorn  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the CodeGraph API locally with reload.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run(
        "main:app",
        host=args.host,
        port=args.port,
        reload=True,
        app_dir=str(BACKEND),
        reload_dirs=[str(BACKEND)],
    )


if __name__ == "__main__":
    main()
