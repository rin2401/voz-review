"""FastAPI main application"""
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from jinja2 import Environment, FileSystemLoader
from contextlib import asynccontextmanager
from typing import Optional, List
import asyncio

from database.mongodb import (
    connect, close,
    get_all_companies,
    get_all_threads,
    get_reviews_by_company,
    get_review_count,
    get_replies_for_posts,
    get_company_thread_ids,
    search_reviews,
    insert_review,
    upsert_company,
    increment_company_review_count,
    seed_threads,
    upsert_thread,
    get_thread_state,
    set_thread_crawl_status,
    update_thread_state,
)
from crawler.voz_scraper import VozCrawler, THREAD_URLS
import config


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events"""
    await connect()
    await seed_threads(THREAD_URLS)
    yield
    await close()


app = FastAPI(
    title="Voz Review Crawler",
    description="Crawl và tổng hợp review công ty từ voz.vn",
    version="1.0.0",
    lifespan=lifespan
)

# Static files and templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# Also create a direct Jinja env for manual rendering
jinja_env = Environment(loader=FileSystemLoader("templates"))

RUNNING_CRAWL_URLS: set[str] = set()


def company_to_slug(name: str) -> str:
    return (name or "").replace(" ", "-")


async def resolve_company_name(slug_or_name: str) -> str:
    companies = await get_all_companies(sort_by="az")
    names = [company.get("name", "") for company in companies]

    if slug_or_name in names:
        return slug_or_name

    normalized = (slug_or_name or "").replace("-", " ")
    if normalized in names:
        return normalized

    lower_map = {name.lower(): name for name in names}
    return lower_map.get(normalized.lower(), slug_or_name)


jinja_env.globals["company_to_slug"] = company_to_slug


# ============== PAGES ==============

@app.get("/", response_class=HTMLResponse)
async def home(request: Request, q: str = "", sort: str = "recent_review"):
    """Main page - list companies"""
    companies = await get_all_companies(sort_by=sort)
    if q:
        keyword = q.lower().strip()
        companies = [c for c in companies if keyword in c.get("name", "").lower()]
    template = jinja_env.get_template("index.html")
    return HTMLResponse(template.render(
        request=request,
        companies=companies,
        query=q,
        sort=sort,
    ))


@app.get("/company/{company_name}", response_class=HTMLResponse)
async def company_detail(request: Request, company_name: str, page: int = 1, thread_id: str = "", view: str = "all"):
    """Company detail page - list reviews"""
    limit = 20
    skip = (page - 1) * limit
    default_visible_replies = 3

    company_name = await resolve_company_name(company_name)
    company_slug = company_to_slug(company_name)

    available_thread_ids = await get_company_thread_ids(company_name)
    active_thread_id = thread_id if thread_id in available_thread_ids else ""
    active_view = view if view in {"all", "salary", "interview"} else "all"
    salary_only = active_view == "salary"
    interview_only = active_view == "interview"

    reviews = await get_reviews_by_company(
        company_name,
        limit=limit,
        skip=skip,
        thread_id=active_thread_id or None,
        salary_only=salary_only,
        interview_only=interview_only,
    )
    total = await get_review_count(
        company=company_name,
        thread_id=active_thread_id or None,
        salary_only=salary_only,
        interview_only=interview_only,
    )

    review_by_post_id = {
        str(review.get("voz_post_id")): review
        for review in reviews
        if review.get("voz_post_id")
    }

    root_post_ids = [str(review.get("voz_post_id")) for review in reviews if review.get("voz_post_id")]
    all_reply_ids_to_fetch = set(root_post_ids)
    reply_children_by_post_id = {}
    fetched_post_ids = set()

    for _ in range(4):
        pending_parent_ids = list(all_reply_ids_to_fetch - fetched_post_ids)
        if not pending_parent_ids:
            break

        reply_children = await get_replies_for_posts(pending_parent_ids)
        fetched_post_ids.update(pending_parent_ids)

        for child in reply_children:
            parent_id = child.get("reply_post_id")
            child_post_id = child.get("voz_post_id")
            if not parent_id:
                continue
            reply_children_by_post_id.setdefault(str(parent_id), []).append(child)
            if child_post_id:
                all_reply_ids_to_fetch.add(str(child_post_id))

    for children in reply_children_by_post_id.values():
        children.sort(key=lambda item: item.get("post_date") or item.get("created_at"))

    template = jinja_env.get_template("company.html")
    return HTMLResponse(template.render(
        request=request,
        company=company_name,
        company_slug=company_slug,
        reviews=reviews,
        review_by_post_id=review_by_post_id,
        reply_children_by_post_id=reply_children_by_post_id,
        default_visible_replies=default_visible_replies,
        available_thread_ids=available_thread_ids,
        active_thread_id=active_thread_id,
        active_view=active_view,
        page=page,
        total=total,
        pages=(total + limit - 1) // limit
    ))


@app.get("/search", response_class=HTMLResponse)
async def search_page(request: Request, q: str = "", company: str = "", sort: str = "recent_review"):
    """Search reviews"""
    if not q:
        template = jinja_env.get_template("search.html")
        return HTMLResponse(template.render(
            request=request,
            results=[],
            query="",
            company_query=company,
            sort=sort,
            review_by_post_id={},
            reply_children_by_post_id={},
            default_visible_replies=3,
        ))
    
    results = await search_reviews(q, limit=50)
    if company:
        keyword = company.lower().strip()
        results = [r for r in results if keyword in (r.get("company") or "").lower()]

    if sort == "likes_desc":
        results.sort(key=lambda item: item.get("likes") or 0, reverse=True)
    else:
        sort = "recent_review"
        results.sort(key=lambda item: item.get("post_date") or item.get("created_at"), reverse=True)

    default_visible_replies = 3

    review_by_post_id = {
        str(review.get("voz_post_id")): review
        for review in results
        if review.get("voz_post_id")
    }

    root_post_ids = [str(review.get("voz_post_id")) for review in results if review.get("voz_post_id")]
    all_reply_ids_to_fetch = set(root_post_ids)
    reply_children_by_post_id = {}
    fetched_post_ids = set()

    for _ in range(4):
        pending_parent_ids = list(all_reply_ids_to_fetch - fetched_post_ids)
        if not pending_parent_ids:
            break

        reply_children = await get_replies_for_posts(pending_parent_ids)
        fetched_post_ids.update(pending_parent_ids)

        for child in reply_children:
            parent_id = child.get("reply_post_id")
            child_post_id = child.get("voz_post_id")
            if not parent_id:
                continue
            reply_children_by_post_id.setdefault(str(parent_id), []).append(child)
            if child_post_id:
                all_reply_ids_to_fetch.add(str(child_post_id))

    for children in reply_children_by_post_id.values():
        children.sort(key=lambda item: item.get("post_date") or item.get("created_at"))

    template = jinja_env.get_template("search.html")
    return HTMLResponse(template.render(
        request=request,
        results=results,
        query=q,
        company_query=company,
        sort=sort,
        review_by_post_id=review_by_post_id,
        reply_children_by_post_id=reply_children_by_post_id,
        default_visible_replies=default_visible_replies,
    ))


async def refresh_thread_job_statuses():
    threads = await get_all_threads()
    for thread in threads:
        url = thread.get("url")
        if not url:
            continue
        if thread.get("crawl_status") == "running" and url not in RUNNING_CRAWL_URLS:
            await set_thread_crawl_status(url, "idle")


@app.get("/threads", response_class=HTMLResponse)
async def threads_page(request: Request):
    """List configured crawl threads"""
    await refresh_thread_job_statuses()
    threads = await get_all_threads()
    total_reviews = await get_review_count()
    total_companies = len(await get_all_companies())
    template = jinja_env.get_template("threads.html")
    return HTMLResponse(template.render(
        request=request,
        threads=threads,
        total_reviews=total_reviews,
        total_companies=total_companies,
        total_threads=len(threads),
    ))


# ============== API ==============

@app.get("/api/companies")
async def api_companies():
    """Get all companies"""
    return await get_all_companies()


@app.get("/api/companies/{company}/reviews")
async def api_company_reviews(
    company: str,
    limit: int = 20,
    skip: int = 0
):
    """Get reviews for a company"""
    reviews = await get_reviews_by_company(company, limit=limit, skip=skip)
    total = await get_review_count(company=company)
    return {"reviews": reviews, "total": total}


@app.get("/api/search")
async def api_search(q: str, limit: int = 20, skip: int = 0):
    """Search reviews API"""
    results = await search_reviews(q, limit=limit, skip=skip)
    return {"results": results, "query": q}


@app.post("/api/reviews")
async def api_create_review(review: dict):
    """Manually add a review"""
    review_id = await insert_review(review)
    return {"id": review_id, "status": "created"}


@app.get("/api/stats")
async def api_stats():
    """Get overall stats"""
    companies = await get_all_companies()
    total_reviews = await get_review_count()
    threads = await get_all_threads()
    return {
        "total_companies": len(companies),
        "total_reviews": total_reviews,
        "threads": len(threads)
    }


# ============== CRAWLER ENDPOINTS ==============

@app.post("/api/crawl/all")
async def api_crawl_all(max_pages: int = 0):
    """Crawl all configured threads from DB"""
    asyncio.create_task(crawl_all_forums(max_pages))
    threads = await get_all_threads()
    return {"status": "started", "threads": len(threads)}


@app.post("/api/crawl/thread")
async def api_crawl_thread(url: str, max_pages: int = 0):
    """Crawl a specific thread by URL. max_pages=0 means crawl all pages"""
    thread = await get_thread_state(url=url)
    if thread and thread.get("crawl_status") == "running":
        if url in RUNNING_CRAWL_URLS:
            return {"status": "already_running", "url": url}
        await set_thread_crawl_status(url, "idle")
    await set_thread_crawl_status(url, "running")
    RUNNING_CRAWL_URLS.add(url)
    asyncio.create_task(crawl_thread(url, max_pages))
    return {"status": "started", "url": url, "max_pages": "all" if max_pages == 0 else max_pages}


async def crawl_thread(url: str, max_pages: int):
    """Crawl a specific thread - resume from threads.last_page when available."""
    crawler = VozCrawler()
    thread_id = crawler._extract_thread_id(url) or None
    try:
        async with crawler:
            first_page_url = url if url.endswith('/') else url + '/'
            first_html = await crawler.get_page_html(first_page_url)

            import re
            page_numbers = re.findall(r'/page-(\d+)', first_html)
            total_pages = max([int(p) for p in page_numbers]) if page_numbers else 1

            thread_state = await get_thread_state(thread_id=thread_id, url=url)
            start_page = 1
            if thread_state and thread_state.get('last_page'):
                start_page = max(1, int(thread_state['last_page']))

            end_page = total_pages if max_pages == 0 else min(total_pages, start_page + max_pages - 1)
            print(f"📊 Thread: {total_pages} pages detected, resume from page {start_page}, crawl until {end_page}")

            for page in range(start_page, end_page + 1):
                if page == 1:
                    page_url = first_page_url
                    html = first_html
                else:
                    page_url = f"{first_page_url}page-{page}/"
                    print(f"📄 Crawling page {page}/{end_page}")
                    html = await crawler.get_page_html(page_url)

                await process_thread_page(crawler, page_url, html)
                await update_thread_state(thread_id=thread_id, url=url, last_page=page)
                await asyncio.sleep(2)

        await set_thread_crawl_status(url, "idle")
        print(f"✅ Thread crawl complete: {url}")
    except Exception as e:
        await set_thread_crawl_status(url, "error", error=str(e))
        print(f"❌ Thread crawl failed: {e}")
    finally:
        RUNNING_CRAWL_URLS.discard(url)


async def process_thread_page(crawler, page_url: str, html: str):
    """Process a single thread page - insert all reviews"""
    posts = crawler.parse_thread_page(html, page_url)
    inserted_count = 0
    skipped_count = 0

    for post_data in posts:
        try:
            if post_data["company"] and post_data["company"] != "Unknown":
                await upsert_company(post_data["company"])
            _, inserted = await insert_review(post_data)
            if inserted:
                inserted_count += 1
                if post_data["company"] != "Unknown":
                    await increment_company_review_count(post_data["company"])
            else:
                skipped_count += 1
        except Exception as e:
            print(f"Error inserting review: {e}")
    print(f"  ✅ Page: {inserted_count} inserted, {skipped_count} skipped duplicates")


async def run_crawler(thread_url: str, max_pages: int):
    """Run crawler for a single thread URL"""
    try:
        async with VozCrawler() as crawler:
            threads, reviews = await crawler.crawl_forum(thread_url, max_pages=max_pages)
            print(f"✅ Crawl complete for {thread_url}: {threads} threads, {reviews} reviews")
    except Exception as e:
        print(f"❌ Crawl failed for {thread_url}: {e}")


async def crawl_all_forums(max_pages: int):
    """Crawl all configured threads from DB"""
    threads = await get_all_threads()
    for thread in threads:
        url = thread.get("url")
        if not url or thread.get("crawl_status") == "running":
            continue
        await set_thread_crawl_status(url, "running")
        await run_crawler(url, max_pages)
        await asyncio.sleep(5)  # Be nice between threads


# ============== INFO ==============

@app.get("/api/threads")
async def api_threads():
    """Get configured thread URLs from DB"""
    await refresh_thread_job_statuses()
    return await get_all_threads()


@app.post("/api/threads")
async def api_create_thread(payload: dict):
    """Add or update a thread URL in DB."""
    crawler = VozCrawler()
    normalized_url = (payload.get("url") or "").strip()
    if not normalized_url:
        raise HTTPException(400, "URL is required")
    thread_id = crawler._extract_thread_id(normalized_url)
    await upsert_thread(url=normalized_url, thread_id=thread_id)
    return {"status": "created", "url": normalized_url, "thread_id": thread_id}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=18004, reload=True)
