import {
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricOptions,
  type TelemetryMetricRecorder,
  type TelemetrySpanEndOptions,
  type TelemetrySpanOptions,
  type TelemetrySpanRecorder,
} from "@repo/observability";
import { createMemorySecurityEventSink, verifyAdminIdentityAssertion } from "@repo/security";
import { describe, expect, it } from "vitest";
import {
  createGitHubAdminGateway,
  type GitHubAdminGatewayConfig,
  readGitHubAdminGatewayConfig,
} from "./github-admin-gateway";

type RecordedMetric = {
  /** Low-cardinality metric labels captured by the test recorder. */
  readonly labels?: TelemetryMetricOptions["labels"] | undefined;
  /** Metric instrument name. */
  readonly name: string;
  /** Metric unit. */
  readonly unit?: string | undefined;
  /** Recorded metric value. */
  readonly value: number;
};

type RecordedSpan = {
  /** Attributes attached when the span ended. */
  readonly endAttributes?: TelemetrySpanEndOptions["attributes"] | undefined;
  /** Span name. */
  readonly name: string;
  /** Attributes attached when the span started. */
  readonly startAttributes?: TelemetrySpanOptions["attributes"] | undefined;
  /** Span status. */
  readonly status?: TelemetrySpanEndOptions["status"] | undefined;
  /** Trace context attached when the span started. */
  readonly traceContext?: TelemetrySpanOptions["traceContext"] | undefined;
};

type RecordedGatewayWarning = {
  /** Product-safe gateway warning fields. */
  readonly fields?: Record<string, unknown> | undefined;
  /** Warning message emitted by the gateway. */
  readonly message: string;
};

