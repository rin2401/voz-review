import asyncio
import unittest
from datetime import datetime
from unittest.mock import AsyncMock, patch

from scheduler import CrawlAllRunManager, next_top_of_hour_utc


class SchedulerUtilityTests(unittest.TestCase):
    def test_next_top_of_hour_uses_configured_timezone_boundary(self):
        now = datetime.fromisoformat("2026-03-28T05:37:12+00:00")

        next_run = next_top_of_hour_utc(now, "Asia/Ho_Chi_Minh")

        self.assertEqual(next_run.isoformat(), "2026-03-28T06:00:00")

    def test_exact_boundary_moves_to_following_hour(self):
        now = datetime.fromisoformat("2026-03-28T06:00:00+00:00")

        next_run = next_top_of_hour_utc(now, "Asia/Ho_Chi_Minh")

        self.assertEqual(next_run.isoformat(), "2026-03-28T07:00:00")


class CrawlAllRunManagerTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_run_rejects_overlap_while_existing_task_is_running(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def crawl_all_callable(_max_pages: int):
            started.set()
            await release.wait()
            return {
                "threads_total": 2,
                "threads_started": 2,
                "threads_skipped_running": 0,
                "threads_failed": 0,
            }

        manager = CrawlAllRunManager(
            timezone_name="Asia/Ho_Chi_Minh",
            enabled=True,
            lease_minutes=180,
            crawl_all_callable=crawl_all_callable,
        )

        with patch("scheduler.try_acquire_scheduler_lock", AsyncMock(return_value={"job_name": "crawl_all_threads"})), \
             patch("scheduler.complete_scheduler_run", AsyncMock()) as complete_mock:
            first = await manager.start_run(reason="manual", max_pages=0)
            await started.wait()
            second = await manager.start_run(reason="scheduled-hourly", max_pages=0)
            release.set()
            await manager.shutdown()

        self.assertEqual(first["status"], "started")
        self.assertEqual(second["status"], "already_running")
        complete_mock.assert_awaited_once()

    async def test_start_run_returns_already_running_when_lock_is_held_elsewhere(self):
        manager = CrawlAllRunManager(
            timezone_name="Asia/Ho_Chi_Minh",
            enabled=True,
            lease_minutes=180,
            crawl_all_callable=AsyncMock(),
        )

        with patch("scheduler.try_acquire_scheduler_lock", AsyncMock(return_value=None)):
            result = await manager.start_run(reason="scheduled-hourly", max_pages=0)

        self.assertEqual(result["status"], "already_running")


if __name__ == "__main__":
    unittest.main()
