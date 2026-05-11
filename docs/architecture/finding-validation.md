# Finding Validation

LLM output is untrusted. Every finding must be validated before persistence or publishing.

Validation should check:

- Schema shape.
- File path safety.
- Location exists in the current diff or allowed summary scope.
- Evidence is specific and tied to the change.
- Severity is calibrated.
- Suggested fixes do not introduce unsafe or unrelated changes.
- Duplicate findings are removed.
- Secrets and sensitive payloads are redacted.

Primary ownership:

- `contracts/schemas/llm` defines the external LLM output schemas.
- `workers/review` validates, deduplicates, ranks, and calibrates findings.
- `services/api` persists and serves only validated findings.
- `workers/publisher` publishes only approved publishable reviews.

Validation should be covered by deterministic tests and review-quality eval fixtures.
