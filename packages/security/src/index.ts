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
        sameSite: "Strict",
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

/** Returns whether an HTTP method is safe from CSRF mutation checks. */
export function isCsrfSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

/** Verifies a request CSRF header against the session-bound token. */
export function verifyCsrfToken(session: AdminSession, providedToken: string | null): boolean {
  return Boolean(providedToken) && constantTimeEqual(providedToken ?? "", session.csrfToken);
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
    sameSite: "Strict",
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
