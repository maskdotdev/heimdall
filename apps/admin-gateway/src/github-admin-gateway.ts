import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createTelemetryTraceContextFromHeaders,
  normalizeTelemetryTraceContext,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricRecorder,
  type TelemetrySpanRecorder,
} from "@repo/observability";
import {
  ADMIN_PERMISSIONS,
  type AdminIdentityAssertion,
  type AdminPermission,
  recordSecurityEvent,
  type SecurityEventSeverity,
  type SecurityEventSink,
  signAdminIdentityAssertion,
} from "@repo/security";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Default GitHub REST API version used by the gateway. */
const GITHUB_API_VERSION = "2022-11-28";

/** Default OAuth scopes required to verify a private GitHub organization membership. */
const DEFAULT_GITHUB_OAUTH_SCOPES = ["read:org"] as const;

/** Maximum allowed gateway session lifetime for production-ready deployments. */
const MAX_GATEWAY_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/** Maximum allowed GitHub OAuth state lifetime for production-ready deployments. */
const MAX_OAUTH_STATE_MAX_AGE_SECONDS = 15 * 60;

/** Request body accepted by the signed assertion endpoint. */
const AssertionRequestBodySchema = Type.Object(
  {
    orgId: Type.Optional(Type.String({ minLength: 1 })),
    orgIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 })),
    purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    repoId: Type.Optional(Type.String({ minLength: 1 })),
    repoIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 })),
  },
  { additionalProperties: false },
);
type AssertionRequestBody = Static<typeof AssertionRequestBodySchema>;

