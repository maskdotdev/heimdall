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
      }),
    ).toMatchObject({
      nodeEnv: "production",
      logLevel: "warn",
      githubAppId: "123",
      githubWebhookSecret: "secret",
      objectStorageBucket: "heimdall-artifacts",
    });
  });

  it("rejects missing required values", () => {
    expect(() => loadRuntimeConfig({ REDIS_URL: "redis://localhost:6379" })).toThrow(
      ConfigValidationError,
    );
  });
});
