"""
Checks that job progress (server-sent events) streams incrementally through a proxy — the
Vercel /api rewrite in production, the Vite proxy locally — instead of arriving all at once.

    python scripts/check_streaming.py https://code-graph-ashy.vercel.app/api
    python scripts/check_streaming.py http://localhost:5173/api --url https://github.com/pallets/flask/pull/6133

It starts one analysis (anonymous; counts toward the hourly limit) and prints when each
progress event arrived. Pick a repo or PR that hasn't been analysed yet: a cached one
finishes immediately with a single event and proves nothing.

Verdict "incremental": several distinct events, spread over the run, no gap above
MAX_GAP_S, and the first event within MAX_FIRST_S. A buffering proxy shows up as one burst
at the end (all events within a fraction of a second, after a long silence).
"""

import argparse
import json
import sys
import time

import httpx

MAX_GAP_S = 10.0
MAX_FIRST_S = 15.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("base", help="API base URL, e.g. https://code-graph-ashy.vercel.app/api")
    parser.add_argument("--url", default="https://github.com/koajs/koa", help="repository or pull request to analyse")
    args = parser.parse_args()

    with httpx.Client(base_url=args.base.rstrip("/"), headers={"X-CodeGraph": "1"}, timeout=httpx.Timeout(30, read=180)) as client:
        t0 = time.monotonic()
        r = client.post("/analyze", json={"repo_url": args.url})
        if r.status_code != 200:
            print(f"POST /analyze -> {r.status_code}: {r.text[:200]}")
            return 2
        job = r.json()
        print(f"job {job['job_id']} ({job.get('status')})")
        stamps = []
        with client.stream("GET", f"/jobs/{job['job_id']}") as resp:
            print(f"GET /jobs -> {resp.status_code} {resp.headers.get('content-type')}")
            for line in resp.iter_lines():
                if not line.startswith("data:"):
                    continue
                ev = json.loads(line[5:])
                t = time.monotonic() - t0
                stamps.append((t, ev))
                print(f"{t:7.2f}s  {ev['status']:8} {str(ev.get('stage')):11} {ev.get('progress', 0):>3}%  {ev.get('message') or ''}")
                if ev["status"] in ("done", "error"):
                    break

    if len(stamps) < 3:
        print("\nNot enough events to judge (the job was probably cached). Use a repo or PR that wasn't analysed yet.")
        return 1
    times = [t for t, _ in stamps]
    gaps = [b - a for a, b in zip(times, times[1:])]
    distinct = len({(e.get("stage"), e.get("message")) for _, e in stamps})
    spread = times[-1] - times[0]
    ok = distinct >= 3 and max(gaps) <= MAX_GAP_S and times[0] <= MAX_FIRST_S and spread > 2
    print(f"\n{len(stamps)} events, {distinct} distinct, first after {times[0]:.1f}s, spread {spread:.1f}s, largest gap {max(gaps):.1f}s")
    print("verdict:", "incremental" if ok else "NOT incremental (buffered or stalled)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
