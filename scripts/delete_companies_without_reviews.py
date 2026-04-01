"""Delete company documents that no longer have any matching reviews."""
import asyncio
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from database.mongodb import close, connect, get_database, build_company_aggregation_pipeline


async def main():
    await connect()
    db = get_database()
    try:
        active_company_names = set()
        async for row in db.reviews.aggregate(build_company_aggregation_pipeline()):
            name = str(row.get("_id") or "").strip()
            if name:
                active_company_names.add(name)

        existing_company_names = []
        async for doc in db.companies.find({}, {"name": 1}):
            name = str(doc.get("name") or "").strip()
            if name:
                existing_company_names.append(name)

        orphan_names = sorted(name for name in existing_company_names if name not in active_company_names)
        if orphan_names:
            result = await db.companies.delete_many({"name": {"$in": orphan_names}})
            deleted_count = result.deleted_count
        else:
            deleted_count = 0

        print(
            {
                "existing_companies": len(existing_company_names),
                "active_companies": len(active_company_names),
                "orphan_companies": len(orphan_names),
                "deleted_count": deleted_count,
                "sample_deleted": orphan_names[:20],
            }
        )
    finally:
        await close()


if __name__ == "__main__":
    asyncio.run(main())
