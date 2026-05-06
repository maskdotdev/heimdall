import { type AdminActor, verifyAdminIdentityAssertion } from "@repo/security";
import {
  ADMIN_IDENTITY_HEADER_NAMES,
  type AdminIdentityRequestHeaders,
  readGatewayIdentityAssertion,
} from "./admin-smoke-identity";

/** Timeout for one deployed endpoint probe. */
const PROBE_TIMEOUT_MS = 10_000;

/** Admin permissions required for the full dashboard proof drill. */
const REQUIRED_DASHBOARD_PERMISSIONS = [
  "admin.inspect",
  "admin.replay.plan",
  "admin.replay.execute",
  "admin.settings.manage",
  "admin.audit.view",
] as const;

/** Replay inspectors supported by the dashboard drill. */
export type ReplayKind = "webhook" | "review" | "publisher";

/** Environment values required before running the staging control-plane proof. */
export type PreflightEnvironment = {
  /** Deployed staging API URL. */
  readonly apiUrl: string;
  /** Deployed staging dashboard URL. */
  readonly webUrl: string;
  /** Deployed gateway assertion URL. */
  readonly assertionUrl: string;
  /** Authenticated GitHub gateway session cookie. */
  readonly gatewayCookie: string;
  /** Organization scope used by smoke and dashboard proof commands. */
  readonly orgId: string;
  /** Repository scope used by smoke and dashboard proof commands. */
  readonly repoId: string;
  /** Replay inspector kind used by the dashboard proof. */
  readonly replayKind: ReplayKind;
  /** Replay resource ID used by the dashboard proof. */
  readonly replayId: string;
  /** Browser-level Chrome DevTools Protocol WebSocket endpoint. */
  readonly browserWsEndpoint: string;
  /** Whether settings writes are explicitly acknowledged. */
  readonly allowSettingsWrite: boolean;
  /** Whether replay writes are explicitly acknowledged. */
  readonly allowReplayWrite: boolean;
  /** Admin API enabled flag from deployment configuration. */
  readonly adminEnabled: string;
  /** Admin API route exposure mode from deployment configuration. */
  readonly adminRouteExposure: string;
  /** Admin API identity provider from deployment configuration. */
  readonly adminIdentityProvider: string;
  /** Admin API assertion secret from deployment configuration. */
  readonly adminIdentityAssertionSecret: string;
  /** Admin API session secret from deployment configuration. */
  readonly adminSessionSecret: string;
  /** Admin API CORS origins from deployment configuration. */
  readonly adminAllowedOrigins: readonly string[];
  /** GitHub organization login required by API and gateway config. */
  readonly adminGithubOrg: string;
  /** Deployed gateway public URL from deployment configuration. */
  readonly gatewayPublicUrl: string;
  /** Dashboard redirect URL configured on the gateway. */
  readonly gatewayDashboardUrl: string;
  /** Gateway session secret from deployment configuration. */
  readonly gatewaySessionSecret: string;
  /** Gateway CORS origins from deployment configuration. */
  readonly gatewayAllowedOrigins: readonly string[];
  /** Gateway GitHub login allowlist from deployment configuration. */
  readonly gatewayAllowedLogins: readonly string[];
  /** Whether all active GitHub organization members may administer Heimdall. */
  readonly gatewayAllowAllOrgMembers: boolean;
  /** Gateway-granted admin permissions. */
  readonly gatewayPermissions: readonly string[];
  /** GitHub OAuth client ID configured for the gateway. */
  readonly githubClientId: string;
  /** GitHub OAuth client secret configured for the gateway. */
  readonly githubClientSecret: string;
};

/** One successful staging preflight check. */
type PreflightCheck = {
  /** Machine-readable check name. */
  readonly name: string;
  /** Human-readable check summary. */
  readonly detail: string;
};

