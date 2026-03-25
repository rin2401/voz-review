"""
Voz Forum Crawler
Crawls review threads from voz.vn
"""
import asyncio
import re
import httpx
from datetime import datetime
from typing import Optional, List, Tuple
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright
from playwright_stealth import stealth
from playwright_stealth.stealth import Stealth
from urllib.parse import urljoin

import config
from database.mongodb import (
    insert_review,
    upsert_company,
    get_crawl_state,
    update_crawl_state,
    increment_company_review_count
)


class VozCrawler:
    def __init__(self):
        self.base_url = config.VOZ_BASE_URL
        self.session = httpx.AsyncClient(
            timeout=config.VOZ_TIMEOUT,
            follow_redirects=True,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        )
        self.playwright = None
        self.browser = None
        self.context = None
    
    async def __aenter__(self):
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(headless=True)
        self.context = await self.browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        # Apply stealth mode
        stealth_instance = Stealth()
        await stealth_instance.apply_stealth_async(self.context)
        return self
    
    async def __aexit__(self, *args):
        if self.context:
            await self.context.close()
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()
        await self.session.aclose()
    
    async def get_page_html(self, url: str) -> str:
        """Fetch page HTML - tries httpx first, falls back to Playwright with stealth"""
        try:
            response = await self.session.get(url)
            response.raise_for_status()
            return response.text
        except Exception:
            # Fallback to Playwright with stealth for JS-rendered content
            page = await self.context.new_page()
            # Apply stealth to this page too
            stealth_instance = Stealth()
            await stealth_instance.apply_stealth_async(page)
            await page.goto(url, timeout=config.PAGE_LOAD_TIMEOUT, wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)  # Wait for Cloudflare to verify
            html = await page.content()
            await page.close()
            return html
    
    def parse_thread_page(self, html: str, forum_url: str) -> List[dict]:
        """Parse review posts from thread page"""
        soup = BeautifulSoup(html, "html.parser")
        posts = []
        
        # Find all post containers - XenForo uses article.message for posts
        post_elements = soup.select("article.message--post")
        
        for post in post_elements:
            try:
                # Extract author from data-author or .username
                author = post.get("data-author", "")
                if not author:
                    author_elem = post.select_one(".username")
                    author = author_elem.text.strip() if author_elem else "Anonymous"
                
                # Author URL
                author_url_elem = post.select_one(".username, .avatar")
                author_url = None
                if author_url_elem:
                    href = author_url_elem.get("href", "")
                    if href and not href.startswith("http"):
                        author_url = urljoin(self.base_url, href)
                
                # Extract post date
                time_elem = post.select_one("time.u-dt")
                post_date = None
                if time_elem:
                    datetime_str = time_elem.get("datetime", "")
                    if datetime_str:
                        try:
                            post_date = datetime.fromisoformat(datetime_str.replace("Z", "+00:00"))
                        except:
                            pass
                
                # Extract post content while preserving line breaks better
                content_elem = post.select_one(".message-content, .bbWrapper")

                # Extract quoted/replied post ID only from quote attribution
                reply_post_id = None
                quote_link = post.select_one("a.bbCodeBlock-sourceJump, .bbCodeBlock-sourceJump")
                if quote_link:
                    content_selector = quote_link.get("data-content-selector", "")
                    match = re.search(r'#post-(\d+)', content_selector)
                    if not match:
                        href = quote_link.get("href", "")
                        match = re.search(r'[?&]id=(\d+)', href)
                    if not match:
                        href = quote_link.get("href", "")
                        match = re.search(r'#post-(\d+)', href)
                    if match:
                        reply_post_id = match.group(1)

                # Remove quoted blocks from main content so reply text stays cleaner
                content = ""
                if content_elem:
                    content_for_text = BeautifulSoup(str(content_elem), "html.parser")
                    for quoted in content_for_text.select(".bbCodeBlock, blockquote, .message-userContent .bbCodeBlock"):
                        quoted.decompose()
                    content = content_for_text.get_text("\n", strip=True)
                
                # Extract post ID from data-content or id
                post_id = post.get("data-content", "").replace("post-", "")
                if not post_id:
                    post_id_elem = post.select_one("a[href*='/post-']")
                    if post_id_elem:
                        href = post_id_elem.get("href", "")
                        match = re.search(r'post-(\d+)', href)
                        if match:
                            post_id = match.group(1)
                
                # Normalize empty post IDs so DB unique index works safely
                if not post_id:
                    post_id = None

                # Extract likes
                likes = 0
                like_elem = post.select_one(".reactions-value")
                if like_elem:
                    try:
                        likes = int(like_elem.text.strip().replace(",", ""))
                    except:
                        pass
                
                # Skip if no content
                if not content or len(content) < 20:
                    continue
                
                # Extract company name from content
                company = self._extract_company(content)
                
                # Build full URL with page and post anchor
                if post_id:
                    voz_url = f"{forum_url.rstrip('/')}#post-{post_id}"
                else:
                    voz_url = forum_url
                
                posts.append({
                    "voz_thread_id": self._extract_thread_id(forum_url),
                    "voz_post_id": post_id,
                    "reply_post_id": reply_post_id,
                    "company": company,
                    "content": content[:5000],
                    "author": author,
                    "author_url": author_url,
                    "post_date": post_date or datetime.utcnow(),
                    "url": voz_url,
                    "likes": likes,
                    "awards": 0,
                })
            except Exception as e:
                print(f"Error parsing post: {e}")
                continue
        
        return posts
    
    def _extract_thread_id(self, url: str) -> str:
        """Extract thread ID from URL"""
        match = re.search(r'/t\.(\d+)', url)
        return match.group(1) if match else ""
    
    def _clean_company_name(self, company: str) -> str:
        """Normalize extracted company names by removing trailing notes."""
        company = company.strip()

        # Drop trailing notes in parentheses, e.g. "OANDA Coinpass (làm remote, giờ UK"
        company = re.split(r'\s*\(', company, maxsplit=1)[0].strip()

        # Drop obvious trailing note separators like dash/en dash/em dash
        company = re.split(r'\s+[\-–—]\s+', company, maxsplit=1)[0].strip()

        # Drop trailing note after comma, e.g. "A***s, Singapore"
        company = re.split(r'\s*,\s*', company, maxsplit=1)[0].strip()

        # Clean punctuation around edges but keep wildcard '*' used in censored names
        company = company.rstrip('.,;:')
        company = re.sub(r'^[^\w\s&*]+|[^\w\s&*]+$', '', company)
        return company.strip()

    def _extract_company(self, content: str) -> str:
        """
        Extract company name from review content.
        Looks for patterns like:
        - "Tên công ty: XXX" (exactly at start of line)
        - "Công ty XXX" 
        """
        lines = content.split('\n')
        
        # Skip if this looks like a question/request post
        skip_phrases = ['xin review', 'cho em hỏi', 'cho mình hỏi', 'có ai', 'tuyển', 'nhận offer', 'hỏi về', 'cần hỏi']
        first_line = lines[0].lower() if lines else ""
        if any(phrase in first_line for phrase in skip_phrases):
            # Check if it's a reply (contains "said:")
            if 'said:' not in content.lower():
                return "Unknown"
        
        # Look for "Tên công ty:" at the START of a line
        for line in lines:
            line = line.strip()
            if line.lower().startswith('tên công ty') or line.lower().startswith('tên cty'):
                # Extract after the colon
                if ':' in line:
                    company = line.split(':', 1)[1].strip()
                else:
                    company = line.split('tên công ty', 1)[1].strip()
                
                # Clean up - remove trailing junk
                company = company.rstrip('.,;:')
                
                # Skip if it's clearly not a company name
                if len(company) < 2:
                    return "Unknown"
                if any(x in company.lower() for x in ['xin', 'hỏi', 'review', 'cho', 'em ', 'mình ']):
                    return "Unknown"
                
                company = self._clean_company_name(company)
                
                if len(company) >= 2 and len(company) <= 60:
                    return company
        
        # Also try: starts with "Công ty" as a standalone line
        for line in lines:
            line = line.strip()
            lower_line = line.lower()
            if lower_line.startswith('công ty ') and len(line) < 80:
                company = line[len('công ty '):].strip()
                company = self._clean_company_name(company)
                if len(company) >= 2:
                    return company
        
        return "Unknown"
    
    async def crawl_forum(self, forum_url: str, max_pages: int = 5) -> Tuple[int, int]:
        """
        Crawl a forum for review threads.
        Returns (threads_found, reviews_extracted)
        """
        print(f"🔍 Crawling forum: {forum_url}")
        
        # Get crawl state
        forum_id = self._extract_thread_id(forum_url) or forum_url
        state = await get_crawl_state(forum_id)
        
        # Determine starting page
        start_page = 1
        if state and state.get("last_page"):
            start_page = state["last_page"]
        
        total_reviews = 0
        
        for page in range(start_page, start_page + max_pages):
            page_url = f"{forum_url}?page={page}" if page > 1 else forum_url
            
            try:
                html = await self.get_page_html(page_url)
                posts = self.parse_thread_page(html, page_url)
                
                if not posts:
                    break
                
                for post_data in posts:
                    try:
                        # Ensure company exists
                        if post_data["company"] and post_data["company"] != "Unknown":
                            await upsert_company(post_data["company"])
                        
                        # Insert review if not duplicated by voz_post_id
                        _, inserted = await insert_review(post_data)
                        if not inserted:
                            continue
                        total_reviews += 1
                        
                        # Update company count only for newly inserted reviews
                        if post_data["company"] != "Unknown":
                            await increment_company_review_count(post_data["company"])
                    except Exception as e:
                        print(f"Error inserting review: {e}")
                        continue
                
                # Update crawl state
                if posts:
                    last_post_date = posts[-1].get("post_date")
                    await update_crawl_state(forum_id, last_post_date, page)
                
                print(f"  📄 Page {page}: {len(posts)} reviews")
                await asyncio.sleep(config.CRAWL_DELAY)
                
            except Exception as e:
                print(f"Error crawling page {page}: {e}")
                continue
        
        print(f"✅ Done! Extracted {total_reviews} reviews")
        return (0, total_reviews)


