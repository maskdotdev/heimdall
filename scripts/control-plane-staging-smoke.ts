import {
  type AdminIdentityRequestHeaders,
  readGatewayIdentityAssertion,
} from "./admin-smoke-identity";

/** Environment values required for the control-plane staging smoke. */
type SmokeEnvironment = {
  /** Dashboard origin allowed to use admin credentials. */
  readonly adminOrigin: string;
  /** Staging API base URL. */
  readonly apiUrl: string;
  /** Provider subject used for the smoke actor. */
  readonly providerSubject: string;
  /** Organization scope used for audit-history checks. */
  readonly orgId: string;
  /** Repository scope requested from the identity gateway. */
  readonly repoId: string;
};

/** Minimal API envelope returned by admin routes. */
type ApiEnvelope<T> = {
  /** Response payload. */
  readonly data: T;
};

/** Session payload returned by the admin API. */
type SmokeSession = {
  /** Session-bound CSRF token. */
  readonly csrfToken: string;
  /** Authenticated actor summary. */
  readonly actor: {
    /** Provider-backed actor ID. */
    readonly userId: string;
  };
};

/** Minimal audit row returned by admin audit search. */
type SmokeAuditLog = {
  /** Audit log ID recorded by the API. */
  readonly auditLogId: string;
  /** Audit action. */
  readonly action: string;
};

/** Runs the staging smoke test. */
async function main(): Promise<void> {
  const env = readEnvironment();
  const identity = await readGatewayIdentityAssertion({
    orgId: env.orgId,
    providerSubject: env.providerSubject,
    purpose: "control-plane-staging-smoke",
    repoId: env.repoId,
  });
  const login = await loginAdmin(env, identity.headers);
  await getJson<ApiEnvelope<SmokeSession>>(new URL("/admin/session", env.apiUrl), {
    headers: { cookie: login.cookie },
  });
  const loginAudit = await latestAuditLog(env, login.cookie, {
    action: "admin.session.created",
    actorUserId: login.session.actor.userId,
  });
  await getJson<ApiEnvelope<{ readonly auditLogs: readonly unknown[] }>>(
    new URL(`/admin/audit-logs?orgId=${encodeURIComponent(env.orgId)}&limit=5`, env.apiUrl),
    { headers: { cookie: login.cookie } },
  );
  const logout = await getJson<ApiEnvelope<{ readonly auditLogId?: string; readonly ok: boolean }>>(
    new URL("/admin/auth/logout", env.apiUrl),
    {
      method: "POST",
      headers: {
        cookie: login.cookie,
        origin: env.adminOrigin,
        "x-csrf-token": login.session.csrfToken,
      },
    },
  );

  console.log(
    JSON.stringify(
      {
        actor: login.session.actor.userId,
        auditLogIds: {
          login: loginAudit.auditLogId,
          logout: logout.data.auditLogId,
        },
        gatewayUrl: identity.source,
        orgId: env.orgId,
        repoId: env.repoId,
        status: "control-plane staging smoke passed",
      },
      null,
      2,
    ),
  );
}

/** Logs into the staging API with a signed identity assertion. */
async function loginAdmin(
  env: SmokeEnvironment,
  identityHeaders: AdminIdentityRequestHeaders,
): Promise<{
  /** Cookie header value returned by the API. */
  readonly cookie: string;
  /** Authenticated session payload. */
  readonly session: SmokeSession;
}> {
  const response = await fetch(new URL("/admin/auth/login", env.apiUrl), {
    method: "POST",
    headers: {
      ...identityHeaders,
      origin: env.adminOrigin,
    },
  });
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  const body = await response.json().catch(() => undefined);
  if (!response.ok || !cookie) {
    throw new Error(
      `Admin login smoke failed with HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  }

  return { cookie, session: (body as ApiEnvelope<SmokeSession>).data };
}

/** Gets JSON from one smoke endpoint and fails on non-2xx responses. */
async function getJson<T>(url: URL, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`${url.pathname} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  return body as T;
}

/** Returns the newest audit log for an actor/action in the smoke organization scope. */
async function latestAuditLog(
  env: SmokeEnvironment,
  cookie: string,
  filter: {
    /** Audit action filter. */
    readonly action: string;
    /** Actor user ID filter. */
    readonly actorUserId: string;
  },
): Promise<SmokeAuditLog> {
  const url = new URL("/admin/audit-logs", env.apiUrl);
  url.searchParams.set("action", filter.action);
  url.searchParams.set("actorUserId", filter.actorUserId);
  url.searchParams.set("limit", "1");
  url.searchParams.set("orgId", env.orgId);
  const body = await getJson<ApiEnvelope<{ readonly auditLogs: readonly SmokeAuditLog[] }>>(url, {
    headers: { cookie },
  });
  const [auditLog] = body.data.auditLogs;
  if (!auditLog) {
    throw new Error(`Audit log ${filter.action} was not found for ${filter.actorUserId}.`);
  }

  return auditLog;
}

/** Reads and validates smoke-test environment variables. */
function readEnvironment(): SmokeEnvironment {
  const env = requiredEnvironment([
    "API_URL",
    "HEIMDALL_ADMIN_SMOKE_ASSERTION_URL",
    "HEIMDALL_ADMIN_SMOKE_ORG_ID",
    "HEIMDALL_ADMIN_SMOKE_REPO_ID",
  ] as const);
  const allowLocalTarget = process.env.HEIMDALL_ADMIN_SMOKE_ALLOW_LOCAL_TARGET === "true";
  assertNonLocalProofTarget("API_URL", env.API_URL, allowLocalTarget);
  assertNonLocalProofTarget(
    "HEIMDALL_ADMIN_SMOKE_ASSERTION_URL",
    env.HEIMDALL_ADMIN_SMOKE_ASSERTION_URL,
    allowLocalTarget,
  );

  return {
    adminOrigin: adminSmokeOrigin(allowLocalTarget),
    apiUrl: env.API_URL,
    providerSubject: process.env.HEIMDALL_ADMIN_SMOKE_PROVIDER_SUBJECT ?? "staging-smoke",
    orgId: env.HEIMDALL_ADMIN_SMOKE_ORG_ID,
    repoId: env.HEIMDALL_ADMIN_SMOKE_REPO_ID,
  };
}

/** Resolves the dashboard origin sent on credentialed admin requests. */
function adminSmokeOrigin(allowLocalTarget: boolean): string {
  const configuredOrigin = emptyToUndefined(process.env.HEIMDALL_ADMIN_SMOKE_ORIGIN);
  if (configuredOrigin) {
    return new URL(configuredOrigin).origin;
  }

  const webUrl = emptyToUndefined(process.env.WEB_URL);
  if (webUrl) {
    return new URL(webUrl).origin;
  }

  if (allowLocalTarget) {
    return "http://localhost:3001";
  }

  throw new Error("WEB_URL or HEIMDALL_ADMIN_SMOKE_ORIGIN is required for staging smoke.");
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

/** Ensures a staging proof target does not point at local development services. */
function assertNonLocalProofTarget(name: string, value: string, allowLocalTarget: boolean): void {
  if (allowLocalTarget) {
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }

  if (isLocalHostname(url.hostname)) {
    throw new Error(
      `${name} must point at a deployed staging target. Set HEIMDALL_ADMIN_SMOKE_ALLOW_LOCAL_TARGET=true only for local development smoke.`,
    );
  }
}

/** Converts a blank string to undefined. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
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

await main();
