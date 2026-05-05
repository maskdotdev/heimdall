import { type LLMFindingOutput, LLMFindingOutputSchema } from "@repo/contracts/review/finding";
import { parseWithSchema } from "@repo/contracts/validation/parse";
import type { Static, TSchema } from "@sinclair/typebox";

/** Task names supported by the gateway MVP. */
export type LLMTask = "review.findings";

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

/** Creates a schema-validating LLM gateway around an injected provider adapter. */
export function createLLMGateway(provider: LLMProvider): LLMGateway {
  return {
    generateObject: async (input) => {
      const output = await provider.generateObject(input);
      return parseWithSchema(input.schemaName, input.schema, output);
    },
    generateReviewFindings: async (input) =>
      parseWithSchema(
        "LLMFindingOutput",
        LLMFindingOutputSchema,
        await provider.generateObject({
          task: "review.findings",
          schema: LLMFindingOutputSchema,
          schemaName: "LLMFindingOutput",
          system:
            "You are a code review pass. Return only concrete, actionable findings anchored to changed diff lines.",
          prompt: input.prompt,
          ...(input.metadata ? { metadata: input.metadata } : {}),
        }),
      ),
  };
}

/** Creates a deterministic gateway for tests and local no-provider execution. */
export function createStaticLLMGateway(output: LLMFindingOutput = { findings: [] }): LLMGateway {
  return createLLMGateway({
    generateObject: async <TSchemaValue extends TSchema>() => output as Static<TSchemaValue>,
  });
}
