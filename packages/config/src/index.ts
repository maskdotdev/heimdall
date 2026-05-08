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
    githubAppSlug: Type.Optional(Type.String({ minLength: 1 })),
    githubAppInstallUrl: Type.Optional(Type.String({ minLength: 1 })),
    apiPublicUrl: Type.Optional(Type.String({ minLength: 1 })),
    appAllowedOrigins: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
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

/** Indexer driver modes supported by worker runtime configuration. */
export const IndexerDriverNameSchema = Type.Union([
  Type.Literal("in_process_ts"),
  Type.Literal("cli"),
  Type.Literal("remote"),
  Type.Literal("fake"),
]);
export type IndexerDriverName = Static<typeof IndexerDriverNameSchema>;

/** Artifact upload modes supported by the indexer boundary. */
export const IndexerArtifactUploadModeSchema = Type.Union([
  Type.Literal("local_only"),
  Type.Literal("object_storage"),
]);
export type IndexerArtifactUploadMode = Static<typeof IndexerArtifactUploadModeSchema>;

/** Index artifact record validation modes used at the driver boundary. */
export const IndexerValidationRecordModeSchema = Type.Union([
  Type.Literal("full"),
  Type.Literal("manifest_only"),
  Type.Literal("sample"),
]);
export type IndexerValidationRecordMode = Static<typeof IndexerValidationRecordModeSchema>;

/** Remote indexer control API authentication modes. */
export const IndexerRemoteAuthModeSchema = Type.Union([
  Type.Literal("bearer"),
  Type.Literal("hmac"),
  Type.Literal("mtls"),
  Type.Literal("none"),
]);
export type IndexerRemoteAuthMode = Static<typeof IndexerRemoteAuthModeSchema>;

