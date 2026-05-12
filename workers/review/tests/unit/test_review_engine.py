import unittest

from contract_types import ReviewerFinding, ReviewerOutput
from review_worker.context_builder import build_diff_context_bundle
from review_worker.engine import ReviewEngine
from review_worker.fake_provider import FakeReviewerProvider
from review_worker.ports import ReviewRequest
from review_worker.validation import ReviewerOutputValidationError, validate_reviewer_output

from test_finding_quality import context_bundle


class ReviewEngineTests(unittest.TestCase):
    def test_fake_provider_generates_valid_normalized_findings(self) -> None:
        result = ReviewEngine(FakeReviewerProvider()).review(ReviewRequest(context_bundle=context_bundle()))

        self.assertEqual(result.raw_output.schemaVersion, "1.0.0")
        self.assertEqual(result.findings[0].reviewRunId, "run_1")
        self.assertEqual(result.findings[0].status, "validated")
        self.assertTrue(result.findings[0].validation.schemaValid)

    def test_invalid_raw_output_is_rejected(self) -> None:
        with self.assertRaises(ReviewerOutputValidationError):
            validate_reviewer_output(
                ReviewerOutput(
                    schemaVersion="1.0.0",
                    findings=[
                        ReviewerFinding(
                            title="Invalid",
                            body="Missing evidence.",
                            category="maintainability",
                            severity="low",
                            confidence="high",
                            evidence=[],
                        )
                    ],
                )
            )


if __name__ == "__main__":
    unittest.main()
