import unittest

from review_worker import imported_contract_names


class ContractImportTests(unittest.TestCase):
    def test_imports_generated_contract_types(self) -> None:
        self.assertEqual(imported_contract_names(), ("ReviewerOutput", "Finding"))


if __name__ == "__main__":
    unittest.main()
