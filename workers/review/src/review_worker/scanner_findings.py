from __future__ import annotations

from contract_types import ContextBundle, ReviewerEvidence, ReviewerFinding, ReviewerOutput, ScannerSignal, SourceLocation


PROMOTED_SCANNER_RULE_IDS = {"mutated-copy-original-used", "nested-metadata-indexing", "ordered-inputs-with-mapping-values"}


def add_scanner_fallback_findings(context_bundle: ContextBundle, output: ReviewerOutput) -> ReviewerOutput:
    for signal in context_bundle.scannerSignals or []:
        if signal.ruleId not in PROMOTED_SCANNER_RULE_IDS or signal.location is None:
            continue
        if _finding_already_covers_location(output, signal.location):
            continue
        output.findings.append(_finding_from_signal(signal))
    return output


def _finding_already_covers_location(output: ReviewerOutput, location: SourceLocation) -> bool:
    for finding in output.findings:
        if finding.location is not None and _same_line(finding.location, location):
            return True
        for evidence in finding.evidence:
            if evidence.location is not None and _same_line(evidence.location, location):
                return True
    return False


def _finding_from_signal(signal: ScannerSignal) -> ReviewerFinding:
    location = signal.location
    if location is None:
        raise ValueError("scanner signal fallback requires a location")
    if signal.ruleId == "nested-metadata-indexing":
        return ReviewerFinding(
            title="Guard nested metadata before indexing",
            body=(
                "The changed code directly indexes nested persisted metadata. If the stored metadata is missing any "
                "intermediate key or has an unexpected shape, the lookup raises before the surrounding fallback or error "
                "handling can run."
            ),
            category="reliability",
            severity=signal.severity,
            confidence="high",
            location=location,
            evidence=[
                ReviewerEvidence(kind="scanner-signal", summary=signal.message, location=location),
                ReviewerEvidence(
                    kind="diff-line",
                    summary="The changed line directly indexes nested metadata at this location.",
                    location=location,
                ),
            ],
            suggestedFix="Read each metadata level with type checks or safe accessors before comparing nested values.",
        )
    if signal.ruleId == "mutated-copy-original-used":
        return ReviewerFinding(
            title="Use the mutated copy instead of the original object",
            body=(
                "The changed code creates a copy, mutates that copy, and then uses the original object in the returned "
                "value or payload. The mutation is therefore ignored by callers, so the new display or normalization "
                "logic has no effect."
            ),
            category="correctness",
            severity=signal.severity,
            confidence="high",
            location=location,
            evidence=[
                ReviewerEvidence(kind="scanner-signal", summary=signal.message, location=location),
                ReviewerEvidence(
                    kind="diff-line",
                    summary="The changed line uses the original object after a copied value was mutated.",
                    location=location,
                ),
            ],
            suggestedFix="Use the mutated copy in the returned value or payload, or remove the unused copy.",
        )
    return ReviewerFinding(
        title="Mapping values can be paired with the wrong ordered input",
        body=(
            "The changed code zips an ordered input collection with values from a mapping. Mapping value order can differ "
            "from the input order or omit entries, so later code can associate each value with the wrong key."
        ),
        category="correctness",
        severity=signal.severity,
        confidence="high",
        location=location,
        evidence=[
            ReviewerEvidence(kind="scanner-signal", summary=signal.message, location=location),
            ReviewerEvidence(
                kind="diff-line",
                summary="The changed line pairs ordered inputs with mapping values at this location.",
                location=location,
            ),
        ],
        suggestedFix="Iterate over the ordered keys and look up mapping entries by key instead of zipping with mapping values.",
    )


def _same_line(left: SourceLocation, right: SourceLocation) -> bool:
    return left.path == right.path and left.startLine == right.startLine
