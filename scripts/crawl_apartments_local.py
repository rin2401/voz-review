"""Local apartment (chung cư) crawl runner.

Crawls apartment threads (threads.kind == "apartment") from voz.vn under plain
Python, where Cloudflare's per-invocation CPU limit does not apply, and writes
into the apartment collections (apartments / apartment_reviews) — never the
company collections. The extraction logic mirrors workers/crawler/apartment-extract.js.

Holds the shared scheduler lock (scheduler_states, job crawl_all_threads, the
same lock the Worker cron uses) for the whole run so Worker cron cycles skip
while this run is active; the lock is released on every exit path.

Usage:
    python scripts/crawl_apartments_local.py --env-file .env [--url <thread-url>] \
        [--max-pages N] [--lease-minutes 120]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

from pymongo.errors import BulkWriteError

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

# Keep the in-process scheduler off; only the crawl helpers are used here.
os.environ.setdefault("HOURLY_CRAWL_SCHEDULER_ENABLED", "false")


def load_env_file(path: Path) -> None:
    """Load simple KEY=VALUE lines before importing app config."""
    if not path.exists():
        return

    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def resolve_mongo_uri() -> str:
    return os.getenv("MONGO_URI") or os.getenv("MONGODB_URI") or ""


def require_atlas_uri(allow_local: bool) -> None:
    mongo_uri = resolve_mongo_uri()
    if allow_local:
        return
    if mongo_uri.startswith("mongodb+srv://") or "mongodb.net" in mongo_uri:
        return
    raise SystemExit(
        "Refusing to crawl without a MongoDB Atlas URI. Set MONGODB_URI/MONGO_URI "
        "or pass --allow-local for local development."
    )


APARTMENT_ALIASES_PATH = ROOT_DIR / "data" / "apartment_aliases.json"

# Numbered-list prefixes ("1. Tên dự án:") are common in these threads.
LIST_PREFIX = re.compile(r"^(?:[•·●▪◦*\-]+|\d+[.)])\s*")

APARTMENT_LABEL = re.compile(r"^\s*(?:tên dự án|ten du an|tên du an|dự án|du an)\s*(:?)", re.IGNORECASE)
APARTMENT_LABEL_SPLIT = re.compile(r"(?:tên dự án|ten du an|tên du an|dự án|du an)", re.IGNORECASE)

SKIP_PHRASES = [
    "xin review", "xin đánh giá", "xin ít", "cho em hỏi", "cho mình hỏi", "cho các bác",
    "có ai", "có nên", "tư vấn", "hỏi về", "cần hỏi", "cần tư vấn", "cho e hỏi",
]
VALUE_SKIP_TOKENS = [
    "xin", "hỏi", "hoi", "cho em", "cho mình", "có nên", "thế nào", "the nao",
    "tư vấn", "tu van", "tên gì", "ten gi",
]
DASH_NOTE_KEYWORDS = [
    "review", "xin review", "cho em hỏi", "cho mình hỏi", "có nên",
    "thế nào", "the nao", "tư vấn", "tu van", "hỏi", "hoi", "đánh giá", "danh gia",
]


def load_apartment_alias_map() -> dict[str, str]:
    if not APARTMENT_ALIASES_PATH.exists():
        return {}
    payload = json.loads(APARTMENT_ALIASES_PATH.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        return {}
    return {
        (alias or "").strip(): (canonical or "").strip()
        for alias, canonical in payload.items()
        if (alias or "").strip() and (canonical or "").strip()
    }


class ApartmentExtractor:
    """Apartment name extraction, mirroring workers/crawler/apartment-extract.js."""

    def __init__(self, alias_map: dict[str, str]):
        self.alias_map = alias_map
        self.candidates = self._build_candidates(alias_map)

    @staticmethod
    def _build_candidates(alias_map: dict[str, str]) -> list[tuple[str, str, re.Pattern]]:
        candidates = []
        seen = set()
        for alias, canonical in alias_map.items():
            for raw_name in (alias, canonical):
                name = (raw_name or "").strip()
                if len(name) < 3:
                    continue
                key = name.lower()
                if key in seen:
                    continue
                seen.add(key)
                pattern = re.compile(rf"(?<!\w){re.escape(name)}(?!\w)", re.IGNORECASE)
                candidates.append((name, canonical, pattern))
        candidates.sort(key=lambda item: len(item[0]), reverse=True)
        return candidates

    def apply_alias(self, apartment: str) -> str:
        from database.company_aliases import resolve_canonical_company

        return resolve_canonical_company(apartment or "", alias_map=self.alias_map)

    def normalize_apartments(self, apartments: list[str]) -> list[str]:
        normalized = []
        seen = set()
        for raw_apartment in apartments or []:
            apartment = self.apply_alias((raw_apartment or "").strip())
            if not apartment or apartment == "Unknown":
                continue
            key = apartment.lower()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(apartment)
        return normalized

    @staticmethod
    def clean_apartment_name(apartment: str) -> str:
        """Clean a raw apartment name; location qualifiers (quận/Q7/TP HCM...) stay."""
        apartment = (apartment or "").strip()

        # Drop trailing notes in parentheses, e.g. "The Global City (đang xây)"
        apartment = re.split(r"\s*\(", apartment, maxsplit=1)[0].strip()

        # Drop trailing note after dash only when the right side looks like a note
        dash_parts = re.split(r"\s+[-–—]\s+", apartment, maxsplit=1)
        if len(dash_parts) == 2:
            right_side = dash_parts[1].strip()
            right_lower = right_side.lower()
            if right_side and any(token in right_lower for token in DASH_NOTE_KEYWORDS):
                apartment = dash_parts[0].strip()

        # Drop trailing note after comma, e.g. "Akari City, Nam Long"
        apartment = re.split(r"\s*,\s*", apartment, maxsplit=1)[0].strip()

        # Clean punctuation around edges but keep wildcard '*' used in censored names
        apartment = apartment.rstrip(".,;:")
        apartment = re.sub(r"^[^\w\s&*]+|[^\w\s&*]+$", "", apartment)
        return apartment.strip()

    @staticmethod
    def _find_section_starts(lines: list[str]) -> list[int]:
        section_starts = []
        for index, raw_line in enumerate(lines):
            line = raw_line.strip()
            if not line:
                continue
            normalized_line = LIST_PREFIX.sub("", line)
            if APARTMENT_LABEL.match(normalized_line):
                section_starts.append(index)
        return section_starts

    def split_apartment_sections(self, content: str) -> list[str]:
        lines = content.split("\n")
        section_starts = self._find_section_starts(lines)
        if len(section_starts) < 2:
            return [content]

        sections = []
        boundaries = section_starts + [len(lines)]
        for start, end in zip(boundaries, boundaries[1:]):
            section = "\n".join(lines[start:end]).strip()
            if section:
                sections.append(section)
        return sections or [content]

    def _normalize_extracted_apartment(self, raw_apartment: str) -> str:
        apartment = self.clean_apartment_name(raw_apartment)
        words = [w for w in apartment.split() if w and w not in {"-", "–", "—"}]
        # Complex names are proper nouns; a lowercase start means the label
        # value is a prose sentence, not a name.
        if not apartment or not apartment[0].isupper():
            return ""
        if len(words) > 8:
            return ""
        if len(apartment) < 3 or len(apartment) > 80:
            return ""
        return apartment

    def extract_apartment(self, content: str) -> str:
        lines = content.split("\n")

        # Skip if this looks like a question/request post
        first_line = lines[0].lower() if lines else ""
        if any(phrase in first_line for phrase in SKIP_PHRASES):
            if "said:" not in content.lower():
                return "Unknown"

        def _next_non_empty_line(start_index: int) -> str:
            for candidate in lines[start_index + 1:]:
                candidate = candidate.strip()
                if candidate:
                    return candidate
            return ""

        # Look for "Tên dự án:" / "Dự án:" at the START of a line (optionally
        # behind a bullet or numbered-list prefix)
        for index, raw_line in enumerate(lines):
            line = raw_line.strip()
            normalized_line = LIST_PREFIX.sub("", line)
            lower_line = normalized_line.lower()
            if not (
                lower_line.startswith("tên dự án")
                or lower_line.startswith("ten du an")
                or lower_line.startswith("dự án")
                or lower_line.startswith("du an")
            ):
                continue

            if ":" in normalized_line:
                apartment = normalized_line.split(":", 1)[1].strip()
            else:
                apartment = APARTMENT_LABEL_SPLIT.split(normalized_line, maxsplit=1)[-1].strip()

            if not apartment:
                apartment = _next_non_empty_line(index)

            # Skip if it's clearly not a complex name
            if len(apartment) < 3:
                return "Unknown"
            if any(token in apartment.lower() for token in VALUE_SKIP_TOKENS):
                return "Unknown"

            normalized_apartment = self._normalize_extracted_apartment(apartment)
            if normalized_apartment:
                return normalized_apartment

        # Fallback: longest matching alias/canonical name inside content
        for _name, canonical, pattern in self.candidates:
            if pattern.search(content):
                return canonical

        return "Unknown"

    def extract_apartments(self, content: str) -> list[str]:
        sections = self.split_apartment_sections(content)
        extracted: list[str] = []

        if len(sections) > 1:
            for section in sections:
                apartment = self.extract_apartment(section)
                if apartment and apartment != "Unknown":
                    extracted.append(apartment)

        if not extracted:
            apartment = self.extract_apartment(content)
            if apartment and apartment != "Unknown":
                extracted.append(apartment)

        return self.normalize_apartments(extracted)


def aliases_for_name(alias_map: dict[str, str], name: str) -> list[str]:
    """Aliases grouped under a canonical name, mirroring workers/crawler/aliases.js."""
    from database.company_aliases import resolve_canonical_company

    canonical = (name or "").strip()
    if not canonical:
        return []
    canonical_key = canonical.lower()
    aliases: list[str] = []
    seen: set[str] = set()
    for raw_alias, raw_canonical in (alias_map or {}).items():
        resolved = resolve_canonical_company((raw_canonical or "").strip(), alias_map=alias_map)
        if not resolved or resolved != canonical:
            continue
        alias = (raw_alias or "").strip()
        if not alias or alias == "Unknown":
            continue
        key = alias.lower()
        if key == canonical_key or key in seen:
            continue
        seen.add(key)
        aliases.append(alias)
    return aliases


def detect_total_pages(html: str) -> int:
    numbers = [int(match.group(1)) for match in re.finditer(r"/page-(\d+)", html)]
    return max(numbers) if numbers else 1


async def insert_apartment_reviews(reviews_collection, review_docs: list[dict]) -> tuple[int, int]:
    """Batch insert with duplicate-key tolerance; returns (inserted, skipped)."""
    if not review_docs:
        return (0, 0)
    try:
        await reviews_collection.insert_many(review_docs, ordered=False)
        return (len(review_docs), 0)
    except BulkWriteError as error:
        details = getattr(error, "details", None) or {}
        write_errors = details.get("writeErrors") or []
        duplicate_only = all(err.get("code") == 11000 for err in write_errors)
        if not duplicate_only:
            raise
        inserted = int(details.get("nInserted") or 0)
        return (inserted, len(review_docs) - inserted)


async def ensure_apartments_exist(apartments_collection, names, alias_map: dict[str, str]) -> None:
    now = datetime.utcnow()
    for name in names:
        await apartments_collection.update_one(
            {"name": name},
            {
                "$setOnInsert": {"name": name, "created_at": now},
                "$set": {"aliases": aliases_for_name(alias_map, name), "updated_at": now},
            },
            upsert=True,
        )


async def crawl_apartment_thread(crawler, extractor, db, url: str, max_pages: int) -> dict:
    import config
    from database.mongodb import get_thread_state, set_thread_crawl_status, update_thread_state

    thread_id = crawler._extract_thread_id(url) or None
    first_page_url = url if url.endswith("/") else f"{url}/"

    first_html = await crawler.get_page_html(first_page_url)
    total_pages = detect_total_pages(first_html)

    state = await get_thread_state(thread_id=thread_id, url=url)
    start_page = max(1, int(state.get("last_page") or 1)) if state else 1
    end_page = total_pages if max_pages == 0 else min(total_pages, start_page + max_pages - 1)
    print(f"Thread {url}: {total_pages} pages detected, resume from {start_page}, crawl until {end_page}")

    if state and state.get("crawl_status") == "running":
        # The scheduler lock we hold proves no other run is active.
        await set_thread_crawl_status(url, "idle")
    await set_thread_crawl_status(url, "running")

    reviews_collection = db["apartment_reviews"]
    apartments_collection = db["apartments"]
    pages_crawled = 0
    total_inserted = 0

    try:
        for page in range(start_page, end_page + 1):
            if page == 1:
                page_url = first_page_url
                html = first_html
            else:
                page_url = f"{first_page_url}page-{page}/"
                html = await crawler.get_page_html(page_url)

            posts = crawler.parse_thread_page(html, page_url)
            review_docs = []
            apartment_names = set()
            now = datetime.utcnow()
            for post_data in posts:
                # The parser fills company-specific fields on every post;
                # apartment reviews must not carry them.
                post_data.pop("company", None)
                post_data.pop("companies", None)
                post_data.pop("monthly_salary_million", None)
                post_data["apartments"] = extractor.extract_apartments(post_data.get("content") or "")
                apartment_names.update(post_data["apartments"])
                # Mirror the JS insert path: created_at drives the reply-tree
                # sort on the reader side; status defaults to "pending".
                post_data["created_at"] = now
                post_data["status"] = post_data.get("status") or "pending"
                review_docs.append(post_data)

            inserted, skipped = await insert_apartment_reviews(reviews_collection, review_docs)
            await ensure_apartments_exist(apartments_collection, apartment_names, extractor.alias_map)
            total_inserted += inserted
            print(f"  Page {page}/{end_page}: {inserted} inserted, {skipped} skipped duplicates")

            last_post_date = posts[-1].get("post_date") if posts else None
            await update_thread_state(
                thread_id=thread_id, url=url, last_post_date=last_post_date, last_page=page
            )
            pages_crawled += 1
            await asyncio.sleep(config.CRAWL_DELAY)
    except Exception as error:
        await set_thread_crawl_status(url, "error", str(error))
        raise
    await set_thread_crawl_status(url, "idle")
    print(f"Thread crawl complete: {url} ({pages_crawled} pages, {total_inserted} inserted)")
    return {"url": url, "pages_crawled": pages_crawled, "inserted": total_inserted}


async def run(args: argparse.Namespace) -> None:
    import config
    from crawler.voz_scraper import VozCrawler
    from database.mongodb import (
        close,
        complete_scheduler_run,
        connect,
        ensure_scheduler_state,
        get_all_threads,
        get_database,
        try_acquire_scheduler_lock,
    )
    from scheduler import SCHEDULER_JOB_NAME, next_top_of_hour_utc, utc_now

    await connect()
    db = get_database()
    timezone_name = config.HOURLY_CRAWL_SCHEDULER_TIMEZONE
    next_run_at = next_top_of_hour_utc(utc_now(), timezone_name)
    await ensure_scheduler_state(SCHEDULER_JOB_NAME, timezone_name, True, next_run_at)

    lock_until = datetime.utcnow() + timedelta(minutes=args.lease_minutes)
    lock_state = await try_acquire_scheduler_lock(
        SCHEDULER_JOB_NAME,
        reason="local-manual-apartments",
        timezone=timezone_name,
        enabled=True,
        lock_until=lock_until,
        next_run_at=next_run_at,
    )
    if not lock_state:
        print(
            "Scheduler lock is held by another run (Worker cron or manual trigger); "
            "retry shortly.",
            flush=True,
        )
        await close()
        sys.exit(2)
    print(f"Scheduler lock held until {lock_until.isoformat()}", flush=True)

    threads = await get_all_threads()
    if args.url:
        targets = [thread for thread in threads if thread.get("url") == args.url]
        if not targets:
            print(f"Thread not found in DB: {args.url}", flush=True)
            await complete_scheduler_run(
                SCHEDULER_JOB_NAME, status="error", error="thread not found", next_run_at=next_run_at
            )
            await close()
            sys.exit(1)
    else:
        targets = [thread for thread in threads if thread.get("kind") == "apartment" and thread.get("url")]
        if not targets:
            print("No apartment threads in DB", flush=True)
            await complete_scheduler_run(
                SCHEDULER_JOB_NAME, status="error", error="no apartment threads", next_run_at=next_run_at
            )
            await close()
            sys.exit(1)

    extractor = ApartmentExtractor(load_apartment_alias_map())
    summary = {"threads": len(targets), "pages": 0, "inserted": 0, "failed": 0}
    try:
        async with VozCrawler() as crawler:
            for thread in targets:
                url = thread["url"]
                print(f"Crawling {url}", flush=True)
                result = await crawl_apartment_thread(crawler, extractor, db, url, args.max_pages)
                summary["pages"] += result["pages_crawled"]
                summary["inserted"] += result["inserted"]
        result_text = (
            f"local apartments crawl: threads={summary['threads']}, "
            f"pages={summary['pages']}, inserted={summary['inserted']}, failed={summary['failed']}"
        )
        await complete_scheduler_run(
            SCHEDULER_JOB_NAME, status="success", result=result_text, next_run_at=next_run_at
        )
        print(f"Local apartment crawl complete: {result_text}", flush=True)
    except Exception as error:
        await complete_scheduler_run(
            SCHEDULER_JOB_NAME, status="error", error=str(error), next_run_at=next_run_at
        )
        print(f"Local crawl failed: {error}", flush=True)
        raise
    finally:
        await close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="Crawl one apartment thread URL. Defaults to all kind=apartment threads.")
    parser.add_argument("--max-pages", type=int, default=0, help="Pages per thread. 0 means crawl until current end.")
    parser.add_argument("--lease-minutes", type=int, default=120, help="Scheduler lock lease for this local run.")
    parser.add_argument(
        "--env-file",
        default=".env.local",
        help="Optional env file to load before importing config. Defaults to .env.local.",
    )
    parser.add_argument(
        "--allow-local",
        action="store_true",
        help="Allow non-Atlas MongoDB URIs for local development.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    load_env_file(ROOT_DIR / args.env_file)
    require_atlas_uri(allow_local=args.allow_local)
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
