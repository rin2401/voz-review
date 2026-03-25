"""Normalize company names in reviews and rebuild company summaries."""
import asyncio
import sys
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import config
from crawler.voz_scraper import VozCrawler
from database.mongodb import connect, close


async def main():
    crawler = VozCrawler()
    await connect()
    client = AsyncIOMotorClient(config.MONGO_URI)
    db = client[config.MONGO_DB]

    scanned = 0
    updated = 0
    rebuilt_companies = 0

    try:
        cursor = db.reviews.find(
            {"company": {"$exists": True, "$nin": [None, "", "Unknown"]}},
            {"_id": 1, "company": 1},
        )
        async for doc in cursor:
            scanned += 1
            old_name = doc.get("company")
            new_name = crawler._clean_company_name(old_name)
            if new_name and new_name != old_name:
                await db.reviews.update_one(
                    {"_id": doc["_id"]},
                    {"$set": {"company": new_name}},
                )
                updated += 1

        await db.companies.delete_many({})
        pipeline = [
            {"$match": {"company": {"$exists": True, "$nin": [None, "", "Unknown"]}}},
            {
                "$group": {
                    "_id": "$company",
                    "review_count": {"$sum": 1},
                    "latest_review": {"$max": "$created_at"},
                    "created_at": {"$min": "$created_at"},
                }
            },
        ]

        docs = []
        async for row in db.reviews.aggregate(pipeline):
            docs.append(
                {
                    "name": row["_id"],
                    "review_count": row["review_count"],
                    "created_at": row.get("created_at"),
                    "updated_at": row.get("latest_review"),
                }
            )

        if docs:
            await db.companies.insert_many(docs)
            rebuilt_companies = len(docs)

        print(
            {
                "scanned_reviews": scanned,
                "updated_reviews": updated,
                "rebuilt_companies": rebuilt_companies,
            }
        )
    finally:
        client.close()
        await close()


if __name__ == "__main__":
    asyncio.run(main())
