import { type Static, Type } from "@sinclair/typebox";
import { CodeEdgeKindSchema, SymbolKindSchema } from "../enums/index";
import { CodeLanguageSchema } from "../enums/language";
import { ContentHashSchema } from "../primitives/hashes";
import {
  ChunkIdSchema,
  DiagnosticIdSchema,
  EdgeIdSchema,
  FileIdSchema,
  RepoIdSchema,
  SymbolIdSchema,
} from "../primitives/ids";
import { RepoPathSchema } from "../primitives/paths";
import { LineRangeSchema } from "../primitives/ranges";
import { GitCommitShaSchema } from "../pull-request/pull-request";

export const FileRecordSchema = Type.Object(
  {
    type: Type.Literal("file"),
    schemaVersion: Type.Literal("index_record.file.v1"),
    fileId: FileIdSchema,
    repoId: RepoIdSchema,
    commitSha: GitCommitShaSchema,
    path: RepoPathSchema,
    language: CodeLanguageSchema,
    contentHash: ContentHashSchema,
    sizeBytes: Type.Integer({ minimum: 0 }),
    lineCount: Type.Integer({ minimum: 0 }),
    isBinary: Type.Boolean(),
    isGenerated: Type.Boolean(),
    isTest: Type.Boolean(),
    isVendored: Type.Boolean(),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type FileRecord = Static<typeof FileRecordSchema>;

export const SymbolVisibilitySchema = Type.Union([
  Type.Literal("public"),
  Type.Literal("protected"),
  Type.Literal("private"),
  Type.Literal("internal"),
  Type.Literal("unknown"),
]);
export type SymbolVisibility = Static<typeof SymbolVisibilitySchema>;

export const SymbolRecordSchema = Type.Object(
  {
    type: Type.Literal("symbol"),
    schemaVersion: Type.Literal("index_record.symbol.v1"),
    symbolId: SymbolIdSchema,
    fileId: FileIdSchema,
    repoId: RepoIdSchema,
    commitSha: GitCommitShaSchema,
    path: RepoPathSchema,
    language: CodeLanguageSchema,
    name: Type.String(),
    qualifiedName: Type.Optional(Type.String()),
    kind: SymbolKindSchema,
    range: LineRangeSchema,
    selectionRange: Type.Optional(LineRangeSchema),
    signature: Type.Optional(Type.String()),
    docstring: Type.Optional(Type.String()),
    visibility: Type.Optional(SymbolVisibilitySchema),
    contentHash: ContentHashSchema,
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type SymbolRecord = Static<typeof SymbolRecordSchema>;

export const IndexNodeKindSchema = Type.Union([
  Type.Literal("file"),
  Type.Literal("symbol"),
  Type.Literal("chunk"),
  Type.Literal("external"),
]);
export type IndexNodeKind = Static<typeof IndexNodeKindSchema>;

export const EdgeRecordSchema = Type.Object(
  {
    type: Type.Literal("edge"),
    schemaVersion: Type.Literal("index_record.edge.v1"),
    edgeId: EdgeIdSchema,
    repoId: RepoIdSchema,
    commitSha: GitCommitShaSchema,
    fromId: Type.String(),
    toId: Type.String(),
    fromKind: IndexNodeKindSchema,
    toKind: IndexNodeKindSchema,
    kind: CodeEdgeKindSchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type EdgeRecord = Static<typeof EdgeRecordSchema>;

export const ChunkKindSchema = Type.Union([
  Type.Literal("file"),
  Type.Literal("symbol"),
  Type.Literal("symbol_part"),
  Type.Literal("documentation"),
  Type.Literal("config"),
  Type.Literal("test"),
  Type.Literal("unknown"),
]);
export type ChunkKind = Static<typeof ChunkKindSchema>;

export const ChunkRecordSchema = Type.Object(
  {
    type: Type.Literal("chunk"),
    schemaVersion: Type.Literal("index_record.chunk.v1"),
    chunkId: ChunkIdSchema,
    fileId: FileIdSchema,
    symbolId: Type.Optional(SymbolIdSchema),
    repoId: RepoIdSchema,
    commitSha: GitCommitShaSchema,
    path: RepoPathSchema,
    language: CodeLanguageSchema,
    range: LineRangeSchema,
    kind: ChunkKindSchema,
    text: Type.String(),
    contentHash: ContentHashSchema,
    tokenEstimate: Type.Integer({ minimum: 0 }),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type ChunkRecord = Static<typeof ChunkRecordSchema>;

export const DiagnosticSeveritySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("warning"),
  Type.Literal("error"),
]);
export type DiagnosticSeverity = Static<typeof DiagnosticSeveritySchema>;

export const DiagnosticRecordSchema = Type.Object(
  {
    type: Type.Literal("diagnostic"),
    schemaVersion: Type.Literal("index_record.diagnostic.v1"),
    diagnosticId: DiagnosticIdSchema,
    repoId: RepoIdSchema,
    commitSha: GitCommitShaSchema,
    path: Type.Optional(RepoPathSchema),
    range: Type.Optional(LineRangeSchema),
    source: Type.String(),
    severity: DiagnosticSeveritySchema,
    code: Type.Optional(Type.String()),
    message: Type.String(),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type DiagnosticRecord = Static<typeof DiagnosticRecordSchema>;

export const DependencyTypeSchema = Type.Union([
  Type.Literal("prod"),
  Type.Literal("dev"),
  Type.Literal("peer"),
  Type.Literal("optional"),
  Type.Literal("unknown"),
]);
export type DependencyType = Static<typeof DependencyTypeSchema>;

export const DependencyRecordSchema = Type.Object(
  {
    type: Type.Literal("dependency"),
    schemaVersion: Type.Literal("index_record.dependency.v1"),
    dependencyId: Type.String(),
    repoId: RepoIdSchema,
    commitSha: GitCommitShaSchema,
    manifestPath: RepoPathSchema,
    packageManager: Type.Optional(Type.String()),
    name: Type.String(),
    versionSpec: Type.Optional(Type.String()),
    resolvedVersion: Type.Optional(Type.String()),
    dependencyType: Type.Optional(DependencyTypeSchema),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type DependencyRecord = Static<typeof DependencyRecordSchema>;

export const RouteRecordSchema = Type.Object(
  {
    type: Type.Literal("route"),
    schemaVersion: Type.Literal("index_record.route.v1"),
    routeId: Type.String(),
    repoId: RepoIdSchema,
    commitSha: GitCommitShaSchema,
    path: RepoPathSchema,
    language: CodeLanguageSchema,
    routePattern: Type.String(),
    methods: Type.Array(Type.String()),
    handlerSymbolId: Type.Optional(SymbolIdSchema),
    range: Type.Optional(LineRangeSchema),
    framework: Type.Optional(Type.String()),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type RouteRecord = Static<typeof RouteRecordSchema>;

export const TestMappingRecordSchema = Type.Object(
  {
    type: Type.Literal("test_mapping"),
    schemaVersion: Type.Literal("index_record.test_mapping.v1"),
    testMappingId: Type.String(),
    repoId: RepoIdSchema,
    commitSha: GitCommitShaSchema,
    testFileId: FileIdSchema,
    targetFileId: Type.Optional(FileIdSchema),
    targetSymbolId: Type.Optional(SymbolIdSchema),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type TestMappingRecord = Static<typeof TestMappingRecordSchema>;

export const IndexRecordSchema = Type.Union([
  FileRecordSchema,
  SymbolRecordSchema,
  EdgeRecordSchema,
  ChunkRecordSchema,
  DiagnosticRecordSchema,
  DependencyRecordSchema,
  RouteRecordSchema,
  TestMappingRecordSchema,
]);
export type IndexRecord = Static<typeof IndexRecordSchema>;

export function isSupportedIndexRecordVersion(
  record: Pick<IndexRecord, "type" | "schemaVersion">,
): boolean {
  switch (record.type) {
    case "file":
      return record.schemaVersion === "index_record.file.v1";
    case "symbol":
      return record.schemaVersion === "index_record.symbol.v1";
    case "edge":
      return record.schemaVersion === "index_record.edge.v1";
    case "chunk":
      return record.schemaVersion === "index_record.chunk.v1";
    case "diagnostic":
      return record.schemaVersion === "index_record.diagnostic.v1";
    case "dependency":
      return record.schemaVersion === "index_record.dependency.v1";
    case "route":
      return record.schemaVersion === "index_record.route.v1";
    case "test_mapping":
      return record.schemaVersion === "index_record.test_mapping.v1";
    default:
      return false;
  }
}
