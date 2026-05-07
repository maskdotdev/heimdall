import {
  createTraceState,
  type Attributes as OpenTelemetryAttributes,
  type Context as OpenTelemetryContext,
  type Counter as OpenTelemetryCounter,
  type Gauge as OpenTelemetryGauge,
  type Histogram as OpenTelemetryHistogram,
  type Meter as OpenTelemetryMeter,
  type Span as OpenTelemetrySpan,
  type SpanContext as OpenTelemetrySpanContext,
  SpanKind as OpenTelemetrySpanKind,
  type Tracer as OpenTelemetryTracer,
  metrics as openTelemetryMetrics,
  trace as openTelemetryTrace,
  ROOT_CONTEXT,
  SpanStatusCode,
} from "@opentelemetry/api";
import {
  type Logger as OpenTelemetryLogger,
  logs as openTelemetryLogs,
  SeverityNumber,
} from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider as OpenTelemetryLoggerProvider,
} from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-node";
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

/** Telemetry metric instrument kind. */
export const TelemetryMetricKindSchema = Type.Union([
  Type.Literal("counter"),
  Type.Literal("gauge"),
  Type.Literal("histogram"),
]);

/** Structured metric point emitted by the observability metric recorder. */
export const TelemetryMetricPointSchema = Type.Object(
  {
    kind: TelemetryMetricKindSchema,
    labels: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), TelemetryAttributeValueSchema),
    ),
    name: Type.String({ minLength: 1 }),
    resource: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), TelemetryAttributeValueSchema),
    ),
    timestamp: Type.String({ minLength: 1 }),
    unit: Type.Optional(Type.String({ minLength: 1 })),
    value: Type.Number(),
  },
  { additionalProperties: false },
);

/** Telemetry span kind compatible with common OpenTelemetry span roles. */
export const TelemetrySpanKindSchema = Type.Union([
  Type.Literal("internal"),
  Type.Literal("server"),
  Type.Literal("client"),
  Type.Literal("producer"),
  Type.Literal("consumer"),
]);

/** Product-safe telemetry span status. */
export const TelemetrySpanStatusSchema = Type.Union([
  Type.Literal("unset"),
  Type.Literal("ok"),
  Type.Literal("error"),
]);

/** Trace context propagated between requests, durable jobs, and workers. */
export const TelemetryTraceContextSchema = Type.Object(
  {
    parentEventId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    traceparent: Type.Optional(
      Type.String({
        maxLength: 55,
        minLength: 55,
        pattern: "^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$",
      }),
    ),
    tracestate: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);

/** Product-safe span event attached to a structured telemetry span. */
export const TelemetrySpanEventSchema = Type.Object(
  {
    attributes: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), TelemetryAttributeValueSchema),
    ),
    name: Type.String({ minLength: 1, maxLength: 160 }),
    timestamp: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Structured span record emitted by the observability tracer facade. */
export const TelemetrySpanRecordSchema = Type.Object(
  {
    attributes: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), TelemetryAttributeValueSchema),
    ),
    durationMs: Type.Number({ minimum: 0 }),
    endTime: Type.String({ minLength: 1 }),
    error: Type.Optional(SerializedTelemetryErrorSchema),
    events: Type.Optional(Type.Array(TelemetrySpanEventSchema, { maxItems: 32 })),
    kind: TelemetrySpanKindSchema,
    name: Type.String({ minLength: 1, maxLength: 240 }),
    resource: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), TelemetryAttributeValueSchema),
    ),
    startTime: Type.String({ minLength: 1 }),
    status: TelemetrySpanStatusSchema,
    traceContext: Type.Optional(TelemetryTraceContextSchema),
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

/** Telemetry metric instrument kind. */
export type TelemetryMetricKind = Static<typeof TelemetryMetricKindSchema>;

/** Structured metric point emitted by the observability metric recorder. */
export type TelemetryMetricPoint = Static<typeof TelemetryMetricPointSchema>;

/** Telemetry span kind compatible with common OpenTelemetry span roles. */
export type TelemetrySpanKind = Static<typeof TelemetrySpanKindSchema>;

/** Product-safe telemetry span status. */
export type TelemetrySpanStatus = Static<typeof TelemetrySpanStatusSchema>;

/** Trace context propagated between requests, durable jobs, and workers. */
export type TelemetryTraceContext = Static<typeof TelemetryTraceContextSchema>;

/** Product-safe span event attached to a structured telemetry span. */
export type TelemetrySpanEvent = Static<typeof TelemetrySpanEventSchema>;

/** Structured span record emitted by the observability tracer facade. */
export type TelemetrySpanRecord = Static<typeof TelemetrySpanRecordSchema>;

/** Input accepted when normalizing trace context. */
export type TelemetryTraceContextInput = {
  /** Optional parent durable event ID used to link related operations. */
  readonly parentEventId?: string | undefined;
  /** Optional request ID used in logs and product-safe support flows. */
  readonly requestId?: string | undefined;
  /** Optional W3C traceparent header value. */
  readonly traceparent?: string | undefined;
  /** Optional W3C tracestate header value. */
  readonly tracestate?: string | undefined;
};

/** Header source used for trace context extraction. */
export type TelemetryTraceHeaderSource = Headers | Readonly<Record<string, string | undefined>>;

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

/** Options accepted when recording a metric point. */
export type TelemetryMetricOptions = {
  /** Low-cardinality metric labels. High-cardinality keys are dropped. */
  readonly labels?: Readonly<Record<string, TelemetryAttributeValue | undefined>>;
  /** Optional deterministic timestamp for tests. */
  readonly timestamp?: string;
  /** Optional metric unit such as `ms`, `bytes`, or `1`. */
  readonly unit?: string;
};

/** Sink that receives structured telemetry metric points. */
export type TelemetryMetricSink = {
  /** Writes one normalized metric point. */
  readonly write: (point: TelemetryMetricPoint) => void;
};

