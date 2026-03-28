"""Heuristics for suggesting likely duplicate company names for manual review."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from difflib import SequenceMatcher
import re
import unicodedata
from typing import Iterable

from database.company_aliases import load_company_alias_map, normalize_aliases, resolve_canonical_company

LEET_TRANSLATION = str.maketrans(
    {
        "0": "o",
        "1": "i",
        "3": "e",
        "4": "a",
        "5": "s",
        "6": "g",
        "7": "t",
        "8": "b",
    }
)

CORPORATE_SUFFIXES = {
    "co",
    "company",
    "corp",
    "corporation",
    "inc",
    "incorporated",
    "jsc",
    "limited",
    "ltd",
    "llc",
    "vn",
    "vietnam",
}

GENERIC_MATCH_TOKENS = CORPORATE_SUFFIXES | {
    "bank",
    "capital",
    "digital",
    "global",
    "group",
    "holding",
    "holdings",
    "international",
    "partner",
    "partners",
    "service",
    "services",
    "software",
    "solution",
    "solutions",
    "system",
    "systems",
    "tech",
    "technology",
    "technologies",
}

STRONG_TOKEN_MIN_LENGTH = 5
MAX_SHARED_TOKEN_FREQUENCY = 4
MAX_SINGLE_TOKEN_EXPANSION = 1

HIGH_CONFIDENCE = "high"
MEDIUM_CONFIDENCE = "medium"

CONFIDENCE_LABELS = {
    100: HIGH_CONFIDENCE,
    98: HIGH_CONFIDENCE,
    95: HIGH_CONFIDENCE,
    92: HIGH_CONFIDENCE,
    88: MEDIUM_CONFIDENCE,
    84: MEDIUM_CONFIDENCE,
}


@dataclass(frozen=True)
class CompanyProfile:
    name: str
    review_count: int
    aliases: tuple[str, ...]
    alias_set: frozenset[str]
    tokens: tuple[str, ...]
    strong_tokens: frozenset[str]
    compact: str
    masked_compact: str
    leet_compact: str
    core_compact: str
    canonical_target: str
    quality_score: int
    quality_flags: tuple[str, ...]


@dataclass(frozen=True)
class PairEvidence:
    left_name: str
    right_name: str
    score: int
    match_reason: str
    reasons: tuple[str, ...]
    shared_tokens: tuple[str, ...] = ()


class _UnionFind:
    def __init__(self, items: Iterable[str]):
        self.parent = {item: item for item in items}

    def find(self, item: str) -> str:
        parent = self.parent[item]
        if parent != item:
            self.parent[item] = self.find(parent)
        return self.parent[item]

    def union(self, left: str, right: str):
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            self.parent[right_root] = left_root


def _ascii_fold(text: str) -> str:
    folded = unicodedata.normalize("NFKD", text or "")
    return "".join(char for char in folded if not unicodedata.combining(char))


def _normalize_space_punctuation(text: str) -> str:
    folded = _ascii_fold(text).casefold()
    folded = folded.replace("&", " and ")
    return re.sub(r"[^a-z0-9*]+", " ", folded).strip()


def _compact(text: str, *, keep_mask: bool = False) -> str:
    pattern = r"[^a-z0-9*]+" if keep_mask else r"[^a-z0-9]+"
    return re.sub(pattern, "", _normalize_space_punctuation(text))


def _leet_fold(compact_text: str, *, keep_mask: bool = False) -> str:
    translated = compact_text.translate(LEET_TRANSLATION)
    pattern = r"[^a-z*]+" if keep_mask else r"[^a-z]+"
    return re.sub(pattern, "", translated)


def _core_compact(text: str) -> str:
    normalized = _normalize_space_punctuation(text).translate(LEET_TRANSLATION)
    tokens = [token for token in re.findall(r"[a-z0-9]+", normalized) if token not in CORPORATE_SUFFIXES]
    if not tokens:
        return _leet_fold(_compact(text))
    return "".join(tokens)


def _quality_flags(name: str) -> tuple[str, ...]:
    flags = []
    if "*" in name:
        flags.append("masked")
    if re.search(r"\d", name):
        flags.append("contains_digits")
    if re.search(r"[^\w\s&*.+/-]", name):
        flags.append("special_punctuation")
    if name != name.strip():
        flags.append("surrounding_whitespace")
    if name.islower():
        flags.append("all_lowercase")
    return tuple(flags)


def _quality_score(name: str, review_count: int) -> int:
    score = min(int(review_count or 0), 50)
    score += 8 if "*" not in name else -10
    score += 6 if not re.search(r"\d", name) else -4
    score += 3 if name == name.strip() else -2
    score += 3 if re.search(r"[A-Za-z]", name) else -5
    score += 2 if not re.search(r"[^\w\s&*.+/-]", name) else -2
    score += 2 if not name.islower() else -1
    return score


def _normalized_tokens(text: str) -> tuple[str, ...]:
    return tuple(re.findall(r"[a-z0-9]+", _normalize_space_punctuation(text)))


def _strong_tokens(tokens: tuple[str, ...]) -> frozenset[str]:
    return frozenset(
        token
        for token in tokens
        if len(token) >= STRONG_TOKEN_MIN_LENGTH and token not in GENERIC_MATCH_TOKENS
    )


def build_company_profile(company: dict, alias_map: dict[str, str] | None = None) -> CompanyProfile:
    name = str(company.get("name") or "").strip()
    review_count = int(company.get("review_count") or 0)
    raw_aliases = company.get("aliases") or []
    if isinstance(raw_aliases, str):
        raw_aliases = [raw_aliases]
    aliases = tuple(normalize_aliases(raw_aliases, canonical_name=name))
    alias_set = frozenset(alias.casefold() for alias in aliases)
    active_alias_map = alias_map if alias_map is not None else load_company_alias_map()
    return CompanyProfile(
        name=name,
        review_count=review_count,
        aliases=aliases,
        alias_set=alias_set,
        tokens=_normalized_tokens(name),
        strong_tokens=_strong_tokens(_normalized_tokens(name)),
        compact=_compact(name),
        masked_compact=_leet_fold(_compact(name, keep_mask=True), keep_mask=True),
        leet_compact=_leet_fold(_compact(name)),
        core_compact=_core_compact(name),
        canonical_target=resolve_canonical_company(name, alias_map=active_alias_map),
        quality_score=_quality_score(name, review_count),
        quality_flags=_quality_flags(name),
    )


def _masked_match(left: CompanyProfile, right: CompanyProfile) -> bool:
    if "*" not in left.masked_compact and "*" not in right.masked_compact:
        return False
    if not left.masked_compact or not right.masked_compact:
        return False
    if len(left.masked_compact) != len(right.masked_compact):
        return False
    for left_char, right_char in zip(left.masked_compact, right.masked_compact):
        if left_char == "*" or right_char == "*":
            continue
        if left_char != right_char:
            return False
    return True


def _close_spelling_match(left: CompanyProfile, right: CompanyProfile) -> bool:
    left_value = left.core_compact or left.leet_compact
    right_value = right.core_compact or right.leet_compact
    if min(len(left_value), len(right_value)) < 6:
        return False
    if abs(len(left_value) - len(right_value)) > 2:
        return False
    if left_value[:1] != right_value[:1]:
        return False
    if left_value[:4] != right_value[:4]:
        return False
    return SequenceMatcher(None, left_value, right_value).ratio() >= 0.92


def _is_single_token_expansion(left_tokens: tuple[str, ...], right_tokens: tuple[str, ...]) -> bool:
    if not left_tokens or not right_tokens:
        return False
    shorter, longer = sorted((left_tokens, right_tokens), key=len)
    extra = len(longer) - len(shorter)
    if extra < 0 or extra > MAX_SINGLE_TOKEN_EXPANSION:
        return False
    return longer[: len(shorter)] == shorter or longer[-len(shorter) :] == shorter


def _shared_strong_tokens(
    left: CompanyProfile,
    right: CompanyProfile,
    token_frequencies: dict[str, int],
) -> tuple[str, ...]:
    return tuple(
        sorted(
            token
            for token in (left.strong_tokens & right.strong_tokens)
            if token_frequencies.get(token, 0) <= MAX_SHARED_TOKEN_FREQUENCY
        )
    )


def _pair_evidence(
    left: CompanyProfile,
    right: CompanyProfile,
    token_frequencies: dict[str, int],
) -> PairEvidence | None:
    left_name = left.name
    right_name = right.name
    reasons = []
    score = 0
    match_reason = ""
    shared_tokens: tuple[str, ...] = ()

    def apply_reason(reason: str, new_score: int, *, matched_tokens: tuple[str, ...] = ()) -> None:
        nonlocal score, match_reason, shared_tokens
        reasons.append(reason)
        if matched_tokens:
            shared_tokens = matched_tokens
        if new_score > score:
            score = new_score
            match_reason = reason

    if left_name == right_name:
        return None

    if left_name.casefold() in right.alias_set or right_name.casefold() in left.alias_set:
        apply_reason("alias_cross_reference", 98)

    if (
        left.canonical_target
        and right.canonical_target
        and left.canonical_target == right.canonical_target
        and len({left_name, right_name, left.canonical_target}) > 1
    ):
        apply_reason("same_alias_canonical", 95)

    if left.compact and left.compact == right.compact:
        apply_reason("case_spacing_punctuation_fold", 100)

    if left.leet_compact and left.leet_compact == right.leet_compact and left.compact != right.compact:
        apply_reason("leetspeak_fold", 95)

    if _masked_match(left, right):
        apply_reason("masked_character_match", 92)

    if (
        left.core_compact
        and left.core_compact == right.core_compact
        and left.leet_compact != right.leet_compact
        and len(left.core_compact) >= 5
    ):
        apply_reason("corporate_suffix_fold", 88)

    pair_shared_tokens = _shared_strong_tokens(left, right, token_frequencies)
    if pair_shared_tokens:
        has_subset_support = bool(left.strong_tokens) and bool(right.strong_tokens) and (
            left.strong_tokens <= right.strong_tokens or right.strong_tokens <= left.strong_tokens
        )
        if len(pair_shared_tokens) >= 2 and has_subset_support:
            apply_reason("shared_strong_token", 88, matched_tokens=pair_shared_tokens)
        elif len(pair_shared_tokens) == 1 and has_subset_support and _is_single_token_expansion(left.tokens, right.tokens):
            apply_reason("shared_strong_token", 84, matched_tokens=pair_shared_tokens)

    if _close_spelling_match(left, right):
        apply_reason("close_spelling_variant", 84)

    if score < 84:
        return None
    return PairEvidence(
        left_name=left_name,
        right_name=right_name,
        score=score,
        match_reason=match_reason,
        reasons=tuple(sorted(set(reasons))),
        shared_tokens=shared_tokens,
    )


def _propose_canonical_name(profiles: list[CompanyProfile]) -> tuple[str, str]:
    canonical_candidates = {}
    for profile in profiles:
        target = profile.canonical_target
        if not target:
            continue
        canonical_candidates[target] = canonical_candidates.get(target, 0) + 1

    if canonical_candidates:
        target, count = max(canonical_candidates.items(), key=lambda item: (item[1], item[0]))
        if target in {profile.name for profile in profiles} and count >= 2:
            return target, "existing_alias_map"

    chosen = max(
        profiles,
        key=lambda profile: (
            profile.quality_score,
            profile.review_count,
            len(profile.core_compact or profile.leet_compact),
            len(profile.name),
        ),
    )
    return chosen.name, "quality_and_review_count"


def _human_members(profiles: list[CompanyProfile]) -> list[dict]:
    members = []
    for profile in sorted(
        profiles,
        key=lambda item: (-item.review_count, -item.quality_score, item.name.casefold()),
    ):
        members.append(
            {
                "name": profile.name,
                "review_count": profile.review_count,
                "aliases": list(profile.aliases),
                "quality_flags": list(profile.quality_flags),
            }
        )
    return members


def analyze_likely_duplicate_companies(
    companies: list[dict],
    alias_map: dict[str, str] | None = None,
) -> dict[str, object]:
    active_alias_map = alias_map if alias_map is not None else load_company_alias_map()
    profiles = [build_company_profile(company, alias_map=active_alias_map) for company in companies if str(company.get("name") or "").strip()]
    profiles_by_name = {profile.name: profile for profile in profiles}
    all_evidence: dict[tuple[str, str], PairEvidence] = {}

    compact_buckets: dict[str, list[CompanyProfile]] = {}
    leet_buckets: dict[str, list[CompanyProfile]] = {}
    core_buckets: dict[str, list[CompanyProfile]] = {}
    masked_buckets: dict[str, list[CompanyProfile]] = {}
    strong_token_buckets: dict[str, list[CompanyProfile]] = {}
    token_frequencies: dict[str, int] = {}

    for profile in profiles:
        if profile.compact:
            compact_buckets.setdefault(profile.compact, []).append(profile)
        if profile.leet_compact:
            leet_buckets.setdefault(profile.leet_compact, []).append(profile)
        if profile.core_compact:
            core_buckets.setdefault(profile.core_compact[:4], []).append(profile)
        if len(profile.masked_compact) >= 3:
            masked_buckets.setdefault(
                f"{len(profile.masked_compact)}:{profile.masked_compact[:1]}:{profile.masked_compact[-1:]}",
                [],
            ).append(profile)
        for token in profile.strong_tokens:
            token_frequencies[token] = token_frequencies.get(token, 0) + 1
            strong_token_buckets.setdefault(token, []).append(profile)

    candidate_pairs: set[tuple[str, str]] = set()

    for bucket in compact_buckets.values():
        if len(bucket) < 2:
            continue
        for index, left in enumerate(bucket):
            for right in bucket[index + 1 :]:
                candidate_pairs.add(tuple(sorted((left.name, right.name))))

    for bucket in leet_buckets.values():
        if len(bucket) < 2:
            continue
        for index, left in enumerate(bucket):
            for right in bucket[index + 1 :]:
                candidate_pairs.add(tuple(sorted((left.name, right.name))))

    for bucket in core_buckets.values():
        if len(bucket) < 2:
            continue
        ordered = sorted(bucket, key=lambda item: item.name.casefold())
        for index, left in enumerate(ordered):
            for right in ordered[index + 1 :]:
                candidate_pairs.add(tuple(sorted((left.name, right.name))))

    for bucket in masked_buckets.values():
        if len(bucket) < 2:
            continue
        ordered = sorted(bucket, key=lambda item: item.name.casefold())
        for index, left in enumerate(ordered):
            for right in ordered[index + 1 :]:
                candidate_pairs.add(tuple(sorted((left.name, right.name))))

    for token, bucket in strong_token_buckets.items():
        if len(bucket) < 2 or token_frequencies.get(token, 0) > MAX_SHARED_TOKEN_FREQUENCY:
            continue
        ordered = sorted(bucket, key=lambda item: item.name.casefold())
        for index, left in enumerate(ordered):
            for right in ordered[index + 1 :]:
                candidate_pairs.add(tuple(sorted((left.name, right.name))))

    for left_name, right_name in sorted(candidate_pairs):
        evidence = _pair_evidence(profiles_by_name[left_name], profiles_by_name[right_name], token_frequencies)
        if evidence is not None:
            all_evidence[(left_name, right_name)] = evidence

    union_find = _UnionFind(profile.name for profile in profiles)
    for evidence in all_evidence.values():
        union_find.union(evidence.left_name, evidence.right_name)

    grouped_names: dict[str, list[str]] = {}
    for profile in profiles:
        root = union_find.find(profile.name)
        grouped_names.setdefault(root, []).append(profile.name)

    groups = []
    high_confidence_count = 0
    medium_confidence_count = 0

    for member_names in grouped_names.values():
        if len(member_names) < 2:
            continue
        member_profiles = [profiles_by_name[name] for name in sorted(member_names, key=str.casefold)]
        member_pairs = [
            evidence
            for (left_name, right_name), evidence in all_evidence.items()
            if left_name in member_names and right_name in member_names
        ]
        if not member_pairs:
            continue
        top_score = max(evidence.score for evidence in member_pairs)
        confidence = CONFIDENCE_LABELS[top_score]
        if confidence == HIGH_CONFIDENCE:
            high_confidence_count += 1
        else:
            medium_confidence_count += 1

        canonical_name, canonical_reason = _propose_canonical_name(member_profiles)
        groups.append(
            {
                "confidence": confidence,
                "confidence_score": top_score,
                "proposed_canonical_name": canonical_name,
                "canonical_reason": canonical_reason,
                "reasons": sorted({reason for evidence in member_pairs for reason in evidence.reasons}),
                "members": _human_members(member_profiles),
                "total_review_count": sum(profile.review_count for profile in member_profiles),
                "pair_matches": [
                    {
                        "left_name": evidence.left_name,
                        "right_name": evidence.right_name,
                        "confidence_score": evidence.score,
                        "match_reason": evidence.match_reason,
                        "reasons": list(evidence.reasons),
                        "shared_tokens": list(evidence.shared_tokens),
                    }
                    for evidence in sorted(member_pairs, key=lambda item: (-item.score, item.left_name.casefold(), item.right_name.casefold()))
                ],
            }
        )

    groups.sort(
        key=lambda group: (
            0 if group["confidence"] == HIGH_CONFIDENCE else 1,
            -int(group["total_review_count"]),
            -int(group["confidence_score"]),
            str(group["proposed_canonical_name"]).casefold(),
        )
    )

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_companies_scanned": len(profiles),
        "groups": groups,
        "summary": {
            "group_count": len(groups),
            "high_confidence_groups": high_confidence_count,
            "medium_confidence_groups": medium_confidence_count,
        },
        "heuristics": [
            "Exact folds on case, spacing, and punctuation after ASCII normalization.",
            "Leetspeak folding for common substitutions: 0->o, 1->i, 3->e, 4->a, 5->s, 6->g, 7->t, 8->b.",
            "Masked-character matching when one or both variants replace characters with * at the same positions.",
            "Corporate-suffix folding for generic suffixes such as company, co, corp, inc, ltd, llc, jsc, vn, vietnam.",
            "Shared strong-token matching for low-frequency, non-generic company tokens with conservative token-expansion guards.",
            "Close-spelling matching within blocked buckets using SequenceMatcher with conservative thresholds.",
            "Canonical suggestion prefers existing alias-map canonicals, then the highest-quality, highest-volume variant.",
        ],
    }
