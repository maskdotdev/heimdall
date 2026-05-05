# #10 Index Artifact Schema — Implementation Spec

## Status

Proposed implementation spec for the replaceable code indexer artifact contract.

This document defines the artifact format emitted by any indexer implementation and consumed by the importer, embedding pipeline, retrieval engine, review engine, and internal debugging tools.

The goal is simple:

```text
Any indexer implementation may be replaced as long as it produces the same artifact contract.
```

The first implementation can be a TypeScript indexer. Later implementations can be a Rust CLI, Go service, language-server-backed analyzer, or remote indexing service. The rest of the product should not care.

---

## 1. Purpose

The index artifact schema is the stable data boundary between:

```text
Repo workspace at exact commit SHA
        |
        v
Indexer implementation
        |
        v
Index artifact
        |
        v
Importer
        |
        v
Normalized DB / vector store / retrieval
```

The indexer should only produce artifacts. It should not know about:

```text
- Postgres table names
- pgvector or Qdrant
- BullMQ jobs
- GitHub comments
- review passes
- LLM prompts
- dashboard APIs
- billing
```

The importer owns storage. The retriever owns query behavior. The review engine owns reasoning. The artifact schema only describes code facts in a versioned, streamable format.

---

## 2. Non-goals

This package does **not** implement:

```text
- repository cloning
- workspace checkout
- AST parsing
- embedding generation
- vector search
- review logic
- GitHub publishing
- DB writes
- static analysis execution
```

It only provides:

```text
- artifact format definitions
- manifest schema
- record schemas
- validation helpers
- JSONL reader/writer helpers
- compatibility checks
- fixture utilities
- artifact diff utilities
```

---

## 3. Package location

Create:

```text
/packages/index-schema
```

Recommended package name:

```text
@repo/index-schema
```

This package should be dependency-light. It should be safe to use from:

```text
/apps/indexer-cli
/packages/indexer-ts
/packages/indexer-driver
/packages/index-importer
/packages/retrieval
/apps/worker
/internal dev tools
```

---

## 4. Relationship to `/packages/contracts`

The artifact schema overlaps with the broader contracts package from #0.

Recommended boundary:

```text
/packages/contracts
  - app-wide primitive types
  - app-wide IDs
  - review contracts
  - API DTOs
  - job payloads
  - provider-neutral PR contracts

/packages/index-schema
  - artifact-specific manifest schema
  - artifact-specific record schema
  - JSONL readers/writers
  - artifact validation
  - artifact compatibility rules
  - artifact diffing utilities
```

Avoid duplicating schemas. Use this ownership model:

`@repo/index-schema` owns artifact contracts. `@repo/contracts` re-exports public index artifact types.

```text
@repo/index-schema
  -> IndexManifest
  -> IndexRecord
  -> FileRecord
  -> SymbolRecord
  -> ChunkRecord

@repo/contracts
  -> export type { IndexManifest, IndexRecord } from "@repo/index-schema"
```

`@repo/contracts` may define shared primitives such as `RepoId`, `Sha256`, `IsoDateTime`, and `RepoPath`. `@repo/index-schema` may import those primitives, but it must remain the only package that defines artifact-specific manifest and record schemas.

Do not put independent `IndexManifest`, `IndexRecord`, `FileRecord`, `SymbolRecord`, `ChunkRecord`, or artifact validator schemas in both packages.

Do not allow circular imports. The allowed direction is `@repo/index-schema -> @repo/contracts/primitives`, with `@repo/contracts` re-exporting public artifact types only.

Version naming rule:

```text
IndexManifest.schemaVersion = "index_artifact.v1"
IndexRecord.schemaVersion = "index_record.v1"
```

If record-type-specific versions are needed later, add a separate `recordTypeVersion` field rather than changing the canonical `schemaVersion` value.

---

## 5. Design principles

### 5.1 Artifact-first

The indexer emits files. The importer consumes files.

```text
indexer
  -> index-manifest.json
  -> records.jsonl
```

Do not have the indexer write to Postgres directly.

---

### 5.2 Streamable

Large repositories may produce hundreds of thousands of records. The artifact must be readable without loading the full file into memory.

Use JSON Lines for record files.

```text
one compact JSON object per line
```

---

### 5.3 Strict core fields, flexible metadata

Core fields should be strict.

```text
additionalProperties: false
```

Experimental data should go inside `metadata`.

```ts
metadata?: Record<string, JsonValue>;
```

This prevents accidental schema drift while preserving extensibility.

---

### 5.4 Version everything

Version every boundary that can change behavior.

```text
artifact schema version
record schema version
indexer version
parser versions
chunker version
ID strategy version
path normalization version
language detector version
```

A review should be explainable months later.

---

### 5.5 Stable IDs plus cross-version fingerprints

Use two identifiers where appropriate:

```text
id          = unique within this index artifact / commit
fingerprint = best-effort stable identity across commits
```

Example:

```text
symbolId          = commit-scoped identity
symbolFingerprint = path + qualified name + kind, without commit SHA
```

This helps changed-symbol detection and base/head mapping.

---

### 5.6 Content-addressed caching

Every file, symbol, chunk, and emitted text unit should have a hash.

This enables:

```text
- skipping unchanged parsing work
- skipping unchanged embeddings
- comparing indexer output
- replaying old artifacts
- verifying importer integrity
```

---

### 5.7 Provider-neutral

The artifact should not contain GitHub-specific concepts.

Use:

```text
repoId
commitSha
path
line ranges
symbols
edges
chunks
```

Avoid:

```text
pull_request_number
GitHub node IDs
GitHub URLs
review comment IDs
```

---

### 5.8 Deterministic output

Given the same input workspace, indexer version, parser version, chunker version, and configuration, the artifact should be byte-stable as much as practical.

Recommended ordering:

```text
files by path
symbols by file path + startLine + name
chunks by file path + startLine + chunkOrdinal
dependencies by manager + manifest path + name
routes by file path + method + route path
edges by fromId + kind + toId
diagnostics by file path + line + code
```

This makes index comparisons and regression tests useful.

---

## 6. Artifact file layout

### 6.1 MVP layout

```text
index-artifact/
  index-manifest.json
  records.jsonl
```

### 6.2 Future partitioned layout

The manifest should support multiple record files even if MVP uses one.

```text
index-artifact/
  index-manifest.json
  records/
    files.jsonl
    symbols.jsonl
    chunks.jsonl
    dependencies.jsonl
    routes.jsonl
    edges.jsonl
    diagnostics.jsonl
```

### 6.3 Why manifest supports multiple files

A single `records.jsonl` is simple. Multiple record files help when:

```text
- repositories are very large
- importer wants to parallelize record loading
- edge records are huge
- chunks need separate retention policies
- raw chunk text should be stored separately
```

MVP should still write one `records.jsonl`.

---

## 7. File format rules

### 7.1 Manifest

`index-manifest.json` must be a single UTF-8 encoded JSON object.

It should be human-readable, but stable ordering is preferred.

Recommended:

```text
2-space formatted JSON for manifest
compact JSON for JSONL records
```

### 7.2 Records

`records.jsonl` must be JSON Lines:

```text
- UTF-8
- one valid JSON object per line
- no blank lines
- line separator is \n
- final newline is recommended
```

Although JSON Lines technically allows any JSON value per line, this artifact contract restricts every line to a JSON object with a `type` discriminator.

### 7.3 Compression

MVP:

```text
compression: "none"
```

Future:

```text
compression: "gzip"
```

If compressed, use file names like:

```text
records.jsonl.gz
```

The manifest must declare compression per record file.

---

## 8. Schema versions

Use explicit string versions instead of loose semver.

```ts
export const INDEX_ARTIFACT_SCHEMA_VERSION = "index_artifact.v1" as const;
export const INDEX_RECORD_SCHEMA_VERSION = "index_record.v1" as const;
```

