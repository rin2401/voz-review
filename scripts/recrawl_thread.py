"""Run a clean thread crawl with proper DB lifecycle."""
import asyncio
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from crawler.voz_scraper import THREAD_URLS
from database.mongodb import connect, close
from main import crawl_thread


async def main():
    await connect()
    try:
        url = THREAD_URLS[0]
        print(f"Starting crawl: {url}")
        await crawl_thread(url, 0)
    finally:
        await close()


if __name__ == "__main__":
    asyncio.run(main())
