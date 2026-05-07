import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Admin control-plane permissions enforced by API routes. */
export const ADMIN_PERMISSIONS = [
  "admin.inspect",
  "admin.replay.plan",
  "admin.replay.execute",
  "admin.settings.manage",
  "admin.audit.view",
] as const;

/** One granular admin control-plane permission. */
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/** Product organization roles used by customer-facing authorization. */
export const PRODUCT_ROLES = ["owner", "admin", "member", "viewer"] as const;

/** One product organization role. */
export type ProductRole = (typeof PRODUCT_ROLES)[number];

/** Product permissions enforced by customer-facing API routes. */
export const PRODUCT_PERMISSIONS = [
  "org:view",
  "org:manage",
  "org:members:read",
  "org:members:write",
  "installation:read",
  "installation:sync",
  "repo:read",
  "repo:settings:write",
  "repo:enable",
  "repo:disable",
  "repo:reindex",
  "review:read",
  "review:debug:read",
  "review:rerun",
  "finding:read",
  "finding:write",
  "rule:read",
  "rule:write",
  "memory:read",
  "memory:write",
  "usage:read",
  "audit:read",
  "billing:manage",
  "security:manage",
] as const;

/** One product permission. */
export type ProductPermission = (typeof PRODUCT_PERMISSIONS)[number];

/** Product organization membership attached to an authenticated user. */
export type ProductMembership = {
  /** Organization that granted the role. */
  readonly orgId: string;
  /** Role granted in the organization. */
  readonly role: ProductRole;
};

/** Authenticated product actor used by customer-facing API authorization. */
export type ProductActor = {
  /** Stable product user ID. */
  readonly userId: string;
  /** Organization memberships loaded from the database. */
  readonly memberships: readonly ProductMembership[];
  /** Optional dashboard convenience selection. */
  readonly selectedOrgId?: string | undefined;
};

/** Data classes used for artifacts, logs, audit events, and retention policy. */
export const DATA_CLASSIFICATIONS = [
  "public",
  "internal",
  "customer_confidential",
  "customer_code",
  "secret",
  "regulated_personal_data",
] as const;

/** Data class used for artifacts, logs, audit events, and retention policy. */
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

/** Retention classes used by security and artifact lifecycle policy. */
export const RETENTION_CLASSES = [
  "operational_short",
  "review_artifact",
  "index_lifetime",
  "audit",
  "billing",
  "security",
  "customer_configurable",
] as const;

/** Retention class used by security and artifact lifecycle policy. */
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** Value tagged with a security data classification. */
export type ClassifiedValue<TValue> = {
  /** Classified value. */
  readonly value: TValue;
  /** Classification assigned to the value. */
  readonly classification: DataClassification;
  /** Product-safe reason for the classification. */
  readonly reason: string;
};

/** Input used to classify an artifact or artifact-like payload. */
export type ClassifyArtifactInput = {
  /** Artifact kind, such as raw_diff, context_bundle, or prompt_artifact. */
  readonly artifactType: string;
  /** Whether the artifact includes source code, diffs, snippets, or embeddings. */
  readonly containsCode?: boolean | undefined;
  /** Whether the artifact includes prompt text or prompt-derived content. */
  readonly containsPrompt?: boolean | undefined;
  /** Whether the artifact includes known or suspected credentials. */
  readonly containsToken?: boolean | undefined;
  /** Whether the artifact includes personal data such as names, emails, or profile data. */
  readonly containsPersonalData?: boolean | undefined;
};

/** Security metadata required for stored artifacts. */
export type ArtifactSecurityMetadata = {
  /** Stable artifact ID. */
  readonly artifactId: string;
  /** Organization that owns the artifact. */
  readonly orgId: string;
  /** Optional repository that owns the artifact. */
  readonly repoId?: string | undefined;
  /** Optional review run that created the artifact. */
  readonly reviewRunId?: string | undefined;
  /** Data classification assigned to the artifact. */
  readonly classification: DataClassification;
  /** Whether the artifact contains source code, diffs, snippets, prompts, or embeddings. */
  readonly containsCode: boolean;
  /** Whether the artifact contains known or suspected credentials. */
  readonly containsSecrets: boolean;
  /** Retention class applied to the artifact. */
  readonly retentionClass: RetentionClass;
  /** ISO timestamp for artifact creation. */
  readonly createdAt: string;
  /** Optional ISO timestamp when the artifact expires. */
  readonly expiresAt?: string | undefined;
  /** SHA-256 hash of the stored payload. */
  readonly sha256: string;
  /** Stored payload size in bytes. */
  readonly sizeBytes: number;
};

