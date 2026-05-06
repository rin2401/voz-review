# Repository Guidelines

## Project Structure & Module Organization

This repository is a Python 3.12 FastAPI app for crawling and browsing company reviews from `voz.vn`. Core app code lives in `main.py`, scheduler logic in `scheduler.py`, and config in `config.py`. Crawling code is under `crawler/`, MongoDB models and helpers are in `database/`, and API package markers are in `api/`. UI files live in `templates/` and `static/`. Data fixtures such as aliases belong in `data/`. Utility and migration scripts live in `scripts/`. Tests are in `tests/`.

## Build, Test, and Development Commands

- `pip install -r requirements.txt`: install runtime dependencies.
- `playwright install chromium`: install the browser required by the crawler.
- `docker run -d -p 27017:27017 --name mongodb mongo:latest`: start local MongoDB.
- `uvicorn main:app --reload --host 0.0.0.0 --port 8000`: run the web app locally.
- `python -m pytest`: run the full test suite.
- `python scripts/reset_crawl_data.py`: clear crawl collections before a fresh recrawl.
- `python scripts/crawl_voz_to_atlas.py --env-file .env --max-pages 0`: run a manual crawl against Atlas.

If you use `uv`, keep `uv.lock` aligned with dependency changes.

## Coding Style & Naming Conventions

Use 4-space indentation and match existing Python style. Prefer `snake_case` for functions and variables, `PascalCase` for classes, and uppercase names for constants. Keep async crawler and database paths async end-to-end. Add type hints when they clarify behavior, and prefer small helper functions over large route handlers.

No formatter or linter is configured here, so avoid unrelated formatting churn.

## Testing Guidelines

Add tests under `tests/` with filenames like `test_scheduler.py`. Test methods should describe behavior, for example `test_start_run_rejects_overlap_while_existing_task_is_running`. Use `unittest.IsolatedAsyncioTestCase` for async flows and mock external crawling or MongoDB locks where possible. Run `python -m pytest` before opening a PR.

## Commit & Pull Request Guidelines

Follow the existing Conventional Commit style: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`. Keep messages short and imperative, for example `fix: prioritize aliases over single-letter company names`.

Pull requests should include the problem, the change summary, test results, and any migration or recrawl steps. Include screenshots or a brief UI note when changing `templates/` or `static/`.

## Security & Configuration Tips

Do not commit `.venv/`, logs, sockets, or local MongoDB artifacts. Keep scheduler behavior driven by environment variables such as `HOURLY_CRAWL_SCHEDULER_ENABLED`, `HOURLY_CRAWL_SCHEDULER_TIMEZONE`, and `HOURLY_CRAWL_SCHEDULER_LEASE_MINUTES`.
