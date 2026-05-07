import { type EnvironmentRecord, getProcessEnvironment } from "@repo/config";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Scalar attribute values allowed in structured telemetry events. */
export const TelemetryAttributeValueSchema = Type.Union([
  Type.Boolean(),
  Type.Number(),
  Type.String(),
]);

/** Runtime environment names used for observability resources. */
export const ObservabilityEnvironmentSchema = Type.Union([
  Type.Literal("local"),
  Type.Literal("development"),
  Type.Literal("staging"),
  Type.Literal("production"),
]);

/** Observability exporter mode. */
export const ObservabilityExporterSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("console"),
  Type.Literal("otlp"),
]);

/** Observability log level. */
export const ObservabilityLogLevelSchema = Type.Union([
  Type.Literal("debug"),
  Type.Literal("info"),
  Type.Literal("warn"),
  Type.Literal("error"),
]);

/** Observability redaction policy. */
export const ObservabilityRedactionConfigSchema = Type.Object(
  {
    captureCodeSnippets: Type.Boolean(),
    capturePrompts: Type.Boolean(),
    includeDebugAttributes: Type.Boolean(),
    logRawErrors: Type.Boolean(),
    strict: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Observability runtime configuration. */
export const ObservabilityConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    environment: ObservabilityEnvironmentSchema,
    exporter: ObservabilityExporterSchema,
    logLevel: ObservabilityLogLevelSchema,
    metricsIntervalMs: Type.Integer({ minimum: 1 }),
    otlpEndpoint: Type.Optional(Type.String({ minLength: 1 })),
    redaction: ObservabilityRedactionConfigSchema,
    serviceName: Type.String({ minLength: 1 }),
    traceErrorSampleRate: Type.Number({ minimum: 0, maximum: 1 }),
    traceSampleRate: Type.Number({ minimum: 0, maximum: 1 }),
    traceSlowJobSampleRate: Type.Number({ minimum: 0, maximum: 1 }),
    version: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Admin control-plane telemetry event names emitted by production services. */
export const AdminControlPlaneTelemetryEventNameSchema = Type.Union([
  Type.Literal("admin.access.denied"),
  Type.Literal("admin.action.completed"),
  Type.Literal("admin.auth.success"),
  Type.Literal("admin.billing.checkout_session.created"),
  Type.Literal("admin.billing.portal_session.created"),
  Type.Literal("admin.debug_bundle.exported"),
  Type.Literal("admin.eval_import.draft_created"),
  Type.Literal("admin.memory_rules.inspected"),
  Type.Literal("admin.replay.dispatched"),
  Type.Literal("admin.rule.created"),
  Type.Literal("admin.rule.deleted"),
  Type.Literal("admin.rule.updated"),
  Type.Literal("admin.session.revoked"),
  Type.Literal("admin.settings.updated"),
]);

/** Structured admin control-plane telemetry event. */
export const AdminControlPlaneTelemetryEventSchema = Type.Object(
  {
    actorUserId: Type.Optional(Type.String({ minLength: 1 })),
    attributes: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), TelemetryAttributeValueSchema),
    ),
    name: AdminControlPlaneTelemetryEventNameSchema,
    orgId: Type.Optional(Type.String({ minLength: 1 })),
    repoId: Type.Optional(Type.String({ minLength: 1 })),
    requestId: Type.Optional(Type.String({ minLength: 1 })),
    route: Type.Optional(Type.String({ minLength: 1 })),
    statusCode: Type.Optional(Type.Number({ minimum: 100, maximum: 599 })),
    timestamp: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Coarse error classes safe to export in telemetry backends. */
export const TelemetryErrorClassSchema = Type.Union([
  Type.Literal("auth_error"),
  Type.Literal("db_error"),
  Type.Literal("provider_error"),
  Type.Literal("rate_limit_error"),
  Type.Literal("timeout_error"),
  Type.Literal("validation_error"),
  Type.Literal("unknown_error"),
]);

/** Product-safe serialized error payload. */
export const SerializedTelemetryErrorSchema = Type.Object(
  {
    class: TelemetryErrorClassSchema,
    code: Type.Optional(Type.String({ minLength: 1 })),
    message: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    retryable: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Structured JSON log entry emitted by the observability logger. */
export const StructuredTelemetryLogEntrySchema = Type.Object(
  {
    attributes: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), TelemetryAttributeValueSchema),
    ),
    error: Type.Optional(SerializedTelemetryErrorSchema),
    level: ObservabilityLogLevelSchema,
    message: Type.String({ minLength: 1 }),
    resource: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), TelemetryAttributeValueSchema),
    ),
    target: Type.String({ minLength: 1 }),
    timestamp: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Scalar attribute value allowed in structured telemetry events. */