/** Organization retention policy controls. */
export type RetentionPolicy = {
  /** Organization that owns the policy. */
  readonly orgId: string;
  /** Retention window for raw diff artifacts. */
  readonly rawDiffDays: number;
  /** Retention window for retrieved context bundles. */
  readonly contextBundleDays: number;
  /** Retention window for prompt artifacts, or disabled to block storage. */
  readonly promptArtifactDays: number | "disabled";
  /** Retention window for generic review artifacts. */
  readonly reviewArtifactDays: number;
  /** Retention window for sandbox/static-analysis artifacts. */
  readonly sandboxArtifactDays: number;
  /** Retention behavior for index-derived artifacts. */
  readonly indexRetention: "while_enabled" | "fixed_days";
  /** Retention window for fixed-day index artifacts. */
  readonly indexArtifactDays: number;
  /** Retention window for operational short-lived records. */
  readonly operationalShortDays: number;
  /** Retention window for audit logs. */
  readonly auditLogDays: number;
  /** Retention window for billing/accounting records. */
  readonly billingUsageDays: number;
  /** Retention window for security events. */
  readonly securityEventDays: number;
  /** Whether repo disable should delete sensitive repo artifacts. */
  readonly deleteOnRepoDisable: boolean;
  /** Whether uninstall deletes immediately or after a grace period. */
  readonly deleteOnUninstall: "immediate" | "after_grace_period";
};

/** Retention decision for a stored artifact. */
export type RetentionDecision = {
  /** Retention class selected for the artifact. */
  readonly retentionClass: RetentionClass;
  /** Whether the artifact should be stored. */
  readonly storage: "allowed" | "disabled";
  /** Optional ISO expiration timestamp. */
  readonly expiresAt?: string | undefined;
  /** Whether repo disable should delete this artifact under the policy. */
  readonly deleteOnRepoDisable: boolean;
  /** Whether uninstall deletes this artifact immediately or after a grace period. */
  readonly deleteOnUninstall: "immediate" | "after_grace_period";
  /** Product-safe decision reason. */
  readonly reason: string;
};

/** Severity levels used for security events and incident triage. */
export const SECURITY_EVENT_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

/** Severity level used for security events and incident triage. */
export type SecurityEventSeverity = (typeof SECURITY_EVENT_SEVERITIES)[number];

/** Sources that can emit security events. */
export const SECURITY_EVENT_SOURCES = [
  "api",
  "worker",
  "github",
  "sandbox",
  "llm_gateway",
  "system",
] as const;

/** Source that emitted one security event. */
export type SecurityEventSource = (typeof SECURITY_EVENT_SOURCES)[number];

/** Lifecycle states for security event triage. */
export const SECURITY_EVENT_STATUSES = ["new", "triaged", "dismissed", "incident_created"] as const;

/** Lifecycle state for security event triage. */
export type SecurityEventStatus = (typeof SECURITY_EVENT_STATUSES)[number];

/** Structured high-risk security event recorded by services and control-plane workflows. */
export type SecurityEvent = {
  /** Stable event ID. */
  readonly id: string;
  /** Organization scope when the event is tenant-specific. */
  readonly orgId?: string | undefined;
  /** Repository scope when the event is repository-specific. */
  readonly repoId?: string | undefined;
  /** Event type, such as invalid_webhook_signature_spike. */
  readonly type: string;
  /** Security severity for triage and alerting. */
  readonly severity: SecurityEventSeverity;
  /** Service or subsystem that emitted the event. */
  readonly source: SecurityEventSource;
  /** Actor that triggered the event when known. */
  readonly actorId?: string | undefined;
  /** Resource type affected by the event. */
  readonly resourceType?: string | undefined;
  /** Resource ID affected by the event. */
  readonly resourceId?: string | undefined;
  /** Product-safe metadata with sensitive keys and values removed or redacted. */
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  /** ISO timestamp when the event was created. */
  readonly createdAt: string;
  /** Triage status. */
  readonly status: SecurityEventStatus;
};

/** Input accepted when creating a normalized security event. */
export type SecurityEventInput = {
  /** Optional stable event ID. Defaults to a generated ID. */
  readonly id?: string | undefined;
  /** Organization scope when the event is tenant-specific. */
  readonly orgId?: string | undefined;
  /** Repository scope when the event is repository-specific. */
  readonly repoId?: string | undefined;
  /** Event type, such as invalid_webhook_signature_spike. */
  readonly type: string;
  /** Optional explicit severity. Defaults from the event type. */
  readonly severity?: SecurityEventSeverity | undefined;
  /** Service or subsystem that emitted the event. */
  readonly source: SecurityEventSource;
  /** Actor that triggered the event when known. */
  readonly actorId?: string | undefined;
  /** Resource type affected by the event. */
  readonly resourceType?: string | undefined;
  /** Resource ID affected by the event. */
  readonly resourceId?: string | undefined;
  /** Metadata that is sanitized before recording. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /** Optional deterministic timestamp for tests. */
  readonly createdAt?: string | undefined;
  /** Triage status. Defaults to new. */
  readonly status?: SecurityEventStatus | undefined;
};

/** Sink that records normalized security events. */
export type SecurityEventSink = {
  /** Records one normalized security event. */
  readonly record: (event: SecurityEvent) => void;
};

/** In-memory security-event sink used by tests and local tools. */
export type MemorySecurityEventSink = SecurityEventSink & {
  /** Removes all recorded events. */
  readonly clear: () => void;
  /** Returns recorded events in insertion order. */
  readonly events: () => readonly SecurityEvent[];
};

