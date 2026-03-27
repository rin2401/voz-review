"""Pydantic models for review data"""
from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime


class Review(BaseModel):
    """Review model"""
    voz_thread_id: str
    voz_post_id: str
    reply_post_id: Optional[str] = None
    company: str
    companies: List[str] = Field(default_factory=list)
    content: str
    author: str
    author_url: Optional[str] = None
    post_date: datetime
    url: str
    likes: int = 0
    awards: int = 0
    monthly_salary_million: Optional[float] = None
    status: str = "pending"
    created_at: Optional[datetime] = None


class Company(BaseModel):
    """Company model"""
    name: str
    review_count: int = 0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class CrawlState(BaseModel):
    """Crawl state tracking"""
    forum_id: str
    last_crawl: Optional[datetime] = None
    last_post_date: Optional[datetime] = None
    last_page: int = 1


class CompanySummary(BaseModel):
    """Company with aggregated data"""
    name: str
    review_count: int
    latest_review: Optional[datetime] = None
    avg_rating: Optional[float] = None
