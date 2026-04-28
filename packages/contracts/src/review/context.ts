import { type Static, Type } from "@sinclair/typebox";
import { CodeLanguageSchema } from "../enums/language";
import { ContentHashSchema } from "../primitives/hashes";
import {
  ChunkIdSchema,
  FileIdSchema,
  PullRequestSnapshotIdSchema,
  RepoIdSchema,
  ReviewRunIdSchema,
  SymbolIdSchema,
} from "../primitives/ids";
import { RepoPathSchema } from "../primitives/paths";
import { LineRangeSchema } from "../primitives/ranges";
import { IsoDateTimeSchema } from "../primitives/time";
import { ChangedSymbolSchema } from "../pull-request/changed-symbol";
import { ChangedFileSchema } from "../pull-request/diff";
import { GitCommitShaSchema } from "../pull-request/pull-request";

export const ContextItemKindSchema = Type.Union([
  Type.Literal("diff"),
  Type.Literal("changed_symbol"),
  Type.Literal("same_file_context"),
  Type.Literal("dependency"),
  Type.Literal("caller"),
  Type.Literal("callee"),
  Type.Literal("related_test"),
  Type.Literal("similar_pattern"),
  Type.Literal("config"),
  Type.Literal("documentation"),
  Type.Literal("repo_rule"),
  Type.Literal("memory_fact"),
  Type.Literal("static_analysis"),
]);
export type ContextItemKind = Static<typeof ContextItemKindSchema>;

export const ContextItemSourceSchema = Type.Union([
  Type.Literal("diff"),
  Type.Literal("symbol_graph"),
  Type.Literal("vector_search"),
  Type.Literal("static_analysis"),
  Type.Literal("repo_rule"),
  Type.Literal("memory"),
  Type.Literal("manual"),
]);
export type ContextItemSource = Static<typeof ContextItemSourceSchema>;

export const CodeSnippetSchema = Type.Object(
  {
    path: RepoPathSchema,
    language: CodeLanguageSchema,
    range: LineRangeSchema,
    text: Type.String(),
    contentHash: Type.Optional(ContentHashSchema),
    symbolId: Type.Optional(SymbolIdSchema),
    chunkId: Type.Optional(ChunkIdSchema),
  },
  { additionalProperties: false },
);
export type CodeSnippet = Static<typeof CodeSnippetSchema>;

export const ContextItemSchema = Type.Object(
  {
    contextItemId: Type.String({ pattern: "^ctxitem_[A-Za-z0-9_-]+$" }),
    kind: ContextItemKindSchema,
    source: ContextItemSourceSchema,
    title: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
    snippet: Type.Optional(CodeSnippetSchema),
    text: Type.Optional(Type.String()),
    score: Type.Optional(Type.Number()),
    priority: Type.Integer({ minimum: 0, maximum: 100 }),
    tokenEstimate: Type.Integer({ minimum: 0 }),
    provenance: Type.Object(
      {
        retriever: Type.String(),
        reason: Type.String(),
        query: Type.Optional(Type.String()),
        relatedSymbolId: Type.Optional(SymbolIdSchema),
        relatedFileId: Type.Optional(FileIdSchema),
      },
      { additionalProperties: false },
    ),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type ContextItem = Static<typeof ContextItemSchema>;

export const ContextBundleSchema = Type.Object(
  {
    schemaVersion: Type.Literal("context_bundle.v1"),
    contextBundleId: Type.String({ pattern: "^ctx_[A-Za-z0-9_-]+$" }),
    reviewRunId: ReviewRunIdSchema,
    repoId: RepoIdSchema,
    pullRequestSnapshotId: PullRequestSnapshotIdSchema,
    baseSha: GitCommitShaSchema,
    headSha: GitCommitShaSchema,
    changedFiles: Type.Array(ChangedFileSchema),
    changedSymbols: Type.Array(ChangedSymbolSchema),
    items: Type.Array(ContextItemSchema),
    tokenBudget: Type.Object(
      {
        maxTokens: Type.Integer({ minimum: 1 }),
        estimatedTokens: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    createdAt: IsoDateTimeSchema,
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type ContextBundle = Static<typeof ContextBundleSchema>;