Manifest example:

```json
{
  "schemaVersion": "index_artifact.v1",
  "recordSchemaVersion": "index_record.v1"
}
```

Compatibility rules:

```text
index_artifact.v1 -> current v1 importer can read
index_artifact.v2 -> v1 importer must reject unless explicitly upgraded
```

Do not silently accept unknown major versions.

---

## 9. Feature flags

The manifest should declare features.

```ts
requiredFeatures: string[];
optionalFeatures: string[];
```

Example:

```json
{
  "requiredFeatures": [
    "record_ordering.v1",
    "stable_ids.v1",
    "repo_paths.posix.v1"
  ],
  "optionalFeatures": [
    "routes.v1",
    "test_mappings.v1"
  ]
}
```

Importer behavior:

```text
Unsupported required feature -> reject artifact
Unsupported optional feature -> ignore supported unknown data if safe
```

Feature flags are useful when adding richer language-specific records without forcing a full schema version bump.

---

## 10. Path normalization

All paths in artifact records must be normalized repo-relative POSIX paths.

Required rules:

```text
- use `/`, never `\`
- no leading slash
- no empty path
- no `.` segment
- no `..` segment
- no repeated slashes
- no null bytes
- preserve case
- normalize Unicode to NFC if possible
- max length: 4096 characters
```

Examples:

```text
src/auth/session.ts          valid
./src/auth/session.ts        invalid
src//auth/session.ts         invalid
/Users/me/repo/file.ts       invalid
../secrets.env               invalid
src\\auth\\session.ts        invalid
```

Helper:

```ts
export function normalizeRepoPath(input: string): RepoPath;
```

Validation should reject unsafe paths, not silently repair them, except for converting backslashes to slashes inside the indexer before emitting records.

---

## 11. Ranges and positions

Use two range types.

### 11.1 Line range

Used for GitHub diff anchoring and whole-line snippets.

```ts
export type LineRange = {
  startLine: number; // 1-based inclusive
  endLine: number;   // 1-based inclusive
};
```

Rules:

```text
startLine >= 1
endLine >= startLine
endLine <= file.lineCount when file.lineCount is known
```

### 11.2 Text range

Used for parser/source positions.

```ts
export type TextPosition = {
  line: number;   // 1-based
  column: number; // 0-based UTF-16 code unit offset
};

export type TextRange = {
  start: TextPosition;
  end: TextPosition; // exclusive
};
```

### 11.3 Byte range

Used for exact source slicing and parser offsets.

```ts
export type ByteRange = {
  startByte: number; // 0-based inclusive
  endByte: number;   // 0-based exclusive
};
```

Byte ranges are optional because not every parser/indexer will provide them.

---

## 12. Hashes

Use lowercase hexadecimal SHA-256 strings.

```text
sha256:<64 lowercase hex chars>
```

Example:

```text
sha256:7b94d0f963e3c5f4a0a871...
```

Recommended hash types:

```ts
export type Sha256 = `sha256:${string}`;
```

Hash definitions:

| Field | Meaning |
|---|---|
| `contentHash` | SHA-256 of raw file bytes or exact emitted text bytes, depending on record type. |
| `textHash` | SHA-256 of emitted chunk text. |
| `recordsSha256` | SHA-256 of the record file bytes. |
| `manifestSha256` | Computed by importer/storage, not embedded in manifest to avoid circularity. |
| `artifactDigest` | Optional digest over manifest + record file digests, computed outside manifest. |

Avoid hashing normalized display text when cache correctness depends on raw content. Use raw bytes where possible.

---

## 13. Stable ID strategy

### 13.1 ID prefixes

Use readable prefixes for debugging.

```text
ia_      index artifact
file_    file record
sym_     symbol record
edge_    edge record
chunk_   chunk record
diag_    diagnostic record
dep_     dependency record
route_   route record
tmap_    test mapping record
```

IDs should be deterministic, not database-generated.

### 13.2 ID encoding

Recommended:

```text
prefix + base32url(sha256(input)).slice(0, 26)
```

Example:

```text
sym_01hr4s9z0n52h0em7nq1ab9wkc
```

Use lowercase. Avoid ambiguous characters if you implement custom base32.

### 13.3 Commit-scoped IDs

Most record IDs should include:

```text
repoId
commitSha
record kind
path
record-specific identity
```

Example file ID input:

```text
file:v1:${repoId}:${commitSha}:${path}
```

Example symbol ID input:

```text
symbol:v1:${repoId}:${commitSha}:${path}:${kind}:${qualifiedName}:${startLine}:${signatureHash}
```

### 13.4 Cross-version fingerprints

Fingerprints should exclude commit SHA.

Example symbol fingerprint input:

```text
symbol-fingerprint:v1:${repoId}:${path}:${kind}:${qualifiedName}
```

Record IDs identify this artifact. Fingerprints help map logically similar objects across base and head commits.

---

## 14. Manifest schema

### 14.1 TypeScript shape

```ts
export type IndexManifest = {
  schemaVersion: "index_artifact.v1";
  recordSchemaVersion: "index_record.v1";

  artifactId: string;

  repo: {
    repoId: string;
    provider?: "github" | "gitlab" | "bitbucket" | "local";
    providerRepoId?: string;
    owner?: string;
    name?: string;
  };

  commit: {
    commitSha: string;
    treeSha?: string;
    defaultBranch?: string;
    indexedRef?: string;
  };

  indexer: {
    name: string;
    version: string;
    buildSha?: string;
    runtime?: string;
    startedAt: string;
    completedAt: string;
  };

  configuration: {
    pathNormalizerVersion: string;
    idStrategyVersion: string;
    languageDetectorVersion: string;
    chunkerVersion: string;
    maxFileBytes: number;
    includeGeneratedFiles: boolean;
    includeVendoredFiles: boolean;
    includeBinaryFiles: boolean;
    ignoredPathGlobs: string[];
  };

  parsers: Record<string, {
    name: string;
    version: string;
    grammarVersion?: string;
  }>;

  recordFiles: Array<{
    path: string;
    mediaType: "application/jsonl";
    encoding: "utf-8";
    compression: "none" | "gzip";
    recordKind: "mixed" | "file" | "symbol" | "chunk" | "edge" | "diagnostic" | "dependency" | "route" | "test_mapping";
    recordCount: number;
    byteLength: number;
    sha256: string;
  }>;

  counts: {
    files: number;
    symbols: number;
    chunks: number;
    edges: number;
    diagnostics: number;
    dependencies: number;
    routes: number;
    testMappings: number;
    skippedFiles: number;
    parsedFiles: number;
  };

  languages: Array<{
    language: string;
    fileCount: number;
    symbolCount: number;
    chunkCount: number;
    lineCount: number;
  }>;

  incremental?: {
    mode: "full" | "incremental";
    previousArtifactId?: string;
    previousCommitSha?: string;
    changedPaths?: string[];
    deletedPaths?: string[];
  };

  requiredFeatures: string[];
  optionalFeatures: string[];

  warnings: Array<{
    code: string;
    message: string;
    count?: number;
  }>;

  metadata?: Record<string, unknown>;
};
```

### 14.2 Example manifest

