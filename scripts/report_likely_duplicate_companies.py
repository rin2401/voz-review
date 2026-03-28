"""Generate a manual-review report of company names that may be duplicates."""
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from database.mongodb import build_likely_duplicate_company_report, close, connect, get_database

REPORT_PATH = ROOT_DIR / "scripts" / "output" / "likely_duplicate_companies_report.json"
RUN_TIMEOUT_SECONDS = 30
HEURISTIC_SUMMARY = [
    "ASCII-normalized case/spacing/punctuation folding.",
    "Leetspeak substitutions such as 0->o and 1->i.",
    "Masked-character matches using * in aligned positions.",
    "Corporate suffix folding for generic endings like company, corp, inc, ltd, llc, vn, vietnam.",
    "Shared strong-token matches for low-frequency, non-generic company tokens with conservative token-expansion guards.",
    "Conservative close-spelling detection within blocked buckets.",
]


def _print_group(group: dict):
    confidence = str(group["confidence"]).upper()
    print(f"[{confidence}] {group['proposed_canonical_name']}  total_reviews={group['total_review_count']}")
    print(f"  reasons: {', '.join(group['reasons'])}")
    print(f"  canonical_basis: {group['canonical_reason']}")
    for member in group["members"]:
        extras = []
        if member["review_count"]:
            extras.append(f"reviews={member['review_count']}")
        if member["quality_flags"]:
            extras.append(f"flags={','.join(member['quality_flags'])}")
        if member["aliases"]:
            extras.append(f"aliases={', '.join(member['aliases'][:3])}")
        suffix = f" ({'; '.join(extras)})" if extras else ""
        print(f"  - {member['name']}{suffix}")


def _format_error(exc: Exception) -> str:
    if isinstance(exc, asyncio.TimeoutError):
        return f"Timed out after {RUN_TIMEOUT_SECONDS}s while connecting to MongoDB or querying company data."
    message = str(exc).strip()
    if message:
        return message
    return exc.__class__.__name__


async def main():
    report = None
    try:
        REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.wait_for(connect(), timeout=RUN_TIMEOUT_SECONDS)
        db = get_database()
        report = await asyncio.wait_for(build_likely_duplicate_company_report(db), timeout=RUN_TIMEOUT_SECONDS)
    except Exception as exc:
        error_message = _format_error(exc)
        report = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "status": "error",
            "error": error_message,
            "total_companies_scanned": 0,
            "groups": [],
            "summary": {
                "group_count": 0,
                "high_confidence_groups": 0,
                "medium_confidence_groups": 0,
            },
            "heuristics": HEURISTIC_SUMMARY,
        }
        REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"report_path": str(REPORT_PATH), "status": "error", "error": error_message}, ensure_ascii=False))
        return 1
    finally:
        await close()

    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = report["summary"]
    print(
        json.dumps(
            {
                "report_path": str(REPORT_PATH),
                "total_companies_scanned": report["total_companies_scanned"],
                "group_count": summary["group_count"],
                "high_confidence_groups": summary["high_confidence_groups"],
                "medium_confidence_groups": summary["medium_confidence_groups"],
            },
            ensure_ascii=False,
        )
    )
    print("")
    for group in report["groups"]:
        _print_group(group)
        print("")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