/** Conservative default retention policy for MVP deployments. */
export const DEFAULT_RETENTION_POLICY = {
  auditLogDays: 365,
  billingUsageDays: 2555,
  contextBundleDays: 90,
  deleteOnRepoDisable: false,
  deleteOnUninstall: "after_grace_period",
  indexArtifactDays: 30,
  indexRetention: "while_enabled",
  operationalShortDays: 30,
  orgId: "default",
  promptArtifactDays: "disabled",
  rawDiffDays: 90,
  reviewArtifactDays: 90,
  sandboxArtifactDays: 30,
  securityEventDays: 365,
} as const satisfies RetentionPolicy;

/** Product permissions granted to each organization role. */
const PRODUCT_PERMISSIONS_BY_ROLE = {
  owner: PRODUCT_PERMISSIONS,
  admin: PRODUCT_PERMISSIONS.filter(
    (permission) => permission !== "billing:manage" && permission !== "security:manage",
  ),
  member: [
    "org:view",
    "installation:read",
    "repo:read",
    "review:read",
    "finding:read",
    "rule:read",
    "memory:read",
    "usage:read",
  ],
  viewer: [
    "org:view",
    "installation:read",
    "repo:read",
    "review:read",
    "finding:read",
    "rule:read",
    "memory:read",
    "usage:read",
  ],
} satisfies Record<ProductRole, readonly ProductPermission[]>;

/** Artifact types that are known to contain code or code-derived content. */
const codeArtifactTypes = new Set([
  "context_bundle",
  "embedding_index",
  "index_artifact",
  "llm_response_artifact",
  "prompt_artifact",
  "raw_diff",
  "source_chunk",
]);

/** Artifact types that are known to contain personal data. */
const personalDataArtifactTypes = new Set(["user_profile", "org_membership"]);

/** Artifact types that are internal-only operational data. */
const internalArtifactTypes = new Set(["audit_log", "security_event", "system_metric"]);

/** Artifact types that are public by design. */
const publicArtifactTypes = new Set(["marketing_content", "public_documentation"]);

/** High-risk event types that should page or trigger incident workflows by default. */
const criticalSecurityEventTypes = new Set([
  "secret_detected_in_log_or_artifact",
  "cross_tenant_access_attempt",
  "support_break_glass_started",
  "sandbox_escape_indicator",
  "private_key_rotation_failure",
  "llm_key_rotation_failure",
]);

/** Security event types that require urgent triage but are not always incidents. */
const highSecurityEventTypes = new Set([
  "artifact_download_spike",
  "invalid_webhook_signature_spike",
  "prompt_redaction_secret_detected",
  "sandbox_resource_abuse",
  "unexpected_github_permission_error",
]);

/** Metadata keys that must not be copied to security events. */
const sensitiveSecurityMetadataKeyPatterns = [
  "authorization",
  "code",
  "cookie",
  "database_url",
  "diff",
  "email",
  "password",
  "private_key",
  "prompt",
  "raw",
  "redis_url",
  "secret",
  "signed_url",
  "source",
  "token",
] as const;

/** Identity provider families that can back admin actors. */
export type AdminIdentityProvider = "oidc" | "saml" | "github_org";

/** Route exposure policy for privileged admin endpoints. */
export type AdminRouteExposure = "disabled" | "internal" | "public";

/** Coarse dashboard role derived from granular permissions for display only. */
export type AdminDisplayRole = "support" | "admin";

/** Provider-backed actor admitted to the admin control plane. */
export type AdminActor = {
  /** Actor category stored in audit records. */
  readonly actorType: "idp_user";
  /** Stable actor ID derived from provider and provider subject. */
  readonly actorUserId: string;
  /** Identity provider that authenticated the actor. */
  readonly provider: AdminIdentityProvider;
  /** Stable provider subject for this actor. */
  readonly providerSubject: string;
  /** Coarse role used only for legacy dashboard labels. */
  readonly role: AdminDisplayRole;
  /** Granular permissions granted by the identity provider. */
  readonly permissions: readonly AdminPermission[];
  /** Organization scope IDs granted by the identity provider. Use "*" for all organizations. */
  readonly orgIds: readonly string[];
  /** Repository scope IDs granted by the identity provider. Use "*" for all repositories. */
  readonly repoIds: readonly string[];
  /** Display name from the identity provider. */
  readonly displayName?: string | undefined;
  /** Primary email from the identity provider. */
  readonly email?: string | undefined;
};

/** Signed identity assertion emitted by an upstream OIDC, SAML, or GitHub org gateway. */
export type AdminIdentityAssertion = {
  /** Identity provider family that produced the assertion. */
  readonly provider: AdminIdentityProvider;
  /** Stable subject from the identity provider. */
  readonly providerSubject: string;
  /** Granular permissions granted to this actor. */
  readonly permissions: readonly AdminPermission[];
  /** Organization scope IDs granted to this actor. Use "*" for all organizations. */
  readonly orgIds?: readonly string[] | undefined;
  /** Repository scope IDs granted to this actor. Use "*" for all repositories. */
  readonly repoIds?: readonly string[] | undefined;
  /** GitHub organization login when provider is github_org. */
  readonly githubOrg?: string | undefined;
  /** Display name from the identity provider. */
  readonly displayName?: string | undefined;
  /** Primary email from the identity provider. */
  readonly email?: string | undefined;
};