```json
{
  "schemaVersion": "index_artifact.v1",
  "recordSchemaVersion": "index_record.v1",
  "artifactId": "ia_01hv6w3eq7n5rj7eqc6j4k4t3q",
  "repo": {
    "repoId": "repo_01hv6s3qj9n3qj1x7m9pz0m5pc",
    "provider": "github",
    "providerRepoId": "123456789",
    "owner": "example-org",
    "name": "example-repo"
  },
  "commit": {
    "commitSha": "91f2e1a2d31a9a750ef4a7832ce21a6f1a06a52f",
    "defaultBranch": "main",
    "indexedRef": "refs/heads/main"
  },
  "indexer": {
    "name": "indexer-ts",
    "version": "0.1.0",
    "buildSha": "7e5f4ad",
    "runtime": "bun@1.2.0",
    "startedAt": "2026-04-28T18:00:00.000Z",
    "completedAt": "2026-04-28T18:00:12.431Z"
  },
  "configuration": {
    "pathNormalizerVersion": "repo_path.v1",
    "idStrategyVersion": "stable_ids.v1",
    "languageDetectorVersion": "language_detector.v1",
    "chunkerVersion": "chunker.symbol_window.v1",
    "maxFileBytes": 1048576,
    "includeGeneratedFiles": false,
    "includeVendoredFiles": false,
    "includeBinaryFiles": false,
    "ignoredPathGlobs": ["node_modules/**", "dist/**", "coverage/**"]
  },
  "parsers": {
    "typescript": {
      "name": "tree-sitter-typescript",
      "version": "0.23.0"
    },
    "python": {
      "name": "tree-sitter-python",
      "version": "0.23.0"
    }
  },
  "recordFiles": [
    {
      "path": "records.jsonl",
      "mediaType": "application/jsonl",
      "encoding": "utf-8",
      "compression": "none",
      "recordKind": "mixed",
      "recordCount": 18342,
      "byteLength": 7429182,
      "sha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ],
  "counts": {
    "files": 1221,
    "symbols": 5210,
    "chunks": 7609,
    "edges": 4521,
    "diagnostics": 3,
    "dependencies": 304,
    "routes": 24,
    "testMappings": 49,
    "skippedFiles": 192,
    "parsedFiles": 1029
  },
  "languages": [
    {
      "language": "typescript",
      "fileCount": 841,
      "symbolCount": 4210,
      "chunkCount": 6051,
      "lineCount": 118231
    },
    {
      "language": "python",
      "fileCount": 188,
      "symbolCount": 1000,
      "chunkCount": 1558,
      "lineCount": 40212
    }
  ],
  "incremental": {
    "mode": "full"
  },
  "requiredFeatures": ["record_ordering.v1", "stable_ids.v1", "repo_paths.posix.v1"],
  "optionalFeatures": ["routes.v1", "test_mappings.v1"],
  "warnings": [],
  "metadata": {}
}
```

---

## 15. Record model overview

Each JSONL line is a discriminated record.

```ts
export type IndexRecord =
  | FileRecord
  | SymbolRecord
  | ChunkRecord
  | EdgeRecord
  | DiagnosticRecord
  | DependencyRecord
  | RouteRecord
  | TestMappingRecord;
```

Every record has:

```ts
type BaseRecord = {
  schemaVersion: "index_record.v1";
  type: string;
  id: string;
  metadata?: Record<string, JsonValue>;
};
```

MVP record types:

```text
file
symbol
chunk
edge
diagnostic
dependency
route
test_mapping
```

---

## 16. Record ordering

MVP should require deterministic record ordering to simplify importer behavior.

Required order by type:

```text
1. file
2. symbol
3. chunk
4. dependency
5. route
6. test_mapping
7. edge
8. diagnostic
```

Why this order:

```text
- files exist before symbols/chunks
- symbols exist before edges
- chunks exist before embedding jobs
- edges can reference previously emitted nodes
- diagnostics can be imported last without blocking graph creation
```

Importer should validate ordering in strict mode.

For future partitioned artifacts, the manifest may declare:

```json
{
  "requiredFeatures": ["record_ordering.partitioned.v1"]
}
```

---

## 17. FileRecord

Represents a source file, config file, generated file, binary file, or skipped file.

### 17.1 Shape

```ts
export type FileRecord = {
  schemaVersion: "index_record.v1";
  type: "file";
  id: FileId;

  path: RepoPath;
  fingerprint: string;

  language: CodeLanguage | "unknown";
  fileKind:
    | "source"
    | "test"
    | "config"
    | "documentation"
    | "generated"
    | "vendored"
    | "binary"
    | "build_output"
    | "unknown";

  contentHash?: Sha256;
  sizeBytes: number;
  lineCount?: number;

  extension?: string;
  encoding?: "utf-8" | "binary" | "unknown";

  isGenerated: boolean;
  isVendored: boolean;
  isTest: boolean;
  isBinary: boolean;

  parserStatus: "parsed" | "skipped" | "error" | "unsupported";
  skipReason?:
    | "ignored_path"
    | "too_large"
    | "binary"
    | "generated"
    | "vendored"
    | "unsupported_language"
    | "parser_error";

  metadata?: Record<string, JsonValue>;
};
```

### 17.2 Example

```json
{
  "schemaVersion": "index_record.v1",
  "type": "file",
  "id": "file_01hv6wn5fpfrjsm3tvf2f7n6tw",
  "path": "src/auth/session.ts",
  "fingerprint": "filefp_01hv6wn5fpfrjsm3tvf2f7n6tw",
  "language": "typescript",
  "fileKind": "source",
  "contentHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "sizeBytes": 18342,
  "lineCount": 512,
  "extension": ".ts",
  "encoding": "utf-8",
  "isGenerated": false,
  "isVendored": false,
  "isTest": false,
  "isBinary": false,
  "parserStatus": "parsed",
  "metadata": {}
}
```

### 17.3 Validation rules

```text
path must be normalized
file ID must be unique
fingerprint should be path-derived and commit-independent
binary files must not emit text chunks
skipped files should include skipReason
parsed files should have language != unknown unless parser supports unknown
lineCount required for parsed UTF-8 files
contentHash required for non-deleted, non-virtual files
```

---

## 18. SymbolRecord

Represents a function, method, class, type, module, variable, enum, field, or other named code entity.

### 18.1 Shape

```ts
export type SymbolRecord = {
  schemaVersion: "index_record.v1";
  type: "symbol";
  id: SymbolId;

  fileId: FileId;
  path: RepoPath;

  fingerprint: string;
  parentSymbolId?: SymbolId;

  name: string;
  qualifiedName: string;

  kind:
    | "module"
    | "namespace"
    | "function"
    | "method"
    | "class"
    | "interface"
    | "type_alias"
    | "enum"
    | "constructor"
    | "field"
    | "property"
    | "variable"
    | "constant"
    | "parameter"
    | "decorator"
    | "unknown";

  visibility?: "public" | "protected" | "private" | "internal" | "unknown";

  range: LineRange;
  selectionRange?: TextRange;
  byteRange?: ByteRange;

  signature?: string;
  docstring?: string;

  isExported?: boolean;
  isDefaultExport?: boolean;
  isAsync?: boolean;
  isGenerator?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;

  contentHash?: Sha256;
  signatureHash?: Sha256;

  metadata?: Record<string, JsonValue>;
};
```

### 18.2 Example

```json
{
  "schemaVersion": "index_record.v1",
  "type": "symbol",
  "id": "sym_01hv6x7s5e97ybeqv16yd4s5nn",
  "fileId": "file_01hv6wn5fpfrjsm3tvf2f7n6tw",
  "path": "src/auth/session.ts",
  "fingerprint": "symfp_01hv6x7x802e6pggrf6spg5xwa",
  "name": "validateSession",
  "qualifiedName": "validateSession",
  "kind": "function",
  "visibility": "public",
  "range": {
    "startLine": 42,
    "endLine": 91
  },
  "selectionRange": {
    "start": { "line": 42, "column": 16 },
    "end": { "line": 42, "column": 31 }
  },
  "signature": "export async function validateSession(token: string): Promise<Session | null>",
  "docstring": "Validates a session token and returns the active session.",
  "isExported": true,
  "isDefaultExport": false,
  "isAsync": true,
  "contentHash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "signatureHash": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "metadata": {}
}
```

### 18.3 Validation rules

```text
fileId must reference an existing FileRecord
path must match referenced file path
range must fit inside file lineCount when known
parentSymbolId must reference another symbol in same file unless explicitly cross-file
qualifiedName must be non-empty
contentHash recommended for non-module symbols
signatureHash recommended when signature is present
```

