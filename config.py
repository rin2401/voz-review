"""Configuration for Voz Review Crawler"""
import os
from pathlib import Path

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

# Review status
STATUS_PENDING = "pending"
STATUS_APPROVED = "approved"
STATUS_REJECTED = "rejected"
