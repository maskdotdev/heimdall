import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AdminIdentityAssertion, signAdminIdentityAssertion } from "@repo/security";
import { describe, expect, it } from "vitest";
import { ADMIN_IDENTITY_HEADER_NAMES } from "../scripts/admin-smoke-identity";
import {
  checkDashboardApiConfiguration,
  type PreflightEnvironment,
  validateDeploymentConfiguration,
  validateGatewayAssertion,
} from "../scripts/control-plane-staging-preflight";

describe("control-plane staging preflight", () => {
  it("accepts a complete GitHub-org staging configuration", () => {
    const urls = validateDeploymentConfiguration(preflightEnvironment());

    expect(urls.api.origin).toBe("https://api.staging.example.com");
    expect(urls.assertion.origin).toBe("https://idp-gateway.staging.example.com");
    expect(urls.web.origin).toBe("https://admin.staging.example.com");
  });

  it("rejects local or non-HTTPS staging targets", () => {
    expect(() =>
      validateDeploymentConfiguration(
        preflightEnvironment({
          apiUrl: "http://localhost:3000",
        }),
      ),
    ).toThrow(/API_URL must use https for staging proof/);

    expect(() =>
      validateDeploymentConfiguration(
        preflightEnvironment({
          webUrl: "https://127.0.0.1:3001",
        }),
      ),
    ).toThrow(/WEB_URL must point at a deployed staging target/);
  });

  it("rejects unsafe auth, CORS, write, and permission settings", () => {
    expect(() =>
      validateDeploymentConfiguration(
        preflightEnvironment({
          adminAllowedOrigins: ["*"],
          allowReplayWrite: false,
          allowSettingsWrite: false,
          gatewayAllowedLogins: [],
          gatewayAllowedOrigins: ["*"],
          gatewayPermissions: ["admin.inspect"],
        }),
      ),
    ).toThrow(/HEIMDALL_ADMIN_ALLOWED_ORIGINS must include WEB_URL origin/);

    expect(() =>
      validateDeploymentConfiguration(
        preflightEnvironment({
          adminAllowedOrigins: ["*"],
          allowReplayWrite: false,
          allowSettingsWrite: false,
          gatewayAllowedLogins: [],
          gatewayAllowedOrigins: ["*"],
          gatewayPermissions: ["admin.inspect"],
        }),
      ),
    ).toThrow(/HEIMDALL_DASHBOARD_E2E_ALLOW_SETTINGS_WRITE must be true/);

    expect(() =>
      validateDeploymentConfiguration(
        preflightEnvironment({
          adminAllowedOrigins: ["*"],
          allowReplayWrite: false,
          allowSettingsWrite: false,
          gatewayAllowedLogins: [],
          gatewayAllowedOrigins: ["*"],
          gatewayPermissions: ["admin.inspect"],
        }),
      ),
    ).toThrow(/HEIMDALL_ADMIN_GATEWAY_PERMISSIONS must include admin.replay.plan/);
  });

  it("rejects gateway and dashboard origin mismatches", () => {
    expect(() =>
      validateDeploymentConfiguration(
        preflightEnvironment({
          assertionUrl: "https://other-gateway.staging.example.com/heimdall/assertion",
        }),
      ),
    ).toThrow(/HEIMDALL_ADMIN_SMOKE_ASSERTION_URL must use HEIMDALL_ADMIN_GATEWAY_PUBLIC_URL/);

    expect(() =>
      validateDeploymentConfiguration(
        preflightEnvironment({
          gatewayDashboardUrl: "https://other-admin.staging.example.com",
        }),
      ),
    ).toThrow(/HEIMDALL_ADMIN_GATEWAY_DASHBOARD_URL must use WEB_URL origin/);
  });

  it("verifies gateway assertion provider, org, scope, and permissions", () => {
    const env = preflightEnvironment();

    expect(validateGatewayAssertion(env, gatewayIdentity(env))).toMatchObject({
      actorUserId: "github_org:12345",
      orgIds: ["org_staging"],
      repoIds: ["repo_staging"],
    });
    expect(() =>
      validateGatewayAssertion(env, gatewayIdentity(env, { githubOrg: "other-org" })),
    ).toThrow(/GitHub organization membership is required/);
    expect(() => validateGatewayAssertion(env, gatewayIdentity(env, { provider: "oidc" }))).toThrow(
      /unexpected provider/,
    );
    expect(() =>
      validateGatewayAssertion(env, gatewayIdentity(env, { orgIds: ["org_other"] })),
    ).toThrow(/gateway assertion org scope must include org_staging/);
    expect(() =>
      validateGatewayAssertion(env, gatewayIdentity(env, { repoIds: ["repo_other"] })),
    ).toThrow(/gateway assertion repo scope must include repo_staging/);
    expect(() =>
      validateGatewayAssertion(env, gatewayIdentity(env, { permissions: ["admin.inspect"] })),
    ).toThrow(/HEIMDALL_ADMIN_GATEWAY_PERMISSIONS must include admin.replay.plan/);
  });

  it("verifies that the dashboard bundle references the configured API and gateway URLs", async () => {
    const server = await createDashboardServer(
      [
        'const apiBaseUrl = "https://api.staging.example.com";',
        'const gatewayBaseUrl = "https://gateway.staging.example.com";',
      ].join("\n"),
    );

    try {
      await expect(
        checkDashboardApiConfiguration(
          server.url,
          "https://api.staging.example.com",
          "https://gateway.staging.example.com",
        ),
      ).resolves.toMatchObject({ name: "dashboard API configuration" });
      await expect(
        checkDashboardApiConfiguration(server.url, "https://other-api.staging.example.com"),
      ).rejects.toThrow(/dashboard bundle does not contain API_URL/);
      await expect(
        checkDashboardApiConfiguration(
          server.url,
          "https://api.staging.example.com",
          "https://other-gateway.staging.example.com",
        ),
      ).rejects.toThrow(/dashboard bundle does not contain GATEWAY_URL/);
    } finally {
      await server.close();
    }
  });
});

