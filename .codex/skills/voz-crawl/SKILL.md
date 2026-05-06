---
name: voz-crawl
description: Run or rerun the Voz review crawl that writes directly to MongoDB Atlas for this repository. Use when the user asks to crawl Voz data, rerun the Atlas crawl, seed and crawl configured threads, or crawl a specific Voz thread with `scripts/crawl_voz_to_atlas.py`.
---

# Voz Crawl

Use this skill to run the repository's manual Atlas crawl reliably.

## Workflow

1. Run the crawl from the repository root, not from `scripts/`.
2. Default to `python scripts/crawl_voz_to_atlas.py --env-file .env --max-pages 0`.
3. Use `./.codex/skills/voz-crawl/scripts/run_crawl.py` instead of reconstructing the command by hand.
4. If the user asks to crawl one thread only, pass `--url <voz-thread-url>`.
5. If the database is fresh and needs the built-in thread list, add `--seed-default-threads`.

## Commands

Default full crawl:

```bash
python .codex/skills/voz-crawl/scripts/run_crawl.py
```

Crawl one thread:

```bash
python .codex/skills/voz-crawl/scripts/run_crawl.py --url https://voz.vn/t/...
```

Seed configured threads, then crawl:

```bash
python .codex/skills/voz-crawl/scripts/run_crawl.py --seed-default-threads
```

## Notes

- The helper script resolves the repo root automatically and then runs `scripts/crawl_voz_to_atlas.py`.
- This repo currently uses `.env` for the Atlas URI; the crawl script itself defaults to `.env.local`, so always pass `--env-file .env` unless the user explicitly wants another file.
- The crawl needs network access to both MongoDB Atlas and `voz.vn`. If sandboxed execution fails with DNS or connection errors, rerun with escalated permissions.
- `--max-pages 0` means resume from stored crawl state and continue until the current end page for each thread.