/** Options for verifying a signed identity assertion. */
export type VerifyAdminIdentityAssertionOptions = {
  /** Expected identity provider configured for this deployment. */
  readonly expectedProvider: AdminIdentityProvider;
  /** Shared secret used by the upstream IdP gateway to sign assertions. */
  readonly assertionSecret: string;
  /** Base64url-encoded JSON identity assertion. */
  readonly encodedAssertion: string | undefined;
  /** Base64url HMAC-SHA256 signature over `${timestamp}.${encodedAssertion}`. */
  readonly signature: string | undefined;
  /** Millisecond epoch timestamp included in the signed assertion envelope. */
  readonly timestamp: string | undefined;
  /** Required GitHub organization login for github_org deployments. */
  readonly requiredGithubOrg?: string | undefined;
  /** Maximum allowed assertion clock skew in seconds. */
  readonly maxSkewSeconds?: number | undefined;
  /** Current time provider for tests. */
  readonly now?: (() => Date) | undefined;
};

/** Authenticated admin session persisted in the signed cookie. */
export type AdminSession = {
  /** Opaque session ID for audit correlation. */
  readonly sessionId: string;
  /** Provider-backed actor for this session. */
  readonly actor: AdminActor;
  /** CSRF token that must be supplied on cookie-authenticated mutations. */
  readonly csrfToken: string;
  /** ISO timestamp for token issuance. */
  readonly issuedAt: string;
  /** ISO timestamp for token expiration. */
  readonly expiresAt: string;
};

/** Secure cookie settings for control-plane sessions. */
export type AdminSessionCookieOptions = {
  /** Cookie name used for the signed session token. */
  readonly cookieName: string;
  /** Secret used to sign session tokens. */
  readonly sessionSecret: string;
  /** Whether the cookie must include the Secure flag. */
  readonly secure: boolean;
  /** SameSite policy for browser session cookies. */
  readonly sameSite?: "Strict" | "Lax" | "None" | undefined;
  /** Session lifetime in seconds. */
  readonly maxAgeSeconds: number;
  /** Cookie path for admin sessions. */
  readonly path?: string | undefined;
  /** Current time provider for tests. */
  readonly now?: (() => Date) | undefined;
};

/** Session cookie write returned by session manager operations. */
export type AdminSessionCookieWrite = {
  /** Authenticated session represented by the cookie. */
  readonly session: AdminSession;
  /** Serialized Set-Cookie header value. */
  readonly cookie: string;
};

/** Manager that creates, verifies, rotates, and clears admin session cookies. */
export type AdminSessionManager = {
  /** Creates a new signed admin session cookie for an actor. */
  readonly create: (actor: AdminActor) => AdminSessionCookieWrite;
  /** Reads and verifies a signed admin session cookie from a Cookie header. */
  readonly read: (cookieHeader: string | null) => AdminSession | undefined;
  /** Rotates a signed admin session cookie while preserving the actor and session ID. */
  readonly rotate: (session: AdminSession) => AdminSessionCookieWrite;
  /** Returns a Set-Cookie header that clears the admin session cookie. */
  readonly clear: () => string;
};

/** Structured security error raised during admin authentication. */
export class AdminSecurityError extends Error {
  /** Machine-readable error code. */
  public readonly code: string;

  /** HTTP status that should be returned for this error. */
  public readonly status: number;

  /** Creates an admin security error. */
  public constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AdminSecurityError";
    this.code = code;
    this.status = status;
  }
}

/** Creates a manager for signed admin session cookies. */
export function createAdminSessionManager(options: AdminSessionCookieOptions): AdminSessionManager {
  const cookiePath = options.path ?? "/admin";
  const sameSite = options.sameSite ?? "Strict";
  const now = options.now ?? (() => new Date());

  return {
    create: (actor) => {
      const issuedAt = now();
      const session = createSession(
        actor,
        randomToken("sess"),
        randomToken("csrf"),
        issuedAt,
        options.maxAgeSeconds,
      );
      return {
        session,
        cookie: sessionCookie(options, cookiePath, session),
      };
    },
    read: (cookieHeader) => {
      const token = parseCookieHeader(cookieHeader)[options.cookieName];
      if (!token) {
        return undefined;
      }

      const session = verifySignedPayload<AdminSession>(token, options.sessionSecret);
      if (!session) {
        return undefined;
      }

      return new Date(session.expiresAt).getTime() > now().getTime() ? session : undefined;
    },
    rotate: (session) => {
      const issuedAt = now();
      const rotated = createSession(
        session.actor,
        session.sessionId,
        randomToken("csrf"),
        issuedAt,
        options.maxAgeSeconds,
      );
      return {
        session: rotated,
        cookie: sessionCookie(options, cookiePath, rotated),
      };
    },
    clear: () =>
      serializeCookie(options.cookieName, "", {
        httpOnly: true,
        maxAgeSeconds: 0,
        path: cookiePath,
        sameSite,
        secure: options.secure,
      }),
  };
}

