# #25 Observability Implementation Spec

## Status

Draft implementation spec for the Greptile-like code review system.

This document defines the observability layer for the full product:

```text
/apps/api
/apps/worker
/apps/web
/apps/indexer-cli
/packages/*
```

The goal is to make every review run explainable, every production issue debuggable, and every expensive path measurable.

---

## 1. Purpose

Observability is not just monitoring. For this product, observability is the system that lets us answer:

```text
Why did this review happen?
Why did it take this long?
Why did it cost this much?
Why did this finding get published?
Why did this finding get rejected?
Why did this PR get skipped?
Why was this context retrieved?
Why did indexing fail?
Why did publishing fail?
Which customer/repo/workflow is affected?
```

The observability layer must connect these concepts:

```text
GitHub webhook event
  -> background job
  -> review run
  -> PR snapshot
  -> repo sync
  -> indexing
  -> import
  -> embedding
  -> retrieval
  -> review passes
  -> finding validation
  -> publishing
  -> feedback/memory
```

Every one of those stages should have logs, traces, metrics, and durable artifacts that can be correlated by ID.

---

## 2. Core recommendation

Use a vendor-neutral OpenTelemetry-first design:

```text
Application code
  -> /packages/observability
  -> OpenTelemetry API/SDK
  -> OTLP exporter
  -> OpenTelemetry Collector
  -> backend(s)
```

Recommended MVP backend options:

```text
Local dev:
  - OpenTelemetry Collector
  - Grafana
  - Prometheus
  - Tempo
  - Loki or local structured logs

Production simple:
  - OpenTelemetry Collector
  - hosted Datadog / Grafana Cloud / Honeycomb / New Relic / Sentry/etc.

Production open-source:
  - Prometheus or Mimir for metrics
  - Tempo for traces
  - Loki for logs
  - Grafana for dashboards
```

Keep app instrumentation vendor-neutral. Vendor-specific choices should live in deployment config, collectors, exporters, or backend dashboards.

---

## 3. Design principles

### 3.1 One observability package

No app or package should hand-roll telemetry behavior.

Use:

```text
/packages/observability
```

for:

```text
- logger factory
- tracer factory
- meter factory
- common attributes
- span helpers
- metric helpers
- redaction helpers
- error serialization
- correlation ID helpers
- dashboard metric names
- test utilities
```

### 3.2 Correlate everything by stable IDs

Every log, span, metric attribute where appropriate, and durable event should include the relevant correlation IDs.

Core IDs:

```text
request_id
trace_id
span_id
job_id
queue_name
org_id
repo_id
repository_provider_id
installation_id
pull_request_number
base_sha
head_sha
review_run_id
index_version_id
artifact_id
finding_id
published_finding_id
llm_call_id
sandbox_run_id
```

Do not include all IDs everywhere. Include the IDs relevant to that operation. Avoid high-cardinality metrics labels; high-cardinality values are fine in logs and spans.

### 3.3 Metrics are for aggregate health

Metrics should answer:

```text
Are we healthy?
Are we slow?
Are we expensive?
Are we losing jobs?
Which stage is the bottleneck?
Which queue is backed up?
Are customers affected?
```

Metrics should not include raw PR titles, file paths, branch names, prompts, code snippets, user emails, GitHub tokens, or LLM outputs.

### 3.4 Traces are for request/job causality

Traces should show stage-by-stage causality:

```text
webhook.receive
  -> db.webhook_event.insert
  -> queue.enqueue pr.review
  -> worker.review_pr
    -> github.fetch_pr_snapshot
    -> review_orchestrator.stage.snapshot
    -> review_orchestrator.stage.ensure_index
    -> retrieval.build_context
    -> review_engine.run_passes
    -> finding_validation.run
    -> queue.enqueue review.publish
```

Use traces to debug one specific failing or slow review.

### 3.5 Logs are for facts, events, and debugging

Logs should be structured JSON. They should be safe to store. Logs should include enough information to understand what happened without reading raw prompts or customer code.

### 3.6 Artifacts are for deep explanation

Observability should point to durable artifacts:

```text
- raw webhook payload hash
- PR snapshot artifact URI
- diff artifact URI
- index artifact URI
- context bundle artifact URI
- review pass artifacts
- candidate findings
- rejected findings
- publish plan
- LLM call metadata
```

Logs and traces should not become giant artifact stores.

### 3.7 Redaction is mandatory

No secrets, auth tokens, source code snippets, raw prompts, raw LLM responses, private repo names, private branch names, or customer emails should be emitted into third-party observability backends unless explicitly allowed by policy.

The observability layer must default to safe logging.

### 3.8 Do not use high-cardinality labels in metrics

Avoid metric labels like:

```text
repo_id
review_run_id
file_path
branch_name
commit_sha
pull_request_number
user_id
installation_id
model_request_id
job_id
```

These are appropriate in traces/logs, not metrics. For metrics, use bounded labels such as:

```text
service_name
operation
stage
status
queue_name
provider
language
finding_category
finding_severity
model_profile
review_mode
error_class
```

### 3.9 Observability must not materially slow the hot path

Telemetry should be non-blocking where possible. Export failures must not fail the user operation unless explicitly configured for tests.

---

## 4. Package layout

```text
/packages/observability
  src/
    index.ts
    config.ts
    bootstrap.ts
    resource.ts
    logger.ts
    tracer.ts
    metrics.ts
    attributes.ts
    errors.ts
    redaction.ts
    context.ts
    spans.ts
    logs.ts
    instruments.ts
    dashboards.ts
    sampling.ts
    health.ts
    testing.ts
    integrations/
      api.ts
      elysia.ts
      worker.ts
      queue.ts
      db.ts
      github.ts
      repo-sync.ts
      indexer.ts
      embedding.ts
      retrieval.ts
      review.ts
      llm.ts
      publisher.ts
      sandbox.ts
      static-analysis.ts
    schemas/
      telemetry-event.ts
      log-event.ts
      metric-name.ts
      span-name.ts
    test/
      fake-logger.ts
      fake-tracer.ts
      fake-meter.ts
      capture-telemetry.ts
```

Suggested exports:

```ts
export * from "./config";
export * from "./bootstrap";
export * from "./logger";
export * from "./tracer";
export * from "./metrics";
export * from "./attributes";
export * from "./errors";
export * from "./redaction";
export * from "./context";
export * from "./spans";
export * from "./instruments";
export * from "./health";
```

---

## 5. Runtime architecture

### 5.1 Local development

```text
API / Worker / Web / Indexer
  -> OTLP over HTTP/gRPC
  -> OpenTelemetry Collector
  -> Prometheus / Tempo / Loki
  -> Grafana
```

Local `compose.yaml` should include:

```text
otel-collector
prometheus
tempo
loki
grafana
```

Optional local dev simplification:

```text
OTEL_EXPORTER=console
```

so traces/logs print locally without requiring the full stack.

### 5.2 Production

```text
Services
  -> OpenTelemetry Collector sidecar/agent/gateway
  -> selected observability backend
```

Recommended deployment:

```text
API pods/containers       -> local collector or gateway collector
Worker pods/containers    -> local collector or gateway collector
Indexer containers        -> local collector or gateway collector
Sandbox runners           -> event summaries only, not raw process output
```

### 5.3 Collector responsibilities

The Collector should own:

```text
- batching
- retries
- exporting
- tail sampling if used
- attribute filtering
- backend routing
- environment-specific config
- dropping unsafe attributes if they appear
```

Application code should not need to know whether telemetry goes to Datadog, Grafana Cloud, Honeycomb, New Relic, Sentry, or self-hosted backends.

---

## 6. Service names and resources

Define stable OpenTelemetry resource attributes for every process.

Recommended service names:

```text
code-review-api
code-review-web
code-review-worker
code-review-indexer-cli
code-review-sandbox-runner
code-review-maintenance
```

Required resource attributes:

```ts
const resourceAttributes = {
  "service.name": serviceName,
  "service.namespace": "code-review-agent",
  "service.version": process.env.APP_VERSION,
  "deployment.environment.name": process.env.APP_ENV,
  "host.name": process.env.HOSTNAME,
};
```

Optional resource attributes:

```text
cloud.provider
cloud.region
cloud.availability_zone
container.name
container.id
k8s.namespace.name
k8s.pod.name
k8s.deployment.name
process.runtime.name
process.runtime.version
```

Do not use customer IDs as resource attributes. Customer IDs belong on spans/logs when needed, not on resources.

---

## 7. Configuration

### 7.1 Environment variables

```text
OBSERVABILITY_ENABLED=true
OBSERVABILITY_SERVICE_NAME=code-review-api
OBSERVABILITY_ENV=local|staging|production
OBSERVABILITY_LOG_LEVEL=debug|info|warn|error
OBSERVABILITY_EXPORTER=none|console|otlp
OBSERVABILITY_OTLP_ENDPOINT=http://otel-collector:4318
OBSERVABILITY_TRACE_SAMPLE_RATE=1.0
OBSERVABILITY_TRACE_ERROR_SAMPLE_RATE=1.0
OBSERVABILITY_TRACE_SLOW_JOB_SAMPLE_RATE=1.0
OBSERVABILITY_METRICS_INTERVAL_MS=15000
OBSERVABILITY_REDACTION_STRICT=true
OBSERVABILITY_INCLUDE_DEBUG_ATTRIBUTES=false
OBSERVABILITY_LOG_RAW_ERRORS=false
OBSERVABILITY_CAPTURE_PROMPTS=false
OBSERVABILITY_CAPTURE_CODE_SNIPPETS=false
```

### 7.2 Config object

```ts
export type ObservabilityConfig = {
  enabled: boolean;
  serviceName: string;
  environment: "local" | "development" | "staging" | "production";
  version: string;
  exporter: "none" | "console" | "otlp";
  otlpEndpoint?: string;
  logLevel: "debug" | "info" | "warn" | "error";
  traceSampleRate: number;
  metricsIntervalMs: number;
  redaction: {
    strict: boolean;
    includeDebugAttributes: boolean;
    capturePrompts: boolean;
    captureCodeSnippets: boolean;
    logRawErrors: boolean;
  };
};
```

### 7.3 Bootstrap

Each app should initialize observability first.

```ts
import { bootstrapObservability } from "@repo/observability";

await bootstrapObservability({
  serviceName: "code-review-api",
});
```

The bootstrap should:

```text
- configure resource attributes
- initialize logger
- initialize tracer provider
- initialize meter provider
- configure exporters
- install auto-instrumentation where supported
- install process error handlers
- register shutdown hooks
```

---

## 8. Structured logging

### 8.1 Logger requirements

The logger should output structured JSON objects.

Minimum fields:

```json
{
  "timestamp": "2026-04-28T20:05:00.000Z",
  "level": "info",
  "service": "code-review-worker",
  "environment": "production",
  "message": "review stage completed",
  "event_name": "review.stage.completed",
  "trace_id": "...",
  "span_id": "..."
}
```

Context fields when available:

```json
{
  "request_id": "req_...",
  "job_id": "job_...",
  "queue_name": "pr.review",
  "org_id": "org_...",
  "repo_id": "repo_...",
  "review_run_id": "rrun_...",
  "stage": "retrieval",
  "duration_ms": 817
}
```

### 8.2 Recommended logger facade

```ts
export interface AppLogger {
  debug(message: string, attrs?: LogAttrs): void;
  info(message: string, attrs?: LogAttrs): void;
  warn(message: string, attrs?: LogAttrs): void;
  error(message: string, attrs?: LogAttrs): void;
  child(attrs: LogAttrs): AppLogger;
}
```

Usage:

```ts
const logger = getLogger().child({
  org_id: orgId,
  repo_id: repoId,
  review_run_id: reviewRunId,
});

logger.info("review stage completed", {
  event_name: "review.stage.completed",
  stage: "retrieval",
  duration_ms: elapsedMs,
});
```

### 8.3 Log event naming

Use dot-separated event names:

```text
api.request.started
api.request.completed
api.request.failed
webhook.received
webhook.verified
webhook.rejected
webhook.event.persisted
queue.job.enqueued
queue.job.started
queue.job.completed
queue.job.failed
review.run.created
review.stage.started
review.stage.completed
review.stage.failed
index.run.started
index.run.completed
index.run.failed
llm.call.started
llm.call.completed
llm.call.failed
publisher.publish.started
publisher.publish.completed
publisher.publish.failed
```

### 8.4 Log levels

```text
debug:
  detailed local diagnostics, disabled by default in production

info:
  normal lifecycle events

warn:
  unusual but recoverable conditions

error:
  failed operations, exceptions, data integrity issues, publish failures
```

Examples:

```text
info: webhook accepted
warn: PR skipped because diff is too large
error: review publishing failed after retries
```

### 8.5 Log redaction

The logger must redact:

```text
- GitHub App private keys
- installation tokens
- OAuth tokens
- session secrets
- webhook secrets
- API keys
- model provider keys
- database URLs
- Redis URLs
- signed URLs
- Authorization headers
- Set-Cookie headers
- raw prompts by default
- raw code snippets by default
```

Implement a recursive redactor:

```ts
export function redactLogAttrs(attrs: unknown): unknown;
```

Redact keys matching:

```text
token
secret
password
passwd
private_key
api_key
authorization
cookie
set_cookie
connection_string
database_url
redis_url
signed_url
```

Also redact likely secret values using pattern matching:

```text
ghp_*
ghs_*
ghu_*
github_pat_*
sk-*
xoxb-*
Bearer *
-----BEGIN PRIVATE KEY-----
```

### 8.6 Source code safety

Logs should not include raw source code. Instead log:

```text
file_count
chunk_count
symbol_count
content_hash
artifact_uri
artifact_hash
line_count
byte_count
```

Do not log:

```text
file contents
chunk text
prompt text
LLM response text
PR description text
comment body text
```

unless an explicit internal/debug setting is enabled and the org policy allows it.

---

## 9. Tracing

### 9.1 Span naming convention

Use low-cardinality span names.

Good:

```text
webhook.receive
queue.enqueue
worker.job
github.fetch_pr_snapshot
repo_sync.checkout_workspace
indexer.run
index_importer.import_artifact
embedding.embed_batch
retrieval.build_context
review_engine.run_pass
finding_validation.validate
publisher.publish_review
llm.generate_object
```

Bad:

```text
review PR #182 in repo abc
fetch src/auth/session.ts
call gpt-5.5-pro for review 123
```

### 9.2 Root traces

Root spans should exist for:

```text
- HTTP requests
- webhook deliveries
- worker jobs
- indexer CLI invocations
- sandbox command executions
- scheduled maintenance jobs
```

### 9.3 Context propagation

When an API request enqueues a job, propagate trace context into job metadata.

Job payload metadata:

```ts
type JobTelemetryContext = {
  traceparent?: string;
  tracestate?: string;
  requestId?: string;
  parentEventId?: string;
};
```

When worker starts, extract trace context and create child span:

```text
api request trace
  -> queue.enqueue span
  -> worker.job span
```

For webhook-triggered flows:

```text
webhook.receive
  -> enqueue pr.review
  -> worker.job pr.review
  -> review stages
```

### 9.4 Common span attributes

```ts
export const CommonSpanAttrs = {
  orgId: "app.org_id",
  repoId: "app.repo_id",
  installationId: "app.installation_id",
  provider: "app.provider",
  reviewRunId: "app.review_run_id",
  pullRequestNumber: "app.pull_request_number",
  baseSha: "app.base_sha",
  headSha: "app.head_sha",
  jobId: "app.job_id",
  queueName: "app.queue_name",
  stage: "app.stage",
};
```

Use app-specific attributes with an `app.` prefix unless a stable semantic convention already exists.

### 9.5 Error handling in spans

Every caught error should be recorded on the active span:

```ts
span.recordException(error);
span.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorMessage(error) });
```

Also log a structured error event.