async def quick_crawl_thread(thread_url: str) -> List[dict]:
    """Quick crawl a single thread"""
    async with VozCrawler() as crawler:
        html = await crawler.get_page_html(thread_url)
        return crawler.parse_thread_page(html, thread_url)


# Forum URLs for different review types
# Updated based on current Voz structure (2026)
REVIEW_FORUMS = {
    "salary_thread": "https://voz.vn/t/thread-tong-hop-chia-se-ve-muc-luong-tai-cac-cong-ty-part-2.515355/",  # Thread tổng hợp salary
    # "it_career": "https://voz.vn/f/f60.60/",  # Lập trình / CNTT
    # "salary": "https://voz.vn/f/f58.58/",  # Tuyển dụng - Tìm việc
}

# Direct thread URLs to crawl
THREAD_URLS = [
    "https://voz.vn/t/thread-tong-hop-chia-se-ve-muc-luong-tai-cac-cong-ty-part-2.515355/",
]


if __name__ == "__main__":
    # Test crawl
    async def test():
        async with VozCrawler() as crawler:
            # Test single page
            url = REVIEW_FORUMS["salary_thread"]
            html = await crawler.get_page_html(url)
            posts = crawler.parse_thread_page(html, url)
            print(f"Found {len(posts)} posts")
            for p in posts[:3]:
                print(f"  - {p['author']}: {p['company']} ({len(p['content'])} chars)")
    
    asyncio.run(test())
