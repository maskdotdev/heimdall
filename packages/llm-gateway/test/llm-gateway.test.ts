import {
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricOptions,
  type TelemetryMetricRecorder,
  type TelemetrySpanEndOptions,
  type TelemetrySpanOptions,
  type TelemetrySpanRecorder,
} from "@repo/observability";
import { describe, expect, it } from "vitest";
import {
  createLLMGateway,
  createOpenAIChatCompletionsProvider,
  FakeLLMProvider,
  LLMGatewayError,
  type LLMProvider,
  type OpenAIChatCompletionsFetch,
} from "../src/index";

type RecordedMetric = {
  /** Metric instrument kind recorded by the fake recorder. */
  readonly kind: "counter" | "histogram";
  /** Low-cardinality metric labels. */
  readonly labels?: TelemetryMetricOptions["labels"] | undefined;
  /** Metric name. */
  readonly name: string;
  /** Metric unit. */
  readonly unit?: string | undefined;
  /** Metric value. */
  readonly value: number;
};

type RecordedSpan = {
  /** Attributes attached when the span ended. */
  readonly endAttributes?: TelemetrySpanEndOptions["attributes"] | undefined;
  /** Error attached when the span ended. */
  readonly error?: unknown;
  /** Span name. */
  readonly name: string;
  /** Attributes attached when the span started. */
  readonly startAttributes?: TelemetrySpanOptions["attributes"] | undefined;
  /** Span status attached when the span ended. */
  readonly status?: TelemetrySpanEndOptions["status"] | undefined;
};

