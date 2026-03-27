"""MongoDB and Beanie database initialization plus query helpers."""
from datetime import datetime
import re
from typing import Any, Optional

from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, TEXT
from pymongo.errors import DuplicateKeyError

import config
from database.beanie_compat import init_beanie
from database.models import CompanyDocument, OfferDocument, ReviewDocument, ThreadDocument

client: Optional[AsyncIOMotorClient] = None
db = None


def _document_to_dict(document: Any) -> dict:
    payload = document.model_dump(mode="python")
    payload.pop("id", None)
    return payload


def get_database():
    """Return the active Mongo database handle."""
    return db


async def connect():
    """Initialize database connection and Beanie documents."""
    global client, db
    if client is not None and db is not None:
        return

    client = AsyncIOMotorClient(config.MONGO_URI)
    db = client[config.MONGO_DB]
    await init_beanie(
        database=db,
        document_models=[
            ReviewDocument,
            CompanyDocument,
            ThreadDocument,
            OfferDocument,
        ],
    )

    await create_indexes()
    print(f"✅ Connected to MongoDB via Beanie: {config.MONGO_DB}")


async def close():
    """Close database connection."""
    global client, db
    if client:
        client.close()
        client = None
        db = None
        print("🔌 MongoDB connection closed")


async def create_indexes():
    """Create and clean up indexes for compatibility with legacy collection shapes."""
    reviews = ReviewDocument.get_motor_collection()
    existing_indexes = await reviews.index_information()
    for index_name, index_info in existing_indexes.items():
        if index_name == "_id_":
            continue
        keys = index_info.get("key", [])
        if keys and keys[0][0] == "_fts" and index_name != "company_text_companies_text_content_text":
            await reviews.drop_index(index_name)

    await reviews.create_index([("company", TEXT), ("companies", TEXT), ("content", TEXT)])
    await reviews.create_index("company")
    await reviews.create_index("companies")
    await reviews.create_index("created_at")
    await reviews.create_index("voz_thread_id")

    existing_indexes = await reviews.index_information()
    voz_post_index = existing_indexes.get("voz_post_id_1")
    if voz_post_index and not voz_post_index.get("unique"):
        await reviews.drop_index("voz_post_id_1")

    await reviews.create_index(
        "voz_post_id",
        unique=True,
        partialFilterExpression={"voz_post_id": {"$exists": True, "$type": "string"}},
    )
    await reviews.create_index("reply_post_id")
    await reviews.create_index([("company", ASCENDING), ("created_at", ASCENDING)])
    await reviews.create_index([("companies", ASCENDING), ("created_at", ASCENDING)])

    companies = CompanyDocument.get_motor_collection()
    await companies.create_index("name", unique=True)

    threads = ThreadDocument.get_motor_collection()
    await threads.create_index("url", unique=True)
    await threads.create_index("thread_id", unique=True, sparse=True)

    offers = OfferDocument.get_motor_collection()
    existing_offer_indexes = await offers.index_information()
    for index_name, index_info in existing_offer_indexes.items():
        keys = index_info.get("key", [])
        key_names = [field for field, _ in keys]
        if index_name == "_id_":
            continue
        if key_names == ["voz_post_id"] and index_info.get("unique"):
            await offers.drop_index(index_name)
        if key_names == ["voz_post_id", "company"]:
            await offers.drop_index(index_name)
        if key_names == ["voz_post_id", "offer_index"] and not index_info.get("unique"):
            await offers.drop_index(index_name)

    await offers.create_index(
        [("voz_post_id", ASCENDING), ("offer_index", ASCENDING)],
        unique=True,
        partialFilterExpression={
            "voz_post_id": {"$exists": True, "$type": "string"},
            "offer_index": {"$exists": True, "$type": "number"},
        },
    )
    await offers.create_index("company")
    await offers.create_index("voz_thread_id")
    await offers.create_index("offer_year")
    await offers.create_index("updated_at")


