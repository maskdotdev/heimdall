import { validPullRequestSnapshotFixture } from "@repo/contracts/fixtures/pull-request.fixture";
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
});