/** Metric recorder facade used by application services. */
export type TelemetryMetricRecorder = {
  /** Records a monotonic counter increment. */
  readonly count: (
    name: string,
    options?: TelemetryMetricOptions & { readonly value?: number },
  ) => void;
  /** Records a point-in-time gauge value. */
  readonly gauge: (name: string, value: number, options?: TelemetryMetricOptions) => void;
  /** Records a histogram sample. */
  readonly histogram: (name: string, value: number, options?: TelemetryMetricOptions) => void;
};

/** Options accepted when starting a telemetry span. */
export type TelemetrySpanOptions = {
  /** Product-safe attributes attached when the span starts. */
  readonly attributes?: Readonly<Record<string, TelemetryAttributeValue | undefined>>;
  /** Span role compatible with common OpenTelemetry span kinds. */
  readonly kind?: TelemetrySpanKind;
  /** Optional deterministic start timestamp for tests. */
  readonly startTime?: string;
  /** Optional trace context propagated from request or job boundaries. */
  readonly traceContext?: TelemetryTraceContextInput | undefined;
};

/** Options accepted when ending a telemetry span. */
export type TelemetrySpanEndOptions = {
  /** Product-safe attributes attached when the span ends. */
  readonly attributes?: Readonly<Record<string, TelemetryAttributeValue | undefined>>;
  /** Optional error to classify and serialize on failed spans. */
  readonly error?: unknown;
  /** Explicit span status. Defaults to `error` when error is present and `ok` otherwise. */
  readonly status?: TelemetrySpanStatus;
  /** Optional deterministic end timestamp for tests. */
  readonly timestamp?: string;
};

/** Handle returned for a started telemetry span. */
export type TelemetrySpanHandle = {
  /** Ends the span once and returns the emitted record when one is written. */
  readonly end: (options?: TelemetrySpanEndOptions) => TelemetrySpanRecord | undefined;
};

/** Sink that receives structured telemetry span records. */
export type TelemetrySpanSink = {
  /** Writes one normalized span record. */
  readonly write: (span: TelemetrySpanRecord) => void;
};

/** In-memory span sink used by tests. */
export type MemoryTelemetrySpanSink = TelemetrySpanSink & {
  /** Removes all recorded spans from the sink. */
  readonly clear: () => void;
  /** Returns recorded spans in insertion order. */
  readonly spans: () => readonly TelemetrySpanRecord[];
};

/** Tracer facade used by application services. */
export type TelemetrySpanRecorder = {
  /** Starts a span and returns a handle that records it on end. */
  readonly startSpan: (name: string, options?: TelemetrySpanOptions) => TelemetrySpanHandle;
};

/** Options accepted by the observability runtime bootstrap. */
export type ObservabilityRuntimeOptions = {
  /** Optional preloaded config. Defaults to environment parsing. */
  readonly config?: ObservabilityConfig;
  /** Optional console implementation for console-mode sinks. */
  readonly consoleLogger?: ObservabilityConsoleLogger;
  /** Default service name used when config and environment do not provide one. */
  readonly defaultServiceName?: string;
  /** Optional environment record for config and resource attributes. */
  readonly env?: EnvironmentRecord;
  /** Whether OTLP mode registers OpenTelemetry providers globally. Defaults to true. */
  readonly registerGlobalOpenTelemetry?: boolean;
};

/** Runtime observability handles shared by services. */
export type ObservabilityRuntime = {
  /** Admin control-plane event sink selected by config. */
  readonly adminControlPlaneSink: ObservabilitySink;
  /** Loaded observability config. */
  readonly config: ObservabilityConfig;
  /** Structured telemetry logger selected by config. */
  readonly logger: StructuredTelemetryLogger;
  /** Metric recorder selected by config. */
  readonly metrics: TelemetryMetricRecorder;
  /** Span recorder selected by config. */
  readonly traces: TelemetrySpanRecorder;
  /** Stable resource attributes attached to logs, spans, and metrics. */
  readonly resourceAttributes: ObservabilityResourceAttributes;
  /** Flushes and closes observability providers. No-op until OTel providers are wired. */
  readonly shutdown: () => Promise<void>;
};

