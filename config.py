"""Configuration for Voz Review Crawler."""
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    mongo_uri: str = Field(
        default="mongodb://localhost:27017",
        validation_alias=AliasChoices("MONGO_URI", "MONGODB_URI"),
    )
    mongo_db: str = Field(
        default="voz_crawler",
        validation_alias=AliasChoices("MONGO_DB", "MONGODB_DB"),
    )
    mongo_server_selection_timeout_ms: int = Field(
        default=30000,
        validation_alias="MONGO_SERVER_SELECTION_TIMEOUT_MS",
    )

    voz_base_url: str = Field(default="https://voz.vn", validation_alias="VOZ_BASE_URL")
    voz_timeout: int = Field(default=30, validation_alias="VOZ_TIMEOUT")

    crawl_delay: int = Field(default=2, validation_alias="CRAWL_DELAY")
    max_retries: int = Field(default=3, validation_alias="MAX_RETRIES")
    page_load_timeout: int = Field(default=15000, validation_alias="PAGE_LOAD_TIMEOUT")
    hourly_crawl_scheduler_enabled: bool = Field(
        default=False,
        validation_alias="HOURLY_CRAWL_SCHEDULER_ENABLED",
    )
    hourly_crawl_scheduler_timezone: str = Field(
        default="Asia/Ho_Chi_Minh",
        validation_alias="HOURLY_CRAWL_SCHEDULER_TIMEZONE",
    )
    hourly_crawl_scheduler_lease_minutes: int = Field(
        default=180,
        validation_alias="HOURLY_CRAWL_SCHEDULER_LEASE_MINUTES",
    )
    worker_crawl_url: str = Field(default="", validation_alias="WORKER_CRAWL_URL")
    crawl_trigger_token: str = Field(default="", validation_alias="CRAWL_TRIGGER_TOKEN")

    status_pending: str = Field(default="pending", validation_alias="STATUS_PENDING")
    status_approved: str = Field(default="approved", validation_alias="STATUS_APPROVED")
    status_rejected: str = Field(default="rejected", validation_alias="STATUS_REJECTED")

settings = Settings()

# Backward-compatible module-level constants used across the codebase.
MONGO_URI = settings.mongo_uri
MONGO_DB = settings.mongo_db
MONGO_SERVER_SELECTION_TIMEOUT_MS = settings.mongo_server_selection_timeout_ms

VOZ_BASE_URL = settings.voz_base_url
VOZ_TIMEOUT = settings.voz_timeout

CRAWL_DELAY = settings.crawl_delay
MAX_RETRIES = settings.max_retries
PAGE_LOAD_TIMEOUT = settings.page_load_timeout
HOURLY_CRAWL_SCHEDULER_ENABLED = settings.hourly_crawl_scheduler_enabled
HOURLY_CRAWL_SCHEDULER_TIMEZONE = settings.hourly_crawl_scheduler_timezone
HOURLY_CRAWL_SCHEDULER_LEASE_MINUTES = settings.hourly_crawl_scheduler_lease_minutes
WORKER_CRAWL_URL = settings.worker_crawl_url
CRAWL_TRIGGER_TOKEN = settings.crawl_trigger_token

STATUS_PENDING = settings.status_pending
STATUS_APPROVED = settings.status_approved
STATUS_REJECTED = settings.status_rejected
