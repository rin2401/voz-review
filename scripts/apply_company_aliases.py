"""Apply company alias mapping to reviews and rebuild company summaries."""
import asyncio
import json
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from database.mongodb import connect, close, get_database, prepare_review_document, rebuild_companies_collection

ALIASES_PATH = ROOT_DIR / "data" / "company_aliases.json"


async def main():
    if not ALIASES_PATH.exists():
        raise SystemExit(f"Alias file not found: {ALIASES_PATH}")

    alias_map = json.loads(ALIASES_PATH.read_text(encoding="utf-8"))

    await connect()
    db = get_database()

    changed_reviews = 0
    rebuilt_companies = 0

    try:
        cursor = db.reviews.find({}, {"_id": 1, "company": 1, "companies": 1})
        async for review in cursor:
            original_company = review.get("company")
            original_companies = list(review.get("companies") or [])

            mapped_company = alias_map.get(original_company, original_company)
            mapped_companies = [alias_map.get(company, company) for company in original_companies]
            updated_review = prepare_review_document(
                {
                    "company": mapped_company,
                    "companies": mapped_companies,
                }
            )

            if (
                updated_review["company"] != original_company
                or updated_review["companies"] != original_companies
            ):
                result = await db.reviews.update_one(
                    {"_id": review["_id"]},
                    {"$set": {"company": updated_review["company"], "companies": updated_review["companies"]}},
                )
                changed_reviews += result.modified_count

        rebuilt_companies = await rebuild_companies_collection(db)

        print(
            {
                "aliases_loaded": len(alias_map),
                "changed_reviews": changed_reviews,
                "rebuilt_companies": rebuilt_companies,
                "alias_file": str(ALIASES_PATH),
            }
        )
    finally:
        await close()


if __name__ == "__main__":
    asyncio.run(main())