/** OpenTelemetry-backed runtime handles selected when the OTLP exporter is enabled. */
type OpenTelemetryRuntimeHandles = {
  /** Admin control-plane telemetry sink backed by OpenTelemetry logs. */
  readonly adminControlPlaneSink: ObservabilitySink;
  /** Structured logger backed by OpenTelemetry logs. */
  readonly logger: StructuredTelemetryLogger;
  /** Metric recorder backed by OpenTelemetry metrics. */
  readonly metrics: TelemetryMetricRecorder;
  /** Flushes and closes OpenTelemetry providers. */
  readonly shutdown: () => Promise<void>;
  /** Span recorder backed by OpenTelemetry traces. */
  readonly traces: TelemetrySpanRecorder;
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

/** Low-cardinality metric names emitted directly by service bootstrap code. */
export const OBSERVABILITY_METRIC_NAMES = {
  apiRequestDurationMs: "code_review_agent.api.request_duration_ms",
  apiRequestsTotal: "code_review_agent.api.requests_total",
  apiServiceStartsTotal: "code_review_agent.api.service_starts_total",
  apiServiceStopsTotal: "code_review_agent.api.service_stops_total",
  embeddingBatchDurationMs: "code_review_agent.embedding.batch_duration_ms",
  embeddingInputsTotal: "code_review_agent.embedding.inputs_total",
  embeddingJobsTotal: "code_review_agent.embedding.jobs_total",
  embeddingTokensTotal: "code_review_agent.embedding.tokens_total",
  indexImporterDurationMs: "code_review_agent.index_importer.duration_ms",
  indexImporterImportsTotal: "code_review_agent.index_importer.imports_total",
  indexImporterRecordsTotal: "code_review_agent.index_importer.records_total",
  indexImporterValidationFailuresTotal:
    "code_review_agent.index_importer.validation_failures_total",
  llmCallsTotal: "code_review_agent.llm.calls_total",
  llmDurationMs: "code_review_agent.llm.duration_ms",
  llmRateLimitedTotal: "code_review_agent.llm.rate_limited_total",
  llmRetriesTotal: "code_review_agent.llm.retries_total",
  llmStructuredOutputFailuresTotal: "code_review_agent.llm.structured_output_failures_total",
  publisherCommentsCreatedTotal: "code_review_agent.publisher.comments_created_total",
  publisherCommentsSkippedTotal: "code_review_agent.publisher.comments_skipped_total",
  publisherDurationMs: "code_review_agent.publisher.duration_ms",
  publisherGithubRateLimitedTotal: "code_review_agent.publisher.github_rate_limited_total",
  publisherRunsTotal: "code_review_agent.publisher.runs_total",
  queueJobDurationMs: "code_review_agent.queue.job_duration_ms",
  queueJobsCompletedTotal: "code_review_agent.queue.jobs_completed_total",
  queueJobsFailedTotal: "code_review_agent.queue.jobs_failed_total",
  queueJobsStartedTotal: "code_review_agent.queue.jobs_started_total",
  queueRetriesTotal: "code_review_agent.queue.retries_total",
  repoSyncDurationMs: "code_review_agent.repo_sync.duration_ms",
  repoSyncOperationsTotal: "code_review_agent.repo_sync.operations_total",
  retrievalContextItemsTotal: "code_review_agent.retrieval.context_items_total",
  retrievalContextTokens: "code_review_agent.retrieval.context_tokens",
  retrievalDurationMs: "code_review_agent.retrieval.duration_ms",
  retrievalRequestsTotal: "code_review_agent.retrieval.requests_total",
  retrievalSourceCandidatesTotal: "code_review_agent.retrieval.source_candidates_total",
  webhookDeliveriesTotal: "code_review_agent.webhook.deliveries_total",
  webhookDeliveryDurationMs: "code_review_agent.webhook.delivery_duration_ms",
  webhookDuplicateDeliveriesTotal: "code_review_agent.webhook.duplicate_deliveries_total",
  webhookRejectionsTotal: "code_review_agent.webhook.rejections_total",
  workerServiceStartsTotal: "code_review_agent.worker.service_starts_total",
  workerServiceStopsTotal: "code_review_agent.worker.service_stops_total",
} as const;

/** Stable span names emitted directly by service and queue boundaries. */
export const OBSERVABILITY_SPAN_NAMES = {
  apiRequest: "code_review_agent.api.request",
  durableJobProcess: "code_review_agent.durable_job.process",
  embeddingEmbedBatch: "code_review_agent.embedding.embed_batch",
  indexImporterImportArtifact: "code_review_agent.index_importer.import_artifact",
  llmGenerateObject: "code_review_agent.llm.generate_object",
  publisherPublishReview: "code_review_agent.publisher.publish_review",
  pullRequestReview: "code_review_agent.review.pull_request",
  repoSyncCheckoutWorkspace: "code_review_agent.repo_sync.checkout_workspace",
  reviewPipelineStage: "code_review_agent.review.pipeline_stage",
  retrievalBuildContext: "code_review_agent.retrieval.build_context",
  webhookDelivery: "code_review_agent.webhook.delivery",
} as const;

const OPEN_TELEMETRY_EXPORT_TIMEOUT_MS = 5_000;

let hasRegisteredOpenTelemetryProviders = false;

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
  const configuredOtlpEndpoint =
    typeof mergedConfig.otlpEndpoint === "string" ? mergedConfig.otlpEndpoint : undefined;
  if (configuredOtlpEndpoint && !isAbsoluteHttpUrl(configuredOtlpEndpoint)) {
    issues.push("OBSERVABILITY_OTLP_ENDPOINT must be an absolute http(s) URL");
  }

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

/** Sanitizes metric labels and drops high-cardinality label keys. */
export function sanitizeTelemetryMetricLabels(
  labels: Readonly<Record<string, TelemetryAttributeValue | undefined>>,
  redaction: ObservabilityRedactionConfig = DEFAULT_OBSERVABILITY_CONFIG.redaction,
): Readonly<Record<string, TelemetryAttributeValue>> {
  const sanitized = sanitizeTelemetryAttributes(labels, redaction);
  const metricLabels: Record<string, TelemetryAttributeValue> = {};

  for (const [key, value] of Object.entries(sanitized)) {
    if (!shouldDropTelemetryMetricLabel(key)) {
      metricLabels[key] = value;
    }
  }

  return metricLabels;
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
    searchable.includes("validation") ||
    searchable.includes("schema") ||
    searchable.includes("parse")
  ) {
    return "validation_error";
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

/** Builds a structured metric point with safe labels and resource attributes. */
export function createTelemetryMetricPoint(
  config: ObservabilityConfig,
  input: TelemetryMetricOptions & {
    /** Metric instrument kind. */
    readonly kind: TelemetryMetricKind;
    /** Low-cardinality metric name. */
    readonly name: string;
    /** Numeric metric value. */
    readonly value: number;
  },
  env: EnvironmentRecord = getProcessEnvironment(),
): TelemetryMetricPoint {
  if (!/^code_review_agent\.[A-Za-z0-9_.]+$/u.test(input.name)) {
    throw new Error("Telemetry metric name must use the code_review_agent prefix.");
  }
  if (!Number.isFinite(input.value)) {
    throw new Error("Telemetry metric value must be finite.");
  }
  if (input.kind === "counter" && input.value < 0) {
    throw new Error("Telemetry counter value must be non-negative.");
  }

  const point = withoutUndefinedValues({
    kind: input.kind,
    labels: input.labels
      ? sanitizeTelemetryMetricLabels(input.labels, config.redaction)
      : undefined,
    name: input.name,
    resource: createObservabilityResourceAttributes(config, env),
    timestamp: input.timestamp ?? new Date().toISOString(),
    unit: input.unit,
    value: input.value,
  });

  if (!Value.Check(TelemetryMetricPointSchema, point)) {
    throw new Error("Telemetry metric point does not match the schema.");
  }
  const timestamp = point.timestamp;
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    throw new Error("Telemetry metric point timestamp must be parseable.");
  }

  return point as TelemetryMetricPoint;
}

/** Renders a structured telemetry metric point as one JSON line. */
export function renderTelemetryMetricLine(point: TelemetryMetricPoint): string {
  if (!Value.Check(TelemetryMetricPointSchema, point)) {
    throw new Error("Telemetry metric point does not match the schema.");
  }

  return JSON.stringify({
    level: "info",
    metric: point,
    target: "heimdall.metrics",
  });
}

/** Creates a console-backed sink for structured telemetry metric points. */
export function createConsoleTelemetryMetricSink(
  logger: ObservabilityConsoleLogger = console,
): TelemetryMetricSink {
  return {
    write: (point) => {
      logger.info(renderTelemetryMetricLine(point));
    },
  };
}

/** Creates a metric recorder facade. */
export function createTelemetryMetricRecorder(
  config: ObservabilityConfig,
  sink: TelemetryMetricSink = createConsoleTelemetryMetricSink(),
  env: EnvironmentRecord = getProcessEnvironment(),
): TelemetryMetricRecorder {
  const record = (
    kind: TelemetryMetricKind,
    name: string,
    value: number,
    options?: TelemetryMetricOptions,
  ) => {
    if (!config.enabled || config.exporter !== "console") {
      return;
    }

    try {
      sink.write(
        createTelemetryMetricPoint(
          config,
          {
            ...options,
            kind,
            name,
            value,
          },
          env,
        ),
      );
    } catch {
      return;
    }
  };

  return {
    count: (name, options) => record("counter", name, options?.value ?? 1, options),
    gauge: (name, value, options) => record("gauge", name, value, options),
    histogram: (name, value, options) => record("histogram", name, value, options),
  };
}

/** Creates a metric recorder that intentionally drops every metric point. */
export function createNoopTelemetryMetricRecorder(): TelemetryMetricRecorder {
  return {
    count: () => undefined,
    gauge: () => undefined,
    histogram: () => undefined,
  };
}

/** Builds a structured span record with safe attributes and resource data. */
export function createTelemetrySpanRecord(
  config: ObservabilityConfig,
  input: TelemetrySpanOptions &
    TelemetrySpanEndOptions & {
      /** Low-cardinality span name. */
      readonly name: string;
      /** Span end timestamp. */
      readonly endTime: string;
      /** Span start timestamp. */
      readonly startTime: string;
    },
  env: EnvironmentRecord = getProcessEnvironment(),
): TelemetrySpanRecord {
  if (!/^code_review_agent\.[A-Za-z0-9_.]+$/u.test(input.name)) {
    throw new Error("Telemetry span name must use the code_review_agent prefix.");
  }

  const startMs = Date.parse(input.startTime);
  const endMs = Date.parse(input.endTime);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new Error("Telemetry span timestamps must be parseable.");
  }

  const attributes = input.attributes
    ? sanitizeTelemetryAttributes(input.attributes, config.redaction)
    : undefined;
  const status = input.status ?? (input.error === undefined ? "ok" : "error");
  const span = withoutUndefinedValues({
    attributes,
    durationMs: Math.max(0, endMs - startMs),
    endTime: input.endTime,
    error:
      input.error === undefined
        ? undefined
        : serializeTelemetryError(input.error, config.redaction),
    kind: input.kind ?? "internal",
    name: input.name,
    resource: createObservabilityResourceAttributes(config, env),
    startTime: input.startTime,
    status,
    traceContext: input.traceContext
      ? normalizeTelemetryTraceContext(input.traceContext)
      : undefined,
  });

  if (!Value.Check(TelemetrySpanRecordSchema, span)) {
    throw new Error("Telemetry span record does not match the schema.");
  }

  return span as TelemetrySpanRecord;
}

