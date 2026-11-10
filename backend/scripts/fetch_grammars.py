"""Download every non-Python tree-sitter grammar CodeGraph uses into the project's grammar cache.

Run once at build time (Render build command, Dockerfile), from the backend directory:

    python scripts/fetch_grammars.py

The cache is backend/.grammars, or CODEGRAPH_GRAMMAR_DIR when set. The server reads only
this cache and never downloads a grammar while handling a request. Exits non-zero when
any grammar fails to download or load with its tags query.
"""

import sys
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from languages import registry  # noqa: E402


def main() -> int:
    target = registry.grammar_dir()
    print(f"[grammars] cache: {target}")
    target.mkdir(parents=True, exist_ok=True)
    start = time.perf_counter()
    try:
        loaded = set(registry.fetch())
    except Exception as e:  # network, manifest, permissions
        print(f"[grammars] download failed: {e}", file=sys.stderr)
        return 1
    failed = [g for g in registry.GRAMMARS if g not in loaded]
    for g in registry.GRAMMARS:
        status = "ok" if g in loaded else f"FAILED ({registry.failure_reason(g)})"
        print(f"[grammars]   {g:<11} {status}")
    print(f"[grammars] {len(loaded)}/{len(registry.GRAMMARS)} ready in {time.perf_counter() - start:.1f}s")
    if failed:
        print(f"[grammars] missing: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