async def get_all_companies(sort_by: str = "recent_review") -> list[dict]:
    """Get all companies with review counts."""
    sort_map = {
        "az": [("name", ASCENDING)],
        "most_review": [("review_count", -1), ("name", ASCENDING)],
        "recent_review": [("latest_post_date", -1), ("name", ASCENDING)],
        "salary_desc": [("max_monthly_salary_million", -1), ("review_count", -1), ("name", ASCENDING)],
    }
    cursor = CompanyDocument.get_motor_collection().find({}).sort(sort_map.get(sort_by, sort_map["az"]))
    companies = await cursor.to_list(length=None)
    for company in companies:
        company.setdefault("review_count", 0)
        company.setdefault("latest_post_date", None)
        company.setdefault("max_monthly_salary_million", None)
    return companies


def normalize_review_companies(review_doc: dict) -> list[str]:
    companies = review_doc.get("companies")
    if isinstance(companies, list):
        normalized = []
        seen = set()
        for raw_company in companies:
            company = (raw_company or "").strip()
            if not company or company == "Unknown":
                continue
            key = company.lower()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(company)
        if normalized:
            return normalized

    fallback = (review_doc.get("company") or "").strip()
    if fallback and fallback != "Unknown":
        return [fallback]
    return []


def prepare_review_document(review_doc: dict) -> dict:
    normalized_companies = normalize_review_companies(review_doc)
    review_doc["companies"] = normalized_companies
    review_doc["company"] = normalized_companies[0] if normalized_companies else "Unknown"
    return review_doc


def build_company_match(company: str) -> dict:
    escaped_company = re.escape(company)
    company_regex = {"$regex": f"^{escaped_company}$", "$options": "i"}
    return {
        "$or": [
            {"companies": company_regex},
            {
                "$and": [
                    {"$or": [{"companies": {"$exists": False}}, {"companies": {"$size": 0}}]},
                    {"company": company_regex},
                ]
            },
        ]
    }


def build_known_company_query() -> dict:
    return {
        "$or": [
            {"companies.0": {"$exists": True}},
            {
                "$and": [
                    {"$or": [{"companies": {"$exists": False}}, {"companies": {"$size": 0}}]},
                    {"company": {"$exists": True, "$nin": [None, "", "Unknown"]}},
                ]
            },
        ]
    }


def build_company_aggregation_pipeline() -> list[dict]:
    return [
        {
            "$project": {
                "created_at": 1,
                "post_date": 1,
                "monthly_salary_million": 1,
                "companies_for_aggregation": {
                    "$cond": [
                        {"$gt": [{"$size": {"$ifNull": ["$companies", []]}}, 0]},
                        "$companies",
                        {
                            "$cond": [
                                {"$and": [{"$ne": ["$company", None]}, {"$ne": ["$company", ""]}, {"$ne": ["$company", "Unknown"]}]},
                                ["$company"],
                                [],
                            ]
                        },
                    ]
                },
            }
        },
        {"$unwind": "$companies_for_aggregation"},
        {
            "$group": {
                "_id": "$companies_for_aggregation",
                "review_count": {"$sum": 1},
                "latest_review": {"$max": "$post_date"},
                "created_at": {"$min": "$created_at"},
                "max_monthly_salary_million": {"$max": "$monthly_salary_million"},
            }
        },
    ]


async def rebuild_companies_collection(target_db=None) -> int:
    """Rebuild company summary collection from review documents."""
    active_db = target_db if target_db is not None else CompanyDocument.get_motor_database()
    await active_db.companies.delete_many({})
    docs = []
    async for row in active_db.reviews.aggregate(build_company_aggregation_pipeline()):
        docs.append(
            {
                "name": row["_id"],
                "review_count": row["review_count"],
                "created_at": row.get("created_at"),
                "updated_at": row.get("latest_review"),
                "latest_post_date": row.get("latest_review"),
                "max_monthly_salary_million": row.get("max_monthly_salary_million"),
            }
        )

    if docs:
        await active_db.companies.insert_many(docs)
    return len(docs)