### 9.6 Span events

Use span events for important stage milestones:

```text
review.policy.compiled
review.snapshot.fetched
review.index_dependency.waiting
retrieval.candidates.generated
retrieval.context.packed
review.pass.completed
finding.validation.rejected
publish.comment.created
```

Do not add one span event per file/chunk for large repos. Use summaries.

### 9.7 Sampling

MVP:

```text
local:      sample 100%
staging:    sample 100%
production: sample 10-25% normal traces, 100% error traces if backend supports tail sampling
```

Review runs are valuable. Consider higher sampling for:

```text
- failed review runs
- slow review runs
- enterprise orgs during onboarding
- new prompt/indexer versions
- dry-run debugging sessions
```

If tail sampling is not available, use head sampling plus force-sampled debug mode for selected review runs.

### 9.8 Trace links

When operations are logically related but not parent/child, use span links.

Examples:

```text
review.run trace links to index.run trace
publish trace links to review.run trace
memory.update trace links to published finding trace
```

---

## 10. Metrics

### 10.1 Metric naming

Use this prefix:

```text
code_review_agent.
```

Examples:

```text
code_review_agent.webhook.deliveries_total
code_review_agent.queue.jobs_total
code_review_agent.review.runs_total
code_review_agent.review.duration_ms
code_review_agent.index.duration_ms
code_review_agent.llm.tokens_total
code_review_agent.llm.cost_usd
```

### 10.2 Metric types

Use:

```text
Counter:
  monotonic counts, e.g. jobs completed, webhooks received

Histogram:
  latency, duration, sizes, costs, token counts

UpDownCounter/Gauge:
  queue depth, active jobs, active workspaces, disk bytes
```

Prefer histograms for durations.

### 10.3 Metric label rules

Allowed labels:

```text
service_name
environment
status
operation
stage
queue_name
provider
review_mode
finding_category
finding_severity
model_profile
language
error_class
skip_reason
publish_mode
```

Usually disallowed labels:

```text
org_id
repo_id
user_id
job_id
review_run_id
commit_sha
branch_name
file_path
pull_request_number
finding_id
```

Exception: internal-only low-volume metrics may include org/repo if exported to a controlled backend, but this should not be the default.

### 10.4 Core system metrics

#### API metrics

```text
code_review_agent.api.requests_total
  labels: route, method, status_class

code_review_agent.api.request_duration_ms
  labels: route, method, status_class

code_review_agent.api.errors_total
  labels: route, method, error_class
```

#### Webhook metrics

```text
code_review_agent.webhook.deliveries_total
  labels: provider, event_name, action, status

code_review_agent.webhook.delivery_duration_ms
  labels: provider, event_name, action, status

code_review_agent.webhook.rejections_total
  labels: provider, reason

code_review_agent.webhook.duplicate_deliveries_total
  labels: provider, event_name
```

#### Queue metrics

```text
code_review_agent.queue.jobs_enqueued_total
  labels: queue_name, job_type

code_review_agent.queue.jobs_started_total
  labels: queue_name, job_type

code_review_agent.queue.jobs_completed_total
  labels: queue_name, job_type

code_review_agent.queue.jobs_failed_total
  labels: queue_name, job_type, error_class

code_review_agent.queue.job_duration_ms
  labels: queue_name, job_type, status

code_review_agent.queue.wait_duration_ms
  labels: queue_name, job_type

code_review_agent.queue.depth
  labels: queue_name, state

code_review_agent.queue.retries_total
  labels: queue_name, job_type, reason
```

#### Review metrics

```text
code_review_agent.review.runs_total
  labels: status, review_mode, trigger

code_review_agent.review.duration_ms
  labels: status, review_mode

code_review_agent.review.stage_duration_ms
  labels: stage, status

code_review_agent.review.skipped_total
  labels: skip_reason

code_review_agent.review.superseded_total
  labels: reason

code_review_agent.review.findings_candidate_total
  labels: category, severity, source

code_review_agent.review.findings_validated_total
  labels: category, severity, source

code_review_agent.review.findings_rejected_total
  labels: rejection_reason, category, source

code_review_agent.review.findings_published_total
  labels: category, severity, source
```

#### Indexing metrics

```text
code_review_agent.index.runs_total
  labels: status, driver, language_group

code_review_agent.index.duration_ms
  labels: status, driver

code_review_agent.index.files_total
  labels: language, status

code_review_agent.index.symbols_total
  labels: language, symbol_kind

code_review_agent.index.chunks_total
  labels: language

code_review_agent.index.edges_total
  labels: edge_kind

code_review_agent.index.artifact_bytes
  labels: driver

code_review_agent.index.cache_hits_total
  labels: cache_type

code_review_agent.index.cache_misses_total
  labels: cache_type
```

#### Repo sync metrics

```text
code_review_agent.repo_sync.operations_total
  labels: operation, status

code_review_agent.repo_sync.duration_ms
  labels: operation, status

code_review_agent.repo_sync.bytes_fetched
  labels: provider

code_review_agent.repo_sync.active_workspaces
  labels: worker_pool

code_review_agent.repo_sync.disk_usage_bytes
  labels: cache_type
```

#### Embedding metrics

```text
code_review_agent.embedding.jobs_total
  labels: status, provider, model_profile

code_review_agent.embedding.batch_duration_ms
  labels: provider, model_profile, status

code_review_agent.embedding.inputs_total
  labels: input_kind, provider, model_profile

code_review_agent.embedding.tokens_total
  labels: provider, model_profile

code_review_agent.embedding.cost_usd
  labels: provider, model_profile

code_review_agent.embedding.cache_hits_total
  labels: provider, model_profile

code_review_agent.embedding.cache_misses_total
  labels: provider, model_profile
```

#### Retrieval metrics

```text
code_review_agent.retrieval.requests_total
  labels: status, review_mode

code_review_agent.retrieval.duration_ms
  labels: status, review_mode

code_review_agent.retrieval.source_candidates_total
  labels: source_type

code_review_agent.retrieval.context_items_total
  labels: item_type, source_type

code_review_agent.retrieval.context_tokens
  labels: item_type, source_type

code_review_agent.retrieval.vector_search_duration_ms
  labels: vector_backend

code_review_agent.retrieval.lexical_search_duration_ms
  labels: backend
```

#### LLM metrics

```text
code_review_agent.llm.calls_total
  labels: task, provider, model_profile, status

code_review_agent.llm.duration_ms
  labels: task, provider, model_profile, status

code_review_agent.llm.input_tokens_total
  labels: task, provider, model_profile

code_review_agent.llm.output_tokens_total
  labels: task, provider, model_profile

code_review_agent.llm.cost_usd
  labels: task, provider, model_profile

code_review_agent.llm.cache_hits_total
  labels: task, model_profile

code_review_agent.llm.cache_misses_total
  labels: task, model_profile

code_review_agent.llm.structured_output_failures_total
  labels: task, provider, model_profile

code_review_agent.llm.retries_total
  labels: task, provider, reason

code_review_agent.llm.rate_limited_total
  labels: provider, model_profile
```

#### Publishing metrics

```text
code_review_agent.publisher.runs_total
  labels: provider, publish_mode, status

code_review_agent.publisher.duration_ms
  labels: provider, publish_mode, status

code_review_agent.publisher.comments_created_total
  labels: provider, comment_type

code_review_agent.publisher.comments_updated_total
  labels: provider, comment_type

code_review_agent.publisher.comments_skipped_total
  labels: provider, reason

code_review_agent.publisher.github_rate_limited_total
  labels: operation
```

#### Static analysis metrics

```text
code_review_agent.static_analysis.runs_total
  labels: tool, status

code_review_agent.static_analysis.duration_ms
  labels: tool, status

code_review_agent.static_analysis.diagnostics_total
  labels: tool, severity, category

code_review_agent.static_analysis.timeouts_total
  labels: tool
```

#### Sandbox metrics

