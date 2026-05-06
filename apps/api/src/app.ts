import { randomUUID } from "node:crypto";
import {
  AdminDebugConfirmationError,
  AdminDebugNotFoundError,
  type AdminDebugService,
  type AdminReplayAuditActor,
  createAdminDebugService,
} from "@repo/admin-tools";
import {
  DEFAULT_REPOSITORY_SETTINGS,
  type Repository,
  type RepositorySettings,
  safeParseWithSchema,
  type UpdateRepositoryControlPlaneSettingsRequest,
  UpdateRepositoryControlPlaneSettingsRequestSchema,
} from "@repo/contracts";
import {
  auditLogs,
  createDatabaseClient,
  type DatabaseClient,
  type HeimdallDatabase,
  RepositoryRepository,
} from "@repo/db";
import {
  type AdminControlPlaneTelemetryEventInput,
  createNoopObservabilitySink,
  type ObservabilitySink,
  tryRecordAdminControlPlaneTelemetryEvent,
} from "@repo/observability";
import {
  type AdminActor,
  type AdminIdentityProvider,
  type AdminPermission,
  type AdminRouteExposure,
  AdminSecurityError,
  type AdminSession,
  type AdminSessionManager,
  actorCanAccessOrg,
  actorCanAccessRepo,
  actorHasPermission,
  adminCapabilities,
  createAdminSessionManager,
  isCsrfSafeMethod,
  verifyAdminIdentityAssertion,
  verifyCsrfToken,
} from "@repo/security";
import {
  GitHubWebhookHandler,
  WebhookAuthenticationError,
  WebhookPayloadError,
} from "@repo/webhook-ingestion";
import { and, desc, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import { Elysia } from "elysia";

/** Authentication settings for admin control-plane routes. */
export type AdminControlPlaneAuthOptions = {
  /** Whether admin control-plane routes are enabled. */
  readonly enabled?: boolean;
  /** Admin route exposure policy. */
  readonly routeExposure?: AdminRouteExposure;
  /** Internal exposure header name required when routeExposure is internal. */
  readonly internalHeaderName?: string;
  /** Internal exposure header value required when routeExposure is internal. */
  readonly internalHeaderValue?: string;
  /** Identity provider expected for signed admin assertions. */
  readonly identityProvider?: AdminIdentityProvider;
  /** Shared assertion signing secret used by the upstream IdP gateway. */
  readonly assertionSecret?: string;
  /** Signed session cookie secret. */
  readonly sessionSecret?: string;
  /** Signed session cookie name. */
  readonly cookieName?: string;
  /** Whether session cookies require HTTPS. */
  readonly secureCookies?: boolean;
  /** SameSite policy used for browser session cookies. */
  readonly cookieSameSite?: "Strict" | "Lax" | "None";
  /** Session lifetime in seconds. */
  readonly sessionMaxAgeSeconds?: number;
  /** Strict CORS origins allowed to use admin credentials. */
  readonly allowedOrigins?: readonly string[];
  /** Required GitHub organization for github_org identity providers. */
  readonly githubOrg?: string;
};

/** Resolved authentication settings for admin control-plane routes. */
type ResolvedAdminControlPlaneAuthOptions = {
  /** Whether admin control-plane routes are enabled. */
  readonly enabled: boolean;
  /** Admin route exposure policy. */
  readonly routeExposure: AdminRouteExposure;
  /** Internal exposure header name required when routeExposure is internal. */
  readonly internalHeaderName?: string | undefined;
  /** Internal exposure header value required when routeExposure is internal. */
  readonly internalHeaderValue?: string | undefined;
  /** Identity provider expected for signed admin assertions. */
  readonly identityProvider?: AdminIdentityProvider | undefined;
  /** Shared assertion signing secret used by the upstream IdP gateway. */
  readonly assertionSecret?: string | undefined;
  /** Session manager for signed cookies when configuration is valid. */
  readonly sessionManager?: AdminSessionManager | undefined;
  /** Strict CORS origins allowed to use admin credentials. */
  readonly allowedOrigins: readonly string[];
  /** Required GitHub organization for github_org identity providers. */
  readonly githubOrg?: string | undefined;
  /** Configuration error that prevents safe admin access. */
  readonly configurationError?: string | undefined;
};

/** Error envelope returned by admin API routes. */
type AdminErrorResponse = {
  /** Structured API error. */
  readonly error: {
    /** Machine-readable error code. */
    readonly code: string;
    /** Human-readable error message. */
    readonly message: string;
  };
};

/** Minimal Elysia set object shape used by admin helpers. */
type AdminResponseSet = {
  /** HTTP status assigned by the route. */
  status?: number | string;
  /** HTTP headers assigned by the route. */
  headers?: Record<string, string | number>;
};

/** Minimal Elysia set object shape for status-only helpers. */
type AdminStatusSet = {
  /** HTTP status assigned by the route. */
  status?: number | string;
};

/** Authenticated admin request context produced by the session guard. */
type AdminRequestContext = {
  /** Provider-backed admin actor. */
  readonly actor: AdminActor;
  /** Verified admin session. */
  readonly session: AdminSession;
  /** Request ID propagated into audit logs. */
  readonly requestId: string;
};

/** Repository settings response used by the control-plane API and dashboard. */
type AdminControlPlaneSettings = {
  /** Repository row being controlled. */
  readonly repository: Repository;
  /** Mutable review settings for the repository. */
  readonly settings: RepositorySettings;
};

/** Query options for audit history search. */
type AdminAuditLogQuery = {
  /** Organization filter. */
  readonly orgId?: string | undefined;
  /** Resource type filter. */
  readonly resourceType?: string | undefined;
  /** Resource ID filter. */
  readonly resourceId?: string | undefined;
  /** Actor user ID filter. */
  readonly actorUserId?: string | undefined;
  /** Action filter. */
  readonly action?: string | undefined;
  /** Free-text search over action, resource, actor, and metadata. */
  readonly search?: string | undefined;
  /** Maximum number of rows to return. */
  readonly limit: number;
};

/** Audit log summary returned by the control-plane dashboard. */
type AdminAuditLogSummary = {
  /** Audit log row ID. */
  readonly auditLogId: string;
  /** Organization associated with the event when available. */
  readonly orgId?: string | undefined;
  /** Actor category. */
  readonly actorType: string;
  /** Stable actor ID when available. */
  readonly actorUserId?: string | undefined;
  /** Audit action. */
  readonly action: string;
  /** Resource type. */
  readonly resourceType: string;
  /** Resource ID when available. */
  readonly resourceId?: string | undefined;
  /** ISO timestamp for the event. */
  readonly occurredAt: string;
  /** Event metadata, including request IDs and before/after changes. */
  readonly metadata?: unknown;
};

/** Audit event input used by the control-plane service. */
type AdminAuditEventInput = {
  /** Actor that caused the event. */
  readonly actor: AdminActor;
  /** Session ID that authorized the event when available. */
  readonly sessionId?: string | undefined;
  /** Request ID that authorized the event. */
  readonly requestId: string;
  /** Audit action. */
  readonly action: string;
  /** Resource type. */
  readonly resourceType: string;
  /** Resource ID when available. */
  readonly resourceId?: string | undefined;
  /** Organization ID when available. */
  readonly orgId?: string | undefined;
  /** Event-specific metadata. */
  readonly metadata?: Record<string, unknown> | undefined;
};

/** Admin telemetry input before absent optional fields are removed. */
type AdminTelemetryRequestEventInput = Omit<
  AdminControlPlaneTelemetryEventInput,
  "actorUserId" | "orgId" | "repoId" | "route"
> & {
  /** Stable actor ID when known. */
  readonly actorUserId?: string | undefined;
  /** Organization scope when known. */
  readonly orgId?: string | undefined;
  /** Repository scope when known. */
  readonly repoId?: string | undefined;
};

/** Service surface for control-plane settings and audit APIs. */
export type AdminControlPlaneService = {
  /** Gets repository control-plane settings. */
  readonly getRepositorySettings: (repoId: string) => Promise<AdminControlPlaneSettings>;
  /** Updates repository control-plane settings and writes an audit log in the same transaction. */
  readonly updateRepositorySettings: (
    repoId: string,
    patch: UpdateRepositoryControlPlaneSettingsRequest,
    audit: Omit<
      AdminAuditEventInput,
      "action" | "metadata" | "orgId" | "resourceId" | "resourceType"
    >,
  ) => Promise<AdminControlPlaneSettings>;
  /** Lists searchable admin audit history. */
  readonly listAuditLogs: (query: AdminAuditLogQuery) => Promise<readonly AdminAuditLogSummary[]>;
  /** Writes one admin audit event. */
  readonly recordAuditEvent: (event: AdminAuditEventInput) => Promise<AdminAuditLogSummary>;
};

/** Error raised when a control-plane resource does not exist. */
class AdminControlPlaneNotFoundError extends Error {
  /** Missing resource type. */
  public readonly resourceType: string;

  /** Missing resource ID. */
  public readonly resourceId: string;

  /** Creates a not-found error. */
  public constructor(resourceType: string, resourceId: string) {
    super(`Admin control-plane ${resourceType} ${resourceId} was not found.`);
    this.name = "AdminControlPlaneNotFoundError";
    this.resourceType = resourceType;
    this.resourceId = resourceId;
  }
}

/** Dependencies used to create the API app. */
export type CreateApiAppOptions = {
  /** GitHub webhook handler for tests or custom composition. */
  readonly githubWebhookHandler?: GitHubWebhookHandler;
  /** Admin debug service for tests or custom composition. */
  readonly adminDebugService?: AdminDebugService;
  /** Admin control-plane service for tests or custom composition. */
  readonly adminControlPlaneService?: AdminControlPlaneService;
  /** Admin control-plane authentication override for tests or custom composition. */
  readonly adminControlPlaneAuth?: AdminControlPlaneAuthOptions;
  /** Admin control-plane observability sink for structured telemetry. */
  readonly adminObservabilitySink?: ObservabilitySink;
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
  const getAdminControlPlaneService = () =>
    options.adminControlPlaneService ??
    createAdminControlPlaneService({ db: getDatabaseClient().db });
  const adminAuth = resolveAdminControlPlaneAuth(options.adminControlPlaneAuth);
  const observabilitySink = options.adminObservabilitySink ?? createNoopObservabilitySink();

  return new Elysia()
    .get("/healthz", () => ({ ok: true, service: "api" }))
    .options("/admin/*", ({ request, set }) =>
      handleAdminPreflight(request, set, adminAuth, observabilitySink),
    )
    .post("/admin/auth/login", async ({ request, set }) => {
      const requestId = requestIdFromRequest(request);
      const configResponse = guardAdminConfiguration(
        request,
        set,
        adminAuth,
        requestId,
        observabilitySink,
      );
      if (configResponse) {
        return configResponse;
      }

      try {
        const actor = verifyAdminIdentityAssertion({
          assertionSecret: requireValue(adminAuth.assertionSecret),
          encodedAssertion: request.headers.get("x-heimdall-idp-assertion") ?? undefined,
          expectedProvider: requireValue(adminAuth.identityProvider),
          requiredGithubOrg: adminAuth.githubOrg,
          signature: request.headers.get("x-heimdall-idp-signature") ?? undefined,
          timestamp: request.headers.get("x-heimdall-idp-timestamp") ?? undefined,
        });
        const sessionWrite = requireValue(adminAuth.sessionManager).create(actor);
        const loginAudit = await getAdminControlPlaneService().recordAuditEvent({
          action: "admin.session.created",
          actor,
          metadata: {
            capabilities: adminCapabilities(actor),
            permissions: actor.permissions,
            provider: actor.provider,
            repoIds: actor.repoIds,
            requestId,
            sessionId: sessionWrite.session.sessionId,
          },
          orgId: primaryActorOrgId(actor),
          requestId,
          resourceId: sessionWrite.session.sessionId,
          resourceType: "admin_session",
          sessionId: sessionWrite.session.sessionId,
        });
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: actor.actorUserId,
          attributes: {
            auditLogId: loginAudit.auditLogId,
            provider: actor.provider,
          },
          name: "admin.auth.success",
          orgId: primaryActorOrgId(actor),
          requestId,
          statusCode: 200,
        });
        setAdminResponseHeaders(request, set, adminAuth, requestId, sessionWrite.cookie);

        return {
          data: { ...publicAdminSession(sessionWrite.session), auditLogId: loginAudit.auditLogId },
        };
      } catch (error) {
        const response = handleAdminAuthError(error, set);
        recordAdminAccessDenied(
          observabilitySink,
          request,
          requestId,
          response.error.code,
          statusCodeFromSet(set, 401),
        );
        return response;
      }
    })
    .post("/admin/auth/logout", async ({ request, set }) => {
      const guardResult = guardAdminSession(request, set, adminAuth, observabilitySink);
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const logoutAudit = await getAdminControlPlaneService().recordAuditEvent({
        action: "admin.session.revoked",
        actor: guardResult.actor,
        metadata: {
          permissions: guardResult.actor.permissions,
          provider: guardResult.actor.provider,
          requestId: guardResult.requestId,
          sessionId: guardResult.session.sessionId,
        },
        orgId: primaryActorOrgId(guardResult.actor),
        requestId: guardResult.requestId,
        resourceId: guardResult.session.sessionId,
        resourceType: "admin_session",
        sessionId: guardResult.session.sessionId,
      });
      setAdminResponseHeaders(
        request,
        set,
        adminAuth,
        guardResult.requestId,
        requireValue(adminAuth.sessionManager).clear(),
      );
      recordAdminTelemetry(observabilitySink, request, {
        actorUserId: guardResult.actor.actorUserId,
        attributes: {
          auditLogId: logoutAudit.auditLogId,
          provider: guardResult.actor.provider,
        },
        name: "admin.session.revoked",
        orgId: primaryActorOrgId(guardResult.actor),
        requestId: guardResult.requestId,
        statusCode: 200,
      });

      return { data: { auditLogId: logoutAudit.auditLogId, ok: true } };
    })
    .get("/admin/session", ({ request, set }) => {
      const guardResult = guardAdminSession(request, set, adminAuth, observabilitySink);
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const rotated = requireValue(adminAuth.sessionManager).rotate(guardResult.session);
      setAdminResponseHeaders(request, set, adminAuth, guardResult.requestId, rotated.cookie);
      return { data: publicAdminSession(rotated.session) };
    })
    .get("/admin/debug/webhooks/:webhookEventId", async ({ params, request, set }) => {
      const guardResult = guardAdminSession(
        request,
        set,
        adminAuth,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const details = await getAdminDebugService().getWebhookDebugDetails(params.webhookEventId);
        const authorizationResponse = guardScopedAccess(
          guardResult.actor,
          details.webhookEvent.orgId,
          details.webhookEvent.repoId,
          set,
        );
        return authorizationResponse ?? { data: details };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/admin/debug/webhooks/:webhookEventId/replay-plan", async ({ params, request, set }) => {
      const guardResult = guardAdminSession(
        request,
        set,
        adminAuth,
        observabilitySink,
        "admin.replay.plan",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const plan = await getAdminDebugService().createWebhookReplayPlan(params.webhookEventId);
        const fallbackDetails =
          plan.jobs.length === 0
            ? await getAdminDebugService().getWebhookDebugDetails(params.webhookEventId)
            : undefined;
        const authorizationResponse =
          plan.jobs.length > 0
            ? await guardPlanScopedAccess(
                guardResult.actor,
                plan.jobs,
                set,
                getAdminControlPlaneService(),
              )
            : guardScopedAccess(
                guardResult.actor,
                fallbackDetails?.webhookEvent.orgId,
                fallbackDetails?.webhookEvent.repoId,
                set,
              );
        return authorizationResponse ?? { data: plan };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/admin/debug/webhooks/:webhookEventId/replay", async ({ params, request, set }) => {
      const guardResult = guardAdminSession(
        request,
        set,
        adminAuth,
        observabilitySink,
        "admin.replay.execute",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const confirmationToken = await readConfirmationToken(request);
      if (!confirmationToken) {
        set.status = 400;
        return adminInvalidConfirmationResponse();
      }

      try {
        const plan = await getAdminDebugService().createWebhookReplayPlan(params.webhookEventId);
        const fallbackDetails =
          plan.jobs.length === 0
            ? await getAdminDebugService().getWebhookDebugDetails(params.webhookEventId)
            : undefined;
        const authorizationResponse =
          plan.jobs.length > 0
            ? await guardPlanScopedAccess(
                guardResult.actor,
                plan.jobs,
                set,
                getAdminControlPlaneService(),
              )
            : guardScopedAccess(
                guardResult.actor,
                fallbackDetails?.webhookEvent.orgId,
                fallbackDetails?.webhookEvent.repoId,
                set,
              );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const replay = await getAdminDebugService().executeWebhookReplay(
          params.webhookEventId,
          confirmationToken,
          replayAuditActor(guardResult),
        );
        const scope = plan.jobs[0] ?? fallbackDetails?.webhookEvent;
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: {
            replayKind: "webhook",
            resourceId: params.webhookEventId,
          },
          name: "admin.replay.dispatched",
          orgId: scope?.orgId,
          repoId: scope?.repoId,
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: replay };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .get("/admin/debug/reviews/:reviewRunId", async ({ params, request, set }) => {
      const guardResult = guardAdminSession(
        request,
        set,
        adminAuth,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const details = await getAdminDebugService().getReviewDebugDetails(params.reviewRunId);
        const authorizationResponse = await guardRepoIdScopedAccess(
          guardResult.actor,
          details.reviewRun.repoId,
          set,
          getAdminControlPlaneService(),
        );
        return authorizationResponse ?? { data: details };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/admin/debug/reviews/:reviewRunId/replay-plan", async ({ params, request, set }) => {
      const guardResult = guardAdminSession(
        request,
        set,
        adminAuth,
        observabilitySink,
        "admin.replay.plan",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const plan = await getAdminDebugService().createReviewReplayPlan(params.reviewRunId);
        const authorizationResponse = await guardPlanScopedAccess(
          guardResult.actor,
          [plan.job],
          set,
          getAdminControlPlaneService(),
        );
        return authorizationResponse ?? { data: plan };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/admin/debug/reviews/:reviewRunId/replay", async ({ params, request, set }) => {
      const guardResult = guardAdminSession(
        request,
        set,
        adminAuth,
        observabilitySink,
        "admin.replay.execute",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const confirmationToken = await readConfirmationToken(request);
      if (!confirmationToken) {
        set.status = 400;
        return adminInvalidConfirmationResponse();
      }

      try {
        const plan = await getAdminDebugService().createReviewReplayPlan(params.reviewRunId);
        const authorizationResponse = await guardPlanScopedAccess(
          guardResult.actor,
          [plan.job],
          set,
          getAdminControlPlaneService(),
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const replay = await getAdminDebugService().executeReviewReplay(
          params.reviewRunId,
          confirmationToken,
          replayAuditActor(guardResult),
        );
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: {
            replayKind: "review",
            resourceId: params.reviewRunId,
          },
          name: "admin.replay.dispatched",
          orgId: plan.job.orgId,
          repoId: plan.job.repoId,
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: replay };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .get("/admin/debug/publisher/:reviewRunId", async ({ params, request, set }) => {
      const guardResult = guardAdminSession(
        request,
        set,
        adminAuth,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const details = await getAdminDebugService().getPublisherDebugDetails(params.reviewRunId);
        const repositoryScopeResponse = await guardRepoIdScopedAccess(
          guardResult.actor,
          details.repoId,
          set,
          getAdminControlPlaneService(),
        );
        if (repositoryScopeResponse) {
          return repositoryScopeResponse;
        }

        const authorizationResponse = await guardJobsScopedAccess(
          guardResult.actor,
          [...details.relatedJobs, ...details.publishRuns],
          set,
          getAdminControlPlaneService(),
        );
        return authorizationResponse ?? { data: details };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/admin/debug/publisher/:reviewRunId/replay-plan", async ({ params, request, set }) => {
      const guardResult = guardAdminSession(
        request,
        set,
        adminAuth,
        observabilitySink,
        "admin.replay.plan",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const plan = await getAdminDebugService().createPublisherReplayPlan(params.reviewRunId);
        const authorizationResponse = await guardPlanScopedAccess(
          guardResult.actor,
          [plan.job],
          set,
          getAdminControlPlaneService(),
        );
        return authorizationResponse ?? { data: plan };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/admin/debug/publisher/:reviewRunId/replay", async ({ params, request, set }) => {
      const guardResult = guardAdminSession(
        request,
        set,
        adminAuth,
        observabilitySink,
        "admin.replay.execute",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const confirmationToken = await readConfirmationToken(request);
      if (!confirmationToken) {
        set.status = 400;
        return adminInvalidConfirmationResponse();
      }

      try {
        const plan = await getAdminDebugService().createPublisherReplayPlan(params.reviewRunId);
        const authorizationResponse = await guardPlanScopedAccess(
          guardResult.actor,
          [plan.job],
          set,
          getAdminControlPlaneService(),
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const replay = await getAdminDebugService().executePublisherReplay(
          params.reviewRunId,
          confirmationToken,
          replayAuditActor(guardResult),
        );
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: {
            replayKind: "publisher",
            resourceId: params.reviewRunId,
          },
          name: "admin.replay.dispatched",
          orgId: plan.job.orgId,
          repoId: plan.job.repoId,
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: replay };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .get("/admin/repos/:repoId/settings", async ({ params, request, set }) => {
      const guardResult = guardAdminSession(
        request,
        set,
        adminAuth,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardScopedAccess(
          guardResult.actor,
          settings.repository.orgId,
          settings.repository.repoId,
          set,
        );
        return authorizationResponse ?? { data: settings };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .patch("/admin/repos/:repoId/settings", async ({ params, request, set }) => {
      const guardResult = guardAdminSession(
        request,
        set,
        adminAuth,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const parsed = safeParseWithSchema(
        "UpdateRepositoryControlPlaneSettingsRequest",
        UpdateRepositoryControlPlaneSettingsRequestSchema,
        await request.json().catch(() => undefined),
      );
      if (!parsed.ok) {
        set.status = 400;
        return {
          error: {
            code: parsed.error.code,
            message: parsed.error.message,
          },
        };
      }

      try {
        const before = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardScopedAccess(
          guardResult.actor,
          before.repository.orgId,
          before.repository.repoId,
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const settings = await getAdminControlPlaneService().updateRepositorySettings(
          params.repoId,
          parsed.value,
          {
            actor: guardResult.actor,
            requestId: guardResult.requestId,
            sessionId: guardResult.session.sessionId,
          },
        );
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: {
            repositoryEnabled: settings.repository.enabled,
            severityThreshold: settings.settings.severityThreshold,
          },
          name: "admin.settings.updated",
          orgId: settings.repository.orgId,
          repoId: settings.repository.repoId,
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: settings };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/admin/audit-logs", async ({ request, set }) => {
      const guardResult = guardAdminSession(
        request,
        set,
        adminAuth,
        observabilitySink,
        "admin.audit.view",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const query = auditLogQueryFromUrl(new URL(request.url));
      const authorizationResponse = guardAuditQueryScope(guardResult.actor, query, set);
      if (authorizationResponse) {
        return authorizationResponse;
      }

      return { data: { auditLogs: await getAdminControlPlaneService().listAuditLogs(query) } };
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

/** Creates the durable control-plane service backed by the database. */
function createAdminControlPlaneService(dependencies: {
  /** Database used to read settings and write audit logs. */
  readonly db: HeimdallDatabase;
}): AdminControlPlaneService {
  return {
    getRepositorySettings: (repoId) => getRepositorySettings(dependencies.db, repoId),
    listAuditLogs: (query) => listAuditLogs(dependencies.db, query),
    recordAuditEvent: (event) => insertAuditLog(dependencies.db, event),
    updateRepositorySettings: (repoId, patch, audit) =>
      updateRepositorySettings(dependencies.db, repoId, patch, audit),
  };
}

/** Gets repository settings, falling back to default settings when the row is absent. */
async function getRepositorySettings(
  db: HeimdallDatabase,
  repoId: string,
): Promise<AdminControlPlaneSettings> {
  const repositoryRepository = new RepositoryRepository(db);
  const repository = await repositoryRepository.getRepository(repoId);
  if (!repository) {
    throw new AdminControlPlaneNotFoundError("repository", repoId);
  }

  return {
    repository,
    settings:
      (await repositoryRepository.getSettings(repoId)) ??
      defaultRepositorySettings(repoId, repository.updatedAt),
  };
}

/** Updates repository settings and appends a before/after audit record atomically. */
async function updateRepositorySettings(
  db: HeimdallDatabase,
  repoId: string,
  patch: UpdateRepositoryControlPlaneSettingsRequest,
  audit: Omit<
    AdminAuditEventInput,
    "action" | "metadata" | "orgId" | "resourceId" | "resourceType"
  >,
): Promise<AdminControlPlaneSettings> {
  return db.transaction(async (tx) => {
    const repositoryRepository = new RepositoryRepository(tx as HeimdallDatabase);
    const before = await getRepositorySettings(tx as HeimdallDatabase, repoId);
    let repository = before.repository;
    if (patch.repositoryEnabled !== undefined) {
      repository = await repositoryRepository.updateRepositoryEnabled(
        repoId,
        patch.repositoryEnabled,
      );
    }

    const settingsPatch = settingsOnlyPatch(patch);
    const settings =
      Object.keys(settingsPatch).length > 0
        ? await repositoryRepository.upsertSettings({
            ...before.settings,
            ...settingsPatch,
            updatedAt: new Date().toISOString(),
          })
        : before.settings;

    await insertAuditLog(tx as HeimdallDatabase, {
      ...audit,
      action: "repo.settings.updated",
      metadata: {
        after: { repository, settings },
        before,
        changedFields: Object.keys(patch).sort(),
        requestId: audit.requestId,
        sessionId: audit.sessionId,
      },
      orgId: repository.orgId,
      resourceId: repoId,
      resourceType: "repository",
    });

    return { repository, settings };
  });
}

/** Lists audit logs with strict filters and deterministic ordering. */
async function listAuditLogs(
  db: HeimdallDatabase,
  query: AdminAuditLogQuery,
): Promise<readonly AdminAuditLogSummary[]> {
  const conditions: SQL[] = [];
  if (query.orgId) {
    conditions.push(eq(auditLogs.orgId, query.orgId));
  }
  if (query.resourceType) {
    conditions.push(eq(auditLogs.resourceType, query.resourceType));
  }
  if (query.resourceId) {
    conditions.push(eq(auditLogs.resourceId, query.resourceId));
  }
  if (query.actorUserId) {
    conditions.push(eq(auditLogs.actorUserId, query.actorUserId));
  }
  if (query.action) {
    conditions.push(eq(auditLogs.action, query.action));
  }
  if (query.search) {
    const pattern = `%${query.search}%`;
    const searchCondition = or(
      ilike(auditLogs.action, pattern),
      ilike(auditLogs.resourceType, pattern),
      ilike(auditLogs.resourceId, pattern),
      ilike(auditLogs.actorUserId, pattern),
      ilike(sql<string>`${auditLogs.metadata}::text`, pattern),
    );
    if (searchCondition) {
      conditions.push(searchCondition);
    }
  }

  const rows = await db
    .select()
    .from(auditLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLogs.occurredAt))
    .limit(query.limit);

  return rows.map(toAuditLogSummary);
}

/** Inserts one admin audit log row. */
async function insertAuditLog(
  db: HeimdallDatabase,
  event: AdminAuditEventInput,
): Promise<AdminAuditLogSummary> {
  const [row] = await db
    .insert(auditLogs)
    .values({
      action: event.action,
      actorType: event.actor.actorType,
      actorUserId: event.actor.actorUserId,
      auditLogId: newAuditLogId(),
      metadata: {
        actor: {
          email: event.actor.email,
          displayName: event.actor.displayName,
          permissions: event.actor.permissions,
          provider: event.actor.provider,
          providerSubject: event.actor.providerSubject,
          role: event.actor.role,
        },
        requestId: event.requestId,
        sessionId: event.sessionId,
        ...event.metadata,
      },
      occurredAt: new Date(),
      orgId: event.orgId,
      resourceId: event.resourceId,
      resourceType: event.resourceType,
    })
    .returning();

  return toAuditLogSummary(requireReturnedRow(row));
}

/** Resolves admin control-plane authentication settings from options and environment. */
function resolveAdminControlPlaneAuth(
  options: AdminControlPlaneAuthOptions | undefined,
): ResolvedAdminControlPlaneAuthOptions {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const enabled = options?.enabled ?? process.env.HEIMDALL_ADMIN_ENABLED === "true";
  const routeExposure =
    options?.routeExposure ??
    parseAdminRouteExposure(process.env.HEIMDALL_ADMIN_ROUTE_EXPOSURE) ??
    "disabled";
  const secureCookies = options?.secureCookies ?? nodeEnv === "production";
  const cookieSameSite =
    options?.cookieSameSite ?? parseCookieSameSite(process.env.HEIMDALL_ADMIN_COOKIE_SAME_SITE);
  const sessionSecret = options?.sessionSecret ?? process.env.HEIMDALL_ADMIN_SESSION_SECRET;
  const identityProvider =
    options?.identityProvider ??
    parseIdentityProvider(process.env.HEIMDALL_ADMIN_IDENTITY_PROVIDER);
  const assertionSecret =
    options?.assertionSecret ?? process.env.HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET;
  const githubOrg = options?.githubOrg ?? process.env.HEIMDALL_ADMIN_GITHUB_ORG;
  const allowedOrigins =
    options?.allowedOrigins ??
    parseStringList(process.env.HEIMDALL_ADMIN_ALLOWED_ORIGINS) ??
    parseStringList(process.env.WEB_URL) ??
    [];
  const configurationError = validateResolvedAdminAuth({
    allowedOrigins,
    assertionSecret,
    enabled,
    githubOrg,
    identityProvider,
    internalHeaderName:
      options?.internalHeaderName ?? process.env.HEIMDALL_ADMIN_INTERNAL_HEADER_NAME,
    internalHeaderValue:
      options?.internalHeaderValue ?? process.env.HEIMDALL_ADMIN_INTERNAL_HEADER_VALUE,
    nodeEnv,
    routeExposure,
    cookieSameSite,
    secureCookies,
    sessionSecret,
  });

  return {
    allowedOrigins,
    assertionSecret,
    enabled,
    githubOrg,
    identityProvider,
    internalHeaderName:
      options?.internalHeaderName ?? process.env.HEIMDALL_ADMIN_INTERNAL_HEADER_NAME,
    internalHeaderValue:
      options?.internalHeaderValue ?? process.env.HEIMDALL_ADMIN_INTERNAL_HEADER_VALUE,
    routeExposure,
    sessionManager:
      enabled && sessionSecret
        ? createAdminSessionManager({
            cookieName: options?.cookieName ?? "heimdall_admin_session",
            maxAgeSeconds: options?.sessionMaxAgeSeconds ?? 8 * 60 * 60,
            sameSite: cookieSameSite,
            secure: secureCookies,
            sessionSecret,
          })
        : undefined,
    ...(configurationError ? { configurationError } : {}),
  };
}

/** Validates resolved admin auth settings. */
function validateResolvedAdminAuth(input: {
  /** Whether admin routes are enabled. */
  readonly enabled: boolean;
  /** Route exposure policy. */
  readonly routeExposure: AdminRouteExposure;
  /** Internal header name. */
  readonly internalHeaderName?: string | undefined;
  /** Internal header value. */
  readonly internalHeaderValue?: string | undefined;
  /** Identity provider. */
  readonly identityProvider?: AdminIdentityProvider | undefined;
  /** Required GitHub organization for github_org providers. */
  readonly githubOrg?: string | undefined;
  /** Assertion signing secret. */
  readonly assertionSecret?: string | undefined;
  /** Session signing secret. */
  readonly sessionSecret?: string | undefined;
  /** Whether cookies are secure. */
  readonly secureCookies: boolean;
  /** SameSite policy used for browser session cookies. */
  readonly cookieSameSite?: "Strict" | "Lax" | "None" | undefined;
  /** Allowed CORS origins. */
  readonly allowedOrigins: readonly string[];
  /** Node environment name. */
  readonly nodeEnv: string;
}): string | undefined {
  if (!input.enabled) {
    return undefined;
  }
  if (input.routeExposure === "disabled") {
    return "Admin control-plane routes are enabled but HEIMDALL_ADMIN_ROUTE_EXPOSURE is disabled.";
  }
  if (
    input.routeExposure === "internal" &&
    (!input.internalHeaderName || !input.internalHeaderValue)
  ) {
    return "Internal admin route exposure requires HEIMDALL_ADMIN_INTERNAL_HEADER_NAME and HEIMDALL_ADMIN_INTERNAL_HEADER_VALUE.";
  }
  if (!input.identityProvider) {
    return "Admin control-plane auth requires HEIMDALL_ADMIN_IDENTITY_PROVIDER.";
  }
  if (input.identityProvider === "github_org" && !input.githubOrg) {
    return "Admin control-plane auth requires HEIMDALL_ADMIN_GITHUB_ORG for github_org providers.";
  }
  if (!input.assertionSecret || input.assertionSecret.length < 32) {
    return "Admin control-plane auth requires a 32+ character HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET.";
  }
  if (!input.sessionSecret || input.sessionSecret.length < 32) {
    return "Admin control-plane auth requires a 32+ character HEIMDALL_ADMIN_SESSION_SECRET.";
  }
  if (input.nodeEnv === "production" && !input.secureCookies) {
    return "Production admin sessions require secure cookies.";
  }
  if (input.cookieSameSite === "None" && !input.secureCookies) {
    return "SameSite=None admin cookies require secure cookies.";
  }
  if (input.nodeEnv === "production" && input.allowedOrigins.length === 0) {
    return "Production admin CORS requires at least one explicit allowed origin.";
  }

  return undefined;
}

/** Handles admin CORS preflight requests with strict origin checks. */
function handleAdminPreflight(
  request: Request,
  set: AdminResponseSet,
  auth: ResolvedAdminControlPlaneAuthOptions,
  observabilitySink: ObservabilitySink,
): AdminErrorResponse | undefined {
  const requestId = requestIdFromRequest(request);
  const guardResponse = guardAdminConfiguration(request, set, auth, requestId, observabilitySink);
  if (guardResponse) {
    return guardResponse;
  }

  set.status = 204;
  return undefined;
}

/** Guards enabled, configured, exposed, and CORS-valid admin routes. */
function guardAdminConfiguration(
  request: Request,
  set: AdminResponseSet,
  auth: ResolvedAdminControlPlaneAuthOptions,
  requestId: string,
  observabilitySink: ObservabilitySink,
): AdminErrorResponse | undefined {
  setAdminResponseHeaders(request, set, auth, requestId);
  if (!auth.enabled || auth.routeExposure === "disabled") {
    set.status = 404;
    recordAdminAccessDenied(observabilitySink, request, requestId, "admin.disabled", 404);
    return {
      error: {
        code: "admin.disabled",
        message: "Admin control-plane routes are disabled.",
      },
    };
  }
  if (auth.configurationError) {
    set.status = 503;
    recordAdminAccessDenied(observabilitySink, request, requestId, "admin.misconfigured", 503);
    return {
      error: {
        code: "admin.misconfigured",
        message: auth.configurationError,
      },
    };
  }
  if (auth.routeExposure === "internal") {
    const headerValue = request.headers.get(requireValue(auth.internalHeaderName));
    if (headerValue !== auth.internalHeaderValue) {
      set.status = 404;
      recordAdminAccessDenied(observabilitySink, request, requestId, "admin.not_exposed", 404);
      return {
        error: {
          code: "admin.not_exposed",
          message: "Admin control-plane routes are not exposed on this route.",
        },
      };
    }
  }

  const origin = request.headers.get("origin");
  if (
    (!isCsrfSafeMethod(request.method) && !origin) ||
    (origin && !auth.allowedOrigins.includes(origin))
  ) {
    set.status = 403;
    recordAdminAccessDenied(observabilitySink, request, requestId, "admin.cors_forbidden", 403, {
      ...(origin ? { origin } : {}),
    });
    return {
      error: {
        code: "admin.cors_forbidden",
        message: "Origin is not allowed for admin control-plane requests.",
      },
    };
  }

  return undefined;
}

/** Guards an authenticated session and optional permission. */
function guardAdminSession(
  request: Request,
  set: AdminResponseSet,
  auth: ResolvedAdminControlPlaneAuthOptions,
  observabilitySink: ObservabilitySink,
  permission?: AdminPermission,
): AdminRequestContext | { readonly response: AdminErrorResponse } {
  const requestId = requestIdFromRequest(request);
  const configResponse = guardAdminConfiguration(request, set, auth, requestId, observabilitySink);
  if (configResponse) {
    return { response: configResponse };
  }

  const session = requireValue(auth.sessionManager).read(request.headers.get("cookie"));
  if (!session) {
    set.status = 401;
    recordAdminAccessDenied(observabilitySink, request, requestId, "admin.unauthorized", 401);
    return {
      response: {
        error: {
          code: "admin.unauthorized",
          message: "Admin session is missing, invalid, or expired.",
        },
      },
    };
  }

  if (
    !isCsrfSafeMethod(request.method) &&
    !verifyCsrfToken(session, request.headers.get("x-csrf-token"))
  ) {
    set.status = 403;
    recordAdminAccessDenied(observabilitySink, request, requestId, "admin.csrf_forbidden", 403);
    return {
      response: {
        error: {
          code: "admin.csrf_forbidden",
          message: "Admin mutation requires a valid CSRF token.",
        },
      },
    };
  }

  if (permission && !actorHasPermission(session.actor, permission)) {
    set.status = 403;
    recordAdminAccessDenied(observabilitySink, request, requestId, "admin.forbidden", 403, {
      actorUserId: session.actor.actorUserId,
      permission,
    });
    return {
      response: {
        error: {
          code: "admin.forbidden",
          message: `Admin permission ${permission} is required.`,
        },
      },
    };
  }

  return { actor: session.actor, requestId, session };
}

/** Guards organization and repository scope for a loaded resource. */
function guardScopedAccess(
  actor: AdminActor,
  orgId: string | undefined,
  repoId: string | undefined,
  set: AdminStatusSet,
): AdminErrorResponse | undefined {
  if (actorCanAccessRepo(actor, repoId, orgId)) {
    return undefined;
  }

  set.status = 403;
  return {
    error: {
      code: "admin.scope_forbidden",
      message: "Admin actor is not scoped to this organization or repository.",
    },
  };
}

/** Guards scope over replay plan jobs. */
async function guardPlanScopedAccess(
  actor: AdminActor,
  jobs: readonly { readonly orgId?: string; readonly repoId?: string }[],
  set: AdminStatusSet,
  service: AdminControlPlaneService,
): Promise<AdminErrorResponse | undefined> {
  if (jobs.length === 0) {
    return undefined;
  }

  for (const job of jobs) {
    const response = await guardMaybeRepoScopedAccess(actor, job.repoId, job.orgId, set, service);
    if (response) {
      return response;
    }
  }

  return undefined;
}

/** Guards scope over durable job summaries. */
async function guardJobsScopedAccess(
  actor: AdminActor,
  jobs: readonly { readonly orgId?: string; readonly repoId?: string }[],
  set: AdminStatusSet,
  service: AdminControlPlaneService,
): Promise<AdminErrorResponse | undefined> {
  if (jobs.length === 0) {
    return undefined;
  }

  for (const job of jobs) {
    const response = await guardMaybeRepoScopedAccess(actor, job.repoId, job.orgId, set, service);
    if (response) {
      return response;
    }
  }

  return undefined;
}

/** Guards scope for a loaded repository ID by resolving its organization. */
async function guardRepoIdScopedAccess(
  actor: AdminActor,
  repoId: string,
  set: AdminStatusSet,
  service: AdminControlPlaneService,
): Promise<AdminErrorResponse | undefined> {
  return guardMaybeRepoScopedAccess(actor, repoId, undefined, set, service);
}

/** Guards scope for an optional repository ID and organization ID. */
async function guardMaybeRepoScopedAccess(
  actor: AdminActor,
  repoId: string | undefined,
  orgId: string | undefined,
  set: AdminStatusSet,
  service: AdminControlPlaneService,
): Promise<AdminErrorResponse | undefined> {
  if (actorCanAccessRepo(actor, repoId, orgId)) {
    return undefined;
  }
  if (repoId) {
    const settings = await service.getRepositorySettings(repoId).catch(() => undefined);
    if (settings && actorCanAccessRepo(actor, repoId, settings.repository.orgId)) {
      return undefined;
    }
  }

  return guardScopedAccess(actor, orgId, repoId, set);
}

/** Guards audit query scope before search execution. */
function guardAuditQueryScope(
  actor: AdminActor,
  query: AdminAuditLogQuery,
  set: AdminStatusSet,
): AdminErrorResponse | undefined {
  if (query.orgId && !actorCanAccessOrg(actor, query.orgId)) {
    return guardScopedAccess(actor, query.orgId, undefined, set);
  }

  if (!query.orgId && !actor.orgIds.includes("*")) {
    set.status = 403;
    return {
      error: {
        code: "admin.audit_scope_required",
        message:
          "Audit history requires an orgId filter unless the actor has all-organization scope.",
      },
    };
  }

  return undefined;
}

/** Applies security, request ID, cookie, and strict CORS response headers. */
function setAdminResponseHeaders(
  request: Request,
  set: AdminResponseSet,
  auth: ResolvedAdminControlPlaneAuthOptions,
  requestId: string,
  cookie?: string,
): void {
  const origin = request.headers.get("origin");
  set.headers = {
    ...(set.headers ?? {}),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-request-id": requestId,
  };

  if (origin && auth.allowedOrigins.includes(origin)) {
    set.headers["access-control-allow-credentials"] = "true";
    set.headers["access-control-allow-headers"] =
      "content-type,x-csrf-token,x-heimdall-idp-assertion,x-heimdall-idp-signature,x-heimdall-idp-timestamp,x-request-id";
    set.headers["access-control-allow-methods"] = "GET,POST,PATCH,OPTIONS";
    set.headers["access-control-allow-origin"] = origin;
    set.headers.vary = "Origin";
  }

  if (cookie) {
    set.headers["set-cookie"] = cookie;
  }
}

/** Returns a public session DTO for the dashboard. */
function publicAdminSession(session: AdminSession) {
  return {
    actor: {
      actorType: session.actor.actorType,
      email: session.actor.email,
      displayName: session.actor.displayName,
      provider: session.actor.provider,
      role: session.actor.role,
      userId: session.actor.actorUserId,
    },
    capabilities: adminCapabilities(session.actor),
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
    permissions: session.actor.permissions,
    scopes: {
      orgIds: session.actor.orgIds,
      repoIds: session.actor.repoIds,
    },
    sessionId: session.sessionId,
  };
}

/** Returns the primary organization scope to attach to actor-level audit events. */
function primaryActorOrgId(actor: AdminActor): string | undefined {
  return actor.orgIds.find((orgId) => orgId !== "*");
}

/** Converts a control-plane actor to the replay audit actor contract. */
function replayAuditActor(context: AdminRequestContext): AdminReplayAuditActor {
  return {
    actorType: context.actor.actorType,
    actorUserId: context.actor.actorUserId,
    permissions: context.actor.permissions,
    provider: context.actor.provider,
    requestId: context.requestId,
    role: context.actor.role,
    sessionId: context.session.sessionId,
    ...(context.actor.displayName ? { displayName: context.actor.displayName } : {}),
    ...(context.actor.email ? { email: context.actor.email } : {}),
  };
}

/** Extracts a replay confirmation token from a JSON request body. */
async function readConfirmationToken(request: Request): Promise<string | undefined> {
  const body = await request.json().catch(() => undefined);
  const record = body && typeof body === "object" && !Array.isArray(body) ? body : undefined;
  const confirmationToken = (record as { confirmationToken?: unknown } | undefined)
    ?.confirmationToken;
  return typeof confirmationToken === "string" && confirmationToken.length > 0
    ? confirmationToken
    : undefined;
}

/** Converts admin auth domain errors into API responses. */
function handleAdminAuthError(error: unknown, set: AdminStatusSet) {
  if (error instanceof AdminSecurityError) {
    set.status = error.status;
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  throw error;
}

/** Converts admin-debug domain errors into API responses. */
function handleAdminDebugError(error: unknown, set: AdminStatusSet) {
  if (error instanceof AdminDebugNotFoundError) {
    set.status = 404;
    return adminNotFoundResponse(error.resourceType, error.resourceId, error.message);
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

/** Converts control-plane domain errors into API responses. */
function handleAdminControlPlaneError(error: unknown, set: AdminStatusSet) {
  if (error instanceof AdminControlPlaneNotFoundError) {
    set.status = 404;
    return adminNotFoundResponse(error.resourceType, error.resourceId, error.message);
  }

  throw error;
}

/** Returns a structured not-found response. */
function adminNotFoundResponse(resourceType: string, resourceId: string, message: string) {
  return {
    error: {
      code: "admin.not_found",
      details: {
        resourceId,
        resourceType,
      },
      message,
    },
  };
}

/** Returns the error response for missing or malformed replay confirmations. */
function adminInvalidConfirmationResponse() {
  return {
    error: {
      code: "admin_debug.invalid_confirmation",
      message: "Replay requests require a JSON confirmationToken.",
    },
  };
}

/** Records one admin control-plane telemetry event for the current request. */
function recordAdminTelemetry(
  observabilitySink: ObservabilitySink,
  request: Request,
  event: AdminTelemetryRequestEventInput,
): void {
  const { actorUserId, orgId, repoId, ...baseEvent } = event;
  tryRecordAdminControlPlaneTelemetryEvent(observabilitySink, {
    ...baseEvent,
    ...(actorUserId ? { actorUserId } : {}),
    ...(orgId ? { orgId } : {}),
    ...(repoId ? { repoId } : {}),
    route: routeFromRequest(request),
  });
}

/** Records a denied admin access event for alerting and audit correlation. */
function recordAdminAccessDenied(
  observabilitySink: ObservabilitySink,
  request: Request,
  requestId: string,
  code: string,
  statusCode: number,
  attributes: Record<string, string | number | boolean> = {},
): void {
  recordAdminTelemetry(observabilitySink, request, {
    attributes: {
      code,
      method: request.method,
      ...attributes,
    },
    name: "admin.access.denied",
    requestId,
    statusCode,
  });
}

/** Returns a numeric status code from an Elysia set object. */
function statusCodeFromSet(set: AdminStatusSet, fallback: number): number {
  return typeof set.status === "number" ? set.status : fallback;
}

/** Returns the path component of a request URL. */
function routeFromRequest(request: Request): string {
  return new URL(request.url).pathname;
}

/** Returns a request ID from a header or generates one. */
function requestIdFromRequest(request: Request): string {
  return request.headers.get("x-request-id") ?? `req_${randomUUID()}`;
}

/** Converts a URL into a bounded audit query. */
function auditLogQueryFromUrl(url: URL): AdminAuditLogQuery {
  return {
    action: optionalQueryString(url, "action"),
    actorUserId: optionalQueryString(url, "actorUserId"),
    limit: boundedLimit(url.searchParams.get("limit")),
    orgId: optionalQueryString(url, "orgId"),
    resourceId: optionalQueryString(url, "resourceId"),
    resourceType: optionalQueryString(url, "resourceType"),
    search: optionalQueryString(url, "search"),
  };
}

/** Reads a non-empty query string value. */
function optionalQueryString(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value && value.length > 0 ? value : undefined;
}

/** Parses a safe audit query row limit. */
function boundedLimit(value: string | null): number {
  const parsed = Number(value ?? 50);
  if (!Number.isSafeInteger(parsed)) {
    return 50;
  }

  return Math.min(100, Math.max(1, parsed));
}

/** Returns a patch object that contains only repository settings fields. */
function settingsOnlyPatch(
  patch: UpdateRepositoryControlPlaneSettingsRequest,
): Partial<RepositorySettings> {
  const { repositoryEnabled: _repositoryEnabled, ...settingsPatch } = patch;
  return settingsPatch;
}

/** Builds default settings for repositories without a settings row. */
function defaultRepositorySettings(repoId: string, timestamp: string): RepositorySettings {
  return {
    ...DEFAULT_REPOSITORY_SETTINGS,
    createdAt: timestamp,
    ignoredAuthors: [...DEFAULT_REPOSITORY_SETTINGS.ignoredAuthors],
    ignoredLabels: [...DEFAULT_REPOSITORY_SETTINGS.ignoredLabels],
    ignoredPaths: [...DEFAULT_REPOSITORY_SETTINGS.ignoredPaths],
    repoId,
    updatedAt: timestamp,
  };
}

/** Converts an audit log row to the dashboard summary shape. */
function toAuditLogSummary(row: {
  readonly auditLogId: string;
  readonly orgId: string | null;
  readonly actorType: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly occurredAt: Date;
  readonly metadata: unknown;
}): AdminAuditLogSummary {
  return {
    action: row.action,
    actorType: row.actorType,
    auditLogId: row.auditLogId,
    metadata: row.metadata,
    occurredAt: row.occurredAt.toISOString(),
    orgId: row.orgId ?? undefined,
    actorUserId: row.actorUserId ?? undefined,
    resourceId: row.resourceId ?? undefined,
    resourceType: row.resourceType,
  };
}

/** Returns a row or throws when a database write unexpectedly returned nothing. */
function requireReturnedRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error("Database write did not return a row.");
  }

  return row;
}

/** Returns a defined value or throws for miswired code paths. */
function requireValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Required admin control-plane value was not configured.");
  }

  return value;
}

/** Creates a new audit log ID. */
function newAuditLogId(): string {
  return `audit_${randomUUID()}`;
}

/** Parses a route exposure value. */
function parseAdminRouteExposure(value: string | undefined): AdminRouteExposure | undefined {
  return value === "disabled" || value === "internal" || value === "public" ? value : undefined;
}

/** Parses an identity provider value. */
function parseIdentityProvider(value: string | undefined): AdminIdentityProvider | undefined {
  return value === "oidc" || value === "saml" || value === "github_org" ? value : undefined;
}

/** Parses an admin session cookie SameSite policy. */
function parseCookieSameSite(value: string | undefined): "Strict" | "Lax" | "None" | undefined {
  return value === "Strict" || value === "Lax" || value === "None" ? value : undefined;
}

/** Parses a JSON or comma-separated string list. */
function parseStringList(value: string | undefined): readonly string[] | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  if (value.trim().startsWith("[")) {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : undefined;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