/** Runs the staging control-plane preflight. */
export async function main(): Promise<void> {
  const env = readEnvironment();
  const urls = validateDeploymentConfiguration(env);
  const checks = await Promise.all([
    checkJsonHealth(new URL("/healthz", env.apiUrl), "api", "api health"),
    checkJsonHealth(new URL("/healthz", env.assertionUrl), "admin-gateway", "gateway health"),
    checkWeb(env.webUrl),
    checkDashboardApiConfiguration(env.webUrl, env.apiUrl),
    checkCorsPreflight({
      name: "api admin cors",
      origin: urls.web.origin,
      requestHeaders:
        "content-type,x-heimdall-idp-assertion,x-heimdall-idp-signature,x-heimdall-idp-timestamp",
      requestMethod: "POST",
      url: new URL("/admin/auth/login", env.apiUrl),
    }),
    checkCorsPreflight({
      name: "gateway assertion cors",
      origin: urls.web.origin,
      requestHeaders: "content-type",
      requestMethod: "POST",
      url: urls.assertion,
    }),
    checkGatewayAssertion(env),
  ]);

  console.log(
    JSON.stringify(
      {
        apiUrl: urls.api.origin,
        checks,
        gatewayUrl: urls.assertion.origin,
        orgId: env.orgId,
        replay: {
          id: env.replayId,
          kind: env.replayKind,
        },
        repoId: env.repoId,
        status: "control-plane staging preflight passed",
        webUrl: urls.web.origin,
      },
      null,
      2,
    ),
  );
}

/** Requests one gateway assertion to prove the authenticated gateway session is usable. */
async function checkGatewayAssertion(env: PreflightEnvironment): Promise<PreflightCheck> {
  const identity = await readGatewayIdentityAssertion({
    orgId: env.orgId,
    purpose: "control-plane-staging-preflight",
    repoId: env.repoId,
  });
  const actor = validateGatewayAssertion(env, identity);

  return {
    detail: `issued signed assertion for ${actor.actorUserId}, org ${env.orgId}, and repo ${env.repoId}`,
    name: "gateway assertion session",
  };
}

/** Validates that one gateway-issued assertion is ready for the staging proof. */
export function validateGatewayAssertion(
  env: PreflightEnvironment,
  identity: {
    /** API request headers emitted by the gateway. */
    readonly headers: AdminIdentityRequestHeaders;
    /** Origin that emitted the assertion. */
    readonly source: string;
  },
): AdminActor {
  const assertion = identity.headers[ADMIN_IDENTITY_HEADER_NAMES.assertion];
  const signature = identity.headers[ADMIN_IDENTITY_HEADER_NAMES.signature];
  const timestamp = identity.headers[ADMIN_IDENTITY_HEADER_NAMES.timestamp];
  if (!assertion || !signature || !timestamp) {
    throw new Error("gateway assertion probe did not return a complete signed assertion.");
  }
  if (new URL(identity.source).origin !== new URL(env.assertionUrl).origin) {
    throw new Error(
      `gateway assertion source ${identity.source} did not match ${env.assertionUrl}.`,
    );
  }
  const actor = verifyAdminIdentityAssertion({
    assertionSecret: env.adminIdentityAssertionSecret,
    encodedAssertion: assertion,
    expectedProvider: "github_org",
    requiredGithubOrg: env.adminGithubOrg,
    signature,
    timestamp,
  });
  const issues = [
    actor.provider !== "github_org" ? "gateway assertion provider must be github_org" : undefined,
    !scopeIncludes(actor.orgIds, env.orgId)
      ? `gateway assertion org scope must include ${env.orgId}`
      : undefined,
    !scopeIncludes(actor.repoIds, env.repoId)
      ? `gateway assertion repo scope must include ${env.repoId}`
      : undefined,
    ...missingPermissions(actor.permissions),
  ].filter((issue): issue is string => typeof issue === "string");
  if (issues.length > 0) {
    throw new Error(`Gateway assertion is not proof-ready: ${issues.join("; ")}.`);
  }

  return actor;
}

