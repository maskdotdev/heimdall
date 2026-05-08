import { describe, expect, it } from "vitest";
import {
  type AwsSecretsManagerFetch,
  actorCanAccessRepo,
  COMPLIANCE_CONTROL_IDS,
  COMPLIANCE_EVIDENCE_TYPES,
  classifyArtifact,
  createAdminSessionManager,
  createAwsSecretsManager,
  createComplianceEvidenceDescriptor,
  createLocalEnvSecretsManager,
  createMemorySecurityEventSink,
  createNoopSecurityEventSink,
  createSecretsManagerFromEnvironment,
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
  redactPromptSecrets,
  redactResolvedSecret,
  redactString,
  resolveArtifactRetention,
  retentionClassForArtifactType,
  sanitizeComplianceEvidenceMetadata,
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
    expect(productRoleHasPermission("admin", "org:manage")).toBe(true);
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
      canManageOrgSettings: true,
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

  it("resolves AWS Secrets Manager string secrets with signed requests", async () => {
    let requestedUrl: string | undefined;
    let requestedInit: Parameters<AwsSecretsManagerFetch>[1] | undefined;
    const fetch: AwsSecretsManagerFetch = async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            SecretString: "aws-secret-value",
            VersionId: "version-1",
          }),
      };
    };
    const manager = createAwsSecretsManager({
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "secret-access-key",
        sessionToken: "session-token",
      },
      fetch,
      now: () => new Date("2026-05-08T14:15:16.000Z"),
      region: "us-east-1",
    });

    const resolved = await manager.resolveSecret(parseSecretRef("aws:prod/github-app/private-key"));

    expect(resolved).toEqual({
      ref: {
        name: "prod/github-app/private-key",
        provider: "aws_secrets_manager",
      },
      resolvedAt: "2026-05-08T14:15:16.000Z",
      value: "aws-secret-value",
      version: "version-1",
    });
    if (!requestedInit) {
      throw new Error("Expected AWS Secrets Manager request.");
    }
    expect(requestedUrl).toBe("https://secretsmanager.us-east-1.amazonaws.com/");
    expect(JSON.parse(requestedInit.body)).toEqual({
      SecretId: "prod/github-app/private-key",
    });
    expect(requestedInit.headers["x-amz-date"]).toBe("20260508T141516Z");
    expect(requestedInit.headers["x-amz-target"]).toBe("secretsmanager.GetSecretValue");
    expect(requestedInit.headers["x-amz-security-token"]).toBe("session-token");
    expect(requestedInit.headers.authorization).toContain(
      "Credential=AKIDEXAMPLE/20260508/us-east-1/secretsmanager/aws4_request",
    );
    expect(requestedInit.headers.authorization).toContain(
      "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target",
    );
    expect(requestedInit.headers.authorization).toContain("Signature=");
  });

  it("maps AWS Secrets Manager provider failures to product-safe resolution errors", async () => {
    const fetchNotFound: AwsSecretsManagerFetch = async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "secret not found",
        }),
    });
    const notFoundManager = createAwsSecretsManager({
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "secret-access-key",
      },
      fetch: fetchNotFound,
      now: () => new Date("2026-05-08T14:15:16.000Z"),
      region: "us-east-1",
    });

    await expect(
      notFoundManager.resolveSecret(parseSecretRef("aws:prod/missing")),
    ).rejects.toMatchObject({
      code: "secret_not_found",
    });

    const fetchDenied: AwsSecretsManagerFetch = async () => ({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          __type: "com.amazonaws.secretsmanager#AccessDeniedException",
          message: "access denied",
        }),
    });
    const deniedManager = createAwsSecretsManager({
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "secret-access-key",
      },
      fetch: fetchDenied,
      now: () => new Date("2026-05-08T14:15:16.000Z"),
      region: "us-east-1",
    });

    await expect(
      deniedManager.resolveSecret(parseSecretRef("aws:prod/denied")),
    ).rejects.toMatchObject({
      code: "secret_provider_error",
    });
  });

  it("routes environment and AWS secret refs from runtime environment configuration", async () => {
    const fetch: AwsSecretsManagerFetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          SecretBinary: Buffer.from("aws-binary-secret", "utf8").toString("base64"),
          VersionId: "binary-version",
        }),
    });
    const manager = createSecretsManagerFromEnvironment({
      env: {
        AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
        AWS_REGION: "us-east-1",
        AWS_SECRET_ACCESS_KEY: "secret-access-key",
        LOCAL_SECRET: "local-secret",
      },
      fetch,
      now: () => new Date("2026-05-08T14:15:16.000Z"),
    });

    await expect(manager.resolveSecret(parseSecretRef("env:LOCAL_SECRET"))).resolves.toMatchObject({
      value: "local-secret",
    });
    await expect(
      manager.resolveSecret(parseSecretRef("aws:prod/binary-secret")),
    ).resolves.toMatchObject({
      value: "aws-binary-secret",
      version: "binary-version",
    });

    const envOnlyManager = createSecretsManagerFromEnvironment({
      env: {
        LOCAL_SECRET: "local-secret",
      },
      fetch,
    });
    await expect(
      envOnlyManager.resolveSecret(parseSecretRef("aws:prod/missing-config")),
    ).rejects.toMatchObject({
      code: "secret_provider_unsupported",
    });
  });

  it("redacts secret patterns before prompt and log use", () => {
    const prompt = [
      'const token = "github_pat_1234567890abcdef1234567890abcdef";',
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "DATABASE_URL=postgres://user:password@example.test/db",
      "-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----",
    ].join("\n");

    const redacted = redactPromptSecrets(prompt);

    expect(redacted.redacted).toBe(true);
    expect(redacted.matchKinds).toEqual(
      expect.arrayContaining(["credential_url", "github_token", "openai_api_key", "private_key"]),
    );
    expect(redacted.value).toContain("[redacted-github-token]");
    expect(redacted.value).toContain("[redacted-llm-api-key]");
    expect(redacted.value).toContain("[redacted-private-key]");
    expect(redacted.value).not.toContain("github_pat_1234567890abcdef");
    expect(redacted.value).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted.value).not.toContain("user:password@example.test");

    expect(
      redactString("literal secret-value-123", {
        additionalSecrets: ["secret-value-123"],
      }),
    ).toMatchObject({
      matchKinds: ["literal_secret"],
      value: "literal [redacted]",
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

  it("creates product-safe compliance evidence descriptors with stable controls", () => {
    expect(COMPLIANCE_CONTROL_IDS).toEqual([
      "soc2.cc6.1.access_review",
      "soc2.cc7.2.audit_logging",
      "soc2.cc8.1.change_management",
      "gdpr.art15.data_export",
      "gdpr.art17.data_deletion",
      "nist.ssdf.po.5.security_events",
    ]);
    expect(COMPLIANCE_EVIDENCE_TYPES).toContain("audit_log_export");

    const descriptor = createComplianceEvidenceDescriptor({
      collectedAt: "2026-05-08T14:00:00.000Z",
      collectedBy: "ci:compliance-evidence",
      controlId: "soc2.cc7.2.audit_logging",
      evidenceHash: "sha256:abc123",
      evidenceType: "audit_log_export",
      evidenceUri: "s3://heimdall-evidence/org_1/audit-log-export.jsonl",
      id: "cmpev_audit_export",
      metadata: {
        "debug.raw_diff": "+ const leaked = true;",
        exportedRows: 2,
        note: "Authorization: Bearer ghp_1234567890",
        "provider.token": "ghp_1234567890",
      },
      orgId: "org_1",
      source: "ci",
      summary: {
        actorCount: 1,
        "source.body": "export const leaked = true;",
      },
    });

    expect(descriptor).toEqual({
      collectedAt: "2026-05-08T14:00:00.000Z",
      collectedBy: "ci:compliance-evidence",
      controlId: "soc2.cc7.2.audit_logging",
      evidenceHash: "sha256:abc123",
      evidenceType: "audit_log_export",
      evidenceUri: "s3://heimdall-evidence/org_1/audit-log-export.jsonl",
      id: "cmpev_audit_export",
      metadata: {
        exportedRows: 2,
        note: "Authorization: Bearer [redacted]",
      },
      orgId: "org_1",
      source: "ci",
      status: "collected",
      summary: {
        actorCount: 1,
      },
    });
    expect(JSON.stringify(descriptor)).not.toContain("ghp_1234567890");
    expect(JSON.stringify(descriptor)).not.toContain("export const leaked");
    expect(
      sanitizeComplianceEvidenceMetadata({
        path: "docs/evidence/security.json",
        secret: "should not persist",
        total: 1,
      }),
    ).toEqual({ path: "docs/evidence/security.json", total: 1 });
  });
});