/** GitHub OAuth token response used by the authorization-code callback. */
const OAuthTokenResponseSchema = Type.Object(
  {
    access_token: Type.String({ minLength: 1 }),
    scope: Type.Optional(Type.String()),
    token_type: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
type OAuthTokenResponse = Static<typeof OAuthTokenResponseSchema>;

/** GitHub user profile returned by GET /user. */
const GitHubUserSchema = Type.Object(
  {
    email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    id: Type.Number(),
    login: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
);
type GitHubUser = Static<typeof GitHubUserSchema>;

/** GitHub organization membership returned by GET /user/memberships/orgs/{org}. */
const GitHubMembershipSchema = Type.Object(
  {
    organization: Type.Object(
      {
        login: Type.String({ minLength: 1 }),
      },
      { additionalProperties: true },
    ),
    role: Type.Optional(Type.String()),
    state: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
);
type GitHubMembership = Static<typeof GitHubMembershipSchema>;

/** Signed OAuth state payload stored in the callback cookie and GitHub state parameter. */
const OAuthStateSchema = Type.Object(
  {
    expiresAt: Type.String({ minLength: 1 }),
    issuedAt: Type.String({ minLength: 1 }),
    nonce: Type.String({ minLength: 16 }),
    returnTo: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
type OAuthState = Static<typeof OAuthStateSchema>;

/** Gateway session created after a successful GitHub OAuth callback. */
const GatewaySessionSchema = Type.Object(
  {
    displayName: Type.Optional(Type.String({ minLength: 1 })),
    email: Type.Optional(Type.String({ minLength: 1 })),
    expiresAt: Type.String({ minLength: 1 }),
    githubLogin: Type.String({ minLength: 1 }),
    githubOrg: Type.String({ minLength: 1 }),
    githubRole: Type.Optional(Type.String({ minLength: 1 })),
    issuedAt: Type.String({ minLength: 1 }),
    orgIds: Type.Array(Type.String({ minLength: 1 })),
    permissions: Type.Array(Type.String({ minLength: 1 })),
    providerSubject: Type.String({ minLength: 1 }),
    repoIds: Type.Array(Type.String({ minLength: 1 })),
    sessionId: Type.String({ minLength: 16 }),
  },
  { additionalProperties: false },
);
type GatewaySession = Static<typeof GatewaySessionSchema>;

/** Logger surface used by the gateway. */
export type GitHubAdminGatewayLogger = {
  /** Writes an informational operator event. */
  readonly info?: (message: string, fields?: Record<string, unknown>) => void;
  /** Writes a warning operator event. */
  readonly warn?: (message: string, fields?: Record<string, unknown>) => void;
  /** Writes an error operator event. */
  readonly error?: (message: string, fields?: Record<string, unknown>) => void;
};

/** Fetch surface used for GitHub HTTP calls. */
export type GitHubAdminGatewayFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Runtime settings for the GitHub organization admin identity gateway. */
export type GitHubAdminGatewayConfig = {
  /** Host address to bind when the app is started directly. */
  readonly host: string;
  /** Port to bind when the app is started directly. */
  readonly port: number;
  /** Public HTTPS origin for OAuth callbacks and gateway links. */
  readonly publicUrl: string;
  /** Dashboard URL used after a successful GitHub login. */
  readonly dashboardUrl: string;
  /** GitHub OAuth application client ID. */
  readonly githubClientId: string;
  /** GitHub OAuth application client secret. */
  readonly githubClientSecret: string;
  /** GitHub organization login required for admin access. */
  readonly githubOrg: string;
  /** Shared assertion signing secret also configured on the Heimdall API. */
  readonly assertionSecret: string;
  /** Gateway-only session signing secret. */
  readonly sessionSecret: string;
  /** Strict origins allowed to call assertion endpoints with gateway credentials. */
  readonly allowedOrigins: readonly string[];
  /** GitHub logins allowed to receive admin assertions. */
  readonly allowedGithubLogins: readonly string[];
  /** Whether active members of the configured GitHub org are allowed without a login allowlist. */
  readonly allowAllOrgMembers: boolean;
  /** Whether allowlisted GitHub users may authenticate when the configured owner is not an org. */
  readonly allowUserLoginWithoutOrg: boolean;
  /** Heimdall organization scope IDs granted to admitted operators. */
  readonly orgIds: readonly string[];
  /** Heimdall repository scope IDs granted to admitted operators. */
  readonly repoIds: readonly string[];
  /** Admin permissions granted to admitted operators. */
  readonly permissions: readonly AdminPermission[];
  /** OAuth scopes requested from GitHub. */
  readonly oauthScopes: readonly string[];
  /** Gateway session cookie name. */
  readonly sessionCookieName: string;
  /** OAuth state cookie name. */
  readonly stateCookieName: string;
  /** Whether gateway cookies require HTTPS. */
  readonly secureCookies: boolean;
  /** Gateway session lifetime in seconds. */
  readonly sessionMaxAgeSeconds: number;
  /** OAuth state lifetime in seconds. */
  readonly oauthStateMaxAgeSeconds: number;
  /** Node environment name used for fail-closed production validation. */
  readonly nodeEnv: string;
};

/** Dependencies that can be replaced by tests. */
export type GitHubAdminGatewayDependencies = {
  /** Fetch implementation used for GitHub HTTP calls. */
  readonly fetch?: GitHubAdminGatewayFetch;
  /** Optional metric recorder for product-safe gateway request telemetry. */
  readonly metrics?: TelemetryMetricRecorder;
  /** Current time provider. */
  readonly now?: () => Date;
  /** Random token provider. */
  readonly randomToken?: () => string;
  /** Optional span recorder for product-safe gateway request traces. */
  readonly traces?: TelemetrySpanRecorder;
  /** Operator logger. */
  readonly logger?: GitHubAdminGatewayLogger;
  /** Optional sink used to record normalized admin-gateway security events. */
  readonly securityEventSink?: SecurityEventSink | undefined;
};

/** Runtime dependencies resolved after defaults are applied. */
type GitHubAdminGatewayRuntime = Required<
  Pick<GitHubAdminGatewayDependencies, "fetch" | "logger" | "now" | "randomToken">
> &
  Pick<GitHubAdminGatewayDependencies, "metrics" | "securityEventSink" | "traces">;

/** Created GitHub admin gateway request handler. */
export type GitHubAdminGateway = {
  /** Handles one incoming gateway request. */
  readonly handle: (request: Request) => Promise<Response>;
  /** Validated gateway config used by the handler. */
  readonly config: GitHubAdminGatewayConfig;
};

/** Error converted to a structured gateway HTTP response. */
class GatewayHttpError extends Error {
  /** Machine-readable error code. */
  public readonly code: string;

  /** Product-safe structured details for response and log triage. */
  public readonly details: Readonly<Record<string, string | number | boolean>> | undefined;

  /** HTTP status code. */
  public readonly status: number;

  /** Creates a structured gateway error. */
  public constructor(
    status: number,
    code: string,
    message: string,
    details?: Readonly<Record<string, string | number | boolean>> | undefined,
  ) {
    super(message);
    this.name = "GatewayHttpError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

/** Creates a GitHub organization-backed admin identity gateway. */
export function createGitHubAdminGateway(
  config: GitHubAdminGatewayConfig,
  dependencies: GitHubAdminGatewayDependencies = {},
): GitHubAdminGateway {
  const validatedConfig = validateGatewayConfig(config);
  const runtime: GitHubAdminGatewayRuntime = {
    fetch: dependencies.fetch ?? fetch,
    logger: dependencies.logger ?? console,
    now: dependencies.now ?? (() => new Date()),
    randomToken: dependencies.randomToken ?? (() => randomBytes(32).toString("base64url")),
    ...(dependencies.metrics ? { metrics: dependencies.metrics } : {}),
    ...(dependencies.securityEventSink
      ? { securityEventSink: dependencies.securityEventSink }
      : {}),
    ...(dependencies.traces ? { traces: dependencies.traces } : {}),
  };

  return {
    config: validatedConfig,
    handle: async (request) => {
      return handleGatewayRequestWithTelemetry(request, validatedConfig, runtime);
    },
  };
}

/** Reads GitHub gateway configuration from an environment map. */
export function readGitHubAdminGatewayConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GitHubAdminGatewayConfig {
  const publicUrl = requiredEnv(env, "HEIMDALL_ADMIN_GATEWAY_PUBLIC_URL");
  const dashboardUrl =
    emptyToUndefined(env.HEIMDALL_ADMIN_GATEWAY_DASHBOARD_URL) ??
    emptyToUndefined(env.WEB_URL) ??
    publicUrl;
  const nodeEnv = env.NODE_ENV ?? "development";
  const secureCookies = env.HEIMDALL_ADMIN_GATEWAY_SECURE_COOKIES
    ? env.HEIMDALL_ADMIN_GATEWAY_SECURE_COOKIES !== "false"
    : nodeEnv === "production" || new URL(publicUrl).protocol === "https:";

  return {
    allowAllOrgMembers: env.HEIMDALL_ADMIN_GATEWAY_ALLOW_ALL_ORG_MEMBERS === "true",
    allowUserLoginWithoutOrg: env.HEIMDALL_ADMIN_GATEWAY_ALLOW_USER_LOGIN_WITHOUT_ORG === "true",
    allowedGithubLogins: normalizeGithubLogins(
      parseStringList(env.HEIMDALL_ADMIN_GATEWAY_ALLOWED_LOGINS) ?? [],
    ),
    allowedOrigins: parseStringList(env.HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS) ??
      parseStringList(env.HEIMDALL_ADMIN_ALLOWED_ORIGINS) ?? [new URL(dashboardUrl).origin],
    assertionSecret: requiredEnv(env, "HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET"),
    dashboardUrl,
    githubClientId:
      emptyToUndefined(env.HEIMDALL_ADMIN_GATEWAY_GITHUB_CLIENT_ID) ??
      requiredEnv(env, "GITHUB_CLIENT_ID"),
    githubClientSecret:
      emptyToUndefined(env.HEIMDALL_ADMIN_GATEWAY_GITHUB_CLIENT_SECRET) ??
      requiredEnv(env, "GITHUB_CLIENT_SECRET"),
    githubOrg: requiredEnv(env, "HEIMDALL_ADMIN_GITHUB_ORG"),
    host: env.HEIMDALL_ADMIN_GATEWAY_HOST ?? "0.0.0.0",
    nodeEnv,
    oauthScopes: parseStringList(env.HEIMDALL_ADMIN_GATEWAY_GITHUB_SCOPES) ?? [
      ...DEFAULT_GITHUB_OAUTH_SCOPES,
    ],
    oauthStateMaxAgeSeconds: parsePositiveInteger(
      env.HEIMDALL_ADMIN_GATEWAY_OAUTH_STATE_MAX_AGE_SECONDS,
      10 * 60,
      "HEIMDALL_ADMIN_GATEWAY_OAUTH_STATE_MAX_AGE_SECONDS",
    ),
    orgIds: parseStringList(env.HEIMDALL_ADMIN_GATEWAY_ORG_IDS) ?? [],
    permissions: parseAdminPermissions(env.HEIMDALL_ADMIN_GATEWAY_PERMISSIONS),
    port: parsePort(env.HEIMDALL_ADMIN_GATEWAY_PORT),
    publicUrl,
    repoIds: parseStringList(env.HEIMDALL_ADMIN_GATEWAY_REPO_IDS) ?? [],
    secureCookies,
    sessionCookieName:
      emptyToUndefined(env.HEIMDALL_ADMIN_GATEWAY_SESSION_COOKIE_NAME) ??
      "heimdall_admin_gateway_session",
    sessionMaxAgeSeconds: parsePositiveInteger(
      env.HEIMDALL_ADMIN_GATEWAY_SESSION_MAX_AGE_SECONDS,
      8 * 60 * 60,
      "HEIMDALL_ADMIN_GATEWAY_SESSION_MAX_AGE_SECONDS",
    ),
    sessionSecret: requiredEnv(env, "HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET"),
    stateCookieName:
      emptyToUndefined(env.HEIMDALL_ADMIN_GATEWAY_STATE_COOKIE_NAME) ??
      "heimdall_admin_gateway_oauth_state",
  };
}

/** Handles one gateway request with product-safe request telemetry. */
async function handleGatewayRequestWithTelemetry(
  request: Request,
  config: GitHubAdminGatewayConfig,
  runtime: GitHubAdminGatewayRuntime,
): Promise<Response> {
  const startedAt = runtime.now();
  const url = new URL(request.url);
  const route = gatewayRouteTemplate(url);
  const requestId = gatewayRequestId(request, runtime);
  const traceContext = normalizeTelemetryTraceContext({
    ...createTelemetryTraceContextFromHeaders(request.headers),
    requestId,
  });
  const span = runtime.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.adminGatewayRequest, {
    attributes: {
      "admin_gateway.method": request.method,
      "admin_gateway.route": route,
    },
    kind: "server",
    traceContext,
  });

  try {
    const response = await handleGatewayRequest(request, config, runtime);
    const durationMs = Math.max(0, runtime.now().getTime() - startedAt.getTime());
    recordGatewayRequestMetrics(runtime.metrics, {
      durationMs,
      method: request.method,
      route,
      status: response.status,
    });
    span?.end({
      attributes: {
        "admin_gateway.status_code": response.status,
      },
      status: response.status >= 500 ? "error" : "ok",
    });

    return withRequestIdHeader(response, requestId);
  } catch (error) {
    tryRecordGatewaySecurityEvent(runtime.securityEventSink, request, requestId, route, error, {
      createdAt: runtime.now().toISOString(),
    });
    const response = handleGatewayError(error, runtime.logger);
    const durationMs = Math.max(0, runtime.now().getTime() - startedAt.getTime());
    recordGatewayRequestMetrics(runtime.metrics, {
      durationMs,
      method: request.method,
      route,
      status: response.status,
    });
    span?.end({
      attributes: {
        "admin_gateway.status_code": response.status,
      },
      error,
      status: "error",
    });

    return withRequestIdHeader(response, requestId);
  }
}

/** Optional deterministic fields used when recording gateway security events. */
type GatewaySecurityEventOptions = {
  /** Event creation timestamp. */
  readonly createdAt: string;
};

/** Security event metadata derived from one rejected gateway request. */
type GatewaySecurityEventDetails = {
  /** Normalized gateway error code. */
  readonly code: string;
  /** Event severity for triage. */
  readonly severity: SecurityEventSeverity;
  /** HTTP status code returned to the caller. */
  readonly statusCode: number;
  /** Normalized security event type. */
  readonly type: string;
};

/** Records a product-safe security event for high-risk gateway request rejections. */
function tryRecordGatewaySecurityEvent(
  securityEventSink: SecurityEventSink | undefined,
  request: Request,
  requestId: string,
  route: string,
  error: unknown,
  options: GatewaySecurityEventOptions,
): void {
  const details = gatewaySecurityEventDetails(error);
  if (!securityEventSink || !details) {
    return;
  }

  try {
    recordSecurityEvent(securityEventSink, {
      createdAt: options.createdAt,
      metadata: {
        denialReason: details.code,
        method: request.method,
        requestId,
        route,
        statusCode: details.statusCode,
      },
      resourceId: route,
      resourceType: "admin_gateway_route",
      severity: details.severity,
      source: "admin_gateway",
      type: details.type,
    });
  } catch {
    // Security event sinks must never change the gateway response outcome.
  }
}

/** Returns security-event details for gateway errors that warrant alert correlation. */
function gatewaySecurityEventDetails(error: unknown): GatewaySecurityEventDetails | undefined {
  if (!(error instanceof GatewayHttpError) || !isSecurityRelevantGatewayStatus(error.status)) {
    return undefined;
  }

  return {
    code: error.code,
    severity: gatewaySecurityEventSeverity(error),
    statusCode: error.status,
    type: gatewaySecurityEventType(error.code),
  };
}

/** Returns whether a gateway status represents a security-relevant denial. */
function isSecurityRelevantGatewayStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}

/** Returns the normalized security event type for one gateway denial code. */
function gatewaySecurityEventType(code: string): string {
  if (code === "admin_gateway.github_login_forbidden") {
    return "admin_gateway_github_login_forbidden";
  }
  if (code === "admin_gateway.github_org_forbidden") {
    return "admin_gateway_github_org_forbidden";
  }
  if (code === "admin_gateway.scope_forbidden") {
    return "admin_gateway_scope_forbidden";
  }
  if (code === "admin_gateway.cors_forbidden") {
    return "admin_gateway_cors_forbidden";
  }
  if (code.startsWith("admin_gateway.oauth_state_")) {
    return "admin_gateway_oauth_state_denied";
  }
  if (code === "admin_gateway.unauthorized") {
    return "admin_gateway_auth_denied";
  }

  return "admin_gateway_request_denied";
}

/** Returns the default security severity for one gateway denial. */
function gatewaySecurityEventSeverity(error: GatewayHttpError): SecurityEventSeverity {
  if (
    error.code === "admin_gateway.github_org_forbidden" ||
    error.code === "admin_gateway.scope_forbidden" ||
    error.code.startsWith("admin_gateway.oauth_state_")
  ) {
    return "high";
  }
  if (error.status === 403 || error.status === 429) {
    return "medium";
  }

  return "low";
}

/** Handles one gateway request. */
async function handleGatewayRequest(
  request: Request,
  config: GitHubAdminGatewayConfig,
  runtime: GitHubAdminGatewayRuntime,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return handlePreflight(request, config);
  }
  if (url.pathname === "/healthz" && request.method === "GET") {
    return jsonResponse(
      {
        ok: true,
        provider: "github_org",
        service: "admin-gateway",
      },
      200,
      request,
      config,
    );
  }
  if (url.pathname === "/auth/github/start" && request.method === "GET") {
    return startGitHubLogin(url, config, runtime);
  }
  if (url.pathname === "/auth/github/callback" && request.method === "GET") {
    return finishGitHubLogin(request, url, config, runtime);
  }
  if (url.pathname === "/auth/logout" && request.method === "POST") {
    return logoutGatewaySession(request, config);
  }
  if (isAssertionPath(url.pathname)) {
    if (request.method === "POST") {
      return issueAssertion(request, config, runtime);
    }

    throw new GatewayHttpError(
      405,
      "admin_gateway.method_not_allowed",
      "Admin identity assertions require POST.",
    );
  }

  throw new GatewayHttpError(404, "admin_gateway.not_found", "Route not found.");
}

/** Returns the product-safe route template used for gateway telemetry. */
function gatewayRouteTemplate(url: URL): string {
  if (url.pathname === "/healthz") {
    return "/healthz";
  }
  if (url.pathname === "/auth/github/start") {
    return "/auth/github/start";
  }
  if (url.pathname === "/auth/github/callback") {
    return "/auth/github/callback";
  }
  if (url.pathname === "/auth/logout") {
    return "/auth/logout";
  }
  if (url.pathname === "/heimdall/assertion" || url.pathname === "/assertion") {
    return "/assertion";
  }

  return "unknown";
}

/** Returns the request ID to propagate through gateway telemetry and responses. */
function gatewayRequestId(request: Request, runtime: GitHubAdminGatewayRuntime): string {
  const provided = request.headers.get("x-request-id")?.trim();
  if (provided && /^[A-Za-z0-9_.:-]{1,120}$/u.test(provided)) {
    return provided;
  }

  return `req_${runtime
    .randomToken()
    .replace(/[^A-Za-z0-9_.:-]/gu, "_")
    .slice(0, 96)}`;
}

/** Adds the request ID response header without mutating an existing response. */
function withRequestIdHeader(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/** Records aggregate gateway request metrics with bounded labels. */
function recordGatewayRequestMetrics(
  metrics: TelemetryMetricRecorder | undefined,
  input: {
    /** Request duration in milliseconds. */
    readonly durationMs: number;
    /** HTTP method. */
    readonly method: string;
    /** Product-safe route template. */
    readonly route: string;
    /** HTTP response status code. */
    readonly status: number;
  },
): void {
  if (!metrics) {
    return;
  }

  const labels = {
    method: input.method.toUpperCase(),
    route: input.route,
    status_class: `${Math.trunc(input.status / 100)}xx`,
  };
  metrics.count(OBSERVABILITY_METRIC_NAMES.adminGatewayRequestsTotal, { labels });
  metrics.histogram(OBSERVABILITY_METRIC_NAMES.adminGatewayRequestDurationMs, input.durationMs, {
    labels,
    unit: "ms",
  });
}

/** Handles a CORS preflight request for credentialed assertion endpoints. */
function handlePreflight(request: Request, config: GitHubAdminGatewayConfig): Response {
  assertAllowedOrigin(request, config);
  return jsonResponse({}, 204, request, config);
}

/** Starts the GitHub OAuth web application flow. */
function startGitHubLogin(
  url: URL,
  config: GitHubAdminGatewayConfig,
  runtime: GitHubAdminGatewayRuntime,
): Response {
  const now = runtime.now();
  const statePayload: OAuthState = {
    expiresAt: new Date(now.getTime() + config.oauthStateMaxAgeSeconds * 1000).toISOString(),
    issuedAt: now.toISOString(),
    nonce: runtime.randomToken(),
    returnTo: safeReturnTo(url.searchParams.get("returnTo"), config),
  };
  const state = signPayload(statePayload, config.sessionSecret);
  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", config.githubClientId);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl(config).toString());
  authorizeUrl.searchParams.set("scope", config.oauthScopes.join(" "));
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("allow_signup", "false");

  const headers = redirectHeaders(authorizeUrl.toString());
  headers.append(
    "set-cookie",
    serializeCookie(config.stateCookieName, state, {
      httpOnly: true,
      maxAgeSeconds: config.oauthStateMaxAgeSeconds,
      path: "/auth/github/callback",
      sameSite: "Lax",
      secure: config.secureCookies,
    }),
  );
  return new Response(undefined, { headers, status: 302 });
}

/** Finishes GitHub OAuth login, verifies org membership, and creates a gateway session. */
async function finishGitHubLogin(
  request: Request,
  url: URL,
  config: GitHubAdminGatewayConfig,
  runtime: GitHubAdminGatewayRuntime,
): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw new GatewayHttpError(
      400,
      "admin_gateway.github_callback_invalid",
      "GitHub callback requires code and state.",
    );
  }

  const stateCookie = parseCookieHeader(request.headers.get("cookie"))[config.stateCookieName];
  if (!stateCookie || !constantTimeEqual(stateCookie, state)) {
    throw new GatewayHttpError(
      401,
      "admin_gateway.oauth_state_mismatch",
      "GitHub OAuth state cookie is missing or invalid.",
    );
  }

  const statePayload = verifyOAuthState(state, config, runtime.now());
  const token = await exchangeGitHubOAuthCode(code, config, runtime.fetch);
  const user = await getGitHubUser(token.access_token, runtime.fetch);
  const membership = await getGitHubMembershipForLogin(user, token.access_token, config, runtime);
  assertAdmittedGitHubMember(user, membership, config);
  const session = createGatewaySession(user, membership, config, runtime);
  runtime.logger.info?.("admin gateway login succeeded", {
    githubLogin: user.login,
    githubOrg: membership?.organization.login ?? config.githubOrg,
    providerSubject: session.providerSubject,
  });

  const headers = redirectHeaders(statePayload.returnTo);
  headers.append(
    "set-cookie",
    clearCookie(config.stateCookieName, "/auth/github/callback", config),
  );
  headers.append(
    "set-cookie",
    serializeCookie(config.sessionCookieName, signPayload(session, config.sessionSecret), {
      httpOnly: true,
      maxAgeSeconds: config.sessionMaxAgeSeconds,
      path: "/",
      sameSite: "Lax",
      secure: config.secureCookies,
    }),
  );
  return new Response(undefined, { headers, status: 302 });
}

/** Clears the gateway browser session. */
function logoutGatewaySession(request: Request, config: GitHubAdminGatewayConfig): Response {
  assertAllowedOrigin(request, config);
  const headers = secureHeaders(request, config);
  headers.append("set-cookie", clearCookie(config.sessionCookieName, "/", config));
  return jsonResponse({ ok: true }, 200, request, config, headers);
}

/** Issues a signed Heimdall admin assertion for the authenticated gateway session. */
async function issueAssertion(
  request: Request,
  config: GitHubAdminGatewayConfig,
  runtime: GitHubAdminGatewayRuntime,
): Promise<Response> {
  assertAllowedOrigin(request, config);
  const session = readGatewaySession(request, config, runtime.now());
  if (!session) {
    throw new GatewayHttpError(
      401,
      "admin_gateway.unauthorized",
      "A valid GitHub gateway session is required.",
    );
  }

  const body = request.method === "POST" ? await readAssertionRequestBody(request) : {};
  const orgIds = requestedScope(body.orgIds, body.orgId, session.orgIds, "organization");
  const repoIds = requestedScope(body.repoIds, body.repoId, session.repoIds, "repository");
  const assertion: AdminIdentityAssertion = {
    displayName: session.displayName,
    email: session.email,
    githubOrg: session.githubOrg,
    orgIds,
    permissions: session.permissions as readonly AdminPermission[],
    provider: "github_org",
    providerSubject: session.providerSubject,
    repoIds,
  };
  const signed = signAdminIdentityAssertion(
    assertion,
    config.assertionSecret,
    runtime.now().getTime().toString(),
  );
  runtime.logger.info?.("admin gateway assertion issued", {
    githubLogin: session.githubLogin,
    orgIds,
    providerSubject: session.providerSubject,
    purpose: body.purpose,
    repoIds,
  });

  return jsonResponse(
    {
      actor: {
        displayName: session.displayName,
        githubLogin: session.githubLogin,
        githubOrg: session.githubOrg,
        orgIds,
        permissions: session.permissions,
        provider: "github_org",
        providerSubject: session.providerSubject,
        repoIds,
      },
      encodedAssertion: signed.encodedAssertion,
      headers: {
        "x-heimdall-idp-assertion": signed.encodedAssertion,
        "x-heimdall-idp-signature": signed.signature,
        "x-heimdall-idp-timestamp": signed.timestamp,
      },
      signature: signed.signature,
      timestamp: signed.timestamp,
    },
    200,
    request,
    config,
  );
}

/** Exchanges a GitHub OAuth callback code for a user access token. */
async function exchangeGitHubOAuthCode(
  code: string,
  config: GitHubAdminGatewayConfig,
  fetchFn: GitHubAdminGatewayFetch,
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.githubClientId,
    client_secret: config.githubClientSecret,
    code,
    redirect_uri: callbackUrl(config).toString(),
  });
  const response = await fetchFn("https://github.com/login/oauth/access_token", {
    body,
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  const json = await response.json().catch(() => undefined);
  if (!response.ok || !Value.Check(OAuthTokenResponseSchema, json)) {
    throw new GatewayHttpError(
      502,
      "admin_gateway.github_token_exchange_failed",
      "GitHub OAuth token exchange failed.",
    );
  }

  return json;
}

/** Fetches the authenticated GitHub user profile. */
async function getGitHubUser(
  accessToken: string,
  fetchFn: GitHubAdminGatewayFetch,
): Promise<GitHubUser> {
  const json = await fetchGitHubJson("https://api.github.com/user", accessToken, fetchFn, "user");
  if (!Value.Check(GitHubUserSchema, json)) {
    throw new GatewayHttpError(
      502,
      "admin_gateway.github_user_invalid",
      "GitHub user response was invalid.",
    );
  }

  return json;
}

/** Fetches the authenticated user's membership in the required GitHub organization. */
async function getGitHubMembership(
  githubOrg: string,
  accessToken: string,
  fetchFn: GitHubAdminGatewayFetch,
): Promise<GitHubMembership> {
  const url = `https://api.github.com/user/memberships/orgs/${encodeURIComponent(githubOrg)}`;
  const json = await fetchGitHubJson(url, accessToken, fetchFn, "membership");
  if (!Value.Check(GitHubMembershipSchema, json)) {
    throw new GatewayHttpError(
      502,
      "admin_gateway.github_membership_invalid",
      "GitHub organization membership response was invalid.",
    );
  }

  return json;
}

/** Fetches GitHub org membership or permits an explicit local user-owner fallback. */
async function getGitHubMembershipForLogin(
  user: GitHubUser,
  accessToken: string,
  config: GitHubAdminGatewayConfig,
  runtime: GitHubAdminGatewayRuntime,
): Promise<GitHubMembership | undefined> {
  try {
    return await getGitHubMembership(config.githubOrg, accessToken, runtime.fetch);
  } catch (error) {
    const mayUseUserOwnerFallback =
      config.allowUserLoginWithoutOrg &&
      config.allowedGithubLogins.includes(user.login.toLowerCase()) &&
      error instanceof GatewayHttpError &&
      error.code === "admin_gateway.github_api_failed" &&
      error.status === 403;
    if (mayUseUserOwnerFallback) {
      runtime.logger.warn?.("admin gateway using allowlisted GitHub user owner fallback", {
        githubLogin: user.login,
        githubOrg: config.githubOrg,
      });
      return undefined;
    }

    throw error;
  }
}

/** Fetches one GitHub REST API JSON document with standard headers. */
async function fetchGitHubJson(
  url: string,
  accessToken: string,
  fetchFn: GitHubAdminGatewayFetch,
  step: "membership" | "user",
): Promise<unknown> {
  const response = await fetchFn(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "heimdall-admin-gateway",
      "x-github-api-version": GITHUB_API_VERSION,
    },
  });
  const json = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new GatewayHttpError(
      response.status === 404 ? 403 : 502,
      "admin_gateway.github_api_failed",
      "GitHub API validation failed.",
      {
        githubStatus: response.status,
        githubStep: step,
      },
    );
  }

  return json;
}

/** Validates that a GitHub user is an admitted active member of the configured organization. */
function assertAdmittedGitHubMember(
  user: GitHubUser,
  membership: GitHubMembership | undefined,
  config: GitHubAdminGatewayConfig,
): void {
  if (!membership) {
    const normalizedLogin = user.login.toLowerCase();
    if (config.allowedGithubLogins.includes(normalizedLogin)) {
      return;
    }

    throw new GatewayHttpError(
      403,
      "admin_gateway.github_login_forbidden",
      "This GitHub login is not allowed to administer Heimdall.",
    );
  }

  if (
    membership.state !== "active" ||
    membership.organization.login.toLowerCase() !== config.githubOrg.toLowerCase()
  ) {
    throw new GatewayHttpError(
      403,
      "admin_gateway.github_org_forbidden",
      "Active GitHub organization membership is required.",
    );
  }

  const normalizedLogin = user.login.toLowerCase();
  if (!config.allowAllOrgMembers && !config.allowedGithubLogins.includes(normalizedLogin)) {
    throw new GatewayHttpError(
      403,
      "admin_gateway.github_login_forbidden",
      "This GitHub login is not allowed to administer Heimdall.",
    );
  }
}

/** Creates a gateway session from verified GitHub identity and configured Heimdall grants. */
function createGatewaySession(
  user: GitHubUser,
  membership: GitHubMembership | undefined,
  config: GitHubAdminGatewayConfig,
  runtime: GitHubAdminGatewayRuntime,
): GatewaySession {
  const issuedAt = runtime.now();
  const expiresAt = new Date(issuedAt.getTime() + config.sessionMaxAgeSeconds * 1000);
  const displayName = nullableString(user.name) ?? user.login;
  const email = nullableString(user.email);
  return {
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
    expiresAt: expiresAt.toISOString(),
    githubLogin: user.login,
    githubOrg: membership?.organization.login ?? config.githubOrg,
    ...(membership?.role ? { githubRole: membership.role } : {}),
    issuedAt: issuedAt.toISOString(),
    orgIds: [...config.orgIds],
    permissions: [...config.permissions],
    providerSubject: String(user.id),
    repoIds: [...config.repoIds],
    sessionId: runtime.randomToken(),
  };
}

/** Reads and verifies the signed gateway session cookie. */
function readGatewaySession(
  request: Request,
  config: GitHubAdminGatewayConfig,
  now: Date,
): GatewaySession | undefined {
  const token = parseCookieHeader(request.headers.get("cookie"))[config.sessionCookieName];
  if (!token) {
    return undefined;
  }

  const session = verifySignedPayload<GatewaySession>(
    token,
    config.sessionSecret,
    GatewaySessionSchema,
  );
  if (!session) {
    return undefined;
  }

  return new Date(session.expiresAt).getTime() > now.getTime() ? session : undefined;
}

/** Reads and validates the JSON body for an assertion request. */
async function readAssertionRequestBody(request: Request): Promise<AssertionRequestBody> {
  const body = (await request.json().catch(() => undefined)) as unknown;
  if (!body) {
    return {};
  }
  if (!Value.Check(AssertionRequestBodySchema, body)) {
    throw new GatewayHttpError(
      400,
      "admin_gateway.assertion_request_invalid",
      "Assertion request body is invalid.",
    );
  }

  return body;
}

/** Returns requested scope IDs after verifying they are a subset of the session scope. */
function requestedScope(
  requestedList: readonly string[] | undefined,
  requestedSingle: string | undefined,
  sessionScope: readonly string[],
  label: string,
): readonly string[] {
  const requested = requestedList?.length
    ? requestedList
    : requestedSingle
      ? [requestedSingle]
      : [];
  if (requested.length === 0) {
    return sessionScope;
  }
  if (sessionScope.includes("*")) {
    return requested;
  }

  const allowed = new Set(sessionScope);
  const forbidden = requested.filter((entry) => !allowed.has(entry));
  if (forbidden.length > 0) {
    throw new GatewayHttpError(
      403,
      "admin_gateway.scope_forbidden",
      `Requested ${label} scope is not granted to this gateway session.`,
    );
  }

  return requested;
}

/** Verifies and decodes an OAuth state payload. */
function verifyOAuthState(state: string, config: GitHubAdminGatewayConfig, now: Date): OAuthState {
  const payload = verifySignedPayload<OAuthState>(state, config.sessionSecret, OAuthStateSchema);
  if (!payload || new Date(payload.expiresAt).getTime() <= now.getTime()) {
    throw new GatewayHttpError(
      401,
      "admin_gateway.oauth_state_expired",
      "GitHub OAuth state is invalid or expired.",
    );
  }

  return payload;
}

/** Validates gateway configuration and returns normalized values. */
function validateGatewayConfig(config: GitHubAdminGatewayConfig): GitHubAdminGatewayConfig {
  const publicUrl = new URL(config.publicUrl);
  const dashboardUrl = new URL(config.dashboardUrl);
  if (config.nodeEnv === "production" && publicUrl.protocol !== "https:") {
    throw new Error("HEIMDALL_ADMIN_GATEWAY_PUBLIC_URL must use https in production.");
  }
  if (config.nodeEnv === "production" && dashboardUrl.protocol !== "https:") {
    throw new Error("HEIMDALL_ADMIN_GATEWAY_DASHBOARD_URL must use https in production.");
  }
  if (config.nodeEnv === "production" && !config.secureCookies) {
    throw new Error("Production admin gateway sessions require secure cookies.");
  }
  if (!config.githubClientId || !config.githubClientSecret) {
    throw new Error("GitHub OAuth client configuration is required.");
  }
  if (!config.githubOrg) {
    throw new Error("HEIMDALL_ADMIN_GITHUB_ORG is required.");
  }
  if (config.assertionSecret.length < 32) {
    throw new Error("HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET must be at least 32 characters.");
  }
  if (config.sessionSecret.length < 32) {
    throw new Error("HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET must be at least 32 characters.");
  }
  if (config.permissions.length === 0) {
    throw new Error("HEIMDALL_ADMIN_GATEWAY_PERMISSIONS must grant at least one permission.");
  }
  if (config.orgIds.length === 0 && config.repoIds.length === 0) {
    throw new Error("HEIMDALL_ADMIN_GATEWAY_ORG_IDS or REPO_IDS must grant at least one scope.");
  }
  if (!config.allowAllOrgMembers && config.allowedGithubLogins.length === 0) {
    throw new Error(
      "Set HEIMDALL_ADMIN_GATEWAY_ALLOWED_LOGINS or HEIMDALL_ADMIN_GATEWAY_ALLOW_ALL_ORG_MEMBERS=true.",
    );
  }
  if (!config.oauthScopes.includes("read:org")) {
    throw new Error("HEIMDALL_ADMIN_GATEWAY_GITHUB_SCOPES must include read:org.");
  }
  if (
    config.sessionMaxAgeSeconds <= 0 ||
    config.sessionMaxAgeSeconds > MAX_GATEWAY_SESSION_MAX_AGE_SECONDS
  ) {
    throw new Error("HEIMDALL_ADMIN_GATEWAY_SESSION_MAX_AGE_SECONDS must be between 1 and 28800.");
  }
  if (
    config.oauthStateMaxAgeSeconds <= 0 ||
    config.oauthStateMaxAgeSeconds > MAX_OAUTH_STATE_MAX_AGE_SECONDS
  ) {
    throw new Error(
      "HEIMDALL_ADMIN_GATEWAY_OAUTH_STATE_MAX_AGE_SECONDS must be between 1 and 900.",
    );
  }

  return {
    ...config,
    allowedGithubLogins: normalizeGithubLogins(config.allowedGithubLogins),
    allowedOrigins: normalizeAllowedOrigins(config.allowedOrigins, dashboardUrl, config.nodeEnv),
    githubOrg: config.githubOrg.trim(),
    publicUrl: publicUrl.toString().replace(/\/$/u, ""),
  };
}

/** Returns whether a path can issue admin identity assertions. */
function isAssertionPath(pathname: string): boolean {
  return pathname === "/heimdall/assertion" || pathname === "/assertion";
}

/** Builds the GitHub OAuth callback URL for the configured public gateway URL. */
function callbackUrl(config: GitHubAdminGatewayConfig): URL {
  return new URL("/auth/github/callback", config.publicUrl);
}

/** Returns a safe post-login redirect target. */
function safeReturnTo(returnTo: string | null, config: GitHubAdminGatewayConfig): string {
  if (!returnTo) {
    return config.dashboardUrl;
  }

  try {
    const parsed = new URL(returnTo, config.dashboardUrl);
    if (config.allowedOrigins.includes(parsed.origin)) {
      return parsed.toString();
    }
  } catch {
    return config.dashboardUrl;
  }

  return config.dashboardUrl;
}

/** Asserts that a credentialed request origin is allowed. */
function assertAllowedOrigin(request: Request, config: GitHubAdminGatewayConfig): void {
  const origin = request.headers.get("origin");
  if (!origin || !config.allowedOrigins.includes(origin)) {
    throw new GatewayHttpError(
      403,
      "admin_gateway.cors_forbidden",
      "Origin is not allowed for admin gateway requests.",
    );
  }
}

/** Converts a gateway error into a structured HTTP response. */
function handleGatewayError(error: unknown, logger: GitHubAdminGatewayLogger): Response {
  if (error instanceof GatewayHttpError) {
    logger.warn?.("admin gateway request rejected", {
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
      status: error.status,
    });
    return jsonResponse(
      {
        error: {
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
          message: error.message,
        },
      },
      error.status,
    );
  }

  logger.error?.("admin gateway request failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  return jsonResponse(
    {
      error: {
        code: "admin_gateway.internal_error",
        message: "Admin gateway request failed.",
      },
    },
    500,
  );
}

/** Returns a JSON response with security and optional CORS headers. */
function jsonResponse(
  body: unknown,
  status: number,
  request?: Request,
  config?: GitHubAdminGatewayConfig,
  headers: Headers = secureHeaders(request, config),
): Response {
  if (status !== 204) {
    headers.set("content-type", "application/json");
  }

  return new Response(status === 204 ? undefined : JSON.stringify(body), { headers, status });
}

/** Returns headers common to all gateway responses. */
function secureHeaders(request?: Request, config?: GitHubAdminGatewayConfig): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  const origin = request?.headers.get("origin");
  if (origin && config?.allowedOrigins.includes(origin)) {
    headers.set("access-control-allow-credentials", "true");
    headers.set("access-control-allow-headers", "authorization,content-type");
    headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }

  return headers;
}

