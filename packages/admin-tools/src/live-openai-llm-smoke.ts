import { createLLMGateway, createOpenAIChatCompletionsProvider } from "@repo/llm-gateway";
import { loadSmokeEnv, optionalEnv } from "./smoke-env";

const LLM_SMOKE_PROMPT = [
  "Controlled live smoke fixture. No customer code or secrets are included.",
  "",
  "Review this no-op diff:",
  "```diff",
  "diff --git a/smoke.ts b/smoke.ts",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 1;",
  "```",
  "",
  'Return {"findings":[]} if there is no actionable issue.',
].join("\n");

/** Configuration for the guarded live OpenAI-compatible LLM smoke. */
type LlmSmokeConfig = {
  /** OpenAI-compatible API key used only for this live smoke. */
  readonly apiKey: string;
  /** OpenAI-compatible API base URL. */
  readonly baseUrl: string;
  /** Maximum completion tokens requested from the provider. */
  readonly maxCompletionTokens: number;
  /** Review model to request. */
  readonly model: string;
  /** Optional OpenAI organization header value. */
  readonly organization?: string;
  /** Optional OpenAI project header value. */
  readonly project?: string;
  /** Request timeout in milliseconds. */
  readonly timeoutMs: number;
};

/** Product-safe proof emitted by the live LLM smoke. */
type LlmSmokeProof = {
  /** API origin host used by the smoke. */
  readonly baseUrlHost: string;
  /** Number of schema-valid findings returned by the provider. */
  readonly findingCount: number;
  /** LLM model requested by the smoke. */
  readonly model: string;
  /** Provider identifier used by the smoke. */
  readonly provider: "openai";
  /** Schema validated by the gateway. */
  readonly schemaName: "LLMFindingOutput";
  /** Status of the smoke run. */
  readonly status: "passed";
  /** Gateway task exercised by the smoke. */
  readonly task: "review.findings";
};

/** Loads and validates the live LLM smoke configuration. */
function loadConfig(): LlmSmokeConfig {
  loadSmokeEnv();
  if (optionalEnv("HEIMDALL_LLM_SMOKE_ALLOW_LIVE") !== "true") {
    throw new Error("Set HEIMDALL_LLM_SMOKE_ALLOW_LIVE=true to run the live LLM provider smoke.");
  }

  const apiKey =
    optionalEnv("HEIMDALL_LLM_PROVIDER_API_KEY") ??
    optionalEnv("LLM_PROVIDER_API_KEY") ??
    optionalEnv("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error(
      "Missing LLM smoke API key: set HEIMDALL_LLM_PROVIDER_API_KEY, LLM_PROVIDER_API_KEY, or OPENAI_API_KEY.",
    );
  }

  const model =
    optionalEnv("HEIMDALL_LLM_SMOKE_MODEL") ??
    optionalEnv("HEIMDALL_LLM_MODEL") ??
    optionalEnv("LLM_MODEL") ??
    optionalEnv("OPENAI_MODEL");
  if (!model) {
    throw new Error(
      "Missing LLM smoke model: set HEIMDALL_LLM_SMOKE_MODEL, HEIMDALL_LLM_MODEL, LLM_MODEL, or OPENAI_MODEL.",
    );
  }

  const organization = optionalEnv("OPENAI_ORGANIZATION");
  const project = optionalEnv("OPENAI_PROJECT");

  return {
    apiKey,
    baseUrl:
      optionalEnv("HEIMDALL_LLM_BASE_URL") ??
      optionalEnv("LLM_PROVIDER_BASE_URL") ??
      optionalEnv("OPENAI_BASE_URL") ??
      "https://api.openai.com/v1",
    maxCompletionTokens: firstOptionalIntegerEnv(
      ["HEIMDALL_LLM_SMOKE_MAX_COMPLETION_TOKENS", "OPENAI_LLM_MAX_COMPLETION_TOKENS"],
      128,
    ),
    model,
    ...(organization ? { organization } : {}),
    ...(project ? { project } : {}),
    timeoutMs: firstOptionalIntegerEnv(
      ["HEIMDALL_LLM_TIMEOUT_MS", "LLM_PROVIDER_TIMEOUT_MS", "OPENAI_TIMEOUT_MS"],
      30_000,
    ),
  };
}

/** Returns the first positive integer configured by environment variable name. */
function firstOptionalIntegerEnv(names: readonly string[], fallback: number): number {
  for (const name of names) {
    const value = optionalEnv(name);
    if (!value) {
      continue;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`${name} must be a positive integer when set.`);
    }
    return parsed;
  }

  return fallback;
}

/** Runs the live provider smoke and prints product-safe proof JSON. */
async function main(): Promise<void> {
  const config = loadConfig();
  const provider = createOpenAIChatCompletionsProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    maxCompletionTokens: config.maxCompletionTokens,
    model: config.model,
    ...(config.organization ? { organization: config.organization } : {}),
    ...(config.project ? { project: config.project } : {}),
    temperature: 0,
    timeoutMs: config.timeoutMs,
  });
  const gateway = createLLMGateway(provider, {
    defaultModelProfile: "live-smoke",
    retryPolicy: { maxAttempts: 1 },
  });
  const output = await gateway.generateReviewFindings({
    metadata: {
      fixtureKey: "live-openai-llm-smoke",
      modelProfile: "live-smoke",
      smoke: true,
    },
    prompt: LLM_SMOKE_PROMPT,
  });

  if (!Array.isArray(output.findings)) {
    throw new Error("LLM provider returned an invalid findings collection.");
  }

  const proof: LlmSmokeProof = {
    baseUrlHost: new URL(config.baseUrl).host,
    findingCount: output.findings.length,
    model: config.model,
    provider: "openai",
    schemaName: "LLMFindingOutput",
    status: "passed",
    task: "review.findings",
  };

  console.log(JSON.stringify(proof, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
