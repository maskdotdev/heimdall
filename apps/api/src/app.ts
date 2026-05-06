import { createHash, timingSafeEqual } from "node:crypto";
import {
  AdminDebugConfirmationError,
  AdminDebugNotFoundError,
  type AdminDebugService,
  type AdminReplayAuditActor,
  createAdminDebugService,
} from "@repo/admin-tools";
import { createDatabaseClient, type DatabaseClient } from "@repo/db";
import {
  GitHubWebhookHandler,
  WebhookAuthenticationError,
  WebhookPayloadError,
} from "@repo/webhook-ingestion";
import { Elysia } from "elysia";

/** Access role for authenticated support/admin users. */
export type AdminAccessRole = "support" | "admin";

/** Configured support/admin user that can access admin-debug routes. */
export type AdminAccessUser = {
  /** Stable actor ID written into audit logs. */
  readonly userId: string;
  /** Role assigned to this actor. */
  readonly role: AdminAccessRole;
  /** Bearer token used by the actor. */
  readonly token: string;
  /** Display name shown in operator views when available. */
  readonly displayName?: string;
  /** Primary email shown in operator views when available. */
  readonly email?: string;
};

/** Authentication settings for admin-debug routes. */
export type AdminDebugAuthOptions = {
  /** Whether admin-debug routes are enabled. */
  readonly enabled?: boolean;
  /** Compatibility fallback bearer token for enabled admin-debug routes. */
  readonly token?: string;
  /** Named support/admin users that can access admin-debug routes. */
  readonly users?: readonly AdminAccessUser[];
};

type ResolvedAdminDebugAuthOptions = {
  /** Whether admin-debug routes are enabled. */
  readonly enabled: boolean;
  /** Compatibility fallback bearer token for enabled admin-debug routes. */
  readonly token?: string | undefined;
  /** Named support/admin users that can access admin-debug routes. */
  readonly users: readonly AdminAccessUser[];
  /** Configuration error that prevents safe admin-debug access. */
  readonly configurationError?: string | undefined;
};

