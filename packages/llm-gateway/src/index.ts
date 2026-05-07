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
import { type Static, type TSchema, Type } from "@sinclair/typebox";

/** Stable prompt version for review finding generation. */
export const REVIEW_FINDINGS_PROMPT_VERSION = "review-findings.v1";

/** Stable model profile used by the review finding generation task. */
export const REVIEW_FINDINGS_MODEL_PROFILE = "review_findings";

/** System prompt used for schema-valid review finding generation. */
export const REVIEW_FINDINGS_SYSTEM_PROMPT =
  "You are a code review pass. Return only concrete, actionable findings anchored to changed diff lines.";

/** Task names supported by the gateway MVP. */
export type LLMTask = "review.findings";

/** Prompt definition for the review finding generation task. */
export type ReviewFindingsPromptDefinition = {
  /** Stable prompt version written to audit metadata. */
  readonly promptVersion: string;
  /** Schema name used in validation errors and provider JSON-mode instructions. */
  readonly schemaName: "LLMFindingOutput";
  /** System prompt containing review policy for the task. */
  readonly system: string;
  /** Task that owns this prompt definition. */
  readonly task: "review.findings";
};

/** Registry of versioned prompts used by gateway convenience methods. */
export type LLMPromptRegistry = {
  /** Prompt definition used by `generateReviewFindings`. */
  readonly reviewFindings: ReviewFindingsPromptDefinition;
};

/** Default prompt definition for review finding generation. */
export const REVIEW_FINDINGS_PROMPT_DEFINITION = {
  promptVersion: REVIEW_FINDINGS_PROMPT_VERSION,
  schemaName: "LLMFindingOutput",
  system: REVIEW_FINDINGS_SYSTEM_PROMPT,
  task: "review.findings",
} as const satisfies ReviewFindingsPromptDefinition;

/** Default versioned prompt registry used by the gateway. */
export const DEFAULT_LLM_PROMPT_REGISTRY = {
  reviewFindings: REVIEW_FINDINGS_PROMPT_DEFINITION,
} as const satisfies LLMPromptRegistry;

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

/** Product-safe input budget enforced before provider execution. */
export type LLMGatewayBudgetPolicy = {
  /** Maximum user prompt characters allowed for one request. */
  readonly maxPromptChars?: number;
  /** Maximum system prompt characters allowed for one request. */
  readonly maxSystemChars?: number;
  /** Maximum combined system and user prompt characters allowed for one request. */
  readonly maxTotalInputChars?: number;
};

/** Provider route selected by task and low-cardinality model profile. */
export type LLMModelRoute = {
  /** Model profile requested by callers through metadata or gateway defaults. */
  readonly modelProfile: string;
  /** Provider adapter used when this route matches. */
  readonly provider: LLMProvider;
  /** Optional task restriction for the route. */
  readonly task?: LLMTask;
};

