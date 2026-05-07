import { type LLMFindingOutput, LLMFindingOutputSchema } from "@repo/contracts/review/finding";
import { parseWithSchema } from "@repo/contracts/validation/parse";
import {
  classifyTelemetryError,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricRecorder,
  type TelemetrySpanHandle,
  type TelemetrySpanRecorder,
} from "@repo/observability";
import { redactPromptSecrets } from "@repo/security";
import type { Static, TSchema } from "@sinclair/typebox";

/** Task names supported by the gateway MVP. */
export type LLMTask = "review.findings";

/** Normalized LLM gateway failure codes. */
export type LLMErrorCode =
  | "provider_unavailable"
  | "provider_rate_limited"
  | "provider_auth_failed"
  | "model_not_found"
  | "model_capability_missing"
  | "input_too_large"
  | "budget_exceeded"
  | "timeout"
  | "schema_validation_failed"
  | "provider_refusal"
  | "cache_error"
  | "unknown";

/** Retry policy used for transient provider failures. */
export type LLMGatewayRetryPolicy = {
  /** Maximum number of total attempts, including the first request. */
  readonly maxAttempts: number;
  /** Error codes that may be retried when the error is marked retryable. */
  readonly retryableErrorCodes: readonly LLMErrorCode[];
};

/** Options used to create a schema-validating gateway. */
export type CreateLLMGatewayOptions = {
  /** Default low-cardinality model profile label used when metadata does not provide one. */
  readonly defaultModelProfile?: string;
  /** Optional metric recorder for product-safe aggregate LLM telemetry. */
  readonly metrics?: TelemetryMetricRecorder;
  /** Whether to redact secret-like data from prompts before provider calls. Defaults to true. */
  readonly redactPrompts?: boolean | undefined;
  /** Optional bounded retry policy for transient provider failures. */
  readonly retryPolicy?: Partial<LLMGatewayRetryPolicy>;
  /** Optional span recorder for product-safe LLM call spans. */
  readonly traces?: TelemetrySpanRecorder;
};

/** Details used to construct a normalized LLM gateway error. */
export type LLMGatewayErrorOptions = {
  /** Stable gateway error code. */
  readonly code: LLMErrorCode;
  /** Task that was running when the error occurred, when known. */
  readonly task?: LLMTask;
  /** Provider adapter that raised or caused the error. */
  readonly provider?: string;
  /** Model that raised or caused the error. */
  readonly model?: string;
  /** Whether retrying the same request is expected to be safe. */
  readonly retryable?: boolean;
  /** Product-safe diagnostic metadata. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Original error object, never serialized by the gateway. */
  readonly cause?: unknown;
};

