"""Apply company alias mapping to reviews and rebuild company summaries."""
import asyncio
import json
import sys
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import config
from database.mongodb import connect, close

ALIASES_PATH = ROOT_DIR / "data" / "company_aliases.json"


async def main():
    if not ALIASES_PATH.exists():
        raise SystemExit(f"Alias file not found: {ALIASES_PATH}")

    alias_map = json.loads(ALIASES_PATH.read_text(encoding="utf-8"))

    await connect()
    client = AsyncIOMotorClient(config.MONGO_URI)
    db = client[config.MONGO_DB]

    changed_reviews = 0
    rebuilt_companies = 0

    try:
        for alias, canonical in alias_map.items():
            if not alias or not canonical or alias == canonical:
                continue
            result = await db.reviews.update_many(
                {"company": alias},
                {"$set": {"company": canonical}},
            )
            changed_reviews += result.modified_count

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
            {"$sort": {"_id": 1}},
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
                "aliases_loaded": len(alias_map),
                "changed_reviews": changed_reviews,
                "rebuilt_companies": rebuilt_companies,
                "alias_file": str(ALIASES_PATH),
            }
        )
    finally:
        client.close()
        await close()


if __name__ == "__main__":
    asyncio.run(main())
