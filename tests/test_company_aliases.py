import unittest

from database.company_aliases import (
    build_company_aliases_by_canonical,
    company_aliases_for_name,
    normalize_aliases,
    resolve_canonical_company,
)


class CompanyAliasHelpersTests(unittest.TestCase):
    def test_normalize_aliases_deduplicates_case_insensitively(self):
        self.assertEqual(
            normalize_aliases([" AXON ", "Axon", "Unknown", "", "A**n"], canonical_name="AXON"),
            ["A**n"],
        )

    def test_resolve_canonical_company_follows_alias_chain(self):
        alias_map = {
            "Line Technology Vietnam": "Line Technology",
            "Line Technology": "LINE VN",
            "LINE VN": "LINE VN",
        }

        self.assertEqual(
            resolve_canonical_company("Line Technology Vietnam", alias_map=alias_map),
            "LINE VN",
        )

    def test_alias_map_builds_final_canonical_aliases(self):
        aliases = build_company_aliases_by_canonical()

        self.assertIn("Line Technology", aliases["LINE VN"])
        self.assertIn("Line Technology Vietnam", aliases["LINE VN"])
        self.assertNotIn("LINE VN", aliases["LINE VN"])

    def test_company_aliases_for_name_returns_copy(self):
        aliases = company_aliases_for_name("FPT Software")
        clone = company_aliases_for_name("FPT Software")

        self.assertIsNot(aliases, clone)
        self.assertEqual(aliases, clone)


if __name__ == "__main__":
    unittest.main()
