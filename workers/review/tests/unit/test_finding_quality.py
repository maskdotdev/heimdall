import unittest

from contract_types import ChangedFile, DiffHunk, DiffLine, ReviewerEvidence, ReviewerFinding, ReviewerOutput, SourceLocation
from review_worker.context_builder import build_diff_context_bundle
from review_worker.finding_quality import validated_findings_from_reviewer_output

from test_context_builder import change_request, diff


class FindingQualityTests(unittest.TestCase):
    def test_ranks_and_deduplicates_valid_findings(self) -> None:
        bundle = context_bundle()
        output = ReviewerOutput(
            schemaVersion="1.0.0",
            findings=[
                reviewer_finding("Low finding", "low", line=2),
                reviewer_finding("High finding", "high", line=3),
                reviewer_finding("high   finding", "medium", line=3),
            ],
        )

        findings = validated_findings_from_reviewer_output(bundle, output)

        self.assertEqual([finding.title for finding in findings], ["High finding", "Low finding"])
        self.assertEqual([finding.rank for finding in findings], [1, 2])
        self.assertEqual(findings[0].dedupeKey, "review.py:3:maintainability:high finding")
        self.assertTrue(findings[0].validation.locationValid)
        self.assertTrue(findings[0].validation.evidenceValid)
        self.assertTrue(findings[0].validation.redactionValid)

    def test_drops_findings_outside_current_diff(self) -> None:
        output = ReviewerOutput(
            schemaVersion="1.0.0",
            findings=[reviewer_finding("Invalid location", "high", path="other.py", line=10)],
        )

        findings = validated_findings_from_reviewer_output(context_bundle(), output)

        self.assertEqual(findings, ())

    def test_allows_summary_level_finding_with_specific_diff_evidence(self) -> None:
        output = ReviewerOutput(
            schemaVersion="1.0.0",
            findings=[
                ReviewerFinding(
                    title="Summary finding",
                    body="This issue applies to the changed function overall.",
                    category="maintainability",
                    severity="medium",
                    confidence="high",
                    evidence=[
                        ReviewerEvidence(
                            kind="diff-line",
                            summary="The added return path in the changed hunk demonstrates the issue.",
                            location=SourceLocation(path="review.py", startLine=2),
                        )
                    ],
                )
            ],
        )

        findings = validated_findings_from_reviewer_output(context_bundle(), output)

        self.assertEqual(len(findings), 1)
        self.assertIsNone(findings[0].location)

    def test_drops_weak_or_untied_evidence(self) -> None:
        output = ReviewerOutput(
            schemaVersion="1.0.0",
            findings=[
                ReviewerFinding(
                    title="Weak evidence",
                    body="This finding should not be persisted.",
                    category="maintainability",
                    severity="medium",
                    confidence="high",
                    location=SourceLocation(path="review.py", startLine=2),
                    evidence=[ReviewerEvidence(kind="other", summary="Evidence")],
                )
            ],
        )

        findings = validated_findings_from_reviewer_output(context_bundle(), output)

        self.assertEqual(findings, ())

    def test_drops_findings_that_appear_to_expose_secrets(self) -> None:
        output = ReviewerOutput(
            schemaVersion="1.0.0",
            findings=[
                reviewer_finding(
                    "Secret exposure",
                    "critical",
                    body="The changed code includes token=abcdefghijklmnopqrstuvwxyz123456.",
                    line=2,
                )
            ],
        )

        findings = validated_findings_from_reviewer_output(context_bundle(), output)

        self.assertEqual(findings, ())


def context_bundle():
    return build_diff_context_bundle(
        "run_1",
        change_request(),
        diff(
            [
                ChangedFile(
                    path="review.py",
                    status="modified",
                    additions=2,
                    deletions=0,
                    language="Python",
                    hunks=[
                        DiffHunk(
                            oldStart=1,
                            oldLines=1,
                            newStart=1,
                            newLines=3,
                            lines=[
                                DiffLine(kind="context", oldLine=1, newLine=1, content="def review():"),
                                DiffLine(kind="added", newLine=2, content="    result = compute()"),
                                DiffLine(kind="added", newLine=3, content="    return result"),
                            ],
                        )
                    ],
                )
            ]
        ),
    )


def reviewer_finding(
    title: str,
    severity: str,
    *,
    path: str = "review.py",
    line: int = 2,
    body: str = "The changed code has a concrete issue worth reporting.",
) -> ReviewerFinding:
    location = SourceLocation(path=path, startLine=line)
    return ReviewerFinding(
        title=title,
        body=body,
        category="maintainability",
        severity=severity,
        confidence="high",
        location=location,
        evidence=[
            ReviewerEvidence(
                kind="diff-line",
                summary="The changed hunk contains the concrete line that supports this finding.",
                location=location,
            )
        ],
    )


if __name__ == "__main__":
    unittest.main()
