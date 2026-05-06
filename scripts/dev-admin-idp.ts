import {
  ADMIN_PERMISSIONS,
  type AdminIdentityAssertion,
  type AdminIdentityProvider,
  type AdminPermission,
  signAdminIdentityAssertion,
} from "@repo/security";

/** Dev-only identity gateway runtime settings. */
type DevAdminIdentityGatewayConfig = {
  /** Host address to bind. Defaults to loopback. */
  readonly host: string;
  /** Port to listen on. */
  readonly port: number;
  /** Shared assertion signing secret also configured on the API. */
  readonly assertionSecret: string;
  /** Identity provider family to place in assertions. */
  readonly provider: AdminIdentityProvider;
  /** Default provider subject for local assertions. */
  readonly providerSubject: string;
  /** Default actor email. */
  readonly email?: string | undefined;
  /** Default actor display name. */
  readonly displayName?: string | undefined;
  /** Default GitHub organization for github_org assertions. */
  readonly githubOrg?: string | undefined;
  /** Default organization scope IDs. */
  readonly orgIds: readonly string[];
  /** Default repository scope IDs. */
  readonly repoIds: readonly string[];
  /** Default permissions to grant. */
  readonly permissions: readonly AdminPermission[];
};

/** Supported request body for local assertion minting. */
type AssertionRequestBody = {
  /** Optional request purpose for operator logs. */
  readonly purpose?: unknown;
  /** Optional provider subject override. */
  readonly providerSubject?: unknown;
  /** Optional actor email override. */
  readonly email?: unknown;
  /** Optional actor display-name override. */
  readonly displayName?: unknown;
  /** Optional single organization scope. */
  readonly orgId?: unknown;
  /** Optional organization scopes. */
  readonly orgIds?: unknown;
  /** Optional single repository scope. */
  readonly repoId?: unknown;
  /** Optional repository scopes. */
  readonly repoIds?: unknown;
  /** Optional permission set. */
  readonly permissions?: unknown;
};

/** Shape returned from the local assertion gateway. */
type AssertionResponseBody = {
  /** Base64url-encoded identity assertion. */
  readonly encodedAssertion: string;
  /** Assertion signature. */
  readonly signature: string;
  /** Millisecond epoch timestamp. */
  readonly timestamp: string;
  /** Header map accepted by the admin API login route. */
  readonly headers: {
    /** Encoded assertion header. */
    readonly "x-heimdall-idp-assertion": string;
    /** Assertion signature header. */
    readonly "x-heimdall-idp-signature": string;
    /** Assertion timestamp header. */
    readonly "x-heimdall-idp-timestamp": string;
  };
  /** Non-secret assertion summary for smoke logs. */
  readonly actor: {
    /** Identity provider family. */
    readonly provider: AdminIdentityProvider;
    /** Provider subject. */
    readonly providerSubject: string;
    /** Granted organization scopes. */
    readonly orgIds: readonly string[];
    /** Granted repository scopes. */
    readonly repoIds: readonly string[];
    /** Granted admin permissions. */
    readonly permissions: readonly AdminPermission[];
  };
};

const DEFAULT_DEV_ASSERTION_SECRET = "local-admin-assertion-secret-with-32-chars";

/** Starts the dev-only admin identity gateway. */
async function main(): Promise<void> {
  const config = readConfig();
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: (request) => handleRequest(request, config),
  });

  console.log(
    `dev admin idp listening on http://${server.hostname}:${server.port}/assertion for ${config.provider}:${config.providerSubject}`,
  );
}

/** Handles one HTTP request. */
async function handleRequest(
  request: Request,
  config: DevAdminIdentityGatewayConfig,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return jsonResponse({}, 204);
  }
  if (url.pathname === "/healthz" && request.method === "GET") {
    return jsonResponse({ ok: true, service: "dev-admin-idp" });
  }
  if (url.pathname === "/assertion" && (request.method === "GET" || request.method === "POST")) {
    const body = request.method === "POST" ? await readJsonBody(request) : undefined;
    return jsonResponse(createAssertionResponse(config, body));
  }

  return jsonResponse({ error: { code: "not_found", message: "Route not found." } }, 404);
}

/** Creates one signed assertion response. */
function createAssertionResponse(
  config: DevAdminIdentityGatewayConfig,
  body: AssertionRequestBody | undefined,
): AssertionResponseBody {
  const assertion = assertionFromRequest(config, body);
  const signed = signAdminIdentityAssertion(assertion, config.assertionSecret);
  return {
    actor: {
      orgIds: assertion.orgIds ?? [],
      permissions: assertion.permissions,
      provider: assertion.provider,
      providerSubject: assertion.providerSubject,
      repoIds: assertion.repoIds ?? [],
    },
    encodedAssertion: signed.encodedAssertion,
    headers: {
      "x-heimdall-idp-assertion": signed.encodedAssertion,
      "x-heimdall-idp-signature": signed.signature,
      "x-heimdall-idp-timestamp": signed.timestamp,
    },
    signature: signed.signature,
    timestamp: signed.timestamp,
  };
}

