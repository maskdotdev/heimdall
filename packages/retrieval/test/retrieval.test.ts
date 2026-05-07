import { validPullRequestSnapshotFixture } from "@repo/contracts/fixtures/pull-request.fixture";
import { createStaticRelevantMemoryRetriever, type MemoryFact } from "@repo/memory";
import { describe, expect, it } from "vitest";
import { type RetrievalIndex, retrieveContext } from "../src/index";

describe("retrieveContext", () => {
  it("returns diff context with an explicit missing-index fallback", async () => {
    const bundle = await retrieveContext({
      reviewRunId: "rrn_01HREVIEW",
      snapshot: validPullRequestSnapshotFixture,
      indexAvailable: false,
      timestamp: "2026-05-05T00:00:00.000Z",
    });

    expect(bundle.metadata).toMatchObject({
      retrievalMode: "diff_fallback",
      indexAvailable: false,
    });
    expect(bundle.items[0]).toMatchObject({
      kind: "repo_rule",
      title: "Repository index unavailable",
    });
    expect(bundle.items.some((item) => item.kind === "diff")).toBe(true);
  });

  it("validates context bundles against the shared runtime contract", async () => {
    await expect(
      retrieveContext({
        reviewRunId: "invalid-review-run-id",
        snapshot: validPullRequestSnapshotFixture,
        indexAvailable: false,
        timestamp: "2026-05-05T00:00:00.000Z",
      }),
    ).rejects.toThrow(/ContextBundle/u);
  });

  it("adds relevant memory facts as explicit context items", async () => {
    const memoryFact = {
      id: "mem_context",
      orgId: "org_1",
      repoId: validPullRequestSnapshotFixture.repoId,
      kind: "testing_convention",
      content: "Generated clients under src/generated are covered by contract tests.",
      normalizedContent: "generated clients under src/generated are covered by contract tests.",
      scope: {
        level: "repo",
        orgId: "org_1",
        repoId: validPullRequestSnapshotFixture.repoId,
      },
      appliesTo: {
        languages: ["typescript"],
        categories: ["test_coverage"],
      },
      sourceKind: "command",
      trustLevel: "explicit_maintainer",
      confidence: 0.93,
      status: "active",
      priority: 450,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-05T00:00:00.000Z",
    } satisfies MemoryFact;

    const bundle = await retrieveContext({
      reviewRunId: "rrn_01HREVIEW",
      snapshot: validPullRequestSnapshotFixture,
      indexAvailable: false,
      memory: {
        orgId: "org_1",
        retriever: createStaticRelevantMemoryRetriever([memoryFact]),
        findingCategories: ["test_coverage"],
        maxFacts: 3,
        maxTokens: 200,
      },
      timestamp: "2026-05-05T00:00:00.000Z",
    });

    expect(bundle.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "memory_fact",
          source: "memory",
          text: expect.stringContaining("Generated clients under src/generated"),
        }),
      ]),
    );
    expect(bundle.metadata).toMatchObject({
      memory: {
        includedFactIds: ["mem_context"],
        trace: [expect.objectContaining({ included: true, memoryFactId: "mem_context" })],
      },
    });
  });

  it("adds index-backed same-file, symbol, test, and similar context", async () => {
    const index: RetrievalIndex = {
      indexVersionId: "idx_123",
      getSameFileChunks: async () => [
        {
          chunkId: "chunk_same",
          symbolId: "sym_same",
          path: "src/index.ts",
          startLine: 1,
          endLine: 3,
          language: "typescript",
          contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          text: "export function run() {}",
          tokenEstimate: 6,
        },
      ],
      getSymbolsForFiles: async () => [
        {
          symbolId: "sym_same",
          fileId: "file_same",
          path: "src/index.ts",
          name: "run",
          kind: "function",
          startLine: 1,
          endLine: 1,
        },
      ],
      getRelatedChunks: async () => [],
      getRelatedTestChunks: async () => [
        {
          chunkId: "chunk_test",
          path: "src/index.test.ts",
          startLine: 1,
          endLine: 5,
          language: "typescript",
          contentHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          text: "it('runs', () => run());",
          tokenEstimate: 6,
        },
      ],
      searchSimilarChunks: async () => [
        {
          chunkId: "chunk_similar",
          path: "src/other.ts",
          startLine: 1,
          endLine: 2,
          language: "typescript",
          contentHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          text: "export function other() {}",
          tokenEstimate: 6,
          score: 1,
        },
      ],
    };

    const bundle = await retrieveContext({
      reviewRunId: "rrn_01HREVIEW",
      snapshot: validPullRequestSnapshotFixture,
      index,
      timestamp: "2026-05-05T00:00:00.000Z",
    });

    expect(bundle.metadata).toMatchObject({
      retrievalMode: "indexed_context",
      indexAvailable: true,
      indexVersionId: "idx_123",
    });
    expect(bundle.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        "same_file_context",
        "changed_symbol",
        "related_test",
        "similar_pattern",
        "diff",
      ]),
    );
  });

  it("keeps required context when optional indexed retrievers fail", async () => {
    const index: RetrievalIndex = {
      indexVersionId: "idx_123",
      getSameFileChunks: async () => [
        {
          chunkId: "chunk_same",
          symbolId: "sym_same",
          path: "src/index.ts",
          startLine: 1,
          endLine: 3,
          language: "typescript",
          contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          text: "export function run() {}",
          tokenEstimate: 6,
        },
      ],
      getSymbolsForFiles: async () => [],
      getRelatedChunks: async () => {
        throw new Error("Graph retriever unavailable.");
      },
      getRelatedTestChunks: async () => [],
      searchSimilarChunks: async () => {
        throw new Error("Semantic retriever unavailable.");
      },
    };

    const bundle = await retrieveContext({
      reviewRunId: "rrn_01HREVIEW",
      snapshot: validPullRequestSnapshotFixture,
      index,
      timestamp: "2026-05-05T00:00:00.000Z",
    });

    expect(bundle.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["same_file_context", "diff"]),
    );
    expect(bundle.metadata).toMatchObject({
      warnings: [
        expect.objectContaining({ code: "graph_retrieval_failed", retriever: "symbol-graph" }),
        expect.objectContaining({
          code: "semantic_retrieval_failed",
          retriever: "semantic-search",
        }),
      ],
    });
  });
});
