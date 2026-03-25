"""Normalize company names, apply alias mapping, backfill monthly salary, and rebuild company summaries."""
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
                "latest_review": {"$max": "$post_date"},
                "created_at": {"$min": "$created_at"},
                "max_monthly_salary_million": {"$max": "$monthly_salary_million"},
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
                "latest_post_date": row.get("latest_review"),
                "max_monthly_salary_million": row.get("max_monthly_salary_million"),
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
    salary_updates = 0
    alias_updates = 0
    rebuilt_companies = 0

    try:
        cursor = db.reviews.find(
            {"content": {"$exists": True, "$nin": [None, ""]}},
            {"_id": 1, "company": 1, "content": 1, "monthly_salary_million": 1},
        )
        async for doc in cursor:
            scanned += 1
            updates = {}

            reparsed_company = crawler._extract_company(doc.get("content") or "")
            if reparsed_company != (doc.get("company") or "Unknown"):
                updates["company"] = reparsed_company
                normalized_updates += 1

            salary = crawler._extract_monthly_salary_million(doc.get("content") or "")
            if salary != doc.get("monthly_salary_million"):
                updates["monthly_salary_million"] = salary
                salary_updates += 1

            if updates:
                await db.reviews.update_one({"_id": doc["_id"]}, {"$set": updates})

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
                "salary_updates": salary_updates,
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
