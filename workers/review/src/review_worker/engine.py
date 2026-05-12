from __future__ import annotations

from .finding_quality import validated_findings_from_reviewer_output
from .ports import ReviewRequest, ReviewResult, ReviewerProvider


class ReviewEngine:
    def __init__(self, provider: ReviewerProvider) -> None:
        self.provider = provider

    def review(self, request: ReviewRequest) -> ReviewResult:
        raw_output = self.provider.review(request)
        findings = validated_findings_from_reviewer_output(request.context_bundle, raw_output)
        return ReviewResult(raw_output=raw_output, findings=findings)