/** Creates a valid preflight environment with optional field overrides. */
function preflightEnvironment(overrides: Partial<PreflightEnvironment> = {}): PreflightEnvironment {
  return {
    adminAllowedOrigins: ["https://admin.staging.example.com"],
    adminEnabled: "true",
    adminGithubOrg: "example-org",
    adminIdentityAssertionSecret: "assertion-secret-with-at-least-32-chars",
    adminIdentityProvider: "github_org",
    adminRouteExposure: "public",
    adminSessionSecret: "admin-session-secret-with-at-least-32-chars",
    allowReplayWrite: true,
    allowSettingsWrite: true,
    apiUrl: "https://api.staging.example.com",
    assertionUrl: "https://idp-gateway.staging.example.com/heimdall/assertion",
    browserWsEndpoint: "wss://browser.staging.example.com/devtools/browser/session",
    gatewayAllowedLogins: ["octo-admin"],
    gatewayAllowedOrigins: ["https://admin.staging.example.com"],
    gatewayAllowAllOrgMembers: false,
    gatewayCookie: "heimdall_admin_gateway_session=session",
    gatewayDashboardUrl: "https://admin.staging.example.com",
    gatewayPermissions: [
      "admin.inspect",
      "admin.replay.plan",
      "admin.replay.execute",
      "admin.settings.manage",
      "admin.audit.view",
    ],
    gatewayPublicUrl: "https://idp-gateway.staging.example.com",
    gatewaySessionSecret: "gateway-session-secret-with-at-least-32-chars",
    githubClientId: "github-client-id",
    githubClientSecret: "github-client-secret",
    orgId: "org_staging",
    replayId: "webhook_staging",
    replayKind: "webhook",
    repoId: "repo_staging",
    webUrl: "https://admin.staging.example.com",
    ...overrides,
  };
}

/** Creates one signed gateway identity fixture. */
function gatewayIdentity(
  env: PreflightEnvironment,
  overrides: Partial<AdminIdentityAssertion> = {},
): {
  /** API request headers emitted by the gateway. */
  readonly headers: {
    /** Encoded admin assertion. */
    readonly [ADMIN_IDENTITY_HEADER_NAMES.assertion]: string;
    /** Admin assertion signature. */
    readonly [ADMIN_IDENTITY_HEADER_NAMES.signature]: string;
    /** Admin assertion timestamp. */
    readonly [ADMIN_IDENTITY_HEADER_NAMES.timestamp]: string;
  };
  /** Gateway origin that emitted the assertion. */
  readonly source: string;
} {
  const signed = signAdminIdentityAssertion(
    {
      githubOrg: env.adminGithubOrg,
      orgIds: [env.orgId],
      permissions: [
        "admin.inspect",
        "admin.replay.plan",
        "admin.replay.execute",
        "admin.settings.manage",
        "admin.audit.view",
      ],
      provider: "github_org",
      providerSubject: "12345",
      repoIds: [env.repoId],
      ...overrides,
    },
    env.adminIdentityAssertionSecret,
  );

  return {
    headers: {
      [ADMIN_IDENTITY_HEADER_NAMES.assertion]: signed.encodedAssertion,
      [ADMIN_IDENTITY_HEADER_NAMES.signature]: signed.signature,
      [ADMIN_IDENTITY_HEADER_NAMES.timestamp]: signed.timestamp,
    },
    source: env.gatewayPublicUrl,
  };
}

/** Running dashboard test server descriptor. */
type DashboardTestServer = {
  /** Base URL for the running test server. */
  readonly url: string;
  /** Closes the test server. */
  readonly close: () => Promise<void>;
};

/** Starts a dashboard asset server that serves one JavaScript bundle. */
async function createDashboardServer(assetBody: string): Promise<DashboardTestServer> {
  const server = createServer((request, response) => {
    handleDashboardRequest(request, response, assetBody);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("dashboard test server did not bind to a TCP port.");
  }

  return {
    close: () => closeServer(server),
    url: `http://127.0.0.1:${address.port}`,
  };
}

/** Handles one dashboard fixture request. */
function handleDashboardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  assetBody: string,
): void {
  if (request.url === "/assets/index.js") {
    response.writeHead(200, { "content-type": "application/javascript" });
    response.end(assetBody);
    return;
  }

  response.writeHead(200, { "content-type": "text/html" });
  response.end('<!doctype html><script type="module" src="/assets/index.js"></script>');
}

/** Closes one HTTP server. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
