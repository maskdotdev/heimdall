import { type Static, Type } from "@sinclair/typebox";

export const packageName = "@repo/index-schema" as const;

export const INDEX_ARTIFACT_SCHEMA_VERSION = "index_artifact.v1" as const;
export const INDEX_RECORD_SCHEMA_VERSION = "index_record.v1" as const;

export const RepoPathSchema = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: "^(?!/)(?!.*\\.\\./)(?!.*\\\\).+$",
});
export type RepoPath = Static<typeof RepoPathSchema>;

export const Sha256Schema = Type.String({
  pattern: "^sha256:[a-f0-9]{64}$",
});
export type Sha256 = Static<typeof Sha256Schema>;

export const ContentHashSchema = Sha256Schema;
export type ContentHash = Sha256;

export const ArtifactIdSchema = Type.String({ pattern: "^art_[A-Za-z0-9_-]+$" });
export type ArtifactId = Static<typeof ArtifactIdSchema>;

export const ChunkIdSchema = Type.String({ pattern: "^chunk_[A-Za-z0-9_-]+$" });
export type ChunkId = Static<typeof ChunkIdSchema>;

export const DiagnosticIdSchema = Type.String({ pattern: "^diag_[A-Za-z0-9_-]+$" });
export type DiagnosticId = Static<typeof DiagnosticIdSchema>;

export const EdgeIdSchema = Type.String({ pattern: "^edge_[A-Za-z0-9_-]+$" });
export type EdgeId = Static<typeof EdgeIdSchema>;

export const FileIdSchema = Type.String({ pattern: "^file_[A-Za-z0-9_-]+$" });
export type FileId = Static<typeof FileIdSchema>;

export const IndexVersionIdSchema = Type.String({ pattern: "^idx_[A-Za-z0-9_-]+$" });
export type IndexVersionId = Static<typeof IndexVersionIdSchema>;

export const RepoIdSchema = Type.String({ pattern: "^repo_[A-Za-z0-9_-]+$" });
export type RepoId = Static<typeof RepoIdSchema>;

export const SymbolIdSchema = Type.String({ pattern: "^sym_[A-Za-z0-9_-]+$" });
export type SymbolId = Static<typeof SymbolIdSchema>;

export const GitCommitShaSchema = Type.String({ minLength: 7, maxLength: 64 });
export type GitCommitSha = Static<typeof GitCommitShaSchema>;

export const IsoDateTimeSchema = Type.String({ format: "date-time" });
export type IsoDateTime = Static<typeof IsoDateTimeSchema>;

export const LineRangeSchema = Type.Object(
  {
    startLine: Type.Integer({ minimum: 1 }),
    endLine: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type LineRange = Static<typeof LineRangeSchema>;

export const CodeLanguageSchema = Type.Union([
  Type.Literal("typescript"),
  Type.Literal("javascript"),
  Type.Literal("tsx"),
  Type.Literal("jsx"),
  Type.Literal("python"),
  Type.Literal("go"),
  Type.Literal("rust"),
  Type.Literal("java"),
  Type.Literal("kotlin"),
  Type.Literal("csharp"),
  Type.Literal("cpp"),
  Type.Literal("c"),
  Type.Literal("ruby"),
  Type.Literal("php"),
  Type.Literal("swift"),
  Type.Literal("unknown"),
]);
export type CodeLanguage = Static<typeof CodeLanguageSchema>;

export const SymbolKindSchema = Type.Union([
  Type.Literal("module"),
  Type.Literal("namespace"),
  Type.Literal("class"),
  Type.Literal("interface"),
  Type.Literal("type"),
  Type.Literal("enum"),
  Type.Literal("function"),
  Type.Literal("method"),
  Type.Literal("constructor"),
  Type.Literal("property"),
  Type.Literal("variable"),
  Type.Literal("constant"),
  Type.Literal("route"),
  Type.Literal("component"),
  Type.Literal("hook"),
  Type.Literal("unknown"),
]);
export type SymbolKind = Static<typeof SymbolKindSchema>;

export const CodeEdgeKindSchema = Type.Union([
  Type.Literal("imports"),
  Type.Literal("exports"),
  Type.Literal("calls"),
  Type.Literal("references"),
  Type.Literal("defines"),
  Type.Literal("extends"),
  Type.Literal("implements"),
  Type.Literal("tests"),
  Type.Literal("configures"),
  Type.Literal("routes_to"),
  Type.Literal("reads"),
  Type.Literal("writes"),
  Type.Literal("uses_type"),
  Type.Literal("unknown"),
]);
export type CodeEdgeKind = Static<typeof CodeEdgeKindSchema>;

export const IndexManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(INDEX_ARTIFACT_SCHEMA_VERSION),
    recordSchemaVersion: Type.Literal(INDEX_RECORD_SCHEMA_VERSION),
    artifactId: ArtifactIdSchema,
    repoId: RepoIdSchema,
    commitSha: GitCommitShaSchema,
    indexerName: Type.String(),
    indexerVersion: Type.String(),
    chunkerVersion: Type.String(),
    generatedAt: IsoDateTimeSchema,
    languages: Type.Array(CodeLanguageSchema),
    recordCount: Type.Integer({ minimum: 0 }),
    fileCount: Type.Integer({ minimum: 0 }),
    symbolCount: Type.Integer({ minimum: 0 }),
    edgeCount: Type.Integer({ minimum: 0 }),
    chunkCount: Type.Integer({ minimum: 0 }),
    parserVersions: Type.Record(Type.String(), Type.String()),
    previousIndexId: Type.Optional(IndexVersionIdSchema),
    artifactHash: Type.Optional(Sha256Schema),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type IndexManifest = Static<typeof IndexManifestSchema>;

export function isSupportedIndexManifestVersion(version: string): boolean {
  return version === INDEX_ARTIFACT_SCHEMA_VERSION;
}

export const FileRecordSchema = Type.Object(
  {
    type: Type.Literal("file"),
    schemaVersion: Type.Literal(INDEX_RECORD_SCHEMA_VERSION),
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
    schemaVersion: Type.Literal(INDEX_RECORD_SCHEMA_VERSION),
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
    schemaVersion: Type.Literal(INDEX_RECORD_SCHEMA_VERSION),
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
    schemaVersion: Type.Literal(INDEX_RECORD_SCHEMA_VERSION),
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
    schemaVersion: Type.Literal(INDEX_RECORD_SCHEMA_VERSION),
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
    schemaVersion: Type.Literal(INDEX_RECORD_SCHEMA_VERSION),
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
    schemaVersion: Type.Literal(INDEX_RECORD_SCHEMA_VERSION),
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
    schemaVersion: Type.Literal(INDEX_RECORD_SCHEMA_VERSION),
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

export function isSupportedIndexRecordVersion(record: Pick<IndexRecord, "schemaVersion">): boolean {
  return record.schemaVersion === INDEX_RECORD_SCHEMA_VERSION;
}