/** Reads and validates required environment variables. */
function readEnvironment(): PreflightEnvironment {
  const env = requiredEnvironment([
    "API_URL",
    "WEB_URL",
    "HEIMDALL_ADMIN_SMOKE_ASSERTION_URL",
    "HEIMDALL_ADMIN_SMOKE_GATEWAY_COOKIE",
    "HEIMDALL_ADMIN_SMOKE_ORG_ID",
    "HEIMDALL_ADMIN_SMOKE_REPO_ID",
    "HEIMDALL_DASHBOARD_E2E_BROWSER_WS",
    "HEIMDALL_DASHBOARD_E2E_REPLAY_KIND",
    "HEIMDALL_DASHBOARD_E2E_REPLAY_ID",
    "HEIMDALL_ADMIN_ENABLED",
    "HEIMDALL_ADMIN_ROUTE_EXPOSURE",
    "HEIMDALL_ADMIN_IDENTITY_PROVIDER",
    "HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET",
    "HEIMDALL_ADMIN_SESSION_SECRET",
    "HEIMDALL_ADMIN_ALLOWED_ORIGINS",
    "HEIMDALL_ADMIN_GITHUB_ORG",
    "HEIMDALL_ADMIN_GATEWAY_PUBLIC_URL",
    "HEIMDALL_ADMIN_GATEWAY_DASHBOARD_URL",
    "HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET",
    "HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS",
    "HEIMDALL_ADMIN_GATEWAY_PERMISSIONS",
  ] as const);
  const githubClientId =
    emptyToUndefined(process.env.HEIMDALL_ADMIN_GATEWAY_GITHUB_CLIENT_ID) ??
    emptyToUndefined(process.env.GITHUB_CLIENT_ID);
  const githubClientSecret =
    emptyToUndefined(process.env.HEIMDALL_ADMIN_GATEWAY_GITHUB_CLIENT_SECRET) ??
    emptyToUndefined(process.env.GITHUB_CLIENT_SECRET);
  const resolvedGithubClientId = githubClientId ?? "";
  const resolvedGithubClientSecret = githubClientSecret ?? "";
  const missing = [
    !resolvedGithubClientId
      ? "HEIMDALL_ADMIN_GATEWAY_GITHUB_CLIENT_ID or GITHUB_CLIENT_ID"
      : undefined,
    !resolvedGithubClientSecret
      ? "HEIMDALL_ADMIN_GATEWAY_GITHUB_CLIENT_SECRET or GITHUB_CLIENT_SECRET"
      : undefined,
  ].filter((name): name is string => typeof name === "string");
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}.`);
  }

  return {
    adminAllowedOrigins: parseStringList(env.HEIMDALL_ADMIN_ALLOWED_ORIGINS),
    adminEnabled: env.HEIMDALL_ADMIN_ENABLED,
    adminGithubOrg: env.HEIMDALL_ADMIN_GITHUB_ORG,
    adminIdentityAssertionSecret: env.HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET,
    adminIdentityProvider: env.HEIMDALL_ADMIN_IDENTITY_PROVIDER,
    adminRouteExposure: env.HEIMDALL_ADMIN_ROUTE_EXPOSURE,
    adminSessionSecret: env.HEIMDALL_ADMIN_SESSION_SECRET,
    allowReplayWrite: process.env.HEIMDALL_DASHBOARD_E2E_ALLOW_REPLAY_WRITE === "true",
    allowSettingsWrite: process.env.HEIMDALL_DASHBOARD_E2E_ALLOW_SETTINGS_WRITE === "true",
    apiUrl: env.API_URL,
    assertionUrl: env.HEIMDALL_ADMIN_SMOKE_ASSERTION_URL,
    browserWsEndpoint: env.HEIMDALL_DASHBOARD_E2E_BROWSER_WS,
    gatewayAllowedLogins: parseStringList(process.env.HEIMDALL_ADMIN_GATEWAY_ALLOWED_LOGINS),
    gatewayAllowedOrigins: parseStringList(env.HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS),
    gatewayAllowAllOrgMembers: process.env.HEIMDALL_ADMIN_GATEWAY_ALLOW_ALL_ORG_MEMBERS === "true",
    gatewayCookie: env.HEIMDALL_ADMIN_SMOKE_GATEWAY_COOKIE,
    gatewayDashboardUrl: env.HEIMDALL_ADMIN_GATEWAY_DASHBOARD_URL,
    gatewayPermissions: parseStringList(env.HEIMDALL_ADMIN_GATEWAY_PERMISSIONS),
    gatewayPublicUrl: env.HEIMDALL_ADMIN_GATEWAY_PUBLIC_URL,
    gatewaySessionSecret: env.HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET,
    githubClientId: resolvedGithubClientId,
    githubClientSecret: resolvedGithubClientSecret,
    orgId: env.HEIMDALL_ADMIN_SMOKE_ORG_ID,
    replayId: env.HEIMDALL_DASHBOARD_E2E_REPLAY_ID,
    replayKind: replayKindFromEnv(env.HEIMDALL_DASHBOARD_E2E_REPLAY_KIND),
    repoId: env.HEIMDALL_ADMIN_SMOKE_REPO_ID,
    webUrl: env.WEB_URL,
  };
}

/** Reads required environment variables and reports all missing names at once. */
function requiredEnvironment<const Names extends readonly string[]>(
  names: Names,
): { readonly [Key in Names[number]]: string } {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}.`);
  }

  return Object.fromEntries(names.map((name) => [name, process.env[name] ?? ""])) as {
    readonly [Key in Names[number]]: string;
  };
}

