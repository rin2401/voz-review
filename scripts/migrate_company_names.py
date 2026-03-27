"""Backfill review companies, apply aliases, refresh salary/thread fields, and rebuild company summaries."""
import asyncio
import json
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from crawler.voz_scraper import VozCrawler
from database.mongodb import connect, close, get_database, prepare_review_document, rebuild_companies_collection

ALIASES_PATH = ROOT_DIR / "data" / "company_aliases.json"

async def main():
    crawler = VozCrawler()
    alias_map = {}
    if ALIASES_PATH.exists():
        alias_map = json.loads(ALIASES_PATH.read_text(encoding="utf-8"))

    await connect()
    db = get_database()

    scanned = 0
    company_updates = 0
    salary_updates = 0
    thread_id_updates = 0
    rebuilt_companies = 0

    try:
        cursor = db.reviews.find(
            {"content": {"$exists": True, "$nin": [None, ""]}},
            {"_id": 1, "company": 1, "companies": 1, "content": 1, "monthly_salary_million": 1, "url": 1, "voz_thread_id": 1},
        )
        async for doc in cursor:
            scanned += 1
            updates = {}

            reparsed_companies = crawler._extract_companies(doc.get("content") or "")
            fallback_company = reparsed_companies[0] if reparsed_companies else (doc.get("company") or "Unknown")
            updated_review = prepare_review_document(
                {
                    "company": alias_map.get(fallback_company, fallback_company),
                    "companies": [alias_map.get(company, company) for company in reparsed_companies],
                }
            )
            if updated_review["companies"] != list(doc.get("companies") or []):
                updates["companies"] = updated_review["companies"]
                company_updates += 1

            salary = crawler._extract_monthly_salary_million(doc.get("content") or "")
            if salary != doc.get("monthly_salary_million"):
                updates["monthly_salary_million"] = salary
                salary_updates += 1

            thread_id = crawler._extract_thread_id(doc.get("url") or "")
            if thread_id and thread_id != doc.get("voz_thread_id"):
                updates["voz_thread_id"] = thread_id
                thread_id_updates += 1

            if updates:
                await db.reviews.update_one({"_id": doc["_id"]}, {"$set": updates})

        rebuilt_companies = await rebuild_companies_collection(db)

        print(
            {
                "scanned_reviews": scanned,
                "company_updates": company_updates,
                "salary_updates": salary_updates,
                "thread_id_updates": thread_id_updates,
                "aliases_loaded": len(alias_map),
                "rebuilt_companies": rebuilt_companies,
                "alias_file": str(ALIASES_PATH),
            }
        )
    finally:
        await close()


if __name__ == "__main__":
    asyncio.run(main())