type AdminErrorResponse = {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
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
    .get("/admin/session", ({ request, set }) => {
      const guardResult = guardAdminDebugActorRequest(request, set, adminDebugAuth, "support");
      if ("response" in guardResult) {
        return guardResult.response;
      }

      return {
        data: {
          actor: publicAdminActor(guardResult.actor),
          capabilities: {
            canInspect: true,
            canPlanReplay: true,
            canExecuteReplay: guardResult.actor.role === "admin",
          },
        },
      };
    })
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
      const guardResult = guardAdminDebugActorRequest(request, set, adminDebugAuth, "admin");
      if ("response" in guardResult) {
        return guardResult.response;
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
            guardResult.actor,
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
      const guardResult = guardAdminDebugActorRequest(request, set, adminDebugAuth, "admin");
      if ("response" in guardResult) {
        return guardResult.response;
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
            guardResult.actor,
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
      const guardResult = guardAdminDebugActorRequest(request, set, adminDebugAuth, "admin");
      if ("response" in guardResult) {
        return guardResult.response;
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
            guardResult.actor,
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
): ResolvedAdminDebugAuthOptions {
  const parsedUsers = options?.users
    ? { users: options.users }
    : parseAdminAccessUsers(process.env.HEIMDALL_ADMIN_USERS);

  return {
    enabled: options?.enabled ?? process.env.HEIMDALL_ADMIN_DEBUG_ENABLED === "true",
    token: options?.token ?? process.env.HEIMDALL_ADMIN_DEBUG_TOKEN,
    users: parsedUsers.users ?? [],
    configurationError: parsedUsers.error,
  };
}

/** Guards one admin-debug route request. */
function guardAdminDebugRequest(
  request: Request,
  set: { status?: number | string },
  auth: ResolvedAdminDebugAuthOptions,
):
  | {
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    }
  | undefined {
  const guardResult = guardAdminDebugActorRequest(request, set, auth, "support");
  return "response" in guardResult ? guardResult.response : undefined;
}

function guardAdminDebugActorRequest(
  request: Request,
  set: { status?: number | string },
  auth: ResolvedAdminDebugAuthOptions,
  minimumRole: AdminAccessRole,
): { readonly actor: AdminReplayAuditActor } | { readonly response: AdminErrorResponse } {
  const configurationError = validateAdminDebugConfiguration(auth);
  if (configurationError) {
    set.status = configurationError.status;
    return { response: configurationError.response };
  }

  const providedToken = bearerToken(request.headers.get("authorization"));
  const actor = providedToken ? authenticateAdminActor(providedToken, auth) : undefined;
  if (!actor) {
    set.status = 401;
    return {
      response: {
        error: {
          code: "admin_debug.unauthorized",
          message: "Admin debug authorization failed.",
        },
      },
    };
  }

  if (!roleAtLeast(actor.role, minimumRole)) {
    set.status = 403;
    return {
      response: {
        error: {
          code: "admin_debug.forbidden",
          message: "This admin debug action requires an admin role.",
        },
      },
    };
  }

  return { actor };
}

function validateAdminDebugConfiguration(
  auth: ResolvedAdminDebugAuthOptions,
): { readonly status: number; readonly response: AdminErrorResponse } | undefined {
  if (!auth.enabled) {
    return {
      status: 404,
      response: {
        error: {
          code: "admin_debug.disabled",
          message: "Admin debug routes are disabled.",
        },
      },
    };
  }

  if (auth.configurationError) {
    return {
      status: 503,
      response: {
        error: {
          code: "admin_debug.misconfigured",
          message: auth.configurationError,
        },
      },
    };
  }

  if (auth.users.length === 0 && !auth.token) {
    return {
      status: 503,
      response: {
        error: {
          code: "admin_debug.misconfigured",
          message: "Admin debug routes require HEIMDALL_ADMIN_USERS or HEIMDALL_ADMIN_DEBUG_TOKEN.",
        },
      },
    };
  }

  return undefined;
}

function authenticateAdminActor(
  providedToken: string,
  auth: ResolvedAdminDebugAuthOptions,
): AdminReplayAuditActor | undefined {
  const user = auth.users.find(
    (candidate) => candidate.token.length > 0 && constantTimeEqual(providedToken, candidate.token),
  );
  if (user) {
    return {
      actorType: "admin_user",
      actorUserId: user.userId,
      role: user.role,
      ...(user.displayName ? { displayName: user.displayName } : {}),
      ...(user.email ? { email: user.email } : {}),
    };
  }

  if (auth.token && constantTimeEqual(providedToken, auth.token)) {
    return {
      actorType: "internal_token",
      actorUserId: "internal_admin_token",
      role: "admin",
      displayName: "Internal admin token",
    };
  }

  return undefined;
}

function parseAdminAccessUsers(value: string | undefined):
  | { readonly users: readonly AdminAccessUser[]; readonly error?: undefined }
  | {
      readonly users?: undefined;
      readonly error: string;
    } {
  if (!value || value.trim().length === 0) {
    return { users: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { error: "HEIMDALL_ADMIN_USERS must be a JSON array of support/admin users." };
  }

  if (!Array.isArray(parsed)) {
    return { error: "HEIMDALL_ADMIN_USERS must be a JSON array of support/admin users." };
  }

  const users: AdminAccessUser[] = [];
  for (const [index, entry] of parsed.entries()) {
    const record = asRecord(entry);
    const userId = stringField(record, "userId");
    const role = stringField(record, "role");
    const token = stringField(record, "token");
    if (!userId || !isAdminAccessRole(role) || !token) {
      return {
        error: `HEIMDALL_ADMIN_USERS[${index}] requires userId, role support/admin, and token.`,
      };
    }

    const displayName = stringField(record, "displayName");
    const email = stringField(record, "email");
    users.push({
      userId,
      role,
      token,
      ...(displayName ? { displayName } : {}),
      ...(email ? { email } : {}),
    });
  }

  return { users };
}

function publicAdminActor(actor: AdminReplayAuditActor) {
  return {
    actorType: actor.actorType,
    userId: actor.actorUserId,
    role: actor.role,
    ...(actor.displayName ? { displayName: actor.displayName } : {}),
    ...(actor.email ? { email: actor.email } : {}),
  };
}

function roleAtLeast(actual: AdminAccessRole, minimum: AdminAccessRole): boolean {
  const rank: Record<AdminAccessRole, number> = { support: 1, admin: 2 };
  return rank[actual] >= rank[minimum];
}

function isAdminAccessRole(value: string | undefined): value is AdminAccessRole {
  return value === "support" || value === "admin";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
