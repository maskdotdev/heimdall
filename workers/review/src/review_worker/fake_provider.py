from __future__ import annotations

from contract_types import ReviewerEvidence, ReviewerFinding, ReviewerOutput

from .ports import ReviewRequest


class FakeReviewerProvider:
    def review(self, request: ReviewRequest) -> ReviewerOutput:
        first_snippet = (request.context_bundle.sourceSnippets or [None])[0]
        location = first_snippet.location if first_snippet is not None else None
        return ReviewerOutput(
            schemaVersion="1.0.0",
            summary="Fixture review output.",
            findings=[
                ReviewerFinding(
                    title="Review generated from diff context",
                    body="The fake reviewer produced a deterministic finding for MVP workflow tests.",
                    category="maintainability",
                    severity="low",
                    confidence="high",
                    location=location,
                    evidence=[
                        ReviewerEvidence(
                            kind="diff-line",
                            summary="The diff-only context bundle contained changed code.",
                            location=location,
                        )
                    ],
                    suggestedFix="Inspect the changed code before publishing this finding.",
                )
            ],
        )
