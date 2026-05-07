# Observability SLOs

Use this catalog with `OBSERVABILITY_SLO_DEFINITIONS` to configure dashboards and release reviews.
These targets define the MVP measurement contract. They do not implement full error-budget
automation.

Each SLO must include service, environment, owner, dashboard link, rolling window, SLI, and target.
Segment review latency and quality targets by repository size and PR size when those labels are
available.

| SLO or target | Category | Target |
| --- | --- | --- |
| Webhook ingestion latency | Latency | 99% of valid webhook deliveries return 2xx within 5 seconds. |
| Review completion latency | Latency | 90% of standard PR reviews complete within 5 minutes after webhook ingestion. |
| Publishing reliability | Reliability | 99% of publishable runs publish successfully or skip for a valid reason. |
| Review queue freshness | Freshness | 95% of `pr.review` jobs start within 60 seconds. |
| API availability | Availability | 99.9% API readiness during production hours. |
| Review comment budget | Quality | Published comments stay within the configured review budget. |
| High-confidence finding publish rate | Quality | Publish rate stays stable week over week. |
| Anchor rejection balance | Quality | Anchor failures do not dominate rejection reasons. |
| Duplicate comment rate | Quality | Duplicate comments stay near zero. |

## Webhook Ingestion Latency

Measure valid webhook delivery duration and success status. Exclude rejected invalid signatures and
duplicate deliveries from the success denominator unless the dashboard has a separate duplicate
delivery panel.

## Review Completion Latency

Measure from webhook receipt to review-run completion for standard PR reviews. Segment the dashboard
by repository size and PR size before comparing a large PR to the global target.

## Publishing Reliability

Count successful publishes and explicit valid skips as good outcomes. Count provider errors,
validation failures, stale publishes without a valid skip reason, and unexpected publisher crashes as
bad outcomes.

## Review Queue Freshness

Measure the time from job enqueue to job start for `pr.review` jobs. Use queue age and worker health
panels to separate capacity problems from downstream provider throttling.

## API Availability

Measure readiness checks during production hours. Pair this SLO with the API down page so operators
can distinguish deploy, database, and configuration failures.

## Quality Targets

Use quality targets as product-health guardrails rather than hard availability SLOs. Review them
with release metrics, model-profile changes, and retrieval or validation changes.
