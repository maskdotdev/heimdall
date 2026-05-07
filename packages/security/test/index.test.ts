import { describe, expect, it } from "vitest";
import {
  actorCanAccessRepo,
  classifyArtifact,
  createAdminSessionManager,
  createLocalEnvSecretsManager,
  createMemorySecurityEventSink,
  createNoopSecurityEventSink,
  createSecurityEvent,
  createUnsupportedProductionSecretsManager,
  DEFAULT_RETENTION_POLICY,
  defaultSecurityEventSeverity,
  formatSecretRef,
  isProductRole,
  parseSecretRef,
  productActorHasOrgPermission,
  productActorHasRepoPermission,
  productCapabilities,
  productPermissionsForRole,
  productRoleHasPermission,
  recordSecurityEvent,
  redactResolvedSecret,
  resolveArtifactRetention,
  retentionClassForArtifactType,
  shouldAlertSecurityEvent,
  signAdminIdentityAssertion,
  verifyAdminIdentityAssertion,
  verifyCsrfToken,
} from "../src";

describe("admin security", () => {
  const assertionSecret = "assertion-secret-with-at-least-32-chars";
  const sessionSecret = "session-secret-with-at-least-32-chars";

  it("verifies signed identity assertions and derives provider-backed actors", () => {
    const signed = signAdminIdentityAssertion(
      {
        provider: "github_org",
        providerSubject: "12345",
        githubOrg: "octo-org",
        permissions: ["admin.inspect", "admin.settings.manage"],
        orgIds: ["org_1"],
      },
      assertionSecret,
      Date.now().toString(),
    );

    const actor = verifyAdminIdentityAssertion({
      assertionSecret,
      encodedAssertion: signed.encodedAssertion,
      expectedProvider: "github_org",
      requiredGithubOrg: "octo-org",
      signature: signed.signature,
      timestamp: signed.timestamp,
    });

    expect(actor).toMatchObject({
      actorType: "idp_user",
      actorUserId: "github_org:12345",
      role: "admin",
    });
    expect(actorCanAccessRepo(actor, "repo_1", "org_1")).toBe(true);
  });

  it("creates, reads, rotates, and clears secure sessions", () => {
    const manager = createAdminSessionManager({
      cookieName: "admin_session",
      maxAgeSeconds: 3600,
      secure: true,
      sessionSecret,
    });
    const created = manager.create({
      actorType: "idp_user",
      actorUserId: "oidc:usr_1",
      provider: "oidc",
      providerSubject: "usr_1",
      role: "support",
      permissions: ["admin.inspect"],
      orgIds: ["*"],
      repoIds: [],
    });
    const cookie = created.cookie.split(";")[0] ?? "";
    const read = manager.read(cookie);
    expect(read?.actor.actorUserId).toBe("oidc:usr_1");
    expect(read ? verifyCsrfToken(read, read.csrfToken) : false).toBe(true);

    const rotated = manager.rotate(created.session);
    expect(rotated.session.sessionId).toBe(created.session.sessionId);
    expect(rotated.session.csrfToken).not.toBe(created.session.csrfToken);
    expect(manager.clear()).toContain("Max-Age=0");
  });

  it("honors the configured session cookie SameSite policy", () => {
    const manager = createAdminSessionManager({
      cookieName: "admin_session",
      maxAgeSeconds: 3600,
      sameSite: "None",
      secure: true,
      sessionSecret,
    });

    const created = manager.create({
      actorType: "idp_user",
      actorUserId: "oidc:usr_1",
      provider: "oidc",
      providerSubject: "usr_1",
      role: "support",
      permissions: ["admin.inspect"],
      orgIds: ["*"],
      repoIds: [],
    });

    expect(created.cookie).toContain("SameSite=None");
    expect(manager.clear()).toContain("SameSite=None");
  });

  it("maps product roles to customer-facing permissions", () => {
    expect(isProductRole("owner")).toBe(true);
    expect(isProductRole("support")).toBe(false);
    expect(productRoleHasPermission("owner", "billing:manage")).toBe(true);
    expect(productRoleHasPermission("admin", "repo:settings:write")).toBe(true);
    expect(productRoleHasPermission("admin", "billing:manage")).toBe(false);
    expect(productRoleHasPermission("member", "review:read")).toBe(true);
    expect(productRoleHasPermission("viewer", "repo:settings:write")).toBe(false);
    expect(productPermissionsForRole("viewer")).toContain("usage:read");
  });

  it("authorizes product actors by organization membership", () => {
    const actor = {
      userId: "user_1",
      memberships: [
        { orgId: "org_owner", role: "owner" },
        { orgId: "org_viewer", role: "viewer" },
      ],
    } as const;

    expect(productActorHasOrgPermission(actor, "org_owner", "security:manage")).toBe(true);
    expect(productActorHasOrgPermission(actor, "org_viewer", "usage:read")).toBe(true);
    expect(productActorHasOrgPermission(actor, "org_viewer", "repo:settings:write")).toBe(false);
    expect(productActorHasRepoPermission(actor, "org_owner", "repo:reindex")).toBe(true);
    expect(productActorHasRepoPermission(actor, "org_missing", "repo:read")).toBe(false);
  });

  it("derives product capability flags from roles", () => {
    expect(productCapabilities("owner")).toMatchObject({
      canManageBilling: true,
      canManageMembers: true,
      canReadUsage: true,
    });
    expect(productCapabilities("viewer")).toMatchObject({
      canManageBilling: false,
      canManageMembers: false,
      canReadUsage: true,
    });
  });

  it("classifies artifacts conservatively", () => {
    expect(
      classifyArtifact({
        artifactType: "context_bundle",
        containsCode: true,
      }),
    ).toBe("customer_code");
    expect(
      classifyArtifact({
        artifactType: "prompt_artifact",
        containsPrompt: true,
        containsToken: true,
      }),
    ).toBe("secret");
    expect(
      classifyArtifact({
        artifactType: "user_profile",
        containsPersonalData: true,
      }),
    ).toBe("regulated_personal_data");
    expect(classifyArtifact({ artifactType: "repository_metadata" })).toBe("customer_confidential");
  });

  it("resolves retention decisions for sensitive artifact classes", () => {
    const createdAt = "2026-05-07T00:00:00.000Z";

    expect(retentionClassForArtifactType("raw_diff")).toBe("review_artifact");
    expect(
      resolveArtifactRetention({
        artifactType: "raw_diff",
        createdAt,
      }),
    ).toMatchObject({
      expiresAt: "2026-08-05T00:00:00.000Z",
      retentionClass: "review_artifact",
      storage: "allowed",
    });
    expect(
      resolveArtifactRetention({
        artifactType: "prompt_artifact",
        createdAt,
      }),
    ).toMatchObject({
      retentionClass: "review_artifact",
      storage: "disabled",
    });
    expect(
      resolveArtifactRetention({
        artifactType: "index_artifact",
        createdAt,
      }),
    ).toMatchObject({
      retentionClass: "index_lifetime",
      storage: "allowed",
    });
    expect(
      resolveArtifactRetention({
        artifactType: "prompt_artifact",
        createdAt,
        policy: {
          ...DEFAULT_RETENTION_POLICY,
          orgId: "org_custom",
          promptArtifactDays: 7,
        },
      }),
    ).toMatchObject({
      expiresAt: "2026-05-14T00:00:00.000Z",
      storage: "allowed",
    });
  });

  it("parses and formats secret references without secret values", () => {
    expect(parseSecretRef("GITHUB_WEBHOOK_SECRET")).toEqual({
      name: "GITHUB_WEBHOOK_SECRET",
      provider: "env",
    });
    expect(parseSecretRef("aws:prod/github-app/private-key#v2")).toEqual({
      name: "prod/github-app/private-key",
      provider: "aws_secrets_manager",
      version: "v2",
    });
    expect(formatSecretRef(parseSecretRef("gcp:prod/llm/openai"))).toBe(
      "gcp_secret_manager:prod/llm/openai",
    );
    expect(() => parseSecretRef("unknown:prod/key")).toThrow("provider unknown is not supported");
    expect(() => parseSecretRef("env:")).toThrow("Secret ref name must not be empty");
  });

  it("resolves local env secrets and redacts resolved values", async () => {
    const manager = createLocalEnvSecretsManager({
      env: {
        GITHUB_WEBHOOK_SECRET: "webhook-secret-value",
      },
      now: () => new Date("2026-05-07T12:00:00.000Z"),
    });

    const resolved = await manager.resolveSecret(parseSecretRef("env:GITHUB_WEBHOOK_SECRET"));

    expect(resolved).toEqual({
      ref: {
        name: "GITHUB_WEBHOOK_SECRET",
        provider: "env",
      },
      resolvedAt: "2026-05-07T12:00:00.000Z",
      value: "webhook-secret-value",
    });
    expect(redactResolvedSecret(resolved)).toEqual({
      ref: resolved.ref,
      resolvedAt: resolved.resolvedAt,
      value: "[redacted-secret]",
    });
    await expect(manager.resolveSecret(parseSecretRef("env:MISSING_SECRET"))).rejects.toMatchObject(
      {
        code: "secret_not_found",
      },
    );
    await expect(
      manager.resolveSecret(parseSecretRef("aws:prod/github-app/private-key")),
    ).rejects.toMatchObject({
      code: "secret_provider_unsupported",
    });
  });

  it("keeps production secret providers explicit until configured", async () => {
    const manager = createUnsupportedProductionSecretsManager("aws_secrets_manager");

    await expect(
      manager.resolveSecret(parseSecretRef("aws:prod/github-app/private-key")),
    ).rejects.toMatchObject({
      code: "secret_provider_unsupported",
    });
  });

  it("normalizes high-risk security events with safe metadata", () => {
    const event = createSecurityEvent({
      actorId: "user_1",
      createdAt: "2026-05-07T12:00:00.000Z",
      metadata: {
        count: 3,
        "debug.raw_diff": "+ const leaked = true;",
        "github.token": "ghp_1234567890abcdef",
        provider: "github",
        reason: "Authorization: Bearer github_pat_1234567890",
        "source.body": "export const leaked = true;",
      },
      orgId: "org_1",
      repoId: "repo_1",
      resourceId: "artifact_1",
      resourceType: "review_artifact",
      source: "api",
      type: "secret_detected_in_log_or_artifact",
    });

    expect(event).toMatchObject({
      actorId: "user_1",
      createdAt: "2026-05-07T12:00:00.000Z",
      metadata: {
        count: 3,
        provider: "github",
        reason: "Authorization: Bearer [redacted]",
      },
      severity: "critical",
      status: "new",
    });
    expect(JSON.stringify(event)).not.toContain("ghp_1234567890abcdef");
    expect(JSON.stringify(event)).not.toContain("github_pat_1234567890");
    expect(JSON.stringify(event)).not.toContain("export const leaked");
    expect(shouldAlertSecurityEvent(event)).toBe(true);
  });

  it("records security events through the sink boundary", () => {
    const sink = createMemorySecurityEventSink();
    const event = recordSecurityEvent(sink, {
      createdAt: "2026-05-07T12:05:00.000Z",
      metadata: { statusCode: 403 },
      source: "api",
      type: "cross_tenant_access_attempt",
    });

    expect(defaultSecurityEventSeverity("invalid_webhook_signature_spike")).toBe("high");
    expect(event.metadata).toMatchObject({ statusCode: 403 });
    expect(event.severity).toBe("critical");
    expect(sink.events()).toEqual([event]);
    sink.clear();
    expect(sink.events()).toEqual([]);
    expect(() =>
      recordSecurityEvent(createNoopSecurityEventSink(), {
        metadata: { statusCode: 403 },
        source: "api",
        type: "admin_auth_denied",
      }),
    ).not.toThrow();
  });
});
