"""MongoDB database connection and operations"""
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, TEXT
from pymongo.errors import DuplicateKeyError
from datetime import datetime
from typing import Optional, List
import re
import config

client: Optional[AsyncIOMotorClient] = None
db = None


async def connect():
    """Initialize database connection"""
    global client, db
    client = AsyncIOMotorClient(config.MONGO_URI)
    db = client[config.MONGO_DB]
    
    # Create indexes
    await create_indexes()
    print(f"✅ Connected to MongoDB: {config.MONGO_DB}")


async def close():
    """Close database connection"""
    global client
    if client:
        client.close()
        print("🔌 MongoDB connection closed")


async def create_indexes():
    """Create necessary indexes for performance"""
    # Reviews collection
    reviews = db.reviews
    await reviews.create_index([("company", TEXT), ("content", TEXT)])
    await reviews.create_index("company")
    await reviews.create_index("created_at")
    await reviews.create_index("voz_thread_id")

    # Replace old non-unique voz_post_id index with unique partial index
    existing_indexes = await reviews.index_information()
    voz_post_index = existing_indexes.get("voz_post_id_1")
    if voz_post_index and not voz_post_index.get("unique"):
        await reviews.drop_index("voz_post_id_1")

    await reviews.create_index(
        "voz_post_id",
        unique=True,
        partialFilterExpression={"voz_post_id": {"$exists": True, "$type": "string"}}
    )
    await reviews.create_index("reply_post_id")
    await reviews.create_index([("company", ASCENDING), ("created_at", ASCENDING)])
    
    # Companies collection (for aggregation)
    companies = db.companies
    await companies.create_index("name", unique=True)
    
    # Crawl state (for tracking last crawl)
    crawl_state = db.crawl_state
    await crawl_state.create_index("forum_id", unique=True)

    # Threads collection
    threads = db.threads
    await threads.create_index("url", unique=True)
    await threads.create_index("thread_id", unique=True, sparse=True)


async def get_all_companies(sort_by: str = "recent_review") -> List[dict]:
    """Get all companies with review counts"""
    sort_map = {
        "az": [("name", ASCENDING)],
        "most_review": [("review_count", -1), ("name", ASCENDING)],
        "recent_review": [("updated_at", -1), ("name", ASCENDING)],
        "salary_desc": [("max_monthly_salary_million", -1), ("review_count", -1), ("name", ASCENDING)],
    }
    cursor = db.companies.find({}).sort(sort_map.get(sort_by, sort_map["az"]))
    return await cursor.to_list(length=None)


async def get_reviews_by_company(
    company: str, 
    limit: int = 50, 
    skip: int = 0,
    status: str = None
) -> List[dict]:
    """Get reviews for a specific company"""
    # Escape regex special characters in company name
    escaped_company = re.escape(company)
    query = {"company": {"$regex": f"^{escaped_company}$", "$options": "i"}}
    if status:
        query["status"] = status
    
    cursor = db.reviews.find(query).sort("created_at", -1).skip(skip).limit(limit)
    return await cursor.to_list(length=limit)


async def get_review_count(company: str = None, status: str = None) -> int:
    """Count reviews, optionally filtered by company or status"""
    query = {}
    if company:
        escaped_company = re.escape(company)
        query["company"] = {"$regex": f"^{escaped_company}$", "$options": "i"}
    if status:
        query["status"] = status
    return await db.reviews.count_documents(query)


async def upsert_company(name: str) -> dict:
    """Create or update company, return updated doc"""
    now = datetime.utcnow()
    # Use exact match for upsert to avoid regex issues
    result = await db.companies.find_one_and_update(
        {"name": name},
        {
            "$set": {"updated_at": now},
            "$setOnInsert": {"created_at": now, "review_count": 0}
        },
        upsert=True,
        return_document=True
    )
    return result


async def increment_company_review_count(company_name: str):
    """Increment review count for company"""
    await db.companies.update_one(
        {"name": company_name},
        {"$inc": {"review_count": 1}}
    )


async def insert_review(review_data: dict) -> tuple[str | None, bool]:
    """Insert a new review, return (inserted_id, inserted_new)"""
    review_data["created_at"] = datetime.utcnow()
    review_data["status"] = config.STATUS_PENDING
    try:
        result = await db.reviews.insert_one(review_data)
        return str(result.inserted_id), True
    except DuplicateKeyError:
        return None, False


async def get_crawl_state(forum_id: str) -> Optional[dict]:
    """Get last crawl timestamp for a forum"""
    return await db.crawl_state.find_one({"forum_id": forum_id})


async def update_crawl_state(forum_id: str, last_post_date: datetime, last_page: int):
    """Update crawl state after successful crawl"""
    await db.crawl_state.update_one(
        {"forum_id": forum_id},
        {
            "$set": {
                "last_crawl": datetime.utcnow(),
                "last_post_date": last_post_date,
                "last_page": last_page
            }
        },
        upsert=True
    )


async def get_replies_for_posts(post_ids: List[str]) -> List[dict]:
    """Get replies whose reply_post_id points to any of the given post IDs."""
    if not post_ids:
        return []
    cursor = db.reviews.find(
        {"reply_post_id": {"$in": post_ids}}
    ).sort("created_at", 1)
    return await cursor.to_list(length=None)


async def get_all_threads() -> List[dict]:
    """Get all configured crawl threads from DB."""
    cursor = db.threads.find({}).sort("created_at", -1)
    return await cursor.to_list(length=None)


async def upsert_thread(url: str, title: str = None, thread_id: str = None, kind: str = "thread"):
    """Create or update a crawl thread config."""
    now = datetime.utcnow()
    await db.threads.update_one(
        {"url": url},
        {
            "$set": {
                "title": title or url,
                "thread_id": thread_id,
                "kind": kind,
                "updated_at": now,
            },
            "$setOnInsert": {"created_at": now},
        },
        upsert=True,
    )


async def seed_threads(thread_urls: List[str]):
    """Seed DB thread configs from legacy code constants if missing."""
    for url in thread_urls:
        thread_id_match = re.search(r'/t(?:/[^/]*?)?\.(\d+)(?:/|$)', url)
        thread_id = thread_id_match.group(1) if thread_id_match else None
        await upsert_thread(url=url, thread_id=thread_id)


async def search_reviews(
    keyword: str, 
    limit: int = 50, 
    skip: int = 0
) -> List[dict]:
    """Full-text search across reviews"""
    cursor = db.reviews.find(
        {"$text": {"$search": keyword}}
    ).sort("created_at", -1).skip(skip).limit(limit)
    return await cursor.to_list(length=limit)
