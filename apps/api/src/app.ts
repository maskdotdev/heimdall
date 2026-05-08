import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { openapi } from "@elysia/openapi";
import {
  AdminDebugConfirmationError,
  AdminDebugNotFoundError,
  type AdminDebugService,
  type AdminFailureDetail,
  type AdminFailureSource,
  type AdminReplayAuditActor,
  createAdminDebugService,
  type ImportReviewRunToEvalRequest,
  redactDebugBundleValue,
} from "@repo/admin-tools";
import {
  createReviewArtifactPayloadStoreFromEnvironment,
  hasReviewArtifactPayloadStorage,
  InlineReviewArtifactPayloadStore,
  type ReviewArtifactPayloadStore,
} from "@repo/artifacts";
import {
  type BillingProvider,
  type BillingProviderRequestLogger,
  type BillingProviderRequestLogInput,
  type BillingWebhookHeaders,
  billingProviderIdempotencyKey,
  type CheckoutSessionRef,
  FakeBillingProvider,
  type ParsedBillingWebhookEvent,
  type PortalSessionRef,
  type ProviderSubscription,
  StripeBillingProvider,
} from "@repo/billing";
import { loadRuntimeConfig } from "@repo/config";
import {
  type BillingReconcileJobPayload,
  type CreateBillingCheckoutSessionRequest,
  CreateBillingCheckoutSessionRequestSchema,
  type CreateBillingPortalSessionRequest,
  CreateBillingPortalSessionRequestSchema,
  type CreateRepoRuleRequest,
  CreateRepoRuleRequestSchema,
  DEFAULT_REPOSITORY_SETTINGS,
  type Entitlement,
  type EntitlementDecision,
  type EvaluationBaselineSummary,
  type EvaluationCaseResultSummary,
  type EvaluationRunSummary,
  type EvaluationSuiteSummary,
  type FindingOutcomeSignalSource,
  type FindingOutcomeType,
  type IndexRepoCommitJobPayload,
  JOB_TYPES,
  type JobEnvelope,
  type MemoryFactKind,
  type MemoryFactSource,
  type MemoryFactStatus,
  type OrgSettings,
  type PlanSnapshot,
  type ProviderInstallation,
  type RepoRule,
  type Repository,
  type RepositorySettings,
  type ReviewPullRequestJobPayload,
  type SyncInstallationJobPayload,
  safeParseWithSchema,
  type TestRepositoryPolicyRequest,
  TestRepositoryPolicyRequestSchema,
  type UpdateMemoryJobPayload,
  type UpdateOrgSettingsRequest,
  UpdateOrgSettingsRequestSchema,
  type UpdateRepoRuleRequest,
  UpdateRepoRuleRequestSchema,
  type UpdateRepositoryControlPlaneSettingsRequest,
  UpdateRepositoryControlPlaneSettingsRequestSchema,
  type UsageEventType,
  UserIdSchema,
  type ValidateRepoLocalConfigFileRequest,
  ValidateRepoLocalConfigFileRequestSchema,
} from "@repo/contracts";
import {
  artifactAccessEvents,
  auditLogs,
  type BackgroundJobRecord,
  BackgroundJobRepository,
  BillingRepository,
  billingAccounts,
  billingMeterEvents,
  billingPlans,
  billingPlanVersions,
  billingWebhookEvents,
  createDatabaseClient,
  type DatabaseClient,
  type EvalBaselineRow,
  type EvalCaseResultRow,
  type EvalRunRow,
  type EvalSuiteRow,
  EvaluationRepository,
  FeedbackRepository,
  type FeedbackTimelineRecord,
  type FindingOutcomeRecord,
  type HeimdallDatabase,
  invoices,
  type MemoryCandidateRecord,
  MemoryCandidateRepository,
  type MemoryFactRecord,
  MemoryFactRepository,
  type memoryCandidates,
  type memoryFacts,
  oauthStates,
  orgMemberships,
  orgs,
  ProviderInstallationRepository,
  providerInstallations,
  pullRequestSnapshots,
  quotaCounters,
  RepoRuleRepository,
  RepositoryRepository,
  type RepositorySuppressionMatchRecord,
  type ReviewFindingInspectionRecord,
  ReviewRepository,
  repoRuleScope,
  repoRuleType,
  repositories,
  reviewArtifacts,
  reviewRunMetrics,
  reviewRuns,
  securityEvents,
  subscriptions,
  usageEvents,
  userProviderAccounts,
  userSessions,
  users,
  WebhookRepository,
} from "@repo/db";
import {
  type AdminControlPlaneTelemetryEventInput,
  type AdminControlPlaneTelemetryEventName,
  createNoopObservabilitySink,
  createNoopTelemetryMetricRecorder,
  createNoopTelemetrySpanRecorder,
  createTelemetryTraceContextFromHeaders,
  normalizeTelemetryTraceContext,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type ObservabilitySink,
  type TelemetryMetricRecorder,
  type TelemetrySpanHandle,
  type TelemetrySpanRecorder,
  type TelemetryTraceContext,
  tryRecordAdminControlPlaneTelemetryEvent,
} from "@repo/observability";
import { QUEUE_NAMES } from "@repo/queue";
import {
  type BuildReviewPolicySnapshotResult,
  buildReviewPolicySnapshot,
  classifyPath,
  createDefaultOrgSettings,
  type EffectiveReviewPolicy,
  type EvaluateFindingPolicyInput,
  evaluateFindingPolicy,
  type FindingPolicyDecision,
  type PathClassification,
  type PolicyDecisionTrace,
  type PolicyWarning,
  parseRepoLocalConfig,
  type RepoLocalConfig,
  type RepoLocalConfigValidationError,
} from "@repo/rules";
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
  createLocalEnvSecretsManager,
  isCsrfSafeMethod,
  isProductRole,
  type ProductActor,
  type ProductMembership,
  type ProductPermission,
  parseSecretRef,
  productActorHasOrgPermission,
  productActorHasRepoPermission,
  productCapabilities,
  productPermissionsForRole,
  recordSecurityEvent,
  SECURITY_EVENT_SEVERITIES,
  SECURITY_EVENT_SOURCES,
  SECURITY_EVENT_STATUSES,
  type SecretRef,
  type SecretsManager,
  type SecurityEvent,
  type SecurityEventSeverity,
  type SecurityEventSink,
  type SecurityEventSource,
  type SecurityEventStatus,
  verifyAdminIdentityAssertion,
  verifyCsrfToken,
} from "@repo/security";
import {
  type BillingSummary,
  DefaultBillingService,
  DefaultEntitlementService,
  PLAN_LIMIT_FEATURE_KEYS,
  PostgresBillingStore,
  PostgresEntitlementStore,
} from "@repo/usage";
import {
  GitHubWebhookHandler,
  type HandleGitHubWebhookInput,
  WebhookAuthenticationError,
  type WebhookIngestionResult,
  WebhookPayloadError,
} from "@repo/webhook-ingestion";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
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
  /** Optional support-session signing secret. Defaults to the session secret. */
  readonly supportSessionSecret?: string;
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
  /** In-process admin route rate limit settings. */
  readonly rateLimit?: AdminControlPlaneRateLimitOptions;
};

/** In-process rate limit settings for admin control-plane routes. */
export type AdminControlPlaneRateLimitOptions = {
  /** Maximum requests allowed per client key in each window. */
  readonly maxRequests?: number;
  /** Sliding window duration in seconds. */
  readonly windowSeconds?: number;
  /** Maximum tracked client keys retained by this API process. */
  readonly maxEntries?: number;
};

/** Authentication settings for product user session routes. */
export type ProductSessionAuthOptions = {
  /** Whether product session routes are enabled. */
  readonly enabled?: boolean;
  /** Opaque product session cookie name. */
  readonly cookieName?: string;
  /** Secret pepper used to hash opaque session tokens before DB lookup. */
  readonly sessionPepper?: string;
  /** Whether session cookies require HTTPS. */
  readonly secureCookies?: boolean;
  /** SameSite policy used for browser session cookies. */
  readonly cookieSameSite?: "Strict" | "Lax" | "None";
  /** Session lifetime in days for newly created product sessions. */
  readonly sessionTtlDays?: number;
};

/** GitHub OAuth settings for product user login. */
export type ProductGitHubOAuthOptions = {
  /** Whether GitHub OAuth routes are enabled. */
  readonly enabled?: boolean;
  /** GitHub OAuth client ID. */
  readonly clientId?: string;
  /** GitHub OAuth client secret. */
  readonly clientSecret?: string;
  /** Public callback URL registered with GitHub. */
  readonly callbackUrl?: string;
  /** GitHub authorization endpoint. */
  readonly authorizationUrl?: string;
  /** GitHub token exchange endpoint. */
  readonly tokenUrl?: string;
  /** GitHub user profile API endpoint. */
  readonly userApiUrl?: string;
  /** GitHub user emails API endpoint. */
  readonly emailsApiUrl?: string;
  /** OAuth scopes requested from GitHub. */
  readonly scopes?: readonly string[];
  /** State lifetime in minutes. */
  readonly stateTtlMinutes?: number;
  /** Default dashboard redirect path after login. */
  readonly defaultRedirectPath?: string;
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
  /** Name of the signed admin session cookie. */
  readonly sessionCookieName: string;
  /** Secret used to sign short-lived support-session tokens. */
  readonly supportSessionSecret?: string | undefined;
  /** Strict CORS origins allowed to use admin credentials. */
  readonly allowedOrigins: readonly string[];
  /** Required GitHub organization for github_org identity providers. */
  readonly githubOrg?: string | undefined;
  /** In-process limiter for admin route requests. */
  readonly rateLimiter?: AdminRouteRateLimiter | undefined;
  /** Sink that records normalized security events for admin auth and access denials. */
  readonly securityEventSink?: SecurityEventSink | undefined;
  /** Configuration error that prevents safe admin access. */
  readonly configurationError?: string | undefined;
};

/** Resolved authentication settings for product user session routes. */
type ResolvedProductSessionAuthOptions = {
  /** Whether product session routes are enabled. */
  readonly enabled: boolean;
  /** Opaque product session cookie name. */
  readonly cookieName: string;
  /** Secret pepper used to hash opaque session tokens before DB lookup. */
  readonly sessionPepper?: string | undefined;
  /** Whether session cookies require HTTPS. */
  readonly secureCookies: boolean;
  /** SameSite policy used for browser session cookies. */
  readonly cookieSameSite: "Strict" | "Lax" | "None";
  /** Session lifetime in days for newly created product sessions. */
  readonly sessionTtlDays: number;
  /** Configuration error that prevents safe product session access. */
  readonly configurationError?: string | undefined;
};

/** Resolved GitHub OAuth settings for product user login. */
type ResolvedProductGitHubOAuthOptions = {
  /** Whether GitHub OAuth routes are enabled. */
  readonly enabled: boolean;
  /** GitHub OAuth client ID. */
  readonly clientId?: string | undefined;
  /** GitHub OAuth client secret. */
  readonly clientSecret?: string | undefined;
  /** Public callback URL registered with GitHub. */
  readonly callbackUrl?: string | undefined;
  /** GitHub authorization endpoint. */
  readonly authorizationUrl: string;
  /** GitHub token exchange endpoint. */
  readonly tokenUrl: string;
  /** GitHub user profile API endpoint. */
  readonly userApiUrl: string;
  /** GitHub user emails API endpoint. */
  readonly emailsApiUrl: string;
  /** OAuth scopes requested from GitHub. */
  readonly scopes: readonly string[];
  /** State lifetime in minutes. */
  readonly stateTtlMinutes: number;
  /** Default dashboard redirect path after login. */
  readonly defaultRedirectPath: string;
  /** Configuration error that prevents safe OAuth login. */
  readonly configurationError?: string | undefined;
};

/** Result returned by the admin route rate limiter. */
type AdminRateLimitCheck = {
  /** Whether the request may continue. */
  readonly allowed: boolean;
  /** Seconds until the current client key can retry. */
  readonly retryAfterSeconds: number;
};

/** Minimal in-process limiter used by admin control-plane routes. */
type AdminRouteRateLimiter = {
  /** Checks and records one request for a client key. */
  readonly check: (key: string, nowMs?: number) => AdminRateLimitCheck;
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

/** Structured request validation error raised by admin route body parsers. */
class AdminRequestValidationError extends Error {
  /** Machine-readable API error code. */
  public readonly code: string;

  /** HTTP status returned to the caller. */
  public readonly status: number;

  /** Creates an admin request validation error. */
  public constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AdminRequestValidationError";
    this.code = code;
    this.status = status;
  }
}

/** Structured product OAuth error raised during GitHub login. */
class ProductOAuthError extends Error {
  /** Machine-readable API error code. */
  public readonly code: string;

  /** HTTP status returned to the caller. */
  public readonly status: number;

  /** Creates a product OAuth error. */
  public constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ProductOAuthError";
    this.code = code;
    this.status = status;
  }
}

/** Supported finding outcome labels accepted by the scoped API. */
const FINDING_OUTCOME_TYPES = new Set<FindingOutcomeType>([
  "accepted",
  "rejected",
  "ignored",
  "resolved",
  "dismissed",
  "commented",
  "positive_reaction",
  "negative_reaction",
  "unknown",
]);

/** Supported finding outcome signal sources accepted by the scoped API. */
const FINDING_OUTCOME_SOURCES = new Set<FindingOutcomeSignalSource>([
  "provider_webhook",
  "user_action",
  "commit_analysis",
  "manual_label",
  "system_inference",
]);

/** Supported memory fact kinds accepted by the scoped API. */
const MEMORY_FACT_KINDS = new Set<MemoryFactKind>([
  "repo_convention",
  "suppression",
  "architecture_note",
  "review_preference",
  "domain_context",
  "tooling_note",
  "other",
]);

/** Supported memory fact sources accepted by the scoped API. */
const MEMORY_FACT_SOURCES = new Set<MemoryFactSource>([
  "explicit_rule",
  "feedback",
  "comment_thread",
  "manual",
  "system",
]);

/** Supported memory fact statuses accepted by the scoped API. */
const MEMORY_FACT_STATUSES = new Set<MemoryFactStatus>(["active", "disabled", "expired"]);

/** Supported memory candidate statuses accepted by the scoped API. */
const MEMORY_CANDIDATE_STATUSES = new Set([
  "pending",
  "approved",
  "rejected",
  "auto_activated",
  "expired",
  "superseded",
]);

/** Supported usage event types accepted by the scoped API. */
const USAGE_EVENT_TYPES = new Set<UsageEventType>([
  "review.run",
  "review.credit",
  "index.file",
  "index.chunk",
  "embedding.token",
  "llm.token",
  "github.api_call",
  "storage.artifact_written",
  "worker.job",
]);

/** Public GitHub App setup details shown on the product dashboard. */
export type ProductGitHubAppSetup = {
  /** Whether the API has enough GitHub App config to ingest and process webhooks. */
  readonly configured: boolean;
  /** GitHub App ID when configured. */
  readonly appId?: string | undefined;
  /** GitHub App slug used to build the install URL when available. */
  readonly appSlug?: string | undefined;
  /** Direct GitHub App installation URL when available. */
  readonly installUrl?: string | undefined;
  /** Whether webhook signature verification has a configured secret. */
  readonly webhookConfigured: boolean;
  /** Public webhook URL to configure in GitHub App settings when WEB_URL is known. */
  readonly webhookUrl?: string | undefined;
};

/** GitHub App installation URL response for authenticated product API callers. */
type GitHubInstallUrlResponse = {
  /** GitHub App installation URL. */
  readonly url: string;
  /** Whether the API has enough GitHub App config to ingest and process webhooks. */
  readonly configured: boolean;
  /** GitHub App slug used for the URL when available. */
  readonly appSlug?: string | undefined;
  /** Whether webhook signature verification has a configured secret. */
  readonly webhookConfigured: boolean;
  /** Public webhook URL to configure in GitHub App settings when WEB_URL is known. */
  readonly webhookUrl?: string | undefined;
};

/** Sanitized GitHub App installation callback redirect details. */
type GitHubInstallCallbackRedirect = {
  /** Dashboard URL that receives the user after GitHub redirects back. */
  readonly url: string;
  /** Provider installation ID returned by GitHub when available. */
  readonly installationId?: string | undefined;
  /** GitHub setup action when available. */
  readonly setupAction?: "install" | "update" | undefined;
  /** Opaque state value echoed by GitHub when available and syntactically valid. */
  readonly state?: string | undefined;
};

/** Public installation summary for product onboarding. */
export type ProductInstallationSummary = {
  /** Git provider. */
  readonly provider: string;
  /** GitHub account login that owns the installation. */
  readonly accountLogin: string;
  /** GitHub account type. */
  readonly accountType: string;
  /** Installation creation timestamp. */
  readonly installedAt: string;
  /** Suspension timestamp when GitHub suspended the installation. */
  readonly suspendedAt?: string | undefined;
  /** Deletion timestamp when the installation was removed. */
  readonly deletedAt?: string | undefined;
};

/** Product-facing repository summary for onboarding. */
export type ProductRepositorySummary = {
  /** Repository full name. */
  readonly fullName: string;
  /** Default branch when known. */
  readonly defaultBranch?: string | undefined;
  /** Repository visibility. */
  readonly visibility: string;
  /** Whether review automation is enabled. */
  readonly enabled: boolean;
  /** Latest review status for this repository when present. */
  readonly latestReviewStatus?: string | undefined;
};

/** Product-facing review summary for onboarding. */
export type ProductReviewSummary = {
  /** Repository full name. */
  readonly repoFullName: string;
  /** Pull request number. */
  readonly pullRequestNumber: number;
  /** Pull request title when known. */
  readonly pullRequestTitle?: string | undefined;
  /** Pull request author login when known. */
  readonly authorLogin?: string | undefined;
  /** Review run status. */
  readonly status: string;
  /** Review finding counts. */
  readonly counts: {
    /** Candidate findings produced by the review. */
    readonly candidateFindings: number;
    /** Validated findings retained after validation. */
    readonly validatedFindings: number;
    /** Published findings. */
    readonly publishedFindings: number;
    /** Rejected findings. */
    readonly rejectedFindings: number;
  };
  /** Last update timestamp. */
  readonly updatedAt: string;
};

/** Public webhook activity summary for product onboarding. */
export type ProductWebhookSummary = {
  /** Total webhook deliveries persisted by the API. */
  readonly totalDeliveries: number;
  /** Latest webhook delivery timestamp when present. */
  readonly latestDeliveryAt?: string | undefined;
  /** Latest webhook event name when present. */
  readonly latestEventName?: string | undefined;
  /** Latest webhook action when present. */
  readonly latestAction?: string | undefined;
  /** Latest webhook processing status when present. */
  readonly latestStatus?: string | undefined;
};

/** Public product onboarding payload for the normal application flow. */
export type ProductOnboardingSummary = {
  /** GitHub App setup details. */
  readonly githubApp: ProductGitHubAppSetup;
  /** Recent provider installations. */
  readonly installations: readonly ProductInstallationSummary[];
  /** Recent repositories known from installation or repository webhooks. */
  readonly repositories: readonly ProductRepositorySummary[];
  /** Recent review runs across known repositories. */
  readonly recentReviews: readonly ProductReviewSummary[];
  /** Webhook delivery activity. */
  readonly webhook: ProductWebhookSummary;
};

/** Product user DTO returned by authenticated customer-facing routes. */
export type ProductUserSummary = {
  /** Stable product user ID. */
  readonly userId: string;
  /** Primary email address when known. */
  readonly primaryEmail?: string | undefined;
  /** Display name when known. */
  readonly displayName?: string | undefined;
  /** Avatar URL when known. */
  readonly avatarUrl?: string | undefined;
};

/** Product organization membership DTO returned by the current-user route. */
export type ProductMembershipSummary = ProductMembership & {
  /** Permissions granted by the role. */
  readonly permissions: readonly ProductPermission[];
  /** Dashboard capability flags derived from the role. */
  readonly capabilities: Record<string, boolean>;
};

/** Provider installation DTO returned by the current-user route. */
export type ProductSessionInstallationSummary = {
  /** Stable installation ID. */
  readonly installationId: string;
  /** Organization that owns the installation. */
  readonly orgId: string;
  /** Provider name. */
  readonly provider: string;
  /** Provider installation ID. */
  readonly providerInstallationId: string;
  /** Provider account login. */
  readonly accountLogin: string;
  /** Provider account type. */
  readonly accountType: string;
};

/** Authenticated product session context loaded from the database. */
export type ProductSessionContext = {
  /** Stable product session ID. */
  readonly sessionId: string;
  /** Authenticated product actor. */
  readonly actor: ProductActor;
  /** Product user attached to the session. */
  readonly user: ProductUserSummary;
  /** Session expiration timestamp. */
  readonly expiresAt: string;
  /** Installations visible through the actor's organization memberships. */
  readonly installations: readonly ProductSessionInstallationSummary[];
};

/** Request used to create one DB-backed product session. */
export type ProductSessionCreateRequest = {
  /** Stable product user ID. */
  readonly userId: string;
  /** Optional selected organization for dashboard convenience. */
  readonly selectedOrgId?: string | undefined;
  /** Optional session metadata. */
  readonly metadata?: Record<string, unknown> | undefined;
};

/** Cookie write returned when a product session is created. */
export type ProductSessionCookieWrite = {
  /** Authenticated product session represented by the cookie. */
  readonly session: ProductSessionContext;
  /** Serialized Set-Cookie header value. */
  readonly cookie: string;
};

/** Request used to start GitHub OAuth login. */
export type ProductGitHubOAuthStartRequest = {
  /** Optional dashboard redirect after a successful callback. */
  readonly redirectTo?: string | undefined;
  /** Absolute API request URL used to derive the callback URL when not configured. */
  readonly requestUrl: string;
  /** Request ID propagated into OAuth state metadata. */
  readonly requestId: string;
};

/** GitHub OAuth authorization redirect details. */
export type ProductGitHubOAuthStart = {
  /** Absolute URL where the browser should be redirected. */
  readonly authorizationUrl: string;
};

/** Request used to complete GitHub OAuth login. */
export type ProductGitHubOAuthCallbackRequest = {
  /** Absolute callback URL received from GitHub. */
  readonly callbackUrl: string;
  /** Request ID propagated into OAuth state metadata. */
  readonly requestId: string;
};

/** Result of a completed GitHub OAuth login before session creation. */
export type ProductGitHubOAuthCompletion = {
  /** Stable product user ID. */
  readonly userId: string;
  /** Sanitized dashboard redirect after session creation. */
  readonly redirectTo: string;
  /** Stable GitHub user ID. */
  readonly providerUserId: string;
  /** GitHub login. */
  readonly providerLogin: string;
  /** Primary email when known. */
  readonly primaryEmail?: string | undefined;
};

/** Service surface for product GitHub OAuth login. */
export type ProductGitHubOAuthService = {
  /** Creates one OAuth state record and returns the GitHub authorization URL. */
  readonly start: (request: ProductGitHubOAuthStartRequest) => Promise<ProductGitHubOAuthStart>;
  /** Validates callback state, fetches GitHub identity, and upserts the product user. */
  readonly complete: (
    request: ProductGitHubOAuthCallbackRequest,
  ) => Promise<ProductGitHubOAuthCompletion>;
};

/** Service surface for opaque product sessions. */
export type ProductSessionService = {
  /** Creates a new DB-backed product session and opaque session cookie. */
  readonly createSession: (
    request: ProductSessionCreateRequest,
  ) => Promise<ProductSessionCookieWrite>;
  /** Reads a DB-backed product session from a Cookie header. */
  readonly readSession: (cookieHeader: string | null) => Promise<ProductSessionContext | undefined>;
  /** Revokes one product session. */
  readonly revokeSession: (sessionId: string) => Promise<void>;
  /** Returns a Set-Cookie header that clears the product session cookie. */
  readonly clearCookie: () => string;
};

/** Current product user response body. */
export type ProductMeResponse = {
  /** Product user attached to the current session. */
  readonly user: ProductUserSummary;
  /** Selected organization for dashboard convenience. */
  readonly selectedOrgId?: string | undefined;
  /** Organization memberships available to the user. */
  readonly memberships: readonly ProductMembershipSummary[];
  /** Provider installations visible through the user's memberships. */
  readonly installations: readonly ProductSessionInstallationSummary[];
  /** Current session summary. */
  readonly session: {
    /** Stable product session ID. */
    readonly sessionId: string;
    /** Session expiration timestamp. */
    readonly expiresAt: string;
  };
};

/** Service surface for the normal product onboarding dashboard. */
export type ProductDashboardService = {
  /** Loads product setup and activity state. */
  readonly getOnboarding: () => Promise<ProductOnboardingSummary>;
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

/** Per-request telemetry state kept outside route contexts. */
type ApiRequestTelemetryState = {
  /** Request start time used for duration metrics. */
  readonly startedAtMs: number;
  /** Span handle for the API server request. */
  readonly span: TelemetrySpanHandle;
};

/** Input used to close one API request telemetry record. */
type ApiRequestTelemetryEndInput = {
  /** Optional error that ended the request. */
  readonly error?: unknown;
  /** HTTP method label. */
  readonly method: string;
  /** Request object used as the telemetry state key. */
  readonly request: Request;
  /** Registered low-cardinality route pattern. */
  readonly route: string | undefined;
  /** Elysia response state after route handling. */
  readonly set: AdminStatusSet;
  /** Fallback status code when no explicit status is available. */
  readonly statusCode: number;
};

/** Supported privileged operations for time-limited support sessions. */
type SupportSessionScope = "raw_artifact_payload" | "raw_eval_import";

/** Parsed support-session header value. */
type RequestSupportSession = {
  /** Stable support-session ID used in audit records. */
  readonly supportSessionId: string;
  /** Raw header value used for signed-token verification. */
  readonly token: string;
  /** Whether the header uses the current signed-token format or a legacy opaque reference. */
  readonly format: "signed" | "legacy";
};

/** Request body accepted by the support-session creation route. */
type CreateSupportSessionRequestBody = {
  /** Human-entered reason for privileged access. */
  readonly reason: string;
  /** Optional scope list. Defaults to raw artifact and raw eval access. */
  readonly scopes?: readonly SupportSessionScope[] | undefined;
  /** Optional organization scope. */
  readonly orgId?: string | undefined;
  /** Optional repository scope. */
  readonly repoId?: string | undefined;
  /** Optional review-run scope. */
  readonly reviewRunId?: string | undefined;
  /** Requested lifetime in minutes. */
  readonly expiresInMinutes?: number | undefined;
};

/** Public support-session token response. */
type SupportSessionTokenSummary = {
  /** Stable support-session ID used in audit records. */
  readonly supportSessionId: string;
  /** Signed support-session token to send in the support-session header. */
  readonly token: string;
  /** Scope list embedded in the signed token. */
  readonly scopes: readonly SupportSessionScope[];
  /** ISO timestamp when the token expires. */
  readonly expiresAt: string;
  /** Audit log row for the session creation event. */
  readonly auditLogId: string;
  /** Optional organization scope. */
  readonly orgId?: string | undefined;
  /** Optional repository scope. */
  readonly repoId?: string | undefined;
  /** Optional review-run scope. */
  readonly reviewRunId?: string | undefined;
};

/** Signed support-session token payload. */
type SupportSessionTokenClaims = {
  /** Token schema version. */
  readonly version: typeof SUPPORT_SESSION_TOKEN_VERSION;
  /** Stable support-session ID used in audit records. */
  readonly supportSessionId: string;
  /** Actor user ID that may use this support session. */
  readonly actorUserId: string;
  /** Scope list embedded in the signed token. */
  readonly scopes: readonly SupportSessionScope[];
  /** ISO timestamp when the token was created. */
  readonly createdAt: string;
  /** ISO timestamp when the token expires. */
  readonly expiresAt: string;
  /** Optional organization scope. */
  readonly orgId?: string | undefined;
  /** Optional repository scope. */
  readonly repoId?: string | undefined;
  /** Optional review-run scope. */
  readonly reviewRunId?: string | undefined;
};

/** Resource being accessed through a support session. */
type SupportSessionResourceScope = {
  /** Organization that owns the target resource. */
  readonly orgId?: string | undefined;
  /** Repository that owns the target resource. */
  readonly repoId?: string | undefined;
  /** Review run that owns the target resource. */
  readonly reviewRunId?: string | undefined;
};

/** Provider webhook delivery status label used for telemetry. */
type WebhookTelemetryStatus = "accepted" | "duplicate" | "failed" | "ignored" | "rejected";

/** Per-delivery webhook telemetry state kept inside the route handler. */
type WebhookTelemetryState = {
  /** Delivery action label parsed from the payload when present. */
  readonly action: string;
  /** Provider event name label parsed from request headers. */
  readonly eventName: string;
  /** Provider identifier label. */
  readonly provider: string;
  /** Request ID used for trace and security-event correlation. */
  readonly requestId: string;
  /** Request start time used for duration metrics. */
  readonly startedAtMs: number;
  /** Span handle for the provider webhook delivery. */
  readonly span: TelemetrySpanHandle;
};

/** Input used to close one provider webhook telemetry record. */
type WebhookTelemetryEndInput = {
  /** Optional error that ended the delivery. */
  readonly error?: unknown;
  /** Optional product-safe rejection or failure reason. */
  readonly reason?: string;
  /** HTTP response status code assigned to the delivery. */
  readonly statusCode: number;
  /** Provider delivery status. */
  readonly webhookStatus: WebhookTelemetryStatus;
};

/** Authenticated admin request context produced by the session guard. */
type AdminRequestContext = {
  /** Provider-backed admin actor. */
  readonly actor: AdminActor;
  /** Verified admin session. */
  readonly session: AdminSession;
  /** Product-safe trace context propagated into durable work. */
  readonly traceContext: TelemetryTraceContext;
  /** Request ID propagated into audit logs. */
  readonly requestId: string;
  /** HTTP method for security-event and audit correlation. */
  readonly method: string;
  /** Request route path for security-event and audit correlation. */
  readonly route: string;
  /** Sink that records normalized security events for this request. */
  readonly securityEventSink?: SecurityEventSink | undefined;
  /** Request-scoped support-session ID for privileged raw artifact handling. */
  readonly supportSessionId?: string;
  /** Parsed support-session header value when present. */
  readonly supportSession?: RequestSupportSession | undefined;
};

/** Authenticated product request context produced by the session guard. */
type ProductRequestContext = {
  /** Verified product session. */
  readonly session: ProductSessionContext;
  /** Product-safe trace context propagated into durable work. */
  readonly traceContext: TelemetryTraceContext;
  /** Request ID propagated into response headers. */
  readonly requestId: string;
  /** HTTP method for security-event and audit correlation. */
  readonly method: string;
  /** Request route path for security-event and audit correlation. */
  readonly route: string;
};

/** Authenticated request context for customer-facing `/api/v1` resource routes. */
type ApiV1RequestContext =
  | (AdminRequestContext & {
      /** Session family that authenticated the request. */
      readonly kind: "admin";
    })
  | {
      /** Product actor adapted to the existing control-plane service boundaries. */
      readonly actor: AdminActor;
      /** Session family that authenticated the request. */
      readonly kind: "product";
      /** Product actor used for customer-facing RBAC checks. */
      readonly productActor: ProductActor;
      /** Verified product session. */
      readonly session: ProductSessionContext;
      /** Product-safe trace context propagated into durable work. */
      readonly traceContext: TelemetryTraceContext;
      /** Request ID propagated into audit logs and response headers. */
      readonly requestId: string;
      /** HTTP method for security-event and audit correlation. */
      readonly method: string;
      /** Request route path for security-event and audit correlation. */
      readonly route: string;
    };

/** Repository settings response used by the control-plane API and dashboard. */
type AdminControlPlaneSettings = {
  /** Repository row being controlled. */
  readonly repository: Repository;
  /** Mutable review settings for the repository. */
  readonly settings: RepositorySettings;
};

/** Organization settings response used by the control-plane API and dashboard. */
type AdminOrgControlPlaneSettings = {
  /** Organization row being controlled. */
  readonly org: AdminOrganizationSummary;
  /** Mutable policy defaults and guardrails for the organization. */
  readonly settings: OrgSettings;
};

/** Policy preview response for repository settings and rules UX. */
type AdminRepositoryPolicyPreview = {
  /** Stable policy snapshot ID that would be used for a review run preview. */
  readonly policySnapshotId: string;
  /** Stable hash for the effective policy JSON. */
  readonly policyHash: string;
  /** Effective policy produced by the compiler. */
  readonly effectivePolicy: EffectiveReviewPolicy;
  /** Non-fatal compiler warnings. */
  readonly warnings: readonly PolicyWarning[];
  /** Compiler trace safe for support surfaces. */
  readonly trace: PolicyDecisionTrace;
};

/** Policy test response for a sample finding and path. */
type AdminRepositoryPolicyTest = {
  /** Effective policy preview used for this test. */
  readonly preview: AdminRepositoryPolicyPreview;
  /** Path classification for the sample finding location. */
  readonly pathClassification: PathClassification;
  /** Finding policy decision for the sample finding. */
  readonly findingDecision: FindingPolicyDecision;
};

/** Repo-local reviewer config validation response for settings UX. */
type AdminRepoLocalConfigValidation = {
  /** Whether the supplied config can be parsed and used. */
  readonly valid: boolean;
  /** Parsed normalized config when validation succeeds. */
  readonly parsed?: RepoLocalConfig | undefined;
  /** Validation errors that prevent use. */
  readonly errors: readonly RepoLocalConfigValidationError[];
  /** Non-fatal validation or policy warnings. */
  readonly warnings: readonly PolicyWarning[];
};

/** Repository discovery row returned by admin overview and repository list routes. */
type AdminRepositorySummary = Repository & {
  /** Latest review run ID for this repository when available. */
  readonly latestReviewRunId?: string | undefined;
  /** Latest review status for this repository when available. */
  readonly latestReviewStatus?: string | undefined;
  /** Latest review update timestamp for this repository when available. */
  readonly latestReviewUpdatedAt?: string | undefined;
};

/** Finding counts attached to one review run. */
type AdminReviewFindingCounts = {
  /** Candidate findings emitted before validation. */
  readonly candidateFindings: number;
  /** Findings accepted by validation. */
  readonly validatedFindings: number;
  /** Findings published to the provider. */
  readonly publishedFindings: number;
  /** Findings rejected by validation. */
  readonly rejectedFindings: number;
};

/** Product-safe durable background job summary attached to review details. */
type AdminBackgroundJobSummary = {
  /** Durable background job row ID. */
  readonly backgroundJobId: string;
  /** Queue that owns the job. */
  readonly queueName: string;
  /** Durable idempotency key. */
  readonly jobKey: string;
  /** Handler type carried by the job envelope. */
  readonly jobType: string;
  /** Current durable job status. */
  readonly status: string;
  /** Organization associated with the job when available. */
  readonly orgId?: string | undefined;
  /** Repository associated with the job when available. */
  readonly repoId?: string | undefined;
  /** Review run associated with the job when available. */
  readonly reviewRunId?: string | undefined;
  /** Current durable attempt count. */
  readonly attempts: number;
  /** Maximum durable attempts allowed. */
  readonly maxAttempts: number;
  /** ISO timestamp when the job was scheduled. */
  readonly scheduledAt?: string | undefined;
  /** ISO timestamp when the job started. */
  readonly startedAt?: string | undefined;
  /** ISO timestamp when the job completed. */
  readonly completedAt?: string | undefined;
  /** ISO timestamp when the job was created. */
  readonly createdAt: string;
  /** ISO timestamp when the job was last updated. */
  readonly updatedAt: string;
  /** Structured failure summary when the job failed. */
  readonly failure?: AdminFailureDetail | undefined;
};

/** Review history row returned by admin overview and review list routes. */
type AdminReviewRunSummary = {
  /** Review run ID. */
  readonly reviewRunId: string;
  /** Repository ID. */
  readonly repoId: string;
  /** Organization ID. */
  readonly orgId: string;
  /** Repository full name. */
  readonly repoFullName: string;
  /** Provider pull request number. */
  readonly pullRequestNumber: number;
  /** Pull request title when a snapshot is available. */
  readonly pullRequestTitle?: string | undefined;
  /** Pull request author when a snapshot is available. */
  readonly authorLogin?: string | undefined;
  /** Changed file count when a snapshot is available. */
  readonly changedFileCount?: number | undefined;
  /** Review trigger. */
  readonly trigger: string;
  /** Review run status. */
  readonly status: string;
  /** Base commit SHA. */
  readonly baseSha: string;
  /** Head commit SHA. */
  readonly headSha: string;
  /** Review summary when available. */
  readonly summary?: string | undefined;
  /** Finding counts persisted on the review run. */
  readonly counts: AdminReviewFindingCounts;
  /** ISO timestamp when the review run was created. */
  readonly createdAt: string;
  /** ISO timestamp when the review run was last updated. */
  readonly updatedAt: string;
  /** ISO timestamp when review work started. */
  readonly startedAt?: string | undefined;
  /** ISO timestamp when review work completed. */
  readonly completedAt?: string | undefined;
  /** Structured failure summary when the review run failed. */
  readonly failure?: AdminFailureDetail | undefined;
  /** Durable jobs tied to the review run when detail data is loaded. */
  readonly relatedJobs?: readonly AdminBackgroundJobSummary[] | undefined;
};

/** Query options for review history discovery. */
type AdminReviewRunListQuery = {
  /** Organization IDs allowed by the caller scope. Use "*" for all organizations. */
  readonly orgIds?: readonly string[] | undefined;
  /** Repository IDs allowed by the caller scope. Use "*" for all repositories. */
  readonly repoIds?: readonly string[] | undefined;
  /** Repository filter. */
  readonly repoId?: string | undefined;
  /** Review status filter. */
  readonly status?: string | undefined;
  /** Free-text search over repository, PR number, and PR title. */
  readonly search?: string | undefined;
  /** Maximum rows to return. */
  readonly limit?: number | undefined;
};

/** Query options for review finding discovery. */
type AdminReviewFindingListQuery = {
  /** Validation decision filter. */
  readonly decision?: string | undefined;
  /** Finding severity filter. */
  readonly severity?: string | undefined;
  /** Maximum rows to return. */
  readonly limit?: number | undefined;
};

/** Query options for evaluation suite discovery. */
type AdminEvaluationSuiteListQuery = {
  /** Maximum rows to return. */
  readonly limit?: number | undefined;
};

/** Query options for persisted evaluation runs under one suite. */
type AdminEvaluationRunListQuery = {
  /** Evaluation suite ID to inspect. */
  readonly evalSuiteId: string;
  /** Maximum rows to return. */
  readonly limit?: number | undefined;
};

/** Details returned for one persisted evaluation run. */
type AdminEvaluationRunDetails = {
  /** Evaluation run summary. */
  readonly run: EvaluationRunSummary;
  /** Per-case evaluation results for the run. */
  readonly caseResults: readonly EvaluationCaseResultSummary[];
};

/** Provider publication state attached to one finding when available. */
type AdminReviewFindingPublicationSummary = {
  /** Published finding ID. */
  readonly publishedFindingId: string;
  /** Git provider that received the publication. */
  readonly provider: string;
  /** Provider comment ID when publication created an inline comment. */
  readonly providerCommentId?: string | undefined;
  /** Provider review ID when publication batched comments in a review. */
  readonly providerReviewId?: string | undefined;
  /** Provider check-run ID when publication created a check run. */
  readonly providerCheckRunId?: string | undefined;
  /** Publication status. */
  readonly status: string;
  /** Publication timestamp. */
  readonly publishedAt: string;
  /** Publisher error payload when publication failed. */
  readonly error?: unknown;
  /** Publication metadata. */
  readonly metadata?: Record<string, unknown> | undefined;
};

/** Latest user or provider outcome attached to one finding. */
type AdminReviewFindingOutcomeSummary = {
  /** Finding outcome row ID. */
  readonly findingOutcomeId: string;
  /** Outcome label recorded for the finding. */
  readonly outcome: string;
  /** Outcome signal source. */
  readonly source: string;
  /** Outcome occurrence timestamp. */
  readonly occurredAt: string;
  /** Outcome row creation timestamp. */
  readonly createdAt: string;
  /** Outcome metadata. */
  readonly metadata?: Record<string, unknown> | undefined;
};

/** Feedback signal row attached to one feedback timeline event. */
type AdminReviewFindingFeedbackSignalSummary = {
  /** Feedback signal row ID. */
  readonly feedbackSignalId: string;
  /** Signal kind classified by the memory package. */
  readonly signalKind: string;
  /** Signal polarity used by outcome scoring. */
  readonly polarity: string;
  /** Signal strength from zero to one. */
  readonly strength: number;
  /** Classifier confidence from zero to one. */
  readonly confidence: number;
  /** Product-safe signal reason. */
  readonly reason: string;
  /** Signal creation timestamp. */
  readonly createdAt: string;
};

/** Normalized feedback event shown in finding timelines. */
type AdminReviewFindingFeedbackEventSummary = {
  /** Feedback event row ID. */
  readonly feedbackEventId: string;
  /** Provider that delivered the feedback. */
  readonly provider: string;
  /** Feedback source, such as webhook or dashboard. */
  readonly source: string;
  /** Normalized feedback event kind. */
  readonly eventKind: string;
  /** External provider event ID when available. */
  readonly externalEventId?: string | undefined;
  /** Actor login when available. */
  readonly actorLogin?: string | undefined;
  /** Pull request number when available. */
  readonly pullRequestNumber?: number | undefined;
  /** Provider comment ID when available. */
  readonly externalCommentId?: string | undefined;
  /** Redacted provider metadata for debugging. */
  readonly payloadRedacted?: Record<string, unknown> | undefined;
  /** Event receipt timestamp. */
  readonly receivedAt: string;
  /** Deterministic signals classified from this event. */
  readonly signals: readonly AdminReviewFindingFeedbackSignalSummary[];
};

/** Finding row returned by review history APIs. */
type AdminReviewFindingSummary = {
  /** Validated finding ID used as the canonical API ID. */
  readonly findingId: string;
  /** Candidate finding ID emitted before validation. */
  readonly candidateFindingId: string;
  /** Published finding ID when the finding reached the provider. */
  readonly publishedFindingId?: string | undefined;
  /** Review run ID that produced the finding. */
  readonly reviewRunId: string;
  /** Repository ID that owns the finding. */
  readonly repoId: string;
  /** Organization ID that owns the repository. */
  readonly orgId: string;
  /** Repository full name. */
  readonly repoFullName: string;
  /** Validation decision. */
  readonly decision: string;
  /** Finding category. */
  readonly category: string;
  /** Finding severity. */
  readonly severity: string;
  /** Finding title. */
  readonly title: string;
  /** Finding body. */
  readonly body: string;
  /** Diff location or repository location. */
  readonly location: unknown;
  /** Evidence array captured for the finding. */
  readonly evidence: unknown;
  /** Model or validator confidence score. */
  readonly confidence: number;
  /** Validation metadata persisted by the validator. */
  readonly validation: unknown;
  /** Rank within the review when available. */
  readonly rank?: number | undefined;
  /** Stable duplicate-detection fingerprint. */
  readonly fingerprint: string;
  /** Finding metadata. */
  readonly metadata?: Record<string, unknown> | undefined;
  /** Provider publication state when available. */
  readonly publication?: AdminReviewFindingPublicationSummary | undefined;
  /** Latest recorded outcome when available. */
  readonly latestOutcome?: AdminReviewFindingOutcomeSummary | undefined;
};

/** Joined finding row selected from review, repository, validation, and publication tables. */
type AdminReviewFindingRow = ReviewFindingInspectionRecord;

/** Latest finding outcomes indexed by candidate and publication IDs. */
type AdminReviewFindingOutcomeLookup = {
  /** Latest outcome keyed by candidate finding ID. */
  readonly byCandidateFindingId: ReadonlyMap<string, AdminReviewFindingOutcomeSummary>;
  /** Latest outcome keyed by published finding ID. */
  readonly byPublishedFindingId: ReadonlyMap<string, AdminReviewFindingOutcomeSummary>;
};

/** Joined feedback event and optional signal row selected for timelines. */
type AdminReviewFindingFeedbackTimelineRow = FeedbackTimelineRecord;

/** Artifact metadata row returned by scoped review artifact APIs. */
type AdminReviewArtifactSummary = {
  /** Review artifact row ID. */
  readonly reviewArtifactId: string;
  /** Review run that owns the artifact. */
  readonly reviewRunId: string;
  /** Repository that owns the artifact. */
  readonly repoId: string;
  /** Artifact kind. */
  readonly kind: string;
  /** Artifact display name. */
  readonly name: string;
  /** Artifact URI reference. */
  readonly uri: string;
  /** Artifact content hash. */
  readonly hash: string;
  /** Artifact byte size. */
  readonly sizeBytes: number;
  /** Artifact classification. */
  readonly classification: string;
  /** Artifact redaction level when supplied by the producer. */
  readonly redactionLevel?: string | undefined;
  /** Retention expiration timestamp when configured. */
  readonly retentionUntil?: string | undefined;
  /** Artifact creation timestamp. */
  readonly createdAt: string;
  /** Whether metadata contains an inline payload. */
  readonly hasStoredPayload: boolean;
  /** Metadata keys available on the artifact row. */
  readonly metadataKeys: readonly string[];
  /** Payload-free static-analysis counters when this is a static-analysis report artifact. */
  readonly staticAnalysis?: AdminStaticAnalysisArtifactSummary | undefined;
};

/** Payload-free static-analysis report counters returned with artifact metadata. */
type AdminStaticAnalysisArtifactSummary = {
  /** Static-analysis report ID. */
  readonly reportId: string;
  /** Static-analysis mode used for the report. */
  readonly mode: string;
  /** Final static-analysis report status. */
  readonly status: string;
  /** Total static-analysis duration in milliseconds. */
  readonly durationMs: number;
  /** Planned tool run count. */
  readonly toolRunCount: number;
  /** Successful tool run count. */
  readonly succeededToolRunCount: number;
  /** Failed tool run count. */
  readonly failedToolRunCount: number;
  /** Timed-out tool run count. */
  readonly timedOutToolRunCount: number;
  /** Total normalized diagnostic count. */
  readonly diagnosticCount: number;
  /** Diagnostic count on changed lines. */
  readonly changedLineDiagnosticCount: number;
  /** Diagnostic count marked new by the analyzer. */
  readonly newDiagnosticCount: number;
  /** Error or critical diagnostic count. */
  readonly highSeverityDiagnosticCount: number;
  /** Product-safe warning count. */
  readonly warningCount: number;
};

/** Redaction mode accepted by review artifact payload reads. */
type AdminReviewArtifactPayloadAccessLevel = "redacted" | "raw_allowed";

/** Request context recorded with one review artifact payload read. */
type AdminReviewArtifactPayloadRequest = {
  /** Actor that requested the payload. */
  readonly actor: AdminActor;
  /** Request ID propagated into audit metadata. */
  readonly requestId: string;
  /** Human-readable operational reason supplied by the caller. */
  readonly reason: string;
  /** Payload access level authorized for this read. */
  readonly accessLevel: AdminReviewArtifactPayloadAccessLevel;
  /** Support-session ID when raw or privileged artifact access is attached to a ticket. */
  readonly supportSessionId?: string | undefined;
  /** Request client IP address when available. */
  readonly ipAddress?: string | undefined;
  /** Request user-agent when available. */
  readonly userAgent?: string | undefined;
};

/** Redacted or raw review artifact payload response. */
type AdminReviewArtifactPayloadSummary = {
  /** Metadata for the artifact whose payload was read. */
  readonly artifact: AdminReviewArtifactSummary;
  /** Artifact access event row written for this read. */
  readonly artifactAccessEventId: string;
  /** Payload access level used for this response. */
  readonly accessLevel: AdminReviewArtifactPayloadAccessLevel;
  /** Review artifact payload. Redacted unless accessLevel is raw_allowed. */
  readonly payload: unknown;
};

/** Raw review artifact direct download URL response. */
type AdminReviewArtifactDownloadUrlSummary = {
  /** Metadata for the artifact whose payload URL was created. */
  readonly artifact: AdminReviewArtifactSummary;
  /** Artifact access event row written for this URL creation. */
  readonly artifactAccessEventId: string;
  /** Payload access level used for this response. */
  readonly accessLevel: AdminReviewArtifactPayloadAccessLevel;
  /** Short-lived signed direct download URL. */
  readonly url: string;
  /** ISO timestamp when the signed URL expires. */
  readonly expiresAt: string;
};

/** Scope accepted by the finding suppression helper route. */
type FindingSuppressionScope = "repo" | "org";

/** Parsed request body for suppressing future findings similar to one finding. */
type SuppressSimilarFindingBody = {
  /** Suppression scope requested by the caller. */
  readonly scope: FindingSuppressionScope;
  /** Human-readable reason for the durable suppression. */
  readonly reason: string;
  /** Optional expiration timestamp for the suppression rule. */
  readonly expiresAt?: string | undefined;
};

/** Input used to create an audited finding suppression rule. */
type AdminFindingSuppressionRequest = Omit<
  AdminAuditEventInput,
  "action" | "metadata" | "orgId" | "repoId" | "resourceId" | "resourceType"
> &
  SuppressSimilarFindingBody & {
    /** Caller-provided or request-derived idempotency key. */
    readonly idempotencyKey: string;
  };

/** Result returned after creating or reusing a finding suppression rule. */
type AdminFindingSuppressionSummary = {
  /** Finding that seeded the suppression. */
  readonly finding: AdminReviewFindingSummary;
  /** Created or reused suppression rule. */
  readonly rule: AdminRepoRuleSummary;
  /** Suppression scope that was applied. */
  readonly scope: FindingSuppressionScope;
  /** Audit row written for the helper action. */
  readonly auditLogId: string;
};

/** Parsed PATCH body for finding outcome updates. */
type FindingOutcomePatchBody = {
  /** Outcome label recorded for the finding. */
  readonly outcome: FindingOutcomeType;
  /** Source of the outcome signal. */
  readonly source: FindingOutcomeSignalSource;
  /** Outcome occurrence timestamp. */
  readonly occurredAt: string;
  /** Optional human-readable notes stored in metadata. */
  readonly notes?: string | undefined;
  /** Caller-supplied metadata stored with the outcome row. */
  readonly metadata?: Record<string, unknown> | undefined;
};

/** Input used to audit and idempotently record one finding outcome. */
type AdminFindingOutcomeRecordRequest = Omit<
  AdminAuditEventInput,
  "action" | "metadata" | "orgId" | "repoId" | "resourceId" | "resourceType"
> &
  FindingOutcomePatchBody & {
    /** Caller-provided or request-derived idempotency key. */
    readonly idempotencyKey: string;
  };

/** Result returned after a finding outcome mutation. */
type AdminFindingOutcomeRecordSummary = {
  /** Updated finding summary with the latest outcome attached. */
  readonly finding: AdminReviewFindingSummary;
  /** Outcome row created or reused by the request. */
  readonly outcome: AdminReviewFindingOutcomeSummary;
  /** Audit row written for the outcome request. */
  readonly auditLogId: string;
};

/** Input used to audit and idempotently enqueue a review rerun. */
type AdminReviewRerunRequest = Omit<
  AdminAuditEventInput,
  "action" | "metadata" | "orgId" | "repoId" | "resourceId" | "resourceType"
> & {
  /** Caller-provided or request-derived idempotency key. */
  readonly idempotencyKey: string;
};

/** Query options for repository memory fact discovery. */
type AdminMemoryFactListQuery = {
  /** Memory fact status filter. */
  readonly status?: MemoryFactStatus | undefined;
  /** Memory fact kind filter. */
  readonly kind?: MemoryFactKind | undefined;
  /** Whether organization-scoped facts should be included with repository facts. */
  readonly includeOrgFacts?: boolean | undefined;
  /** Maximum rows to return. */
  readonly limit?: number | undefined;
};

/** Query options for repository memory candidate discovery. */
type AdminMemoryCandidateListQuery = {
  /** Memory candidate lifecycle status filter. */
  readonly status?: string | undefined;
  /** Candidate kind filter. */
  readonly candidateKind?: string | undefined;
  /** Whether organization-scoped candidates should be included with repository candidates. */
  readonly includeOrgCandidates?: boolean | undefined;
  /** Maximum rows to return. */
  readonly limit?: number | undefined;
};

/** Query options for repository suppression match audit history. */
type AdminSuppressionMatchListQuery = {
  /** Maximum rows to return. */
  readonly limit?: number | undefined;
};

/** Memory fact row returned by scoped product API routes. */
type AdminMemoryFactSummary = {
  /** Memory fact ID. */
  readonly memoryFactId: string;
  /** Owning organization ID. */
  readonly orgId: string;
  /** Owning repository ID when the fact is repository-scoped. */
  readonly repoId?: string | undefined;
  /** Scope label derived from the row. */
  readonly scope: "organization" | "repository";
  /** Typed memory fact kind. */
  readonly kind: MemoryFactKind;
  /** Raw stored fact type, preserved for migration/debug visibility. */
  readonly factType: string;
  /** Short subject shown in list views. */
  readonly subject: string;
  /** Human-readable memory text. */
  readonly text: string;
  /** Human-readable memory body kept for existing operator surfaces. */
  readonly body: string;
  /** Source that produced the memory fact. */
  readonly source: MemoryFactSource;
  /** Confidence score. */
  readonly confidence: number;
  /** Durable memory status. */
  readonly status: MemoryFactStatus;
  /** Whether the memory fact currently applies to reviews. */
  readonly enabled: boolean;
  /** Memory fact creation timestamp. */
  readonly createdAt: string;
  /** Memory fact update timestamp. */
  readonly updatedAt: string;
  /** Expiration timestamp when present. */
  readonly expiresAt?: string | undefined;
  /** Additional metadata stored with the memory fact. */
  readonly metadata?: Record<string, unknown> | undefined;
};

/** Parsed request body for memory fact creation. */
type MemoryFactCreateBody = {
  /** Memory fact kind. */
  readonly kind: MemoryFactKind;
  /** Optional short subject shown in list views. */
  readonly subject?: string | undefined;
  /** Human-readable memory text. */
  readonly text: string;
  /** Source that produced the memory fact. */
  readonly source: MemoryFactSource;
  /** Initial confidence score. */
  readonly confidence: number;
  /** Whether the memory fact should be active immediately. */
  readonly enabled: boolean;
  /** Expiration timestamp when provided. */
  readonly expiresAt?: string | undefined;
  /** Additional caller metadata. */
  readonly metadata?: Record<string, unknown> | undefined;
};

/** Parsed request body for memory fact updates. */
type MemoryFactPatchBody = {
  /** Memory fact kind. */
  readonly kind?: MemoryFactKind | undefined;
  /** Optional short subject shown in list views. */
  readonly subject?: string | undefined;
  /** Human-readable memory text. */
  readonly text?: string | undefined;
  /** Source that produced the memory fact. */
  readonly source?: MemoryFactSource | undefined;
  /** Updated confidence score. */
  readonly confidence?: number | undefined;
  /** Updated durable status. */
  readonly status?: MemoryFactStatus | undefined;
  /** Whether the memory fact should be active. */
  readonly enabled?: boolean | undefined;
  /** Expiration timestamp, or null to clear it. */
  readonly expiresAt?: string | null | undefined;
  /** Replacement caller metadata. */
  readonly metadata?: Record<string, unknown> | undefined;
};

/** Input used to audit and idempotently create a repository memory fact. */
type AdminMemoryFactCreateRequest = Omit<
  AdminAuditEventInput,
  "action" | "metadata" | "orgId" | "repoId" | "resourceId" | "resourceType"
> &
  MemoryFactCreateBody & {
    /** Caller-provided or request-derived idempotency key. */
    readonly idempotencyKey: string;
  };

/** Input used to audit one memory fact update. */
type AdminMemoryFactUpdateRequest = Omit<
  AdminAuditEventInput,
  "action" | "metadata" | "orgId" | "repoId" | "resourceId" | "resourceType"
> &
  MemoryFactPatchBody;

/** Input used to audit one memory fact deletion. */
type AdminMemoryFactDeleteRequest = Omit<
  AdminAuditEventInput,
  "action" | "metadata" | "orgId" | "repoId" | "resourceId" | "resourceType"
>;

/** Memory candidate row returned by scoped product API routes. */
type AdminMemoryCandidateSummary = {
  /** Memory candidate ID. */
  readonly memoryCandidateId: string;
  /** Owning organization ID. */
  readonly orgId: string;
  /** Owning repository ID when the candidate is repository-scoped. */
  readonly repoId?: string | undefined;
  /** Source that proposed the candidate. */
  readonly sourceKind: string;
  /** Candidate kind proposed by feedback processing. */
  readonly candidateKind: string;
  /** Proposed durable memory text. */
  readonly proposedContent: string;
  /** Candidate lifecycle status. */
  readonly status: string;
  /** Candidate confidence score. */
  readonly confidence: number;
  /** Trust level assigned to the proposing signal. */
  readonly trustLevel: string;
  /** Login that created the candidate when known. */
  readonly createdByLogin?: string | undefined;
  /** Source feedback event ID when known. */
  readonly sourceFeedbackEventId?: string | undefined;
  /** Source finding ID when known. */
  readonly sourceFindingId?: string | undefined;
  /** Memory fact created from this candidate when approved. */
  readonly approvedMemoryFactId?: string | undefined;
  /** User ID that made the moderation decision when present. */
  readonly decidedByUserId?: string | undefined;
  /** Moderation decision timestamp when present. */
  readonly decidedAt?: string | undefined;
  /** Expiration timestamp when present. */
  readonly expiresAt?: string | undefined;
  /** Structured proposed scope payload. */
  readonly proposedScope: Record<string, unknown>;
  /** Structured proposed applies-to payload. */
  readonly proposedAppliesTo: Record<string, unknown>;
  /** Additional candidate metadata. */
  readonly metadata?: Record<string, unknown> | undefined;
  /** Candidate creation timestamp. */
  readonly createdAt: string;
  /** Candidate update timestamp. */
  readonly updatedAt: string;
};

/** Recent memory suppression match returned by repository memory APIs. */
type AdminSuppressionMatchSummary = {
  /** Durable suppression match row ID. */
  readonly suppressionMatchId: string;
  /** Review run that emitted the suppression decision. */
  readonly reviewRunId: string;
  /** Validated finding row suppressed by memory. */
  readonly findingId: string;
  /** Candidate finding inspected by the memory matcher. */
  readonly candidateFindingId: string;
  /** Durable memory fact responsible for suppression. */
  readonly memoryFactId: string;
  /** Human-readable memory fact body. */
  readonly memoryText: string;
  /** Current status of the memory fact. */
  readonly memoryStatus: string;
  /** Finding title associated with the suppressed candidate. */
  readonly findingTitle: string;
  /** Finding category associated with the suppressed candidate. */
  readonly findingCategory: string;
  /** Finding severity associated with the suppressed candidate. */
  readonly findingSeverity: string;
  /** Finding location associated with the suppressed candidate. */
  readonly location: unknown;
  /** Suppression match strategy. */
  readonly matchKind: string;
  /** Suppression matcher confidence from zero to one. */
  readonly confidence: number;
  /** Product-safe matcher reason when available. */
  readonly reason?: string | undefined;
  /** Match creation timestamp. */
  readonly createdAt: string;
};

/** Parsed request body for memory candidate moderation. */
type MemoryCandidateModerationBody = {
  /** Operator reason for the moderation decision. */
  readonly reason?: string | undefined;
  /** Additional caller metadata for the moderation decision. */
  readonly metadata?: Record<string, unknown> | undefined;
};

/** Input used to audit and idempotently moderate one memory candidate. */
type AdminMemoryCandidateModerationRequest = Omit<
  AdminAuditEventInput,
  "action" | "metadata" | "orgId" | "repoId" | "resourceId" | "resourceType"
> &
  MemoryCandidateModerationBody & {
    /** Caller-provided or request-derived idempotency key. */
    readonly idempotencyKey: string;
  };

/** Result returned after approving one memory candidate. */
type AdminMemoryCandidateApprovalSummary = {
  /** Updated memory candidate. */
  readonly candidate: AdminMemoryCandidateSummary;
  /** Created or reused durable memory fact. */
  readonly memoryFact: AdminMemoryFactSummary;
  /** Audit row written for the approval request. */
  readonly auditLogId: string;
};

/** Result returned after rejecting one memory candidate. */
type AdminMemoryCandidateRejectionSummary = {
  /** Updated memory candidate. */
  readonly candidate: AdminMemoryCandidateSummary;
  /** Audit row written for the rejection request. */
  readonly auditLogId: string;
};

/** Database row shape for memory fact queries. */
type MemoryFactRow = typeof memoryFacts.$inferSelect | MemoryFactRecord;

/** Database row shape for memory candidate queries. */
type MemoryCandidateRow = typeof memoryCandidates.$inferSelect | MemoryCandidateRecord;

/** Joined row shape for repository suppression match history. */
type SuppressionMatchRow = RepositorySuppressionMatchRecord;

/** Query options for repository discovery. */
type AdminRepositoryListQuery = {
  /** Organization IDs allowed by the caller scope. Use "*" for all organizations. */
  readonly orgIds?: readonly string[] | undefined;
  /** Repository IDs allowed by the caller scope. Use "*" for all repositories. */
  readonly repoIds?: readonly string[] | undefined;
  /** Free-text search over repository identity fields. */
  readonly search?: string | undefined;
  /** Maximum rows to return. */
  readonly limit?: number | undefined;
};

/** Query options for scoped organization discovery. */
type AdminOrganizationListQuery = {
  /** Organization IDs allowed by the caller scope. Use "*" for all organizations. */
  readonly orgIds?: readonly string[] | undefined;
  /** Free-text search over organization identity fields. */
  readonly search?: string | undefined;
  /** Maximum rows to return. */
  readonly limit?: number | undefined;
};

/** Organization row returned by scoped API and dashboard routes. */
type AdminOrganizationSummary = {
  /** Organization ID. */
  readonly orgId: string;
  /** Organization display name. */
  readonly name: string;
  /** URL-safe organization slug. */
  readonly slug: string;
  /** Organization metadata safe for admin and product control-plane responses. */
  readonly metadata?: Record<string, unknown> | undefined;
  /** Number of provider installations associated with the organization. */
  readonly installationCount: number;
  /** Number of repositories associated with the organization. */
  readonly repositoryCount: number;
  /** Organization creation timestamp. */
  readonly createdAt: string;
  /** Organization update timestamp. */
  readonly updatedAt: string;
};

/** Query options for scoped provider installation discovery. */
type AdminInstallationListQuery = {
  /** Organization IDs allowed by the caller scope. Use "*" for all organizations. */
  readonly orgIds?: readonly string[] | undefined;
  /** Provider filter. */
  readonly provider?: string | undefined;
  /** Free-text search over provider installation identity fields. */
  readonly search?: string | undefined;
  /** Maximum rows to return. */
  readonly limit?: number | undefined;
};

/** Provider installation row returned by scoped API and dashboard routes. */
type AdminProviderInstallationSummary = {
  /** Internal installation ID. */
  readonly installationId: string;
  /** Owning organization ID. */
  readonly orgId: string;
  /** Git provider. */
  readonly provider: string;
  /** Provider installation ID. */
  readonly providerInstallationId: string;
  /** Provider account login. */
  readonly accountLogin: string;
  /** Provider account type. */
  readonly accountType: string;
  /** Granted installation permissions as returned by the provider webhook. */
  readonly permissions: Record<string, unknown>;
  /** Installation creation timestamp. */
  readonly installedAt: string;
  /** Suspension timestamp when present. */
  readonly suspendedAt?: string | undefined;
  /** Deletion timestamp when present. */
  readonly deletedAt?: string | undefined;
};

/** Durable installation sync enqueue result. */
type AdminInstallationSyncRunSummary = {
  /** Durable background job row ID. */
  readonly backgroundJobId: string;
  /** Durable job idempotency key. */
  readonly jobKey: string;
  /** Current durable job status. */
  readonly status: string;
  /** Audit row written for this sync request. */
  readonly auditLogId: string;
};

/** Input used to audit and idempotently enqueue an installation sync. */
type AdminInstallationSyncRequest = Omit<
  AdminAuditEventInput,
  "action" | "metadata" | "orgId" | "resourceId" | "resourceType"
> & {
  /** Caller-provided or request-derived idempotency key. */
  readonly idempotencyKey: string;
};

/** Durable repository command enqueue result. */
type AdminRepositoryJobRunSummary = {
  /** Durable background job row ID. */
  readonly backgroundJobId: string;
  /** Durable job idempotency key. */
  readonly jobKey: string;
  /** Current durable job status. */
  readonly status: string;
  /** Audit row written for this repository command. */
  readonly auditLogId: string;
};

/** Durable review rerun enqueue result. */
type AdminReviewRerunRunSummary = AdminRepositoryJobRunSummary & {
  /** Source review run that the rerun request targets. */
  readonly sourceReviewRunId: string;
};

/** Input used to audit and idempotently enqueue a repository sync. */
type AdminRepositorySyncRequest = Omit<
  AdminAuditEventInput,
  "action" | "metadata" | "orgId" | "resourceId" | "resourceType"
> & {
  /** Caller-provided or request-derived idempotency key. */
  readonly idempotencyKey: string;
};

/** Input used to audit and idempotently enqueue a repository reindex. */
type AdminRepositoryReindexRequest = AdminRepositorySyncRequest & {
  /** Commit SHA to index. */
  readonly commitSha: string;
  /** Human-readable reason supplied by the caller. */
  readonly reason?: string | undefined;
  /** Whether the caller explicitly requested a reindex even if a matching job exists. */
  readonly force?: boolean | undefined;
};

/** Parsed API request body for repository reindex commands. */
type RepositoryReindexBody = {
  /** Commit SHA to index. */
  readonly commitSha?: string | undefined;
  /** Human-readable reason supplied by the caller. */
  readonly reason?: string | undefined;
  /** Whether to bypass default dedupe behavior. */
  readonly force?: boolean | undefined;
};

/** Repository or organization rule row shown by repository settings UX. */
type AdminRepoRuleSummary = {
  /** Rule ID used by typed policy snapshots. */
  readonly ruleId: string;
  /** Rule row ID. */
  readonly repoRuleId: string;
  /** Organization ID that owns the rule. */
  readonly orgId: string;
  /** Repository ID when the rule is repository-scoped. */
  readonly repoId?: string | undefined;
  /** Human-readable rule name. */
  readonly name: string;
  /** Optional human-readable rule description. */
  readonly description?: string | undefined;
  /** Rule effect consumed by the policy engine. */
  readonly effect: RepoRule["effect"];
  /** Structured matchers consumed by the policy engine. */
  readonly matcher: RepoRule["matcher"];
  /** Rule instruction consumed by the policy engine. */
  readonly instruction: string;
  /** Rule priority. Lower values run first. */
  readonly priority: number;
  /** Whether the rule currently applies. */
  readonly enabled: boolean;
  /** User ID that created the rule when available. */
  readonly createdByUserId?: string | undefined;
  /** Rule scope label. */
  readonly scope: string;
  /** Rule type label. */
  readonly ruleType: string;
  /** Rule body or instruction. */
  readonly body: string;
  /** Whether the rule currently applies. */
  readonly isEnabled: boolean;
  /** Rule creation timestamp. */
  readonly createdAt: string;
  /** Rule update timestamp. */
  readonly updatedAt: string;
};

/** Dashboard overview payload returned after session refresh. */
type AdminDashboardOverview = {
  /** Scoped repositories available to the actor. */
  readonly repositories: readonly AdminRepositorySummary[];
  /** Recent review runs available to the actor. */
  readonly recentReviews: readonly AdminReviewRunSummary[];
  /** Durable review rollup metrics for the current actor scope. */
  readonly reviewMetrics: AdminReviewMetricsSummary;
  /** Recent audit entries when the actor has audit access. */
  readonly recentAuditLogs: readonly AdminAuditLogSummary[];
  /** Product-safe runtime readiness summary for dashboard visibility. */
  readonly runtimeHealth: ApiHealthResponse;
};

/** Durable review metrics returned by dashboard overview APIs. */
type AdminReviewMetricsSummary = {
  /** Total review runs in scope. */
  readonly totalRuns: number;
  /** Completed review runs in scope. */
  readonly completedRuns: number;
  /** Failed review runs in scope. */
  readonly failedRuns: number;
  /** Skipped review runs in scope. */
  readonly skippedRuns: number;
  /** Superseded review runs in scope. */
  readonly supersededRuns: number;
  /** Median end-to-end duration in milliseconds when metrics exist. */
  readonly medianDurationMs?: number | undefined;
  /** P95 end-to-end duration in milliseconds when metrics exist. */
  readonly p95DurationMs?: number | undefined;
  /** Candidate findings recorded by terminal review metrics. */
  readonly candidateFindings: number;
  /** Validated findings recorded by terminal review metrics. */
  readonly validatedFindings: number;
  /** Published findings recorded by terminal review metrics. */
  readonly publishedFindings: number;
  /** Rejected findings recorded by terminal review metrics. */
  readonly rejectedFindings: number;
  /** Average published findings per review run. */
  readonly averagePublishedFindings: number;
  /** Estimated review cost in USD as a decimal string. */
  readonly estimatedCostUsd: string;
  /** ISO timestamp when the rollup was generated. */
  readonly generatedAt: string;
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

/** Query options for security event history search. */
type AdminSecurityEventQuery = {
  /** Organization filter. */
  readonly orgId?: string | undefined;
  /** Repository filter. */
  readonly repoId?: string | undefined;
  /** Security event type filter. */
  readonly type?: string | undefined;
  /** Severity filter. */
  readonly severity?: SecurityEventSeverity | undefined;
  /** Source subsystem filter. */
  readonly source?: SecurityEventSource | undefined;
  /** Triage status filter. */
  readonly status?: SecurityEventStatus | undefined;
  /** Actor ID filter. */
  readonly actorId?: string | undefined;
  /** Resource type filter. */
  readonly resourceType?: string | undefined;
  /** Resource ID filter. */
  readonly resourceId?: string | undefined;
  /** Free-text search over type, actor, resource, and metadata. */
  readonly search?: string | undefined;
  /** Maximum number of rows to return. */
  readonly limit: number;
};

/** Security event summary returned by the control-plane dashboard. */
type AdminSecurityEventSummary = {
  /** Security event row ID. */
  readonly securityEventId: string;
  /** Organization associated with the event when available. */
  readonly orgId?: string | undefined;
  /** Repository associated with the event when available. */
  readonly repoId?: string | undefined;
  /** Security event type. */
  readonly type: string;
  /** Severity used for incident triage. */
  readonly severity: SecurityEventSeverity;
  /** Service or subsystem that emitted the event. */
  readonly source: SecurityEventSource;
  /** Current triage status. */
  readonly status: SecurityEventStatus;
  /** Actor that triggered the event when known. */
  readonly actorId?: string | undefined;
  /** Resource type affected by the event. */
  readonly resourceType?: string | undefined;
  /** Resource ID affected by the event. */
  readonly resourceId?: string | undefined;
  /** Product-safe event metadata. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** ISO timestamp when the event was created. */
  readonly createdAt: string;
  /** ISO timestamp when the event was last updated. */
  readonly updatedAt: string;
};

/** Query options for usage rollup inspection. */
type AdminUsageQuery = {
  /** Organization IDs allowed by the caller scope. Use "*" for all organizations. */
  readonly orgIds?: readonly string[] | undefined;
  /** Repository IDs allowed by the caller scope. Use "*" for all repositories. */
  readonly repoIds?: readonly string[] | undefined;
  /** Optional organization filter. */
  readonly orgId?: string | undefined;
  /** Optional repository filter. */
  readonly repoId?: string | undefined;
  /** Inclusive period start ISO timestamp. */
  readonly periodStart?: string | undefined;
  /** Exclusive period end ISO timestamp. */
  readonly periodEnd?: string | undefined;
  /** Maximum number of rollup rows to return. */
  readonly limit: number;
};

/** Usage rollup row returned by the admin usage endpoint. */
type AdminUsageRollupSummary = {
  /** Organization that owns the usage. */
  readonly orgId: string;
  /** Repository that caused the usage when available. */
  readonly repoId?: string | undefined;
  /** Usage event type. */
  readonly eventType: string;
  /** Usage unit. */
  readonly unit: string;
  /** Number of ledger events in the rollup. */
  readonly eventCount: number;
  /** Signed quantity sum. */
  readonly quantity: number;
  /** Signed internal cost estimate in micro-USD. */
  readonly costMicros: number;
};

/** Usage totals returned by the admin usage endpoint. */
type AdminUsageTotals = {
  /** Number of ledger events included in returned rollups. */
  readonly eventCount: number;
  /** Total signed internal cost estimate in micro-USD. */
  readonly costMicros: number;
  /** Total completed reviews in returned rollups. */
  readonly reviewCount: number;
  /** Total LLM tokens in returned rollups. */
  readonly llmTokens: number;
};

/** Usage summary returned by the admin usage endpoint. */
type AdminUsageSummary = {
  /** Rollup period start when provided. */
  readonly periodStart?: string | undefined;
  /** Rollup period end when provided. */
  readonly periodEnd?: string | undefined;
  /** Aggregated usage rows. */
  readonly rollups: readonly AdminUsageRollupSummary[];
  /** Totals derived from the returned rollups. */
  readonly totals: AdminUsageTotals;
};

/** Supported product usage summary grouping dimensions. */
type ProductUsageSummaryGroupBy = "day" | "week" | "month" | "repo";

/** Query options for customer-facing usage summary endpoints. */
type ProductUsageSummaryQuery = {
  /** Organization that owns the usage. */
  readonly orgId: string;
  /** Optional repository filter. */
  readonly repoId?: string | undefined;
  /** Inclusive period start ISO timestamp. */
  readonly periodStart?: string | undefined;
  /** Exclusive period end ISO timestamp. */
  readonly periodEnd?: string | undefined;
  /** Optional grouping requested by the dashboard. */
  readonly groupBy?: ProductUsageSummaryGroupBy | undefined;
  /** Maximum number of grouped rows to return. */
  readonly limit: number;
};

/** Repository usage breakdown returned when grouping usage by repository. */
type ProductUsageByRepoSummary = {
  /** Repository that caused the usage. */
  readonly repoId: string;
  /** Human-readable repository name. */
  readonly repoName: string;
  /** Completed review count for the repository. */
  readonly reviewRuns: number;
  /** Estimated internal cost in USD. */
  readonly estimatedCostUsd: string;
};

/** Customer-facing usage summary response. */
type ProductUsageSummary = {
  /** Completed review count. */
  readonly reviewRuns: number;
  /** Indexed commit count when commit usage events are present. */
  readonly indexedCommits: number;
  /** Embedding token count. */
  readonly embeddingTokens: number;
  /** LLM input tokens used by review work. */
  readonly reviewInputTokens: number;
  /** LLM output tokens used by review work. */
  readonly reviewOutputTokens: number;
  /** Estimated internal cost in USD. */
  readonly estimatedCostUsd: string;
  /** Repository breakdown when requested. */
  readonly byRepo?: readonly ProductUsageByRepoSummary[] | undefined;
};

/** Query options for customer-facing usage event endpoints. */
type ProductUsageEventsQuery = {
  /** Organization that owns the usage. */
  readonly orgId: string;
  /** Optional repository filter. */
  readonly repoId?: string | undefined;
  /** Optional usage event type filter. */
  readonly eventType?: UsageEventType | undefined;
  /** Inclusive period start ISO timestamp. */
  readonly periodStart?: string | undefined;
  /** Exclusive period end ISO timestamp. */
  readonly periodEnd?: string | undefined;
  /** Maximum number of events to return. */
  readonly limit: number;
};

/** Usage event row returned by customer-facing usage event endpoints. */
type ProductUsageEventSummary = {
  /** Stable usage event ID. */
  readonly usageEventId: string;
  /** Organization that owns the usage. */
  readonly orgId: string;
  /** Repository that caused the usage when available. */
  readonly repoId?: string | undefined;
  /** Review run that caused the usage when available. */
  readonly reviewRunId?: string | undefined;
  /** Usage event type. */
  readonly eventType: string;
  /** Signed quantity. */
  readonly quantity: number;
  /** Usage unit. */
  readonly unit: string;
  /** Signed internal cost estimate in micro-USD. */
  readonly costMicros: number;
  /** ISO timestamp for the usage event. */
  readonly occurredAt: string;
  /** Event metadata when present. */
  readonly metadata?: Record<string, unknown> | undefined;
};

/** Query options for entitlement inspection. */
type AdminEntitlementQuery = {
  /** Organization to inspect. */
  readonly orgId?: string | undefined;
  /** Feature keys to check. */
  readonly featureKeys: readonly string[];
};

/** Entitlement query after scope validation requires an organization. */
type ScopedAdminEntitlementQuery = AdminEntitlementQuery & {
  /** Organization to inspect. */
  readonly orgId: string;
};

/** Plan and entitlement state returned by the admin entitlement endpoint. */
type AdminEntitlementSummary = {
  /** Organization that owns the plan snapshot. */
  readonly orgId: string;
  /** Stable plan snapshot compiled without provider calls. */
  readonly planSnapshot: PlanSnapshot;
  /** Feature decisions for the requested feature keys. */
  readonly decisions: readonly EntitlementDecision[];
  /** Entitlement rows that were available to the compiler. */
  readonly entitlements: readonly Entitlement[];
  /** Timestamp when this summary was compiled. */
  readonly checkedAt: string;
};

/** Query options for billing account inspection. */
type AdminBillingQuery = {
  /** Organization to inspect. */
  readonly orgId?: string | undefined;
};

/** Billing query after scope validation requires an organization. */
type ScopedAdminBillingQuery = AdminBillingQuery & {
  /** Organization to inspect. */
  readonly orgId: string;
};

/** Query options for billing meter event inspection. */
type AdminBillingMeterEventsQuery = AdminBillingQuery & {
  /** Meter event send status filter. */
  readonly status?: string | undefined;
  /** Billing period key filter. */
  readonly periodKey?: string | undefined;
  /** Maximum number of meter event rows to return. */
  readonly limit: number;
};

/** Billing meter event query after scope validation requires an organization. */
type ScopedAdminBillingMeterEventsQuery = AdminBillingMeterEventsQuery & {
  /** Organization to inspect. */
  readonly orgId: string;
};

/** Billing meter event row returned by admin support APIs. */
type AdminBillingMeterEventSummary = {
  /** Local meter event row ID. */
  readonly billingMeterEventId: string;
  /** Local billing account row ID. */
  readonly billingAccountId: string;
  /** Organization that owns the meter event. */
  readonly orgId: string;
  /** Provider that receives the meter event. */
  readonly provider: string;
  /** Provider customer ID. */
  readonly providerCustomerId: string;
  /** Internal meter key. */
  readonly meterKey: string;
  /** Provider meter event name. */
  readonly providerEventName: string;
  /** Billing period key. */
  readonly periodKey: string;
  /** Inclusive billing period start. */
  readonly periodStart: string;
  /** Exclusive billing period end. */
  readonly periodEnd: string;
  /** Positive usage quantity planned for the provider. */
  readonly quantity: number;
  /** Provider idempotency key. */
  readonly idempotencyKey: string;
  /** Send status. */
  readonly status: string;
  /** Provider meter event ID after a successful send. */
  readonly providerMeterEventId?: string | undefined;
  /** Number of send attempts. */
  readonly attemptCount: number;
  /** Last provider error code when a send failed. */
  readonly lastErrorCode?: string | undefined;
  /** Last provider error message when a send failed. */
  readonly lastErrorMessage?: string | undefined;
  /** Usage event IDs included in this planned row. */
  readonly sourceUsageEventIds: readonly string[];
  /** Timestamp when the provider accepted the event. */
  readonly sentAt?: string | undefined;
  /** Row creation timestamp. */
  readonly createdAt: string;
  /** Row update timestamp. */
  readonly updatedAt: string;
};

/** Billing meter event debug payload returned by admin support APIs. */
type AdminBillingMeterEventsSummary = {
  /** Organization that owns the returned meter events. */
  readonly orgId: string;
  /** Status filter when provided. */
  readonly status?: string | undefined;
  /** Period filter when provided. */
  readonly periodKey?: string | undefined;
  /** Meter events matching the query. */
  readonly meterEvents: readonly AdminBillingMeterEventSummary[];
};

/** Query options for billing reconciliation and alert inspection. */
type AdminBillingReconciliationQuery = AdminBillingQuery & {
  /** Billing period key filter for quota and meter rows. */
  readonly periodKey?: string | undefined;
  /** Inclusive usage period start for anomaly checks. */
  readonly periodStart?: string | undefined;
  /** Exclusive usage period end for anomaly checks. */
  readonly periodEnd?: string | undefined;
  /** Maximum number of rows to inspect per issue source. */
  readonly limit: number;
  /** Ready meter events older than this many minutes are considered delayed. */
  readonly meterLagMinutes: number;
  /** Usage rollups with absolute cost over this threshold are flagged. */
  readonly costAnomalyMicros: number;
};

/** Billing reconciliation query after scope validation requires an organization. */
type ScopedAdminBillingReconciliationQuery = AdminBillingReconciliationQuery & {
  /** Organization to inspect. */
  readonly orgId: string;
};

/** Request used to enqueue a durable billing reconciliation job. */
type AdminBillingReconciliationEnqueueRequest = ScopedAdminBillingReconciliationQuery & {
  /** Product-safe trace context propagated into durable work. */
  readonly traceContext?: TelemetryTraceContext | undefined;
  /** Request ID that authorized the enqueue when available. */
  readonly requestId?: string | undefined;
};

/** Billing reconciliation issue severity. */
type AdminBillingReconciliationSeverity = "warning" | "critical";

/** One billing reconciliation issue for support dashboards. */
type AdminBillingReconciliationIssue = {
  /** Issue severity. */
  readonly severity: AdminBillingReconciliationSeverity;
  /** Stable issue category. */
  readonly category:
    | "meter_sync_lag"
    | "meter_sync_failed"
    | "provider_request_failed"
    | "billing_webhook_failed"
    | "quota_counter_drift"
    | "usage_cost_anomaly";
  /** Human-readable issue title. */
  readonly title: string;
  /** Concise issue detail. */
  readonly detail: string;
  /** Related table or resource type. */
  readonly resourceType: string;
  /** Related row ID when known. */
  readonly resourceId?: string | undefined;
  /** Issue timestamp. */
  readonly occurredAt: string;
};

/** Billing reconciliation and alert report returned by admin support APIs. */
type AdminBillingReconciliationSummary = {
  /** Organization that owns the report. */
  readonly orgId: string;
  /** Report generation timestamp. */
  readonly checkedAt: string;
  /** Billing period key filter when applied. */
  readonly periodKey?: string | undefined;
  /** Usage anomaly period start when applied. */
  readonly periodStart?: string | undefined;
  /** Usage anomaly period end when applied. */
  readonly periodEnd?: string | undefined;
  /** Reconciliation issues ordered by severity and recency. */
  readonly issues: readonly AdminBillingReconciliationIssue[];
};

/** Durable billing reconciliation job returned after an operator triggers repair. */
type AdminBillingReconciliationRunSummary = {
  /** Durable background job row ID. */
  readonly backgroundJobId: string;
  /** Durable job idempotency key. */
  readonly jobKey: string;
  /** Current durable job status. */
  readonly status: string;
};

/** Billing checkout mutation request after scope and idempotency are resolved. */
type ScopedAdminBillingCheckoutRequest = CreateBillingCheckoutSessionRequest & {
  /** Organization that owns the checkout session. */
  readonly orgId: string;
  /** Provider idempotency key for retry-safe checkout creation. */
  readonly idempotencyKey: string;
};

/** Billing portal mutation request after scope and idempotency are resolved. */
type ScopedAdminBillingPortalRequest = CreateBillingPortalSessionRequest & {
  /** Organization that owns the portal session. */
  readonly orgId: string;
  /** Provider idempotency key for retry-safe portal session creation. */
  readonly idempotencyKey: string;
};

/** Lazy billing provider factory used only by mutation routes. */
type BillingProviderFactory = () => BillingProvider | undefined;

/** Input accepted by inbound billing webhook processors. */
export type ProcessBillingWebhookInput = {
  /** Request headers from the provider webhook request. */
  readonly headers: BillingWebhookHeaders;
  /** Raw webhook request body used for signature verification. */
  readonly rawBody: Uint8Array;
};

/** Result returned after an inbound billing webhook is recorded and applied. */
export type ProcessBillingWebhookResult = {
  /** Billing provider that emitted the webhook. */
  readonly provider: string;
  /** Provider event ID used for idempotency. */
  readonly providerEventId: string;
  /** Provider event type. */
  readonly eventType: string;
  /** Processing status. */
  readonly status: "processed" | "ignored" | "duplicate";
  /** Whether this webhook had already reached a terminal status. */
  readonly duplicate: boolean;
  /** Organization associated with the webhook when known. */
  readonly orgId?: string;
  /** Billing account associated with the webhook when known. */
  readonly billingAccountId?: string;
};

/** Processor for inbound billing provider webhooks. */
export type BillingWebhookProcessor = {
  /** Verifies, records, and applies one Stripe webhook event. */
  readonly processStripeWebhook: (
    input: ProcessBillingWebhookInput,
  ) => Promise<ProcessBillingWebhookResult>;
};

/** Audit event input used by the control-plane service. */
type AdminAuditEventInput = {
  /** Actor that caused the event. */
  readonly actor: AdminActor;
  /** Session ID that authorized the event when available. */
  readonly sessionId?: string | undefined;
  /** Product-safe trace context propagated into durable work. */
  readonly traceContext?: TelemetryTraceContext | undefined;
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

/** Default entitlement keys shown to support users. */
const DEFAULT_ENTITLEMENT_FEATURE_KEYS = [
  "reviews.enabled",
  "reviews.inline_comments",
  "reviews.pr_summary",
  "memory.enabled",
  "rules.advanced",
  "static_analysis.enabled",
  "security.audit_logs",
  ...PLAN_LIMIT_FEATURE_KEYS,
] as const;

/** Default admin requests allowed per client in one fixed window. */
const DEFAULT_ADMIN_RATE_LIMIT_MAX_REQUESTS = 120;
/** Default admin rate-limit window in seconds. */
const DEFAULT_ADMIN_RATE_LIMIT_WINDOW_SECONDS = 60;
/** Default lifetime for object-store artifact download URLs. */
const DEFAULT_REVIEW_ARTIFACT_SIGNED_URL_EXPIRES_SECONDS = 300;
/** Default maximum number of tracked admin rate-limit client keys. */
const DEFAULT_ADMIN_RATE_LIMIT_MAX_ENTRIES = 10_000;
/** Header that carries a request-scoped support-session reference. */
const SUPPORT_SESSION_HEADER = "x-heimdall-support-session-id";
/** Opaque support-session IDs accepted from trusted admin surfaces. */
const SUPPORT_SESSION_ID_PATTERN = /^supp_[A-Za-z0-9_-]{8,128}$/u;
/** Signed support-session token accepted for privileged access. */
const SIGNED_SUPPORT_SESSION_TOKEN_PATTERN = /^supp_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43,86}$/u;
/** Support-session token schema version. */
const SUPPORT_SESSION_TOKEN_VERSION = 1;
/** Default support-session lifetime in minutes. */
const DEFAULT_SUPPORT_SESSION_EXPIRES_MINUTES = 30;
/** Maximum support-session lifetime in minutes. */
const MAX_SUPPORT_SESSION_EXPIRES_MINUTES = 120;
/** Admin action kind emitted for successful action metric telemetry by source event name. */
const ADMIN_ACTION_KIND_BY_TELEMETRY_NAME: Partial<
  Record<AdminControlPlaneTelemetryEventName, string>
> = {
  "admin.billing.checkout_session.created": "billing.checkout_session.create",
  "admin.billing.portal_session.created": "billing.portal_session.create",
  "admin.debug_bundle.exported": "debug_bundle.export",
  "admin.eval_import.draft_created": "eval_import.draft_create",
  "admin.memory_rules.inspected": "memory_rules.inspect",
  "admin.replay.dispatched": "replay.dispatch",
  "admin.rule.created": "repo_rule.create",
  "admin.rule.deleted": "repo_rule.delete",
  "admin.rule.updated": "repo_rule.update",
  "admin.session.revoked": "admin_session.revoke",
  "admin.settings.updated": "repo_settings.update",
} satisfies Partial<Record<AdminControlPlaneTelemetryEventName, string>>;

/** Service surface for control-plane settings and audit APIs. */
export type AdminControlPlaneService = {
  /** Lists organizations visible to an admin actor scope. */
  readonly listOrganizations: (
    query: AdminOrganizationListQuery,
  ) => Promise<readonly AdminOrganizationSummary[]>;
  /** Gets one organization for scoped routes. */
  readonly getOrganization: (orgId: string) => Promise<AdminOrganizationSummary>;
  /** Lists provider installations visible to an admin actor scope. */
  readonly listProviderInstallations: (
    query: AdminInstallationListQuery,
  ) => Promise<readonly AdminProviderInstallationSummary[]>;
  /** Gets one provider installation for scoped routes. */
  readonly getProviderInstallation: (
    installationId: string,
  ) => Promise<AdminProviderInstallationSummary>;
  /** Enqueues a durable provider installation sync job. */
  readonly enqueueInstallationSync: (
    installationId: string,
    request: AdminInstallationSyncRequest,
  ) => Promise<AdminInstallationSyncRunSummary>;
  /** Enqueues a durable repository sync job. */
  readonly enqueueRepositorySync: (
    repoId: string,
    request: AdminRepositorySyncRequest,
  ) => Promise<AdminRepositoryJobRunSummary>;
  /** Enqueues a durable repository reindex job. */
  readonly enqueueRepositoryReindex: (
    repoId: string,
    request: AdminRepositoryReindexRequest,
  ) => Promise<AdminRepositoryJobRunSummary>;
  /** Lists repositories visible to an admin actor scope. */
  readonly listRepositories: (
    query: AdminRepositoryListQuery,
  ) => Promise<readonly AdminRepositorySummary[]>;
  /** Lists review runs visible to an admin actor scope. */
  readonly listReviewRuns: (
    query: AdminReviewRunListQuery,
  ) => Promise<readonly AdminReviewRunSummary[]>;
  /** Gets durable review rollup metrics visible to an admin actor scope. */
  readonly getReviewMetricsSummary: (
    query: AdminReviewRunListQuery,
  ) => Promise<AdminReviewMetricsSummary>;
  /** Lists persisted evaluation suites and latest run hints. */
  readonly listEvaluationSuites: (
    query: AdminEvaluationSuiteListQuery,
  ) => Promise<readonly EvaluationSuiteSummary[]>;
  /** Lists persisted evaluation runs for one suite. */
  readonly listEvaluationRuns: (
    query: AdminEvaluationRunListQuery,
  ) => Promise<readonly EvaluationRunSummary[]>;
  /** Gets one persisted evaluation run and its case results. */
  readonly getEvaluationRun: (evalRunId: string) => Promise<AdminEvaluationRunDetails>;
  /** Gets one review run with repository and pull-request context. */
  readonly getReviewRun: (reviewRunId: string) => Promise<AdminReviewRunSummary>;
  /** Lists artifact metadata for one review run. */
  readonly listReviewArtifacts: (
    reviewRunId: string,
  ) => Promise<readonly AdminReviewArtifactSummary[]>;
  /** Reads one audited review artifact payload. */
  readonly getReviewArtifactPayload: (
    reviewRunId: string,
    reviewArtifactId: string,
    request: AdminReviewArtifactPayloadRequest,
  ) => Promise<AdminReviewArtifactPayloadSummary>;
  /** Creates one audited short-lived raw artifact download URL. */
  readonly createReviewArtifactDownloadUrl: (
    reviewRunId: string,
    reviewArtifactId: string,
    request: AdminReviewArtifactPayloadRequest,
  ) => Promise<AdminReviewArtifactDownloadUrlSummary>;
  /** Lists findings produced by one review run. */
  readonly listReviewFindings: (
    reviewRunId: string,
    query: AdminReviewFindingListQuery,
  ) => Promise<readonly AdminReviewFindingSummary[]>;
  /** Gets one review finding by validated, candidate, or published finding ID. */
  readonly getReviewFinding: (findingId: string) => Promise<AdminReviewFindingSummary>;
  /** Lists feedback events and signals attached to one review finding. */
  readonly listFindingFeedbackEvents: (
    findingId: string,
  ) => Promise<readonly AdminReviewFindingFeedbackEventSummary[]>;
  /** Records an outcome for one review finding. */
  readonly recordFindingOutcome: (
    findingId: string,
    request: AdminFindingOutcomeRecordRequest,
  ) => Promise<AdminFindingOutcomeRecordSummary>;
  /** Creates or reuses a suppression rule seeded by one finding. */
  readonly suppressSimilarFinding: (
    findingId: string,
    request: AdminFindingSuppressionRequest,
  ) => Promise<AdminFindingSuppressionSummary>;
  /** Enqueues a durable rerun for one review run. */
  readonly enqueueReviewRerun: (
    reviewRunId: string,
    request: AdminReviewRerunRequest,
  ) => Promise<AdminReviewRerunRunSummary>;
  /** Lists memory facts that apply to one repository. */
  readonly listRepositoryMemoryFacts: (
    repoId: string,
    query: AdminMemoryFactListQuery,
  ) => Promise<readonly AdminMemoryFactSummary[]>;
  /** Lists pending and decided memory candidates that apply to one repository. */
  readonly listRepositoryMemoryCandidates: (
    repoId: string,
    query: AdminMemoryCandidateListQuery,
  ) => Promise<readonly AdminMemoryCandidateSummary[]>;
  /** Lists recent suppression matches recorded for one repository. */
  readonly listRepositorySuppressionMatches: (
    repoId: string,
    query: AdminSuppressionMatchListQuery,
  ) => Promise<readonly AdminSuppressionMatchSummary[]>;
  /** Gets one memory fact by ID. */
  readonly getMemoryFact: (memoryFactId: string) => Promise<AdminMemoryFactSummary>;
  /** Gets one memory candidate by ID. */
  readonly getMemoryCandidate: (memoryCandidateId: string) => Promise<AdminMemoryCandidateSummary>;
  /** Creates one repository-scoped memory fact. */
  readonly createRepositoryMemoryFact: (
    repoId: string,
    request: AdminMemoryFactCreateRequest,
  ) => Promise<AdminMemoryFactSummary>;
  /** Approves one memory candidate into a durable memory fact. */
  readonly approveMemoryCandidate: (
    memoryCandidateId: string,
    request: AdminMemoryCandidateModerationRequest,
  ) => Promise<AdminMemoryCandidateApprovalSummary>;
  /** Rejects one memory candidate. */
  readonly rejectMemoryCandidate: (
    memoryCandidateId: string,
    request: AdminMemoryCandidateModerationRequest,
  ) => Promise<AdminMemoryCandidateRejectionSummary>;
  /** Updates one memory fact. */
  readonly updateMemoryFact: (
    memoryFactId: string,
    request: AdminMemoryFactUpdateRequest,
  ) => Promise<AdminMemoryFactSummary>;
  /** Soft-deletes one memory fact by disabling it. */
  readonly deleteMemoryFact: (
    memoryFactId: string,
    request: AdminMemoryFactDeleteRequest,
  ) => Promise<AdminMemoryFactSummary>;
  /** Lists org and repository rules that affect one repository. */
  readonly listRepositoryRules: (repoId: string) => Promise<readonly AdminRepoRuleSummary[]>;
  /** Creates one repository-scoped rule. */
  readonly createRepositoryRule: (
    repoId: string,
    request: CreateRepoRuleRequest,
    audit: Omit<
      AdminAuditEventInput,
      "action" | "metadata" | "orgId" | "resourceId" | "resourceType"
    >,
  ) => Promise<AdminRepoRuleSummary>;
  /** Updates one repository-scoped rule. */
  readonly updateRepositoryRule: (
    repoId: string,
    ruleId: string,
    request: UpdateRepoRuleRequest,
    audit: Omit<
      AdminAuditEventInput,
      "action" | "metadata" | "orgId" | "resourceId" | "resourceType"
    >,
  ) => Promise<AdminRepoRuleSummary>;
  /** Deletes one repository-scoped rule. */
  readonly deleteRepositoryRule: (
    repoId: string,
    ruleId: string,
    audit: Omit<
      AdminAuditEventInput,
      "action" | "metadata" | "orgId" | "resourceId" | "resourceType"
    >,
  ) => Promise<AdminRepoRuleSummary>;
  /** Previews the effective review policy for current settings plus an optional draft patch. */
  readonly previewRepositoryPolicy: (
    repoId: string,
    patch: UpdateRepositoryControlPlaneSettingsRequest,
  ) => Promise<AdminRepositoryPolicyPreview>;
  /** Tests the effective review policy against a sample finding. */
  readonly testRepositoryPolicy: (
    repoId: string,
    request: TestRepositoryPolicyRequest,
  ) => Promise<AdminRepositoryPolicyTest>;
  /** Validates one repo-local reviewer config draft for a repository. */
  readonly validateRepositoryConfigFile: (
    repoId: string,
    request: ValidateRepoLocalConfigFileRequest,
  ) => Promise<AdminRepoLocalConfigValidation>;
  /** Gets organization-level policy defaults and guardrails. */
  readonly getOrgSettings: (orgId: string) => Promise<AdminOrgControlPlaneSettings>;
  /** Updates organization-level policy defaults and guardrails. */
  readonly updateOrgSettings: (
    orgId: string,
    patch: UpdateOrgSettingsRequest,
    audit: Omit<
      AdminAuditEventInput,
      "action" | "metadata" | "orgId" | "resourceId" | "resourceType"
    >,
  ) => Promise<AdminOrgControlPlaneSettings>;
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
  /** Lists searchable security event history. */
  readonly listSecurityEvents: (
    query: AdminSecurityEventQuery,
  ) => Promise<readonly AdminSecurityEventSummary[]>;
  /** Lists internal usage rollups visible to an admin actor scope. */
  readonly listUsageSummary: (query: AdminUsageQuery) => Promise<AdminUsageSummary>;
  /** Gets customer-facing usage summary metrics for one scoped org or repository. */
  readonly getProductUsageSummary: (
    query: ProductUsageSummaryQuery,
  ) => Promise<ProductUsageSummary>;
  /** Lists customer-facing usage events for one scoped organization. */
  readonly listProductUsageEvents: (
    query: ProductUsageEventsQuery,
  ) => Promise<readonly ProductUsageEventSummary[]>;
  /** Gets provider-free plan and entitlement decisions for an organization. */
  readonly getEntitlementSummary: (
    query: ScopedAdminEntitlementQuery,
  ) => Promise<AdminEntitlementSummary>;
  /** Gets local billing account, subscription, credit, invoice, and plan state. */
  readonly getBillingSummary: (query: ScopedAdminBillingQuery) => Promise<BillingSummary>;
  /** Lists usage-based billing meter event rows for support debugging. */
  readonly listBillingMeterEvents: (
    query: ScopedAdminBillingMeterEventsQuery,
  ) => Promise<AdminBillingMeterEventsSummary>;
  /** Gets billing drift, sync failure, and anomaly issues for support debugging. */
  readonly getBillingReconciliation: (
    query: ScopedAdminBillingReconciliationQuery,
  ) => Promise<AdminBillingReconciliationSummary>;
  /** Enqueues a durable billing reconciliation repair job. */
  readonly enqueueBillingReconciliation: (
    query: AdminBillingReconciliationEnqueueRequest,
  ) => Promise<AdminBillingReconciliationRunSummary>;
  /** Creates a provider checkout session for an organization billing account. */
  readonly createBillingCheckoutSession: (
    request: ScopedAdminBillingCheckoutRequest,
  ) => Promise<CheckoutSessionRef>;
  /** Creates a provider customer portal session for an organization billing account. */
  readonly createBillingPortalSession: (
    request: ScopedAdminBillingPortalRequest,
  ) => Promise<PortalSessionRef>;
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

/** Error raised when control-plane functionality is unavailable because config is missing. */
class AdminControlPlaneConfigurationError extends Error {
  /** Machine-readable API error code. */
  public readonly code: string;

  /** HTTP status used for the response. */
  public readonly statusCode: number;

  /** Creates a control-plane configuration error. */
  public constructor(code: string, message: string, statusCode = 503) {
    super(message);
    this.name = "AdminControlPlaneConfigurationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Error raised when a billing provider webhook cannot be accepted. */
class BillingWebhookProcessingError extends Error {
  /** Machine-readable API error code. */
  public readonly code: string;

  /** HTTP status used for the response. */
  public readonly statusCode: number;

  /** Creates a billing webhook processing error. */
  public constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "BillingWebhookProcessingError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** API health check status returned by liveness and readiness probes. */
export type ApiHealthStatus = "fail" | "pass";

/** One product-safe API health check row. */
export type ApiHealthCheck = {
  /** Stable dependency or subsystem name. */
  readonly name: string;
  /** Product-safe health status. */
  readonly status: ApiHealthStatus;
  /** Optional product-safe detail without secrets or connection strings. */
  readonly message?: string;
};

/** Product-safe API health probe response. */
export type ApiHealthResponse = {
  /** Per-check health rows. */
  readonly checks: readonly ApiHealthCheck[];
  /** Whether every check passed. */
  readonly ok: boolean;
  /** Service identifier. */
  readonly service: "api";
  /** Aggregate health status. */
  readonly status: ApiHealthStatus;
  /** ISO timestamp for the probe response. */
  readonly timestamp: string;
};

/** Readiness check hook used by tests and custom API composition. */
export type ApiReadinessCheck = () => Promise<readonly ApiHealthCheck[]>;

/** Environment map used by API runtime secret resolution. */
export type ApiSecretEnvironment = Readonly<Record<string, string | undefined>>;

/** Secrets used to verify GitHub webhook signatures. */
export type ApiGitHubWebhookSecrets = {
  /** Current active GitHub webhook secret. */
  readonly current: string;
  /** Optional previous secret accepted during a rotation window. */
  readonly previous?: string | undefined;
};

/** Minimal GitHub webhook handler contract used by the API route. */
export type GitHubWebhookRequestHandler = {
  /** Handles one raw GitHub webhook delivery. */
  readonly handle: (input: HandleGitHubWebhookInput) => Promise<WebhookIngestionResult>;
};

/** Dependencies used to create the API app. */
export type CreateApiAppOptions = {
  /** GitHub webhook handler for tests or custom composition. */
  readonly githubWebhookHandler?: GitHubWebhookRequestHandler;
  /** Admin debug service for tests or custom composition. */
  readonly adminDebugService?: AdminDebugService;
  /** Admin control-plane service for tests or custom composition. */
  readonly adminControlPlaneService?: AdminControlPlaneService;
  /** Billing provider for tests or custom composition. */
  readonly billingProvider?: BillingProvider;
  /** Billing webhook processor for tests or custom composition. */
  readonly billingWebhookProcessor?: BillingWebhookProcessor;
  /** Product dashboard service for tests or custom composition. */
  readonly productDashboardService?: ProductDashboardService;
  /** Product session service for tests or custom composition. */
  readonly productSessionService?: ProductSessionService;
  /** Product GitHub OAuth service for tests or custom composition. */
  readonly productGitHubOAuthService?: ProductGitHubOAuthService;
  /** Artifact payload store for tests or custom composition. */
  readonly artifactPayloadStore?: ReviewArtifactPayloadStore;
  /** Admin control-plane authentication override for tests or custom composition. */
  readonly adminControlPlaneAuth?: AdminControlPlaneAuthOptions;
  /** Product session authentication override for tests or custom composition. */
  readonly productSessionAuth?: ProductSessionAuthOptions;
  /** Product GitHub OAuth authentication override for tests or custom composition. */
  readonly productGitHubOAuth?: ProductGitHubOAuthOptions;
  /** Shared database client for production composition or tests. */
  readonly databaseClient?: DatabaseClient;
  /** Environment map used by runtime secret resolvers. */
  readonly secretEnvironment?: ApiSecretEnvironment;
  /** Secret manager used by runtime secret resolvers. */
  readonly secretsManager?: SecretsManager;
  /** Admin control-plane observability sink for structured telemetry. */
  readonly adminObservabilitySink?: ObservabilitySink;
  /** Admin control-plane security-event sink for high-risk access denials. */
  readonly adminSecurityEventSink?: SecurityEventSink;
  /** Metric recorder for API request and lifecycle telemetry. */
  readonly metrics?: TelemetryMetricRecorder;
  /** Optional readiness check hook for tests or custom composition. */
  readonly readinessCheck?: ApiReadinessCheck;
  /** Span recorder for API request-boundary telemetry. */
  readonly traces?: TelemetrySpanRecorder;
};

/** Creates a local security-event sink that intentionally drops API events. */
function createNoopApiSecurityEventSink(): SecurityEventSink {
  return {
    record: () => {},
  };
}

/** Options used to create a Postgres-backed security event sink. */
export type PostgresSecurityEventSinkOptions = {
  /** Database facade that receives durable security events. */
  readonly db: HeimdallDatabase;
  /** Optional product-safe error hook for failed background writes. */
  readonly onError?: (error: unknown, event: SecurityEvent) => void;
};

/** Creates a security event sink that writes normalized events to Postgres. */
export function createPostgresSecurityEventSink(
  options: PostgresSecurityEventSinkOptions,
): SecurityEventSink {
  return {
    record: (event) => {
      try {
        const write = options.db
          .insert(securityEvents)
          .values(securityEventInsertFromEvent(event))
          .onConflictDoNothing();
        void Promise.resolve(write).catch((error: unknown) => {
          options.onError?.(error, event);
        });
      } catch (error) {
        options.onError?.(error, event);
      }
    },
  };
}

/** Converts a normalized security event into a `security_events` insert row. */
function securityEventInsertFromEvent(event: SecurityEvent): typeof securityEvents.$inferInsert {
  const createdAt = new Date(event.createdAt);
  return {
    actorId: event.actorId ?? null,
    createdAt,
    metadata: event.metadata,
    orgId: event.orgId ?? null,
    repoId: event.repoId ?? null,
    resourceId: event.resourceId ?? null,
    resourceType: event.resourceType ?? null,
    securityEventId: event.id,
    severity: event.severity,
    source: event.source,
    status: event.status,
    type: event.type,
    updatedAt: createdAt,
  };
}

/** Dependencies for a GitHub webhook handler that resolves secrets at request time. */
type SecretResolvingGitHubWebhookHandlerDependencies = {
  /** Database used by the underlying ingestion handler. */
  readonly db: HeimdallDatabase;
  /** Environment map that contains secret refs or local fallback values. */
  readonly env: ApiSecretEnvironment;
  /** Optional metric recorder used by webhook ingestion. */
  readonly metrics?: TelemetryMetricRecorder | undefined;
  /** Secret manager used to resolve configured secret refs. */
  readonly secretsManager: SecretsManager;
  /** Optional span recorder used by webhook ingestion. */
  readonly traces?: TelemetrySpanRecorder | undefined;
};

/** GitHub webhook handler that resolves configured secrets through the security boundary. */
class SecretResolvingGitHubWebhookHandler implements GitHubWebhookRequestHandler {
  /** Creates a secret-resolving GitHub webhook handler. */
  public constructor(
    private readonly dependencies: SecretResolvingGitHubWebhookHandlerDependencies,
  ) {}

  /** Resolves webhook secrets, then delegates to the durable GitHub ingestion handler. */
  public async handle(input: HandleGitHubWebhookInput): Promise<WebhookIngestionResult> {
    const secrets = await resolveApiGitHubWebhookSecrets(
      this.dependencies.env,
      this.dependencies.secretsManager,
    );
    if (!secrets) {
      throw new WebhookAuthenticationError("GitHub webhook secret is not configured.");
    }

    return new GitHubWebhookHandler({
      db: this.dependencies.db,
      metrics: this.dependencies.metrics,
      previousWebhookSecret: secrets.previous,
      traces: this.dependencies.traces,
      webhookSecret: secrets.current,
    }).handle(input);
  }
}

/** Resolves GitHub webhook secrets through SecretRef/SecretsManager configuration. */
export async function resolveApiGitHubWebhookSecrets(
  env: ApiSecretEnvironment,
  secretsManager: SecretsManager = createLocalEnvSecretsManager({ env }),
): Promise<ApiGitHubWebhookSecrets | undefined> {
  const currentRef = secretRefFromEnvironment({
    directValue: env.GITHUB_WEBHOOK_SECRET,
    envName: "GITHUB_WEBHOOK_SECRET",
    refValue: env.GITHUB_WEBHOOK_SECRET_REF,
  });
  if (!currentRef) {
    return undefined;
  }

  const previousRef = secretRefFromEnvironment({
    directValue: env.GITHUB_PREVIOUS_WEBHOOK_SECRET,
    envName: "GITHUB_PREVIOUS_WEBHOOK_SECRET",
    refValue: env.GITHUB_PREVIOUS_WEBHOOK_SECRET_REF ?? env.GITHUB_WEBHOOK_PREVIOUS_SECRET_REF,
  });
  const [current, previous] = await Promise.all([
    secretsManager.resolveSecret(currentRef, {
      purpose: "github_webhook_secret",
      service: "api",
    }),
    previousRef
      ? secretsManager.resolveSecret(previousRef, {
          purpose: "github_webhook_secret",
          service: "api",
        })
      : undefined,
  ]);
  const currentValue = emptyToUndefined(current.value);
  if (!currentValue) {
    return undefined;
  }
  const previousValue = previous ? emptyToUndefined(previous.value) : undefined;

  return {
    current: currentValue,
    ...(previousValue ? { previous: previousValue } : {}),
  };
}

/** Creates the Heimdall API app. */
export function createApiApp(options: CreateApiAppOptions = {}) {
  let databaseClient: DatabaseClient | undefined = options.databaseClient;
  let environmentBillingProvider: BillingProvider | undefined;
  let environmentBillingProviderLoaded = false;
  let environmentArtifactPayloadStore: ReviewArtifactPayloadStore | undefined;
  const getDatabaseClient = () => {
    databaseClient ??= createDatabaseClient();
    return databaseClient;
  };
  const getBillingProvider = () => {
    if (options.billingProvider) {
      return options.billingProvider;
    }
    if (!environmentBillingProviderLoaded) {
      environmentBillingProvider = createBillingProviderFromEnv(getDatabaseClient().db);
      environmentBillingProviderLoaded = true;
    }

    return environmentBillingProvider;
  };
  const getArtifactPayloadStore = () => {
    if (options.artifactPayloadStore) {
      return options.artifactPayloadStore;
    }
    environmentArtifactPayloadStore ??= createReviewArtifactPayloadStoreFromEnv();

    return environmentArtifactPayloadStore;
  };
  const getAdminDebugService = () =>
    options.adminDebugService ?? createAdminDebugService({ db: getDatabaseClient().db });
  const getAdminControlPlaneService = () =>
    options.adminControlPlaneService ??
    createAdminControlPlaneService({
      artifactPayloadStore: getArtifactPayloadStore(),
      db: getDatabaseClient().db,
      getBillingProvider,
    });
  const getBillingWebhookProcessor = () =>
    options.billingWebhookProcessor ??
    createBillingWebhookProcessor({ db: getDatabaseClient().db, getBillingProvider });
  const getProductDashboardService = () =>
    options.productDashboardService ??
    createProductDashboardService({ db: getDatabaseClient().db });
  const productSessionAuth = resolveProductSessionAuth(options.productSessionAuth);
  const getProductSessionService = () =>
    options.productSessionService ??
    createProductSessionService({ auth: productSessionAuth, db: getDatabaseClient().db });
  const productGitHubOAuth = resolveProductGitHubOAuth(options.productGitHubOAuth);
  const hasInjectedProductGitHubOAuthService = Boolean(options.productGitHubOAuthService);
  const getProductGitHubOAuthService = () =>
    options.productGitHubOAuthService ??
    createProductGitHubOAuthService({ auth: productGitHubOAuth, db: getDatabaseClient().db });
  const observabilitySink = options.adminObservabilitySink ?? createNoopObservabilitySink();
  const securityEventSink = options.adminSecurityEventSink ?? createNoopApiSecurityEventSink();
  const adminAuth = {
    ...resolveAdminControlPlaneAuth(options.adminControlPlaneAuth),
    securityEventSink,
  };
  const metrics = options.metrics ?? createNoopTelemetryMetricRecorder();
  const traces = options.traces ?? createNoopTelemetrySpanRecorder();
  const secretEnvironment = options.secretEnvironment ?? process.env;
  const secretsManager =
    options.secretsManager ?? createLocalEnvSecretsManager({ env: secretEnvironment });
  let environmentGithubWebhookHandler: GitHubWebhookRequestHandler | undefined;
  const getGithubWebhookHandler = () => {
    if (options.githubWebhookHandler) {
      return options.githubWebhookHandler;
    }
    environmentGithubWebhookHandler ??= new SecretResolvingGitHubWebhookHandler({
      db: getDatabaseClient().db,
      env: secretEnvironment,
      metrics,
      secretsManager,
      traces,
    });

    return environmentGithubWebhookHandler;
  };
  const readinessCheck = options.readinessCheck ?? (() => checkApiReadiness(getDatabaseClient));
  const apiRequestTelemetry = new WeakMap<Request, ApiRequestTelemetryState>();

  return new Elysia()
    .use(
      openapi({
        documentation: {
          components: {
            securitySchemes: {
              adminSession: {
                in: "cookie",
                name: adminAuth.sessionCookieName,
                type: "apiKey",
              },
              productSession: {
                in: "cookie",
                name: productSessionAuth.cookieName,
                type: "apiKey",
              },
            },
          },
          info: {
            description: "Heimdall control-plane and product dashboard API.",
            title: "Heimdall API",
            version: "1.0.0",
          },
        },
        enabled: openApiDocsEnabled(),
        path: "/openapi",
        specPath: "/openapi/json",
      }),
    )
    .onRequest(({ request }) => {
      const requestId = requestIdFromRequest(request);
      const span = traces.startSpan(OBSERVABILITY_SPAN_NAMES.apiRequest, {
        attributes: {
          "http.request.method": normalizedRequestMethod(request.method),
          "http.route": "unknown",
        },
        kind: "server",
        traceContext: traceContextFromRequest(request, requestId),
      });
      apiRequestTelemetry.set(request, {
        span,
        startedAtMs: Date.now(),
      });
    })
    .onAfterHandle(({ request, responseValue, route, set }) => {
      finishApiRequestTelemetry(apiRequestTelemetry, metrics, {
        method: request.method,
        request,
        route,
        set,
        statusCode: statusCodeFromResponseValue(responseValue, statusCodeFromSet(set, 200)),
      });
    })
    .onError(({ code, error, request, route, set }) => {
      finishApiRequestTelemetry(apiRequestTelemetry, metrics, {
        error,
        method: request.method,
        request,
        route,
        set,
        statusCode: apiErrorStatusCode(code, set),
      });
    })
    .get("/healthz", () => ({ ok: true, service: "api" }))
    .get("/livez", () =>
      createApiHealthResponse([
        {
          name: "process",
          status: "pass",
        },
      ]),
    )
    .get("/readyz", async ({ set }) => {
      const response = createApiHealthResponse(await readinessCheck());
      if (!response.ok) {
        set.status = 503;
      }

      return response;
    })
    .options("/app/*", ({ request, set }) => {
      setProductResponseHeaders(request, set);
      set.status = 204;
    })
    .get("/app/onboarding", async ({ request, set }) => {
      setProductResponseHeaders(request, set);
      return { data: await getProductDashboardService().getOnboarding() };
    })
    .options("/api/v1/*", ({ request, set }) =>
      isProductSessionRoute(new URL(request.url).pathname)
        ? handleProductPreflight(request, set)
        : handleAdminPreflight(request, set, adminAuth, observabilitySink),
    )
    .get("/api/v1/auth/github/start", async ({ request, set }) => {
      const requestId = requestIdFromRequest(request);
      setProductResponseHeaders(request, set);
      setResponseHeader(set, "x-request-id", requestId);
      const configResponse = guardProductOAuthConfiguration(
        set,
        productSessionAuth,
        productGitHubOAuth,
        hasInjectedProductGitHubOAuthService,
      );
      if (configResponse) {
        return configResponse;
      }

      try {
        const start = await getProductGitHubOAuthService().start({
          redirectTo: optionalQueryString(new URL(request.url), "redirectTo"),
          requestId,
          requestUrl: request.url,
        });
        return redirectResponseFromSet(set, start.authorizationUrl);
      } catch (error) {
        return handleProductOAuthError(error, set);
      }
    })
    .get("/api/v1/auth/github/callback", async ({ request, set }) => {
      const requestId = requestIdFromRequest(request);
      setProductResponseHeaders(request, set);
      setResponseHeader(set, "x-request-id", requestId);
      const configResponse = guardProductOAuthConfiguration(
        set,
        productSessionAuth,
        productGitHubOAuth,
        hasInjectedProductGitHubOAuthService,
      );
      if (configResponse) {
        return configResponse;
      }

      try {
        const completion = await getProductGitHubOAuthService().complete({
          callbackUrl: request.url,
          requestId,
        });
        const sessionWrite = await getProductSessionService().createSession({
          metadata: {
            provider: "github",
            providerLogin: completion.providerLogin,
            providerUserId: completion.providerUserId,
          },
          userId: completion.userId,
        });
        return redirectResponseFromSet(
          set,
          productDashboardRedirectUrl(completion.redirectTo),
          302,
          { "set-cookie": sessionWrite.cookie },
        );
      } catch (error) {
        return productOAuthErrorRedirect(error, productGitHubOAuth);
      }
    })
    .get("/api/v1/me", async ({ request, set }) => {
      const guardResult = await guardProductSession(
        request,
        set,
        productSessionAuth,
        getProductSessionService(),
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      return { data: productMeResponse(guardResult.session) };
    })
    .post("/api/v1/auth/logout", async ({ request, set }) => {
      const guardResult = await guardProductSession(
        request,
        set,
        productSessionAuth,
        getProductSessionService(),
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const sessionService = getProductSessionService();
      await sessionService.revokeSession(guardResult.session.sessionId);
      set.headers = {
        ...(set.headers ?? {}),
        "set-cookie": sessionService.clearCookie(),
      };

      return { data: { ok: true } };
    })
    .get("/api/v1/orgs", async ({ request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const url = new URL(request.url);
      const orgs = await getAdminControlPlaneService().listOrganizations(
        scopedOrganizationListQuery(url, guardResult.actor, listLimitFromUrl(url)),
      );

      return { data: { orgs } };
    })
    .get("/api/v1/orgs/:orgId/repositories", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const authorizationResponse = guardApiV1ScopedAccess(
        guardResult,
        params.orgId,
        undefined,
        "repo:read",
        set,
      );
      if (authorizationResponse) {
        return authorizationResponse;
      }

      const url = new URL(request.url);
      const repositories = await getAdminControlPlaneService().listRepositories(
        scopedOrganizationRepositoryListQuery(
          url,
          guardResult.actor,
          params.orgId,
          listLimitFromUrl(url),
        ),
      );

      return { data: { repositories } };
    })
    .get("/api/v1/orgs/:orgId/review-runs", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const authorizationResponse = guardApiV1ScopedAccess(
        guardResult,
        params.orgId,
        undefined,
        "review:read",
        set,
      );
      if (authorizationResponse) {
        return authorizationResponse;
      }

      const url = new URL(request.url);
      const reviews = await getAdminControlPlaneService().listReviewRuns({
        ...scopedReviewRunListQuery(url, guardResult.actor, listLimitFromUrl(url)),
        orgIds: [params.orgId],
      });

      return { data: { reviews } };
    })
    .get("/api/v1/orgs/:orgId/usage/summary", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const authorizationResponse = guardApiV1ScopedAccess(
        guardResult,
        params.orgId,
        undefined,
        "usage:read",
        set,
      );
      if (authorizationResponse) {
        return authorizationResponse;
      }

      try {
        const usage = await getAdminControlPlaneService().getProductUsageSummary(
          productUsageSummaryQueryFromUrl(new URL(request.url), params.orgId),
        );

        return { data: usage };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/orgs/:orgId/usage/events", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const authorizationResponse = guardApiV1ScopedAccess(
        guardResult,
        params.orgId,
        undefined,
        "usage:read",
        set,
      );
      if (authorizationResponse) {
        return authorizationResponse;
      }

      try {
        const query = productUsageEventsQueryFromUrl(new URL(request.url), params.orgId);
        const repositoryAuthorizationResponse = query.repoId
          ? await guardApiV1MaybeRepoScopedAccess(
              guardResult,
              query.repoId,
              params.orgId,
              "usage:read",
              set,
              getAdminControlPlaneService(),
            )
          : undefined;
        if (repositoryAuthorizationResponse) {
          return repositoryAuthorizationResponse;
        }

        const events = await getAdminControlPlaneService().listProductUsageEvents(query);

        return { data: { events } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/orgs/:orgId/settings", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const authorizationResponse = guardApiV1ScopedAccess(
        guardResult,
        params.orgId,
        undefined,
        "org:view",
        set,
      );
      if (authorizationResponse) {
        return authorizationResponse;
      }

      try {
        const settings = await getAdminControlPlaneService().getOrgSettings(params.orgId);
        return { data: { settings: settings.settings } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .patch("/api/v1/orgs/:orgId/settings", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const parsed = safeParseWithSchema(
        "UpdateOrgSettingsRequest",
        UpdateOrgSettingsRequestSchema,
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

      const authorizationResponse = guardApiV1ScopedAccess(
        guardResult,
        params.orgId,
        undefined,
        "org:manage",
        set,
      );
      if (authorizationResponse) {
        return authorizationResponse;
      }

      try {
        const settings = await getAdminControlPlaneService().updateOrgSettings(
          params.orgId,
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
            allowMemorySuppression: settings.settings.allowMemorySuppression,
            allowRepoLocalConfig: settings.settings.allowRepoLocalConfig,
            allowUserDefinedRules: settings.settings.allowUserDefinedRules,
            version: settings.settings.version,
          },
          name: "admin.settings.updated",
          orgId: settings.org.orgId,
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: { settings: settings.settings } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/orgs/:orgId", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const org = await getAdminControlPlaneService().getOrganization(params.orgId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          org.orgId,
          undefined,
          "org:view",
          set,
        );
        return authorizationResponse ?? { data: { org } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/installations", async ({ request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const url = new URL(request.url);
      const installations = await getAdminControlPlaneService().listProviderInstallations(
        scopedInstallationListQuery(url, guardResult.actor, listLimitFromUrl(url)),
      );

      return { data: { installations } };
    })
    .get("/api/v1/installations/:installationId", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const installation = await getAdminControlPlaneService().getProviderInstallation(
          params.installationId,
        );
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          installation.orgId,
          undefined,
          "installation:read",
          set,
        );
        return authorizationResponse ?? { data: { installation } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/api/v1/installations/:installationId/sync", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const installation = await getAdminControlPlaneService().getProviderInstallation(
          params.installationId,
        );
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          installation.orgId,
          undefined,
          "installation:sync",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const run = await getAdminControlPlaneService().enqueueInstallationSync(
          params.installationId,
          {
            actor: guardResult.actor,
            idempotencyKey: installationSyncIdempotencyKey(
              request,
              params.installationId,
              guardResult.requestId,
            ),
            requestId: guardResult.requestId,
            sessionId: guardResult.session.sessionId,
            traceContext: guardResult.traceContext,
          },
        );
        set.status = 202;
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: {
            actionKind: "installation.sync.enqueue",
            auditLogId: run.auditLogId,
            backgroundJobId: run.backgroundJobId,
            provider: installation.provider,
          },
          name: "admin.action.completed",
          orgId: installation.orgId,
          requestId: guardResult.requestId,
          statusCode: 202,
        });

        return { data: run };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/github/install-url", async ({ request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        return { data: githubInstallUrlResponse() };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/github/install-callback", ({ request, set }) => {
      try {
        const redirect = githubInstallCallbackRedirect(new URL(request.url));
        set.status = 302;
        set.headers = {
          "cache-control": "no-store",
          location: redirect.url,
        };
        return {
          data: redirect,
        };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/repositories/:repoId/memory", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          settings.repository.orgId,
          settings.repository.repoId,
          "memory:read",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const url = new URL(request.url);
        const [memoryFacts, memoryCandidates, suppressionMatches] = await Promise.all([
          getAdminControlPlaneService().listRepositoryMemoryFacts(
            params.repoId,
            memoryFactListQueryFromUrl(url),
          ),
          getAdminControlPlaneService().listRepositoryMemoryCandidates(
            params.repoId,
            memoryCandidateListQueryFromUrl(url),
          ),
          getAdminControlPlaneService().listRepositorySuppressionMatches(
            params.repoId,
            suppressionMatchListQueryFromUrl(url),
          ),
        ]);

        return {
          data: {
            memoryCandidates,
            memoryFacts,
            repository: settings.repository,
            suppressionMatches,
          },
        };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/api/v1/repositories/:repoId/memory", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          settings.repository.orgId,
          settings.repository.repoId,
          "memory:write",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const memoryFact = await getAdminControlPlaneService().createRepositoryMemoryFact(
          params.repoId,
          {
            ...(await readMemoryFactCreateBody(request)),
            actor: guardResult.actor,
            idempotencyKey: memoryFactCommandIdempotencyKey(
              request,
              params.repoId,
              guardResult.requestId,
            ),
            requestId: guardResult.requestId,
            sessionId: guardResult.session.sessionId,
          },
        );
        set.status = 201;

        return { data: { memoryFact } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/repositories/:repoId/review-runs", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          settings.repository.orgId,
          settings.repository.repoId,
          "review:read",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const url = new URL(request.url);
        const reviews = await getAdminControlPlaneService().listReviewRuns({
          ...scopedReviewRunListQuery(url, guardResult.actor, listLimitFromUrl(url)),
          repoId: params.repoId,
        });

        return { data: { reviews } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/repositories/:repoId/usage/summary", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          settings.repository.orgId,
          settings.repository.repoId,
          "usage:read",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const usage = await getAdminControlPlaneService().getProductUsageSummary(
          productUsageSummaryQueryFromUrl(
            new URL(request.url),
            settings.repository.orgId,
            params.repoId,
          ),
        );

        return { data: usage };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/repositories/:repoId", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          settings.repository.orgId,
          settings.repository.repoId,
          "repo:read",
          set,
        );
        return authorizationResponse ?? { data: settings };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/repositories/:repoId/rules", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          settings.repository.orgId,
          settings.repository.repoId,
          "rule:read",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const rules = await getAdminControlPlaneService().listRepositoryRules(params.repoId);
        return { data: { rules } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/api/v1/repositories/:repoId/rules", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const parsed = safeParseWithSchema(
        "CreateRepoRuleRequest",
        CreateRepoRuleRequestSchema,
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
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          settings.repository.orgId,
          settings.repository.repoId,
          "rule:write",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const rule = await getAdminControlPlaneService().createRepositoryRule(
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
          attributes: { effect: rule.effect, ruleId: rule.ruleId },
          name: "admin.rule.created",
          orgId: rule.orgId,
          repoId: rule.repoId,
          requestId: guardResult.requestId,
          statusCode: 201,
        });
        set.status = 201;

        return { data: rule };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .patch("/api/v1/repositories/:repoId/rules/:ruleId", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const parsed = safeParseWithSchema(
        "UpdateRepoRuleRequest",
        UpdateRepoRuleRequestSchema,
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
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          settings.repository.orgId,
          settings.repository.repoId,
          "rule:write",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const rule = await getAdminControlPlaneService().updateRepositoryRule(
          params.repoId,
          params.ruleId,
          parsed.value,
          {
            actor: guardResult.actor,
            requestId: guardResult.requestId,
            sessionId: guardResult.session.sessionId,
          },
        );
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: { effect: rule.effect, ruleId: rule.ruleId },
          name: "admin.rule.updated",
          orgId: rule.orgId,
          repoId: rule.repoId,
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: rule };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .delete("/api/v1/repositories/:repoId/rules/:ruleId", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          settings.repository.orgId,
          settings.repository.repoId,
          "rule:write",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const rule = await getAdminControlPlaneService().deleteRepositoryRule(
          params.repoId,
          params.ruleId,
          {
            actor: guardResult.actor,
            requestId: guardResult.requestId,
            sessionId: guardResult.session.sessionId,
          },
        );
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: { effect: rule.effect, ruleId: rule.ruleId },
          name: "admin.rule.deleted",
          orgId: rule.orgId,
          repoId: rule.repoId,
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: rule };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/api/v1/repositories/:repoId/policy-preview", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const parsed = safeParseWithSchema(
        "UpdateRepositoryControlPlaneSettingsRequest",
        UpdateRepositoryControlPlaneSettingsRequestSchema,
        await request.json().catch(() => ({})),
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
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          settings.repository.orgId,
          settings.repository.repoId,
          "rule:read",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const preview = await getAdminControlPlaneService().previewRepositoryPolicy(
          params.repoId,
          parsed.value,
        );
        return { data: preview };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/api/v1/repositories/:repoId/policy-test", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const parsed = safeParseWithSchema(
        "TestRepositoryPolicyRequest",
        TestRepositoryPolicyRequestSchema,
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
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          settings.repository.orgId,
          settings.repository.repoId,
          "rule:read",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const test = await getAdminControlPlaneService().testRepositoryPolicy(
          params.repoId,
          parsed.value,
        );
        return { data: test };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/api/v1/repositories/:repoId/config-file/validate", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      const parsed = safeParseWithSchema(
        "ValidateRepoLocalConfigFileRequest",
        ValidateRepoLocalConfigFileRequestSchema,
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
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          settings.repository.orgId,
          settings.repository.repoId,
          "rule:read",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const validation = await getAdminControlPlaneService().validateRepositoryConfigFile(
          params.repoId,
          parsed.value,
        );
        return { data: validation };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .patch("/api/v1/repositories/:repoId/settings", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
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
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          before.repository.orgId,
          before.repository.repoId,
          "repo:settings:write",
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
    .post("/api/v1/repositories/:repoId/enable", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const before = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          before.repository.orgId,
          before.repository.repoId,
          "repo:enable",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const settings = await getAdminControlPlaneService().updateRepositorySettings(
          params.repoId,
          { repositoryEnabled: true },
          {
            actor: guardResult.actor,
            requestId: guardResult.requestId,
            sessionId: guardResult.session.sessionId,
          },
        );
        const syncRun = await getAdminControlPlaneService().enqueueRepositorySync(params.repoId, {
          actor: guardResult.actor,
          idempotencyKey: repositoryCommandIdempotencyKey(
            request,
            params.repoId,
            guardResult.requestId,
          ),
          requestId: guardResult.requestId,
          sessionId: guardResult.session.sessionId,
          traceContext: guardResult.traceContext,
        });
        set.status = 202;

        return { data: { settings, syncRun } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/api/v1/repositories/:repoId/disable", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const before = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          before.repository.orgId,
          before.repository.repoId,
          "repo:disable",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const settings = await getAdminControlPlaneService().updateRepositorySettings(
          params.repoId,
          { repositoryEnabled: false },
          {
            actor: guardResult.actor,
            requestId: guardResult.requestId,
            sessionId: guardResult.session.sessionId,
          },
        );

        return { data: settings };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/api/v1/repositories/:repoId/sync", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          settings.repository.orgId,
          settings.repository.repoId,
          "repo:reindex",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const run = await getAdminControlPlaneService().enqueueRepositorySync(params.repoId, {
          actor: guardResult.actor,
          idempotencyKey: repositoryCommandIdempotencyKey(
            request,
            params.repoId,
            guardResult.requestId,
          ),
          requestId: guardResult.requestId,
          sessionId: guardResult.session.sessionId,
          traceContext: guardResult.traceContext,
        });
        set.status = 202;

        return { data: run };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/api/v1/repositories/:repoId/reindex", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          settings.repository.orgId,
          settings.repository.repoId,
          "repo:reindex",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const body = await readRepositoryReindexBody(request);
        const commitSha = body.commitSha ?? repositoryMetadataHeadSha(settings.repository);
        if (!commitSha) {
          throw new AdminRequestValidationError(
            "repo.commit_sha_required",
            "Repository reindex requires commitSha until default-branch head discovery is available.",
            400,
          );
        }

        const run = await getAdminControlPlaneService().enqueueRepositoryReindex(params.repoId, {
          actor: guardResult.actor,
          commitSha,
          ...(body.force !== undefined ? { force: body.force } : {}),
          idempotencyKey: repositoryCommandIdempotencyKey(
            request,
            params.repoId,
            guardResult.requestId,
          ),
          ...(body.reason ? { reason: body.reason } : {}),
          requestId: guardResult.requestId,
          sessionId: guardResult.session.sessionId,
          traceContext: guardResult.traceContext,
        });
        set.status = 202;

        return { data: run };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/review-runs/:reviewRunId/findings", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const reviewRun = await getAdminControlPlaneService().getReviewRun(params.reviewRunId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          reviewRun.orgId,
          reviewRun.repoId,
          "finding:read",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const findings = await getAdminControlPlaneService().listReviewFindings(
          params.reviewRunId,
          reviewFindingListQueryFromUrl(new URL(request.url)),
        );

        return { data: { findings, reviewRun } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/review-runs/:reviewRunId/artifacts", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const reviewRun = await getAdminControlPlaneService().getReviewRun(params.reviewRunId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          reviewRun.orgId,
          reviewRun.repoId,
          "review:debug:read",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const artifacts = await getAdminControlPlaneService().listReviewArtifacts(
          params.reviewRunId,
        );

        return { data: { artifacts, reviewRun } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get(
      "/api/v1/review-runs/:reviewRunId/artifacts/:reviewArtifactId/payload",
      async ({ params, request, set }) => {
        const guardResult = await guardApiV1Session(
          request,
          set,
          adminAuth,
          productSessionAuth,
          getProductSessionService,
          observabilitySink,
          "admin.inspect",
        );
        if ("response" in guardResult) {
          return guardResult.response;
        }

        try {
          const reviewRun = await getAdminControlPlaneService().getReviewRun(params.reviewRunId);
          const authorizationResponse = guardApiV1ScopedAccess(
            guardResult,
            reviewRun.orgId,
            reviewRun.repoId,
            "review:debug:read",
            set,
          );
          if (authorizationResponse) {
            return authorizationResponse;
          }

          const payloadRequest = reviewArtifactPayloadRequestFromUrl(
            new URL(request.url),
            guardResult,
            request,
          );
          const rawAccessResponse = guardRawArtifactPayloadAccess(
            payloadRequest,
            guardResult,
            adminAuth,
            {
              orgId: reviewRun.orgId,
              repoId: reviewRun.repoId,
              reviewRunId: reviewRun.reviewRunId,
            },
            request,
            set,
            observabilitySink,
            securityEventSink,
          );
          if (rawAccessResponse) {
            return rawAccessResponse;
          }

          const payload = await getAdminControlPlaneService().getReviewArtifactPayload(
            params.reviewRunId,
            params.reviewArtifactId,
            payloadRequest,
          );
          setResponseHeader(set, "cache-control", "no-store");

          return { data: { ...payload, reviewRun } };
        } catch (error) {
          if (error instanceof AdminRequestValidationError) {
            recordAdminAccessDenied(
              observabilitySink,
              request,
              guardResult.requestId,
              error.code,
              error.status,
              {
                actorUserId: guardResult.actor.actorUserId,
                resourceId: params.reviewArtifactId,
                reviewRunId: params.reviewRunId,
              },
              securityEventSink,
            );
          }
          return handleAdminControlPlaneError(error, set);
        }
      },
    )
    .get(
      "/api/v1/review-runs/:reviewRunId/artifacts/:reviewArtifactId/download-url",
      async ({ params, request, set }) => {
        const guardResult = await guardApiV1Session(
          request,
          set,
          adminAuth,
          productSessionAuth,
          getProductSessionService,
          observabilitySink,
          "admin.inspect",
        );
        if ("response" in guardResult) {
          return guardResult.response;
        }

        try {
          const reviewRun = await getAdminControlPlaneService().getReviewRun(params.reviewRunId);
          const authorizationResponse = guardApiV1ScopedAccess(
            guardResult,
            reviewRun.orgId,
            reviewRun.repoId,
            "review:debug:read",
            set,
          );
          if (authorizationResponse) {
            return authorizationResponse;
          }

          const payloadRequest = reviewArtifactPayloadRequestFromUrl(
            new URL(request.url),
            guardResult,
            request,
          );
          const rawAccessResponse = guardRawArtifactPayloadAccess(
            payloadRequest,
            guardResult,
            adminAuth,
            {
              orgId: reviewRun.orgId,
              repoId: reviewRun.repoId,
              reviewRunId: reviewRun.reviewRunId,
            },
            request,
            set,
            observabilitySink,
            securityEventSink,
          );
          if (rawAccessResponse) {
            return rawAccessResponse;
          }

          const downloadUrl = await getAdminControlPlaneService().createReviewArtifactDownloadUrl(
            params.reviewRunId,
            params.reviewArtifactId,
            payloadRequest,
          );
          setResponseHeader(set, "cache-control", "no-store");

          return { data: { ...downloadUrl, reviewRun } };
        } catch (error) {
          if (error instanceof AdminRequestValidationError) {
            recordAdminAccessDenied(
              observabilitySink,
              request,
              guardResult.requestId,
              error.code,
              error.status,
              {
                actorUserId: guardResult.actor.actorUserId,
                resourceId: params.reviewArtifactId,
                reviewRunId: params.reviewRunId,
              },
              securityEventSink,
            );
          }
          return handleAdminControlPlaneError(error, set);
        }
      },
    )
    .get(
      "/api/v1/review-runs/:reviewRunId/artifacts/:reviewArtifactId/download",
      async ({ params, request, set }) => {
        const guardResult = await guardApiV1Session(
          request,
          set,
          adminAuth,
          productSessionAuth,
          getProductSessionService,
          observabilitySink,
          "admin.inspect",
        );
        if ("response" in guardResult) {
          return guardResult.response;
        }

        try {
          const reviewRun = await getAdminControlPlaneService().getReviewRun(params.reviewRunId);
          const authorizationResponse = guardApiV1ScopedAccess(
            guardResult,
            reviewRun.orgId,
            reviewRun.repoId,
            "review:debug:read",
            set,
          );
          if (authorizationResponse) {
            return authorizationResponse;
          }

          const payloadRequest = reviewArtifactPayloadRequestFromUrl(
            new URL(request.url),
            guardResult,
            request,
          );
          const rawAccessResponse = guardRawArtifactPayloadAccess(
            payloadRequest,
            guardResult,
            adminAuth,
            {
              orgId: reviewRun.orgId,
              repoId: reviewRun.repoId,
              reviewRunId: reviewRun.reviewRunId,
            },
            request,
            set,
            observabilitySink,
            securityEventSink,
          );
          if (rawAccessResponse) {
            return rawAccessResponse;
          }

          const payload = await getAdminControlPlaneService().getReviewArtifactPayload(
            params.reviewRunId,
            params.reviewArtifactId,
            payloadRequest,
          );
          setResponseHeader(set, "cache-control", "no-store");
          setResponseHeader(set, "content-type", "application/json; charset=utf-8");
          setResponseHeader(
            set,
            "content-disposition",
            `attachment; filename="${artifactDownloadFilename(payload.artifact)}"`,
          );

          return new Response(JSON.stringify(payload.payload, null, 2), {
            headers: headersFromSet(set),
            status: 200,
          });
        } catch (error) {
          if (error instanceof AdminRequestValidationError) {
            recordAdminAccessDenied(
              observabilitySink,
              request,
              guardResult.requestId,
              error.code,
              error.status,
              {
                actorUserId: guardResult.actor.actorUserId,
                resourceId: params.reviewArtifactId,
                reviewRunId: params.reviewRunId,
              },
              securityEventSink,
            );
          }
          return handleAdminControlPlaneError(error, set);
        }
      },
    )
    .post("/api/v1/review-runs/:reviewRunId/rerun", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const reviewRun = await getAdminControlPlaneService().getReviewRun(params.reviewRunId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          reviewRun.orgId,
          reviewRun.repoId,
          "review:rerun",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const run = await getAdminControlPlaneService().enqueueReviewRerun(params.reviewRunId, {
          actor: guardResult.actor,
          idempotencyKey: reviewRerunIdempotencyKey(
            request,
            params.reviewRunId,
            guardResult.requestId,
          ),
          requestId: guardResult.requestId,
          sessionId: guardResult.session.sessionId,
          traceContext: guardResult.traceContext,
        });
        set.status = 202;

        return { data: run };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/review-runs/:reviewRunId", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const reviewRun = await getAdminControlPlaneService().getReviewRun(params.reviewRunId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          reviewRun.orgId,
          reviewRun.repoId,
          "review:read",
          set,
        );
        return authorizationResponse ?? { data: { reviewRun } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/findings/:findingId", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const finding = await getAdminControlPlaneService().getReviewFinding(params.findingId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          finding.orgId,
          finding.repoId,
          "finding:read",
          set,
        );
        return authorizationResponse ?? { data: { finding } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/findings/:findingId/feedback-events", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const finding = await getAdminControlPlaneService().getReviewFinding(params.findingId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          finding.orgId,
          finding.repoId,
          "finding:read",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const timeline = await getAdminControlPlaneService().listFindingFeedbackEvents(
          params.findingId,
        );

        return { data: { feedbackEvents: timeline, finding } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .patch("/api/v1/findings/:findingId/outcome", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const finding = await getAdminControlPlaneService().getReviewFinding(params.findingId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          finding.orgId,
          finding.repoId,
          "finding:write",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const outcome = await getAdminControlPlaneService().recordFindingOutcome(params.findingId, {
          ...(await readFindingOutcomePatchBody(request)),
          actor: guardResult.actor,
          idempotencyKey: findingOutcomeIdempotencyKey(
            request,
            params.findingId,
            guardResult.requestId,
          ),
          requestId: guardResult.requestId,
          sessionId: guardResult.session.sessionId,
          traceContext: guardResult.traceContext,
        });

        return { data: outcome };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/api/v1/findings/:findingId/suppress-similar", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const finding = await getAdminControlPlaneService().getReviewFinding(params.findingId);
        const body = await readSuppressSimilarFindingBody(request);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          finding.orgId,
          body.scope === "repo" ? finding.repoId : undefined,
          "rule:write",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const suppression = await getAdminControlPlaneService().suppressSimilarFinding(
          params.findingId,
          {
            ...body,
            actor: guardResult.actor,
            idempotencyKey: findingSuppressionIdempotencyKey(
              request,
              params.findingId,
              guardResult.requestId,
            ),
            requestId: guardResult.requestId,
            sessionId: guardResult.session.sessionId,
          },
        );
        set.status = 201;

        return { data: suppression };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/api/v1/memory/:memoryFactId", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.inspect",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const memoryFact = await getAdminControlPlaneService().getMemoryFact(params.memoryFactId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          memoryFact.orgId,
          memoryFact.repoId,
          "memory:read",
          set,
        );
        return authorizationResponse ?? { data: { memoryFact } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .patch("/api/v1/memory/:memoryFactId", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const existing = await getAdminControlPlaneService().getMemoryFact(params.memoryFactId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          existing.orgId,
          existing.repoId,
          "memory:write",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const memoryFact = await getAdminControlPlaneService().updateMemoryFact(
          params.memoryFactId,
          {
            ...(await readMemoryFactPatchBody(request)),
            actor: guardResult.actor,
            requestId: guardResult.requestId,
            sessionId: guardResult.session.sessionId,
          },
        );

        return { data: { memoryFact } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .delete("/api/v1/memory/:memoryFactId", async ({ params, request, set }) => {
      const guardResult = await guardApiV1Session(
        request,
        set,
        adminAuth,
        productSessionAuth,
        getProductSessionService,
        observabilitySink,
        "admin.settings.manage",
      );
      if ("response" in guardResult) {
        return guardResult.response;
      }

      try {
        const existing = await getAdminControlPlaneService().getMemoryFact(params.memoryFactId);
        const authorizationResponse = guardApiV1ScopedAccess(
          guardResult,
          existing.orgId,
          existing.repoId,
          "memory:write",
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const memoryFact = await getAdminControlPlaneService().deleteMemoryFact(
          params.memoryFactId,
          {
            actor: guardResult.actor,
            requestId: guardResult.requestId,
            sessionId: guardResult.session.sessionId,
          },
        );

        return { data: { memoryFact } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post(
      "/api/v1/memory-candidates/:memoryCandidateId/approve",
      async ({ params, request, set }) => {
        const guardResult = await guardApiV1Session(
          request,
          set,
          adminAuth,
          productSessionAuth,
          getProductSessionService,
          observabilitySink,
          "admin.settings.manage",
        );
        if ("response" in guardResult) {
          return guardResult.response;
        }

        try {
          const existing = await getAdminControlPlaneService().getMemoryCandidate(
            params.memoryCandidateId,
          );
          const authorizationResponse = guardApiV1ScopedAccess(
            guardResult,
            existing.orgId,
            existing.repoId,
            "memory:write",
            set,
          );
          if (authorizationResponse) {
            return authorizationResponse;
          }

          const approval = await getAdminControlPlaneService().approveMemoryCandidate(
            params.memoryCandidateId,
            {
              ...(await readMemoryCandidateModerationBody(request)),
              actor: guardResult.actor,
              idempotencyKey: memoryCandidateCommandIdempotencyKey(
                request,
                params.memoryCandidateId,
                guardResult.requestId,
              ),
              requestId: guardResult.requestId,
              sessionId: guardResult.session.sessionId,
            },
          );

          return { data: approval };
        } catch (error) {
          return handleAdminControlPlaneError(error, set);
        }
      },
    )
    .post(
      "/api/v1/memory-candidates/:memoryCandidateId/reject",
      async ({ params, request, set }) => {
        const guardResult = await guardApiV1Session(
          request,
          set,
          adminAuth,
          productSessionAuth,
          getProductSessionService,
          observabilitySink,
          "admin.settings.manage",
        );
        if ("response" in guardResult) {
          return guardResult.response;
        }

        try {
          const existing = await getAdminControlPlaneService().getMemoryCandidate(
            params.memoryCandidateId,
          );
          const authorizationResponse = guardApiV1ScopedAccess(
            guardResult,
            existing.orgId,
            existing.repoId,
            "memory:write",
            set,
          );
          if (authorizationResponse) {
            return authorizationResponse;
          }

          const rejection = await getAdminControlPlaneService().rejectMemoryCandidate(
            params.memoryCandidateId,
            {
              ...(await readMemoryCandidateModerationBody(request)),
              actor: guardResult.actor,
              idempotencyKey: memoryCandidateCommandIdempotencyKey(
                request,
                params.memoryCandidateId,
                guardResult.requestId,
              ),
              requestId: guardResult.requestId,
              sessionId: guardResult.session.sessionId,
            },
          );

          return { data: rejection };
        } catch (error) {
          return handleAdminControlPlaneError(error, set);
        }
      },
    )
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
          {},
          securityEventSink,
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
    .post("/admin/support-sessions", async ({ request, set }) => {
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
        const supportSession = await createAuditedSupportSession({
          auth: adminAuth,
          body: await readCreateSupportSessionRequestBody(request),
          context: guardResult,
          service: getAdminControlPlaneService(),
        });
        set.status = 201;

        return { data: supportSession };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
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
    .get("/admin/debug/jobs/:backgroundJobId", async ({ params, request, set }) => {
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
        const details = await getAdminDebugService().getBackgroundJobDebugDetails(
          params.backgroundJobId,
        );
        const authorizationResponse = await guardJobsScopedAccess(
          guardResult.actor,
          [details.job],
          set,
          getAdminControlPlaneService(),
        );
        return authorizationResponse ?? { data: details };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/admin/debug/jobs/:backgroundJobId/replay-plan", async ({ params, request, set }) => {
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
        const plan = await getAdminDebugService().createBackgroundJobReplayPlan(
          params.backgroundJobId,
        );
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
    .post("/admin/debug/jobs/:backgroundJobId/replay", async ({ params, request, set }) => {
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
        const plan = await getAdminDebugService().createBackgroundJobReplayPlan(
          params.backgroundJobId,
        );
        const authorizationResponse = await guardPlanScopedAccess(
          guardResult.actor,
          [plan.job],
          set,
          getAdminControlPlaneService(),
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const replay = await getAdminDebugService().executeBackgroundJobReplay(
          params.backgroundJobId,
          confirmationToken,
          replayAuditActor(guardResult),
        );
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: {
            replayKind: "job",
            resourceId: params.backgroundJobId,
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
    .post(
      "/admin/debug/reviews/:reviewRunId/retrieval-replay",
      async ({ params, request, set }) => {
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
          const details = await getAdminDebugService().getReviewDebugDetails(params.reviewRunId);
          const authorizationResponse = await guardRepoIdScopedAccess(
            guardResult.actor,
            details.reviewRun.repoId,
            set,
            getAdminControlPlaneService(),
          );
          if (authorizationResponse) {
            return authorizationResponse;
          }

          const dryRun = await getAdminDebugService().replayRetrievalDryRun(params.reviewRunId);
          return { data: dryRun };
        } catch (error) {
          return handleAdminDebugError(error, set);
        }
      },
    )
    .post(
      "/admin/debug/reviews/:reviewRunId/validation-replay",
      async ({ params, request, set }) => {
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
          const details = await getAdminDebugService().getReviewDebugDetails(params.reviewRunId);
          const authorizationResponse = await guardRepoIdScopedAccess(
            guardResult.actor,
            details.reviewRun.repoId,
            set,
            getAdminControlPlaneService(),
          );
          if (authorizationResponse) {
            return authorizationResponse;
          }

          const dryRun = await getAdminDebugService().replayValidationDryRun(params.reviewRunId);
          return { data: dryRun };
        } catch (error) {
          return handleAdminDebugError(error, set);
        }
      },
    )
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
    .post("/admin/debug/reviews/:reviewRunId/debug-bundle", async ({ params, request, set }) => {
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
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const bundle = await getAdminDebugService().exportReviewRunDebugBundle(
          params.reviewRunId,
          replayAuditActor(guardResult),
        );
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: {
            bundleId: bundle.bundleId,
            payloadHash: bundle.payloadHash,
            resourceId: params.reviewRunId,
            ...(guardResult.supportSessionId
              ? { supportSessionId: guardResult.supportSessionId }
              : {}),
          },
          name: "admin.debug_bundle.exported",
          repoId: bundle.repoId,
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: bundle };
      } catch (error) {
        return handleAdminDebugError(error, set);
      }
    })
    .post("/admin/debug/reviews/:reviewRunId/import-eval", async ({ params, request, set }) => {
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
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const importRequest = await readEvalImportRequest(request, params.reviewRunId);
        const rawImportGuardResponse = guardRawEvalImportAccess(
          importRequest,
          guardResult,
          adminAuth,
          {
            repoId: details.reviewRun.repoId,
            reviewRunId: details.reviewRun.reviewRunId,
          },
          request,
          set,
          observabilitySink,
          securityEventSink,
        );
        if (rawImportGuardResponse) {
          return rawImportGuardResponse;
        }

        const draft = await getAdminDebugService().createReviewRunEvalImportDraft(
          importRequest,
          replayAuditActor(guardResult),
        );
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: {
            caseId: draft.evalCase.caseId,
            importDraftId: draft.importDraftId,
            resourceId: params.reviewRunId,
            ...(guardResult.supportSessionId
              ? { supportSessionId: guardResult.supportSessionId }
              : {}),
            suiteId: draft.suiteId,
          },
          name: "admin.eval_import.draft_created",
          repoId: draft.repoId,
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: draft };
      } catch (error) {
        if (error instanceof AdminRequestValidationError) {
          recordAdminAccessDenied(
            observabilitySink,
            request,
            guardResult.requestId,
            error.code,
            error.status,
            { actorUserId: guardResult.actor.actorUserId, resourceId: params.reviewRunId },
            securityEventSink,
          );
        }
        return handleAdminDebugError(error, set);
      }
    })
    .get("/admin/debug/repos/:repoId/memory-rules", async ({ params, request, set }) => {
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
        const details = await getAdminDebugService().getMemoryRulesDebugDetails(params.repoId);
        const authorizationResponse = guardScopedAccess(
          guardResult.actor,
          details.repository.orgId,
          details.repository.repoId,
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: {
            memoryFactCount: details.memoryFacts.length,
            resourceId: params.repoId,
            ruleCount: details.rules.length,
          },
          name: "admin.memory_rules.inspected",
          orgId: details.repository.orgId,
          repoId: details.repository.repoId,
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: details };
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
    .get("/admin/overview", async ({ request, set }) => {
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

      const url = new URL(request.url);
      const limit = listLimitFromUrl(url);
      const service = getAdminControlPlaneService();
      const repositoryQuery = scopedRepositoryListQuery(url, guardResult.actor, limit);
      const reviewQuery = scopedReviewRunListQuery(url, guardResult.actor, limit);
      const auditQuery = actorHasPermission(guardResult.actor, "admin.audit.view")
        ? overviewAuditQueryForActor(guardResult.actor, limit)
        : undefined;
      const [repositories, recentReviews, reviewMetrics, recentAuditLogs, runtimeHealth] =
        await Promise.all([
          service.listRepositories(repositoryQuery),
          service.listReviewRuns(reviewQuery),
          service.getReviewMetricsSummary(reviewQuery),
          auditQuery ? service.listAuditLogs(auditQuery) : Promise.resolve([]),
          readinessCheck().then(createApiHealthResponse),
        ]);

      return {
        data: {
          repositories,
          recentAuditLogs,
          recentReviews,
          reviewMetrics,
          runtimeHealth,
        } satisfies AdminDashboardOverview,
      };
    })
    .get("/admin/repos", async ({ request, set }) => {
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

      const url = new URL(request.url);
      const repositories = await getAdminControlPlaneService().listRepositories(
        scopedRepositoryListQuery(url, guardResult.actor, listLimitFromUrl(url)),
      );

      return { data: { repositories } };
    })
    .get("/admin/reviews", async ({ request, set }) => {
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

      const url = new URL(request.url);
      const query = scopedReviewRunListQuery(url, guardResult.actor, listLimitFromUrl(url));
      if (query.repoId) {
        const authorizationResponse = await guardRepoIdScopedAccess(
          guardResult.actor,
          query.repoId,
          set,
          getAdminControlPlaneService(),
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }
      }

      const reviews = await getAdminControlPlaneService().listReviewRuns(query);
      return { data: { reviews } };
    })
    .get("/admin/evaluation/suites", async ({ request, set }) => {
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

      const suites = await getAdminControlPlaneService().listEvaluationSuites({
        limit: listLimitFromUrl(new URL(request.url)),
      });
      return { data: { suites } };
    })
    .get("/admin/evaluation/suites/:evalSuiteId/runs", async ({ params, request, set }) => {
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

      const runs = await getAdminControlPlaneService().listEvaluationRuns({
        evalSuiteId: params.evalSuiteId,
        limit: listLimitFromUrl(new URL(request.url)),
      });
      return { data: { runs } };
    })
    .get("/admin/evaluation/runs/:evalRunId", async ({ params, request, set }) => {
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
        const details = await getAdminControlPlaneService().getEvaluationRun(params.evalRunId);
        return { data: details };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .get("/admin/repos/:repoId/rules", async ({ params, request, set }) => {
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
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const rules = await getAdminControlPlaneService().listRepositoryRules(params.repoId);
        return { data: { rules } };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/admin/repos/:repoId/rules", async ({ params, request, set }) => {
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
        "CreateRepoRuleRequest",
        CreateRepoRuleRequestSchema,
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
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardScopedAccess(
          guardResult.actor,
          settings.repository.orgId,
          settings.repository.repoId,
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const rule = await getAdminControlPlaneService().createRepositoryRule(
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
          attributes: { effect: rule.effect, ruleId: rule.ruleId },
          name: "admin.rule.created",
          orgId: rule.orgId,
          repoId: rule.repoId,
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: rule };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .patch("/admin/repos/:repoId/rules/:ruleId", async ({ params, request, set }) => {
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
        "UpdateRepoRuleRequest",
        UpdateRepoRuleRequestSchema,
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
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardScopedAccess(
          guardResult.actor,
          settings.repository.orgId,
          settings.repository.repoId,
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const rule = await getAdminControlPlaneService().updateRepositoryRule(
          params.repoId,
          params.ruleId,
          parsed.value,
          {
            actor: guardResult.actor,
            requestId: guardResult.requestId,
            sessionId: guardResult.session.sessionId,
          },
        );
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: { effect: rule.effect, ruleId: rule.ruleId },
          name: "admin.rule.updated",
          orgId: rule.orgId,
          repoId: rule.repoId,
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: rule };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .delete("/admin/repos/:repoId/rules/:ruleId", async ({ params, request, set }) => {
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

      try {
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardScopedAccess(
          guardResult.actor,
          settings.repository.orgId,
          settings.repository.repoId,
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const rule = await getAdminControlPlaneService().deleteRepositoryRule(
          params.repoId,
          params.ruleId,
          {
            actor: guardResult.actor,
            requestId: guardResult.requestId,
            sessionId: guardResult.session.sessionId,
          },
        );
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: { effect: rule.effect, ruleId: rule.ruleId },
          name: "admin.rule.deleted",
          orgId: rule.orgId,
          repoId: rule.repoId,
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: rule };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/admin/repos/:repoId/policy-preview", async ({ params, request, set }) => {
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

      const parsed = safeParseWithSchema(
        "UpdateRepositoryControlPlaneSettingsRequest",
        UpdateRepositoryControlPlaneSettingsRequestSchema,
        await request.json().catch(() => ({})),
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
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardScopedAccess(
          guardResult.actor,
          settings.repository.orgId,
          settings.repository.repoId,
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const preview = await getAdminControlPlaneService().previewRepositoryPolicy(
          params.repoId,
          parsed.value,
        );
        return { data: preview };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/admin/repos/:repoId/policy-test", async ({ params, request, set }) => {
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

      const parsed = safeParseWithSchema(
        "TestRepositoryPolicyRequest",
        TestRepositoryPolicyRequestSchema,
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
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardScopedAccess(
          guardResult.actor,
          settings.repository.orgId,
          settings.repository.repoId,
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const test = await getAdminControlPlaneService().testRepositoryPolicy(
          params.repoId,
          parsed.value,
        );
        return { data: test };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/admin/repos/:repoId/config-file/validate", async ({ params, request, set }) => {
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

      const parsed = safeParseWithSchema(
        "ValidateRepoLocalConfigFileRequest",
        ValidateRepoLocalConfigFileRequestSchema,
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
        const settings = await getAdminControlPlaneService().getRepositorySettings(params.repoId);
        const authorizationResponse = guardScopedAccess(
          guardResult.actor,
          settings.repository.orgId,
          settings.repository.repoId,
          set,
        );
        if (authorizationResponse) {
          return authorizationResponse;
        }

        const validation = await getAdminControlPlaneService().validateRepositoryConfigFile(
          params.repoId,
          parsed.value,
        );
        return { data: validation };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
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
    .get("/admin/security-events", async ({ request, set }) => {
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

      const query = securityEventQueryFromUrl(new URL(request.url));
      const authorizationResponse = guardSecurityEventQueryScope(guardResult.actor, query, set);
      if (authorizationResponse) {
        return authorizationResponse;
      }

      return {
        data: {
          securityEvents: await getAdminControlPlaneService().listSecurityEvents(query),
        },
      };
    })
    .get("/admin/usage", async ({ request, set }) => {
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

      const query = scopedUsageQuery(new URL(request.url), guardResult.actor);
      const authorizationResponse = await guardUsageQueryScope(
        guardResult.actor,
        query,
        set,
        getAdminControlPlaneService(),
      );
      if (authorizationResponse) {
        return authorizationResponse;
      }

      return { data: await getAdminControlPlaneService().listUsageSummary(query) };
    })
    .get("/admin/entitlements", async ({ request, set }) => {
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

      const query = entitlementQueryFromUrl(new URL(request.url), guardResult.actor);
      const authorizationResponse = guardEntitlementQueryScope(guardResult.actor, query, set);
      if (authorizationResponse) {
        return authorizationResponse;
      }

      return {
        data: await getAdminControlPlaneService().getEntitlementSummary({
          ...query,
          orgId: requireValue(query.orgId),
        }),
      };
    })
    .get("/admin/billing", async ({ request, set }) => {
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

      const query = billingQueryFromUrl(new URL(request.url), guardResult.actor);
      const authorizationResponse = guardBillingQueryScope(guardResult.actor, query, set);
      if (authorizationResponse) {
        return authorizationResponse;
      }

      return {
        data: await getAdminControlPlaneService().getBillingSummary({
          orgId: requireValue(query.orgId),
        }),
      };
    })
    .get("/admin/billing/meter-events", async ({ request, set }) => {
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

      const query = billingMeterEventsQueryFromUrl(new URL(request.url), guardResult.actor);
      const authorizationResponse = guardBillingQueryScope(guardResult.actor, query, set);
      if (authorizationResponse) {
        return authorizationResponse;
      }

      return {
        data: await getAdminControlPlaneService().listBillingMeterEvents({
          ...query,
          orgId: requireValue(query.orgId),
        }),
      };
    })
    .get("/admin/billing/reconciliation", async ({ request, set }) => {
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

      const query = billingReconciliationQueryFromUrl(new URL(request.url), guardResult.actor);
      const authorizationResponse = guardBillingQueryScope(guardResult.actor, query, set);
      if (authorizationResponse) {
        return authorizationResponse;
      }

      return {
        data: await getAdminControlPlaneService().getBillingReconciliation({
          ...query,
          orgId: requireValue(query.orgId),
        }),
      };
    })
    .post("/admin/billing/reconciliation/run", async ({ request, set }) => {
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

      const query = billingReconciliationQueryFromUrl(new URL(request.url), guardResult.actor);
      const authorizationResponse = guardBillingQueryScope(guardResult.actor, query, set);
      if (authorizationResponse) {
        return authorizationResponse;
      }

      const run = await getAdminControlPlaneService().enqueueBillingReconciliation({
        ...query,
        orgId: requireValue(query.orgId),
        requestId: guardResult.requestId,
        traceContext: guardResult.traceContext,
      });
      await getAdminControlPlaneService().recordAuditEvent({
        action: "billing.reconciliation.enqueued",
        actor: guardResult.actor,
        metadata: {
          jobKey: run.jobKey,
          periodKey: query.periodKey,
          requestId: guardResult.requestId,
        },
        orgId: requireValue(query.orgId),
        requestId: guardResult.requestId,
        resourceId: run.backgroundJobId,
        resourceType: "background_job",
        sessionId: guardResult.session.sessionId,
      });

      return { data: run };
    })
    .post("/admin/billing/checkout-session", async ({ request, set }) => {
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
        "CreateBillingCheckoutSessionRequest",
        CreateBillingCheckoutSessionRequestSchema,
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

      const query = { orgId: parsed.value.orgId ?? singleActorOrgScope(guardResult.actor) };
      const authorizationResponse = guardBillingQueryScope(guardResult.actor, query, set);
      if (authorizationResponse) {
        return authorizationResponse;
      }

      try {
        const session = await getAdminControlPlaneService().createBillingCheckoutSession({
          ...parsed.value,
          idempotencyKey: billingMutationIdempotencyKey(
            request,
            "checkout",
            requireValue(query.orgId),
            guardResult.requestId,
          ),
          orgId: requireValue(query.orgId),
        });
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: { checkoutSessionId: session.checkoutSessionId, provider: session.provider },
          name: "admin.billing.checkout_session.created",
          orgId: requireValue(query.orgId),
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: session };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/admin/billing/portal-session", async ({ request, set }) => {
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
        "CreateBillingPortalSessionRequest",
        CreateBillingPortalSessionRequestSchema,
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

      const query = { orgId: parsed.value.orgId ?? singleActorOrgScope(guardResult.actor) };
      const authorizationResponse = guardBillingQueryScope(guardResult.actor, query, set);
      if (authorizationResponse) {
        return authorizationResponse;
      }

      try {
        const session = await getAdminControlPlaneService().createBillingPortalSession({
          ...parsed.value,
          idempotencyKey: billingMutationIdempotencyKey(
            request,
            "portal",
            requireValue(query.orgId),
            guardResult.requestId,
          ),
          orgId: requireValue(query.orgId),
        });
        recordAdminTelemetry(observabilitySink, request, {
          actorUserId: guardResult.actor.actorUserId,
          attributes: { portalSessionId: session.portalSessionId, provider: session.provider },
          name: "admin.billing.portal_session.created",
          orgId: requireValue(query.orgId),
          requestId: guardResult.requestId,
          statusCode: 200,
        });

        return { data: session };
      } catch (error) {
        return handleAdminControlPlaneError(error, set);
      }
    })
    .post("/webhooks/stripe", async ({ request, set }) => {
      const rawBody = new Uint8Array(await request.arrayBuffer());
      try {
        const result = await getBillingWebhookProcessor().processStripeWebhook({
          headers: request.headers,
          rawBody,
        });

        set.status = 202;
        return { data: result };
      } catch (error) {
        if (error instanceof BillingWebhookProcessingError) {
          set.status = error.statusCode;
          return { error: { code: error.code, message: error.message } };
        }

        throw error;
      }
    })
    .post("/webhooks/github", async ({ request, set }) => {
      const rawBody = new Uint8Array(await request.arrayBuffer());
      const telemetry = startWebhookDeliveryTelemetry(traces, request, "github", rawBody);
      try {
        const result = await getGithubWebhookHandler().handle({
          headers: request.headers,
          rawBody,
        });

        set.status = 202;
        finishWebhookDeliveryTelemetry(metrics, telemetry, {
          statusCode: 202,
          webhookStatus: result.status,
        });
        return result;
      } catch (error) {
        if (error instanceof WebhookAuthenticationError) {
          set.status = 401;
          tryRecordInvalidGitHubWebhookSignatureSecurityEvent(
            securityEventSink,
            request,
            telemetry,
          );
          finishWebhookDeliveryTelemetry(metrics, telemetry, {
            error,
            reason: "invalid_signature",
            statusCode: 401,
            webhookStatus: "rejected",
          });
          return { error: { code: "webhook.invalid_signature", message: error.message } };
        }

        if (error instanceof WebhookPayloadError) {
          set.status = 400;
          finishWebhookDeliveryTelemetry(metrics, telemetry, {
            error,
            reason: "invalid_payload",
            statusCode: 400,
            webhookStatus: "rejected",
          });
          return { error: { code: "webhook.invalid_payload", message: error.message } };
        }

        finishWebhookDeliveryTelemetry(metrics, telemetry, {
          error,
          reason: "unhandled_error",
          statusCode: 500,
          webhookStatus: "failed",
        });
        throw error;
      }
    });
}

/** Creates a product-safe API health response from individual checks. */
function createApiHealthResponse(checks: readonly ApiHealthCheck[]): ApiHealthResponse {
  const ok = checks.length > 0 && checks.every((check) => check.status === "pass");

  return {
    checks,
    ok,
    service: "api",
    status: ok ? "pass" : "fail",
    timestamp: new Date().toISOString(),
  };
}

/** Runs default API readiness checks against config and critical dependencies. */
async function checkApiReadiness(
  getDatabaseClient: () => DatabaseClient,
): Promise<readonly ApiHealthCheck[]> {
  const checks: ApiHealthCheck[] = [];

  try {
    loadRuntimeConfig();
    checks.push({ name: "config", status: "pass" });
  } catch {
    checks.push({
      message: "Runtime configuration is invalid.",
      name: "config",
      status: "fail",
    });
    return checks;
  }

  try {
    await getDatabaseClient().db.execute(sql`select 1`);
    checks.push({ name: "postgres", status: "pass" });
  } catch {
    checks.push({
      message: "Postgres is unavailable.",
      name: "postgres",
      status: "fail",
    });
  }

  return checks;
}

/** Creates the durable control-plane service backed by the database. */
function createAdminControlPlaneService(dependencies: {
  /** Database used to read settings and write audit logs. */
  readonly db: HeimdallDatabase;
  /** Optional artifact payload store used for review artifact reads. */
  readonly artifactPayloadStore?: ReviewArtifactPayloadStore;
  /** Lazy billing provider factory for provider-backed billing mutations. */
  readonly getBillingProvider?: BillingProviderFactory;
}): AdminControlPlaneService {
  const artifactPayloadStore =
    dependencies.artifactPayloadStore ?? new InlineReviewArtifactPayloadStore();

  return {
    createBillingCheckoutSession: (request) =>
      createBillingCheckoutSession(
        dependencies.db,
        requireBillingProvider(dependencies.getBillingProvider?.()),
        request,
      ),
    createBillingPortalSession: (request) =>
      createBillingPortalSession(
        dependencies.db,
        requireBillingProvider(dependencies.getBillingProvider?.()),
        request,
      ),
    approveMemoryCandidate: (memoryCandidateId, request) =>
      approveMemoryCandidate(dependencies.db, memoryCandidateId, request),
    createRepositoryMemoryFact: (repoId, request) =>
      createRepositoryMemoryFact(dependencies.db, repoId, request),
    createRepositoryRule: (repoId, request, audit) =>
      createRepositoryRule(dependencies.db, repoId, request, audit),
    deleteMemoryFact: (memoryFactId, request) =>
      deleteMemoryFact(dependencies.db, memoryFactId, request),
    deleteRepositoryRule: (repoId, ruleId, audit) =>
      deleteRepositoryRule(dependencies.db, repoId, ruleId, audit),
    enqueueBillingReconciliation: (query) => enqueueBillingReconciliation(dependencies.db, query),
    enqueueInstallationSync: (installationId, request) =>
      enqueueInstallationSync(dependencies.db, installationId, request),
    enqueueReviewRerun: (reviewRunId, request) =>
      enqueueReviewRerun(dependencies.db, reviewRunId, request),
    enqueueRepositoryReindex: (repoId, request) =>
      enqueueRepositoryReindex(dependencies.db, repoId, request),
    enqueueRepositorySync: (repoId, request) =>
      enqueueRepositorySync(dependencies.db, repoId, request),
    getBillingSummary: (query) => getBillingSummary(dependencies.db, query),
    getBillingReconciliation: (query) => getBillingReconciliation(dependencies.db, query),
    getEvaluationRun: (evalRunId) => getEvaluationRun(dependencies.db, evalRunId),
    getMemoryCandidate: (memoryCandidateId) =>
      getMemoryCandidate(dependencies.db, memoryCandidateId),
    getMemoryFact: (memoryFactId) => getMemoryFact(dependencies.db, memoryFactId),
    getOrganization: (orgId) => getOrganization(dependencies.db, orgId),
    getOrgSettings: (orgId) => getOrgSettings(dependencies.db, orgId),
    getProductUsageSummary: (query) => getProductUsageSummary(dependencies.db, query),
    getProviderInstallation: (installationId) =>
      getProviderInstallation(dependencies.db, installationId),
    getRepositorySettings: (repoId) => getRepositorySettings(dependencies.db, repoId),
    getReviewArtifactPayload: (reviewRunId, reviewArtifactId, request) =>
      getReviewArtifactPayload(
        dependencies.db,
        artifactPayloadStore,
        reviewRunId,
        reviewArtifactId,
        request,
      ),
    createReviewArtifactDownloadUrl: (reviewRunId, reviewArtifactId, request) =>
      createReviewArtifactDownloadUrl(
        dependencies.db,
        artifactPayloadStore,
        reviewRunId,
        reviewArtifactId,
        request,
      ),
    getReviewFinding: (findingId) => getReviewFinding(dependencies.db, findingId),
    getReviewMetricsSummary: (query) => getReviewMetricsSummary(dependencies.db, query),
    getReviewRun: (reviewRunId) => getReviewRun(dependencies.db, reviewRunId),
    getEntitlementSummary: (query) => getEntitlementSummary(dependencies.db, query),
    listFindingFeedbackEvents: (findingId) => listFindingFeedbackEvents(dependencies.db, findingId),
    listReviewArtifacts: (reviewRunId) => listReviewArtifacts(dependencies.db, reviewRunId),
    listBillingMeterEvents: (query) => listBillingMeterEvents(dependencies.db, query),
    listRepositoryMemoryCandidates: (repoId, query) =>
      listRepositoryMemoryCandidates(dependencies.db, repoId, query),
    listRepositoryMemoryFacts: (repoId, query) =>
      listRepositoryMemoryFacts(dependencies.db, repoId, query),
    listRepositorySuppressionMatches: (repoId, query) =>
      listRepositorySuppressionMatches(dependencies.db, repoId, query),
    listOrganizations: (query) => listOrganizations(dependencies.db, query),
    listProductUsageEvents: (query) => listProductUsageEvents(dependencies.db, query),
    listProviderInstallations: (query) => listProviderInstallations(dependencies.db, query),
    listRepositories: (query) => listRepositories(dependencies.db, query),
    listEvaluationRuns: (query) => listEvaluationRuns(dependencies.db, query),
    listEvaluationSuites: (query) => listEvaluationSuites(dependencies.db, query),
    listAuditLogs: (query) => listAuditLogs(dependencies.db, query),
    listSecurityEvents: (query) => listSecurityEvents(dependencies.db, query),
    listRepositoryRules: (repoId) => listRepositoryRules(dependencies.db, repoId),
    listReviewFindings: (reviewRunId, query) =>
      listReviewFindings(dependencies.db, reviewRunId, query),
    listReviewRuns: (query) => listReviewRuns(dependencies.db, query),
    listUsageSummary: (query) => listUsageSummary(dependencies.db, query),
    previewRepositoryPolicy: (repoId, patch) =>
      previewRepositoryPolicy(dependencies.db, repoId, patch),
    testRepositoryPolicy: (repoId, request) =>
      testRepositoryPolicy(dependencies.db, repoId, request),
    validateRepositoryConfigFile: (repoId, request) =>
      validateRepositoryConfigFile(dependencies.db, repoId, request),
    recordFindingOutcome: (findingId, request) =>
      recordFindingOutcome(dependencies.db, findingId, request),
    rejectMemoryCandidate: (memoryCandidateId, request) =>
      rejectMemoryCandidate(dependencies.db, memoryCandidateId, request),
    suppressSimilarFinding: (findingId, request) =>
      suppressSimilarFinding(dependencies.db, findingId, request),
    recordAuditEvent: (event) => insertAuditLog(dependencies.db, event),
    updateOrgSettings: (orgId, patch, audit) =>
      updateOrgSettings(dependencies.db, orgId, patch, audit),
    updateRepositoryRule: (repoId, ruleId, request, audit) =>
      updateRepositoryRule(dependencies.db, repoId, ruleId, request, audit),
    updateMemoryFact: (memoryFactId, request) =>
      updateMemoryFact(dependencies.db, memoryFactId, request),
    updateRepositorySettings: (repoId, patch, audit) =>
      updateRepositorySettings(dependencies.db, repoId, patch, audit),
  };
}

/** Creates the review artifact payload store configured for this API process. */
function createReviewArtifactPayloadStoreFromEnv(): ReviewArtifactPayloadStore {
  return createReviewArtifactPayloadStoreFromEnvironment(process.env);
}

/** Creates the product dashboard service backed by the database. */
function createProductDashboardService(dependencies: {
  /** Database used to read product setup and activity state. */
  readonly db: HeimdallDatabase;
}): ProductDashboardService {
  return {
    getOnboarding: () => getProductOnboarding(dependencies.db),
  };
}

/** Creates the DB-backed opaque product session service. */
function createProductSessionService(dependencies: {
  /** Database used to read and write product sessions. */
  readonly db: HeimdallDatabase;
  /** Resolved product session auth settings. */
  readonly auth: ResolvedProductSessionAuthOptions;
}): ProductSessionService {
  return {
    createSession: (request) => createProductSession(dependencies.db, dependencies.auth, request),
    readSession: (cookieHeader) =>
      readProductSession(dependencies.db, dependencies.auth, cookieHeader),
    revokeSession: (sessionId) => revokeProductSession(dependencies.db, sessionId),
    clearCookie: () => productSessionClearCookie(dependencies.auth),
  };
}

/** Creates the DB-backed GitHub OAuth product login service. */
function createProductGitHubOAuthService(dependencies: {
  /** Database used to persist OAuth state and product users. */
  readonly db: HeimdallDatabase;
  /** Resolved GitHub OAuth settings. */
  readonly auth: ResolvedProductGitHubOAuthOptions;
}): ProductGitHubOAuthService {
  return {
    start: (request) => startProductGitHubOAuth(dependencies.db, dependencies.auth, request),
    complete: (request) => completeProductGitHubOAuth(dependencies.db, dependencies.auth, request),
  };
}

/** Creates a GitHub OAuth state record and returns the authorization URL. */
async function startProductGitHubOAuth(
  db: HeimdallDatabase,
  auth: ResolvedProductGitHubOAuthOptions,
  request: ProductGitHubOAuthStartRequest,
): Promise<ProductGitHubOAuthStart> {
  const config = requireProductGitHubOAuthConfig(auth);
  const state = newProductOAuthState();
  const redirectTo = safeProductRedirectTo(request.redirectTo) ?? auth.defaultRedirectPath;
  const callbackUrl = productOAuthCallbackUrl(auth, request.requestUrl);
  const now = new Date();

  await db.insert(oauthStates).values({
    expiresAt: new Date(now.getTime() + auth.stateTtlMinutes * 60 * 1000),
    metadata: {
      provider: "github",
      requestId: request.requestId,
    },
    oauthStateId: newProductOAuthStateId(),
    redirectTo,
    stateHash: hashProductOAuthState(state),
  });

  const authorizationUrl = new URL(auth.authorizationUrl);
  authorizationUrl.searchParams.set("client_id", config.clientId);
  authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
  authorizationUrl.searchParams.set("scope", auth.scopes.join(" "));
  authorizationUrl.searchParams.set("state", state);

  return { authorizationUrl: authorizationUrl.toString() };
}

/** Completes GitHub OAuth login and upserts the corresponding product user. */
async function completeProductGitHubOAuth(
  db: HeimdallDatabase,
  auth: ResolvedProductGitHubOAuthOptions,
  request: ProductGitHubOAuthCallbackRequest,
): Promise<ProductGitHubOAuthCompletion> {
  requireProductGitHubOAuthConfig(auth);
  const callbackUrl = new URL(request.callbackUrl);
  const code = callbackUrl.searchParams.get("code");
  const state = callbackUrl.searchParams.get("state");
  if (!code || !state) {
    throw new ProductOAuthError(
      "github_oauth.callback_invalid",
      "GitHub OAuth callback requires code and state.",
      400,
    );
  }

  const redirectTo = await consumeProductOAuthState(db, state);
  const accessToken = await exchangeGitHubOAuthCode(
    auth,
    code,
    productOAuthCallbackUrl(auth, request.callbackUrl),
  );
  const profile = await fetchGitHubOAuthProfile(auth, accessToken);
  const userId = await upsertProductOAuthUser(db, profile, request.requestId);

  return {
    ...(profile.primaryEmail ? { primaryEmail: profile.primaryEmail } : {}),
    providerLogin: profile.providerLogin,
    providerUserId: profile.providerUserId,
    redirectTo,
    userId,
  };
}

/** Consumes an OAuth state record exactly once and returns its redirect path. */
async function consumeProductOAuthState(db: HeimdallDatabase, state: string): Promise<string> {
  const [row] = await db
    .update(oauthStates)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthStates.stateHash, hashProductOAuthState(state)),
        isNull(oauthStates.consumedAt),
        gt(oauthStates.expiresAt, new Date()),
      ),
    )
    .returning({
      redirectTo: oauthStates.redirectTo,
    });

  if (!row) {
    throw new ProductOAuthError(
      "github_oauth.state_invalid",
      "GitHub OAuth state is missing, expired, or already used.",
      400,
    );
  }

  return safeProductRedirectTo(row.redirectTo ?? undefined) ?? "/";
}

/** Minimal GitHub OAuth profile used to create product users. */
type ProductGitHubOAuthProfile = {
  /** Stable GitHub user ID. */
  readonly providerUserId: string;
  /** GitHub login. */
  readonly providerLogin: string;
  /** Primary email when known. */
  readonly primaryEmail?: string | undefined;
  /** Display name when known. */
  readonly displayName?: string | undefined;
  /** Avatar URL when known. */
  readonly avatarUrl?: string | undefined;
};

/** Exchanges a GitHub OAuth authorization code for an access token. */
async function exchangeGitHubOAuthCode(
  auth: ResolvedProductGitHubOAuthOptions,
  code: string,
  callbackUrl: string,
): Promise<string> {
  const config = requireProductGitHubOAuthConfig(auth);
  const response = await fetch(auth.tokenUrl, {
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: callbackUrl,
    }),
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  const body = await response.json().catch(() => undefined);
  const record = asRecord(body);
  const accessToken = stringField(record, "access_token");
  if (!response.ok || !accessToken) {
    throw new ProductOAuthError(
      "github_oauth.token_exchange_failed",
      "GitHub OAuth token exchange failed.",
      502,
    );
  }

  return accessToken;
}

/** Fetches the GitHub user profile and primary email for OAuth login. */
async function fetchGitHubOAuthProfile(
  auth: ResolvedProductGitHubOAuthOptions,
  accessToken: string,
): Promise<ProductGitHubOAuthProfile> {
  const user = await fetchGitHubOAuthJson(auth.userApiUrl, accessToken);
  const providerUserId = stringOrNumberField(user, "id");
  const providerLogin = stringField(user, "login");
  if (!providerUserId || !providerLogin) {
    throw new ProductOAuthError(
      "github_oauth.profile_invalid",
      "GitHub OAuth profile response did not include a user ID and login.",
      502,
    );
  }

  const email =
    stringField(user, "email") ?? (await fetchGitHubOAuthPrimaryEmail(auth, accessToken));
  const displayName = stringField(user, "name") ?? providerLogin;
  const avatarUrl = stringField(user, "avatar_url");

  return {
    ...(avatarUrl ? { avatarUrl } : {}),
    displayName,
    ...(email ? { primaryEmail: email } : {}),
    providerLogin,
    providerUserId,
  };
}

/** Fetches the primary verified GitHub email when available. */
async function fetchGitHubOAuthPrimaryEmail(
  auth: ResolvedProductGitHubOAuthOptions,
  accessToken: string,
): Promise<string | undefined> {
  const response = await fetch(auth.emailsApiUrl, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "heimdall/0.1.0",
    },
  });
  if (!response.ok) {
    return undefined;
  }

  const body = await response.json().catch(() => undefined);
  if (!Array.isArray(body)) {
    return undefined;
  }

  const emailRecord = body
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
    )
    .find((entry) => entry.primary === true && entry.verified === true);
  return emailRecord ? stringField(emailRecord, "email") : undefined;
}

/** Fetches one authenticated GitHub OAuth JSON endpoint. */
async function fetchGitHubOAuthJson(
  url: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "heimdall/0.1.0",
    },
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new ProductOAuthError(
      "github_oauth.profile_fetch_failed",
      "GitHub OAuth profile fetch failed.",
      502,
    );
  }

  return asRecord(body);
}

/** Upserts the product user and linked GitHub provider account. */
async function upsertProductOAuthUser(
  db: HeimdallDatabase,
  profile: ProductGitHubOAuthProfile,
  requestId: string,
): Promise<string> {
  const existingAccount = await getProductProviderAccount(db, "github", profile.providerUserId);
  const userId =
    existingAccount?.userId ?? stablePrefixedId("usr", ["github", profile.providerUserId]);
  const now = new Date();

  await db
    .insert(users)
    .values({
      ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
      metadata: {
        lastLoginProvider: "github",
        providerLogin: profile.providerLogin,
        requestId,
      },
      ...(profile.primaryEmail ? { primaryEmail: profile.primaryEmail } : {}),
      userId,
    })
    .onConflictDoUpdate({
      target: users.userId,
      set: {
        avatarUrl: profile.avatarUrl ?? null,
        displayName: profile.displayName ?? null,
        metadata: {
          lastLoginProvider: "github",
          providerLogin: profile.providerLogin,
          requestId,
        },
        primaryEmail: profile.primaryEmail ?? null,
        updatedAt: now,
      },
    });

  await db
    .insert(userProviderAccounts)
    .values({
      ...(profile.primaryEmail ? { email: profile.primaryEmail } : {}),
      metadata: {
        requestId,
      },
      provider: "github",
      providerLogin: profile.providerLogin,
      providerUserId: profile.providerUserId,
      userId,
      userProviderAccountId: stablePrefixedId("upacct", ["github", profile.providerUserId]),
    })
    .onConflictDoUpdate({
      target: [userProviderAccounts.provider, userProviderAccounts.providerUserId],
      set: {
        email: profile.primaryEmail ?? null,
        metadata: {
          requestId,
        },
        providerLogin: profile.providerLogin,
        updatedAt: now,
        userId,
      },
    });

  return userId;
}

/** Gets an existing product provider account by provider identity. */
async function getProductProviderAccount(
  db: HeimdallDatabase,
  provider: string,
  providerUserId: string,
): Promise<{ readonly userId: string } | undefined> {
  const [row] = await db
    .select({
      userId: userProviderAccounts.userId,
    })
    .from(userProviderAccounts)
    .where(
      and(
        eq(userProviderAccounts.provider, provider),
        eq(userProviderAccounts.providerUserId, providerUserId),
      ),
    )
    .limit(1);

  return row;
}

/** Requires usable GitHub OAuth configuration. */
function requireProductGitHubOAuthConfig(auth: ResolvedProductGitHubOAuthOptions): {
  /** GitHub OAuth client ID. */
  readonly clientId: string;
  /** GitHub OAuth client secret. */
  readonly clientSecret: string;
} {
  if (auth.configurationError || !auth.clientId || !auth.clientSecret) {
    throw new ProductOAuthError(
      "github_oauth.unconfigured",
      auth.configurationError ?? "GitHub OAuth is not configured.",
      503,
    );
  }

  return {
    clientId: auth.clientId,
    clientSecret: auth.clientSecret,
  };
}

/** Creates a new OAuth state row ID. */
function newProductOAuthStateId(): string {
  return `oauth_${randomUUID()}`;
}

/** Creates a new opaque OAuth state token. */
function newProductOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

/** Hashes an OAuth state token for durable lookup. */
function hashProductOAuthState(state: string): string {
  return createHash("sha256")
    .update("heimdall.product-oauth-state.v1")
    .update("\0")
    .update(state)
    .digest("hex");
}

/** Returns the callback URL used for GitHub OAuth requests. */
function productOAuthCallbackUrl(
  auth: ResolvedProductGitHubOAuthOptions,
  requestUrl: string,
): string {
  if (auth.callbackUrl) {
    return auth.callbackUrl;
  }

  return new URL("/api/v1/auth/github/callback", requestUrl).toString();
}

/** Creates one DB-backed product session and the cookie that references it. */
async function createProductSession(
  db: HeimdallDatabase,
  auth: ResolvedProductSessionAuthOptions,
  request: ProductSessionCreateRequest,
): Promise<ProductSessionCookieWrite> {
  const sessionPepper = requireProductSessionPepper(auth);
  const sessionId = newProductSessionId();
  const token = newProductSessionToken();
  const sessionHash = hashProductSessionToken(token, sessionPepper);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + productSessionCookieMaxAgeSeconds(auth) * 1000);

  await db.insert(userSessions).values({
    expiresAt,
    ...(request.metadata ? { metadata: request.metadata } : {}),
    sessionHash,
    sessionId,
    ...(request.selectedOrgId ? { selectedOrgId: request.selectedOrgId } : {}),
    userId: request.userId,
  });

  const session = await readProductSessionByHash(db, sessionHash, now);
  if (!session) {
    throw new Error("Created product session could not be reloaded.");
  }

  return {
    cookie: productSessionCookie(auth, token),
    session,
  };
}

/** Reads one DB-backed product session from an incoming Cookie header. */
async function readProductSession(
  db: HeimdallDatabase,
  auth: ResolvedProductSessionAuthOptions,
  cookieHeader: string | null,
): Promise<ProductSessionContext | undefined> {
  if (!auth.enabled || !auth.sessionPepper || auth.sessionPepper.length < 32) {
    return undefined;
  }

  const token = parseProductCookieHeader(cookieHeader)[auth.cookieName];
  if (!token) {
    return undefined;
  }

  return readProductSessionByHash(
    db,
    hashProductSessionToken(token, auth.sessionPepper),
    new Date(),
  );
}

/** Reads one active product session by its persisted token hash. */
async function readProductSessionByHash(
  db: HeimdallDatabase,
  sessionHash: string,
  now: Date,
): Promise<ProductSessionContext | undefined> {
  const [row] = await db
    .select({
      avatarUrl: users.avatarUrl,
      displayName: users.displayName,
      expiresAt: userSessions.expiresAt,
      primaryEmail: users.primaryEmail,
      selectedOrgId: userSessions.selectedOrgId,
      sessionId: userSessions.sessionId,
      userId: users.userId,
    })
    .from(userSessions)
    .innerJoin(users, eq(users.userId, userSessions.userId))
    .where(
      and(
        eq(userSessions.sessionHash, sessionHash),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, now),
      ),
    )
    .limit(1);

  if (!row) {
    return undefined;
  }

  const memberships = await listProductSessionMemberships(db, row.userId);
  const selectedOrgId = selectedOrgForMemberships(row.selectedOrgId ?? undefined, memberships);
  const actor: ProductActor = {
    memberships,
    ...(selectedOrgId ? { selectedOrgId } : {}),
    userId: row.userId,
  };

  return {
    actor,
    expiresAt: row.expiresAt.toISOString(),
    installations: await listProductSessionInstallations(
      db,
      memberships.map((membership) => membership.orgId),
    ),
    sessionId: row.sessionId,
    user: {
      ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
      ...(row.displayName ? { displayName: row.displayName } : {}),
      ...(row.primaryEmail ? { primaryEmail: row.primaryEmail } : {}),
      userId: row.userId,
    },
  };
}

/** Lists valid organization memberships for an authenticated product user. */
async function listProductSessionMemberships(
  db: HeimdallDatabase,
  userId: string,
): Promise<readonly ProductMembership[]> {
  const rows = await db
    .select({
      orgId: orgMemberships.orgId,
      role: orgMemberships.role,
    })
    .from(orgMemberships)
    .where(eq(orgMemberships.userId, userId))
    .orderBy(asc(orgMemberships.orgId));

  return rows.flatMap((row) =>
    isProductRole(row.role) ? [{ orgId: row.orgId, role: row.role }] : [],
  );
}

/** Lists provider installations visible through the user's organization memberships. */
async function listProductSessionInstallations(
  db: HeimdallDatabase,
  orgIds: readonly string[],
): Promise<readonly ProductSessionInstallationSummary[]> {
  const installations = await new ProviderInstallationRepository(
    db,
  ).listActiveProviderInstallationsForOrgs(orgIds);
  return installations.map(toProductSessionInstallationSummary);
}

/** Revokes one DB-backed product session. */
async function revokeProductSession(db: HeimdallDatabase, sessionId: string): Promise<void> {
  const now = new Date();
  await db
    .update(userSessions)
    .set({
      revokedAt: now,
      updatedAt: now,
    })
    .where(eq(userSessions.sessionId, sessionId));
}

/** Returns a Set-Cookie header that clears the product session cookie. */
function productSessionClearCookie(auth: ResolvedProductSessionAuthOptions): string {
  return serializeProductCookie(auth.cookieName, "", {
    httpOnly: true,
    maxAgeSeconds: 0,
    path: "/",
    sameSite: auth.cookieSameSite,
    secure: auth.secureCookies,
  });
}

/** Returns a Set-Cookie header for a new opaque product session token. */
function productSessionCookie(auth: ResolvedProductSessionAuthOptions, token: string): string {
  return serializeProductCookie(auth.cookieName, token, {
    httpOnly: true,
    maxAgeSeconds: productSessionCookieMaxAgeSeconds(auth),
    path: "/",
    sameSite: auth.cookieSameSite,
    secure: auth.secureCookies,
  });
}

/** Returns the product session lifetime in seconds. */
function productSessionCookieMaxAgeSeconds(auth: ResolvedProductSessionAuthOptions): number {
  return Math.max(1, auth.sessionTtlDays) * 24 * 60 * 60;
}

/** Returns a valid selected organization only when it is present in memberships. */
function selectedOrgForMemberships(
  selectedOrgId: string | undefined,
  memberships: readonly ProductMembership[],
): string | undefined {
  return selectedOrgId && memberships.some((membership) => membership.orgId === selectedOrgId)
    ? selectedOrgId
    : undefined;
}

/** Requires a configured product session pepper for session creation. */
function requireProductSessionPepper(auth: ResolvedProductSessionAuthOptions): string {
  if (!auth.sessionPepper || auth.sessionPepper.length < 32) {
    throw new Error(
      auth.configurationError ?? "Product session auth requires a configured session pepper.",
    );
  }

  return auth.sessionPepper;
}

/** Creates a new product session ID. */
function newProductSessionId(): string {
  return `sess_${randomUUID()}`;
}

/** Creates a new opaque product session token. */
function newProductSessionToken(): string {
  return `ps_${randomBytes(32).toString("base64url")}`;
}

/** Hashes an opaque product session token for durable lookup. */
function hashProductSessionToken(token: string, sessionPepper: string): string {
  return createHash("sha256")
    .update("heimdall.product-session.v1")
    .update("\0")
    .update(sessionPepper)
    .update("\0")
    .update(token)
    .digest("hex");
}

/** Cookie serialization options used by the product session cookie writer. */
type ProductCookieSerializationOptions = {
  /** Whether the cookie should be inaccessible to JavaScript. */
  readonly httpOnly: boolean;
  /** Maximum age in seconds. */
  readonly maxAgeSeconds: number;
  /** Cookie path. */
  readonly path: string;
  /** SameSite policy. */
  readonly sameSite: "Strict" | "Lax" | "None";
  /** Whether the cookie requires HTTPS. */
  readonly secure: boolean;
};

/** Serializes a product Set-Cookie header value. */
function serializeProductCookie(
  name: string,
  value: string,
  options: ProductCookieSerializationOptions,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAgeSeconds}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

/** Parses a Cookie header into a lookup map for product session reads. */
function parseProductCookieHeader(header: string | null): Record<string, string> {
  if (!header) {
    return {};
  }

  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex);
    const rawValue = trimmed.slice(separatorIndex + 1);
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      cookies[key] = rawValue;
    }
  }

  return cookies;
}

/** Loads the normal product onboarding state from deployment config and persisted GitHub data. */
async function getProductOnboarding(db: HeimdallDatabase): Promise<ProductOnboardingSummary> {
  const [installations, repositories, recentReviews, webhook] = await Promise.all([
    listProductInstallations(db),
    listProductRepositories(db),
    listProductReviewRuns(db),
    getProductWebhookSummary(db),
  ]);

  return {
    githubApp: productGitHubAppSetup(),
    installations,
    recentReviews,
    repositories,
    webhook,
  };
}

/** Builds GitHub App setup details from the current deployment environment. */
function productGitHubAppSetup(): ProductGitHubAppSetup {
  const appId = emptyToUndefined(process.env.GITHUB_APP_ID);
  const appSlug = emptyToUndefined(process.env.HEIMDALL_GITHUB_APP_SLUG);
  const explicitInstallUrl = emptyToUndefined(process.env.HEIMDALL_GITHUB_APP_INSTALL_URL);
  const installUrl =
    explicitInstallUrl ?? (appSlug ? `https://github.com/apps/${appSlug}/installations/new` : "");
  const webhookUrl = productWebhookUrl();
  const webhookConfigured = githubWebhookSecretConfigured(process.env);

  return {
    configured: Boolean(appId && webhookConfigured && installUrl),
    ...(appId ? { appId } : {}),
    ...(appSlug ? { appSlug } : {}),
    ...(installUrl ? { installUrl } : {}),
    webhookConfigured,
    ...(webhookUrl ? { webhookUrl } : {}),
  };
}

/** Returns the authenticated product API GitHub App installation URL payload. */
function githubInstallUrlResponse(): GitHubInstallUrlResponse {
  const setup = productGitHubAppSetup();
  if (!setup.installUrl) {
    throw new AdminControlPlaneConfigurationError(
      "github.install_url_unconfigured",
      "GitHub App installation URL is not configured.",
      503,
    );
  }

  return {
    ...(setup.appSlug ? { appSlug: setup.appSlug } : {}),
    configured: setup.configured,
    url: setup.installUrl,
    webhookConfigured: setup.webhookConfigured,
    ...(setup.webhookUrl ? { webhookUrl: setup.webhookUrl } : {}),
  };
}

/** Builds a safe dashboard redirect after GitHub App installation callbacks. */
function githubInstallCallbackRedirect(callbackUrl: URL): GitHubInstallCallbackRedirect {
  const installationId = githubInstallCallbackInstallationId(
    callbackUrl.searchParams.get("installation_id"),
  );
  const setupAction = githubInstallCallbackSetupAction(
    callbackUrl.searchParams.get("setup_action"),
  );
  const state = githubInstallCallbackState(callbackUrl.searchParams.get("state"));
  const redirectParams = new URLSearchParams({
    githubInstallation: "complete",
  });
  if (installationId) {
    redirectParams.set("installationId", installationId);
  }
  if (setupAction) {
    redirectParams.set("setupAction", setupAction);
  }
  if (state) {
    redirectParams.set("state", state);
  }

  return {
    ...(installationId ? { installationId } : {}),
    ...(setupAction ? { setupAction } : {}),
    ...(state ? { state } : {}),
    url: productDashboardUrl("/app/onboarding", redirectParams),
  };
}

/** Reads and validates a GitHub App installation ID query value. */
function githubInstallCallbackInstallationId(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!/^\d{1,32}$/u.test(value)) {
    throw new AdminRequestValidationError(
      "github.install_callback_invalid",
      "GitHub App installation callback installation_id is invalid.",
      400,
    );
  }

  return value;
}

/** Reads and validates a GitHub App installation setup action query value. */
function githubInstallCallbackSetupAction(
  value: string | null,
): GitHubInstallCallbackRedirect["setupAction"] {
  if (!value) {
    return undefined;
  }
  if (value === "install" || value === "update") {
    return value;
  }

  throw new AdminRequestValidationError(
    "github.install_callback_invalid",
    "GitHub App installation callback setup_action is invalid.",
    400,
  );
}

/** Reads and validates an opaque GitHub App installation callback state value. */
function githubInstallCallbackState(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._~=-]{1,512}$/u.test(value)) {
    throw new AdminRequestValidationError(
      "github.install_callback_invalid",
      "GitHub App installation callback state is invalid.",
      400,
    );
  }

  return value;
}

/** Builds a dashboard URL from WEB_URL when configured, otherwise returns a relative URL. */
function productDashboardUrl(pathname: string, query: URLSearchParams): string {
  const queryString = query.toString();
  const path = `${pathname}${queryString ? `?${queryString}` : ""}`;
  const baseUrl = emptyToUndefined(process.env.WEB_URL);
  if (!baseUrl) {
    return path;
  }

  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return path;
  }
}

/** Builds a dashboard redirect URL from a safe relative path. */
function productDashboardRedirectUrl(
  redirectTo: string,
  extraParams: URLSearchParams = new URLSearchParams(),
): string {
  const safeRedirect = safeProductRedirectTo(redirectTo) ?? "/";
  const parsed = new URL(safeRedirect, "https://heimdall.local");
  for (const [key, value] of extraParams) {
    parsed.searchParams.set(key, value);
  }

  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  const baseUrl = emptyToUndefined(process.env.WEB_URL);
  if (!baseUrl) {
    return path;
  }

  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return path;
  }
}

/** Returns a safe relative product redirect path. */
function safeProductRedirectTo(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed?.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed, "https://heimdall.local");
    if (parsed.origin !== "https://heimdall.local") {
      return undefined;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}

/** Returns the public GitHub webhook URL for the API deployment when configured. */
function productWebhookUrl(): string | undefined {
  const apiUrl = emptyToUndefined(process.env.HEIMDALL_API_PUBLIC_URL);
  const legacyApiUrl = emptyToUndefined(process.env.API_URL);
  const webUrl = emptyToUndefined(process.env.WEB_URL);
  const baseUrl = apiUrl ?? legacyApiUrl ?? webUrl;
  if (!baseUrl) {
    return undefined;
  }

  try {
    return new URL("/webhooks/github", baseUrl).toString();
  } catch {
    return undefined;
  }
}

/** Lists recent GitHub App installations for the product dashboard. */
async function listProductInstallations(
  db: HeimdallDatabase,
): Promise<readonly ProductInstallationSummary[]> {
  const installations = await new ProviderInstallationRepository(
    db,
  ).listRecentProviderInstallations({
    limit: 10,
  });
  return installations.map(toProductInstallationSummary);
}

/** Converts a provider installation into a product session DTO. */
function toProductSessionInstallationSummary(
  installation: ProviderInstallation,
): ProductSessionInstallationSummary {
  return {
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    installationId: installation.installationId,
    orgId: installation.orgId,
    provider: installation.provider,
    providerInstallationId: installation.providerInstallationId,
  };
}

/** Converts a provider installation into a product onboarding DTO. */
function toProductInstallationSummary(
  installation: ProviderInstallation,
): ProductInstallationSummary {
  return {
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    ...(installation.deletedAt ? { deletedAt: installation.deletedAt } : {}),
    installedAt: installation.installedAt,
    provider: installation.provider,
    ...(installation.suspendedAt ? { suspendedAt: installation.suspendedAt } : {}),
  };
}

/** Lists organizations visible to a scoped admin actor. */
async function listOrganizations(
  db: HeimdallDatabase,
  query: AdminOrganizationListQuery,
): Promise<readonly AdminOrganizationSummary[]> {
  const conditions = organizationListConditions(query);
  const rows = await db
    .select({
      createdAt: orgs.createdAt,
      installationCount: sql<number>`count(distinct ${providerInstallations.installationId})::int`,
      metadata: orgs.metadata,
      name: orgs.name,
      orgId: orgs.orgId,
      repositoryCount: sql<number>`count(distinct ${repositories.repoId})::int`,
      slug: orgs.slug,
      updatedAt: orgs.updatedAt,
    })
    .from(orgs)
    .leftJoin(providerInstallations, eq(providerInstallations.orgId, orgs.orgId))
    .leftJoin(repositories, eq(repositories.orgId, orgs.orgId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(orgs.orgId, orgs.name, orgs.slug, orgs.metadata, orgs.createdAt, orgs.updatedAt)
    .orderBy(asc(orgs.name), asc(orgs.slug))
    .limit(boundedListLimit(query.limit));

  return rows.map(toAdminOrganizationSummary);
}

/** Gets one organization by ID. */
async function getOrganization(
  db: HeimdallDatabase,
  orgId: string,
): Promise<AdminOrganizationSummary> {
  const [row] = await db
    .select({
      createdAt: orgs.createdAt,
      installationCount: sql<number>`count(distinct ${providerInstallations.installationId})::int`,
      metadata: orgs.metadata,
      name: orgs.name,
      orgId: orgs.orgId,
      repositoryCount: sql<number>`count(distinct ${repositories.repoId})::int`,
      slug: orgs.slug,
      updatedAt: orgs.updatedAt,
    })
    .from(orgs)
    .leftJoin(providerInstallations, eq(providerInstallations.orgId, orgs.orgId))
    .leftJoin(repositories, eq(repositories.orgId, orgs.orgId))
    .where(eq(orgs.orgId, orgId))
    .groupBy(orgs.orgId, orgs.name, orgs.slug, orgs.metadata, orgs.createdAt, orgs.updatedAt)
    .limit(1);

  if (!row) {
    throw new AdminControlPlaneNotFoundError("organization", orgId);
  }

  return toAdminOrganizationSummary(row);
}

/** Builds SQL predicates for organization discovery. */
function organizationListConditions(query: AdminOrganizationListQuery): SQL[] {
  const conditions: SQL[] = [];
  const orgIds = query.orgIds ?? [];
  if (query.orgIds !== undefined && !orgIds.includes("*")) {
    conditions.push(orgIds.length > 0 ? inArray(orgs.orgId, [...orgIds]) : sql`false`);
  }

  const search = query.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    const searchCondition = or(
      ilike(orgs.name, pattern),
      ilike(orgs.slug, pattern),
      ilike(orgs.orgId, pattern),
    );
    if (searchCondition) {
      conditions.push(searchCondition);
    }
  }

  return conditions;
}

/** Converts an organization row into a scoped API DTO. */
function toAdminOrganizationSummary(row: {
  /** Organization ID. */
  readonly orgId: string;
  /** Organization display name. */
  readonly name: string;
  /** Organization slug. */
  readonly slug: string;
  /** Organization metadata. */
  readonly metadata: unknown;
  /** Associated provider installation count. */
  readonly installationCount: number;
  /** Associated repository count. */
  readonly repositoryCount: number;
  /** Creation timestamp. */
  readonly createdAt: Date;
  /** Update timestamp. */
  readonly updatedAt: Date;
}): AdminOrganizationSummary {
  const metadata = asOptionalRecord(row.metadata);
  return {
    createdAt: row.createdAt.toISOString(),
    installationCount: row.installationCount,
    ...(metadata ? { metadata } : {}),
    name: row.name,
    orgId: row.orgId,
    repositoryCount: row.repositoryCount,
    slug: row.slug,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Lists provider installations visible to a scoped admin actor. */
async function listProviderInstallations(
  db: HeimdallDatabase,
  query: AdminInstallationListQuery,
): Promise<readonly AdminProviderInstallationSummary[]> {
  const scopedOrgIds = query.orgIds?.includes("*") ? undefined : query.orgIds;
  const installations = await new ProviderInstallationRepository(db).listProviderInstallations({
    limit: boundedListLimit(query.limit),
    ...(scopedOrgIds !== undefined ? { orgIds: scopedOrgIds } : {}),
    ...(query.provider !== undefined ? { provider: query.provider } : {}),
    ...(query.search !== undefined ? { search: query.search } : {}),
  });

  return installations.map(toAdminProviderInstallationSummary);
}

/** Gets one provider installation by internal ID. */
async function getProviderInstallation(
  db: HeimdallDatabase,
  installationId: string,
): Promise<AdminProviderInstallationSummary> {
  const installation = await new ProviderInstallationRepository(db).getProviderInstallation(
    installationId,
  );

  if (!installation) {
    throw new AdminControlPlaneNotFoundError("provider_installation", installationId);
  }

  return toAdminProviderInstallationSummary(installation);
}

/** Converts a provider installation row into a scoped API DTO. */
function toAdminProviderInstallationSummary(
  installation: ProviderInstallation,
): AdminProviderInstallationSummary {
  return {
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    ...(installation.deletedAt ? { deletedAt: installation.deletedAt } : {}),
    installationId: installation.installationId,
    installedAt: installation.installedAt,
    orgId: installation.orgId,
    permissions: installation.permissions,
    provider: installation.provider,
    providerInstallationId: installation.providerInstallationId,
    ...(installation.suspendedAt ? { suspendedAt: installation.suspendedAt } : {}),
  };
}

/** Enqueues a durable manual provider installation sync job and records an audit event. */
async function enqueueInstallationSync(
  db: HeimdallDatabase,
  installationId: string,
  request: AdminInstallationSyncRequest,
): Promise<AdminInstallationSyncRunSummary> {
  return db.transaction(async (tx) => {
    const transactionDb = tx as HeimdallDatabase;
    const installation = await getProviderInstallation(transactionDb, installationId);
    if (installation.provider !== "github") {
      throw new AdminRequestValidationError(
        "installation.unsupported_provider",
        "Only GitHub installation sync is supported.",
        400,
      );
    }

    const timestamp = new Date().toISOString();
    const jobKey = ["api", "installation", "sync", installationId, request.idempotencyKey].join(
      ":",
    );
    const payload: SyncInstallationJobPayload = {
      installationId,
      provider: "github",
      reason: "manual",
    };
    const envelope: JobEnvelope<SyncInstallationJobPayload> = {
      attempt: 0,
      createdAt: timestamp,
      idempotencyKey: jobKey,
      jobId: stablePrefixedId("job", ["installation_sync", jobKey]),
      jobType: JOB_TYPES.SyncInstallation,
      maxAttempts: 3,
      payload,
      schemaVersion: "sync_installation_job.v1",
      ...(request.traceContext ? { traceContext: request.traceContext } : {}),
    };

    const { job } = await new BackgroundJobRepository(transactionDb).insertBackgroundJob({
      backgroundJobId: stablePrefixedId("job", ["background_job", jobKey]),
      envelope,
      metadata: {
        requestId: request.requestId,
        source: "api_installation_sync",
      },
      orgId: installation.orgId,
      queueName: QUEUE_NAMES.repoSync,
    });
    const audit = await insertAuditLog(transactionDb, {
      actor: request.actor,
      action: "installation.sync.enqueued",
      metadata: {
        backgroundJobId: job.backgroundJobId,
        idempotencyKey: request.idempotencyKey,
        jobKey: job.jobKey,
        jobStatus: job.status,
        provider: installation.provider,
        providerInstallationId: installation.providerInstallationId,
      },
      orgId: installation.orgId,
      requestId: request.requestId,
      resourceId: installation.installationId,
      resourceType: "provider_installation",
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });

    return {
      auditLogId: audit.auditLogId,
      backgroundJobId: job.backgroundJobId,
      jobKey: job.jobKey,
      status: job.status,
    };
  });
}

/** Enqueues a durable manual repository sync job and records an audit event. */
async function enqueueRepositorySync(
  db: HeimdallDatabase,
  repoId: string,
  request: AdminRepositorySyncRequest,
): Promise<AdminRepositoryJobRunSummary> {
  return db.transaction(async (tx) => {
    const transactionDb = tx as HeimdallDatabase;
    const settings = await getRepositorySettings(transactionDb, repoId);
    if (settings.repository.provider !== "github") {
      throw new AdminRequestValidationError(
        "repo.unsupported_provider",
        "Only GitHub repository sync is supported.",
        400,
      );
    }

    const timestamp = new Date().toISOString();
    const jobKey = ["api", "repository", "sync", repoId, request.idempotencyKey].join(":");
    const payload: SyncInstallationJobPayload = {
      installationId: settings.repository.installationId,
      provider: "github",
      reason: "manual",
    };
    const envelope: JobEnvelope<SyncInstallationJobPayload> = {
      attempt: 0,
      createdAt: timestamp,
      idempotencyKey: jobKey,
      jobId: stablePrefixedId("job", ["repository_sync", jobKey]),
      jobType: JOB_TYPES.SyncInstallation,
      maxAttempts: 3,
      payload,
      schemaVersion: "sync_installation_job.v1",
      ...(request.traceContext ? { traceContext: request.traceContext } : {}),
    };

    const { job } = await new BackgroundJobRepository(transactionDb).insertBackgroundJob({
      backgroundJobId: stablePrefixedId("job", ["background_job", jobKey]),
      envelope,
      metadata: {
        providerRepoId: settings.repository.providerRepoId,
        requestId: request.requestId,
        source: "api_repository_sync",
        targetRepoId: repoId,
      },
      orgId: settings.repository.orgId,
      queueName: QUEUE_NAMES.repoSync,
      repoId,
    });
    const audit = await insertAuditLog(transactionDb, {
      actor: request.actor,
      action: "repo.sync.enqueued",
      metadata: {
        backgroundJobId: job.backgroundJobId,
        idempotencyKey: request.idempotencyKey,
        jobKey: job.jobKey,
        jobStatus: job.status,
        provider: settings.repository.provider,
        providerRepoId: settings.repository.providerRepoId,
      },
      orgId: settings.repository.orgId,
      requestId: request.requestId,
      resourceId: repoId,
      resourceType: "repository",
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });

    return {
      auditLogId: audit.auditLogId,
      backgroundJobId: job.backgroundJobId,
      jobKey: job.jobKey,
      status: job.status,
    };
  });
}

/** Enqueues a durable manual repository reindex job and records an audit event. */
async function enqueueRepositoryReindex(
  db: HeimdallDatabase,
  repoId: string,
  request: AdminRepositoryReindexRequest,
): Promise<AdminRepositoryJobRunSummary> {
  return db.transaction(async (tx) => {
    const transactionDb = tx as HeimdallDatabase;
    const settings = await getRepositorySettings(transactionDb, repoId);
    if (settings.repository.provider !== "github") {
      throw new AdminRequestValidationError(
        "repo.unsupported_provider",
        "Only GitHub repository reindex is supported.",
        400,
      );
    }

    const timestamp = new Date().toISOString();
    const jobKey = [
      "api",
      "repository",
      "reindex",
      repoId,
      request.commitSha,
      request.force ? request.requestId : request.idempotencyKey,
    ].join(":");
    const payload: IndexRepoCommitJobPayload = {
      commitSha: request.commitSha,
      installationId: settings.repository.installationId,
      priority: "normal",
      reason: "manual",
      repoId,
    };
    const envelope: JobEnvelope<IndexRepoCommitJobPayload> = {
      attempt: 0,
      createdAt: timestamp,
      idempotencyKey: jobKey,
      jobId: stablePrefixedId("job", ["repository_reindex", jobKey]),
      jobType: JOB_TYPES.IndexRepoCommit,
      maxAttempts: 3,
      payload,
      schemaVersion: "index_repo_commit_job.v1",
      ...(request.traceContext ? { traceContext: request.traceContext } : {}),
    };

    const { job } = await new BackgroundJobRepository(transactionDb).insertBackgroundJob({
      backgroundJobId: stablePrefixedId("job", ["background_job", jobKey]),
      envelope,
      metadata: {
        commitSha: request.commitSha,
        force: request.force ?? false,
        ...(request.reason ? { reason: request.reason } : {}),
        requestId: request.requestId,
        source: "api_repository_reindex",
      },
      orgId: settings.repository.orgId,
      queueName: QUEUE_NAMES.indexing,
      repoId,
    });
    const audit = await insertAuditLog(transactionDb, {
      actor: request.actor,
      action: "repo.reindex.enqueued",
      metadata: {
        backgroundJobId: job.backgroundJobId,
        commitSha: request.commitSha,
        force: request.force ?? false,
        idempotencyKey: request.idempotencyKey,
        jobKey: job.jobKey,
        jobStatus: job.status,
        ...(request.reason ? { reason: request.reason } : {}),
      },
      orgId: settings.repository.orgId,
      requestId: request.requestId,
      resourceId: repoId,
      resourceType: "repository",
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });

    return {
      auditLogId: audit.auditLogId,
      backgroundJobId: job.backgroundJobId,
      jobKey: job.jobKey,
      status: job.status,
    };
  });
}

/** Enqueues a durable review rerun job and records an audit event. */
async function enqueueReviewRerun(
  db: HeimdallDatabase,
  reviewRunId: string,
  request: AdminReviewRerunRequest,
): Promise<AdminReviewRerunRunSummary> {
  return db.transaction(async (tx) => {
    const transactionDb = tx as HeimdallDatabase;
    const reviewRun = await getReviewRun(transactionDb, reviewRunId);
    const settings = await getRepositorySettings(transactionDb, reviewRun.repoId);
    if (settings.repository.provider !== "github") {
      throw new AdminRequestValidationError(
        "review.unsupported_provider",
        "Only GitHub review reruns are supported.",
        400,
      );
    }

    const timestamp = new Date().toISOString();
    const jobKey = ["api", "review", "rerun", reviewRunId, request.idempotencyKey].join(":");
    const payload: ReviewPullRequestJobPayload = {
      baseSha: reviewRun.baseSha,
      headSha: reviewRun.headSha,
      installationId: settings.repository.installationId,
      pullRequestNumber: reviewRun.pullRequestNumber,
      repoId: reviewRun.repoId,
      trigger: "rerun",
    };
    const envelope: JobEnvelope<ReviewPullRequestJobPayload> = {
      attempt: 0,
      createdAt: timestamp,
      idempotencyKey: jobKey,
      jobId: stablePrefixedId("job", ["review_rerun", jobKey]),
      jobType: JOB_TYPES.ReviewPullRequest,
      maxAttempts: 3,
      payload,
      schemaVersion: "job_envelope.v1",
      ...(request.traceContext ? { traceContext: request.traceContext } : {}),
    };

    const { job } = await new BackgroundJobRepository(transactionDb).insertBackgroundJob({
      backgroundJobId: stablePrefixedId("job", ["background_job", jobKey]),
      envelope,
      metadata: {
        originalStatus: reviewRun.status,
        requestId: request.requestId,
        source: "api_review_rerun",
      },
      orgId: reviewRun.orgId,
      queueName: QUEUE_NAMES.review,
      repoId: reviewRun.repoId,
      reviewRunId,
    });
    const audit = await insertAuditLog(transactionDb, {
      actor: request.actor,
      action: "review.rerun.enqueued",
      metadata: {
        backgroundJobId: job.backgroundJobId,
        idempotencyKey: request.idempotencyKey,
        jobKey: job.jobKey,
        jobStatus: job.status,
        pullRequestNumber: reviewRun.pullRequestNumber,
        repoId: reviewRun.repoId,
      },
      orgId: reviewRun.orgId,
      requestId: request.requestId,
      resourceId: reviewRunId,
      resourceType: "review_run",
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });

    return {
      auditLogId: audit.auditLogId,
      backgroundJobId: job.backgroundJobId,
      jobKey: job.jobKey,
      sourceReviewRunId: reviewRunId,
      status: job.status,
    };
  });
}

/** Converts a durable job record into the common enqueue response shape. */
function toAdminBackgroundJobRunSummary(
  job: Pick<BackgroundJobRecord, "backgroundJobId" | "jobKey" | "status">,
): Omit<AdminRepositoryJobRunSummary, "auditLogId"> {
  return {
    backgroundJobId: job.backgroundJobId,
    jobKey: job.jobKey,
    status: job.status,
  };
}

/** Lists product-safe repository summaries without admin metadata. */
async function listProductRepositories(
  db: HeimdallDatabase,
): Promise<readonly ProductRepositorySummary[]> {
  const rows = await listRepositories(db, { limit: 12 });
  return rows.map((repository) => ({
    ...(repository.defaultBranch ? { defaultBranch: repository.defaultBranch } : {}),
    enabled: repository.enabled,
    fullName: repository.fullName,
    ...(repository.latestReviewStatus ? { latestReviewStatus: repository.latestReviewStatus } : {}),
    visibility: repository.visibility,
  }));
}

/** Lists product-safe review summaries without run IDs or commit SHAs. */
async function listProductReviewRuns(
  db: HeimdallDatabase,
): Promise<readonly ProductReviewSummary[]> {
  const rows = await listReviewRuns(db, { limit: 12 });
  return rows.map((review) => ({
    ...(review.authorLogin ? { authorLogin: review.authorLogin } : {}),
    counts: review.counts,
    pullRequestNumber: review.pullRequestNumber,
    ...(review.pullRequestTitle ? { pullRequestTitle: review.pullRequestTitle } : {}),
    repoFullName: review.repoFullName,
    status: review.status,
    updatedAt: review.updatedAt,
  }));
}

/** Summarizes persisted webhook activity for the product dashboard. */
async function getProductWebhookSummary(db: HeimdallDatabase): Promise<ProductWebhookSummary> {
  const summary = await new WebhookRepository(db).getWebhookActivitySummary();
  const latest = summary.latest;

  return {
    totalDeliveries: summary.totalDeliveries,
    ...(latest
      ? {
          ...(latest.action ? { latestAction: latest.action } : {}),
          latestDeliveryAt: latest.receivedAt.toISOString(),
          latestEventName: latest.eventName,
          latestStatus: latest.status,
        }
      : {}),
  };
}

/** Lists repositories with latest-review hints for the admin dashboard. */
async function listRepositories(
  db: HeimdallDatabase,
  query: AdminRepositoryListQuery,
): Promise<readonly AdminRepositorySummary[]> {
  const wildcardScope = query.orgIds?.includes("*") || query.repoIds?.includes("*");
  const rows = await new RepositoryRepository(db).listRepositories({
    limit: boundedListLimit(query.limit),
    ...(query.search !== undefined ? { search: query.search } : {}),
    ...(!wildcardScope && query.orgIds !== undefined ? { orgIds: query.orgIds } : {}),
    ...(!wildcardScope && query.repoIds !== undefined ? { repoIds: query.repoIds } : {}),
  });
  const latestReviews = await Promise.all(
    rows.map((repository) => latestReviewForRepository(db, repository.repoId)),
  );

  return rows.map((repository, index) => {
    const latestReview = latestReviews[index];
    return {
      ...toAdminRepositorySummary(repository),
      ...(latestReview
        ? {
            latestReviewRunId: latestReview.reviewRunId,
            latestReviewStatus: latestReview.status,
            latestReviewUpdatedAt: latestReview.updatedAt.toISOString(),
          }
        : {}),
    };
  });
}

/** Gets the latest review row for one repository. */
async function latestReviewForRepository(
  db: HeimdallDatabase,
  repoId: string,
): Promise<
  | {
      /** Review run ID. */
      readonly reviewRunId: string;
      /** Current review status. */
      readonly status: string;
      /** Last update timestamp. */
      readonly updatedAt: Date;
    }
  | undefined
> {
  const [row] = await db
    .select({
      reviewRunId: reviewRuns.reviewRunId,
      status: reviewRuns.status,
      updatedAt: reviewRuns.updatedAt,
    })
    .from(reviewRuns)
    .where(eq(reviewRuns.repoId, repoId))
    .orderBy(desc(reviewRuns.updatedAt))
    .limit(1);

  return row;
}

/** Converts a repository row into a dashboard repository summary. */
function toAdminRepositorySummary(repository: Repository): AdminRepositorySummary {
  return {
    repoId: repository.repoId,
    orgId: repository.orgId,
    installationId: repository.installationId,
    provider: repository.provider,
    providerRepoId: repository.providerRepoId,
    owner: repository.owner,
    name: repository.name,
    fullName: repository.fullName,
    ...(repository.defaultBranch ? { defaultBranch: repository.defaultBranch } : {}),
    ...(repository.cloneUrl ? { cloneUrl: repository.cloneUrl } : {}),
    visibility: repository.visibility,
    isArchived: repository.isArchived,
    isFork: repository.isFork,
    enabled: repository.enabled,
    createdAt: repository.createdAt,
    updatedAt: repository.updatedAt,
    ...(repository.metadata ? { metadata: repository.metadata } : {}),
  };
}

/** Lists recent review runs with repository and pull-request context. */
async function listReviewRuns(
  db: HeimdallDatabase,
  query: AdminReviewRunListQuery,
): Promise<readonly AdminReviewRunSummary[]> {
  const conditions = reviewRunListConditions(query);
  const rows = await db
    .select({
      authorLogin: pullRequestSnapshots.authorLogin,
      baseSha: reviewRuns.baseSha,
      changedFileCount: pullRequestSnapshots.changedFileCount,
      completedAt: reviewRuns.completedAt,
      counts: reviewRuns.counts,
      createdAt: reviewRuns.createdAt,
      error: reviewRuns.error,
      headSha: reviewRuns.headSha,
      orgId: repositories.orgId,
      pullRequestNumber: reviewRuns.pullRequestNumber,
      pullRequestTitle: pullRequestSnapshots.title,
      repoFullName: repositories.fullName,
      repoId: reviewRuns.repoId,
      reviewRunId: reviewRuns.reviewRunId,
      startedAt: reviewRuns.startedAt,
      status: reviewRuns.status,
      summary: reviewRuns.summary,
      trigger: reviewRuns.trigger,
      updatedAt: reviewRuns.updatedAt,
    })
    .from(reviewRuns)
    .innerJoin(repositories, eq(reviewRuns.repoId, repositories.repoId))
    .leftJoin(
      pullRequestSnapshots,
      eq(reviewRuns.pullRequestSnapshotId, pullRequestSnapshots.snapshotId),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(reviewRuns.updatedAt))
    .limit(boundedListLimit(query.limit));

  return rows.map(toAdminReviewRunSummary);
}

/** Gets dashboard review rollups for the same scope as review history discovery. */
async function getReviewMetricsSummary(
  db: HeimdallDatabase,
  query: AdminReviewRunListQuery,
): Promise<AdminReviewMetricsSummary> {
  const conditions = reviewRunListConditions(query);
  const [row] = await db
    .select({
      candidateFindings: sql<number>`coalesce(sum(${reviewRunMetrics.candidateFindings}), 0)::int`,
      completedRuns: sql<number>`count(*) filter (where ${reviewRuns.status} = 'completed')::int`,
      estimatedCostUsd: sql<string>`coalesce(sum(${reviewRunMetrics.estimatedCostUsd}), 0)::text`,
      failedRuns: sql<number>`count(*) filter (where ${reviewRuns.status} = 'failed')::int`,
      medianDurationMs: sql<number | null>`round(
        percentile_cont(0.5) within group (order by ${reviewRunMetrics.totalDurationMs})
        filter (where ${reviewRunMetrics.totalDurationMs} is not null)
      )::int`,
      p95DurationMs: sql<number | null>`round(
        percentile_cont(0.95) within group (order by ${reviewRunMetrics.totalDurationMs})
        filter (where ${reviewRunMetrics.totalDurationMs} is not null)
      )::int`,
      publishedFindings: sql<number>`coalesce(sum(${reviewRunMetrics.publishedFindings}), 0)::int`,
      rejectedFindings: sql<number>`coalesce(sum(${reviewRunMetrics.rejectedFindings}), 0)::int`,
      skippedRuns: sql<number>`count(*) filter (where ${reviewRuns.status} = 'skipped')::int`,
      supersededRuns: sql<number>`count(*) filter (where ${reviewRuns.status} = 'superseded')::int`,
      totalRuns: sql<number>`count(*)::int`,
      validatedFindings: sql<number>`coalesce(sum(${reviewRunMetrics.validatedFindings}), 0)::int`,
    })
    .from(reviewRuns)
    .innerJoin(repositories, eq(reviewRuns.repoId, repositories.repoId))
    .leftJoin(reviewRunMetrics, eq(reviewRuns.reviewRunId, reviewRunMetrics.reviewRunId))
    .leftJoin(
      pullRequestSnapshots,
      eq(reviewRuns.pullRequestSnapshotId, pullRequestSnapshots.snapshotId),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .limit(1);
  const metrics = row ?? {
    candidateFindings: 0,
    completedRuns: 0,
    estimatedCostUsd: "0",
    failedRuns: 0,
    medianDurationMs: null,
    p95DurationMs: null,
    publishedFindings: 0,
    rejectedFindings: 0,
    skippedRuns: 0,
    supersededRuns: 0,
    totalRuns: 0,
    validatedFindings: 0,
  };

  return {
    averagePublishedFindings:
      metrics.totalRuns > 0
        ? roundToTwoDecimalPlaces(metrics.publishedFindings / metrics.totalRuns)
        : 0,
    candidateFindings: metrics.candidateFindings,
    completedRuns: metrics.completedRuns,
    estimatedCostUsd: metrics.estimatedCostUsd,
    failedRuns: metrics.failedRuns,
    generatedAt: new Date().toISOString(),
    ...(metrics.medianDurationMs !== null ? { medianDurationMs: metrics.medianDurationMs } : {}),
    ...(metrics.p95DurationMs !== null ? { p95DurationMs: metrics.p95DurationMs } : {}),
    publishedFindings: metrics.publishedFindings,
    rejectedFindings: metrics.rejectedFindings,
    skippedRuns: metrics.skippedRuns,
    supersededRuns: metrics.supersededRuns,
    totalRuns: metrics.totalRuns,
    validatedFindings: metrics.validatedFindings,
  };
}

/** Lists persisted evaluation suites with latest run and active baseline hints. */
async function listEvaluationSuites(
  db: HeimdallDatabase,
  query: AdminEvaluationSuiteListQuery,
): Promise<readonly EvaluationSuiteSummary[]> {
  const repository = new EvaluationRepository(db);
  const suites = await repository.listEvalSuites({ limit: boundedListLimit(query.limit) });
  return await Promise.all(
    suites.map(async (suite) => {
      const [latestRuns, activeBaseline] = await Promise.all([
        repository.listEvalRunsForSuite({ evalSuiteId: suite.evalSuiteId, limit: 1 }),
        repository.getActiveEvalBaseline(suite.evalSuiteId),
      ]);

      return toEvaluationSuiteSummary(suite, latestRuns[0], activeBaseline);
    }),
  );
}

/** Lists persisted evaluation runs for one suite. */
async function listEvaluationRuns(
  db: HeimdallDatabase,
  query: AdminEvaluationRunListQuery,
): Promise<readonly EvaluationRunSummary[]> {
  const repository = new EvaluationRepository(db);
  const runs = await repository.listEvalRunsForSuite({
    evalSuiteId: query.evalSuiteId,
    limit: boundedListLimit(query.limit),
  });

  return runs.map(toEvaluationRunSummary);
}

/** Gets one persisted evaluation run with per-case result rows. */
async function getEvaluationRun(
  db: HeimdallDatabase,
  evalRunId: string,
): Promise<AdminEvaluationRunDetails> {
  const repository = new EvaluationRepository(db);
  const [run, caseResults] = await Promise.all([
    repository.getEvalRun(evalRunId),
    repository.listEvalCaseResults(evalRunId),
  ]);
  if (!run) {
    throw new AdminControlPlaneNotFoundError("eval_run", evalRunId);
  }

  return {
    caseResults: caseResults.map(toEvaluationCaseResultSummary),
    run: toEvaluationRunSummary(run),
  };
}

/** Converts an evaluation suite row into an API summary. */
function toEvaluationSuiteSummary(
  suite: EvalSuiteRow,
  latestRun: EvalRunRow | undefined,
  activeBaseline: EvalBaselineRow | undefined,
): EvaluationSuiteSummary {
  return {
    ...(activeBaseline ? { activeBaseline: toEvaluationBaselineSummary(activeBaseline) } : {}),
    createdAt: suite.createdAt.toISOString(),
    defaultGraders: suite.defaultGraders,
    defaultRunner: suite.defaultRunner,
    description: suite.description,
    evalSuiteId: suite.evalSuiteId,
    ...(latestRun ? { latestRun: toEvaluationRunSummary(latestRun) } : {}),
    name: suite.name,
    owner: suite.owner,
    tags: suite.tags,
    thresholds: suite.thresholds,
    updatedAt: suite.updatedAt.toISOString(),
    version: suite.version,
  };
}

/** Converts an evaluation baseline row into an API summary. */
function toEvaluationBaselineSummary(row: EvalBaselineRow): EvaluationBaselineSummary {
  return {
    active: row.active,
    baselineVariantId: row.baselineVariantId,
    createdAt: row.createdAt.toISOString(),
    ...(row.evalRunId ? { evalRunId: row.evalRunId } : {}),
    evalSuiteId: row.evalSuiteId,
  };
}

/** Converts an evaluation run row into an API summary. */
function toEvaluationRunSummary(row: EvalRunRow): EvaluationRunSummary {
  return {
    ...(row.baselineVariantId ? { baselineVariantId: row.baselineVariantId } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    caseCount: row.caseCount,
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
    environment: row.environment,
    ...(row.error ? { error: row.error } : {}),
    evalRunId: row.evalRunId,
    evalSuiteId: row.evalSuiteId,
    evalVariantId: row.evalVariantId,
    ...(row.gitCommitSha ? { gitCommitSha: row.gitCommitSha } : {}),
    ...(row.reportUri ? { reportUri: row.reportUri } : {}),
    startedAt: row.startedAt.toISOString(),
    status: row.status,
    ...(row.summary ? { summary: row.summary } : {}),
    triggeredBy: row.triggeredBy,
  };
}

/** Converts an evaluation case result row into an API summary. */
function toEvaluationCaseResultSummary(row: EvalCaseResultRow): EvaluationCaseResultSummary {
  return {
    artifacts: row.artifacts,
    costs: row.costs,
    createdAt: row.createdAt.toISOString(),
    ...(row.error ? { error: row.error } : {}),
    evalCaseId: row.evalCaseId,
    evalCaseResultId: row.evalCaseResultId,
    evalRunId: row.evalRunId,
    matchedFindings: row.matchedFindings,
    scores: row.scores,
    status: row.status,
    timings: row.timings,
    unmatchedExpectedFindings: row.unmatchedExpectedFindings,
    unmatchedGeneratedFindings: row.unmatchedGeneratedFindings,
  };
}

/** Gets one review run with repository and pull-request context. */
async function getReviewRun(
  db: HeimdallDatabase,
  reviewRunId: string,
): Promise<AdminReviewRunSummary> {
  const [row] = await db
    .select({
      authorLogin: pullRequestSnapshots.authorLogin,
      baseSha: reviewRuns.baseSha,
      changedFileCount: pullRequestSnapshots.changedFileCount,
      completedAt: reviewRuns.completedAt,
      counts: reviewRuns.counts,
      createdAt: reviewRuns.createdAt,
      error: reviewRuns.error,
      headSha: reviewRuns.headSha,
      orgId: repositories.orgId,
      pullRequestNumber: reviewRuns.pullRequestNumber,
      pullRequestTitle: pullRequestSnapshots.title,
      repoFullName: repositories.fullName,
      repoId: reviewRuns.repoId,
      reviewRunId: reviewRuns.reviewRunId,
      startedAt: reviewRuns.startedAt,
      status: reviewRuns.status,
      summary: reviewRuns.summary,
      trigger: reviewRuns.trigger,
      updatedAt: reviewRuns.updatedAt,
    })
    .from(reviewRuns)
    .innerJoin(repositories, eq(reviewRuns.repoId, repositories.repoId))
    .leftJoin(
      pullRequestSnapshots,
      eq(reviewRuns.pullRequestSnapshotId, pullRequestSnapshots.snapshotId),
    )
    .where(eq(reviewRuns.reviewRunId, reviewRunId))
    .limit(1);

  if (!row) {
    throw new AdminControlPlaneNotFoundError("review_run", reviewRunId);
  }

  const reviewRun = toAdminReviewRunSummary(row);
  const relatedJobs = await listReviewRunBackgroundJobs(db, reviewRunId);
  return {
    ...reviewRun,
    relatedJobs,
  };
}

/** Lists product-safe durable jobs tied to one review run. */
async function listReviewRunBackgroundJobs(
  db: HeimdallDatabase,
  reviewRunId: string,
): Promise<readonly AdminBackgroundJobSummary[]> {
  const rows = await new BackgroundJobRepository(db).listBackgroundJobsForReviewRun(reviewRunId);

  return rows.map(toAdminBackgroundJobSummary);
}

/** Converts one durable job row into a product-safe summary. */
function toAdminBackgroundJobSummary(row: {
  /** Current durable attempt count. */
  readonly attempts: number;
  /** Durable background job row ID. */
  readonly backgroundJobId: string;
  /** Completion timestamp. */
  readonly completedAt?: Date | undefined;
  /** Creation timestamp. */
  readonly createdAt: Date;
  /** Durable job error payload. */
  readonly error?: unknown;
  /** Durable idempotency key. */
  readonly jobKey: string;
  /** Durable job type. */
  readonly jobType: string;
  /** Maximum durable attempt count. */
  readonly maxAttempts: number;
  /** Organization ID. */
  readonly orgId?: string | undefined;
  /** Queue name. */
  readonly queueName: string;
  /** Repository ID. */
  readonly repoId?: string | undefined;
  /** Review run ID. */
  readonly reviewRunId?: string | undefined;
  /** Schedule timestamp. */
  readonly scheduledAt?: Date | undefined;
  /** Start timestamp. */
  readonly startedAt?: Date | undefined;
  /** Durable job status. */
  readonly status: string;
  /** Update timestamp. */
  readonly updatedAt: Date;
}): AdminBackgroundJobSummary {
  const failure =
    row.status === "failed" || row.status === "dead_lettered"
      ? backgroundJobFailureFromUnknown(row)
      : undefined;

  return {
    attempts: row.attempts,
    backgroundJobId: row.backgroundJobId,
    createdAt: row.createdAt.toISOString(),
    jobKey: row.jobKey,
    jobType: row.jobType,
    maxAttempts: row.maxAttempts,
    queueName: row.queueName,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
    ...(failure ? { failure } : {}),
    ...(row.orgId ? { orgId: row.orgId } : {}),
    ...(row.repoId ? { repoId: row.repoId } : {}),
    ...(row.reviewRunId ? { reviewRunId: row.reviewRunId } : {}),
    ...(row.scheduledAt ? { scheduledAt: row.scheduledAt.toISOString() } : {}),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
  };
}

/** Review artifact row shape used for audited payload access. */
type ReviewArtifactAccessRow = {
  /** Artifact classification label. */
  readonly classification: string;
  /** Artifact creation timestamp. */
  readonly createdAt: Date;
  /** Artifact content hash. */
  readonly hash: string;
  /** Artifact kind. */
  readonly kind: string;
  /** Artifact metadata JSON. */
  readonly metadata: unknown;
  /** Artifact display name. */
  readonly name: string;
  /** Organization that owns the artifact repository. */
  readonly orgId: string;
  /** Repository that owns the artifact. */
  readonly repoId: string;
  /** Artifact retention expiration when set. */
  readonly retentionUntil: Date | null;
  /** Artifact row ID. */
  readonly reviewArtifactId: string;
  /** Review run that produced the artifact. */
  readonly reviewRunId: string;
  /** Serialized artifact size in bytes. */
  readonly sizeBytes: number;
  /** Durable artifact URI. */
  readonly uri: string;
};

/** Lists review artifact metadata without returning stored artifact payloads. */
async function listReviewArtifacts(
  db: HeimdallDatabase,
  reviewRunId: string,
): Promise<readonly AdminReviewArtifactSummary[]> {
  const rows = await db
    .select({
      classification: reviewArtifacts.classification,
      createdAt: reviewArtifacts.createdAt,
      hash: reviewArtifacts.hash,
      kind: reviewArtifacts.kind,
      metadata: reviewArtifacts.metadata,
      name: reviewArtifacts.name,
      repoId: reviewArtifacts.repoId,
      retentionUntil: reviewArtifacts.retentionUntil,
      reviewArtifactId: reviewArtifacts.reviewArtifactId,
      reviewRunId: reviewArtifacts.reviewRunId,
      sizeBytes: reviewArtifacts.sizeBytes,
      uri: reviewArtifacts.uri,
    })
    .from(reviewArtifacts)
    .where(eq(reviewArtifacts.reviewRunId, reviewRunId))
    .orderBy(asc(reviewArtifacts.createdAt), asc(reviewArtifacts.reviewArtifactId));

  return rows.map(toAdminReviewArtifactSummary);
}

/** Reads one stored review artifact payload and records an artifact access event. */
async function getReviewArtifactPayload(
  db: HeimdallDatabase,
  artifactPayloadStore: ReviewArtifactPayloadStore,
  reviewRunId: string,
  reviewArtifactId: string,
  request: AdminReviewArtifactPayloadRequest,
): Promise<AdminReviewArtifactPayloadSummary> {
  const row = await getReviewArtifactAccessRow(db, reviewRunId, reviewArtifactId);
  const storedPayload = await artifactPayloadStore.getJson({
    metadata: row.metadata,
    uri: row.uri,
  });
  if (!storedPayload.exists) {
    throw new AdminControlPlaneNotFoundError("review_artifact_payload", reviewArtifactId);
  }

  const artifact = toAdminReviewArtifactSummary(row);
  const artifactAccessEventId = await recordReviewArtifactAccessEvent(db, {
    artifact,
    orgId: row.orgId,
    repoId: row.repoId,
    request,
    reviewRunId: row.reviewRunId,
  });

  return {
    accessLevel: request.accessLevel,
    artifact,
    artifactAccessEventId,
    payload:
      request.accessLevel === "raw_allowed"
        ? storedPayload.payload
        : redactReviewArtifactPayload(row.kind, storedPayload.payload),
  };
}

/** Creates one audited short-lived raw artifact download URL. */
async function createReviewArtifactDownloadUrl(
  db: HeimdallDatabase,
  artifactPayloadStore: ReviewArtifactPayloadStore,
  reviewRunId: string,
  reviewArtifactId: string,
  request: AdminReviewArtifactPayloadRequest,
): Promise<AdminReviewArtifactDownloadUrlSummary> {
  if (request.accessLevel !== "raw_allowed") {
    throw new AdminRequestValidationError(
      "artifact.raw_download_required",
      "Direct artifact download URLs require raw artifact access.",
      400,
    );
  }
  if (!artifactPayloadStore.createSignedGetUrl) {
    throw new AdminRequestValidationError(
      "artifact.signed_url_unavailable",
      "The configured review artifact store does not support signed download URLs.",
      409,
    );
  }

  const row = await getReviewArtifactAccessRow(db, reviewRunId, reviewArtifactId);
  const artifact = toAdminReviewArtifactSummary(row);
  const signedUrl = await artifactPayloadStore.createSignedGetUrl({
    expiresInSeconds: DEFAULT_REVIEW_ARTIFACT_SIGNED_URL_EXPIRES_SECONDS,
    metadata: row.metadata,
    responseContentDisposition: `attachment; filename="${artifactDownloadFilename(artifact)}"`,
    responseContentType: "application/json; charset=utf-8",
    uri: row.uri,
  });
  if (!signedUrl.exists) {
    throw new AdminControlPlaneNotFoundError("review_artifact_payload", reviewArtifactId);
  }

  const artifactAccessEventId = await recordReviewArtifactAccessEvent(db, {
    artifact,
    orgId: row.orgId,
    repoId: row.repoId,
    request,
    reviewRunId: row.reviewRunId,
  });

  return {
    accessLevel: request.accessLevel,
    artifact,
    artifactAccessEventId,
    expiresAt: signedUrl.expiresAt.toISOString(),
    url: signedUrl.url,
  };
}

/** Reads one review artifact row and validates retention before payload access. */
async function getReviewArtifactAccessRow(
  db: HeimdallDatabase,
  reviewRunId: string,
  reviewArtifactId: string,
): Promise<ReviewArtifactAccessRow> {
  const [row] = await db
    .select({
      classification: reviewArtifacts.classification,
      createdAt: reviewArtifacts.createdAt,
      hash: reviewArtifacts.hash,
      kind: reviewArtifacts.kind,
      metadata: reviewArtifacts.metadata,
      name: reviewArtifacts.name,
      orgId: repositories.orgId,
      repoId: reviewArtifacts.repoId,
      retentionUntil: reviewArtifacts.retentionUntil,
      reviewArtifactId: reviewArtifacts.reviewArtifactId,
      reviewRunId: reviewArtifacts.reviewRunId,
      sizeBytes: reviewArtifacts.sizeBytes,
      uri: reviewArtifacts.uri,
    })
    .from(reviewArtifacts)
    .innerJoin(repositories, eq(reviewArtifacts.repoId, repositories.repoId))
    .where(
      and(
        eq(reviewArtifacts.reviewRunId, reviewRunId),
        eq(reviewArtifacts.reviewArtifactId, reviewArtifactId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new AdminControlPlaneNotFoundError("review_artifact", reviewArtifactId);
  }

  if (row.retentionUntil && row.retentionUntil.getTime() <= Date.now()) {
    throw new AdminRequestValidationError(
      "artifact.retention_expired",
      "Review artifact retention has expired.",
      410,
    );
  }

  return row;
}

/** Records one sensitive review artifact access event. */
async function recordReviewArtifactAccessEvent(
  db: HeimdallDatabase,
  input: {
    /** Artifact summary stored on the event. */
    readonly artifact: AdminReviewArtifactSummary;
    /** Organization that owns the artifact repository. */
    readonly orgId: string;
    /** Repository that owns the artifact. */
    readonly repoId: string;
    /** Review run that produced the artifact. */
    readonly reviewRunId: string;
    /** Caller request metadata and access level. */
    readonly request: AdminReviewArtifactPayloadRequest;
  },
): Promise<string> {
  const artifactAccessEventId = `artaccess_${randomUUID()}`;
  await db.insert(artifactAccessEvents).values({
    accessLevel: input.request.accessLevel,
    actorType: input.request.actor.actorType,
    actorUserId: input.request.actor.actorUserId,
    artifactAccessEventId,
    artifactRef: artifactAccessRef(input.artifact),
    ipAddress: input.request.ipAddress,
    orgId: input.orgId,
    reason: input.request.reason,
    repoId: input.repoId,
    reviewRunId: input.reviewRunId,
    supportSessionId: input.request.supportSessionId,
    userAgent: input.request.userAgent,
  });

  return artifactAccessEventId;
}

/** Returns the payload with sensitive code, prompt, and provider fields replaced. */
function redactReviewArtifactPayload(kind: string, payload: unknown): unknown {
  const redactedPayload = redactDebugBundleValue(payload);
  if (artifactPayloadCanExposeRootPrimitive(kind, payload)) {
    return redactedPayload;
  }

  const redactedWrapper = asOptionalRecord(redactDebugBundleValue({ payload }));
  return redactedWrapper?.payload ?? redactedPayload;
}

/** Returns whether an artifact payload can be redacted by walking its value. */
function artifactPayloadCanExposeRootPrimitive(kind: string, payload: unknown): boolean {
  if (Array.isArray(payload)) {
    return false;
  }

  if (typeof payload === "object" && payload !== null) {
    return true;
  }

  return kind === "policy_snapshot" || kind === "plan_snapshot" || kind === "orchestrator_trace";
}

/** Builds a payload-free artifact reference for artifact access events. */
function artifactAccessRef(artifact: AdminReviewArtifactSummary): Record<string, unknown> {
  return {
    classification: artifact.classification,
    hash: artifact.hash,
    kind: artifact.kind,
    name: artifact.name,
    ...(artifact.redactionLevel ? { redactionLevel: artifact.redactionLevel } : {}),
    reviewArtifactId: artifact.reviewArtifactId,
    reviewRunId: artifact.reviewRunId,
    sizeBytes: artifact.sizeBytes,
    uri: artifact.uri,
  };
}

/** Returns a safe JSON filename for artifact downloads. */
function artifactDownloadFilename(artifact: AdminReviewArtifactSummary): string {
  const rawName = artifact.name || `${artifact.kind}-${artifact.reviewArtifactId}.json`;
  const baseName = rawName
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  const filename = baseName || `${artifact.kind}-${artifact.reviewArtifactId}`;

  return filename.endsWith(".json") ? filename : `${filename}.json`;
}

/** Converts one review artifact row into a payload-free API DTO. */
function toAdminReviewArtifactSummary(row: {
  /** Artifact classification label. */
  readonly classification: string;
  /** Artifact creation timestamp. */
  readonly createdAt: Date;
  /** Artifact content hash. */
  readonly hash: string;
  /** Artifact kind. */
  readonly kind: string;
  /** Artifact metadata JSON. */
  readonly metadata: unknown;
  /** Artifact display name. */
  readonly name: string;
  /** Repository that owns the artifact. */
  readonly repoId: string;
  /** Retention expiration timestamp when configured. */
  readonly retentionUntil: Date | null;
  /** Artifact row ID. */
  readonly reviewArtifactId: string;
  /** Review run that owns the artifact. */
  readonly reviewRunId: string;
  /** Artifact byte size. */
  readonly sizeBytes: number;
  /** Artifact storage URI. */
  readonly uri: string;
}): AdminReviewArtifactSummary {
  const metadata = asOptionalRecord(row.metadata);
  const redactionLevel =
    metadata && typeof metadata.redactionLevel === "string" ? metadata.redactionLevel : undefined;
  const staticAnalysis = staticAnalysisArtifactSummaryFromMetadata(metadata);

  return {
    classification: row.classification,
    createdAt: row.createdAt.toISOString(),
    hash: row.hash,
    hasStoredPayload: hasReviewArtifactPayloadStorage(metadata),
    kind: row.kind,
    metadataKeys: metadata ? Object.keys(metadata).sort() : [],
    name: row.name,
    ...(redactionLevel ? { redactionLevel } : {}),
    repoId: row.repoId,
    ...(row.retentionUntil ? { retentionUntil: row.retentionUntil.toISOString() } : {}),
    reviewArtifactId: row.reviewArtifactId,
    reviewRunId: row.reviewRunId,
    sizeBytes: row.sizeBytes,
    ...(staticAnalysis ? { staticAnalysis } : {}),
    uri: row.uri,
  };
}

/** Reads payload-free static-analysis counters from review artifact metadata. */
function staticAnalysisArtifactSummaryFromMetadata(
  metadata: Record<string, unknown> | undefined,
): AdminStaticAnalysisArtifactSummary | undefined {
  const summary = asOptionalRecord(metadata?.staticAnalysis);
  if (!summary) {
    return undefined;
  }

  const reportId = stringFromUnknownRecord(summary, "reportId");
  const mode = stringFromUnknownRecord(summary, "mode");
  const status = stringFromUnknownRecord(summary, "status");
  if (!reportId || !mode || !status) {
    return undefined;
  }

  return {
    changedLineDiagnosticCount: numberFromRecord(summary, "changedLineDiagnosticCount"),
    diagnosticCount: numberFromRecord(summary, "diagnosticCount"),
    durationMs: numberFromRecord(summary, "durationMs"),
    failedToolRunCount: numberFromRecord(summary, "failedToolRunCount"),
    highSeverityDiagnosticCount: numberFromRecord(summary, "highSeverityDiagnosticCount"),
    mode,
    newDiagnosticCount: numberFromRecord(summary, "newDiagnosticCount"),
    reportId,
    status,
    succeededToolRunCount: numberFromRecord(summary, "succeededToolRunCount"),
    timedOutToolRunCount: numberFromRecord(summary, "timedOutToolRunCount"),
    toolRunCount: numberFromRecord(summary, "toolRunCount"),
    warningCount: numberFromRecord(summary, "warningCount"),
  };
}

/** Lists validated findings for one review run with publication and outcome state. */
async function listReviewFindings(
  db: HeimdallDatabase,
  reviewRunId: string,
  query: AdminReviewFindingListQuery,
): Promise<readonly AdminReviewFindingSummary[]> {
  const rows = await new ReviewRepository(db).listReviewFindings({
    decision: query.decision,
    limit: boundedListLimit(query.limit),
    reviewRunId,
    severity: query.severity,
  });

  const outcomes = await latestFindingOutcomesForRows(db, rows);
  return rows.map((row) => toAdminReviewFindingSummary(row, outcomes));
}

/** Gets one finding by validated, candidate, or published finding ID. */
async function getReviewFinding(
  db: HeimdallDatabase,
  findingId: string,
): Promise<AdminReviewFindingSummary> {
  const row = await new ReviewRepository(db).getReviewFindingByAnyId(findingId);

  if (!row) {
    throw new AdminControlPlaneNotFoundError("finding", findingId);
  }

  const outcomes = await latestFindingOutcomesForRows(db, [row]);
  return toAdminReviewFindingSummary(row, outcomes);
}

/** Lists normalized feedback events and classified signals for one finding. */
async function listFindingFeedbackEvents(
  db: HeimdallDatabase,
  findingId: string,
): Promise<readonly AdminReviewFindingFeedbackEventSummary[]> {
  const finding = await getReviewFinding(db, findingId);
  if (!finding.publishedFindingId) {
    return [];
  }

  const rows = await new FeedbackRepository(db).listFeedbackTimelineForPublishedFinding(
    finding.publishedFindingId,
  );

  return feedbackTimelineFromRows(rows);
}

/** Loads latest outcome rows for a set of finding rows. */
async function latestFindingOutcomesForRows(
  db: HeimdallDatabase,
  findings: readonly AdminReviewFindingRow[],
): Promise<AdminReviewFindingOutcomeLookup> {
  const candidateFindingIds = uniqueStrings(findings.map((finding) => finding.candidateFindingId));
  const publishedFindingIds = uniqueStrings(
    findings.flatMap((finding) => (finding.publishedFindingId ? [finding.publishedFindingId] : [])),
  );
  const rows = await new ReviewRepository(db).listFindingOutcomesForFindings({
    candidateFindingIds,
    publishedFindingIds,
  });

  const byCandidateFindingId = new Map<string, AdminReviewFindingOutcomeSummary>();
  const byPublishedFindingId = new Map<string, AdminReviewFindingOutcomeSummary>();
  for (const row of rows) {
    const outcome = toAdminReviewFindingOutcomeSummary(row);
    if (row.candidateFindingId && !byCandidateFindingId.has(row.candidateFindingId)) {
      byCandidateFindingId.set(row.candidateFindingId, outcome);
    }
    if (row.publishedFindingId && !byPublishedFindingId.has(row.publishedFindingId)) {
      byPublishedFindingId.set(row.publishedFindingId, outcome);
    }
  }

  return { byCandidateFindingId, byPublishedFindingId };
}

/** Converts a joined finding row into an API DTO. */
function toAdminReviewFindingSummary(
  row: AdminReviewFindingRow,
  outcomes: AdminReviewFindingOutcomeLookup,
): AdminReviewFindingSummary {
  const metadata = asOptionalRecord(row.metadata);
  const publicationMetadata = asOptionalRecord(row.publicationMetadata);
  const candidateOutcome = outcomes.byCandidateFindingId.get(row.candidateFindingId);
  const publishedOutcome = row.publishedFindingId
    ? outcomes.byPublishedFindingId.get(row.publishedFindingId)
    : undefined;
  const latestOutcome = latestFindingOutcome(candidateOutcome, publishedOutcome);

  return {
    body: row.body,
    candidateFindingId: row.candidateFindingId,
    category: row.category,
    confidence: row.confidence,
    decision: row.decision,
    evidence: row.evidence,
    findingId: row.findingId,
    fingerprint: row.fingerprint,
    ...(latestOutcome ? { latestOutcome } : {}),
    location: row.location,
    ...(metadata ? { metadata } : {}),
    orgId: row.orgId,
    ...(row.publishedFindingId &&
    row.publicationProvider &&
    row.publicationStatus &&
    row.publishedAt
      ? {
          publication: {
            ...(row.publicationError ? { error: row.publicationError } : {}),
            ...(publicationMetadata ? { metadata: publicationMetadata } : {}),
            ...(row.providerCheckRunId ? { providerCheckRunId: row.providerCheckRunId } : {}),
            ...(row.providerCommentId ? { providerCommentId: row.providerCommentId } : {}),
            ...(row.providerReviewId ? { providerReviewId: row.providerReviewId } : {}),
            provider: row.publicationProvider,
            publishedAt: row.publishedAt.toISOString(),
            publishedFindingId: row.publishedFindingId,
            status: row.publicationStatus,
          },
          publishedFindingId: row.publishedFindingId,
        }
      : {}),
    ...(row.rank !== null ? { rank: row.rank } : {}),
    repoFullName: row.repoFullName,
    repoId: row.repoId,
    reviewRunId: row.reviewRunId,
    severity: row.severity,
    title: row.title,
    validation: row.validation,
  };
}

/** Converts a finding outcome row into an API DTO. */
function toAdminReviewFindingOutcomeSummary(
  row: FindingOutcomeRecord,
): AdminReviewFindingOutcomeSummary {
  const metadata = asOptionalRecord(row.metadata);
  return {
    createdAt: row.createdAt.toISOString(),
    findingOutcomeId: row.findingOutcomeId,
    ...(metadata ? { metadata } : {}),
    occurredAt: row.occurredAt.toISOString(),
    outcome: row.outcome,
    source: row.source,
  };
}

/** Returns the most recent outcome from candidate and publication outcome rows. */
function latestFindingOutcome(
  candidateOutcome: AdminReviewFindingOutcomeSummary | undefined,
  publishedOutcome: AdminReviewFindingOutcomeSummary | undefined,
): AdminReviewFindingOutcomeSummary | undefined {
  if (!candidateOutcome) {
    return publishedOutcome;
  }
  if (!publishedOutcome) {
    return candidateOutcome;
  }

  return candidateOutcome.occurredAt >= publishedOutcome.occurredAt
    ? candidateOutcome
    : publishedOutcome;
}

/** Groups joined feedback event and signal rows into timeline DTOs. */
function feedbackTimelineFromRows(
  rows: readonly AdminReviewFindingFeedbackTimelineRow[],
): readonly AdminReviewFindingFeedbackEventSummary[] {
  const events = new Map<string, AdminReviewFindingFeedbackEventSummary>();
  for (const row of rows) {
    const existing = events.get(row.feedbackEventId);
    const event =
      existing ??
      ({
        ...(row.actorLogin ? { actorLogin: row.actorLogin } : {}),
        eventKind: row.eventKind,
        ...(row.externalCommentId ? { externalCommentId: row.externalCommentId } : {}),
        ...(row.externalEventId ? { externalEventId: row.externalEventId } : {}),
        feedbackEventId: row.feedbackEventId,
        ...(asOptionalRecord(row.payloadRedacted)
          ? { payloadRedacted: asOptionalRecord(row.payloadRedacted) }
          : {}),
        provider: row.provider,
        ...(row.pullRequestNumber ? { pullRequestNumber: row.pullRequestNumber } : {}),
        receivedAt: row.receivedAt.toISOString(),
        signals: [],
        source: row.source,
      } satisfies AdminReviewFindingFeedbackEventSummary);

    if (!existing) {
      events.set(row.feedbackEventId, event);
    }
    if (row.feedbackSignalId && row.signalKind && row.polarity && row.reason) {
      const signal = {
        confidence: row.signalConfidence ?? 0,
        createdAt: (row.signalCreatedAt ?? row.receivedAt).toISOString(),
        feedbackSignalId: row.feedbackSignalId,
        polarity: row.polarity,
        reason: row.reason,
        signalKind: row.signalKind,
        strength: row.strength ?? 0,
      } satisfies AdminReviewFindingFeedbackSignalSummary;
      events.set(row.feedbackEventId, {
        ...event,
        signals: [...event.signals, signal],
      });
    }
  }

  return [...events.values()];
}

/** Records one idempotent finding outcome and audits the user action. */
async function recordFindingOutcome(
  db: HeimdallDatabase,
  findingId: string,
  request: AdminFindingOutcomeRecordRequest,
): Promise<AdminFindingOutcomeRecordSummary> {
  return db.transaction(async (tx) => {
    const transactionDb = tx as HeimdallDatabase;
    const finding = await getReviewFinding(transactionDb, findingId);
    const findingOutcomeId = stablePrefixedId("out", [
      "finding_outcome",
      finding.findingId,
      request.idempotencyKey,
    ]);
    const metadata = {
      ...(request.metadata ?? {}),
      ...(request.notes ? { notes: request.notes } : {}),
      actorUserId: request.actor.actorUserId,
      requestId: request.requestId,
    };

    const outcome = toAdminReviewFindingOutcomeSummary(
      await new ReviewRepository(transactionDb).createFindingOutcomeIfAbsent({
        candidateFindingId: finding.candidateFindingId,
        createdAt: new Date(),
        findingOutcomeId,
        metadata,
        occurredAt: new Date(request.occurredAt),
        orgId: finding.orgId,
        outcome: request.outcome,
        publishedFindingId: finding.publishedFindingId ?? null,
        repoId: finding.repoId,
        source: request.source,
      }),
    );
    const memoryUpdateJob = await enqueueFindingOutcomeMemoryUpdate(
      transactionDb,
      finding,
      outcome,
      request,
    );
    const audit = await insertAuditLog(transactionDb, {
      actor: request.actor,
      action: "finding.outcome.recorded",
      metadata: {
        findingOutcomeId: outcome.findingOutcomeId,
        idempotencyKey: request.idempotencyKey,
        memoryUpdateBackgroundJobId: memoryUpdateJob.backgroundJobId,
        memoryUpdateJobKey: memoryUpdateJob.jobKey,
        memoryUpdateJobStatus: memoryUpdateJob.status,
        outcome: request.outcome,
        repoId: finding.repoId,
        source: request.source,
      },
      orgId: finding.orgId,
      requestId: request.requestId,
      resourceId: finding.findingId,
      resourceType: "finding",
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });

    return {
      auditLogId: audit.auditLogId,
      finding: {
        ...finding,
        latestOutcome: outcome,
      },
      outcome,
    };
  });
}

/** Creates or reuses an audited suppression rule seeded by one finding. */
async function suppressSimilarFinding(
  db: HeimdallDatabase,
  findingId: string,
  request: AdminFindingSuppressionRequest,
): Promise<AdminFindingSuppressionSummary> {
  return db.transaction(async (tx) => {
    const transactionDb = tx as HeimdallDatabase;
    const finding = await getReviewFinding(transactionDb, findingId);
    const targetRepoId = request.scope === "repo" ? finding.repoId : undefined;
    const ruleId = stablePrefixedId("rule", [
      "finding_suppression",
      request.scope,
      finding.findingId,
      request.idempotencyKey,
    ]);
    const ruleRepository = new RepoRuleRepository(transactionDb);
    const existingRule = await ruleRepository.getRule(ruleId);
    const rule =
      existingRule ??
      (await ruleRepository.createRule({
        ...createdByUserIdFromAuditActor(request.actor),
        effect: "suppress",
        enabled: true,
        instruction: suppressionInstruction(finding, request),
        matcher: suppressionMatcherFromFinding(finding),
        metadata: suppressionRuleMetadata(finding, request),
        name: suppressionRuleName(finding),
        orgId: finding.orgId,
        priority: 100,
        ...(targetRepoId ? { repoId: targetRepoId } : {}),
        ruleId,
      }));
    const summary = repoRuleSummaryFromRule(rule);
    const audit = await insertAuditLog(transactionDb, {
      actor: request.actor,
      action: "finding.suppression.created",
      metadata: {
        expiresAt: request.expiresAt,
        findingId: finding.findingId,
        idempotencyKey: request.idempotencyKey,
        reason: request.reason,
        repoId: finding.repoId,
        rule: summary,
        scope: request.scope,
      },
      orgId: finding.orgId,
      requestId: request.requestId,
      resourceId: finding.findingId,
      resourceType: "finding",
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });

    return {
      auditLogId: audit.auditLogId,
      finding,
      rule: summary,
      scope: request.scope,
    };
  });
}

/** Builds a narrow suppression matcher from a finding title and optional location path. */
function suppressionMatcherFromFinding(finding: AdminReviewFindingSummary): RepoRule["matcher"] {
  const path = pathFromFindingLocation(finding.location);
  return {
    ...(path ? { paths: [path] } : {}),
    titleRegex: `^${escapeRegExp(finding.title)}$`,
  };
}

/** Builds suppression rule metadata for audit and future policy compiler decisions. */
function suppressionRuleMetadata(
  finding: AdminReviewFindingSummary,
  request: AdminFindingSuppressionRequest,
): Record<string, unknown> {
  return {
    action: "suppress_similar_finding",
    category: finding.category,
    ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    findingFingerprint: finding.fingerprint,
    findingId: finding.findingId,
    reason: request.reason,
    reviewRunId: finding.reviewRunId,
    scope: request.scope,
    severity: finding.severity,
  };
}

/** Builds a human-readable instruction for suppression rules. */
function suppressionInstruction(
  finding: AdminReviewFindingSummary,
  request: AdminFindingSuppressionRequest,
): string {
  const path = pathFromFindingLocation(finding.location);
  const location = path ? ` in ${path}` : "";
  return `Suppress findings with the same title${location}. Reason: ${request.reason}`;
}

/** Builds a bounded rule name from one finding title. */
function suppressionRuleName(finding: AdminReviewFindingSummary): string {
  return truncateText(`Suppress similar: ${finding.title}`, 200);
}

/** Reads a repository-relative path from a finding location object when present. */
function pathFromFindingLocation(location: unknown): string | undefined {
  return stringField(asRecord(location), "path");
}

/** Escapes one string for use as a literal regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

/** Truncates text to a maximum length with a compact suffix. */
function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

/** Enqueues memory candidate processing for one recorded finding outcome. */
async function enqueueFindingOutcomeMemoryUpdate(
  db: HeimdallDatabase,
  finding: AdminReviewFindingSummary,
  outcome: AdminReviewFindingOutcomeSummary,
  request: AdminFindingOutcomeRecordRequest,
): Promise<Omit<AdminRepositoryJobRunSummary, "auditLogId">> {
  const timestamp = new Date().toISOString();
  const jobKey = ["api", "memory", "finding_outcome", finding.findingId, outcome.findingOutcomeId]
    .filter((part) => part.length > 0)
    .join(":");
  const payload: UpdateMemoryJobPayload = {
    findingId: finding.findingId,
    outcomeId: outcome.findingOutcomeId,
    reason: "finding_outcome",
    repoId: finding.repoId,
  };
  const envelope: JobEnvelope<UpdateMemoryJobPayload> = {
    attempt: 0,
    createdAt: timestamp,
    idempotencyKey: jobKey,
    jobId: stablePrefixedId("job", ["memory_update", jobKey]),
    jobType: JOB_TYPES.UpdateMemory,
    maxAttempts: 3,
    payload,
    schemaVersion: "job_envelope.v1",
    ...(request.traceContext ? { traceContext: request.traceContext } : {}),
  };

  const { job } = await new BackgroundJobRepository(db).insertBackgroundJob({
    backgroundJobId: stablePrefixedId("job", ["background_job", jobKey]),
    envelope,
    metadata: {
      outcome: outcome.outcome,
      outcomeId: outcome.findingOutcomeId,
      requestId: request.requestId,
      source: "finding_outcome",
    },
    orgId: finding.orgId,
    queueName: QUEUE_NAMES.memory,
    repoId: finding.repoId,
    reviewRunId: finding.reviewRunId,
  });

  return toAdminBackgroundJobRunSummary(job);
}

/** Lists memory facts that apply to one repository. */
async function listRepositoryMemoryFacts(
  db: HeimdallDatabase,
  repoId: string,
  query: AdminMemoryFactListQuery,
): Promise<readonly AdminMemoryFactSummary[]> {
  const settings = await getRepositorySettings(db, repoId);
  const rows = await new MemoryFactRepository(db).listRepositoryMemoryFacts({
    factType: query.kind,
    includeOrgFacts: query.includeOrgFacts,
    limit: boundedListLimit(query.limit),
    orgId: settings.repository.orgId,
    repoId,
    status: query.status,
  });

  return rows.map(toAdminMemoryFactSummary);
}

/** Lists memory candidates that apply to one repository. */
async function listRepositoryMemoryCandidates(
  db: HeimdallDatabase,
  repoId: string,
  query: AdminMemoryCandidateListQuery,
): Promise<readonly AdminMemoryCandidateSummary[]> {
  const settings = await getRepositorySettings(db, repoId);
  const rows = await new MemoryCandidateRepository(db).listRepositoryMemoryCandidates({
    candidateKind: query.candidateKind,
    includeOrgCandidates: query.includeOrgCandidates,
    limit: boundedListLimit(query.limit),
    orgId: settings.repository.orgId,
    repoId,
    status: query.status,
  });

  return rows.map(toAdminMemoryCandidateSummary);
}

/** Lists recent memory suppression matches for one repository. */
async function listRepositorySuppressionMatches(
  db: HeimdallDatabase,
  repoId: string,
  query: AdminSuppressionMatchListQuery,
): Promise<readonly AdminSuppressionMatchSummary[]> {
  const rows = await new ReviewRepository(db).listRepositorySuppressionMatches({
    limit: boundedListLimit(query.limit),
    repoId,
  });

  return rows.map(toAdminSuppressionMatchSummary);
}

/** Gets one memory fact row by ID. */
async function getMemoryFact(
  db: HeimdallDatabase,
  memoryFactId: string,
): Promise<AdminMemoryFactSummary> {
  return toAdminMemoryFactSummary(await getMemoryFactRow(db, memoryFactId));
}

/** Gets one memory candidate by ID. */
async function getMemoryCandidate(
  db: HeimdallDatabase,
  memoryCandidateId: string,
): Promise<AdminMemoryCandidateSummary> {
  return toAdminMemoryCandidateSummary(await getMemoryCandidateRow(db, memoryCandidateId));
}

/** Creates one repository-scoped memory fact and records an audit event. */
async function createRepositoryMemoryFact(
  db: HeimdallDatabase,
  repoId: string,
  request: AdminMemoryFactCreateRequest,
): Promise<AdminMemoryFactSummary> {
  return db.transaction(async (tx) => {
    const transactionDb = tx as HeimdallDatabase;
    const settings = await getRepositorySettings(transactionDb, repoId);
    const memoryFactId = stablePrefixedId("mem", ["memory_fact", repoId, request.idempotencyKey]);
    const metadata = memoryFactMetadata({
      actorUserId: request.actor.actorUserId,
      idempotencyKey: request.idempotencyKey,
      inputMetadata: request.metadata,
      requestId: request.requestId,
      source: request.source,
      subject: request.subject ?? defaultMemorySubject(request.text),
    });
    const row = await new MemoryFactRepository(transactionDb).createMemoryFactIfAbsent({
      body: request.text,
      confidence: request.confidence,
      expiresAt: request.expiresAt ? new Date(request.expiresAt) : null,
      factType: request.kind,
      memoryFactId,
      metadata,
      orgId: settings.repository.orgId,
      repoId,
      status: request.enabled ? "active" : "disabled",
    });
    const summary = toAdminMemoryFactSummary(row);
    await insertAuditLog(transactionDb, {
      actor: request.actor,
      action: "memory.created",
      metadata: {
        idempotencyKey: request.idempotencyKey,
        kind: summary.kind,
        repoId,
        status: summary.status,
      },
      orgId: summary.orgId,
      requestId: request.requestId,
      resourceId: summary.memoryFactId,
      resourceType: "memory_fact",
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });

    return summary;
  });
}

/** Approves one memory candidate into a durable memory fact and records an audit event. */
async function approveMemoryCandidate(
  db: HeimdallDatabase,
  memoryCandidateId: string,
  request: AdminMemoryCandidateModerationRequest,
): Promise<AdminMemoryCandidateApprovalSummary> {
  return db.transaction(async (tx) => {
    const transactionDb = tx as HeimdallDatabase;
    const current = await getMemoryCandidateRow(transactionDb, memoryCandidateId);
    if (current.status === "rejected") {
      throw new AdminRequestValidationError(
        "memory_candidate.already_rejected",
        "Rejected memory candidates cannot be approved.",
        409,
      );
    }

    const memoryFact = await createOrGetMemoryFactFromCandidate(transactionDb, current, request);
    const alreadyApproved =
      current.status === "approved" && current.approvedMemoryFactId === memoryFact.memoryFactId;
    const candidate = alreadyApproved
      ? toAdminMemoryCandidateSummary(current)
      : await markMemoryCandidateApproved(transactionDb, current, memoryFact.memoryFactId, request);
    const audit = await insertAuditLog(transactionDb, {
      actor: request.actor,
      action: "memory_candidate.approved",
      metadata: {
        alreadyApproved,
        candidateKind: candidate.candidateKind,
        idempotencyKey: request.idempotencyKey,
        memoryFactId: memoryFact.memoryFactId,
        ...(request.reason ? { reason: request.reason } : {}),
        ...(candidate.repoId ? { repoId: candidate.repoId } : {}),
        status: candidate.status,
      },
      orgId: candidate.orgId,
      requestId: request.requestId,
      resourceId: candidate.memoryCandidateId,
      resourceType: "memory_candidate",
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });

    return {
      auditLogId: audit.auditLogId,
      candidate,
      memoryFact,
    };
  });
}

/** Rejects one memory candidate and records an audit event. */
async function rejectMemoryCandidate(
  db: HeimdallDatabase,
  memoryCandidateId: string,
  request: AdminMemoryCandidateModerationRequest,
): Promise<AdminMemoryCandidateRejectionSummary> {
  return db.transaction(async (tx) => {
    const transactionDb = tx as HeimdallDatabase;
    const current = await getMemoryCandidateRow(transactionDb, memoryCandidateId);
    if (current.status === "approved") {
      throw new AdminRequestValidationError(
        "memory_candidate.already_approved",
        "Approved memory candidates cannot be rejected.",
        409,
      );
    }

    const alreadyRejected = current.status === "rejected";
    const candidate = alreadyRejected
      ? toAdminMemoryCandidateSummary(current)
      : await markMemoryCandidateRejected(transactionDb, current, request);
    const audit = await insertAuditLog(transactionDb, {
      actor: request.actor,
      action: "memory_candidate.rejected",
      metadata: {
        alreadyRejected,
        candidateKind: candidate.candidateKind,
        idempotencyKey: request.idempotencyKey,
        ...(request.reason ? { reason: request.reason } : {}),
        ...(candidate.repoId ? { repoId: candidate.repoId } : {}),
        status: candidate.status,
      },
      orgId: candidate.orgId,
      requestId: request.requestId,
      resourceId: candidate.memoryCandidateId,
      resourceType: "memory_candidate",
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });

    return {
      auditLogId: audit.auditLogId,
      candidate,
    };
  });
}

/** Updates one memory fact and records an audit event. */
async function updateMemoryFact(
  db: HeimdallDatabase,
  memoryFactId: string,
  request: AdminMemoryFactUpdateRequest,
): Promise<AdminMemoryFactSummary> {
  return db.transaction(async (tx) => {
    const transactionDb = tx as HeimdallDatabase;
    const current = await getMemoryFactRow(transactionDb, memoryFactId);
    const nextStatus =
      request.status ??
      (request.enabled === undefined ? current.status : statusFromEnabled(request.enabled));
    const currentMetadata = asRecord(current.metadata);
    const metadata = memoryFactMetadata({
      actorUserId: request.actor.actorUserId,
      inputMetadata: request.metadata ?? currentMetadata,
      requestId: request.requestId,
      source: request.source ?? memoryFactSourceFromMetadata(currentMetadata),
      subject:
        request.subject ??
        stringField(currentMetadata, "subject") ??
        defaultMemorySubject(request.text ?? current.body),
    });
    const updated = await new MemoryFactRepository(transactionDb).updateMemoryFact({
      body: request.text ?? current.body,
      confidence: request.confidence ?? current.confidence,
      expiresAt:
        request.expiresAt === undefined
          ? current.expiresAt
          : request.expiresAt
            ? new Date(request.expiresAt)
            : null,
      factType: request.kind ?? current.factType,
      memoryFactId,
      metadata,
      status: nextStatus,
      updatedAt: new Date(),
    });
    const summary = toAdminMemoryFactSummary(requireReturnedRow(updated));
    await insertAuditLog(transactionDb, {
      actor: request.actor,
      action: "memory.updated",
      metadata: {
        after: {
          kind: summary.kind,
          status: summary.status,
        },
        before: {
          kind: current.factType,
          status: current.status,
        },
        repoId: summary.repoId,
      },
      orgId: summary.orgId,
      requestId: request.requestId,
      resourceId: summary.memoryFactId,
      resourceType: "memory_fact",
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });

    return summary;
  });
}

/** Soft-deletes one memory fact by disabling it and records an audit event. */
async function deleteMemoryFact(
  db: HeimdallDatabase,
  memoryFactId: string,
  request: AdminMemoryFactDeleteRequest,
): Promise<AdminMemoryFactSummary> {
  return db.transaction(async (tx) => {
    const transactionDb = tx as HeimdallDatabase;
    const current = await getMemoryFactRow(transactionDb, memoryFactId);
    const metadata = {
      ...asRecord(current.metadata),
      deletedByUserId: request.actor.actorUserId,
      deletedRequestId: request.requestId,
    };
    const updated = await new MemoryFactRepository(transactionDb).disableMemoryFact({
      memoryFactId,
      metadata,
      updatedAt: new Date(),
    });
    const summary = toAdminMemoryFactSummary(requireReturnedRow(updated));
    await insertAuditLog(transactionDb, {
      actor: request.actor,
      action: "memory.deleted",
      metadata: {
        previousStatus: current.status,
        repoId: summary.repoId,
        status: summary.status,
      },
      orgId: summary.orgId,
      requestId: request.requestId,
      resourceId: summary.memoryFactId,
      resourceType: "memory_fact",
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });

    return summary;
  });
}

/** Gets a memory fact row or raises a typed not-found error. */
async function getMemoryFactRow(
  db: HeimdallDatabase,
  memoryFactId: string,
): Promise<MemoryFactRow> {
  const row = await new MemoryFactRepository(db).getMemoryFact(memoryFactId);
  if (!row) {
    throw new AdminControlPlaneNotFoundError("memory_fact", memoryFactId);
  }

  return row;
}

/** Gets a memory candidate row or raises a typed not-found error. */
async function getMemoryCandidateRow(
  db: HeimdallDatabase,
  memoryCandidateId: string,
): Promise<MemoryCandidateRow> {
  const row = await new MemoryCandidateRepository(db).getMemoryCandidate(memoryCandidateId);
  if (!row) {
    throw new AdminControlPlaneNotFoundError("memory_candidate", memoryCandidateId);
  }

  return row;
}

/** Converts a memory fact row into a scoped API DTO. */
function toAdminMemoryFactSummary(row: MemoryFactRow): AdminMemoryFactSummary {
  const metadata = asRecord(row.metadata);
  const status = memoryFactStatusFromString(row.status);
  const kind = memoryFactKindFromString(row.factType);
  const subject = stringField(metadata, "subject") ?? defaultMemorySubject(row.body);

  return {
    body: row.body,
    confidence: row.confidence,
    createdAt: row.createdAt.toISOString(),
    enabled: status === "active",
    ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    factType: row.factType,
    kind,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    memoryFactId: row.memoryFactId,
    orgId: row.orgId,
    ...(row.repoId ? { repoId: row.repoId } : {}),
    scope: row.repoId ? "repository" : "organization",
    source: memoryFactSourceFromMetadata(metadata),
    status,
    subject,
    text: row.body,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Converts a memory candidate row into a scoped API DTO. */
function toAdminMemoryCandidateSummary(row: MemoryCandidateRow): AdminMemoryCandidateSummary {
  const metadata = asRecord(row.metadata);

  return {
    ...(row.approvedMemoryFactId ? { approvedMemoryFactId: row.approvedMemoryFactId } : {}),
    candidateKind: row.candidateKind,
    confidence: normalizedConfidence(row.confidence),
    createdAt: row.createdAt.toISOString(),
    ...(row.createdByLogin ? { createdByLogin: row.createdByLogin } : {}),
    ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
    ...(row.decidedByUserId ? { decidedByUserId: row.decidedByUserId } : {}),
    ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    memoryCandidateId: row.memoryCandidateId,
    orgId: row.orgId,
    proposedAppliesTo: asRecord(row.proposedAppliesTo),
    proposedContent: row.proposedContent,
    proposedScope: asRecord(row.proposedScope),
    ...(row.repoId ? { repoId: row.repoId } : {}),
    ...(row.sourceFeedbackEventId ? { sourceFeedbackEventId: row.sourceFeedbackEventId } : {}),
    ...(row.sourceFindingId ? { sourceFindingId: row.sourceFindingId } : {}),
    sourceKind: row.sourceKind,
    status: row.status,
    trustLevel: row.trustLevel,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Converts a joined suppression match row into a scoped API DTO. */
function toAdminSuppressionMatchSummary(row: SuppressionMatchRow): AdminSuppressionMatchSummary {
  return {
    candidateFindingId: row.candidateFindingId,
    confidence: normalizedConfidence(row.confidence),
    createdAt: row.createdAt.toISOString(),
    findingCategory: row.findingCategory,
    findingId: row.findingId,
    findingSeverity: row.findingSeverity,
    findingTitle: row.findingTitle,
    location: row.location,
    matchKind: row.matchKind,
    memoryFactId: row.memoryFactId,
    memoryStatus: row.memoryStatus,
    memoryText: row.memoryText,
    ...(row.reason ? { reason: row.reason } : {}),
    reviewRunId: row.reviewRunId,
    suppressionMatchId: row.suppressionMatchId,
  };
}

/** Creates or reuses the durable memory fact for one approved candidate. */
async function createOrGetMemoryFactFromCandidate(
  db: HeimdallDatabase,
  candidate: MemoryCandidateRow,
  request: AdminMemoryCandidateModerationRequest,
): Promise<AdminMemoryFactSummary> {
  const memoryFactId =
    candidate.approvedMemoryFactId ??
    stablePrefixedId("mem", ["memory_candidate", candidate.memoryCandidateId]);
  const factType = memoryFactKindForCandidate(candidate.candidateKind);
  const row = await new MemoryFactRepository(db).createMemoryFactIfAbsent({
    body: candidate.proposedContent,
    confidence: normalizedConfidence(candidate.confidence),
    expiresAt: candidate.expiresAt,
    factType,
    memoryFactId,
    metadata: memoryFactMetadata({
      actorUserId: request.actor.actorUserId,
      idempotencyKey: request.idempotencyKey,
      inputMetadata: memoryFactMetadataFromCandidate(candidate, request),
      requestId: request.requestId,
      source: "feedback",
      subject: defaultMemorySubject(candidate.proposedContent),
    }),
    orgId: candidate.orgId,
    repoId: candidate.repoId,
    status: "active",
  });

  return toAdminMemoryFactSummary(row);
}

/** Marks one memory candidate approved after its durable memory fact exists. */
async function markMemoryCandidateApproved(
  db: HeimdallDatabase,
  candidate: MemoryCandidateRow,
  memoryFactId: string,
  request: AdminMemoryCandidateModerationRequest,
): Promise<AdminMemoryCandidateSummary> {
  const decisionAt = new Date();
  const decidedByUserId = await existingUserId(db, request.actor.actorUserId);
  const updated = await new MemoryCandidateRepository(db).approveMemoryCandidate({
    decidedAt: decisionAt,
    decidedByUserId,
    memoryCandidateId: candidate.memoryCandidateId,
    memoryFactId,
    metadata: memoryCandidateDecisionMetadata(candidate, "approved", request, memoryFactId),
  });

  return toAdminMemoryCandidateSummary(requireReturnedRow(updated));
}

/** Marks one memory candidate rejected. */
async function markMemoryCandidateRejected(
  db: HeimdallDatabase,
  candidate: MemoryCandidateRow,
  request: AdminMemoryCandidateModerationRequest,
): Promise<AdminMemoryCandidateSummary> {
  const decisionAt = new Date();
  const decidedByUserId = await existingUserId(db, request.actor.actorUserId);
  const updated = await new MemoryCandidateRepository(db).rejectMemoryCandidate({
    decidedAt: decisionAt,
    decidedByUserId,
    memoryCandidateId: candidate.memoryCandidateId,
    metadata: memoryCandidateDecisionMetadata(candidate, "rejected", request),
  });

  return toAdminMemoryCandidateSummary(requireReturnedRow(updated));
}

/** Returns a valid user ID for FK-backed decision fields when the actor is stored locally. */
async function existingUserId(db: HeimdallDatabase, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: users.userId })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);
  return row?.userId ?? null;
}

/** Maps a feedback candidate kind to a scoped API memory fact kind. */
function memoryFactKindForCandidate(candidateKind: string): MemoryFactKind {
  if (
    candidateKind === "suppress_exact_finding" ||
    candidateKind === "suppress_similar_finding" ||
    candidateKind === "suppress_category_in_scope"
  ) {
    return "suppression";
  }
  if (candidateKind === "architecture_convention") {
    return "architecture_note";
  }
  if (
    candidateKind === "team_preference" ||
    candidateKind === "style_preference" ||
    candidateKind === "severity_calibration"
  ) {
    return "review_preference";
  }
  if (candidateKind === "testing_convention") {
    return "tooling_note";
  }
  if (candidateKind === "repo_fact" || candidateKind === "security_convention") {
    return "repo_convention";
  }

  return "other";
}

/** Builds memory fact metadata from the approved candidate and moderation request. */
function memoryFactMetadataFromCandidate(
  candidate: MemoryCandidateRow,
  request: AdminMemoryCandidateModerationRequest,
): Record<string, unknown> {
  return {
    ...asRecord(candidate.metadata),
    ...(request.metadata ?? {}),
    candidateKind: candidate.candidateKind,
    ...(candidate.createdByLogin ? { createdByLogin: candidate.createdByLogin } : {}),
    memoryCandidateId: candidate.memoryCandidateId,
    proposedAppliesTo: asRecord(candidate.proposedAppliesTo),
    proposedScope: asRecord(candidate.proposedScope),
    ...(request.reason ? { reason: request.reason } : {}),
    ...(candidate.sourceFeedbackEventId
      ? { sourceFeedbackEventId: candidate.sourceFeedbackEventId }
      : {}),
    ...(candidate.sourceFindingId ? { sourceFindingId: candidate.sourceFindingId } : {}),
    sourceKind: candidate.sourceKind,
    trustLevel: candidate.trustLevel,
  };
}

/** Builds candidate metadata that captures the latest moderation decision. */
function memoryCandidateDecisionMetadata(
  candidate: MemoryCandidateRow,
  decision: "approved" | "rejected",
  request: AdminMemoryCandidateModerationRequest,
  memoryFactId?: string,
): Record<string, unknown> {
  return {
    ...asRecord(candidate.metadata),
    ...(request.metadata ?? {}),
    decidedByActorUserId: request.actor.actorUserId,
    decision,
    decisionIdempotencyKey: request.idempotencyKey,
    ...(memoryFactId ? { memoryFactId } : {}),
    ...(request.reason ? { reason: request.reason } : {}),
    requestId: request.requestId,
  };
}

/** Normalizes a confidence value to the API-supported range. */
function normalizedConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Builds stored memory metadata from caller input and audit context. */
function memoryFactMetadata(input: {
  /** Actor ID that wrote the memory fact when available. */
  readonly actorUserId?: string | undefined;
  /** Caller-provided idempotency key when this is a create request. */
  readonly idempotencyKey?: string | undefined;
  /** Caller-supplied metadata. */
  readonly inputMetadata?: Record<string, unknown> | undefined;
  /** Request ID that wrote the row. */
  readonly requestId: string;
  /** Memory source. */
  readonly source: MemoryFactSource;
  /** Memory subject. */
  readonly subject: string;
}): Record<string, unknown> {
  return {
    ...(input.inputMetadata ?? {}),
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    requestId: input.requestId,
    source: input.source,
    subject: input.subject,
  };
}

/** Returns a compact default subject for memory rows that do not store one. */
function defaultMemorySubject(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

/** Converts a boolean enabled value into the corresponding memory status. */
function statusFromEnabled(enabled: boolean): MemoryFactStatus {
  return enabled ? "active" : "disabled";
}

/** Narrows a raw memory fact kind, falling back to other for legacy rows. */
function memoryFactKindFromString(value: string): MemoryFactKind {
  return isMemoryFactKind(value) ? value : "other";
}

/** Narrows a raw memory fact status, falling back to disabled for unknown rows. */
function memoryFactStatusFromString(value: string): MemoryFactStatus {
  return isMemoryFactStatus(value) ? value : "disabled";
}

/** Reads a memory fact source from metadata, falling back to manual. */
function memoryFactSourceFromMetadata(metadata: Record<string, unknown>): MemoryFactSource {
  const source = stringField(metadata, "source");
  return source && isMemoryFactSource(source) ? source : "manual";
}

/** Builds SQL predicates for review history discovery. */
function reviewRunListConditions(query: AdminReviewRunListQuery): SQL[] {
  const conditions: SQL[] = [];
  const scopedConditions = scopedReviewRunRepositoryConditions(query);
  if (scopedConditions) {
    conditions.push(scopedConditions);
  }
  if (query.repoId) {
    conditions.push(eq(reviewRuns.repoId, query.repoId));
  }
  if (query.status) {
    conditions.push(eq(reviewRuns.status, query.status));
  }

  const search = query.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    const prNumber = Number(search);
    const searchCondition = or(
      ilike(repositories.fullName, pattern),
      ilike(pullRequestSnapshots.title, pattern),
      ilike(pullRequestSnapshots.authorLogin, pattern),
      Number.isSafeInteger(prNumber) ? eq(reviewRuns.pullRequestNumber, prNumber) : undefined,
    );
    if (searchCondition) {
      conditions.push(searchCondition);
    }
  }

  return conditions;
}

/** Builds a repository scope predicate for review history. */
function scopedReviewRunRepositoryConditions(query: AdminReviewRunListQuery): SQL | undefined {
  const orgIds = query.orgIds ?? [];
  const repoIds = query.repoIds ?? [];
  const hasExplicitScope = query.orgIds !== undefined || query.repoIds !== undefined;
  if (orgIds.includes("*") || repoIds.includes("*")) {
    return undefined;
  }

  const conditions: SQL[] = [];
  if (orgIds.length > 0) {
    conditions.push(inArray(repositories.orgId, [...orgIds]));
  }
  if (repoIds.length > 0) {
    conditions.push(inArray(reviewRuns.repoId, [...repoIds]));
  }
  if (conditions.length === 0) {
    return hasExplicitScope ? sql`false` : undefined;
  }

  const [condition] = conditions;
  return conditions.length === 1 ? (condition ?? sql`false`) : or(...conditions);
}

/** Converts a joined review history row into a dashboard DTO. */
function toAdminReviewRunSummary(row: {
  /** Review run ID. */
  readonly reviewRunId: string;
  /** Repository ID. */
  readonly repoId: string;
  /** Organization ID. */
  readonly orgId: string;
  /** Repository full name. */
  readonly repoFullName: string;
  /** Pull request number. */
  readonly pullRequestNumber: number;
  /** Pull request title from the snapshot. */
  readonly pullRequestTitle: string | null;
  /** Pull request author from the snapshot. */
  readonly authorLogin: string | null;
  /** Changed file count from the snapshot. */
  readonly changedFileCount: number | null;
  /** Review trigger. */
  readonly trigger: string;
  /** Review status. */
  readonly status: string;
  /** Base commit SHA. */
  readonly baseSha: string;
  /** Head commit SHA. */
  readonly headSha: string;
  /** Review summary. */
  readonly summary: string | null;
  /** Persisted finding counts. */
  readonly counts: unknown;
  /** Structured review run error payload. */
  readonly error: unknown;
  /** Creation timestamp. */
  readonly createdAt: Date;
  /** Update timestamp. */
  readonly updatedAt: Date;
  /** Start timestamp. */
  readonly startedAt: Date | null;
  /** Completion timestamp. */
  readonly completedAt: Date | null;
}): AdminReviewRunSummary {
  const failure = reviewRunFailureFromUnknown(row);

  return {
    reviewRunId: row.reviewRunId,
    repoId: row.repoId,
    orgId: row.orgId,
    repoFullName: row.repoFullName,
    pullRequestNumber: row.pullRequestNumber,
    ...(row.pullRequestTitle ? { pullRequestTitle: row.pullRequestTitle } : {}),
    ...(row.authorLogin ? { authorLogin: row.authorLogin } : {}),
    ...(row.changedFileCount !== null ? { changedFileCount: row.changedFileCount } : {}),
    trigger: row.trigger,
    status: row.status,
    baseSha: row.baseSha,
    headSha: row.headSha,
    ...(row.summary ? { summary: row.summary } : {}),
    counts: reviewCountsFromUnknown(row.counts),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
    ...(failure ? { failure } : {}),
  };
}

/** Converts a review run error payload into a dashboard-safe failure summary. */
function reviewRunFailureFromUnknown(row: {
  /** Review run ID. */
  readonly reviewRunId: string;
  /** Review run status. */
  readonly status: string;
  /** Structured review run error payload. */
  readonly error: unknown;
  /** Update timestamp. */
  readonly updatedAt: Date;
  /** Completion timestamp. */
  readonly completedAt: Date | null;
}): AdminFailureDetail | undefined {
  if (!row.error && row.status !== "failed") {
    return undefined;
  }

  return failureDetailFromUnknown({
    error: row.error,
    fallbackCode: "review_run.failed",
    fallbackMessage: "Review run failed.",
    occurredAt: (row.completedAt ?? row.updatedAt).toISOString(),
    rowId: row.reviewRunId,
    source: "review_run",
  });
}

/** Converts a durable background-job error payload into a dashboard-safe failure summary. */
function backgroundJobFailureFromUnknown(row: {
  /** Background job row ID. */
  readonly backgroundJobId: string;
  /** Durable job type. */
  readonly jobType: string;
  /** Durable idempotency key. */
  readonly jobKey: string;
  /** Durable job status. */
  readonly status: string;
  /** Durable job error payload. */
  readonly error?: unknown;
  /** Completion timestamp. */
  readonly completedAt?: Date | undefined;
  /** Update timestamp. */
  readonly updatedAt: Date;
}): AdminFailureDetail {
  return failureDetailFromUnknown({
    source: "background_job",
    fallbackCode:
      row.status === "dead_lettered" ? "background_job.dead_lettered" : "background_job.failed",
    fallbackMessage: `Background job ${row.jobType}:${row.jobKey} failed.`,
    rowId: row.backgroundJobId,
    occurredAt: (row.completedAt ?? row.updatedAt).toISOString(),
    error: row.error,
  });
}

/** Converts an unknown error payload into a structured failure summary. */
function failureDetailFromUnknown(input: {
  /** Table or event source that produced the failure. */
  readonly source: AdminFailureSource;
  /** Machine-readable fallback code. */
  readonly fallbackCode: string;
  /** Human-readable fallback message. */
  readonly fallbackMessage: string;
  /** Related database row ID when available. */
  readonly rowId?: string | undefined;
  /** ISO timestamp associated with the failure when available. */
  readonly occurredAt?: string | undefined;
  /** Structured or string error payload. */
  readonly error: unknown;
}): AdminFailureDetail {
  const record = asOptionalRecord(input.error);
  const retryable = record?.retryable;
  const detailsRecord = asOptionalRecord(record?.details);
  const detailEntries = record
    ? Object.entries(record).filter(
        ([key]) => !["code", "message", "retryable", "details"].includes(key),
      )
    : [];
  const fallbackDetails = detailEntries.length > 0 ? Object.fromEntries(detailEntries) : undefined;
  const details = detailsRecord ?? fallbackDetails;

  return {
    code: stringField(record ?? {}, "code") ?? input.fallbackCode,
    ...(details !== undefined ? { details } : {}),
    message:
      stringField(record ?? {}, "message") ??
      (typeof input.error === "string" && input.error.length > 0
        ? input.error
        : input.fallbackMessage),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    ...(input.rowId ? { rowId: input.rowId } : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
    source: input.source,
  };
}

/** Parses persisted review counts into dashboard-safe defaults. */
function reviewCountsFromUnknown(value: unknown): AdminReviewFindingCounts {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  return {
    candidateFindings: numberFromRecord(record, "candidateFindings"),
    validatedFindings: numberFromRecord(record, "validatedFindings"),
    publishedFindings: numberFromRecord(record, "publishedFindings"),
    rejectedFindings: numberFromRecord(record, "rejectedFindings"),
  };
}

/** Reads a finite number from an unknown record field. */
function numberFromRecord(value: object | undefined, key: string): number {
  const field = (value as Record<string, unknown> | undefined)?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

/** Returns an object record only when the unknown value is object-like. */
function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Converts an unknown JSON value into a compact string list. */
function stringListFromUnknown(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

/** Reads a string field from an unknown JSON record. */
function stringFromUnknownRecord(value: unknown, key: string): string | undefined {
  const record = asOptionalRecord(value);
  const field = record?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

/** Sorts reconciliation issues by severity and timestamp. */
function compareBillingReconciliationIssues(
  left: AdminBillingReconciliationIssue,
  right: AdminBillingReconciliationIssue,
): number {
  return (
    reconciliationSeverityRank(right.severity) - reconciliationSeverityRank(left.severity) ||
    right.occurredAt.localeCompare(left.occurredAt) ||
    left.category.localeCompare(right.category)
  );
}

/** Returns the sort rank for one reconciliation severity. */
function reconciliationSeverityRank(severity: AdminBillingReconciliationSeverity): number {
  return severity === "critical" ? 2 : 1;
}

/** Rounds a finite number to two decimal places for compact dashboard metrics. */
function roundToTwoDecimalPlaces(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/** Returns a safe list limit. */
function boundedListLimit(limit: number | undefined): number {
  if (!limit || !Number.isSafeInteger(limit)) {
    return 50;
  }

  return Math.min(100, Math.max(1, limit));
}

/** Gets organization policy defaults, falling back to product defaults when the row is absent. */
async function getOrgSettings(
  db: HeimdallDatabase,
  orgId: string,
): Promise<AdminOrgControlPlaneSettings> {
  const org = await getOrganization(db, orgId);
  const repositoryRepository = new RepositoryRepository(db);

  return {
    org,
    settings:
      (await repositoryRepository.getOrgSettings(orgId)) ??
      createDefaultOrgSettings(orgId, org.updatedAt),
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

/** Lists organization and repository rules that can affect a repository. */
async function listRepositoryRules(
  db: HeimdallDatabase,
  repoId: string,
): Promise<readonly AdminRepoRuleSummary[]> {
  const settings = await getRepositorySettings(db, repoId);
  const rules = await new RepoRuleRepository(db).listEffectiveRules({
    orgId: settings.repository.orgId,
    repoId,
  });

  return rules
    .map(repoRuleSummaryFromRule)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** Creates a repository-scoped rule and appends an audit record atomically. */
async function createRepositoryRule(
  db: HeimdallDatabase,
  repoId: string,
  request: CreateRepoRuleRequest,
  audit: Omit<
    AdminAuditEventInput,
    "action" | "metadata" | "orgId" | "resourceId" | "resourceType"
  >,
): Promise<AdminRepoRuleSummary> {
  return db.transaction(async (tx) => {
    const settings = await getRepositorySettings(tx as HeimdallDatabase, repoId);
    const timestamp = new Date().toISOString();
    const rule = await new RepoRuleRepository(tx as HeimdallDatabase).createRule({
      ruleId: `rule_${randomUUID()}`,
      orgId: settings.repository.orgId,
      repoId,
      name: request.name,
      ...(request.description ? { description: request.description } : {}),
      effect: request.effect,
      matcher: request.matcher,
      instruction: request.instruction,
      priority: request.priority ?? 500,
      enabled: request.enabled ?? true,
      ...createdByUserIdFromAuditActor(audit.actor),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const summary = repoRuleSummaryFromRule(rule);

    await insertAuditLog(tx as HeimdallDatabase, {
      ...audit,
      action: "repo.rule.created",
      metadata: {
        after: summary,
        requestId: audit.requestId,
        sessionId: audit.sessionId,
      },
      orgId: settings.repository.orgId,
      resourceId: rule.ruleId,
      resourceType: "repo_rule",
    });

    return summary;
  });
}

/** Updates a repository-scoped rule and appends an audit record atomically. */
async function updateRepositoryRule(
  db: HeimdallDatabase,
  repoId: string,
  ruleId: string,
  request: UpdateRepoRuleRequest,
  audit: Omit<
    AdminAuditEventInput,
    "action" | "metadata" | "orgId" | "resourceId" | "resourceType"
  >,
): Promise<AdminRepoRuleSummary> {
  return db.transaction(async (tx) => {
    const settings = await getRepositorySettings(tx as HeimdallDatabase, repoId);
    const ruleRepository = new RepoRuleRepository(tx as HeimdallDatabase);
    const before = await ruleRepository.getRepositoryRule({ repoId, ruleId });
    if (!before) {
      throw new AdminControlPlaneNotFoundError("repo_rule", ruleId);
    }

    const updated = await ruleRepository.updateRepositoryRule({
      repoId,
      ruleId,
      patch: request,
    });
    if (!updated) {
      throw new AdminControlPlaneNotFoundError("repo_rule", ruleId);
    }
    const summary = repoRuleSummaryFromRule(updated);

    await insertAuditLog(tx as HeimdallDatabase, {
      ...audit,
      action: "repo.rule.updated",
      metadata: {
        after: summary,
        before: repoRuleSummaryFromRule(before),
        changedFields: Object.keys(request).sort(),
        requestId: audit.requestId,
        sessionId: audit.sessionId,
      },
      orgId: settings.repository.orgId,
      resourceId: ruleId,
      resourceType: "repo_rule",
    });

    return summary;
  });
}

/** Deletes a repository-scoped rule and appends an audit record atomically. */
async function deleteRepositoryRule(
  db: HeimdallDatabase,
  repoId: string,
  ruleId: string,
  audit: Omit<
    AdminAuditEventInput,
    "action" | "metadata" | "orgId" | "resourceId" | "resourceType"
  >,
): Promise<AdminRepoRuleSummary> {
  return db.transaction(async (tx) => {
    const settings = await getRepositorySettings(tx as HeimdallDatabase, repoId);
    const deleted = await new RepoRuleRepository(tx as HeimdallDatabase).deleteRepositoryRule({
      repoId,
      ruleId,
    });
    if (!deleted) {
      throw new AdminControlPlaneNotFoundError("repo_rule", ruleId);
    }
    const summary = repoRuleSummaryFromRule(deleted);

    await insertAuditLog(tx as HeimdallDatabase, {
      ...audit,
      action: "repo.rule.deleted",
      metadata: {
        before: summary,
        requestId: audit.requestId,
        sessionId: audit.sessionId,
      },
      orgId: settings.repository.orgId,
      resourceId: ruleId,
      resourceType: "repo_rule",
    });

    return summary;
  });
}

/** Previews the effective review policy for current settings plus an optional draft patch. */
async function previewRepositoryPolicy(
  db: HeimdallDatabase,
  repoId: string,
  patch: UpdateRepositoryControlPlaneSettingsRequest,
): Promise<AdminRepositoryPolicyPreview> {
  return policyPreviewFromResult(await buildRepositoryPolicySnapshotForPreview(db, repoId, patch));
}

/** Tests the effective review policy against a sample finding and path. */
async function testRepositoryPolicy(
  db: HeimdallDatabase,
  repoId: string,
  request: TestRepositoryPolicyRequest,
): Promise<AdminRepositoryPolicyTest> {
  const result = await buildRepositoryPolicySnapshotForPreview(
    db,
    repoId,
    request.settingsPatch ?? {},
  );
  const policy = result.snapshot.effectivePolicy;
  const pathClassification = classifyPath({
    path: request.finding.location.path,
    policy,
    ...(request.pathLineCount !== undefined ? { lineCount: request.pathLineCount } : {}),
    ...(request.pathSizeBytes !== undefined ? { sizeBytes: request.pathSizeBytes } : {}),
  });
  const findingDecision = evaluateFindingPolicy({
    finding: policyTestFindingFromRequest(request),
    pathClassification,
    policy,
  });

  return {
    findingDecision,
    pathClassification,
    preview: policyPreviewFromResult(result),
  };
}

/** Validates one repo-local reviewer config draft for a repository. */
async function validateRepositoryConfigFile(
  db: HeimdallDatabase,
  repoId: string,
  request: ValidateRepoLocalConfigFileRequest,
): Promise<AdminRepoLocalConfigValidation> {
  const repositoryRepository = new RepositoryRepository(db);
  const settings = await getRepositorySettings(db, repoId);
  const orgSettings =
    (await repositoryRepository.getOrgSettings(settings.repository.orgId)) ??
    createDefaultOrgSettings(settings.repository.orgId, settings.repository.updatedAt);
  const parsed = parseRepoLocalConfig({
    content: request.content,
    format: request.format,
    sourceCommitSha: "0000000",
    sourcePath: request.sourcePath ?? defaultRepoLocalConfigValidationSourcePath(),
  });
  const warnings: PolicyWarning[] = [...parsed.warnings];
  if (parsed.ok && !orgSettings.allowRepoLocalConfig) {
    warnings.push({
      code: "repo_local_config_disabled_by_org_settings",
      message: "Repo-local config is valid but organization settings currently disable it.",
      details: {
        orgSettingsVersion: orgSettings.version,
      },
    });
  }

  return parsed.ok
    ? {
        errors: [],
        parsed: parsed.config,
        valid: true,
        warnings,
      }
    : {
        errors: parsed.errors,
        valid: false,
        warnings,
      };
}

/** Returns the validation source path used when the caller did not provide one. */
function defaultRepoLocalConfigValidationSourcePath(): string {
  return ".github/ai-reviewer.yml";
}

/** Updates organization policy defaults and appends a before/after audit record atomically. */
async function updateOrgSettings(
  db: HeimdallDatabase,
  orgId: string,
  patch: UpdateOrgSettingsRequest,
  audit: Omit<
    AdminAuditEventInput,
    "action" | "metadata" | "orgId" | "resourceId" | "resourceType"
  >,
): Promise<AdminOrgControlPlaneSettings> {
  return db.transaction(async (tx) => {
    const transactionDb = tx as HeimdallDatabase;
    const repositoryRepository = new RepositoryRepository(transactionDb);
    const before = await getOrgSettings(transactionDb, orgId);
    const changedFields = Object.keys(patch).sort();
    const settings =
      changedFields.length > 0
        ? await repositoryRepository.upsertOrgSettings(
            mergeOrgSettingsPatch(
              before.settings,
              patch,
              new Date().toISOString(),
              updatedByUserIdFromAuditActor(audit.actor),
            ),
          )
        : before.settings;

    await insertAuditLog(transactionDb, {
      ...audit,
      action: "org.settings.updated",
      metadata: {
        after: { org: before.org, settings },
        before,
        changedFields,
        requestId: audit.requestId,
        sessionId: audit.sessionId,
      },
      orgId,
      resourceId: orgId,
      resourceType: "organization",
    });

    return { org: before.org, settings };
  });
}

/** Applies a partial organization settings patch to a validated current settings document. */
function mergeOrgSettingsPatch(
  settings: OrgSettings,
  patch: UpdateOrgSettingsRequest,
  updatedAt: string,
  updatedByUserId: string | null,
): OrgSettings {
  const triggerPatch = patch.defaultTriggerPolicy;
  const findingPatch = patch.defaultFindingPolicy;
  const publishingPatch = patch.defaultPublishingPolicy;
  const memoryPatch = patch.defaultMemoryPolicy;
  const requireLabel = triggerPatch?.requireLabel ?? settings.defaultTriggerPolicy.requireLabel;
  const memoryTtlDays = memoryPatch?.memoryTtlDays ?? settings.defaultMemoryPolicy.memoryTtlDays;
  const allowedModelProfiles =
    patch.allowedModelProfiles !== undefined
      ? [...patch.allowedModelProfiles]
      : settings.allowedModelProfiles !== undefined
        ? [...settings.allowedModelProfiles]
        : undefined;

  return {
    schemaVersion: settings.schemaVersion,
    orgId: settings.orgId,
    defaultReviewPolicy: patch.defaultReviewPolicy ?? settings.defaultReviewPolicy,
    defaultTriggerPolicy: {
      enabledActions: [
        ...(triggerPatch?.enabledActions ?? settings.defaultTriggerPolicy.enabledActions),
      ],
      ignoredAuthors: [
        ...(triggerPatch?.ignoredAuthors ?? settings.defaultTriggerPolicy.ignoredAuthors),
      ],
      ignoredLabels: [
        ...(triggerPatch?.ignoredLabels ?? settings.defaultTriggerPolicy.ignoredLabels),
      ],
      ...(requireLabel !== undefined ? { requireLabel } : {}),
      skipDraftPullRequests:
        triggerPatch?.skipDraftPullRequests ?? settings.defaultTriggerPolicy.skipDraftPullRequests,
    },
    defaultFindingPolicy: {
      allowStyleFindings:
        findingPatch?.allowStyleFindings ?? settings.defaultFindingPolicy.allowStyleFindings,
      enabledCategories: [
        ...(findingPatch?.enabledCategories ?? settings.defaultFindingPolicy.enabledCategories),
      ],
      maxCommentsPerReview:
        findingPatch?.maxCommentsPerReview ?? settings.defaultFindingPolicy.maxCommentsPerReview,
      minimumConfidence:
        findingPatch?.minimumConfidence ?? settings.defaultFindingPolicy.minimumConfidence,
      severityThreshold:
        findingPatch?.severityThreshold ?? settings.defaultFindingPolicy.severityThreshold,
      suppressGeneratedFileFindings:
        findingPatch?.suppressGeneratedFileFindings ??
        settings.defaultFindingPolicy.suppressGeneratedFileFindings,
    },
    defaultPublishingPolicy: {
      maxCommentsPerReview:
        publishingPatch?.maxCommentsPerReview ??
        settings.defaultPublishingPolicy.maxCommentsPerReview,
      publishCheckRun:
        publishingPatch?.publishCheckRun ?? settings.defaultPublishingPolicy.publishCheckRun,
      publishInlineComments:
        publishingPatch?.publishInlineComments ??
        settings.defaultPublishingPolicy.publishInlineComments,
      publishSummaryComment:
        publishingPatch?.publishSummaryComment ??
        settings.defaultPublishingPolicy.publishSummaryComment,
    },
    defaultMemoryPolicy: {
      allowExactFindingSuppression:
        memoryPatch?.allowExactFindingSuppression ??
        settings.defaultMemoryPolicy.allowExactFindingSuppression,
      allowNaturalLanguageInstructions:
        memoryPatch?.allowNaturalLanguageInstructions ??
        settings.defaultMemoryPolicy.allowNaturalLanguageInstructions,
      allowPathCategorySuppression:
        memoryPatch?.allowPathCategorySuppression ??
        settings.defaultMemoryPolicy.allowPathCategorySuppression,
      enableMemoryContext:
        memoryPatch?.enableMemoryContext ?? settings.defaultMemoryPolicy.enableMemoryContext,
      enableMemorySuppression:
        memoryPatch?.enableMemorySuppression ??
        settings.defaultMemoryPolicy.enableMemorySuppression,
      maxMemoryFactsInContext:
        memoryPatch?.maxMemoryFactsInContext ??
        settings.defaultMemoryPolicy.maxMemoryFactsInContext,
      ...(memoryTtlDays !== undefined ? { memoryTtlDays } : {}),
      requireApprovalForMemoryFacts:
        memoryPatch?.requireApprovalForMemoryFacts ??
        settings.defaultMemoryPolicy.requireApprovalForMemoryFacts,
      trustedFeedbackRoles: [
        ...(memoryPatch?.trustedFeedbackRoles ?? settings.defaultMemoryPolicy.trustedFeedbackRoles),
      ],
    },
    ...(allowedModelProfiles !== undefined ? { allowedModelProfiles } : {}),
    allowRepoLocalConfig: patch.allowRepoLocalConfig ?? settings.allowRepoLocalConfig,
    allowMemorySuppression: patch.allowMemorySuppression ?? settings.allowMemorySuppression,
    allowUserDefinedRules: patch.allowUserDefinedRules ?? settings.allowUserDefinedRules,
    createdAt: settings.createdAt,
    updatedAt,
    updatedByUserId,
    version: settings.version + 1,
  };
}

/** Builds an effective policy snapshot for preview and local policy tests. */
async function buildRepositoryPolicySnapshotForPreview(
  db: HeimdallDatabase,
  repoId: string,
  patch: UpdateRepositoryControlPlaneSettingsRequest,
): Promise<BuildReviewPolicySnapshotResult> {
  const current = await getRepositorySettings(db, repoId);
  const timestamp = new Date().toISOString();
  const settings = {
    ...current.settings,
    ...settingsOnlyPatch(patch),
    updatedAt: timestamp,
  };
  const repository = {
    ...current.repository,
    enabled: patch.repositoryEnabled ?? current.repository.enabled,
  };
  const activeRules = await new RepoRuleRepository(db).listEffectiveRules({
    orgId: current.repository.orgId,
    repoId,
  });
  const orgSettings = await new RepositoryRepository(db).getOrgSettings(current.repository.orgId);

  return buildReviewPolicySnapshot({
    activeRules,
    ...(orgSettings ? { orgSettings } : {}),
    repository,
    settings,
    timestamp,
  });
}

/** Converts a policy test request into the finding shape used by rule evaluation. */
function policyTestFindingFromRequest(
  request: TestRepositoryPolicyRequest,
): EvaluateFindingPolicyInput["finding"] {
  return {
    body: request.finding.body,
    category: request.finding.category,
    confidence: request.finding.confidence,
    evidence:
      request.finding.evidence && request.finding.evidence.length > 0
        ? request.finding.evidence
        : [
            {
              confidence: request.finding.confidence,
              evidenceId: "ev_policy_test",
              kind: "repo_rule",
              summary: "Synthetic evidence for local policy testing.",
            },
          ],
    location: request.finding.location,
    severity: request.finding.severity,
    title: request.finding.title,
  };
}

/** Converts a typed repository rule to the admin API summary shape. */
function repoRuleSummaryFromRule(rule: RepoRule): AdminRepoRuleSummary {
  return {
    ruleId: rule.ruleId,
    repoRuleId: rule.ruleId,
    orgId: rule.orgId,
    ...(rule.repoId ? { repoId: rule.repoId } : {}),
    name: rule.name,
    ...(rule.description ? { description: rule.description } : {}),
    effect: rule.effect,
    matcher: rule.matcher,
    instruction: rule.instruction,
    priority: rule.priority,
    enabled: rule.enabled,
    ...(rule.createdByUserId ? { createdByUserId: rule.createdByUserId } : {}),
    scope: repoRuleScope(rule),
    ruleType: repoRuleType(rule),
    body: rule.instruction,
    isEnabled: rule.enabled,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

/** Returns a contract user ID from an admin actor when the provider ID already matches. */
function createdByUserIdFromAuditActor(
  actor: AdminActor,
): Pick<RepoRule, "createdByUserId"> | Record<string, never> {
  const parsed = safeParseWithSchema("UserId", UserIdSchema, actor.actorUserId);
  return parsed.ok ? { createdByUserId: parsed.value } : {};
}

/** Returns a contract user ID from an admin actor when it can be stored on org settings. */
function updatedByUserIdFromAuditActor(actor: AdminActor): string | null {
  const parsed = safeParseWithSchema("UserId", UserIdSchema, actor.actorUserId);
  return parsed.ok ? parsed.value : null;
}

/** Converts a compiled policy snapshot into the API preview shape. */
function policyPreviewFromResult(
  result: BuildReviewPolicySnapshotResult,
): AdminRepositoryPolicyPreview {
  return {
    effectivePolicy: result.snapshot.effectivePolicy,
    policyHash: result.snapshot.policyHash,
    policySnapshotId: result.snapshot.policySnapshotId,
    trace: result.trace,
    warnings: result.warnings,
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

/** Lists security events with strict filters and deterministic ordering. */
async function listSecurityEvents(
  db: HeimdallDatabase,
  query: AdminSecurityEventQuery,
): Promise<readonly AdminSecurityEventSummary[]> {
  const conditions: SQL[] = [];
  if (query.orgId) {
    conditions.push(eq(securityEvents.orgId, query.orgId));
  }
  if (query.repoId) {
    conditions.push(eq(securityEvents.repoId, query.repoId));
  }
  if (query.type) {
    conditions.push(eq(securityEvents.type, query.type));
  }
  if (query.severity) {
    conditions.push(eq(securityEvents.severity, query.severity));
  }
  if (query.source) {
    conditions.push(eq(securityEvents.source, query.source));
  }
  if (query.status) {
    conditions.push(eq(securityEvents.status, query.status));
  }
  if (query.actorId) {
    conditions.push(eq(securityEvents.actorId, query.actorId));
  }
  if (query.resourceType) {
    conditions.push(eq(securityEvents.resourceType, query.resourceType));
  }
  if (query.resourceId) {
    conditions.push(eq(securityEvents.resourceId, query.resourceId));
  }
  if (query.search) {
    const pattern = `%${query.search}%`;
    const searchCondition = or(
      ilike(securityEvents.securityEventId, pattern),
      ilike(securityEvents.type, pattern),
      ilike(securityEvents.severity, pattern),
      ilike(securityEvents.source, pattern),
      ilike(securityEvents.status, pattern),
      ilike(securityEvents.actorId, pattern),
      ilike(securityEvents.resourceType, pattern),
      ilike(securityEvents.resourceId, pattern),
      ilike(sql<string>`${securityEvents.metadata}::text`, pattern),
    );
    if (searchCondition) {
      conditions.push(searchCondition);
    }
  }

  const rows = await db
    .select()
    .from(securityEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(securityEvents.createdAt), desc(securityEvents.securityEventId))
    .limit(query.limit);

  return rows.map(toSecurityEventSummary);
}

/** Lists aggregated usage rows for an admin-visible scope and time period. */
async function listUsageSummary(
  db: HeimdallDatabase,
  query: AdminUsageQuery,
): Promise<AdminUsageSummary> {
  const conditions = usageConditions(query);
  const rows = await db
    .select({
      orgId: usageEvents.orgId,
      repoId: usageEvents.repoId,
      eventType: usageEvents.eventType,
      unit: usageEvents.unit,
      eventCount: sql<number>`count(*)::int`,
      quantity: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::int`,
      costMicros: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)::int`,
    })
    .from(usageEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(usageEvents.orgId, usageEvents.repoId, usageEvents.eventType, usageEvents.unit)
    .orderBy(
      desc(sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)::int`),
      desc(sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::int`),
    )
    .limit(query.limit);
  const rollups = rows.map((row) => ({
    orgId: row.orgId,
    ...(row.repoId ? { repoId: row.repoId } : {}),
    eventType: row.eventType,
    unit: row.unit,
    eventCount: row.eventCount,
    quantity: row.quantity,
    costMicros: row.costMicros,
  }));

  return {
    ...(query.periodStart ? { periodStart: query.periodStart } : {}),
    ...(query.periodEnd ? { periodEnd: query.periodEnd } : {}),
    rollups,
    totals: usageTotalsFromRollups(rollups),
  };
}

/** Gets customer-facing usage summary metrics for one scoped org or repository. */
async function getProductUsageSummary(
  db: HeimdallDatabase,
  query: ProductUsageSummaryQuery,
): Promise<ProductUsageSummary> {
  const conditions = productUsageConditions(query);
  const inputTokens = usageMetadataIntegerExpression("inputTokens");
  const outputTokens = usageMetadataIntegerExpression("outputTokens");
  const [row] = await db
    .select({
      embeddingTokens: sql<number>`coalesce(sum(case when ${usageEvents.eventType} = 'embedding.token' then ${usageEvents.quantity} else 0 end), 0)::int`,
      estimatedCostMicros: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)::int`,
      indexedCommits: sql<number>`coalesce(sum(case when ${usageEvents.eventType} = 'index.commit' then ${usageEvents.quantity} else 0 end), 0)::int`,
      reviewInputTokens: sql<number>`coalesce(sum(case when ${usageEvents.eventType} = 'llm.token' then ${inputTokens} else 0 end), 0)::int`,
      reviewOutputTokens: sql<number>`coalesce(sum(case when ${usageEvents.eventType} = 'llm.token' then ${outputTokens} else 0 end), 0)::int`,
      reviewRuns: sql<number>`coalesce(sum(case when ${usageEvents.eventType} = 'review.run' then ${usageEvents.quantity} else 0 end), 0)::int`,
    })
    .from(usageEvents)
    .where(and(...conditions));
  const totals = requireReturnedRow(row);
  const byRepo =
    query.groupBy === "repo" ? await listProductUsageByRepo(db, query, conditions) : undefined;

  return {
    ...(byRepo ? { byRepo } : {}),
    embeddingTokens: totals.embeddingTokens,
    estimatedCostUsd: microsToUsdString(totals.estimatedCostMicros),
    indexedCommits: totals.indexedCommits,
    reviewInputTokens: totals.reviewInputTokens,
    reviewOutputTokens: totals.reviewOutputTokens,
    reviewRuns: totals.reviewRuns,
  };
}

/** Lists repository usage metrics for the customer-facing by-repository breakdown. */
async function listProductUsageByRepo(
  db: HeimdallDatabase,
  query: ProductUsageSummaryQuery,
  conditions: readonly SQL[],
): Promise<readonly ProductUsageByRepoSummary[]> {
  const rows = await db
    .select({
      costMicros: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)::int`,
      repoId: usageEvents.repoId,
      repoName: repositories.fullName,
      reviewRuns: sql<number>`coalesce(sum(case when ${usageEvents.eventType} = 'review.run' then ${usageEvents.quantity} else 0 end), 0)::int`,
    })
    .from(usageEvents)
    .leftJoin(repositories, eq(repositories.repoId, usageEvents.repoId))
    .where(and(...conditions))
    .groupBy(usageEvents.repoId, repositories.fullName)
    .orderBy(desc(sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)::int`))
    .limit(query.limit);

  return rows.flatMap((row) =>
    row.repoId
      ? [
          {
            estimatedCostUsd: microsToUsdString(row.costMicros),
            repoId: row.repoId,
            repoName: row.repoName ?? row.repoId,
            reviewRuns: row.reviewRuns,
          },
        ]
      : [],
  );
}

/** Lists customer-facing usage ledger events for one scoped organization. */
async function listProductUsageEvents(
  db: HeimdallDatabase,
  query: ProductUsageEventsQuery,
): Promise<readonly ProductUsageEventSummary[]> {
  const conditions = productUsageConditions(query);
  if (query.eventType) {
    conditions.push(eq(usageEvents.eventType, query.eventType));
  }
  const rows = await db
    .select({
      costMicros: usageEvents.costMicros,
      eventType: usageEvents.eventType,
      metadata: usageEvents.metadata,
      occurredAt: usageEvents.occurredAt,
      orgId: usageEvents.orgId,
      quantity: usageEvents.quantity,
      repoId: usageEvents.repoId,
      reviewRunId: usageEvents.reviewRunId,
      unit: usageEvents.unit,
      usageEventId: usageEvents.usageEventId,
    })
    .from(usageEvents)
    .where(and(...conditions))
    .orderBy(desc(usageEvents.occurredAt), desc(usageEvents.usageEventId))
    .limit(query.limit);

  return rows.map(toProductUsageEventSummary);
}

/** Converts a usage event row into the customer-facing API shape. */
function toProductUsageEventSummary(row: {
  /** Stable usage event ID. */
  readonly usageEventId: string;
  /** Organization that owns the usage. */
  readonly orgId: string;
  /** Repository that caused the usage when available. */
  readonly repoId: string | null;
  /** Review run that caused the usage when available. */
  readonly reviewRunId: string | null;
  /** Usage event type. */
  readonly eventType: string;
  /** Signed quantity. */
  readonly quantity: number;
  /** Usage unit. */
  readonly unit: string;
  /** Signed internal cost estimate in micro-USD. */
  readonly costMicros: number;
  /** Event timestamp. */
  readonly occurredAt: Date;
  /** Event metadata. */
  readonly metadata: unknown;
}): ProductUsageEventSummary {
  const metadata = asOptionalRecord(row.metadata);
  return {
    costMicros: row.costMicros,
    eventType: row.eventType,
    ...(metadata ? { metadata } : {}),
    occurredAt: row.occurredAt.toISOString(),
    orgId: row.orgId,
    quantity: row.quantity,
    ...(row.repoId ? { repoId: row.repoId } : {}),
    ...(row.reviewRunId ? { reviewRunId: row.reviewRunId } : {}),
    unit: row.unit,
    usageEventId: row.usageEventId,
  };
}

/** Compiles plan and entitlement state for one organization. */
async function getEntitlementSummary(
  db: HeimdallDatabase,
  query: ScopedAdminEntitlementQuery,
): Promise<AdminEntitlementSummary> {
  const checkedAt = new Date().toISOString();
  const service = new DefaultEntitlementService(new PostgresEntitlementStore(db));
  const entitlementsForOrg = await service.getOrgEntitlements(query.orgId);
  const planSnapshot = await service.compilePlanSnapshot({
    entitlements: entitlementsForOrg,
    now: checkedAt,
    orgId: query.orgId,
  });
  const decisions = await Promise.all(
    query.featureKeys.map((featureKey) =>
      service.checkFeature({
        featureKey,
        now: checkedAt,
        orgId: query.orgId,
        snapshot: planSnapshot,
      }),
    ),
  );

  return {
    checkedAt,
    decisions,
    entitlements: entitlementsForOrg,
    orgId: query.orgId,
    planSnapshot,
  };
}

/** Gets local billing account, subscription, credit, invoice, and plan state. */
async function getBillingSummary(
  db: HeimdallDatabase,
  query: ScopedAdminBillingQuery,
): Promise<BillingSummary> {
  const service = new DefaultBillingService(new PostgresBillingStore(db));
  return service.getBillingSummary({ orgId: query.orgId });
}

/** Lists billing meter event rows for support debugging. */
async function listBillingMeterEvents(
  db: HeimdallDatabase,
  query: ScopedAdminBillingMeterEventsQuery,
): Promise<AdminBillingMeterEventsSummary> {
  const conditions: SQL[] = [eq(billingMeterEvents.orgId, query.orgId)];
  if (query.status) {
    conditions.push(eq(billingMeterEvents.status, query.status));
  }
  if (query.periodKey) {
    conditions.push(eq(billingMeterEvents.periodKey, query.periodKey));
  }

  const rows = await db
    .select()
    .from(billingMeterEvents)
    .where(and(...conditions))
    .orderBy(desc(billingMeterEvents.updatedAt), billingMeterEvents.billingMeterEventId)
    .limit(query.limit);

  return {
    meterEvents: rows.map(billingMeterEventSummaryFromRow),
    orgId: query.orgId,
    ...(query.periodKey ? { periodKey: query.periodKey } : {}),
    ...(query.status ? { status: query.status } : {}),
  };
}

/** Converts a billing meter event row into the support API shape. */
function billingMeterEventSummaryFromRow(row: {
  readonly billingMeterEventId: string;
  readonly billingAccountId: string;
  readonly orgId: string;
  readonly provider: string;
  readonly providerCustomerId: string;
  readonly meterKey: string;
  readonly providerEventName: string;
  readonly periodKey: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly quantity: number;
  readonly idempotencyKey: string;
  readonly status: string;
  readonly providerMeterEventId: string | null;
  readonly attemptCount: number;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly sourceUsageEventIds: unknown;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): AdminBillingMeterEventSummary {
  return {
    attemptCount: row.attemptCount,
    billingAccountId: row.billingAccountId,
    billingMeterEventId: row.billingMeterEventId,
    createdAt: row.createdAt.toISOString(),
    idempotencyKey: row.idempotencyKey,
    ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
    ...(row.lastErrorMessage ? { lastErrorMessage: row.lastErrorMessage } : {}),
    meterKey: row.meterKey,
    orgId: row.orgId,
    periodEnd: row.periodEnd.toISOString(),
    periodKey: row.periodKey,
    periodStart: row.periodStart.toISOString(),
    provider: row.provider,
    providerCustomerId: row.providerCustomerId,
    providerEventName: row.providerEventName,
    ...(row.providerMeterEventId ? { providerMeterEventId: row.providerMeterEventId } : {}),
    quantity: row.quantity,
    ...(row.sentAt ? { sentAt: row.sentAt.toISOString() } : {}),
    sourceUsageEventIds: stringListFromUnknown(row.sourceUsageEventIds),
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Gets billing drift, failed sync, and anomaly issues for one organization. */
async function getBillingReconciliation(
  db: HeimdallDatabase,
  query: ScopedAdminBillingReconciliationQuery,
): Promise<AdminBillingReconciliationSummary> {
  const checkedAt = new Date().toISOString();
  const [meterIssues, webhookIssues, providerRequestIssues, quotaIssues, usageIssues] =
    await Promise.all([
      listMeterSyncIssues(db, query, checkedAt),
      listBillingWebhookIssues(db, query),
      listProviderRequestIssues(db, query),
      listQuotaCounterIssues(db, query),
      listUsageAnomalyIssues(db, query),
    ]);
  const issues = [
    ...meterIssues,
    ...webhookIssues,
    ...providerRequestIssues,
    ...quotaIssues,
    ...usageIssues,
  ].sort(compareBillingReconciliationIssues);

  return {
    checkedAt,
    issues,
    orgId: query.orgId,
    ...(query.periodEnd ? { periodEnd: query.periodEnd } : {}),
    ...(query.periodKey ? { periodKey: query.periodKey } : {}),
    ...(query.periodStart ? { periodStart: query.periodStart } : {}),
  };
}

/** Lists failed or stale meter sync rows. */
async function listMeterSyncIssues(
  db: HeimdallDatabase,
  query: ScopedAdminBillingReconciliationQuery,
  checkedAt: string,
): Promise<readonly AdminBillingReconciliationIssue[]> {
  const lagCutoff = new Date(Date.parse(checkedAt) - query.meterLagMinutes * 60_000);
  const lagCondition = and(
    eq(billingMeterEvents.status, "ready_to_send"),
    lt(billingMeterEvents.updatedAt, lagCutoff),
  );
  const conditions: SQL[] = [
    eq(billingMeterEvents.orgId, query.orgId),
    or(eq(billingMeterEvents.status, "failed"), lagCondition ?? sql`false`) ?? sql`false`,
  ];
  if (query.periodKey) {
    conditions.push(eq(billingMeterEvents.periodKey, query.periodKey));
  }

  const rows = await db
    .select()
    .from(billingMeterEvents)
    .where(and(...conditions))
    .orderBy(desc(billingMeterEvents.updatedAt))
    .limit(query.limit);

  return rows.map((row) => ({
    category: row.status === "failed" ? "meter_sync_failed" : "meter_sync_lag",
    detail:
      row.status === "failed"
        ? (row.lastErrorMessage ?? "Meter event send failed.")
        : `Meter event has been ready since ${row.updatedAt.toISOString()}.`,
    occurredAt: row.updatedAt.toISOString(),
    resourceId: row.billingMeterEventId,
    resourceType: "billing_meter_event",
    severity: row.status === "failed" ? "critical" : "warning",
    title: `${row.meterKey} ${row.periodKey} ${row.status}`,
  }));
}

/** Lists failed inbound billing webhooks. */
async function listBillingWebhookIssues(
  db: HeimdallDatabase,
  query: ScopedAdminBillingReconciliationQuery,
): Promise<readonly AdminBillingReconciliationIssue[]> {
  const rows = await db
    .select()
    .from(billingWebhookEvents)
    .where(
      and(eq(billingWebhookEvents.orgId, query.orgId), eq(billingWebhookEvents.status, "failed")),
    )
    .orderBy(desc(billingWebhookEvents.receivedAt))
    .limit(query.limit);

  return rows.map((row) => ({
    category: "billing_webhook_failed",
    detail: stringFromUnknownRecord(row.error, "message") ?? "Billing webhook processing failed.",
    occurredAt: row.receivedAt.toISOString(),
    resourceId: row.billingWebhookEventId,
    resourceType: "billing_webhook_event",
    severity: "critical",
    title: row.eventType,
  }));
}

/** Lists failed outbound billing provider requests. */
async function listProviderRequestIssues(
  db: HeimdallDatabase,
  query: ScopedAdminBillingReconciliationQuery,
): Promise<readonly AdminBillingReconciliationIssue[]> {
  const billingRepository = new BillingRepository(db);
  const rows = await billingRepository.listFailedBillingProviderRequests({
    limit: query.limit,
    orgId: query.orgId,
  });

  return rows.map((row) => ({
    category: "provider_request_failed",
    detail: row.errorMessage ?? "Billing provider request failed.",
    occurredAt: row.completedAt?.toISOString() ?? row.startedAt.toISOString(),
    resourceId: row.billingProviderRequestId,
    resourceType: "billing_provider_request",
    severity: "warning",
    title: `${row.provider}.${row.operation}`,
  }));
}

/** Lists monthly review credit quota counters that drift from usage ledger totals. */
async function listQuotaCounterIssues(
  db: HeimdallDatabase,
  query: ScopedAdminBillingReconciliationQuery,
): Promise<readonly AdminBillingReconciliationIssue[]> {
  const conditions: SQL[] = [
    eq(quotaCounters.orgId, query.orgId),
    eq(quotaCounters.quotaKey, "monthly_review_credits"),
  ];
  if (query.periodKey) {
    conditions.push(eq(quotaCounters.periodKey, query.periodKey));
  }
  const counters = await db
    .select()
    .from(quotaCounters)
    .where(and(...conditions))
    .orderBy(desc(quotaCounters.periodStart))
    .limit(query.limit);

  const issues: readonly (AdminBillingReconciliationIssue | undefined)[] = await Promise.all(
    counters.map(async (counter) => {
      const [usage] = await db
        .select({
          quantity: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::int`,
        })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.orgId, counter.orgId),
            eq(usageEvents.eventType, "review.credit"),
            eq(usageEvents.unit, "credit"),
            gte(usageEvents.occurredAt, counter.periodStart),
            lt(usageEvents.occurredAt, counter.periodEnd),
          ),
        );
      const usageQuantity = usage?.quantity ?? 0;
      if (usageQuantity === counter.usedQuantity) {
        return undefined;
      }

      return {
        category: "quota_counter_drift",
        detail: `Counter used ${counter.usedQuantity}; usage ledger sums to ${usageQuantity}.`,
        occurredAt: counter.updatedAt.toISOString(),
        resourceId: counter.quotaCounterId,
        resourceType: "quota_counter",
        severity: "warning",
        title: `Review credit counter drift for ${counter.periodKey}`,
      } satisfies AdminBillingReconciliationIssue;
    }),
  );

  return issues.filter((issue): issue is AdminBillingReconciliationIssue => Boolean(issue));
}

/** Lists usage rollups with high cost or negative usage totals. */
async function listUsageAnomalyIssues(
  db: HeimdallDatabase,
  query: ScopedAdminBillingReconciliationQuery,
): Promise<readonly AdminBillingReconciliationIssue[]> {
  const conditions: SQL[] = [eq(usageEvents.orgId, query.orgId)];
  if (query.periodStart) {
    conditions.push(gte(usageEvents.occurredAt, new Date(query.periodStart)));
  }
  if (query.periodEnd) {
    conditions.push(lt(usageEvents.occurredAt, new Date(query.periodEnd)));
  }
  const rows = await db
    .select({
      costMicros: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)::int`,
      eventType: usageEvents.eventType,
      quantity: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::int`,
      unit: usageEvents.unit,
    })
    .from(usageEvents)
    .where(and(...conditions))
    .groupBy(usageEvents.eventType, usageEvents.unit)
    .having(
      or(
        sql`abs(coalesce(sum(${usageEvents.costMicros}), 0)) >= ${query.costAnomalyMicros}`,
        sql`coalesce(sum(${usageEvents.quantity}), 0) < 0`,
      ),
    )
    .orderBy(desc(sql<number>`abs(coalesce(sum(${usageEvents.costMicros}), 0))`))
    .limit(query.limit);

  return rows.map((row) => ({
    category: "usage_cost_anomaly",
    detail: `Quantity ${row.quantity}; internal cost ${(row.costMicros / 1_000_000).toFixed(4)} USD.`,
    occurredAt: new Date().toISOString(),
    resourceType: "usage_event_rollup",
    severity: Math.abs(row.costMicros) >= query.costAnomalyMicros ? "warning" : "critical",
    title: `${row.eventType} ${row.unit}`,
  }));
}

/** Enqueues a durable billing reconciliation repair job. */
async function enqueueBillingReconciliation(
  db: HeimdallDatabase,
  query: AdminBillingReconciliationEnqueueRequest,
): Promise<AdminBillingReconciliationRunSummary> {
  const payload = billingReconciliationJobPayload(query);
  const jobKey = [
    "admin:billing:reconcile",
    query.orgId,
    payload.provider ?? "stripe",
    payload.periodKey ?? payload.periodStart ?? "current",
  ].join(":");
  const envelope = {
    attempt: 0,
    createdAt: new Date().toISOString(),
    idempotencyKey: jobKey,
    jobId: stablePrefixedId("job", ["billing_reconcile", jobKey]),
    jobType: JOB_TYPES.BillingReconcile,
    maxAttempts: 3,
    payload,
    schemaVersion: "billing_reconcile_job.v1",
    ...(query.traceContext ? { traceContext: query.traceContext } : {}),
  };
  const { job } = await new BackgroundJobRepository(db).insertBackgroundJob({
    backgroundJobId: stablePrefixedId("job", ["background_job", jobKey]),
    envelope,
    metadata: {
      ...(query.requestId ? { requestId: query.requestId } : {}),
      source: "admin_billing_reconciliation",
    },
    orgId: query.orgId,
    queueName: QUEUE_NAMES.billing,
  });

  return toAdminBackgroundJobRunSummary(job);
}

/** Builds a contract-compatible billing reconciliation job payload. */
function billingReconciliationJobPayload(
  query: ScopedAdminBillingReconciliationQuery,
): BillingReconcileJobPayload {
  return {
    limit: query.limit,
    orgId: query.orgId,
    ...(query.periodEnd ? { periodEnd: query.periodEnd } : {}),
    ...(query.periodKey ? { periodKey: query.periodKey } : {}),
    ...(query.periodStart ? { periodStart: query.periodStart } : {}),
    provider: "stripe",
  };
}

/** Creates a provider checkout session for one scoped organization. */
async function createBillingCheckoutSession(
  db: HeimdallDatabase,
  billingProvider: BillingProvider,
  request: ScopedAdminBillingCheckoutRequest,
): Promise<CheckoutSessionRef> {
  const summary = await getBillingSummary(db, request);
  const providerCustomerId = await ensureBillingProviderCustomer(
    db,
    billingProvider,
    summary.billingAccount,
  );

  return billingProvider.createCheckoutSession({
    billingAccountId: summary.billingAccount.billingAccountId,
    cancelUrl: request.cancelUrl,
    idempotencyKey: request.idempotencyKey,
    metadata: {
      billingAccountId: summary.billingAccount.billingAccountId,
      orgId: request.orgId,
      planKey: request.planKey,
    },
    orgId: request.orgId,
    planKey: request.planKey,
    providerCustomerId,
    ...(request.quantity ? { quantity: request.quantity } : {}),
    successUrl: request.successUrl,
  });
}

/** Creates a provider customer portal session for one scoped organization. */
async function createBillingPortalSession(
  db: HeimdallDatabase,
  billingProvider: BillingProvider,
  request: ScopedAdminBillingPortalRequest,
): Promise<PortalSessionRef> {
  const summary = await getBillingSummary(db, request);
  const providerCustomerId = await ensureBillingProviderCustomer(
    db,
    billingProvider,
    summary.billingAccount,
  );

  return billingProvider.createCustomerPortalSession({
    billingAccountId: summary.billingAccount.billingAccountId,
    idempotencyKey: request.idempotencyKey,
    orgId: request.orgId,
    providerCustomerId,
    returnUrl: request.returnUrl,
  });
}

/** Ensures a local billing account has a provider customer ID before a provider flow starts. */
async function ensureBillingProviderCustomer(
  db: HeimdallDatabase,
  billingProvider: BillingProvider,
  billingAccount: BillingSummary["billingAccount"],
): Promise<string> {
  if (billingAccount.providerCustomerId) {
    return billingAccount.providerCustomerId;
  }

  const customer = await billingProvider.createCustomer({
    billingAccountId: billingAccount.billingAccountId,
    idempotencyKey: billingProviderIdempotencyKey("admin.billing.customer", [
      billingAccount.orgId,
      billingAccount.billingAccountId,
    ]),
    metadata: {
      billingAccountId: billingAccount.billingAccountId,
      orgId: billingAccount.orgId,
    },
    orgId: billingAccount.orgId,
    ...(billingAccount.billingEmail ? { billingEmail: billingAccount.billingEmail } : {}),
    ...(billingAccount.billingName ? { billingName: billingAccount.billingName } : {}),
  });

  await db
    .update(billingAccounts)
    .set({
      billingMode: "self_serve",
      provider: customer.provider,
      providerCustomerId: customer.providerCustomerId,
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.billingAccountId, billingAccount.billingAccountId));

  return customer.providerCustomerId;
}

/** Requires billing provider configuration for mutation routes. */
function requireBillingProvider(provider: BillingProvider | undefined): BillingProvider {
  if (!provider) {
    throw new AdminControlPlaneConfigurationError(
      "admin.billing_provider_not_configured",
      "Billing provider configuration is required for checkout and portal sessions.",
    );
  }

  return provider;
}

/** Creates the configured billing provider from environment variables. */
function createBillingProviderFromEnv(db: HeimdallDatabase): BillingProvider | undefined {
  if (process.env.HEIMDALL_BILLING_PROVIDER === "fake") {
    return new FakeBillingProvider({
      ...(process.env.HEIMDALL_FAKE_BILLING_BASE_URL
        ? { baseUrl: process.env.HEIMDALL_FAKE_BILLING_BASE_URL }
        : {}),
    });
  }

  const apiKey = process.env.STRIPE_SECRET_KEY;
  const checkoutPriceByPlanKey = stripeCheckoutPriceMapFromEnv(
    process.env.HEIMDALL_STRIPE_CHECKOUT_PRICE_MAP,
  );
  if (!apiKey || Object.keys(checkoutPriceByPlanKey).length === 0) {
    return undefined;
  }

  return new StripeBillingProvider({
    apiKey,
    checkoutPriceByPlanKey,
    requestLogger: new PostgresBillingProviderRequestLogger(db),
    ...(process.env.STRIPE_WEBHOOK_SECRET
      ? { webhookSecret: process.env.STRIPE_WEBHOOK_SECRET }
      : {}),
  });
}

/** Creates the default billing webhook processor. */
function createBillingWebhookProcessor(dependencies: {
  /** Database used to record and apply billing webhooks. */
  readonly db: HeimdallDatabase;
  /** Lazy provider factory used for signature verification and provider refreshes. */
  readonly getBillingProvider: BillingProviderFactory;
}): BillingWebhookProcessor {
  return {
    processStripeWebhook: (input) =>
      processStripeBillingWebhook(
        dependencies.db,
        requireBillingProvider(dependencies.getBillingProvider()),
        input,
      ),
  };
}

/** Verifies, records, and applies one Stripe webhook event. */
async function processStripeBillingWebhook(
  db: HeimdallDatabase,
  billingProvider: BillingProvider,
  input: ProcessBillingWebhookInput,
): Promise<ProcessBillingWebhookResult> {
  const parsed = await parseBillingWebhookForRoute(billingProvider, input);
  const initialAccount = await findBillingAccountForWebhook(db, parsed);
  const billingWebhookEventId = stablePrefixedId("bwh", [parsed.provider, parsed.providerEventId]);
  const payloadHash = createHash("sha256").update(input.rawBody).digest("hex");
  const existing = await getBillingWebhookEvent(db, parsed.provider, parsed.providerEventId);
  if (existing?.status === "processed" || existing?.status === "ignored") {
    return billingWebhookResult(parsed, existing.status, true, {
      ...(existing.billingAccountId ? { billingAccountId: existing.billingAccountId } : {}),
      ...(existing.orgId ? { orgId: existing.orgId } : {}),
    });
  }

  if (!existing) {
    await db
      .insert(billingWebhookEvents)
      .values({
        billingAccountId: initialAccount?.billingAccountId ?? null,
        billingWebhookEventId,
        eventType: parsed.eventType,
        orgId: initialAccount?.orgId ?? null,
        payload: parsed.rawEvent,
        payloadHash,
        provider: parsed.provider,
        providerCustomerId:
          parsed.relatedProviderCustomerId ?? parsed.subscription?.providerCustomerId ?? null,
        providerEventId: parsed.providerEventId,
        providerSubscriptionId:
          parsed.relatedProviderSubscriptionId ??
          parsed.subscription?.providerSubscriptionId ??
          null,
        status: "received",
      })
      .onConflictDoNothing();
  }

  try {
    const outcome = await applyBillingWebhookEvent(db, billingProvider, parsed, initialAccount);
    await db
      .update(billingWebhookEvents)
      .set({
        billingAccountId: outcome.billingAccountId ?? initialAccount?.billingAccountId ?? null,
        error: null,
        orgId: outcome.orgId ?? initialAccount?.orgId ?? null,
        processedAt: new Date(),
        status: outcome.status,
      })
      .where(eq(billingWebhookEvents.billingWebhookEventId, billingWebhookEventId));

    return billingWebhookResult(parsed, outcome.status, false, outcome);
  } catch (error) {
    await db
      .update(billingWebhookEvents)
      .set({
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
        processedAt: new Date(),
        status: "failed",
      })
      .where(eq(billingWebhookEvents.billingWebhookEventId, billingWebhookEventId));
    throw error;
  }
}

/** Parses one billing webhook and maps provider parser failures to route-safe errors. */
async function parseBillingWebhookForRoute(
  billingProvider: BillingProvider,
  input: ProcessBillingWebhookInput,
): Promise<ParsedBillingWebhookEvent> {
  try {
    return await billingProvider.parseWebhook(input);
  } catch (error) {
    throw new BillingWebhookProcessingError(
      "webhook.invalid_signature",
      error instanceof Error ? error.message : "Billing webhook signature verification failed.",
      400,
    );
  }
}

/** Applies one parsed billing webhook event to local billing mirrors. */
async function applyBillingWebhookEvent(
  db: HeimdallDatabase,
  billingProvider: BillingProvider,
  parsed: ParsedBillingWebhookEvent,
  initialAccount: BillingAccountRow | undefined,
): Promise<{
  readonly status: "processed" | "ignored";
  readonly orgId?: string;
  readonly billingAccountId?: string;
}> {
  const account = initialAccount ?? (await findBillingAccountForWebhook(db, parsed));
  const invoice = stripeInvoiceFromWebhookEvent(parsed);
  if (invoice && account) {
    await upsertInvoiceMirror(db, account, parsed.provider, invoice);
    await updateBillingAccountPaymentStatus(
      db,
      account,
      paymentStatusFromInvoice(parsed.eventType),
    );
    return {
      billingAccountId: account.billingAccountId,
      orgId: account.orgId,
      status: "processed",
    };
  }

  const subscription =
    parsed.subscription ??
    (await retrieveRelatedProviderSubscription(billingProvider, parsed, account));
  if (subscription && account) {
    await upsertSubscriptionMirror(db, account, subscription);
    return {
      billingAccountId: account.billingAccountId,
      orgId: account.orgId,
      status: "processed",
    };
  }

  if (account && parsed.eventType.startsWith("customer.")) {
    await updateBillingAccountFromCustomerWebhook(
      db,
      account,
      billingWebhookObject(parsed.rawEvent),
    );
    return {
      billingAccountId: account.billingAccountId,
      orgId: account.orgId,
      status: "processed",
    };
  }

  return {
    ...(account ? { billingAccountId: account.billingAccountId, orgId: account.orgId } : {}),
    status: "ignored",
  };
}

type BillingAccountRow = typeof billingAccounts.$inferSelect;

/** Finds the local billing account linked to a parsed provider webhook. */
async function findBillingAccountForWebhook(
  db: HeimdallDatabase,
  parsed: ParsedBillingWebhookEvent,
): Promise<BillingAccountRow | undefined> {
  const providerCustomerId =
    parsed.relatedProviderCustomerId ?? parsed.subscription?.providerCustomerId;
  if (!providerCustomerId) {
    return undefined;
  }

  const [account] = await db
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.providerCustomerId, providerCustomerId))
    .limit(1);
  return account;
}

/** Gets an existing billing webhook event row by provider event identity. */
async function getBillingWebhookEvent(
  db: HeimdallDatabase,
  provider: string,
  providerEventId: string,
): Promise<typeof billingWebhookEvents.$inferSelect | undefined> {
  const [event] = await db
    .select()
    .from(billingWebhookEvents)
    .where(
      and(
        eq(billingWebhookEvents.provider, provider),
        eq(billingWebhookEvents.providerEventId, providerEventId),
      ),
    )
    .limit(1);
  return event;
}

/** Retrieves related subscription state from the provider when a webhook only carries an ID. */
async function retrieveRelatedProviderSubscription(
  billingProvider: BillingProvider,
  parsed: ParsedBillingWebhookEvent,
  account: BillingAccountRow | undefined,
): Promise<ProviderSubscription | undefined> {
  if (!parsed.relatedProviderSubscriptionId || !account) {
    return undefined;
  }

  return billingProvider.getSubscription({
    billingAccountId: account.billingAccountId,
    orgId: account.orgId,
    providerSubscriptionId: parsed.relatedProviderSubscriptionId,
  });
}

/** Upserts the local subscription mirror from provider state. */
async function upsertSubscriptionMirror(
  db: HeimdallDatabase,
  account: BillingAccountRow,
  subscription: ProviderSubscription,
): Promise<void> {
  const billingPlanVersionId = subscription.planKey
    ? await getActiveBillingPlanVersionId(db, subscription.planKey)
    : account.currentPlanVersionId;
  const status = subscriptionStatus(subscription.status);
  const paymentStatus = paymentStatusFromSubscription(status);
  const now = new Date();

  await db
    .insert(subscriptions)
    .values({
      billingAccountId: account.billingAccountId,
      billingPlanVersionId: billingPlanVersionId ?? null,
      currentPeriodEnd: dateFromIso(subscription.currentPeriodEnd),
      currentPeriodStart: dateFromIso(subscription.currentPeriodStart),
      provider: subscription.provider,
      providerSubscriptionId: subscription.providerSubscriptionId,
      quantity: subscription.quantity ?? null,
      rawProviderStatus: subscription.rawProviderStatus,
      status,
      subscriptionId: stablePrefixedId("sub", [
        subscription.provider,
        subscription.providerSubscriptionId,
      ]),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [subscriptions.provider, subscriptions.providerSubscriptionId],
      set: {
        billingPlanVersionId: billingPlanVersionId ?? null,
        currentPeriodEnd: dateFromIso(subscription.currentPeriodEnd),
        currentPeriodStart: dateFromIso(subscription.currentPeriodStart),
        quantity: subscription.quantity ?? null,
        rawProviderStatus: subscription.rawProviderStatus,
        status,
        updatedAt: now,
      },
    });

  await db
    .update(billingAccounts)
    .set({
      billingMode: "self_serve",
      currentPlanKey: subscription.planKey ?? account.currentPlanKey,
      currentPlanVersionId: billingPlanVersionId ?? account.currentPlanVersionId,
      paymentStatus,
      provider: subscription.provider,
      providerCustomerId: subscription.providerCustomerId,
      status: billingAccountStatusFromSubscription(status),
      updatedAt: now,
    })
    .where(eq(billingAccounts.billingAccountId, account.billingAccountId));
}

/** Gets the active plan version ID for a local plan key. */
async function getActiveBillingPlanVersionId(
  db: HeimdallDatabase,
  planKey: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ billingPlanVersionId: billingPlanVersions.billingPlanVersionId })
    .from(billingPlanVersions)
    .innerJoin(billingPlans, eq(billingPlanVersions.billingPlanId, billingPlans.billingPlanId))
    .where(and(eq(billingPlans.planKey, planKey), eq(billingPlanVersions.active, true)))
    .limit(1);
  return row?.billingPlanVersionId;
}

/** Upserts the local invoice mirror from a provider invoice object. */
async function upsertInvoiceMirror(
  db: HeimdallDatabase,
  account: BillingAccountRow,
  provider: string,
  invoice: StripeInvoiceMirror,
): Promise<void> {
  const now = new Date();
  await db
    .insert(invoices)
    .values({
      amountDueMicros: invoice.amountDueMicros,
      amountPaidMicros: invoice.amountPaidMicros,
      amountRemainingMicros: invoice.amountRemainingMicros,
      billingAccountId: account.billingAccountId,
      currency: invoice.currency,
      hostedInvoiceUrl: invoice.hostedInvoiceUrl ?? null,
      invoiceId: stablePrefixedId("inv", [provider, invoice.providerInvoiceId]),
      invoicePdfUrl: invoice.invoicePdfUrl ?? null,
      periodEnd: dateFromIso(invoice.periodEnd),
      periodStart: dateFromIso(invoice.periodStart),
      provider,
      providerInvoiceId: invoice.providerInvoiceId,
      rawProviderInvoice: invoice.rawProviderInvoice,
      status: invoice.status,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [invoices.provider, invoices.providerInvoiceId],
      set: {
        amountDueMicros: invoice.amountDueMicros,
        amountPaidMicros: invoice.amountPaidMicros,
        amountRemainingMicros: invoice.amountRemainingMicros,
        hostedInvoiceUrl: invoice.hostedInvoiceUrl ?? null,
        invoicePdfUrl: invoice.invoicePdfUrl ?? null,
        periodEnd: dateFromIso(invoice.periodEnd),
        periodStart: dateFromIso(invoice.periodStart),
        rawProviderInvoice: invoice.rawProviderInvoice,
        status: invoice.status,
        updatedAt: now,
      },
    });
}

/** Updates billing-account payment status from a provider invoice event. */
async function updateBillingAccountPaymentStatus(
  db: HeimdallDatabase,
  account: BillingAccountRow,
  paymentStatus: string | undefined,
): Promise<void> {
  if (!paymentStatus) {
    return;
  }

  await db
    .update(billingAccounts)
    .set({
      paymentStatus,
      status: paymentStatus === "current" ? "active" : account.status,
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.billingAccountId, account.billingAccountId));
}

/** Updates safe customer contact fields from a customer webhook object. */
async function updateBillingAccountFromCustomerWebhook(
  db: HeimdallDatabase,
  account: BillingAccountRow,
  object: Record<string, unknown>,
): Promise<void> {
  await db
    .update(billingAccounts)
    .set({
      billingEmail: stringField(object, "email") ?? account.billingEmail,
      billingName: stringField(object, "name") ?? account.billingName,
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.billingAccountId, account.billingAccountId));
}

/** Builds a route result from a parsed webhook and processing status. */
function billingWebhookResult(
  parsed: ParsedBillingWebhookEvent,
  status: "processed" | "ignored",
  duplicate: boolean,
  context: { readonly orgId?: string; readonly billingAccountId?: string },
): ProcessBillingWebhookResult {
  return {
    duplicate,
    eventType: parsed.eventType,
    provider: parsed.provider,
    providerEventId: parsed.providerEventId,
    status: duplicate ? "duplicate" : status,
    ...(context.billingAccountId ? { billingAccountId: context.billingAccountId } : {}),
    ...(context.orgId ? { orgId: context.orgId } : {}),
  };
}

/** Provider invoice fields needed by the local invoice mirror. */
type StripeInvoiceMirror = {
  /** Provider invoice ID. */
  readonly providerInvoiceId: string;
  /** Local invoice status. */
  readonly status: "draft" | "open" | "paid" | "uncollectible" | "void" | "deleted";
  /** Lowercase ISO currency code. */
  readonly currency: string;
  /** Amount due in micros. */
  readonly amountDueMicros: number;
  /** Amount paid in micros. */
  readonly amountPaidMicros: number;
  /** Amount remaining in micros. */
  readonly amountRemainingMicros: number;
  /** Invoice period start. */
  readonly periodStart?: string;
  /** Invoice period end. */
  readonly periodEnd?: string;
  /** Hosted invoice URL. */
  readonly hostedInvoiceUrl?: string;
  /** Invoice PDF URL. */
  readonly invoicePdfUrl?: string;
  /** Safe raw provider invoice fields. */
  readonly rawProviderInvoice: Record<string, unknown>;
};

/** Extracts a provider invoice mirror from a parsed webhook event when possible. */
function stripeInvoiceFromWebhookEvent(
  parsed: ParsedBillingWebhookEvent,
): StripeInvoiceMirror | undefined {
  if (!parsed.eventType.startsWith("invoice.")) {
    return undefined;
  }

  const object = billingWebhookObject(parsed.rawEvent);
  const providerInvoiceId = stringField(object, "id");
  const status = invoiceStatus(stringField(object, "status"), parsed.eventType);
  const currency = stringField(object, "currency")?.toLowerCase();
  if (!providerInvoiceId || !status || !currency) {
    return undefined;
  }

  return {
    amountDueMicros: stripeAmountToMicros(integerField(object, "amount_due")),
    amountPaidMicros: stripeAmountToMicros(integerField(object, "amount_paid")),
    amountRemainingMicros: stripeAmountToMicros(integerField(object, "amount_remaining")),
    currency,
    providerInvoiceId,
    rawProviderInvoice: {
      amount_due: integerField(object, "amount_due"),
      amount_paid: integerField(object, "amount_paid"),
      amount_remaining: integerField(object, "amount_remaining"),
      currency,
      status,
    },
    status,
    ...optionalIsoFromUnixProperty("periodStart", integerField(object, "period_start")),
    ...optionalIsoFromUnixProperty("periodEnd", integerField(object, "period_end")),
    ...optionalStringResult("hostedInvoiceUrl", stringField(object, "hosted_invoice_url")),
    ...optionalStringResult("invoicePdfUrl", stringField(object, "invoice_pdf")),
  };
}

/** Reads the provider object from a webhook event envelope. */
function billingWebhookObject(rawEvent: Record<string, unknown>): Record<string, unknown> {
  const data = asRecord(rawEvent.data);
  return asRecord(data.object);
}

/** Maps Stripe subscription status into local allowed subscription states. */
function subscriptionStatus(status: string): string {
  switch (status) {
    case "active":
    case "incomplete":
    case "incomplete_expired":
    case "past_due":
    case "paused":
    case "trialing":
    case "unpaid":
      return status;
    case "canceled":
      return "cancelled";
    default:
      return "past_due";
  }
}

/** Maps local subscription status into billing account status. */
function billingAccountStatusFromSubscription(status: string): string {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "cancelled":
      return "cancelled";
    case "past_due":
    case "unpaid":
      return "past_due";
    default:
      return "manual_review";
  }
}

/** Maps local subscription status into payment status. */
function paymentStatusFromSubscription(status: string): string {
  switch (status) {
    case "active":
    case "trialing":
      return "current";
    case "cancelled":
      return "not_required";
    case "past_due":
    case "unpaid":
      return "past_due";
    default:
      return "failed";
  }
}

/** Maps invoice webhook type into a billing-account payment status patch. */
function paymentStatusFromInvoice(eventType: string): string | undefined {
  switch (eventType) {
    case "invoice.paid":
      return "current";
    case "invoice.payment_failed":
      return "past_due";
    case "invoice.marked_uncollectible":
      return "failed";
    default:
      return undefined;
  }
}

/** Maps Stripe invoice status into local allowed invoice states. */
function invoiceStatus(
  status: string | undefined,
  eventType: string,
): StripeInvoiceMirror["status"] | undefined {
  switch (status) {
    case "draft":
    case "open":
    case "paid":
    case "uncollectible":
    case "void":
      return status;
    default:
      return eventType === "invoice.deleted" ? "deleted" : undefined;
  }
}

/** Converts Stripe minor-unit amounts to micros. */
function stripeAmountToMicros(amount: number | undefined): number {
  return (amount ?? 0) * 10_000;
}

/** Converts an optional ISO timestamp into a Date or null for SQL writes. */
function dateFromIso(value: string | undefined): Date | null {
  return value ? new Date(value) : null;
}

/** Returns a stable prefixed identifier from non-secret parts. */
function stablePrefixedId(prefix: string, parts: readonly unknown[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

/** Narrows unknown JSON to a plain record. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/** Returns unique non-empty strings while preserving input order. */
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/** Reads a non-empty string field from a JSON record. */
function stringField(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads a string or number field from a JSON record as text. */
function stringOrNumberField(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }

  return undefined;
}

/** Reads a safe integer field from a JSON record. */
function integerField(object: Record<string, unknown>, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** Returns an optional string property for result objects. */
function optionalStringResult<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]?: string } {
  return (value ? { [key]: value } : {}) as { readonly [Property in Key]?: string };
}

/** Returns an optional ISO timestamp property converted from Unix seconds. */
function optionalIsoFromUnixProperty<Key extends string>(
  key: Key,
  seconds: number | undefined,
): { readonly [Property in Key]?: string } {
  return (seconds === undefined ? {} : { [key]: new Date(seconds * 1_000).toISOString() }) as {
    readonly [Property in Key]?: string;
  };
}

/** Parses Stripe Checkout price IDs keyed by local plan key from an environment variable. */
function stripeCheckoutPriceMapFromEnv(
  rawValue: string | undefined,
): Readonly<Record<string, string>> {
  if (!rawValue) {
    return {};
  }

  const value = parseJsonObjectEnv(rawValue, "HEIMDALL_STRIPE_CHECKOUT_PRICE_MAP") as Record<
    string,
    unknown
  >;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminControlPlaneConfigurationError(
      "admin.billing_provider_misconfigured",
      "HEIMDALL_STRIPE_CHECKOUT_PRICE_MAP must be a JSON object of plan keys to Stripe price IDs.",
    );
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] =>
      typeof entry[0] === "string" &&
      entry[0].length > 0 &&
      typeof entry[1] === "string" &&
      entry[1].length > 0,
  );
  if (entries.length !== Object.keys(value).length) {
    throw new AdminControlPlaneConfigurationError(
      "admin.billing_provider_misconfigured",
      "HEIMDALL_STRIPE_CHECKOUT_PRICE_MAP values must be non-empty Stripe price ID strings.",
    );
  }

  return Object.fromEntries(entries);
}

/** Parses one JSON object environment variable into unknown JSON. */
function parseJsonObjectEnv(rawValue: string, name: string): unknown {
  try {
    return JSON.parse(rawValue) as unknown;
  } catch {
    throw new AdminControlPlaneConfigurationError(
      "admin.billing_provider_misconfigured",
      `${name} must contain valid JSON.`,
    );
  }
}

/** Durable logger for outbound billing provider requests. */
class PostgresBillingProviderRequestLogger implements BillingProviderRequestLogger {
  private readonly billingRepository: BillingRepository;

  /** Creates a Postgres-backed provider request logger. */
  public constructor(db: HeimdallDatabase) {
    this.billingRepository = new BillingRepository(db);
  }

  /** Records one provider request outcome. */
  public async record(input: BillingProviderRequestLogInput): Promise<void> {
    await this.billingRepository.recordBillingProviderRequest(input);
  }
}

/** Builds SQL predicates for admin usage rollups. */
function usageConditions(query: AdminUsageQuery): SQL[] {
  const conditions: SQL[] = [];
  const scopedCondition = scopedUsageConditions(query);
  if (scopedCondition) {
    conditions.push(scopedCondition);
  }
  if (query.orgId) {
    conditions.push(eq(usageEvents.orgId, query.orgId));
  }
  if (query.repoId) {
    conditions.push(eq(usageEvents.repoId, query.repoId));
  }
  if (query.periodStart) {
    conditions.push(sql`${usageEvents.occurredAt} >= ${new Date(query.periodStart)}`);
  }
  if (query.periodEnd) {
    conditions.push(sql`${usageEvents.occurredAt} < ${new Date(query.periodEnd)}`);
  }

  return conditions;
}

/** Builds SQL predicates for product usage endpoints. */
function productUsageConditions(query: ProductUsageSummaryQuery | ProductUsageEventsQuery): SQL[] {
  const conditions: SQL[] = [eq(usageEvents.orgId, query.orgId)];
  if (query.repoId) {
    conditions.push(eq(usageEvents.repoId, query.repoId));
  }
  if (query.periodStart) {
    conditions.push(gte(usageEvents.occurredAt, new Date(query.periodStart)));
  }
  if (query.periodEnd) {
    conditions.push(lt(usageEvents.occurredAt, new Date(query.periodEnd)));
  }

  return conditions;
}

/** Builds an actor-scope predicate for usage rows. */
function scopedUsageConditions(query: AdminUsageQuery): SQL | undefined {
  const orgIds = query.orgIds ?? [];
  const repoIds = query.repoIds ?? [];
  const hasExplicitScope = query.orgIds !== undefined || query.repoIds !== undefined;
  if (orgIds.includes("*") || repoIds.includes("*")) {
    return undefined;
  }

  const conditions: SQL[] = [];
  if (orgIds.length > 0) {
    conditions.push(inArray(usageEvents.orgId, [...orgIds]));
  }
  if (repoIds.length > 0) {
    conditions.push(inArray(usageEvents.repoId, [...repoIds]));
  }
  if (conditions.length === 0) {
    return hasExplicitScope ? sql`false` : undefined;
  }

  const [condition] = conditions;
  return conditions.length === 1 ? (condition ?? sql`false`) : or(...conditions);
}

/** Reads one integer field from usage event JSON metadata without trusting malformed values. */
function usageMetadataIntegerExpression(field: "inputTokens" | "outputTokens"): SQL<number> {
  return sql<number>`case when (${usageEvents.metadata}->>${field}) ~ '^-?[0-9]+$' then (${usageEvents.metadata}->>${field})::int else 0 end`;
}

/** Computes dashboard totals from usage rollup rows. */
function usageTotalsFromRollups(rollups: readonly AdminUsageRollupSummary[]): AdminUsageTotals {
  return {
    eventCount: rollups.reduce((sum, rollup) => sum + rollup.eventCount, 0),
    costMicros: rollups.reduce((sum, rollup) => sum + rollup.costMicros, 0),
    reviewCount: rollups
      .filter((rollup) => rollup.eventType === "review.run")
      .reduce((sum, rollup) => sum + rollup.quantity, 0),
    llmTokens: rollups
      .filter((rollup) => rollup.eventType === "llm.token")
      .reduce((sum, rollup) => sum + rollup.quantity, 0),
  };
}

/** Formats an internal micro-USD amount as a fixed decimal USD string. */
function microsToUsdString(costMicros: number): string {
  return (costMicros / 1_000_000).toFixed(6);
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
  const supportSessionSecret =
    options?.supportSessionSecret ??
    process.env.HEIMDALL_ADMIN_SUPPORT_SESSION_SECRET ??
    sessionSecret;
  const sessionCookieName = options?.cookieName ?? "heimdall_admin_session";
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
  const rateLimitMaxRequests =
    options?.rateLimit?.maxRequests ??
    optionalPositiveInteger(process.env.HEIMDALL_ADMIN_RATE_LIMIT_MAX_REQUESTS) ??
    DEFAULT_ADMIN_RATE_LIMIT_MAX_REQUESTS;
  const rateLimitWindowSeconds =
    options?.rateLimit?.windowSeconds ??
    optionalPositiveInteger(process.env.HEIMDALL_ADMIN_RATE_LIMIT_WINDOW_SECONDS) ??
    DEFAULT_ADMIN_RATE_LIMIT_WINDOW_SECONDS;
  const rateLimitMaxEntries =
    options?.rateLimit?.maxEntries ??
    optionalPositiveInteger(process.env.HEIMDALL_ADMIN_RATE_LIMIT_MAX_ENTRIES) ??
    DEFAULT_ADMIN_RATE_LIMIT_MAX_ENTRIES;
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
    supportSessionSecret,
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
    sessionCookieName,
    supportSessionSecret,
    sessionManager:
      enabled && sessionSecret
        ? createAdminSessionManager({
            cookieName: sessionCookieName,
            maxAgeSeconds: options?.sessionMaxAgeSeconds ?? 8 * 60 * 60,
            sameSite: cookieSameSite,
            secure: secureCookies,
            sessionSecret,
          })
        : undefined,
    rateLimiter:
      enabled && rateLimitMaxRequests > 0
        ? createAdminRouteRateLimiter({
            maxEntries: rateLimitMaxEntries,
            maxRequests: rateLimitMaxRequests,
            windowSeconds: rateLimitWindowSeconds,
          })
        : undefined,
    ...(configurationError ? { configurationError } : {}),
  };
}

/** Resolves product session authentication settings from options and environment. */
function resolveProductSessionAuth(
  options: ProductSessionAuthOptions | undefined,
): ResolvedProductSessionAuthOptions {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const enabled = options?.enabled ?? optionalBooleanEnv("HEIMDALL_PRODUCT_AUTH_ENABLED") ?? true;
  const secureCookies = options?.secureCookies ?? nodeEnv === "production";
  const cookieSameSite =
    options?.cookieSameSite ??
    parseCookieSameSite(process.env.HEIMDALL_PRODUCT_COOKIE_SAME_SITE) ??
    "Lax";
  const cookieName =
    emptyToUndefined(options?.cookieName) ??
    (nodeEnv === "production" ? "__Host-car_session" : "car_session");
  const sessionPepper =
    emptyToUndefined(options?.sessionPepper) ??
    emptyToUndefined(process.env.HEIMDALL_PRODUCT_SESSION_PEPPER);
  const optionSessionTtlDays =
    options?.sessionTtlDays &&
    Number.isSafeInteger(options.sessionTtlDays) &&
    options.sessionTtlDays > 0
      ? options.sessionTtlDays
      : undefined;
  const sessionTtlDays =
    optionSessionTtlDays ??
    optionalPositiveInteger(process.env.HEIMDALL_PRODUCT_SESSION_TTL_DAYS) ??
    14;
  const configurationError = validateResolvedProductSessionAuth({
    cookieName,
    cookieSameSite,
    enabled,
    nodeEnv,
    secureCookies,
    sessionPepper,
  });

  return {
    cookieName,
    cookieSameSite,
    enabled,
    secureCookies,
    sessionPepper,
    sessionTtlDays,
    ...(configurationError ? { configurationError } : {}),
  };
}

/** Resolves product GitHub OAuth settings from options and environment. */
function resolveProductGitHubOAuth(
  options: ProductGitHubOAuthOptions | undefined,
): ResolvedProductGitHubOAuthOptions {
  const enabled = options?.enabled ?? optionalBooleanEnv("HEIMDALL_GITHUB_OAUTH_ENABLED") ?? true;
  const clientId =
    emptyToUndefined(options?.clientId) ??
    emptyToUndefined(process.env.HEIMDALL_GITHUB_OAUTH_CLIENT_ID) ??
    emptyToUndefined(process.env.GITHUB_CLIENT_ID);
  const clientSecret =
    emptyToUndefined(options?.clientSecret) ??
    emptyToUndefined(process.env.HEIMDALL_GITHUB_OAUTH_CLIENT_SECRET) ??
    emptyToUndefined(process.env.GITHUB_CLIENT_SECRET);
  const authorizationUrl =
    emptyToUndefined(options?.authorizationUrl) ??
    emptyToUndefined(process.env.HEIMDALL_GITHUB_OAUTH_AUTHORIZATION_URL) ??
    "https://github.com/login/oauth/authorize";
  const tokenUrl =
    emptyToUndefined(options?.tokenUrl) ??
    emptyToUndefined(process.env.HEIMDALL_GITHUB_OAUTH_TOKEN_URL) ??
    "https://github.com/login/oauth/access_token";
  const userApiUrl =
    emptyToUndefined(options?.userApiUrl) ??
    emptyToUndefined(process.env.HEIMDALL_GITHUB_OAUTH_USER_URL) ??
    "https://api.github.com/user";
  const emailsApiUrl =
    emptyToUndefined(options?.emailsApiUrl) ??
    emptyToUndefined(process.env.HEIMDALL_GITHUB_OAUTH_EMAILS_URL) ??
    "https://api.github.com/user/emails";
  const scopes = options?.scopes ??
    parseStringList(process.env.HEIMDALL_GITHUB_OAUTH_SCOPES) ?? ["read:user", "user:email"];
  const stateTtlMinutes =
    (options?.stateTtlMinutes &&
    Number.isSafeInteger(options.stateTtlMinutes) &&
    options.stateTtlMinutes > 0
      ? options.stateTtlMinutes
      : undefined) ??
    optionalPositiveInteger(process.env.HEIMDALL_GITHUB_OAUTH_STATE_TTL_MINUTES) ??
    10;
  const defaultRedirectPath =
    safeProductRedirectTo(options?.defaultRedirectPath) ??
    safeProductRedirectTo(process.env.HEIMDALL_PRODUCT_AUTH_DEFAULT_REDIRECT_PATH) ??
    "/";
  const callbackUrl =
    emptyToUndefined(options?.callbackUrl) ??
    emptyToUndefined(process.env.HEIMDALL_GITHUB_OAUTH_CALLBACK_URL);
  const configurationError = validateResolvedProductGitHubOAuth({
    authorizationUrl,
    clientId,
    clientSecret,
    emailsApiUrl,
    enabled,
    tokenUrl,
    userApiUrl,
    ...(callbackUrl ? { callbackUrl } : {}),
  });

  return {
    authorizationUrl,
    ...(callbackUrl ? { callbackUrl } : {}),
    clientId,
    clientSecret,
    defaultRedirectPath,
    emailsApiUrl,
    enabled,
    scopes,
    stateTtlMinutes,
    tokenUrl,
    userApiUrl,
    ...(configurationError ? { configurationError } : {}),
  };
}

/** Validates resolved product GitHub OAuth settings. */
function validateResolvedProductGitHubOAuth(input: {
  /** Whether GitHub OAuth routes are enabled. */
  readonly enabled: boolean;
  /** GitHub OAuth client ID. */
  readonly clientId?: string | undefined;
  /** GitHub OAuth client secret. */
  readonly clientSecret?: string | undefined;
  /** Public callback URL registered with GitHub. */
  readonly callbackUrl?: string | undefined;
  /** GitHub authorization endpoint. */
  readonly authorizationUrl: string;
  /** GitHub token endpoint. */
  readonly tokenUrl: string;
  /** GitHub user profile endpoint. */
  readonly userApiUrl: string;
  /** GitHub user emails endpoint. */
  readonly emailsApiUrl: string;
}): string | undefined {
  if (!input.enabled) {
    return undefined;
  }
  if (!input.clientId || !input.clientSecret) {
    return "GitHub OAuth requires HEIMDALL_GITHUB_OAUTH_CLIENT_ID and HEIMDALL_GITHUB_OAUTH_CLIENT_SECRET.";
  }
  for (const [name, value] of [
    ["authorization URL", input.authorizationUrl],
    ["token URL", input.tokenUrl],
    ["user API URL", input.userApiUrl],
    ["emails API URL", input.emailsApiUrl],
    ["callback URL", input.callbackUrl],
  ] as const) {
    if (value && !isHttpUrl(value)) {
      return `GitHub OAuth ${name} must be an absolute HTTP(S) URL.`;
    }
  }

  return undefined;
}

/** Validates resolved product auth settings. */
function validateResolvedProductSessionAuth(input: {
  /** Whether product session routes are enabled. */
  readonly enabled: boolean;
  /** Product session cookie name. */
  readonly cookieName: string;
  /** Session token pepper. */
  readonly sessionPepper?: string | undefined;
  /** Whether cookies are secure. */
  readonly secureCookies: boolean;
  /** SameSite policy used for browser session cookies. */
  readonly cookieSameSite: "Strict" | "Lax" | "None";
  /** Node environment name. */
  readonly nodeEnv: string;
}): string | undefined {
  if (!input.enabled) {
    return undefined;
  }
  if (!input.cookieName) {
    return "Product session auth requires a session cookie name.";
  }
  if (!input.sessionPepper || input.sessionPepper.length < 32) {
    return "Product session auth requires a 32+ character HEIMDALL_PRODUCT_SESSION_PEPPER.";
  }
  if (input.nodeEnv === "production" && !input.secureCookies) {
    return "Production product sessions require secure cookies.";
  }
  if (input.cookieSameSite === "None" && !input.secureCookies) {
    return "SameSite=None product cookies require secure cookies.";
  }
  if (input.cookieName.startsWith("__Host-") && !input.secureCookies) {
    return "__Host- product session cookies require secure cookies.";
  }

  return undefined;
}

/** Returns whether OpenAPI documentation routes should be exposed for this process. */
function openApiDocsEnabled(): boolean {
  const override = optionalBooleanEnv("HEIMDALL_OPENAPI_ENABLED");
  if (override !== undefined) {
    return override;
  }

  return (process.env.NODE_ENV ?? "development") !== "production";
}

/** Reads a boolean environment variable when it uses an explicit true or false value. */
function optionalBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }

  return undefined;
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
  /** Support-session signing secret. */
  readonly supportSessionSecret?: string | undefined;
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
  if (!input.supportSessionSecret || input.supportSessionSecret.length < 32) {
    return "Admin control-plane auth requires a 32+ character HEIMDALL_ADMIN_SUPPORT_SESSION_SECRET or HEIMDALL_ADMIN_SESSION_SECRET.";
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

/** Creates an in-process fixed-window rate limiter for admin routes. */
function createAdminRouteRateLimiter(input: {
  /** Maximum requests allowed for one client key in a window. */
  readonly maxRequests: number;
  /** Window duration in seconds. */
  readonly windowSeconds: number;
  /** Maximum number of client keys retained by the limiter. */
  readonly maxEntries: number;
}): AdminRouteRateLimiter {
  const windowMs = Math.max(1, input.windowSeconds) * 1000;
  const maxRequests = Math.max(1, input.maxRequests);
  const maxEntries = Math.max(1, input.maxEntries);
  const buckets = new Map<
    string,
    {
      /** Number of requests recorded in the active window. */
      count: number;
      /** Last time this bucket was touched. */
      lastSeenMs: number;
      /** Window start timestamp in milliseconds. */
      windowStartMs: number;
    }
  >();

  return {
    check: (key, nowMs = Date.now()) => {
      let bucket = buckets.get(key);
      if (!bucket || nowMs - bucket.windowStartMs >= windowMs) {
        bucket = { count: 0, lastSeenMs: nowMs, windowStartMs: nowMs };
        buckets.set(key, bucket);
      }

      bucket.count += 1;
      bucket.lastSeenMs = nowMs;
      pruneAdminRateLimitBuckets(buckets, maxEntries, nowMs, windowMs);

      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.windowStartMs + windowMs - nowMs) / 1000),
      );
      return {
        allowed: bucket.count <= maxRequests,
        retryAfterSeconds,
      };
    },
  };
}

/** Prunes expired or least-recently-seen rate-limit buckets. */
function pruneAdminRateLimitBuckets(
  buckets: Map<string, { readonly lastSeenMs: number; readonly windowStartMs: number }>,
  maxEntries: number,
  nowMs: number,
  windowMs: number,
): void {
  if (buckets.size <= maxEntries) {
    return;
  }

  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.windowStartMs >= windowMs) {
      buckets.delete(key);
    }
  }

  if (buckets.size <= maxEntries) {
    return;
  }

  const keysByAge = [...buckets.entries()]
    .sort(([, left], [, right]) => left.lastSeenMs - right.lastSeenMs)
    .map(([key]) => key);
  for (const key of keysByAge.slice(0, buckets.size - maxEntries)) {
    buckets.delete(key);
  }
}

/** Handles admin CORS preflight requests with strict origin checks. */
function handleAdminPreflight(
  request: Request,
  set: AdminResponseSet,
  auth: ResolvedAdminControlPlaneAuthOptions,
  observabilitySink: ObservabilitySink,
): AdminErrorResponse | Response {
  const requestId = requestIdFromRequest(request);
  const guardResponse = guardAdminConfiguration(request, set, auth, requestId, observabilitySink);
  if (guardResponse) {
    return guardResponse;
  }

  set.status = 204;
  return emptyResponseFromSet(set, 204);
}

/** Handles product session CORS preflight requests. */
function handleProductPreflight(request: Request, set: AdminResponseSet): Response {
  const requestId = requestIdFromRequest(request);
  setProductResponseHeaders(request, set);
  set.headers = {
    ...(set.headers ?? {}),
    "x-request-id": requestId,
  };
  set.status = 204;
  return emptyResponseFromSet(set, 204);
}

/** Guards product OAuth routes against disabled or incomplete auth configuration. */
function guardProductOAuthConfiguration(
  set: AdminStatusSet,
  sessionAuth: ResolvedProductSessionAuthOptions,
  oauth: ResolvedProductGitHubOAuthOptions,
  hasInjectedOAuthService: boolean,
): AdminErrorResponse | undefined {
  if (!sessionAuth.enabled || !oauth.enabled) {
    set.status = 404;
    return {
      error: {
        code: "product_auth.disabled",
        message: "Product authentication routes are disabled.",
      },
    };
  }
  if (sessionAuth.configurationError) {
    set.status = 503;
    return {
      error: {
        code: "product_auth.unconfigured",
        message: sessionAuth.configurationError,
      },
    };
  }
  if (!hasInjectedOAuthService && oauth.configurationError) {
    set.status = 503;
    return {
      error: {
        code: "github_oauth.unconfigured",
        message: oauth.configurationError,
      },
    };
  }

  return undefined;
}

/** Converts product OAuth errors into JSON responses. */
function handleProductOAuthError(error: unknown, set: AdminStatusSet): AdminErrorResponse {
  if (error instanceof ProductOAuthError) {
    set.status = error.status;
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  set.status = 502;
  return {
    error: {
      code: "github_oauth.failed",
      message: "GitHub OAuth login failed.",
    },
  };
}

/** Redirects the browser to the product dashboard with a sanitized OAuth error code. */
function productOAuthErrorRedirect(
  error: unknown,
  auth: ResolvedProductGitHubOAuthOptions,
): Response {
  const code = error instanceof ProductOAuthError ? error.code : "github_oauth.failed";
  return new Response(null, {
    headers: {
      location: productDashboardRedirectUrl(
        auth.defaultRedirectPath,
        new URLSearchParams({ authError: code }),
      ),
    },
    status: 302,
  });
}

/** Builds a redirect response from Elysia's mutable response set. */
function redirectResponseFromSet(
  set: AdminResponseSet,
  location: string,
  status = 302,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = headersFromSet(set);
  headers.set("location", location);
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  return new Response(null, { headers, status });
}

/** Builds an empty response from Elysia's mutable response set. */
function emptyResponseFromSet(set: AdminResponseSet, status: number): Response {
  return new Response(null, { headers: headersFromSet(set), status });
}

/** Builds response headers from Elysia's mutable response set. */
function headersFromSet(set: AdminResponseSet): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(set.headers ?? {})) {
    headers.set(key, String(value));
  }

  return headers;
}

/** Sets one response header on a minimal mutable response set. */
function setResponseHeader(set: AdminResponseSet, key: string, value: string | number): void {
  set.headers = {
    ...(set.headers ?? {}),
    [key]: value,
  };
}

/** Returns whether a path belongs to the product session API surface. */
function isProductSessionRoute(pathname: string): boolean {
  return pathname.startsWith("/api/v1/");
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
    recordAdminAccessDenied(
      observabilitySink,
      request,
      requestId,
      "admin.disabled",
      404,
      {},
      auth.securityEventSink,
    );
    return {
      error: {
        code: "admin.disabled",
        message: "Admin control-plane routes are disabled.",
      },
    };
  }
  if (auth.configurationError) {
    set.status = 503;
    recordAdminAccessDenied(
      observabilitySink,
      request,
      requestId,
      "admin.misconfigured",
      503,
      {},
      auth.securityEventSink,
    );
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
      recordAdminAccessDenied(
        observabilitySink,
        request,
        requestId,
        "admin.not_exposed",
        404,
        {},
        auth.securityEventSink,
      );
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
    recordAdminAccessDenied(
      observabilitySink,
      request,
      requestId,
      "admin.cors_forbidden",
      403,
      {
        ...(origin ? { origin } : {}),
      },
      auth.securityEventSink,
    );
    return {
      error: {
        code: "admin.cors_forbidden",
        message: "Origin is not allowed for admin control-plane requests.",
      },
    };
  }
  if (request.method !== "OPTIONS" && auth.rateLimiter) {
    const rateLimit = auth.rateLimiter.check(adminRateLimitKey(request));
    if (!rateLimit.allowed) {
      set.status = 429;
      set.headers = {
        ...(set.headers ?? {}),
        "retry-after": String(rateLimit.retryAfterSeconds),
      };
      recordAdminAccessDenied(
        observabilitySink,
        request,
        requestId,
        "admin.rate_limited",
        429,
        {
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        auth.securityEventSink,
      );
      return {
        error: {
          code: "admin.rate_limited",
          message: "Admin control-plane request rate limit exceeded.",
        },
      };
    }
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
    recordAdminAccessDenied(
      observabilitySink,
      request,
      requestId,
      "admin.unauthorized",
      401,
      {},
      auth.securityEventSink,
    );
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
    recordAdminAccessDenied(
      observabilitySink,
      request,
      requestId,
      "admin.csrf_forbidden",
      403,
      { actorUserId: session.actor.actorUserId },
      auth.securityEventSink,
    );
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
    recordAdminAccessDenied(
      observabilitySink,
      request,
      requestId,
      "admin.forbidden",
      403,
      {
        actorUserId: session.actor.actorUserId,
        permission,
      },
      auth.securityEventSink,
    );
    return {
      response: {
        error: {
          code: "admin.forbidden",
          message: `Admin permission ${permission} is required.`,
        },
      },
    };
  }

  const supportSession = supportSessionFromRequest(request);
  if (supportSession === null) {
    set.status = 400;
    recordAdminAccessDenied(
      observabilitySink,
      request,
      requestId,
      "admin.invalid_support_session",
      400,
      { actorUserId: session.actor.actorUserId },
      auth.securityEventSink,
    );
    return {
      response: {
        error: {
          code: "admin.invalid_support_session",
          message: "Support session ID is invalid.",
        },
      },
    };
  }

  return {
    actor: session.actor,
    method: request.method,
    requestId,
    route: routeFromRequest(request),
    securityEventSink: auth.securityEventSink,
    session,
    traceContext: traceContextFromRequest(request, requestId),
    ...(supportSession
      ? { supportSession, supportSessionId: supportSession.supportSessionId }
      : {}),
  };
}

/** Guards customer-facing product routes with a DB-backed browser session. */
async function guardProductSession(
  request: Request,
  set: AdminResponseSet,
  auth: ResolvedProductSessionAuthOptions,
  sessionService: ProductSessionService,
): Promise<ProductRequestContext | { readonly response: AdminErrorResponse }> {
  const requestId = requestIdFromRequest(request);
  setProductResponseHeaders(request, set);
  set.headers = {
    ...(set.headers ?? {}),
    "x-request-id": requestId,
  };

  if (!auth.enabled) {
    set.status = 404;
    return {
      response: {
        error: {
          code: "product_auth.disabled",
          message: "Product session routes are disabled.",
        },
      },
    };
  }
  if (auth.configurationError) {
    set.status = 503;
    return {
      response: {
        error: {
          code: "product_auth.unconfigured",
          message: auth.configurationError,
        },
      },
    };
  }

  const session = await sessionService.readSession(request.headers.get("cookie"));
  if (!session) {
    set.status = 401;
    return {
      response: {
        error: {
          code: "product_auth.unauthorized",
          message: "Product session is missing, invalid, or expired.",
        },
      },
    };
  }

  return {
    method: request.method,
    requestId,
    route: routeFromRequest(request),
    session,
    traceContext: traceContextFromRequest(request, requestId),
  };
}

/** Guards customer-facing API routes with product sessions, while retaining admin support access. */
async function guardApiV1Session(
  request: Request,
  set: AdminResponseSet,
  adminAuth: ResolvedAdminControlPlaneAuthOptions,
  productAuth: ResolvedProductSessionAuthOptions,
  getSessionService: () => ProductSessionService,
  observabilitySink: ObservabilitySink,
  adminPermission: AdminPermission,
): Promise<ApiV1RequestContext | { readonly response: AdminErrorResponse }> {
  const cookies = parseProductCookieHeader(request.headers.get("cookie"));
  const hasProductCookie = Boolean(cookies[productAuth.cookieName]);
  const hasAdminCookie = Boolean(cookies[adminAuth.sessionCookieName]);
  if (hasProductCookie || !hasAdminCookie) {
    const productGuard = await guardProductSession(request, set, productAuth, getSessionService());
    if (!("response" in productGuard)) {
      return {
        actor: productControlPlaneActor(productGuard.session),
        kind: "product",
        method: productGuard.method,
        productActor: productGuard.session.actor,
        requestId: productGuard.requestId,
        route: productGuard.route,
        session: productGuard.session,
        traceContext: productGuard.traceContext,
      };
    }
    if (!hasAdminCookie) {
      return productGuard;
    }
  }

  const adminGuard = guardAdminSession(request, set, adminAuth, observabilitySink, adminPermission);
  if ("response" in adminGuard) {
    return adminGuard;
  }

  return {
    ...adminGuard,
    kind: "admin",
  };
}

/** Converts a product session into the scoped actor shape used by shared services. */
function productControlPlaneActor(session: ProductSessionContext): AdminActor {
  const selectedMembership =
    session.actor.memberships.find(
      (membership) => membership.orgId === session.actor.selectedOrgId,
    ) ?? session.actor.memberships[0];
  const orgIds = session.actor.memberships.map((membership) => membership.orgId);

  return {
    actorType: "idp_user",
    actorUserId: session.actor.userId,
    ...(session.user.displayName ? { displayName: session.user.displayName } : {}),
    ...(session.user.primaryEmail ? { email: session.user.primaryEmail } : {}),
    orgIds,
    permissions: [],
    provider: "github_org",
    providerSubject: session.actor.userId,
    repoIds: [],
    role:
      selectedMembership?.role === "owner" || selectedMembership?.role === "admin"
        ? "admin"
        : "support",
  };
}

/** Guards organization and repository access for either admin or product `/api/v1` sessions. */
function guardApiV1ScopedAccess(
  context: ApiV1RequestContext,
  orgId: string | undefined,
  repoId: string | undefined,
  productPermission: ProductPermission,
  set: AdminStatusSet,
): AdminErrorResponse | undefined {
  if (context.kind === "admin") {
    const response = guardScopedAccess(context.actor, orgId, repoId, set);
    if (response) {
      recordAdminScopeForbiddenSecurityEvent(context, orgId, repoId, productPermission);
    }
    return response;
  }
  if (!orgId) {
    set.status = 403;
    return {
      error: {
        code: "product_auth.scope_forbidden",
        message: "Product resource is not scoped to an organization.",
      },
    };
  }

  const permitted = repoId
    ? productActorHasRepoPermission(context.productActor, orgId, productPermission)
    : productActorHasOrgPermission(context.productActor, orgId, productPermission);
  if (permitted) {
    return undefined;
  }

  set.status = 403;
  return {
    error: {
      code: "product_auth.forbidden",
      message: `Product permission ${productPermission} is required.`,
    },
  };
}

/** Guards an optional repository filter for either admin or product `/api/v1` sessions. */
async function guardApiV1MaybeRepoScopedAccess(
  context: ApiV1RequestContext,
  repoId: string | undefined,
  orgId: string | undefined,
  productPermission: ProductPermission,
  set: AdminStatusSet,
  service: AdminControlPlaneService,
): Promise<AdminErrorResponse | undefined> {
  if (context.kind === "admin") {
    const response = await guardMaybeRepoScopedAccess(context.actor, repoId, orgId, set, service);
    if (response) {
      recordAdminScopeForbiddenSecurityEvent(context, orgId, repoId, productPermission);
    }
    return response;
  }
  if (!repoId) {
    return guardApiV1ScopedAccess(context, orgId, undefined, productPermission, set);
  }

  const settings = await service.getRepositorySettings(repoId).catch(() => undefined);
  return guardApiV1ScopedAccess(
    context,
    settings?.repository.orgId ?? orgId,
    repoId,
    productPermission,
    set,
  );
}

/** Records a cross-tenant security event for denied admin `/api/v1` scope checks. */
function recordAdminScopeForbiddenSecurityEvent(
  context: Extract<ApiV1RequestContext, { readonly kind: "admin" }>,
  orgId: string | undefined,
  repoId: string | undefined,
  requiredPermission: ProductPermission,
): void {
  if (!context.securityEventSink) {
    return;
  }

  try {
    recordSecurityEvent(context.securityEventSink, {
      actorId: context.actor.actorUserId,
      metadata: {
        denialReason: "admin.scope_forbidden",
        method: context.method,
        requestId: context.requestId,
        requiredPermission,
        route: context.route,
      },
      orgId,
      repoId,
      resourceId: repoId ?? orgId,
      resourceType: repoId ? "repository" : orgId ? "organization" : "admin_scope",
      source: "api",
      type: "cross_tenant_access_attempt",
    });
  } catch {
    // Security event sinks must never change the request outcome.
  }
}

/** Reads and validates the optional request-scoped support-session header. */
function supportSessionFromRequest(request: Request): RequestSupportSession | null | undefined {
  const token = request.headers.get(SUPPORT_SESSION_HEADER)?.trim();
  if (!token) {
    return undefined;
  }

  if (SIGNED_SUPPORT_SESSION_TOKEN_PATTERN.test(token)) {
    const claims = readUnverifiedSupportSessionClaims(token);
    return claims ? { format: "signed", supportSessionId: claims.supportSessionId, token } : null;
  }

  return SUPPORT_SESSION_ID_PATTERN.test(token)
    ? { format: "legacy", supportSessionId: token, token }
    : null;
}

/** Creates a signed support-session token from validated claims. */
function createSupportSessionToken(claims: SupportSessionTokenClaims, secret: string): string {
  const payload = encodeBase64Url(JSON.stringify(claims));
  return `supp_${payload}.${supportSessionSignature(payload, secret)}`;
}

/** Verifies a support-session token and returns validated claims. */
function verifySupportSessionToken(
  token: string,
  secret: string,
): SupportSessionTokenClaims | undefined {
  const parsed = splitSupportSessionToken(token);
  if (!parsed) {
    return undefined;
  }

  const expectedSignature = supportSessionSignature(parsed.payload, secret);
  if (!constantTimeEqual(expectedSignature, parsed.signature)) {
    return undefined;
  }

  return supportSessionClaimsFromPayload(parsed.payload);
}

/** Reads token claims without trusting them, only to expose the product-safe support-session ID. */
function readUnverifiedSupportSessionClaims(token: string): SupportSessionTokenClaims | undefined {
  const parsed = splitSupportSessionToken(token);
  return parsed ? supportSessionClaimsFromPayload(parsed.payload) : undefined;
}

/** Splits a signed support-session token into payload and signature segments. */
function splitSupportSessionToken(
  token: string,
): { readonly payload: string; readonly signature: string } | undefined {
  const [prefixedPayload, signature, extra] = token.split(".");
  if (
    !prefixedPayload ||
    !signature ||
    extra !== undefined ||
    !prefixedPayload.startsWith("supp_")
  ) {
    return undefined;
  }

  const payload = prefixedPayload.slice("supp_".length);
  return payload ? { payload, signature } : undefined;
}

/** Decodes and validates support-session token claims. */
function supportSessionClaimsFromPayload(payload: string): SupportSessionTokenClaims | undefined {
  try {
    const claims = JSON.parse(decodeBase64Url(payload)) as unknown;
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
      return undefined;
    }

    const record = claims as Record<string, unknown>;
    const supportSessionId = stringField(record, "supportSessionId");
    const actorUserId = stringField(record, "actorUserId");
    const createdAt = stringField(record, "createdAt");
    const expiresAt = stringField(record, "expiresAt");
    if (
      record.version !== SUPPORT_SESSION_TOKEN_VERSION ||
      !supportSessionId ||
      !SUPPORT_SESSION_ID_PATTERN.test(supportSessionId) ||
      !actorUserId ||
      !createdAt ||
      !expiresAt ||
      Number.isNaN(Date.parse(createdAt)) ||
      Number.isNaN(Date.parse(expiresAt))
    ) {
      return undefined;
    }

    const scopes = supportSessionScopesFromValue(record.scopes);
    if (scopes.length === 0) {
      return undefined;
    }

    const orgId = stringField(record, "orgId");
    const repoId = stringField(record, "repoId");
    const reviewRunId = stringField(record, "reviewRunId");
    return {
      actorUserId,
      createdAt,
      expiresAt,
      scopes,
      supportSessionId,
      version: SUPPORT_SESSION_TOKEN_VERSION,
      ...(orgId ? { orgId } : {}),
      ...(repoId ? { repoId } : {}),
      ...(reviewRunId ? { reviewRunId } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Returns a valid support-session scope list from an unknown token or request value. */
function supportSessionScopesFromValue(value: unknown): readonly SupportSessionScope[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter(isSupportSessionScope))];
}

/** Returns whether a value is a supported support-session scope. */
function isSupportSessionScope(value: unknown): value is SupportSessionScope {
  return value === "raw_artifact_payload" || value === "raw_eval_import";
}

/** Returns an HMAC-SHA256 signature for a support-session token payload. */
function supportSessionSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Returns a product-safe SHA-256 token hash for audit metadata. */
function supportSessionTokenHash(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

/** Encodes UTF-8 text as base64url. */
function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Decodes UTF-8 text from base64url. */
function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

/** Compares two strings in constant time. */
function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }

  return timingSafeEqual(leftBytes, rightBytes);
}

/** Builds the audited artifact payload access request from URL query and auth context. */
function reviewArtifactPayloadRequestFromUrl(
  url: URL,
  context: ApiV1RequestContext,
  request: Request,
): AdminReviewArtifactPayloadRequest {
  const reason = url.searchParams.get("reason")?.trim();
  if (!reason) {
    throw new AdminRequestValidationError(
      "artifact.reason_required",
      "Review artifact payload access requires a non-empty reason.",
      400,
    );
  }
  if (reason.length > 1000) {
    throw new AdminRequestValidationError(
      "artifact.reason_too_long",
      "Review artifact payload access reason must be at most 1000 characters.",
      400,
    );
  }
  const ipAddress = clientIpAddressFromRequest(request);
  const supportSessionId = context.kind === "admin" ? context.supportSessionId : undefined;
  const userAgent = request.headers.get("user-agent") ?? undefined;

  return {
    accessLevel: artifactPayloadAccessLevelFromUrl(url),
    actor: context.actor,
    ...(ipAddress ? { ipAddress } : {}),
    reason,
    requestId: context.requestId,
    ...(supportSessionId ? { supportSessionId } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

/** Reads the requested artifact payload access level from query parameters. */
function artifactPayloadAccessLevelFromUrl(url: URL): AdminReviewArtifactPayloadAccessLevel {
  const value = url.searchParams.get("accessLevel") ?? url.searchParams.get("redactionLevel");
  if (!value || value === "redacted") {
    return "redacted";
  }
  if (value === "raw_allowed") {
    return "raw_allowed";
  }

  throw new AdminRequestValidationError(
    "artifact.access_level_invalid",
    "Review artifact payload accessLevel must be redacted or raw_allowed.",
    400,
  );
}

/** Guards raw artifact payload access behind admin support-session or elevated admin access. */
function guardRawArtifactPayloadAccess(
  payloadRequest: AdminReviewArtifactPayloadRequest,
  context: ApiV1RequestContext,
  auth: ResolvedAdminControlPlaneAuthOptions,
  resource: SupportSessionResourceScope,
  request: Request,
  set: AdminStatusSet,
  observabilitySink: ObservabilitySink,
  securityEventSink: SecurityEventSink,
): AdminErrorResponse | undefined {
  if (payloadRequest.accessLevel !== "raw_allowed") {
    return undefined;
  }

  if (
    context.kind === "admin" &&
    (supportSessionAllowsAccess(context, auth, "raw_artifact_payload", resource) ||
      canBypassRawArtifactPayloadSupportSession(context.actor))
  ) {
    return undefined;
  }

  set.status = 403;
  recordAdminAccessDenied(
    observabilitySink,
    request,
    context.requestId,
    "admin.support_session_required",
    403,
    {
      actorUserId: context.actor.actorUserId,
      accessLevel: payloadRequest.accessLevel,
    },
    securityEventSink,
  );
  return {
    error: {
      code: "admin.support_session_required",
      message: "Raw artifact payload access requires an admin support session.",
    },
  };
}

/** Returns whether a signed support session authorizes one privileged operation. */
function supportSessionAllowsAccess(
  context: Extract<ApiV1RequestContext, { readonly kind: "admin" }> | AdminRequestContext,
  auth: ResolvedAdminControlPlaneAuthOptions,
  requiredScope: SupportSessionScope,
  resource: SupportSessionResourceScope,
): boolean {
  if (!context.supportSession || context.supportSession.format !== "signed") {
    return false;
  }

  const claims = verifySupportSessionToken(
    context.supportSession.token,
    requireValue(auth.supportSessionSecret),
  );
  if (!claims || claims.actorUserId !== context.actor.actorUserId) {
    return false;
  }
  if (new Date(claims.expiresAt).getTime() <= Date.now()) {
    return false;
  }
  if (!claims.scopes.includes(requiredScope)) {
    return false;
  }

  return supportSessionResourceMatches(claims, resource);
}

/** Returns whether token resource claims allow the requested resource. */
function supportSessionResourceMatches(
  claims: SupportSessionTokenClaims,
  resource: SupportSessionResourceScope,
): boolean {
  if (claims.reviewRunId && resource.reviewRunId !== claims.reviewRunId) {
    return false;
  }
  if (claims.repoId && resource.repoId !== claims.repoId) {
    return false;
  }
  if (claims.orgId && resource.orgId && claims.orgId !== resource.orgId) {
    return false;
  }
  if (claims.orgId && !claims.repoId && !claims.reviewRunId) {
    return resource.orgId === claims.orgId;
  }

  return true;
}

/** Returns whether an admin actor can read raw artifact payloads without support-session context. */
function canBypassRawArtifactPayloadSupportSession(actor: AdminActor): boolean {
  return (
    actorHasPermission(actor, "admin.settings.manage") ||
    actorHasPermission(actor, "admin.replay.execute")
  );
}

/** Guards raw eval fixture imports behind support-session or elevated admin access. */
function guardRawEvalImportAccess(
  importRequest: ImportReviewRunToEvalRequest,
  context: AdminRequestContext,
  auth: ResolvedAdminControlPlaneAuthOptions,
  resource: SupportSessionResourceScope,
  request: Request,
  set: AdminStatusSet,
  observabilitySink: ObservabilitySink,
  securityEventSink: SecurityEventSink,
): AdminErrorResponse | undefined {
  if (
    importRequest.redactionLevel !== "raw_allowed" ||
    supportSessionAllowsAccess(context, auth, "raw_eval_import", resource) ||
    canBypassRawEvalImportSupportSession(context.actor)
  ) {
    return undefined;
  }

  set.status = 403;
  recordAdminAccessDenied(
    observabilitySink,
    request,
    context.requestId,
    "admin.support_session_required",
    403,
    {
      actorUserId: context.actor.actorUserId,
      redactionLevel: importRequest.redactionLevel,
      resourceId: importRequest.reviewRunId,
    },
    securityEventSink,
  );
  return {
    error: {
      code: "admin.support_session_required",
      message: "Raw eval imports require a support session or elevated admin permission.",
    },
  };
}

/** Returns whether an actor can import raw eval drafts without a support-session reference. */
function canBypassRawEvalImportSupportSession(actor: AdminActor): boolean {
  return (
    actorHasPermission(actor, "admin.settings.manage") ||
    actorHasPermission(actor, "admin.replay.execute")
  );
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

/** Guards security event query scope before search execution. */
function guardSecurityEventQueryScope(
  actor: AdminActor,
  query: AdminSecurityEventQuery,
  set: AdminStatusSet,
): AdminErrorResponse | undefined {
  if (query.orgId && !actorCanAccessOrg(actor, query.orgId)) {
    return guardScopedAccess(actor, query.orgId, undefined, set);
  }

  if (!query.orgId && !actor.orgIds.includes("*")) {
    set.status = 403;
    return {
      error: {
        code: "admin.security_event_scope_required",
        message:
          "Security event history requires an orgId filter unless the actor has all-organization scope.",
      },
    };
  }

  return undefined;
}

/** Guards organization and repository filters for usage queries. */
async function guardUsageQueryScope(
  actor: AdminActor,
  query: AdminUsageQuery,
  set: AdminStatusSet,
  service: AdminControlPlaneService,
): Promise<AdminErrorResponse | undefined> {
  if (query.orgId && !actorCanAccessOrg(actor, query.orgId)) {
    return guardScopedAccess(actor, query.orgId, undefined, set);
  }
  if (query.repoId) {
    return guardRepoIdScopedAccess(actor, query.repoId, set, service);
  }

  return undefined;
}

/** Guards organization filters for entitlement queries. */
function guardEntitlementQueryScope(
  actor: AdminActor,
  query: AdminEntitlementQuery,
  set: AdminStatusSet,
): AdminErrorResponse | undefined {
  if (!query.orgId) {
    set.status = 400;
    return {
      error: {
        code: "admin.entitlements_org_required",
        message:
          "Entitlement inspection requires an orgId unless the actor has exactly one organization scope.",
      },
    };
  }

  if (!actorCanAccessOrg(actor, query.orgId)) {
    return guardScopedAccess(actor, query.orgId, undefined, set);
  }

  return undefined;
}

/** Guards organization filters for billing account queries. */
function guardBillingQueryScope(
  actor: AdminActor,
  query: AdminBillingQuery,
  set: AdminStatusSet,
): AdminErrorResponse | undefined {
  if (!query.orgId) {
    set.status = 400;
    return {
      error: {
        code: "admin.billing_org_required",
        message:
          "Billing account inspection requires an orgId unless the actor has exactly one organization scope.",
      },
    };
  }

  if (!actorCanAccessOrg(actor, query.orgId)) {
    return guardScopedAccess(actor, query.orgId, undefined, set);
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
    set.headers["access-control-allow-headers"] = [
      "content-type",
      "idempotency-key",
      "traceparent",
      "tracestate",
      "x-csrf-token",
      "x-heimdall-idp-assertion",
      "x-heimdall-idp-signature",
      "x-heimdall-idp-timestamp",
      "x-heimdall-parent-event-id",
      "x-heimdall-support-session-id",
      "x-request-id",
    ].join(",");
    set.headers["access-control-allow-methods"] = "GET,POST,PATCH,OPTIONS";
    set.headers["access-control-allow-origin"] = origin;
    set.headers.vary = "Origin";
  }

  if (cookie) {
    set.headers["set-cookie"] = cookie;
  }
}

/** Applies public product dashboard headers and optional CORS. */
function setProductResponseHeaders(request: Request, set: AdminResponseSet): void {
  const origin = request.headers.get("origin");
  const allowedOrigins =
    parseStringList(process.env.HEIMDALL_APP_ALLOWED_ORIGINS) ??
    parseStringList(process.env.WEB_URL) ??
    [];
  set.headers = {
    ...(set.headers ?? {}),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };

  if (origin && allowedOrigins.includes(origin)) {
    set.headers["access-control-allow-credentials"] = "true";
    set.headers["access-control-allow-headers"] = [
      "content-type",
      "idempotency-key",
      "traceparent",
      "tracestate",
      "x-heimdall-parent-event-id",
      "x-request-id",
    ].join(",");
    set.headers["access-control-allow-methods"] = "GET,POST,PATCH,OPTIONS";
    set.headers["access-control-allow-origin"] = origin;
    set.headers.vary = "Origin";
  }
}

/** Returns a public current-user DTO for the product dashboard. */
function productMeResponse(session: ProductSessionContext): ProductMeResponse {
  return {
    installations: session.installations,
    memberships: session.actor.memberships.map((membership) => ({
      ...membership,
      capabilities: productCapabilities(membership.role),
      permissions: productPermissionsForRole(membership.role),
    })),
    ...(session.actor.selectedOrgId ? { selectedOrgId: session.actor.selectedOrgId } : {}),
    session: {
      expiresAt: session.expiresAt,
      sessionId: session.sessionId,
    },
    user: session.user,
  };
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
    ...(context.supportSessionId ? { supportSessionId: context.supportSessionId } : {}),
    ...(context.actor.displayName ? { displayName: context.actor.displayName } : {}),
    ...(context.actor.email ? { email: context.actor.email } : {}),
  };
}

/** Creates one audited, signed support session for privileged raw-data access. */
async function createAuditedSupportSession(input: {
  /** Resolved admin auth configuration used for support-session signing. */
  readonly auth: ResolvedAdminControlPlaneAuthOptions;
  /** Request body after validation. */
  readonly body: CreateSupportSessionRequestBody;
  /** Authenticated admin request context. */
  readonly context: AdminRequestContext;
  /** Control-plane service used for audit and scope lookups. */
  readonly service: AdminControlPlaneService;
}): Promise<SupportSessionTokenSummary> {
  const secret = requireValue(input.auth.supportSessionSecret);
  const resource = await resolveSupportSessionResourceScope(
    input.service,
    input.context.actor,
    input.body,
  );
  const supportSessionId = `supp_${randomBytes(24).toString("base64url")}`;
  const createdAt = new Date();
  const expiresInMinutes = input.body.expiresInMinutes ?? DEFAULT_SUPPORT_SESSION_EXPIRES_MINUTES;
  const expiresAt = new Date(createdAt.getTime() + expiresInMinutes * 60 * 1000).toISOString();
  const claims: SupportSessionTokenClaims = {
    actorUserId: input.context.actor.actorUserId,
    createdAt: createdAt.toISOString(),
    expiresAt,
    scopes: input.body.scopes ?? defaultSupportSessionScopes(),
    supportSessionId,
    version: SUPPORT_SESSION_TOKEN_VERSION,
    ...(resource.orgId ? { orgId: resource.orgId } : {}),
    ...(resource.repoId ? { repoId: resource.repoId } : {}),
    ...(resource.reviewRunId ? { reviewRunId: resource.reviewRunId } : {}),
  };
  const token = createSupportSessionToken(claims, secret);
  const auditLog = await input.service.recordAuditEvent({
    action: "admin.support_session.created",
    actor: input.context.actor,
    metadata: {
      createdAt: createdAt.toISOString(),
      expiresInMinutes,
      expiresAt,
      reason: input.body.reason,
      requestId: input.context.requestId,
      scopes: claims.scopes,
      supportSessionId,
      tokenHash: supportSessionTokenHash(token),
      ...(resource.reviewRunId ? { reviewRunId: resource.reviewRunId } : {}),
      ...(resource.repoId ? { repoId: resource.repoId } : {}),
    },
    ...(resource.orgId ? { orgId: resource.orgId } : {}),
    requestId: input.context.requestId,
    resourceId: supportSessionId,
    resourceType: "support_session",
    sessionId: input.context.session.sessionId,
  });

  return {
    auditLogId: auditLog.auditLogId,
    expiresAt,
    scopes: claims.scopes,
    supportSessionId,
    token,
    ...(resource.orgId ? { orgId: resource.orgId } : {}),
    ...(resource.repoId ? { repoId: resource.repoId } : {}),
    ...(resource.reviewRunId ? { reviewRunId: resource.reviewRunId } : {}),
  };
}

/** Reads and validates a support-session creation request body. */
async function readCreateSupportSessionRequestBody(
  request: Request,
): Promise<CreateSupportSessionRequestBody> {
  const body = asRecord(await request.json().catch(() => undefined));
  if (!body) {
    throw new AdminRequestValidationError(
      "admin.support_session_body_invalid",
      "Support-session creation requires a JSON object body.",
      400,
    );
  }

  const reason = stringField(body, "reason");
  if (!reason) {
    throw new AdminRequestValidationError(
      "admin.reason_required",
      "Support-session creation requires a non-empty reason.",
      400,
    );
  }
  if (reason.length > 1000) {
    throw new AdminRequestValidationError(
      "admin.reason_too_long",
      "Support-session reason must be at most 1000 characters.",
      400,
    );
  }

  const expiresInMinutes = supportSessionExpiresInMinutes(body.expiresInMinutes);
  const scopes =
    body.scopes === undefined
      ? defaultSupportSessionScopes()
      : supportSessionScopesFromValue(body.scopes);
  if (scopes.length === 0) {
    throw new AdminRequestValidationError(
      "admin.support_session_scope_invalid",
      "Support-session scopes must include at least one supported scope.",
      400,
    );
  }

  const orgId = stringField(body, "orgId");
  const repoId = stringField(body, "repoId");
  const reviewRunId = stringField(body, "reviewRunId");

  return {
    expiresInMinutes,
    reason,
    scopes,
    ...(orgId ? { orgId } : {}),
    ...(repoId ? { repoId } : {}),
    ...(reviewRunId ? { reviewRunId } : {}),
  };
}

/** Resolves and authorizes the resource scope for one support-session token. */
async function resolveSupportSessionResourceScope(
  service: AdminControlPlaneService,
  actor: AdminActor,
  body: CreateSupportSessionRequestBody,
): Promise<SupportSessionResourceScope> {
  if (body.reviewRunId) {
    const reviewRun = await service.getReviewRun(body.reviewRunId);
    ensureConsistentSupportSessionScope(body, {
      orgId: reviewRun.orgId,
      repoId: reviewRun.repoId,
      reviewRunId: reviewRun.reviewRunId,
    });
    ensureActorCanCreateSupportSession(actor, {
      orgId: reviewRun.orgId,
      repoId: reviewRun.repoId,
      reviewRunId: reviewRun.reviewRunId,
    });
    return {
      orgId: reviewRun.orgId,
      repoId: reviewRun.repoId,
      reviewRunId: reviewRun.reviewRunId,
    };
  }

  if (body.repoId) {
    const settings = await service.getRepositorySettings(body.repoId);
    ensureConsistentSupportSessionScope(body, {
      orgId: settings.repository.orgId,
      repoId: settings.repository.repoId,
    });
    ensureActorCanCreateSupportSession(actor, {
      orgId: settings.repository.orgId,
      repoId: settings.repository.repoId,
    });
    return { orgId: settings.repository.orgId, repoId: settings.repository.repoId };
  }

  if (body.orgId) {
    ensureActorCanCreateSupportSession(actor, { orgId: body.orgId });
    return { orgId: body.orgId };
  }

  if (!actorHasPermission(actor, "admin.settings.manage")) {
    throw new AdminRequestValidationError(
      "admin.support_session_scope_required",
      "Support-session creation requires an organization, repository, or review-run scope.",
      400,
    );
  }

  return {};
}

/** Ensures an explicit support-session request scope matches the loaded resource. */
function ensureConsistentSupportSessionScope(
  requested: CreateSupportSessionRequestBody,
  resolved: SupportSessionResourceScope,
): void {
  if (
    (requested.orgId && requested.orgId !== resolved.orgId) ||
    (requested.repoId && requested.repoId !== resolved.repoId) ||
    (requested.reviewRunId && requested.reviewRunId !== resolved.reviewRunId)
  ) {
    throw new AdminRequestValidationError(
      "admin.support_session_scope_mismatch",
      "Support-session resource scope does not match the requested resource.",
      400,
    );
  }
}

/** Ensures an actor can create a support session for the requested resource. */
function ensureActorCanCreateSupportSession(
  actor: AdminActor,
  resource: SupportSessionResourceScope,
): void {
  const permitted = resource.repoId
    ? actorCanAccessRepo(actor, resource.repoId, resource.orgId)
    : actorCanAccessOrg(actor, resource.orgId);
  if (!permitted) {
    throw new AdminRequestValidationError(
      "admin.scope_forbidden",
      "Admin actor is not scoped to this organization or repository.",
      403,
    );
  }
}

/** Returns the bounded support-session lifetime from an unknown request value. */
function supportSessionExpiresInMinutes(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_SUPPORT_SESSION_EXPIRES_MINUTES;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_SUPPORT_SESSION_EXPIRES_MINUTES
  ) {
    throw new AdminRequestValidationError(
      "admin.support_session_ttl_invalid",
      `Support-session expiresInMinutes must be an integer between 1 and ${MAX_SUPPORT_SESSION_EXPIRES_MINUTES}.`,
      400,
    );
  }

  return value;
}

/** Returns the default support-session scopes for privileged raw support workflows. */
function defaultSupportSessionScopes(): readonly SupportSessionScope[] {
  return ["raw_artifact_payload", "raw_eval_import"];
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

/** Extracts a repository reindex command body from JSON with validation. */
async function readRepositoryReindexBody(request: Request): Promise<RepositoryReindexBody> {
  const body = await request.json().catch(() => undefined);
  const record = asRecord(body);
  const commitSha = stringField(record, "commitSha");
  if (commitSha && !isValidGitCommitSha(commitSha)) {
    throw new AdminRequestValidationError(
      "repo.commit_sha_invalid",
      "Repository reindex commitSha must be a 7 to 64 character Git commit SHA.",
      400,
    );
  }

  const reason = stringField(record, "reason");
  const force = record.force;
  if (force !== undefined && typeof force !== "boolean") {
    throw new AdminRequestValidationError(
      "repo.reindex_force_invalid",
      "Repository reindex force must be a boolean when provided.",
      400,
    );
  }

  return {
    ...(commitSha ? { commitSha } : {}),
    ...(typeof force === "boolean" ? { force } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** Extracts a finding outcome update body from JSON with validation. */
async function readFindingOutcomePatchBody(request: Request): Promise<FindingOutcomePatchBody> {
  const body = await request.json().catch(() => undefined);
  const record = asRecord(body);
  const outcome = stringField(record, "outcome") ?? stringField(record, "outcomeType");
  if (!outcome || !isFindingOutcomeType(outcome)) {
    throw new AdminRequestValidationError(
      "finding.outcome_invalid",
      "Finding outcome must be one of the supported outcome labels.",
      400,
    );
  }

  const source =
    stringField(record, "source") ?? stringField(record, "signalSource") ?? "user_action";
  if (!isFindingOutcomeSource(source)) {
    throw new AdminRequestValidationError(
      "finding.outcome_source_invalid",
      "Finding outcome source must be one of the supported signal sources.",
      400,
    );
  }

  const occurredAt = isoDateFromRecord(record, "occurredAt") ?? new Date().toISOString();
  const metadataValue = record.metadata;
  if (
    metadataValue !== undefined &&
    (metadataValue === null || typeof metadataValue !== "object" || Array.isArray(metadataValue))
  ) {
    throw new AdminRequestValidationError(
      "finding.outcome_metadata_invalid",
      "Finding outcome metadata must be an object when provided.",
      400,
    );
  }

  return {
    ...(metadataValue ? { metadata: asRecord(metadataValue) } : {}),
    ...(stringField(record, "notes") ? { notes: stringField(record, "notes") } : {}),
    occurredAt,
    outcome,
    source,
  };
}

/** Extracts a suppress-similar request body from JSON with validation. */
async function readSuppressSimilarFindingBody(
  request: Request,
): Promise<SuppressSimilarFindingBody> {
  const record = asRecord(await request.json().catch(() => undefined));
  const rawScope = stringField(record, "scope") ?? "repo";
  if (rawScope !== "repo" && rawScope !== "org") {
    throw new AdminRequestValidationError(
      "finding.suppression_scope_invalid",
      "Finding suppression scope must be repo or org.",
      400,
    );
  }

  const reason = optionalBoundedStringField(record, "reason", 1000);
  if (!reason) {
    throw new AdminRequestValidationError(
      "finding.suppression_reason_required",
      "Finding suppression reason is required.",
      400,
    );
  }

  const expiresAt = isoDateFromRecord(record, "expiresAt");
  if (expiresAt && new Date(expiresAt).valueOf() <= Date.now()) {
    throw new AdminRequestValidationError(
      "finding.suppression_expiration_invalid",
      "Finding suppression expiresAt must be in the future.",
      400,
    );
  }

  return {
    ...(expiresAt ? { expiresAt } : {}),
    reason,
    scope: rawScope,
  };
}

/** Extracts a memory fact creation body from JSON with validation. */
async function readMemoryFactCreateBody(request: Request): Promise<MemoryFactCreateBody> {
  const record = asRecord(await request.json().catch(() => undefined));
  const kind = readMemoryFactKind(record, true);
  const text = stringField(record, "text") ?? stringField(record, "body");
  if (!text || text.length > 4000) {
    throw new AdminRequestValidationError(
      "memory.text_invalid",
      "Memory fact text is required and must be at most 4000 characters.",
      400,
    );
  }

  const source = readMemoryFactSource(record) ?? "manual";
  const confidence = optionalConfidenceField(record, "confidence") ?? 1;
  const enabled = optionalBooleanField(record, "enabled") ?? true;
  const metadata = optionalMetadataRecord(record);
  const subject = optionalBoundedStringField(record, "subject", 300);
  const expiresAt = isoDateFromRecord(record, "expiresAt");

  return {
    confidence,
    enabled,
    ...(expiresAt ? { expiresAt } : {}),
    kind,
    ...(metadata ? { metadata } : {}),
    source,
    ...(subject ? { subject } : {}),
    text,
  };
}

/** Extracts a memory fact update body from JSON with validation. */
async function readMemoryFactPatchBody(request: Request): Promise<MemoryFactPatchBody> {
  const record = asRecord(await request.json().catch(() => undefined));
  const enabled = optionalBooleanField(record, "enabled");
  const confidence = optionalConfidenceField(record, "confidence");
  const expiresAt = readNullableIsoDateFromRecord(record, "expiresAt");
  const kind = readMemoryFactKind(record, false);
  const metadata = optionalMetadataRecord(record);
  const source = readMemoryFactSource(record);
  const status = readMemoryFactStatus(record);
  const subject = optionalBoundedStringField(record, "subject", 300);
  const text =
    optionalBoundedStringField(record, "text", 4000) ??
    optionalBoundedStringField(record, "body", 4000);
  const patch: MemoryFactPatchBody = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(kind ? { kind } : {}),
    ...(metadata ? { metadata } : {}),
    ...(source ? { source } : {}),
    ...(status ? { status } : {}),
    ...(subject ? { subject } : {}),
    ...(text ? { text } : {}),
  };
  if (Object.keys(patch).length === 0) {
    throw new AdminRequestValidationError(
      "memory.patch_empty",
      "Memory fact update requires at least one field.",
      400,
    );
  }

  return patch;
}

/** Extracts a memory candidate moderation body from JSON with validation. */
async function readMemoryCandidateModerationBody(
  request: Request,
): Promise<MemoryCandidateModerationBody> {
  const record = asRecord(await request.json().catch(() => undefined));
  const metadata = optionalMetadataRecord(record);
  const reason = optionalBoundedStringField(record, "reason", 1000);

  return {
    ...(metadata ? { metadata } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** Reads a memory fact kind from a JSON record. */
function readMemoryFactKind(record: Record<string, unknown>, required: true): MemoryFactKind;
function readMemoryFactKind(
  record: Record<string, unknown>,
  required: false,
): MemoryFactKind | undefined;
function readMemoryFactKind(
  record: Record<string, unknown>,
  required: boolean,
): MemoryFactKind | undefined {
  const value = stringField(record, "kind") ?? stringField(record, "factType");
  if (!value) {
    if (required) {
      throw new AdminRequestValidationError(
        "memory.kind_required",
        "Memory fact kind is required.",
        400,
      );
    }

    return undefined;
  }
  if (!isMemoryFactKind(value)) {
    throw new AdminRequestValidationError(
      "memory.kind_invalid",
      "Memory fact kind is not supported.",
      400,
    );
  }

  return value;
}

/** Reads a memory fact source from a JSON record. */
function readMemoryFactSource(record: Record<string, unknown>): MemoryFactSource | undefined {
  const value = stringField(record, "source");
  if (!value) {
    return undefined;
  }
  if (!isMemoryFactSource(value)) {
    throw new AdminRequestValidationError(
      "memory.source_invalid",
      "Memory fact source is not supported.",
      400,
    );
  }

  return value;
}

/** Reads a memory fact status from a JSON record. */
function readMemoryFactStatus(record: Record<string, unknown>): MemoryFactStatus | undefined {
  const value = stringField(record, "status");
  if (!value) {
    return undefined;
  }
  if (!isMemoryFactStatus(value)) {
    throw new AdminRequestValidationError(
      "memory.status_invalid",
      "Memory fact status is not supported.",
      400,
    );
  }

  return value;
}

/** Returns whether a string is a supported finding outcome label. */
function isFindingOutcomeType(value: string): value is FindingOutcomeType {
  return FINDING_OUTCOME_TYPES.has(value as FindingOutcomeType);
}

/** Returns whether a string is a supported finding outcome signal source. */
function isFindingOutcomeSource(value: string): value is FindingOutcomeSignalSource {
  return FINDING_OUTCOME_SOURCES.has(value as FindingOutcomeSignalSource);
}

/** Returns whether a string is a supported memory fact kind. */
function isMemoryFactKind(value: string): value is MemoryFactKind {
  return MEMORY_FACT_KINDS.has(value as MemoryFactKind);
}

/** Returns whether a string is a supported memory fact source. */
function isMemoryFactSource(value: string): value is MemoryFactSource {
  return MEMORY_FACT_SOURCES.has(value as MemoryFactSource);
}

/** Returns whether a string is a supported memory fact status. */
function isMemoryFactStatus(value: string): value is MemoryFactStatus {
  return MEMORY_FACT_STATUSES.has(value as MemoryFactStatus);
}

/** Returns whether a string is a supported memory candidate status. */
function isMemoryCandidateStatus(value: string): boolean {
  return MEMORY_CANDIDATE_STATUSES.has(value);
}

/** Returns whether a string is a supported usage summary grouping dimension. */
function isProductUsageGroupBy(value: string): value is ProductUsageSummaryGroupBy {
  return value === "day" || value === "week" || value === "month" || value === "repo";
}

/** Returns whether a string is a supported usage event type. */
function isUsageEventType(value: string): value is UsageEventType {
  return USAGE_EVENT_TYPES.has(value as UsageEventType);
}

/** Reads and validates an ISO-compatible timestamp field from a JSON record. */
function isoDateFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(record, key);
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new AdminRequestValidationError(
      "timestamp.invalid",
      `${key} must be an ISO-compatible timestamp.`,
      400,
    );
  }

  return date.toISOString();
}

/** Reads and validates an optional nullable ISO timestamp field from a JSON record. */
function readNullableIsoDateFromRecord(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in record)) {
    return undefined;
  }
  if (record[key] === null) {
    return null;
  }

  return isoDateFromRecord(record, key);
}

/** Reads and validates an optional bounded string field from a JSON record. */
function optionalBoundedStringField(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = stringField(record, key);
  if (!value) {
    return undefined;
  }
  if (value.length > maxLength) {
    throw new AdminRequestValidationError(
      "string.too_long",
      `${key} must be at most ${maxLength} characters.`,
      400,
    );
  }

  return value;
}

/** Reads and validates an optional confidence field from a JSON record. */
function optionalConfidenceField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new AdminRequestValidationError(
      "confidence.invalid",
      `${key} must be a number between 0 and 1.`,
      400,
    );
  }

  return value;
}

/** Reads and validates an optional boolean field from a JSON record. */
function optionalBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new AdminRequestValidationError("boolean.invalid", `${key} must be a boolean.`, 400);
  }

  return value;
}

/** Reads and validates optional metadata from a JSON record. */
function optionalMetadataRecord(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const metadata = record.metadata;
  if (metadata === undefined) {
    return undefined;
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new AdminRequestValidationError(
      "metadata.invalid",
      "metadata must be an object when provided.",
      400,
    );
  }

  return asRecord(metadata);
}

/** Returns whether a value is acceptable as a Git commit SHA for reindex jobs. */
function isValidGitCommitSha(value: string): boolean {
  return /^[A-Fa-f0-9]{7,64}$/u.test(value);
}

/** Extracts an eval import request from a JSON request body with safe defaults. */
async function readEvalImportRequest(
  request: Request,
  reviewRunId: string,
): Promise<ImportReviewRunToEvalRequest> {
  const body = await request.json().catch(() => undefined);
  const record = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const caseName = stringRecordValue(record, "caseName") ?? `Imported review ${reviewRunId}`;
  const suiteId = stringRecordValue(record, "suiteId") ?? "smoke-full-pipeline-v1";
  const reason = stringRecordValue(record, "reason");
  if (!reason) {
    throw new AdminRequestValidationError(
      "admin.reason_required",
      "Admin eval import drafts require a non-empty reason.",
      400,
    );
  }
  const labels = stringArrayRecordValue(record, "labels");

  return {
    reviewRunId,
    suiteId,
    caseName,
    reason,
    includeArtifacts: {
      pullRequestSnapshot: booleanRecordValue(record, "pullRequestSnapshot", true),
      rawDiff: booleanRecordValue(record, "rawDiff", false),
      contextBundle: booleanRecordValue(record, "contextBundle", false),
      reviewOutputs: booleanRecordValue(record, "reviewOutputs", true),
      validationOutputs: booleanRecordValue(record, "validationOutputs", true),
    },
    redactionLevel: evalImportRedactionLevel(stringRecordValue(record, "redactionLevel")),
    ...(labels.length > 0 ? { labels } : {}),
  };
}

/** Reads one string property from an unknown record. */
function stringRecordValue(record: object, key: string): string | undefined {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Reads one string-array property from an unknown record. */
function stringArrayRecordValue(record: object, key: string): readonly string[] {
  const value = (record as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

/** Reads one boolean property from an unknown record. */
function booleanRecordValue(record: object, key: string, fallback: boolean): boolean {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : fallback;
}

/** Narrows eval import redaction levels. */
function evalImportRedactionLevel(
  value: string | undefined,
): ImportReviewRunToEvalRequest["redactionLevel"] {
  return value === "synthetic" || value === "raw_allowed" ? value : "redacted";
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
  if (error instanceof AdminRequestValidationError) {
    set.status = error.status;
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

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
  if (error instanceof AdminRequestValidationError) {
    set.status = error.status;
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  if (error instanceof AdminControlPlaneNotFoundError) {
    set.status = 404;
    return adminNotFoundResponse(error.resourceType, error.resourceId, error.message);
  }

  if (error instanceof AdminControlPlaneConfigurationError) {
    set.status = error.statusCode;
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
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
  const route = routeFromRequest(request);
  tryRecordAdminControlPlaneTelemetryEvent(observabilitySink, {
    ...baseEvent,
    ...(actorUserId ? { actorUserId } : {}),
    ...(orgId ? { orgId } : {}),
    ...(repoId ? { repoId } : {}),
    route,
  });

  const actionKind = completedAdminActionKind(baseEvent.name, baseEvent.statusCode);
  if (!actionKind) {
    return;
  }

  tryRecordAdminControlPlaneTelemetryEvent(observabilitySink, {
    attributes: {
      actionKind,
      sourceEventName: baseEvent.name,
      status: "completed",
    },
    name: "admin.action.completed",
    route,
    ...(actorUserId ? { actorUserId } : {}),
    ...(orgId ? { orgId } : {}),
    ...(repoId ? { repoId } : {}),
    ...(baseEvent.requestId ? { requestId: baseEvent.requestId } : {}),
    ...(baseEvent.statusCode ? { statusCode: baseEvent.statusCode } : {}),
  });
}

/** Returns the generic admin action kind for a completed source telemetry event. */
function completedAdminActionKind(
  name: AdminControlPlaneTelemetryEventName,
  statusCode: number | undefined,
): string | undefined {
  if ((statusCode ?? 200) >= 400) {
    return undefined;
  }

  return ADMIN_ACTION_KIND_BY_TELEMETRY_NAME[name];
}

/** Product-safe attributes attached to admin access-denied telemetry. */
type AdminAccessDeniedAttributes = Readonly<Record<string, string | number | boolean>>;

/** Security event type emitted for each high-risk admin denial code. */
const SECURITY_EVENT_TYPE_BY_ADMIN_DENIAL_CODE = {
  "admin.cors_forbidden": "admin_cors_forbidden",
  "admin.csrf_forbidden": "admin_csrf_forbidden",
  "admin.forbidden": "admin_permission_denied",
  "admin.invalid_support_session": "admin_support_session_invalid",
  "admin.rate_limited": "admin_rate_limited",
  "admin.support_session_required": "admin_support_session_required",
  "admin.unauthorized": "admin_auth_denied",
} as const satisfies Readonly<Record<string, string>>;

/** Explicit security event severities for admin denial codes that need stronger defaults. */
const SECURITY_EVENT_SEVERITY_BY_ADMIN_DENIAL_CODE = {
  "admin.invalid_support_session": "high",
  "admin.support_session_required": "high",
} as const satisfies Readonly<Record<string, SecurityEventSeverity>>;

/** Admin denial attribute keys copied to normalized security-event top-level fields. */
const SECURITY_EVENT_TOP_LEVEL_ADMIN_DENIAL_ATTRIBUTES = new Set([
  "actorUserId",
  "orgId",
  "repoId",
  "resourceId",
  "resourceType",
]);

/** Records a denied admin access event for alerting and audit correlation. */
function recordAdminAccessDenied(
  observabilitySink: ObservabilitySink,
  request: Request,
  requestId: string,
  code: string,
  statusCode: number,
  attributes: AdminAccessDeniedAttributes = {},
  securityEventSink?: SecurityEventSink | undefined,
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
  tryRecordAdminAccessDeniedSecurityEvent(
    securityEventSink,
    request,
    requestId,
    code,
    statusCode,
    attributes,
  );
}

/** Records a normalized security event for high-risk admin denials when configured. */
function tryRecordAdminAccessDeniedSecurityEvent(
  securityEventSink: SecurityEventSink | undefined,
  request: Request,
  requestId: string,
  code: string,
  statusCode: number,
  attributes: AdminAccessDeniedAttributes,
): void {
  if (!securityEventSink) {
    return;
  }

  const eventType = securityEventTypeForAdminDenial(code);
  if (!eventType) {
    return;
  }

  try {
    recordSecurityEvent(securityEventSink, {
      actorId: stringAdminDeniedAttribute(attributes, "actorUserId"),
      metadata: {
        denialReason: code,
        method: request.method,
        requestId,
        route: routeFromRequest(request),
        statusCode,
        ...securityEventMetadataFromAdminDeniedAttributes(attributes),
      },
      orgId: stringAdminDeniedAttribute(attributes, "orgId"),
      repoId: stringAdminDeniedAttribute(attributes, "repoId"),
      resourceId:
        stringAdminDeniedAttribute(attributes, "resourceId") ??
        stringAdminDeniedAttribute(attributes, "reviewRunId"),
      resourceType: securityEventResourceTypeForAdminDenial(code, attributes),
      severity: securityEventSeverityForAdminDenial(code, statusCode),
      source: "api",
      type: eventType,
    });
  } catch {
    // Security event sinks must never change the request outcome.
  }
}

/** Returns the normalized security event type for an admin denial code. */
function securityEventTypeForAdminDenial(code: string): string | undefined {
  if (code.startsWith("admin_auth.")) {
    return "admin_auth_denied";
  }
  if (code.startsWith("artifact.")) {
    return "review_artifact_access_denied";
  }

  return SECURITY_EVENT_TYPE_BY_ADMIN_DENIAL_CODE[
    code as keyof typeof SECURITY_EVENT_TYPE_BY_ADMIN_DENIAL_CODE
  ];
}

/** Returns the security severity for one admin denial. */
function securityEventSeverityForAdminDenial(
  code: string,
  statusCode: number,
): SecurityEventSeverity {
  const explicitSeverity =
    SECURITY_EVENT_SEVERITY_BY_ADMIN_DENIAL_CODE[
      code as keyof typeof SECURITY_EVENT_SEVERITY_BY_ADMIN_DENIAL_CODE
    ];
  if (explicitSeverity) {
    return explicitSeverity;
  }
  if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
    return "medium";
  }

  return statusCode >= 500 ? "high" : "low";
}

/** Returns the product-safe resource type for one admin denial security event. */
function securityEventResourceTypeForAdminDenial(
  code: string,
  attributes: AdminAccessDeniedAttributes,
): string {
  const explicitResourceType = stringAdminDeniedAttribute(attributes, "resourceType");
  if (explicitResourceType) {
    return explicitResourceType;
  }
  if (code.startsWith("artifact.") || stringAdminDeniedAttribute(attributes, "reviewRunId")) {
    return "review_artifact";
  }
  if (stringAdminDeniedAttribute(attributes, "permission")) {
    return "admin_permission";
  }

  return "admin_route";
}

/** Copies non-top-level admin denial attributes into security-event metadata. */
function securityEventMetadataFromAdminDeniedAttributes(
  attributes: AdminAccessDeniedAttributes,
): AdminAccessDeniedAttributes {
  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!SECURITY_EVENT_TOP_LEVEL_ADMIN_DENIAL_ATTRIBUTES.has(key)) {
      metadata[key] = value;
    }
  }

  return metadata;
}

/** Reads one string admin-denial attribute by key. */
function stringAdminDeniedAttribute(
  attributes: AdminAccessDeniedAttributes,
  key: string,
): string | undefined {
  const value = attributes[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** HTTP status names that Elysia may expose through response state. */
const ELYSIA_STATUS_CODE_BY_NAME = {
  Accepted: 202,
  "Bad Request": 400,
  Created: 201,
  Forbidden: 403,
  Found: 302,
  "Internal Server Error": 500,
  "No Content": 204,
  "Not Found": 404,
  OK: 200,
  "Service Unavailable": 503,
  Unauthorized: 401,
} as const satisfies Readonly<Record<string, number>>;

/** Elysia lifecycle error codes mapped to product-safe HTTP status labels. */
const API_ERROR_STATUS_CODE_BY_CODE = {
  INTERNAL_SERVER_ERROR: 500,
  INVALID_COOKIE_SIGNATURE: 400,
  INVALID_FILE_TYPE: 415,
  NOT_FOUND: 404,
  PARSE: 400,
  UNKNOWN: 500,
  VALIDATION: 400,
} as const satisfies Readonly<Record<string, number>>;

/** Ends request-boundary spans and emits low-cardinality request metrics. */
function finishApiRequestTelemetry(
  apiRequestTelemetry: WeakMap<Request, ApiRequestTelemetryState>,
  metrics: TelemetryMetricRecorder,
  input: ApiRequestTelemetryEndInput,
): void {
  const state = apiRequestTelemetry.get(input.request);
  if (!state) {
    return;
  }
  apiRequestTelemetry.delete(input.request);

  const durationMs = Math.max(0, Date.now() - state.startedAtMs);
  const method = normalizedRequestMethod(input.method);
  const route = telemetryRouteLabel(input.route);
  const statusCode = normalizedStatusCode(input.statusCode, 500);
  const statusFamily = statusFamilyFromCode(statusCode);
  const labels = {
    "http.request.method": method,
    "http.response.status_code": statusCode,
    "http.route": route,
    "http.status_family": statusFamily,
  };

  metrics.count(OBSERVABILITY_METRIC_NAMES.apiRequestsTotal, { labels });
  metrics.histogram(OBSERVABILITY_METRIC_NAMES.apiRequestDurationMs, durationMs, {
    labels,
    unit: "ms",
  });
  state.span.end({
    attributes: labels,
    ...(input.error === undefined ? {} : { error: input.error }),
    status: input.error === undefined && statusCode < 500 ? "ok" : "error",
  });
}

/** Returns an uppercase HTTP method label with a bounded fallback. */
function normalizedRequestMethod(method: string): string {
  const normalizedMethod = method.trim().toUpperCase();
  return /^[A-Z]{1,16}$/u.test(normalizedMethod) ? normalizedMethod : "UNKNOWN";
}

/** Returns a low-cardinality route label for API request telemetry. */
function telemetryRouteLabel(route: string | undefined): string {
  if (!route?.startsWith("/")) {
    return "unknown";
  }

  return route.replaceAll(/[?#].*$/gu, "").slice(0, 120);
}

/** Returns a valid HTTP status code for telemetry labels. */
function normalizedStatusCode(statusCode: number, fallback: number): number {
  return Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? statusCode
    : fallback;
}

/** Returns the coarse HTTP status family label for metrics. */
function statusFamilyFromCode(statusCode: number): string {
  return `${Math.trunc(statusCode / 100)}xx`;
}

/** Starts provider webhook delivery telemetry for route-local instrumentation. */
function startWebhookDeliveryTelemetry(
  traces: TelemetrySpanRecorder,
  request: Request,
  provider: string,
  rawBody: Uint8Array,
): WebhookTelemetryState {
  const action = webhookActionFromRawBody(rawBody);
  const eventName = webhookEventNameFromRequest(request);
  const requestId = requestIdFromRequest(request);
  const span = traces.startSpan(OBSERVABILITY_SPAN_NAMES.webhookDelivery, {
    attributes: {
      "webhook.action": action,
      "webhook.event_name": eventName,
      "webhook.provider": provider,
    },
    kind: "server",
    traceContext: traceContextFromRequest(request, requestId),
  });

  return {
    action,
    eventName,
    provider,
    requestId,
    span,
    startedAtMs: Date.now(),
  };
}

/** Records a product-safe security event for rejected GitHub webhook signatures. */
function tryRecordInvalidGitHubWebhookSignatureSecurityEvent(
  securityEventSink: SecurityEventSink,
  request: Request,
  telemetry: WebhookTelemetryState,
): void {
  try {
    const deliveryId = webhookHeaderMetadataValue(request.headers, "x-github-delivery");
    recordSecurityEvent(securityEventSink, {
      metadata: {
        action: telemetry.action,
        eventName: telemetry.eventName,
        method: request.method,
        provider: telemetry.provider,
        reason: "invalid_signature",
        requestId: telemetry.requestId,
        route: routeFromRequest(request),
        statusCode: 401,
        ...(deliveryId ? { deliveryId } : {}),
      },
      resourceId: deliveryId,
      resourceType: "webhook_delivery",
      severity: "high",
      source: "api",
      type: "invalid_webhook_signature_spike",
    });
  } catch {
    // Security event sinks must never change the webhook response outcome.
  }
}

/** Ends webhook delivery telemetry and emits low-cardinality delivery metrics. */
function finishWebhookDeliveryTelemetry(
  metrics: TelemetryMetricRecorder,
  telemetry: WebhookTelemetryState,
  input: WebhookTelemetryEndInput,
): void {
  const durationMs = Math.max(0, Date.now() - telemetry.startedAtMs);
  const labels = webhookDeliveryMetricLabels(telemetry, input.webhookStatus);
  metrics.count(OBSERVABILITY_METRIC_NAMES.webhookDeliveriesTotal, { labels });
  metrics.histogram(OBSERVABILITY_METRIC_NAMES.webhookDeliveryDurationMs, durationMs, {
    labels,
    unit: "ms",
  });

  if (input.webhookStatus === "duplicate") {
    metrics.count(OBSERVABILITY_METRIC_NAMES.webhookDuplicateDeliveriesTotal, {
      labels: {
        event_name: telemetry.eventName,
        provider: telemetry.provider,
      },
    });
  }
  if (input.webhookStatus === "rejected") {
    metrics.count(OBSERVABILITY_METRIC_NAMES.webhookRejectionsTotal, {
      labels: {
        provider: telemetry.provider,
        reason: normalizeWebhookLabel(input.reason ?? "unknown"),
      },
    });
  }

  telemetry.span.end({
    attributes: {
      ...labels,
      "http.response.status_code": normalizedStatusCode(input.statusCode, 500),
      ...(input.reason ? { reason: normalizeWebhookLabel(input.reason) } : {}),
    },
    ...(input.error === undefined ? {} : { error: input.error }),
    status: input.error === undefined && input.webhookStatus !== "failed" ? "ok" : "error",
  });
}

/** Returns metric labels shared by webhook delivery counters and histograms. */
function webhookDeliveryMetricLabels(
  telemetry: WebhookTelemetryState,
  status: WebhookTelemetryStatus,
): Readonly<Record<string, string>> {
  return {
    action: telemetry.action,
    event_name: telemetry.eventName,
    provider: telemetry.provider,
    status,
  };
}

/** Returns the provider event name from a webhook request. */
function webhookEventNameFromRequest(request: Request): string {
  return normalizeWebhookLabel(request.headers.get("x-github-event") ?? "unknown");
}

/** Returns a bounded product-safe webhook header value for metadata. */
function webhookHeaderMetadataValue(headers: Headers, name: string): string | undefined {
  const value = emptyToUndefined(headers.get(name) ?? undefined);
  return value ? value.slice(0, 120) : undefined;
}

/** Returns a provider action label from a JSON webhook payload when present. */
function webhookActionFromRawBody(rawBody: Uint8Array): string {
  try {
    const payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    if (payload && typeof payload === "object" && "action" in payload) {
      const action = (payload as { readonly action?: unknown }).action;
      return normalizeWebhookLabel(typeof action === "string" ? action : "unknown");
    }
  } catch {
    return "unknown";
  }

  return "unknown";
}

/** Normalizes provider-controlled webhook labels before metric export. */
function normalizeWebhookLabel(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/gu, "_")
    .slice(0, 80);
  return normalized.length > 0 ? normalized : "unknown";
}

/** Returns a numeric status code from an Elysia set object. */
function statusCodeFromSet(set: AdminStatusSet, fallback: number): number {
  return statusCodeFromResponseStatus(set.status, fallback);
}

/** Returns a numeric status code from a route response when one is explicit. */
function statusCodeFromResponseValue(responseValue: unknown, fallback: number): number {
  if (responseValue instanceof Response) {
    return normalizedStatusCode(responseValue.status, fallback);
  }

  return fallback;
}

/** Returns the status code for an Elysia error lifecycle event. */
function apiErrorStatusCode(code: string | number, set: AdminStatusSet): number {
  const fallback =
    typeof code === "number"
      ? code
      : (API_ERROR_STATUS_CODE_BY_CODE[code as keyof typeof API_ERROR_STATUS_CODE_BY_CODE] ?? 500);
  return statusCodeFromResponseStatus(set.status, fallback);
}

/** Converts an Elysia response status value into a numeric HTTP status. */
function statusCodeFromResponseStatus(
  status: number | string | undefined,
  fallback: number,
): number {
  if (typeof status === "number") {
    return normalizedStatusCode(status, fallback);
  }
  if (typeof status !== "string") {
    return fallback;
  }

  const numericStatus = Number(status);
  if (Number.isInteger(numericStatus)) {
    return normalizedStatusCode(numericStatus, fallback);
  }

  return ELYSIA_STATUS_CODE_BY_NAME[status as keyof typeof ELYSIA_STATUS_CODE_BY_NAME] ?? fallback;
}

/** Returns the path component of a request URL. */
function routeFromRequest(request: Request): string {
  return new URL(request.url).pathname;
}

/** Returns a request ID from a header or generates one. */
function requestIdFromRequest(request: Request): string {
  return request.headers.get("x-request-id") ?? `req_${randomUUID()}`;
}

/** Returns normalized trace context for a request and the selected request ID. */
function traceContextFromRequest(request: Request, requestId: string): TelemetryTraceContext {
  return normalizeTelemetryTraceContext({
    ...createTelemetryTraceContextFromHeaders(request.headers),
    requestId,
  });
}

/** Returns a stable client key for admin route rate limiting. */
function adminRateLimitKey(request: Request): string {
  return clientIpAddressFromRequest(request) ?? "local";
}

/** Returns the first forwarded client IP address when present. */
function clientIpAddressFromRequest(request: Request): string | undefined {
  const forwardedFor = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return forwardedFor ?? request.headers.get("x-real-ip") ?? undefined;
}

/** Converts a URL and actor scope into organization discovery query. */
function scopedOrganizationListQuery(
  url: URL,
  actor: AdminActor,
  limit: number,
): AdminOrganizationListQuery {
  return {
    limit,
    orgIds: actor.orgIds,
    search: optionalQueryString(url, "search"),
  };
}

/** Converts a URL, actor scope, and selected org into a repository discovery query. */
function scopedOrganizationRepositoryListQuery(
  url: URL,
  actor: AdminActor,
  orgId: string,
  limit: number,
): AdminRepositoryListQuery {
  return {
    limit,
    orgIds: [orgId],
    repoIds: actor.repoIds,
    search: optionalQueryString(url, "search"),
  };
}

/** Converts a URL and actor scope into provider installation discovery query. */
function scopedInstallationListQuery(
  url: URL,
  actor: AdminActor,
  limit: number,
): AdminInstallationListQuery {
  return {
    limit,
    orgIds: actor.orgIds,
    provider: optionalQueryString(url, "provider"),
    search: optionalQueryString(url, "search"),
  };
}

/** Converts a URL and actor scope into a repository discovery query. */
function scopedRepositoryListQuery(
  url: URL,
  actor: AdminActor,
  limit: number,
): AdminRepositoryListQuery {
  return {
    limit,
    orgIds: actor.orgIds,
    repoIds: actor.repoIds,
    search: optionalQueryString(url, "search"),
  };
}

/** Converts a URL and actor scope into a review history query. */
function scopedReviewRunListQuery(
  url: URL,
  actor: AdminActor,
  limit: number,
): AdminReviewRunListQuery {
  return {
    limit,
    orgIds: actor.orgIds,
    repoId: optionalQueryString(url, "repoId"),
    repoIds: actor.repoIds,
    search: optionalQueryString(url, "search"),
    status: optionalQueryString(url, "status"),
  };
}

/** Converts a URL into a review finding discovery query. */
function reviewFindingListQueryFromUrl(url: URL): AdminReviewFindingListQuery {
  return {
    decision: optionalQueryString(url, "decision"),
    limit: listLimitFromUrl(url),
    severity: optionalQueryString(url, "severity"),
  };
}

/** Converts a URL into a repository memory fact discovery query. */
function memoryFactListQueryFromUrl(url: URL): AdminMemoryFactListQuery {
  const kind = optionalQueryString(url, "kind");
  const status = optionalQueryString(url, "status");
  const memoryKind = kind && isMemoryFactKind(kind) ? kind : undefined;
  const memoryStatus = status && isMemoryFactStatus(status) ? status : undefined;
  if (kind && !isMemoryFactKind(kind)) {
    throw new AdminRequestValidationError(
      "memory.kind_invalid",
      "Memory fact kind is not supported.",
      400,
    );
  }
  if (status && !isMemoryFactStatus(status)) {
    throw new AdminRequestValidationError(
      "memory.status_invalid",
      "Memory fact status is not supported.",
      400,
    );
  }

  return {
    includeOrgFacts: optionalBooleanQuery(url, "includeOrgFacts"),
    ...(memoryKind ? { kind: memoryKind } : {}),
    limit: listLimitFromUrl(url),
    ...(memoryStatus ? { status: memoryStatus } : {}),
  };
}

/** Converts a URL into a repository memory candidate discovery query. */
function memoryCandidateListQueryFromUrl(url: URL): AdminMemoryCandidateListQuery {
  const status = optionalQueryString(url, "candidateStatus");
  if (status && !isMemoryCandidateStatus(status)) {
    throw new AdminRequestValidationError(
      "memory_candidate.status_invalid",
      "Memory candidate status is not supported.",
      400,
    );
  }

  return {
    candidateKind: optionalQueryString(url, "candidateKind"),
    includeOrgCandidates: optionalBooleanQuery(url, "includeOrgCandidates"),
    limit: listLimitFromUrl(url),
    ...(status ? { status } : {}),
  };
}

/** Converts a URL into a repository suppression match query. */
function suppressionMatchListQueryFromUrl(url: URL): AdminSuppressionMatchListQuery {
  return {
    limit: listLimitFromUrl(url),
  };
}

/** Converts a URL and actor scope into a usage rollup query. */
function scopedUsageQuery(url: URL, actor: AdminActor): AdminUsageQuery {
  return {
    limit: listLimitFromUrl(url),
    orgIds: actor.orgIds,
    repoIds: actor.repoIds,
    orgId: optionalQueryString(url, "orgId"),
    repoId: optionalQueryString(url, "repoId"),
    periodStart: optionalIsoQueryString(url, "periodStart"),
    periodEnd: optionalIsoQueryString(url, "periodEnd"),
  };
}

/** Converts a URL into a customer-facing usage summary query. */
function productUsageSummaryQueryFromUrl(
  url: URL,
  orgId: string,
  repoId?: string,
): ProductUsageSummaryQuery {
  return {
    groupBy: productUsageGroupByFromUrl(url),
    limit: listLimitFromUrl(url),
    orgId,
    periodEnd: usagePeriodEndFromUrl(url),
    periodStart: usagePeriodStartFromUrl(url),
    ...(repoId ? { repoId } : {}),
  };
}

/** Converts a URL into a customer-facing usage event query. */
function productUsageEventsQueryFromUrl(url: URL, orgId: string): ProductUsageEventsQuery {
  const repoId = optionalQueryString(url, "repoId");
  return {
    eventType: usageEventTypeFromUrl(url),
    limit: listLimitFromUrl(url),
    orgId,
    periodEnd: usagePeriodEndFromUrl(url),
    periodStart: usagePeriodStartFromUrl(url),
    ...(repoId ? { repoId } : {}),
  };
}

/** Reads the usage period start from either public or internal query names. */
function usagePeriodStartFromUrl(url: URL): string | undefined {
  return (
    optionalStrictIsoQueryString(url, "start") ?? optionalStrictIsoQueryString(url, "periodStart")
  );
}

/** Reads the usage period end from either public or internal query names. */
function usagePeriodEndFromUrl(url: URL): string | undefined {
  return optionalStrictIsoQueryString(url, "end") ?? optionalStrictIsoQueryString(url, "periodEnd");
}

/** Reads and validates the optional product usage grouping dimension. */
function productUsageGroupByFromUrl(url: URL): ProductUsageSummaryGroupBy | undefined {
  const groupBy = optionalQueryString(url, "groupBy");
  if (!groupBy) {
    return undefined;
  }
  if (!isProductUsageGroupBy(groupBy)) {
    throw new AdminRequestValidationError(
      "usage.group_by_invalid",
      "Usage summary groupBy is not supported.",
      400,
    );
  }

  return groupBy;
}

/** Reads and validates the optional product usage event type filter. */
function usageEventTypeFromUrl(url: URL): UsageEventType | undefined {
  const eventType = optionalQueryString(url, "type") ?? optionalQueryString(url, "eventType");
  if (!eventType) {
    return undefined;
  }
  if (!isUsageEventType(eventType)) {
    throw new AdminRequestValidationError(
      "usage.event_type_invalid",
      "Usage event type is not supported.",
      400,
    );
  }

  return eventType;
}

/** Converts a URL and actor scope into an entitlement inspection query. */
function entitlementQueryFromUrl(url: URL, actor: AdminActor): AdminEntitlementQuery {
  return {
    featureKeys: featureKeysFromUrl(url),
    orgId: optionalQueryString(url, "orgId") ?? singleActorOrgScope(actor),
  };
}

/** Converts a URL and actor scope into a billing account inspection query. */
function billingQueryFromUrl(url: URL, actor: AdminActor): AdminBillingQuery {
  return {
    orgId: optionalQueryString(url, "orgId") ?? singleActorOrgScope(actor),
  };
}

/** Converts a URL and actor scope into a billing meter event inspection query. */
function billingMeterEventsQueryFromUrl(url: URL, actor: AdminActor): AdminBillingMeterEventsQuery {
  return {
    limit: listLimitFromUrl(url),
    orgId: optionalQueryString(url, "orgId") ?? singleActorOrgScope(actor),
    periodKey: optionalQueryString(url, "periodKey"),
    status: optionalQueryString(url, "status"),
  };
}

/** Converts a URL and actor scope into a billing reconciliation query. */
function billingReconciliationQueryFromUrl(
  url: URL,
  actor: AdminActor,
): AdminBillingReconciliationQuery {
  return {
    costAnomalyMicros: optionalPositiveIntegerQuery(url, "costAnomalyMicros") ?? 5_000_000,
    limit: listLimitFromUrl(url),
    meterLagMinutes: optionalPositiveIntegerQuery(url, "meterLagMinutes") ?? 120,
    orgId: optionalQueryString(url, "orgId") ?? singleActorOrgScope(actor),
    periodEnd: optionalIsoQueryString(url, "periodEnd"),
    periodKey: optionalQueryString(url, "periodKey"),
    periodStart: optionalIsoQueryString(url, "periodStart"),
  };
}

/** Builds a provider idempotency key for admin billing mutation routes. */
function billingMutationIdempotencyKey(
  request: Request,
  operation: string,
  orgId: string,
  requestId: string,
): string {
  return billingProviderIdempotencyKey(`admin.billing.${operation}`, [
    orgId,
    request.headers.get("idempotency-key")?.trim() || requestId,
  ]);
}

/** Reads the caller-provided idempotency key for installation sync requests. */
function installationSyncIdempotencyKey(
  request: Request,
  installationId: string,
  requestId: string,
): string {
  return request.headers.get("idempotency-key")?.trim() || `${installationId}:${requestId}`;
}

/** Reads the caller-provided idempotency key for repository command requests. */
function repositoryCommandIdempotencyKey(
  request: Request,
  repoId: string,
  requestId: string,
): string {
  return request.headers.get("idempotency-key")?.trim() || `${repoId}:${requestId}`;
}

/** Reads the caller-provided idempotency key for review rerun requests. */
function reviewRerunIdempotencyKey(
  request: Request,
  reviewRunId: string,
  requestId: string,
): string {
  return request.headers.get("idempotency-key")?.trim() || `${reviewRunId}:${requestId}`;
}

/** Reads the caller-provided idempotency key for finding outcome requests. */
function findingOutcomeIdempotencyKey(
  request: Request,
  findingId: string,
  requestId: string,
): string {
  return request.headers.get("idempotency-key")?.trim() || `${findingId}:${requestId}`;
}

/** Reads the caller-provided idempotency key for finding suppression requests. */
function findingSuppressionIdempotencyKey(
  request: Request,
  findingId: string,
  requestId: string,
): string {
  return request.headers.get("idempotency-key")?.trim() || `${findingId}:${requestId}`;
}

/** Reads the caller-provided idempotency key for memory fact create requests. */
function memoryFactCommandIdempotencyKey(
  request: Request,
  repoId: string,
  requestId: string,
): string {
  return request.headers.get("idempotency-key")?.trim() || `${repoId}:${requestId}`;
}

/** Reads the caller-provided idempotency key for memory candidate moderation requests. */
function memoryCandidateCommandIdempotencyKey(
  request: Request,
  memoryCandidateId: string,
  requestId: string,
): string {
  return request.headers.get("idempotency-key")?.trim() || `${memoryCandidateId}:${requestId}`;
}

/** Reads a last-known default branch head SHA from repository metadata when present. */
function repositoryMetadataHeadSha(repository: Repository): string | undefined {
  const metadata = asRecord(repository.metadata);
  const headSha = stringField(metadata, "defaultBranchHeadSha") ?? stringField(metadata, "headSha");
  return headSha && isValidGitCommitSha(headSha) ? headSha : undefined;
}

/** Returns requested feature keys or the default support-facing set. */
function featureKeysFromUrl(url: URL): readonly string[] {
  const values = url.searchParams
    .getAll("featureKey")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return values.length > 0 ? values : DEFAULT_ENTITLEMENT_FEATURE_KEYS;
}

/** Returns the actor's only concrete organization scope when it is unambiguous. */
function singleActorOrgScope(actor: AdminActor): string | undefined {
  const orgIds = actor.orgIds.filter((orgId) => orgId !== "*");
  return orgIds.length === 1 ? orgIds[0] : undefined;
}

/** Builds a recent-audit query for dashboard overview when scope permits it. */
function overviewAuditQueryForActor(
  actor: AdminActor,
  limit: number,
): AdminAuditLogQuery | undefined {
  if (actor.orgIds.includes("*")) {
    return { limit };
  }

  const orgId = actor.orgIds.find((candidate) => candidate !== "*");
  return orgId ? { limit, orgId } : undefined;
}

/** Reads a bounded list limit from a URL. */
function listLimitFromUrl(url: URL): number {
  return boundedLimit(url.searchParams.get("limit"));
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

/** Converts a URL into a bounded security event query. */
function securityEventQueryFromUrl(url: URL): AdminSecurityEventQuery {
  return {
    actorId: optionalQueryString(url, "actorId"),
    limit: boundedLimit(url.searchParams.get("limit")),
    orgId: optionalQueryString(url, "orgId"),
    repoId: optionalQueryString(url, "repoId"),
    resourceId: optionalQueryString(url, "resourceId"),
    resourceType: optionalQueryString(url, "resourceType"),
    search: optionalQueryString(url, "search"),
    severity: optionalSecurityEventSeverity(url),
    source: optionalSecurityEventSource(url),
    status: optionalSecurityEventStatus(url),
    type: optionalQueryString(url, "type"),
  };
}

/** Reads a known security event severity from a URL query string. */
function optionalSecurityEventSeverity(url: URL): SecurityEventSeverity | undefined {
  const value = optionalQueryString(url, "severity");
  return value && SECURITY_EVENT_SEVERITIES.includes(value as SecurityEventSeverity)
    ? (value as SecurityEventSeverity)
    : undefined;
}

/** Reads a known security event source from a URL query string. */
function optionalSecurityEventSource(url: URL): SecurityEventSource | undefined {
  const value = optionalQueryString(url, "source");
  return value && SECURITY_EVENT_SOURCES.includes(value as SecurityEventSource)
    ? (value as SecurityEventSource)
    : undefined;
}

/** Reads a known security event status from a URL query string. */
function optionalSecurityEventStatus(url: URL): SecurityEventStatus | undefined {
  const value = optionalQueryString(url, "status");
  return value && SECURITY_EVENT_STATUSES.includes(value as SecurityEventStatus)
    ? (value as SecurityEventStatus)
    : undefined;
}

/** Reads a non-empty query string value. */
function optionalQueryString(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value && value.length > 0 ? value : undefined;
}

/** Reads a query string value only when it is a valid ISO-compatible timestamp. */
function optionalIsoQueryString(url: URL, key: string): string | undefined {
  const value = optionalQueryString(url, key);
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

/** Reads a query string value as an ISO timestamp and rejects malformed input. */
function optionalStrictIsoQueryString(url: URL, key: string): string | undefined {
  const value = optionalQueryString(url, key);
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new AdminRequestValidationError(
      "query.timestamp_invalid",
      `Query parameter ${key} must be a valid ISO timestamp.`,
      400,
    );
  }

  return date.toISOString();
}

/** Reads a positive integer query string value. */
function optionalPositiveIntegerQuery(url: URL, key: string): number | undefined {
  const value = optionalQueryString(url, key);
  return optionalPositiveInteger(value);
}

/** Reads a boolean query string value. */
function optionalBooleanQuery(url: URL, key: string): boolean | undefined {
  const value = optionalQueryString(url, key);
  if (!value) {
    return undefined;
  }

  return value === "true" ? true : value === "false" ? false : undefined;
}

/** Parses a positive integer from a string value. */
function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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

/** Converts a security event row to the dashboard summary shape. */
function toSecurityEventSummary(row: {
  readonly securityEventId: string;
  readonly orgId: string | null;
  readonly repoId: string | null;
  readonly type: string;
  readonly severity: string;
  readonly source: string;
  readonly status: string;
  readonly actorId: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly metadata: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): AdminSecurityEventSummary {
  return {
    actorId: row.actorId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    metadata: asOptionalRecord(row.metadata) ?? {},
    orgId: row.orgId ?? undefined,
    repoId: row.repoId ?? undefined,
    resourceId: row.resourceId ?? undefined,
    resourceType: row.resourceType ?? undefined,
    securityEventId: row.securityEventId,
    severity: row.severity as SecurityEventSeverity,
    source: row.source as SecurityEventSource,
    status: row.status as SecurityEventStatus,
    type: row.type,
    updatedAt: row.updatedAt.toISOString(),
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

/** Returns whether a value is an absolute HTTP or HTTPS URL. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Converts blank environment values to undefined. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

/** Returns whether a GitHub webhook secret or secret ref is configured. */
function githubWebhookSecretConfigured(env: ApiSecretEnvironment): boolean {
  return Boolean(
    emptyToUndefined(env.GITHUB_WEBHOOK_SECRET_REF) ?? emptyToUndefined(env.GITHUB_WEBHOOK_SECRET),
  );
}

/** Builds a secret ref from an explicit ref or a local env fallback value. */
function secretRefFromEnvironment(input: {
  /** Direct local environment value used as a fallback. */
  readonly directValue: string | undefined;
  /** Local environment variable name to wrap in an env SecretRef. */
  readonly envName: string;
  /** Explicit SecretRef string. */
  readonly refValue: string | undefined;
}): SecretRef | undefined {
  const explicitRef = emptyToUndefined(input.refValue);
  if (explicitRef) {
    return parseSecretRef(explicitRef);
  }

  return emptyToUndefined(input.directValue) ? parseSecretRef(`env:${input.envName}`) : undefined;
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
