"""One-shot backfill: clean up over-long apartment (chung cu) names.

Drops street/developer/district qualifiers from canonical apartment names
(e.g. "Eaton Park Q2 – Gamuda Land" -> "Eaton Park"), merges two
near-duplicates into their canonical project ("Elysian Q9" -> "The Elysian"),
and recomputes DB aliases from data/apartment_aliases.json — the same source
the Worker upsert uses, so DB and fixture stay in sync.

Run AFTER editing data/apartment_aliases.json (old names must already be
registered as aliases of the new canonicals). Reviews are re-attributed by
rewriting the `apartments` array on apartment_reviews docs.

Usage:
    python scripts/cleanup_apartment_names.py --env-file .env [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from pymongo import MongoClient

ROOT_DIR = Path(__file__).resolve().parent.parent
ALIASES_PATH = ROOT_DIR / "data" / "apartment_aliases.json"

# (old canonical, new canonical) — renamed in place, old name becomes an alias.
RENAMES: list[tuple[str, str]] = [
    ("Cao ốc Thịnh Vượng đường Nguyễ Duy Trinh", "Cao ốc Thịnh Vượng"),
    ("Prosper Phố Đông của CĐT Phúc Yên", "Prosper Phố Đông"),
    ("Eaton Park Q2 – Gamuda Land", "Eaton Park"),
    ("Park Vista Nguyễn Hữu Thọ", "Park Vista"),
    ("Viva Plaza đường 15B", "Viva Plaza"),
    ("De Capella quận 2", "De Capella"),
    ("Gladia Khang Điền", "Gladia"),
    ("West Gate Bình Chánh", "West Gate"),
    ("Esme’ Dĩ An", "Esme"),
    ("Marina TOWER", "Marina Tower"),
    ("Charmora city", "Charmora City"),
]

# (old canonical, existing canonical) — old doc deleted, reviews re-attributed.
MERGES: list[tuple[str, str]] = [
    ("Elysian Q9", "The Elysian"),
    ("Moonlight Residences", "Moonlight Residence"),
]

# Canonicals whose DB aliases are stale after the fixture edit (junk typo
# aliases removed from Lumiere Boulevard, new alias added for CTL Tham Lương).
RECOMPUTE_ALIASES: list[str] = ["Lumiere Boulevard", "CTL Tham Lương"]


def load_env_file(path: Path) -> None:
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


def resolve_canonical(name: str, alias_map: dict[str, str]) -> str:
    """Follow an alias chain to its canonical name (mirrors aliases.js)."""
    seen: set[str] = set()
    current = (name or "").strip()
    while current not in seen:
        seen.add(current)
        mapped = (alias_map.get(current) or "").strip()
        if not mapped or mapped == current:
            return current
        current = mapped
    return current


def aliases_for(name: str, alias_map: dict[str, str]) -> list[str]:
    """Aliases registered for a canonical name, mirroring normalizeAliases."""
    canonical_key = (name or "").strip().lower()
    out: list[str] = []
    seen: set[str] = set()
    for alias, canonical in alias_map.items():
        if resolve_canonical(canonical, alias_map) != name:
            continue
        cleaned = (alias or "").strip()
        if not cleaned or cleaned == "Unknown":
            continue
        key = cleaned.lower()
        if key == canonical_key or key in seen:
            continue
        seen.add(key)
        out.append(cleaned)
    return out


def reattribute(doc: dict, old: str, new: str) -> list[str] | None:
    """Rewrite a review's apartments array; None when nothing changes."""
    apartments = [a for a in doc.get("apartments") or [] if isinstance(a, str)]
    changed = any(a.strip().lower() == old.strip().lower() for a in apartments)
    if not changed:
        return None
    rewritten: list[str] = []
    seen: set[str] = set()
    for raw in apartments:
        value = new if raw.strip().lower() == old.strip().lower() else raw
        key = value.lower()
        if key in seen:
            continue
        seen.add(key)
        rewritten.append(value)
    return rewritten


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default=".env", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    load_env_file(args.env_file)
    uri = resolve_mongo_uri()
    if not uri:
        print("MONGO_URI (or MONGODB_URI) is required", file=sys.stderr)
        return 1

    db_name = os.getenv("MONGODB_DB") or os.getenv("MONGO_DB") or "voz_crawler"
    alias_map: dict[str, str] = {
        (alias or "").strip(): (canonical or "").strip()
        for alias, canonical in json.loads(ALIASES_PATH.read_text()).items()
        if (alias or "").strip() and (canonical or "").strip()
    }

    client = MongoClient(uri)
    db = client[db_name]
    apartments = db["apartments"]
    reviews = db["apartment_reviews"]
    now = datetime.now(timezone.utc)
    dry = args.dry_run

    # Safety checks first: every old name must exist, no rename target may
    # already exist, and every merge target must exist.
    for old, new in RENAMES:
        if not apartments.find_one({"name": old}):
            print(f"ABORT: rename source missing in DB: {old!r}", file=sys.stderr)
            return 1
        if apartments.find_one({"name": new}):
            print(f"ABORT: rename target already exists: {new!r}", file=sys.stderr)
            return 1
    for old, target in MERGES:
        if not apartments.find_one({"name": old}):
            print(f"ABORT: merge source missing in DB: {old!r}", file=sys.stderr)
            return 1
        if not apartments.find_one({"name": target}):
            print(f"ABORT: merge target missing in DB: {target!r}", file=sys.stderr)
            return 1

    for old, new in RENAMES:
        review_docs = list(reviews.find({"apartments": old}))
        print(f"RENAME {old!r} -> {new!r} | aliases={aliases_for(new, alias_map)} | reviews={len(review_docs)}")
        if dry:
            continue
        apartments.update_one(
            {"name": old},
            {"$set": {"name": new, "aliases": aliases_for(new, alias_map), "updated_at": now}},
        )
        for doc in review_docs:
            rewritten = reattribute(doc, old, new)
            if rewritten is not None:
                reviews.update_one({"_id": doc["_id"]}, {"$set": {"apartments": rewritten}})

    for old, target in MERGES:
        review_docs = list(reviews.find({"apartments": old}))
        print(f"MERGE {old!r} into {target!r} | reviews={len(review_docs)}")
        if dry:
            continue
        apartments.delete_one({"name": old})
        for doc in review_docs:
            rewritten = reattribute(doc, old, target)
            if rewritten is not None:
                reviews.update_one({"_id": doc["_id"]}, {"$set": {"apartments": rewritten}})
        apartments.update_one(
            {"name": target},
            {"$set": {"aliases": aliases_for(target, alias_map), "updated_at": now}},
        )

    for name in RECOMPUTE_ALIASES:
        doc = apartments.find_one({"name": name})
        if not doc:
            print(f"SKIP recompute (missing): {name!r}", file=sys.stderr)
            continue
        print(f"RECOMPUTE aliases {name!r} -> {aliases_for(name, alias_map)}")
        if not dry:
            apartments.update_one(
                {"_id": doc["_id"]},
                {"$set": {"aliases": aliases_for(name, alias_map), "updated_at": now}},
            )

    print("done" + (" (dry-run)" if dry else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