/** Returns redirect response headers. */
function redirectHeaders(location: string): Headers {
  return new Headers({
    "cache-control": "no-store",
    location,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
}

/** Signs a JSON payload as a compact base64url HMAC token. */
function signPayload(payload: unknown, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${hmac(secret, encodedPayload)}`;
}

/** Verifies and decodes a signed JSON payload. */
function verifySignedPayload<T>(token: string, secret: string, schema: TSchema): T | undefined {
  const [encodedPayload, signature, ...extra] = token.split(".");
  if (!encodedPayload || !signature || extra.length > 0) {
    return undefined;
  }
  if (!constantTimeEqual(hmac(secret, encodedPayload), signature)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }

  return Value.Check(schema, parsed) ? (parsed as T) : undefined;
}

/** Returns a base64url HMAC-SHA256 signature. */
function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/** Compares two strings without leaking matching prefix length. */
function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** Serializes a Set-Cookie header value. */
function serializeCookie(
  name: string,
  value: string,
  options: {
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
  },
): string {
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

/** Returns a Set-Cookie header value that clears a cookie. */
function clearCookie(name: string, path: string, config: GitHubAdminGatewayConfig): string {
  return serializeCookie(name, "", {
    httpOnly: true,
    maxAgeSeconds: 0,
    path,
    sameSite: "Lax",
    secure: config.secureCookies,
  });
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

/** Reads one required environment variable. */
function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = emptyToUndefined(env[name]);
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

/** Converts a blank string to undefined. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** Parses a comma-separated string list. */
function parseStringList(value: string | undefined): readonly string[] | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Parses and validates admin permission grants from the environment. */
function parseAdminPermissions(value: string | undefined): readonly AdminPermission[] {
  const entries = parseStringList(value) ?? [];
  const permissions = entries.filter((entry): entry is AdminPermission =>
    (ADMIN_PERMISSIONS as readonly string[]).includes(entry),
  );
  if (permissions.length !== entries.length) {
    throw new Error(
      `HEIMDALL_ADMIN_GATEWAY_PERMISSIONS must contain only: ${ADMIN_PERMISSIONS.join(", ")}`,
    );
  }

  return [...new Set(permissions)];
}

/** Parses a TCP port from an environment value. */
function parsePort(value: string | undefined): number {
  const port = Number(value ?? "4318");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("HEIMDALL_ADMIN_GATEWAY_PORT must be a valid TCP port.");
  }

  return port;
}

/** Parses a positive integer environment value. */
function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

/** Normalizes and validates origins allowed to make credentialed gateway requests. */
function normalizeAllowedOrigins(
  allowedOrigins: readonly string[],
  dashboardUrl: URL,
  nodeEnv: string,
): readonly string[] {
  const origins = allowedOrigins.length > 0 ? allowedOrigins : [dashboardUrl.origin];
  return [...new Set(origins.map((origin) => normalizeAllowedOrigin(origin, nodeEnv)))];
}

/** Converts one configured origin to its canonical browser origin. */
function normalizeAllowedOrigin(origin: string, nodeEnv: string): string {
  const trimmed = origin.trim();
  if (trimmed === "*" || trimmed.length === 0) {
    throw new Error("HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS must not include wildcard origins.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS must contain valid origins.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS must use http or https origins.");
  }
  if (nodeEnv === "production" && parsed.protocol !== "https:") {
    throw new Error("HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS must use https in production.");
  }

  return parsed.origin;
}

/** Normalizes GitHub login strings for allowlist comparisons. */
function normalizeGithubLogins(logins: readonly string[]): readonly string[] {
  return [...new Set(logins.map((login) => login.trim().toLowerCase()).filter(Boolean))];
}

/** Converts nullable GitHub string fields to defined strings. */
function nullableString(value: string | null | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