/** Builds an admin assertion from defaults plus request overrides. */
function assertionFromRequest(
  config: DevAdminIdentityGatewayConfig,
  body: AssertionRequestBody | undefined,
): AdminIdentityAssertion {
  return {
    displayName: stringField(body?.displayName) ?? config.displayName,
    email: stringField(body?.email) ?? config.email,
    githubOrg: config.provider === "github_org" ? config.githubOrg : undefined,
    orgIds: scopedList(body?.orgIds, body?.orgId, config.orgIds),
    permissions: permissionList(body?.permissions, config.permissions),
    provider: config.provider,
    providerSubject: stringField(body?.providerSubject) ?? config.providerSubject,
    repoIds: scopedList(body?.repoIds, body?.repoId, config.repoIds),
  };
}

/** Reads and validates gateway configuration from the process environment. */
function readConfig(): DevAdminIdentityGatewayConfig {
  if (process.env.NODE_ENV === "production") {
    throw new Error("dev-admin-idp refuses to run with NODE_ENV=production.");
  }

  const provider = providerFromEnv(process.env.HEIMDALL_DEV_ADMIN_IDP_PROVIDER ?? "oidc");
  const githubOrg = emptyToUndefined(process.env.HEIMDALL_ADMIN_GITHUB_ORG);
  if (provider === "github_org" && !githubOrg) {
    throw new Error("HEIMDALL_ADMIN_GITHUB_ORG is required for github_org dev assertions.");
  }

  return {
    assertionSecret:
      emptyToUndefined(process.env.HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET) ??
      DEFAULT_DEV_ASSERTION_SECRET,
    displayName: emptyToUndefined(process.env.HEIMDALL_DEV_ADMIN_IDP_DISPLAY_NAME) ?? "Dev Admin",
    email: emptyToUndefined(process.env.HEIMDALL_DEV_ADMIN_IDP_EMAIL) ?? "dev-admin@example.local",
    githubOrg,
    host: process.env.HEIMDALL_DEV_ADMIN_IDP_HOST ?? "127.0.0.1",
    orgIds: parseStringList(process.env.HEIMDALL_DEV_ADMIN_IDP_ORG_IDS) ?? ["org_local"],
    permissions: parsePermissionList(process.env.HEIMDALL_DEV_ADMIN_IDP_PERMISSIONS) ?? [
      ...ADMIN_PERMISSIONS,
    ],
    port: parsePort(process.env.HEIMDALL_DEV_ADMIN_IDP_PORT),
    provider,
    providerSubject: process.env.HEIMDALL_DEV_ADMIN_IDP_SUBJECT ?? "dev-admin",
    repoIds: parseStringList(process.env.HEIMDALL_DEV_ADMIN_IDP_REPO_IDS) ?? [],
  };
}

/** Reads a JSON request body as an assertion override object. */
async function readJsonBody(request: Request): Promise<AssertionRequestBody | undefined> {
  const body = (await request.json().catch(() => undefined)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as AssertionRequestBody)
    : undefined;
}

/** Returns a JSON response with dev-friendly CORS headers. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-origin": "http://localhost:3001",
      "cache-control": "no-store",
      "content-type": "application/json",
    },
    status,
  });
}

/** Parses one identity provider value. */
function providerFromEnv(value: string): AdminIdentityProvider {
  if (value === "oidc" || value === "saml" || value === "github_org") {
    return value;
  }

  throw new Error("HEIMDALL_DEV_ADMIN_IDP_PROVIDER must be oidc, saml, or github_org.");
}

/** Parses one port value. */
function parsePort(value: string | undefined): number {
  const port = Number(value ?? "4317");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("HEIMDALL_DEV_ADMIN_IDP_PORT must be a valid TCP port.");
  }

  return port;
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

/** Parses a comma-separated permission list. */
function parsePermissionList(value: string | undefined): readonly AdminPermission[] | undefined {
  const entries = parseStringList(value);
  if (!entries) {
    return undefined;
  }

  return permissionList(entries, []);
}

/** Returns a request-supplied or fallback string list. */
function scopedList(
  listValue: unknown,
  singleValue: unknown,
  fallback: readonly string[],
): readonly string[] {
  const list = Array.isArray(listValue)
    ? listValue.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : undefined;
  const single = stringField(singleValue);
  if (list && list.length > 0) {
    return list;
  }
  if (single) {
    return [single];
  }

  return fallback;
}

/** Returns valid permissions from a request value or fallback. */
function permissionList(
  value: unknown,
  fallback: readonly AdminPermission[],
): readonly AdminPermission[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const permissions = value.filter(
    (entry): entry is AdminPermission =>
      typeof entry === "string" && ADMIN_PERMISSIONS.includes(entry as AdminPermission),
  );
  return permissions.length > 0 ? permissions : fallback;
}

/** Returns a non-empty string value. */
function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Converts blank environment values to undefined. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

await main();