export type TelemetryAttributeValue = Static<typeof TelemetryAttributeValueSchema>;

/** Runtime environment name used for observability resources. */
export type ObservabilityEnvironment = Static<typeof ObservabilityEnvironmentSchema>;

/** Observability exporter mode. */
export type ObservabilityExporter = Static<typeof ObservabilityExporterSchema>;

/** Observability log level. */
export type ObservabilityLogLevel = Static<typeof ObservabilityLogLevelSchema>;

/** Observability redaction policy. */
export type ObservabilityRedactionConfig = Static<typeof ObservabilityRedactionConfigSchema>;

/** Observability runtime configuration. */
export type ObservabilityConfig = Static<typeof ObservabilityConfigSchema>;

/** Overrides accepted by the observability configuration loader. */
export type ObservabilityConfigOverrides = Partial<Omit<ObservabilityConfig, "redaction">> & {
  /** Optional redaction policy overrides. */
  readonly redaction?: Partial<ObservabilityRedactionConfig>;
};

/** Resource attributes attached to telemetry providers. */
export type ObservabilityResourceAttributes = Readonly<Record<string, TelemetryAttributeValue>>;

/** Admin control-plane telemetry event name. */
export type AdminControlPlaneTelemetryEventName = Static<
  typeof AdminControlPlaneTelemetryEventNameSchema
>;

/** Structured admin control-plane telemetry event. */
export type AdminControlPlaneTelemetryEvent = Static<typeof AdminControlPlaneTelemetryEventSchema>;

/** Coarse error class safe to export in telemetry backends. */
export type TelemetryErrorClass = Static<typeof TelemetryErrorClassSchema>;

/** Product-safe serialized error payload. */
export type SerializedTelemetryError = Static<typeof SerializedTelemetryErrorSchema>;

/** Structured JSON log entry emitted by the observability logger. */
export type StructuredTelemetryLogEntry = Static<typeof StructuredTelemetryLogEntrySchema>;

/** Admin control-plane telemetry event accepted before timestamp normalization. */
export type AdminControlPlaneTelemetryEventInput = Omit<
  AdminControlPlaneTelemetryEvent,
  "timestamp"
> & {
  /** ISO timestamp for the event. */
  readonly timestamp?: string;
};

/** Sink that receives normalized observability events. */
export type ObservabilitySink = {
  /** Records one normalized admin control-plane event. */
  readonly record: (event: AdminControlPlaneTelemetryEvent) => void;
};

/** In-memory sink used by tests and local audits. */
export type MemoryObservabilitySink = ObservabilitySink & {
  /** Removes all recorded events from the sink. */
  readonly clear: () => void;
  /** Returns recorded events in insertion order. */
  readonly events: () => readonly AdminControlPlaneTelemetryEvent[];
};

/** Console logger surface used by the console sink. */
export type ObservabilityConsoleLogger = {
  /** Emits a debug structured telemetry line. */
  readonly debug?: (message?: unknown, ...optionalParams: readonly unknown[]) => void;
  /** Emits an error structured telemetry line. */
  readonly error?: (message?: unknown, ...optionalParams: readonly unknown[]) => void;
  /** Emits an informational structured telemetry line. */
  readonly info: (message?: unknown, ...optionalParams: readonly unknown[]) => void;
  /** Emits a warning structured telemetry line. */
  readonly warn: (message?: unknown, ...optionalParams: readonly unknown[]) => void;
};

/** Structured telemetry log options accepted by logger methods. */
export type StructuredTelemetryLogOptions = {
  /** Additional safe telemetry attributes. */
  readonly attributes?: Readonly<Record<string, TelemetryAttributeValue | undefined>>;
  /** Optional error to classify and serialize. */
  readonly error?: unknown;
  /** Optional target/component label. */
  readonly target?: string;
  /** Optional deterministic timestamp for tests. */
  readonly timestamp?: string;
};

/** Sink that receives structured telemetry log entries. */
export type StructuredTelemetryLogSink = {
  /** Writes one normalized structured log entry. */
  readonly write: (entry: StructuredTelemetryLogEntry) => void;
};