```text
code_review_agent.sandbox.runs_total
  labels: runner, trust_level, status

code_review_agent.sandbox.duration_ms
  labels: runner, trust_level, status

code_review_agent.sandbox.cpu_ms
  labels: runner, trust_level

code_review_agent.sandbox.memory_peak_bytes
  labels: runner, trust_level

code_review_agent.sandbox.output_bytes
  labels: runner, trust_level

code_review_agent.sandbox.violations_total
  labels: runner, violation_type
```

#### Memory/feedback metrics

```text
code_review_agent.feedback.events_total
  labels: event_type, provider

code_review_agent.feedback.signals_total
  labels: signal_type

code_review_agent.memory.candidates_total
  labels: status, source

code_review_agent.memory.facts_total
  labels: scope, status

code_review_agent.memory.suppression_matches_total
  labels: scope, match_type
```

### 10.5 Business quality metrics

These are product metrics, but they should still be emitted safely.

```text
code_review_agent.quality.comments_per_review
  labels: review_mode

code_review_agent.quality.published_findings_per_review
  labels: review_mode

code_review_agent.quality.finding_acceptance_total
  labels: category, severity

code_review_agent.quality.finding_rejection_total
  labels: category, severity, reason

code_review_agent.quality.review_replay_diff_total
  labels: prompt_version, indexer_version
```

Do not include org/repo labels by default. Store per-org/repo quality rollups in Postgres for dashboard analytics.

---

## 11. Health checks

### 11.1 API health endpoints

```text
GET /healthz
GET /readyz
GET /livez
```

Definitions:

```text
/livez:
  process is alive

/readyz:
  process can serve traffic
  checks critical dependencies

/healthz:
  human-readable health summary
```

API readiness checks:

```text
- Postgres connection
- Redis connection if API enqueues jobs
- config loaded
- GitHub App config present
```

### 11.2 Worker health

Worker health should include:

```text
- process alive
- connected to Redis
- connected to Postgres
- registered queues
- active job count
- last successful heartbeat
- graceful shutdown state
```

### 11.3 Indexer CLI health

Indexer CLI should support:

```bash
indexer-cli health
indexer-cli version
indexer-cli capabilities
```

Output:

```json
{
  "name": "indexer-ts",
  "version": "0.1.0",
  "schemaVersions": ["index_artifact.v1"],
  "languages": ["typescript", "javascript", "python"],
  "status": "ok"
}
```

### 11.4 Dependency checks

Periodic dependency checks:

```text
Postgres
Redis
object storage
GitHub API reachability
LLM provider availability
embedding provider availability
vector backend
```

Do not perform expensive checks on every `/readyz` request.

---

## 12. Error model

### 12.1 Error classes

Define normalized error classes:

```ts
export type ErrorClass =
  | "config_error"
  | "auth_error"
  | "permission_error"
  | "validation_error"
  | "rate_limit_error"
  | "provider_error"
  | "network_error"
  | "timeout_error"
  | "db_error"
  | "queue_error"
  | "artifact_error"
  | "index_error"
  | "embedding_error"
  | "retrieval_error"
  | "llm_error"
  | "publish_error"
  | "sandbox_error"
  | "policy_error"
  | "unknown_error";
```

### 12.2 Safe error serialization

```ts
export type SerializedError = {
  errorClass: ErrorClass;
  name: string;
  message: string;
  safeMessage: string;
  code?: string;
  statusCode?: number;
  stackHash?: string;
  causeClass?: ErrorClass;
  retryable: boolean;
};
```

Do not log raw stack traces in production by default. Store stack hash and safe message. Full stack can be sent to an internal error tracker only if policy allows.

### 12.3 Error event helper

```ts
logger.error("review stage failed", {
  event_name: "review.stage.failed",
  ...serializeError(error),
  review_run_id: reviewRunId,
  stage,
});
```

### 12.4 Retry classification

Errors should be classified for retries:

```text
retryable:
  network error
  temporary provider error
  rate limit with backoff
  queue transient error
  object storage transient error

not retryable:
  invalid config
  invalid artifact schema
  permission denied
  missing repo
  invalid webhook signature
  policy skip
```

---

## 13. Correlation and context

### 13.1 Request context

```ts
export type RequestContext = {
  requestId: string;
  traceId?: string;
  userId?: string;
  orgId?: string;
  installationId?: string;
  ipHash?: string;
  userAgentHash?: string;
};
```

### 13.2 Job context

```ts
export type JobContext = {
  jobId: string;
  queueName: string;
  jobType: string;
  attempt: number;
  traceparent?: string;
  requestId?: string;
  orgId?: string;
  repoId?: string;
  reviewRunId?: string;
};
```

### 13.3 Review context

```ts
export type ReviewTelemetryContext = {
  orgId: string;
  repoId: string;
  provider: "github" | "gitlab" | "bitbucket";
  installationId: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  reviewRunId: string;
};
```

### 13.4 Context propagation API

```ts
export function withTelemetryContext<T>(
  attrs: TelemetryAttrs,
  fn: () => Promise<T>,
): Promise<T>;

export function getTelemetryContext(): TelemetryAttrs;

export function injectTraceContext(carrier: Record<string, string>): void;

export function extractTraceContext<T>(
  carrier: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T>;
```

---

## 14. Instrumentation by component

### 14.1 API server

Instrument:

```text
- request start/end
- route
- method
- status code
- auth result
- org selection
- DB query duration via DB wrapper
- queue enqueue calls
- errors
```

Spans:

```text
api.request
api.auth
api.rbac
api.db_query
api.queue_enqueue
```

Logs:

```text
api.request.started
api.request.completed
api.request.failed
api.auth.failed
api.rbac.denied
```

Metrics:

```text
api.requests_total
api.request_duration_ms
api.errors_total
```

Elysia middleware shape:

```ts
export function observabilityElysiaPlugin() {
  return new Elysia({ name: "observability" })
    .derive(({ request, path }) => {
      const requestId = getOrCreateRequestId(request);
      return { requestId };
    })
    .onBeforeHandle(({ requestId, request }) => {
      // start span / attach context
    })
    .onAfterHandle(({ requestId, response }) => {
      // record success
    })
    .onError(({ requestId, error }) => {
      // record error
    });
}
```

### 14.2 Webhook ingestion

Instrument:

```text
- delivery received
- signature verification
- payload parse
- event normalization
- event persistence
- idempotency decision
- job planning
- job enqueue
- response duration
```

Spans:

```text
webhook.receive
webhook.verify_signature
webhook.normalize
webhook.persist_event
webhook.plan_jobs
webhook.enqueue_jobs
```

Important attributes:

```text
app.provider
github.event_name
github.event_action
github.delivery_id
app.webhook_event_id
app.idempotency_status
```

Do not put the raw payload in logs/spans.

### 14.3 Queue and workers

Instrument:

```text
- enqueue
- dequeue/start
- attempt number
- completion
- failure
- retry scheduling
- queue wait time
- job runtime
- stalled jobs
- dead-letter jobs
```

Root span per job:

```text
worker.job
```

Attributes:

```text
app.queue_name
app.job_type
app.job_id
app.job_attempt
app.job_priority
app.job_dedupe_key
```

Wrapper:

```ts
export function instrumentJobHandler<TPayload>(
  jobType: string,
  handler: JobHandler<TPayload>,
): JobHandler<TPayload> {
  return async (job) => {
    return withJobSpan(job, async () => {
      const start = performance.now();
      try {
        logger.info("queue job started", jobLogAttrs(job));
        const result = await handler(job);
        recordJobCompleted(job, performance.now() - start);
        return result;
      } catch (error) {
        recordJobFailed(job, error, performance.now() - start);
        throw error;
      }
    });
  };
}
```

### 14.4 Database layer

Instrument at the DB wrapper/repository layer.

Track:

```text
- query operation
- query category
- duration
- row count when safe
- transaction duration
- transaction retries
- advisory lock wait time
```

Avoid logging raw SQL values. For raw SQL, use a normalized query name:

```text
repository.findById
reviewRun.create
indexImporter.upsertChunks
retrieval.semanticSearch
```

