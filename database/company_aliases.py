"""Helpers for loading and normalizing company alias mappings."""
from functools import lru_cache
import json
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
ALIASES_PATH = ROOT_DIR / "data" / "company_aliases.json"


def normalize_aliases(raw_aliases: list[str], canonical_name: str | None = None) -> list[str]:
    normalized = []
    seen = set()
    canonical_key = (canonical_name or "").strip().lower()

    for raw_alias in raw_aliases:
        alias = (raw_alias or "").strip()
        if not alias or alias == "Unknown":
            continue
        key = alias.lower()
        if canonical_key and key == canonical_key:
            continue
        if key in seen:
            continue
        seen.add(key)
        normalized.append(alias)

    return normalized


@lru_cache(maxsize=1)
def load_company_alias_map() -> dict[str, str]:
    if not ALIASES_PATH.exists():
        return {}

    payload = json.loads(ALIASES_PATH.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        return {}

    normalized = {}
    for raw_alias, raw_canonical in payload.items():
        alias = (raw_alias or "").strip()
        canonical = (raw_canonical or "").strip()
        if not alias or not canonical:
            continue
        normalized[alias] = canonical
    return normalized


def resolve_canonical_company(name: str, alias_map: dict[str, str] | None = None) -> str:
    normalized_name = (name or "").strip()
    if not normalized_name:
        return ""

    active_alias_map = alias_map if alias_map is not None else load_company_alias_map()
    seen = set()
    current = normalized_name

    while current not in seen:
        seen.add(current)
        mapped = (active_alias_map.get(current) or "").strip()
        if not mapped or mapped == current:
            return current
        current = mapped

    return current


@lru_cache(maxsize=1)
def build_company_aliases_by_canonical() -> dict[str, list[str]]:
    alias_map = load_company_alias_map()
    grouped: dict[str, list[str]] = {}

    for raw_alias, raw_canonical in alias_map.items():
        canonical = resolve_canonical_company(raw_canonical, alias_map=alias_map)
        alias = (raw_alias or "").strip()
        if not alias or not canonical:
            continue
        grouped.setdefault(canonical, []).append(alias)

    return {
        canonical: normalize_aliases(aliases, canonical_name=canonical)
        for canonical, aliases in grouped.items()
    }


def company_aliases_for_name(name: str) -> list[str]:
    canonical_name = (name or "").strip()
    if not canonical_name:
        return []
    return list(build_company_aliases_by_canonical().get(canonical_name, []))