describe("createLLMGateway", () => {
  it("validates structured review finding output", async () => {
    const gateway = createLLMGateway({
      generateObject: async () => ({
        findings: [
          {
            path: "src/math.ts",
            line: 2,
            severity: "medium",
            category: "correctness",
            title: "Handle non-finite values",
            body: "The changed coercion accepts NaN and Infinity.",
            evidence: ["The added line calls Number() without a finite check."],
            confidence: 0.82,
          },
        ],
      }),
    });

    await expect(gateway.generateReviewFindings({ prompt: "{}" })).resolves.toMatchObject({
      findings: [{ path: "src/math.ts", line: 2 }],
    });
  });

  it("rejects provider output that cannot become a candidate finding", async () => {
    const gateway = createLLMGateway({
      generateObject: async () => ({
        findings: [
          {
            path: "src/math.ts",
            line: 2,
            severity: "medium",
            category: "correctness",
            title: "",
            body: "The changed coercion accepts NaN and Infinity.",
            evidence: ["The added line calls Number() without a finite check."],
            confidence: 0.82,
          },
        ],
      }),
    });

    await expect(gateway.generateReviewFindings({ prompt: "{}" })).rejects.toThrow(
      /LLMFindingOutput/u,
    );
    await expect(gateway.generateReviewFindings({ prompt: "{}" })).rejects.toMatchObject({
      code: "schema_validation_failed",
      retryable: false,
    });
  });

  it("retries retryable provider failures", async () => {
    const provider = new FakeLLMProvider({
      failuresBeforeSuccess: 1,
      defaultObject: {
        findings: [
          {
            path: "src/math.ts",
            line: 2,
            severity: "medium",
            category: "correctness",
            title: "Handle non-finite values",
            body: "The changed coercion accepts NaN and Infinity.",
            evidence: ["The added line calls Number() without a finite check."],
            confidence: 0.82,
          },
        ],
      },
    });
    const gateway = createLLMGateway(provider, { retryPolicy: { maxAttempts: 2 } });

    await expect(gateway.generateReviewFindings({ prompt: "{}" })).resolves.toMatchObject({
      findings: [{ path: "src/math.ts", line: 2 }],
    });
  });

  it("does not retry non-retryable provider failures", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      id: "fake",
      generateObject: async (input) => {
        callCount += 1;
        throw new LLMGatewayError("Provider auth failed.", {
          code: "provider_auth_failed",
          provider: "fake",
          retryable: false,
          task: input.task,
        });
      },
    };
    const gateway = createLLMGateway(provider, { retryPolicy: { maxAttempts: 3 } });

    await expect(gateway.generateReviewFindings({ prompt: "{}" })).rejects.toMatchObject({
      code: "provider_auth_failed",
      retryable: false,
    });
    expect(callCount).toBe(1);
  });

  it("selects fake provider fixtures from metadata", async () => {
    const gateway = createLLMGateway(
      new FakeLLMProvider({
        fixtures: {
          finding: {
            findings: [
              {
                path: "src/string.ts",
                line: 5,
                severity: "high",
                category: "security",
                title: "Reject unsafe input",
                body: "The changed parser now trusts raw user input.",
                evidence: ["The added line passes request data directly to eval."],
                confidence: 0.9,
              },
            ],
          },
        },
      }),
    );

    await expect(
      gateway.generateReviewFindings({ prompt: "{}", metadata: { fixtureKey: "finding" } }),
    ).resolves.toMatchObject({
      findings: [{ path: "src/string.ts", line: 5 }],
    });
  });

  it("redacts secret-looking prompt content before provider calls", async () => {
    const providerPrompts: string[] = [];
    const providerMetadata: unknown[] = [];
    const gateway = createLLMGateway({
      id: "capture",
      generateObject: async (input) => {
        providerPrompts.push(input.prompt);
        providerMetadata.push(input.metadata);
        return { findings: [] };
      },
    });

    await expect(
      gateway.generateReviewFindings({
        prompt: JSON.stringify({
          changedFiles: [
            {
              path: "src/config.ts",
              hunks: [
                {
                  lines: [
                    {
                      kind: "addition",
                      newLine: 12,
                      content: "const token = 'github_pat_1234567890abcdef1234567890abcdef';",
                    },
                  ],
                },
              ],
            },
          ],
          retrievedContext: [
            {
              text: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
            },
          ],
        }),
      }),
    ).resolves.toEqual({ findings: [] });

    expect(providerPrompts).toHaveLength(1);
    expect(providerPrompts[0]).toContain("[redacted-github-token]");
    expect(providerPrompts[0]).toContain("[redacted-llm-api-key]");
    expect(providerPrompts[0]).not.toContain("github_pat_1234567890abcdef");
    expect(providerPrompts[0]).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(providerMetadata[0]).toMatchObject({
      promptRedacted: true,
      promptRedactionKinds: expect.arrayContaining(["github_token", "openai_api_key"]),
    });
  });

  it("calls OpenAI-compatible Chat Completions with JSON mode", async () => {
    const calls: RecordedFetchCall[] = [];
    const fetchFn: OpenAIChatCompletionsFetch = async (url, init) => {
      calls.push({ ...(init ? { init } : {}), url: String(url) });
      return openAIChatCompletionResponse({ findings: [] });
    };
    const gateway = createLLMGateway(
      createOpenAIChatCompletionsProvider({
        apiKey: "sk-test-openai-key",
        baseUrl: "https://llm.example/v1/",
        fetch: fetchFn,
        model: "gpt-test",
      }),
    );

    await expect(
      gateway.generateReviewFindings({
        prompt: JSON.stringify({ changedFiles: [] }),
      }),
    ).resolves.toEqual({ findings: [] });

    const call = requireFirstFetchCall(calls);
    expect(call.url).toBe("https://llm.example/v1/chat/completions");
    expect(call.init).toMatchObject({
      headers: {
        Authorization: "Bearer sk-test-openai-key",
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    const body = requestJsonBody(call);
    expect(body).toMatchObject({
      model: "gpt-test",
      n: 1,
      response_format: { type: "json_object" },
      store: false,
    });
    expect(body.messages).toEqual([
      {
        content: expect.stringContaining("JSON"),
        role: "system",
      },
      {
        content: JSON.stringify({ changedFiles: [] }),
        role: "user",
      },
    ]);
  });

  it("normalizes OpenAI-compatible HTTP errors", async () => {
    const gateway = createLLMGateway(
      createOpenAIChatCompletionsProvider({
        apiKey: "sk-test-openai-key",
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "invalid_api_key",
                message: "Invalid API key.",
                type: "invalid_request_error",
              },
            }),
            {
              headers: { "x-request-id": "req_123" },
              status: 401,
            },
          ),
        model: "gpt-test",
      }),
      { retryPolicy: { maxAttempts: 1 } },
    );

    await expect(gateway.generateReviewFindings({ prompt: "{}" })).rejects.toMatchObject({
      code: "provider_auth_failed",
      details: {
        errorCode: "invalid_api_key",
        errorType: "invalid_request_error",
        requestId: "req_123",
        status: 401,
        statusFamily: "4xx",
      },
      model: "gpt-test",
      provider: "openai",
      retryable: false,
    });
  });

  it("rejects non-JSON OpenAI message content as structured output failure", async () => {
    const gateway = createLLMGateway(
      createOpenAIChatCompletionsProvider({
        apiKey: "sk-test-openai-key",
        fetch: async () => openAIChatCompletionRawContentResponse("not-json"),
        model: "gpt-test",
      }),
    );

    await expect(gateway.generateReviewFindings({ prompt: "{}" })).rejects.toMatchObject({
      code: "schema_validation_failed",
      provider: "openai",
      retryable: false,
    });
  });

  it("records product-safe metrics and spans for successful calls", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const gateway = createLLMGateway(
      new FakeLLMProvider({
        defaultObject: {
          findings: [
            {
              path: "src/math.ts",
              line: 2,
              severity: "medium",
              category: "correctness",
              title: "Handle non-finite values",
              body: "The changed coercion accepts NaN and Infinity.",
              evidence: ["The added line calls Number() without a finite check."],
              confidence: 0.82,
            },
          ],
        },
      }),
      {
        metrics: createRecordingMetrics(metrics),
        traces: createRecordingTraces(spans),
      },
    );

    await expect(
      gateway.generateReviewFindings({
        metadata: { modelProfile: "review_strong", repoId: "repo_1" },
        prompt: "{}",
      }),
    ).resolves.toMatchObject({
      findings: [{ path: "src/math.ts", line: 2 }],
    });

    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "counter",
          labels: {
            model_profile: "review_strong",
            provider: "fake",
            status: "succeeded",
            task: "review.findings",
          },
          name: OBSERVABILITY_METRIC_NAMES.llmCallsTotal,
          value: 1,
        }),
        expect.objectContaining({
          kind: "histogram",
          labels: {
            model_profile: "review_strong",
            provider: "fake",
            status: "succeeded",
            task: "review.findings",
          },
          name: OBSERVABILITY_METRIC_NAMES.llmDurationMs,
          unit: "ms",
        }),
      ]),
    );
    expect(spans).toEqual([
      expect.objectContaining({
        endAttributes: expect.objectContaining({
          "llm.status": "succeeded",
        }),
        name: OBSERVABILITY_SPAN_NAMES.llmGenerateObject,
        startAttributes: expect.objectContaining({
          "llm.model_profile": "review_strong",
          "llm.provider": "fake",
          "llm.task": "review.findings",
        }),
        status: "ok",
      }),
    ]);
    expect(JSON.stringify(metrics)).not.toContain("repo_1");
    expect(JSON.stringify(spans)).not.toContain("repo_1");
  });

  it("records retry, rate-limit, and structured-output failure telemetry", async () => {
    const retryMetrics: RecordedMetric[] = [];
    const retryGateway = createLLMGateway(
      new FakeLLMProvider({
        failureCode: "provider_unavailable",
        failuresBeforeSuccess: 1,
      }),
      {
        metrics: createRecordingMetrics(retryMetrics),
        retryPolicy: { maxAttempts: 2 },
      },
    );

    await expect(retryGateway.generateReviewFindings({ prompt: "{}" })).resolves.toMatchObject({
      findings: [],
    });
    expect(retryMetrics).toContainEqual(
      expect.objectContaining({
        labels: {
          model_profile: "default",
          provider: "fake",
          reason: "provider_unavailable",
          task: "review.findings",
        },
        name: OBSERVABILITY_METRIC_NAMES.llmRetriesTotal,
      }),
    );

    const failedMetrics: RecordedMetric[] = [];
    const failedSpans: RecordedSpan[] = [];
    const invalidGateway = createLLMGateway(
      {
        id: "fake",
        generateObject: async () => ({
          findings: [{ path: "src/math.ts", title: "" }],
        }),
      },
      {
        metrics: createRecordingMetrics(failedMetrics),
        traces: createRecordingTraces(failedSpans),
      },
    );

    await expect(invalidGateway.generateReviewFindings({ prompt: "{}" })).rejects.toMatchObject({
      code: "schema_validation_failed",
    });
    expect(failedMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: {
            error_class: "validation_error",
            model_profile: "default",
            provider: "fake",
            status: "failed",
            task: "review.findings",
          },
          name: OBSERVABILITY_METRIC_NAMES.llmCallsTotal,
        }),
        expect.objectContaining({
          labels: {
            model_profile: "default",
            provider: "fake",
            task: "review.findings",
          },
          name: OBSERVABILITY_METRIC_NAMES.llmStructuredOutputFailuresTotal,
        }),
      ]),
    );
    expect(failedSpans).toEqual([
      expect.objectContaining({
        endAttributes: expect.objectContaining({
          "llm.error_class": "validation_error",
          "llm.status": "failed",
        }),
        status: "error",
      }),
    ]);

    const rateLimitedMetrics: RecordedMetric[] = [];
    const rateLimitedGateway = createLLMGateway(
      {
        id: "openai",
        generateObject: async (input) => {
          throw new LLMGatewayError("Rate limit exceeded.", {
            code: "provider_rate_limited",
            provider: "openai",
            retryable: false,
            task: input.task,
          });
        },
      },
      { metrics: createRecordingMetrics(rateLimitedMetrics) },
    );

    await expect(rateLimitedGateway.generateReviewFindings({ prompt: "{}" })).rejects.toMatchObject(
      {
        code: "provider_rate_limited",
      },
    );
    expect(rateLimitedMetrics).toContainEqual(
      expect.objectContaining({
        labels: {
          model_profile: "default",
          provider: "openai",
        },
        name: OBSERVABILITY_METRIC_NAMES.llmRateLimitedTotal,
      }),
    );
  });
});

