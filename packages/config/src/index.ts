import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Deployment environment names supported by Heimdall. */
export const AppEnvironmentSchema = Type.Union([
  Type.Literal("development"),
  Type.Literal("test"),
  Type.Literal("production"),
]);
export type AppEnvironment = Static<typeof AppEnvironmentSchema>;

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
  };

  const cleaned = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined && value !== ""),
  );

  if (Value.Check(RuntimeConfigSchema, cleaned)) {
    return cleaned;
  }

  const issues = [...Value.Errors(RuntimeConfigSchema, cleaned)].map((issue) => {
    const path = issue.path === "" ? "config" : issue.path;
    return `${path} ${issue.message}`;
  });

  throw new ConfigValidationError(issues);
}
