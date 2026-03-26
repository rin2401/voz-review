"""Backfill structured offers from existing reviews into the offers collection."""
import asyncio
import sys
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import config
from crawler.voz_scraper import VozCrawler
from database.mongodb import connect, close, upsert_offer, delete_offer_by_post_id


async def main():
    crawler = VozCrawler()

    await connect()
    client = AsyncIOMotorClient(config.MONGO_URI)
    db = client[config.MONGO_DB]

    scanned = 0
    offers_upserted = 0
    offers_created = 0
    stale_offers_deleted = 0
    skipped_unknown_company = 0

    try:
        cursor = db.reviews.find(
            {"content": {"$exists": True, "$nin": [None, ""]}},
            {
                "_id": 1,
                "voz_thread_id": 1,
                "voz_post_id": 1,
                "company": 1,
                "content": 1,
            },
        )
        async for doc in cursor:
            scanned += 1
            company = doc.get("company") or crawler._extract_company(doc.get("content") or "")
            offer_doc = crawler._extract_offer(
                doc.get("content") or "",
                company,
                doc.get("voz_thread_id") or "",
                doc.get("voz_post_id"),
                source_review_id=str(doc.get("_id")),
            )

            if offer_doc:
                _, created = await upsert_offer(offer_doc)
                offers_upserted += 1
                if created:
                    offers_created += 1
            else:
                if not company or company == "Unknown":
                    skipped_unknown_company += 1
                stale_offers_deleted += await delete_offer_by_post_id(doc.get("voz_post_id"))

        print(
            {
                "scanned_reviews": scanned,
                "offers_upserted": offers_upserted,
                "offers_created": offers_created,
                "stale_offers_deleted": stale_offers_deleted,
                "skipped_unknown_company": skipped_unknown_company,
            }
        )
    finally:
        client.close()
        await close()


if __name__ == "__main__":
    asyncio.run(main())