Spans:

```text
db.query
db.transaction
db.advisory_lock
```

Metrics:

```text
code_review_agent.db.query_duration_ms
code_review_agent.db.transactions_total
code_review_agent.db.advisory_lock_wait_ms
```

Metric labels:

```text
operation
status
```

No table-specific high-cardinality labels unless carefully controlled.

### 14.5 GitHub adapter

Instrument:

```text
- installation token creation
- API request duration
- rate limit headers
- secondary rate limit detection
- pagination
- PR snapshot fetch
- diff fetch
- comment publish
- check run publish
```

Spans:

```text
github.create_installation_token
github.rest_request
github.fetch_pr_snapshot
github.fetch_diff
github.publish_review
github.create_check_run
```

Attributes:

```text
app.provider=github
github.operation
github.api_route_template
github.status_code
github.rate_limit_remaining
github.rate_limit_reset_unix
```

Do not log full URLs if they include tokens. Do not log headers containing auth.

### 14.6 Repo sync

Instrument:

```text
- mirror lookup
- mirror clone
- fetch
- worktree creation
- checkout
- cleanup
- disk usage
- quota enforcement
- lock wait
```

Spans:

```text
repo_sync.acquire_mirror_lock
repo_sync.fetch
repo_sync.create_worktree
repo_sync.cleanup_worktree
repo_sync.measure_disk
```

Metrics:

```text
repo_sync.duration_ms
repo_sync.bytes_fetched
repo_sync.disk_usage_bytes
repo_sync.active_workspaces
```

Attributes/logs:

```text
operation
status
provider
repo_id
commit_sha in traces/logs only, not metrics
```

### 14.7 Indexer boundary

Instrument:

```text
- driver selection
- indexer process spawn
- indexer duration
- stdout/stderr byte counts
- artifact validation handoff
- timeout/kill events
- language support/capability mismatch
```

Spans:

```text
indexer_driver.run
indexer_driver.spawn_cli
indexer_driver.validate_result
```

Metrics:

```text
indexer_driver.runs_total
indexer_driver.duration_ms
indexer_driver.timeouts_total
indexer_driver.output_bytes
```

Do not log stdout/stderr raw by default. Store bounded, redacted summaries or artifact references.

### 14.8 TypeScript indexer / indexer CLI

The indexer CLI should emit machine-readable progress events to stderr/stdout or a telemetry file.

Example progress event:

```json
{
  "event_name": "indexer.file_parsed",
  "language": "typescript",
  "status": "success",
  "duration_ms": 3,
  "symbols": 7,
  "chunks": 3
}
```

The worker should aggregate, not log one event per file in production.

Indexer metrics:

```text
files discovered
files skipped
files parsed
files failed
symbols extracted
chunks emitted
edges emitted
artifact bytes
parse duration by language
```

### 14.9 Index importer

Instrument:

```text
- artifact open
- manifest validation
- record streaming
- batch insert duration
- record counts by type
- integrity checks
- embedding job planning
- activation
```

Spans:

```text
index_importer.import_artifact
index_importer.validate_manifest
index_importer.stream_records
index_importer.insert_batch
index_importer.activate_index_version
index_importer.plan_embedding_jobs
```

Metrics:

```text
index_importer.imports_total
index_importer.duration_ms
index_importer.records_total
index_importer.batch_insert_duration_ms
index_importer.validation_failures_total
```

### 14.10 Embedding pipeline

Instrument:

```text
- chunk selection
- cache hit/miss
- batch size
- input tokens/chars
- provider call duration
- vector validation
- DB write duration
- cost
```

Spans:

```text
embedding.plan_batch
embedding.provider_call
embedding.write_vectors
```

Metrics:

```text
embedding.batch_duration_ms
embedding.inputs_total
embedding.tokens_total
embedding.cost_usd
embedding.cache_hits_total
embedding.cache_misses_total
```

Attributes:

```text
provider
model_profile
input_kind
status
```

Do not include chunk text.

### 14.11 Retrieval engine

Instrument retrieval as a first-class product surface.

Track:

```text
- total retrieval duration
- changed symbol count
- candidates by source
- candidates after dedupe
- selected context items
- token budget requested/used
- vector search latency
- lexical search latency
- graph search latency
- retrieval trace artifact URI
```

Spans:

```text
retrieval.build_context
retrieval.detect_changed_symbols
retrieval.same_file_context
retrieval.graph_context
retrieval.semantic_search
retrieval.lexical_search
retrieval.related_tests
retrieval.rank_candidates
retrieval.pack_context
retrieval.persist_artifact
```

Metrics:

```text
retrieval.duration_ms
retrieval.source_candidates_total
retrieval.context_items_total
retrieval.context_tokens
retrieval.search_duration_ms
```

Important: retrieval traces may include file paths and snippets. Store them as controlled artifacts, not generic telemetry.

### 14.12 Review orchestrator

Instrument the stage state machine.

For every stage:

```text
- stage started
- stage completed
- stage failed
- duration
- state transition
- artifact produced
```

Spans:

```text
review_orchestrator.run
review_orchestrator.stage
```

Stage names:

```text
create_or_reuse_run
fetch_snapshot
gate_review
compile_policy
ensure_index
ensure_embeddings
build_changeset
retrieve_context
run_review_engine
validate_findings
create_publish_plan
enqueue_publish
finalize
```

Metrics:

```text
review.stage_duration_ms
review.runs_total
review.skipped_total
review.superseded_total
```

### 14.13 LLM gateway

Instrument:

```text
- task
- provider
- model profile
- prompt version
- schema version
- input token estimate
- output tokens
- latency
- cost
- cache hit/miss
- structured output validation failures
- retries
- rate limits
- fallback provider use
```

Spans:

```text
llm.generate_text
llm.generate_object
llm.validate_output
llm.retry
```

Metrics:

```text
llm.calls_total
llm.duration_ms
llm.input_tokens_total
llm.output_tokens_total
llm.cost_usd
llm.structured_output_failures_total
llm.rate_limited_total
```

Logs should not include prompts/responses by default. Store prompt/response artifact refs only when policy allows.

Safe LLM log:

```json
{
  "event_name": "llm.call.completed",
  "task": "review.correctness",
  "provider": "openai",
  "model_profile": "review_strong",
  "prompt_version": "review.correctness.v1",
  "duration_ms": 2187,
  "input_tokens": 4812,
  "output_tokens": 732,
  "cost_usd": 0.0132,
  "cache_status": "miss",
  "status": "success"
}
```

### 14.14 Review engine / review passes

Instrument:

```text
- pass selection
- pass start/end
- candidates generated
- candidates normalized
- judge pass count
- prompt versions used
- budget used
```

Spans:

```text
review_engine.run
review_engine.pass
review_engine.normalize_candidates
review_engine.judge_candidates
```

Metrics:

```text
review.pass_duration_ms
review.pass_candidates_total
review.pass_failures_total
```

Labels:

```text
pass_name
status
```

### 14.15 Finding validation

Instrument every rejection reason in aggregate.

Track:

```text
- candidate count
- schema valid/invalid
- anchor valid/invalid
- evidence valid/invalid
- suppressed by rule/memory
- duplicates removed
- final publishable count
- budget truncation
```

Spans:

```text
finding_validation.run
finding_validation.anchor_check
finding_validation.evidence_check
finding_validation.suppression_check
finding_validation.dedupe
finding_validation.rank
```

Metrics:

```text
review.findings_rejected_total
review.findings_validated_total
review.findings_published_total
```

### 14.16 Publisher

Instrument:

```text
- publish plan loaded
- staleness guard
- existing marker lookup
- grouped review creation
- inline comments created
- summary created/updated
- check run created/updated
- duplicate prevention
- partial publish
- GitHub errors/rate limits
```

Spans:

```text
publisher.publish_review
publisher.check_staleness
publisher.lookup_existing_comments
publisher.render_comments
publisher.github_create_review
publisher.github_upsert_summary
publisher.github_update_check_run
```

Metrics:

