"""Apply company alias mapping to reviews and rebuild company summaries."""
import asyncio
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from database.company_aliases import load_company_alias_map, resolve_canonical_company
from database.mongodb import connect, close, fill_company_aliases, get_database, normalize_review_companies, prepare_review_document, rebuild_companies_collection

ALIASES_PATH = ROOT_DIR / "data" / "company_aliases.json"


async def main():
    if not ALIASES_PATH.exists():
        raise SystemExit(f"Alias file not found: {ALIASES_PATH}")

    alias_map = load_company_alias_map()

    await connect()
    db = get_database()

    changed_reviews = 0
    rebuilt_companies = 0
    alias_fill_result = {"updated_companies": 0, "missing_canonical_companies": [], "missing_canonical_count": 0}

    try:
        cursor = db.reviews.find({}, {"_id": 1, "company": 1, "companies": 1})
        async for review in cursor:
            original_companies = normalize_review_companies(review, allow_legacy_fallback=False)
            mapped_companies = [resolve_canonical_company(company, alias_map=alias_map) for company in original_companies]
            updated_review = prepare_review_document(
                {
                    "company": resolve_canonical_company(review.get("company"), alias_map=alias_map),
                    "companies": mapped_companies,
                }
            )

            if updated_review["companies"] != original_companies:
                result = await db.reviews.update_one(
                    {"_id": review["_id"]},
                    {"$set": {"companies": updated_review["companies"]}},
                )
                changed_reviews += result.modified_count

        rebuilt_companies = await rebuild_companies_collection(db)
        alias_fill_result = await fill_company_aliases(db)

        print(
            {
                "aliases_loaded": len(alias_map),
                "changed_reviews": changed_reviews,
                "rebuilt_companies": rebuilt_companies,
                "updated_company_aliases": alias_fill_result["updated_companies"],
                "missing_canonical_companies": alias_fill_result["missing_canonical_companies"],
                "alias_file": str(ALIASES_PATH),
            }
        )
    finally:
        await close()


if __name__ == "__main__":
    asyncio.run(main())
