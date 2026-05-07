import { describe, expect, it } from "vitest";
import {
  type BuiltEmbeddingInput,
  buildCodeChunkEmbeddingInput,
  buildEmbeddingInputBatches,
  createEmbeddingProviderFromEnvironment,
  createHashEmbeddingProvider,
  DEFAULT_EMBEDDING_DIMENSIONS,
  roughTokenEstimate,
} from "../src";

describe("createHashEmbeddingProvider", () => {
  it("matches the pgvector storage dimension by default", async () => {
    const provider = createHashEmbeddingProvider("text-embedding-3-small");
    const [vector] = await provider.embedTexts(["export const value = 1;"]);

    expect(provider.dimensions).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
    expect(vector).toHaveLength(DEFAULT_EMBEDDING_DIMENSIONS);
  });
});

describe("createEmbeddingProviderFromEnvironment", () => {
  it("creates the default local hash provider with the queued job model", async () => {
    const provider = createEmbeddingProviderFromEnvironment(
      {},
      { model: "text-embedding-3-small" },
    );
    const [vector] = await provider.embedTexts(["const value = 1;"]);

    expect(provider).toMatchObject({
      dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
      model: "text-embedding-3-small",
    });
    expect(vector).toHaveLength(DEFAULT_EMBEDDING_DIMENSIONS);
  });

  it("uses explicit local provider dimensions from environment", () => {
    const provider = createEmbeddingProviderFromEnvironment({
      EMBEDDING_DIMENSIONS: "8",
      EMBEDDING_MODEL: "fake-code-embedding",
      EMBEDDING_PROVIDER: "fake",
    });

    expect(provider).toMatchObject({
      dimensions: 8,
      model: "fake-code-embedding",
    });
  });

  it("rejects unsupported provider names", () => {
    expect(() => createEmbeddingProviderFromEnvironment({ EMBEDDING_PROVIDER: "bogus" })).toThrow(
      "Unsupported embedding provider: bogus",
    );
  });
});

describe("buildCodeChunkEmbeddingInput", () => {
  it("builds stable code chunk provider input with useful metadata", () => {
    const input = buildCodeChunkEmbeddingInput({
      chunkId: "chunk_1",
      endLine: 12,
      kind: "symbol",
      language: "typescript",
      path: "src/auth/session.ts",
      startLine: 4,
      symbolId: "sym_validateSession",
      text: "export function validateSession() {\n  return true;\n}",
    });

    expect(input).toMatchObject({
      inputId: "chunk_1",
      inputKind: "code_chunk",
      tokenEstimate: roughTokenEstimate(input.text),
      wasTruncated: false,
    });
    expect(input.text).toBe(
      [
        "language: typescript",
        "path: src/auth/session.ts",
        "symbol_id: sym_validateSession",
        "chunk_kind: symbol",
        "lines: 4-12",
        "",
        "export function validateSession() {\n  return true;\n}",
      ].join("\n"),
    );
    expect(input.inputHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("truncates oversized input while preserving the header and tail", () => {
    const input = buildCodeChunkEmbeddingInput(
      {
        chunkId: "chunk_large",
        endLine: 900,
        path: "src/large.ts",
        startLine: 1,
        text: `${"a".repeat(200)}\nTAIL_MARKER`,
      },
      { maxInputTokens: 40 },
    );

    expect(input.wasTruncated).toBe(true);
    expect(input.text).toContain("path: src/large.ts");
    expect(input.text).toContain("[...truncated...]");
    expect(input.text).toContain("TAIL_MARKER");
    expect(input.tokenEstimate).toBeLessThanOrEqual(40);
  });

  it("rejects empty chunk text", () => {
    expect(() =>
      buildCodeChunkEmbeddingInput({
        chunkId: "chunk_empty",
        endLine: 1,
        path: "src/empty.ts",
        startLine: 1,
        text: "   ",
      }),
    ).toThrow("Embedding input text cannot be empty.");
  });
});

describe("buildEmbeddingInputBatches", () => {
  it("splits provider requests by input count and token budget", () => {
    const inputs = [
      testInput("chunk_1", 10, 10),
      testInput("chunk_2", 10, 10),
      testInput("chunk_3", 10, 10),
      testInput("chunk_4", 60, 10),
    ];

    const batches = buildEmbeddingInputBatches(inputs, {
      maxCharsPerRequest: 1_000,
      maxInputsPerRequest: 2,
      maxTokensPerRequest: 50,
    });

    expect(batches.map((batch) => batch.map((input) => input.inputId))).toEqual([
      ["chunk_1", "chunk_2"],
      ["chunk_3"],
      ["chunk_4"],
    ]);
  });
});

/** Creates a minimal built embedding input for batch policy tests. */
function testInput(inputId: string, tokenEstimate: number, charCount: number): BuiltEmbeddingInput {
  return {
    inputHash: `sha256:${"a".repeat(64)}`,
    inputId,
    inputKind: "code_chunk",
    text: "x".repeat(charCount),
    tokenEstimate,
    wasTruncated: false,
  };
}
