from __future__ import annotations

import re
from dataclasses import dataclass

from contract_types import ContextBundle, Finding, ReviewerFinding, ReviewerOutput, SourceLocation

from .normalizer import normalize_validated_reviewer_finding
from .validation import validate_reviewer_output


SEVERITY_ORDER = {
    "critical": 0,
    "high": 1,
    "medium": 2,
    "low": 3,
    "info": 4,
}
CONFIDENCE_ORDER = {
    "high": 0,
    "medium": 1,
    "low": 2,
}
EVIDENCE_KINDS_TIED_TO_CHANGE = {
    "diff-line",
    "source-snippet",
    "scanner-signal",
    "dependency-edge",
    "test-signal",
    "review-standard",
}
GENERIC_EVIDENCE_SUMMARIES = {
    "evidence",
    "diff",
    "code",
    "issue",
    "finding",
}
SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)\b(api[_-]?key|token|secret|password)\s*[:=]\s*['\"]?[A-Za-z0-9_./+=-]{16,}"),
)


@dataclass(frozen=True, slots=True)
class _ValidatedCandidate:
    index: int
    dedupe_key: str
    candidate: ReviewerFinding


def validated_findings_from_reviewer_output(
    context_bundle: ContextBundle,
    output: ReviewerOutput,
) -> tuple[Finding, ...]:
    validate_reviewer_output(output)

    validated: list[_ValidatedCandidate] = []
    for index, candidate in enumerate(output.findings, start=1):
        if _candidate_is_valid(context_bundle, candidate):
            validated.append(_ValidatedCandidate(index=index, dedupe_key=dedupe_key(candidate), candidate=candidate))

    ranked = sorted(
        validated,
        key=lambda item: (
            SEVERITY_ORDER[item.candidate.severity],
            CONFIDENCE_ORDER[item.candidate.confidence],
            item.index,
        ),
    )

    findings: list[Finding] = []
    seen_dedupe_keys: set[str] = set()
    for item in ranked:
        if item.dedupe_key in seen_dedupe_keys:
            continue
        seen_dedupe_keys.add(item.dedupe_key)
        rank = len(findings) + 1
        findings.append(
            normalize_validated_reviewer_finding(
                review_run_id=context_bundle.reviewRunId,
                finding_id=f"finding_{context_bundle.reviewRunId}_{rank}",
                candidate=item.candidate,
                dedupe_key=item.dedupe_key,
                rank=rank,
            )
        )
    return tuple(findings)


def dedupe_key(candidate: ReviewerFinding) -> str:
    title = " ".join(candidate.title.casefold().split())
    if candidate.location is None:
        return f"{candidate.category}:{title}"
    return f"{candidate.location.path}:{candidate.location.startLine or 0}:{candidate.category}:{title}"


def _candidate_is_valid(context_bundle: ContextBundle, candidate: ReviewerFinding) -> bool:
    return (
        _location_is_valid(context_bundle, candidate.location)
        and _evidence_is_valid(context_bundle, candidate)
        and _redaction_is_valid(candidate)
    )


def _evidence_is_valid(context_bundle: ContextBundle, candidate: ReviewerFinding) -> bool:
    for evidence in candidate.evidence:
        summary = " ".join(evidence.summary.split())
        if len(summary) < 12 or summary.casefold() in GENERIC_EVIDENCE_SUMMARIES:
            continue

        if evidence.location is not None and _location_is_valid(context_bundle, evidence.location):
            return True
        if candidate.location is not None and evidence.kind in EVIDENCE_KINDS_TIED_TO_CHANGE:
            return True
    return False


def _location_is_valid(context_bundle: ContextBundle, location: SourceLocation | None) -> bool:
    if location is None:
        return True

    changed_file = next((item for item in context_bundle.diff.files if item.path == location.path), None)
    if changed_file is None:
        return False
    if location.startLine is None:
        return True

    end_line = location.endLine or location.startLine
    if end_line < location.startLine:
        return False

    valid_lines = {
        line.newLine
        for hunk in changed_file.hunks
        for line in hunk.lines
        if line.newLine is not None and line.kind in ("context", "added")
    }
    if not valid_lines:
        return False
    return all(line_number in valid_lines for line_number in range(location.startLine, end_line + 1))


def _redaction_is_valid(candidate: ReviewerFinding) -> bool:
    values = [candidate.title, candidate.body, candidate.suggestedFix or ""]
    values.extend(evidence.summary for evidence in candidate.evidence)
    return not any(pattern.search(value) for pattern in SECRET_PATTERNS for value in values)