async def get_reviews_by_company(
    company: str,
    limit: int = 50,
    skip: int = 0,
    status: str = None,
    thread_id: str = None,
    salary_only: bool = False,
    interview_only: bool = False,
) -> list[dict]:
    """Get reviews for a specific company."""
    query = build_company_match(company)
    if status:
        query["status"] = status
    if thread_id:
        query["voz_thread_id"] = thread_id
    if salary_only:
        query["content"] = {"$regex": r"lương", "$options": "i"}
    if interview_only:
        query["content"] = {"$regex": r"phỏng vấn", "$options": "i"}

    cursor = ReviewDocument.get_motor_collection().find(query).sort("post_date", -1).skip(skip).limit(limit)
    reviews = await cursor.to_list(length=limit)
    return [prepare_review_document(review) for review in reviews]


def build_offer_query(company: str = None, thread_id: str = None, position_keyword: str = "") -> dict:
    query = {}
    if company:
        escaped_company = re.escape(company)
        query["company"] = {"$regex": f"^{escaped_company}$", "$options": "i"}
    if thread_id:
        query["voz_thread_id"] = thread_id
    if position_keyword:
        query["position"] = {"$regex": re.escape(position_keyword.strip()), "$options": "i"}
    return query


async def get_offers_by_company(
    company: str,
    limit: int = 50,
    skip: int = 0,
    thread_id: str = None,
    position_keyword: str = "",
    sort_by: str = "recent",
) -> list[dict]:
    """Get extracted offers for a specific company."""
    query = build_offer_query(company=company, thread_id=thread_id, position_keyword=position_keyword)
    sort_map = {
        "recent": [("updated_at", -1), ("created_at", -1)],
        "year_desc": [("offer_year", -1), ("updated_at", -1), ("created_at", -1)],
        "year_asc": [("offer_year", 1), ("updated_at", -1), ("created_at", -1)],
        "salary_desc": [("monthly_salary_million", -1), ("updated_at", -1), ("created_at", -1)],
        "salary_asc": [("monthly_salary_million", 1), ("updated_at", -1), ("created_at", -1)],
        "position_az": [("position", 1), ("updated_at", -1)],
    }

    cursor = OfferDocument.get_motor_collection().find(query).sort(sort_map.get(sort_by, sort_map["recent"])).skip(skip).limit(limit)
    offers = await cursor.to_list(length=limit)

    post_ids = [str(offer.get("voz_post_id")) for offer in offers if offer.get("voz_post_id")]
    review_docs = []
    if post_ids:
        review_docs = await ReviewDocument.get_motor_collection().find(
            {"voz_post_id": {"$in": post_ids}},
            {"_id": 0, "voz_post_id": 1, "url": 1, "post_date": 1},
        ).to_list(length=None)
    review_map = {str(doc.get("voz_post_id")): doc for doc in review_docs if doc.get("voz_post_id")}

    for offer in offers:
        linked_review = review_map.get(str(offer.get("voz_post_id")))
        if linked_review:
            offer["url"] = linked_review.get("url") or ""
            offer["post_date"] = linked_review.get("post_date")

    return offers


async def get_offer_count(company: str = None, thread_id: str = None, position_keyword: str = "") -> int:
    """Count offers, optionally filtered by company, thread, or position."""
    query = build_offer_query(company=company, thread_id=thread_id, position_keyword=position_keyword)
    return await OfferDocument.find(query).count()


async def get_review_count(company: str = None, status: str = None, thread_id: str = None, salary_only: bool = False, interview_only: bool = False) -> int:
    """Count reviews, optionally filtered by company or status."""
    query = build_company_match(company) if company else {}
    if status:
        query["status"] = status
    if thread_id:
        query["voz_thread_id"] = thread_id
    if salary_only:
        query["content"] = {"$regex": r"lương", "$options": "i"}
    if interview_only:
        query["content"] = {"$regex": r"phỏng vấn", "$options": "i"}
    return await ReviewDocument.find(query).count()


async def get_company_review_count() -> int:
    """Count reviews that have a known company name."""
    return await ReviewDocument.find(build_known_company_query()).count()


async def upsert_company(name: str) -> dict:
    """Create or update company, return updated doc."""
    now = datetime.utcnow()
    document = await CompanyDocument.find_one({"name": name})
    if document:
        document.updated_at = now
        await document.save()
        return _document_to_dict(document)

    document = CompanyDocument(
        name=name,
        created_at=now,
        updated_at=now,
        review_count=0,
        latest_post_date=None,
        max_monthly_salary_million=None,
    )
    try:
        await document.insert()
    except DuplicateKeyError:
        existing = await CompanyDocument.find_one({"name": name})
        if existing is None:
            raise
        existing.updated_at = now
        await existing.save()
        document = existing
    return _document_to_dict(document)


