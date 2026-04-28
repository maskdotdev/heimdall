import type { ContextBundle } from "#contracts/review/context";
import type { ReviewRun } from "#contracts/review/review-run";
import { hashB, ids, now } from "./common";
import { validChangedFileFixture } from "./pull-request.fixture";

export const validContextBundleFixture = {
  schemaVersion: "context_bundle.v1",
  contextBundleId: "ctx_01HXAMPLE",
  reviewRunId: ids.reviewRunId,
  repoId: ids.repoId,
  pullRequestSnapshotId: ids.snapshotId,
  baseSha: "1111111",
  headSha: "2222222",
  changedFiles: [validChangedFileFixture],
  changedSymbols: [
    {
      symbolId: ids.symbolId,
      fileId: ids.fileId,
      path: "src/math.ts",
      name: "add",
      qualifiedName: "add",
      kind: "function",
      language: "typescript",
      changeType: "modified",
      newRange: { startLine: 1, endLine: 3 },
      diffHunkIds: ["hunk_1"],
      confidence: 0.92
    }
  ],
  items: [
    {
      contextItemId: "ctxitem_01HXAMPLE",
      kind: "same_file_context",
      source: "symbol_graph",
      title: "add function",
      snippet: {
        path: "src/math.ts",
        language: "typescript",
        range: { startLine: 1, endLine: 3 },
        text: "export function add(a: number, b: number) { return Number(a) + Number(b); }",
        contentHash: hashB,
        symbolId: ids.symbolId,
        chunkId: ids.chunkId
      },
      priority: 90,
      tokenEstimate: 22,
      provenance: {
        retriever: "fixture",
        reason: "Changed symbol context",
        relatedSymbolId: ids.symbolId,
        relatedFileId: ids.fileId
      }
    }
  ],
  tokenBudget: {
    maxTokens: 8000,
    estimatedTokens: 120
  },
  createdAt: now
} satisfies ContextBundle;

export const validReviewRunFixture = {
  reviewRunId: ids.reviewRunId,
  schemaVersion: "review_run.v1",
  repoId: ids.repoId,
  pullRequestSnapshotId: ids.snapshotId,
  pullRequestNumber: 42,
  baseSha: "1111111",
  headSha: "2222222",
  trigger: "webhook",
  status: "completed",
  startedAt: now,
  completedAt: now,
  createdAt: now,
  updatedAt: now,
  summary: "One medium-confidence finding was published.",
  artifactRefs: [
    {
      artifactId: ids.artifactId,
      kind: "context_bundle",
      uri: "s3://heimdall-artifacts/context.json",
      createdAt: now
    }
  ],
  counts: {
    candidateFindings: 1,
    validatedFindings: 1,
    publishedFindings: 1,
    rejectedFindings: 0
  }
} satisfies ReviewRun;
