import { describe, expect, it } from "vitest";
import {
  createMemoryObservabilitySink,
  createObservabilityResourceAttributes,
  createObservabilityRuntime,
  createStructuredTelemetryLogger,
  createTelemetryMetricPoint,
  createTelemetryMetricRecorder,
  createTelemetrySpanRecorder,
  createTelemetryTraceContextFromHeaders,
  createTelemetryTraceHeaders,
  DEFAULT_OBSERVABILITY_CONFIG,
  loadObservabilityConfig,
  normalizeAdminControlPlaneTelemetryEvent,
  normalizeTelemetryTraceContext,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  ObservabilityConfigValidationError,
  recordAdminControlPlaneTelemetryEvent,
  renderStructuredTelemetryLogLine,
  renderTelemetryMetricLine,
  renderTelemetrySpanLine,
  sanitizeTelemetryAttributes,
  sanitizeTelemetryMetricLabels,
  serializeTelemetryError,
  summarizeAdminControlPlaneTelemetry,
} from "../src";

describe("observability config", () => {
  it("loads typed runtime config from environment variables", () => {
    const config = loadObservabilityConfig({
      APP_VERSION: "sha-123",
      LOG_LEVEL: "trace",
      OBSERVABILITY_CAPTURE_CODE_SNIPPETS: "false",
      OBSERVABILITY_CAPTURE_PROMPTS: "true",
      OBSERVABILITY_ENABLED: "true",
      OBSERVABILITY_ENV: "staging",
      OBSERVABILITY_EXPORTER: "otlp",
      OBSERVABILITY_INCLUDE_DEBUG_ATTRIBUTES: "true",
      OBSERVABILITY_LOG_RAW_ERRORS: "true",
      OBSERVABILITY_METRICS_INTERVAL_MS: "5000",
      OBSERVABILITY_OTLP_ENDPOINT: "http://otel-collector:4318",
      OBSERVABILITY_REDACTION_STRICT: "false",
      OBSERVABILITY_SERVICE_NAME: "code-review-api",
      OBSERVABILITY_TRACE_ERROR_SAMPLE_RATE: "1",
      OBSERVABILITY_TRACE_SAMPLE_RATE: "0.25",
      OBSERVABILITY_TRACE_SLOW_JOB_SAMPLE_RATE: "0.5",
    });

    expect(config).toMatchObject({
      enabled: true,
      environment: "staging",
      exporter: "otlp",
      logLevel: "debug",
      metricsIntervalMs: 5000,
      otlpEndpoint: "http://otel-collector:4318",
      redaction: {
        captureCodeSnippets: false,
        capturePrompts: true,
        includeDebugAttributes: true,
        logRawErrors: true,
        strict: false,
      },
      serviceName: "code-review-api",
      traceErrorSampleRate: 1,
      traceSampleRate: 0.25,
      traceSlowJobSampleRate: 0.5,
      version: "sha-123",
    });
  });

  it("rejects invalid observability environment values", () => {
    expect(() =>
      loadObservabilityConfig({
        OBSERVABILITY_EXPORTER: "zipkin",
        OBSERVABILITY_TRACE_SAMPLE_RATE: "2",
      }),
    ).toThrow(ObservabilityConfigValidationError);
  });

  it("rejects invalid OTLP endpoint URLs", () => {
    expect(() =>
      loadObservabilityConfig({
        OBSERVABILITY_OTLP_ENDPOINT: "localhost:4318",
      }),
    ).toThrow(ObservabilityConfigValidationError);
  });

  it("builds stable service resource attributes without customer identifiers", () => {
    const config = loadObservabilityConfig({
      APP_VERSION: "sha-123",
      OBSERVABILITY_ENV: "production",
      OBSERVABILITY_SERVICE_NAME: "code-review-worker",
    });

    const attributes = createObservabilityResourceAttributes(config, { HOSTNAME: "worker-1" });

    expect(attributes).toMatchObject({
      "deployment.environment.name": "production",
      "host.name": "worker-1",
      "service.name": "code-review-worker",
      "service.namespace": "code-review-agent",
      "service.version": "sha-123",
    });
    expect(attributes).not.toHaveProperty("org_id");
    expect(attributes).not.toHaveProperty("repo_id");
  });
});

