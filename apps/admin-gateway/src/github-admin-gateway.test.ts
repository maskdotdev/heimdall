import { verifyAdminIdentityAssertion } from "@repo/security";
import { describe, expect, it } from "vitest";
import { createGitHubAdminGateway, type GitHubAdminGatewayConfig } from "./github-admin-gateway";

describe("GitHub admin gateway", () => {
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
    const gateway = createGitHubAdminGateway(baseConfig(), {
      ...deterministicDependencies(),
      fetch: async (input) => githubResponse(input.toString(), "other-admin", "active"),
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

  it("normalizes configured allowed origins before request checks", () => {
    const gateway = createGitHubAdminGateway({
      ...baseConfig(),
      allowedOrigins: ["https://admin.test/settings"],
    });

    expect(gateway.config.allowedOrigins).toEqual(["https://admin.test"]);
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
