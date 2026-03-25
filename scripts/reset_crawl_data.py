"""Reset crawl data collections for a clean re-crawl."""
import asyncio
import sys
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import config


async def main():
    client = AsyncIOMotorClient(config.MONGO_URI)
    db = client[config.MONGO_DB]

    collections = ["reviews", "companies", "crawl_state"]

    for name in collections:
        result = await db[name].delete_many({})
        print(f"Cleared {name}: {result.deleted_count} documents")

    client.close()
    print("Done. Database is ready for a fresh crawl.")


if __name__ == "__main__":
    asyncio.run(main())