describe("structured telemetry logging", () => {
  it("sanitizes unsafe attributes and redacts secret-looking text", () => {
    const attributes = sanitizeTelemetryAttributes({
      "debug.trace": "drop debug internals",
      "github.token": "ghp_1234567890",
      "http.status_code": 200,
      "prompt.raw": "ignore all previous instructions",
      "provider.message": "Bearer ghp_1234567890 failed for dev@example.com",
    });

    expect(attributes).toEqual({
      "http.status_code": 200,
      "provider.message": "Bearer [redacted] failed for [redacted-email]",
    });
  });

  it("serializes errors without leaking raw messages by default", () => {
    const error = Object.assign(
      new Error("GitHub rate limit for dev@example.com with token=ghp_1234567890"),
      {
        code: "GITHUB_RATE_LIMIT",
        retryable: true,
      },
    );
    const safeError = serializeTelemetryError(error);
    const verboseError = serializeTelemetryError(error, {
      ...DEFAULT_OBSERVABILITY_CONFIG.redaction,
      logRawErrors: true,
    });

    expect(safeError).toMatchObject({
      class: "rate_limit_error",
      code: "GITHUB_RATE_LIMIT",
      message: "External provider rate limit was reached.",
      retryable: true,
    });
    expect(verboseError.message).toContain("[redacted-email]");
    expect(verboseError.message).toContain("token=[redacted]");
    expect(verboseError.message).not.toContain("dev@example.com");
    expect(verboseError.message).not.toContain("ghp_1234567890");
  });

  it("emits structured JSON log lines with resource attributes", () => {
    const lines: string[] = [];
    const config = loadObservabilityConfig({
      APP_VERSION: "sha-456",
      OBSERVABILITY_ENABLED: "true",
      OBSERVABILITY_EXPORTER: "console",
      OBSERVABILITY_SERVICE_NAME: "heimdall-api",
    });
    const logger = createStructuredTelemetryLogger(
      config,
      {
        write: (entry) => {
          lines.push(renderStructuredTelemetryLogLine(entry));
        },
      },
      { HOSTNAME: "api-1" },
    );

    logger.info("Handled request token=ghp_1234567890", {
      attributes: {
        "http.status_code": 200,
        "prompt.raw": "raw prompt must not be logged",
      },
      timestamp: "2026-05-07T12:00:00.000Z",
    });

    const [entry] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entry).toMatchObject({
      attributes: {
        "http.status_code": 200,
      },
      level: "info",
      message: "Handled request token=[redacted]",
      resource: {
        "host.name": "api-1",
        "service.name": "heimdall-api",
        "service.version": "sha-456",
      },
      target: "heimdall-api",
      timestamp: "2026-05-07T12:00:00.000Z",
    });
    expect(JSON.stringify(entry)).not.toContain("raw prompt");
    expect(JSON.stringify(entry)).not.toContain("ghp_1234567890");
  });
});