```text
publisher.runs_total
publisher.duration_ms
publisher.comments_created_total
publisher.comments_skipped_total
```

### 14.17 Feedback and memory

Instrument:

```text
- feedback event ingestion
- marker correlation
- permission checks
- signal classification
- outcome update
- memory candidate creation
- memory fact activation
- suppression match
```

Spans:

```text
memory.process_feedback
memory.correlate_finding
memory.classify_signal
memory.update_outcome
memory.create_candidate
memory.activate_fact
memory.match_suppression
```

Metrics:

```text
feedback.events_total
feedback.signals_total
memory.candidates_total
memory.facts_total
memory.suppression_matches_total
```

### 14.18 Rules/configuration

Instrument:

```text
- policy compilation
- rule evaluation
- trigger decisions
- path decisions
- finding policy decisions
- publishing policy decisions
```

Spans:

```text
rules.compile_policy
rules.evaluate_trigger
rules.evaluate_path
rules.evaluate_finding
```

Metrics:

```text
rules.policy_compilations_total
rules.policy_compile_duration_ms
rules.decisions_total
```

Labels:

```text
decision_type
action
reason
```

### 14.19 Static analysis

Instrument:

```text
- plan creation
- tool selection
- sandbox request
- tool duration
- output size
- diagnostic count
- parse failures
- timeouts
```

Spans:

```text
static_analysis.plan
static_analysis.run_tool
static_analysis.parse_output
static_analysis.normalize_diagnostics
```

Metrics:

```text
static_analysis.runs_total
static_analysis.duration_ms
static_analysis.diagnostics_total
static_analysis.timeouts_total
```

### 14.20 Sandbox

Instrument sandbox runs without logging raw command output by default.

Track:

```text
- runner type
- trust level
- command category
- duration
- exit code
- CPU/memory usage
- network policy
- file mount policy
- output bytes
- artifact bytes
- violation type
```

Spans:

```text
sandbox.run
sandbox.prepare
sandbox.execute
sandbox.collect_artifacts
sandbox.cleanup
```

Metrics:

```text
sandbox.runs_total
sandbox.duration_ms
sandbox.cpu_ms
sandbox.memory_peak_bytes
sandbox.violations_total
```

---

## 15. Durable observability data in Postgres

Telemetry backends are not the only source of truth. Durable product-state observability should also live in Postgres.

### 15.1 `review_stage_events`

```sql
create table review_stage_events (
  id text primary key,
  review_run_id text not null references review_runs(id),
  stage text not null,
  status text not null,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer,
  error_class text,
  error_message text,
  artifact_uri text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index review_stage_events_review_run_idx
  on review_stage_events (review_run_id, created_at);
```

### 15.2 `telemetry_events` optional table

Use only for durable product events, not all logs.

```sql
create table telemetry_events (
  id text primary key,
  event_name text not null,
  org_id text,
  repo_id text,
  review_run_id text,
  job_id text,
  severity text not null,
  message text not null,
  attrs jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index telemetry_events_review_run_idx
  on telemetry_events (review_run_id, created_at);

create index telemetry_events_event_name_idx
  on telemetry_events (event_name, created_at);
```

### 15.3 `system_health_snapshots` optional table

```sql
create table system_health_snapshots (
  id text primary key,
  service_name text not null,
  environment text not null,
  status text not null,
  checks jsonb not null,
  created_at timestamptz not null default now()
);
```

### 15.4 `review_run_metrics` optional rollup table

Useful for dashboard and analytics without querying external telemetry.

```sql
create table review_run_metrics (
  review_run_id text primary key references review_runs(id),
  total_duration_ms integer,
  snapshot_duration_ms integer,
  index_wait_duration_ms integer,
  retrieval_duration_ms integer,
  review_engine_duration_ms integer,
  validation_duration_ms integer,
  publishing_duration_ms integer,
  candidate_findings integer,
  validated_findings integer,
  published_findings integer,
  rejected_findings integer,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric(12, 6),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

---

## 16. Artifact strategy

Use artifacts for high-detail debug data.

Important artifacts:

```text
webhook payload digest
raw PR diff
PullRequestSnapshot
DiffModel
ChangeSet
IndexArtifact
IndexImportSummary
EmbeddingBatchSummary
RetrievalTrace
ContextBundle
ReviewPassArtifact
CandidateFindings
RejectedFindings
ValidatedFindings
PublishPlan
PublishResult
FeedbackCorrelationTrace
```

Artifact record:

```ts
export type ObservabilityArtifactRef = {
  artifactId: string;
  kind: string;
  uri: string;
  sha256: string;
  byteSize: number;
  redactionLevel: "safe" | "contains_code" | "contains_prompt" | "contains_sensitive";
  createdAt: string;
};
```

Rules:

```text
- store artifacts in object storage
- reference artifacts from review_runs/review_artifacts
- do not emit artifact contents into logs/traces
- hash every artifact
- enforce retention policy
- enforce access control in dashboard/API
```

---

## 17. Dashboards

### 17.1 Executive/system dashboard

Questions:

```text
Is the system healthy?
Are reviews completing?
Are costs under control?
Are users getting value?
```

Panels:

```text
- review runs by status
- median/p95 review duration
- review runs skipped by reason
- published findings per review
- cost per review
- queue depth by queue
- failed jobs by queue
- API error rate
- GitHub publish failures
- LLM provider errors
```

### 17.2 Review pipeline dashboard

Panels:

```text
- review stage p50/p95/p99 durations
- review stage failures by error class
- index wait time
- retrieval duration
- review engine duration
- validation rejection reasons
- publish duration
- end-to-end time to first review
```

### 17.3 Indexing dashboard

Panels:

```text
- index runs by status
- index duration by driver
- files parsed by language
- parse failures by language
- artifact size
- cache hit/miss
- import duration
- embedding backlog
```

### 17.4 LLM/cost dashboard

Panels:

```text
- LLM calls by task/provider/model profile
- input/output tokens
- cost by task
- cost per review
- structured output failure rate
- rate limit events
- retry count
- provider latency p95
- cache hit rate
```

### 17.5 Queue dashboard

Panels:

```text
- queue depth by queue
- active jobs
- waiting jobs
- delayed jobs
- failed jobs
- stalled jobs
- job wait time p95
- job duration p95
- retries by job type
```

### 17.6 Publishing dashboard

Panels:

```text
- publish runs by status
- comments created/updated/skipped
- duplicate prevention count
- stale publish attempts prevented
- GitHub API latency
- GitHub rate limit remaining
- publish failures by error class
```

### 17.7 Customer onboarding dashboard

Panels:

```text
- installation events
- repos enabled
- initial index status
- first review time
- reviews skipped by config
- review success rate for new orgs
```

---

## 18. Alerts

### 18.1 Principles

Alerts should be actionable. Avoid alerts for things no one will act on.

Alert classes:

```text
Page:
  user-facing outage or severe degradation

Ticket:
  degraded but not urgent

Info:
  useful signal, no action required
```

### 18.2 Core alerts

#### API down

```text
Condition:
  API readiness fails for > 5 minutes
Severity:
  Page
```

#### Webhook ingestion failures

```text
Condition:
  webhook rejection/failure rate > threshold for 10 minutes
Severity:
  Page if widespread, ticket if isolated
```

#### Review queue backlog

```text
Condition:
  pr.review queue wait p95 > 10 minutes for 15 minutes
Severity:
  Page or ticket depending on customer tier
```

#### Review failure rate

```text
Condition:
  review runs failed / review runs started > 10% for 15 minutes
Severity:
  Page
```

#### Publishing failure rate

```text
Condition:
  publisher runs failed > 5% for 15 minutes
Severity:
  Page
```

#### LLM provider outage

```text
Condition:
  LLM provider error/rate-limit failures > 20% for 10 minutes
Severity:
  Page if no fallback, ticket if fallback working
```

#### Cost anomaly

```text
Condition:
  cost per review or total hourly cost > expected threshold
Severity:
  Ticket or page depending on budget guardrail
