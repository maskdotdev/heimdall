import { AdminDebugNotFoundError, type AdminDebugService } from "@repo/admin-tools";
import { describe, expect, it } from "vitest";
import { createApiApp } from "./app";

describe("api app", () => {
  const adminDebugAuth = { enabled: true, token: "debug-secret" };
  const namedAdminAuth = {
    enabled: true,
    users: [
      {
        userId: "usr_support",
        role: "support" as const,
        token: "support-secret",
        displayName: "Support User",
        email: "support@example.com",
      },
      {
        userId: "usr_admin",
        role: "admin" as const,
        token: "admin-secret",
        displayName: "Admin User",
        email: "admin@example.com",
      },
    ],
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

  it("exposes admin debug visibility routes through the injected service", async () => {
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      adminDebugAuth,
      adminDebugService: createMockAdminDebugService({
        getWebhookDebugDetails: async (webhookEventId: string) => ({
          webhookEvent: {
            webhookEventId,
            provider: "github",
            deliveryId: "delivery-1",
            eventName: "pull_request",
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
    });

    const response = await app.handle(
      authorizedRequest("http://localhost/admin/debug/webhooks/webhook_1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        webhookEvent: {
          webhookEventId: "webhook_1",
          deliveryId: "delivery-1",
        },
        expectedJobKeys: ["github:review:repo_1:7:abc123"],
      },
    });
  });

  it("exposes gated replay-plan routes through the injected service", async () => {
    const payload = {
      repoId: "repo_1",
      installationId: "inst_1",
      pullRequestNumber: 7,
      baseSha: "1111111",
      headSha: "2222222",
      trigger: "webhook" as const,
    };
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      adminDebugAuth,
      adminDebugService: createMockAdminDebugService({
        createReviewReplayPlan: async (reviewRunId: string) => ({
          action: "review.requeue",
          reviewRunId,
          queueName: "review",
          jobKey: "admin:review:rrn_1:abc123",
          job: {
            source: "operator_replay",
            queueName: "review",
            jobType: "pr.review.v1",
            replayJobKey: "admin:review:rrn_1:abc123",
            envelope: {
              jobId: "job_replay",
              jobType: "pr.review.v1",
              schemaVersion: "job_envelope.v1",
              idempotencyKey: "admin:review:rrn_1:abc123",
              createdAt: "2026-05-05T12:00:00.000Z",
              attempt: 0,
              maxAttempts: 3,
              payload,
            },
            repoId: "repo_1",
            reviewRunId,
          },
          payload,
          currentStatus: "failed",
          relatedJobs: [],
          failures: [
            {
              source: "review_run",
              code: "review_orchestrator.failed",
              message: "Review failed.",
              retryable: true,
            },
          ],
          confirmationToken: "sha256:abc123",
          requiresExplicitConfirmation: true,
        }),
      }),
    });

    const response = await app.handle(
      authorizedRequest("http://localhost/admin/debug/reviews/rrn_1/replay-plan", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        action: "review.requeue",
        reviewRunId: "rrn_1",
        confirmationToken: "sha256:abc123",
        requiresExplicitConfirmation: true,
      },
    });
  });

  it("executes confirmed replay routes through the injected service", async () => {
    let observedActor: unknown;
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      adminDebugAuth,
      adminDebugService: createMockAdminDebugService({
        executeReviewReplay: async (reviewRunId: string, confirmationToken: string, actor) => {
          observedActor = actor;
          return {
            action: "review.requeue",
            confirmationToken,
            auditLogId: "audit_1",
            insertedJobIds: [`job_${reviewRunId}`],
            existingJobIds: [],
            replayJobs: [],
          };
        },
      }),
    });

    const response = await app.handle(
      authorizedRequest("http://localhost/admin/debug/reviews/rrn_1/replay", {
        method: "POST",
        body: JSON.stringify({ confirmationToken: "sha256:abc123" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        action: "review.requeue",
        confirmationToken: "sha256:abc123",
        auditLogId: "audit_1",
        insertedJobIds: ["job_rrn_1"],
      },
    });
    expect(observedActor).toMatchObject({
      actorType: "internal_token",
      actorUserId: "internal_admin_token",
      role: "admin",
    });
  });

  it("identifies named support and admin users through the session route", async () => {
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      adminDebugAuth: namedAdminAuth,
      adminDebugService: createMockAdminDebugService({}),
    });

    const supportResponse = await app.handle(
      authorizedRequest("http://localhost/admin/session", {}, "support-secret"),
    );
    expect(supportResponse.status).toBe(200);
    await expect(supportResponse.json()).resolves.toMatchObject({
      data: {
        actor: {
          userId: "usr_support",
          role: "support",
          email: "support@example.com",
        },
        capabilities: {
          canInspect: true,
          canPlanReplay: true,
          canExecuteReplay: false,
        },
      },
    });

    const adminResponse = await app.handle(
      authorizedRequest("http://localhost/admin/session", {}, "admin-secret"),
    );
    expect(adminResponse.status).toBe(200);
    await expect(adminResponse.json()).resolves.toMatchObject({
      data: {
        actor: {
          userId: "usr_admin",
          role: "admin",
        },
        capabilities: {
          canExecuteReplay: true,
        },
      },
    });
  });

  it("allows support users to plan replay but blocks replay execution", async () => {
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      adminDebugAuth: namedAdminAuth,
      adminDebugService: createMockAdminDebugService({
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
          throw new Error("Support users must not execute replay.");
        },
      }),
    });

    const planResponse = await app.handle(
      authorizedRequest(
        "http://localhost/admin/debug/webhooks/webhook_1/replay-plan",
        { method: "POST" },
        "support-secret",
      ),
    );
    expect(planResponse.status).toBe(200);
    await expect(planResponse.json()).resolves.toMatchObject({
      data: {
        blockedJobIds: ["job_running"],
        confirmationToken: "sha256:plan",
      },
    });

    const replayResponse = await app.handle(
      authorizedRequest(
        "http://localhost/admin/debug/webhooks/webhook_1/replay",
        {
          method: "POST",
          body: JSON.stringify({ confirmationToken: "sha256:plan" }),
        },
        "support-secret",
      ),
    );

    expect(replayResponse.status).toBe(403);
    await expect(replayResponse.json()).resolves.toMatchObject({
      error: { code: "admin_debug.forbidden" },
    });
  });

  it("guards admin debug routes with explicit bearer auth", async () => {
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      adminDebugAuth,
      adminDebugService: createMockAdminDebugService({
        getWebhookDebugDetails: async () => {
          throw new Error("admin service should not be called without auth");
        },
      }),
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/webhooks/webhook_1"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin_debug.unauthorized" },
    });
  });

  it("keeps admin debug routes disabled by default", async () => {
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      adminDebugService: createMockAdminDebugService({
        getWebhookDebugDetails: async () => {
          throw new Error("admin service should not be called when disabled");
        },
      }),
    });

    const response = await app.handle(
      new Request("http://localhost/admin/debug/webhooks/webhook_1", {
        headers: { authorization: "Bearer debug-secret" },
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin_debug.disabled" },
    });
  });

  it("maps missing admin debug resources to 404 responses", async () => {
    const app = createApiApp({
      githubWebhookHandler: noopWebhookHandler(),
      adminDebugAuth,
      adminDebugService: createMockAdminDebugService({
        getPublisherDebugDetails: async () => {
          throw new AdminDebugNotFoundError("review_run", "rrn_missing");
        },
      }),
    });

    const response = await app.handle(
      authorizedRequest("http://localhost/admin/debug/publisher/rrn_missing"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "admin_debug.not_found",
        details: {
          resourceType: "review_run",
          resourceId: "rrn_missing",
        },
      },
    });
  });
});

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

function authorizedRequest(input: string, init: RequestInit = {}, token = "debug-secret"): Request {
  return new Request(input, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
}

function createMockAdminDebugService(overrides: Partial<AdminDebugService>): AdminDebugService {
  const unexpectedCall = async () => {
    throw new Error("Unexpected admin debug service call.");
  };

  return {
    getWebhookDebugDetails: unexpectedCall,
    createWebhookReplayPlan: unexpectedCall,
    executeWebhookReplay: unexpectedCall,
    getReviewDebugDetails: unexpectedCall,
    createReviewReplayPlan: unexpectedCall,
    executeReviewReplay: unexpectedCall,
    getPublisherDebugDetails: unexpectedCall,
    createPublisherReplayPlan: unexpectedCall,
    executePublisherReplay: unexpectedCall,
    ...overrides,
  };
}
