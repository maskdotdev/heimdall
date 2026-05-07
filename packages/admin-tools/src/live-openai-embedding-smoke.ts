import { createOpenAIEmbeddingProvider } from "@repo/embedding";
import { loadSmokeEnv, optionalEnv, optionalIntegerEnv } from "./smoke-env";

/** Configuration for the guarded live OpenAI-compatible embedding smoke. */
type EmbeddingSmokeConfig = {
  /** OpenAI-compatible API key used only for this live smoke. */
  readonly apiKey: string;
  /** OpenAI-compatible API base URL. */
  readonly baseUrl: string;
  /** Optional requested embedding dimensions. */
  readonly dimensions?: number;
  /** Embedding model to request. */
  readonly model: string;
  /** Request timeout in milliseconds. */
  readonly timeoutMs: number;
};

/** Product-safe proof emitted by the live embedding smoke. */
type EmbeddingSmokeProof = {
  /** API origin host used by the smoke. */
  readonly baseUrlHost: string;
  /** Number of inputs sent to the provider. */
  readonly inputCount: number;
  /** Embedding model requested by the smoke. */
  readonly model: string;
  /** Provider identifier used by the smoke. */
  readonly provider: "openai";
  /** Status of the smoke run. */
  readonly status: "passed";
  /** Provider-reported token usage, when returned by the endpoint. */
  readonly usage?: {
    /** Input tokens reported by the provider. */
    readonly inputTokens?: number;
    /** Total tokens reported by the provider. */
    readonly totalTokens?: number;
  };
  /** Length of the vector returned by the provider. */
  readonly vectorLength: number;
};

/** Loads and validates the live embedding smoke configuration. */
function loadConfig(): EmbeddingSmokeConfig {
  loadSmokeEnv();
  if (optionalEnv("HEIMDALL_EMBEDDING_SMOKE_ALLOW_LIVE") !== "true") {
    throw new Error(
      "Set HEIMDALL_EMBEDDING_SMOKE_ALLOW_LIVE=true to run the live embedding provider smoke.",
    );
  }

  const apiKey =
    optionalEnv("HEIMDALL_EMBEDDING_PROVIDER_API_KEY") ??
    optionalEnv("OPENAI_EMBEDDING_API_KEY") ??
    optionalEnv("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error(
      "Missing embedding smoke API key: set HEIMDALL_EMBEDDING_PROVIDER_API_KEY, OPENAI_EMBEDDING_API_KEY, or OPENAI_API_KEY.",
    );
  }

  const dimensions = optionalEmbeddingDimensions();

  return {
    apiKey,
    baseUrl:
      optionalEnv("OPENAI_EMBEDDING_BASE_URL") ??
      optionalEnv("OPENAI_BASE_URL") ??
      "https://api.openai.com/v1",
    ...(dimensions ? { dimensions } : {}),
    model:
      optionalEnv("OPENAI_EMBEDDING_MODEL") ??
      optionalEnv("EMBEDDING_MODEL") ??
      "text-embedding-3-small",
    timeoutMs: optionalIntegerEnv("OPENAI_EMBEDDING_TIMEOUT_MS", 30_000),
  };
}

/** Parses an optional requested embedding dimension value. */
function optionalEmbeddingDimensions(): number | undefined {
  const value = optionalEnv("OPENAI_EMBEDDING_DIMENSIONS") ?? optionalEnv("EMBEDDING_DIMENSIONS");
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("OPENAI_EMBEDDING_DIMENSIONS must be a positive integer when set.");
  }

  return parsed;
}

/** Runs the live provider smoke and prints product-safe proof JSON. */
async function main(): Promise<void> {
  const config = loadConfig();
  const provider = createOpenAIEmbeddingProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    ...(config.dimensions ? { dimensions: config.dimensions } : {}),
    model: config.model,
    timeoutMs: config.timeoutMs,
  });
  const smokeInputs = ["Heimdall live embedding smoke input. No customer data is sent."];
  const result = provider.embedTextsWithUsage
    ? await provider.embedTextsWithUsage(smokeInputs)
    : { vectors: await provider.embedTexts(smokeInputs) };
  const [vector] = result.vectors;
  if (!vector || vector.length === 0) {
    throw new Error("Embedding provider returned no vector for the smoke input.");
  }
  if (config.dimensions && vector.length !== config.dimensions) {
    throw new Error(
      `Embedding provider returned ${vector.length} dimensions; expected ${config.dimensions}.`,
    );
  }

  const proof: EmbeddingSmokeProof = {
    baseUrlHost: new URL(config.baseUrl).host,
    inputCount: 1,
    model: config.model,
    provider: "openai",
    status: "passed",
    ...(result.usage
      ? {
          usage: {
            ...(result.usage.inputTokens !== undefined
              ? { inputTokens: result.usage.inputTokens }
              : {}),
            ...(result.usage.totalTokens !== undefined
              ? { totalTokens: result.usage.totalTokens }
              : {}),
          },
        }
      : {}),
    vectorLength: vector.length,
  };

  console.log(JSON.stringify(proof, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
