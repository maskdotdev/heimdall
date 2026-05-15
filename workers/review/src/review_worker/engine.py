from __future__ import annotations

from .finding_quality import validated_findings_from_reviewer_output
from .ports import ReviewRequest, ReviewResult, ReviewerProvider
from .scanner_findings import add_scanner_fallback_findings


class ReviewEngine:
    def __init__(self, provider: ReviewerProvider) -> None:
        self.provider = provider

    def review(self, request: ReviewRequest) -> ReviewResult:
        raw_output = self.provider.review(request)
        raw_output = add_scanner_fallback_findings(request.context_bundle, raw_output)
        findings = validated_findings_from_reviewer_output(request.context_bundle, raw_output)
        return ReviewResult(raw_output=raw_output, findings=findings)