```

#### Embedding backlog

```text
Condition:
  embedding queue age p95 > threshold
Severity:
  Ticket
```

#### Indexing failures

```text
Condition:
  index runs failed > threshold for specific driver/language
Severity:
  Ticket
```

#### Sandbox violation spike

```text
Condition:
  sandbox violations spike above baseline
Severity:
  Ticket/page depending on violation type
```

### 18.3 Alert metadata

Every alert should include:

```text
- service
- environment
- dashboard link
- runbook link
- likely owner
- recent deploy version
- affected queue/stage/provider
```

---

## 19. SLOs and SLIs

### 19.1 Suggested MVP SLOs

#### Webhook ingestion latency

```text
SLO:
  99% of valid webhook deliveries return 2xx within 5 seconds.

SLI:
  webhook delivery duration and success status.
```

#### Review completion latency

```text
SLO:
  90% of standard PR reviews complete within 5 minutes after webhook ingestion.

SLI:
  review_run.completed_at - webhook_event.received_at
```

Use different SLOs by repo size/PR size.

#### Publishing reliability

```text
SLO:
  99% of publishable review runs publish successfully or are explicitly skipped for a valid reason.

SLI:
  publisher success / publish attempts.
```

#### Queue freshness

```text
SLO:
  95% of pr.review jobs start within 60 seconds.

SLI:
  job started_at - job enqueued_at.
```

#### API availability

```text
SLO:
  99.9% API readiness during production hours.
```

### 19.2 Product quality SLO-like targets

These are not infrastructure SLOs, but they matter.

```text
- comments per review <= configured budget
- high-confidence finding publish rate stable
- rejection reasons not dominated by anchor failures
- finding acceptance rate improves over time
- duplicate comment rate near zero
```

---

## 20. Security and privacy

### 20.1 Data classification

Classify telemetry values:

```text
safe:
  counts, durations, statuses, enum labels

customer_metadata:
  org ID, repo ID, installation ID, PR number

code_sensitive:
  source code snippets, file contents, diffs, context bundles

secret_sensitive:
  tokens, keys, credentials, signed URLs

prompt_sensitive:
  raw prompts, raw model outputs, retrieved code context
```

Default behavior:

```text
safe -> metrics/logs/traces OK
customer_metadata -> traces/logs OK, metrics only if bounded/controlled
code_sensitive -> artifacts only, access-controlled
secret_sensitive -> never store, redact/drop
prompt_sensitive -> artifacts only if org policy allows
```

### 20.2 Redaction tests

Add tests that ensure these are redacted:

```text
Authorization: Bearer ...
ghp_...
github_pat_...
-----BEGIN PRIVATE KEY-----
OPENAI_API_KEY
DATABASE_URL
REDIS_URL
cookies
signed URLs
source code blocks when capture disabled
```

### 20.3 Access control

Dashboard access to debug artifacts should require:

```text
- authenticated user
- org membership
- repo access
- permission to view debug artifacts
- audit log entry
```

### 20.4 Retention

Suggested retention:

```text
metrics:
  30-180 days depending on backend

logs:
  14-30 days production default

traces:
  7-30 days default

review artifacts:
  30-90 days default, configurable

prompt/code artifacts:
  disabled by default or short retention
```

Enterprise customers may require custom retention or no external telemetry containing customer metadata.

---

## 21. Testing strategy

### 21.1 Unit tests

Test:

```text
- redaction
- safe error serialization
- logger child context merge
- metric label validation
- span attribute helpers
- context propagation
- job trace injection/extraction
- config parsing
```

### 21.2 Integration tests

Test:

```text
- API request creates span/log/metric
- webhook delivery creates expected telemetry
- worker job links to parent trace context
- failed job records error and metric
- review stage emits stage event
- LLM call records usage without prompt leakage
```

### 21.3 Golden telemetry tests

Create expected telemetry snapshots for:

```text
- successful review
- skipped review
- index wait/resume
- failed LLM call with retry
- stale publish prevented
- feedback memory update
```

Test shape, not exact timestamps.

### 21.4 Redaction regression tests

Add fixtures with fake secrets and code snippets. Assert logs/spans never include them when strict redaction is enabled.

### 21.5 Local telemetry smoke test

Script:

```bash
pnpm dev:observability
pnpm test:telemetry-smoke
```

Expected:

```text
- local API emits trace
- worker job emits linked trace
- metrics visible in Prometheus
- trace visible in Tempo/Grafana
- logs visible locally/Loki
```

---

## 22. Implementation details

### 22.1 Metric helper

```ts
export type MetricLabelValue = string | number | boolean;

export function safeMetricLabels(
  labels: Record<string, MetricLabelValue | undefined>,
): Record<string, MetricLabelValue> {
  // drop undefined
  // validate allowed label keys
  // reject high-cardinality keys in production
}
```

### 22.2 Timer helper

```ts
export async function observeDuration<T>(
  histogram: Histogram,
  labels: Record<string, MetricLabelValue>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    histogram.record(performance.now() - start, { ...labels, status: "success" });
    return result;
  } catch (error) {
    histogram.record(performance.now() - start, { ...labels, status: "error" });
    throw error;
  }
}
```

### 22.3 Span helper

```ts
export async function withSpan<T>(
  name: string,
  attrs: SpanAttrs,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: sanitizeSpanAttrs(attrs) }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(serializeError(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorMessage(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

### 22.4 Stage helper

```ts
export async function runObservedStage<T>(input: {
  reviewRunId: string;
  stage: ReviewStage;
  attrs?: SpanAttrs;
  fn: () => Promise<T>;
}): Promise<T> {
  return withSpan("review_orchestrator.stage", {
    "app.review_run_id": input.reviewRunId,
    "app.stage": input.stage,
    ...input.attrs,
  }, async () => {
    const startedAt = new Date();
    await recordStageStarted(input.reviewRunId, input.stage, startedAt);
    try {
      const result = await input.fn();
      await recordStageCompleted(input.reviewRunId, input.stage, startedAt, new Date());
      return result;
    } catch (error) {
      await recordStageFailed(input.reviewRunId, input.stage, startedAt, new Date(), error);
      throw error;
    }
  });
}
```

### 22.5 Error helper

```ts
export function classifyError(error: unknown): ErrorClass {
  if (isRateLimitError(error)) return "rate_limit_error";
  if (isTimeoutError(error)) return "timeout_error";
  if (isDbError(error)) return "db_error";
  if (isProviderError(error)) return "provider_error";
  return "unknown_error";
}
```

---

## 23. Local development setup

### 23.1 Compose services

Add services:

```yaml
otel-collector:
  image: otel/opentelemetry-collector-contrib:latest
  command: ["--config=/etc/otel-collector-config.yaml"]
  ports:
    - "4317:4317"
    - "4318:4318"
  volumes:
    - ./infra/otel/otel-collector-config.yaml:/etc/otel-collector-config.yaml

prometheus:
  image: prom/prometheus:latest
  ports:
    - "9090:9090"

tempo:
  image: grafana/tempo:latest
  ports:
    - "3200:3200"

loki:
  image: grafana/loki:latest
  ports:
    - "3100:3100"

grafana:
  image: grafana/grafana:latest
  ports:
    - "3001:3000"
```

### 23.2 Collector config

Example shape:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch: {}
  memory_limiter:
    check_interval: 1s
    limit_mib: 512

exporters:
  debug:
    verbosity: detailed
  prometheus:
    endpoint: 0.0.0.0:9464
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp/tempo, debug]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus, debug]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug]
```

Use Loki export if you set that up. Start with debug logs locally if simpler.

---

## 24. Production deployment notes

### 24.1 Collector topology

Options:

```text
sidecar collector:
  one collector per service instance
  good isolation, more overhead

agent collector:
  one collector per node/host
  good for k8s/VMs

gateway collector:
  centralized collectors
  easier backend routing, potential bottleneck
