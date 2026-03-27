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
from database.mongodb import connect, close, sync_offers_for_post, delete_offer_by_post_id, normalize_review_companies


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
                "companies": 1,
                "content": 1,
            },
        )
        async for doc in cursor:
            scanned += 1
            companies = normalize_review_companies(doc)
            company = companies[0] if companies else crawler._apply_company_alias(doc.get("company") or "Unknown")
            offer_docs = crawler._extract_offers(
                doc.get("content") or "",
                company,
                doc.get("voz_thread_id") or "",
                doc.get("voz_post_id"),
                companies,
            )

            if offer_docs:
                upserted, created, deleted = await sync_offers_for_post(doc.get("voz_post_id"), offer_docs)
                offers_upserted += upserted
                offers_created += created
                stale_offers_deleted += deleted
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