/** Logger facade used by application services. */
export type StructuredTelemetryLogger = {
  /** Emits a debug log entry. */
  readonly debug: (message: string, options?: StructuredTelemetryLogOptions) => void;
  /** Emits an error log entry. */
  readonly error: (message: string, options?: StructuredTelemetryLogOptions) => void;
  /** Emits an informational log entry. */
  readonly info: (message: string, options?: StructuredTelemetryLogOptions) => void;
  /** Emits a warning log entry. */
  readonly warn: (message: string, options?: StructuredTelemetryLogOptions) => void;
};

/** Summary of admin control-plane telemetry used by release audits. */
export type AdminControlPlaneTelemetrySummary = {
  /** Count of denied access events. */
  readonly accessDeniedCount: number;
  /** Count of completed admin action metric events. */
  readonly adminActionCompletedCount: number;
  /** Completed admin action count by action kind. */
  readonly adminActionsByKind: Readonly<Record<string, number>>;
  /** Event count by telemetry name. */
  readonly eventsByName: Readonly<Record<AdminControlPlaneTelemetryEventName, number>>;
  /** Denied access count by error code. */
  readonly failuresByCode: Readonly<Record<string, number>>;
  /** Count of replay dispatch events. */
  readonly replayDispatchCount: number;
  /** Count of settings mutation events. */
  readonly settingsUpdateCount: number;
  /** Total number of telemetry events. */
  readonly totalEvents: number;
};

/** Default safe observability configuration. */
export const DEFAULT_OBSERVABILITY_CONFIG = {
  enabled: false,
  environment: "development",
  exporter: "none",
  logLevel: "info",
  metricsIntervalMs: 15_000,
  redaction: {
    captureCodeSnippets: false,
    capturePrompts: false,
    includeDebugAttributes: false,
    logRawErrors: false,
    strict: true,
  },
  serviceName: "heimdall",
  traceErrorSampleRate: 1,
  traceSampleRate: 1,
  traceSlowJobSampleRate: 1,
  version: "dev",
} as const satisfies ObservabilityConfig;

/** Error raised when observability configuration is invalid. */
export class ObservabilityConfigValidationError extends Error {
  /** Validation issues found while loading observability config. */
  public readonly issues: readonly string[];

  /** Creates an observability configuration validation error. */
  public constructor(issues: readonly string[]) {
    super(`Invalid observability configuration: ${issues.join("; ")}`);
    this.name = "ObservabilityConfigValidationError";
    this.issues = issues;
  }
}

