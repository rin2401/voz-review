# Voz Review Crawler

Crawl và tổng hợp review công ty từ voz.vn

## Setup

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Install Playwright browsers
playwright install chromium

# 3. Start MongoDB (Docker)
docker run -d -p 27017:27017 --name mongodb mongo:latest

# 4. Run
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## Features

- Crawl review threads từ nhiều sub-forum Voz
- Tổng hợp reviews theo công ty
- Full-text search
- API endpoints
- Dark theme UI

## API Endpoints

- `GET /` - Trang chủ
- `GET /company/{name}` - Reviews của công ty
- `GET /search?q=...` - Tìm kiếm
- `POST /api/crawl/forum/{key}` - Crawl 1 forum
- `POST /api/crawl/all` - Crawl tất cả forums
- `GET /api/stats` - Thống kê

## Forum Keys

- `it_career` - Review công ty IT
- `salary` - Review salary
- `interview` - Review interview
- `work_life` - Review work life