/** CLI indexer runtime configuration. */
export const IndexerCliConfigSchema = Type.Object(
  {
    envAllowlist: Type.Array(Type.String({ minLength: 1 })),
    executablePath: Type.Optional(Type.String({ minLength: 1 })),
    extraArgs: Type.Array(Type.String()),
    killGraceMs: Type.Integer({ minimum: 0 }),
    stderrMaxBytes: Type.Integer({ minimum: 1 }),
    stdoutMaxBytes: Type.Integer({ minimum: 1 }),
    workingDirectory: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type IndexerCliConfig = Static<typeof IndexerCliConfigSchema>;

/** Remote indexer control API configuration. */
export const IndexerRemoteConfigSchema = Type.Object(
  {
    authMode: IndexerRemoteAuthModeSchema,
    baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    bearerToken: Type.Optional(Type.String({ minLength: 1 })),
    maxPollMs: Type.Integer({ minimum: 1 }),
    pollIntervalMs: Type.Integer({ minimum: 1 }),
    timeoutMs: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type IndexerRemoteConfig = Static<typeof IndexerRemoteConfigSchema>;

/** Runtime configuration for the indexer boundary and selected driver. */
export const IndexerConfigSchema = Type.Object(
  {
    artifactRootPath: Type.String({ minLength: 1 }),
    artifactUploadMode: IndexerArtifactUploadModeSchema,
    cli: IndexerCliConfigSchema,
    defaultTimeoutMs: Type.Integer({ minimum: 1 }),
    driver: IndexerDriverNameSchema,
    maxTimeoutMs: Type.Integer({ minimum: 1 }),
    remote: IndexerRemoteConfigSchema,
    validateArtifacts: Type.Boolean(),
    validateRecordMode: IndexerValidationRecordModeSchema,
    validationSampleSize: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type IndexerConfig = Static<typeof IndexerConfigSchema>;

/** Defaults accepted while loading indexer configuration in apps. */
export type LoadIndexerConfigOptions = {
  /** Default artifact root when no indexer artifact-root environment variable is set. */
  readonly defaultArtifactRootPath?: string;
  /** Default timeout when no indexer timeout environment variable is set. */
  readonly defaultTimeoutMs?: number;
};

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
    githubAppSlug: emptyToUndefined(env.HEIMDALL_GITHUB_APP_SLUG),
    githubAppInstallUrl: emptyToUndefined(env.HEIMDALL_GITHUB_APP_INSTALL_URL),
    apiPublicUrl: emptyToUndefined(env.HEIMDALL_API_PUBLIC_URL),
    appAllowedOrigins: parseStringList(env.HEIMDALL_APP_ALLOWED_ORIGINS),
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

/** Converts environment variables into the canonical indexer runtime config object. */
export function loadIndexerConfig(
  env: EnvironmentRecord = getProcessEnvironment(),
  options: LoadIndexerConfigOptions = {},
): IndexerConfig {
  const issues: string[] = [];
  const driver = parseIndexerDriverName(env.INDEXER_DRIVER, issues);
  const defaultTimeoutMs =
    parsePositiveIntegerEnv(
      firstEnvValue(env, ["INDEXER_DEFAULT_TIMEOUT_MS", "INDEXER_TIMEOUT_MS"]),
      "INDEXER_DEFAULT_TIMEOUT_MS",
      issues,
    ) ??
    options.defaultTimeoutMs ??
    120_000;
  const maxTimeoutMs =
    parsePositiveIntegerEnv(env.INDEXER_MAX_TIMEOUT_MS, "INDEXER_MAX_TIMEOUT_MS", issues) ??
    Math.max(defaultTimeoutMs, 600_000);
  const cliExecutablePath = firstEnvValue(env, [
    "INDEXER_CLI_EXECUTABLE_PATH",
    "INDEXER_CLI_COMMAND",
  ]);
  const remoteBearerToken = emptyToUndefined(env.INDEXER_REMOTE_BEARER_TOKEN);
  const config = {
    artifactRootPath:
      firstEnvValue(env, ["INDEXER_ARTIFACT_ROOT_PATH", "INDEX_ARTIFACT_ROOT"]) ??
      options.defaultArtifactRootPath ??
      ".heimdall/index-artifacts",
    artifactUploadMode: emptyToUndefined(env.INDEXER_ARTIFACT_UPLOAD_MODE) ?? "local_only",
    cli: {
      envAllowlist: parseStringList(env.INDEXER_CLI_ENV_ALLOWLIST) ?? [
        "PATH",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "NO_COLOR",
      ],
      ...(cliExecutablePath ? { executablePath: cliExecutablePath } : {}),
      extraArgs: parseJsonStringArrayEnv(
        env.INDEXER_CLI_ARGS_JSON,
        "INDEXER_CLI_ARGS_JSON",
        issues,
      ),
      killGraceMs:
        parseNonNegativeIntegerEnv(
          env.INDEXER_CLI_KILL_GRACE_MS,
          "INDEXER_CLI_KILL_GRACE_MS",
          issues,
        ) ?? 1_000,
      stderrMaxBytes:
        parsePositiveIntegerEnv(
          env.INDEXER_CLI_STDERR_MAX_BYTES,
          "INDEXER_CLI_STDERR_MAX_BYTES",
          issues,
        ) ?? 64 * 1024,
      stdoutMaxBytes:
        parsePositiveIntegerEnv(
          env.INDEXER_CLI_STDOUT_MAX_BYTES,
          "INDEXER_CLI_STDOUT_MAX_BYTES",
          issues,
        ) ?? 64 * 1024,
      ...(emptyToUndefined(env.INDEXER_CLI_WORKING_DIRECTORY)
        ? { workingDirectory: emptyToUndefined(env.INDEXER_CLI_WORKING_DIRECTORY) }
        : {}),
    },
    defaultTimeoutMs,
    driver,
    maxTimeoutMs,
    remote: {
      authMode:
        emptyToUndefined(env.INDEXER_REMOTE_AUTH_MODE) ?? (remoteBearerToken ? "bearer" : "none"),
      ...(remoteBearerToken ? { bearerToken: remoteBearerToken } : {}),
      ...(emptyToUndefined(env.INDEXER_REMOTE_BASE_URL)
        ? { baseUrl: emptyToUndefined(env.INDEXER_REMOTE_BASE_URL) }
        : {}),
      maxPollMs:
        parsePositiveIntegerEnv(
          env.INDEXER_REMOTE_MAX_POLL_MS,
          "INDEXER_REMOTE_MAX_POLL_MS",
          issues,
        ) ?? defaultTimeoutMs,
      pollIntervalMs:
        parsePositiveIntegerEnv(
          env.INDEXER_REMOTE_POLL_INTERVAL_MS,
          "INDEXER_REMOTE_POLL_INTERVAL_MS",
          issues,
        ) ?? 1_000,
      timeoutMs:
        parsePositiveIntegerEnv(
          env.INDEXER_REMOTE_TIMEOUT_MS,
          "INDEXER_REMOTE_TIMEOUT_MS",
          issues,
        ) ?? defaultTimeoutMs,
    },
    validateArtifacts: parseBooleanEnv(env.INDEXER_VALIDATE_ARTIFACTS, true, issues),
    validateRecordMode: emptyToUndefined(env.INDEXER_VALIDATE_RECORD_MODE) ?? "full",
    validationSampleSize:
      parsePositiveIntegerEnv(
        env.INDEXER_VALIDATION_SAMPLE_SIZE,
        "INDEXER_VALIDATION_SAMPLE_SIZE",
        issues,
      ) ?? 1_000,
  };

  if (Value.Check(IndexerConfigSchema, config)) {
    const validationIssues = validateIndexerConfig(config);
    const allIssues = [...issues, ...validationIssues];
    if (allIssues.length === 0) {
      return config;
    }

    throw new ConfigValidationError(allIssues);
  }

  const schemaIssues = [...Value.Errors(IndexerConfigSchema, config)].map((issue) => {
    const path = issue.path === "" ? "indexerConfig" : issue.path;
    return `${path} ${issue.message}`;
  });

  throw new ConfigValidationError([...issues, ...schemaIssues]);
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

/** Returns the first configured non-empty environment value from an ordered list. */
function firstEnvValue(env: EnvironmentRecord, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = emptyToUndefined(env[name]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

/** Parses the indexer driver name and normalizes legacy aliases. */
function parseIndexerDriverName(value: string | undefined, issues: string[]): IndexerDriverName {
  const driver = emptyToUndefined(value) ?? "in_process_ts";
  if (driver === "typescript") {
    return "in_process_ts";
  }
  if (driver === "in_process_ts" || driver === "cli" || driver === "remote" || driver === "fake") {
    return driver;
  }

  issues.push(`Unsupported INDEXER_DRIVER: ${driver}`);
  return "in_process_ts";
}

/** Parses a boolean environment value with a default. */
function parseBooleanEnv(
  value: string | undefined,
  defaultValue: boolean,
  issues: string[],
): boolean {
  const normalized = emptyToUndefined(value);
  if (!normalized) {
    return defaultValue;
  }
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  issues.push(`Expected boolean environment value, got: ${normalized}`);
  return defaultValue;
}

/** Parses a positive integer environment value. */
function parsePositiveIntegerEnv(
  value: string | undefined,
  name: string,
  issues: string[],
): number | undefined {
  const normalized = emptyToUndefined(value);
  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (Number.isFinite(parsed) && parsed > 0 && String(parsed) === normalized) {
    return parsed;
  }

  issues.push(`${name} must be a positive integer`);
  return undefined;
}

/** Parses a non-negative integer environment value. */
function parseNonNegativeIntegerEnv(
  value: string | undefined,
  name: string,
  issues: string[],
): number | undefined {
  const normalized = emptyToUndefined(value);
  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (Number.isFinite(parsed) && parsed >= 0 && String(parsed) === normalized) {
    return parsed;
  }

  issues.push(`${name} must be a non-negative integer`);
  return undefined;
}

/** Parses a JSON string-array environment value. */
function parseJsonStringArrayEnv(
  value: string | undefined,
  name: string,
  issues: string[],
): readonly string[] {
  const normalized = emptyToUndefined(value);
  if (!normalized) {
    return [];
  }

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return parsed;
    }
  } catch {
    // Report the normalized validation issue below.
  }

  issues.push(`${name} must be a JSON array of strings`);
  return [];
}

/** Validates cross-field indexer configuration requirements. */
function validateIndexerConfig(config: IndexerConfig): readonly string[] {
  const issues: string[] = [];
  if (config.defaultTimeoutMs > config.maxTimeoutMs) {
    issues.push("INDEXER_DEFAULT_TIMEOUT_MS must be less than or equal to INDEXER_MAX_TIMEOUT_MS");
  }
  if (config.driver === "cli" && !config.cli.executablePath) {
    issues.push(
      "INDEXER_CLI_EXECUTABLE_PATH or INDEXER_CLI_COMMAND is required when INDEXER_DRIVER=cli.",
    );
  }
  if (config.driver === "remote" && !config.remote.baseUrl) {
    issues.push("INDEXER_REMOTE_BASE_URL is required when INDEXER_DRIVER=remote.");
  }
  if (config.remote.authMode === "bearer" && !config.remote.bearerToken) {
    issues.push("INDEXER_REMOTE_BEARER_TOKEN is required when INDEXER_REMOTE_AUTH_MODE=bearer.");
  }

  return issues;
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
