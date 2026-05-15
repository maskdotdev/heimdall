import unittest

from contract_types import ChangedFile, DiffHunk, DiffLine, ReviewerEvidence, ReviewerFinding, ReviewerOutput, SourceLocation
from review_worker.context_builder import build_diff_context_bundle
from review_worker.engine import ReviewEngine
from review_worker.fake_provider import FakeReviewerProvider
from review_worker.ports import ReviewRequest
from review_worker.validation import ReviewerOutputValidationError, validate_reviewer_output

from test_context_builder import change_request, diff
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

    def test_promotes_precise_scanner_signal_when_model_misses_it(self) -> None:
        bundle = build_diff_context_bundle(
            "run_1",
            change_request(),
            diff(
                [
                    ChangedFile(
                        path="review.py",
                        status="modified",
                        additions=1,
                        deletions=0,
                        language="Python",
                        hunks=[
                            DiffHunk(
                                oldStart=1,
                                oldLines=0,
                                newStart=1,
                                newLines=1,
                                lines=[DiffLine(kind="added", newLine=1, content="pairs = zip(requested_ids, rows.values())")],
                            )
                        ],
                    )
                ]
            ),
        )

        result = ReviewEngine(EmptyReviewerProvider()).review(ReviewRequest(bundle))

        self.assertEqual(result.raw_output.findings[0].title, "Mapping values can be paired with the wrong ordered input")
        self.assertEqual(result.findings[0].evidence[0].kind, "scanner-signal")

    def test_does_not_duplicate_scanner_signal_when_model_already_covers_line(self) -> None:
        bundle = build_diff_context_bundle(
            "run_1",
            change_request(),
            diff(
                [
                    ChangedFile(
                        path="review.py",
                        status="modified",
                        additions=1,
                        deletions=0,
                        language="Python",
                        hunks=[
                            DiffHunk(
                                oldStart=1,
                                oldLines=0,
                                newStart=1,
                                newLines=1,
                                lines=[DiffLine(kind="added", newLine=1, content="pairs = zip(requested_ids, rows.values())")],
                            )
                        ],
                    )
                ]
            ),
        )
        output = ReviewerOutput(
            schemaVersion="1.0.0",
            findings=[
                ReviewerFinding(
                    title="Existing finding",
                    body="The model already reported this changed line.",
                    category="correctness",
                    severity="medium",
                    confidence="high",
                    location=SourceLocation(path="review.py", startLine=1),
                    evidence=[
                        ReviewerEvidence(
                            kind="diff-line",
                            summary="The changed line already supports a finding here.",
                            location=SourceLocation(path="review.py", startLine=1),
                        )
                    ],
                )
            ],
        )

        result = ReviewEngine(StaticReviewerProvider(output)).review(ReviewRequest(bundle))

        self.assertEqual(len(result.raw_output.findings), 1)

    def test_promotes_nested_metadata_scanner_signal_when_model_misses_it(self) -> None:
        bundle = build_diff_context_bundle(
            "run_1",
            change_request(),
            diff(
                [
                    ChangedFile(
                        path="review.py",
                        status="modified",
                        additions=1,
                        deletions=0,
                        language="Python",
                        hunks=[
                            DiffHunk(
                                oldStart=1,
                                oldLines=0,
                                newStart=1,
                                newLines=1,
                                lines=[
                                    DiffLine(
                                        kind="added",
                                        newLine=1,
                                        content='if actor != integration.metadata["sender"]["login"]:',
                                    )
                                ],
                            )
                        ],
                    )
                ]
            ),
        )

        result = ReviewEngine(EmptyReviewerProvider()).review(ReviewRequest(bundle))

        self.assertEqual(result.raw_output.findings[0].title, "Guard nested metadata before indexing")
        self.assertEqual(result.findings[0].evidence[0].kind, "scanner-signal")


class EmptyReviewerProvider:
    def review(self, request: ReviewRequest) -> ReviewerOutput:
        return ReviewerOutput(schemaVersion="1.0.0", summary="No findings.", findings=[])


class StaticReviewerProvider:
    def __init__(self, output: ReviewerOutput) -> None:
        self.output = output

    def review(self, request: ReviewRequest) -> ReviewerOutput:
        return self.output


if __name__ == "__main__":
    unittest.main()