---

## 19. ChunkRecord

Represents text that can be embedded, summarized, or sent to the review model.

Chunks are not always symbols. Some chunks may represent:

```text
- full function body
- class with methods
- sliding window around code
- config file section
- documentation section
- dependency manifest section
```

### 19.1 Shape

```ts
export type ChunkRecord = {
  schemaVersion: "index_record.v1";
  type: "chunk";
  id: ChunkId;

  fileId: FileId;
  path: RepoPath;
  symbolId?: SymbolId;

  fingerprint: string;

  chunkKind:
    | "symbol"
    | "file"
    | "window"
    | "config"
    | "documentation"
    | "dependency_manifest"
    | "test"
    | "unknown";

  language: CodeLanguage | "unknown";

  range: LineRange;
  byteRange?: ByteRange;

  text: string;
  textHash: Sha256;
  contentHash?: Sha256;

  tokenEstimate?: number;
  charCount: number;
  lineCount: number;

  chunkOrdinal: number;
  chunkerVersion: string;
  chunkerStrategy: string;

  primarySymbolName?: string;
  primarySymbolKind?: string;

  importance?: "low" | "normal" | "high";

  metadata?: Record<string, JsonValue>;
};
```

### 19.2 Example

```json
{
  "schemaVersion": "index_record.v1",
  "type": "chunk",
  "id": "chunk_01hv6xcy1v9kzdd29k86a5y8br",
  "fileId": "file_01hv6wn5fpfrjsm3tvf2f7n6tw",
  "path": "src/auth/session.ts",
  "symbolId": "sym_01hv6x7s5e97ybeqv16yd4s5nn",
  "fingerprint": "chunkfp_01hv6xcy1v9kzdd29k86a5y8br",
  "chunkKind": "symbol",
  "language": "typescript",
  "range": {
    "startLine": 42,
    "endLine": 91
  },
  "text": "export async function validateSession(token: string): Promise<Session | null> {\n  ...\n}",
  "textHash": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "contentHash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "tokenEstimate": 327,
  "charCount": 1421,
  "lineCount": 50,
  "chunkOrdinal": 0,
  "chunkerVersion": "chunker.symbol_window.v1",
  "chunkerStrategy": "symbol_with_context",
  "primarySymbolName": "validateSession",
  "primarySymbolKind": "function",
  "importance": "high",
  "metadata": {}
}
```

### 19.3 Validation rules

```text
fileId must reference existing FileRecord
symbolId, when present, must reference existing SymbolRecord
path must match file path
text must not be empty unless chunkKind explicitly allows empty config sections
textHash must equal SHA-256 of emitted UTF-8 text bytes
charCount should equal text.length in JS code units unless documented otherwise
lineCount should match emitted text line count
range must fit file lineCount when known
binary files must not emit chunks
```

### 19.4 Chunk text security

Chunks contain source code. Treat artifact files as sensitive.

Do not:

```text
- log chunk text
- include chunk text in unredacted traces
- store chunks in public object storage
- expose chunks through dashboard without RBAC
```

---

## 20. EdgeRecord

Represents a relationship between files, symbols, chunks, dependencies, routes, or external entities.

### 20.1 Shape

```ts
export type EdgeEndpoint =
  | { entityType: "file"; id: FileId }
  | { entityType: "symbol"; id: SymbolId }
  | { entityType: "chunk"; id: ChunkId }
  | { entityType: "dependency"; id: DependencyId }
  | { entityType: "route"; id: RouteId }
  | { entityType: "external"; name: string; externalKind?: string };

export type EdgeRecord = {
  schemaVersion: "index_record.v1";
  type: "edge";
  id: EdgeId;

  from: EdgeEndpoint;
  to: EdgeEndpoint;

  kind:
    | "contains"
    | "defines"
    | "imports"
    | "exports"
    | "calls"
    | "references"
    | "uses_type"
    | "extends"
    | "implements"
    | "decorates"
    | "tests"
    | "configures"
    | "depends_on"
    | "routes_to"
    | "reads"
    | "writes"
    | "throws"
    | "handles"
    | "unknown";

  confidence: number;

  evidence?: {
    fileId?: FileId;
    path?: RepoPath;
    range?: LineRange;
    text?: string;
  };

  metadata?: Record<string, JsonValue>;
};
```

### 20.2 Example import edge

```json
{
  "schemaVersion": "index_record.v1",
  "type": "edge",
  "id": "edge_01hv6xj14t2m2r38e56dvzw6hz",
  "from": {
    "entityType": "file",
    "id": "file_01hv6wn5fpfrjsm3tvf2f7n6tw"
  },
  "to": {
    "entityType": "external",
    "name": "jsonwebtoken",
    "externalKind": "npm_package"
  },
  "kind": "imports",
  "confidence": 1,
  "evidence": {
    "fileId": "file_01hv6wn5fpfrjsm3tvf2f7n6tw",
    "path": "src/auth/session.ts",
    "range": { "startLine": 1, "endLine": 1 },
    "text": "import jwt from 'jsonwebtoken';"
  },
  "metadata": {}
}
```

### 20.3 Example call edge

```json
{
  "schemaVersion": "index_record.v1",
  "type": "edge",
  "id": "edge_01hv6xk3qg89bcj8xmrrc19ecj",
  "from": {
    "entityType": "symbol",
    "id": "sym_01hv6x7s5e97ybeqv16yd4s5nn"
  },
  "to": {
    "entityType": "symbol",
    "id": "sym_01hv6xp2wa8r7q6hn67bb4xxd"
  },
  "kind": "calls",
  "confidence": 0.82,
  "evidence": {
    "fileId": "file_01hv6wn5fpfrjsm3tvf2f7n6tw",
    "path": "src/auth/session.ts",
    "range": { "startLine": 66, "endLine": 66 },
    "text": "const user = await loadUser(session.userId);"
  },
  "metadata": {
    "resolution": "best_effort_static"
  }
}
```

### 20.4 Validation rules

```text
id must be unique
from and to must not be identical unless kind permits self-reference
confidence must be between 0 and 1
local endpoints must reference existing records
external endpoints must include name
edges should be emitted after referenced nodes
unknown kind should be rare and should include metadata.reason
```

---

## 21. DiagnosticRecord

Represents parser/indexer diagnostics, skipped file notices, partial parse failures, or analyzer messages.

Diagnostics are for index quality, not PR review findings. They may inform review, but they are not user-facing comments by default.

### 21.1 Shape

```ts
export type DiagnosticRecord = {
  schemaVersion: "index_record.v1";
  type: "diagnostic";
  id: DiagnosticId;

  source: "indexer" | "parser" | "language_server" | "static_tool" | "importer";
  severity: "info" | "warning" | "error";

  code: string;
  message: string;

  fileId?: FileId;
  path?: RepoPath;
  range?: LineRange;

  metadata?: Record<string, JsonValue>;
};
```

### 21.2 Example

```json
{
  "schemaVersion": "index_record.v1",
  "type": "diagnostic",
  "id": "diag_01hv6xq4xqfn2f6n7tvnwy0n9h",
  "source": "parser",
  "severity": "warning",
  "code": "typescript.partial_parse",
  "message": "Parsed file with syntax errors; symbol extraction may be incomplete.",
  "fileId": "file_01hv6wn5fpfrjsm3tvf2f7n6tw",
  "path": "src/auth/session.ts",
  "range": {
    "startLine": 120,
    "endLine": 120
  },
  "metadata": {}
}
```

### 21.3 Validation rules

```text
fileId/path optional for repo-level diagnostics
path must be present when fileId is present
code must be stable and machine-readable
message should be human-readable but not include secrets or huge code blocks
```

---

## 22. DependencyRecord

Represents dependencies discovered from package manifests or lockfiles.

