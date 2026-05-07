import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import {
  AdminDebugNotFoundError,
  type AdminDebugService,
  type AdminReplayAuditActor,
} from "@repo/admin-tools";
import type {
  Repository,
  RepositorySettings,
  UpdateRepositoryControlPlaneSettingsRequest,
} from "@repo/contracts";
import type { HeimdallDatabase } from "@repo/db";
import {
  createMemoryObservabilitySink,
  createMemoryTelemetrySpanSink,
  createTelemetryMetricRecorder,
  createTelemetrySpanRecorder,
  loadObservabilityConfig,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricPoint,
} from "@repo/observability";
import { buildReviewPolicySnapshot } from "@repo/rules";
import {
  createMemorySecurityEventSink,
  createSecurityEvent,
  type SecretsManager,
  signAdminIdentityAssertion,
} from "@repo/security";
import { WebhookAuthenticationError } from "@repo/webhook-ingestion";
import { describe, expect, it } from "vitest";
import {
  type AdminControlPlaneService,
  createApiApp,
  createPostgresSecurityEventSink,
  type ProductDashboardService,
  type ProductGitHubOAuthService,
  type ProductSessionService,
  resolveApiGitHubWebhookSecrets,
} from "./app";

type AdminRuleSummaryFixture = Awaited<
  ReturnType<AdminControlPlaneService["listRepositoryRules"]>
>[number];
type AdminUsageSummaryFixture = Awaited<ReturnType<AdminControlPlaneService["listUsageSummary"]>>;
type AdminSecurityEventFixture = Awaited<
  ReturnType<AdminControlPlaneService["listSecurityEvents"]>
>[number];
type ProductUsageSummaryFixture = Awaited<
  ReturnType<AdminControlPlaneService["getProductUsageSummary"]>
>;
type ProductUsageEventFixture = Awaited<
  ReturnType<AdminControlPlaneService["listProductUsageEvents"]>
>[number];
type ProductSessionFixture = NonNullable<Awaited<ReturnType<ProductSessionService["readSession"]>>>;
type AdminEntitlementSummaryFixture = Awaited<
  ReturnType<AdminControlPlaneService["getEntitlementSummary"]>
>;
type AdminBillingSummaryFixture = Awaited<
  ReturnType<AdminControlPlaneService["getBillingSummary"]>
>;
type AdminBillingMeterEventsFixture = Awaited<
  ReturnType<AdminControlPlaneService["listBillingMeterEvents"]>
>;
type AdminBillingReconciliationFixture = Awaited<
  ReturnType<AdminControlPlaneService["getBillingReconciliation"]>
>;
type AdminOrganizationFixture = Awaited<ReturnType<AdminControlPlaneService["getOrganization"]>>;
type AdminProviderInstallationFixture = Awaited<
  ReturnType<AdminControlPlaneService["getProviderInstallation"]>
>;
type AdminInstallationSyncRunFixture = Awaited<
  ReturnType<AdminControlPlaneService["enqueueInstallationSync"]>
>;
type AdminRepositoryJobRunFixture = Awaited<
  ReturnType<AdminControlPlaneService["enqueueRepositoryReindex"]>
>;
type AdminReviewArtifactFixture = Awaited<
  ReturnType<AdminControlPlaneService["listReviewArtifacts"]>
>[number];
type AdminReviewArtifactPayloadFixture = Awaited<
  ReturnType<AdminControlPlaneService["getReviewArtifactPayload"]>
>;
type AdminReviewArtifactDownloadUrlFixture = Awaited<
  ReturnType<AdminControlPlaneService["createReviewArtifactDownloadUrl"]>
>;
type AdminReviewMetricsFixture = Awaited<
  ReturnType<AdminControlPlaneService["getReviewMetricsSummary"]>
>;
type AdminReviewFindingFixture = Awaited<ReturnType<AdminControlPlaneService["getReviewFinding"]>>;
type AdminFindingOutcomeRecordFixture = Awaited<
  ReturnType<AdminControlPlaneService["recordFindingOutcome"]>
>;
type AdminFindingSuppressionFixture = Awaited<
  ReturnType<AdminControlPlaneService["suppressSimilarFinding"]>
>;
type AdminReviewRerunRunFixture = Awaited<
  ReturnType<AdminControlPlaneService["enqueueReviewRerun"]>
>;
type AdminMemoryFactFixture = Awaited<ReturnType<AdminControlPlaneService["getMemoryFact"]>>;
type AdminMemoryCandidateFixture = Awaited<
  ReturnType<AdminControlPlaneService["getMemoryCandidate"]>
>;
type AdminMemoryCandidateApprovalFixture = Awaited<
  ReturnType<AdminControlPlaneService["approveMemoryCandidate"]>
>;
type AdminMemoryCandidateRejectionFixture = Awaited<
  ReturnType<AdminControlPlaneService["rejectMemoryCandidate"]>
>;
type AdminBackgroundJobDebugFixture = Awaited<
  ReturnType<AdminDebugService["getBackgroundJobDebugDetails"]>
>;
type AdminBackgroundJobReplayPlanFixture = Awaited<
  ReturnType<AdminDebugService["createBackgroundJobReplayPlan"]>
>;
type AdminReplayExecutionFixture = Awaited<
  ReturnType<AdminDebugService["executeBackgroundJobReplay"]>
>;
type AdminReviewDebugFixture = Awaited<ReturnType<AdminDebugService["getReviewDebugDetails"]>>;
type AdminDebugBundleFixture = Awaited<ReturnType<AdminDebugService["exportReviewRunDebugBundle"]>>;
type AdminEvalImportDraftFixture = Awaited<
  ReturnType<AdminDebugService["createReviewRunEvalImportDraft"]>
>;
type AdminEvaluationSuiteFixture = Awaited<
  ReturnType<AdminControlPlaneService["listEvaluationSuites"]>
>[number];
type AdminEvaluationRunFixture = Awaited<
  ReturnType<AdminControlPlaneService["listEvaluationRuns"]>
>[number];
type AdminEvaluationRunDetailsFixture = Awaited<
  ReturnType<AdminControlPlaneService["getEvaluationRun"]>
>;
type AdminMemoryRulesDebugFixture = Awaited<
  ReturnType<AdminDebugService["getMemoryRulesDebugDetails"]>
>;
type AdminValidationReplayDryRunFixture = Awaited<
  ReturnType<AdminDebugService["replayValidationDryRun"]>
>;
type AdminRetrievalReplayDryRunFixture = Awaited<
  ReturnType<AdminDebugService["replayRetrievalDryRun"]>
>;

/** Allowed admin dashboard origin used by API route tests. */
const adminOrigin = "http://localhost:3001";
/** Support-session header used by privileged admin route tests. */
const SUPPORT_SESSION_HEADER_FIXTURE = "x-heimdall-support-session-id";
/** Valid support-session ID used by privileged admin route tests. */
const SUPPORT_SESSION_ID_FIXTURE = "supp_12345678";

