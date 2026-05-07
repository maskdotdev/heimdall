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
import { createMemoryObservabilitySink } from "@repo/observability";
import { signAdminIdentityAssertion } from "@repo/security";
import { describe, expect, it } from "vitest";
import { type AdminControlPlaneService, createApiApp, type ProductDashboardService } from "./app";

/** Allowed admin dashboard origin used by API route tests. */
const adminOrigin = "http://localhost:3001";

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

  it("rejects disallowed CORS origins for admin routes", async () => {
    const observabilitySink = createMemoryObservabilitySink();
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({}),
      adminObservabilitySink: observabilitySink,
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

  it("serves repository rules only to scoped inspectors", async () => {
    const app = createApiApp({
      adminControlPlaneAuth: auth,
      adminControlPlaneService: createMockControlPlaneService({
        listRepositoryRules: async (repoId) => [
          {
            repoRuleId: "rule_1",
            orgId: "org_1",
            repoId,
            scope: "path",
            ruleType: "suppress",
            body: "Skip generated files.",
            isEnabled: true,
            createdAt: "2026-05-05T12:00:00.000Z",
            updatedAt: "2026-05-05T12:30:00.000Z",
          },
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

  it("serves scoped repository and review discovery without pasted IDs", async () => {
    const repositoryQueries: unknown[] = [];
    const reviewQueries: unknown[] = [];
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
      }),
      githubWebhookHandler: noopWebhookHandler(),
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
      },
    });
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

/** Creates a mock admin/debug service. */
function createMockAdminDebugService(overrides: Partial<AdminDebugService>): AdminDebugService {
  const unexpectedCall = async () => {
    throw new Error("Unexpected admin debug service call.");
  };

  return {
    getWebhookDebugDetails: unexpectedCall,
    createWebhookReplayPlan: unexpectedCall,
    executeWebhookReplay: unexpectedReplayCall,
    getReviewDebugDetails: unexpectedCall,
    createReviewReplayPlan: unexpectedCall,
    executeReviewReplay: unexpectedReplayCall,
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
    getRepositorySettings: async () => ({
      repository: repositoryFixture,
      settings: settingsFixture,
    }),
    listRepositories: async () => [repositoryFixture],
    listRepositoryRules: async () => [],
    listReviewRuns: async () => [reviewRunSummaryFixture],
    listAuditLogs: async () => [],
    recordAuditEvent: async (event) => auditLog(event.action),
    updateRepositorySettings: async () => ({
      repository: repositoryFixture,
      settings: settingsFixture,
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