### 22.1 Shape

```ts
export type DependencyRecord = {
  schemaVersion: "index_record.v1";
  type: "dependency";
  id: DependencyId;

  manager:
    | "npm"
    | "pnpm"
    | "yarn"
    | "bun"
    | "pip"
    | "poetry"
    | "uv"
    | "go"
    | "cargo"
    | "maven"
    | "gradle"
    | "composer"
    | "unknown";

  ecosystem:
    | "javascript"
    | "python"
    | "go"
    | "rust"
    | "jvm"
    | "php"
    | "unknown";

  manifestPath: RepoPath;
  lockfilePath?: RepoPath;

  name: string;
  versionSpec?: string;
  resolvedVersion?: string;

  scope?: "production" | "development" | "peer" | "optional" | "build" | "unknown";

  isDirect: boolean;

  metadata?: Record<string, JsonValue>;
};
```

### 22.2 Example

```json
{
  "schemaVersion": "index_record.v1",
  "type": "dependency",
  "id": "dep_01hv6xs50feayw9q7wrcnb74md",
  "manager": "pnpm",
  "ecosystem": "javascript",
  "manifestPath": "package.json",
  "lockfilePath": "pnpm-lock.yaml",
  "name": "jsonwebtoken",
  "versionSpec": "^9.0.2",
  "resolvedVersion": "9.0.2",
  "scope": "production",
  "isDirect": true,
  "metadata": {}
}
```

### 22.3 Validation rules

```text
manifestPath must reference a known file path or be accepted as manifest-only if skipped from FileRecord
name must be non-empty
isDirect required
resolvedVersion optional because lockfile may not exist
```

---

## 23. RouteRecord

Represents framework route mappings when the indexer can infer them.

This is optional but useful for reviewing API changes.

### 23.1 Shape

```ts
export type RouteRecord = {
  schemaVersion: "index_record.v1";
  type: "route";
  id: RouteId;

  framework:
    | "elysia"
    | "express"
    | "fastify"
    | "next"
    | "remix"
    | "hono"
    | "fastapi"
    | "django"
    | "flask"
    | "rails"
    | "spring"
    | "unknown";

  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ANY";
  routePath: string;

  fileId: FileId;
  path: RepoPath;
  range: LineRange;

  handlerSymbolId?: SymbolId;
  middlewareSymbolIds?: SymbolId[];

  confidence: number;

  metadata?: Record<string, JsonValue>;
};
```

### 23.2 Example

```json
{
  "schemaVersion": "index_record.v1",
  "type": "route",
  "id": "route_01hv6xw8c727x6br9pbhf0ms5b",
  "framework": "elysia",
  "method": "POST",
  "routePath": "/api/sessions/validate",
  "fileId": "file_01hv6wn5fpfrjsm3tvf2f7n6tw",
  "path": "src/auth/session.ts",
  "range": {
    "startLine": 130,
    "endLine": 138
  },
  "handlerSymbolId": "sym_01hv6x7s5e97ybeqv16yd4s5nn",
  "middlewareSymbolIds": [],
  "confidence": 0.9,
  "metadata": {}
}
```

### 23.3 Validation rules

```text
fileId must reference existing FileRecord
handlerSymbolId, when present, must reference existing SymbolRecord
confidence must be 0..1
routePath must be non-empty
```

---

## 24. TestMappingRecord

Represents a best-effort mapping between tests and source code.

### 24.1 Shape

```ts
export type TestMappingRecord = {
  schemaVersion: "index_record.v1";
  type: "test_mapping";
  id: TestMappingId;

  testFileId: FileId;
  testPath: RepoPath;

  targetFileId?: FileId;
  targetPath?: RepoPath;

  testSymbolId?: SymbolId;
  targetSymbolId?: SymbolId;

  confidence: number;

  reason:
    | "naming_convention"
    | "import_relation"
    | "call_relation"
    | "framework_metadata"
    | "coverage_report"
    | "manual_rule"
    | "unknown";

  metadata?: Record<string, JsonValue>;
};
```

### 24.2 Example

```json
{
  "schemaVersion": "index_record.v1",
  "type": "test_mapping",
  "id": "tmap_01hv6xz58ksw1dmt2mrvr8nz0a",
  "testFileId": "file_01hv6xz6n1q1x9kht9sy70kw6h",
  "testPath": "src/auth/session.test.ts",
  "targetFileId": "file_01hv6wn5fpfrjsm3tvf2f7n6tw",
  "targetPath": "src/auth/session.ts",
  "confidence": 0.86,
  "reason": "naming_convention",
  "metadata": {}
}
```

### 24.3 Validation rules

```text
testFileId must reference existing FileRecord
targetFileId, when present, must reference existing FileRecord
at least one of targetFileId or targetPath should be present
confidence must be 0..1
reason must be specific when possible
```

---

## 25. Tombstones and deleted paths

For MVP, deleted files in a commit do not need records because each artifact represents a complete commit snapshot.

For incremental artifacts, support tombstones later.

Future record:

```ts
export type TombstoneRecord = {
  schemaVersion: "index_record.v1";
  type: "tombstone";
  id: string;
  entityType: "file" | "symbol" | "chunk" | "edge";
  previousId?: string;
  path?: RepoPath;
  reason: "deleted" | "changed" | "replaced";
};
```

MVP should not require tombstones. The importer should treat a full artifact as authoritative for that commit.

---

## 26. TypeBox schemas

### 26.1 Dependencies

Recommended package dependencies:

```json
{
  "dependencies": {
    "@sinclair/typebox": "latest",
    "ajv": "latest"
  },
  "devDependencies": {
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

Use TypeBox to generate JSON Schema-compatible schemas and TypeScript static types.

### 26.2 File layout

```text
/packages/index-schema
  package.json
  tsconfig.json
  src/
    index.ts
    constants.ts
    versions.ts
    json-value.ts
    primitives.ts
    ids.ts
    paths.ts
    ranges.ts
    hashes.ts
    manifest.schema.ts
    records/
      base-record.schema.ts
      file-record.schema.ts
      symbol-record.schema.ts
      chunk-record.schema.ts
      edge-record.schema.ts
      diagnostic-record.schema.ts
      dependency-record.schema.ts
      route-record.schema.ts
      test-mapping-record.schema.ts
      index-record.schema.ts
    artifact/
      artifact-ref.schema.ts
      validation-result.schema.ts
    validate/
      ajv.ts
      validate-manifest.ts
      validate-record.ts
      validate-artifact.ts
      compatibility.ts
      referential-integrity.ts
    io/
      jsonl-reader.ts
      jsonl-writer.ts
      manifest-reader.ts
      artifact-reader.ts
      artifact-writer.ts
    utils/
      normalize-path.ts
      hash.ts
      stable-id.ts
      record-ordering.ts
      counts.ts
      diff-artifacts.ts
    fixtures/
      minimal-artifact.ts
      realistic-typescript-artifact.ts
    test/
      *.test.ts
```

### 26.3 Primitive schemas

```ts
import { Type, Static } from "@sinclair/typebox";

export const Sha256Schema = Type.String({
  pattern: "^sha256:[a-f0-9]{64}$",
});
export type Sha256 = Static<typeof Sha256Schema>;

export const RepoPathSchema = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*//)(?!.*\\u0000).+$",
});
export type RepoPath = Static<typeof RepoPathSchema>;

export const IsoDateTimeSchema = Type.String({
  format: "date-time",
});

export const LineRangeSchema = Type.Object(
  {
    startLine: Type.Integer({ minimum: 1 }),
    endLine: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);
export type LineRange = Static<typeof LineRangeSchema>;
```

### 26.4 Record base schema

```ts
export const JsonValueSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Self),
    Type.Record(Type.String(), Self),
  ])
);

export const MetadataSchema = Type.Record(Type.String(), JsonValueSchema);