describe("api app", () => {
  const auth = {
    allowedOrigins: [adminOrigin],
    assertionSecret: "assertion-secret-with-at-least-32-chars",
    cookieName: "test_admin_session",
    enabled: true,
    identityProvider: "oidc" as const,
    routeExposure: "public" as const,
    secureCookies: false,
    sessionSecret: "session-secret-with-at-least-32-chars",
  };
  const productAuth = {
    enabled: true,
    secureCookies: false,
    sessionPepper: "product-session-pepper-with-at-least-32-chars",
  };

  it("maps security events into durable Postgres rows", () => {
    const insertedRows: unknown[] = [];
    const db = {
      insert: () => ({
        values: (row: unknown) => {
          insertedRows.push(row);
          return { onConflictDoNothing: () => Promise.resolve() };
        },
      }),
    } as unknown as HeimdallDatabase;
    const sink = createPostgresSecurityEventSink({ db });

    sink.record(
      createSecurityEvent({
        actorId: "oidc:usr_support",
        createdAt: "2026-05-07T12:00:00.000Z",
        id: "secevt_test",
        metadata: {
          denialReason: "admin.scope_forbidden",
          statusCode: 403,
        },
        orgId: "org_1",
        repoId: "repo_1",
        resourceId: "repo_1",
        resourceType: "repository",
        source: "api",
        type: "cross_tenant_access_attempt",
      }),
    );

    expect(insertedRows).toEqual([
      expect.objectContaining({
        actorId: "oidc:usr_support",
        createdAt: new Date("2026-05-07T12:00:00.000Z"),
        metadata: expect.objectContaining({
          denialReason: "admin.scope_forbidden",
          statusCode: 403,
        }),
        orgId: "org_1",
        repoId: "repo_1",
        resourceId: "repo_1",
        resourceType: "repository",
        securityEventId: "secevt_test",
        severity: "critical",
        source: "api",
        status: "new",
        type: "cross_tenant_access_attempt",
        updatedAt: new Date("2026-05-07T12:00:00.000Z"),
      }),
    ]);
  });

  it("resolves GitHub webhook secrets through SecretRef configuration", async () => {
    await expect(
      resolveApiGitHubWebhookSecrets({
        CURRENT_WEBHOOK_SECRET: "current-webhook-secret",
        GITHUB_PREVIOUS_WEBHOOK_SECRET: "previous-webhook-secret",
        GITHUB_WEBHOOK_SECRET_REF: "env:CURRENT_WEBHOOK_SECRET",
      }),
    ).resolves.toEqual({
      current: "current-webhook-secret",
      previous: "previous-webhook-secret",
    });
    await expect(
      resolveApiGitHubWebhookSecrets({
        GITHUB_WEBHOOK_SECRET_REF: "aws:prod/github-app/webhook-secret",
      }),
    ).rejects.toMatchObject({
      code: "secret_provider_unsupported",
    });
  });

  it("resolves GitHub webhook route secrets before signature verification", async () => {
    const resolvedRefs: string[] = [];
    const secretsManager: SecretsManager = {
      resolveSecret: async (ref, context) => {
        resolvedRefs.push(`${ref.provider}:${ref.name}:${context?.purpose}:${context?.service}`);
        return {
          ref,
          resolvedAt: "2026-05-07T12:00:00.000Z",
          value: "route-webhook-secret",
        };
      },
    };
    const app = createApiApp({
      databaseClient: { db: {} as HeimdallDatabase } as never,
      secretEnvironment: {
        GITHUB_WEBHOOK_SECRET_REF: "env:ROUTE_WEBHOOK_SECRET",
      },
      secretsManager,
    });
    const rawBody = new TextEncoder().encode("{}");

    const response = await app.handle(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body: rawBody,
        headers: {
          "x-github-delivery": "delivery-secret-ref",
          "x-github-event": "pull_request",
          "x-hub-signature-256": githubWebhookSignature("wrong-secret", rawBody),
        },
      }),
    );

    expect(response.status).toBe(401);
    expect(resolvedRefs).toEqual(["env:ROUTE_WEBHOOK_SECRET:github_webhook_secret:api"]);
  });

  it("wires the GitHub webhook route to the handler", async () => {
    const app = createApiApp({
      githubWebhookHandler: {
        handle: async () => ({
          status: "accepted",
          deliveryId: "delivery-1",
          webhookEventId: "webhook_test",
          jobs: [],
        }),
      } as never,
    });

    const response = await app.handle(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "accepted",
      deliveryId: "delivery-1",
    });
  });

  it("records GitHub webhook delivery metrics and spans", async () => {
    const config = loadObservabilityConfig({
      OBSERVABILITY_ENABLED: "true",
      OBSERVABILITY_EXPORTER: "console",
      OBSERVABILITY_SERVICE_NAME: "code-review-api",
    });
    const metricPoints: TelemetryMetricPoint[] = [];
    const spanSink = createMemoryTelemetrySpanSink();
    const app = createApiApp({
      githubWebhookHandler: {
        handle: async () => ({
          deliveryId: "delivery-telemetry",
          jobs: [],
          status: "accepted",
          webhookEventId: "webhook_telemetry",
        }),
      } as never,
      metrics: createTelemetryMetricRecorder(config, {
        write: (point) => {
          metricPoints.push(point);
        },
      }),
      traces: createTelemetrySpanRecorder(config, spanSink),
    });

    const response = await app.handle(
      new Request("http://localhost/webhooks/github", {
        body: JSON.stringify({ action: "opened" }),
        headers: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          "x-github-event": "pull_request",
          "x-request-id": "req_webhook_telemetry",
        },
        method: "POST",
      }),
    );

    const deliveryCount = metricPoints.find(
      (point) => point.name === OBSERVABILITY_METRIC_NAMES.webhookDeliveriesTotal,
    );
    const deliveryDuration = metricPoints.find(
      (point) => point.name === OBSERVABILITY_METRIC_NAMES.webhookDeliveryDurationMs,
    );
    const webhookSpan = spanSink
      .spans()
      .find((span) => span.name === OBSERVABILITY_SPAN_NAMES.webhookDelivery);

    expect(response.status).toBe(202);
    expect(deliveryCount).toMatchObject({
      kind: "counter",
      labels: {
        action: "opened",
        event_name: "pull_request",
        provider: "github",
        status: "accepted",
      },
      value: 1,
    });
    expect(deliveryDuration).toMatchObject({
      kind: "histogram",
      labels: deliveryCount?.labels,
      unit: "ms",
    });
    expect(deliveryDuration?.value).toBeGreaterThanOrEqual(0);
    expect(webhookSpan).toMatchObject({
      attributes: expect.objectContaining({
        action: "opened",
        event_name: "pull_request",
        provider: "github",
        status: "accepted",
      }),
      kind: "server",
      status: "ok",
      traceContext: {
        requestId: "req_webhook_telemetry",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    });
  });

  it("records GitHub webhook rejection metrics", async () => {
    const config = loadObservabilityConfig({
      OBSERVABILITY_ENABLED: "true",
      OBSERVABILITY_EXPORTER: "console",
      OBSERVABILITY_SERVICE_NAME: "code-review-api",
    });
    const metricPoints: TelemetryMetricPoint[] = [];
    const app = createApiApp({
      githubWebhookHandler: {
        handle: async () => {
          throw new WebhookAuthenticationError("GitHub webhook signature verification failed.");
        },
      } as never,
      metrics: createTelemetryMetricRecorder(config, {
        write: (point) => {
          metricPoints.push(point);
        },
      }),
    });

    const response = await app.handle(
      new Request("http://localhost/webhooks/github", {
        body: JSON.stringify({ action: "opened" }),
        headers: {
          "x-github-event": "pull_request",
        },
        method: "POST",
      }),
    );

    const rejectionCount = metricPoints.find(
      (point) => point.name === OBSERVABILITY_METRIC_NAMES.webhookRejectionsTotal,
    );

    expect(response.status).toBe(401);
    expect(rejectionCount).toMatchObject({
      kind: "counter",
      labels: {
        provider: "github",
        reason: "invalid_signature",
      },
      value: 1,
    });
  });

  it("exposes liveness without touching external dependencies", async () => {
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
    });

    const response = await app.handle(new Request("http://localhost/livez"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      checks: [{ name: "process", status: "pass" }],
      ok: true,
      service: "api",
      status: "pass",
    });
  });

  it("returns readiness success when injected checks pass", async () => {
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      readinessCheck: async () => [
        { name: "config", status: "pass" },
        { name: "postgres", status: "pass" },
      ],
    });

    const response = await app.handle(new Request("http://localhost/readyz"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      checks: [
        { name: "config", status: "pass" },
        { name: "postgres", status: "pass" },
      ],
      ok: true,
      service: "api",
      status: "pass",
    });
  });

  it("records product-safe API request metrics and spans", async () => {
    const config = loadObservabilityConfig({
      OBSERVABILITY_ENABLED: "true",
      OBSERVABILITY_EXPORTER: "console",
      OBSERVABILITY_SERVICE_NAME: "code-review-api",
    });
    const metricPoints: TelemetryMetricPoint[] = [];
    const spanSink = createMemoryTelemetrySpanSink();
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      metrics: createTelemetryMetricRecorder(config, {
        write: (point) => {
          metricPoints.push(point);
        },
      }),
      readinessCheck: async () => [{ name: "config", status: "pass" }],
      traces: createTelemetrySpanRecorder(config, spanSink),
    });

    const response = await app.handle(
      new Request("http://localhost/readyz", {
        headers: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          "x-request-id": "req_api_telemetry",
        },
      }),
    );

    const requestCount = metricPoints.find(
      (point) => point.name === OBSERVABILITY_METRIC_NAMES.apiRequestsTotal,
    );
    const requestDuration = metricPoints.find(
      (point) => point.name === OBSERVABILITY_METRIC_NAMES.apiRequestDurationMs,
    );

    expect(response.status).toBe(200);
    expect(requestCount).toMatchObject({
      kind: "counter",
      labels: {
        "http.request.method": "GET",
        "http.response.status_code": 200,
        "http.route": "/readyz",
        "http.status_family": "2xx",
      },
      value: 1,
    });
    expect(requestDuration).toMatchObject({
      kind: "histogram",
      labels: requestCount?.labels,
      unit: "ms",
    });
    expect(requestDuration?.value).toBeGreaterThanOrEqual(0);
    expect(spanSink.spans()).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          "http.request.method": "GET",
          "http.response.status_code": 200,
          "http.route": "/readyz",
          "http.status_family": "2xx",
        }),
        kind: "server",
        name: OBSERVABILITY_SPAN_NAMES.apiRequest,
        status: "ok",
        traceContext: {
          requestId: "req_api_telemetry",
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      }),
    ]);
  });

  it("returns readiness failure without leaking dependency details", async () => {
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      readinessCheck: async () => [
        {
          message: "Postgres is unavailable.",
          name: "postgres",
          status: "fail",
        },
      ],
    });

    const response = await app.handle(new Request("http://localhost/readyz"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: [
        {
          message: "Postgres is unavailable.",
          name: "postgres",
          status: "fail",
        },
      ],
      ok: false,
      service: "api",
      status: "fail",
    });
  });

  it("exposes OpenAPI JSON outside production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousOpenApiEnabled = process.env.HEIMDALL_OPENAPI_ENABLED;
    process.env.NODE_ENV = "development";
    delete process.env.HEIMDALL_OPENAPI_ENABLED;
    try {
      const app = createApiApp({
        githubWebhookHandler: noopWebhookHandler(),
      });

      const response = await app.handle(new Request("http://localhost/openapi/json"));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        info: { title: "Heimdall API", version: "1.0.0" },
        openapi: expect.any(String),
      });
      expect(body.paths).toHaveProperty("/api/v1/orgs");
      expect(body.paths).toHaveProperty("/api/v1/orgs/{orgId}/usage/summary");
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousOpenApiEnabled === undefined) {
        delete process.env.HEIMDALL_OPENAPI_ENABLED;
      } else {
        process.env.HEIMDALL_OPENAPI_ENABLED = previousOpenApiEnabled;
      }
    }
  });

  it("keeps OpenAPI disabled by default in production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousOpenApiEnabled = process.env.HEIMDALL_OPENAPI_ENABLED;
    process.env.NODE_ENV = "production";
    delete process.env.HEIMDALL_OPENAPI_ENABLED;
    try {
      const app = createApiApp({
        githubWebhookHandler: noopWebhookHandler(),
      });

      const response = await app.handle(new Request("http://localhost/openapi/json"));

      expect(response.status).toBe(404);
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousOpenApiEnabled === undefined) {
        delete process.env.HEIMDALL_OPENAPI_ENABLED;
      } else {
        process.env.HEIMDALL_OPENAPI_ENABLED = previousOpenApiEnabled;
      }
    }
  });

  it("wires the Stripe webhook route to the billing webhook processor", async () => {
    const rawBodies: string[] = [];
    const app = createApiApp({
      billingWebhookProcessor: {
        processStripeWebhook: async (input) => {
          rawBodies.push(Buffer.from(input.rawBody).toString("utf8"));
          return {
            duplicate: false,
            eventType: "customer.subscription.updated",
            provider: "stripe",
            providerEventId: "evt_stripe_123",
            status: "processed",
          };
        },
      },
      githubWebhookHandler: noopWebhookHandler(),
    });

    const response = await app.handle(
      new Request("http://localhost/webhooks/stripe", {
        body: JSON.stringify({ id: "evt_stripe_123" }),
        headers: { "stripe-signature": "test_signature" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    expect(rawBodies).toEqual(['{"id":"evt_stripe_123"}']);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        eventType: "customer.subscription.updated",
        providerEventId: "evt_stripe_123",
        status: "processed",
      },
    });
  });

  it("serves product onboarding without an admin session", async () => {
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      productDashboardService: createMockProductDashboardService(),
    });

    const response = await app.handle(new Request("http://localhost/app/onboarding"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        githubApp: {
          configured: true,
          installUrl: "https://github.com/apps/heimdall-dev/installations/new",
          webhookConfigured: true,
        },
        installations: [{ accountLogin: "octo-org" }],
        recentReviews: [{ repoFullName: "octo-org/heimdall" }],
        repositories: [{ fullName: "octo-org/heimdall" }],
        webhook: {
          latestEventName: "pull_request",
          totalDeliveries: 3,
        },
      },
    });
  });

  it("serves the authenticated product user from a product session", async () => {
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService(),
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/me", {
        headers: { cookie: "car_session=opaque" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        installations: [
          {
            accountLogin: "octo-org",
            installationId: "inst_1",
            orgId: "org_1",
            provider: "github",
          },
        ],
        memberships: [
          {
            capabilities: {
              canManageRepositorySettings: true,
              canReadUsage: true,
            },
            orgId: "org_1",
            permissions: expect.arrayContaining(["repo:settings:write", "usage:read"]),
            role: "admin",
          },
        ],
        selectedOrgId: "org_1",
        session: {
          sessionId: "sess_product",
        },
        user: {
          primaryEmail: "owner@example.com",
          userId: "usr_1",
        },
      },
    });
  });

  it("serves scoped API v1 resources from product sessions", async () => {
    const listOrgQueries: Parameters<AdminControlPlaneService["listOrganizations"]>[0][] = [];
    const listRepositoryQueries: Parameters<AdminControlPlaneService["listRepositories"]>[0][] = [];
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({
        listOrganizations: async (query) => {
          listOrgQueries.push(query);
          return [organizationFixture()];
        },
        listRepositories: async (query) => {
          listRepositoryQueries.push(query);
          return [repositoryFixture];
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService(),
    });

    const orgsResponse = await app.handle(
      new Request("http://localhost/api/v1/orgs?search=octo&limit=5", {
        headers: { cookie: "car_session=opaque" },
      }),
    );
    const repositoriesResponse = await app.handle(
      new Request("http://localhost/api/v1/orgs/org_1/repositories?search=heimdall&limit=5", {
        headers: { cookie: "car_session=opaque" },
      }),
    );
    const memoryResponse = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/memory?candidateStatus=pending", {
        headers: { cookie: "car_session=opaque" },
      }),
    );

    expect(orgsResponse.status).toBe(200);
    expect(repositoriesResponse.status).toBe(200);
    expect(memoryResponse.status).toBe(200);
    await expect(orgsResponse.json()).resolves.toMatchObject({
      data: { orgs: [{ orgId: "org_1", slug: "octo-org" }] },
    });
    await expect(repositoriesResponse.json()).resolves.toMatchObject({
      data: { repositories: [{ fullName: "octo-org/heimdall", repoId: "repo_1" }] },
    });
    await expect(memoryResponse.json()).resolves.toMatchObject({
      data: {
        memoryCandidates: [{ memoryCandidateId: "mcand_1", status: "pending" }],
        memoryFacts: [{ memoryFactId: "mem_1" }],
      },
    });
    expect(listOrgQueries).toEqual([
      expect.objectContaining({ limit: 5, orgIds: ["org_1"], search: "octo" }),
    ]);
    expect(listRepositoryQueries).toEqual([
      expect.objectContaining({ limit: 5, orgIds: ["org_1"], search: "heimdall" }),
    ]);
  });

  it("rejects product API mutations when the product role lacks permission", async () => {
    let updateCalled = false;
    const viewerSession = productSessionFixture({
      actor: {
        memberships: [{ orgId: "org_1", role: "viewer" }],
        selectedOrgId: "org_1",
        userId: "usr_1",
      },
    });
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({
        getRepositorySettings: async () => ({
          repository: repositoryFixture,
          settings: settingsFixture,
        }),
        updateRepositorySettings: async () => {
          updateCalled = true;
          return {
            repository: repositoryFixture,
            settings: settingsFixture,
          };
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService({
        readSession: async () => viewerSession,
      }),
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/enable", {
        headers: { cookie: "car_session=opaque", "idempotency-key": "idem_repo" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    expect(updateCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "product_auth.forbidden" },
    });
  });

  it("serves product repository rules and policy previews", async () => {
    const calls: string[] = [];
    let observedPatch: UpdateRepositoryControlPlaneSettingsRequest | undefined;
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({
        createRepositoryRule: async (_repoId, request) => {
          calls.push(`create:${request.effect}:${request.name}`);
          return repoRuleSummaryFixture({
            body: request.instruction,
            effect: request.effect,
            instruction: request.instruction,
            name: request.name,
          });
        },
        deleteRepositoryRule: async (_repoId, ruleId) => {
          calls.push(`delete:${ruleId}`);
          return repoRuleSummaryFixture({ repoRuleId: ruleId, ruleId });
        },
        listRepositoryRules: async (repoId) => [
          repoRuleSummaryFixture({
            body: "Use stable public APIs.",
            instruction: "Use stable public APIs.",
            repoId,
          }),
        ],
        previewRepositoryPolicy: async (_repoId, patch) => {
          observedPatch = patch;
          const result = buildReviewPolicySnapshot({
            repository: repositoryFixture,
            settings: {
              ...settingsFixture,
              ...patch,
              maxCommentsPerReview:
                patch.maxCommentsPerReview ?? settingsFixture.maxCommentsPerReview,
              reviewPolicy: patch.reviewPolicy ?? settingsFixture.reviewPolicy,
            },
          });
          return {
            effectivePolicy: result.snapshot.effectivePolicy,
            policyHash: "sha256:product-preview",
            policySnapshotId: "pol_product_preview",
            trace: result.trace,
            warnings: result.warnings,
          };
        },
        testRepositoryPolicy: async (_repoId, request) => {
          calls.push(`test:${request.finding.location.path}`);
          const result = buildReviewPolicySnapshot({
            repository: repositoryFixture,
            settings: settingsFixture,
          });
          return {
            findingDecision: {
              reasonCode: "suppressed_by_repo_rule",
              severity: request.finding.severity,
              shouldPublish: false,
              trace: result.trace,
            },
            pathClassification: {
              config: false,
              documentation: false,
              generated: true,
              ignored: false,
              included: true,
              matchedPatterns: ["**/generated/**"],
              path: request.finding.location.path,
              reasonCodes: ["path_included", "generated_path"],
              test: false,
              trace: result.trace,
              vendored: false,
            },
            preview: {
              effectivePolicy: result.snapshot.effectivePolicy,
              policyHash: "sha256:product-test",
              policySnapshotId: "pol_product_test",
              trace: result.trace,
              warnings: result.warnings,
            },
          };
        },
        updateRepositoryRule: async (_repoId, ruleId, request) => {
          calls.push(`update:${ruleId}:${request.enabled}`);
          return repoRuleSummaryFixture({
            enabled: request.enabled ?? true,
            repoRuleId: ruleId,
            ruleId,
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService(),
    });
    const productHeaders = { cookie: "car_session=opaque", "content-type": "application/json" };

    const listResponse = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/rules", {
        headers: productHeaders,
      }),
    );
    const previewResponse = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/policy-preview", {
        body: JSON.stringify({
          maxCommentsPerReview: 4,
          reviewPolicy: "summary_only",
          sandboxPolicy: { defaultRunner: "gvisor", maxTimeoutMs: 90_000 },
        }),
        headers: productHeaders,
        method: "POST",
      }),
    );
    const createResponse = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/rules", {
        body: JSON.stringify({
          enabled: true,
          effect: "context",
          instruction: "Prefer stable public APIs.",
          matcher: { paths: ["src/api/**"] },
          name: "Public API guidance",
          priority: 200,
        }),
        headers: productHeaders,
        method: "POST",
      }),
    );
    const testResponse = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/policy-test", {
        body: JSON.stringify({
          finding: {
            body: "Generated client docs are intentionally omitted.",
            category: "documentation",
            confidence: 0.87,
            location: {
              isInDiff: true,
              line: 12,
              path: "src/generated/client.ts",
              side: "RIGHT",
            },
            severity: "medium",
            title: "Generated client method is missing docs",
          },
        }),
        headers: productHeaders,
        method: "POST",
      }),
    );
    const updateResponse = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/rules/rule_1", {
        body: JSON.stringify({ enabled: false }),
        headers: productHeaders,
        method: "PATCH",
      }),
    );
    const deleteResponse = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/rules/rule_1", {
        headers: productHeaders,
        method: "DELETE",
      }),
    );

    expect(listResponse.status).toBe(200);
    expect(previewResponse.status).toBe(200);
    expect(createResponse.status).toBe(201);
    expect(testResponse.status).toBe(200);
    expect(updateResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(observedPatch).toEqual({
      maxCommentsPerReview: 4,
      reviewPolicy: "summary_only",
      sandboxPolicy: { defaultRunner: "gvisor", maxTimeoutMs: 90_000 },
    });
    expect(calls).toEqual([
      "create:context:Public API guidance",
      "test:src/generated/client.ts",
      "update:rule_1:false",
      "delete:rule_1",
    ]);
    await expect(listResponse.json()).resolves.toMatchObject({
      data: { rules: [{ body: "Use stable public APIs.", repoRuleId: "rule_1" }] },
    });
    await expect(previewResponse.json()).resolves.toMatchObject({
      data: {
        effectivePolicy: { reviewPolicy: "summary_only", sandbox: { defaultRunner: "gvisor" } },
        policyHash: "sha256:product-preview",
      },
    });
    await expect(testResponse.json()).resolves.toMatchObject({
      data: {
        findingDecision: { reasonCode: "suppressed_by_repo_rule", shouldPublish: false },
        pathClassification: { generated: true, path: "src/generated/client.ts" },
        preview: { policyHash: "sha256:product-test" },
      },
    });
  });

  it("rejects product repository rule writes when the role lacks permission", async () => {
    let createCalled = false;
    const viewerSession = productSessionFixture({
      actor: {
        memberships: [{ orgId: "org_1", role: "viewer" }],
        selectedOrgId: "org_1",
        userId: "usr_1",
      },
    });
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({
        createRepositoryRule: async () => {
          createCalled = true;
          return repoRuleSummaryFixture();
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService({
        readSession: async () => viewerSession,
      }),
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/rules", {
        body: JSON.stringify({
          effect: "suppress",
          instruction: "Skip generated findings.",
          matcher: { paths: ["src/generated/**"] },
          name: "Suppress generated files",
        }),
        headers: { cookie: "car_session=opaque", "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    expect(createCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "product_auth.forbidden" },
    });
  });

  it("serves product review details and records finding outcomes", async () => {
    const artifactReviewRunIds: string[] = [];
    const outcomeRequests: Parameters<AdminControlPlaneService["recordFindingOutcome"]>[1][] = [];
    const rerunRequests: Parameters<AdminControlPlaneService["enqueueReviewRerun"]>[1][] = [];
    const suppressionRequests: Parameters<AdminControlPlaneService["suppressSimilarFinding"]>[1][] =
      [];
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({
        enqueueReviewRerun: async (_reviewRunId, request) => {
          rerunRequests.push(request);
          return reviewRerunRunFixture({
            jobKey: "api:review:rerun:rrn_1:idem_rerun",
          });
        },
        getReviewFinding: async () => reviewFindingFixture(),
        getReviewRun: async () => ({
          ...reviewRunSummaryFixture,
          relatedJobs: [
            {
              attempts: 3,
              backgroundJobId: "job_review_failed",
              createdAt: "2026-05-05T12:00:00.000Z",
              failure: {
                code: "github.rate_limited",
                message: "GitHub rate limit exceeded.",
                retryable: true,
                source: "background_job",
              },
              jobKey: "api:review:rerun:rrn_1:idem_rerun",
              jobType: "pr.review.v1",
              maxAttempts: 3,
              queueName: "review",
              repoId: "repo_1",
              reviewRunId: "rrn_1",
              status: "failed",
              updatedAt: "2026-05-05T12:20:00.000Z",
            },
          ],
        }),
        listReviewArtifacts: async (reviewRunId) => {
          artifactReviewRunIds.push(reviewRunId);
          return [
            reviewArtifactFixture({
              hasStoredPayload: true,
              metadataKeys: ["payload", "policyHash"],
            }),
          ];
        },
        listReviewFindings: async () => [reviewFindingFixture()],
        recordFindingOutcome: async (_findingId, request) => {
          outcomeRequests.push(request);
          return findingOutcomeRecordFixture({
            outcome: findingOutcomeFixture({ outcome: request.outcome, source: request.source }),
          });
        },
        suppressSimilarFinding: async (_findingId, request) => {
          suppressionRequests.push(request);
          return findingSuppressionFixture({
            scope: request.scope,
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService(),
    });
    const productHeaders = { cookie: "car_session=opaque", "content-type": "application/json" };

    const reviewResponse = await app.handle(
      new Request("http://localhost/api/v1/review-runs/rrn_1", {
        headers: productHeaders,
      }),
    );
    const findingsResponse = await app.handle(
      new Request("http://localhost/api/v1/review-runs/rrn_1/findings", {
        headers: productHeaders,
      }),
    );
    const artifactsResponse = await app.handle(
      new Request("http://localhost/api/v1/review-runs/rrn_1/artifacts", {
        headers: productHeaders,
      }),
    );
    const findingResponse = await app.handle(
      new Request("http://localhost/api/v1/findings/fnd_validated_1", {
        headers: productHeaders,
      }),
    );
    const outcomeResponse = await app.handle(
      new Request("http://localhost/api/v1/findings/fnd_validated_1/outcome", {
        body: JSON.stringify({ notes: "Resolved by the author.", outcome: "resolved" }),
        headers: { ...productHeaders, "idempotency-key": "idem_outcome" },
        method: "PATCH",
      }),
    );
    const suppressionResponse = await app.handle(
      new Request("http://localhost/api/v1/findings/fnd_validated_1/suppress-similar", {
        body: JSON.stringify({
          expiresAt: "2026-06-05T12:00:00.000Z",
          reason: "Repeated false positive for generated provider code.",
          scope: "repo",
        }),
        headers: { ...productHeaders, "idempotency-key": "idem_suppress" },
        method: "POST",
      }),
    );
    const rerunResponse = await app.handle(
      new Request("http://localhost/api/v1/review-runs/rrn_1/rerun", {
        headers: { ...productHeaders, "idempotency-key": "idem_rerun" },
        method: "POST",
      }),
    );

    expect(reviewResponse.status).toBe(200);
    expect(findingsResponse.status).toBe(200);
    expect(artifactsResponse.status).toBe(200);
    expect(findingResponse.status).toBe(200);
    expect(outcomeResponse.status).toBe(200);
    expect(suppressionResponse.status).toBe(201);
    expect(rerunResponse.status).toBe(202);
    expect(artifactReviewRunIds).toEqual(["rrn_1"]);
    expect(outcomeRequests).toEqual([
      expect.objectContaining({
        idempotencyKey: "idem_outcome",
        notes: "Resolved by the author.",
        outcome: "resolved",
        source: "user_action",
      }),
    ]);
    expect(rerunRequests).toEqual([
      expect.objectContaining({
        idempotencyKey: "idem_rerun",
      }),
    ]);
    expect(suppressionRequests).toEqual([
      expect.objectContaining({
        expiresAt: "2026-06-05T12:00:00.000Z",
        idempotencyKey: "idem_suppress",
        reason: "Repeated false positive for generated provider code.",
        scope: "repo",
      }),
    ]);
    await expect(reviewResponse.json()).resolves.toMatchObject({
      data: {
        reviewRun: {
          relatedJobs: [
            {
              backgroundJobId: "job_review_failed",
              failure: { code: "github.rate_limited" },
              status: "failed",
            },
          ],
          reviewRunId: "rrn_1",
        },
      },
    });
    await expect(findingsResponse.json()).resolves.toMatchObject({
      data: { findings: [{ findingId: "fnd_validated_1" }] },
    });
    await expect(artifactsResponse.json()).resolves.toMatchObject({
      data: {
        artifacts: [
          {
            classification: "customer_confidential",
            hasStoredPayload: true,
            metadataKeys: ["payload", "policyHash"],
            reviewArtifactId: "art_1",
          },
        ],
        reviewRun: { reviewRunId: "rrn_1" },
      },
    });
    await expect(suppressionResponse.json()).resolves.toMatchObject({
      data: {
        rule: {
          effect: "suppress",
          name: "Suppress similar: Provider retry loop is unbounded",
        },
        scope: "repo",
      },
    });
  });

  it("rejects product artifact metadata reads when the role lacks debug permission", async () => {
    let listArtifactsCalled = false;
    const viewerSession = productSessionFixture({
      actor: {
        memberships: [{ orgId: "org_1", role: "viewer" }],
        selectedOrgId: "org_1",
        userId: "usr_1",
      },
    });
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({
        getReviewRun: async () => reviewRunSummaryFixture,
        listReviewArtifacts: async () => {
          listArtifactsCalled = true;
          return [reviewArtifactFixture()];
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService({
        readSession: async () => viewerSession,
      }),
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/review-runs/rrn_1/artifacts", {
        headers: { cookie: "car_session=opaque" },
      }),
    );

    expect(response.status).toBe(403);
    expect(listArtifactsCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "product_auth.forbidden" },
    });
  });

  it("serves audited redacted product artifact payload reads", async () => {
    const payloadRequests: Parameters<AdminControlPlaneService["getReviewArtifactPayload"]>[2][] =
      [];
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({
        getReviewRun: async () => reviewRunSummaryFixture,
        getReviewArtifactPayload: async (_reviewRunId, _artifactId, request) => {
          payloadRequests.push(request);
          return reviewArtifactPayloadFixture();
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService(),
    });

    const response = await app.handle(
      new Request(
        "http://localhost/api/v1/review-runs/rrn_1/artifacts/art_1/payload?reason=Investigate%20failed%20review",
        {
          headers: {
            cookie: "car_session=opaque",
            "user-agent": "vitest",
            "x-forwarded-for": "203.0.113.10, 10.0.0.2",
          },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payloadRequests).toEqual([
      expect.objectContaining({
        accessLevel: "redacted",
        ipAddress: "203.0.113.10",
        reason: "Investigate failed review",
        userAgent: "vitest",
      }),
    ]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        accessLevel: "redacted",
        artifact: { reviewArtifactId: "art_1" },
        artifactAccessEventId: "artaccess_1",
        reviewRun: { reviewRunId: "rrn_1" },
      },
    });
  });

  it("downloads audited redacted product artifact payloads", async () => {
    const payloadRequests: Parameters<AdminControlPlaneService["getReviewArtifactPayload"]>[2][] =
      [];
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({
        getReviewRun: async () => reviewRunSummaryFixture,
        getReviewArtifactPayload: async (_reviewRunId, _artifactId, request) => {
          payloadRequests.push(request);
          return reviewArtifactPayloadFixture({
            artifact: reviewArtifactFixture({
              hasStoredPayload: true,
              metadataKeys: ["payload"],
              name: "provider prompt.json",
            }),
            payload: { redacted: true },
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService(),
    });

    const response = await app.handle(
      new Request(
        "http://localhost/api/v1/review-runs/rrn_1/artifacts/art_1/download?reason=Download%20for%20incident",
        {
          headers: { cookie: "car_session=opaque" },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="provider-prompt.json"',
    );
    expect(payloadRequests).toEqual([
      expect.objectContaining({
        accessLevel: "redacted",
        reason: "Download for incident",
      }),
    ]);
    await expect(response.text()).resolves.toContain('"redacted": true');
  });

  it("requires reasons before reading product artifact payloads", async () => {
    let payloadRead = false;
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({
        getReviewRun: async () => reviewRunSummaryFixture,
        getReviewArtifactPayload: async () => {
          payloadRead = true;
          return reviewArtifactPayloadFixture();
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService(),
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/review-runs/rrn_1/artifacts/art_1/payload", {
        headers: { cookie: "car_session=opaque" },
      }),
    );

    expect(response.status).toBe(400);
    expect(payloadRead).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "artifact.reason_required" },
    });
  });

  it("blocks raw artifact payload reads without admin support access", async () => {
    let payloadRead = false;
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({
        getReviewRun: async () => reviewRunSummaryFixture,
        getReviewArtifactPayload: async () => {
          payloadRead = true;
          return reviewArtifactPayloadFixture({ accessLevel: "raw_allowed" });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService(),
    });

    const response = await app.handle(
      new Request(
        "http://localhost/api/v1/review-runs/rrn_1/artifacts/art_1/payload?reason=Raw%20debug&accessLevel=raw_allowed",
        {
          headers: { cookie: "car_session=opaque" },
        },
      ),
    );

    expect(response.status).toBe(403);
    expect(payloadRead).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.support_session_required" },
    });
  });

  it("allows admin support sessions to read raw artifact payloads", async () => {
    const payloadRequests: Parameters<AdminControlPlaneService["getReviewArtifactPayload"]>[2][] =
      [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getReviewRun: async () => reviewRunSummaryFixture,
        getReviewArtifactPayload: async (_reviewRunId, _artifactId, request) => {
          payloadRequests.push(request);
          return reviewArtifactPayloadFixture({
            accessLevel: "raw_allowed",
            payload: { raw: "provider prompt" },
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request(
        "http://localhost/api/v1/review-runs/rrn_1/artifacts/art_1/payload?reason=Support%20ticket&accessLevel=raw_allowed",
        {
          headers: {
            cookie: login.cookie,
            [SUPPORT_SESSION_HEADER_FIXTURE]: SUPPORT_SESSION_ID_FIXTURE,
          },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(payloadRequests).toEqual([
      expect.objectContaining({
        accessLevel: "raw_allowed",
        supportSessionId: SUPPORT_SESSION_ID_FIXTURE,
      }),
    ]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        accessLevel: "raw_allowed",
        payload: { raw: "provider prompt" },
      },
    });
  });

  it("creates audited raw signed artifact download URLs for admin support sessions", async () => {
    const urlRequests: Parameters<
      AdminControlPlaneService["createReviewArtifactDownloadUrl"]
    >[2][] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        createReviewArtifactDownloadUrl: async (_reviewRunId, _artifactId, request) => {
          urlRequests.push(request);
          return reviewArtifactDownloadUrlFixture();
        },
        getReviewRun: async () => reviewRunSummaryFixture,
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request(
        "http://localhost/api/v1/review-runs/rrn_1/artifacts/art_1/download-url?reason=Support%20download&accessLevel=raw_allowed",
        {
          headers: {
            cookie: login.cookie,
            [SUPPORT_SESSION_HEADER_FIXTURE]: SUPPORT_SESSION_ID_FIXTURE,
          },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(urlRequests).toEqual([
      expect.objectContaining({
        accessLevel: "raw_allowed",
        reason: "Support download",
        supportSessionId: SUPPORT_SESSION_ID_FIXTURE,
      }),
    ]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        accessLevel: "raw_allowed",
        artifactAccessEventId: "artaccess_1",
        expiresAt: "2026-05-07T12:05:00.000Z",
        reviewRun: { reviewRunId: "rrn_1" },
        url: expect.stringContaining("X-Amz-Signature=abc"),
      },
    });
  });

  it("blocks cross-tenant product artifact routes before reading artifact data", async () => {
    const artifactCalls: string[] = [];
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({
        createReviewArtifactDownloadUrl: async () => {
          artifactCalls.push("download-url");
          return reviewArtifactDownloadUrlFixture();
        },
        getReviewRun: async () => ({
          ...reviewRunSummaryFixture,
          orgId: "org_2",
          repoFullName: "other-org/heimdall",
          repoId: "repo_2",
          reviewRunId: "rrn_foreign",
        }),
        getReviewArtifactPayload: async () => {
          artifactCalls.push("payload");
          return reviewArtifactPayloadFixture();
        },
        listReviewArtifacts: async () => {
          artifactCalls.push("metadata");
          return [reviewArtifactFixture()];
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService(),
    });

    const requests = [
      "http://localhost/api/v1/review-runs/rrn_foreign/artifacts",
      "http://localhost/api/v1/review-runs/rrn_foreign/artifacts/art_2/payload?reason=Inspect%20foreign%20payload",
      "http://localhost/api/v1/review-runs/rrn_foreign/artifacts/art_2/download?reason=Download%20foreign%20payload",
      "http://localhost/api/v1/review-runs/rrn_foreign/artifacts/art_2/download-url?reason=Sign%20foreign%20payload",
    ];

    for (const url of requests) {
      const response = await app.handle(
        new Request(url, {
          headers: { cookie: "car_session=opaque" },
        }),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "product_auth.forbidden" },
      });
    }
    expect(artifactCalls).toEqual([]);
  });

  it("rejects product suppress-similar writes when the role lacks rule permission", async () => {
    let suppressCalled = false;
    const viewerSession = productSessionFixture({
      actor: {
        memberships: [{ orgId: "org_1", role: "viewer" }],
        selectedOrgId: "org_1",
        userId: "usr_1",
      },
    });
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({
        getReviewFinding: async () => reviewFindingFixture(),
        suppressSimilarFinding: async () => {
          suppressCalled = true;
          return findingSuppressionFixture();
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService({
        readSession: async () => viewerSession,
      }),
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/findings/fnd_validated_1/suppress-similar", {
        body: JSON.stringify({ reason: "Repeated false positive.", scope: "repo" }),
        headers: { cookie: "car_session=opaque", "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    expect(suppressCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "product_auth.forbidden" },
    });
  });

  it("serves product review failure summaries", async () => {
    const failedReview = {
      ...reviewRunSummaryFixture,
      failure: {
        code: "review_orchestrator.failed",
        message: "Review engine timed out.",
        occurredAt: "2026-05-05T12:30:00.000Z",
        retryable: true,
        rowId: "rrn_1",
        source: "review_run" as const,
      },
      status: "failed",
    };
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({
        getReviewRun: async () => failedReview,
        listReviewRuns: async () => [failedReview],
      }),
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService(),
    });

    const detailResponse = await app.handle(
      new Request("http://localhost/api/v1/review-runs/rrn_1", {
        headers: { cookie: "car_session=opaque" },
      }),
    );
    const listResponse = await app.handle(
      new Request("http://localhost/api/v1/orgs/org_1/review-runs", {
        headers: { cookie: "car_session=opaque" },
      }),
    );

    expect(detailResponse.status).toBe(200);
    expect(listResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      data: {
        reviewRun: {
          failure: {
            code: "review_orchestrator.failed",
            message: "Review engine timed out.",
            retryable: true,
          },
          status: "failed",
        },
      },
    });
    await expect(listResponse.json()).resolves.toMatchObject({
      data: {
        reviews: [
          {
            failure: { code: "review_orchestrator.failed" },
            reviewRunId: "rrn_1",
          },
        ],
      },
    });
  });

  it("serves product session preflight without admin auth", async () => {
    const previousAllowedOrigins = process.env.HEIMDALL_APP_ALLOWED_ORIGINS;
    process.env.HEIMDALL_APP_ALLOWED_ORIGINS = "https://app.example";
    try {
      const app = createApiApp({
        githubWebhookHandler: noopWebhookHandler(),
        productSessionAuth: productAuth,
        productSessionService: createMockProductSessionService(),
      });

      const response = await app.handle(
        new Request("http://localhost/api/v1/me", {
          headers: {
            origin: "https://app.example",
          },
          method: "OPTIONS",
        }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("access-control-allow-methods")).toContain("POST");
      expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example");
    } finally {
      if (previousAllowedOrigins === undefined) {
        delete process.env.HEIMDALL_APP_ALLOWED_ORIGINS;
      } else {
        process.env.HEIMDALL_APP_ALLOWED_ORIGINS = previousAllowedOrigins;
      }
    }
  });

  it("starts GitHub OAuth login for product sessions", async () => {
    const starts: string[] = [];
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      productGitHubOAuthService: createMockProductGitHubOAuthService({
        start: async (request) => {
          starts.push(request.redirectTo ?? "");
          return {
            authorizationUrl: "https://github.com/login/oauth/authorize?state=state_1",
          };
        },
      }),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService(),
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/auth/github/start?redirectTo=/reviews"),
    );

    expect(response.status).toBe(302);
    expect(starts).toEqual(["/reviews"]);
    expect(response.headers.get("location")).toBe(
      "https://github.com/login/oauth/authorize?state=state_1",
    );
  });

  it("completes GitHub OAuth login and writes a product session cookie", async () => {
    const completedUrls: string[] = [];
    const sessionUsers: string[] = [];
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      productGitHubOAuthService: createMockProductGitHubOAuthService({
        complete: async (request) => {
          completedUrls.push(request.callbackUrl);
          return {
            primaryEmail: "owner@example.com",
            providerLogin: "octocat",
            providerUserId: "12345",
            redirectTo: "/dashboard?tab=reviews",
            userId: "usr_1",
          };
        },
      }),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService({
        createSession: async (request) => {
          sessionUsers.push(request.userId);
          return {
            cookie: "car_session=session_token; Max-Age=1209600; Path=/; SameSite=Lax; HttpOnly",
            session: productSessionFixture(),
          };
        },
      }),
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/auth/github/callback?code=code_1&state=state_1"),
    );

    expect(response.status).toBe(302);
    expect(completedUrls).toEqual([
      "http://localhost/api/v1/auth/github/callback?code=code_1&state=state_1",
    ]);
    expect(sessionUsers).toEqual(["usr_1"]);
    expect(response.headers.get("location")).toBe("/dashboard?tab=reviews");
    expect(response.headers.get("set-cookie")).toContain("car_session=session_token");
  });

  it("rejects unconfigured GitHub OAuth starts", async () => {
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      productGitHubOAuth: {
        enabled: true,
      },
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService(),
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/auth/github/start?redirectTo=/"),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "github_oauth.unconfigured" },
    });
  });

  it("revokes product sessions and clears the product cookie", async () => {
    const revokedSessionIds: string[] = [];
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService({
        revokeSession: async (sessionId) => {
          revokedSessionIds.push(sessionId);
        },
      }),
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/auth/logout", {
        headers: { cookie: "car_session=opaque" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(revokedSessionIds).toEqual(["sess_product"]);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    await expect(response.json()).resolves.toMatchObject({ data: { ok: true } });
  });

  it("rejects missing product sessions", async () => {
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: productAuth,
      productSessionService: createMockProductSessionService({
        readSession: async () => undefined,
      }),
    });

    const response = await app.handle(new Request("http://localhost/api/v1/me"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "product_auth.unauthorized" },
    });
  });

  it("reports product session configuration errors before reading sessions", async () => {
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      productSessionAuth: {
        enabled: true,
        secureCookies: false,
        sessionPepper: "short",
      },
      productSessionService: createMockProductSessionService(),
    });

    const response = await app.handle(new Request("http://localhost/api/v1/me"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "product_auth.unconfigured" },
    });
  });

  it("creates provider-backed admin sessions from signed identity assertions", async () => {
    const auditEvents: string[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        recordAuditEvent: async (event) => {
          auditEvents.push(event.action);
          return auditLog(event.action);
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });

    const loginResponse = await app.handle(
      signedLoginRequest({
        email: "admin@example.com",
        permissions: ["admin.inspect", "admin.audit.view"],
        providerSubject: "usr_admin",
      }),
    );

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.headers.get("set-cookie")).toContain("test_admin_session=");
    await expect(loginResponse.json()).resolves.toMatchObject({
      data: {
        actor: {
          provider: "oidc",
          userId: "oidc:usr_admin",
        },
        capabilities: {
          canInspect: true,
          canViewAuditHistory: true,
          canExecuteReplay: false,
        },
      },
    });
    expect(auditEvents).toEqual(["admin.session.created"]);
  });

  it("returns and rotates authenticated sessions from secure cookies", async () => {
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      permissions: ["admin.inspect", "admin.replay.plan"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/session", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("test_admin_session=");
    await expect(response.json()).resolves.toMatchObject({
      data: {
        capabilities: {
          canInspect: true,
          canPlanReplay: true,
          canExecuteReplay: false,
        },
      },
    });
  });

  it("keeps admin routes disabled by default", async () => {
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({}),
      githubWebhookHandler: noopWebhookHandler(),
    });

    const response = await app.handle(new Request("http://localhost/admin/session"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.disabled" },
    });
  });

  it("rejects malformed support-session headers on authenticated admin routes", async () => {
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/session", {
        headers: {
          cookie: login.cookie,
          [SUPPORT_SESSION_HEADER_FIXTURE]: "ticket-123",
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.invalid_support_session" },
    });
  });

  it("rejects disallowed CORS origins for admin routes", async () => {
    const observabilitySink = createMemoryObservabilitySink();
    const securityEventSink = createMemorySecurityEventSink();
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminObservabilitySink: observabilitySink,
      adminSecurityEventSink: securityEventSink,
      githubWebhookHandler: noopWebhookHandler(),
    });

    const response = await app.handle(
      signedLoginRequest({
        headers: { origin: "https://evil.example" },
        permissions: ["admin.inspect"],
        providerSubject: "usr_admin",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.cors_forbidden" },
    });
    expect(observabilitySink.events()).toMatchObject([
      {
        attributes: {
          code: "admin.cors_forbidden",
          origin: "https://evil.example",
        },
        name: "admin.access.denied",
        route: "/admin/auth/login",
        statusCode: 403,
      },
    ]);
    expect(securityEventSink.events()).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          denialReason: "admin.cors_forbidden",
          method: "POST",
          origin: "https://evil.example",
          route: "/admin/auth/login",
        }),
        resourceType: "admin_route",
        severity: "medium",
        source: "api",
        type: "admin_cors_forbidden",
      }),
    ]);
  });

  it("rejects missing origins for admin mutations", async () => {
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      githubWebhookHandler: noopWebhookHandler(),
    });

    const response = await app.handle(
      signedLoginRequest({
        includeOrigin: false,
        permissions: ["admin.inspect"],
        providerSubject: "usr_admin",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.cors_forbidden" },
    });
  });

  it("rate-limits admin routes by client key", async () => {
    const observabilitySink = createMemoryObservabilitySink();
    const app = createApiApp({
      adminControlPlaneAuth: {
        ...auth,
        rateLimit: {
          maxRequests: 1,
          windowSeconds: 60,
        },
      },
      adminControlPlaneService: createMockControlPlaneService({}),
      adminObservabilitySink: observabilitySink,
      githubWebhookHandler: noopWebhookHandler(),
    });

    const first = await app.handle(
      new Request("http://localhost/admin/session", {
        headers: { "x-forwarded-for": "203.0.113.10" },
      }),
    );
    const second = await app.handle(
      new Request("http://localhost/admin/session", {
        headers: { "x-forwarded-for": "203.0.113.10" },
      }),
    );
    const otherClient = await app.handle(
      new Request("http://localhost/admin/session", {
        headers: { "x-forwarded-for": "203.0.113.11" },
      }),
    );

    expect(first.status).toBe(401);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
    expect(otherClient.status).toBe(401);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: "admin.rate_limited" },
    });
    expect(observabilitySink.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({
            code: "admin.rate_limited",
            retryAfterSeconds: 60,
          }),
          name: "admin.access.denied",
          statusCode: 429,
        }),
      ]),
    );
  });

  it("serves scoped API v1 organizations through signed sessions", async () => {
    const listQueries: Parameters<AdminControlPlaneService["listOrganizations"]>[0][] = [];
    const org = organizationFixture();
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getOrganization: async (orgId) => ({
          ...org,
          orgId,
        }),
        listOrganizations: async (query) => {
          listQueries.push(query);
          return [org];
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const listResponse = await app.handle(
      new Request("http://localhost/api/v1/orgs?search=octo&limit=5", {
        headers: { cookie: login.cookie },
      }),
    );
    const detailResponse = await app.handle(
      new Request("http://localhost/api/v1/orgs/org_1", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      data: {
        orgs: [
          {
            installationCount: 1,
            name: "Octo Org",
            orgId: "org_1",
            repositoryCount: 2,
            slug: "octo-org",
          },
        ],
      },
    });
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      data: {
        org: {
          orgId: "org_1",
          slug: "octo-org",
        },
      },
    });
    expect(listQueries).toEqual([
      expect.objectContaining({
        limit: 5,
        orgIds: ["org_1"],
        search: "octo",
      }),
    ]);
  });

  it("blocks cross-scope API v1 organization detail", async () => {
    const securityEventSink = createMemorySecurityEventSink();
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getOrganization: async () => organizationFixture({ orgId: "org_1" }),
      }),
      adminSecurityEventSink: securityEventSink,
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_2"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/orgs/org_1", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.scope_forbidden" },
    });
    expect(securityEventSink.events()).toEqual([
      expect.objectContaining({
        actorId: "oidc:usr_support",
        metadata: expect.objectContaining({
          denialReason: "admin.scope_forbidden",
          method: "GET",
          requiredPermission: "org:view",
          route: "/api/v1/orgs/org_1",
        }),
        orgId: "org_1",
        resourceId: "org_1",
        resourceType: "organization",
        severity: "critical",
        source: "api",
        type: "cross_tenant_access_attempt",
      }),
    ]);
  });

  it("serves scoped API v1 installations through signed sessions", async () => {
    const listQueries: Parameters<AdminControlPlaneService["listProviderInstallations"]>[0][] = [];
    const installation = providerInstallationFixture();
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getProviderInstallation: async (installationId) => ({
          ...installation,
          installationId,
        }),
        listProviderInstallations: async (query) => {
          listQueries.push(query);
          return [installation];
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const listResponse = await app.handle(
      new Request("http://localhost/api/v1/installations?search=octo&limit=5", {
        headers: { cookie: login.cookie },
      }),
    );
    const detailResponse = await app.handle(
      new Request("http://localhost/api/v1/installations/inst_1", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      data: {
        installations: [
          {
            accountLogin: "octo-org",
            installationId: "inst_1",
            orgId: "org_1",
            provider: "github",
          },
        ],
      },
    });
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      data: {
        installation: {
          installationId: "inst_1",
          orgId: "org_1",
        },
      },
    });
    expect(listQueries).toEqual([
      expect.objectContaining({
        limit: 5,
        orgIds: ["org_1"],
        search: "octo",
      }),
    ]);
  });

  it("enqueues installation sync through scoped API v1 sessions", async () => {
    const syncRequests: Parameters<AdminControlPlaneService["enqueueInstallationSync"]>[1][] = [];
    const syncRun = installationSyncRunFixture();
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getProviderInstallation: async () => providerInstallationFixture(),
        enqueueInstallationSync: async (_installationId, request) => {
          syncRequests.push(request);
          return syncRun;
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/installations/inst_1/sync", {
        method: "POST",
        headers: {
          cookie: login.cookie,
          "idempotency-key": "idem_sync",
          origin: adminOrigin,
          traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
          tracestate: "vendor=value",
          "x-csrf-token": login.csrfToken,
          "x-heimdall-parent-event-id": "webhook_1",
          "x-request-id": "req_admin_sync",
        },
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        auditLogId: "audit_sync",
        backgroundJobId: "job_sync",
        jobKey: "api:installation:sync:inst_1:idem_sync",
        status: "pending",
      },
    });
    expect(syncRequests).toHaveLength(1);
    expect(syncRequests[0]).toMatchObject({
      actor: expect.objectContaining({ actorUserId: "oidc:usr_admin" }),
      idempotencyKey: "idem_sync",
      requestId: "req_admin_sync",
      sessionId: expect.stringMatching(/^sess_/u),
      traceContext: {
        parentEventId: "webhook_1",
        requestId: "req_admin_sync",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=value",
      },
    });
  });

  it("blocks cross-scope installation sync before enqueue", async () => {
    let enqueueCalled = false;
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getProviderInstallation: async () => providerInstallationFixture({ orgId: "org_1" }),
        enqueueInstallationSync: async () => {
          enqueueCalled = true;
          return installationSyncRunFixture();
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_2"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/installations/inst_1/sync", {
        method: "POST",
        headers: {
          cookie: login.cookie,
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(enqueueCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.scope_forbidden" },
    });
  });

  it("serves GitHub App install URLs through scoped API v1 sessions", async () => {
    const previous = {
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
      HEIMDALL_GITHUB_APP_SLUG: process.env.HEIMDALL_GITHUB_APP_SLUG,
      HEIMDALL_GITHUB_APP_INSTALL_URL: process.env.HEIMDALL_GITHUB_APP_INSTALL_URL,
      WEB_URL: process.env.WEB_URL,
    };
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.HEIMDALL_GITHUB_APP_SLUG = "heimdall-dev";
    delete process.env.HEIMDALL_GITHUB_APP_INSTALL_URL;
    process.env.WEB_URL = adminOrigin;
    try {
      const app = createApiApp({
        adminControlPlaneAuth: auth,
        adminControlPlaneService: createMockControlPlaneService({}),
        githubWebhookHandler: noopWebhookHandler(),
      });
      const login = await loginSession(app, {
        orgIds: ["org_1"],
        permissions: ["admin.inspect"],
        providerSubject: "usr_support",
      });

      const response = await app.handle(
        new Request("http://localhost/api/v1/github/install-url", {
          headers: { cookie: login.cookie },
        }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        data: {
          appSlug: "heimdall-dev",
          configured: true,
          url: "https://github.com/apps/heimdall-dev/installations/new",
          webhookConfigured: true,
          webhookUrl: "http://localhost:3001/webhooks/github",
        },
      });
    } finally {
      restoreEnv(previous);
    }
  });

  it("redirects GitHub App install callbacks to onboarding with sanitized query state", async () => {
    const previous = { WEB_URL: process.env.WEB_URL };
    process.env.WEB_URL = adminOrigin;
    try {
      const app = createApiApp({
        adminControlPlaneService: createMockControlPlaneService({}),
        githubWebhookHandler: noopWebhookHandler(),
      });

      const response = await app.handle(
        new Request(
          "http://localhost/api/v1/github/install-callback?installation_id=12345&setup_action=install&state=state_123",
        ),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "http://localhost:3001/app/onboarding?githubInstallation=complete&installationId=12345&setupAction=install&state=state_123",
      );
    } finally {
      restoreEnv(previous);
    }
  });

  it("rejects malformed GitHub App install callback query values", async () => {
    const app = createApiApp({
      adminControlPlaneService: createMockControlPlaneService({}),
      githubWebhookHandler: noopWebhookHandler(),
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/github/install-callback?installation_id=not-a-number"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "github.install_callback_invalid" },
    });
  });

  it("serves scoped API v1 repositories and repository detail", async () => {
    const listQueries: Parameters<AdminControlPlaneService["listRepositories"]>[0][] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getRepositorySettings: async () => ({
          repository: repositoryFixture,
          settings: settingsFixture,
        }),
        listRepositories: async (query) => {
          listQueries.push(query);
          return [repositoryFixture];
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const listResponse = await app.handle(
      new Request("http://localhost/api/v1/orgs/org_1/repositories?search=heimdall&limit=5", {
        headers: { cookie: login.cookie },
      }),
    );
    const detailResponse = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      data: {
        repositories: [
          {
            fullName: "octo-org/heimdall",
            orgId: "org_1",
            repoId: "repo_1",
          },
        ],
      },
    });
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      data: {
        repository: {
          repoId: "repo_1",
        },
        settings: {
          severityThreshold: "medium",
        },
      },
    });
    expect(listQueries).toEqual([
      expect.objectContaining({
        limit: 5,
        orgIds: ["org_1"],
        search: "heimdall",
      }),
    ]);
  });

  it("updates scoped API v1 repository settings with validation and CSRF", async () => {
    const patches: Parameters<AdminControlPlaneService["updateRepositorySettings"]>[1][] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getRepositorySettings: async () => ({
          repository: repositoryFixture,
          settings: settingsFixture,
        }),
        updateRepositorySettings: async (_repoId, patch) => {
          patches.push(patch);
          return {
            repository: repositoryFixture,
            settings: {
              ...settingsFixture,
              severityThreshold: patch.severityThreshold ?? settingsFixture.severityThreshold,
            },
          };
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/settings", {
        body: JSON.stringify({ severityThreshold: "high" }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(200);
    expect(patches).toEqual([expect.objectContaining({ severityThreshold: "high" })]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        settings: {
          severityThreshold: "high",
        },
      },
    });
  });

  it("enables and syncs scoped API v1 repositories", async () => {
    const patches: Parameters<AdminControlPlaneService["updateRepositorySettings"]>[1][] = [];
    const syncRequests: Parameters<AdminControlPlaneService["enqueueRepositorySync"]>[1][] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getRepositorySettings: async () => ({
          repository: { ...repositoryFixture, enabled: false },
          settings: settingsFixture,
        }),
        enqueueRepositorySync: async (_repoId, request) => {
          syncRequests.push(request);
          return repositoryJobRunFixture({
            jobKey: "api:repository:sync:repo_1:idem_repo",
          });
        },
        updateRepositorySettings: async (_repoId, patch) => {
          patches.push(patch);
          return {
            repository: { ...repositoryFixture, enabled: patch.repositoryEnabled ?? false },
            settings: settingsFixture,
          };
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/enable", {
        headers: {
          cookie: login.cookie,
          "idempotency-key": "idem_repo",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    expect(patches).toEqual([expect.objectContaining({ repositoryEnabled: true })]);
    expect(syncRequests).toEqual([
      expect.objectContaining({
        idempotencyKey: "idem_repo",
      }),
    ]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        settings: {
          repository: {
            enabled: true,
          },
        },
        syncRun: {
          jobKey: "api:repository:sync:repo_1:idem_repo",
        },
      },
    });
  });

  it("enqueues scoped API v1 repository reindex jobs", async () => {
    const reindexRequests: Parameters<AdminControlPlaneService["enqueueRepositoryReindex"]>[1][] =
      [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getRepositorySettings: async () => ({
          repository: repositoryFixture,
          settings: settingsFixture,
        }),
        enqueueRepositoryReindex: async (_repoId, request) => {
          reindexRequests.push(request);
          return repositoryJobRunFixture({
            jobKey: "api:repository:reindex:repo_1:abcdef1234567890:idem_reindex",
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/reindex", {
        body: JSON.stringify({
          commitSha: "abcdef1234567890",
          reason: "Refresh after onboarding.",
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          "idempotency-key": "idem_reindex",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    expect(reindexRequests).toEqual([
      expect.objectContaining({
        commitSha: "abcdef1234567890",
        idempotencyKey: "idem_reindex",
        reason: "Refresh after onboarding.",
      }),
    ]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        jobKey: "api:repository:reindex:repo_1:abcdef1234567890:idem_reindex",
      },
    });
  });

  it("blocks cross-scope repository reindex before enqueue", async () => {
    let enqueueCalled = false;
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getRepositorySettings: async () => ({
          repository: { ...repositoryFixture, orgId: "org_1" },
          settings: settingsFixture,
        }),
        enqueueRepositoryReindex: async () => {
          enqueueCalled = true;
          return repositoryJobRunFixture();
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_2"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/reindex", {
        body: JSON.stringify({ commitSha: "abcdef1234567890" }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    expect(enqueueCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.scope_forbidden" },
    });
  });

  it("serves scoped API v1 review runs and findings", async () => {
    const reviewQueries: Parameters<AdminControlPlaneService["listReviewRuns"]>[0][] = [];
    const findingQueries: Parameters<AdminControlPlaneService["listReviewFindings"]>[1][] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getRepositorySettings: async () => ({
          repository: repositoryFixture,
          settings: settingsFixture,
        }),
        getReviewFinding: async () => reviewFindingFixture(),
        getReviewRun: async () => reviewRunSummaryFixture,
        listReviewFindings: async (_reviewRunId, query) => {
          findingQueries.push(query);
          return [reviewFindingFixture()];
        },
        listReviewRuns: async (query) => {
          reviewQueries.push(query);
          return [reviewRunSummaryFixture];
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const orgReviewsResponse = await app.handle(
      new Request("http://localhost/api/v1/orgs/org_1/review-runs?status=completed&limit=5", {
        headers: { cookie: login.cookie },
      }),
    );
    const repoReviewsResponse = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/review-runs?limit=5", {
        headers: { cookie: login.cookie },
      }),
    );
    const reviewResponse = await app.handle(
      new Request("http://localhost/api/v1/review-runs/rrn_1", {
        headers: { cookie: login.cookie },
      }),
    );
    const findingsResponse = await app.handle(
      new Request("http://localhost/api/v1/review-runs/rrn_1/findings?decision=publish", {
        headers: { cookie: login.cookie },
      }),
    );
    const findingResponse = await app.handle(
      new Request("http://localhost/api/v1/findings/fnd_validated_1", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(orgReviewsResponse.status).toBe(200);
    expect(repoReviewsResponse.status).toBe(200);
    expect(reviewResponse.status).toBe(200);
    expect(findingsResponse.status).toBe(200);
    expect(findingResponse.status).toBe(200);
    await expect(findingsResponse.json()).resolves.toMatchObject({
      data: {
        findings: [{ findingId: "fnd_validated_1", latestOutcome: { outcome: "accepted" } }],
        reviewRun: { reviewRunId: "rrn_1" },
      },
    });
    await expect(findingResponse.json()).resolves.toMatchObject({
      data: {
        finding: {
          findingId: "fnd_validated_1",
          publication: { providerCommentId: "123" },
        },
      },
    });
    expect(reviewQueries).toEqual([
      expect.objectContaining({ limit: 5, orgIds: ["org_1"], status: "completed" }),
      expect.objectContaining({ limit: 5, repoId: "repo_1" }),
    ]);
    expect(findingQueries).toEqual([expect.objectContaining({ decision: "publish" })]);
  });

  it("serves scoped API v1 usage summaries and events", async () => {
    const summaryQueries: Parameters<AdminControlPlaneService["getProductUsageSummary"]>[0][] = [];
    const eventQueries: Parameters<AdminControlPlaneService["listProductUsageEvents"]>[0][] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getProductUsageSummary: async (query) => {
          summaryQueries.push(query);
          return productUsageSummaryFixture({
            byRepo: [
              {
                estimatedCostUsd: "0.000250",
                repoId: "repo_1",
                repoName: "octo/heimdall",
                reviewRuns: 2,
              },
            ],
            estimatedCostUsd: "0.000250",
            reviewInputTokens: 900,
            reviewOutputTokens: 300,
            reviewRuns: 2,
          });
        },
        getRepositorySettings: async () => ({
          repository: repositoryFixture,
          settings: settingsFixture,
        }),
        listProductUsageEvents: async (query) => {
          eventQueries.push(query);
          return [
            productUsageEventFixture({
              costMicros: 250,
              eventType: "llm.token",
              quantity: 1200,
            }),
          ];
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const orgSummaryResponse = await app.handle(
      new Request(
        "http://localhost/api/v1/orgs/org_1/usage/summary?start=2026-05-01T00:00:00.000Z&end=2026-06-01T00:00:00.000Z&groupBy=repo",
        { headers: { cookie: login.cookie } },
      ),
    );
    const repoSummaryResponse = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/usage/summary?groupBy=repo", {
        headers: { cookie: login.cookie },
      }),
    );
    const eventsResponse = await app.handle(
      new Request(
        "http://localhost/api/v1/orgs/org_1/usage/events?type=llm.token&repoId=repo_1&limit=5",
        { headers: { cookie: login.cookie } },
      ),
    );

    expect(orgSummaryResponse.status).toBe(200);
    expect(repoSummaryResponse.status).toBe(200);
    expect(eventsResponse.status).toBe(200);
    expect(summaryQueries).toEqual([
      expect.objectContaining({
        groupBy: "repo",
        orgId: "org_1",
        periodEnd: "2026-06-01T00:00:00.000Z",
        periodStart: "2026-05-01T00:00:00.000Z",
      }),
      expect.objectContaining({ groupBy: "repo", orgId: "org_1", repoId: "repo_1" }),
    ]);
    expect(eventQueries).toEqual([
      expect.objectContaining({
        eventType: "llm.token",
        limit: 5,
        orgId: "org_1",
        repoId: "repo_1",
      }),
    ]);
    await expect(orgSummaryResponse.json()).resolves.toMatchObject({
      data: {
        byRepo: [{ repoId: "repo_1", reviewRuns: 2 }],
        estimatedCostUsd: "0.000250",
        reviewInputTokens: 900,
        reviewOutputTokens: 300,
      },
    });
    await expect(eventsResponse.json()).resolves.toMatchObject({
      data: {
        events: [{ costMicros: 250, eventType: "llm.token", quantity: 1200 }],
      },
    });
  });

  it("rejects invalid scoped API v1 usage filters", async () => {
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/orgs/org_1/usage/events?type=unsupported", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "usage.event_type_invalid" },
    });
  });

  it("blocks cross-scope API v1 usage reads before loading usage", async () => {
    let summaryCalled = false;
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getProductUsageSummary: async () => {
          summaryCalled = true;
          return productUsageSummaryFixture();
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_2"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/orgs/org_1/usage/summary", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(403);
    expect(summaryCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.scope_forbidden" },
    });
  });

  it("records scoped API v1 finding outcomes", async () => {
    const outcomeRequests: Parameters<AdminControlPlaneService["recordFindingOutcome"]>[1][] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getReviewFinding: async () => reviewFindingFixture(),
        recordFindingOutcome: async (_findingId, request) => {
          outcomeRequests.push(request);
          return findingOutcomeRecordFixture({
            outcome: findingOutcomeFixture({ outcome: request.outcome, source: request.source }),
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/findings/fnd_validated_1/outcome", {
        body: JSON.stringify({
          metadata: { source: "manual_review" },
          notes: "Developer accepted this finding.",
          outcome: "resolved",
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          "idempotency-key": "idem_outcome",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(200);
    expect(outcomeRequests).toEqual([
      expect.objectContaining({
        idempotencyKey: "idem_outcome",
        notes: "Developer accepted this finding.",
        outcome: "resolved",
        source: "user_action",
      }),
    ]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        auditLogId: "audit_finding_outcome",
        outcome: { outcome: "resolved", source: "user_action" },
      },
    });
  });

  it("enqueues scoped API v1 review reruns", async () => {
    const rerunRequests: Parameters<AdminControlPlaneService["enqueueReviewRerun"]>[1][] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        enqueueReviewRerun: async (_reviewRunId, request) => {
          rerunRequests.push(request);
          return reviewRerunRunFixture({
            jobKey: "api:review:rerun:rrn_1:idem_review",
          });
        },
        getReviewRun: async () => reviewRunSummaryFixture,
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/review-runs/rrn_1/rerun", {
        headers: {
          cookie: login.cookie,
          "idempotency-key": "idem_review",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    expect(rerunRequests).toEqual([
      expect.objectContaining({
        idempotencyKey: "idem_review",
      }),
    ]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        jobKey: "api:review:rerun:rrn_1:idem_review",
        sourceReviewRunId: "rrn_1",
      },
    });
  });

  it("blocks cross-scope finding outcome updates before recording", async () => {
    let recordCalled = false;
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getReviewFinding: async () => reviewFindingFixture({ orgId: "org_1", repoId: "repo_1" }),
        recordFindingOutcome: async () => {
          recordCalled = true;
          return findingOutcomeRecordFixture();
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_2"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/findings/fnd_validated_1/outcome", {
        body: JSON.stringify({ outcome: "dismissed" }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(403);
    expect(recordCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.scope_forbidden" },
    });
  });

  it("serves scoped API v1 repository memory facts and candidates", async () => {
    const listQueries: Parameters<AdminControlPlaneService["listRepositoryMemoryFacts"]>[1][] = [];
    const candidateQueries: Parameters<
      AdminControlPlaneService["listRepositoryMemoryCandidates"]
    >[1][] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getMemoryFact: async () => memoryFactFixture(),
        getRepositorySettings: async () => ({
          repository: repositoryFixture,
          settings: settingsFixture,
        }),
        listRepositoryMemoryFacts: async (_repoId, query) => {
          listQueries.push(query);
          return [memoryFactFixture()];
        },
        listRepositoryMemoryCandidates: async (_repoId, query) => {
          candidateQueries.push(query);
          return [memoryCandidateFixture()];
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const listResponse = await app.handle(
      new Request(
        "http://localhost/api/v1/repositories/repo_1/memory?kind=repo_convention&status=active&candidateStatus=pending&candidateKind=repo_fact",
        {
          headers: { cookie: login.cookie },
        },
      ),
    );
    const detailResponse = await app.handle(
      new Request("http://localhost/api/v1/memory/mem_1", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(listResponse.status).toBe(200);
    expect(detailResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      data: {
        memoryCandidates: [
          {
            candidateKind: "repo_fact",
            memoryCandidateId: "mcand_1",
            status: "pending",
          },
        ],
        memoryFacts: [
          {
            kind: "repo_convention",
            memoryFactId: "mem_1",
            scope: "repository",
            text: "Prefer bounded retries for provider calls.",
          },
        ],
      },
    });
    await expect(detailResponse.json()).resolves.toMatchObject({
      data: {
        memoryFact: {
          memoryFactId: "mem_1",
          source: "manual",
        },
      },
    });
    expect(listQueries).toEqual([
      expect.objectContaining({
        kind: "repo_convention",
        status: "active",
      }),
    ]);
    expect(candidateQueries).toEqual([
      expect.objectContaining({
        candidateKind: "repo_fact",
        status: "pending",
      }),
    ]);
  });

  it("creates, updates, and deletes scoped API v1 memory facts", async () => {
    const createRequests: Parameters<AdminControlPlaneService["createRepositoryMemoryFact"]>[1][] =
      [];
    const updateRequests: Parameters<AdminControlPlaneService["updateMemoryFact"]>[1][] = [];
    const deleteRequests: Parameters<AdminControlPlaneService["deleteMemoryFact"]>[1][] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        createRepositoryMemoryFact: async (_repoId, request) => {
          createRequests.push(request);
          return memoryFactFixture({
            kind: request.kind,
            text: request.text,
          });
        },
        deleteMemoryFact: async (_memoryFactId, request) => {
          deleteRequests.push(request);
          return memoryFactFixture({ enabled: false, status: "disabled" });
        },
        getMemoryFact: async () => memoryFactFixture(),
        getRepositorySettings: async () => ({
          repository: repositoryFixture,
          settings: settingsFixture,
        }),
        updateMemoryFact: async (_memoryFactId, request) => {
          updateRequests.push(request);
          return memoryFactFixture({
            enabled: request.enabled ?? true,
            status: request.enabled === false ? "disabled" : "active",
            text: request.text ?? "Prefer bounded retries for provider calls.",
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const createResponse = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/memory", {
        body: JSON.stringify({
          kind: "repo_convention",
          subject: "Provider retry policy",
          text: "Prefer bounded retries for provider calls.",
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          "idempotency-key": "idem_memory",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "POST",
      }),
    );
    const updateResponse = await app.handle(
      new Request("http://localhost/api/v1/memory/mem_1", {
        body: JSON.stringify({
          enabled: false,
          text: "Prefer bounded retries and explicit retry budgets.",
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "PATCH",
      }),
    );
    const deleteResponse = await app.handle(
      new Request("http://localhost/api/v1/memory/mem_1", {
        headers: {
          cookie: login.cookie,
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "DELETE",
      }),
    );

    expect(createResponse.status).toBe(201);
    expect(updateResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(createRequests).toEqual([
      expect.objectContaining({
        idempotencyKey: "idem_memory",
        kind: "repo_convention",
        source: "manual",
      }),
    ]);
    expect(updateRequests).toEqual([
      expect.objectContaining({
        enabled: false,
        text: "Prefer bounded retries and explicit retry budgets.",
      }),
    ]);
    expect(deleteRequests).toHaveLength(1);
    await expect(deleteResponse.json()).resolves.toMatchObject({
      data: {
        memoryFact: {
          enabled: false,
          status: "disabled",
        },
      },
    });
  });

  it("approves and rejects scoped API v1 memory candidates", async () => {
    const approvalRequests: Parameters<AdminControlPlaneService["approveMemoryCandidate"]>[1][] =
      [];
    const rejectionRequests: Parameters<AdminControlPlaneService["rejectMemoryCandidate"]>[1][] =
      [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        approveMemoryCandidate: async (memoryCandidateId, request) => {
          approvalRequests.push(request);
          return memoryCandidateApprovalFixture({
            candidate: memoryCandidateFixture({
              approvedMemoryFactId: "mem_from_candidate",
              memoryCandidateId,
              status: "approved",
            }),
          });
        },
        getMemoryCandidate: async (memoryCandidateId) =>
          memoryCandidateFixture({ memoryCandidateId }),
        rejectMemoryCandidate: async (memoryCandidateId, request) => {
          rejectionRequests.push(request);
          return memoryCandidateRejectionFixture({
            candidate: memoryCandidateFixture({
              memoryCandidateId,
              status: "rejected",
            }),
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const approvalResponse = await app.handle(
      new Request("http://localhost/api/v1/memory-candidates/mcand_approve/approve", {
        body: JSON.stringify({
          metadata: { reviewedIn: "memory-dashboard" },
          reason: "Matches the repository guidance.",
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          "idempotency-key": "idem_candidate_approve",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "POST",
      }),
    );
    const rejectionResponse = await app.handle(
      new Request("http://localhost/api/v1/memory-candidates/mcand_reject/reject", {
        body: JSON.stringify({
          reason: "Too broad for this repository.",
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          "idempotency-key": "idem_candidate_reject",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "POST",
      }),
    );

    expect(approvalResponse.status).toBe(200);
    expect(rejectionResponse.status).toBe(200);
    expect(approvalRequests).toEqual([
      expect.objectContaining({
        idempotencyKey: "idem_candidate_approve",
        reason: "Matches the repository guidance.",
      }),
    ]);
    expect(rejectionRequests).toEqual([
      expect.objectContaining({
        idempotencyKey: "idem_candidate_reject",
        reason: "Too broad for this repository.",
      }),
    ]);
    await expect(approvalResponse.json()).resolves.toMatchObject({
      data: {
        candidate: {
          approvedMemoryFactId: "mem_from_candidate",
          memoryCandidateId: "mcand_approve",
          status: "approved",
        },
        memoryFact: {
          memoryFactId: "mem_from_candidate",
        },
      },
    });
    await expect(rejectionResponse.json()).resolves.toMatchObject({
      data: {
        candidate: {
          memoryCandidateId: "mcand_reject",
          status: "rejected",
        },
      },
    });
  });

  it("blocks cross-scope memory candidate writes before mutation", async () => {
    let approveCalled = false;
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        approveMemoryCandidate: async () => {
          approveCalled = true;
          return memoryCandidateApprovalFixture();
        },
        getMemoryCandidate: async () => memoryCandidateFixture({ orgId: "org_1" }),
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_2"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/memory-candidates/mcand_1/approve", {
        body: JSON.stringify({
          reason: "Looks correct.",
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    expect(approveCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.scope_forbidden" },
    });
  });

  it("blocks cross-scope memory writes before mutation", async () => {
    let createCalled = false;
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        createRepositoryMemoryFact: async () => {
          createCalled = true;
          return memoryFactFixture();
        },
        getRepositorySettings: async () => ({
          repository: { ...repositoryFixture, orgId: "org_1" },
          settings: settingsFixture,
        }),
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_2"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/api/v1/repositories/repo_1/memory", {
        body: JSON.stringify({
          kind: "repo_convention",
          text: "Prefer bounded retries for provider calls.",
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    expect(createCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.scope_forbidden" },
    });
  });

  it("fails closed when github_org auth omits the required organization", async () => {
    const app = createApiApp({
      adminControlPlaneAuth: {
        ...auth,
        identityProvider: "github_org",
      },
      adminControlPlaneService: createMockControlPlaneService({}),
      githubWebhookHandler: noopWebhookHandler(),
    });

    const response = await app.handle(new Request("http://localhost/admin/session"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.misconfigured" },
    });
  });

  it("exposes admin debug visibility routes through scoped sessions", async () => {
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        getWebhookDebugDetails: async (webhookEventId: string) => ({
          webhookEvent: {
            webhookEventId,
            provider: "github",
            deliveryId: "delivery-1",
            eventName: "pull_request",
            orgId: "org_1",
            repoId: "repo_1",
            status: "processed",
            payloadHash: "sha256:test",
            hasStoredPayload: true,
            receivedAt: "2026-05-05T12:00:00.000Z",
          },
          expectedJobKeys: ["github:review:repo_1:7:abc123"],
          relatedJobs: [],
          replayAudits: [],
          failures: [],
        }),
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/webhooks/webhook_1", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        webhookEvent: {
          webhookEventId: "webhook_1",
          deliveryId: "delivery-1",
        },
      },
    });
  });

  it("exposes memory and rules inspector details through scoped sessions", async () => {
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        getMemoryRulesDebugDetails: async () => memoryRulesDebugDetailsFixture(),
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/repos/repo_1/memory-rules", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        memoryFacts: [
          {
            memoryFactId: "mem_1",
            status: "active",
          },
        ],
        memoryCandidates: [
          {
            memoryCandidateId: "mcand_1",
            status: "pending",
          },
        ],
        repository: {
          repoId: "repo_1",
          orgId: "org_1",
        },
        rules: [
          {
            ruleId: "rule_1",
            effect: "context",
          },
        ],
      },
    });
  });

  it("exports redacted review debug bundles through scoped sessions", async () => {
    const actors: AdminReplayAuditActor[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        getReviewDebugDetails: async (reviewRunId: string) =>
          reviewDebugDetailsFixture({ reviewRunId }),
        exportReviewRunDebugBundle: async (reviewRunId: string, actor: AdminReplayAuditActor) => {
          actors.push(actor);
          return debugBundleFixture({ reviewRunId });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/reviews/rrn_1/debug-bundle", {
        method: "POST",
        headers: {
          cookie: login.cookie,
          origin: adminOrigin,
          [SUPPORT_SESSION_HEADER_FIXTURE]: SUPPORT_SESSION_ID_FIXTURE,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        adminActionId: "admact_debug_bundle",
        auditLogId: "audit_debug_bundle",
        bundleId: "dbg_review",
        payloadHash: "sha256:debug-bundle",
        payload: {
          review: {
            reviewRunId: "rrn_1",
          },
        },
      },
    });
    expect(actors[0]).toMatchObject({
      actorType: "idp_user",
      actorUserId: "oidc:usr_support",
      role: "support",
      supportSessionId: SUPPORT_SESSION_ID_FIXTURE,
    });
  });

  it("creates eval import drafts through scoped review inspector sessions", async () => {
    const requestedSuites: string[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        getReviewDebugDetails: async (reviewRunId: string) =>
          reviewDebugDetailsFixture({ reviewRunId }),
        createReviewRunEvalImportDraft: async (request) => {
          requestedSuites.push(request.suiteId);
          return evalImportDraftFixture({ reviewRunId: request.reviewRunId });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/reviews/rrn_1/import-eval", {
        method: "POST",
        body: JSON.stringify({
          caseName: "Imported review case",
          labels: ["prod-failure"],
          reason: "Cover a production miss.",
          suiteId: "smoke-full-pipeline-v1",
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(requestedSuites).toEqual(["smoke-full-pipeline-v1"]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        adminActionId: "admact_eval_import",
        auditLogId: "audit_eval_import",
        evalCase: {
          caseId: "case_imported_review",
        },
        importDraftId: "evaldraft_1",
      },
    });
  });

  it("runs retrieval replay dry-runs through scoped replay planning sessions", async () => {
    const replayedReviewRunIds: string[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        getReviewDebugDetails: async (reviewRunId: string) =>
          reviewDebugDetailsFixture({ reviewRunId }),
        replayRetrievalDryRun: async (reviewRunId: string) => {
          replayedReviewRunIds.push(reviewRunId);
          return retrievalReplayDryRunFixture({ reviewRunId });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.replay.plan"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/reviews/rrn_1/retrieval-replay", {
        method: "POST",
        headers: {
          cookie: login.cookie,
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(replayedReviewRunIds).toEqual(["rrn_1"]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        mutatesProductionState: false,
        replayed: {
          itemCount: 1,
          retrievalMode: "indexed_context",
        },
        reviewRunId: "rrn_1",
      },
    });
  });

  it("runs validation replay dry-runs through scoped replay planning sessions", async () => {
    const replayedReviewRunIds: string[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        getReviewDebugDetails: async (reviewRunId: string) =>
          reviewDebugDetailsFixture({ reviewRunId }),
        replayValidationDryRun: async (reviewRunId: string) => {
          replayedReviewRunIds.push(reviewRunId);
          return validationReplayDryRunFixture({ reviewRunId });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.replay.plan"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/reviews/rrn_1/validation-replay", {
        method: "POST",
        headers: {
          cookie: login.cookie,
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(replayedReviewRunIds).toEqual(["rrn_1"]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        candidateFindingCount: 1,
        mutatesProductionState: false,
        replayed: {
          publish: 1,
          reject: 0,
        },
        reviewRunId: "rrn_1",
      },
    });
  });

  it("requires non-empty reasons for eval import draft mutations", async () => {
    let importCalled = false;
    const observabilitySink = createMemoryObservabilitySink();
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        getReviewDebugDetails: async (reviewRunId: string) =>
          reviewDebugDetailsFixture({ reviewRunId }),
        createReviewRunEvalImportDraft: async () => {
          importCalled = true;
          return evalImportDraftFixture();
        },
      }),
      adminObservabilitySink: observabilitySink,
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/reviews/rrn_1/import-eval", {
        method: "POST",
        body: JSON.stringify({
          reason: "   ",
          suiteId: "smoke-full-pipeline-v1",
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(importCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.reason_required" },
    });
    expect(observabilitySink.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({
            actorUserId: "oidc:usr_support",
            code: "admin.reason_required",
            resourceId: "rrn_1",
          }),
          name: "admin.access.denied",
          statusCode: 400,
        }),
      ]),
    );
  });

  it("requires support-session references for raw eval import drafts by support actors", async () => {
    const actors: AdminReplayAuditActor[] = [];
    const requestedRedactionLevels: string[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        getReviewDebugDetails: async (reviewRunId: string) =>
          reviewDebugDetailsFixture({ reviewRunId }),
        createReviewRunEvalImportDraft: async (request, actor) => {
          actors.push(actor);
          requestedRedactionLevels.push(request.redactionLevel);
          return evalImportDraftFixture({
            redactionLevel: request.redactionLevel,
            reviewRunId: request.reviewRunId,
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const denied = await app.handle(
      new Request("http://localhost/admin/debug/reviews/rrn_1/import-eval", {
        method: "POST",
        body: JSON.stringify({
          redactionLevel: "raw_allowed",
          reason: "Inspect raw artifact behavior.",
          suiteId: "smoke-full-pipeline-v1",
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );
    const allowed = await app.handle(
      new Request("http://localhost/admin/debug/reviews/rrn_1/import-eval", {
        method: "POST",
        body: JSON.stringify({
          redactionLevel: "raw_allowed",
          reason: "Inspect raw artifact behavior.",
          suiteId: "smoke-full-pipeline-v1",
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          [SUPPORT_SESSION_HEADER_FIXTURE]: SUPPORT_SESSION_ID_FIXTURE,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: "admin.support_session_required" },
    });
    expect(allowed.status).toBe(200);
    expect(requestedRedactionLevels).toEqual(["raw_allowed"]);
    expect(actors).toEqual([
      expect.objectContaining({
        actorUserId: "oidc:usr_support",
        supportSessionId: SUPPORT_SESSION_ID_FIXTURE,
      }),
    ]);
  });

  it("allows elevated admin actors to create raw eval import drafts without support sessions", async () => {
    const actors: AdminReplayAuditActor[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        getReviewDebugDetails: async (reviewRunId: string) =>
          reviewDebugDetailsFixture({ reviewRunId }),
        createReviewRunEvalImportDraft: async (request, actor) => {
          actors.push(actor);
          return evalImportDraftFixture({
            redactionLevel: request.redactionLevel,
            reviewRunId: request.reviewRunId,
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect", "admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/reviews/rrn_1/import-eval", {
        method: "POST",
        body: JSON.stringify({
          redactionLevel: "raw_allowed",
          reason: "Admin raw import review.",
          suiteId: "smoke-full-pipeline-v1",
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(actors).toEqual([
      expect.objectContaining({
        actorUserId: "oidc:usr_admin",
        role: "admin",
      }),
    ]);
  });

  it("blocks cross-tenant debug bundle export before creating an export", async () => {
    let exportCalled = false;
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getRepositorySettings: async (repoId) => ({
          repository: {
            ...repositoryFixture,
            repoId,
            orgId: "org_2",
          },
          settings: {
            ...settingsFixture,
            repoId,
          },
        }),
      }),
      adminDebugService: createMockAdminDebugService({
        getReviewDebugDetails: async (reviewRunId: string) =>
          reviewDebugDetailsFixture({ reviewRunId, repoId: "repo_2" }),
        exportReviewRunDebugBundle: async () => {
          exportCalled = true;
          return debugBundleFixture({ repoId: "repo_2" });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/reviews/rrn_2/debug-bundle", {
        method: "POST",
        headers: {
          cookie: login.cookie,
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(exportCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.scope_forbidden" },
    });
  });

  it("blocks cross-tenant eval import drafts before creating a draft", async () => {
    let importCalled = false;
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getRepositorySettings: async (repoId) => ({
          repository: {
            ...repositoryFixture,
            repoId,
            orgId: "org_2",
          },
          settings: {
            ...settingsFixture,
            repoId,
          },
        }),
      }),
      adminDebugService: createMockAdminDebugService({
        getReviewDebugDetails: async (reviewRunId: string) =>
          reviewDebugDetailsFixture({ reviewRunId, repoId: "repo_2" }),
        createReviewRunEvalImportDraft: async (request) => {
          importCalled = true;
          return evalImportDraftFixture({ repoId: "repo_2", reviewRunId: request.reviewRunId });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/reviews/rrn_2/import-eval", {
        method: "POST",
        body: JSON.stringify({
          caseName: "Foreign review case",
          reason: "This should not pass scope checks.",
          suiteId: "smoke-full-pipeline-v1",
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(importCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.scope_forbidden" },
    });
  });

  it("blocks cross-tenant retrieval replay dry-runs before replaying retrieval", async () => {
    let replayCalled = false;
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getRepositorySettings: async (repoId) => ({
          repository: {
            ...repositoryFixture,
            repoId,
            orgId: "org_2",
          },
          settings: {
            ...settingsFixture,
            repoId,
          },
        }),
      }),
      adminDebugService: createMockAdminDebugService({
        getReviewDebugDetails: async (reviewRunId: string) =>
          reviewDebugDetailsFixture({ reviewRunId, repoId: "repo_2" }),
        replayRetrievalDryRun: async (reviewRunId: string) => {
          replayCalled = true;
          return retrievalReplayDryRunFixture({ reviewRunId });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.replay.plan"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/reviews/rrn_2/retrieval-replay", {
        method: "POST",
        headers: {
          cookie: login.cookie,
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(replayCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.scope_forbidden" },
    });
  });

  it("blocks cross-tenant validation replay dry-runs before replaying validation", async () => {
    let replayCalled = false;
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getRepositorySettings: async (repoId) => ({
          repository: {
            ...repositoryFixture,
            repoId,
            orgId: "org_2",
          },
          settings: {
            ...settingsFixture,
            repoId,
          },
        }),
      }),
      adminDebugService: createMockAdminDebugService({
        getReviewDebugDetails: async (reviewRunId: string) =>
          reviewDebugDetailsFixture({ reviewRunId, repoId: "repo_2" }),
        replayValidationDryRun: async (reviewRunId: string) => {
          replayCalled = true;
          return validationReplayDryRunFixture({ reviewRunId });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.replay.plan"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/reviews/rrn_2/validation-replay", {
        method: "POST",
        headers: {
          cookie: login.cookie,
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(replayCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.scope_forbidden" },
    });
  });

  it("blocks cross-tenant memory and rules inspection", async () => {
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        getMemoryRulesDebugDetails: async () =>
          memoryRulesDebugDetailsFixture({
            repository: {
              ...memoryRulesDebugDetailsFixture().repository,
              repoId: "repo_2",
              orgId: "org_2",
            },
          }),
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/repos/repo_2/memory-rules", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.scope_forbidden" },
    });
  });

  it("serves background job inspection through scoped admin sessions", async () => {
    const inspectedJobIds: string[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        getBackgroundJobDebugDetails: async (backgroundJobId: string) => {
          inspectedJobIds.push(backgroundJobId);
          return backgroundJobDebugFixture({ backgroundJobId });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/jobs/job_1", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(200);
    expect(inspectedJobIds).toEqual(["job_1"]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        job: {
          backgroundJobId: "job_1",
          status: "failed",
        },
        failures: [{ code: "background_job.failed" }],
      },
    });
  });

  it("executes background job replay through scoped replay sessions", async () => {
    const executedJobIds: string[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        createBackgroundJobReplayPlan: async (backgroundJobId: string) =>
          backgroundJobReplayPlanFixture({ backgroundJobId }),
        executeBackgroundJobReplay: async (backgroundJobId: string) => {
          executedJobIds.push(backgroundJobId);
          return replayExecutionFixture({ action: "job.requeue" });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.replay.execute"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/jobs/job_1/replay", {
        method: "POST",
        body: JSON.stringify({ confirmationToken: "sha256:job-plan" }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(executedJobIds).toEqual(["job_1"]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        action: "job.requeue",
        insertedJobIds: ["job_replay"],
      },
    });
  });

  it("blocks cross-tenant background job replay plans before replaying jobs", async () => {
    let replayCalled = false;
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getRepositorySettings: async (repoId) => ({
          repository: {
            ...repositoryFixture,
            repoId,
            orgId: "org_2",
          },
          settings: {
            ...settingsFixture,
            repoId,
          },
        }),
      }),
      adminDebugService: createMockAdminDebugService({
        createBackgroundJobReplayPlan: async (backgroundJobId: string) =>
          backgroundJobReplayPlanFixture({
            backgroundJobId,
            job: replayJobPlanFixture({ orgId: "org_2", repoId: "repo_2" }),
          }),
        executeBackgroundJobReplay: async () => {
          replayCalled = true;
          return replayExecutionFixture({ action: "job.requeue" });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.replay.execute"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/jobs/job_2/replay", {
        method: "POST",
        body: JSON.stringify({ confirmationToken: "sha256:job-plan" }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(replayCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.scope_forbidden" },
    });
  });

  it("allows replay planning but blocks replay execution without execute permission", async () => {
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        getWebhookDebugDetails: async (webhookEventId: string) => ({
          webhookEvent: webhookSummary(webhookEventId),
          expectedJobKeys: [],
          relatedJobs: [],
          replayAudits: [],
          failures: [],
        }),
        createWebhookReplayPlan: async (webhookEventId: string) => ({
          action: "webhook.requeue_jobs",
          webhookEventId,
          deliveryId: "delivery-1",
          eligibleJobIds: [],
          blockedJobIds: ["job_running"],
          missingJobKeys: [],
          jobs: [],
          relatedJobs: [],
          failures: [],
          confirmationToken: "sha256:plan",
          requiresExplicitConfirmation: true,
        }),
        executeWebhookReplay: async () => {
          throw new Error("Replay execution should be permission-gated.");
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["*"],
      permissions: ["admin.inspect", "admin.replay.plan"],
      providerSubject: "usr_support",
    });

    const planResponse = await app.handle(
      new Request("http://localhost/admin/debug/webhooks/webhook_1/replay-plan", {
        method: "POST",
        headers: {
          cookie: login.cookie,
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );
    expect(planResponse.status).toBe(200);

    const replayResponse = await app.handle(
      new Request("http://localhost/admin/debug/webhooks/webhook_1/replay", {
        method: "POST",
        body: JSON.stringify({ confirmationToken: "sha256:plan" }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(replayResponse.status).toBe(403);
    await expect(replayResponse.json()).resolves.toMatchObject({
      error: { code: "admin.forbidden" },
    });
  });

  it("requires CSRF tokens for cookie-authenticated mutations", async () => {
    const securityEventSink = createMemorySecurityEventSink();
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        createWebhookReplayPlan: async (webhookEventId: string) => ({
          action: "webhook.requeue_jobs",
          webhookEventId,
          deliveryId: "delivery-1",
          eligibleJobIds: [],
          blockedJobIds: [],
          missingJobKeys: [],
          jobs: [],
          relatedJobs: [],
          failures: [],
          confirmationToken: "sha256:plan",
          requiresExplicitConfirmation: true,
        }),
      }),
      adminSecurityEventSink: securityEventSink,
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["*"],
      permissions: ["admin.replay.plan"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/webhooks/webhook_1/replay-plan", {
        method: "POST",
        headers: { cookie: login.cookie, origin: adminOrigin },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.csrf_forbidden" },
    });
    expect(securityEventSink.events()).toEqual([
      expect.objectContaining({
        actorId: "oidc:usr_support",
        metadata: expect.objectContaining({
          denialReason: "admin.csrf_forbidden",
          method: "POST",
          route: "/admin/debug/webhooks/webhook_1/replay-plan",
        }),
        resourceType: "admin_route",
        severity: "medium",
        source: "api",
        type: "admin_csrf_forbidden",
      }),
    ]);
  });

  it("updates repository settings through the control-plane service", async () => {
    const observabilitySink = createMemoryObservabilitySink();
    let observedPatch: UpdateRepositoryControlPlaneSettingsRequest | undefined;
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        updateRepositorySettings: async (_repoId, patch) => {
          observedPatch = patch;
          return {
            repository: { ...repositoryFixture, enabled: patch.repositoryEnabled ?? true },
            settings: {
              ...settingsFixture,
              severityThreshold: patch.severityThreshold ?? "medium",
            },
          };
        },
      }),
      adminObservabilitySink: observabilitySink,
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect", "admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/repos/repo_1/settings", {
        method: "PATCH",
        body: JSON.stringify({ repositoryEnabled: false, severityThreshold: "high" }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(observedPatch).toEqual({ repositoryEnabled: false, severityThreshold: "high" });
    await expect(response.json()).resolves.toMatchObject({
      data: {
        repository: { enabled: false, repoId: "repo_1" },
        settings: { severityThreshold: "high" },
      },
    });
    expect(observabilitySink.events().map((event) => event.name)).toContain(
      "admin.settings.updated",
    );
    expect(observabilitySink.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: {
            actionKind: "repo_settings.update",
            sourceEventName: "admin.settings.updated",
            status: "completed",
          },
          name: "admin.action.completed",
          repoId: "repo_1",
          statusCode: 200,
        }),
      ]),
    );
  });

  it("serves searchable audit history only to scoped audit viewers", async () => {
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        listAuditLogs: async (query) => [auditLog(`searched:${query.search ?? ""}`)],
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.audit.view"],
      providerSubject: "usr_auditor",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/audit-logs?orgId=org_1&search=settings", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        auditLogs: [{ action: "searched:settings" }],
      },
    });
  });

  it("serves searchable security events only to scoped audit viewers", async () => {
    const securityEventQueries: unknown[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        listSecurityEvents: async (query) => {
          securityEventQueries.push(query);
          return [
            securityEvent({
              actorId: query.actorId,
              repoId: query.repoId,
              resourceId: query.resourceId,
              resourceType: query.resourceType,
              severity: query.severity ?? "critical",
              source: query.source ?? "api",
              status: query.status ?? "new",
              type: query.type ?? "cross_tenant_access_attempt",
            }),
          ];
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.audit.view"],
      providerSubject: "usr_auditor",
    });

    const response = await app.handle(
      new Request(
        "http://localhost/admin/security-events?orgId=org_1&repoId=repo_1&type=cross_tenant_access_attempt&severity=critical&source=api&status=new&actorId=oidc%3Ausr_auditor&resourceType=organization&resourceId=org_2&search=cross&limit=3",
        {
          headers: { cookie: login.cookie },
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        securityEvents: [
          {
            actorId: "oidc:usr_auditor",
            repoId: "repo_1",
            severity: "critical",
            source: "api",
            status: "new",
            type: "cross_tenant_access_attempt",
          },
        ],
      },
    });
    expect(securityEventQueries).toEqual([
      {
        actorId: "oidc:usr_auditor",
        limit: 3,
        orgId: "org_1",
        repoId: "repo_1",
        resourceId: "org_2",
        resourceType: "organization",
        search: "cross",
        severity: "critical",
        source: "api",
        status: "new",
        type: "cross_tenant_access_attempt",
      },
    ]);
  });

  it("requires organization scope for scoped security event history viewers", async () => {
    let queried = false;
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        listSecurityEvents: async () => {
          queried = true;
          return [];
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.audit.view"],
      providerSubject: "usr_auditor",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/security-events?severity=critical", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(403);
    expect(queried).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "admin.security_event_scope_required",
      },
    });
  });

  it("serves scoped usage rollups to inspectors", async () => {
    const usageQueries: unknown[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        listUsageSummary: async (query) => {
          usageQueries.push(query);
          return usageSummaryFixture({
            rollups: [
              {
                orgId: "org_1",
                repoId: "repo_1",
                eventType: "llm.token",
                unit: "token",
                eventCount: 2,
                quantity: 1200,
                costMicros: 250,
              },
            ],
            totals: {
              eventCount: 2,
              costMicros: 250,
              reviewCount: 0,
              llmTokens: 1200,
            },
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/usage?orgId=org_1&periodStart=2026-05-01T00:00:00.000Z", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(200);
    expect(usageQueries).toContainEqual(
      expect.objectContaining({
        orgId: "org_1",
        periodStart: "2026-05-01T00:00:00.000Z",
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: {
        totals: { llmTokens: 1200, costMicros: 250 },
        rollups: [{ eventType: "llm.token", quantity: 1200 }],
      },
    });
  });

  it("serves provider-free entitlement decisions to scoped inspectors", async () => {
    const entitlementQueries: unknown[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getEntitlementSummary: async (query) => {
          entitlementQueries.push(query);
          return entitlementSummaryFixture({
            decisions: [
              {
                orgId: "org_1",
                featureKey: "reviews.inline_comments",
                allowed: true,
                reason: "enabled",
                source: "plan",
                value: true,
              },
            ],
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/entitlements?featureKey=reviews.inline_comments", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(200);
    expect(entitlementQueries).toContainEqual(
      expect.objectContaining({
        orgId: "org_1",
        featureKeys: ["reviews.inline_comments"],
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: {
        orgId: "org_1",
        planSnapshot: { planKey: "team" },
        decisions: [{ featureKey: "reviews.inline_comments", allowed: true }],
      },
    });
  });

  it("serves billing account state to scoped inspectors", async () => {
    const billingQueries: unknown[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getBillingSummary: async (query) => {
          billingQueries.push(query);
          return billingSummaryFixture({
            subscription: {
              billingAccountId: "bill_1",
              billingPlanVersionId: "planv_team_2026_01",
              cancelAtPeriodEnd: false,
              createdAt: "2026-05-05T12:00:00.000Z",
              currentPeriodEnd: "2026-06-01T00:00:00.000Z",
              currentPeriodStart: "2026-05-01T00:00:00.000Z",
              provider: "stripe",
              providerSubscriptionId: "sub_provider_123",
              quantity: 3,
              rawProviderStatus: { status: "active" },
              status: "active",
              subscriptionId: "sub_1",
              updatedAt: "2026-05-05T12:00:00.000Z",
            },
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/billing", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(200);
    expect(billingQueries).toContainEqual({ orgId: "org_1" });
    await expect(response.json()).resolves.toMatchObject({
      data: {
        billingAccount: { billingAccountId: "bill_1", provider: "stripe" },
        planSnapshot: { planKey: "team" },
        subscription: { subscriptionId: "sub_1", status: "active" },
      },
    });
  });

  it("serves billing meter event debug rows to scoped inspectors", async () => {
    const meterEventQueries: unknown[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        listBillingMeterEvents: async (query) => {
          meterEventQueries.push(query);
          return billingMeterEventsFixture({
            meterEvents: [
              {
                attemptCount: 1,
                billingAccountId: "bill_1",
                billingMeterEventId: "bmtr_1",
                createdAt: "2026-05-07T12:00:00.000Z",
                idempotencyKey: "stripe_meter:org_1:review_credits:2026-05",
                lastErrorCode: "stripe_unavailable",
                lastErrorMessage: "provider down",
                meterKey: "review_credits",
                orgId: "org_1",
                periodEnd: "2026-06-01T00:00:00.000Z",
                periodKey: "2026-05",
                periodStart: "2026-05-01T00:00:00.000Z",
                provider: "stripe",
                providerCustomerId: "cus_123",
                providerEventName: "review_credits",
                quantity: 4,
                sourceUsageEventIds: ["usage_1", "usage_2"],
                status: "failed",
                updatedAt: "2026-05-07T12:05:00.000Z",
              },
            ],
            periodKey: "2026-05",
            status: "failed",
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/billing/meter-events?status=failed&periodKey=2026-05", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(200);
    expect(meterEventQueries).toContainEqual(
      expect.objectContaining({
        orgId: "org_1",
        periodKey: "2026-05",
        status: "failed",
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: {
        meterEvents: [
          {
            billingMeterEventId: "bmtr_1",
            quantity: 4,
            sourceUsageEventIds: ["usage_1", "usage_2"],
            status: "failed",
          },
        ],
        orgId: "org_1",
      },
    });
  });

  it("serves billing reconciliation issues to scoped inspectors", async () => {
    const reconciliationQueries: unknown[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getBillingReconciliation: async (query) => {
          reconciliationQueries.push(query);
          return billingReconciliationFixture({
            issues: [
              {
                category: "meter_sync_failed",
                detail: "provider down",
                occurredAt: "2026-05-07T12:05:00.000Z",
                resourceId: "bmtr_1",
                resourceType: "billing_meter_event",
                severity: "critical",
                title: "review_credits 2026-05 failed",
              },
            ],
            periodKey: "2026-05",
          });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request(
        "http://localhost/admin/billing/reconciliation?periodKey=2026-05&meterLagMinutes=30",
        {
          headers: { cookie: login.cookie },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(reconciliationQueries).toContainEqual(
      expect.objectContaining({
        meterLagMinutes: 30,
        orgId: "org_1",
        periodKey: "2026-05",
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: {
        issues: [
          {
            category: "meter_sync_failed",
            resourceId: "bmtr_1",
            severity: "critical",
          },
        ],
        orgId: "org_1",
        periodKey: "2026-05",
      },
    });
  });

  it("enqueues scoped billing reconciliation jobs for billing managers", async () => {
    const reconciliationQueries: unknown[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        enqueueBillingReconciliation: async (query) => {
          reconciliationQueries.push(query);
          return {
            backgroundJobId: "job_billing_reconcile",
            jobKey: "admin:billing:reconcile:org_1:stripe:2026-05",
            status: "pending",
          };
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/billing/reconciliation/run?periodKey=2026-05", {
        headers: {
          cookie: login.cookie,
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(reconciliationQueries).toContainEqual(
      expect.objectContaining({
        orgId: "org_1",
        periodKey: "2026-05",
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: {
        backgroundJobId: "job_billing_reconcile",
        status: "pending",
      },
    });
  });

  it("creates scoped billing checkout and portal sessions for billing managers", async () => {
    const checkoutRequests: unknown[] = [];
    const portalRequests: unknown[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        createBillingCheckoutSession: async (request) => {
          checkoutRequests.push(request);
          return {
            checkoutSessionId: "cs_stripe_123",
            expiresAt: "2026-05-07T13:00:00.000Z",
            provider: "stripe",
            url: "https://checkout.stripe.test/session",
          };
        },
        createBillingPortalSession: async (request) => {
          portalRequests.push(request);
          return {
            portalSessionId: "bps_stripe_123",
            provider: "stripe",
            url: "https://billing.stripe.test/session",
          };
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const checkoutResponse = await app.handle(
      new Request("http://localhost/admin/billing/checkout-session", {
        body: JSON.stringify({
          cancelUrl: "https://app.example.test/billing",
          planKey: "team",
          quantity: 3,
          successUrl: "https://app.example.test/billing/success",
        }),
        headers: {
          "content-type": "application/json",
          cookie: login.cookie,
          "idempotency-key": "idem_checkout",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "POST",
      }),
    );
    const portalResponse = await app.handle(
      new Request("http://localhost/admin/billing/portal-session", {
        body: JSON.stringify({
          returnUrl: "https://app.example.test/billing",
        }),
        headers: {
          "content-type": "application/json",
          cookie: login.cookie,
          "idempotency-key": "idem_portal",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
        method: "POST",
      }),
    );

    expect(checkoutResponse.status).toBe(200);
    expect(portalResponse.status).toBe(200);
    expect(checkoutRequests).toContainEqual(
      expect.objectContaining({
        orgId: "org_1",
        planKey: "team",
        quantity: 3,
      }),
    );
    expect(portalRequests).toContainEqual(
      expect.objectContaining({
        orgId: "org_1",
        returnUrl: "https://app.example.test/billing",
      }),
    );
    await expect(checkoutResponse.json()).resolves.toMatchObject({
      data: { checkoutSessionId: "cs_stripe_123", provider: "stripe" },
    });
    await expect(portalResponse.json()).resolves.toMatchObject({
      data: { portalSessionId: "bps_stripe_123", provider: "stripe" },
    });
  });

  it("serves repository rules only to scoped inspectors", async () => {
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        listRepositoryRules: async (repoId) => [
          repoRuleSummaryFixture({
            repoId,
            instruction: "Skip generated files.",
            body: "Skip generated files.",
          }),
        ],
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/repos/repo_1/rules", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        rules: [{ body: "Skip generated files.", repoRuleId: "rule_1" }],
      },
    });
  });

  it("creates, updates, and deletes repository rules through the control-plane service", async () => {
    const calls: string[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        createRepositoryRule: async (_repoId, request) => {
          calls.push(`create:${request.effect}:${request.name}`);
          return repoRuleSummaryFixture({
            name: request.name,
            effect: request.effect,
            instruction: request.instruction,
            body: request.instruction,
          });
        },
        updateRepositoryRule: async (_repoId, ruleId, request) => {
          calls.push(`update:${ruleId}:${request.enabled}`);
          return repoRuleSummaryFixture({ ruleId, repoRuleId: ruleId, enabled: false });
        },
        deleteRepositoryRule: async (_repoId, ruleId) => {
          calls.push(`delete:${ruleId}`);
          return repoRuleSummaryFixture({ ruleId, repoRuleId: ruleId });
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect", "admin.settings.manage"],
      providerSubject: "usr_admin",
    });

    const createResponse = await app.handle(
      new Request("http://localhost/admin/repos/repo_1/rules", {
        method: "POST",
        body: JSON.stringify({
          name: "Suppress generated clients",
          effect: "suppress",
          matcher: { paths: ["src/generated/**"] },
          instruction: "Do not publish generated-client findings.",
          priority: 100,
          enabled: true,
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );
    const updateResponse = await app.handle(
      new Request("http://localhost/admin/repos/repo_1/rules/rule_1", {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );
    const deleteResponse = await app.handle(
      new Request("http://localhost/admin/repos/repo_1/rules/rule_1", {
        method: "DELETE",
        headers: {
          cookie: login.cookie,
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(createResponse.status).toBe(200);
    expect(updateResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(calls).toEqual([
      "create:suppress:Suppress generated clients",
      "update:rule_1:false",
      "delete:rule_1",
    ]);
    await expect(createResponse.json()).resolves.toMatchObject({
      data: { effect: "suppress", name: "Suppress generated clients" },
    });
  });

  it("previews repository policy with a draft settings patch", async () => {
    let observedPatch: UpdateRepositoryControlPlaneSettingsRequest | undefined;
    let observedTestPath: string | undefined;
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        previewRepositoryPolicy: async (_repoId, patch) => {
          observedPatch = patch;
          const result = buildReviewPolicySnapshot({
            repository: repositoryFixture,
            settings: {
              ...settingsFixture,
              ...patch,
              maxCommentsPerReview:
                patch.maxCommentsPerReview ?? settingsFixture.maxCommentsPerReview,
              reviewPolicy: patch.reviewPolicy ?? settingsFixture.reviewPolicy,
            },
          });
          return {
            effectivePolicy: result.snapshot.effectivePolicy,
            policyHash: "sha256:preview",
            policySnapshotId: "pol_preview",
            trace: result.trace,
            warnings: [
              {
                code: "comment_budget_clamped_by_safety_floor",
                message: "Repository comment budget was clamped by the safety floor.",
              },
            ],
          };
        },
        testRepositoryPolicy: async (_repoId, request) => {
          observedTestPath = request.finding.location.path;
          const result = buildReviewPolicySnapshot({
            repository: repositoryFixture,
            settings: settingsFixture,
          });
          return {
            findingDecision: {
              reasonCode: "below_severity_threshold",
              severity: request.finding.severity,
              shouldPublish: false,
              trace: result.trace,
            },
            pathClassification: {
              config: false,
              documentation: false,
              generated: false,
              ignored: false,
              included: true,
              matchedPatterns: [],
              path: request.finding.location.path,
              reasonCodes: ["path_included"],
              test: false,
              trace: result.trace,
              vendored: false,
            },
            preview: {
              effectivePolicy: result.snapshot.effectivePolicy,
              policyHash: "sha256:policy-test",
              policySnapshotId: "pol_policy_test",
              trace: result.trace,
              warnings: result.warnings,
            },
          };
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/repos/repo_1/policy-preview", {
        method: "POST",
        body: JSON.stringify({ maxCommentsPerReview: 50, reviewPolicy: "summary_only" }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );
    const testResponse = await app.handle(
      new Request("http://localhost/admin/repos/repo_1/policy-test", {
        method: "POST",
        body: JSON.stringify({
          settingsPatch: { severityThreshold: "high" },
          finding: {
            body: "The changed line can return NaN.",
            category: "correctness",
            confidence: 0.82,
            location: {
              isInDiff: true,
              line: 2,
              path: "src/math.ts",
              side: "RIGHT",
            },
            severity: "medium",
            title: "Handle non-finite numeric inputs",
          },
        }),
        headers: {
          cookie: login.cookie,
          "content-type": "application/json",
          origin: adminOrigin,
          "x-csrf-token": login.csrfToken,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(testResponse.status).toBe(200);
    expect(observedPatch).toEqual({ maxCommentsPerReview: 50, reviewPolicy: "summary_only" });
    expect(observedTestPath).toBe("src/math.ts");
    await expect(response.json()).resolves.toMatchObject({
      data: {
        effectivePolicy: { reviewPolicy: "summary_only" },
        policyHash: "sha256:preview",
        warnings: [{ code: "comment_budget_clamped_by_safety_floor" }],
      },
    });
    await expect(testResponse.json()).resolves.toMatchObject({
      data: {
        findingDecision: { reasonCode: "below_severity_threshold", shouldPublish: false },
        pathClassification: { included: true, path: "src/math.ts" },
        preview: { policyHash: "sha256:policy-test" },
      },
    });
  });

  it("serves scoped repository and review discovery without pasted IDs", async () => {
    const repositoryQueries: unknown[] = [];
    const reviewQueries: unknown[] = [];
    const reviewMetricQueries: unknown[] = [];
    const auditQueries: unknown[] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        listAuditLogs: async (query) => {
          auditQueries.push(query);
          return [auditLog("repo.settings.updated")];
        },
        listRepositories: async (query) => {
          repositoryQueries.push(query);
          return [
            {
              ...repositoryFixture,
              latestReviewRunId: "rrn_1",
              latestReviewStatus: "completed",
              latestReviewUpdatedAt: "2026-05-05T12:30:00.000Z",
            },
          ];
        },
        listReviewRuns: async (query) => {
          reviewQueries.push(query);
          return [reviewRunSummaryFixture];
        },
        getReviewMetricsSummary: async (query) => {
          reviewMetricQueries.push(query);
          return reviewMetricsFixture();
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
      readinessCheck: async () => [
        { name: "config", status: "pass" },
        { name: "postgres", status: "pass" },
      ],
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect", "admin.audit.view"],
      providerSubject: "usr_support",
    });

    const overviewResponse = await app.handle(
      new Request("http://localhost/admin/overview?limit=12", {
        headers: { cookie: login.cookie },
      }),
    );
    const repositoriesResponse = await app.handle(
      new Request("http://localhost/admin/repos?search=heimdall", {
        headers: { cookie: login.cookie },
      }),
    );
    const reviewsResponse = await app.handle(
      new Request("http://localhost/admin/reviews?repoId=repo_1&status=completed", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(overviewResponse.status).toBe(200);
    await expect(overviewResponse.json()).resolves.toMatchObject({
      data: {
        recentAuditLogs: [{ action: "repo.settings.updated" }],
        recentReviews: [{ reviewRunId: "rrn_1", repoFullName: "octo-org/heimdall" }],
        repositories: [{ fullName: "octo-org/heimdall", latestReviewRunId: "rrn_1" }],
        reviewMetrics: {
          completedRuns: 2,
          medianDurationMs: 1200,
          p95DurationMs: 2800,
          totalRuns: 4,
        },
        runtimeHealth: {
          checks: [
            { name: "config", status: "pass" },
            { name: "postgres", status: "pass" },
          ],
          ok: true,
          service: "api",
          status: "pass",
        },
      },
    });
    expect(reviewMetricQueries).toEqual([
      expect.objectContaining({ limit: 12, orgIds: ["org_1"] }),
    ]);
    expect(repositoriesResponse.status).toBe(200);
    await expect(repositoriesResponse.json()).resolves.toMatchObject({
      data: {
        repositories: [{ repoId: "repo_1" }],
      },
    });
    expect(reviewsResponse.status).toBe(200);
    await expect(reviewsResponse.json()).resolves.toMatchObject({
      data: {
        reviews: [{ reviewRunId: "rrn_1" }],
      },
    });
    expect(repositoryQueries).toContainEqual(
      expect.objectContaining({ orgIds: ["org_1"], search: "heimdall" }),
    );
    expect(reviewQueries).toContainEqual(
      expect.objectContaining({ orgIds: ["org_1"], repoId: "repo_1", status: "completed" }),
    );
    expect(auditQueries).toContainEqual(expect.objectContaining({ orgId: "org_1" }));
  });

  it("serves evaluation history suites, runs, and case results", async () => {
    const suiteQueries: Parameters<AdminControlPlaneService["listEvaluationSuites"]>[0][] = [];
    const runQueries: Parameters<AdminControlPlaneService["listEvaluationRuns"]>[0][] = [];
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getEvaluationRun: async (evalRunId) =>
          evaluationRunDetailsFixture({
            run: evaluationRunFixture({ evalRunId }),
          }),
        listEvaluationRuns: async (query) => {
          runQueries.push(query);
          return [evaluationRunFixture({ evalSuiteId: query.evalSuiteId })];
        },
        listEvaluationSuites: async (query) => {
          suiteQueries.push(query);
          return [evaluationSuiteFixture()];
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const suitesResponse = await app.handle(
      new Request("http://localhost/admin/evaluation/suites?limit=5", {
        headers: { cookie: login.cookie },
      }),
    );
    const runsResponse = await app.handle(
      new Request("http://localhost/admin/evaluation/suites/smoke-full-pipeline-v1/runs?limit=3", {
        headers: { cookie: login.cookie },
      }),
    );
    const runResponse = await app.handle(
      new Request("http://localhost/admin/evaluation/runs/eval_run_1", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(suitesResponse.status).toBe(200);
    expect(runsResponse.status).toBe(200);
    expect(runResponse.status).toBe(200);
    await expect(suitesResponse.json()).resolves.toMatchObject({
      data: {
        suites: [
          {
            activeBaseline: { baselineVariantId: "variant_baseline" },
            evalSuiteId: "smoke-full-pipeline-v1",
            latestRun: { evalRunId: "eval_run_1", status: "passed" },
          },
        ],
      },
    });
    await expect(runsResponse.json()).resolves.toMatchObject({
      data: {
        runs: [{ evalSuiteId: "smoke-full-pipeline-v1", evalRunId: "eval_run_1" }],
      },
    });
    await expect(runResponse.json()).resolves.toMatchObject({
      data: {
        caseResults: [{ evalCaseId: "case_auth_regression", status: "passed" }],
        run: { evalRunId: "eval_run_1" },
      },
    });
    expect(suiteQueries).toEqual([expect.objectContaining({ limit: 5 })]);
    expect(runQueries).toEqual([
      expect.objectContaining({ evalSuiteId: "smoke-full-pipeline-v1", limit: 3 }),
    ]);
  });

  it("scope-checks publisher debug details by review repository even without publish jobs", async () => {
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        getRepositorySettings: async (repoId) => ({
          repository: {
            ...repositoryFixture,
            repoId,
            orgId: "org_2",
          },
          settings: {
            ...settingsFixture,
            repoId,
          },
        }),
      }),
      adminDebugService: createMockAdminDebugService({
        getPublisherDebugDetails: async (reviewRunId: string) => ({
          reviewRunId,
          repoId: "repo_2",
          publishRuns: [],
          operations: [],
          outputs: {
            checkRuns: [],
            reviews: [],
            summaryComments: [],
            findings: [],
          },
          relatedJobs: [],
          replayAudits: [],
          reconciliation: {
            reviewRunId,
            status: "missing",
            operationCount: 0,
            checkRunCount: 0,
            reviewCount: 0,
            summaryCommentCount: 0,
            publishedFindingCount: 0,
            issues: [],
          },
          failures: [],
        }),
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["org_1"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/publisher/rrn_2", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin.scope_forbidden" },
    });
  });

  it("maps missing admin resources to 404 responses", async () => {
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminDebugService: createMockAdminDebugService({
        getPublisherDebugDetails: async () => {
          throw new AdminDebugNotFoundError("review_run", "rrn_missing");
        },
      }),
      githubWebhookHandler: noopWebhookHandler(),
    });
    const login = await loginSession(app, {
      orgIds: ["*"],
      permissions: ["admin.inspect"],
      providerSubject: "usr_support",
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/publisher/rrn_missing", {
        headers: { cookie: login.cookie },
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "admin.not_found",
        details: {
          resourceType: "review_run",
          resourceId: "rrn_missing",
        },
      },
    });
  });
});

/** No-op webhook handler used by API route tests. */
function noopWebhookHandler() {
  return {
    handle: async () => ({
      status: "ignored",
      deliveryId: "delivery-1",
      webhookEventId: "webhook_1",
      jobs: [],
    }),
  } as never;
}

/** Computes a GitHub-style HMAC SHA-256 webhook signature for route tests. */
function githubWebhookSignature(secret: string, rawBody: Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** Creates a signed IdP login request. */
function signedLoginRequest(input: {
  /** Provider subject for the actor. */
  readonly providerSubject: string;
  /** Granted permissions. */
  readonly permissions: readonly Parameters<
    typeof signAdminIdentityAssertion
  >[0]["permissions"][number][];
  /** Granted organization scopes. */
  readonly orgIds?: readonly string[];
  /** Granted repository scopes. */
  readonly repoIds?: readonly string[];
  /** Actor email. */
  readonly email?: string;
  /** Additional request headers. */
  readonly headers?: HeadersInit;
  /** Whether to include the default allowed origin header. */
  readonly includeOrigin?: boolean;
}): Request {
  const signed = signAdminIdentityAssertion(
    {
      provider: "oidc",
      providerSubject: input.providerSubject,
      permissions: input.permissions,
      orgIds: input.orgIds ?? ["*"],
      repoIds: input.repoIds ?? [],
      email: input.email,
    },
    "assertion-secret-with-at-least-32-chars",
  );

  return new Request("http://localhost/admin/auth/login", {
    method: "POST",
    headers: {
      ...(input.includeOrigin === false ? {} : { origin: adminOrigin }),
      "x-heimdall-idp-assertion": signed.encodedAssertion,
      "x-heimdall-idp-signature": signed.signature,
      "x-heimdall-idp-timestamp": signed.timestamp,
      ...input.headers,
    },
  });
}

/** Login session details used by authenticated route tests. */
type TestLoginSession = {
  /** Cookie header value for the signed session. */
  readonly cookie: string;
  /** CSRF token returned by the login response. */
  readonly csrfToken: string;
};

/** Creates an authenticated admin session for tests. */
async function loginSession(
  app: ReturnType<typeof createApiApp>,
  input: Parameters<typeof signedLoginRequest>[0],
): Promise<TestLoginSession> {
  const response = await app.handle(signedLoginRequest(input));
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) {
    throw new Error("Login response did not include a session cookie.");
  }

  const body = (await response.json()) as { data?: { csrfToken?: string } };
  if (!body.data?.csrfToken) {
    throw new Error("Login response did not include a CSRF token.");
  }

  return { cookie, csrfToken: body.data.csrfToken };
}

/** Restores a set of environment variables after a route test mutates process.env. */
function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/** Creates a mock admin/debug service. */
function createMockAdminDebugService(overrides: Partial<AdminDebugService>): AdminDebugService {
  const unexpectedCall = async () => {
    throw new Error("Unexpected admin debug service call.");
  };

  return {
    getWebhookDebugDetails: unexpectedCall,
    createWebhookReplayPlan: unexpectedCall,
    executeWebhookReplay: unexpectedReplayCall,
    getBackgroundJobDebugDetails: unexpectedCall,
    createBackgroundJobReplayPlan: unexpectedCall,
    executeBackgroundJobReplay: unexpectedReplayCall,
    getReviewDebugDetails: unexpectedCall,
    createReviewReplayPlan: unexpectedCall,
    replayRetrievalDryRun: unexpectedCall,
    replayValidationDryRun: unexpectedCall,
    executeReviewReplay: unexpectedReplayCall,
    exportReviewRunDebugBundle: unexpectedDebugBundleCall,
    createReviewRunEvalImportDraft: unexpectedEvalImportCall,
    getMemoryRulesDebugDetails: unexpectedCall,
    getUsageCostInspection: unexpectedCall,
    getPublisherDebugDetails: unexpectedCall,
    createPublisherReplayPlan: unexpectedCall,
    executePublisherReplay: unexpectedReplayCall,
    ...overrides,
  };
}

/** Creates a mock control-plane service. */
function createMockControlPlaneService(
  overrides: Partial<AdminControlPlaneService>,
): AdminControlPlaneService {
  return {
    createBillingCheckoutSession: async () => ({
      checkoutSessionId: "cs_1",
      expiresAt: "2026-05-07T13:00:00.000Z",
      provider: "stripe",
      url: "https://checkout.stripe.test/session",
    }),
    createBillingPortalSession: async () => ({
      portalSessionId: "bps_1",
      provider: "stripe",
      url: "https://billing.stripe.test/session",
    }),
    approveMemoryCandidate: async () => memoryCandidateApprovalFixture(),
    createRepositoryMemoryFact: async () => memoryFactFixture(),
    createRepositoryRule: async () => repoRuleSummaryFixture(),
    createReviewArtifactDownloadUrl: async () => reviewArtifactDownloadUrlFixture(),
    deleteMemoryFact: async () => memoryFactFixture({ enabled: false, status: "disabled" }),
    deleteRepositoryRule: async () => repoRuleSummaryFixture(),
    enqueueBillingReconciliation: async () => ({
      backgroundJobId: "job_billing_reconcile",
      jobKey: "admin:billing:reconcile:org_1:stripe:2026-05",
      status: "pending",
    }),
    enqueueInstallationSync: async () => installationSyncRunFixture(),
    enqueueReviewRerun: async () => reviewRerunRunFixture(),
    enqueueRepositoryReindex: async () => repositoryJobRunFixture(),
    enqueueRepositorySync: async () =>
      repositoryJobRunFixture({
        jobKey: "api:repository:sync:repo_1:idem_repo",
      }),
    getRepositorySettings: async () => ({
      repository: repositoryFixture,
      settings: settingsFixture,
    }),
    getBillingSummary: async () => billingSummaryFixture(),
    getEntitlementSummary: async () => entitlementSummaryFixture(),
    getBillingReconciliation: async () => billingReconciliationFixture(),
    getEvaluationRun: async () => evaluationRunDetailsFixture(),
    getMemoryCandidate: async () => memoryCandidateFixture(),
    getMemoryFact: async () => memoryFactFixture(),
    getOrganization: async () => organizationFixture(),
    getProductUsageSummary: async () => productUsageSummaryFixture(),
    getProviderInstallation: async () => providerInstallationFixture(),
    listBillingMeterEvents: async () => billingMeterEventsFixture(),
    listRepositoryMemoryCandidates: async () => [memoryCandidateFixture()],
    listRepositoryMemoryFacts: async () => [memoryFactFixture()],
    getReviewArtifactPayload: async () => reviewArtifactPayloadFixture(),
    getReviewFinding: async () => reviewFindingFixture(),
    getReviewMetricsSummary: async () => reviewMetricsFixture(),
    getReviewRun: async () => reviewRunSummaryFixture,
    listReviewArtifacts: async () => [reviewArtifactFixture()],
    listOrganizations: async () => [organizationFixture()],
    listProductUsageEvents: async () => [productUsageEventFixture()],
    listProviderInstallations: async () => [providerInstallationFixture()],
    listRepositories: async () => [repositoryFixture],
    listEvaluationRuns: async () => [evaluationRunFixture()],
    listEvaluationSuites: async () => [evaluationSuiteFixture()],
    listRepositoryRules: async () => [],
    listReviewFindings: async () => [reviewFindingFixture()],
    listReviewRuns: async () => [reviewRunSummaryFixture],
    listSecurityEvents: async () => [],
    listUsageSummary: async () => usageSummaryFixture(),
    previewRepositoryPolicy: async () => {
      const result = buildReviewPolicySnapshot({
        repository: repositoryFixture,
        settings: settingsFixture,
      });
      return {
        effectivePolicy: result.snapshot.effectivePolicy,
        policyHash: result.snapshot.policyHash,
        policySnapshotId: result.snapshot.policySnapshotId,
        trace: result.trace,
        warnings: result.warnings,
      };
    },
    testRepositoryPolicy: async () => {
      const result = buildReviewPolicySnapshot({
        repository: repositoryFixture,
        settings: settingsFixture,
      });
      return {
        findingDecision: {
          reasonCode: "finding_allowed",
          severity: "medium",
          shouldPublish: true,
          trace: result.trace,
        },
        pathClassification: {
          config: false,
          documentation: false,
          generated: false,
          ignored: false,
          included: true,
          matchedPatterns: [],
          path: "src/math.ts",
          reasonCodes: ["path_included"],
          test: false,
          trace: result.trace,
          vendored: false,
        },
        preview: {
          effectivePolicy: result.snapshot.effectivePolicy,
          policyHash: result.snapshot.policyHash,
          policySnapshotId: result.snapshot.policySnapshotId,
          trace: result.trace,
          warnings: result.warnings,
        },
      };
    },
    listAuditLogs: async () => [],
    recordFindingOutcome: async () => findingOutcomeRecordFixture(),
    rejectMemoryCandidate: async () => memoryCandidateRejectionFixture(),
    suppressSimilarFinding: async () => findingSuppressionFixture(),
    recordAuditEvent: async (event) => auditLog(event.action),
    updateMemoryFact: async () => memoryFactFixture(),
    updateRepositoryRule: async () => repoRuleSummaryFixture(),
    updateRepositorySettings: async () => ({
      repository: repositoryFixture,
      settings: settingsFixture,
    }),
    ...overrides,
  };
}

/** Creates an organization fixture. */
function organizationFixture(
  overrides: Partial<AdminOrganizationFixture> = {},
): AdminOrganizationFixture {
  return {
    createdAt: "2026-05-05T12:00:00.000Z",
    installationCount: 1,
    metadata: {
      plan: "team",
    },
    name: "Octo Org",
    orgId: "org_1",
    repositoryCount: 2,
    slug: "octo-org",
    updatedAt: "2026-05-05T12:30:00.000Z",
    ...overrides,
  };
}

/** Creates a provider installation fixture. */
function providerInstallationFixture(
  overrides: Partial<AdminProviderInstallationFixture> = {},
): AdminProviderInstallationFixture {
  return {
    accountLogin: "octo-org",
    accountType: "Organization",
    installationId: "inst_1",
    installedAt: "2026-05-05T12:00:00.000Z",
    orgId: "org_1",
    permissions: {
      contents: "read",
      pull_requests: "write",
    },
    provider: "github",
    providerInstallationId: "12345",
    ...overrides,
  };
}

/** Creates an installation sync enqueue fixture. */
function installationSyncRunFixture(
  overrides: Partial<AdminInstallationSyncRunFixture> = {},
): AdminInstallationSyncRunFixture {
  return {
    auditLogId: "audit_sync",
    backgroundJobId: "job_sync",
    jobKey: "api:installation:sync:inst_1:idem_sync",
    status: "pending",
    ...overrides,
  };
}

/** Creates a repository job enqueue fixture. */
function repositoryJobRunFixture(
  overrides: Partial<AdminRepositoryJobRunFixture> = {},
): AdminRepositoryJobRunFixture {
  return {
    auditLogId: "audit_repo_job",
    backgroundJobId: "job_repo",
    jobKey: "api:repository:reindex:repo_1:abcdef1234567890:idem_reindex",
    status: "pending",
    ...overrides,
  };
}

/** Creates a review rerun enqueue fixture. */
function reviewRerunRunFixture(
  overrides: Partial<AdminReviewRerunRunFixture> = {},
): AdminReviewRerunRunFixture {
  return {
    auditLogId: "audit_review_rerun",
    backgroundJobId: "job_review",
    jobKey: "api:review:rerun:rrn_1:idem_review",
    sourceReviewRunId: "rrn_1",
    status: "pending",
    ...overrides,
  };
}

/** Creates a review artifact metadata fixture. */
function reviewArtifactFixture(
  overrides: Partial<AdminReviewArtifactFixture> = {},
): AdminReviewArtifactFixture {
  return {
    classification: "customer_confidential",
    createdAt: "2026-05-05T12:15:00.000Z",
    hash: "sha256:artifact-hash",
    hasStoredPayload: false,
    kind: "policy_snapshot",
    metadataKeys: [],
    name: "Review policy snapshot",
    repoId: "repo_1",
    retentionUntil: "2026-06-05T12:15:00.000Z",
    reviewArtifactId: "art_1",
    reviewRunId: "rrn_1",
    sizeBytes: 128,
    uri: "artifact://reviews/rrn_1/policy_snapshot.json",
    ...overrides,
  };
}

/** Creates a review artifact payload fixture. */
function reviewArtifactPayloadFixture(
  overrides: Partial<AdminReviewArtifactPayloadFixture> = {},
): AdminReviewArtifactPayloadFixture {
  return {
    accessLevel: "redacted",
    artifact: reviewArtifactFixture({
      hasStoredPayload: true,
      metadataKeys: ["payload"],
    }),
    artifactAccessEventId: "artaccess_1",
    payload: {
      schemaVersion: "context_bundle.v1",
      items: [
        {
          path: "src/provider.ts",
          snippet: {
            redacted: true,
            key: "snippet",
            reason: "sensitive_field",
            sha256: "sha256:redacted",
            sizeBytes: 64,
            valueType: "string",
          },
          title: "Provider context",
        },
      ],
    },
    ...overrides,
  };
}

/** Creates a review artifact signed download URL fixture. */
function reviewArtifactDownloadUrlFixture(
  overrides: Partial<AdminReviewArtifactDownloadUrlFixture> = {},
): AdminReviewArtifactDownloadUrlFixture {
  return {
    accessLevel: "raw_allowed",
    artifact: reviewArtifactFixture({
      hasStoredPayload: true,
      metadataKeys: ["payloadStorage"],
      name: "provider prompt.json",
    }),
    artifactAccessEventId: "artaccess_1",
    expiresAt: "2026-05-07T12:05:00.000Z",
    url: "https://objects.example.test/heimdall-artifacts/provider-prompt.json?X-Amz-Signature=abc",
    ...overrides,
  };
}

/** Creates a review finding fixture. */
function reviewFindingFixture(
  overrides: Partial<AdminReviewFindingFixture> = {},
): AdminReviewFindingFixture {
  return {
    body: "Use a bounded retry policy for provider calls.",
    candidateFindingId: "fnd_candidate_1",
    category: "reliability",
    confidence: 0.92,
    decision: "publish",
    evidence: [
      {
        confidence: 0.9,
        evidenceId: "ev_1",
        kind: "diff",
        path: "src/provider.ts",
        summary: "The changed call retries without a cap.",
      },
    ],
    findingId: "fnd_validated_1",
    fingerprint: "review-finding-fingerprint",
    latestOutcome: findingOutcomeFixture(),
    location: {
      line: 42,
      path: "src/provider.ts",
      side: "RIGHT",
    },
    orgId: "org_1",
    publication: {
      provider: "github",
      providerCommentId: "123",
      publishedAt: "2026-05-05T12:31:00.000Z",
      publishedFindingId: "fnd_published_1",
      status: "published",
    },
    publishedFindingId: "fnd_published_1",
    repoFullName: "octo-org/heimdall",
    repoId: "repo_1",
    reviewRunId: "rrn_1",
    severity: "medium",
    title: "Provider retry loop is unbounded",
    validation: {
      reasons: [],
      validatedAt: "2026-05-05T12:29:00.000Z",
      validatorVersion: "validator-test",
    },
    ...overrides,
  };
}

/** Creates a finding outcome fixture. */
function findingOutcomeFixture(
  overrides: Partial<AdminFindingOutcomeRecordFixture["outcome"]> = {},
): AdminFindingOutcomeRecordFixture["outcome"] {
  return {
    createdAt: "2026-05-05T12:40:00.000Z",
    findingOutcomeId: "out_1",
    occurredAt: "2026-05-05T12:39:00.000Z",
    outcome: "accepted",
    source: "user_action",
    ...overrides,
  };
}

/** Creates a finding outcome mutation fixture. */
function findingOutcomeRecordFixture(
  overrides: Partial<AdminFindingOutcomeRecordFixture> = {},
): AdminFindingOutcomeRecordFixture {
  const outcome = findingOutcomeFixture();
  return {
    auditLogId: "audit_finding_outcome",
    finding: reviewFindingFixture({ latestOutcome: outcome }),
    outcome,
    ...overrides,
  };
}

/** Creates a finding suppression helper fixture. */
function findingSuppressionFixture(
  overrides: Partial<AdminFindingSuppressionFixture> = {},
): AdminFindingSuppressionFixture {
  return {
    auditLogId: "audit_finding_suppression",
    finding: reviewFindingFixture(),
    rule: repoRuleSummaryFixture({
      effect: "suppress",
      instruction: "Suppress findings with the same title in src/provider.ts.",
      matcher: { paths: ["src/provider.ts"], titleRegex: "^Provider retry loop is unbounded$" },
      name: "Suppress similar: Provider retry loop is unbounded",
      priority: 100,
    }),
    scope: "repo",
    ...overrides,
  };
}

/** Creates a memory fact fixture. */
function memoryFactFixture(
  overrides: Partial<AdminMemoryFactFixture> = {},
): AdminMemoryFactFixture {
  return {
    body: "Prefer bounded retries for provider calls.",
    confidence: 1,
    createdAt: "2026-05-05T12:00:00.000Z",
    enabled: true,
    factType: "repo_convention",
    kind: "repo_convention",
    memoryFactId: "mem_1",
    metadata: {
      source: "manual",
      subject: "Provider retry policy",
    },
    orgId: "org_1",
    repoId: "repo_1",
    scope: "repository",
    source: "manual",
    status: "active",
    subject: "Provider retry policy",
    text: "Prefer bounded retries for provider calls.",
    updatedAt: "2026-05-05T12:00:00.000Z",
    ...overrides,
  };
}

/** Creates a memory candidate fixture. */
function memoryCandidateFixture(
  overrides: Partial<AdminMemoryCandidateFixture> = {},
): AdminMemoryCandidateFixture {
  return {
    candidateKind: "repo_fact",
    confidence: 0.8,
    createdAt: "2026-05-05T12:00:00.000Z",
    createdByLogin: "maintainer",
    memoryCandidateId: "mcand_1",
    metadata: {
      source: "feedback",
    },
    orgId: "org_1",
    proposedAppliesTo: {
      pathGlobs: ["src/**"],
    },
    proposedContent: "Prefer bounded retries for provider calls.",
    proposedScope: {
      level: "repository",
      orgId: "org_1",
      repoId: "repo_1",
    },
    repoId: "repo_1",
    sourceKind: "comment_feedback",
    status: "pending",
    trustLevel: "explicit_maintainer",
    updatedAt: "2026-05-05T12:00:00.000Z",
    ...overrides,
  };
}

/** Creates a memory candidate approval fixture. */
function memoryCandidateApprovalFixture(
  overrides: Partial<AdminMemoryCandidateApprovalFixture> = {},
): AdminMemoryCandidateApprovalFixture {
  return {
    auditLogId: "audit_memory_candidate_approval",
    candidate: memoryCandidateFixture({
      approvedMemoryFactId: "mem_from_candidate",
      decidedAt: "2026-05-05T13:00:00.000Z",
      decidedByUserId: "usr_admin",
      status: "approved",
    }),
    memoryFact: memoryFactFixture({
      memoryFactId: "mem_from_candidate",
      metadata: {
        memoryCandidateId: "mcand_1",
        source: "feedback",
      },
      source: "feedback",
    }),
    ...overrides,
  };
}

/** Creates a memory candidate rejection fixture. */
function memoryCandidateRejectionFixture(
  overrides: Partial<AdminMemoryCandidateRejectionFixture> = {},
): AdminMemoryCandidateRejectionFixture {
  return {
    auditLogId: "audit_memory_candidate_rejection",
    candidate: memoryCandidateFixture({
      decidedAt: "2026-05-05T13:00:00.000Z",
      decidedByUserId: "usr_admin",
      status: "rejected",
    }),
    ...overrides,
  };
}

/** Creates an evaluation run fixture. */
function evaluationRunFixture(
  overrides: Partial<AdminEvaluationRunFixture> = {},
): AdminEvaluationRunFixture {
  return {
    branch: "main",
    caseCount: 12,
    completedAt: "2026-05-05T12:10:00.000Z",
    environment: "ci",
    evalRunId: "eval_run_1",
    evalSuiteId: "smoke-full-pipeline-v1",
    evalVariantId: "variant_current",
    gitCommitSha: "abc1234",
    reportUri: "file:///tmp/eval-report.md",
    startedAt: "2026-05-05T12:00:00.000Z",
    status: "passed",
    summary: {
      anchorAccuracy: 1,
      falsePositiveCount: 0,
      recall: 1,
    },
    triggeredBy: "ci",
    ...overrides,
  };
}

/** Creates an evaluation suite fixture. */
function evaluationSuiteFixture(
  overrides: Partial<AdminEvaluationSuiteFixture> = {},
): AdminEvaluationSuiteFixture {
  return {
    activeBaseline: {
      active: true,
      baselineVariantId: "variant_baseline",
      createdAt: "2026-05-05T11:00:00.000Z",
      evalRunId: "eval_run_baseline",
      evalSuiteId: "smoke-full-pipeline-v1",
    },
    createdAt: "2026-05-05T11:00:00.000Z",
    defaultGraders: ["exact_finding", "anchor"],
    defaultRunner: "full_pipeline",
    description: "Deterministic smoke suite.",
    evalSuiteId: "smoke-full-pipeline-v1",
    latestRun: evaluationRunFixture(),
    name: "Smoke full pipeline",
    owner: "quality",
    tags: ["smoke", "deterministic"],
    thresholds: {
      maxFalsePositives: 0,
      minRecall: 1,
    },
    updatedAt: "2026-05-05T12:10:00.000Z",
    version: "1",
    ...overrides,
  };
}

/** Creates an evaluation case result fixture. */
function evaluationCaseResultFixture(
  overrides: Partial<AdminEvaluationRunDetailsFixture["caseResults"][number]> = {},
): AdminEvaluationRunDetailsFixture["caseResults"][number] {
  return {
    artifacts: [{ kind: "markdown", uri: "file:///tmp/eval-report.md" }],
    costs: { estimatedUsd: 0 },
    createdAt: "2026-05-05T12:10:00.000Z",
    evalCaseId: "case_auth_regression",
    evalCaseResultId: "eval_result_1",
    evalRunId: "eval_run_1",
    matchedFindings: [{ expectedId: "expected_auth_regression", fingerprint: "finding_1" }],
    scores: [{ name: "exact_finding", score: 1 }],
    status: "passed",
    timings: { durationMs: 10 },
    unmatchedExpectedFindings: [],
    unmatchedGeneratedFindings: [],
    ...overrides,
  };
}

/** Creates an evaluation run details fixture. */
function evaluationRunDetailsFixture(
  overrides: Partial<AdminEvaluationRunDetailsFixture> = {},
): AdminEvaluationRunDetailsFixture {
  return {
    caseResults: [evaluationCaseResultFixture()],
    run: evaluationRunFixture(),
    ...overrides,
  };
}

/** Creates a usage summary fixture. */
function usageSummaryFixture(
  overrides: Partial<AdminUsageSummaryFixture> = {},
): AdminUsageSummaryFixture {
  return {
    periodStart: "2026-05-01T00:00:00.000Z",
    rollups: [],
    totals: {
      eventCount: 0,
      costMicros: 0,
      reviewCount: 0,
      llmTokens: 0,
    },
    ...overrides,
  };
}

/** Creates a customer-facing usage summary fixture. */
function productUsageSummaryFixture(
  overrides: Partial<ProductUsageSummaryFixture> = {},
): ProductUsageSummaryFixture {
  return {
    embeddingTokens: 0,
    estimatedCostUsd: "0.000000",
    indexedCommits: 0,
    reviewInputTokens: 0,
    reviewOutputTokens: 0,
    reviewRuns: 0,
    ...overrides,
  };
}

/** Creates a customer-facing usage event fixture. */
function productUsageEventFixture(
  overrides: Partial<ProductUsageEventFixture> = {},
): ProductUsageEventFixture {
  return {
    costMicros: 0,
    eventType: "review.run",
    occurredAt: "2026-05-05T12:00:00.000Z",
    orgId: "org_1",
    quantity: 1,
    repoId: "repo_1",
    reviewRunId: "rrn_1",
    unit: "review",
    usageEventId: "usage_1",
    ...overrides,
  };
}

/** Creates an entitlement summary fixture. */
function entitlementSummaryFixture(
  overrides: Partial<AdminEntitlementSummaryFixture> = {},
): AdminEntitlementSummaryFixture {
  return {
    checkedAt: "2026-05-05T12:00:00.000Z",
    decisions: [],
    entitlements: [],
    orgId: "org_1",
    planSnapshot: {
      billingAccountId: "bill_1",
      compiledAt: "2026-05-05T12:00:00.000Z",
      features: {
        "reviews.enabled": true,
        "reviews.inline_comments": true,
      },
      limits: {
        "reviews.max_comments_per_pr": 8,
        "reviews.max_monthly_review_credits": 500,
      },
      orgId: "org_1",
      paymentStatus: "current",
      planKey: "team",
      planVersionId: "planv_team_2026_01",
      schemaVersion: "plan_snapshot.v1",
      subscriptionStatus: "active",
    },
    ...overrides,
  };
}

/** Creates a billing summary fixture. */
function billingSummaryFixture(
  overrides: Partial<AdminBillingSummaryFixture> = {},
): AdminBillingSummaryFixture {
  const planSnapshot = entitlementSummaryFixture().planSnapshot;
  return {
    billingAccount: {
      billingAccountId: "bill_1",
      billingMode: "self_serve",
      createdAt: "2026-05-05T12:00:00.000Z",
      currentPlanKey: "team",
      currentPlanVersionId: "planv_team_2026_01",
      orgId: "org_1",
      paymentStatus: "current",
      provider: "stripe",
      providerCustomerId: "cus_123",
      status: "active",
      updatedAt: "2026-05-05T12:00:00.000Z",
    },
    checkedAt: "2026-05-05T12:00:00.000Z",
    creditGrants: [],
    entitlements: [],
    invoices: [],
    orgId: "org_1",
    planSnapshot,
    subscriptionItems: [],
    ...overrides,
  };
}

/** Creates a billing meter event debug fixture. */
function billingMeterEventsFixture(
  overrides: Partial<AdminBillingMeterEventsFixture> = {},
): AdminBillingMeterEventsFixture {
  return {
    meterEvents: [],
    orgId: "org_1",
    ...overrides,
  };
}

/** Creates a billing reconciliation fixture. */
function billingReconciliationFixture(
  overrides: Partial<AdminBillingReconciliationFixture> = {},
): AdminBillingReconciliationFixture {
  return {
    checkedAt: "2026-05-07T12:30:00.000Z",
    issues: [],
    orgId: "org_1",
    ...overrides,
  };
}

/** Creates a durable background job debug fixture. */
function backgroundJobDebugFixture(
  overrides: Partial<AdminBackgroundJobDebugFixture["job"]> = {},
): AdminBackgroundJobDebugFixture {
  const job = backgroundJobSummaryFixture(overrides);
  return {
    job,
    replayAudits: [],
    failures: job.failure ? [job.failure] : [],
  };
}

/** Creates a durable background job summary fixture. */
function backgroundJobSummaryFixture(
  overrides: Partial<AdminBackgroundJobDebugFixture["job"]> = {},
): AdminBackgroundJobDebugFixture["job"] {
  return {
    backgroundJobId: "job_1",
    queueName: "publishing",
    jobKey: "github:publish:rrn_1",
    jobType: "review.publish.v1",
    status: "failed",
    orgId: "org_1",
    repoId: "repo_1",
    reviewRunId: "rrn_1",
    attempts: 3,
    maxAttempts: 3,
    createdAt: "2026-05-07T12:00:00.000Z",
    updatedAt: "2026-05-07T12:05:00.000Z",
    completedAt: "2026-05-07T12:05:00.000Z",
    payload: jobEnvelopeFixture(),
    failure: {
      source: "background_job",
      code: "background_job.failed",
      message: "Background job review.publish.v1:github:publish:rrn_1 failed.",
      rowId: "job_1",
      occurredAt: "2026-05-07T12:05:00.000Z",
    },
    ...overrides,
  };
}

/** Creates a background job replay plan fixture. */
function backgroundJobReplayPlanFixture(
  overrides: Partial<AdminBackgroundJobReplayPlanFixture> = {},
): AdminBackgroundJobReplayPlanFixture {
  const job = overrides.job ?? replayJobPlanFixture();
  return {
    action: "job.requeue",
    backgroundJobId: "job_1",
    currentStatus: "failed",
    queueName: job.queueName,
    jobType: job.jobType,
    job,
    failures: [],
    confirmationToken: "sha256:job-plan",
    requiresExplicitConfirmation: true,
    ...overrides,
  };
}

/** Creates a replay job plan fixture. */
function replayJobPlanFixture(
  overrides: Partial<AdminBackgroundJobReplayPlanFixture["job"]> = {},
): AdminBackgroundJobReplayPlanFixture["job"] {
  return {
    source: "existing_job",
    queueName: "publishing",
    jobType: "review.publish.v1",
    originalBackgroundJobId: "job_1",
    originalJobKey: "github:publish:rrn_1",
    replayJobKey: "admin:job:job_1:replay",
    envelope: jobEnvelopeFixture(),
    orgId: "org_1",
    repoId: "repo_1",
    reviewRunId: "rrn_1",
    ...overrides,
  };
}

/** Creates a job envelope fixture for replay planning tests. */
function jobEnvelopeFixture(): AdminBackgroundJobReplayPlanFixture["job"]["envelope"] {
  return {
    jobId: "job_envelope_1",
    jobType: "review.publish.v1",
    schemaVersion: "job_envelope.v1",
    idempotencyKey: "github:publish:rrn_1",
    createdAt: "2026-05-07T12:00:00.000Z",
    attempt: 0,
    maxAttempts: 3,
    payload: {
      reviewRunId: "rrn_1",
      repoId: "repo_1",
      pullRequestNumber: 7,
    },
  };
}

/** Creates a replay execution fixture. */
function replayExecutionFixture(
  overrides: Partial<AdminReplayExecutionFixture> = {},
): AdminReplayExecutionFixture {
  return {
    action: "job.requeue",
    adminActionId: "admact_replay",
    auditLogId: "audit_replay",
    confirmationToken: "sha256:job-plan",
    existingJobIds: [],
    insertedJobIds: ["job_replay"],
    replayJobs: [backgroundJobSummaryFixture({ backgroundJobId: "job_replay", status: "pending" })],
    replayRunId: "rply_1",
    ...overrides,
  };
}

/** Creates a review debug details fixture. */
function reviewDebugDetailsFixture(
  overrides: Partial<AdminReviewDebugFixture["reviewRun"]> = {},
): AdminReviewDebugFixture {
  const reviewRun = {
    reviewRunId: "rrn_1",
    schemaVersion: "review_run.v1",
    repoId: "repo_1",
    pullRequestSnapshotId: "prs_1",
    pullRequestNumber: 7,
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    headSha: "89abcdef0123456789abcdef0123456789abcdef",
    trigger: "webhook",
    status: "completed",
    createdAt: "2026-05-05T12:00:00.000Z",
    updatedAt: "2026-05-05T12:30:00.000Z",
    artifactRefs: [],
    counts: reviewRunSummaryFixture.counts,
    ...overrides,
  } satisfies AdminReviewDebugFixture["reviewRun"];

  return {
    reviewRun,
    artifacts: [],
    candidateFindings: [],
    dependencies: [],
    failures: [],
    llmCalls: [],
    relatedJobs: [],
    replayAudits: [],
    sandboxRuns: [],
    stageEvents: [],
    validatedFindings: [],
  };
}

/** Creates a redacted debug bundle fixture. */
function debugBundleFixture(
  overrides: Partial<AdminDebugBundleFixture> = {},
): AdminDebugBundleFixture {
  return {
    schemaVersion: "admin_debug_bundle.v1",
    adminActionId: "admact_debug_bundle",
    auditLogId: "audit_debug_bundle",
    bundleId: "dbg_review",
    debugExportId: "dbgexp_review",
    expiresAt: "2026-05-08T12:30:00.000Z",
    generatedAt: "2026-05-07T12:30:00.000Z",
    generatedBy: {
      actorType: "idp_user",
      actorUserId: "oidc:usr_support",
      role: "support",
    },
    payload: {
      review: {
        reviewRunId: "rrn_1",
      },
    },
    payloadHash: "sha256:debug-bundle",
    redactionLevel: "metadata",
    repoId: "repo_1",
    reviewRunId: "rrn_1",
    ...overrides,
  };
}

/** Creates a retrieval replay dry-run fixture. */
function retrievalReplayDryRunFixture(
  overrides: Partial<AdminRetrievalReplayDryRunFixture> = {},
): AdminRetrievalReplayDryRunFixture {
  return {
    schemaVersion: "admin_retrieval_replay_dry_run.v1",
    comparisons: [
      {
        key: "chunk_1",
        originalKind: "same_file_context",
        originalPriority: 86,
        originalTitle: "src/index.ts:1",
        replayedKind: "same_file_context",
        replayedPriority: 86,
        replayedTitle: "src/index.ts:1",
        status: "unchanged",
      },
    ],
    generatedAt: "2026-05-07T12:30:00.000Z",
    mutatesProductionState: false,
    original: {
      contextBundleId: "ctx_original",
      estimatedTokens: 80,
      indexVersionId: "idx_1",
      itemCount: 1,
      maxTokens: 8000,
      retrievalMode: "indexed_context",
    },
    pullRequestSnapshotId: "prs_1",
    replayed: {
      contextBundleId: "ctx_replayed",
      estimatedTokens: 80,
      indexVersionId: "idx_1",
      itemCount: 1,
      maxTokens: 8000,
      retrievalMode: "indexed_context",
    },
    reviewRunId: "rrn_1",
    warnings: [],
    ...overrides,
  };
}

/** Creates a validation replay dry-run fixture. */
function validationReplayDryRunFixture(
  overrides: Partial<AdminValidationReplayDryRunFixture> = {},
): AdminValidationReplayDryRunFixture {
  return {
    schemaVersion: "admin_validation_replay_dry_run.v1",
    candidateFindingCount: 1,
    comparisons: [
      {
        key: "cfnd_1",
        candidateFindingId: "cfnd_1",
        originalDecision: "publish",
        originalFindingId: "fnd_1",
        originalReasons: [],
        replayedDecision: "publish",
        replayedFindingId: "fnd_1",
        replayedReasons: [],
        status: "unchanged",
        title: "Keep validation stable",
      },
    ],
    generatedAt: "2026-05-07T12:30:00.000Z",
    mutatesProductionState: false,
    original: {
      publish: 1,
      reject: 0,
    },
    pullRequestSnapshotId: "prs_1",
    replayed: {
      publish: 1,
      reject: 0,
    },
    reviewRunId: "rrn_1",
    warnings: [],
    ...overrides,
  };
}

/** Creates an eval import draft fixture. */
function evalImportDraftFixture(
  overrides: Partial<AdminEvalImportDraftFixture> = {},
): AdminEvalImportDraftFixture {
  return {
    schemaVersion: "admin_eval_import_draft.v1",
    adminActionId: "admact_eval_import",
    auditLogId: "audit_eval_import",
    evalCase: {
      caseId: "case_imported_review",
      title: "Imported review case",
      description: "Imported from a review run.",
      tags: ["production-import", "redacted"],
      changedFiles: [],
      expectedContexts: [],
      retrievedContexts: [],
      expectedFindings: [],
      actualFindings: [],
      latencyMs: 0,
      costUsd: 0,
    },
    files: [],
    generatedAt: "2026-05-07T12:30:00.000Z",
    generatedBy: {
      actorType: "idp_user",
      actorUserId: "oidc:usr_support",
      role: "support",
    },
    importDraftId: "evaldraft_1",
    redactionLevel: "redacted",
    repoId: "repo_1",
    reviewRunId: "rrn_1",
    suiteId: "smoke-full-pipeline-v1",
    warnings: [],
    ...overrides,
  };
}

/** Creates a memory and rules inspector fixture. */
function memoryRulesDebugDetailsFixture(
  overrides: Partial<AdminMemoryRulesDebugFixture> = {},
): AdminMemoryRulesDebugFixture {
  return {
    repository: {
      repoId: "repo_1",
      orgId: "org_1",
      provider: "github",
      fullName: "octo-org/heimdall",
      defaultBranch: "main",
      visibility: "private",
      enabled: true,
      isArchived: false,
      isFork: false,
    },
    memoryFacts: [
      {
        memoryFactId: "mem_1",
        orgId: "org_1",
        repoId: "repo_1",
        scope: "repository",
        factType: "review_guidance",
        body: "Prefer stable public APIs in tests.",
        status: "active",
        confidence: 0.9,
        metadataKeys: ["source"],
        metadataHash: "sha256:memory",
        createdAt: "2026-05-05T12:00:00.000Z",
        updatedAt: "2026-05-05T12:30:00.000Z",
      },
    ],
    memoryCandidates: [
      {
        memoryCandidateId: "mcand_1",
        orgId: "org_1",
        repoId: "repo_1",
        sourceKind: "command",
        candidateKind: "repo_fact",
        proposedContent: "Prefer stable public APIs in tests.",
        status: "pending",
        confidence: 0.8,
        trustLevel: "explicit_maintainer",
        createdByLogin: "maintainer",
        proposedScopeKeys: ["level", "orgId", "repoId"],
        proposedAppliesToKeys: ["pathGlobs"],
        metadataKeys: ["source"],
        createdAt: "2026-05-05T12:00:00.000Z",
        updatedAt: "2026-05-05T12:30:00.000Z",
      },
    ],
    rules: [
      {
        ruleId: "rule_1",
        orgId: "org_1",
        repoId: "repo_1",
        scope: "repository",
        name: "Context rule",
        effect: "context",
        matcher: { paths: ["src/**"] },
        instruction: "Use repository test helpers.",
        priority: 10,
        enabled: true,
        metadataKeys: [],
        createdAt: "2026-05-05T12:00:00.000Z",
        updatedAt: "2026-05-05T12:30:00.000Z",
      },
    ],
    candidateActions: {
      canApprove: true,
      canReject: true,
      reason: "Pending candidates can be moderated through the scoped API.",
    },
    evaluationTools: [
      {
        toolId: "repository.policy_preview",
        label: "Policy preview",
        route: "/admin/repos/repo_1/policy-preview",
        status: "available",
      },
    ],
    warnings: [],
    ...overrides,
  };
}

/** Creates a repository rule summary fixture. */
function repoRuleSummaryFixture(
  overrides: Partial<AdminRuleSummaryFixture> = {},
): AdminRuleSummaryFixture {
  return {
    ruleId: "rule_1",
    repoRuleId: "rule_1",
    orgId: "org_1",
    repoId: "repo_1",
    name: "Suppress generated files",
    effect: "suppress",
    matcher: { paths: ["src/generated/**"] },
    instruction: "Skip generated files.",
    priority: 100,
    enabled: true,
    scope: "path",
    ruleType: "suppress",
    body: "Skip generated files.",
    isEnabled: true,
    createdAt: "2026-05-05T12:00:00.000Z",
    updatedAt: "2026-05-05T12:30:00.000Z",
    ...overrides,
  };
}

/** Creates an authenticated product session fixture. */
function productSessionFixture(
  overrides: Partial<ProductSessionFixture> = {},
): ProductSessionFixture {
  return {
    actor: {
      memberships: [{ orgId: "org_1", role: "admin" }],
      selectedOrgId: "org_1",
      userId: "usr_1",
    },
    expiresAt: "2026-05-08T12:00:00.000Z",
    installations: [
      {
        accountLogin: "octo-org",
        accountType: "organization",
        installationId: "inst_1",
        orgId: "org_1",
        provider: "github",
        providerInstallationId: "12345",
      },
    ],
    sessionId: "sess_product",
    user: {
      avatarUrl: "https://avatars.example/usr_1.png",
      displayName: "Product Owner",
      primaryEmail: "owner@example.com",
      userId: "usr_1",
    },
    ...overrides,
  };
}

/** Creates a mock product session service. */
function createMockProductSessionService(
  overrides: Partial<ProductSessionService> = {},
): ProductSessionService {
  const session = productSessionFixture();
  return {
    clearCookie: () => "car_session=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly",
    createSession: async () => ({
      cookie: "car_session=opaque; Max-Age=1209600; Path=/; SameSite=Lax; HttpOnly",
      session,
    }),
    readSession: async () => session,
    revokeSession: async () => undefined,
    ...overrides,
  };
}

/** Creates a mock product GitHub OAuth service. */
function createMockProductGitHubOAuthService(
  overrides: Partial<ProductGitHubOAuthService> = {},
): ProductGitHubOAuthService {
  return {
    complete: async () => ({
      primaryEmail: "owner@example.com",
      providerLogin: "octocat",
      providerUserId: "12345",
      redirectTo: "/",
      userId: "usr_1",
    }),
    start: async () => ({
      authorizationUrl: "https://github.com/login/oauth/authorize?state=state_1",
    }),
    ...overrides,
  };
}

/** Creates a mock product dashboard service. */
function createMockProductDashboardService(): ProductDashboardService {
  return {
    getOnboarding: async () => ({
      githubApp: {
        appId: "123",
        appSlug: "heimdall-dev",
        configured: true,
        installUrl: "https://github.com/apps/heimdall-dev/installations/new",
        webhookConfigured: true,
        webhookUrl: "https://api.heimdall.test/webhooks/github",
      },
      installations: [
        {
          accountLogin: "octo-org",
          accountType: "organization",
          installedAt: "2026-05-05T12:00:00.000Z",
          provider: "github",
        },
      ],
      recentReviews: [
        {
          authorLogin: "octocat",
          counts: reviewRunSummaryFixture.counts,
          pullRequestNumber: 42,
          pullRequestTitle: "Improve review pipeline",
          repoFullName: "octo-org/heimdall",
          status: "completed",
          updatedAt: "2026-05-05T12:10:00.000Z",
        },
      ],
      repositories: [
        {
          defaultBranch: "main",
          enabled: true,
          fullName: "octo-org/heimdall",
          latestReviewStatus: "completed",
          visibility: "private",
        },
      ],
      webhook: {
        latestDeliveryAt: "2026-05-05T12:15:00.000Z",
        latestEventName: "pull_request",
        latestStatus: "processed",
        totalDeliveries: 3,
      },
    }),
  };
}

/** Unexpected replay method used by mock debug services. */
async function unexpectedReplayCall(
  _id: string,
  _confirmationToken: string,
  _actor: AdminReplayAuditActor,
): Promise<never> {
  throw new Error("Unexpected admin replay service call.");
}

/** Unexpected debug bundle method used by mock debug services. */
async function unexpectedDebugBundleCall(
  _id: string,
  _actor: AdminReplayAuditActor,
): Promise<never> {
  throw new Error("Unexpected admin debug bundle service call.");
}

/** Unexpected eval import method used by mock debug services. */
async function unexpectedEvalImportCall(): Promise<never> {
  throw new Error("Unexpected admin eval import service call.");
}

/** Creates an audit log summary fixture. */
function auditLog(action: string) {
  return {
    action,
    actorType: "idp_user",
    actorUserId: "oidc:usr_admin",
    auditLogId: `audit_${action}`,
    occurredAt: "2026-05-05T12:00:00.000Z",
    resourceType: "admin_session",
  };
}

/** Creates a security event summary fixture. */
function securityEvent(
  overrides: Partial<AdminSecurityEventFixture> = {},
): AdminSecurityEventFixture {
  return {
    actorId: "oidc:usr_admin",
    createdAt: "2026-05-05T12:00:00.000Z",
    metadata: {
      requestId: "req_1",
    },
    orgId: "org_1",
    repoId: "repo_1",
    resourceId: "admin_session",
    resourceType: "session",
    securityEventId: "secevt_1",
    severity: "critical",
    source: "api",
    status: "new",
    type: "cross_tenant_access_attempt",
    updatedAt: "2026-05-05T12:00:00.000Z",
    ...overrides,
  };
}

/** Creates a webhook debug summary fixture. */
function webhookSummary(webhookEventId: string) {
  return {
    webhookEventId,
    provider: "github",
    deliveryId: "delivery-1",
    eventName: "pull_request",
    orgId: "org_1",
    repoId: "repo_1",
    status: "processed",
    payloadHash: "sha256:test",
    hasStoredPayload: true,
    receivedAt: "2026-05-05T12:00:00.000Z",
  };
}

/** Repository fixture used by settings tests. */
const repositoryFixture = {
  repoId: "repo_1",
  orgId: "org_1",
  installationId: "inst_1",
  provider: "github",
  providerRepoId: "123",
  owner: "octo-org",
  name: "heimdall",
  fullName: "octo-org/heimdall",
  visibility: "private",
  isArchived: false,
  isFork: false,
  enabled: true,
  createdAt: "2026-05-05T12:00:00.000Z",
  updatedAt: "2026-05-05T12:00:00.000Z",
} satisfies Repository;

/** Repository settings fixture used by settings tests. */
const settingsFixture = {
  repoId: "repo_1",
  reviewPolicy: "inline_comments_and_summary",
  severityThreshold: "medium",
  maxCommentsPerReview: 5,
  ignoredPaths: ["node_modules/**"],
  ignoredAuthors: [],
  ignoredLabels: [],
  skipGeneratedFiles: true,
  skipDraftPullRequests: true,
  createdAt: "2026-05-05T12:00:00.000Z",
  updatedAt: "2026-05-05T12:00:00.000Z",
} satisfies RepositorySettings;

/** Review history fixture used by discovery route tests. */
const reviewRunSummaryFixture = {
  reviewRunId: "rrn_1",
  repoId: "repo_1",
  orgId: "org_1",
  repoFullName: "octo-org/heimdall",
  pullRequestNumber: 7,
  pullRequestTitle: "Tighten review dashboard",
  authorLogin: "octocat",
  changedFileCount: 4,
  trigger: "pull_request_opened",
  status: "completed",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  headSha: "89abcdef0123456789abcdef0123456789abcdef",
  summary: "Review completed.",
  counts: {
    candidateFindings: 2,
    validatedFindings: 1,
    publishedFindings: 1,
    rejectedFindings: 1,
  },
  createdAt: "2026-05-05T12:00:00.000Z",
  updatedAt: "2026-05-05T12:30:00.000Z",
};

/** Review rollup fixture used by dashboard overview route tests. */
function reviewMetricsFixture(
  overrides: Partial<AdminReviewMetricsFixture> = {},
): AdminReviewMetricsFixture {
  return {
    averagePublishedFindings: 0.5,
    candidateFindings: 4,
    completedRuns: 2,
    estimatedCostUsd: "0.014000",
    failedRuns: 1,
    generatedAt: "2026-05-05T12:30:00.000Z",
    medianDurationMs: 1_200,
    p95DurationMs: 2_800,
    publishedFindings: 2,
    rejectedFindings: 1,
    skippedRuns: 1,
    supersededRuns: 0,
    totalRuns: 4,
    validatedFindings: 3,
    ...overrides,
  };
}
