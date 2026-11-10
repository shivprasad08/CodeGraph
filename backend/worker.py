# What it does: in-process job worker — claims jobs from the store one at a time and runs them
#
# One concurrent job. Claims are exclusive (FOR UPDATE SKIP LOCKED) and hold a 2-minute lock
# that a heartbeat renews every 30 s; a job whose worker died (restart, deploy, crash) is
# re-claimed once its lock expires. After MAX_ATTEMPTS claims it fails with retries_exhausted.
# On a clean shutdown the running job is released back to the queue straight away.
# No LISTEN/NOTIFY (Neon's pooler is transaction mode): /analyze wakes the loop in-process,
# and it polls every POLL_SECONDS for jobs from elsewhere (e.g. left over from a restart).

import asyncio
import logging
import os
import socket
import uuid
from typing import Awaitable, Callable

import store as store_mod

logger = logging.getLogger("codegraph.worker")

POLL_SECONDS = 3
HEARTBEAT_SECONDS = 30
ERROR_BACKOFF_SECONDS = 5


class Worker:
    def __init__(self, store, run: Callable[[str, str], Awaitable[None]]):
        self.store = store
        self.run = run
        self.id = f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
        self.wake_event = asyncio.Event()
        self.current: str | None = None

    def wake(self) -> None:
        self.wake_event.set()

    async def run_once(self) -> bool:
        """Claims and runs one job; False when the queue is empty."""
        job = await self.store.claim_job(self.id)
        if job is None:
            return False
        job_id = job["id"]
        if job["attempts"] > store_mod.MAX_ATTEMPTS:
            logger.warning(f"[worker] job {job_id} gave up after {store_mod.MAX_ATTEMPTS} attempts")
            await self.store.fail_job(job_id, store_mod.RETRIES_EXHAUSTED_MESSAGE, store_mod.RETRIES_EXHAUSTED)
            return True
        logger.info(f"[worker] running job {job_id} (attempt {job['attempts']})")
        self.current = job_id
        beat = asyncio.create_task(self._heartbeat(job_id))
        try:
            await self.run(job_id, job["repo_url"])
        finally:
            beat.cancel()
            if not asyncio.current_task().cancelling():  # on shutdown run_forever releases it
                self.current = None
        return True

    async def _heartbeat(self, job_id: str) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            try:
                if not await self.store.heartbeat(job_id, self.id):
                    logger.warning(f"[worker] lost the lock on job {job_id}")
            except Exception as e:
                logger.warning(f"[worker] heartbeat failed for {job_id}: {type(e).__name__}")

    async def run_forever(self) -> None:
        logger.info(f"[worker] started ({self.id})")
        try:
            while True:
                try:
                    if await self.run_once():
                        continue
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error(f"[worker] {type(e).__name__}: {e}", exc_info=True)
                    await asyncio.sleep(ERROR_BACKOFF_SECONDS)
                    continue
                self.wake_event.clear()
                try:
                    await asyncio.wait_for(self.wake_event.wait(), timeout=POLL_SECONDS)
                except asyncio.TimeoutError:
                    pass
        except asyncio.CancelledError:
            if self.current:
                job_id, self.current = self.current, None
                try:
                    await self.store.release_job(job_id, self.id)
                    logger.info(f"[worker] released job {job_id} back to the queue")
                except Exception as e:
                    logger.warning(f"[worker] could not release {job_id}: {type(e).__name__}")
            raise
