"""Reset crawl data collections for a clean re-crawl."""
import asyncio

from motor.motor_asyncio import AsyncIOMotorClient

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