/** Verifies a signed identity assertion and converts it to an admin actor. */
export function verifyAdminIdentityAssertion(
  options: VerifyAdminIdentityAssertionOptions,
): AdminActor {
  const { encodedAssertion, signature, timestamp } = options;
  if (!encodedAssertion || !signature || !timestamp) {
    throw new AdminSecurityError(
      "admin_auth.missing_assertion",
      "Admin login requires a signed identity assertion.",
      401,
    );
  }

  validateAssertionTimestamp(timestamp, options.maxSkewSeconds ?? 300, options.now);
  verifyHmacEnvelope(options.assertionSecret, `${timestamp}.${encodedAssertion}`, signature);

  const assertion = parseIdentityAssertion(encodedAssertion);
  if (assertion.provider !== options.expectedProvider) {
    throw new AdminSecurityError(
      "admin_auth.provider_mismatch",
      "Admin identity assertion was issued by an unexpected provider.",
      401,
    );
  }

  if (
    assertion.provider === "github_org" &&
    options.requiredGithubOrg &&
    assertion.githubOrg !== options.requiredGithubOrg
  ) {
    throw new AdminSecurityError(
      "admin_auth.github_org_forbidden",
      "GitHub organization membership is required for admin access.",
      403,
    );
  }

  return actorFromAssertion(assertion);
}

/** Signs an identity assertion for integration tests and trusted gateway fixtures. */
export function signAdminIdentityAssertion(
  assertion: AdminIdentityAssertion,
  assertionSecret: string,
  timestamp = Date.now().toString(),
): {
  /** Base64url-encoded JSON identity assertion. */
  readonly encodedAssertion: string;
  /** Base64url HMAC-SHA256 signature over the assertion envelope. */
  readonly signature: string;
  /** Millisecond epoch timestamp included in the signed envelope. */
  readonly timestamp: string;
} {
  const encodedAssertion = encodeBase64Url(JSON.stringify(assertion));
  const signature = hmac(assertionSecret, `${timestamp}.${encodedAssertion}`);
  return { encodedAssertion, signature, timestamp };
}

/** Returns whether an actor has one granular permission. */
export function actorHasPermission(actor: AdminActor, permission: AdminPermission): boolean {
  return actor.permissions.includes(permission);
}

/** Returns whether an actor can access a scoped organization. */
export function actorCanAccessOrg(actor: AdminActor, orgId: string | undefined): boolean {
  if (actor.orgIds.includes("*")) {
    return true;
  }

  return orgId ? actor.orgIds.includes(orgId) : false;
}

/** Returns whether an actor can access a scoped repository. */
export function actorCanAccessRepo(
  actor: AdminActor,
  repoId: string | undefined,
  orgId: string | undefined,
): boolean {
  if (actor.repoIds.includes("*") || actor.orgIds.includes("*")) {
    return true;
  }

  return (repoId ? actor.repoIds.includes(repoId) : false) || actorCanAccessOrg(actor, orgId);
}

/** Returns dashboard capability flags derived from granular permissions. */
export function adminCapabilities(actor: AdminActor): Record<string, boolean> {
  return {
    canInspect: actorHasPermission(actor, "admin.inspect"),
    canPlanReplay: actorHasPermission(actor, "admin.replay.plan"),
    canExecuteReplay: actorHasPermission(actor, "admin.replay.execute"),
    canManageSettings: actorHasPermission(actor, "admin.settings.manage"),
    canViewAuditHistory: actorHasPermission(actor, "admin.audit.view"),
  };
}

/** Returns whether a string is a supported product role. */
export function isProductRole(value: string): value is ProductRole {
  return PRODUCT_ROLES.includes(value as ProductRole);
}

/** Returns whether a product role grants one product permission. */
export function productRoleHasPermission(
  role: ProductRole,
  permission: ProductPermission,
): boolean {
  const permissions: readonly ProductPermission[] = PRODUCT_PERMISSIONS_BY_ROLE[role];
  return permissions.includes(permission);
}

/** Returns the product permissions granted to one role. */
export function productPermissionsForRole(role: ProductRole): readonly ProductPermission[] {
  return PRODUCT_PERMISSIONS_BY_ROLE[role];
}

/** Returns the actor membership for one organization when present. */
export function productMembershipForOrg(
  actor: ProductActor,
  orgId: string,
): ProductMembership | undefined {
  return actor.memberships.find((membership) => membership.orgId === orgId);
}

/** Returns whether a product actor has one permission in an organization. */
export function productActorHasOrgPermission(
  actor: ProductActor,
  orgId: string,
  permission: ProductPermission,
): boolean {
  const membership = productMembershipForOrg(actor, orgId);
  return membership ? productRoleHasPermission(membership.role, permission) : false;
}

/** Returns whether a product actor can access a repository in one organization. */
export function productActorHasRepoPermission(
  actor: ProductActor,
  repoOrgId: string,
  permission: ProductPermission,
): boolean {
  return productActorHasOrgPermission(actor, repoOrgId, permission);
}

/** Returns dashboard capability flags derived from a product role. */
export function productCapabilities(role: ProductRole): Record<string, boolean> {
  return {
    canManageBilling: productRoleHasPermission(role, "billing:manage"),
    canManageMembers: productRoleHasPermission(role, "org:members:write"),
    canManageRepositorySettings: productRoleHasPermission(role, "repo:settings:write"),
    canReadAuditHistory: productRoleHasPermission(role, "audit:read"),
    canReadUsage: productRoleHasPermission(role, "usage:read"),
    canRerunReviews: productRoleHasPermission(role, "review:rerun"),
  };
}