export const BaseRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal("index_record.v1"),
    type: Type.String(),
    id: Type.String({ minLength: 1, maxLength: 128 }),
    metadata: Type.Optional(MetadataSchema),
  },
  { additionalProperties: false }
);
```

### 26.5 File record schema example

```ts
export const FileRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal("index_record.v1"),
    type: Type.Literal("file"),
    id: Type.String({ pattern: "^file_[a-z0-9]+$" }),
    path: RepoPathSchema,
    fingerprint: Type.String({ minLength: 1 }),
    language: Type.String({ minLength: 1 }),
    fileKind: Type.Union([
      Type.Literal("source"),
      Type.Literal("test"),
      Type.Literal("config"),
      Type.Literal("documentation"),
      Type.Literal("generated"),
      Type.Literal("vendored"),
      Type.Literal("binary"),
      Type.Literal("build_output"),
      Type.Literal("unknown"),
    ]),
    contentHash: Type.Optional(Sha256Schema),
    sizeBytes: Type.Integer({ minimum: 0 }),
    lineCount: Type.Optional(Type.Integer({ minimum: 0 })),
    extension: Type.Optional(Type.String()),
    encoding: Type.Optional(Type.Union([
      Type.Literal("utf-8"),
      Type.Literal("binary"),
      Type.Literal("unknown"),
    ])),
    isGenerated: Type.Boolean(),
    isVendored: Type.Boolean(),
    isTest: Type.Boolean(),
    isBinary: Type.Boolean(),
    parserStatus: Type.Union([
      Type.Literal("parsed"),
      Type.Literal("skipped"),
      Type.Literal("error"),
      Type.Literal("unsupported"),
    ]),
    skipReason: Type.Optional(Type.String()),
    metadata: Type.Optional(MetadataSchema),
  },
  { additionalProperties: false }
);
```

### 26.6 Index record union

```ts
export const IndexRecordSchema = Type.Union([
  FileRecordSchema,
  SymbolRecordSchema,
  ChunkRecordSchema,
  DependencyRecordSchema,
  RouteRecordSchema,
  TestMappingRecordSchema,
  EdgeRecordSchema,
  DiagnosticRecordSchema,
]);

export type IndexRecord = Static<typeof IndexRecordSchema>;
```

---

## 27. Ajv validation

### 27.1 Validator setup

```ts
import Ajv from "ajv";
import addFormats from "ajv-formats";

export function createIndexSchemaAjv() {
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
  });

  addFormats(ajv);

  return ajv;
}
```

### 27.2 Validation API

```ts
export type SchemaValidationError = {
  path: string;
  message: string;
  keyword?: string;
  params?: unknown;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: SchemaValidationError[] };

export function validateManifest(input: unknown): ValidationResult<IndexManifest>;
export function validateRecord(input: unknown): ValidationResult<IndexRecord>;
```

### 27.3 Error example

```json
{
  "ok": false,
  "errors": [
    {
      "path": "/path",
      "message": "must match repo-relative path format",
      "keyword": "pattern"
    }
  ]
}
```

---

## 28. JSONL reader

The reader should be streaming.

### 28.1 Interface

```ts
export type ReadJsonlOptions = {
  allowBlankLines?: boolean;
  maxLineBytes?: number;
  signal?: AbortSignal;
};

export async function* readJsonlRecords(
  filePath: string,
  options?: ReadJsonlOptions
): AsyncGenerator<{ lineNumber: number; value: unknown }>;
```

### 28.2 Rules

```text
- reject blank lines by default
- reject lines above maxLineBytes
- parse each line independently
- include line number in errors
- do not load entire file into memory
```

### 28.3 Validation wrapper

```ts
export async function* readValidatedIndexRecords(
  filePath: string,
  options?: ReadJsonlOptions
): AsyncGenerator<{ lineNumber: number; record: IndexRecord }>;
```

---

## 29. JSONL writer

The writer should produce compact deterministic JSON.

### 29.1 Interface

```ts
export type IndexRecordWriter = {
  write(record: IndexRecord): Promise<void>;
  close(): Promise<{
    recordCount: number;
    byteLength: number;
    sha256: Sha256;
  }>;
};

export function createIndexRecordWriter(input: {
  filePath: string;
  compression?: "none" | "gzip";
}): IndexRecordWriter;
```

### 29.2 Rules

```text
- one JSON object per line
- no pretty printing
- final newline
- streaming hash while writing
- track byteLength and recordCount
- optionally enforce record ordering
```

---

## 30. Artifact writer

The artifact writer helps indexers produce valid artifacts without manually managing checksums and counts.

### 30.1 Interface

```ts
export type IndexArtifactWriter = {
  writeRecord(record: IndexRecord): Promise<void>;
  close(input: {
    manifestBase: Omit<IndexManifest, "recordFiles" | "counts" | "languages">;
    counts: IndexManifest["counts"];
    languages: IndexManifest["languages"];
  }): Promise<{
    artifactDir: string;
    manifest: IndexManifest;
  }>;
};

export function createIndexArtifactWriter(input: {
  artifactDir: string;
  recordFileName?: string;
  compression?: "none" | "gzip";
  enforceOrdering?: boolean;
}): IndexArtifactWriter;
```

### 30.2 Responsibilities

```text
- create artifact directory
- write records.jsonl
- compute record file SHA-256
- compute counts
- write index-manifest.json last
- fsync/atomic rename where practical
```

---

## 31. Artifact reader

### 31.1 Interface

```ts
export type IndexArtifactReader = {
  manifest: IndexManifest;
  records(): AsyncGenerator<IndexRecord>;
};

export async function openIndexArtifact(input: {
  artifactDir: string;
  validateManifest?: boolean;
  validateRecords?: boolean;
}): Promise<IndexArtifactReader>;
```

### 31.2 Responsibilities

```text
- read manifest
- validate schema version
- check required features
- verify record file existence
- verify byte length and SHA-256 if requested
- stream records in manifest order
```

---

## 32. Artifact validation

Artifact validation has multiple levels.

### 32.1 Level 1 — manifest validation

Checks:

```text
- valid JSON
- schemaVersion supported
- recordSchemaVersion supported
- required fields present
- recordFiles declared
- paths normalized and inside artifact directory
- counts non-negative
- timestamps valid
```

### 32.2 Level 2 — record schema validation

Checks every JSONL line:

```text
- valid JSON object
- known type
- schemaVersion correct
- schema valid for that type
- no unknown core properties
- metadata shape valid
```

### 32.3 Level 3 — file integrity validation

Checks:

```text
- record file byteLength matches manifest
- record file sha256 matches manifest
- record counts match manifest
- per-type counts match manifest
```

### 32.4 Level 4 — referential integrity validation

Checks:

```text
- unique IDs
- symbol.fileId exists
- chunk.fileId exists
- chunk.symbolId exists when present
- route.fileId exists
- route.handlerSymbolId exists when present
- edge endpoints exist unless external
- test mappings reference existing files/symbols
- path fields match referenced file paths
```

### 32.5 Level 5 — semantic validation

Checks:

```text
- line ranges fit file lineCount when known
- chunks from binary files are rejected
- skipped files do not emit symbols/chunks
- parserStatus and skipReason are consistent
- confidence values are 0..1
- record ordering is correct
```

### 32.6 API

```ts
export type ArtifactValidationOptions = {
  verifyChecksums?: boolean;
  validateReferentialIntegrity?: boolean;
  validateSemanticRules?: boolean;
  maxRecords?: number;
  maxRecordBytes?: number;
  strictOrdering?: boolean;
};

export type ArtifactValidationReport = {
  ok: boolean;
  artifactId?: string;
  errors: ArtifactValidationIssue[];
  warnings: ArtifactValidationIssue[];
  counts: IndexManifest["counts"];
};