/** Renders a structured telemetry span as one JSON line. */
export function renderTelemetrySpanLine(span: TelemetrySpanRecord): string {
  if (!Value.Check(TelemetrySpanRecordSchema, span)) {
    throw new Error("Telemetry span record does not match the schema.");
  }

  return JSON.stringify({
    level: span.status === "error" ? "error" : "info",
    span,
    target: "heimdall.traces",
  });
}

/** Creates a console-backed sink for structured telemetry spans. */
export function createConsoleTelemetrySpanSink(
  logger: ObservabilityConsoleLogger = console,
): TelemetrySpanSink {
  return {
    write: (span) => {
      const line = renderTelemetrySpanLine(span);
      if (span.status === "error") {
        (logger.error ?? logger.warn)(line);
        return;
      }

      logger.info(line);
    },
  };
}

/** Creates an in-memory telemetry span sink for tests. */
export function createMemoryTelemetrySpanSink(
  initialSpans: readonly TelemetrySpanRecord[] = [],
): MemoryTelemetrySpanSink {
  const recordedSpans = [...initialSpans];
  return {
    clear: () => {
      recordedSpans.length = 0;
    },
    spans: () => [...recordedSpans],
    write: (span) => {
      recordedSpans.push(span);
    },
  };
}

/** Creates a product-safe span recorder facade. */
export function createTelemetrySpanRecorder(
  config: ObservabilityConfig,
  sink: TelemetrySpanSink = createConsoleTelemetrySpanSink(),
  env: EnvironmentRecord = getProcessEnvironment(),
): TelemetrySpanRecorder {
  return {
    startSpan: (name, options = {}) => {
      const startTime = options.startTime ?? new Date().toISOString();
      let ended = false;

      return {
        end: (endOptions = {}) => {
          if (ended) {
            return undefined;
          }
          ended = true;
          if (!config.enabled || config.exporter !== "console") {
            return undefined;
          }

          try {
            const span = createTelemetrySpanRecord(
              config,
              {
                attributes: {
                  ...(options.attributes ?? {}),
                  ...(endOptions.attributes ?? {}),
                },
                endTime: endOptions.timestamp ?? new Date().toISOString(),
                name,
                startTime,
                ...(endOptions.error !== undefined ? { error: endOptions.error } : {}),
                ...(options.kind ? { kind: options.kind } : {}),
                ...(endOptions.status ? { status: endOptions.status } : {}),
                ...(options.traceContext ? { traceContext: options.traceContext } : {}),
              },
              env,
            );
            sink.write(span);
            return span;
          } catch {
            return undefined;
          }
        },
      };
    },
  };
}

