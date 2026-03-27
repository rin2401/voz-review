# Voz Review

Crawler + web app để thu thập và tra cứu review công ty từ voz.vn.

## Setup

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

## Features

- Crawl review threads từ nhiều sub-forum Voz
- Tổng hợp review theo công ty
- Full-text search
- API endpoints
- Giao diện dark theme

## API Endpoints

- `GET /` - Trang chủ
- `GET /company/{name}` - Xem review của công ty
- `GET /search?q=...` - Tìm kiếm
- `POST /api/crawl/forum/{key}` - Crawl 1 forum
- `POST /api/crawl/all` - Crawl tất cả forum
- `GET /api/stats` - Xem thống kê

## Forum Keys

- `it_career` - Review công ty IT
- `salary` - Review salary
- `interview` - Review interview
- `work_life` - Review work life

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