/** Returns whether a string is a supported data classification. */
export function isDataClassification(value: string): value is DataClassification {
  return DATA_CLASSIFICATIONS.includes(value as DataClassification);
}

/** Returns whether a string is a supported retention class. */
export function isRetentionClass(value: string): value is RetentionClass {
  return RETENTION_CLASSES.includes(value as RetentionClass);
}

/** Tags a value with a security data classification and reason. */
export function classifyValue<TValue>(
  value: TValue,
  classification: DataClassification,
  reason: string,
): ClassifiedValue<TValue> {
  return { classification, reason, value };
}

/** Classifies an artifact or artifact-like payload using conservative defaults. */
export function classifyArtifact(input: ClassifyArtifactInput): DataClassification {
  if (input.containsToken) {
    return "secret";
  }
  if (input.containsCode || input.containsPrompt || codeArtifactTypes.has(input.artifactType)) {
    return "customer_code";
  }
  if (input.containsPersonalData || personalDataArtifactTypes.has(input.artifactType)) {
    return "regulated_personal_data";
  }
  if (internalArtifactTypes.has(input.artifactType)) {
    return "internal";
  }
  if (publicArtifactTypes.has(input.artifactType)) {
    return "public";
  }

  return "customer_confidential";
}

/** Returns the default retention class for an artifact type. */
export function retentionClassForArtifactType(artifactType: string): RetentionClass {
  if (artifactType === "audit_log") {
    return "audit";
  }
  if (artifactType === "billing_usage") {
    return "billing";
  }
  if (artifactType === "security_event") {
    return "security";
  }
  if (artifactType === "index_artifact" || artifactType === "embedding_index") {
    return "index_lifetime";
  }
  if (
    artifactType === "sandbox_output" ||
    artifactType === "static_analysis_output" ||
    artifactType === "webhook_payload"
  ) {
    return "operational_short";
  }
  if (
    artifactType === "raw_diff" ||
    artifactType === "context_bundle" ||
    artifactType === "prompt_artifact" ||
    artifactType === "llm_response_artifact" ||
    artifactType === "static_report" ||
    artifactType === "review_summary"
  ) {
    return "review_artifact";
  }

  return "customer_configurable";
}

/** Resolves the retention decision for one artifact. */
export function resolveArtifactRetention(input: {
  /** Artifact type to evaluate. */
  readonly artifactType: string;
  /** Creation timestamp for expiration calculation. */
  readonly createdAt: string;
  /** Retention policy to apply. */
  readonly policy?: RetentionPolicy | undefined;
  /** Optional explicit retention class override. */
  readonly retentionClass?: RetentionClass | undefined;
}): RetentionDecision {
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  const retentionClass = input.retentionClass ?? retentionClassForArtifactType(input.artifactType);
  const days = retentionDaysForArtifact(input.artifactType, retentionClass, policy);

  if (days === "disabled") {
    return {
      deleteOnRepoDisable: policy.deleteOnRepoDisable,
      deleteOnUninstall: policy.deleteOnUninstall,
      reason: `${input.artifactType} storage is disabled by retention policy.`,
      retentionClass,
      storage: "disabled",
    };
  }

  if (days === "while_enabled") {
    return {
      deleteOnRepoDisable: policy.deleteOnRepoDisable,
      deleteOnUninstall: policy.deleteOnUninstall,
      reason: `${input.artifactType} is retained while the repository remains enabled.`,
      retentionClass,
      storage: "allowed",
    };
  }

  return {
    deleteOnRepoDisable: policy.deleteOnRepoDisable,
    deleteOnUninstall: policy.deleteOnUninstall,
    expiresAt: addDays(input.createdAt, days),
    reason: `${input.artifactType} expires after ${days} day(s).`,
    retentionClass,
    storage: "allowed",
  };
}

/** Returns the default severity for one security event type. */
export function defaultSecurityEventSeverity(type: string): SecurityEventSeverity {
  if (criticalSecurityEventTypes.has(type)) {
    return "critical";
  }
  if (highSecurityEventTypes.has(type)) {
    return "high";
  }
  if (type.includes("denied") || type.includes("failure") || type.includes("rejected")) {
    return "medium";
  }

  return "info";
}

/** Returns whether a security event should trigger immediate alerting by default. */
export function shouldAlertSecurityEvent(event: Pick<SecurityEvent, "severity" | "type">): boolean {
  return event.severity === "critical" || criticalSecurityEventTypes.has(event.type);
}

/** Creates a normalized product-safe security event. */
export function createSecurityEvent(input: SecurityEventInput): SecurityEvent {
  return {
    id: input.id ?? randomToken("secevt"),
    metadata: sanitizeSecurityEventMetadata(input.metadata ?? {}),
    severity: input.severity ?? defaultSecurityEventSeverity(input.type),
    source: input.source,
    status: input.status ?? "new",
    type: input.type,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(input.repoId ? { repoId: input.repoId } : {}),
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input.resourceType ? { resourceType: input.resourceType } : {}),
  };
}

