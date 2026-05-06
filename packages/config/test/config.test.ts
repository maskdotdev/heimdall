import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadRuntimeConfig } from "../src";

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
