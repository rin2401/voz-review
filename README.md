# Voz Review

Crawler + web app để thu thập và tra cứu review công ty từ voz.vn.

## Setup

App config is loaded automatically from `.env` and `.env.local` via `pydantic-settings`. Environment variables exported in the shell still override values from those files.

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Install Playwright browsers
playwright install chromium

# 3. Start MongoDB (Docker)
docker run -d -p 27017:27017 --name mongodb mongo:latest

# 4. Run app
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## MongoDB Atlas

The app uses `MONGO_URI` for MongoDB connections. If unset, it falls back to `mongodb://localhost:27017`. It can also connect to MongoDB Atlas with an SRV connection string:

```bash
export MONGO_URI='mongodb+srv://<user>:<password>@<cluster-host>/voz_crawler?retryWrites=true&w=majority'
export MONGO_DB='voz_crawler'
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

`MONGODB_URI` and `MONGODB_DB` are also supported aliases. On Vercel, add `MONGO_URI` and `MONGO_DB` as project environment variables. Keep the Atlas password URL-encoded if it contains special characters.

## Cloudflare Worker

`wrangler.toml` deploys a lightweight Cloudflare Worker reverse proxy in front of the Vercel production deployment. The FastAPI app still runs on Vercel; the Worker only forwards traffic at the edge.

```bash
npx wrangler deploy
```

If the Vercel production URL changes, update `ORIGIN_URL` in `wrangler.toml` before deploying, or set it as a Worker variable in Cloudflare.

To copy existing local data to Atlas:

```bash
export ATLAS_MONGO_URI='mongodb+srv://<user>:<password>@<cluster-host>/?retryWrites=true&w=majority'
python scripts/migrate_mongo_to_atlas.py --source-uri mongodb://localhost:27017 --source-db voz_crawler --dest-db voz_crawler --drop-dest
```

To crawl manually and write updates directly to Atlas instead of relying on the in-app hourly scheduler:

```bash
vercel env pull .env.local --environment=production --yes
python scripts/crawl_voz_to_atlas.py --max-pages 0
```

The script loads `.env.local` before importing app config and refuses to run unless `MONGO_URI`/`MONGODB_URI` points to Atlas. Use `--url <voz-thread-url>` to crawl one thread, or `--seed-default-threads` to insert the built-in thread list into a fresh Atlas database before crawling.

## Features

- Crawl review threads từ nhiều sub-forum Voz
- Tự động crawl toàn bộ tracked threads vào đúng đầu mỗi giờ trong app process
- Tổng hợp review theo công ty
- Full-text search
- API endpoints
- Giao diện dark theme

## API Endpoints

- `GET /` - Trang chủ
- `GET /company/{name}` - Xem review của công ty
- `GET /search?q=...` - Tìm kiếm
- `POST /api/crawl/thread?url=...` - Crawl 1 thread
- `POST /api/crawl/all` - Crawl tất cả forum
- `GET /api/scheduler` - Xem trạng thái scheduler hourly
- `GET /api/stats` - Xem thống kê

## Hourly Scheduler

Scheduler chạy bên trong web app process và bắn vào đúng đầu mỗi giờ theo timezone `Asia/Ho_Chi_Minh` khi được bật. Mặc định scheduler đang tắt để tránh crawl tự động trên deployment; dùng `scripts/crawl_voz_to_atlas.py` cho crawl thủ công lên Atlas.
Các biến môi trường liên quan:

- `HOURLY_CRAWL_SCHEDULER_ENABLED=true|false` (mặc định `false`)
- `HOURLY_CRAWL_SCHEDULER_TIMEZONE=Asia/Ho_Chi_Minh`
- `HOURLY_CRAWL_SCHEDULER_LEASE_MINUTES=180`

Scheduler dùng state/lock trong MongoDB để tránh overlap giữa các lần `crawl all`. Nếu một lần crawl trước vẫn đang chạy khi sang giờ mới, lần giờ đó sẽ bị bỏ qua thay vì chồng job.

## Notes

Một số file runtime local như `.venv/`, `*.log`, `*.sock` đã được ignore để repo sạch hơn và tránh đẩy rác môi trường lên GitHub.

## Reset dữ liệu crawl

Nếu muốn crawl lại sạch từ đầu:

```bash
python scripts/reset_crawl_data.py
```

Script này sẽ xóa toàn bộ dữ liệu trong các collection:
- `reviews`
- `companies`
- `threads`

## Migrate tên công ty

Nếu muốn làm sạch lại field `company` trong database theo rule parser mới:

```bash
python scripts/migrate_company_names.py
```

Script này sẽ:
- backfill `reviews.companies` và cập nhật `reviews.company` primary
- rebuild lại collection `companies`
