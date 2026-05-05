import { describe, expect, it } from "vitest";
import { createHashEmbeddingProvider, DEFAULT_EMBEDDING_DIMENSIONS } from "../src";

describe("createHashEmbeddingProvider", () => {
  it("matches the pgvector storage dimension by default", async () => {
    const provider = createHashEmbeddingProvider("text-embedding-3-small");
    const [vector] = await provider.embedTexts(["export const value = 1;"]);

    expect(provider.dimensions).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
    expect(vector).toHaveLength(DEFAULT_EMBEDDING_DIMENSIONS);
  });
});
