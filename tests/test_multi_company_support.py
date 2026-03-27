import unittest
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from crawler.voz_scraper import VozCrawler
from database.mongodb import prepare_review_document, ensure_companies_exist, sync_offers_for_post


class MultiCompanySupportTests(unittest.TestCase):
    def setUp(self):
        self.crawler = VozCrawler()

    def tearDown(self):
        asyncio.run(self.crawler.session.aclose())

    def test_prepare_review_document_preserves_all_detected_companies(self):
        review = {
            "company": "Fallback Corp",
            "companies": ["Alpha Tech", "Beta Systems", "Alpha Tech", "Unknown", ""],
        }

        prepared = prepare_review_document(review)

        self.assertEqual(prepared["company"], "Alpha Tech")
        self.assertEqual(prepared["companies"], ["Alpha Tech", "Beta Systems"])

    def test_extract_offers_maps_sections_to_matching_companies(self):
        content = """
Tên công ty: Alpha Tech
Vị trí: Backend Engineer
Thời điểm: 2024
Lương tháng/năm: 40 triệu
Bonus: 1 tháng

Tên công ty
Beta Systems
Vị trí: Data Engineer
Thời điểm: 2025
Lương tháng/năm: 55 triệu
Bonus: 2 tháng
        """.strip()

        offers = self.crawler._extract_offers(
            content,
            "Alpha Tech",
            "12345",
            "post-1",
            ["Alpha Tech", "Beta Systems"],
        )

        self.assertEqual(len(offers), 2)
        self.assertEqual([offer["company"] for offer in offers], ["Alpha Tech", "Beta Systems"])
        self.assertEqual([offer["offer_index"] for offer in offers], [0, 1])


class CompanyUpsertSyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_ensure_companies_exist_deduplicates_without_touching_unknown(self):
        companies = SimpleNamespace(find_one_and_update=AsyncMock())

        with patch("database.mongodb.db", SimpleNamespace(companies=companies)):
            normalized = await ensure_companies_exist(
                ["Alias Corp", "alias corp", "Unknown", "", "Mapped Inc"]
            )

        self.assertEqual(normalized, ["Alias Corp", "Mapped Inc"])
        self.assertEqual(companies.find_one_and_update.await_count, 2)

    async def test_sync_offers_for_post_creates_missing_company_docs(self):
        offers = SimpleNamespace(delete_many=AsyncMock(return_value=SimpleNamespace(deleted_count=0)))
        companies = SimpleNamespace(find_one_and_update=AsyncMock())

        with patch("database.mongodb.db", SimpleNamespace(offers=offers, companies=companies)), \
             patch("database.mongodb.upsert_offer", AsyncMock(return_value=("post-1", True))):
            upserted, created, deleted = await sync_offers_for_post(
                "post-1",
                [
                    {"company": "Mapped Corp", "voz_post_id": "post-1", "offer_index": 0},
                    {"company": "Mapped Corp", "voz_post_id": "post-1", "offer_index": 1},
                ],
            )

        self.assertEqual((upserted, created, deleted), (2, 2, 0))
        companies.find_one_and_update.assert_awaited_once()

if __name__ == "__main__":
    unittest.main()
