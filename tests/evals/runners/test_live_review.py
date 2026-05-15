from __future__ import annotations

import unittest

from contract_types import Finding, FindingEvidence, FindingValidation, ReviewerEvidence, ReviewerFinding, ReviewerOutput, SourceLocation
from live_review import compare_result, failed_row, format_table


class LiveReviewRunnerTests(unittest.TestCase):
    def test_compare_result_counts_expected_hits_and_dropped_findings(self) -> None:
        raw_output = ReviewerOutput(
            schemaVersion="1.0.0",
            findings=[
                raw_finding("Issue", "high"),
                raw_finding("Issue", "medium"),
            ],
        )
        findings = [
            Finding(
                schemaVersion="1.0.0",
                id="finding_1",
                reviewRunId="run_1",
                source="llm",
                title="Issue",
                body="Body",
                category="correctness",
                severity="high",
                confidence="high",
                location=SourceLocation(path="app.py", startLine=10),
                evidence=[FindingEvidence(kind="diff-line", summary="Changed line", location=SourceLocation(path="app.py", startLine=10))],
                status="validated",
                validation=FindingValidation(schemaValid=True, locationValid=True, evidenceValid=True, redactionValid=True),
                dedupeKey="app.py:10:correctness:issue",
                rank=1,
            )
        ]

        row = compare_result(
            "fake",
            "case",
            raw_output,
            findings,
            {"findings": [{"title": "Issue", "path": "app.py", "startLine": 10}]},
            123,
        )

        self.assertEqual(row.expected_hits, 1)
        self.assertEqual(row.unsupported_or_dropped, 1)
        self.assertEqual(row.duplicate_count, 1)
        self.assertIn("fake", format_table([row]))

    def test_compare_result_matches_expected_finding_by_location_and_category(self) -> None:
        raw_output = ReviewerOutput(schemaVersion="1.0.0", findings=[raw_finding("Different wording", "high")])
        findings = [
            Finding(
                schemaVersion="1.0.0",
                id="finding_1",
                reviewRunId="run_1",
                source="llm",
                title="Unsanitized query parameter reaches SQL",
                body="Body",
                category="security",
                severity="high",
                confidence="high",
                location=SourceLocation(path="app.py", startLine=10),
                evidence=[FindingEvidence(kind="diff-line", summary="Changed line", location=SourceLocation(path="app.py", startLine=10))],
                status="validated",
                validation=FindingValidation(schemaValid=True, locationValid=True, evidenceValid=True, redactionValid=True),
                dedupeKey="app.py:10:security:unsanitized-query-parameter-reaches-sql",
                rank=1,
            )
        ]

        row = compare_result(
            "fake",
            "case",
            raw_output,
            findings,
            {"findings": [{"title": "SQL injection", "category": "security", "severity": "high", "path": "app.py", "startLine": 10}]},
            123,
        )

        self.assertEqual(row.expected_hits, 1)

    def test_compare_result_matches_expected_finding_by_evidence_location(self) -> None:
        raw_output = ReviewerOutput(schemaVersion="1.0.0", findings=[raw_finding("Different wording", "high")])
        findings = [
            Finding(
                schemaVersion="1.0.0",
                id="finding_1",
                reviewRunId="run_1",
                source="llm",
                title="Untrusted request parameter reaches SQL",
                body="Body",
                category="security",
                severity="high",
                confidence="high",
                evidence=[FindingEvidence(kind="diff-line", summary="Changed line", location=SourceLocation(path="app.py", startLine=10))],
                status="validated",
                validation=FindingValidation(schemaValid=True, locationValid=True, evidenceValid=True, redactionValid=True),
                dedupeKey="security:untrusted-request-parameter-reaches-sql",
                rank=1,
            )
        ]

        row = compare_result(
            "fake",
            "case",
            raw_output,
            findings,
            {"findings": [{"title": "SQL injection", "category": "security", "severity": "high", "path": "app.py", "startLine": 10}]},
            123,
        )

        self.assertEqual(row.expected_hits, 1)

    def test_failed_row_keeps_backend_errors_in_report(self) -> None:
        row = failed_row("codex-app-server", "case", 1000, TimeoutError("timed out"))

        self.assertIn("TimeoutError", row.error)
        self.assertIn("timed out", format_table([row]))

def raw_finding(title: str, severity: str) -> ReviewerFinding:
    location = SourceLocation(path="app.py", startLine=10)
    return ReviewerFinding(
        title=title,
        body="Body",
        category="correctness",
        severity=severity,
        confidence="high",
        location=location,
        evidence=[ReviewerEvidence(kind="diff-line", summary="Changed line", location=location)],
    )


if __name__ == "__main__":
    unittest.main()