describe("GitHub admin gateway", () => {
  it("emits product-safe request telemetry and propagates request IDs", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const gateway = createGitHubAdminGateway(baseConfig(), {
      ...deterministicDependencies(),
      metrics: createRecordingMetrics(metrics),
      traces: createRecordingTraces(spans),
    });

    const response = await gateway.handle(
      new Request("https://gateway.test/healthz?token=github-client-secret", {
        headers: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          "x-request-id": "req_gateway_1",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req_gateway_1");
    expect(metrics).toContainEqual({
      labels: {
        method: "GET",
        route: "/healthz",
        status_class: "2xx",
      },
      name: OBSERVABILITY_METRIC_NAMES.adminGatewayRequestsTotal,
      value: 1,
    });
    expect(metrics).toContainEqual({
      labels: {
        method: "GET",
        route: "/healthz",
        status_class: "2xx",
      },
      name: OBSERVABILITY_METRIC_NAMES.adminGatewayRequestDurationMs,
      unit: "ms",
      value: 0,
    });
    expect(spans).toContainEqual({
      endAttributes: {
        "admin_gateway.status_code": 200,
      },
      name: OBSERVABILITY_SPAN_NAMES.adminGatewayRequest,
      startAttributes: {
        "admin_gateway.method": "GET",
        "admin_gateway.route": "/healthz",
      },
      status: "ok",
      traceContext: {
        requestId: "req_gateway_1",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    });
    expect(JSON.stringify({ metrics, spans })).not.toContain("github-client-secret");
  });

  it("starts GitHub OAuth with a signed state cookie", async () => {
    const gateway = createGitHubAdminGateway(baseConfig(), deterministicDependencies());

    const response = await gateway.handle(
      new Request("https://gateway.test/auth/github/start?returnTo=https://admin.test/admin"),
    );

    expect(response.status).toBe(302);
    const location = new URL(requiredHeader(response, "location"));
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("github-client-id");
    expect(location.searchParams.get("scope")).toBe("read:org");
    expect(requiredHeader(response, "set-cookie")).toContain("heimdall_admin_gateway_oauth_state=");
  });

  it("authenticates active allowlisted GitHub org members and emits signed assertions", async () => {
    const fetchCalls: string[] = [];
    const gateway = createGitHubAdminGateway(baseConfig(), {
      ...deterministicDependencies(),
      fetch: async (input) => {
        fetchCalls.push(input.toString());
        return githubResponse(input.toString(), "allowed-admin", "active");
      },
    });
    const start = await gateway.handle(new Request("https://gateway.test/auth/github/start"));
    const state = requiredOAuthState(start);
    const callback = await gateway.handle(
      new Request(`https://gateway.test/auth/github/callback?code=oauth-code&state=${state}`, {
        headers: { cookie: cookiePair(start, "heimdall_admin_gateway_oauth_state") },
      }),
    );
    expect(callback.status).toBe(302);
    expect(fetchCalls).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
      "https://api.github.com/user/memberships/orgs/octo-org",
    ]);

    const assertionResponse = await gateway.handle(
      new Request("https://gateway.test/heimdall/assertion", {
        body: JSON.stringify({ orgId: "org_1", repoId: "repo_1", purpose: "test" }),
        headers: {
          cookie: cookiePair(callback, "heimdall_admin_gateway_session"),
          origin: "https://admin.test",
        },
        method: "POST",
      }),
    );

    expect(assertionResponse.status).toBe(200);
    const body = (await assertionResponse.json()) as {
      readonly encodedAssertion: string;
      readonly signature: string;
      readonly timestamp: string;
    };
    const actor = verifyAdminIdentityAssertion({
      assertionSecret: "assertion-secret-with-at-least-32-chars",
      encodedAssertion: body.encodedAssertion,
      expectedProvider: "github_org",
      requiredGithubOrg: "octo-org",
      signature: body.signature,
      timestamp: body.timestamp,
      now: () => new Date("2026-05-06T12:00:00.000Z"),
    });
    expect(actor).toMatchObject({
      actorUserId: "github_org:12345",
      orgIds: ["org_1"],
      permissions: ["admin.inspect", "admin.replay.execute"],
      repoIds: ["repo_1"],
    });
  });

  it("rejects GitHub users that are not in the allowed login list", async () => {
    const securityEventSink = createMemorySecurityEventSink();
    const gateway = createGitHubAdminGateway(baseConfig(), {
      ...deterministicDependencies(),
      fetch: async (input) => githubResponse(input.toString(), "other-admin", "active"),
      securityEventSink,
    });
    const start = await gateway.handle(new Request("https://gateway.test/auth/github/start"));
    const state = requiredOAuthState(start);

    const callback = await gateway.handle(
      new Request(`https://gateway.test/auth/github/callback?code=oauth-code&state=${state}`, {
        headers: { cookie: cookiePair(start, "heimdall_admin_gateway_oauth_state") },
      }),
    );

    expect(callback.status).toBe(403);
    await expect(callback.json()).resolves.toMatchObject({
      error: { code: "admin_gateway.github_login_forbidden" },
    });
    expect(securityEventSink.events()).toMatchObject([
      {
        createdAt: "2026-05-06T12:00:00.000Z",
        metadata: {
          denialReason: "admin_gateway.github_login_forbidden",
          method: "GET",
          route: "/auth/github/callback",
          statusCode: 403,
        },
        resourceId: "/auth/github/callback",
        resourceType: "admin_gateway_route",
        severity: "medium",
        source: "admin_gateway",
        status: "new",
        type: "admin_gateway_github_login_forbidden",
      },
    ]);
    expect(JSON.stringify(securityEventSink.events())).not.toContain("github-access-token");
  });

  it("rejects inactive GitHub organization memberships", async () => {
    const gateway = createGitHubAdminGateway(baseConfig(), {
      ...deterministicDependencies(),
      fetch: async (input) => githubResponse(input.toString(), "allowed-admin", "pending"),
    });
    const start = await gateway.handle(new Request("https://gateway.test/auth/github/start"));
    const state = requiredOAuthState(start);

    const callback = await gateway.handle(
      new Request(`https://gateway.test/auth/github/callback?code=oauth-code&state=${state}`, {
        headers: { cookie: cookiePair(start, "heimdall_admin_gateway_oauth_state") },
      }),
    );

    expect(callback.status).toBe(403);
    await expect(callback.json()).resolves.toMatchObject({
      error: { code: "admin_gateway.github_org_forbidden" },
    });
  });

  it("reports product-safe GitHub API validation failure details", async () => {
    const warnings: RecordedGatewayWarning[] = [];
    const gateway = createGitHubAdminGateway(baseConfig(), {
      ...deterministicDependencies(),
      fetch: async (input) => githubResponse(input.toString(), "allowed-admin", "missing"),
      logger: {
        warn: (message, fields) => {
          warnings.push({ fields, message });
        },
      },
    });
    const start = await gateway.handle(new Request("https://gateway.test/auth/github/start"));
    const state = requiredOAuthState(start);

    const callback = await gateway.handle(
      new Request(`https://gateway.test/auth/github/callback?code=oauth-code&state=${state}`, {
        headers: { cookie: cookiePair(start, "heimdall_admin_gateway_oauth_state") },
      }),
    );

    expect(callback.status).toBe(403);
    await expect(callback.json()).resolves.toMatchObject({
      error: {
        code: "admin_gateway.github_api_failed",
        details: {
          githubStatus: 404,
          githubStep: "membership",
        },
      },
    });
    expect(warnings).toContainEqual({
      fields: {
        code: "admin_gateway.github_api_failed",
        details: {
          githubStatus: 404,
          githubStep: "membership",
        },
        status: 403,
      },
      message: "admin gateway request rejected",
    });
    expect(JSON.stringify(warnings)).not.toContain("github-access-token");
  });

  it("permits allowlisted GitHub users when user owner fallback is explicitly enabled", async () => {
    const fetchCalls: string[] = [];
    const gateway = createGitHubAdminGateway(
      {
        ...baseConfig(),
        allowUserLoginWithoutOrg: true,
        githubOrg: "allowed-admin",
      },
      {
        ...deterministicDependencies(),
        fetch: async (input) => {
          fetchCalls.push(input.toString());
          return githubResponse(input.toString(), "allowed-admin", "active");
        },
      },
    );
    const start = await gateway.handle(new Request("https://gateway.test/auth/github/start"));
    const state = requiredOAuthState(start);

    const callback = await gateway.handle(
      new Request(`https://gateway.test/auth/github/callback?code=oauth-code&state=${state}`, {
        headers: { cookie: cookiePair(start, "heimdall_admin_gateway_oauth_state") },
      }),
    );

    expect(callback.status).toBe(302);
    expect(fetchCalls).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
      "https://api.github.com/user/memberships/orgs/allowed-admin",
    ]);
  });

  it("rejects assertion scope requests outside the gateway session scope", async () => {
    const securityEventSink = createMemorySecurityEventSink();
    const gateway = createGitHubAdminGateway(baseConfig(), {
      ...deterministicDependencies(),
      fetch: async (input) => githubResponse(input.toString(), "allowed-admin", "active"),
      securityEventSink,
    });
    const start = await gateway.handle(new Request("https://gateway.test/auth/github/start"));
    const state = requiredOAuthState(start);
    const callback = await gateway.handle(
      new Request(`https://gateway.test/auth/github/callback?code=oauth-code&state=${state}`, {
        headers: { cookie: cookiePair(start, "heimdall_admin_gateway_oauth_state") },
      }),
    );

    const assertionResponse = await gateway.handle(
      new Request("https://gateway.test/assertion", {
        body: JSON.stringify({ orgId: "org_2" }),
        headers: {
          cookie: cookiePair(callback, "heimdall_admin_gateway_session"),
          origin: "https://admin.test",
        },
        method: "POST",
      }),
    );

    expect(assertionResponse.status).toBe(403);
    await expect(assertionResponse.json()).resolves.toMatchObject({
      error: { code: "admin_gateway.scope_forbidden" },
    });
    expect(securityEventSink.events()).toMatchObject([
      {
        metadata: {
          denialReason: "admin_gateway.scope_forbidden",
          method: "POST",
          route: "/assertion",
          statusCode: 403,
        },
        resourceId: "/assertion",
        resourceType: "admin_gateway_route",
        severity: "high",
        source: "admin_gateway",
        type: "admin_gateway_scope_forbidden",
      },
    ]);
  });

  it("requires POST for signed assertion issuance", async () => {
    const gateway = createGitHubAdminGateway(baseConfig(), {
      ...deterministicDependencies(),
      fetch: async (input) => githubResponse(input.toString(), "allowed-admin", "active"),
    });
    const start = await gateway.handle(new Request("https://gateway.test/auth/github/start"));
    const state = requiredOAuthState(start);
    const callback = await gateway.handle(
      new Request(`https://gateway.test/auth/github/callback?code=oauth-code&state=${state}`, {
        headers: { cookie: cookiePair(start, "heimdall_admin_gateway_oauth_state") },
      }),
    );

    const assertionResponse = await gateway.handle(
      new Request("https://gateway.test/assertion", {
        headers: { cookie: cookiePair(callback, "heimdall_admin_gateway_session") },
        method: "GET",
      }),
    );

    expect(assertionResponse.status).toBe(405);
    await expect(assertionResponse.json()).resolves.toMatchObject({
      error: { code: "admin_gateway.method_not_allowed" },
    });
  });

  it("requires an allowed origin for signed assertion issuance", async () => {
    const gateway = createGitHubAdminGateway(baseConfig(), {
      ...deterministicDependencies(),
      fetch: async (input) => githubResponse(input.toString(), "allowed-admin", "active"),
    });
    const start = await gateway.handle(new Request("https://gateway.test/auth/github/start"));
    const state = requiredOAuthState(start);
    const callback = await gateway.handle(
      new Request(`https://gateway.test/auth/github/callback?code=oauth-code&state=${state}`, {
        headers: { cookie: cookiePair(start, "heimdall_admin_gateway_oauth_state") },
      }),
    );

    const assertionResponse = await gateway.handle(
      new Request("https://gateway.test/assertion", {
        body: JSON.stringify({ orgId: "org_1" }),
        headers: { cookie: cookiePair(callback, "heimdall_admin_gateway_session") },
        method: "POST",
      }),
    );

    expect(assertionResponse.status).toBe(403);
    await expect(assertionResponse.json()).resolves.toMatchObject({
      error: { code: "admin_gateway.cors_forbidden" },
    });
  });

  it("keeps CORS headers on rejected assertion responses for allowed origins", async () => {
    const gateway = createGitHubAdminGateway(baseConfig(), deterministicDependencies());

    const assertionResponse = await gateway.handle(
      new Request("https://gateway.test/assertion", {
        body: JSON.stringify({ purpose: "dashboard-login" }),
        headers: {
          "content-type": "application/json",
          origin: "https://admin.test",
        },
        method: "POST",
      }),
    );

    expect(assertionResponse.status).toBe(401);
    expect(assertionResponse.headers.get("access-control-allow-origin")).toBe("https://admin.test");
    expect(assertionResponse.headers.get("access-control-allow-credentials")).toBe("true");
    await expect(assertionResponse.json()).resolves.toMatchObject({
      error: { code: "admin_gateway.unauthorized" },
    });
  });

  it("normalizes configured allowed origins before request checks", () => {
    const gateway = createGitHubAdminGateway({
      ...baseConfig(),
      allowedOrigins: ["https://admin.test/settings"],
    });

    expect(gateway.config.allowedOrigins).toEqual(["https://admin.test"]);
  });

  it("defaults cross-origin deployment session cookies to SameSite=None", () => {
    const config = readGitHubAdminGatewayConfig({
      GITHUB_CLIENT_ID: "github-client-id",
      GITHUB_CLIENT_SECRET: "github-client-secret",
      HEIMDALL_ADMIN_GATEWAY_ALLOWED_LOGINS: "allowed-admin",
      HEIMDALL_ADMIN_GATEWAY_DASHBOARD_URL: "https://admin.test",
      HEIMDALL_ADMIN_GATEWAY_ORG_IDS: "org_1",
      HEIMDALL_ADMIN_GATEWAY_PERMISSIONS: "admin.inspect",
      HEIMDALL_ADMIN_GATEWAY_PUBLIC_URL: "https://gateway.test",
      HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET: "gateway-session-secret-with-at-least-32-chars",
      HEIMDALL_ADMIN_GITHUB_ORG: "octo-org",
      HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET: "assertion-secret-with-at-least-32-chars",
      NODE_ENV: "production",
    });

    expect(config.sessionCookieSameSite).toBe("None");
  });

  it("rejects unsafe production gateway configuration", () => {
    expect(() =>
      createGitHubAdminGateway({
        ...baseConfig(),
        allowedOrigins: ["*"],
      }),
    ).toThrow(/HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS must not include wildcard origins/);

    expect(() =>
      createGitHubAdminGateway({
        ...baseConfig(),
        allowedOrigins: ["http://admin.test"],
        nodeEnv: "production",
      }),
    ).toThrow(/HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS must use https in production/);

    expect(() =>
      createGitHubAdminGateway({
        ...baseConfig(),
        secureCookies: false,
        sessionCookieSameSite: "None",
      }),
    ).toThrow(/SameSite=None gateway session cookies require secure cookies/);

    expect(() =>
      createGitHubAdminGateway({
        ...baseConfig(),
        dashboardUrl: "http://admin.test",
        nodeEnv: "production",
      }),
    ).toThrow(/HEIMDALL_ADMIN_GATEWAY_DASHBOARD_URL must use https in production/);

    expect(() =>
      createGitHubAdminGateway({
        ...baseConfig(),
        oauthScopes: ["user:email"],
      }),
    ).toThrow(/HEIMDALL_ADMIN_GATEWAY_GITHUB_SCOPES must include read:org/);

    expect(() =>
      createGitHubAdminGateway({
        ...baseConfig(),
        sessionMaxAgeSeconds: 28_801,
      }),
    ).toThrow(/HEIMDALL_ADMIN_GATEWAY_SESSION_MAX_AGE_SECONDS must be between 1 and 28800/);

    expect(() =>
      createGitHubAdminGateway({
        ...baseConfig(),
        oauthStateMaxAgeSeconds: 901,
      }),
    ).toThrow(/HEIMDALL_ADMIN_GATEWAY_OAUTH_STATE_MAX_AGE_SECONDS must be between 1 and 900/);
  });
});