/** Validates deployment configuration without printing secret values. */
export function validateDeploymentConfiguration(env: PreflightEnvironment): {
  /** Parsed API URL. */
  readonly api: URL;
  /** Parsed assertion URL. */
  readonly assertion: URL;
  /** Parsed gateway public URL. */
  readonly gatewayPublic: URL;
  /** Parsed dashboard URL. */
  readonly web: URL;
} {
  const api = httpsUrl("API_URL", env.apiUrl);
  const assertion = httpsUrl("HEIMDALL_ADMIN_SMOKE_ASSERTION_URL", env.assertionUrl);
  const gatewayPublic = httpsUrl("HEIMDALL_ADMIN_GATEWAY_PUBLIC_URL", env.gatewayPublicUrl);
  const gatewayDashboard = httpsUrl(
    "HEIMDALL_ADMIN_GATEWAY_DASHBOARD_URL",
    env.gatewayDashboardUrl,
  );
  const web = httpsUrl("WEB_URL", env.webUrl);
  const browserWs = websocketUrl("HEIMDALL_DASHBOARD_E2E_BROWSER_WS", env.browserWsEndpoint);
  const issues = [
    env.adminEnabled !== "true" ? "HEIMDALL_ADMIN_ENABLED must be true" : undefined,
    env.adminRouteExposure === "disabled"
      ? "HEIMDALL_ADMIN_ROUTE_EXPOSURE must be internal or public"
      : undefined,
    env.adminIdentityProvider !== "github_org"
      ? "HEIMDALL_ADMIN_IDENTITY_PROVIDER must be github_org for the real gateway proof"
      : undefined,
    env.adminIdentityAssertionSecret.length < 32
      ? "HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET must be at least 32 characters"
      : undefined,
    env.adminSessionSecret.length < 32
      ? "HEIMDALL_ADMIN_SESSION_SECRET must be at least 32 characters"
      : undefined,
    env.gatewaySessionSecret.length < 32
      ? "HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET must be at least 32 characters"
      : undefined,
    !env.gatewayCookie.includes("=")
      ? "HEIMDALL_ADMIN_SMOKE_GATEWAY_COOKIE must be a cookie pair"
      : undefined,
    !env.allowSettingsWrite
      ? "HEIMDALL_DASHBOARD_E2E_ALLOW_SETTINGS_WRITE must be true"
      : undefined,
    !env.allowReplayWrite ? "HEIMDALL_DASHBOARD_E2E_ALLOW_REPLAY_WRITE must be true" : undefined,
    !originListIncludes(env.adminAllowedOrigins, web.origin)
      ? "HEIMDALL_ADMIN_ALLOWED_ORIGINS must include WEB_URL origin"
      : undefined,
    !originListIncludes(env.gatewayAllowedOrigins, web.origin)
      ? "HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS must include WEB_URL origin"
      : undefined,
    env.adminAllowedOrigins.includes("*")
      ? "HEIMDALL_ADMIN_ALLOWED_ORIGINS must not include wildcard origins"
      : undefined,
    env.gatewayAllowedOrigins.includes("*")
      ? "HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS must not include wildcard origins"
      : undefined,
    !sameOrigin(assertion, gatewayPublic)
      ? "HEIMDALL_ADMIN_SMOKE_ASSERTION_URL must use HEIMDALL_ADMIN_GATEWAY_PUBLIC_URL origin"
      : undefined,
    !sameOrigin(gatewayDashboard, web)
      ? "HEIMDALL_ADMIN_GATEWAY_DASHBOARD_URL must use WEB_URL origin"
      : undefined,
    env.gatewayAllowedLogins.length === 0 && !env.gatewayAllowAllOrgMembers
      ? "HEIMDALL_ADMIN_GATEWAY_ALLOWED_LOGINS is required unless HEIMDALL_ADMIN_GATEWAY_ALLOW_ALL_ORG_MEMBERS=true"
      : undefined,
    browserWs.protocol !== "ws:" && browserWs.protocol !== "wss:"
      ? "HEIMDALL_DASHBOARD_E2E_BROWSER_WS must be a ws:// or wss:// URL"
      : undefined,
    ...missingPermissions(env.gatewayPermissions),
  ].filter((issue): issue is string => typeof issue === "string");

  if (issues.length > 0) {
    throw new Error(`Invalid staging control-plane proof configuration: ${issues.join("; ")}.`);
  }

  return { api, assertion, gatewayPublic, web };
}

