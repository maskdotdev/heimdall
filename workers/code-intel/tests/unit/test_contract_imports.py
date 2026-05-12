import unittest

from code_intel import imported_contract_names


class ContractImportTests(unittest.TestCase):
    def test_imports_generated_contract_types(self) -> None:
        self.assertEqual(imported_contract_names(), ("Repository", "ChangeRequest", "Diff"))


if __name__ == "__main__":
    unittest.main()
