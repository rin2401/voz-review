"""In-process hourly crawl scheduler integrated with the web app lifecycle."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Optional
from zoneinfo import ZoneInfo

from database.mongodb import (
    complete_scheduler_run,
    ensure_scheduler_state,
    get_scheduler_state,
    try_acquire_scheduler_lock,
)

SCHEDULER_JOB_NAME = "crawl_all_threads"


def resolve_scheduler_timezone(timezone_name: str) -> ZoneInfo:
    """Resolve the configured scheduler timezone."""
    return ZoneInfo(timezone_name)


def utc_now() -> datetime:
    """Return a naive UTC datetime matching the app's existing DB convention."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def next_top_of_hour_utc(now: datetime, timezone_name: str) -> datetime:
    """Compute the next exact top-of-hour boundary in the configured timezone."""
    zone = resolve_scheduler_timezone(timezone_name)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    else:
        now = now.astimezone(timezone.utc)

    local_now = now.astimezone(zone)
    local_next = local_now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    return local_next.astimezone(timezone.utc).replace(tzinfo=None)


def seconds_until(target_utc: datetime, now: Optional[datetime] = None) -> float:
    """Return non-negative seconds until the target UTC datetime."""
    now = now or utc_now()
    return max((target_utc - now).total_seconds(), 0.0)


def format_run_result(summary: dict) -> str:
    """Format a concise crawl summary for UI visibility."""
    return (
        f"threads={summary.get('threads_total', 0)}, "
        f"started={summary.get('threads_started', 0)}, "
        f"skipped={summary.get('threads_skipped_running', 0)}, "
        f"failed={summary.get('threads_failed', 0)}"
    )


class CrawlAllRunManager:
    """Coordinate the all-threads crawl so manual and scheduled runs share one lock."""

    def __init__(
        self,
        timezone_name: str,
        enabled: bool,
        lease_minutes: int,
        crawl_all_callable: Callable[[int], Awaitable[dict]],
    ):
        self.timezone_name = timezone_name
        self.enabled = enabled
        self.lease_minutes = lease_minutes
        self._crawl_all_callable = crawl_all_callable
        self._task: Optional[asyncio.Task] = None
        self._task_lock = asyncio.Lock()

    async def initialize(self):
        next_run_at = next_top_of_hour_utc(utc_now(), self.timezone_name)
        await ensure_scheduler_state(
            job_name=SCHEDULER_JOB_NAME,
            timezone=self.timezone_name,
            enabled=self.enabled,
            next_run_at=next_run_at,
        )

    async def get_status(self) -> dict | None:
        return await get_scheduler_state(SCHEDULER_JOB_NAME)

    async def start_run(self, reason: str, max_pages: int = 0) -> dict:
        async with self._task_lock:
            if self._task and not self._task.done():
                return {"status": "already_running", "reason": reason}

            next_run_at = next_top_of_hour_utc(utc_now(), self.timezone_name)
            lease_until = utc_now() + timedelta(minutes=self.lease_minutes)
            lock_state = await try_acquire_scheduler_lock(
                job_name=SCHEDULER_JOB_NAME,
                reason=reason,
                timezone=self.timezone_name,
                enabled=self.enabled,
                lock_until=lease_until,
                next_run_at=next_run_at,
            )
            if lock_state is None:
                return {"status": "already_running", "reason": reason}

            self._task = asyncio.create_task(self._run(reason=reason, max_pages=max_pages))
            return {"status": "started", "reason": reason}

    async def _run(self, reason: str, max_pages: int):
        next_run_at = next_top_of_hour_utc(utc_now(), self.timezone_name)
        try:
            summary = await self._crawl_all_callable(max_pages)
            await complete_scheduler_run(
                job_name=SCHEDULER_JOB_NAME,
                status="success",
                result=format_run_result(summary),
                next_run_at=next_run_at,
            )
        except Exception as exc:
            await complete_scheduler_run(
                job_name=SCHEDULER_JOB_NAME,
                status="error",
                error=str(exc),
                next_run_at=next_run_at,
            )
            raise
        finally:
            async with self._task_lock:
                current_task = asyncio.current_task()
                if self._task is current_task:
                    self._task = None

    async def shutdown(self):
        async with self._task_lock:
            task = self._task
        if not task:
            return
        if task.done():
            await asyncio.gather(task, return_exceptions=True)
            return
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=5)
        except asyncio.TimeoutError:
            pass


class HourlyCrawlScheduler:
    """Background loop that triggers the crawl manager on exact hourly boundaries."""

    def __init__(
        self,
        manager: CrawlAllRunManager,
    ):
        self._manager = manager
        self._loop_task: Optional[asyncio.Task] = None

    async def start(self):
        await self._manager.initialize()
        if not self._manager.enabled:
            return
        if self._loop_task and not self._loop_task.done():
            return
        self._loop_task = asyncio.create_task(self._run_loop())

    async def stop(self):
        task = self._loop_task
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self._loop_task = None
        await self._manager.shutdown()

    async def _run_loop(self):
        while True:
            next_run_at = next_top_of_hour_utc(utc_now(), self._manager.timezone_name)
            await ensure_scheduler_state(
                job_name=SCHEDULER_JOB_NAME,
                timezone=self._manager.timezone_name,
                enabled=self._manager.enabled,
                next_run_at=next_run_at,
            )
            await asyncio.sleep(seconds_until(next_run_at))
            await self._manager.start_run(reason="scheduled-hourly", max_pages=0)
