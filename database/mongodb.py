"""MongoDB and Beanie database initialization plus query helpers."""
from datetime import datetime
import re
from typing import Any, Optional

from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ReturnDocument
from pymongo import ASCENDING, DESCENDING, TEXT
from pymongo.errors import DuplicateKeyError, OperationFailure

import config
from database.company_aliases import build_company_aliases_by_canonical, company_aliases_for_name, normalize_aliases
from database.company_duplicates import analyze_likely_duplicate_companies
from database.models import CompanyDocument, OfferDocument, ReviewDocument, SchedulerStateDocument, ThreadDocument

client: Optional[AsyncIOMotorClient] = None
db = None


def _coerce_string(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _coerce_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    normalized = []
    seen = set()
    for item in value:
        text = _coerce_string(item)
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(text)
    return normalized


def _document_to_dict(document: Any) -> dict:
    payload = document.model_dump(mode="python")
    payload.pop("id", None)
    return payload


def get_database():
    """Return the active Mongo database handle."""
    return db


def _normalized_company_aliases_for_name(name: str) -> list[str]:
    return normalize_aliases(company_aliases_for_name(name), canonical_name=name)


def _normalize_company_names(raw_companies: list[Any]) -> list[str]:
    normalized = []
    seen = set()
    for raw_company in raw_companies:
        company = (raw_company or "").strip()
        if not company or company == "Unknown":
            continue
        key = company.lower()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(company)
    return normalized


def _coerce_alias_list(raw_aliases: Any, canonical_name: str | None = None) -> list[str]:
    return normalize_aliases(_coerce_string_list(raw_aliases), canonical_name=canonical_name)


async def connect():
    """Initialize database connection and Beanie documents."""
    global client, db
    if client is not None and db is not None:
        return

    client = AsyncIOMotorClient(config.MONGO_URI)
    db = client[config.MONGO_DB]

    # Drop legacy review text indexes before Beanie init so schema/index changes don't conflict.
    reviews = db.reviews
    existing_indexes = await reviews.index_information()
    for index_name, index_info in existing_indexes.items():
        if index_name == "_id_":
            continue
        keys = index_info.get("key", [])
        if keys and keys[0][0] == "_fts" and index_name != "companies_text_content_text":
            await reviews.drop_index(index_name)

    await init_beanie(
        database=db,
        document_models=[
            ReviewDocument,
            CompanyDocument,
            ThreadDocument,
            SchedulerStateDocument,
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
        if keys and keys[0][0] == "_fts" and index_name != "companies_text_content_text":
            await reviews.drop_index(index_name)

    await reviews.create_index([("companies", TEXT), ("content", TEXT)])
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
    await reviews.create_index([("companies", ASCENDING), ("created_at", ASCENDING)])

    companies = CompanyDocument.get_motor_collection()
    try:
        await companies.create_index("name", unique=True)
    except OperationFailure as exc:
        if exc.code != 11000:
            raise
        print("⚠️ Skipped unique company name index because legacy company documents still contain duplicates")
    await companies.create_index([("review_count", -1), ("name", ASCENDING)])
    await companies.create_index([("latest_post_date", -1), ("name", ASCENDING)])
    await companies.create_index([("max_monthly_salary_million", -1), ("review_count", -1), ("name", ASCENDING)])

    threads = ThreadDocument.get_motor_collection()
    await threads.create_index("url", unique=True)
    await threads.create_index("thread_id", unique=True, sparse=True)

    scheduler_states = SchedulerStateDocument.get_motor_collection()
    await scheduler_states.create_index("job_name", unique=True)
    await scheduler_states.create_index("updated_at")

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
    documents = await CompanyDocument.find_all().sort(sort_map.get(sort_by, sort_map["az"])).to_list()
    companies = [_document_to_dict(document) for document in documents]
    for company in companies:
        company["aliases"] = normalize_aliases(company.get("aliases") or [], canonical_name=company.get("name"))
        company.setdefault("review_count", 0)
        company.setdefault("latest_post_date", None)
        company.setdefault("max_monthly_salary_million", None)
    return companies


def normalize_review_companies(review_doc: dict, allow_legacy_fallback: bool = True) -> list[str]:
    companies = review_doc.get("companies")
    normalized = _normalize_company_names(_coerce_string_list(companies))
    if normalized:
        return normalized

    if allow_legacy_fallback:
        fallback = (review_doc.get("company") or "").strip()
        if fallback and fallback != "Unknown":
            return [fallback]
    return []


def primary_review_company(review_doc: dict, default: str = "Unknown", allow_legacy_fallback: bool = True) -> str:
    companies = normalize_review_companies(review_doc, allow_legacy_fallback=allow_legacy_fallback)
    return companies[0] if companies else default


def prepare_review_document(review_doc: dict) -> dict:
    normalized_companies = normalize_review_companies(review_doc, allow_legacy_fallback=True)
    review_doc["companies"] = normalized_companies
    review_doc.pop("company", None)
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
                "created_at": {
                    "$convert": {
                        "input": "$created_at",
                        "to": "date",
                        "onError": None,
                        "onNull": None,
                    }
                },
                "effective_post_date": {
                    "$ifNull": [
                        {
                            "$convert": {
                                "input": "$post_date",
                                "to": "date",
                                "onError": None,
                                "onNull": None,
                            }
                        },
                        {
                            "$convert": {
                                "input": "$created_at",
                                "to": "date",
                                "onError": None,
                                "onNull": None,
                            }
                        },
                    ]
                },
                "monthly_salary_million": {
                    "$convert": {
                        "input": "$monthly_salary_million",
                        "to": "double",
                        "onError": None,
                        "onNull": None,
                    }
                },
                "companies_for_aggregation": {
                    "$let": {
                        "vars": {
                            "legacy_company": {
                                "$trim": {
                                    "input": {
                                        "$convert": {
                                            "input": "$company",
                                            "to": "string",
                                            "onError": "",
                                            "onNull": "",
                                        }
                                    }
                                }
                            },
                            "normalized_companies": {
                                "$cond": [
                                    {"$isArray": "$companies"},
                                    {
                                        "$filter": {
                                            "input": {
                                                "$map": {
                                                    "input": "$companies",
                                                    "as": "company",
                                                    "in": {
                                                        "$trim": {
                                                            "input": {
                                                                "$convert": {
                                                                    "input": "$$company",
                                                                    "to": "string",
                                                                    "onError": "",
                                                                    "onNull": "",
                                                                }
                                                            }
                                                        }
                                                    },
                                                }
                                            },
                                            "as": "company",
                                            "cond": {
                                                "$and": [
                                                    {"$ne": ["$$company", ""]},
                                                    {"$ne": ["$$company", "Unknown"]},
                                                ]
                                            },
                                        }
                                    },
                                    [],
                                ]
                            },
                        },
                        "in": {
                            "$cond": [
                                {"$gt": [{"$size": "$$normalized_companies"}, 0]},
                                {"$setUnion": ["$$normalized_companies", []]},
                                {
                                    "$cond": [
                                        {
                                            "$and": [
                                                {"$ne": ["$$legacy_company", ""]},
                                                {"$ne": ["$$legacy_company", "Unknown"]},
                                            ]
                                        },
                                        ["$$legacy_company"],
                                        [],
                                    ]
                                },
                            ]
                        },
                    }
                },
            }
        },
        {"$unwind": "$companies_for_aggregation"},
        {
            "$group": {
                "_id": "$companies_for_aggregation",
                "review_count": {"$sum": 1},
                "latest_review": {"$max": "$effective_post_date"},
                "created_at": {"$min": "$created_at"},
                "max_monthly_salary_million": {"$max": "$monthly_salary_million"},
            }
        },
    ]


