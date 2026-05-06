# Repository Guidelines

## Project Structure & Module Organization

This is a Python 3.12 FastAPI app for crawling and browsing company review data from voz.vn. The main web application lives in `main.py`, with scheduler logic in `scheduler.py` and environment-backed settings in `config.py`. Crawler code is under `crawler/`, database models and MongoDB helpers are under `database/`, and API package markers live in `api/`. Jinja templates are in `templates/`, static assets in `static/`, alias data in `data/`, maintenance and migration utilities in `scripts/`, and tests in `tests/`.

## Build, Test, and Development Commands

- `pip install -r requirements.txt`: install runtime dependencies.
- `playwright install chromium`: install the browser used by the crawler.
- `docker run -d -p 27017:27017 --name mongodb mongo:latest`: start a local MongoDB instance.
- `uvicorn main:app --reload --host 0.0.0.0 --port 8000`: run the app locally.
- `python -m pytest`: run the test suite. The tests use `unittest` classes but are pytest-compatible.
- `python scripts/reset_crawl_data.py`: clear crawl collections for a clean recrawl.

If using `uv`, keep `uv.lock` in sync with dependency changes.

## Coding Style & Naming Conventions

Follow the existing Python style: 4-space indentation, type hints where they clarify contracts, `snake_case` for functions and variables, `PascalCase` for classes, and uppercase names for constants. Keep async database and crawler paths async end-to-end. Prefer small helper functions over embedding parsing or normalization rules directly in route handlers.

No formatter or linter is configured in `pyproject.toml`; match nearby code and avoid introducing unrelated formatting churn.

## Testing Guidelines

Place tests in `tests/` using the `test_*.py` filename pattern. Name test methods after the behavior being verified, for example `test_start_run_rejects_overlap_while_existing_task_is_running`. Use `unittest.IsolatedAsyncioTestCase` for async scheduler/database behavior and mocks for external crawling or MongoDB locks where possible. Run `python -m pytest` before submitting changes.

## Commit & Pull Request Guidelines

Recent history uses concise, imperative Conventional Commit-style messages such as `fix: parse single-letter uppercase company name correctly` and `refactor: derive company summary from reviews`. Use `fix:`, `feat:`, `refactor:`, or similar prefixes when appropriate.

Pull requests should include a short problem statement, a summary of the change, test results, and any migration or recrawl steps required. For UI changes in `templates/` or `static/`, include screenshots or a brief note describing the affected pages.

## Security & Configuration Tips

Do not commit runtime files such as `.venv/`, logs, sockets, or local MongoDB artifacts. Keep scheduler behavior configurable through `HOURLY_CRAWL_SCHEDULER_ENABLED`, `HOURLY_CRAWL_SCHEDULER_TIMEZONE`, and `HOURLY_CRAWL_SCHEDULER_LEASE_MINUTES`.
