"""Reset crawl data collections for a clean re-crawl."""
import asyncio
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from database.mongodb import close, connect, get_database


async def main():
    await connect()
    db = get_database()

    collections = ["reviews", "companies", "threads", "offers"]

    try:
        for name in collections:
            result = await db[name].delete_many({})
            print(f"Cleared {name}: {result.deleted_count} documents")
    finally:
        await close()

    print("Done. Database is ready for a fresh crawl.")


if __name__ == "__main__":
    asyncio.run(main())