/** Returns a baseline valid gateway config for tests. */
function baseConfig(): GitHubAdminGatewayConfig {
  return {
    allowAllOrgMembers: false,
    allowUserLoginWithoutOrg: false,
    allowedGithubLogins: ["allowed-admin"],
    allowedOrigins: ["https://admin.test"],
    assertionSecret: "assertion-secret-with-at-least-32-chars",
    dashboardUrl: "https://admin.test",
    githubClientId: "github-client-id",
    githubClientSecret: "github-client-secret",
    githubOrg: "octo-org",
    host: "127.0.0.1",
    nodeEnv: "test",
    oauthScopes: ["read:org"],
    oauthStateMaxAgeSeconds: 600,
    orgIds: ["org_1"],
    permissions: ["admin.inspect", "admin.replay.execute"],
    port: 4318,
    publicUrl: "https://gateway.test",
    repoIds: ["repo_1"],
    secureCookies: true,
    sessionCookieName: "heimdall_admin_gateway_session",
    sessionCookieSameSite: "Lax",
    sessionMaxAgeSeconds: 3600,
    sessionSecret: "gateway-session-secret-with-at-least-32-chars",
    stateCookieName: "heimdall_admin_gateway_oauth_state",
  };
}

/** Returns deterministic dependencies for gateway tests. */
function deterministicDependencies() {
  return {
    logger: {},
    now: () => new Date("2026-05-06T12:00:00.000Z"),
    randomToken: () => "deterministic-token-with-enough-length",
  };
}

