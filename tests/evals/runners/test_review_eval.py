from __future__ import annotations

import unittest

from review_eval import run_eval_suite


class ReviewEvalTests(unittest.TestCase):
    def test_saved_reviewer_outputs_match_expected_validated_findings(self) -> None:
        failures = run_eval_suite()
        self.assertEqual([f"{failure.case_id}: {failure.message}" for failure in failures], [])


if __name__ == "__main__":
    unittest.main()