describe("structured telemetry metrics", () => {
  it("exposes stable API and queue metric names", () => {
    expect(OBSERVABILITY_METRIC_NAMES).toMatchObject({
      apiRequestDurationMs: "code_review_agent.api.request_duration_ms",
      apiRequestsTotal: "code_review_agent.api.requests_total",
      feedbackEventsTotal: "code_review_agent.feedback.events_total",
      feedbackSignalsTotal: "code_review_agent.feedback.signals_total",
      llmCallsTotal: "code_review_agent.llm.calls_total",
      llmDurationMs: "code_review_agent.llm.duration_ms",
      llmRateLimitedTotal: "code_review_agent.llm.rate_limited_total",
      llmRetriesTotal: "code_review_agent.llm.retries_total",
      llmStructuredOutputFailuresTotal: "code_review_agent.llm.structured_output_failures_total",
      memoryCandidatesTotal: "code_review_agent.memory.candidates_total",
      memoryFactsTotal: "code_review_agent.memory.facts_total",
      memorySuppressionMatchesTotal: "code_review_agent.memory.suppression_matches_total",
      queueJobDurationMs: "code_review_agent.queue.job_duration_ms",
      queueJobsCompletedTotal: "code_review_agent.queue.jobs_completed_total",
      queueJobsFailedTotal: "code_review_agent.queue.jobs_failed_total",
      queueJobsStartedTotal: "code_review_agent.queue.jobs_started_total",
      queueRetriesTotal: "code_review_agent.queue.retries_total",
      reviewFindingsPublishedTotal: "code_review_agent.review.findings_published_total",
      reviewFindingsRejectedTotal: "code_review_agent.review.findings_rejected_total",
      reviewFindingsValidatedTotal: "code_review_agent.review.findings_validated_total",
      reviewPassCandidatesTotal: "code_review_agent.review.pass_candidates_total",
      reviewPassDurationMs: "code_review_agent.review.pass_duration_ms",
      reviewPassFailuresTotal: "code_review_agent.review.pass_failures_total",
      retrievalContextItemsTotal: "code_review_agent.retrieval.context_items_total",
      retrievalContextTokens: "code_review_agent.retrieval.context_tokens",
      retrievalDurationMs: "code_review_agent.retrieval.duration_ms",
      retrievalRequestsTotal: "code_review_agent.retrieval.requests_total",
      retrievalSourceCandidatesTotal: "code_review_agent.retrieval.source_candidates_total",
      sandboxCpuMs: "code_review_agent.sandbox.cpu_ms",
      sandboxDurationMs: "code_review_agent.sandbox.duration_ms",
      sandboxMemoryPeakBytes: "code_review_agent.sandbox.memory_peak_bytes",
      sandboxOutputBytes: "code_review_agent.sandbox.output_bytes",
      sandboxRunsTotal: "code_review_agent.sandbox.runs_total",
      sandboxViolationsTotal: "code_review_agent.sandbox.violations_total",
      staticAnalysisDiagnosticsTotal: "code_review_agent.static_analysis.diagnostics_total",
      staticAnalysisDurationMs: "code_review_agent.static_analysis.duration_ms",
      staticAnalysisOutputBytes: "code_review_agent.static_analysis.output_bytes",
      staticAnalysisParseFailuresTotal: "code_review_agent.static_analysis.parse_failures_total",
      staticAnalysisRunsTotal: "code_review_agent.static_analysis.runs_total",
      staticAnalysisTimeoutsTotal: "code_review_agent.static_analysis.timeouts_total",
      webhookDeliveriesTotal: "code_review_agent.webhook.deliveries_total",
      webhookDeliveryDurationMs: "code_review_agent.webhook.delivery_duration_ms",
      webhookDuplicateDeliveriesTotal: "code_review_agent.webhook.duplicate_deliveries_total",
      webhookRejectionsTotal: "code_review_agent.webhook.rejections_total",
    });
  });

  it("sanitizes metric labels by redacting unsafe values and dropping high-cardinality keys", () => {
    const labels = sanitizeTelemetryMetricLabels({
      "app.review_run_id": "rrun_1",
      "github.api_key": "sk-1234567890abcdef",
      "http.route": "/api/v1/repositories/:repoId",
      provider: "github",
      repo_id: "repo_1",
      status: "started",
    });

    expect(labels).toEqual({
      "http.route": "/api/v1/repositories/:repoId",
      provider: "github",
      status: "started",
    });
  });

  it("creates schema-valid metric points with resource attributes", () => {
    const config = loadObservabilityConfig({
      APP_VERSION: "sha-metric",
      OBSERVABILITY_SERVICE_NAME: "code-review-api",
    });
    const point = createTelemetryMetricPoint(
      config,
      {
        kind: "counter",
        labels: {
          review_run_id: "rrun_1",
          status: "started",
        },
        name: OBSERVABILITY_METRIC_NAMES.apiServiceStartsTotal,
        timestamp: "2026-05-07T12:02:00.000Z",
        value: 1,
      },
      { HOSTNAME: "api-1" },
    );

    expect(point).toMatchObject({
      kind: "counter",
      labels: { status: "started" },
      name: OBSERVABILITY_METRIC_NAMES.apiServiceStartsTotal,
      resource: {
        "host.name": "api-1",
        "service.name": "code-review-api",
        "service.version": "sha-metric",
      },
      timestamp: "2026-05-07T12:02:00.000Z",
      value: 1,
    });
    expect(renderTelemetryMetricLine(point)).toContain('"target":"heimdall.metrics"');
  });

  it("records console metrics only when observability is enabled", () => {
    const lines: string[] = [];
    const enabledConfig = loadObservabilityConfig({
      OBSERVABILITY_ENABLED: "true",
      OBSERVABILITY_EXPORTER: "console",
      OBSERVABILITY_SERVICE_NAME: "code-review-worker",
    });
    const disabledConfig = loadObservabilityConfig({
      OBSERVABILITY_ENABLED: "false",
      OBSERVABILITY_EXPORTER: "console",
    });
    const sink = {
      write: (point: ReturnType<typeof createTelemetryMetricPoint>) => {
        lines.push(renderTelemetryMetricLine(point));
      },
    };

    createTelemetryMetricRecorder(enabledConfig, sink).count(
      OBSERVABILITY_METRIC_NAMES.workerServiceStartsTotal,
      {
        labels: { status: "started" },
        timestamp: "2026-05-07T12:03:00.000Z",
      },
    );
    createTelemetryMetricRecorder(disabledConfig, sink).count(
      OBSERVABILITY_METRIC_NAMES.workerServiceStartsTotal,
    );

    const [entry] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(entry).toMatchObject({
      level: "info",
      metric: {
        kind: "counter",
        labels: { status: "started" },
        name: OBSERVABILITY_METRIC_NAMES.workerServiceStartsTotal,
        value: 1,
      },
      target: "heimdall.metrics",
    });
  });
});