/** Fetches and validates one JSON health endpoint. */
async function checkJsonHealth(
  url: URL,
  expectedService: string,
  name: string,
): Promise<PreflightCheck> {
  const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    throw new Error(`${name} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  const record = asRecord(body);
  if (record?.ok !== true || record.service !== expectedService) {
    throw new Error(`${name} returned an unexpected health payload: ${JSON.stringify(body)}`);
  }

  return { detail: `${url.origin}/healthz returned ${expectedService}`, name };
}

/** Fetches the dashboard URL and validates that it returns a page. */
async function checkWeb(webUrl: string): Promise<PreflightCheck> {
  const url = new URL(webUrl);
  const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`dashboard web check failed with HTTP ${response.status}`);
  }

  return { detail: `${url.origin} returned HTTP ${response.status}`, name: "dashboard web" };
}

/** Validates that the deployed dashboard bundle was built for the staging API URL. */
export async function checkDashboardApiConfiguration(
  webUrl: string,
  apiUrl: string,
): Promise<PreflightCheck> {
  const dashboardUrl = new URL(webUrl);
  const response = await fetch(dashboardUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`dashboard API config check failed with HTTP ${response.status}`);
  }

  const assetUrls = extractDashboardAssetUrls(html, dashboardUrl);
  const bundles = await Promise.all(assetUrls.map((assetUrl) => fetchDashboardAsset(assetUrl)));
  const expectedApiBaseUrl = apiUrl.replace(/\/$/u, "");
  const containsApiUrl = [html, ...bundles].some((body) => body.includes(expectedApiBaseUrl));
  if (!containsApiUrl) {
    throw new Error(
      `dashboard bundle does not contain API_URL ${expectedApiBaseUrl}. Rebuild the dashboard with VITE_HEIMDALL_API_BASE_URL set to the staging API URL.`,
    );
  }

  return {
    detail: `${dashboardUrl.origin} bundle references ${expectedApiBaseUrl}`,
    name: "dashboard API configuration",
  };
}

/** Extracts same-origin JavaScript asset URLs referenced by dashboard HTML. */
function extractDashboardAssetUrls(html: string, dashboardUrl: URL): readonly URL[] {
  const urls: URL[] = [];
  for (const match of html.matchAll(/\bsrc=["']([^"']+)["']/giu)) {
    const source = match[1];
    if (!source) {
      continue;
    }

    const assetUrl = new URL(source, dashboardUrl);
    if (assetUrl.origin === dashboardUrl.origin) {
      urls.push(assetUrl);
    }
  }

  return urls;
}

/** Fetches one dashboard asset body. */
async function fetchDashboardAsset(url: URL): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`dashboard asset ${url.pathname} failed with HTTP ${response.status}`);
  }

  return body;
}

/** Validates one credentialed CORS preflight. */
async function checkCorsPreflight(input: {
  /** Check name. */
  readonly name: string;
  /** Origin header value to send. */
  readonly origin: string;
  /** Requested request headers. */
  readonly requestHeaders: string;
  /** Requested request method. */
  readonly requestMethod: string;
  /** Endpoint to preflight. */
  readonly url: URL;
}): Promise<PreflightCheck> {
  const response = await fetch(input.url, {
    headers: {
      "access-control-request-headers": input.requestHeaders,
      "access-control-request-method": input.requestMethod,
      origin: input.origin,
    },
    method: "OPTIONS",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${input.name} failed with HTTP ${response.status}`);
  }

  const allowOrigin = response.headers.get("access-control-allow-origin");
  const allowCredentials = response.headers.get("access-control-allow-credentials");
  if (allowOrigin !== input.origin || allowCredentials !== "true") {
    throw new Error(
      `${input.name} returned invalid CORS headers: access-control-allow-origin=${allowOrigin}, access-control-allow-credentials=${allowCredentials}`,
    );
  }

  return {
    detail: `${input.url.pathname} accepts credentialed origin ${input.origin}`,
    name: input.name,
  };
}

