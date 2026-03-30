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
from database.company_aliases import load_company_alias_map, resolve_canonical_company
from database.mongodb import (
    insert_review,
    sync_offers_for_post,
    get_thread_state,
    update_thread_state,
    increment_company_review_count,
    primary_review_company,
)


class VozCrawler:
    def __init__(self):
        self.base_url = config.VOZ_BASE_URL
        self.alias_map = self._load_company_alias_map()
        self.company_candidates = self._build_company_candidates()
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
                
                companies = self._extract_companies(content)
                primary_company = companies[0] if companies else "Unknown"
                monthly_salary_million = self._extract_monthly_salary_million(content)
                
                # Build full URL with page and post anchor
                if post_id:
                    voz_url = f"{forum_url.rstrip('/')}#post-{post_id}"
                else:
                    voz_url = forum_url
                
                posts.append({
                    "voz_thread_id": self._extract_thread_id(forum_url),
                    "voz_post_id": post_id,
                    "reply_post_id": reply_post_id,
                    "company": primary_company,
                    "companies": companies,
                    "content": content[:5000],
                    "author": author,
                    "author_url": author_url,
                    "post_date": post_date or datetime.utcnow(),
                    "url": voz_url,
                    "likes": likes,
                    "awards": 0,
                    "monthly_salary_million": monthly_salary_million,
                })
            except Exception as e:
                print(f"Error parsing post: {e}")
                continue
        
        return posts
    
    def _extract_thread_id(self, url: str) -> str:
        """Extract thread ID from thread URLs like /t/slug.677450/page-514, /t.677450, or anchors like .677450#post-123."""
        match = re.search(r'/t(?:/[^/]*?)?\.(\d+)(?=[/#?]|$)', url)
        return match.group(1) if match else ""

    def _load_company_alias_map(self) -> dict:
        try:
            return load_company_alias_map()
        except Exception:
            return {}

    def _build_company_candidates(self) -> list[tuple[str, str, re.Pattern]]:
        candidates = []
        seen = set()
        for alias, canonical in self.alias_map.items():
            for raw_name in [alias, canonical]:
                name = (raw_name or '').strip()
                if len(name) < 3:
                    continue
                key = name.lower()
                if key in seen:
                    continue
                seen.add(key)
                pattern = re.compile(rf'(?<!\w){re.escape(name)}(?!\w)', re.IGNORECASE)
                candidates.append((name, canonical, pattern))
        candidates.sort(key=lambda item: len(item[0]), reverse=True)
        return candidates

    def _apply_company_alias(self, company: str) -> str:
        return resolve_canonical_company(company, alias_map=self.alias_map)

    def _normalize_companies(self, companies: List[str]) -> List[str]:
        normalized = []
        seen = set()

        for raw_company in companies:
            company = self._apply_company_alias((raw_company or "").strip())
            if not company or company == "Unknown":
                continue
            key = company.lower()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(company)

        return normalized
    
    def _clean_company_name(self, company: str) -> str:
        """Normalize extracted company names by removing trailing notes."""
        company = company.strip()

        # Drop trailing notes in parentheses, e.g. "OANDA Coinpass (làm remote, giờ UK"
        company = re.split(r'\s*\(', company, maxsplit=1)[0].strip()

        # Drop trailing note after dash only when the right side looks like a note, not part of company name
        dash_parts = re.split(r'\s+[\-–—]\s+', company, maxsplit=1)
        if len(dash_parts) == 2:
            right_side = dash_parts[1].strip()
            right_lower = right_side.lower()
            note_keywords = [
                'remote', 'onsite', 'hybrid', 'singapore', 'sing', 'hà nội', 'hn', 'hcm', 'sài gòn',
                'timezone', 'time zone', 'uk', 'us', 'jp', 'nhật', 'mỹ', 'làm', 'dự án', 'project',
                'outsource', 'product', 'startup', 'review', 'xin review', 'cho em hỏi', 'offer', 'rejected',
            ]
            if right_side and (right_side[:1].islower() or any(token in right_lower for token in note_keywords)):
                company = dash_parts[0].strip()

        # Drop trailing note after comma, e.g. "A***s, Singapore"
        company = re.split(r'\s*,\s*', company, maxsplit=1)[0].strip()

        # Clean punctuation around edges but keep wildcard '*' used in censored names
        company = company.rstrip('.,;:')
        company = re.sub(r'^[^\w\s&*]+|[^\w\s&*]+$', '', company)
        return company.strip()

    def _extract_monthly_salary_million(self, content: str) -> Optional[float]:
        """Extract monthly salary from lines like 50m/50 triệu or plain values like 86 gross / 86 net.

        If a monthly salary label is present and the value is a plain number (for example
        ``Lương tháng (gross): 46``), interpret it as million VND per month.
        """
        lines = content.split('\n')

        def _next_non_empty_line(start_index: int) -> str:
            for candidate in lines[start_index + 1:]:
                candidate = candidate.strip()
                if candidate:
                    return candidate
            return ""

        for index, raw_line in enumerate(lines):
            line = raw_line.strip()
            lower_line = line.lower()
            if not lower_line.startswith('lương tháng') and not lower_line.startswith('luong thang'):
                continue

            if ':' in line:
                salary_text = line.split(':', 1)[1].strip()
            else:
                salary_text = re.split(r'luong thang|lương tháng', line, maxsplit=1, flags=re.IGNORECASE)[-1].strip(' :-')

            if not re.search(r'\d', salary_text):
                salary_text = _next_non_empty_line(index)

            lower_salary = salary_text.lower()
            if any(token in lower_salary for token in ['năm', '/năm', 'year', '/year', 'package', 'usd', 'sgd', '$', 'vnd', 'k']):
                return None

            m = re.search(r'(\d+)\s*m\s*(\d+)\b', lower_salary)
            if m:
                value = float(f"{m.group(1)}.{m.group(2)}")
                if value > 200:
                    return None
                return value

            m = re.search(r'(\d+(?:[.,]\d+)?)\s*(m|tr|triệu|mil)\b', lower_salary)
            if not m:
                m = re.search(r'(\d+(?:[.,]\d+)?)\s*(gross|net)\b', lower_salary)
            if not m:
                m = re.search(r'(\d+(?:[.,]\d+)?)\s*/\s*tháng\b', lower_salary)
            if not m:
                m = re.search(r'(\d+(?:[.,]\d+)?)\s*x\b', lower_salary)
                if m:
                    value = float(m.group(1).replace(',', '.')) * 10
                    if value > 200:
                        return None
                    return value
            if not m:
                m = re.fullmatch(r'(\d+(?:[.,]\d+)?)', lower_salary)
            if not m:
                return None

            value = float(m.group(1).replace(',', '.'))
            if value > 200:
                return None
            return value

        return None

    def _extract_labeled_value(self, content: str, label_patterns: List[str]) -> Optional[str]:
        """Extract the value of a structured label, allowing the value on the next non-empty line."""
        lines = content.split('\n')
        stop_prefixes = [
            'tên công ty', 'tên cty', 'công ty', 'lương tháng', 'luong thang', 'vị trí', 'vi tri',
            'thời điểm', 'thoi diem', 'bonus', 'số năm kinh nghiệm', 'so nam kinh nghiem',
        ]

        def _next_non_empty_line(start_index: int) -> str:
            for candidate in lines[start_index + 1:]:
                candidate = candidate.strip()
                if not candidate:
                    continue
                lower_candidate = candidate.lower()
                if any(lower_candidate.startswith(prefix) for prefix in stop_prefixes):
                    return ""
                return candidate
            return ""

        compiled_patterns = [re.compile(pattern, re.IGNORECASE) for pattern in label_patterns]
        for index, raw_line in enumerate(lines):
            line = raw_line.strip()
            if not line:
                continue
            normalized_line = re.sub(r'^[•·●▪◦*\-]+\s*', '', line)
            for pattern in compiled_patterns:
                match = pattern.match(normalized_line)
                if not match:
                    continue
                value = match.group(1).strip() if match.lastindex else ""
                if not value:
                    value = _next_non_empty_line(index)
                value = value.strip().rstrip('.,;:')
                return value or None
        return None

    def _parse_offer_year(self, raw_value: Optional[str]):
        if not raw_value:
            return None
        cleaned = raw_value.strip()
        year_match = re.search(r'\b(20\d{2}|19\d{2})\b', cleaned)
        if year_match:
            try:
                return int(year_match.group(1))
            except ValueError:
                pass
        return cleaned or None

    def _parse_years_of_experience(self, raw_value: Optional[str]):
        if not raw_value:
            return None
        cleaned = raw_value.strip()
        exp_match = re.search(r'(\d+(?:[.,]\d+)?)', cleaned)
        if exp_match:
            value = float(exp_match.group(1).replace(',', '.'))
            return int(value) if value.is_integer() else value
        return cleaned or None

    def _extract_offer(self, content: str, company: str, voz_thread_id: str, voz_post_id: Optional[str]) -> Optional[dict]:
        """Extract a structured offer payload from review content when the post matches the offer template."""
        if not company or company == "Unknown" or not voz_post_id:
            return None

        bullet_prefix = r'^(?:[•·●▪◦*\-]+\s*)?'
        position = self._extract_labeled_value(content, [bullet_prefix + r'\s*(?:vị trí|vi tri)\s*:\s*(.*)$'])
        offer_year = self._parse_offer_year(self._extract_labeled_value(content, [bullet_prefix + r'\s*(?:thời điểm(?:\s*\(.*?\))?|thoi diem(?:\s*\(.*?\))?)\s*:\s*(.*)$']))
        bonus = self._extract_labeled_value(
            content,
            [
                bullet_prefix + r'\s*bonus\s*:\s*\(.*?\)\s*:\s*(.*)$',
                bullet_prefix + r'\s*bonus(?:\s*\(.*?\))?\s*:\s*(.*)$',
                bullet_prefix + r'\s*(?:phúc lợi|phuc loi)\s*:\s*(.*)$',
            ],
        )
        years_of_experience = self._parse_years_of_experience(
            self._extract_labeled_value(
                content,
                [
                    bullet_prefix + r'\s*(?:số năm kinh nghiệm khi nhận offer|so nam kinh nghiem khi nhan offer)\s*:\s*(.*)$',
                    bullet_prefix + r'\s*(?:kinh nghiệm khi nhận offer|kinh nghiem khi nhan offer)\s*:\s*(.*)$',
                ],
            )
        )
        salary = self._extract_labeled_value(
            content,
            [bullet_prefix + r'\s*(?:lương tháng/năm(?:\s*\(.*?\))?|luong thang/nam(?:\s*\(.*?\))?)\s*:\s*(.*)$'],
        )
        monthly_salary_million = self._extract_monthly_salary_million(content)

        offer_signals = sum(
            value is not None and value != ""
            for value in [position, offer_year, bonus, years_of_experience, monthly_salary_million]
        )
        has_offer_phrase = 'nhận offer' in content.lower() or 'nhan offer' in content.lower()
        if offer_signals < 2 and not (has_offer_phrase and offer_signals >= 1):
            return None

        offer_doc = {
            "voz_thread_id": voz_thread_id or "",
            "voz_post_id": voz_post_id,
            "company": company,
            "salary": salary,
            "monthly_salary_million": monthly_salary_million,
            "position": position,
            "offer_year": offer_year,
            "bonus": bonus,
            "years_of_experience": years_of_experience,
        }
        return offer_doc

    def _find_company_section_starts(self, lines: List[str]) -> List[int]:
        section_starts = []
        for index, raw_line in enumerate(lines):
            line = raw_line.strip()
            if not line:
                continue
            normalized_line = re.sub(r'^[•·●▪◦*\-]+\s*', '', line)
            lower_line = normalized_line.lower()
            if re.match(r'^\s*(?:tên công ty|ten cong ty|tên cty|ten cty)\s*:?', normalized_line, re.IGNORECASE):
                section_starts.append(index)
                continue
            if re.match(r'^\s*(?:công ty|cong ty)\s*:', normalized_line, re.IGNORECASE):
                section_starts.append(index)
                continue
            if lower_line in {"công ty", "cong ty"}:
                section_starts.append(index)
        return section_starts

    def _split_offer_sections(self, content: str) -> List[str]:
        lines = content.split('\n')
        section_starts = self._find_company_section_starts(lines)
        if len(section_starts) < 2:
            return [content]

        sections = []
        boundaries = section_starts + [len(lines)]
        for start, end in zip(boundaries, boundaries[1:]):
            section = '\n'.join(lines[start:end]).strip()
            if section:
                sections.append(section)
        return sections or [content]

    def _extract_offers(
        self,
        content: str,
        company: str,
        voz_thread_id: str,
        voz_post_id: Optional[str],
        companies: Optional[List[str]] = None,
    ) -> List[dict]:
        """Extract one or more offers from a review post."""
        if not voz_post_id:
            return []

        normalized_companies = self._normalize_companies(companies or [])
        fallback_company = normalized_companies[0] if normalized_companies else self._apply_company_alias(company or "Unknown")
        sections = self._split_offer_sections(content)
        offer_docs = []

        for index, section in enumerate(sections):
            section_company = self._extract_company(section)
            if not section_company or section_company == "Unknown":
                if index < len(normalized_companies):
                    section_company = normalized_companies[index]
                else:
                    section_company = fallback_company
            section_company = self._apply_company_alias(section_company or "Unknown")

            offer_doc = self._extract_offer(
                section,
                section_company,
                voz_thread_id,
                voz_post_id,
            )
            if offer_doc:
                offer_doc["offer_index"] = index
                offer_docs.append(offer_doc)

        if offer_docs:
            return offer_docs

        offer_doc = self._extract_offer(content, fallback_company, voz_thread_id, voz_post_id)
        if offer_doc:
            offer_doc["offer_index"] = 0
            return [offer_doc]
        return []

    def _extract_companies(self, content: str) -> List[str]:
        """Extract one or more company names from a review post."""
        sections = self._split_offer_sections(content)
        extracted_companies = []

        if len(sections) > 1:
            for section in sections:
                company = self._extract_company(section)
                if company and company != "Unknown":
                    extracted_companies.append(company)

        if not extracted_companies:
            company = self._extract_company(content)
            if company and company != "Unknown":
                extracted_companies.append(company)

        return self._normalize_companies(extracted_companies)

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
        
        def _next_non_empty_line(start_index: int) -> str:
            for candidate in lines[start_index + 1:]:
                candidate = candidate.strip()
                if candidate:
                    return candidate
            return ""

        def _normalize_extracted_company(company: str) -> str:
            company = self._clean_company_name(company)
            words = [w for w in company.split() if w and w not in {'-', '–', '—'}]
            if not company or not company[0].isupper():
                return ""
            if len(words) > 6:
                return ""
            if len(company) < 2 or len(company) > 60:
                return ""
            return company

        # Look for "Tên công ty:" / "Tên cty:" at the START of a line
        for index, raw_line in enumerate(lines):
            line = raw_line.strip()
            normalized_line = re.sub(r'^[•·●▪◦*\-]+\s*', '', line)
            lower_line = normalized_line.lower()
            if lower_line.startswith('tên công ty') or lower_line.startswith('tên cty'):
                # Extract after the colon; if value is on the next line, use that
                if ':' in normalized_line:
                    company = normalized_line.split(':', 1)[1].strip()
                else:
                    if lower_line.startswith('tên cty'):
                        company = re.split(r'tên cty', normalized_line, maxsplit=1, flags=re.IGNORECASE)[1].strip()
                    else:
                        company = re.split(r'tên công ty', normalized_line, maxsplit=1, flags=re.IGNORECASE)[1].strip()

                if not company:
                    company = _next_non_empty_line(index)

                # Skip if it's clearly not a company name
                if len(company) < 2:
                    return "Unknown"
                if any(x in company.lower() for x in ['xin', 'hỏi', 'review', 'cho', 'em ', 'mình ']):
                    return "Unknown"

                company = _normalize_extracted_company(company)
                if company:
                    return company

        # Also try: starts with "Công ty" as a standalone line or label
        for index, raw_line in enumerate(lines):
            line = raw_line.strip()
            normalized_line = re.sub(r'^[•·●▪◦*\-]+\s*', '', line)
            lower_line = normalized_line.lower()
            if lower_line.startswith('công ty') and len(normalized_line) < 80:
                remainder = normalized_line[len('công ty'):].strip()
                if remainder.startswith(':'):
                    remainder = remainder[1:].strip()
                company = remainder or _next_non_empty_line(index)
                company = _normalize_extracted_company(company)
                if company:
                    return company

        # Fallback: longest matching alias/canonical name inside content for Unknown posts
        for candidate, canonical, pattern in self.company_candidates:
            if pattern.search(content):
                return canonical
        
        return "Unknown"
    
    async def crawl_forum(self, forum_url: str, max_pages: int = 0) -> Tuple[int, int]:
        """
        Crawl a forum for review threads.
        max_pages=0 means continue from crawl state until no more pages.
        Returns (threads_found, reviews_extracted)
        """
        print(f"🔍 Crawling forum: {forum_url}")
        
        # Get crawl progress from threads table
        thread_id = self._extract_thread_id(forum_url) or None
        state = await get_thread_state(thread_id=thread_id, url=forum_url)

        # Determine starting page
        start_page = 1
        if state and state.get("last_page"):
            start_page = state["last_page"]
        
        total_reviews = 0
        page = start_page

        while True:
            if max_pages and page >= start_page + max_pages:
                break

            page_url = f"{forum_url}?page={page}" if page > 1 else forum_url
            
            try:
                html = await self.get_page_html(page_url)
                posts = self.parse_thread_page(html, page_url)
                
                if not posts:
                    break
                
                for post_data in posts:
                    try:
                        # Insert review if not duplicated by voz_post_id
                        _, inserted = await insert_review(post_data)
                        if inserted:
                            total_reviews += 1

                            for company_name in post_data.get("companies") or []:
                                await increment_company_review_count(company_name, post_data.get("post_date"))

                        offer_docs = self._extract_offers(
                            post_data.get("content") or "",
                            primary_review_company(post_data, allow_legacy_fallback=True),
                            post_data.get("voz_thread_id") or "",
                            post_data.get("voz_post_id"),
                            post_data.get("companies") or [],
                        )
                        if post_data.get("voz_post_id"):
                            await sync_offers_for_post(post_data["voz_post_id"], offer_docs)
                    except Exception as e:
                        print(f"Error inserting review: {e}")
                        continue
                
                # Update thread progress directly in threads table
                if posts:
                    last_post_date = posts[-1].get("post_date")
                    await update_thread_state(thread_id=thread_id, url=forum_url, last_post_date=last_post_date, last_page=page)
                
                print(f"  📄 Page {page}: {len(posts)} reviews")
                page += 1
                await asyncio.sleep(config.CRAWL_DELAY)
                
            except Exception as e:
                print(f"Error crawling page {page}: {e}")
                page += 1
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
                companies = p.get("companies") or [primary_review_company(p, allow_legacy_fallback=True)]
                print(f"  - {p['author']}: {', '.join(companies)} ({len(p['content'])} chars)")
    
    asyncio.run(test())