```

Recommended start:

```text
gateway collector for simple container deployment
agent + gateway for larger Kubernetes deployment
```

### 24.2 Deployment attributes

Set:

```text
APP_VERSION=git SHA or semver
APP_ENV=production
OBSERVABILITY_SERVICE_NAME=...
```

### 24.3 Release tracking

Every telemetry signal should include service version as a resource attribute.

Dashboard should support filtering by:

```text
service.version
deployment.environment.name
service.name
```

This makes it easier to identify deploy regressions.

### 24.4 Graceful shutdown

On shutdown:

```text
- stop accepting new HTTP requests
- pause worker job intake
- allow active job to finish or checkpoint
- flush logs/traces/metrics
- close DB/Redis connections
```

Flush telemetry with timeout:

```text
max 5 seconds for API
max 15 seconds for worker
```

---

## 25. Dashboard/API surfaces

In the app dashboard, expose observability in product terms.

### 25.1 Review run detail

Show:

```text
- stage timeline
- stage durations
- status/errors
- artifacts
- candidate/validated/published finding counts
- LLM calls summary
- cost summary
- retrieval summary
- publish summary
- feedback summary
```

### 25.2 Job detail

Show:

```text
- job type
- queue
- status
- attempts
- failure reason
- related review run
- related webhook event
- started/completed timestamps
```

### 25.3 Index version detail

Show:

```text
- indexer version
- schema version
- commit SHA
- file/symbol/chunk/edge counts
- parse failures
- import duration
- embedding coverage
- artifact URI/hash
```

### 25.4 LLM usage view

Show:

```text
- calls by task
- tokens by task
- cost by task
- provider/model profile
- structured output failures
- prompt versions
```

Do not show raw prompts/responses unless org policy and user permission allow.

---

## 26. Runbooks

Create runbooks for:

```text
- review queue backlog
- high review failure rate
- GitHub rate limiting
- LLM provider outage
- embedding backlog
- indexer failures
- publish failures
- cost spike
- Postgres connection exhaustion
- Redis unavailable
- object storage outage
- sandbox violation spike
```

Each runbook should include:

```text
- symptoms
- dashboard links
- first checks
- likely causes
- mitigation steps
- rollback steps
- escalation owner
```

Example runbook outline:

```text
Runbook: PR review queue backlog

Symptoms:
  pr.review queue depth increasing
  queue wait p95 > threshold
  reviews delayed

First checks:
  worker replicas healthy?
  Redis healthy?
  Postgres latency high?
  LLM provider rate limited?
  index queue blocking reviews?

Mitigations:
  scale review workers
  reduce concurrency if DB saturated
  temporarily disable expensive passes
  enable summary-only mode for low-priority repos
  switch/fallback model profile if LLM saturated
```

---

## 27. Implementation sequence

### PR 1: Package shell and config

Implement:

```text
/packages/observability
  config
  bootstrap no-op/console mode
  logger facade
  redaction helper
  error serialization
  tests
```

Acceptance:

```text
- package builds
- config parses env
- logger emits JSON
- redaction tests pass
```

### PR 2: OpenTelemetry bootstrap

Implement:

```text
- tracer provider
- meter provider
- OTLP exporter config
- resource attributes
- shutdown flush
- local console exporter
```

Acceptance:

```text
- API emits test span locally
- worker emits test span locally
- service.name/version/env visible
```

### PR 3: API instrumentation

Implement:

```text
- Elysia plugin
- request IDs
- request logging
- request duration metric
- error span/log behavior
```

Acceptance:

```text
- all API routes have trace/log context
- failed route records safe error
```

### PR 4: Queue/worker instrumentation

Implement:

```text
- job trace propagation
- worker root spans
- job logs
- job metrics
- queue depth metrics
```

Acceptance:

```text
- API/webhook trace links to worker job
- failed job records error and retry metadata
```

### PR 5: Review stage instrumentation

Implement:

```text
- review stage events
- runObservedStage helper
- review stage duration metrics
- stage timeline dashboard API data
```

Acceptance:

```text
- review run detail can show timeline from Postgres
```

### PR 6: Component-specific instrumentation

Implement wrappers for:

```text
- GitHub adapter
- repo sync
- indexer driver
- index importer
- embedding pipeline
- retrieval engine
- LLM gateway
- publisher
```

Acceptance:

```text
- end-to-end review trace shows major stages
- no raw code/prompt leakage in logs/traces
```

### PR 7: Local observability stack

Implement:

```text
- otel collector config
- Prometheus
- Tempo
- Grafana
- starter dashboards
```

Acceptance:

```text
- local smoke test produces visible metrics/traces
```

### PR 8: Alerts and runbooks

Implement:

```text
- base alerts
- runbook markdown files
- dashboard links
```

Acceptance:

```text
- alerts cover API, queue, review failures, LLM/provider failures, publishing failures
```

### PR 9: Redaction and privacy hardening

Implement:

```text
- stricter attribute sanitizer
- prompt/code capture policy
- audit event for debug artifact access
- redaction regression tests
```

Acceptance:

```text
- secret fixtures never appear in telemetry outputs
```

---

## 28. MVP cut

For the MVP, implement:

```text
- /packages/observability package
- config/env parsing
- structured logger
- redaction helper
- error serialization/classification
- OpenTelemetry bootstrap
- resource attributes
- Elysia API instrumentation
- webhook route instrumentation
- worker/job instrumentation
- queue metrics
- review stage events
- review stage metrics
- GitHub adapter basic spans
- repo sync basic spans
- indexer/importer basic spans
- embedding metrics
- retrieval metrics
- LLM call metrics/cost tracking
- publisher metrics
- local OTel Collector
- local Prometheus/Tempo/Grafana option
- basic dashboards
- core alerts
- redaction tests
```

Defer:

```text
- tail sampling
- distributed profiling
- advanced customer quality analytics
- Loki production setup if hosted logs are used
- vendor-specific deep integrations
- high-cardinality internal metrics
- full SLO/error-budget automation
```

---

## 29. Definition of done

#25 is complete when:

```text
- every service initializes /packages/observability
- every HTTP request has request ID + trace context
- every webhook delivery is logged/traced safely
- every background job has a root span and job metrics
- every review run has a durable stage timeline
- every major review stage emits duration metrics
- LLM calls emit tokens/cost/latency metrics without prompt leakage
- retrieval emits candidate/context/token metrics without snippet leakage
- publishing emits status/comment metrics
- index/import/embedding emit operational metrics
- logs are structured JSON
- secret/code/prompt redaction tests pass
- local dev can view at least one end-to-end trace
- dashboards exist for API, queue, review pipeline, LLM/cost, indexing, publishing
- base alerts exist for queue backlog, review failures, publishing failures, LLM provider failures, API health
```

---

## 30. Non-goals

Do not implement in #25:

```text
- business billing logic
- usage rollup billing tables beyond emitted usage metrics/events
- vendor-specific proprietary instrumentation throughout app code
- raw prompt/code logging by default
- profiling unless explicitly prioritized
- full incident management workflow
- replacing durable review artifacts with logs
```

---

## 31. Reference notes

Use these as implementation references when wiring the package:

```text
OpenTelemetry JavaScript docs:
  https://opentelemetry.io/docs/languages/js/

OpenTelemetry JavaScript manual instrumentation:
  https://opentelemetry.io/docs/languages/js/instrumentation/

OpenTelemetry semantic conventions:
  https://opentelemetry.io/docs/concepts/semantic-conventions/

OpenTelemetry HTTP semantic conventions:
  https://opentelemetry.io/docs/specs/semconv/http/

OpenTelemetry database semantic conventions:
  https://opentelemetry.io/docs/specs/semconv/db/

OpenTelemetry messaging semantic conventions:
  https://opentelemetry.io/docs/specs/semconv/messaging/

OpenTelemetry resource semantic conventions:
  https://opentelemetry.io/docs/specs/semconv/resource/

Prometheus histogram best practices:
  https://prometheus.io/docs/practices/histograms/

Prometheus metric types:
  https://prometheus.io/docs/concepts/metric_types/

Grafana Tempo docs:
  https://grafana.com/docs/tempo/latest/
```