/** Creates a span recorder that intentionally drops every span. */
export function createNoopTelemetrySpanRecorder(): TelemetrySpanRecorder {
  return {
    startSpan: () => ({
      end: () => undefined,
    }),
  };
}

/** Creates OpenTelemetry-backed runtime handles for OTLP exporter mode. */
function createOpenTelemetryRuntimeHandles(
  config: ObservabilityConfig,
  env: EnvironmentRecord,
  registerGlobalOpenTelemetry: boolean,
): OpenTelemetryRuntimeHandles {
  const resource = resourceFromAttributes({
    ...createObservabilityResourceAttributes(config, env),
  });
  const exportTimeoutMillis = createOpenTelemetryExportTimeoutMs(config);
  const scheduledDelayMillis = Math.min(OPEN_TELEMETRY_EXPORT_TIMEOUT_MS, config.metricsIntervalMs);
  const traceExporter = new OTLPTraceExporter(
    createOpenTelemetryExporterConfig(config, "v1/traces"),
  );
  const metricExporter = new OTLPMetricExporter(
    createOpenTelemetryExporterConfig(config, "v1/metrics"),
  );
  const logExporter = new OTLPLogExporter(createOpenTelemetryExporterConfig(config, "v1/logs"));
  const meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exportIntervalMillis: config.metricsIntervalMs,
        exportTimeoutMillis,
        exporter: metricExporter,
      }),
    ],
    resource,
  });
  const tracerProvider = new NodeTracerProvider({
    meterProvider,
    resource,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.traceSampleRate),
    }),
    spanProcessors: [
      new BatchSpanProcessor(traceExporter, {
        exportTimeoutMillis,
        scheduledDelayMillis,
      }),
    ],
  });
  const loggerProvider = new OpenTelemetryLoggerProvider({
    meterProvider,
    processors: [
      new BatchLogRecordProcessor(logExporter, {
        exportTimeoutMillis,
        scheduledDelayMillis,
      }),
    ],
    resource,
  });

  if (registerGlobalOpenTelemetry && !hasRegisteredOpenTelemetryProviders) {
    tracerProvider.register();
    openTelemetryMetrics.setGlobalMeterProvider(meterProvider);
    openTelemetryLogs.setGlobalLoggerProvider(loggerProvider);
    hasRegisteredOpenTelemetryProviders = true;
  }

  const meter = meterProvider.getMeter(config.serviceName, config.version);
  const tracer = tracerProvider.getTracer(config.serviceName, config.version);
  const logger = loggerProvider.getLogger(config.serviceName, config.version);

  return {
    adminControlPlaneSink: createOpenTelemetryObservabilitySink(config, logger),
    logger: createStructuredTelemetryLogger(
      config,
      createOpenTelemetryStructuredTelemetryLogSink(logger),
      env,
    ),
    metrics: createOpenTelemetryMetricRecorder(config, meter, env),
    shutdown: async () => {
      await Promise.allSettled([
        loggerProvider.forceFlush(),
        meterProvider.forceFlush(),
        tracerProvider.forceFlush(),
      ]);
      await Promise.allSettled([
        loggerProvider.shutdown(),
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
      ]);
    },
    traces: createOpenTelemetrySpanRecorder(config, tracer, env),
  };
}

/** Creates an OpenTelemetry sink for structured telemetry log entries. */
function createOpenTelemetryStructuredTelemetryLogSink(
  logger: OpenTelemetryLogger,
): StructuredTelemetryLogSink {
  return {
    write: (entry) => {
      logger.emit({
        attributes: toOpenTelemetryAttributes({
          ...(entry.attributes ?? {}),
          ...telemetryErrorAttributes(entry.error),
          "log.target": entry.target,
        }),
        body: entry.message,
        severityNumber: toOpenTelemetrySeverityNumber(entry.level),
        severityText: entry.level.toUpperCase(),
        timestamp: toOpenTelemetryTime(entry.timestamp),
      });
    },
  };
}

/** Creates an OpenTelemetry log sink for admin control-plane telemetry events. */
function createOpenTelemetryObservabilitySink(
  config: ObservabilityConfig,
  logger: OpenTelemetryLogger,
): ObservabilitySink {
  return {
    record: (event) => {
      const normalizedEvent = normalizeAdminControlPlaneTelemetryEvent(event);
      const level = telemetryLogLevel(normalizedEvent);
      logger.emit({
        attributes: toOpenTelemetryAttributes(
          createOpenTelemetryAdminEventAttributes(config, normalizedEvent),
        ),
        body: normalizedEvent.name,
        severityNumber: toOpenTelemetrySeverityNumber(level),
        severityText: level.toUpperCase(),
        timestamp: toOpenTelemetryTime(normalizedEvent.timestamp),
      });
    },
  };
}

