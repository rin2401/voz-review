"""Manually crawl Voz review threads and write updates directly to MongoDB Atlas."""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))


def load_env_file(path: Path) -> None:
    """Load simple KEY=VALUE lines before importing app config."""
    if not path.exists():
        return

    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def resolve_mongo_uri() -> str:
    return os.getenv("MONGO_URI") or os.getenv("MONGODB_URI") or ""


def require_atlas_uri(allow_local: bool) -> None:
    mongo_uri = resolve_mongo_uri()
    if allow_local:
        return
    if mongo_uri.startswith("mongodb+srv://") or "mongodb.net" in mongo_uri:
        return
    raise SystemExit(
        "Refusing to crawl without a MongoDB Atlas URI. Set MONGODB_URI/MONGO_URI "
        "or pass --allow-local for local development."
    )


async def crawl_one_thread(url: str, max_pages: int) -> dict:
    from database.mongodb import get_thread_state, set_thread_crawl_status
    from main import RUNNING_CRAWL_URLS, crawl_thread

    thread = await get_thread_state(url=url)
    if thread and thread.get("crawl_status") == "running":
        if url in RUNNING_CRAWL_URLS:
            return {"status": "already_running", "url": url, "pages_crawled": 0}
        await set_thread_crawl_status(url, "idle")

    await set_thread_crawl_status(url, "running")
    RUNNING_CRAWL_URLS.add(url)
    return await crawl_thread(url, max_pages=max_pages)


async def crawl_configured_threads(max_pages: int, delay_seconds: float, seed_defaults: bool) -> dict:
    from crawler.voz_scraper import THREAD_URLS
    from database.mongodb import get_all_threads, seed_threads

    if seed_defaults:
        await seed_threads(THREAD_URLS)

    threads = await get_all_threads()
    summary = {
        "threads_total": len(threads),
        "threads_started": 0,
        "threads_skipped_running": 0,
        "threads_failed": 0,
        "pages_crawled": 0,
    }

    for index, thread in enumerate(threads, start=1):
        url = thread.get("url")
        if not url:
            continue

        print(f"[{index}/{len(threads)}] Crawling {url}", flush=True)
        result = await crawl_one_thread(url, max_pages=max_pages)
        if result.get("status") == "already_running":
            summary["threads_skipped_running"] += 1
            continue

        summary["threads_started"] += 1
        summary["pages_crawled"] += int(result.get("pages_crawled") or 0)
        if result.get("status") == "error":
            summary["threads_failed"] += 1

        if delay_seconds > 0 and index < len(threads):
            await asyncio.sleep(delay_seconds)

    return summary


async def run(args: argparse.Namespace) -> dict:
    from database.mongodb import close, connect

    await connect()
    try:
        if args.url:
            result = await crawl_one_thread(args.url, max_pages=args.max_pages)
            return {
                "threads_total": 1,
                "threads_started": 0 if result.get("status") == "already_running" else 1,
                "threads_skipped_running": 1 if result.get("status") == "already_running" else 0,
                "threads_failed": 1 if result.get("status") == "error" else 0,
                "pages_crawled": int(result.get("pages_crawled") or 0),
            }
        return await crawl_configured_threads(
            max_pages=args.max_pages,
            delay_seconds=args.delay_seconds,
            seed_defaults=args.seed_default_threads,
        )
    finally:
        await close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Crawl Voz review data manually and write directly to MongoDB Atlas."
    )
    parser.add_argument("--url", help="Crawl one Voz thread URL. Defaults to all configured threads.")
    parser.add_argument("--max-pages", type=int, default=0, help="Pages per thread. 0 means crawl until current end.")
    parser.add_argument("--delay-seconds", type=float, default=5.0, help="Delay between configured threads.")
    parser.add_argument(
        "--env-file",
        default=".env.local",
        help="Optional env file to load before importing config. Defaults to .env.local.",
    )
    parser.add_argument(
        "--seed-default-threads",
        action="store_true",
        help="Insert built-in thread URLs into the destination database before crawling.",
    )
    parser.add_argument(
        "--allow-local",
        action="store_true",
        help="Allow non-Atlas MongoDB URIs for local development.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    os.environ.setdefault("HOURLY_CRAWL_SCHEDULER_ENABLED", "false")
    load_env_file(ROOT_DIR / args.env_file)
    require_atlas_uri(allow_local=args.allow_local)

    summary = asyncio.run(run(args))
    print(
        "Crawl complete: "
        f"threads={summary['threads_total']}, "
        f"started={summary['threads_started']}, "
        f"skipped={summary['threads_skipped_running']}, "
        f"failed={summary['threads_failed']}, "
        f"pages={summary['pages_crawled']}",
        flush=True,
    )


if __name__ == "__main__":
    main()
