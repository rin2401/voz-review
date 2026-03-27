"""Beanie document models for MongoDB collections."""
from datetime import datetime
from typing import Optional

from pydantic import Field
from pymongo import ASCENDING, DESCENDING, IndexModel, TEXT

from database.beanie_compat import Document


class ReviewDocument(Document):
    voz_thread_id: str = ""
    voz_post_id: Optional[str] = None
    reply_post_id: Optional[str] = None
    company: str = "Unknown"
    companies: list[str] = Field(default_factory=list)
    content: str
    author: str
    author_url: Optional[str] = None
    post_date: datetime
    url: str
    likes: int = 0
    awards: int = 0
    monthly_salary_million: Optional[float] = None
    status: str = "pending"
    created_at: Optional[datetime] = None

    class Settings:
        name = "reviews"
        indexes = [
            IndexModel([("company", TEXT), ("companies", TEXT), ("content", TEXT)]),
            IndexModel([("company", ASCENDING)]),
            IndexModel([("companies", ASCENDING)]),
            IndexModel([("created_at", ASCENDING)]),
            IndexModel([("voz_thread_id", ASCENDING)]),
            IndexModel(
                [("voz_post_id", ASCENDING)],
                unique=True,
                partialFilterExpression={"voz_post_id": {"$exists": True, "$type": "string"}},
            ),
            IndexModel([("reply_post_id", ASCENDING)]),
            IndexModel([("company", ASCENDING), ("created_at", ASCENDING)]),
            IndexModel([("companies", ASCENDING), ("created_at", ASCENDING)]),
        ]


class CompanyDocument(Document):
    name: str
    review_count: int = 0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    latest_post_date: Optional[datetime] = None
    max_monthly_salary_million: Optional[float] = None

    class Settings:
        name = "companies"
        indexes = [
            IndexModel([("name", ASCENDING)], unique=True),
            IndexModel([("review_count", DESCENDING), ("name", ASCENDING)]),
            IndexModel([("latest_post_date", DESCENDING), ("name", ASCENDING)]),
            IndexModel([("max_monthly_salary_million", DESCENDING), ("review_count", DESCENDING), ("name", ASCENDING)]),
        ]


class ThreadDocument(Document):
    url: str
    title: Optional[str] = None
    thread_id: Optional[str] = None
    kind: str = "thread"
    crawl_status: str = "idle"
    crawl_error: Optional[str] = None
    last_crawl: Optional[datetime] = None
    last_post_date: Optional[datetime] = None
    last_page: Optional[int] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Settings:
        name = "threads"
        indexes = [
            IndexModel([("url", ASCENDING)], unique=True),
            IndexModel([("thread_id", ASCENDING)], unique=True, sparse=True),
            IndexModel([("created_at", DESCENDING)]),
        ]


class OfferDocument(Document):
    voz_post_id: Optional[str] = None
    offer_index: Optional[int] = None
    company: str
    voz_thread_id: str = ""
    position: Optional[str] = None
    offer_year: Optional[int] = None
    monthly_salary_million: Optional[float] = None
    raw_text: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Settings:
        name = "offers"
        indexes = [
            IndexModel(
                [("voz_post_id", ASCENDING), ("offer_index", ASCENDING)],
                unique=True,
                partialFilterExpression={
                    "voz_post_id": {"$exists": True, "$type": "string"},
                    "offer_index": {"$exists": True, "$type": "number"},
                },
            ),
            IndexModel([("company", ASCENDING)]),
            IndexModel([("voz_thread_id", ASCENDING)]),
            IndexModel([("offer_year", ASCENDING)]),
            IndexModel([("updated_at", ASCENDING)]),
        ]
