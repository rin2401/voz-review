"""Beanie document models for MongoDB collections."""
from datetime import datetime
from typing import Optional

from beanie import Document
from dateutil import parser as date_parser
from pydantic import ConfigDict, Field, field_validator
from pymongo import ASCENDING, DESCENDING, IndexModel, TEXT


def _coerce_string_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []

    normalized = []
    seen = set()
    for item in value:
        if item is None:
            continue
        text = str(item).strip()
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(text)
    return normalized


def _coerce_datetime(value):
    if value in (None, "", 0):
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        raw_value = value.strip()
        if not raw_value:
            return None
        try:
            return date_parser.parse(raw_value)
        except (ValueError, TypeError, OverflowError):
            return None
    return None


def _coerce_int(value, default: int = 0) -> int:
    if value in (None, ""):
        return default
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        text = value.strip().replace(",", "")
        if not text:
            return default
        try:
            return int(float(text))
        except ValueError:
            return default
    return default


def _coerce_float(value):
    if value in (None, ""):
        return None
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip().replace(",", ".")
        if not text:
            return None
        try:
            return float(text)
        except ValueError:
            return None
    return None


class ReviewDocument(Document):
    model_config = ConfigDict(extra="ignore")

    voz_thread_id: str = ""
    voz_post_id: Optional[str] = None
    reply_post_id: Optional[str] = None
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

    @field_validator("voz_post_id", "reply_post_id", "author_url", mode="before")
    @classmethod
    def _normalize_optional_strings(cls, value):
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    @field_validator("voz_thread_id", "author", "url", "status", mode="before")
    @classmethod
    def _normalize_required_strings(cls, value):
        if value is None:
            return ""
        return str(value).strip()

    @field_validator("companies", mode="before")
    @classmethod
    def _normalize_companies(cls, value):
        return _coerce_string_list(value)

    @field_validator("post_date", "created_at", mode="before")
    @classmethod
    def _normalize_datetimes(cls, value):
        return _coerce_datetime(value)

    @field_validator("likes", "awards", mode="before")
    @classmethod
    def _normalize_int_fields(cls, value):
        return _coerce_int(value)

    @field_validator("monthly_salary_million", mode="before")
    @classmethod
    def _normalize_salary(cls, value):
        return _coerce_float(value)

    class Settings:
        name = "reviews"
        indexes = [
            IndexModel([("companies", TEXT), ("content", TEXT)]),
            IndexModel([("companies", ASCENDING)]),
            IndexModel([("created_at", ASCENDING)]),
            IndexModel([("voz_thread_id", ASCENDING)]),
            IndexModel(
                [("voz_post_id", ASCENDING)],
                unique=True,
                partialFilterExpression={"voz_post_id": {"$exists": True, "$type": "string"}},
            ),
            IndexModel([("reply_post_id", ASCENDING)]),
            IndexModel([("companies", ASCENDING), ("created_at", ASCENDING)]),
        ]


class CompanyDocument(Document):
    model_config = ConfigDict(extra="ignore")

    name: str
    aliases: list[str] = Field(default_factory=list)
    review_count: int = 0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    latest_post_date: Optional[datetime] = None
    max_monthly_salary_million: Optional[float] = None

    @field_validator("name", mode="before")
    @classmethod
    def _normalize_name(cls, value):
        return (str(value).strip() if value is not None else "")

    @field_validator("aliases", mode="before")
    @classmethod
    def _normalize_aliases(cls, value):
        return _coerce_string_list(value)

    @field_validator("review_count", mode="before")
    @classmethod
    def _normalize_review_count(cls, value):
        return _coerce_int(value)

    @field_validator("created_at", "updated_at", "latest_post_date", mode="before")
    @classmethod
    def _normalize_company_datetimes(cls, value):
        return _coerce_datetime(value)

    @field_validator("max_monthly_salary_million", mode="before")
    @classmethod
    def _normalize_company_salary(cls, value):
        return _coerce_float(value)

    class Settings:
        name = "companies"
        indexes = [
            IndexModel([("name", ASCENDING)], unique=True),
            IndexModel([("review_count", DESCENDING), ("name", ASCENDING)]),
            IndexModel([("latest_post_date", DESCENDING), ("name", ASCENDING)]),
            IndexModel([("max_monthly_salary_million", DESCENDING), ("review_count", DESCENDING), ("name", ASCENDING)]),
        ]


class ThreadDocument(Document):
    model_config = ConfigDict(extra="ignore")

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

    @field_validator("title", "thread_id", "crawl_error", mode="before")
    @classmethod
    def _normalize_optional_thread_strings(cls, value):
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    @field_validator("url", "kind", "crawl_status", mode="before")
    @classmethod
    def _normalize_required_thread_strings(cls, value):
        if value is None:
            return ""
        return str(value).strip()

    @field_validator("last_crawl", "last_post_date", "created_at", "updated_at", mode="before")
    @classmethod
    def _normalize_thread_datetimes(cls, value):
        return _coerce_datetime(value)

    @field_validator("last_page", mode="before")
    @classmethod
    def _normalize_last_page(cls, value):
        return _coerce_int(value, default=None)

    class Settings:
        name = "threads"
        indexes = [
            IndexModel([("url", ASCENDING)], unique=True),
            IndexModel([("thread_id", ASCENDING)], unique=True, sparse=True),
            IndexModel([("created_at", DESCENDING)]),
        ]


class OfferDocument(Document):
    model_config = ConfigDict(extra="ignore")

    voz_post_id: Optional[str] = None
    offer_index: Optional[int] = None
    company: str
    voz_thread_id: str = ""
    position: Optional[str] = None
    offer_year: Optional[int | str] = None
    salary: Optional[str] = None
    bonus: Optional[str] = None
    years_of_experience: Optional[int | float | str] = None
    monthly_salary_million: Optional[float] = None
    raw_text: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @field_validator("voz_post_id", "position", "salary", "bonus", "raw_text", mode="before")
    @classmethod
    def _normalize_optional_offer_strings(cls, value):
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    @field_validator("company", "voz_thread_id", mode="before")
    @classmethod
    def _normalize_required_offer_strings(cls, value):
        if value is None:
            return ""
        return str(value).strip()

    @field_validator("offer_index", mode="before")
    @classmethod
    def _normalize_offer_index(cls, value):
        return _coerce_int(value, default=None)

    @field_validator("offer_year", mode="before")
    @classmethod
    def _normalize_offer_year(cls, value):
        if value in (None, ""):
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
        text = str(value).strip()
        if text.isdigit():
            return int(text)
        return text or None

    @field_validator("years_of_experience", mode="before")
    @classmethod
    def _normalize_years_of_experience(cls, value):
        if value in (None, ""):
            return None
        if isinstance(value, (int, float)):
            return value
        text = str(value).strip().replace(",", ".")
        try:
            numeric = float(text)
        except ValueError:
            return text or None
        return int(numeric) if numeric.is_integer() else numeric

    @field_validator("monthly_salary_million", mode="before")
    @classmethod
    def _normalize_offer_salary(cls, value):
        return _coerce_float(value)

    @field_validator("created_at", "updated_at", mode="before")
    @classmethod
    def _normalize_offer_datetimes(cls, value):
        return _coerce_datetime(value)

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