/** Generic structured-output request passed to an LLM provider adapter. */
export type GenerateObjectInput<TSchemaValue extends TSchema> = {
  /** Stable task identifier used for routing, caching, and audit logs. */
  readonly task: LLMTask;
  /** TypeBox schema that the provider output must satisfy. */
  readonly schema: TSchemaValue;
  /** Schema display name used in validation errors. */
  readonly schemaName: string;
  /** System prompt containing task policy. */
  readonly system: string;
  /** User prompt containing review data and retrieved context. */
  readonly prompt: string;
  /** Optional deterministic metadata for logs and tests. */
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/** Provider-neutral structured-output adapter. */
export interface LLMProvider {
  /** Stable provider adapter identifier used for errors, traces, and tests. */
  readonly id?: string;
  /** Generates one JSON-compatible object for a schema-first task. */
  generateObject<TSchemaValue extends TSchema>(
    input: GenerateObjectInput<TSchemaValue>,
  ): Promise<Static<TSchemaValue>>;
}

/** Minimal LLM gateway facade used by review passes. */
export interface LLMGateway {
  /** Generates raw structured output and validates it against the supplied schema. */
  generateObject<TSchemaValue extends TSchema>(
    input: GenerateObjectInput<TSchemaValue>,
  ): Promise<Static<TSchemaValue>>;
  /** Generates review findings in the normalized LLM finding output shape. */
  generateReviewFindings(input: GenerateReviewFindingsInput): Promise<LLMFindingOutput>;
}

/** Input for the review finding generation task. */
export type GenerateReviewFindingsInput = {
  /** Prompt rendered by the review engine. */
  readonly prompt: string;
  /** Optional task metadata for attribution. */
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/** Fake provider configuration for deterministic tests and local execution. */
export type FakeLLMProviderOptions = {
  /** Default object returned when no fixture key is present or matched. */
  readonly defaultObject?: unknown;
  /** Objects keyed by `metadata.fixtureKey`. */
  readonly fixtures?: Readonly<Record<string, unknown>>;
  /** Number of retryable failures to raise before returning a fixture. */
  readonly failuresBeforeSuccess?: number;
  /** Error code raised while simulating failures. */
  readonly failureCode?: LLMErrorCode;
};

/** Error raised by the gateway after provider, validation, budget, or policy failures. */
export class LLMGatewayError extends Error {
  /** Stable gateway error code. */
  public readonly code: LLMErrorCode;
  /** Task that was running when the error occurred, when known. */
  public readonly task?: LLMTask;
  /** Provider adapter that raised or caused the error. */
  public readonly provider?: string;
  /** Model that raised or caused the error. */
  public readonly model?: string;
  /** Whether retrying the same request is expected to be safe. */
  public readonly retryable: boolean;
  /** Product-safe diagnostic metadata. */
  public readonly details?: Readonly<Record<string, unknown>>;
  /** Original error object, never serialized by the gateway. */
  public override readonly cause?: unknown;

  /** Creates a normalized LLM gateway error. */
  public constructor(message: string, options: LLMGatewayErrorOptions) {
    super(message);
    this.name = "LLMGatewayError";
    this.code = options.code;
    this.retryable = options.retryable ?? isRetryableLLMErrorCode(options.code);

    if (options.task) {
      this.task = options.task;
    }
    if (options.provider) {
      this.provider = options.provider;
    }
    if (options.model) {
      this.model = options.model;
    }
    if (options.details) {
      this.details = options.details;
    }
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

/** Deterministic provider that returns configured fixtures and can simulate transient failures. */
export class FakeLLMProvider implements LLMProvider {
  /** Stable provider adapter identifier used for errors, traces, and tests. */
  public readonly id = "fake";
  private remainingFailures: number;

  /** Creates a fake provider with optional fixtures and failure simulation. */
  public constructor(private readonly options: FakeLLMProviderOptions = {}) {
    this.remainingFailures = options.failuresBeforeSuccess ?? 0;
  }

  /** Returns the requested fixture after any configured simulated failures. */
  public async generateObject<TSchemaValue extends TSchema>(
    input: GenerateObjectInput<TSchemaValue>,
  ): Promise<Static<TSchemaValue>> {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new LLMGatewayError("Fake LLM provider simulated a retryable failure.", {
        code: this.options.failureCode ?? "provider_unavailable",
        provider: this.id,
        retryable: true,
        task: input.task,
      });
    }

    const fixtureKey =
      input.metadata && typeof input.metadata.fixtureKey === "string"
        ? input.metadata.fixtureKey
        : undefined;
    const fixture =
      fixtureKey && this.options.fixtures && fixtureKey in this.options.fixtures
        ? this.options.fixtures[fixtureKey]
        : undefined;

    return (fixture ?? this.options.defaultObject ?? { findings: [] }) as Static<TSchemaValue>;
  }
}

/** Creates a schema-validating LLM gateway around an injected provider adapter. */
export function createLLMGateway(
  provider: LLMProvider,
  options: CreateLLMGatewayOptions = {},
): LLMGateway {
  const retryPolicy = normalizeRetryPolicy(options.retryPolicy);
  const generateObject = async <TSchemaValue extends TSchema>(
    input: GenerateObjectInput<TSchemaValue>,
  ): Promise<Static<TSchemaValue>> => {
    const providerInput =
      options.redactPrompts === false ? input : redactGenerateObjectPrompt(input);
    const telemetry = startLLMCallTelemetry(provider, providerInput, options);
    try {
      const output = await executeProviderObject(provider, providerInput, retryPolicy, {
        onRetry: (error) => recordLLMRetryMetric(options.metrics, telemetry, error),
      });
      const validated = validateObjectOutput(provider, providerInput, output);
      finishLLMCallTelemetry(options.metrics, telemetry, { status: "succeeded" });
      return validated;
    } catch (error) {
      finishLLMCallTelemetry(options.metrics, telemetry, { error, status: "failed" });
      throw error;
    }
  };

  return {
    generateObject,
    generateReviewFindings: async (input) =>
      generateObject({
        task: "review.findings",
        schema: LLMFindingOutputSchema,
        schemaName: "LLMFindingOutput",
        system:
          "You are a code review pass. Return only concrete, actionable findings anchored to changed diff lines.",
        prompt: input.prompt,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }),
  };
}

/** Redacts secret-like data from the user prompt before an adapter sees it. */
function redactGenerateObjectPrompt<TSchemaValue extends TSchema>(
  input: GenerateObjectInput<TSchemaValue>,
): GenerateObjectInput<TSchemaValue> {
  const redaction = redactPromptSecrets(input.prompt);
  if (!redaction.redacted) {
    return input;
  }

  return {
    ...input,
    metadata: {
      ...(input.metadata ?? {}),
      promptRedacted: true,
      promptRedactionKinds: redaction.matchKinds,
      promptRedactionReplacementCount: redaction.replacementCount,
    },
    prompt: redaction.value,
  };
}

/** Creates a deterministic gateway for tests and local no-provider execution. */
export function createStaticLLMGateway(
  output: LLMFindingOutput = { findings: [] },
  options: CreateLLMGatewayOptions = {},
): LLMGateway {
  return createLLMGateway(new FakeLLMProvider({ defaultObject: output }), options);
}

/** Normalizes unknown provider failures into gateway-owned errors. */
export function normalizeLLMError(
  error: unknown,
  context: {
    /** Task that was running when the error occurred. */
    readonly task: LLMTask;
    /** Provider adapter that raised or caused the error. */
    readonly provider?: string;
  },
): LLMGatewayError {
  if (error instanceof LLMGatewayError) {
    return error;
  }

  return new LLMGatewayError(error instanceof Error ? error.message : "Unknown LLM failure.", {
    cause: error,
    code: "unknown",
    task: context.task,
    ...(context.provider ? { provider: context.provider } : {}),
  });
}

const DEFAULT_RETRYABLE_ERROR_CODES: readonly LLMErrorCode[] = [
  "provider_unavailable",
  "provider_rate_limited",
  "timeout",
  "unknown",
];

const DEFAULT_RETRY_POLICY: LLMGatewayRetryPolicy = {
  maxAttempts: 2,
  retryableErrorCodes: DEFAULT_RETRYABLE_ERROR_CODES,
};

function normalizeRetryPolicy(
  retryPolicy: Partial<LLMGatewayRetryPolicy> | undefined,
): LLMGatewayRetryPolicy {
  return {
    maxAttempts: Math.max(1, retryPolicy?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts),
    retryableErrorCodes:
      retryPolicy?.retryableErrorCodes ?? DEFAULT_RETRY_POLICY.retryableErrorCodes,
  };
}

async function executeProviderObject<TSchemaValue extends TSchema>(
  provider: LLMProvider,
  input: GenerateObjectInput<TSchemaValue>,
  retryPolicy: LLMGatewayRetryPolicy,
  telemetry?: {
    /** Records one retryable provider failure before the next attempt. */
    readonly onRetry?: (error: LLMGatewayError) => void;
  },
): Promise<Static<TSchemaValue>> {
  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    try {
      return await provider.generateObject(input);
    } catch (error) {
      const gatewayError = normalizeLLMError(error, {
        task: input.task,
        ...(provider.id ? { provider: provider.id } : {}),
      });
      const canRetry =
        attempt < retryPolicy.maxAttempts &&
        gatewayError.retryable &&
        retryPolicy.retryableErrorCodes.includes(gatewayError.code);

      if (!canRetry) {
        throw gatewayError;
      }
      telemetry?.onRetry?.(gatewayError);
    }
  }

  throw new LLMGatewayError("LLM provider retry loop exited without a result.", {
    code: "unknown",
    task: input.task,
    ...(provider.id ? { provider: provider.id } : {}),
  });
}

function validateObjectOutput<TSchemaValue extends TSchema>(
  provider: LLMProvider,
  input: GenerateObjectInput<TSchemaValue>,
  output: Static<TSchemaValue>,
): Static<TSchemaValue> {
  try {
    return parseWithSchema(input.schemaName, input.schema, output);
  } catch (error) {
    throw new LLMGatewayError(`Provider output failed schema validation for ${input.schemaName}.`, {
      cause: error,
      code: "schema_validation_failed",
      details: { schemaName: input.schemaName },
      retryable: false,
      task: input.task,
      ...(provider.id ? { provider: provider.id } : {}),
    });
  }
}

function isRetryableLLMErrorCode(code: LLMErrorCode): boolean {
  return DEFAULT_RETRYABLE_ERROR_CODES.includes(code);
}

type LLMCallTelemetryStatus = "failed" | "succeeded";

type LLMCallTelemetryState = {
  /** Low-cardinality labels shared by LLM gateway metrics. */
  readonly labels: Readonly<{
    readonly model_profile: string;
    readonly provider: string;
    readonly task: string;
  }>;
  /** Monotonic start time used for duration metrics. */
  readonly startedAtMs: number;
  /** Product-safe span for this LLM gateway call. */
  readonly span: TelemetrySpanHandle | undefined;
};

/** Starts a product-safe LLM gateway span and returns shared metric labels. */
function startLLMCallTelemetry<TSchemaValue extends TSchema>(
  provider: LLMProvider,
  input: GenerateObjectInput<TSchemaValue>,
  options: CreateLLMGatewayOptions,
): LLMCallTelemetryState {
  const labels = llmMetricLabels(provider, input, options);
  const span = options.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.llmGenerateObject, {
    attributes: {
      "llm.model_profile": labels.model_profile,
      "llm.provider": labels.provider,
      "llm.schema_name": normalizeLLMLabel(input.schemaName, "unknown"),
      "llm.task": labels.task,
      "llm.user_prompt_chars": input.prompt.length,
    },
    kind: "client",
  });

  return {
    labels,
    span,
    startedAtMs: Date.now(),
  };
}

/** Ends an LLM gateway span and emits bounded aggregate metrics. */
function finishLLMCallTelemetry(
  metrics: TelemetryMetricRecorder | undefined,
  telemetry: LLMCallTelemetryState,
  input: {
    /** Error raised by the provider or schema validation layer. */
    readonly error?: unknown;
    /** Final call status. */
    readonly status: LLMCallTelemetryStatus;
  },
): void {
  const durationMs = Date.now() - telemetry.startedAtMs;
  const labels = {
    ...telemetry.labels,
    ...(input.error === undefined ? {} : { error_class: classifyTelemetryError(input.error) }),
    status: input.status,
  };

  metrics?.count(OBSERVABILITY_METRIC_NAMES.llmCallsTotal, { labels });
  metrics?.histogram(OBSERVABILITY_METRIC_NAMES.llmDurationMs, Math.max(0, durationMs), {
    labels,
    unit: "ms",
  });

  if (isStructuredOutputFailure(input.error)) {
    metrics?.count(OBSERVABILITY_METRIC_NAMES.llmStructuredOutputFailuresTotal, {
      labels: telemetry.labels,
    });
  }
  if (isRateLimitedFailure(input.error)) {
    metrics?.count(OBSERVABILITY_METRIC_NAMES.llmRateLimitedTotal, {
      labels: {
        model_profile: telemetry.labels.model_profile,
        provider: telemetry.labels.provider,
      },
    });
  }

  telemetry.span?.end({
    ...(input.error === undefined ? {} : { error: input.error }),
    attributes: {
      "llm.duration_ms": Math.max(0, durationMs),
      ...(input.error === undefined
        ? {}
        : { "llm.error_class": classifyTelemetryError(input.error) }),
      "llm.status": input.status,
    },
    status: input.status === "succeeded" ? "ok" : "error",
  });
}

/** Records one retry attempt for a transient provider failure. */
function recordLLMRetryMetric(
  metrics: TelemetryMetricRecorder | undefined,
  telemetry: LLMCallTelemetryState,
  error: LLMGatewayError,
): void {
  metrics?.count(OBSERVABILITY_METRIC_NAMES.llmRetriesTotal, {
    labels: {
      model_profile: telemetry.labels.model_profile,
      provider: telemetry.labels.provider,
      reason: normalizeLLMLabel(error.code, "unknown"),
      task: telemetry.labels.task,
    },
  });
}

/** Returns low-cardinality labels shared by LLM gateway metrics. */
function llmMetricLabels<TSchemaValue extends TSchema>(
  provider: LLMProvider,
  input: GenerateObjectInput<TSchemaValue>,
  options: CreateLLMGatewayOptions,
): LLMCallTelemetryState["labels"] {
  return {
    model_profile: normalizeLLMLabel(
      stringMetadata(input.metadata, "modelProfile") ??
        stringMetadata(input.metadata, "model_profile") ??
        options.defaultModelProfile,
      "default",
    ),
    provider: normalizeLLMLabel(provider.id, "unknown"),
    task: normalizeLLMLabel(input.task, "unknown"),
  };
}

/** Reads one string metadata field without widening unknown metadata values. */
function stringMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Returns whether an error came from structured output schema validation. */
function isStructuredOutputFailure(error: unknown): boolean {
  return error instanceof LLMGatewayError && error.code === "schema_validation_failed";
}

/** Returns whether an error came from a provider rate limit. */
function isRateLimitedFailure(error: unknown): boolean {
  return error instanceof LLMGatewayError && error.code === "provider_rate_limited";
}

/** Normalizes bounded LLM telemetry label values. */
function normalizeLLMLabel(value: string | undefined, fallback: string): string {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 80);

  return normalized && normalized.length > 0 ? normalized : fallback;
}
