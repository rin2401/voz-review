import unittest

from database.company_duplicates import analyze_likely_duplicate_companies


class CompanyDuplicateHeuristicsTests(unittest.TestCase):
    def test_groups_case_spacing_and_punctuation_variants(self):
        report = analyze_likely_duplicate_companies(
            [
                {"name": "Netcompany", "review_count": 8},
                {"name": "Net company", "review_count": 4},
                {"name": "Another Corp", "review_count": 3},
            ]
        )

        self.assertEqual(report["summary"]["group_count"], 1)
        group = report["groups"][0]
        self.assertEqual(group["confidence"], "high")
        self.assertIn("case_spacing_punctuation_fold", group["reasons"])
        self.assertEqual(group["proposed_canonical_name"], "Netcompany")

    def test_groups_masked_and_leetspeak_variants(self):
        report = analyze_likely_duplicate_companies(
            [
                {"name": "Axon", "review_count": 9},
                {"name": "A**n", "review_count": 2},
                {"name": "Ax0n", "review_count": 1},
            ]
        )

        self.assertEqual(report["summary"]["group_count"], 1)
        group = report["groups"][0]
        self.assertEqual(group["confidence"], "high")
        self.assertIn("masked_character_match", group["reasons"])
        self.assertIn("leetspeak_fold", group["reasons"])
        self.assertEqual(group["proposed_canonical_name"], "Axon")

    def test_groups_close_spelling_variants_conservatively(self):
        report = analyze_likely_duplicate_companies(
            [
                {"name": "Northwind", "review_count": 10},
                {"name": "Northwnd", "review_count": 2},
                {"name": "Meta", "review_count": 5},
            ]
        )

        self.assertEqual(report["summary"]["group_count"], 1)
        group = report["groups"][0]
        self.assertEqual(group["confidence"], "medium")
        self.assertEqual(group["reasons"], ["close_spelling_variant"])
        self.assertEqual(group["proposed_canonical_name"], "Northwind")

    def test_prefers_alias_map_canonical_when_present_in_group(self):
        report = analyze_likely_duplicate_companies(
            [
                {"name": "Positive Thinking Company", "review_count": 6},
                {"name": "P0sitive Thinking Company", "review_count": 1},
                {"name": "Positive Thinking", "review_count": 2},
            ]
        )

        self.assertEqual(report["summary"]["group_count"], 1)
        group = report["groups"][0]
        self.assertEqual(group["proposed_canonical_name"], "Positive Thinking Company")
        self.assertEqual(group["canonical_reason"], "existing_alias_map")

    def test_groups_shared_strong_token_with_single_token_expansion(self):
        report = analyze_likely_duplicate_companies(
            [
                {"name": "Tiktok", "review_count": 11},
                {"name": "Tiktok - London", "review_count": 2},
                {"name": "Another Company", "review_count": 1},
            ],
            alias_map={},
        )

        self.assertEqual(report["summary"]["group_count"], 1)
        group = report["groups"][0]
        self.assertEqual(group["confidence"], "medium")
        self.assertIn("shared_strong_token", group["reasons"])
        pair_match = group["pair_matches"][0]
        self.assertEqual(pair_match["match_reason"], "shared_strong_token")
        self.assertEqual(pair_match["shared_tokens"], ["tiktok"])

    def test_groups_shared_strong_token_with_multiple_strong_tokens(self):
        report = analyze_likely_duplicate_companies(
            [
                {"name": "Hitachi Vantara", "review_count": 5},
                {"name": "Hitachi Vantara VN", "review_count": 1},
                {"name": "Standalone Co", "review_count": 1},
            ],
            alias_map={},
        )

        self.assertEqual(report["summary"]["group_count"], 1)
        group = report["groups"][0]
        self.assertEqual(group["confidence"], "medium")
        self.assertIn("shared_strong_token", group["reasons"])
        pair_match = group["pair_matches"][0]
        self.assertEqual(pair_match["shared_tokens"], ["hitachi", "vantara"])

    def test_does_not_group_generic_or_broad_brand_families(self):
        report = analyze_likely_duplicate_companies(
            [
                {"name": "Amazon", "review_count": 9},
                {"name": "Amazon Web Services", "review_count": 4},
                {"name": "Acme Solutions", "review_count": 3},
                {"name": "Beta Solutions", "review_count": 3},
            ]
        )

        self.assertEqual(report["summary"]["group_count"], 0)


if __name__ == "__main__":
    unittest.main()
