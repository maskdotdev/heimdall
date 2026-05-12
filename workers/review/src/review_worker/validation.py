from __future__ import annotations

from contract_types import ReviewerOutput


ALLOWED_CATEGORIES = {
    "correctness",
    "security",
    "reliability",
    "performance",
    "maintainability",
    "test",
    "style",
    "documentation",
    "accessibility",
    "other",
}
ALLOWED_SEVERITIES = {"critical", "high", "medium", "low", "info"}
ALLOWED_CONFIDENCE = {"high", "medium", "low"}
ALLOWED_EVIDENCE_KINDS = {
    "diff-line",
    "source-snippet",
    "scanner-signal",
    "dependency-edge",
    "test-signal",
    "review-standard",
    "other",
}


class ReviewerOutputValidationError(ValueError):
    pass


def validate_reviewer_output(output: ReviewerOutput) -> None:
    errors: list[str] = []
    if output.schemaVersion != "1.0.0":
        errors.append("schemaVersion must be 1.0.0")
    if len(output.findings) > 100:
        errors.append("findings must contain at most 100 items")

    for index, finding in enumerate(output.findings):
        prefix = f"findings[{index}]"
        if not finding.title:
            errors.append(f"{prefix}.title is required")
        if not finding.body:
            errors.append(f"{prefix}.body is required")
        if finding.category not in ALLOWED_CATEGORIES:
            errors.append(f"{prefix}.category is invalid")
        if finding.severity not in ALLOWED_SEVERITIES:
            errors.append(f"{prefix}.severity is invalid")
        if finding.confidence not in ALLOWED_CONFIDENCE:
            errors.append(f"{prefix}.confidence is invalid")
        if not finding.evidence:
            errors.append(f"{prefix}.evidence must contain at least one item")
        if len(finding.evidence) > 8:
            errors.append(f"{prefix}.evidence must contain at most 8 items")
        for evidence_index, evidence in enumerate(finding.evidence):
            evidence_prefix = f"{prefix}.evidence[{evidence_index}]"
            if evidence.kind not in ALLOWED_EVIDENCE_KINDS:
                errors.append(f"{evidence_prefix}.kind is invalid")
            if not evidence.summary:
                errors.append(f"{evidence_prefix}.summary is required")

    if errors:
        raise ReviewerOutputValidationError("; ".join(errors))
