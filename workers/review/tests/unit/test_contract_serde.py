import unittest

from contract_types import ContextBundle, Diff, Finding, ModelMetadata, ReviewerEvidence, ReviewerFinding, ReviewerOutput, SourceLocation
from contract_types import from_json, to_jsonable
from review_worker.finding_quality import validated_findings_from_reviewer_output

from test_finding_quality import context_bundle, reviewer_finding


class ContractSerdeTests(unittest.TestCase):
    def test_round_trips_context_bundle_and_diff(self) -> None:
        bundle = context_bundle()

        decoded_bundle = from_json(ContextBundle, to_jsonable(bundle))
        decoded_diff = from_json(Diff, to_jsonable(bundle.diff))

        self.assertEqual(decoded_bundle, bundle)
        self.assertEqual(decoded_diff, bundle.diff)

    def test_round_trips_reviewer_output_and_finding(self) -> None:
        output = ReviewerOutput(
            schemaVersion="1.0.0",
            summary="Summary",
            findings=[
                ReviewerFinding(
                    title="Finding",
                    body="The changed line has a concrete issue.",
                    category="maintainability",
                    severity="medium",
                    confidence="high",
                    location=SourceLocation(path="review.py", startLine=2),
                    evidence=[
                        ReviewerEvidence(
                            kind="diff-line",
                            summary="The changed hunk contains the concrete supporting line.",
                            location=SourceLocation(path="review.py", startLine=2),
                        )
                    ],
                )
            ],
            modelMetadata=ModelMetadata(provider="test", model="fixture"),
        )
        bundle = context_bundle()
        finding = validated_findings_from_reviewer_output(bundle, ReviewerOutput(schemaVersion="1.0.0", findings=[reviewer_finding("Finding", "medium")]))[0]

        decoded_output = from_json(ReviewerOutput, to_jsonable(output))
        decoded_finding = from_json(Finding, to_jsonable(finding))

        self.assertEqual(decoded_output, output)
        self.assertEqual(decoded_finding, finding)


if __name__ == "__main__":
    unittest.main()
