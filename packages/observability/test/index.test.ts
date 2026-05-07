import { describe, expect, it } from "vitest";
import {
  createMemoryObservabilitySink,
  createObservabilityResourceAttributes,
  createStructuredTelemetryLogger,
  DEFAULT_OBSERVABILITY_CONFIG,
  loadObservabilityConfig,
  normalizeAdminControlPlaneTelemetryEvent,
  ObservabilityConfigValidationError,
  recordAdminControlPlaneTelemetryEvent,
  renderStructuredTelemetryLogLine,
  sanitizeTelemetryAttributes,
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
