"""Configuration for Voz Review Crawler"""
import os
from pathlib import Path


def _env_bool(name: str, default: bool) -> bool:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    return raw_value.strip().lower() in {"1", "true", "yes", "on"}


# Base paths
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

# MongoDB
MONGO_HOST = os.getenv("MONGO_HOST", "localhost")
MONGO_PORT = int(os.getenv("MONGO_PORT", "27017"))
MONGO_DB = os.getenv("MONGO_DB", "voz_crawler")
MONGO_URI = f"mongodb://{MONGO_HOST}:{MONGO_PORT}"

# Voz settings
VOZ_BASE_URL = "https://voz.vn"
VOZ_TIMEOUT = 30  # seconds

# Crawler settings
CRAWL_DELAY = 2  # seconds between requests (be nice to Voz)
MAX_RETRIES = 3
PAGE_LOAD_TIMEOUT = 15000  # ms for Playwright
HOURLY_CRAWL_SCHEDULER_ENABLED = _env_bool("HOURLY_CRAWL_SCHEDULER_ENABLED", True)
HOURLY_CRAWL_SCHEDULER_TIMEZONE = os.getenv("HOURLY_CRAWL_SCHEDULER_TIMEZONE", "Asia/Ho_Chi_Minh")
HOURLY_CRAWL_SCHEDULER_LEASE_MINUTES = int(os.getenv("HOURLY_CRAWL_SCHEDULER_LEASE_MINUTES", "180"))

# Review status
STATUS_PENDING = "pending"
STATUS_APPROVED = "approved"
STATUS_REJECTED = "rejected"
