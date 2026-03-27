"""Backfill empty voz_thread_id values by parsing them from review URLs."""
import asyncio
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from crawler.voz_scraper import VozCrawler
from database.mongodb import connect, close, get_database


async def main():
    crawler = VozCrawler()

    await connect()
    db = get_database()

    scanned = 0
    updated = 0
    skipped_no_url = 0
    skipped_no_match = 0

    try:
        cursor = db.reviews.find(
            {
                "$or": [
                    {"voz_thread_id": ""},
                    {"voz_thread_id": None},
                    {"voz_thread_id": {"$exists": False}},
                ]
            },
            {"_id": 1, "url": 1, "voz_thread_id": 1},
        )

        async for doc in cursor:
            scanned += 1
            url = doc.get("url") or ""
            if not url:
                skipped_no_url += 1
                continue

            thread_id = crawler._extract_thread_id(url)
            if not thread_id:
                skipped_no_match += 1
                continue

            result = await db.reviews.update_one(
                {"_id": doc["_id"]},
                {"$set": {"voz_thread_id": thread_id}},
            )
            updated += result.modified_count

        print(
            {
                "scanned_reviews": scanned,
                "thread_id_updates": updated,
                "skipped_no_url": skipped_no_url,
                "skipped_no_match": skipped_no_match,
            }
        )
    finally:
        await close()


if __name__ == "__main__":
    asyncio.run(main())