/** Creates a metric recorder backed by OpenTelemetry synchronous instruments. */
function createOpenTelemetryMetricRecorder(
  config: ObservabilityConfig,
  meter: OpenTelemetryMeter,
  env: EnvironmentRecord = getProcessEnvironment(),
): TelemetryMetricRecorder {
  const counters = new Map<string, OpenTelemetryCounter>();
  const gauges = new Map<string, OpenTelemetryGauge>();
  const histograms = new Map<string, OpenTelemetryHistogram>();
  const record = (
    kind: TelemetryMetricKind,
    name: string,
    value: number,
    options?: TelemetryMetricOptions,
  ) => {
    if (!config.enabled || config.exporter !== "otlp") {
      return;
    }

    try {
      const point = createTelemetryMetricPoint(
        config,
        {
          ...options,
          kind,
          name,
          value,
        },
        env,
      );
      const attributes = toOpenTelemetryAttributes(point.labels ?? {});
      const key = telemetryMetricInstrumentKey(point);
      const metricOptions = point.unit ? { unit: point.unit } : {};

      if (point.kind === "counter") {
        const counter = counters.get(key) ?? meter.createCounter(point.name, metricOptions);
        counters.set(key, counter);
        counter.add(point.value, attributes);
        return;
      }
      if (point.kind === "gauge") {
        const gauge = gauges.get(key) ?? meter.createGauge(point.name, metricOptions);
        gauges.set(key, gauge);
        gauge.record(point.value, attributes);
        return;
      }

      const histogram = histograms.get(key) ?? meter.createHistogram(point.name, metricOptions);
      histograms.set(key, histogram);
      histogram.record(point.value, attributes);
    } catch {
      return;
    }
  };

  return {
    count: (name, options) => record("counter", name, options?.value ?? 1, options),
    gauge: (name, value, options) => record("gauge", name, value, options),
    histogram: (name, value, options) => record("histogram", name, value, options),
  };
}

/** Creates a span recorder backed by an OpenTelemetry tracer. */
function createOpenTelemetrySpanRecorder(
  config: ObservabilityConfig,
  tracer: OpenTelemetryTracer,
  env: EnvironmentRecord = getProcessEnvironment(),
): TelemetrySpanRecorder {
  return {
    startSpan: (name, options = {}) => {
      const startTime = options.startTime ?? new Date().toISOString();
      const openTelemetrySpan = startOpenTelemetrySpan(config, tracer, name, startTime, options);
      let ended = false;

      return {
        end: (endOptions = {}) => {
          if (ended) {
            return undefined;
          }
          ended = true;
          if (!config.enabled || config.exporter !== "otlp") {
            return undefined;
          }

          try {
            const span = createTelemetrySpanRecord(
              config,
              {
                attributes: {
                  ...(options.attributes ?? {}),
                  ...(endOptions.attributes ?? {}),
                },
                endTime: endOptions.timestamp ?? new Date().toISOString(),
                name,
                startTime,
                ...(endOptions.error !== undefined ? { error: endOptions.error } : {}),
                ...(options.kind ? { kind: options.kind } : {}),
                ...(endOptions.status ? { status: endOptions.status } : {}),
                ...(options.traceContext ? { traceContext: options.traceContext } : {}),
              },
              env,
            );
            openTelemetrySpan?.setAttributes(toOpenTelemetryAttributes(span.attributes ?? {}));
            if (span.error) {
              openTelemetrySpan?.recordException(
                new Error(span.error.message),
                toOpenTelemetryTime(span.endTime),
              );
            }
            openTelemetrySpan?.setStatus(toOpenTelemetrySpanStatus(span.status, span.error));
            openTelemetrySpan?.end(toOpenTelemetryTime(span.endTime));
            return span;
          } catch {
            openTelemetrySpan?.setStatus({ code: SpanStatusCode.ERROR });
            openTelemetrySpan?.end();
            return undefined;
          }
        },
      };
    },
  };
}

/** Starts an OpenTelemetry span without letting provider failures escape application code. */
function startOpenTelemetrySpan(
  config: ObservabilityConfig,
  tracer: OpenTelemetryTracer,
  name: string,
  startTime: string,
  options: TelemetrySpanOptions,
): OpenTelemetrySpan | undefined {
  if (!config.enabled || config.exporter !== "otlp") {
    return undefined;
  }

  try {
    const attributes = options.attributes
      ? sanitizeTelemetryAttributes(options.attributes, config.redaction)
      : undefined;
    return tracer.startSpan(
      name,
      {
        ...(attributes ? { attributes: toOpenTelemetryAttributes(attributes) } : {}),
        kind: toOpenTelemetrySpanKind(options.kind ?? "internal"),
        startTime: toOpenTelemetryTime(startTime),
      },
      createOpenTelemetryParentContext(options.traceContext),
    );
  } catch {
    return undefined;
  }
}

/** Normalizes product-safe trace context fields for propagation. */
export function normalizeTelemetryTraceContext(
  input: TelemetryTraceContextInput,
): TelemetryTraceContext {
  const context = withoutUndefinedValues({
    parentEventId: normalizeTraceContextText(input.parentEventId, 120),
    requestId: normalizeTraceContextText(input.requestId, 120),
    traceparent: normalizeTraceparent(input.traceparent),
    tracestate: normalizeTracestate(input.tracestate),
  });

  if (!Value.Check(TelemetryTraceContextSchema, context)) {
    throw new Error("Telemetry trace context does not match the schema.");
  }

  return context as TelemetryTraceContext;
}

/** Extracts trace context from HTTP-style headers. */
export function createTelemetryTraceContextFromHeaders(
  headers: TelemetryTraceHeaderSource,
): TelemetryTraceContext {
  return normalizeTelemetryTraceContext({
    parentEventId: readTelemetryHeader(headers, "x-heimdall-parent-event-id"),
    requestId: readTelemetryHeader(headers, "x-request-id"),
    traceparent: readTelemetryHeader(headers, "traceparent"),
    tracestate: readTelemetryHeader(headers, "tracestate"),
  });
}

/** Creates HTTP-style headers for an already normalized trace context. */
export function createTelemetryTraceHeaders(
  context: TelemetryTraceContextInput,
): Readonly<Record<string, string>> {
  const normalizedContext = normalizeTelemetryTraceContext(context);
  const headers: Record<string, string> = {};

  if (normalizedContext.parentEventId) {
    headers["x-heimdall-parent-event-id"] = normalizedContext.parentEventId;
  }
  if (normalizedContext.requestId) {
    headers["x-request-id"] = normalizedContext.requestId;
  }
  if (normalizedContext.traceparent) {
    headers.traceparent = normalizedContext.traceparent;
  }
  if (normalizedContext.tracestate) {
    headers.tracestate = normalizedContext.tracestate;
  }

  return headers;
}

