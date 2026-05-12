from __future__ import annotations

from contract_types import (
    Finding,
    FindingEvidence,
    FindingValidation,
    FixSuggestion,
    ReviewerFinding,
)


def normalize_validated_reviewer_finding(
    review_run_id: str,
    finding_id: str,
    candidate: ReviewerFinding,
    dedupe_key: str,
    rank: int,
) -> Finding:
    return Finding(
        schemaVersion="1.0.0",
        id=finding_id,
        reviewRunId=review_run_id,
        source="llm",
        title=candidate.title,
        body=candidate.body,
        category=candidate.category,
        severity=candidate.severity,
        confidence=candidate.confidence,
        location=candidate.location,
        evidence=[normalize_evidence(item) for item in candidate.evidence],
        suggestions=normalize_suggestions(candidate),
        dedupeKey=dedupe_key,
        rank=rank,
        status="validated",
        validation=FindingValidation(
            schemaValid=True,
            locationValid=True,
            evidenceValid=True,
            redactionValid=True,
            validatorVersion="mvp-review-worker",
        ),
    )


def normalize_evidence(evidence: object) -> FindingEvidence:
    return FindingEvidence(
        kind=evidence.kind,
        summary=evidence.summary,
        location=evidence.location,
    )


def normalize_suggestions(candidate: ReviewerFinding) -> list[FixSuggestion] | None:
    if not candidate.suggestedFix:
        return None
    return [FixSuggestion(summary=candidate.suggestedFix, safety="needs-review")]
