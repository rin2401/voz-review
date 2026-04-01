"""Remove legacy summary fields from companies documents.

This is safe after company summaries are derived from reviews at read time.
"""
import asyncio
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from database.mongodb import close, connect, get_database

LEGACY_FIELDS = {
    "review_count": "",
    "latest_post_date": "",
    "max_monthly_salary_million": "",
}


async def main():
    await connect()
    db = get_database()
    try:
        result = await db.companies.update_many({}, {"$unset": LEGACY_FIELDS})
        print(
            {
                "matched_count": result.matched_count,
                "modified_count": result.modified_count,
                "unset_fields": sorted(LEGACY_FIELDS.keys()),
            }
        )
    finally:
        await close()


if __name__ == "__main__":
    asyncio.run(main())