/** Creates service-level observability handles from config or environment variables. */
export function createObservabilityRuntime(
  options: ObservabilityRuntimeOptions = {},
): ObservabilityRuntime {
  const env = options.env ?? getProcessEnvironment();
  const defaultServiceName = emptyToUndefined(options.defaultServiceName);
  const config =
    options.config ??
    loadObservabilityConfig(
      env,
      emptyToUndefined(env.OBSERVABILITY_SERVICE_NAME) === undefined && defaultServiceName
        ? { serviceName: defaultServiceName }
        : {},
    );
  const consoleLogger = options.consoleLogger ?? console;
  if (config.enabled && config.exporter === "otlp") {
    const openTelemetryRuntime = createOpenTelemetryRuntimeHandles(
      config,
      env,
      options.registerGlobalOpenTelemetry ?? true,
    );

    return {
      adminControlPlaneSink: openTelemetryRuntime.adminControlPlaneSink,
      config,
      logger: openTelemetryRuntime.logger,
      metrics: openTelemetryRuntime.metrics,
      resourceAttributes: createObservabilityResourceAttributes(config, env),
      shutdown: openTelemetryRuntime.shutdown,
      traces: openTelemetryRuntime.traces,
    };
  }

  const adminControlPlaneSink =
    config.enabled && config.exporter === "console"
      ? createConsoleObservabilitySink(consoleLogger)
      : createNoopObservabilitySink();
  const logger = createStructuredTelemetryLogger(
    config,
    createConsoleStructuredTelemetryLogSink(consoleLogger),
    env,
  );
  const metrics = createTelemetryMetricRecorder(
    config,
    createConsoleTelemetryMetricSink(consoleLogger),
    env,
  );
  const traces = createTelemetrySpanRecorder(
    config,
    createConsoleTelemetrySpanSink(consoleLogger),
    env,
  );

  return {
    adminControlPlaneSink,
    config,
    logger,
    metrics,
    resourceAttributes: createObservabilityResourceAttributes(config, env),
    shutdown: async () => undefined,
    traces,
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

/** Converts sanitized telemetry attributes to OpenTelemetry attributes. */
function toOpenTelemetryAttributes(
  attributes: Readonly<Record<string, TelemetryAttributeValue>>,
): OpenTelemetryAttributes {
  return { ...attributes };
}

/** Converts a structured telemetry log level to an OpenTelemetry severity. */
function toOpenTelemetrySeverityNumber(level: ObservabilityLogLevel): SeverityNumber {
  switch (level) {
    case "debug":
      return SeverityNumber.DEBUG;
    case "error":
      return SeverityNumber.ERROR;
    case "warn":
      return SeverityNumber.WARN;
    case "info":
      return SeverityNumber.INFO;
  }
}

/** Converts a structured span kind to an OpenTelemetry span kind. */
function toOpenTelemetrySpanKind(kind: TelemetrySpanKind): OpenTelemetrySpanKind {
  switch (kind) {
    case "client":
      return OpenTelemetrySpanKind.CLIENT;
    case "consumer":
      return OpenTelemetrySpanKind.CONSUMER;
    case "producer":
      return OpenTelemetrySpanKind.PRODUCER;
    case "server":
      return OpenTelemetrySpanKind.SERVER;
    case "internal":
      return OpenTelemetrySpanKind.INTERNAL;
  }
}

/** Converts a product-safe span status to an OpenTelemetry span status. */
function toOpenTelemetrySpanStatus(
  status: TelemetrySpanStatus,
  error: SerializedTelemetryError | undefined,
): { readonly code: SpanStatusCode; readonly message?: string } {
  if (status === "error") {
    return error
      ? { code: SpanStatusCode.ERROR, message: error.message }
      : { code: SpanStatusCode.ERROR };
  }
  if (status === "ok") {
    return { code: SpanStatusCode.OK };
  }

  return { code: SpanStatusCode.UNSET };
}

/** Converts an ISO timestamp to the OpenTelemetry time input used by SDK calls. */
function toOpenTelemetryTime(timestamp: string): Date {
  return new Date(timestamp);
}

/** Builds OpenTelemetry attributes for a serialized telemetry error. */
function telemetryErrorAttributes(
  error: SerializedTelemetryError | undefined,
): Record<string, TelemetryAttributeValue> {
  if (!error) {
    return {};
  }

  const attributes: Record<string, TelemetryAttributeValue> = {
    "error.class": error.class,
    "error.message": error.message,
  };
  if (error.code) {
    attributes["error.code"] = error.code;
  }
  if (error.name) {
    attributes["error.name"] = error.name;
  }
  if (error.retryable !== undefined) {
    attributes["error.retryable"] = error.retryable;
  }

  return attributes;
}

/** Builds product-safe OpenTelemetry attributes for an admin telemetry event. */
function createOpenTelemetryAdminEventAttributes(
  config: ObservabilityConfig,
  event: AdminControlPlaneTelemetryEvent,
): Readonly<Record<string, TelemetryAttributeValue>> {
  const attributes: Record<string, TelemetryAttributeValue> = {
    "event.name": event.name,
    ...sanitizeTelemetryAttributes(event.attributes ?? {}, config.redaction),
  };

  if (event.actorUserId) {
    attributes["heimdall.actor_user_id"] = redactTelemetryText(event.actorUserId, config.redaction);
  }
  if (event.orgId) {
    attributes["heimdall.org_id"] = redactTelemetryText(event.orgId, config.redaction);
  }
  if (event.repoId) {
    attributes["heimdall.repo_id"] = redactTelemetryText(event.repoId, config.redaction);
  }
  if (event.requestId) {
    attributes["heimdall.request_id"] = redactTelemetryText(event.requestId, config.redaction);
  }
  if (event.route) {
    attributes["http.route"] = redactTelemetryText(event.route, config.redaction);
  }
  if (event.statusCode !== undefined) {
    attributes["http.status_code"] = event.statusCode;
  }

  return attributes;
}

/** Builds an OpenTelemetry parent context from propagated W3C trace context. */
function createOpenTelemetryParentContext(
  traceContext: TelemetryTraceContextInput | undefined,
): OpenTelemetryContext | undefined {
  if (!traceContext) {
    return undefined;
  }

  const spanContext = createOpenTelemetrySpanContext(traceContext);
  return spanContext ? openTelemetryTrace.setSpanContext(ROOT_CONTEXT, spanContext) : undefined;
}

/** Builds an OpenTelemetry span context from normalized product-safe trace context. */
function createOpenTelemetrySpanContext(
  traceContext: TelemetryTraceContextInput,
): OpenTelemetrySpanContext | undefined {
  const normalizedContext = normalizeTelemetryTraceContext(traceContext);
  if (!normalizedContext.traceparent) {
    return undefined;
  }

  const [, traceId, spanId, traceFlags] = normalizedContext.traceparent.split("-");
  if (!traceId || !spanId || !traceFlags) {
    return undefined;
  }

  return {
    isRemote: true,
    spanId,
    traceFlags: Number.parseInt(traceFlags, 16),
    traceId,
    ...(normalizedContext.tracestate
      ? { traceState: createTraceState(normalizedContext.tracestate) }
      : {}),
  };
}

/** Builds a stable metric instrument cache key. */
function telemetryMetricInstrumentKey(point: TelemetryMetricPoint): string {
  return `${point.kind}:${point.name}:${point.unit ?? ""}`;
}

/** Builds OTLP HTTP exporter config for one OpenTelemetry signal. */
function createOpenTelemetryExporterConfig(
  config: ObservabilityConfig,
  signalResourcePath: "v1/logs" | "v1/metrics" | "v1/traces",
): { readonly timeoutMillis: number; readonly url?: string } {
  const timeoutMillis = createOpenTelemetryExportTimeoutMs(config);
  if (!config.otlpEndpoint) {
    return { timeoutMillis };
  }

  return {
    timeoutMillis,
    url: createOpenTelemetrySignalUrl(config.otlpEndpoint, signalResourcePath),
  };
}

/** Builds the per-signal OTLP HTTP endpoint URL from a collector base endpoint. */
function createOpenTelemetrySignalUrl(
  endpoint: string,
  signalResourcePath: "v1/logs" | "v1/metrics" | "v1/traces",
): string {
  const url = new URL(endpoint);
  const basePath = url.pathname
    .replace(/\/v1\/(?:logs|metrics|traces)\/?$/u, "")
    .replace(/\/+$/u, "");
  const nextPath = [basePath, signalResourcePath].filter(Boolean).join("/");
  url.pathname = nextPath.startsWith("/") ? nextPath : `/${nextPath}`;
  return url.href;
}

/** Returns the bounded OpenTelemetry export timeout for runtime shutdown and flush paths. */
function createOpenTelemetryExportTimeoutMs(config: ObservabilityConfig): number {
  return Math.max(1, Math.min(OPEN_TELEMETRY_EXPORT_TIMEOUT_MS, config.metricsIntervalMs));
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
    normalizedKey.includes("private_key") ||
    normalizedKey.includes("api_key") ||
    normalizedKey.includes("authorization") ||
    normalizedKey.includes("cookie") ||
    normalizedKey.includes("connection_string") ||
    normalizedKey.includes("database_url") ||
    normalizedKey.includes("redis_url") ||
    normalizedKey.includes("signed_url") ||
    normalizedKey.includes("email")
  );
}

/** Returns whether a metric label key is too high-cardinality for default export. */
function shouldDropTelemetryMetricLabel(key: string): boolean {
  const normalizedKey = key.toLowerCase().replaceAll(/[.-]/gu, "_");
  const highCardinalityKeys = [
    "branch_name",
    "commit_sha",
    "file_path",
    "finding_id",
    "installation_id",
    "job_id",
    "org_id",
    "pull_request_number",
    "repo_id",
    "repository_provider_id",
    "review_run_id",
    "span_id",
    "trace_id",
    "user_id",
  ];

  return highCardinalityKeys.some(
    (highCardinalityKey) =>
      normalizedKey === highCardinalityKey || normalizedKey.endsWith(`_${highCardinalityKey}`),
  );
}

/** Reads a header value from a Headers object or plain record. */
function readTelemetryHeader(
  headers: TelemetryTraceHeaderSource,
  name: string,
): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  const directValue = headers[name] ?? headers[name.toLowerCase()];
  if (directValue !== undefined) {
    return directValue;
  }

  const normalizedName = name.toLowerCase();
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() === normalizedName) {
      return headerValue;
    }
  }

  return undefined;
}