export async function validateIndexArtifact(input: {
  artifactDir: string;
  options?: ArtifactValidationOptions;
}): Promise<ArtifactValidationReport>;
```

---

## 33. Import semantics

The schema package does not import records into the database, but it should define import semantics for the importer to follow.

### 33.1 Full artifact

A full artifact is authoritative for one repo commit.

```text
(repoId, commitSha, artifactId) -> complete index version
```

Importer should create:

```text
repo_index_versions row
indexed_files rows
symbols rows
code_edges rows
code_chunks rows
```

### 33.2 Incremental artifact

An incremental artifact may include only changed paths in the future.

For MVP, importer may reject:

```json
{
  "incremental": { "mode": "incremental" }
}
```

unless incremental support is explicitly enabled.

### 33.3 Duplicate records

Duplicate IDs are invalid.

Duplicate fingerprints are allowed in some cases:

```text
- overloaded functions
- generated wrapper symbols
- duplicate route registrations
```

But duplicates should be rare and may trigger warnings.

### 33.4 Unknown records

Unknown record types are rejected in MVP.

Future behavior may allow unknown optional record types when manifest declares:

```json
{
  "optionalFeatures": ["unknown_records_ignored.v1"]
}
```

---

## 34. Embedding pipeline semantics

Embedding should not happen inside the indexer.

Chunk records provide embedding input:

```text
chunk.id
chunk.text
chunk.textHash
chunk.language
chunk.path
chunk.range
chunk.symbolId
```

Embedding jobs should dedupe by:

```text
embeddingModel
embeddingModelVersion
chunk.textHash
embeddingInputStrategy
```

This means unchanged chunks do not need new embeddings.

Recommended embedding cache key:

```text
embedding:v1:${provider}:${model}:${inputStrategy}:${chunk.textHash}
```

---

## 35. Retrieval semantics

The retrieval engine should rely on normalized imported records, but the artifact schema should preserve enough detail to enable retrieval.

Useful retrieval paths:

```text
changed file -> FileRecord
changed line -> containing SymbolRecord
symbol -> chunks
symbol -> callers/callees via EdgeRecord
file -> imports/dependencies via EdgeRecord
source file -> related tests via TestMappingRecord
route -> handler symbol
dependency -> import edges
```

So the artifact must preserve:

```text
- file path
- line ranges
- symbol ranges
- chunk text
- edges
- test mappings
- dependencies
```

---

## 36. Language support

The schema should support many languages without requiring new record types.

Initial languages:

```text
typescript
javascript
python
```

Future languages:

```text
go
rust
java
kotlin
csharp
ruby
php
scala
swift
```

Do not hardcode all language-specific data into core fields. Put language-specific details in metadata.

Example TypeScript metadata:

```json
{
  "metadata": {
    "typescript": {
      "typeParameters": ["T"],
      "decorators": ["Injectable"],
      "overloadIndex": 0
    }
  }
}
```

Example Python metadata:

```json
{
  "metadata": {
    "python": {
      "decorators": ["pytest.fixture"],
      "isCoroutine": true
    }
  }
}
```

---

## 37. Metadata rules

`metadata` is for extensions, not for required behavior.

Rules:

```text
- metadata must be JSON-serializable
- metadata must not contain functions, buffers, or binary blobs
- metadata keys should be namespaced when language-specific
- metadata should be small
- importer may preserve metadata as JSONB
- retrieval should not depend on metadata unless feature flags declare support
```

Recommended namespacing:

```json
{
  "metadata": {
    "typescript": {},
    "python": {},
    "indexerTs": {},
    "experimental": {}
  }
}
```

---

## 38. Security requirements

Artifacts contain private source code.

### 38.1 Do not log sensitive data

Never log:

```text
- chunk.text
- full file contents
- raw dependency tokens
- repository credentials
- local workspace paths if they expose user names/secrets
```

### 38.2 Validate paths aggressively

Reject any record path that could escape the repo or artifact directory.

```text
../../secret
/tmp/repo/file
C:\Users\mask\repo\file.ts
```

### 38.3 Artifact storage

If stored in object storage:

```text
- private bucket only
- encryption at rest
- tenant-scoped prefixes
- no public ACL
- short retention unless configured
- audit access
```

### 38.4 Manifest privacy

Manifest can include repo owner/name if needed for debugging, but avoid embedding sensitive local paths.

Do not include:

```text
- clone URL with credentials
- installation tokens
- local absolute paths
- environment variables
```

---

## 39. Performance requirements

### 39.1 Streaming

Readers and writers should stream records.

Do not:

```ts
const records = JSON.parse(await fs.readFile("records.jsonl"));
```

Do:

```ts
for await (const record of readValidatedIndexRecords(path)) {
  await importRecord(record);
}
```

### 39.2 Memory targets

For a 500k-record artifact:

```text
reader memory overhead: < 100 MB
writer memory overhead: < 100 MB
validator memory overhead: configurable
```

Referential integrity validation may need sets of IDs. Make it configurable for very large repos.

### 39.3 Size limits

Recommended defaults:

```text
max manifest size: 5 MB
max JSONL line size: 5 MB
max chunk text chars: 40,000
max metadata size per record: 64 KB
max path length: 4096 chars
```

### 39.4 Chunk constraints

Chunks should be useful retrieval units, not arbitrary huge files.

Recommended chunk targets:

```text
normal chunk: 200-1200 tokens
large symbol chunk: up to 2500 tokens
hard max: 8000 tokens unless explicitly configured
```

---

## 40. Compatibility policy

### 40.1 Compatible v1 changes

Allowed without changing `index_artifact.v1`:

```text
- adding optional fields
- adding metadata keys
- adding optional features
- adding new enum values only if importer treats unknown values safely
- adding new record types only if declared optional and ignored safely
```

### 40.2 Breaking changes

Require `index_artifact.v2` or `index_record.v2`:

```text
- removing required fields
- changing field meaning
- changing line/column semantics
- changing ID semantics
- changing hash semantics
- changing JSONL record shape
- changing required record ordering
```

### 40.3 Importer behavior

Importer should:

```text
- reject unknown artifact major versions
- reject unsupported required features
- warn on unknown optional features
- record schema/indexer versions in DB
- store validation report
```

---

## 41. Artifact diffing

Implement an artifact diff utility for indexer replacement and regression tests.

### 41.1 Interface

```ts
export type ArtifactDiffReport = {
  artifactA: string;
  artifactB: string;
  fileDelta: CountDelta;
  symbolDelta: CountDelta;
  chunkDelta: CountDelta;
  edgeDelta: CountDelta;
  addedFiles: string[];
  removedFiles: string[];
  changedFileHashes: string[];
  addedSymbols: string[];
  removedSymbols: string[];
  changedChunkHashes: string[];
  warnings: string[];
};

export async function diffIndexArtifacts(input: {
  artifactDirA: string;
  artifactDirB: string;
}): Promise<ArtifactDiffReport>;
```

### 41.2 Use cases

```text
- compare TypeScript indexer against Rust indexer
- verify deterministic output
- detect unexpected chunking changes
- regression-test parser upgrades
- evaluate retrieval quality after schema changes
```

---

## 42. Fixtures

Create artifact fixtures in:

```text
/packages/index-schema/fixtures
```

Required fixtures:

```text
minimal-valid-artifact/
  index-manifest.json
  records.jsonl

valid-typescript-artifact/
  index-manifest.json
  records.jsonl

valid-python-artifact/
  index-manifest.json
  records.jsonl

invalid-unknown-record-type/
  index-manifest.json
  records.jsonl

invalid-bad-path/
  index-manifest.json
  records.jsonl

invalid-missing-reference/
  index-manifest.json
  records.jsonl

invalid-bad-checksum/
  index-manifest.json
  records.jsonl

invalid-out-of-order-records/
  index-manifest.json
  records.jsonl
