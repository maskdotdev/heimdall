# Observability Alerts

Use this runbook for the MVP alerts defined by `OBSERVABILITY_ALERT_DEFINITIONS`.

Each alert must include service, environment, dashboard link, runbook link, owner, deploy version, and the affected queue, stage, provider, or violation type when applicable.

| Alert | Severity | First checks |
| --- | --- | --- |
| API down | Page | Open `/admin/overview`, verify readiness checks, and inspect API deployment health. |
| Webhook ingestion failures | Page | Inspect recent webhook deliveries, provider signatures, and queue enqueue errors. |
| Review queue backlog | Ticket | Check review job age, worker availability, and queue retry volume. |
| Review failure rate | Page | Group failures by stage and error class, then inspect recent review artifacts. |
| Publishing failure rate | Page | Check GitHub API status, rate limits, stale publish skips, and publisher replay plans. |
| LLM provider outage | Page | Compare provider error rate, rate limits, fallback state, and budget guardrails. |
| Cost anomaly | Ticket | Compare hourly cost, per-review cost, model profile mix, and unusual retry volume. |
| Embedding backlog | Ticket | Check embedding queue age, worker availability, and provider throttling. |
| Indexing failures | Ticket | Group failures by driver and language, then inspect importer validation errors. |
| Sandbox violation spike | Ticket | Group violations by type, trust level, command category, and recent rule changes. |

## API Down

If API readiness fails for more than 5 minutes, verify database connectivity, required environment variables, and recent deploy changes. Roll back if the latest deploy introduced the failure.

## Webhook Ingestion Failures

Check signature verification, provider delivery status, duplicate delivery volume, and enqueue failures. If signatures fail broadly, verify webhook secrets before retrying deliveries.

## Review Queue Backlog

Check queue depth, oldest review job age, worker process health, and downstream provider throttling. Scale workers or pause non-critical jobs if review latency is customer-facing.

## Review Failure Rate

Group failures by review stage and error class. Use review artifacts and stage events to separate provider, retrieval, review-engine, validation, and publishing causes.

## Publishing Failure Rate

Check publisher trace artifacts, GitHub rate-limit metrics, duplicate prevention counts, and stale publish attempts. Use publisher replay only after confirming the source review is still current.

## LLM Provider Outage

Check provider latency, rate limits, structured output failures, retry counts, and fallback model configuration. Apply budget guardrails before increasing retries.

## Cost Anomaly

Inspect review-run metrics, LLM usage events, model profile mix, and retry volume. Confirm whether the anomaly is limited to one org or repo before changing global limits.

## Embedding Backlog

Check embedding queue age, provider throttling, batch sizes, and worker concurrency. If indexing can proceed with degraded retrieval, confirm review runs are not blocked unnecessarily.

## Indexing Failures

Group failures by indexer driver, language, parse failure type, and artifact validation error. Inspect the index artifact and importer summary before retrying broadly.

## Sandbox Violation Spike

Group violations by trust level, command category, image, and violation type. Treat credential or filesystem escape attempts as security incidents.
