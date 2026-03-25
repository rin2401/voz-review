"""Normalize company names, apply alias mapping, and rebuild company summaries."""
import asyncio
import json
import sys
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import config
from crawler.voz_scraper import VozCrawler
from database.mongodb import connect, close

ALIASES_PATH = ROOT_DIR / "data" / "company_aliases.json"


async def rebuild_companies(db) -> int:
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
    return len(docs)


async def main():
    crawler = VozCrawler()
    alias_map = {}
    if ALIASES_PATH.exists():
        alias_map = json.loads(ALIASES_PATH.read_text(encoding="utf-8"))

    await connect()
    client = AsyncIOMotorClient(config.MONGO_URI)
    db = client[config.MONGO_DB]

    scanned = 0
    normalized_updates = 0
    alias_updates = 0
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
                normalized_updates += 1

        for alias, canonical in alias_map.items():
            if not alias or not canonical or alias == canonical:
                continue
            result = await db.reviews.update_many(
                {"company": alias},
                {"$set": {"company": canonical}},
            )
            alias_updates += result.modified_count

        rebuilt_companies = await rebuild_companies(db)

        print(
            {
                "scanned_reviews": scanned,
                "normalized_updates": normalized_updates,
                "alias_updates": alias_updates,
                "aliases_loaded": len(alias_map),
                "rebuilt_companies": rebuilt_companies,
                "alias_file": str(ALIASES_PATH),
            }
        )
    finally:
        client.close()
        await close()


if __name__ == "__main__":
    asyncio.run(main())
