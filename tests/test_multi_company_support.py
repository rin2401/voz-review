import unittest
import asyncio

from crawler.voz_scraper import VozCrawler
from database.mongodb import prepare_review_document


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

if __name__ == "__main__":
    unittest.main()