async def ensure_companies_exist(company_names: list[str]) -> list[str]:
    """Ensure company documents exist for normalized company names without changing counts."""
    normalized_names = []
    seen = set()
    for raw_name in company_names:
        name = (raw_name or "").strip()
        if not name or name == "Unknown":
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        normalized_names.append(name)

    for company_name in normalized_names:
        await upsert_company(company_name)

    return normalized_names


async def increment_company_review_count(company_name: str):
    """Increment review count for company."""
    document = await CompanyDocument.find_one({"name": company_name})
    if document is None:
        document = CompanyDocument(
            name=company_name,
            review_count=1,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        await document.insert()
        return

    document.review_count += 1
    document.updated_at = datetime.utcnow()
    await document.save()


async def insert_review(review_data: dict) -> tuple[str | None, bool]:
    """Insert a new review, return (inserted_id, inserted_new)."""
    prepare_review_document(review_data)
    await ensure_companies_exist(review_data.get("companies") or [])
    review_data["created_at"] = datetime.utcnow()
    review_data["status"] = config.STATUS_PENDING
    document = ReviewDocument(**review_data)
    try:
        await document.insert()
        return str(document.id), True
    except DuplicateKeyError:
        return None, False


async def upsert_offer(offer_data: dict) -> tuple[str | None, bool]:
    """Create or update an extracted offer, keyed by (voz_post_id, offer_index)."""
    voz_post_id = offer_data.get("voz_post_id")
    offer_index = offer_data.get("offer_index")
    company = offer_data.get("company")
    if not voz_post_id or offer_index is None or not company or company == "Unknown":
        return None, False

    now = datetime.utcnow()
    document = await OfferDocument.find_one({"voz_post_id": voz_post_id, "offer_index": offer_index})
    created = document is None
    if document is None:
        payload = {k: v for k, v in offer_data.items() if k != "created_at"}
        document = OfferDocument(**payload, created_at=now, updated_at=now)
        try:
            await document.insert()
        except DuplicateKeyError:
            document = await OfferDocument.find_one({"voz_post_id": voz_post_id, "offer_index": offer_index})
            created = False
    if document is None:
        return None, False

    for key, value in offer_data.items():
        if key == "created_at":
            continue
        setattr(document, key, value)
    document.updated_at = now
    if not created:
        await document.save()
    return voz_post_id, created


async def sync_offers_for_post(voz_post_id: str, offer_docs: list[dict]) -> tuple[int, int, int]:
    """Upsert the latest extracted offers for a post and delete stale indexes for that post."""
    if not voz_post_id:
        return 0, 0, 0

    normalized_offer_docs = []
    seen_indexes = set()
    for fallback_index, offer_doc in enumerate(offer_docs):
        company = offer_doc.get("company")
        if not company or company == "Unknown":
            continue
        offer_index = offer_doc.get("offer_index")
        if offer_index is None:
            offer_index = fallback_index
            offer_doc["offer_index"] = offer_index
        if offer_index in seen_indexes:
            continue
        seen_indexes.add(offer_index)
        normalized_offer_docs.append(offer_doc)

    await ensure_companies_exist([offer_doc.get("company") for offer_doc in normalized_offer_docs])

    created_count = 0
    upserted_count = 0
    for offer_doc in normalized_offer_docs:
        _, created = await upsert_offer(offer_doc)
        upserted_count += 1
        if created:
            created_count += 1

    result = await OfferDocument.get_motor_collection().delete_many(
        {
            "voz_post_id": voz_post_id,
            "offer_index": {"$nin": list(seen_indexes)},
        }
    )
    return upserted_count, created_count, result.deleted_count


async def delete_offer_by_post_id(voz_post_id: str) -> int:
    """Delete stale extracted offers by VOZ post id."""
    if not voz_post_id:
        return 0
    result = await OfferDocument.get_motor_collection().delete_many({"voz_post_id": voz_post_id})
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

    document = await ThreadDocument.find_one(query)
    return _document_to_dict(document) if document else None


async def update_thread_state(thread_id: str = None, url: str = None, last_post_date: datetime = None, last_page: int = None):
    """Update crawl progress directly in threads collection."""
    query = {}
    if thread_id:
        query["thread_id"] = thread_id
    elif url:
        query["url"] = url
    else:
        return

    document = await ThreadDocument.find_one(query)
    if document is None:
        return
    document.last_crawl = datetime.utcnow()
    document.last_post_date = last_post_date
    document.last_page = last_page
    document.updated_at = datetime.utcnow()
    await document.save()


async def set_thread_crawl_status(url: str, status: str, error: str = None):
    """Set crawl job status on thread row."""
    document = await ThreadDocument.find_one({"url": url})
    now = datetime.utcnow()
    if document is None:
        document = ThreadDocument(
            url=url,
            title=url,
            crawl_status=status,
            crawl_error=None if status == "running" else error,
            created_at=now,
            updated_at=now,
        )
        await document.insert()
        return

    document.crawl_status = status
    document.updated_at = now
    if status == "running":
        document.crawl_error = None
    elif error:
        document.crawl_error = error
    await document.save()


async def get_replies_for_posts(post_ids: list[str]) -> list[dict]:
    """Get replies whose reply_post_id points to any of the given post IDs."""
    if not post_ids:
        return []
    cursor = ReviewDocument.get_motor_collection().find({"reply_post_id": {"$in": post_ids}}).sort("created_at", 1)
    replies = await cursor.to_list(length=None)
    return [prepare_review_document(reply) for reply in replies]


async def get_posts_by_ids(post_ids: list[str]) -> list[dict]:
    """Get posts by voz_post_id for reply context rendering."""
    if not post_ids:
        return []
    cursor = ReviewDocument.get_motor_collection().find({"voz_post_id": {"$in": post_ids}})
    posts = await cursor.to_list(length=None)
    return [prepare_review_document(post) for post in posts]


async def get_all_threads() -> list[dict]:
    """Get all configured crawl threads from DB."""
    documents = await ThreadDocument.find_all().sort("-created_at").to_list()
    return [_document_to_dict(document) for document in documents]


async def upsert_thread(url: str, title: str = None, thread_id: str = None, kind: str = "thread"):
    """Create or update a crawl thread config."""
    now = datetime.utcnow()
    document = await ThreadDocument.find_one({"url": url})
    if document is None:
        document = ThreadDocument(
            url=url,
            title=title or url,
            thread_id=thread_id,
            kind=kind,
            crawl_status="idle",
            created_at=now,
            updated_at=now,
        )
        try:
            await document.insert()
        except DuplicateKeyError:
            document = await ThreadDocument.find_one({"url": url})
            if document is None:
                raise

    document.title = title or url
    document.thread_id = thread_id
    document.kind = kind
    document.updated_at = now
    await document.save()


async def seed_threads(thread_urls: list[str]):
    """Seed DB thread configs from legacy code constants if missing."""
    for url in thread_urls:
        thread_id_match = re.search(r'/t(?:/[^/]*?)?\.(\d+)(?:/|$)', url)
        thread_id = thread_id_match.group(1) if thread_id_match else None
        await upsert_thread(url=url, thread_id=thread_id)


async def get_company_thread_ids(company: str) -> list[str]:
    """Get distinct VOZ thread IDs for a company, sorted descending."""
    ids = await ReviewDocument.get_motor_collection().distinct(
        "voz_thread_id",
        {
            **build_company_match(company),
            "voz_thread_id": {"$exists": True, "$nin": [None, ""]},
        },
    )
    return sorted([str(x) for x in ids if x], reverse=True)


async def search_reviews(keyword: str, limit: int = 50, skip: int = 0) -> list[dict]:
    """Full-text search across reviews."""
    cursor = ReviewDocument.get_motor_collection().find({"$text": {"$search": keyword}}).sort("created_at", -1).skip(skip).limit(limit)
    results = await cursor.to_list(length=limit)
    return [prepare_review_document(result) for result in results]