describe("structured telemetry spans", () => {
  it("exposes stable review pipeline span names", () => {
    expect(OBSERVABILITY_SPAN_NAMES).toMatchObject({
      apiRequest: "code_review_agent.api.request",
      durableJobProcess: "code_review_agent.durable_job.process",
      findingValidationAnchorCheck: "code_review_agent.finding_validation.anchor_check",
      findingValidationDedupe: "code_review_agent.finding_validation.dedupe",
      findingValidationEvidenceCheck: "code_review_agent.finding_validation.evidence_check",
      findingValidationRank: "code_review_agent.finding_validation.rank",
      findingValidationRun: "code_review_agent.finding_validation.run",
      findingValidationSuppressionCheck: "code_review_agent.finding_validation.suppression_check",
      llmGenerateObject: "code_review_agent.llm.generate_object",
      memoryActivateFact: "code_review_agent.memory.activate_fact",
      memoryClassifySignal: "code_review_agent.memory.classify_signal",
      memoryCorrelateFinding: "code_review_agent.memory.correlate_finding",
      memoryCreateCandidate: "code_review_agent.memory.create_candidate",
      memoryMatchSuppression: "code_review_agent.memory.match_suppression",
      memoryProcessFeedback: "code_review_agent.memory.process_feedback",
      memoryUpdateOutcome: "code_review_agent.memory.update_outcome",
      pullRequestReview: "code_review_agent.review.pull_request",
      reviewEngineJudgeCandidates: "code_review_agent.review_engine.judge_candidates",
      reviewEngineNormalizeCandidates: "code_review_agent.review_engine.normalize_candidates",
      reviewEnginePass: "code_review_agent.review_engine.pass",
      reviewEngineRun: "code_review_agent.review_engine.run",
      reviewPipelineStage: "code_review_agent.review.pipeline_stage",
      retrievalBuildContext: "code_review_agent.retrieval.build_context",
      sandboxRun: "code_review_agent.sandbox.run",
      staticAnalysisNormalizeDiagnostics: "code_review_agent.static_analysis.normalize_diagnostics",
      staticAnalysisParseOutput: "code_review_agent.static_analysis.parse_output",
      staticAnalysisPlan: "code_review_agent.static_analysis.plan",
      staticAnalysisRunTool: "code_review_agent.static_analysis.run_tool",
      webhookDelivery: "code_review_agent.webhook.delivery",
    });
  });

  it("records console spans with resource attributes and trace context", () => {
    const lines: string[] = [];
    const config = loadObservabilityConfig({
      APP_VERSION: "sha-span",
      OBSERVABILITY_ENABLED: "true",
      OBSERVABILITY_EXPORTER: "console",
      OBSERVABILITY_SERVICE_NAME: "code-review-worker",
    });
    const recorder = createTelemetrySpanRecorder(
      config,
      {
        write: (span) => {
          lines.push(renderTelemetrySpanLine(span));
        },
      },
      { HOSTNAME: "worker-1" },
    );

    const span = recorder.startSpan(OBSERVABILITY_SPAN_NAMES.durableJobProcess, {
      attributes: {
        "debug.internal_state": "drop",
        "job.type": "github.sync_installation.v1",
        "provider.token": "ghp_1234567890",
      },
      kind: "consumer",
      startTime: "2026-05-07T12:04:00.000Z",
      traceContext: {
        requestId: "req_1",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    });
    span.end({
      attributes: { "job.run_state": "completed" },
      timestamp: "2026-05-07T12:04:00.250Z",
    });

    const [entry] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(entry).toMatchObject({
      level: "info",
      span: {
        attributes: {
          "job.run_state": "completed",
          "job.type": "github.sync_installation.v1",
        },
        durationMs: 250,
        kind: "consumer",
        name: OBSERVABILITY_SPAN_NAMES.durableJobProcess,
        resource: {
          "host.name": "worker-1",
          "service.name": "code-review-worker",
          "service.version": "sha-span",
        },
        status: "ok",
        traceContext: {
          requestId: "req_1",
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      },
      target: "heimdall.traces",
    });
    expect(JSON.stringify(entry)).not.toContain("internal_state");
    expect(JSON.stringify(entry)).not.toContain("ghp_1234567890");
  });
});

describe("telemetry trace context", () => {
  it("normalizes valid trace context fields", () => {
    const context = normalizeTelemetryTraceContext({
      parentEventId: " webhook_1 ",
      requestId: " req_1 ",
      traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
      tracestate: "vendor=value",
    });

    expect(context).toEqual({
      parentEventId: "webhook_1",
      requestId: "req_1",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    });
  });

  it("drops invalid trace context fields instead of propagating them", () => {
    const context = normalizeTelemetryTraceContext({
      parentEventId: "bad\nheader",
      requestId: "req_1",
      traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      tracestate: "bad\rstate",
    });

    expect(context).toEqual({
      requestId: "req_1",
    });
  });

  it("extracts and injects trace context headers", () => {
    const headers = createTelemetryTraceHeaders(
      createTelemetryTraceContextFromHeaders(
        new Headers({
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          tracestate: "vendor=value",
          "x-heimdall-parent-event-id": "webhook_1",
          "x-request-id": "req_1",
        }),
      ),
    );

    expect(headers).toEqual({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
      "x-heimdall-parent-event-id": "webhook_1",
      "x-request-id": "req_1",
    });
  });

  it("extracts trace context from case-insensitive header records", () => {
    const context = createTelemetryTraceContextFromHeaders({
      Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
      Tracestate: "vendor=value",
      "X-Heimdall-Parent-Event-Id": "webhook_1",
      "X-Request-Id": "req_1",
    });

    expect(context).toEqual({
      parentEventId: "webhook_1",
      requestId: "req_1",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    });
  });
});

describe("observability runtime bootstrap", () => {
  it("creates no-op runtime handles when observability is disabled", async () => {
    const lines: string[] = [];
    const runtime = createObservabilityRuntime({
      consoleLogger: {
        info: (line) => lines.push(String(line)),
        warn: (line) => lines.push(String(line)),
      },
      env: {
        OBSERVABILITY_ENABLED: "false",
        OBSERVABILITY_EXPORTER: "console",
      },
    });

    runtime.logger.info("hidden");
    runtime.metrics.count(OBSERVABILITY_METRIC_NAMES.apiServiceStartsTotal);
    runtime.adminControlPlaneSink.record({
      name: "admin.auth.success",
      timestamp: "2026-05-07T12:00:00.000Z",
    });
    await runtime.shutdown();

    expect(runtime.config.enabled).toBe(false);
    expect(lines).toEqual([]);
  });

  it("uses a service default only when the environment does not name a service", () => {
    const defaultedRuntime = createObservabilityRuntime({
      defaultServiceName: "code-review-api",
      env: {},
    });
    const environmentRuntime = createObservabilityRuntime({
      defaultServiceName: "code-review-api",
      env: {
        OBSERVABILITY_SERVICE_NAME: "custom-api",
      },
    });

    expect(defaultedRuntime.config.serviceName).toBe("code-review-api");
    expect(defaultedRuntime.resourceAttributes["service.name"]).toBe("code-review-api");
    expect(environmentRuntime.config.serviceName).toBe("custom-api");
    expect(environmentRuntime.resourceAttributes["service.name"]).toBe("custom-api");
  });

  it("creates console runtime handles with shared resource attributes", () => {
    const lines: string[] = [];
    const runtime = createObservabilityRuntime({
      consoleLogger: {
        info: (line) => lines.push(String(line)),
        warn: (line) => lines.push(String(line)),
      },
      env: {
        APP_VERSION: "sha-runtime",
        HOSTNAME: "worker-1",
        OBSERVABILITY_ENABLED: "true",
        OBSERVABILITY_EXPORTER: "console",
        OBSERVABILITY_SERVICE_NAME: "heimdall-worker",
      },
    });

    runtime.logger.warn("Queue depth is high", {
      attributes: { "queue.name": "reviews", "queue.depth": 12 },
      timestamp: "2026-05-07T12:01:00.000Z",
    });
    runtime.adminControlPlaneSink.record({
      name: "admin.replay.dispatched",
      timestamp: "2026-05-07T12:01:01.000Z",
    });
    runtime.metrics.count(OBSERVABILITY_METRIC_NAMES.workerServiceStartsTotal, {
      labels: { "app.review_run_id": "rrun_1", status: "started" },
      timestamp: "2026-05-07T12:01:02.000Z",
    });

    expect(runtime.resourceAttributes).toMatchObject({
      "host.name": "worker-1",
      "service.name": "heimdall-worker",
      "service.version": "sha-runtime",
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"level":"warn"');
    expect(lines[0]).toContain('"queue.name":"reviews"');
    expect(lines[1]).toContain('"target":"heimdall.admin_control_plane"');
    expect(lines[2]).toContain('"target":"heimdall.metrics"');
    expect(lines[2]).not.toContain("rrun_1");
  });

  it("creates OTLP runtime handles without writing console telemetry", () => {
    const lines: string[] = [];
    const runtime = createObservabilityRuntime({
      consoleLogger: {
        info: (line) => lines.push(String(line)),
        warn: (line) => lines.push(String(line)),
      },
      env: {
        APP_VERSION: "sha-otlp",
        HOSTNAME: "worker-otlp",
        OBSERVABILITY_ENABLED: "true",
        OBSERVABILITY_EXPORTER: "otlp",
        OBSERVABILITY_METRICS_INTERVAL_MS: "60000",
        OBSERVABILITY_OTLP_ENDPOINT: "http://otel-collector:4318",
        OBSERVABILITY_SERVICE_NAME: "heimdall-worker",
      },
      registerGlobalOpenTelemetry: false,
    });

    runtime.logger.info("Handled OTLP request", {
      attributes: { "http.status_code": 200 },
      timestamp: "2026-05-07T12:05:00.000Z",
    });
    runtime.metrics.count(OBSERVABILITY_METRIC_NAMES.workerServiceStartsTotal, {
      labels: { status: "started" },
      timestamp: "2026-05-07T12:05:01.000Z",
    });
    runtime.adminControlPlaneSink.record({
      name: "admin.replay.dispatched",
      timestamp: "2026-05-07T12:05:02.000Z",
    });
    const span = runtime.traces
      .startSpan(OBSERVABILITY_SPAN_NAMES.durableJobProcess, {
        attributes: { "job.type": "github.review_pull_request.v1" },
        kind: "consumer",
        startTime: "2026-05-07T12:05:03.000Z",
      })
      .end({ timestamp: "2026-05-07T12:05:03.125Z" });

    expect(runtime.config.exporter).toBe("otlp");
    expect(runtime.resourceAttributes).toMatchObject({
      "host.name": "worker-otlp",
      "service.name": "heimdall-worker",
      "service.version": "sha-otlp",
    });
    expect(span).toMatchObject({
      durationMs: 125,
      kind: "consumer",
      name: OBSERVABILITY_SPAN_NAMES.durableJobProcess,
      status: "ok",
    });
    expect(lines).toEqual([]);
  });
});

describe("admin control-plane telemetry", () => {
  it("normalizes and records events", () => {
    const sink = createMemoryObservabilitySink();
    const event = recordAdminControlPlaneTelemetryEvent(sink, {
      attributes: { code: "admin.forbidden", permission: "admin.replay.execute" },
      name: "admin.access.denied",
      requestId: "req_1",
      route: "/admin/debug/webhooks/webhook_1/replay",
      statusCode: 403,
    });

    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(sink.events()).toEqual([event]);
  });

  it("rejects invalid events", () => {
    expect(() =>
      normalizeAdminControlPlaneTelemetryEvent({
        name: "admin.access.denied",
        statusCode: 99,
        timestamp: "2026-05-06T12:00:00.000Z",
      }),
    ).toThrow(/does not match the schema/);
  });

  it("summarizes release-relevant event counts", () => {
    const summary = summarizeAdminControlPlaneTelemetry([
      {
        attributes: { code: "admin.cors_forbidden" },
        name: "admin.access.denied",
        statusCode: 403,
        timestamp: "2026-05-06T12:00:00.000Z",
      },
      {
        attributes: { code: "admin.cors_forbidden" },
        name: "admin.access.denied",
        statusCode: 403,
        timestamp: "2026-05-06T12:01:00.000Z",
      },
      {
        name: "admin.settings.updated",
        repoId: "repo_1",
        timestamp: "2026-05-06T12:02:00.000Z",
      },
      {
        attributes: {
          actionKind: "repo.settings.update",
          sourceEventName: "admin.settings.updated",
          status: "completed",
        },
        name: "admin.action.completed",
        repoId: "repo_1",
        timestamp: "2026-05-06T12:02:01.000Z",
      },
      {
        name: "admin.replay.dispatched",
        repoId: "repo_1",
        timestamp: "2026-05-06T12:03:00.000Z",
      },
    ]);

    expect(summary).toMatchObject({
      accessDeniedCount: 2,
      adminActionCompletedCount: 1,
      adminActionsByKind: { "repo.settings.update": 1 },
      failuresByCode: { "admin.cors_forbidden": 2 },
      replayDispatchCount: 1,
      settingsUpdateCount: 1,
      totalEvents: 5,
    });
  });
});