/** Parses one replay kind from an environment value. */
function replayKindFromEnv(value: string): ReplayKind {
  if (value === "webhook" || value === "review" || value === "publisher") {
    return value;
  }

  throw new Error("HEIMDALL_DASHBOARD_E2E_REPLAY_KIND must be webhook, review, or publisher.");
}

/** Parses one required HTTPS URL and rejects local hosts. */
function httpsUrl(name: string, value: string): URL {
  const url = parsedUrl(name, value);
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use https for staging proof.`);
  }
  if (isLocalHostname(url.hostname)) {
    throw new Error(`${name} must point at a deployed staging target.`);
  }

  return url;
}

/** Parses one WebSocket URL. */
function websocketUrl(name: string, value: string): URL {
  return parsedUrl(name, value);
}

/** Parses one URL or throws a named validation error. */
function parsedUrl(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}

/** Returns issues for permissions missing from the gateway grant list. */
function missingPermissions(permissions: readonly string[]): readonly string[] {
  return REQUIRED_DASHBOARD_PERMISSIONS.filter(
    (permission) => !permissions.includes(permission),
  ).map((permission) => `HEIMDALL_ADMIN_GATEWAY_PERMISSIONS must include ${permission}`);
}

/** Returns whether two parsed URLs share the same origin. */
function sameOrigin(left: URL, right: URL): boolean {
  return left.origin === right.origin;
}

/** Returns whether one assertion scope list includes a requested scope. */
function scopeIncludes(scopes: readonly string[], requested: string): boolean {
  return scopes.includes("*") || scopes.includes(requested);
}

/** Returns whether an origin list contains the requested origin. */
function originListIncludes(origins: readonly string[], origin: string): boolean {
  return origins.some((entry) => normalizeOrigin(entry) === origin);
}

/** Normalizes one configured origin string. */
function normalizeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/** Parses a comma-separated string list. */
function parseStringList(value: string | undefined): readonly string[] {
  if (!value || value.trim().length === 0) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Converts blank environment values to undefined. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

/** Returns whether a hostname targets local development infrastructure. */
function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "localhost.localdomain" ||
    normalized === "host.docker.internal" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127\./.test(normalized)
  );
}

/** Returns a plain object record when possible. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

if (import.meta.main) {
  await main();
}
