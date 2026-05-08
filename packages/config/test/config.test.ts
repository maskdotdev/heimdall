import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadIndexerConfig, loadRuntimeConfig } from "../src";

describe("runtime config", () => {
  it("parses required environment variables and applies defaults", () => {
    expect(
      loadRuntimeConfig({
        DATABASE_URL: "postgres://postgres:postgres@localhost:5432/heimdall",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toEqual({
      nodeEnv: "development",
      databaseUrl: "postgres://postgres:postgres@localhost:5432/heimdall",
      redisUrl: "redis://localhost:6379",
      logLevel: "info",
      adminEnabled: false,
    });
  });

  it("keeps optional provider configuration when present", () => {
    expect(
      loadRuntimeConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://postgres:postgres@localhost:5432/heimdall",
        REDIS_URL: "redis://localhost:6379",
        LOG_LEVEL: "warn",
        GITHUB_APP_ID: "123",
        GITHUB_WEBHOOK_SECRET: "secret",
        OBJECT_STORAGE_BUCKET: "heimdall-artifacts",
        HEIMDALL_ADMIN_ENABLED: "true",
        HEIMDALL_ADMIN_ROUTE_EXPOSURE: "public",
        HEIMDALL_ADMIN_IDENTITY_PROVIDER: "oidc",
        HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET: "assertion-secret-with-at-least-32-chars",
        HEIMDALL_ADMIN_SESSION_SECRET: "session-secret-with-at-least-32-chars",
        HEIMDALL_ADMIN_ALLOWED_ORIGINS: "https://admin.example.com",
      }),
    ).toMatchObject({
      nodeEnv: "production",
      logLevel: "warn",
      githubAppId: "123",
      githubWebhookSecret: "secret",
      objectStorageBucket: "heimdall-artifacts",
      adminEnabled: true,
      adminRouteExposure: "public",
      adminIdentityProvider: "oidc",
      adminAllowedOrigins: ["https://admin.example.com"],
    });
  });

  it("fails closed when admin routes are enabled without provider configuration", () => {
    expect(() =>
      loadRuntimeConfig({
        DATABASE_URL: "postgres://postgres:postgres@localhost:5432/heimdall",
        REDIS_URL: "redis://localhost:6379",
        HEIMDALL_ADMIN_ENABLED: "true",
      }),
    ).toThrow(ConfigValidationError);
  });

  it("rejects missing required values", () => {
    expect(() => loadRuntimeConfig({ REDIS_URL: "redis://localhost:6379" })).toThrow(
      ConfigValidationError,
    );
  });
});

describe("indexer config", () => {
  it("applies local development defaults", () => {
    expect(loadIndexerConfig()).toEqual({
      artifactRootPath: ".heimdall/index-artifacts",
      artifactUploadMode: "local_only",
      cli: {
        envAllowlist: ["PATH", "LANG", "LC_ALL", "TMPDIR", "NO_COLOR"],
        extraArgs: [],
        killGraceMs: 1000,
        stderrMaxBytes: 65536,
        stdoutMaxBytes: 65536,
      },
      defaultTimeoutMs: 120000,
      driver: "in_process_ts",
      maxTimeoutMs: 600000,
      remote: {
        authMode: "none",
        maxPollMs: 120000,
        pollIntervalMs: 1000,
        timeoutMs: 120000,
      },
      validateArtifacts: true,
      validateRecordMode: "full",
      validationSampleSize: 1000,
    });
  });

  it("parses CLI and remote indexer environment values", () => {
    expect(
      loadIndexerConfig({
        INDEXER_ARTIFACT_ROOT_PATH: "/var/lib/heimdall/index-artifacts",
        INDEXER_ARTIFACT_UPLOAD_MODE: "object_storage",
        INDEXER_CLI_ARGS_JSON: JSON.stringify(["--profile", "ci"]),
        INDEXER_CLI_ENV_ALLOWLIST: "PATH,LANG",
        INDEXER_CLI_EXECUTABLE_PATH: "/usr/local/bin/indexer",
        INDEXER_CLI_KILL_GRACE_MS: "2500",
        INDEXER_CLI_STDERR_MAX_BYTES: "131072",
        INDEXER_CLI_STDOUT_MAX_BYTES: "262144",
        INDEXER_DEFAULT_TIMEOUT_MS: "180000",
        INDEXER_DRIVER: "cli",
        INDEXER_MAX_TIMEOUT_MS: "600000",
        INDEXER_REMOTE_BASE_URL: "https://indexer.example",
        INDEXER_REMOTE_BEARER_TOKEN: "remote-token",
        INDEXER_REMOTE_MAX_POLL_MS: "240000",
        INDEXER_REMOTE_POLL_INTERVAL_MS: "500",
        INDEXER_VALIDATE_ARTIFACTS: "false",
        INDEXER_VALIDATE_RECORD_MODE: "sample",
        INDEXER_VALIDATION_SAMPLE_SIZE: "250",
      }),
    ).toMatchObject({
      artifactRootPath: "/var/lib/heimdall/index-artifacts",
      artifactUploadMode: "object_storage",
      cli: {
        envAllowlist: ["PATH", "LANG"],
        executablePath: "/usr/local/bin/indexer",
        extraArgs: ["--profile", "ci"],
        killGraceMs: 2500,
        stderrMaxBytes: 131072,
        stdoutMaxBytes: 262144,
      },
      defaultTimeoutMs: 180000,
      driver: "cli",
      maxTimeoutMs: 600000,
      remote: {
        authMode: "bearer",
        baseUrl: "https://indexer.example",
        bearerToken: "remote-token",
        maxPollMs: 240000,
        pollIntervalMs: 500,
      },
      validateArtifacts: false,
      validateRecordMode: "sample",
      validationSampleSize: 250,
    });
  });

  it("keeps legacy indexer environment aliases", () => {
    expect(
      loadIndexerConfig({
        INDEX_ARTIFACT_ROOT: "/tmp/index-artifacts",
        INDEXER_CLI_COMMAND: "node",
        INDEXER_DRIVER: "cli",
        INDEXER_TIMEOUT_MS: "90000",
      }),
    ).toMatchObject({
      artifactRootPath: "/tmp/index-artifacts",
      cli: {
        executablePath: "node",
      },
      defaultTimeoutMs: 90000,
      driver: "cli",
    });
  });

  it("validates selected driver requirements", () => {
    expect(() => loadIndexerConfig({ INDEXER_DRIVER: "cli" })).toThrow(ConfigValidationError);
    expect(() => loadIndexerConfig({ INDEXER_DRIVER: "remote" })).toThrow(ConfigValidationError);
    expect(() => loadIndexerConfig({ INDEXER_DRIVER: "bogus" })).toThrow(ConfigValidationError);
  });

  it("rejects malformed numeric and JSON values", () => {
    expect(() =>
      loadIndexerConfig({
        INDEXER_CLI_ARGS_JSON: '{"not":"array"}',
        INDEXER_DEFAULT_TIMEOUT_MS: "0",
      }),
    ).toThrow(ConfigValidationError);
  });
});
