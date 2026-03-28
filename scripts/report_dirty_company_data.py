"""Generate a concise report of suspicious company data that still needs manual review."""
import asyncio
import json
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from database.mongodb import build_company_data_report, close, connect, get_database

REPORT_PATH = ROOT_DIR / "scripts" / "output" / "dirty_company_data_report.json"


async def main():
    await connect()
    db = get_database()
    try:
        REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        report = await build_company_data_report(db)
        REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(
            {
                "report_path": str(REPORT_PATH),
                "suspicious_names": len(report["suspicious_names"]),
                "case_collisions": len(report["case_collisions"]),
                "alias_conflicts": len(report["alias_conflicts"]),
                "alias_duplicates": len(report["alias_duplicates"]),
                "missing_canonical_companies": len(report["missing_canonical_companies"]),
            }
        )
    finally:
        await close()


if __name__ == "__main__":
    asyncio.run(main())
