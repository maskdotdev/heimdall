import { createHash } from "node:crypto";
import type { ChangedFile } from "@repo/contracts/pull-request/diff";
import type { PullRequestSnapshot } from "@repo/contracts/pull-request/pull-request";
import type { ContextBundle, ContextItem } from "@repo/contracts/review/context";

/** Input used to retrieve review context for a pull request snapshot. */
export type RetrieveContextInput = {
  /** Stable review run ID that owns the context bundle. */
  readonly reviewRunId: string;
  /** Pull request snapshot used to build diff-grounded context. */
  readonly snapshot: PullRequestSnapshot;
  /** Whether a repository index is available for richer retrieval. */
  readonly indexAvailable?: boolean;
  /** Maximum estimated tokens allowed in the returned context bundle. */
  readonly maxTokens?: number;
  /** Timestamp used for deterministic tests. */
  readonly timestamp?: string;
};

/** Retrieves a compact context bundle, falling back to diff context when indexes are missing. */
export async function retrieveContext(input: RetrieveContextInput): Promise<ContextBundle> {
  const maxTokens = input.maxTokens ?? 8000;
  const timestamp = input.timestamp ?? new Date().toISOString();
  const diffItems = input.snapshot.changedFiles.flatMap((file) => contextItemsForFile(file));
  const items = packItems(
    input.indexAvailable === false ? withFallbackRule(diffItems) : diffItems,
    maxTokens,
  );

  return {
    schemaVersion: "context_bundle.v1",
    contextBundleId: stableId("ctx", [
      input.reviewRunId,
      input.snapshot.snapshotId,
      input.indexAvailable === false ? "diff-fallback" : "indexed",
    ]),
    reviewRunId: input.reviewRunId,
    repoId: input.snapshot.repoId,
    pullRequestSnapshotId: input.snapshot.snapshotId,
    baseSha: input.snapshot.baseSha,
    headSha: input.snapshot.headSha,
    changedFiles: input.snapshot.changedFiles,
    changedSymbols: [],
    items: [...items],
    tokenBudget: {
      maxTokens,
      estimatedTokens: items.reduce((total, item) => total + item.tokenEstimate, 0),
    },
    createdAt: timestamp,
    metadata: {
      retrievalMode: input.indexAvailable === false ? "diff_fallback" : "indexed_context",
      indexAvailable: input.indexAvailable !== false,
    },
  };
}

function contextItemsForFile(file: ChangedFile): readonly ContextItem[] {
  if (file.isBinary || file.status === "deleted") {
    return [];
  }

  return file.hunks.map((hunk, index) => {
    const text = hunk.lines.map((line) => `${prefixForLine(line.kind)}${line.content}`).join("\n");
    const startLine = hunk.lines.find((line) => line.newLine)?.newLine ?? hunk.newStart;
    const endLine =
      [...hunk.lines].reverse().find((line) => line.newLine)?.newLine ??
      Math.max(startLine, hunk.newStart + hunk.newLines - 1);

    return {
      contextItemId: stableId("ctxitem", [file.path, hunk.hunkId, index]),
      kind: "diff",
      source: "diff",
      title: `${file.path}:${startLine}`,
      summary: hunk.header,
      snippet: {
        path: file.path,
        language: file.language,
        range: { startLine: Math.max(1, startLine), endLine: Math.max(1, endLine) },
        text,
        ...(file.newContentHash ? { contentHash: file.newContentHash } : {}),
      },
      priority: file.isTest ? 55 : 80,
      tokenEstimate: estimateTokens(text),
      provenance: {
        retriever: "diff-context",
        reason: "Changed diff hunk included for review grounding.",
      },
      metadata: {
        hunkId: hunk.hunkId,
        status: file.status,
        isGenerated: file.isGenerated,
        isTest: file.isTest,
      },
    };
  });
}

function withFallbackRule(items: readonly ContextItem[]): readonly ContextItem[] {
  return [
    {
      contextItemId: stableId("ctxitem", ["retrieval", "missing-index"]),
      kind: "repo_rule",
      source: "repo_rule",
      title: "Repository index unavailable",
      text: "No repository index was available. Review passes must rely on pull request diff context only.",
      priority: 100,
      tokenEstimate: 18,
      provenance: {
        retriever: "diff-fallback",
        reason: "Clean fallback when indexed retrieval is unavailable.",
      },
      metadata: { suppressSpeculativeContextClaims: true },
    },
    ...items,
  ];
}

function packItems(items: readonly ContextItem[], maxTokens: number): readonly ContextItem[] {
  const packed: ContextItem[] = [];
  let usedTokens = 0;

  for (const item of [...items].sort((left, right) => right.priority - left.priority)) {
    if (usedTokens + item.tokenEstimate > maxTokens) {
      continue;
    }
    packed.push(item);
    usedTokens += item.tokenEstimate;
  }

  return packed;
}

function prefixForLine(kind: "context" | "addition" | "deletion"): string {
  return kind === "addition" ? "+" : kind === "deletion" ? "-" : " ";
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function stableId(prefix: string, parts: readonly unknown[]): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26);

  return `${prefix}_${hash}`;
}