/** Creates an in-memory security-event sink. */
export function createMemorySecurityEventSink(): MemorySecurityEventSink {
  const recordedEvents: SecurityEvent[] = [];

  return {
    clear: () => {
      recordedEvents.length = 0;
    },
    events: () => [...recordedEvents],
    record: (event) => {
      recordedEvents.push(event);
    },
  };
}

/** Creates a security-event sink that intentionally drops events. */
export function createNoopSecurityEventSink(): SecurityEventSink {
  return {
    record: () => {},
  };
}

/** Records a normalized security event and returns the recorded event. */
export function recordSecurityEvent(
  sink: SecurityEventSink,
  input: SecurityEventInput,
): SecurityEvent {
  const event = createSecurityEvent(input);
  sink.record(event);
  return event;
}

/** Returns whether an HTTP method is safe from CSRF mutation checks. */
export function isCsrfSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

/** Verifies a request CSRF header against the session-bound token. */
export function verifyCsrfToken(session: AdminSession, providedToken: string | null): boolean {
  return Boolean(providedToken) && constantTimeEqual(providedToken ?? "", session.csrfToken);
}

/** Returns retention duration for one artifact and class. */
function retentionDaysForArtifact(
  artifactType: string,
  retentionClass: RetentionClass,
  policy: RetentionPolicy,
): number | "disabled" | "while_enabled" {
  if (artifactType === "prompt_artifact") {
    return policy.promptArtifactDays;
  }
  if (artifactType === "raw_diff") {
    return policy.rawDiffDays;
  }
  if (artifactType === "context_bundle") {
    return policy.contextBundleDays;
  }
  if (artifactType === "sandbox_output" || artifactType === "static_analysis_output") {
    return policy.sandboxArtifactDays;
  }
  if (retentionClass === "index_lifetime") {
    return policy.indexRetention === "while_enabled" ? "while_enabled" : policy.indexArtifactDays;
  }
  if (retentionClass === "audit") {
    return policy.auditLogDays;
  }
  if (retentionClass === "billing") {
    return policy.billingUsageDays;
  }
  if (retentionClass === "security") {
    return policy.securityEventDays;
  }
  if (retentionClass === "operational_short") {
    return policy.operationalShortDays;
  }

  return policy.reviewArtifactDays;
}

/** Adds whole days to an ISO timestamp. */
function addDays(timestamp: string, days: number): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    throw new AdminSecurityError(
      "security.invalid_retention_timestamp",
      "Retention timestamp must be parseable.",
      400,
    );
  }

  return new Date(parsed + days * 24 * 60 * 60 * 1000).toISOString();
}

/** Sanitizes security-event metadata to keep logs and alerts product-safe. */
function sanitizeSecurityEventMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | number | boolean>> {
  const sanitized: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (!isSafeSecurityMetadataKey(key)) {
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number") {
      sanitized[key] = value;
      continue;
    }
    if (typeof value === "string") {
      sanitized[key] = redactSecurityMetadataValue(value);
    }
  }

  return sanitized;
}

/** Returns whether one security-event metadata key is safe to persist and alert on. */
function isSafeSecurityMetadataKey(key: string): boolean {
  if (!/^[A-Za-z0-9_.-]{1,120}$/u.test(key)) {
    return false;
  }

  const normalizedKey = key.toLowerCase().replaceAll(/[.-]/gu, "_");
  if (normalizedKey === "statuscode" || normalizedKey === "status_code") {
    return true;
  }

  return !sensitiveSecurityMetadataKeyPatterns.some((pattern) => normalizedKey.includes(pattern));
}

/** Redacts secret-looking strings from allowed security-event metadata values. */
function redactSecurityMetadataValue(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted-email]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/gu, "[redacted-token]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[redacted-token]")
    .slice(0, 1000);
}

/** Returns a signed session token string for a JSON-serializable payload. */
function signPayload(payload: unknown, secret: string): string {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  return `${encodedPayload}.${hmac(secret, encodedPayload)}`;
}

/** Verifies and decodes a signed session token payload. */
function verifySignedPayload<T>(token: string, secret: string): T | undefined {
  const [encodedPayload, signature, ...extra] = token.split(".");
  if (!encodedPayload || !signature || extra.length > 0) {
    return undefined;
  }

  try {
    verifyHmacEnvelope(secret, encodedPayload, signature);
    return JSON.parse(decodeBase64Url(encodedPayload)) as T;
  } catch {
    return undefined;
  }
}

/** Creates one session object with a fresh expiration timestamp. */
function createSession(
  actor: AdminActor,
  sessionId: string,
  csrfToken: string,
  issuedAt: Date,
  maxAgeSeconds: number,
): AdminSession {
  const expiresAt = new Date(issuedAt.getTime() + 1000 * maxAgeSeconds);
  return {
    actor,
    csrfToken,
    expiresAt: expiresAt.toISOString(),
    issuedAt: issuedAt.toISOString(),
    sessionId,
  };
}

/** Serializes a signed session cookie. */
function sessionCookie(
  options: AdminSessionCookieOptions,
  path: string,
  session: AdminSession,
): string {
  return serializeCookie(options.cookieName, signPayload(session, options.sessionSecret), {
    httpOnly: true,
    maxAgeSeconds: options.maxAgeSeconds,
    path,
    sameSite: options.sameSite ?? "Strict",
    secure: options.secure,
  });
}

