import { FormatRegistry, type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const packageName = "@repo/index-schema" as const;

export const INDEX_ARTIFACT_SCHEMA_VERSION = "index_artifact.v1" as const;
export const INDEX_RECORD_SCHEMA_VERSION = "index_record.v1" as const;
export const INDEX_MANIFEST_FILE_NAME = "index-manifest.json" as const;
export const INDEX_RECORDS_FILE_NAME = "records.jsonl" as const;

/** Required manifest features that this package can safely read and validate. */
export const SUPPORTED_INDEX_ARTIFACT_FEATURES = [
  "record_ordering.v1",
  "repo_paths.posix.v1",
  "stable_ids.v1",
] as const;

/** Manifest feature value known to this version of the artifact schema. */
export type SupportedIndexArtifactFeature = (typeof SUPPORTED_INDEX_ARTIFACT_FEATURES)[number];

const DATE_TIME_FORMAT = "date-time";

if (!FormatRegistry.Has(DATE_TIME_FORMAT)) {
  FormatRegistry.Set(DATE_TIME_FORMAT, (value) => !Number.isNaN(Date.parse(value)));
}

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
    requiredFeatures: Type.Optional(Type.Array(Type.String())),
    optionalFeatures: Type.Optional(Type.Array(Type.String())),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type IndexManifest = Static<typeof IndexManifestSchema>;

export function isSupportedIndexManifestVersion(version: string): boolean {
  return version === INDEX_ARTIFACT_SCHEMA_VERSION;
}

/** Returns whether a required manifest feature is supported by this schema package. */
export function isSupportedIndexArtifactFeature(
  feature: string,
): feature is SupportedIndexArtifactFeature {
  return SUPPORTED_INDEX_ARTIFACT_FEATURES.includes(feature as SupportedIndexArtifactFeature);
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

export const IndexArtifactSchema = Type.Object(
  {
    manifest: IndexManifestSchema,
    records: Type.Array(IndexRecordSchema),
  },
  { additionalProperties: false },
);
export type IndexArtifact = Static<typeof IndexArtifactSchema>;

/** Read-only artifact shape accepted by serialization and diff helper APIs. */
export type IndexArtifactInput = {
  /** Artifact manifest. */
  readonly manifest: IndexManifest;
  /** Artifact records in canonical order. */
  readonly records: readonly IndexRecord[];
};

export function isSupportedIndexRecordVersion(record: { readonly schemaVersion: string }): boolean {
  return record.schemaVersion === INDEX_RECORD_SCHEMA_VERSION;
}

/** Optional safety limits used while parsing line-oriented artifact records. */
export type IndexJsonlRecordLimits = {
  /** Maximum UTF-8 bytes allowed for one JSONL record line. */
  readonly maxRecordBytes?: number;
  /** Maximum record count allowed in one JSONL stream. */
  readonly maxRecords?: number;
};

/** Options for parsing newline-delimited index records. */
export type ParseIndexRecordsJsonlOptions = {
  /** Optional record count and byte limits. */
  readonly limits?: IndexJsonlRecordLimits;
};

/** Options for rendering a whole-artifact JSON document. */
export type StringifyIndexArtifactJsonOptions = {
  /** Whether to render human-readable two-space JSON. */
  readonly pretty?: boolean;
};

/** Product-safe manifest field delta for two index artifacts. */
export type IndexArtifactManifestChange = {
  /** Manifest field that changed. */
  readonly field: string;
  /** Baseline artifact value for the field. */
  readonly baselineValue: unknown;
  /** Candidate artifact value for the field. */
  readonly candidateValue: unknown;
};

/** Stable record reference used by artifact diff summaries. */
export type IndexArtifactRecordDiff = {
  /** Stable record identity in the form type:id. */
  readonly identity: string;
  /** Artifact record type. */
  readonly recordType: IndexRecord["type"];
};

/** Changed record entry that keeps both record values for focused debugging. */
export type IndexArtifactChangedRecordDiff = IndexArtifactRecordDiff & {
  /** Baseline record value. */
  readonly baselineRecord: IndexRecord;
  /** Candidate record value. */
  readonly candidateRecord: IndexRecord;
};

/** Aggregate counts for an artifact comparison. */
export type IndexArtifactDiffSummary = {
  /** Number of records added in the candidate artifact. */
  readonly addedRecordCount: number;
  /** Number of records changed in place in the candidate artifact. */
  readonly changedRecordCount: number;
  /** Number of manifest fields with changed values. */
  readonly manifestChangeCount: number;
  /** Number of records removed from the candidate artifact. */
  readonly removedRecordCount: number;
};

/** Structured comparison between a baseline artifact and a candidate artifact. */
export type IndexArtifactDiff = {
  /** Records present only in the candidate artifact. */
  readonly addedRecords: readonly IndexArtifactRecordDiff[];
  /** Records present in both artifacts but with different content. */
  readonly changedRecords: readonly IndexArtifactChangedRecordDiff[];
  /** Manifest field-level changes. */
  readonly manifestChanges: readonly IndexArtifactManifestChange[];
  /** Records present only in the baseline artifact. */
  readonly removedRecords: readonly IndexArtifactRecordDiff[];
  /** Aggregate comparison counts. */
  readonly summary: IndexArtifactDiffSummary;
};

const INDEX_RECORD_TYPE_ORDER = {
  file: 0,
  symbol: 1,
  chunk: 2,
  dependency: 3,
  route: 4,
  test_mapping: 5,
  edge: 6,
  diagnostic: 7,
} satisfies Record<IndexRecord["type"], number>;

const utf8Encoder = new TextEncoder();

/** Validates an index artifact before it crosses package or process boundaries. */
export function validateIndexArtifact(value: unknown): readonly string[] {
  const errors: string[] = [];
  if (!isJsonObject(value)) {
    return ["artifact must be a JSON object"];
  }

  const manifest = value.manifest;
  const records = value.records;
  const manifestValid = Value.Check(IndexManifestSchema, manifest);
  if (!manifestValid) {
    errors.push(...[...Value.Errors(IndexManifestSchema, manifest)].map((error) => error.message));
  }

  if (!Array.isArray(records)) {
    errors.push("records must be an array");
    return errors;
  }

  let recordsValid = true;
  for (const [index, record] of records.entries()) {
    if (!Value.Check(IndexRecordSchema, record)) {
      recordsValid = false;
      errors.push(
        ...[...Value.Errors(IndexRecordSchema, record)].map(
          (error) => `records[${index}] ${error.path}: ${error.message}`,
        ),
      );
    }
  }

  if (!manifestValid || !recordsValid) {
    return errors;
  }

  const artifact = { manifest, records } as IndexArtifact;
  if (artifact.manifest.recordCount !== artifact.records.length) {
    errors.push(
      `manifest.recordCount ${artifact.manifest.recordCount} does not match ${artifact.records.length} records`,
    );
  }
  validateManifestRequiredFeatures(errors, artifact.manifest);
  errors.push(...validateIndexArtifactRecordSemantics(artifact));

  return errors;
}

/** Parses a complete index artifact JSON document. */
export function parseIndexArtifactJson(text: string): IndexArtifact {
  return JSON.parse(text) as IndexArtifact;
}

/** Renders a complete index artifact JSON document with a final newline. */
export function stringifyIndexArtifactJson(
  artifact: IndexArtifactInput,
  options: StringifyIndexArtifactJsonOptions = {},
): string {
  return `${JSON.stringify(artifact, null, options.pretty ? 2 : 0)}\n`;
}

/** Parses an index artifact manifest JSON document. */
export function parseIndexManifestJson(text: string): IndexManifest {
  return JSON.parse(text) as IndexManifest;
}

/** Renders an index artifact manifest JSON document with stable two-space formatting. */
export function stringifyIndexManifestJson(manifest: IndexManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Parses newline-delimited compact JSON index records. */
export function parseIndexRecordsJsonl(
  text: string,
  options: ParseIndexRecordsJsonlOptions = {},
): readonly IndexRecord[] {
  if (text.length === 0) {
    return [];
  }

  const records: IndexRecord[] = [];
  const lines = text.endsWith("\n") ? text.slice(0, -1).split(/\r?\n/u) : text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (
      options.limits?.maxRecords !== undefined &&
      records.length + 1 > options.limits.maxRecords
    ) {
      throw new Error(
        `Index artifact JSONL record count exceeds configured maximum ${options.limits.maxRecords}.`,
      );
    }

    records.push(parseIndexRecordJsonlLine(line, index + 1, options));
  }

  return records;
}

/** Parses one newline-delimited compact JSON index record. */
export function parseIndexRecordJsonlLine(
  line: string,
  lineNumber: number,
  options: ParseIndexRecordsJsonlOptions = {},
): IndexRecord {
  const lineBytes = byteLength(line);
  if (options.limits?.maxRecordBytes !== undefined && lineBytes > options.limits.maxRecordBytes) {
    throw new Error(
      `Index artifact JSONL record at line ${lineNumber} exceeds configured maximum ${options.limits.maxRecordBytes} bytes.`,
    );
  }

  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid index artifact JSONL record at line ${lineNumber}: empty line.`);
  }

  try {
    return JSON.parse(trimmed) as IndexRecord;
  } catch (error) {
    throw new Error(`Invalid index artifact JSONL record at line ${lineNumber}.`, {
      cause: error,
    });
  }
}

/** Renders newline-delimited compact JSON index records with a final newline when non-empty. */
export function stringifyIndexRecordsJsonl(records: readonly IndexRecord[]): string {
  if (records.length === 0) {
    return "";
  }

  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/** Builds a deterministic diff between two index artifacts. */
export function diffIndexArtifacts(
  baseline: IndexArtifactInput,
  candidate: IndexArtifactInput,
): IndexArtifactDiff {
  const baselineRecords = indexRecordsByIdentity(baseline.records);
  const candidateRecords = indexRecordsByIdentity(candidate.records);
  const addedRecords: IndexArtifactRecordDiff[] = [];
  const changedRecords: IndexArtifactChangedRecordDiff[] = [];
  const removedRecords: IndexArtifactRecordDiff[] = [];

  for (const [identity, record] of candidateRecords) {
    const baselineRecord = baselineRecords.get(identity);
    if (!baselineRecord) {
      addedRecords.push(recordDiff(record));
      continue;
    }

    if (stableJsonStringify(baselineRecord) !== stableJsonStringify(record)) {
      changedRecords.push({
        ...recordDiff(record),
        baselineRecord,
        candidateRecord: record,
      });
    }
  }

  for (const [identity, record] of baselineRecords) {
    if (!candidateRecords.has(identity)) {
      removedRecords.push(recordDiff(record));
    }
  }

  const manifestChanges = diffManifestFields(baseline.manifest, candidate.manifest);

  return {
    addedRecords: addedRecords.sort(compareRecordDiffs),
    changedRecords: changedRecords.sort(compareRecordDiffs),
    manifestChanges,
    removedRecords: removedRecords.sort(compareRecordDiffs),
    summary: {
      addedRecordCount: addedRecords.length,
      changedRecordCount: changedRecords.length,
      manifestChangeCount: manifestChanges.length,
      removedRecordCount: removedRecords.length,
    },
  };
}

/** Validates cross-record artifact invariants that TypeBox cannot express. */
function validateIndexArtifactRecordSemantics(artifact: IndexArtifact): string[] {
  const errors: string[] = [];
  const fileIds = new Set<string>();
  const filePaths = new Set<string>();
  const symbolIds = new Set<string>();
  const chunkIds = new Set<string>();
  const edgeIds = new Set<string>();
  const counts = { chunk: 0, edge: 0, file: 0, symbol: 0 };
  const ordering: ArtifactRecordOrderingState = { highestOrder: -1, highestType: undefined };

  artifact.records.forEach((record, index) => {
    collectRecordOrderingError(errors, ordering, record, index);
    collectRecordIdentity(errors, {
      chunkIds,
      edgeIds,
      fileIds,
      filePaths,
      counts,
      index,
      record,
      symbolIds,
    });
    validateRecordProvenance(errors, artifact.manifest, record, index);
    validateRecordRanges(errors, record, index);
  });

  collectManifestCountError(errors, "fileCount", artifact.manifest.fileCount, counts.file);
  collectManifestCountError(errors, "symbolCount", artifact.manifest.symbolCount, counts.symbol);
  collectManifestCountError(errors, "edgeCount", artifact.manifest.edgeCount, counts.edge);
  collectManifestCountError(errors, "chunkCount", artifact.manifest.chunkCount, counts.chunk);

  artifact.records.forEach((record, index) => {
    collectRecordReferenceErrors(errors, {
      chunkIds,
      fileIds,
      index,
      record,
      symbolIds,
    });
  });

  return errors;
}

/** Validates required manifest feature flags against the current reader support. */
function validateManifestRequiredFeatures(errors: string[], manifest: IndexManifest): void {
  const requiredFeatures = manifest.requiredFeatures ?? [];
  const seen = new Set<string>();

  for (const feature of requiredFeatures) {
    collectDuplicateFeatureError(errors, seen, feature);
    if (!isSupportedIndexArtifactFeature(feature)) {
      errors.push(`manifest.requiredFeatures includes unsupported feature ${feature}`);
    }
  }
}

/** Records a duplicate required feature error when a feature is declared twice. */
function collectDuplicateFeatureError(errors: string[], seen: Set<string>, feature: string): void {
  if (seen.has(feature)) {
    errors.push(`manifest.requiredFeatures duplicates ${feature}`);
    return;
  }

  seen.add(feature);
}

/** Mutable state used while validating canonical record type ordering. */
type ArtifactRecordOrderingState = {
  /** Highest canonical record type order seen so far. */
  highestOrder: number;
  /** Record type associated with the highest order seen so far. */
  highestType: IndexRecord["type"] | undefined;
};

/** Records an error when an artifact moves backward in canonical record type order. */
function collectRecordOrderingError(
  errors: string[],
  state: ArtifactRecordOrderingState,
  record: IndexRecord,
  index: number,
): void {
  const order = INDEX_RECORD_TYPE_ORDER[record.type];
  if (order < state.highestOrder) {
    errors.push(`records[${index}].type ${record.type} appears after ${state.highestType} records`);
    return;
  }
  if (order > state.highestOrder) {
    state.highestOrder = order;
    state.highestType = record.type;
  }
}

/** Mutable state used while collecting artifact identity invariants. */
type ArtifactIdentityAccumulator = {
  /** Count of supported normalized record types. */
  readonly counts: { chunk: number; edge: number; file: number; symbol: number };
  /** Chunk IDs seen so far. */
  readonly chunkIds: Set<string>;
  /** Edge IDs seen so far. */
  readonly edgeIds: Set<string>;
  /** File IDs seen so far. */
  readonly fileIds: Set<string>;
  /** File paths seen so far. */
  readonly filePaths: Set<string>;
  /** Current record offset. */
  readonly index: number;
  /** Current artifact record. */
  readonly record: IndexRecord;
  /** Symbol IDs seen so far. */
  readonly symbolIds: Set<string>;
};

/** Collects duplicate ID/path errors and per-type record counts. */
function collectRecordIdentity(errors: string[], input: ArtifactIdentityAccumulator): void {
  switch (input.record.type) {
    case "chunk":
      input.counts.chunk += 1;
      collectDuplicateIdError(errors, input.chunkIds, input.record.chunkId, input.index, "chunkId");
      break;
    case "edge":
      input.counts.edge += 1;
      collectDuplicateIdError(errors, input.edgeIds, input.record.edgeId, input.index, "edgeId");
      break;
    case "file":
      input.counts.file += 1;
      collectDuplicateIdError(errors, input.fileIds, input.record.fileId, input.index, "fileId");
      collectDuplicateIdError(errors, input.filePaths, input.record.path, input.index, "path");
      break;
    case "symbol":
      input.counts.symbol += 1;
      collectDuplicateIdError(
        errors,
        input.symbolIds,
        input.record.symbolId,
        input.index,
        "symbolId",
      );
      break;
    default:
      break;
  }
}

/** Records a duplicate value error when the set already contains the value. */
function collectDuplicateIdError(
  errors: string[],
  seen: Set<string>,
  value: string,
  index: number,
  fieldName: string,
): void {
  if (seen.has(value)) {
    errors.push(`records[${index}].${fieldName} duplicates ${value}`);
    return;
  }

  seen.add(value);
}

/** Validates record repository and commit provenance against the manifest. */
function validateRecordProvenance(
  errors: string[],
  manifest: IndexManifest,
  record: IndexRecord,
  index: number,
): void {
  if (record.repoId !== manifest.repoId) {
    errors.push(`records[${index}].repoId ${record.repoId} does not match ${manifest.repoId}`);
  }
  if (record.commitSha !== manifest.commitSha) {
    errors.push(
      `records[${index}].commitSha ${record.commitSha} does not match ${manifest.commitSha}`,
    );
  }
}

/** Validates line ranges that require endLine to be greater than or equal to startLine. */
function validateRecordRanges(errors: string[], record: IndexRecord, index: number): void {
  if ("range" in record && record.range) {
    collectRangeOrderError(errors, record.range, `records[${index}].range`);
  }
  if (record.type === "symbol" && record.selectionRange) {
    collectRangeOrderError(errors, record.selectionRange, `records[${index}].selectionRange`);
  }
}

/** Records an ordered line range error when endLine precedes startLine. */
function collectRangeOrderError(
  errors: string[],
  range: { readonly endLine: number; readonly startLine: number },
  label: string,
): void {
  if (range.endLine < range.startLine) {
    errors.push(`${label}.endLine ${range.endLine} is before startLine ${range.startLine}`);
  }
}

/** Records a manifest count mismatch for one normalized record type. */
function collectManifestCountError(
  errors: string[],
  fieldName: string,
  expected: number,
  actual: number,
): void {
  if (expected !== actual) {
    errors.push(`manifest.${fieldName} ${expected} does not match ${actual} records`);
  }
}

/** Collects dangling reference errors across artifact records. */
function collectRecordReferenceErrors(errors: string[], input: ArtifactRecordReferenceInput): void {
  switch (input.record.type) {
    case "chunk":
      collectMissingReferenceError(
        errors,
        input.fileIds,
        input.record.fileId,
        input.index,
        "fileId",
      );
      if (input.record.symbolId) {
        collectMissingReferenceError(
          errors,
          input.symbolIds,
          input.record.symbolId,
          input.index,
          "symbolId",
        );
      }
      break;
    case "edge":
      collectEdgeEndpointError(errors, input.record, input, "from");
      collectEdgeEndpointError(errors, input.record, input, "to");
      break;
    case "route":
      if (input.record.handlerSymbolId) {
        collectMissingReferenceError(
          errors,
          input.symbolIds,
          input.record.handlerSymbolId,
          input.index,
          "handlerSymbolId",
        );
      }
      break;
    case "symbol":
      collectMissingReferenceError(
        errors,
        input.fileIds,
        input.record.fileId,
        input.index,
        "fileId",
      );
      break;
    case "test_mapping":
      collectMissingReferenceError(
        errors,
        input.fileIds,
        input.record.testFileId,
        input.index,
        "testFileId",
      );
      if (input.record.targetFileId) {
        collectMissingReferenceError(
          errors,
          input.fileIds,
          input.record.targetFileId,
          input.index,
          "targetFileId",
        );
      }
      if (input.record.targetSymbolId) {
        collectMissingReferenceError(
          errors,
          input.symbolIds,
          input.record.targetSymbolId,
          input.index,
          "targetSymbolId",
        );
      }
      break;
    default:
      break;
  }
}

/** Input for validating one record against artifact-level reference indexes. */
type ArtifactRecordReferenceInput = ArtifactReferenceIndex & {
  /** Current record offset. */
  readonly index: number;
  /** Current artifact record. */
  readonly record: IndexRecord;
};

/** Artifact-level reference indexes used for dangling-reference checks. */
type ArtifactReferenceIndex = {
  /** Chunk IDs available in the artifact. */
  readonly chunkIds: ReadonlySet<string>;
  /** File IDs available in the artifact. */
  readonly fileIds: ReadonlySet<string>;
  /** Symbol IDs available in the artifact. */
  readonly symbolIds: ReadonlySet<string>;
};

/** Records a dangling reference error when a referenced record ID is absent. */
function collectMissingReferenceError(
  errors: string[],
  seen: ReadonlySet<string>,
  value: string,
  index: number,
  fieldName: string,
): void {
  if (!seen.has(value)) {
    errors.push(`records[${index}].${fieldName} references missing record ${value}`);
  }
}

/** Validates one edge endpoint unless it intentionally points at an external node. */
function collectEdgeEndpointError(
  errors: string[],
  record: Extract<IndexRecord, { type: "edge" }>,
  references: ArtifactRecordReferenceInput,
  side: "from" | "to",
): void {
  const kind = side === "from" ? record.fromKind : record.toKind;
  const id = side === "from" ? record.fromId : record.toId;
  if (kind === "external") {
    return;
  }

  const seen =
    kind === "file"
      ? references.fileIds
      : kind === "symbol"
        ? references.symbolIds
        : references.chunkIds;
  if (!seen.has(id)) {
    errors.push(`records[${references.index}].${side}Id references missing ${kind} record ${id}`);
  }
}

/** Returns UTF-8 byte length without depending on Node-only globals. */
function byteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

/** Returns whether a value is a non-array JSON object. */
function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Indexes artifact records by their stable per-record identity. */
function indexRecordsByIdentity(records: readonly IndexRecord[]): ReadonlyMap<string, IndexRecord> {
  return new Map(records.map((record) => [indexRecordIdentity(record), record]));
}

/** Returns a stable record identity for diffing artifact records. */
function indexRecordIdentity(record: IndexRecord): string {
  switch (record.type) {
    case "chunk":
      return `chunk:${record.chunkId}`;
    case "dependency":
      return `dependency:${record.dependencyId}`;
    case "diagnostic":
      return `diagnostic:${record.diagnosticId}`;
    case "edge":
      return `edge:${record.edgeId}`;
    case "file":
      return `file:${record.fileId}`;
    case "route":
      return `route:${record.routeId}`;
    case "symbol":
      return `symbol:${record.symbolId}`;
    case "test_mapping":
      return `test_mapping:${record.testMappingId}`;
  }
}

/** Returns a compact diff reference for one record. */
function recordDiff(record: IndexRecord): IndexArtifactRecordDiff {
  return {
    identity: indexRecordIdentity(record),
    recordType: record.type,
  };
}

/** Sorts record diff rows by stable identity. */
function compareRecordDiffs(left: IndexArtifactRecordDiff, right: IndexArtifactRecordDiff): number {
  return left.identity.localeCompare(right.identity);
}

/** Compares manifest fields by stable JSON value. */
function diffManifestFields(
  baseline: IndexManifest,
  candidate: IndexManifest,
): readonly IndexArtifactManifestChange[] {
  const fields = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
  return fields
    .filter(
      (field) =>
        stableJsonStringify(manifestFieldValue(baseline, field)) !==
        stableJsonStringify(manifestFieldValue(candidate, field)),
    )
    .map((field) => ({
      baselineValue: manifestFieldValue(baseline, field),
      candidateValue: manifestFieldValue(candidate, field),
      field,
    }));
}

/** Reads a manifest field by name for generic diff output. */
function manifestFieldValue(manifest: IndexManifest, field: string): unknown {
  return (manifest as Readonly<Record<string, unknown>>)[field];
}

/** Returns stable JSON so object key order does not create false artifact diffs. */
function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

/** Recursively sorts object keys for stable JSON comparisons. */
function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  if (!isJsonObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeJsonValue(value[key])]),
  );
}
