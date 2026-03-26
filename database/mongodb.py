"""MongoDB database connection and operations"""
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, TEXT
from pymongo import ReturnDocument
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
    
    # Threads collection
    threads = db.threads
    await threads.create_index("url", unique=True)
    await threads.create_index("thread_id", unique=True, sparse=True)

    # Offers collection
    offers = db.offers
    await offers.create_index(
        "voz_post_id",
        unique=True,
        partialFilterExpression={"voz_post_id": {"$exists": True, "$type": "string"}}
    )
    await offers.create_index("company")
    await offers.create_index("voz_thread_id")
    await offers.create_index("offer_year")
    await offers.create_index("updated_at")


async def get_all_companies(sort_by: str = "recent_review") -> List[dict]:
    """Get all companies with review counts"""
    sort_map = {
        "az": [("name", ASCENDING)],
        "most_review": [("review_count", -1), ("name", ASCENDING)],
        "recent_review": [("latest_post_date", -1), ("name", ASCENDING)],
        "salary_desc": [("max_monthly_salary_million", -1), ("review_count", -1), ("name", ASCENDING)],
    }
    cursor = db.companies.find({}).sort(sort_map.get(sort_by, sort_map["az"]))
    return await cursor.to_list(length=None)


async def get_reviews_by_company(
    company: str, 
    limit: int = 50, 
    skip: int = 0,
    status: str = None,
    thread_id: str = None,
    salary_only: bool = False,
    interview_only: bool = False,
) -> List[dict]:
    """Get reviews for a specific company"""
    # Escape regex special characters in company name
    escaped_company = re.escape(company)
    query = {"company": {"$regex": f"^{escaped_company}$", "$options": "i"}}
    if status:
        query["status"] = status
    if thread_id:
        query["voz_thread_id"] = thread_id
    if salary_only:
        query["content"] = {"$regex": r"lương", "$options": "i"}
    if interview_only:
        query["content"] = {"$regex": r"phỏng vấn", "$options": "i"}

    cursor = db.reviews.find(query).sort("post_date", -1).skip(skip).limit(limit)
    return await cursor.to_list(length=limit)


async def get_review_count(company: str = None, status: str = None, thread_id: str = None, salary_only: bool = False, interview_only: bool = False) -> int:
    """Count reviews, optionally filtered by company or status"""
    query = {}
    if company:
        escaped_company = re.escape(company)
        query["company"] = {"$regex": f"^{escaped_company}$", "$options": "i"}
    if status:
        query["status"] = status
    if thread_id:
        query["voz_thread_id"] = thread_id
    if salary_only:
        query["content"] = {"$regex": r"lương", "$options": "i"}
    if interview_only:
        query["content"] = {"$regex": r"phỏng vấn", "$options": "i"}
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


async def upsert_offer(offer_data: dict) -> tuple[str | None, bool]:
    """Create or update an extracted offer, keyed by voz_post_id when available."""
    voz_post_id = offer_data.get("voz_post_id")
    if not voz_post_id:
        return None, False

    now = datetime.utcnow()
    payload = {k: v for k, v in offer_data.items() if k != "created_at"}
    payload["updated_at"] = now

    result = await db.offers.find_one_and_update(
        {"voz_post_id": voz_post_id},
        {
            "$set": payload,
            "$setOnInsert": {"created_at": now},
        },
        upsert=True,
        return_document=ReturnDocument.BEFORE,
    )
    return voz_post_id, result is None


async def delete_offer_by_post_id(voz_post_id: str) -> int:
    """Delete a stale extracted offer by VOZ post id."""
    if not voz_post_id:
        return 0
    result = await db.offers.delete_one({"voz_post_id": voz_post_id})
    return result.deleted_count


async def get_thread_state(thread_id: str = None, url: str = None) -> Optional[dict]:
    """Get crawl progress directly from threads collection."""
    query = {}
    if thread_id:
        query["thread_id"] = thread_id
    elif url:
        query["url"] = url
    else:
        return None
    return await db.threads.find_one(query)


async def update_thread_state(thread_id: str = None, url: str = None, last_post_date: datetime = None, last_page: int = None):
    """Update crawl progress directly in threads collection."""
    query = {}
    if thread_id:
        query["thread_id"] = thread_id
    elif url:
        query["url"] = url
    else:
        return

    await db.threads.update_one(
        query,
        {
            "$set": {
                "last_crawl": datetime.utcnow(),
                "last_post_date": last_post_date,
                "last_page": last_page,
            }
        },
    )


async def set_thread_crawl_status(url: str, status: str, error: str = None):
    """Set crawl job status on thread row."""
    payload = {"crawl_status": status, "updated_at": datetime.utcnow()}
    if status == "running":
        payload["crawl_error"] = None
    elif error:
        payload["crawl_error"] = error
    await db.threads.update_one({"url": url}, {"$set": payload})


async def get_replies_for_posts(post_ids: List[str]) -> List[dict]:
    """Get replies whose reply_post_id points to any of the given post IDs."""
    if not post_ids:
        return []
    cursor = db.reviews.find(
        {"reply_post_id": {"$in": post_ids}}
    ).sort("created_at", 1)
    return await cursor.to_list(length=None)


async def get_posts_by_ids(post_ids: List[str]) -> List[dict]:
    """Get posts by voz_post_id for reply context rendering."""
    if not post_ids:
        return []
    cursor = db.reviews.find({"voz_post_id": {"$in": post_ids}})
    return await cursor.to_list(length=None)


async def get_all_threads() -> List[dict]:
    """Get all configured crawl threads from DB."""
    return await db.threads.find({}).sort("created_at", -1).to_list(length=None)


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


async def get_company_thread_ids(company: str) -> List[str]:
    """Get distinct VOZ thread IDs for a company, sorted descending."""
    escaped_company = re.escape(company)
    ids = await db.reviews.distinct(
        "voz_thread_id",
        {"company": {"$regex": f"^{escaped_company}$", "$options": "i"}, "voz_thread_id": {"$exists": True, "$nin": [None, ""]}},
    )
    return sorted([str(x) for x in ids if x], reverse=True)


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