/** Options used to create a schema-validating gateway. */
export type CreateLLMGatewayOptions = {
  /** Optional product-safe input budget enforced before provider calls. */
  readonly budget?: LLMGatewayBudgetPolicy;
  /** Default low-cardinality model profile label used when metadata does not provide one. */
  readonly defaultModelProfile?: string;
  /** Optional metric recorder for product-safe aggregate LLM telemetry. */
  readonly metrics?: TelemetryMetricRecorder;
  /** Optional model routes selected by task and model profile. */
  readonly modelRoutes?: readonly LLMModelRoute[];
  /** Optional versioned prompt registry. Defaults to the built-in registry. */
  readonly promptRegistry?: LLMPromptRegistry;
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

/** Fetch boundary used by the OpenAI Chat Completions provider. */
export type OpenAIChatCompletionsFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Options used to create an OpenAI-compatible Chat Completions provider. */
export type OpenAIChatCompletionsProviderOptions = {
  /** Secret API key used only in the Authorization header. */
  readonly apiKey: string;
  /** Optional OpenAI-compatible API base URL. Defaults to https://api.openai.com/v1. */
  readonly baseUrl?: string;
  /** Optional fetch implementation for tests or alternate runtimes. */
  readonly fetch?: OpenAIChatCompletionsFetch;
  /** Optional maximum completion tokens passed through to compatible providers. */
  readonly maxCompletionTokens?: number;
  /** Model identifier sent to the provider. */
  readonly model: string;
  /** Optional OpenAI organization header value. */
  readonly organization?: string;
  /** Optional OpenAI project header value. */
  readonly project?: string;
  /** Optional sampling temperature passed through to compatible providers. */
  readonly temperature?: number;
  /** Optional request timeout in milliseconds. */
  readonly timeoutMs?: number;
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

/** Provider adapter backed by the OpenAI-compatible Chat Completions HTTP API. */
export class OpenAIChatCompletionsProvider implements LLMProvider {
  /** Stable provider adapter identifier used for errors, traces, and tests. */
  public readonly id = "openai";

  /** Secret API key used only for request authorization. */
  private readonly apiKey: string;

  /** OpenAI-compatible API base URL without a trailing slash. */
  private readonly baseUrl: string;

  /** Fetch implementation used for provider requests. */
  private readonly fetchFn: OpenAIChatCompletionsFetch;

  /** Optional maximum completion tokens for provider requests. */
  private readonly maxCompletionTokens: number | undefined;

  /** Model identifier sent to the provider. */
  private readonly model: string;

  /** Optional organization header value. */
  private readonly organization: string | undefined;

  /** Optional project header value. */
  private readonly project: string | undefined;

  /** Optional sampling temperature for provider requests. */
  private readonly temperature: number | undefined;

  /** Optional request timeout in milliseconds. */
  private readonly timeoutMs: number | undefined;

  /** Creates an OpenAI-compatible Chat Completions provider. */
  public constructor(options: OpenAIChatCompletionsProviderOptions) {
    this.apiKey = requireOpenAIProviderString(options.apiKey, "apiKey");
    this.baseUrl = normalizeOpenAIBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxCompletionTokens = optionalPositiveNumber(options.maxCompletionTokens);
    this.model = requireOpenAIProviderString(options.model, "model");
    this.organization = optionalProviderString(options.organization);
    this.project = optionalProviderString(options.project);
    this.temperature = optionalFiniteNumber(options.temperature);
    this.timeoutMs = optionalPositiveNumber(options.timeoutMs);
  }

  /** Calls Chat Completions and parses the assistant message content as JSON. */
  public async generateObject<TSchemaValue extends TSchema>(
    input: GenerateObjectInput<TSchemaValue>,
  ): Promise<Static<TSchemaValue>> {
    const response = await this.fetchChatCompletion(input);
    if (!response.ok) {
      throw await openAIHttpError(response, input, this.model);
    }

    const body = await readOpenAIJsonResponse(response, input, this.model);
    const completion = parseOpenAIChatCompletionResponse(body, input, this.model);
    const choice = completion.choices[0];
    if (!choice) {
      throw openAIResponseShapeError("OpenAI response did not include a completion choice.", {
        model: this.model,
        task: input.task,
      });
    }

    if (
      choice.finish_reason === "content_filter" ||
      optionalProviderString(choice.message.refusal)
    ) {
      throw new LLMGatewayError("OpenAI refused to return review JSON for this request.", {
        code: "provider_refusal",
        details: openAIResponseDetails({ finishReason: choice.finish_reason }),
        model: this.model,
        provider: this.id,
        retryable: false,
        task: input.task,
      });
    }

    const content = optionalProviderString(choice.message.content);
    if (!content) {
      throw new LLMGatewayError("OpenAI response did not include JSON message content.", {
        code: "schema_validation_failed",
        details: openAIResponseDetails({ finishReason: choice.finish_reason }),
        model: this.model,
        provider: this.id,
        retryable: false,
        task: input.task,
      });
    }

    try {
      return JSON.parse(content) as Static<TSchemaValue>;
    } catch (error) {
      throw new LLMGatewayError("OpenAI response message content was not valid JSON.", {
        cause: error,
        code: "schema_validation_failed",
        details: openAIResponseDetails({ finishReason: choice.finish_reason }),
        model: this.model,
        provider: this.id,
        retryable: false,
        task: input.task,
      });
    }
  }

  /** Sends one Chat Completions request with optional timeout handling. */
  private async fetchChatCompletion<TSchemaValue extends TSchema>(
    input: GenerateObjectInput<TSchemaValue>,
  ): Promise<Response> {
    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timeout =
      controller && this.timeoutMs
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : undefined;

    try {
      return await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        body: JSON.stringify(this.createRequestBody(input)),
        headers: this.createRequestHeaders(),
        method: "POST",
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      const isTimeout = controller?.signal.aborted === true;
      throw new LLMGatewayError(
        isTimeout
          ? "OpenAI chat completion request timed out."
          : "OpenAI chat completion request failed.",
        {
          cause: error,
          code: isTimeout ? "timeout" : "provider_unavailable",
          model: this.model,
          provider: this.id,
          retryable: true,
          task: input.task,
        },
      );
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  /** Builds the product request body for a JSON-mode Chat Completions call. */
  private createRequestBody<TSchemaValue extends TSchema>(
    input: GenerateObjectInput<TSchemaValue>,
  ): Record<string, unknown> {
    return {
      messages: [
        {
          content: `${input.system}\n\nReturn exactly one valid JSON object for ${input.schemaName}.`,
          role: "system",
        },
        { content: input.prompt, role: "user" },
      ],
      model: this.model,
      n: 1,
      response_format: { type: "json_object" },
      store: false,
      ...(this.maxCompletionTokens ? { max_completion_tokens: this.maxCompletionTokens } : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
    };
  }

  /** Builds request headers without exposing the API key to logs or metadata. */
  private createRequestHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...(this.organization ? { "OpenAI-Organization": this.organization } : {}),
      ...(this.project ? { "OpenAI-Project": this.project } : {}),
    };
  }
}

/** Creates an OpenAI-compatible Chat Completions provider adapter. */
export function createOpenAIChatCompletionsProvider(
  options: OpenAIChatCompletionsProviderOptions,
): LLMProvider {
  return new OpenAIChatCompletionsProvider(options);
}

/** Creates a schema-validating LLM gateway around an injected provider adapter. */
export function createLLMGateway(
  provider: LLMProvider,
  options: CreateLLMGatewayOptions = {},
): LLMGateway {
  const budget = normalizeBudgetPolicy(options.budget);
  const promptRegistry = options.promptRegistry ?? DEFAULT_LLM_PROMPT_REGISTRY;
  const retryPolicy = normalizeRetryPolicy(options.retryPolicy);
  const generateObject = async <TSchemaValue extends TSchema>(
    input: GenerateObjectInput<TSchemaValue>,
  ): Promise<Static<TSchemaValue>> => {
    const route = selectLLMModelRoute(provider, input, options);
    const routedInput = applyModelRouteMetadata(input, route);
    const providerInput =
      options.redactPrompts === false ? routedInput : redactGenerateObjectPrompt(routedInput);
    const telemetry = startLLMCallTelemetry(route.provider, providerInput, options);
    try {
      enforceBudgetPolicy(providerInput, budget, route.provider.id);
      const output = await executeProviderObject(route.provider, providerInput, retryPolicy, {
        onRetry: (error) => recordLLMRetryMetric(options.metrics, telemetry, error),
      });
      const validated = validateObjectOutput(route.provider, providerInput, output);
      finishLLMCallTelemetry(options.metrics, telemetry, { status: "succeeded" });
      return validated;
    } catch (error) {
      finishLLMCallTelemetry(options.metrics, telemetry, { error, status: "failed" });
      throw error;
    }
  };

  return {
    generateObject,
    generateReviewFindings: async (input) => {
      const promptDefinition = promptRegistry.reviewFindings;

      return generateObject({
        task: promptDefinition.task,
        schema: LLMFindingOutputSchema,
        schemaName: promptDefinition.schemaName,
        system: promptDefinition.system,
        prompt: input.prompt,
        metadata: {
          ...(input.metadata ?? {}),
          promptVersion: promptDefinition.promptVersion,
        },
      });
    },
  };
}

type SelectedLLMModelRoute = {
  /** Model profile selected for the call, when one was configured or requested. */
  readonly modelProfile?: string;
  /** Provider selected for the call. */
  readonly provider: LLMProvider;
};

/** Selects a provider by task and model profile, falling back to the default provider. */
function selectLLMModelRoute<TSchemaValue extends TSchema>(
  defaultProvider: LLMProvider,
  input: GenerateObjectInput<TSchemaValue>,
  options: CreateLLMGatewayOptions,
): SelectedLLMModelRoute {
  const requestedModelProfile =
    stringMetadata(input.metadata, "modelProfile") ??
    stringMetadata(input.metadata, "model_profile") ??
    options.defaultModelProfile;
  const requestedProfileKey = modelProfileRouteKey(requestedModelProfile);
  const route = requestedProfileKey
    ? options.modelRoutes?.find(
        (candidate) =>
          (!candidate.task || candidate.task === input.task) &&
          modelProfileRouteKey(candidate.modelProfile) === requestedProfileKey,
      )
    : undefined;
  const modelProfile = route?.modelProfile ?? requestedModelProfile;

  return {
    ...(modelProfile ? { modelProfile } : {}),
    provider: route?.provider ?? defaultProvider,
  };
}

/** Adds the selected model profile to metadata for telemetry and provider-visible audit data. */
function applyModelRouteMetadata<TSchemaValue extends TSchema>(
  input: GenerateObjectInput<TSchemaValue>,
  route: SelectedLLMModelRoute,
): GenerateObjectInput<TSchemaValue> {
  if (!route.modelProfile) {
    return input;
  }

  return {
    ...input,
    metadata: {
      ...(input.metadata ?? {}),
      modelProfile: route.modelProfile,
    },
  };
}

/** Normalizes model profile selectors for deterministic route matching. */
function modelProfileRouteKey(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
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

const NullableOpenAIStringSchema = Type.Union([Type.String(), Type.Null()]);

const OpenAIChatCompletionResponseSchema = Type.Object(
  {
    choices: Type.Array(
      Type.Object(
        {
          finish_reason: Type.Optional(NullableOpenAIStringSchema),
          message: Type.Object(
            {
              content: Type.Optional(NullableOpenAIStringSchema),
              refusal: Type.Optional(NullableOpenAIStringSchema),
            },
            { additionalProperties: true },
          ),
        },
        { additionalProperties: true },
      ),
      { minItems: 1 },
    ),
    id: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

type OpenAIChatCompletionResponse = Static<typeof OpenAIChatCompletionResponseSchema>;

const OpenAIErrorResponseSchema = Type.Object(
  {
    error: Type.Optional(
      Type.Object(
        {
          code: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
          message: Type.Optional(Type.String()),
          param: Type.Optional(NullableOpenAIStringSchema),
          type: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

type OpenAIHttpErrorMapping = {
  /** Stable gateway error code for an OpenAI HTTP status. */
  readonly code: LLMErrorCode;
  /** Whether retrying the same request can succeed. */
  readonly retryable: boolean;
};

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

/** Normalizes budget settings so non-positive limits are ignored. */
function normalizeBudgetPolicy(
  budget: LLMGatewayBudgetPolicy | undefined,
): LLMGatewayBudgetPolicy | undefined {
  const maxPromptChars = optionalPositiveNumber(budget?.maxPromptChars);
  const maxSystemChars = optionalPositiveNumber(budget?.maxSystemChars);
  const maxTotalInputChars = optionalPositiveNumber(budget?.maxTotalInputChars);

  if (!maxPromptChars && !maxSystemChars && !maxTotalInputChars) {
    return undefined;
  }

  return {
    ...(maxPromptChars ? { maxPromptChars } : {}),
    ...(maxSystemChars ? { maxSystemChars } : {}),
    ...(maxTotalInputChars ? { maxTotalInputChars } : {}),
  };
}

/** Enforces product-safe input size budgets before any provider call is made. */
function enforceBudgetPolicy<TSchemaValue extends TSchema>(
  input: GenerateObjectInput<TSchemaValue>,
  budget: LLMGatewayBudgetPolicy | undefined,
  provider: string | undefined,
): void {
  if (!budget) {
    return;
  }

  const promptChars = input.prompt.length;
  const systemChars = input.system.length;
  const totalInputChars = promptChars + systemChars;
  const violations: string[] = [];

  if (budget.maxPromptChars !== undefined && promptChars > budget.maxPromptChars) {
    violations.push("max_prompt_chars");
  }
  if (budget.maxSystemChars !== undefined && systemChars > budget.maxSystemChars) {
    violations.push("max_system_chars");
  }
  if (budget.maxTotalInputChars !== undefined && totalInputChars > budget.maxTotalInputChars) {
    violations.push("max_total_input_chars");
  }
  if (violations.length === 0) {
    return;
  }

  throw new LLMGatewayError("LLM request exceeded the configured input budget.", {
    code: "budget_exceeded",
    details: {
      ...(budget.maxPromptChars !== undefined ? { maxPromptChars: budget.maxPromptChars } : {}),
      ...(budget.maxSystemChars !== undefined ? { maxSystemChars: budget.maxSystemChars } : {}),
      ...(budget.maxTotalInputChars !== undefined
        ? { maxTotalInputChars: budget.maxTotalInputChars }
        : {}),
      promptChars,
      schemaName: input.schemaName,
      systemChars,
      totalInputChars,
      violations,
    },
    ...(provider ? { provider } : {}),
    retryable: false,
    task: input.task,
  });
}

function normalizeRetryPolicy(
  retryPolicy: Partial<LLMGatewayRetryPolicy> | undefined,
): LLMGatewayRetryPolicy {
  return {
    maxAttempts: Math.max(1, retryPolicy?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts),
    retryableErrorCodes:
      retryPolicy?.retryableErrorCodes ?? DEFAULT_RETRY_POLICY.retryableErrorCodes,
  };
}

/** Reads one required, non-empty OpenAI provider option. */
function requireOpenAIProviderString(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new LLMGatewayError(`OpenAI provider option ${name} is required.`, {
      code: "unknown",
      provider: "openai",
      retryable: false,
    });
  }

  return trimmed;
}

/** Reads one optional, non-empty provider string. */
function optionalProviderString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Reads one optional positive number. */
function optionalPositiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Reads one optional finite number. */
function optionalFiniteNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

/** Normalizes an OpenAI-compatible base URL by removing trailing slashes. */
function normalizeOpenAIBaseUrl(value: string): string {
  const trimmed = requireOpenAIProviderString(value, "baseUrl");
  return trimmed.replaceAll(/\/+$/gu, "");
}

/** Reads the provider JSON response body. */
async function readOpenAIJsonResponse<TSchemaValue extends TSchema>(
  response: Response,
  input: GenerateObjectInput<TSchemaValue>,
  model: string,
): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new LLMGatewayError("OpenAI chat completion response was not valid JSON.", {
      cause: error,
      code: "provider_unavailable",
      details: { responseShape: "chat_completion" },
      model,
      provider: "openai",
      retryable: true,
      task: input.task,
    });
  }
}

/** Parses the provider response envelope without trusting provider output shape. */
function parseOpenAIChatCompletionResponse<TSchemaValue extends TSchema>(
  body: unknown,
  input: GenerateObjectInput<TSchemaValue>,
  model: string,
): OpenAIChatCompletionResponse {
  try {
    return parseWithSchema(
      "OpenAIChatCompletionResponse",
      OpenAIChatCompletionResponseSchema,
      body,
    );
  } catch (error) {
    throw openAIResponseShapeError("OpenAI chat completion response envelope was invalid.", {
      cause: error,
      model,
      task: input.task,
    });
  }
}

/** Creates a provider-unavailable error for an invalid OpenAI response envelope. */
function openAIResponseShapeError(
  message: string,
  options: {
    /** Original validation or parsing error. */
    readonly cause?: unknown;
    /** Model that returned the invalid response. */
    readonly model: string;
    /** Task that was running when the response failed. */
    readonly task: LLMTask;
  },
): LLMGatewayError {
  return new LLMGatewayError(message, {
    ...(options.cause ? { cause: options.cause } : {}),
    code: "provider_unavailable",
    details: { responseShape: "chat_completion" },
    model: options.model,
    provider: "openai",
    retryable: true,
    task: options.task,
  });
}

/** Creates a normalized gateway error from an OpenAI HTTP failure. */
async function openAIHttpError<TSchemaValue extends TSchema>(
  response: Response,
  input: GenerateObjectInput<TSchemaValue>,
  model: string,
): Promise<LLMGatewayError> {
  const details = await openAIHttpErrorDetails(response);
  const mapping = openAIErrorMappingForStatus(response.status, stringDetail(details, "errorCode"));

  return new LLMGatewayError(
    `OpenAI chat completions request failed with HTTP ${response.status}.`,
    {
      code: mapping.code,
      details,
      model,
      provider: "openai",
      retryable: mapping.retryable,
      task: input.task,
    },
  );
}

/** Extracts product-safe details from an OpenAI HTTP error response. */
async function openAIHttpErrorDetails(
  response: Response,
): Promise<Readonly<Record<string, unknown>>> {
  const parsed = await safeReadOpenAIErrorBody(response);
  const error = parseOpenAIErrorBody(parsed);
  const requestId =
    optionalProviderString(response.headers.get("x-request-id")) ??
    optionalProviderString(response.headers.get("openai-request-id"));
  const errorCode = openAIErrorCodeString(error?.code);

  return {
    ...(errorCode ? { errorCode } : {}),
    ...(optionalProviderString(error?.type)
      ? { errorType: optionalProviderString(error?.type) }
      : {}),
    ...(requestId ? { requestId } : {}),
    status: response.status,
    statusFamily: `${Math.trunc(response.status / 100)}xx`,
  };
}

/** Reads an OpenAI error body when the response body is valid JSON. */
async function safeReadOpenAIErrorBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** Parses an OpenAI error response with a narrow boundary schema. */
function parseOpenAIErrorBody(
  value: unknown,
): Static<typeof OpenAIErrorResponseSchema>["error"] | undefined {
  try {
    return parseWithSchema("OpenAIErrorResponse", OpenAIErrorResponseSchema, value).error;
  } catch {
    return undefined;
  }
}

/** Converts an OpenAI error code value into a safe string detail. */
function openAIErrorCodeString(value: string | number | null | undefined): string | undefined {
  if (typeof value === "string") {
    return optionalProviderString(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

/** Maps OpenAI HTTP statuses into the gateway error model. */
function openAIErrorMappingForStatus(
  status: number,
  errorCode: string | undefined,
): OpenAIHttpErrorMapping {
  const normalizedErrorCode = errorCode?.trim().toLowerCase();
  if (normalizedErrorCode === "context_length_exceeded" || status === 413) {
    return { code: "input_too_large", retryable: false };
  }

  if (status === 401 || status === 403) {
    return { code: "provider_auth_failed", retryable: false };
  }
  if (status === 404) {
    return { code: "model_not_found", retryable: false };
  }
  if (status === 408) {
    return { code: "timeout", retryable: true };
  }
  if (status === 429) {
    return { code: "provider_rate_limited", retryable: true };
  }
  if (status >= 500) {
    return { code: "provider_unavailable", retryable: true };
  }
  if (status === 400) {
    return { code: "model_capability_missing", retryable: false };
  }

  return { code: "unknown", retryable: false };
}

/** Creates product-safe provider response details. */
function openAIResponseDetails(input: {
  /** Finish reason returned by the provider, when present. */
  readonly finishReason?: string | null | undefined;
}): Readonly<Record<string, unknown>> {
  return optionalProviderString(input.finishReason)
    ? { finishReason: optionalProviderString(input.finishReason) }
    : {};
}

/** Reads one string field from a product-safe detail record. */
function stringDetail(details: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" ? value : undefined;
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