type RecordedFetchCall = {
  /** Request init passed to the fake fetch implementation. */
  readonly init?: RequestInit;
  /** Request URL passed to the fake fetch implementation. */
  readonly url: string;
};

/** Creates a successful Chat Completions response with JSON-stringified assistant content. */
function openAIChatCompletionResponse(content: unknown): Response {
  return openAIChatCompletionRawContentResponse(JSON.stringify(content));
}

/** Creates a successful Chat Completions response with raw assistant content. */
function openAIChatCompletionRawContentResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content,
            role: "assistant",
          },
        },
      ],
    }),
    {
      headers: { "Content-Type": "application/json" },
      status: 200,
    },
  );
}

/** Returns the first recorded fetch call or raises a test setup failure. */
function requireFirstFetchCall(calls: readonly RecordedFetchCall[]): RecordedFetchCall {
  const call = calls[0];
  if (!call) {
    throw new Error("Expected one fetch call.");
  }

  return call;
}

/** Parses a recorded JSON request body into an object for assertions. */
function requestJsonBody(call: RecordedFetchCall): Record<string, unknown> {
  if (typeof call.init?.body !== "string") {
    throw new Error("Expected request body to be a JSON string.");
  }

  const parsed = JSON.parse(call.init.body) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Expected request body to be a JSON object.");
  }

  return parsed;
}

/** Returns whether a value is a non-null object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createRecordingMetrics(records: RecordedMetric[]): TelemetryMetricRecorder {
  return {
    count: (name, options) => {
      records.push({
        kind: "counter",
        labels: options?.labels,
        name,
        unit: options?.unit,
        value: options?.value ?? 1,
      });
    },
    gauge: () => undefined,
    histogram: (name, value, options) => {
      records.push({
        kind: "histogram",
        labels: options?.labels,
        name,
        unit: options?.unit,
        value,
      });
    },
  };
}

function createRecordingTraces(records: RecordedSpan[]): TelemetrySpanRecorder {
  return {
    startSpan: (name, options) => ({
      end: (endOptions = {}) => {
        records.push({
          endAttributes: endOptions.attributes,
          error: endOptions.error,
          name,
          startAttributes: options?.attributes,
          status: endOptions.status,
        });
        return undefined;
      },
    }),
  };
}
