import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Deployment environment names supported by Heimdall. */
export const AppEnvironmentSchema = Type.Union([
  Type.Literal("development"),
  Type.Literal("test"),
  Type.Literal("production"),
]);
export type AppEnvironment = Static<typeof AppEnvironmentSchema>;

/** Admin control-plane route exposure modes. */
export const AdminRouteExposureSchema = Type.Union([
  Type.Literal("disabled"),
  Type.Literal("internal"),
  Type.Literal("public"),
]);
export type AdminRouteExposure = Static<typeof AdminRouteExposureSchema>;

/** Admin identity provider modes. */
export const AdminIdentityProviderSchema = Type.Union([
  Type.Literal("oidc"),
  Type.Literal("saml"),
  Type.Literal("github_org"),
]);
export type AdminIdentityProvider = Static<typeof AdminIdentityProviderSchema>;

/** Runtime configuration shared by apps and infrastructure packages. */
export const RuntimeConfigSchema = Type.Object(
  {
    nodeEnv: AppEnvironmentSchema,
    databaseUrl: Type.String({ minLength: 1 }),
    redisUrl: Type.String({ minLength: 1 }),
    logLevel: Type.Union([
      Type.Literal("trace"),
      Type.Literal("debug"),
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("error"),
      Type.Literal("fatal"),
    ]),
    githubAppId: Type.Optional(Type.String({ minLength: 1 })),
    githubWebhookSecret: Type.Optional(Type.String({ minLength: 1 })),
    objectStorageBucket: Type.Optional(Type.String({ minLength: 1 })),
    adminEnabled: Type.Boolean(),
    adminRouteExposure: Type.Optional(AdminRouteExposureSchema),
    adminIdentityProvider: Type.Optional(AdminIdentityProviderSchema),
    adminIdentityAssertionSecret: Type.Optional(Type.String({ minLength: 32 })),
    adminSessionSecret: Type.Optional(Type.String({ minLength: 32 })),
    adminAllowedOrigins: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    adminInternalHeaderName: Type.Optional(Type.String({ minLength: 1 })),
    adminInternalHeaderValue: Type.Optional(Type.String({ minLength: 1 })),
    adminGithubOrg: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type RuntimeConfig = Static<typeof RuntimeConfigSchema>;

/** Input map used when loading configuration from process environments. */
export type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

/** Error raised when environment variables do not satisfy the runtime contract. */
export class ConfigValidationError extends Error {
  /** Validation issues returned by TypeBox. */
  public readonly issues: readonly string[];

  /** Creates a configuration validation error. */
  public constructor(issues: readonly string[]) {
    super(`Invalid runtime configuration: ${issues.join("; ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/** Returns the ambient process environment when running on Node.js or Bun. */
export function getProcessEnvironment(): EnvironmentRecord {
  const runtimeGlobal = globalThis as typeof globalThis & {
    readonly process?: { readonly env?: EnvironmentRecord };
  };

  return runtimeGlobal.process?.env ?? {};
}

/** Converts environment variables into the canonical runtime config object. */
export function loadRuntimeConfig(env: EnvironmentRecord = getProcessEnvironment()): RuntimeConfig {
  const config = {
    nodeEnv: env.NODE_ENV ?? "development",
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    logLevel: env.LOG_LEVEL ?? "info",
    githubAppId: env.GITHUB_APP_ID,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
    objectStorageBucket: env.OBJECT_STORAGE_BUCKET,
    adminEnabled: env.HEIMDALL_ADMIN_ENABLED === "true",
    adminRouteExposure: emptyToUndefined(env.HEIMDALL_ADMIN_ROUTE_EXPOSURE),
    adminIdentityProvider: emptyToUndefined(env.HEIMDALL_ADMIN_IDENTITY_PROVIDER),
    adminIdentityAssertionSecret: emptyToUndefined(env.HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET),
    adminSessionSecret: emptyToUndefined(env.HEIMDALL_ADMIN_SESSION_SECRET),
    adminAllowedOrigins: parseStringList(env.HEIMDALL_ADMIN_ALLOWED_ORIGINS),
    adminInternalHeaderName: emptyToUndefined(env.HEIMDALL_ADMIN_INTERNAL_HEADER_NAME),
    adminInternalHeaderValue: emptyToUndefined(env.HEIMDALL_ADMIN_INTERNAL_HEADER_VALUE),
    adminGithubOrg: emptyToUndefined(env.HEIMDALL_ADMIN_GITHUB_ORG),
  };

  const cleaned = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined && value !== ""),
  );

  if (Value.Check(RuntimeConfigSchema, cleaned)) {
    const adminIssues = validateAdminConfig(cleaned);
    if (adminIssues.length === 0) {
      return cleaned;
    }

    throw new ConfigValidationError(adminIssues);
  }

  const issues = [...Value.Errors(RuntimeConfigSchema, cleaned)].map((issue) => {
    const path = issue.path === "" ? "config" : issue.path;
    return `${path} ${issue.message}`;
  });

  throw new ConfigValidationError(issues);
}

/** Converts blank environment values to undefined. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

/** Parses a comma-separated string list from an environment variable. */
function parseStringList(value: string | undefined): readonly string[] | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Validates fail-closed admin control-plane configuration. */
function validateAdminConfig(config: RuntimeConfig): readonly string[] {
  if (!config.adminEnabled) {
    return [];
  }

  const issues: string[] = [];
  if (!config.adminRouteExposure || config.adminRouteExposure === "disabled") {
    issues.push("HEIMDALL_ADMIN_ROUTE_EXPOSURE must be internal or public when admin is enabled");
  }
  if (!config.adminIdentityProvider) {
    issues.push("HEIMDALL_ADMIN_IDENTITY_PROVIDER is required when admin is enabled");
  }
  if (!config.adminIdentityAssertionSecret) {
    issues.push("HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET is required when admin is enabled");
  }
  if (!config.adminSessionSecret) {
    issues.push("HEIMDALL_ADMIN_SESSION_SECRET is required when admin is enabled");
  }
  if (
    config.adminRouteExposure === "internal" &&
    (!config.adminInternalHeaderName || !config.adminInternalHeaderValue)
  ) {
    issues.push(
      "Internal admin exposure requires HEIMDALL_ADMIN_INTERNAL_HEADER_NAME and HEIMDALL_ADMIN_INTERNAL_HEADER_VALUE",
    );
  }
  if (config.adminIdentityProvider === "github_org" && !config.adminGithubOrg) {
    issues.push("HEIMDALL_ADMIN_GITHUB_ORG is required for github_org admin auth");
  }
  if (config.nodeEnv === "production" && !config.adminAllowedOrigins?.length) {
    issues.push("Production admin CORS requires HEIMDALL_ADMIN_ALLOWED_ORIGINS");
  }

  return issues;
}