/** Loads observability configuration from environment variables and optional overrides. */
export function loadObservabilityConfig(
  env: EnvironmentRecord = getProcessEnvironment(),
  overrides: ObservabilityConfigOverrides = {},
): ObservabilityConfig {
  const issues: string[] = [];
  const otlpEndpoint = emptyToUndefined(env.OBSERVABILITY_OTLP_ENDPOINT);
  const baseConfig = {
    enabled: parseBooleanEnv(
      env.OBSERVABILITY_ENABLED,
      DEFAULT_OBSERVABILITY_CONFIG.enabled,
      "OBSERVABILITY_ENABLED",
      issues,
    ),
    environment: parseEnvironmentEnv(env.OBSERVABILITY_ENV ?? env.APP_ENV ?? env.NODE_ENV, issues),
    exporter: parseEnumEnv(
      env.OBSERVABILITY_EXPORTER,
      ["none", "console", "otlp"],
      DEFAULT_OBSERVABILITY_CONFIG.exporter,
      "OBSERVABILITY_EXPORTER",
      issues,
    ),
    logLevel: parseLogLevelEnv(env.OBSERVABILITY_LOG_LEVEL ?? env.LOG_LEVEL),
    metricsIntervalMs: parsePositiveIntegerEnv(
      env.OBSERVABILITY_METRICS_INTERVAL_MS,
      DEFAULT_OBSERVABILITY_CONFIG.metricsIntervalMs,
      "OBSERVABILITY_METRICS_INTERVAL_MS",
      issues,
    ),
    otlpEndpoint,
    redaction: {
      captureCodeSnippets: parseBooleanEnv(
        env.OBSERVABILITY_CAPTURE_CODE_SNIPPETS,
        DEFAULT_OBSERVABILITY_CONFIG.redaction.captureCodeSnippets,
        "OBSERVABILITY_CAPTURE_CODE_SNIPPETS",
        issues,
      ),
      capturePrompts: parseBooleanEnv(
        env.OBSERVABILITY_CAPTURE_PROMPTS,
        DEFAULT_OBSERVABILITY_CONFIG.redaction.capturePrompts,
        "OBSERVABILITY_CAPTURE_PROMPTS",
        issues,
      ),
      includeDebugAttributes: parseBooleanEnv(
        env.OBSERVABILITY_INCLUDE_DEBUG_ATTRIBUTES,
        DEFAULT_OBSERVABILITY_CONFIG.redaction.includeDebugAttributes,
        "OBSERVABILITY_INCLUDE_DEBUG_ATTRIBUTES",
        issues,
      ),
      logRawErrors: parseBooleanEnv(
        env.OBSERVABILITY_LOG_RAW_ERRORS,
        DEFAULT_OBSERVABILITY_CONFIG.redaction.logRawErrors,
        "OBSERVABILITY_LOG_RAW_ERRORS",
        issues,
      ),
      strict: parseBooleanEnv(
        env.OBSERVABILITY_REDACTION_STRICT,
        DEFAULT_OBSERVABILITY_CONFIG.redaction.strict,
        "OBSERVABILITY_REDACTION_STRICT",
        issues,
      ),
    },
    serviceName:
      emptyToUndefined(env.OBSERVABILITY_SERVICE_NAME) ?? DEFAULT_OBSERVABILITY_CONFIG.serviceName,
    traceErrorSampleRate: parseRateEnv(
      env.OBSERVABILITY_TRACE_ERROR_SAMPLE_RATE,
      DEFAULT_OBSERVABILITY_CONFIG.traceErrorSampleRate,
      "OBSERVABILITY_TRACE_ERROR_SAMPLE_RATE",
      issues,
    ),
    traceSampleRate: parseRateEnv(
      env.OBSERVABILITY_TRACE_SAMPLE_RATE,
      DEFAULT_OBSERVABILITY_CONFIG.traceSampleRate,
      "OBSERVABILITY_TRACE_SAMPLE_RATE",
      issues,
    ),
    traceSlowJobSampleRate: parseRateEnv(
      env.OBSERVABILITY_TRACE_SLOW_JOB_SAMPLE_RATE,
      DEFAULT_OBSERVABILITY_CONFIG.traceSlowJobSampleRate,
      "OBSERVABILITY_TRACE_SLOW_JOB_SAMPLE_RATE",
      issues,
    ),
    version: emptyToUndefined(env.APP_VERSION) ?? DEFAULT_OBSERVABILITY_CONFIG.version,
    ...(otlpEndpoint ? { otlpEndpoint } : {}),
  };
  const mergedConfig = {
    ...baseConfig,
    ...withoutUndefinedValues(overrides),
    redaction: {
      ...baseConfig.redaction,
      ...(overrides.redaction ?? {}),
    },
  };

  if (issues.length > 0) {
    throw new ObservabilityConfigValidationError(issues);
  }

  if (Value.Check(ObservabilityConfigSchema, mergedConfig)) {
    return mergedConfig as ObservabilityConfig;
  }

  throw new ObservabilityConfigValidationError(
    schemaIssues(ObservabilityConfigSchema, mergedConfig),
  );
}

/** Builds stable resource attributes for telemetry providers. */
export function createObservabilityResourceAttributes(
  config: ObservabilityConfig,
  env: EnvironmentRecord = getProcessEnvironment(),
): ObservabilityResourceAttributes {
  const attributes: Record<string, TelemetryAttributeValue> = {
    "deployment.environment.name": config.environment,
    "service.name": config.serviceName,
    "service.namespace": "code-review-agent",
    "service.version": config.version,
  };
  const hostname = emptyToUndefined(env.HOSTNAME);
  const runtimeName = detectRuntimeName();
  const runtimeVersion = detectRuntimeVersion();
  if (hostname) {
    attributes["host.name"] = hostname;
  }
  if (runtimeName) {
    attributes["process.runtime.name"] = runtimeName;
  }
  if (runtimeVersion) {
    attributes["process.runtime.version"] = runtimeVersion;
  }

  return attributes;
}

