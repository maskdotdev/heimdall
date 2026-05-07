import { describe, expect, it } from "vitest";
import {
  createMemoryObservabilitySink,
  createObservabilityResourceAttributes,
  loadObservabilityConfig,
  normalizeAdminControlPlaneTelemetryEvent,
  ObservabilityConfigValidationError,
  recordAdminControlPlaneTelemetryEvent,
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