/** Normalizes bounded trace context text fields. */
function normalizeTraceContextText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  const normalizedValue = emptyToUndefined(value);
  if (!normalizedValue || /[\r\n]/u.test(normalizedValue)) {
    return undefined;
  }

  return normalizedValue.slice(0, maxLength);
}

/** Normalizes a W3C traceparent header value. */
function normalizeTraceparent(value: string | undefined): string | undefined {
  const normalizedValue = emptyToUndefined(value)?.toLowerCase();
  if (!normalizedValue) {
    return undefined;
  }

  const match =
    /^(?<version>[0-9a-f]{2})-(?<traceId>[0-9a-f]{32})-(?<spanId>[0-9a-f]{16})-(?<flags>[0-9a-f]{2})$/u.exec(
      normalizedValue,
    );
  if (!match?.groups || match.groups.version === "ff") {
    return undefined;
  }
  const traceId = match.groups.traceId;
  const spanId = match.groups.spanId;
  if (!traceId || !spanId || /^0+$/u.test(traceId) || /^0+$/u.test(spanId)) {
    return undefined;
  }

  return normalizedValue;
}

/** Normalizes a bounded W3C tracestate header value. */
function normalizeTracestate(value: string | undefined): string | undefined {
  const normalizedValue = emptyToUndefined(value);
  if (!normalizedValue || normalizedValue.length > 512 || /[\r\n]/u.test(normalizedValue)) {
    return undefined;
  }

  return normalizedValue;
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

/** Returns whether a value is an absolute HTTP(S) URL. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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