/** Creates a metric recorder that stores metric points in memory. */
function createRecordingMetrics(records: RecordedMetric[]): TelemetryMetricRecorder {
  return {
    count: (name, options) => {
      records.push({
        labels: options?.labels,
        name,
        value: options?.value ?? 1,
      });
    },
    gauge: (name, value, options) => {
      records.push({
        labels: options?.labels,
        name,
        unit: options?.unit,
        value,
      });
    },
    histogram: (name, value, options) => {
      records.push({
        labels: options?.labels,
        name,
        unit: options?.unit,
        value,
      });
    },
  };
}

/** Creates a span recorder that stores span records in memory. */
function createRecordingTraces(records: RecordedSpan[]): TelemetrySpanRecorder {
  return {
    startSpan: (name, options) => {
      return {
        end: (endOptions) => {
          records.push({
            endAttributes: endOptions?.attributes,
            name,
            startAttributes: options?.attributes,
            status: endOptions?.status,
            traceContext: options?.traceContext,
          });

          return undefined;
        },
      };
    },
  };
}

/** Returns a fake GitHub HTTP response for the requested URL. */
function githubResponse(url: string, login: string, membershipState: string): Response {
  if (url === "https://github.com/login/oauth/access_token") {
    return Response.json({ access_token: "github-access-token", token_type: "bearer" });
  }
  if (url === "https://api.github.com/user") {
    return Response.json({
      email: "admin@example.com",
      id: 12345,
      login,
      name: "Allowed Admin",
    });
  }
  if (url === "https://api.github.com/user/memberships/orgs/octo-org") {
    if (membershipState === "missing") {
      return Response.json({ message: "not found" }, { status: 404 });
    }

    return Response.json({
      organization: { login: "octo-org" },
      role: "admin",
      state: membershipState,
    });
  }

  return Response.json({ message: "not found" }, { status: 404 });
}

/** Reads a required response header. */
function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) {
    throw new Error(`Missing response header ${name}.`);
  }

  return value;
}

/** Reads the OAuth state parameter from a start response redirect. */
function requiredOAuthState(response: Response): string {
  const state = new URL(requiredHeader(response, "location")).searchParams.get("state");
  if (!state) {
    throw new Error("OAuth start response did not include a state parameter.");
  }

  return state;
}

/** Extracts one cookie pair from a Set-Cookie response header. */
function cookiePair(response: Response, name: string): string {
  const setCookie = requiredHeader(response, "set-cookie");
  const match = new RegExp(`${name}=([^;,]+)`).exec(setCookie);
  if (!match?.[1]) {
    throw new Error(`Set-Cookie did not include ${name}.`);
  }

  return `${name}=${match[1]}`;
}