async def rebuild_companies_collection(target_db=None) -> int:
    """Rebuild company summary collection from review documents."""
    active_db = target_db if target_db is not None else db
    company_aliases = build_company_aliases_by_canonical()
    await active_db.companies.delete_many({})
    docs = []
    async for row in active_db.reviews.aggregate(build_company_aggregation_pipeline()):
        name = _coerce_string(row.get("_id"))
        if not name or name == "Unknown":
            continue
        docs.append(
            {
                "name": name,
                "aliases": _coerce_alias_list(company_aliases.get(name, []), canonical_name=name),
                "review_count": int(row.get("review_count") or 0),
                "created_at": row.get("created_at"),
                "updated_at": row.get("latest_review"),
                "latest_post_date": row.get("latest_review"),
                "max_monthly_salary_million": row.get("max_monthly_salary_million"),
            }
        )

    if docs:
        await active_db.companies.insert_many(docs)
    await active_db.companies.create_index([("name", ASCENDING)], unique=True)
    await active_db.companies.create_index([("review_count", DESCENDING), ("name", ASCENDING)])
    await active_db.companies.create_index([("latest_post_date", DESCENDING), ("name", ASCENDING)])
    await active_db.companies.create_index([("max_monthly_salary_million", DESCENDING), ("review_count", DESCENDING), ("name", ASCENDING)])
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

    documents = await ReviewDocument.find(query).sort("-post_date").skip(skip).limit(limit).to_list()
    return [prepare_review_document(_document_to_dict(document)) for document in documents]


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

    documents = await OfferDocument.find(query).sort(sort_map.get(sort_by, sort_map["recent"])).skip(skip).limit(limit).to_list()
    offers = [_document_to_dict(document) for document in documents]

    post_ids = [str(offer.get("voz_post_id")) for offer in offers if offer.get("voz_post_id")]
    review_docs = []
    if post_ids:
        review_documents = await ReviewDocument.find({"voz_post_id": {"$in": post_ids}}).to_list()
        review_docs = [_document_to_dict(document) for document in review_documents]
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
        document.aliases = _normalized_company_aliases_for_name(name)
        document.updated_at = now
        await document.save()
        return _document_to_dict(document)

    document = CompanyDocument(
        name=name,
        aliases=_normalized_company_aliases_for_name(name),
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
        existing.aliases = _normalized_company_aliases_for_name(name)
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


async def increment_company_review_count(company_name: str, post_date: datetime = None):
    """Increment review count for company and update latest_post_date if the new review is more recent."""
    now = datetime.utcnow()
    document = await CompanyDocument.find_one({"name": company_name})
    if document is None:
        document = CompanyDocument(
            name=company_name,
            aliases=_normalized_company_aliases_for_name(company_name),
            review_count=1,
            created_at=now,
            updated_at=now,
            latest_post_date=post_date,
        )
        await document.insert()
        return

    document.review_count += 1
    document.aliases = _normalized_company_aliases_for_name(company_name)
    document.updated_at = now
    if post_date and (document.latest_post_date is None or post_date > document.latest_post_date):
        document.latest_post_date = post_date
    await document.save()


async def fill_company_aliases(target_db=None) -> dict[str, int | list[str]]:
    """Populate aliases for existing canonical company documents without creating new companies."""
    active_db = target_db if target_db is not None else CompanyDocument.get_motor_database()
    company_aliases = build_company_aliases_by_canonical()
    existing_names = set()
    updated = 0

    async for doc in active_db.companies.find({}, {"_id": 1, "name": 1, "aliases": 1}):
        name = (doc.get("name") or "").strip()
        if not name:
            continue
        existing_names.add(name)
        aliases = _coerce_alias_list(company_aliases.get(name, []), canonical_name=name)
        if aliases == _coerce_alias_list(doc.get("aliases"), canonical_name=name):
            continue
        result = await active_db.companies.update_one({"_id": doc["_id"]}, {"$set": {"aliases": aliases}})
        updated += result.modified_count

    missing_canonicals = sorted(name for name in company_aliases if name not in existing_names)
    return {
        "updated_companies": updated,
        "missing_canonical_companies": missing_canonicals,
        "missing_canonical_count": len(missing_canonicals),
    }


async def build_company_data_report(target_db=None) -> dict[str, list[dict] | list[str]]:
    """Collect suspicious company and alias issues that still need manual review."""
    active_db = target_db if target_db is not None else CompanyDocument.get_motor_database()
    alias_map = build_company_aliases_by_canonical()

    docs = []
    async for doc in active_db.companies.find({}, {"name": 1, "aliases": 1, "review_count": 1}):
        docs.append(doc)

    exact_names = {_coerce_string(doc.get("name")) for doc in docs if _coerce_string(doc.get("name"))}
    lowercase_buckets: dict[str, list[str]] = {}
    suspicious_names = []
    alias_conflicts = []
    alias_duplicates = []

    for doc in docs:
        raw_name = doc.get("name")
        name = _coerce_string(doc.get("name"))
        raw_alias_values = doc.get("aliases")
        if isinstance(raw_alias_values, str):
            raw_alias_values = [raw_alias_values]
        elif not isinstance(raw_alias_values, list):
            raw_alias_values = []
        aliases = _coerce_alias_list(raw_alias_values, canonical_name=name)
        review_count = int(doc.get("review_count") or 0)
        if not name:
            suspicious_names.append({"name": name, "issue": "blank_name", "review_count": review_count})
            continue

        lowercase_buckets.setdefault(name.lower(), []).append(name)

        name_issues = []
        if name == "Unknown":
            name_issues.append("unknown_name")
        if isinstance(raw_name, str) and raw_name != raw_name.strip():
            name_issues.append("surrounding_whitespace")
        if len(name) > 60:
            name_issues.append("name_too_long")
        if not re.search(r"[A-Za-z]", name):
            name_issues.append("non_alpha_name")
        if re.search(r"\b(xin review|cho em hỏi|cho mình hỏi|có ai|hỏi về)\b", name, re.IGNORECASE):
            name_issues.append("looks_like_question")
        if re.search(r"[()]", name):
            name_issues.append("contains_note_parentheses")

        if name_issues:
            suspicious_names.append({"name": name, "issue": ",".join(name_issues), "review_count": review_count})

        raw_seen_aliases = set()
        for alias in raw_alias_values:
            raw_alias = _coerce_string(alias)
            if not raw_alias or raw_alias.lower() == name.lower():
                continue
            raw_alias_key = raw_alias.lower()
            if raw_alias_key in raw_seen_aliases:
                alias_duplicates.append({"name": name, "alias": raw_alias, "issue": "duplicate_alias_in_document"})
            else:
                raw_seen_aliases.add(raw_alias_key)

        for alias in aliases:
            alias_key = alias.lower()
            if alias in exact_names and alias != name:
                alias_conflicts.append({"name": name, "alias": alias, "issue": "alias_matches_existing_company"})

    case_collisions = [
        {"normalized_name": key, "variants": sorted(values)}
        for key, values in sorted(lowercase_buckets.items())
        if len(set(values)) > 1
    ]
    missing_canonical_companies = sorted(name for name in alias_map if name not in exact_names)

    return {
        "suspicious_names": suspicious_names,
        "case_collisions": case_collisions,
        "alias_conflicts": alias_conflicts,
        "alias_duplicates": alias_duplicates,
        "missing_canonical_companies": missing_canonical_companies,
    }


async def build_likely_duplicate_company_report(target_db=None) -> dict[str, Any]:
    """Collect likely duplicate company-name groups for manual review only."""
    active_db = target_db if target_db is not None else CompanyDocument.get_motor_database()
    docs = []
    async for doc in active_db.companies.find({}, {"name": 1, "aliases": 1, "review_count": 1}):
        docs.append(doc)
    return analyze_likely_duplicate_companies(docs)


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

    stale_offer_docs = await OfferDocument.find(
        {
            "voz_post_id": voz_post_id,
            "offer_index": {"$nin": list(seen_indexes)},
        }
    ).to_list()
    for stale_offer in stale_offer_docs:
        await stale_offer.delete()
    return upserted_count, created_count, len(stale_offer_docs)


async def delete_offer_by_post_id(voz_post_id: str) -> int:
    """Delete stale extracted offers by VOZ post id."""
    if not voz_post_id:
        return 0
    offer_docs = await OfferDocument.find({"voz_post_id": voz_post_id}).to_list()
    for offer_doc in offer_docs:
        await offer_doc.delete()
    return len(offer_docs)


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
    documents = await ReviewDocument.find({"reply_post_id": {"$in": post_ids}}).sort("created_at").to_list()
    return [prepare_review_document(_document_to_dict(document)) for document in documents]


async def get_posts_by_ids(post_ids: list[str]) -> list[dict]:
    """Get posts by voz_post_id for reply context rendering."""
    if not post_ids:
        return []
    documents = await ReviewDocument.find({"voz_post_id": {"$in": post_ids}}).to_list()
    return [prepare_review_document(_document_to_dict(document)) for document in documents]


async def get_all_threads() -> list[dict]:
    """Get all configured crawl threads from DB."""
    documents = await ThreadDocument.find_all().sort("-created_at").to_list()
    return [_document_to_dict(document) for document in documents]


async def ensure_scheduler_state(
    job_name: str,
    timezone: str,
    enabled: bool,
    next_run_at: datetime | None = None,
) -> dict:
    """Create or update persisted scheduler state."""
    now = datetime.utcnow()
    collection = SchedulerStateDocument.get_motor_collection()
    document = await collection.find_one_and_update(
        {"job_name": job_name},
        {
            "$setOnInsert": {
                "job_name": job_name,
                "schedule_kind": "hourly",
                "schedule_minute": 0,
                "created_at": now,
                "last_status": "idle",
            },
            "$set": {
                "timezone": timezone,
                "enabled": enabled,
                "next_run_at": next_run_at,
                "updated_at": now,
            },
        },
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    document.pop("_id", None)
    return document


async def get_scheduler_state(job_name: str) -> Optional[dict]:
    """Fetch persisted scheduler state for a job."""
    document = await SchedulerStateDocument.find_one({"job_name": job_name})
    return _document_to_dict(document) if document else None


async def try_acquire_scheduler_lock(
    job_name: str,
    reason: str,
    timezone: str,
    enabled: bool,
    lock_until: datetime,
    next_run_at: datetime | None = None,
) -> Optional[dict]:
    """Acquire the scheduler lock if no active run is holding it."""
    now = datetime.utcnow()
    collection = SchedulerStateDocument.get_motor_collection()
    document = await collection.find_one_and_update(
        {
            "job_name": job_name,
            "$or": [
                {"lock_until": {"$exists": False}},
                {"lock_until": None},
                {"lock_until": {"$lte": now}},
            ],
        },
        {
            "$set": {
                "timezone": timezone,
                "enabled": enabled,
                "next_run_at": next_run_at,
                "lock_until": lock_until,
                "current_run_started_at": now,
                "current_run_reason": reason,
                "last_started_at": now,
                "last_status": "running",
                "last_result": None,
                "last_error": None,
                "updated_at": now,
            },
        },
        return_document=ReturnDocument.AFTER,
    )
    if document:
        document.pop("_id", None)
    return document


async def complete_scheduler_run(
    job_name: str,
    status: str,
    result: str | None = None,
    error: str | None = None,
    next_run_at: datetime | None = None,
) -> Optional[dict]:
    """Mark a scheduler job finished and release its lock."""
    now = datetime.utcnow()
    collection = SchedulerStateDocument.get_motor_collection()
    document = await collection.find_one_and_update(
        {"job_name": job_name},
        {
            "$set": {
                "last_status": status,
                "last_result": result,
                "last_error": error,
                "last_finished_at": now,
                "next_run_at": next_run_at,
                "updated_at": now,
            },
            "$unset": {
                "lock_until": "",
                "current_run_started_at": "",
                "current_run_reason": "",
            },
        },
        return_document=ReturnDocument.AFTER,
    )
    if document:
        document.pop("_id", None)
    return document


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
