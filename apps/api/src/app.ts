import { createHash, timingSafeEqual } from "node:crypto";
import {
  AdminDebugConfirmationError,
  AdminDebugNotFoundError,
  type AdminDebugService,
  createAdminDebugService,
} from "@repo/admin-tools";
import { createDatabaseClient, type DatabaseClient } from "@repo/db";
import {
  GitHubWebhookHandler,
  WebhookAuthenticationError,
  WebhookPayloadError,
} from "@repo/webhook-ingestion";
import { Elysia } from "elysia";

/** Authentication settings for internal admin-debug routes. */
export type AdminDebugAuthOptions = {
  /** Whether admin-debug routes are enabled. */
  readonly enabled?: boolean;
  /** Bearer token required for enabled admin-debug routes. */
  readonly token?: string;
};

/** Dependencies used to create the API app. */
export type CreateApiAppOptions = {
  /** GitHub webhook handler for tests or custom composition. */
  readonly githubWebhookHandler?: GitHubWebhookHandler;
  /** Admin debug service for tests or custom composition. */
  readonly adminDebugService?: AdminDebugService;
  /** Admin-debug route authentication override for tests or custom composition. */
  readonly adminDebugAuth?: AdminDebugAuthOptions;
};

/** Creates the Heimdall API app. */
export function createApiApp(options: CreateApiAppOptions = {}) {
  let databaseClient: DatabaseClient | undefined;
  const getDatabaseClient = () => {
    databaseClient ??= createDatabaseClient();
    return databaseClient;
  };
  const githubWebhookHandler =
    options.githubWebhookHandler ??
    new GitHubWebhookHandler({
      db: getDatabaseClient().db,
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    });
  const getAdminDebugService = () =>
    options.adminDebugService ?? createAdminDebugService({ db: getDatabaseClient().db });
  const adminDebugAuth = resolveAdminDebugAuth(options.adminDebugAuth);

  return new Elysia()
    .get("/healthz", () => ({ ok: true, service: "api" }))
    .get("/admin/debug/webhooks/:webhookEventId", async ({ params, request, set }) => {
      const guardResponse = guardAdminDebugRequest(request, set, adminDebugAuth);
      if (guardResponse) {
        return guardResponse;
      }

      try {
        return { data: await getAdminDebugService().getWebhookDebugDetails(params.webhookEventId) };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/admin/debug/webhooks/:webhookEventId/replay-plan", async ({ params, request, set }) => {
      const guardResponse = guardAdminDebugRequest(request, set, adminDebugAuth);
      if (guardResponse) {
        return guardResponse;
      }

      try {
        return {
          data: await getAdminDebugService().createWebhookReplayPlan(params.webhookEventId),
        };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/admin/debug/webhooks/:webhookEventId/replay", async ({ params, request, set }) => {
      const guardResponse = guardAdminDebugRequest(request, set, adminDebugAuth);
      if (guardResponse) {
        return guardResponse;
      }

      const confirmationToken = await readConfirmationToken(request);
      if (!confirmationToken) {
        set.status = 400;
        return adminDebugInvalidConfirmationResponse();
      }

      try {
        return {
          data: await getAdminDebugService().executeWebhookReplay(
            params.webhookEventId,
            confirmationToken,
          ),
        };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .get("/admin/debug/reviews/:reviewRunId", async ({ params, request, set }) => {
      const guardResponse = guardAdminDebugRequest(request, set, adminDebugAuth);
      if (guardResponse) {
        return guardResponse;
      }

      try {
        return { data: await getAdminDebugService().getReviewDebugDetails(params.reviewRunId) };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/admin/debug/reviews/:reviewRunId/replay-plan", async ({ params, request, set }) => {
      const guardResponse = guardAdminDebugRequest(request, set, adminDebugAuth);
      if (guardResponse) {
        return guardResponse;
      }

      try {
        return { data: await getAdminDebugService().createReviewReplayPlan(params.reviewRunId) };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/admin/debug/reviews/:reviewRunId/replay", async ({ params, request, set }) => {
      const guardResponse = guardAdminDebugRequest(request, set, adminDebugAuth);
      if (guardResponse) {
        return guardResponse;
      }

      const confirmationToken = await readConfirmationToken(request);
      if (!confirmationToken) {
        set.status = 400;
        return adminDebugInvalidConfirmationResponse();
      }

      try {
        return {
          data: await getAdminDebugService().executeReviewReplay(
            params.reviewRunId,
            confirmationToken,
          ),
        };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .get("/admin/debug/publisher/:reviewRunId", async ({ params, request, set }) => {
      const guardResponse = guardAdminDebugRequest(request, set, adminDebugAuth);
      if (guardResponse) {
        return guardResponse;
      }

      try {
        return { data: await getAdminDebugService().getPublisherDebugDetails(params.reviewRunId) };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/admin/debug/publisher/:reviewRunId/replay-plan", async ({ params, request, set }) => {
      const guardResponse = guardAdminDebugRequest(request, set, adminDebugAuth);
      if (guardResponse) {
        return guardResponse;
      }

      try {
        return {
          data: await getAdminDebugService().createPublisherReplayPlan(params.reviewRunId),
        };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/admin/debug/publisher/:reviewRunId/replay", async ({ params, request, set }) => {
      const guardResponse = guardAdminDebugRequest(request, set, adminDebugAuth);
      if (guardResponse) {
        return guardResponse;
      }

      const confirmationToken = await readConfirmationToken(request);
      if (!confirmationToken) {
        set.status = 400;
        return adminDebugInvalidConfirmationResponse();
      }

      try {
        return {
          data: await getAdminDebugService().executePublisherReplay(
            params.reviewRunId,
            confirmationToken,
          ),
        };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/webhooks/github", async ({ request, set }) => {
      const rawBody = new Uint8Array(await request.arrayBuffer());
      try {
        const result = await githubWebhookHandler.handle({
          headers: request.headers,
          rawBody,
        });

        set.status = 202;
        return result;
      } catch (error) {
        if (error instanceof WebhookAuthenticationError) {
          set.status = 401;
          return { error: { code: "webhook.invalid_signature", message: error.message } };
        }

        if (error instanceof WebhookPayloadError) {
          set.status = 400;
          return { error: { code: "webhook.invalid_payload", message: error.message } };
        }

        throw error;
      }
    });
}

/** Resolves admin-debug authentication settings from options and environment. */
function resolveAdminDebugAuth(
  options: AdminDebugAuthOptions | undefined,
): Required<AdminDebugAuthOptions> {
  return {
    enabled: options?.enabled ?? process.env.HEIMDALL_ADMIN_DEBUG_ENABLED === "true",
    token: options?.token ?? process.env.HEIMDALL_ADMIN_DEBUG_TOKEN ?? "",
  };
}

/** Guards one admin-debug route request. */
function guardAdminDebugRequest(
  request: Request,
  set: { status?: number | string },
  auth: Required<AdminDebugAuthOptions>,
):
  | {
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    }
  | undefined {
  if (!auth.enabled) {
    set.status = 404;
    return {
      error: {
        code: "admin_debug.disabled",
        message: "Admin debug routes are disabled.",
      },
    };
  }

  if (!auth.token) {
    set.status = 503;
    return {
      error: {
        code: "admin_debug.misconfigured",
        message: "Admin debug routes require HEIMDALL_ADMIN_DEBUG_TOKEN.",
      },
    };
  }

  const providedToken = bearerToken(request.headers.get("authorization"));
  if (!providedToken || !constantTimeEqual(providedToken, auth.token)) {
    set.status = 401;
    return {
      error: {
        code: "admin_debug.unauthorized",
        message: "Admin debug authorization failed.",
      },
    };
  }

  return undefined;
}

/** Extracts a bearer token from an Authorization header. */
function bearerToken(header: string | null): string | undefined {
  const match = /^Bearer (?<token>.+)$/u.exec(header ?? "");
  return match?.groups?.token;
}

/** Compares two strings without leaking how many prefix bytes matched. */
function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/** Reads an admin replay confirmation token from a JSON request body. */
async function readConfirmationToken(request: Request): Promise<string | undefined> {
  const body = await request.json().catch(() => undefined);
  const record = body && typeof body === "object" && !Array.isArray(body) ? body : undefined;
  const confirmationToken = (record as { confirmationToken?: unknown } | undefined)
    ?.confirmationToken;
  return typeof confirmationToken === "string" && confirmationToken.length > 0
    ? confirmationToken
    : undefined;
}

/** Converts admin-debug domain errors into API responses. */
function handleAdminDebugError(error: unknown, set: { status?: number | string }) {
  if (error instanceof AdminDebugNotFoundError) {
    set.status = 404;
    return adminDebugNotFoundResponse(error);
  }

  if (error instanceof AdminDebugConfirmationError) {
    set.status = 409;
    return {
      error: {
        code: "admin_debug.confirmation_mismatch",
        message: error.message,
      },
    };
  }

  throw error;
}

function adminDebugNotFoundResponse(error: AdminDebugNotFoundError) {
  return {
    error: {
      code: "admin_debug.not_found",
      message: error.message,
      details: {
        resourceType: error.resourceType,
        resourceId: error.resourceId,
      },
    },
  };
}

/** Returns the error response for missing or malformed replay confirmations. */
function adminDebugInvalidConfirmationResponse() {
  return {
    error: {
      code: "admin_debug.invalid_confirmation",
      message: "Replay requests require a JSON confirmationToken.",
    },
  };
}
