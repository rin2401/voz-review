"""Dump parsed posts from the shared fixture as JSON for JS/Python parity checks."""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from crawler.voz_scraper import VozCrawler

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "voz_thread_page.html"
FORUM_URL = "https://voz.vn/t/nhan-xet-ve-moi-cong-ty-noi-tieng-trong-nganh-it-cntt.677450/"


def default(value):
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc)
        return value.strftime("%Y-%m-%dT%H:%M:%S")
    raise TypeError(f"not serializable: {type(value)}")


crawler = VozCrawler()
posts = crawler.parse_thread_page(FIXTURE.read_text(encoding="utf-8"), FORUM_URL)
print(json.dumps(posts, ensure_ascii=False, default=default))
