import unittest
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from crawler.voz_scraper import VozCrawler
from database.company_aliases import normalize_aliases, resolve_canonical_company
from database.mongodb import prepare_review_document, ensure_companies_exist, primary_review_company, sync_offers_for_post


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

        self.assertEqual(prepared["companies"], ["Alpha Tech", "Beta Systems"])
        self.assertNotIn("company", prepared)

    def test_primary_review_company_uses_legacy_company_only_as_fallback(self):
        self.assertEqual(
            primary_review_company({"companies": ["Alpha Tech"], "company": "Legacy Corp"}),
            "Alpha Tech",
        )
        self.assertEqual(
            primary_review_company({"company": "Legacy Corp"}),
            "Legacy Corp",
        )
        self.assertEqual(
            primary_review_company({"company": "Legacy Corp"}, allow_legacy_fallback=False),
            "Unknown",
        )

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

    def test_resolve_canonical_company_follows_alias_chains(self):
        alias_map = {
            "Line Technology Vietnam": "Line Technology",
            "Line Technology": "LINE VN",
            "LINE VN": "LINE VN",
        }

        self.assertEqual(
            resolve_canonical_company("Line Technology Vietnam", alias_map=alias_map),
            "LINE VN",
        )

    def test_normalize_aliases_deduplicates_and_excludes_canonical_name(self):
        self.assertEqual(
            normalize_aliases([" AXON ", "Axon", "AXON", "Unknown", "", "A**n"], canonical_name="AXON"),
            ["A**n"],
        )


class CompanyUpsertSyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_ensure_companies_exist_deduplicates_without_touching_unknown(self):
        with patch("database.mongodb.upsert_company", AsyncMock()) as upsert_company:
            normalized = await ensure_companies_exist(
                ["Alias Corp", "alias corp", "Unknown", "", "Mapped Inc"]
            )

        self.assertEqual(normalized, ["Alias Corp", "Mapped Inc"])
        self.assertEqual(upsert_company.await_count, 2)

    async def test_sync_offers_for_post_creates_missing_company_docs(self):
        with patch("database.mongodb.ensure_companies_exist", AsyncMock(return_value=["Mapped Corp"])) as ensure_companies_exist_mock, \
             patch("database.mongodb.OfferDocument.find", return_value=SimpleNamespace(to_list=AsyncMock(return_value=[]))), \
             patch("database.mongodb.upsert_offer", AsyncMock(return_value=("post-1", True))):
            upserted, created, deleted = await sync_offers_for_post(
                "post-1",
                [
                    {"company": "Mapped Corp", "voz_post_id": "post-1", "offer_index": 0},
                    {"company": "Mapped Corp", "voz_post_id": "post-1", "offer_index": 1},
                ],
            )

        self.assertEqual((upserted, created, deleted), (2, 2, 0))
        ensure_companies_exist_mock.assert_awaited_once()

if __name__ == "__main__":
    unittest.main()