/** Cookie serialization options used by the local cookie writer. */
type CookieSerializationOptions = {
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

/** Serializes a Set-Cookie header value. */
function serializeCookie(name: string, value: string, options: CookieSerializationOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAgeSeconds}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`,
    "HttpOnly",
  ];
  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

/** Parses a Cookie header into a lookup map. */
function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) {
    return {};
  }

  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.includes("="))
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        const key = part.slice(0, separatorIndex);
        const value = decodeURIComponent(part.slice(separatorIndex + 1));
        return [key, value];
      }),
  );
}

/** Validates an assertion timestamp against the configured skew. */
function validateAssertionTimestamp(
  timestamp: string,
  maxSkewSeconds: number,
  now: (() => Date) | undefined,
): void {
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs)) {
    throw new AdminSecurityError(
      "admin_auth.invalid_assertion_timestamp",
      "Admin identity assertion timestamp is invalid.",
      401,
    );
  }

  const currentMs = (now ?? (() => new Date()))().getTime();
  if (Math.abs(currentMs - timestampMs) > maxSkewSeconds * 1000) {
    throw new AdminSecurityError(
      "admin_auth.stale_assertion",
      "Admin identity assertion is outside the allowed clock skew.",
      401,
    );
  }
}

/** Verifies one base64url HMAC envelope. */
function verifyHmacEnvelope(secret: string, value: string, signature: string): void {
  if (!constantTimeEqual(hmac(secret, value), signature)) {
    throw new AdminSecurityError(
      "admin_auth.invalid_signature",
      "Admin identity assertion signature is invalid.",
      401,
    );
  }
}

/** Converts a signed assertion into an actor record. */
function actorFromAssertion(assertion: AdminIdentityAssertion): AdminActor {
  const permissions = uniquePermissions(assertion.permissions);
  if (permissions.length === 0) {
    throw new AdminSecurityError(
      "admin_auth.no_permissions",
      "Admin identity assertion grants no control-plane permissions.",
      403,
    );
  }

  return {
    actorType: "idp_user",
    actorUserId: `${assertion.provider}:${assertion.providerSubject}`,
    orgIds: normalizeScope(assertion.orgIds),
    permissions,
    provider: assertion.provider,
    providerSubject: assertion.providerSubject,
    repoIds: normalizeScope(assertion.repoIds),
    role: permissions.some(
      (permission) =>
        permission === "admin.replay.execute" || permission === "admin.settings.manage",
    )
      ? "admin"
      : "support",
    ...(assertion.displayName ? { displayName: assertion.displayName } : {}),
    ...(assertion.email ? { email: assertion.email } : {}),
  };
}

/** Parses and validates a base64url-encoded identity assertion. */
function parseIdentityAssertion(encodedAssertion: string): AdminIdentityAssertion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(encodedAssertion));
  } catch {
    throw new AdminSecurityError(
      "admin_auth.invalid_assertion",
      "Admin identity assertion must be valid encoded JSON.",
      401,
    );
  }

  const record = asRecord(parsed);
  const provider = record ? stringField(record, "provider") : undefined;
  const providerSubject = record ? stringField(record, "providerSubject") : undefined;
  if (!isAdminIdentityProvider(provider) || !providerSubject) {
    throw new AdminSecurityError(
      "admin_auth.invalid_assertion",
      "Admin identity assertion requires provider and providerSubject.",
      401,
    );
  }

  return {
    provider,
    providerSubject,
    permissions: parsePermissionArray(record?.permissions),
    orgIds: parseStringArray(record?.orgIds),
    repoIds: parseStringArray(record?.repoIds),
    githubOrg: record ? stringField(record, "githubOrg") : undefined,
    displayName: record ? stringField(record, "displayName") : undefined,
    email: record ? stringField(record, "email") : undefined,
  };
}

/** Returns a unique list of valid admin permissions. */
function uniquePermissions(values: readonly AdminPermission[]): readonly AdminPermission[] {
  return [...new Set(values)];
}

/** Normalizes absent scope lists to no access. */
function normalizeScope(values: readonly string[] | undefined): readonly string[] {
  return values?.filter((value) => value.length > 0) ?? [];
}

/** Parses an unknown value as an admin permission array. */
function parsePermissionArray(value: unknown): readonly AdminPermission[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isAdminPermission);
}

/** Parses an unknown value as a string array. */
function parseStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/** Returns whether a string is an admin permission. */
function isAdminPermission(value: unknown): value is AdminPermission {
  return typeof value === "string" && ADMIN_PERMISSIONS.includes(value as AdminPermission);
}

/** Returns whether a string is an admin identity provider. */
function isAdminIdentityProvider(value: unknown): value is AdminIdentityProvider {
  return value === "oidc" || value === "saml" || value === "github_org";
}

/** Returns an object record when a value is a non-array object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads a string field from an object record. */
function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Creates a random URL-safe token with a purpose prefix. */
function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/** Returns an HMAC-SHA256 signature as base64url text. */
function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/** Compares two strings in constant time. */
function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHmac("sha256", "compare").update(left).digest();
  const rightDigest = createHmac("sha256", "compare").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/** Encodes text using base64url. */
function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Decodes base64url text. */
function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
