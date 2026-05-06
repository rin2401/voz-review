#!/usr/bin/env python3
"""Run the repository's Voz-to-Atlas crawl from the correct working directory."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def find_repo_root(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        crawl_script = candidate / "scripts" / "crawl_voz_to_atlas.py"
        main_file = candidate / "main.py"
        if crawl_script.exists() and main_file.exists():
            return candidate
    raise SystemExit("Could not locate repository root from skill script path.")


def main() -> int:
    repo_root = find_repo_root(Path(__file__).resolve())
    command = [
        sys.executable,
        "scripts/crawl_voz_to_atlas.py",
        "--env-file",
        ".env",
    ]
    command.extend(sys.argv[1:])
    if "--max-pages" not in sys.argv[1:]:
        command.extend(["--max-pages", "0"])
    return subprocess.call(command, cwd=repo_root)


if __name__ == "__main__":
    raise SystemExit(main())