```

Fixtures should be small and safe to commit.

---

## 43. Tests

### 43.1 Schema tests

```text
valid manifest passes
invalid manifest fails
valid each record type passes
invalid each record type fails
unknown core field fails
metadata unknown fields pass
```

### 43.2 JSONL tests

```text
reader parses valid JSONL
reader rejects blank lines
reader rejects invalid JSON
reader preserves line numbers
writer emits final newline
writer emits one object per line
writer computes byte length and SHA-256
```

### 43.3 Artifact validation tests

```text
valid artifact passes all levels
bad checksum fails level 3
missing file reference fails level 4
line range beyond file lineCount fails level 5
out-of-order records fail strict ordering
unsupported required feature fails compatibility
```

### 43.4 Determinism tests

```text
same records produce same file hash
same artifact writer input produces same manifest except timestamps if controlled
deterministic ID functions return expected IDs
```

### 43.5 Diff tests

```text
identical artifacts diff empty
changed symbol hash detected
added file detected
removed chunk detected
```

---

## 44. CLI utilities

Add developer commands through the root workspace.

```text
pnpm index-schema validate <artifact-dir>
pnpm index-schema print-manifest <artifact-dir>
pnpm index-schema count-records <artifact-dir>
pnpm index-schema diff <artifact-a> <artifact-b>
pnpm index-schema generate-fixture <name>
```

Can be implemented as:

```text
/packages/index-schema/src/cli.ts
```

Example:

```bash
pnpm --filter @repo/index-schema cli validate ./tmp/index-artifact
```

Output:

```json
{
  "ok": true,
  "artifactId": "ia_01hv6w3eq7n5rj7eqc6j4k4t3q",
  "counts": {
    "files": 1221,
    "symbols": 5210,
    "chunks": 7609,
    "edges": 4521
  },
  "warnings": []
}
```

---

## 45. Package exports

`/packages/index-schema/src/index.ts` should export:

```ts
export * from "./constants";
export * from "./versions";
export * from "./primitives";
export * from "./ids";
export * from "./paths";
export * from "./ranges";
export * from "./hashes";
export * from "./manifest.schema";
export * from "./records/index-record.schema";
export * from "./validate/validate-manifest";
export * from "./validate/validate-record";
export * from "./validate/validate-artifact";
export * from "./validate/compatibility";
export * from "./io/jsonl-reader";
export * from "./io/jsonl-writer";
export * from "./io/artifact-reader";
export * from "./io/artifact-writer";
export * from "./utils/normalize-path";
export * from "./utils/hash";
export * from "./utils/stable-id";
export * from "./utils/diff-artifacts";
```

Package `exports`:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./schemas": "./dist/schemas.js",
    "./fixtures": "./dist/fixtures/index.js"
  }
}
```

---

## 46. Example end-to-end artifact

### 46.1 records.jsonl

```jsonl
{"schemaVersion":"index_record.v1","type":"file","id":"file_abc","path":"src/math.ts","fingerprint":"filefp_math","language":"typescript","fileKind":"source","contentHash":"sha256:1111111111111111111111111111111111111111111111111111111111111111","sizeBytes":85,"lineCount":4,"extension":".ts","encoding":"utf-8","isGenerated":false,"isVendored":false,"isTest":false,"isBinary":false,"parserStatus":"parsed"}
{"schemaVersion":"index_record.v1","type":"symbol","id":"sym_add","fileId":"file_abc","path":"src/math.ts","fingerprint":"symfp_add","name":"add","qualifiedName":"add","kind":"function","range":{"startLine":1,"endLine":3},"signature":"export function add(a: number, b: number): number","isExported":true,"isAsync":false,"contentHash":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}
{"schemaVersion":"index_record.v1","type":"chunk","id":"chunk_add","fileId":"file_abc","path":"src/math.ts","symbolId":"sym_add","fingerprint":"chunkfp_add","chunkKind":"symbol","language":"typescript","range":{"startLine":1,"endLine":3},"text":"export function add(a: number, b: number): number {\n  return a + b;\n}","textHash":"sha256:3333333333333333333333333333333333333333333333333333333333333333","charCount":74,"lineCount":3,"chunkOrdinal":0,"chunkerVersion":"chunker.symbol_window.v1","chunkerStrategy":"symbol_with_context","primarySymbolName":"add","primarySymbolKind":"function","importance":"normal"}
```

### 46.2 Important note

The example hashes above are illustrative. Real tests should compute actual SHA-256 hashes and validate them.

---

## 47. Implementation sequence

### PR 1 — package skeleton

```text
- create /packages/index-schema
- package.json
- tsconfig.json
- vitest setup
- exports barrel
- constants and versions
```

### PR 2 — primitives

```text
- JsonValue
- Sha256
- RepoPath
- LineRange
- TextRange
- ByteRange
- ID schemas
- path normalization helper
- hash helper
- stable ID helper
```

### PR 3 — manifest schema

```text
- IndexManifest TypeBox schema
- manifest validation
- manifest fixtures
- manifest tests
```

### PR 4 — record schemas

```text
- BaseRecord
- FileRecord
- SymbolRecord
- ChunkRecord
- EdgeRecord
- DiagnosticRecord
- DependencyRecord
- RouteRecord
- TestMappingRecord
- IndexRecord union
- record validation tests
```

### PR 5 — JSONL I/O

```text
- streaming JSONL reader
- streaming JSONL writer
- line number errors
- blank line rejection
- writer checksum/byte count
- tests
```

### PR 6 — artifact reader/writer

```text
- createIndexArtifactWriter
- openIndexArtifact
- manifest writing
- recordFiles metadata
- count generation
- fixture generation
```

### PR 7 — artifact validation

```text
- validateIndexArtifact
- checksum validation
- count validation
- referential integrity validation
- semantic validation
- validation report type
```

### PR 8 — compatibility and diffing

```text
- requiredFeatures validation
- optionalFeatures warnings
- schema version compatibility checks
- diffIndexArtifacts utility
- deterministic ordering utility
```

### PR 9 — CLI

```text
- validate command
- print-manifest command
- count-records command
- diff command
- fixture generation command
```

### PR 10 — integration touchpoints

```text
- indexer-driver validates returned artifacts
- index-importer consumes artifact reader
- indexer-ts uses artifact writer
- tests across packages
```

---

## 48. MVP cut

For the first usable version, implement:

```text
- index-manifest.json
- records.jsonl
- FileRecord
- SymbolRecord
- ChunkRecord
- EdgeRecord
- DiagnosticRecord
- DependencyRecord
- TypeBox schemas
- Ajv validation
- JSONL reader/writer
- artifact reader/writer
- artifact validation levels 1-4
- stable ID helpers
- path normalization
- fixtures
- CLI validate command
```

Defer:

```text
- RouteRecord, unless easy for TypeScript/Elysia projects
- TestMappingRecord, unless needed immediately
- gzip compression
- partitioned record files
- incremental artifact tombstones
- advanced semantic validation
- artifact diff UI
```

---

## 49. Definition of done

This section is complete when:

```text
- @repo/index-schema builds cleanly
- all artifact schemas have TypeScript types and runtime validators
- index-manifest.json schema is implemented
- records.jsonl schema union is implemented
- JSONL reader/writer is streaming
- artifact writer can create a valid minimal artifact
- artifact validator can validate fixtures
- invalid fixtures fail with useful errors
- stable ID helpers are deterministic
- path normalization rejects unsafe paths
- indexer-driver can call validateIndexArtifact after indexing
- index-importer can consume openIndexArtifact without knowing indexer internals
```

---

## 50. Final architecture reminder

The whole point of this package is to preserve this clean boundary:

```text
TypeScript indexer today
Rust indexer tomorrow
Remote indexer later
        |
        v
same index artifact schema
        |
        v
same importer
same retriever
same review engine
same publisher
```

If another part of the system needs parser-specific details, put them in `metadata` or add a versioned optional feature. Do not leak parser internals into the importer or review engine.