/** Sanitizes telemetry attributes by dropping unsafe keys and redacting string values. */
export function sanitizeTelemetryAttributes(
  attributes: Readonly<Record<string, TelemetryAttributeValue | undefined>>,
  redaction: ObservabilityRedactionConfig = DEFAULT_OBSERVABILITY_CONFIG.redaction,
): Readonly<Record<string, TelemetryAttributeValue>> {
  const sanitized: Record<string, TelemetryAttributeValue> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || shouldDropTelemetryAttribute(key, redaction)) {
      continue;
    }

    if (typeof value === "string") {
      sanitized[key] = redactTelemetryText(value, redaction);
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

/** Redacts secret-looking values from telemetry text. */
export function redactTelemetryText(
  value: string,
  redaction: ObservabilityRedactionConfig = DEFAULT_OBSERVABILITY_CONFIG.redaction,
): string {
  const maxLength = redaction.strict ? 1000 : 2000;

  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted-email]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/gu, "[redacted-token]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[redacted-token]")
    .replace(
      /\b(token|secret|password|api[_-]?key|authorization|cookie)=([^\s,;]+)/giu,
      "$1=[redacted]",
    )
    .slice(0, maxLength);
}

/** Classifies an unknown error into a safe telemetry error class. */
export function classifyTelemetryError(error: unknown): TelemetryErrorClass {
  const record = recordFromUnknown(error);
  const searchable = [
    error instanceof Error ? error.name : undefined,
    error instanceof Error ? error.message : undefined,
    stringFromRecord(record, "code"),
    stringFromRecord(record, "type"),
    stringFromRecord(record, "name"),
    stringFromRecord(record, "status"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (searchable.includes("rate") && searchable.includes("limit")) {
    return "rate_limit_error";
  }
  if (
    searchable.includes("timeout") ||
    searchable.includes("timed out") ||
    searchable.includes("abort")
  ) {
    return "timeout_error";
  }
  if (
    searchable.includes("postgres") ||
    searchable.includes("drizzle") ||
    searchable.includes("database") ||
    searchable.includes("sql")
  ) {
    return "db_error";
  }
  if (
    searchable.includes("github") ||
    searchable.includes("openai") ||
    searchable.includes("stripe") ||
    searchable.includes("provider") ||
    searchable.includes("llm")
  ) {
    return "provider_error";
  }
  if (
    searchable.includes("validation") ||
    searchable.includes("schema") ||
    searchable.includes("parse")
  ) {
    return "validation_error";
  }
  if (
    searchable.includes("auth") ||
    searchable.includes("unauthorized") ||
    searchable.includes("forbidden") ||
    searchable.includes("csrf")
  ) {
    return "auth_error";
  }

  return "unknown_error";
}

/** Serializes an unknown error without leaking raw secrets by default. */
export function serializeTelemetryError(
  error: unknown,
  redaction: ObservabilityRedactionConfig = DEFAULT_OBSERVABILITY_CONFIG.redaction,
): SerializedTelemetryError {
  const record = recordFromUnknown(error);
  const errorClass = classifyTelemetryError(error);
  const rawMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const serialized = withoutUndefinedValues({
    class: errorClass,
    code: stringFromRecord(record, "code") ?? stringFromRecord(record, "type"),
    message: redaction.logRawErrors
      ? redactTelemetryText(rawMessage || safeTelemetryErrorMessage(errorClass), redaction)
      : safeTelemetryErrorMessage(errorClass),
    name: error instanceof Error ? error.name : stringFromRecord(record, "name"),
    retryable: booleanFromRecord(record, "retryable"),
  });

  if (!Value.Check(SerializedTelemetryErrorSchema, serialized)) {
    throw new Error("Serialized telemetry error does not match the schema.");
  }

  return serialized as SerializedTelemetryError;
}

/** Builds a structured telemetry log entry. */
export function createStructuredTelemetryLogEntry(
  config: ObservabilityConfig,
  input: StructuredTelemetryLogOptions & {
    /** Severity level for the log entry. */
    readonly level: ObservabilityLogLevel;
    /** Human-readable log message. */
    readonly message: string;
  },
  env: EnvironmentRecord = getProcessEnvironment(),
): StructuredTelemetryLogEntry {
  const entry = withoutUndefinedValues({
    attributes: input.attributes
      ? sanitizeTelemetryAttributes(input.attributes, config.redaction)
      : undefined,
    error:
      input.error === undefined
        ? undefined
        : serializeTelemetryError(input.error, config.redaction),
    level: input.level,
    message: redactTelemetryText(input.message, config.redaction),
    resource: createObservabilityResourceAttributes(config, env),
    target: input.target ?? config.serviceName,
    timestamp: input.timestamp ?? new Date().toISOString(),
  });

  if (!Value.Check(StructuredTelemetryLogEntrySchema, entry)) {
    throw new Error("Structured telemetry log entry does not match the schema.");
  }

  return entry as StructuredTelemetryLogEntry;
}

/** Renders a structured telemetry log entry as one JSON line. */
export function renderStructuredTelemetryLogLine(entry: StructuredTelemetryLogEntry): string {
  if (!Value.Check(StructuredTelemetryLogEntrySchema, entry)) {
    throw new Error("Structured telemetry log entry does not match the schema.");
  }

  return JSON.stringify(entry);
}

/** Creates a console-backed sink for structured telemetry log entries. */
export function createConsoleStructuredTelemetryLogSink(
  logger: ObservabilityConsoleLogger = console,
): StructuredTelemetryLogSink {
  return {
    write: (entry) => {
      const line = renderStructuredTelemetryLogLine(entry);
      if (entry.level === "error") {
        (logger.error ?? logger.warn)(line);
        return;
      }
      if (entry.level === "warn") {
        logger.warn(line);
        return;
      }
      if (entry.level === "debug") {
        (logger.debug ?? logger.info)(line);
        return;
      }

      logger.info(line);
    },
  };
}

/** Creates a structured telemetry logger facade. */
export function createStructuredTelemetryLogger(
  config: ObservabilityConfig,
  sink: StructuredTelemetryLogSink = createConsoleStructuredTelemetryLogSink(),
  env: EnvironmentRecord = getProcessEnvironment(),
): StructuredTelemetryLogger {
  const log = (
    level: ObservabilityLogLevel,
    message: string,
    options?: StructuredTelemetryLogOptions,
  ) => {
    if (!config.enabled || config.exporter === "none") {
      return;
    }

    sink.write(
      createStructuredTelemetryLogEntry(
        config,
        {
          ...options,
          level,
          message,
        },
        env,
      ),
    );
  };

  return {
    debug: (message, options) => log("debug", message, options),
    error: (message, options) => log("error", message, options),
    info: (message, options) => log("info", message, options),
    warn: (message, options) => log("warn", message, options),
  };
}

/** Creates a sink that intentionally drops events. */
export function createNoopObservabilitySink(): ObservabilitySink {
  return {
    record: () => undefined,
  };
}

/** Creates an in-memory observability sink. */
export function createMemoryObservabilitySink(
  initialEvents: readonly AdminControlPlaneTelemetryEvent[] = [],
): MemoryObservabilitySink {
  const recordedEvents = [...initialEvents.map(normalizeAdminControlPlaneTelemetryEvent)];
  return {
    clear: () => {
      recordedEvents.length = 0;
    },
    events: () => [...recordedEvents],
    record: (event) => {
      recordedEvents.push(normalizeAdminControlPlaneTelemetryEvent(event));
    },
  };
}

/** Creates a console-backed observability sink for production services. */
export function createConsoleObservabilitySink(
  logger: ObservabilityConsoleLogger = console,
): ObservabilitySink {
  return {
    record: (event) => {
      const normalizedEvent = normalizeAdminControlPlaneTelemetryEvent(event);
      const line = JSON.stringify({
        event: normalizedEvent,
        level: telemetryLogLevel(normalizedEvent),
        target: "heimdall.admin_control_plane",
      });
      if (telemetryLogLevel(normalizedEvent) === "warn") {
        logger.warn(line);
        return;
      }

      logger.info(line);
    },
  };
}

/** Records a normalized admin control-plane telemetry event. */
export function recordAdminControlPlaneTelemetryEvent(
  sink: ObservabilitySink,
  event: AdminControlPlaneTelemetryEventInput,
): AdminControlPlaneTelemetryEvent {
  const normalizedEvent = normalizeAdminControlPlaneTelemetryEvent(event);
  sink.record(normalizedEvent);
  return normalizedEvent;
}

/** Records telemetry and suppresses sink failures so production requests are not blocked. */
export function tryRecordAdminControlPlaneTelemetryEvent(
  sink: ObservabilitySink,
  event: AdminControlPlaneTelemetryEventInput,
): boolean {
  try {
    recordAdminControlPlaneTelemetryEvent(sink, event);
    return true;
  } catch {
    return false;
  }
}

/** Normalizes and validates an admin control-plane telemetry event. */
export function normalizeAdminControlPlaneTelemetryEvent(
  event: AdminControlPlaneTelemetryEventInput,
): AdminControlPlaneTelemetryEvent {
  const normalizedEvent = withoutUndefinedValues({
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  });
  if (!Value.Check(AdminControlPlaneTelemetryEventSchema, normalizedEvent)) {
    throw new Error("Admin control-plane telemetry event does not match the schema.");
  }
  const timestamp = normalizedEvent.timestamp;
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    throw new Error("Admin control-plane telemetry event timestamp must be parseable.");
  }

  return normalizedEvent as AdminControlPlaneTelemetryEvent;
}

/** Builds a compact summary of admin control-plane telemetry. */
export function summarizeAdminControlPlaneTelemetry(
  events: readonly AdminControlPlaneTelemetryEventInput[],
): AdminControlPlaneTelemetrySummary {
  const normalizedEvents = events.map(normalizeAdminControlPlaneTelemetryEvent);
  const adminActionsByKind: Record<string, number> = {};
  const eventsByName = emptyEventCounts();
  const failuresByCode: Record<string, number> = {};

  for (const event of normalizedEvents) {
    eventsByName[event.name] += 1;
    if (event.name === "admin.access.denied") {
      const code = typeof event.attributes?.code === "string" ? event.attributes.code : "unknown";
      failuresByCode[code] = (failuresByCode[code] ?? 0) + 1;
    }
    if (event.name === "admin.action.completed") {
      const actionKind =
        typeof event.attributes?.actionKind === "string" ? event.attributes.actionKind : "unknown";
      adminActionsByKind[actionKind] = (adminActionsByKind[actionKind] ?? 0) + 1;
    }
  }

  return {
    accessDeniedCount: eventsByName["admin.access.denied"],
    adminActionCompletedCount: eventsByName["admin.action.completed"],
    adminActionsByKind,
    eventsByName,
    failuresByCode,
    replayDispatchCount: eventsByName["admin.replay.dispatched"],
    settingsUpdateCount: eventsByName["admin.settings.updated"],
    totalEvents: normalizedEvents.length,
  };
}

/** Returns an empty event-count map with all known event names initialized. */
function emptyEventCounts(): Record<AdminControlPlaneTelemetryEventName, number> {
  return {
    "admin.access.denied": 0,
    "admin.action.completed": 0,
    "admin.auth.success": 0,
    "admin.billing.checkout_session.created": 0,
    "admin.billing.portal_session.created": 0,
    "admin.debug_bundle.exported": 0,
    "admin.eval_import.draft_created": 0,
    "admin.memory_rules.inspected": 0,
    "admin.replay.dispatched": 0,
    "admin.rule.created": 0,
    "admin.rule.deleted": 0,
    "admin.rule.updated": 0,
    "admin.session.revoked": 0,
    "admin.settings.updated": 0,
  };
}

/** Returns whether an attribute key should be dropped for privacy. */
function shouldDropTelemetryAttribute(
  key: string,
  redaction: ObservabilityRedactionConfig,
): boolean {
  if (!/^[A-Za-z0-9_.-]{1,120}$/u.test(key)) {
    return true;
  }

  const normalizedKey = key.toLowerCase();
  if (!redaction.includeDebugAttributes && normalizedKey.startsWith("debug.")) {
    return true;
  }
  if (!redaction.capturePrompts && normalizedKey.includes("prompt")) {
    return true;
  }
  if (
    !redaction.captureCodeSnippets &&
    (normalizedKey.includes("code_snippet") ||
      normalizedKey.includes("snippet") ||
      normalizedKey.includes("raw_diff") ||
      normalizedKey.includes("patch") ||
      normalizedKey.includes("source_body"))
  ) {
    return true;
  }

  return (
    normalizedKey.includes("token") ||
    normalizedKey.includes("secret") ||
    normalizedKey.includes("password") ||
    normalizedKey.includes("authorization") ||
    normalizedKey.includes("cookie") ||
    normalizedKey.includes("email")
  );
}

/** Returns a product-safe fallback message for an error class. */
function safeTelemetryErrorMessage(errorClass: TelemetryErrorClass): string {
  switch (errorClass) {
    case "auth_error":
      return "Authentication or authorization failed.";
    case "db_error":
      return "Database operation failed.";
    case "provider_error":
      return "External provider operation failed.";
    case "rate_limit_error":
      return "External provider rate limit was reached.";
    case "timeout_error":
      return "Operation timed out.";
    case "validation_error":
      return "Input validation failed.";
    case "unknown_error":
      return "Unexpected error.";
  }
}

/** Converts unknown input to a record for product-safe field reads. */
function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reads one string value from a record. */
function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads one boolean value from a record. */
function booleanFromRecord(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Returns the log level for one telemetry event. */
function telemetryLogLevel(event: AdminControlPlaneTelemetryEvent): "info" | "warn" {
  return event.name === "admin.access.denied" || (event.statusCode ?? 0) >= 400 ? "warn" : "info";
}

/** Parses a boolean environment variable. */
function parseBooleanEnv(
  value: string | undefined,
  fallback: boolean,
  name: string,
  issues: string[],
): boolean {
  const normalizedValue = value?.trim().toLowerCase();
  if (!normalizedValue) {
    return fallback;
  }
  if (normalizedValue === "true") {
    return true;
  }
  if (normalizedValue === "false") {
    return false;
  }

  issues.push(`${name} must be true or false`);
  return fallback;
}

/** Parses an enum environment variable. */
function parseEnumEnv<TValue extends string>(
  value: string | undefined,
  allowedValues: readonly TValue[],
  fallback: TValue,
  name: string,
  issues: string[],
): TValue {
  const normalizedValue = emptyToUndefined(value);
  if (!normalizedValue) {
    return fallback;
  }
  if (allowedValues.includes(normalizedValue as TValue)) {
    return normalizedValue as TValue;
  }

  issues.push(`${name} must be one of: ${allowedValues.join(", ")}`);
  return fallback;
}

/** Parses the observability environment name from deployment env values. */
function parseEnvironmentEnv(
  value: string | undefined,
  issues: string[],
): ObservabilityEnvironment {
  const normalizedValue = emptyToUndefined(value);
  if (normalizedValue === "test") {
    return "local";
  }

  return parseEnumEnv(
    normalizedValue,
    ["local", "development", "staging", "production"],
    DEFAULT_OBSERVABILITY_CONFIG.environment,
    "OBSERVABILITY_ENV",
    issues,
  );
}

/** Parses an observability log level and maps broader app log levels safely. */
function parseLogLevelEnv(value: string | undefined): ObservabilityLogLevel {
  const normalizedValue = value?.trim().toLowerCase();
  if (normalizedValue === "trace") {
    return "debug";
  }
  if (normalizedValue === "fatal") {
    return "error";
  }
  if (
    normalizedValue === "debug" ||
    normalizedValue === "info" ||
    normalizedValue === "warn" ||
    normalizedValue === "error"
  ) {
    return normalizedValue;
  }

  return DEFAULT_OBSERVABILITY_CONFIG.logLevel;
}

/** Parses a positive integer environment variable. */
function parsePositiveIntegerEnv(
  value: string | undefined,
  fallback: number,
  name: string,
  issues: string[],
): number {
  const normalizedValue = emptyToUndefined(value);
  if (!normalizedValue) {
    return fallback;
  }

  const parsedValue = Number(normalizedValue);
  if (Number.isInteger(parsedValue) && parsedValue > 0) {
    return parsedValue;
  }

  issues.push(`${name} must be a positive integer`);
  return fallback;
}

/** Parses a trace sampling rate environment variable. */
function parseRateEnv(
  value: string | undefined,
  fallback: number,
  name: string,
  issues: string[],
): number {
  const normalizedValue = emptyToUndefined(value);
  if (!normalizedValue) {
    return fallback;
  }

  const parsedValue = Number(normalizedValue);
  if (Number.isFinite(parsedValue) && parsedValue >= 0 && parsedValue <= 1) {
    return parsedValue;
  }

  issues.push(`${name} must be a number between 0 and 1`);
  return fallback;
}

/** Converts empty strings to undefined. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** Detects the JavaScript runtime name for resource attributes. */
function detectRuntimeName(): string | undefined {
  const runtimeGlobal = globalThis as typeof globalThis & {
    readonly Bun?: unknown;
    readonly process?: { readonly release?: { readonly name?: string } };
  };

  if (runtimeGlobal.Bun) {
    return "bun";
  }

  return emptyToUndefined(runtimeGlobal.process?.release?.name);
}

/** Detects the JavaScript runtime version for resource attributes. */
function detectRuntimeVersion(): string | undefined {
  const runtimeGlobal = globalThis as typeof globalThis & {
    readonly Bun?: { readonly version?: string };
    readonly process?: { readonly versions?: { readonly node?: string } };
  };

  return emptyToUndefined(runtimeGlobal.Bun?.version ?? runtimeGlobal.process?.versions?.node);
}

/** Converts TypeBox validation issues into concise messages. */
function schemaIssues(schema: TSchema, value: unknown): readonly string[] {
  return [...Value.Errors(schema, value)].map((issue) => {
    const path = issue.path === "" ? "config" : issue.path;
    return `${path} ${issue.message}`;
  });
}

/** Removes undefined optional fields before schema validation. */
function withoutUndefinedValues(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
