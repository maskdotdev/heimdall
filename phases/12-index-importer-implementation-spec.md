# #12 Index Importer — Implementation Spec

## Status

Proposed implementation spec for the index artifact importer.

This document describes how to implement the layer that consumes the versioned index artifacts from **#10 Index Artifact Schema** and writes normalized, queryable code intelligence data into the database from **#2 Database Layer**.

The goal is to make indexing durable, replayable, idempotent, and replaceable.

The guiding rule:

```text
The indexer understands code.
The importer understands storage.
The retriever understands search.
The review engine understands reasoning.
```

The importer should not parse ASTs, generate embeddings, run LLMs, call GitHub, publish comments, or execute repository code. It should validate an artifact, import it into durable storage, and enqueue any follow-up work such as embedding generation.

---

## 1. Purpose

The importer turns this:

```text
index-manifest.json
records.jsonl
```

into this:

```text
repo_index_versions
indexed_files
symbols
code_edges
code_chunks
dependencies
routes
test_mappings
diagnostics
embedding_jobs
```

The flow is:

```text
repo-sync / workspace-manager
        |
        v
indexer-driver
        |
        v
index artifact
        |
        v
index-importer
        |
        +--> validate manifest
        +--> validate records
        +--> create CodeIndexVersion
        +--> import files/symbols/chunks/edges
        +--> plan embedding jobs
        +--> mark index version complete
        |
        v
retrieval engine
```

The importer is the only component that should know how artifact records map to database rows.

---

## 2. Non-goals

The importer does **not** implement:

```text
- repository cloning
- workspace checkout
- AST parsing
- Tree-sitter queries
- symbol extraction
- chunking
- embedding API calls
- vector search
- review passes
- LLM calls
- GitHub publishing
- dashboard rendering
- static-analysis execution
- package install
- arbitrary repo command execution
```

The importer may enqueue embedding jobs, but it should not perform embedding generation itself.

---

## 3. Package location

Create:

```text
/packages/index-importer
```

Recommended package name:

```text
@repo/index-importer
```

This package is used by:

```text
/apps/worker
/internal dev tools
/packages/retrieval tests
/packages/indexer-driver integration tests
```

It should be safe to use from a worker process and from local developer CLIs.

---

## 4. Relationship to earlier sections

### 4.1 Depends on #0 Core Contracts

The importer uses shared primitives and app-wide types:

```text
RepoId
IndexVersionId
ImportBatchId
Sha256
IsoDateTime
RepoPath
Language
LineRange
Result
```

### 4.2 Depends on #2 Database Layer

The importer writes to database tables defined in the database spec:

```text
repo_index_versions
index_import_batches
indexed_files
symbols
code_edges
code_chunks
embedding_jobs
usage_events
audit_logs
```

### 4.3 Depends on #7 Job Queue

The importer enqueues follow-up jobs:

```text
embedding.batch
repo.index.incremental, optional later
```

### 4.4 Depends on #9 Indexer Boundary

The importer consumes the artifact URI/path returned by the active indexer driver.

```ts
const indexResult = await indexerDriver.index(request);
const importResult = await indexImporter.importArtifact({
  repoId,
  commitSha,
  artifactUri: indexResult.artifactUri,
  indexRequestId: request.requestId,
});
```

### 4.5 Depends on #10 Index Artifact Schema

The importer validates:

```text
index-manifest.json
records.jsonl
```

using `@repo/index-schema`.

### 4.6 Feeds #13 Embedding Pipeline

The importer should create durable embedding jobs for chunks whose content hashes do not yet have embeddings for the selected embedding profile.

---

## 5. High-level architecture

```text
                     ┌──────────────────────┐
                     │    Index Artifact     │
                     │ manifest + records    │
                     └───────────┬──────────┘
                                 │
                                 v
                     ┌──────────────────────┐
                     │  Artifact Resolver    │
                     │ local path / S3 / R2  │
                     └───────────┬──────────┘
                                 │
                                 v
                     ┌──────────────────────┐
                     │  Manifest Validator   │
                     └───────────┬──────────┘
                                 │
                                 v
                     ┌──────────────────────┐
                     │   Record Validator    │
                     │ streaming JSONL read  │
                     └───────────┬──────────┘
                                 │
                                 v
                     ┌──────────────────────┐
                     │ Import Orchestrator   │
                     └───────────┬──────────┘
                                 │
             ┌───────────────────┼───────────────────┐
             │                   │                   │
             v                   v                   v
   ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
   │ Typed Importers  │ │ Integrity Checks │ │ Embedding Planner│
   │ files/symbols... │ │ refs/counts/etc. │ │ content hashes   │
   └────────┬────────┘ └────────┬────────┘ └────────┬────────┘
            │                   │                   │
            v                   v                   v
                     ┌──────────────────────┐
                     │      Postgres         │
                     │ normalized index data │
                     └──────────────────────┘
```

---

## 6. Design principles

### 6.1 Artifact-first

The importer consumes artifacts. It should not call parser internals.

Good:

```text
indexer -> artifact -> importer -> database
```

Bad:

```text
indexer -> parser objects -> importer internals -> database
```

This boundary is what lets you replace the TypeScript indexer with a Rust CLI or remote service later.

---

### 6.2 Idempotent

Index import jobs may be retried.

The importer should produce exactly one durable completed import effect for:

```text
repoId + commitSha + indexProfile + artifactHash
```

Retries should either:

```text
- return the existing completed index version
- continue/retry a failed import after cleanup
- reject if a conflicting active import is in progress
```

---

### 6.3 Immutable index versions

A completed `repo_index_versions` row should be immutable.

Do not mutate an existing completed index version's imported data. If a better indexer emits a different artifact for the same commit, create a new index version and make it active for that commit/profile.

```text
repo@commit + old artifact -> index_version_A, complete, superseded later
repo@commit + new artifact -> index_version_B, complete, active
```

This keeps reviews replayable.

---

### 6.4 Visibility by status

Retrieval must only read from index versions where:

```text
status = 'complete'
is_active = true
```

Partial imports are acceptable internally as long as they are never visible to retrieval.

---

### 6.5 Streaming validation

Large repositories can produce large artifacts. The importer should not require loading the entire `records.jsonl` into memory.

Read line-by-line. Validate each record. Insert in bounded batches.

---

### 6.6 Storage owns normalization

The importer maps artifact records to normalized storage.

The index artifact is optimized for streamability and portability. The database is optimized for retrieval queries and data integrity. They should not need to look identical.

---

### 6.7 Embeddings are separate

The importer should not call an embedding model.

It should only identify chunks that need embeddings and create durable embedding jobs.

```text
chunk imported
  -> missing embedding for content_hash + embedding_profile?
  -> enqueue embedding.batch
```

---

### 6.8 Code content is sensitive

The importer handles source code. Logs, traces, metrics, and error messages should avoid dumping raw code text.

Allowed in logs:

```text
- repoId
- commitSha
- indexVersionId
- record counts
- file paths, if not disabled by privacy settings
- hashes
- error categories
```

Avoid in logs:

```text
- chunk text
- full source lines
- credentials
- GitHub installation tokens
- model prompts
```

---

## 7. Core interfaces

Create:

```text
/packages/index-importer/src/types.ts
```

### 7.1 Import input

```ts
export type ImportIndexArtifactInput = {
  repoId: RepoId;
  commitSha: string;

  /** Usually "default". Allows future index profiles such as "fast", "deep", or "security". */
  indexProfile: string;

  /** Local path, s3:// URI, r2:// URI, or artifact:// URI. */
  artifactUri: string;

  /** Optional artifact hash returned by the indexer driver. Importer recomputes and verifies if provided. */
  expectedArtifactHash?: Sha256;

  /** Optional manifest hash returned by the indexer driver. */
  expectedManifestHash?: Sha256;

  /** Worker job ID or durable background job ID. */
  sourceJobId?: string;

  /** Original indexer request ID for debugging. */
  indexRequestId?: string;

  /** Should this successful import become the active index for repo@commit/profile? */
  activate?: boolean;

  /** Should failed previous partial rows for the same artifact be cleaned up before retry? */
  cleanupFailedPreviousImport?: boolean;

  /** Optional importer behavior overrides. */
  options?: ImportOptions;
};
```

### 7.2 Import options

```ts
export type ImportOptions = {
  maxRecords?: number;
  maxFiles?: number;
  maxSymbols?: number;
  maxChunks?: number;
  maxEdges?: number;
  maxRecordBytes?: number;
  maxChunkTextBytes?: number;
  batchSize?: number;
  validateReferences?: boolean;
  storeArtifactCopy?: boolean;
  artifactStoragePrefix?: string;
  enqueueEmbeddingJobs?: boolean;
  embeddingProfile?: string;
};
```

Recommended defaults:

```ts
export const DEFAULT_IMPORT_OPTIONS: Required<ImportOptions> = {
  maxRecords: 1_000_000,
  maxFiles: 100_000,
  maxSymbols: 500_000,
  maxChunks: 500_000,
  maxEdges: 1_000_000,
  maxRecordBytes: 2_000_000,
  maxChunkTextBytes: 256_000,
  batchSize: 1_000,
  validateReferences: true,
  storeArtifactCopy: true,
  artifactStoragePrefix: "index-artifacts",
  enqueueEmbeddingJobs: true,
  embeddingProfile: "default",
};
```

Tune these after real repo benchmarking.

### 7.3 Import result

```ts
export type ImportIndexArtifactResult = {
  importBatchId: ImportBatchId;
  indexVersionId: IndexVersionId;
  repoId: RepoId;
  commitSha: string;
  indexProfile: string;
  artifactHash: Sha256;
  manifestHash: Sha256;
  status: "complete" | "already_complete";
  activated: boolean;
  stats: IndexImportStats;
  warnings: IndexImportWarning[];
  embeddingJobIds: string[];
  artifactStoredUri?: string;
};
```

### 7.4 Import stats

```ts
export type IndexImportStats = {
  recordsRead: number;
  filesImported: number;
  symbolsImported: number;
  chunksImported: number;
  edgesImported: number;
  diagnosticsImported: number;
  dependenciesImported: number;
  routesImported: number;
  testMappingsImported: number;
  chunksNeedingEmbeddings: number;
  chunksReusingEmbeddings: number;
  manifestValidationMs: number;
  recordValidationMs: number;
  dbWriteMs: number;
  integrityCheckMs: number;
  embeddingPlanningMs: number;
  totalMs: number;
};
```

### 7.5 Main interface

```ts
export interface IndexImporter {
  importArtifact(input: ImportIndexArtifactInput): Promise<ImportIndexArtifactResult>;

  validateArtifact(input: ValidateIndexArtifactInput): Promise<ValidateIndexArtifactResult>;

  cleanupFailedImport(input: CleanupFailedImportInput): Promise<CleanupFailedImportResult>;
}
```

---

## 8. Package layout

Recommended structure:

```text
/packages/index-importer
  package.json
  tsconfig.json
  src/
    index.ts
    types.ts
    config.ts
    errors.ts
    importer.ts
    artifact-resolver.ts
    artifact-hasher.ts
    manifest-validator.ts
    record-reader.ts
    record-router.ts
    record-sanitizer.ts
    record-normalizer.ts
    batch-buffer.ts
    import-lock.ts
    import-batch-repository.ts
    index-version-repository.ts
    typed-importers/
      import-files.ts
      import-symbols.ts
      import-chunks.ts
      import-edges.ts
      import-diagnostics.ts
      import-dependencies.ts
      import-routes.ts
      import-test-mappings.ts
    integrity/
      validate-counts.ts
      validate-duplicates.ts
      validate-references.ts
      validate-ranges.ts
      validate-paths.ts
    embedding-planner.ts
    artifact-storage.ts
    metrics.ts
    testing/
      fake-importer.ts
      fixture-artifacts.ts
      import-test-db.ts
  test/
    manifest-validation.test.ts
    record-validation.test.ts
    import-idempotency.test.ts
    import-concurrency.test.ts
    reference-integrity.test.ts
    embedding-planner.test.ts
```

---

## 9. Import state machine

### 9.1 `repo_index_versions.status`

Recommended states:

```text
pending
importing
complete
failed
superseded
```

State transitions:

```text
pending -> importing
importing -> complete
importing -> failed
complete -> superseded
```

Do not transition `failed -> complete`. On retry, create a new import batch and either reuse the same index version after cleanup or create a new index version, depending on the failure mode.

MVP recommendation:

```text
Create a new index_version for each import attempt unless the exact artifact hash was already completed.
```

This is simpler and safer.

### 9.2 `index_import_batches.status`

Recommended states:

```text
created
validating_manifest
validating_records
creating_index_version
importing_files
importing_symbols
importing_chunks
importing_edges
importing_optional_records
running_integrity_checks
planning_embeddings
activating
complete
failed
```

State diagram:

```text
created
  -> validating_manifest
  -> validating_records
  -> creating_index_version
  -> importing_files
  -> importing_symbols
  -> importing_chunks
  -> importing_edges
  -> importing_optional_records
  -> running_integrity_checks
  -> planning_embeddings
  -> activating
  -> complete
```

Any state may transition to:

```text
failed
```

---

## 10. Database model expectations

The exact schema lives in `/packages/db`, but the importer expects these concepts.

### 10.1 `repo_index_versions`

Purpose: one immutable imported index artifact for a repo commit and profile.

Important columns:

```text
id
repo_id
commit_sha
index_profile
schema_version
indexer_name
indexer_version
chunker_version
parser_config_hash
artifact_uri
artifact_hash
manifest_hash
status
is_active
superseded_by_index_version_id
record_counts_json
stats_json
warnings_json
started_at
completed_at
failed_at
failure_reason
created_at
updated_at
```

Recommended uniqueness:

```sql
unique (repo_id, commit_sha, index_profile, artifact_hash)
```

Recommended retrieval constraint:

```text
Only one active complete index version per repo_id + commit_sha + index_profile.
```

Implement this with a partial unique index if your migration layer supports it:

```sql
create unique index repo_index_versions_one_active_idx
on repo_index_versions (repo_id, commit_sha, index_profile)
where is_active = true and status = 'complete';
```

### 10.2 `index_import_batches`

Purpose: track import attempts.

Important columns:

```text
id
repo_id
commit_sha
index_profile
index_version_id
source_job_id
index_request_id
artifact_uri
artifact_hash
manifest_hash
status
current_phase
attempt_number
stats_json
warnings_json
error_json
started_at
completed_at
failed_at
created_at
updated_at
```

### 10.3 `indexed_files`

Keyed by:

```text
index_version_id + file_id
```

Recommended columns:

```text
id
index_version_id
repo_id
commit_sha
file_id
path
language
content_hash
size_bytes
line_count
is_generated
is_vendor
is_test
metadata_json
```

Recommended indexes:

```sql
(index_version_id, path)
(index_version_id, content_hash)
(repo_id, commit_sha, path)
```

### 10.4 `symbols`

Keyed by:

```text
index_version_id + symbol_id
```

Recommended columns:

```text
id
index_version_id
repo_id
commit_sha
symbol_id
file_id
path
name
kind
start_line
end_line
signature
docstring
content_hash
metadata_json
```

Recommended indexes:

```sql
(index_version_id, file_id)
(index_version_id, path)
(index_version_id, name)
(index_version_id, kind)
(index_version_id, content_hash)
```

### 10.5 `code_chunks`

Keyed by:

```text
index_version_id + chunk_id
```

Recommended columns:

```text
id
index_version_id
repo_id
commit_sha
chunk_id
file_id
symbol_id
path
language
start_line
end_line
text
content_hash
token_estimate
chunk_kind
metadata_json
```

Recommended indexes:

```sql
(index_version_id, path)
(index_version_id, symbol_id)
(index_version_id, content_hash)
(repo_id, commit_sha, content_hash)
```

### 10.6 `code_edges`

Keyed by:

```text
index_version_id + edge_id
```

Recommended columns:

```text
id
index_version_id
repo_id
commit_sha
edge_id
from_id
to_id
from_kind
to_kind
edge_kind
confidence
metadata_json
```

Recommended indexes:

```sql
(index_version_id, from_id, edge_kind)
(index_version_id, to_id, edge_kind)
(index_version_id, edge_kind)
```

### 10.7 `embedding_jobs`

Created by importer, executed by #13.

Recommended columns:

```text
id
repo_id
index_version_id
embedding_profile
content_hashes_json
chunk_ids_json
status
attempt_count
created_at
updated_at
```

If you store embeddings by content hash, also maintain an embedding cache table:

```text
code_embedding_cache
  embedding_profile
  content_hash
  vector
  dimensions
  model
  created_at
```

Recommended uniqueness:

```sql
unique (embedding_profile, content_hash)
```

This allows chunk embeddings to be reused across commits and index versions.

---

## 11. Import algorithm

### 11.1 Overview

```ts
export async function importArtifact(
  input: ImportIndexArtifactInput,
): Promise<ImportIndexArtifactResult> {
  const startedAt = Date.now();

  return withImportTrace(input, async () => {
    const artifact = await artifactResolver.resolve(input.artifactUri);

    const hashes = await artifactHasher.computeHashes(artifact);

    await assertExpectedHashes(input, hashes);

    return await importLocks.withRepoCommitImportLock(
      input.repoId,
      input.commitSha,
      input.indexProfile,
      async () => {
        const existing = await indexVersions.findCompletedByArtifactHash({
          repoId: input.repoId,
          commitSha: input.commitSha,
          indexProfile: input.indexProfile,
          artifactHash: hashes.artifactHash,
        });

        if (existing) {
          return buildAlreadyCompleteResult(existing, hashes);
        }

        const batch = await importBatches.create({
          input,
          hashes,
        });

        try {
          await importBatches.markPhase(batch.id, "validating_manifest");
          const manifest = await validateManifest(artifact.manifestPath, input, hashes);

          await importBatches.markPhase(batch.id, "validating_records");
          const preflight = await preflightValidateRecords(artifact.recordsPath, manifest, input.options);

          await importBatches.markPhase(batch.id, "creating_index_version");
          const indexVersion = await indexVersions.createImportingVersion({
            input,
            manifest,
            hashes,
            stats: preflight.stats,
          });

          await importRecords({
            batch,
            indexVersion,
            artifact,
            manifest,
            options: input.options,
          });

          await runIntegrityChecks(indexVersion.id, manifest);

          const embeddingJobs = await planEmbeddingJobs({
            indexVersionId: indexVersion.id,
            embeddingProfile: input.options?.embeddingProfile ?? "default",
          });

          const storedUri = await maybeStoreArtifactCopy(input, artifact, hashes);

          await activateAndComplete({
            indexVersionId: indexVersion.id,
            importBatchId: batch.id,
            repoId: input.repoId,
            commitSha: input.commitSha,
            indexProfile: input.indexProfile,
            activate: input.activate ?? true,
            artifactStoredUri: storedUri,
          });

          return buildCompleteResult({
            batch,
            indexVersion,
            embeddingJobs,
            storedUri,
            startedAt,
          });
        } catch (error) {
          await markFailedAndMaybeCleanup(batch.id, error);
          throw error;
        }
      },
    );
  });
}
```

### 11.2 Phase 1 — Resolve artifact

Inputs may be:

```text
file:///tmp/index-output/abc
/tmp/index-output/abc
s3://bucket/key
r2://bucket/key
artifact://internal/id
```

The resolved artifact must expose:

```ts
export type ResolvedIndexArtifact = {
  artifactUri: string;
  localDirectory: string;
  manifestPath: string;
  recordsPath: string;
  cleanup?: () => Promise<void>;
};
```

Rules:

```text
- manifest file must be named index-manifest.json
- records file must be named records.jsonl
- no symlinks should be followed outside the artifact directory
- no additional files are required for MVP
- optional files may be ignored unless listed in the manifest
```

### 11.3 Phase 2 — Compute hashes

Compute:

```text
manifestHash = sha256(index-manifest.json bytes)
recordsHash = sha256(records.jsonl bytes)
artifactHash = sha256(manifestHash + ":" + recordsHash)
```

Store all three if useful, but `artifactHash` and `manifestHash` are the minimum.

If the indexer driver provided expected hashes, verify them.

### 11.4 Phase 3 — Acquire import lock

Use an application-level lock for:

```text
repoId + commitSha + indexProfile
```

Recommended lock key:

```text
index-import:{repoId}:{commitSha}:{indexProfile}
```

This prevents two workers from importing competing artifacts for the same commit/profile at the same time.

MVP implementation:

```text
Postgres transaction-scoped advisory lock
```

Pseudo-SQL:

```sql
select pg_advisory_xact_lock($1, $2);
```

Where `$1` and `$2` are deterministic 32-bit integers derived from the lock key.

Important: do not hold a single long transaction for the entire import if the repo is large. Use a short transaction to claim or create the import batch and a separate lock strategy if needed.

Recommended practical approach:

```text
1. Acquire transaction advisory lock.
2. Check for existing complete import.
3. Create/claim index_import_batches row with status = validating_manifest.
4. Commit, releasing lock.
5. Proceed with import using batch ownership and status checks.
```

For stricter serialization, reacquire short locks around activation.

### 11.5 Phase 4 — Validate manifest

Validation checklist:

```text
- manifest is valid JSON
- manifest schemaVersion is supported
- manifest repoId matches input repoId, if manifest includes repoId
- manifest commitSha matches input commitSha
- manifest has indexerName
- manifest has indexerVersion
- manifest has chunkerVersion
- manifest has generatedAt
- manifest record counts are non-negative integers
- manifest language list uses supported language enum values
- manifest feature flags are known or explicitly tolerated
- manifest paths are normalized
- manifest size/stat fields do not exceed configured limits
```

Manifest mismatch should fail fast.

### 11.6 Phase 5 — Preflight record validation

Read `records.jsonl` line by line.

For each line:

```text
- reject empty line unless schema explicitly permits it
- enforce max line bytes
- parse JSON
- validate with IndexRecord schema
- sanitize/normalize path fields
- count by record type
- track duplicate IDs by type
- track malformed ranges
- track suspicious metadata sizes
```

Preflight can either:

```text
A. validate only, then read again during import
B. validate and import in the same stream
```

MVP recommendation:

```text
Validate and import in the same stream, but buffer typed records and flush in batches.
```

For stronger safety on very large artifacts, use a staging table and SQL integrity checks.

---

## 12. Record import strategy

### 12.1 MVP strategy — direct typed batch inserts

The simplest importer can stream and batch directly into final tables attached to an `index_version_id` with status `importing`.

```text
records.jsonl stream
  -> validate record
  -> normalize record
  -> route by type
  -> add to batch buffer
  -> flush batch to final table
```

Since retrieval only reads completed active index versions, partial rows are not visible.

If import fails:

```text
- mark index_version failed
- mark import_batch failed
- optionally delete rows for failed index_version_id in cleanup
```

### 12.2 Scale strategy — staging table first

For very large artifacts or stricter integrity validation, use staging tables:

```text
index_staging_records
  import_batch_id
  line_number
  record_type
  record_id
  payload_jsonb
```

Then finalize using SQL:

```text
staging -> indexed_files
staging -> symbols
staging -> code_chunks
staging -> code_edges
```

This helps with:

```text
- reference validation via SQL joins
- duplicate detection
- resumable imports
- debugging invalid artifacts
- batch COPY imports
```

Downside:

```text
- more schema complexity
- more storage during import
- more SQL plumbing
```

Recommendation:

```text
Start with direct typed batch inserts.
Keep the importer API compatible with a future staging implementation.
```

---

## 13. Typed importers

Each record type should have a small importer module.

```text
record -> normalized DB row
```

### 13.1 File importer

Input record:

```ts
FileRecord
```

DB row shape:

```ts
type IndexedFileInsert = {
  indexVersionId: IndexVersionId;
  repoId: RepoId;
  commitSha: string;
  fileId: string;
  path: string;
  language: Language | null;
  contentHash: Sha256;
  sizeBytes: number;
  lineCount: number | null;
  isGenerated: boolean;
  isVendor: boolean;
  isTest: boolean;
  metadataJson: Record<string, unknown>;
};
```

Validation:

```text
- fileId present
- path normalized and relative
- contentHash valid
- sizeBytes >= 0
- lineCount null or >= 0
- flags default false
```

### 13.2 Symbol importer

Input record:

```ts
SymbolRecord
```

DB row shape:

```ts
type SymbolInsert = {
  indexVersionId: IndexVersionId;
  repoId: RepoId;
  commitSha: string;
  symbolId: string;
  fileId: string;
  path: string;
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature: string | null;
  docstring: string | null;
  contentHash: Sha256 | null;
  metadataJson: Record<string, unknown>;
};
```

Validation:

```text
- symbolId present
- fileId present
- name non-empty
- kind supported
- startLine >= 1
- endLine >= startLine
- path normalized
```

### 13.3 Chunk importer

Input record:

```ts
ChunkRecord
```

DB row shape:

```ts
type CodeChunkInsert = {
  indexVersionId: IndexVersionId;
  repoId: RepoId;
  commitSha: string;
  chunkId: string;
  fileId: string;
  symbolId: string | null;
  path: string;
  language: Language | null;
  startLine: number;
  endLine: number;
  text: string;
  contentHash: Sha256;
  tokenEstimate: number | null;
  chunkKind: string;
  metadataJson: Record<string, unknown>;
};
```

Validation:

```text
- chunkId present
- fileId present
- path normalized
- startLine >= 1
- endLine >= startLine
- text non-empty unless chunkKind allows empty metadata-only chunks
- text byte length <= maxChunkTextBytes
- contentHash valid
```

Important:

```text
Do not log chunk text on validation failure.
```

### 13.4 Edge importer

Input record:

```ts
EdgeRecord
```

DB row shape:

```ts
type CodeEdgeInsert = {
  indexVersionId: IndexVersionId;
  repoId: RepoId;
  commitSha: string;
  edgeId: string;
  fromId: string;
  toId: string;
  fromKind: string;
  toKind: string;
  edgeKind: CodeEdgeKind;
  confidence: number;
  metadataJson: Record<string, unknown>;
};
```

Validation:

```text
- edgeId present
- fromId present
- toId present
- edgeKind supported
- confidence between 0 and 1
```

Do not require every edge target to resolve to a local symbol. Some edges may target:

```text
- external packages
- unresolved imports
- built-ins
- generated symbols not indexed
```

Represent endpoint kind explicitly:

```text
symbol
file
external_package
unresolved
route
test
```

### 13.5 Diagnostic importer

Diagnostics are indexer-produced warnings/errors, not review findings.

Examples:

```text
- parser failed for file
- file skipped due to size
- unsupported language
- malformed syntax
- route extraction failed
```

DB row shape:

```ts
type IndexDiagnosticInsert = {
  indexVersionId: IndexVersionId;
  repoId: RepoId;
  commitSha: string;
  diagnosticId: string;
  path: string | null;
  severity: "info" | "warning" | "error";
  category: string;
  message: string;
  metadataJson: Record<string, unknown>;
};
```

### 13.6 Dependency importer

Dependency records should capture package manifests and dependency names.

Examples:

```text
package.json dependencies
tsconfig path aliases
pyproject dependencies
requirements.txt packages
go.mod modules
Cargo.toml crates
```

DB row shape:

```ts
type DependencyInsert = {
  indexVersionId: IndexVersionId;
  repoId: RepoId;
  commitSha: string;
  dependencyId: string;
  sourceFileId: string | null;
  sourcePath: string;
  ecosystem: string;
  name: string;
  versionConstraint: string | null;
  dependencyKind: "runtime" | "dev" | "peer" | "optional" | "unknown";
  metadataJson: Record<string, unknown>;
};
```

### 13.7 Route importer

Route records are optional but useful for frameworks.

Examples:

```text
- Next.js app route
- Express route handler
- FastAPI route
- Elysia route
- Rails route, later
```

DB row shape:

```ts
type RouteInsert = {
  indexVersionId: IndexVersionId;
  repoId: RepoId;
  commitSha: string;
  routeId: string;
  path: string;
  method: string | null;
  routePattern: string;
  handlerSymbolId: string | null;
  confidence: number;
  metadataJson: Record<string, unknown>;
};
```

### 13.8 Test mapping importer

Test mappings help retrieval find related tests.

Examples:

```text
src/user/service.ts -> src/user/service.test.ts
src/auth/session.py -> tests/auth/test_session.py
```

DB row shape:

```ts
type TestMappingInsert = {
  indexVersionId: IndexVersionId;
  repoId: RepoId;
  commitSha: string;
  mappingId: string;
  sourceFileId: string;
  testFileId: string;
  sourceSymbolId: string | null;
  testSymbolId: string | null;
  confidence: number;
  mappingKind: "naming_convention" | "import_reference" | "call_reference" | "coverage" | "manual";
  metadataJson: Record<string, unknown>;
};
```

---

## 14. Batch buffer design

Create a reusable batch buffer:

```ts
type BatchBuffer<T> = {
  add(row: T): Promise<void>;
  flush(): Promise<void>;
  size(): number;
};
```

Usage:

```ts
const fileBuffer = createBatchBuffer<IndexedFileInsert>({
  batchSize: options.batchSize,
  flush: rows => repositories.indexedFiles.insertMany(rows),
});

for await (const record of readIndexRecords(recordsPath)) {
  switch (record.type) {
    case "file":
      await fileBuffer.add(normalizeFileRecord(record, context));
      break;
  }
}

await fileBuffer.flush();
```

Recommended batch sizes:

```text
files:       1,000
symbols:     1,000
chunks:        500 if text is large; 1,000 if text is small
edges:       2,000
diagnostics: 1,000
```

Tune after benchmark results.

---

## 15. Insert strategy

### 15.1 MVP: Drizzle batch inserts

Use Drizzle for normal inserts/upserts.

Recommended:

```ts
await db.insert(indexedFiles).values(rows).onConflictDoNothing();
```

or, when rows should be replaced during retry cleanup:

```ts
await db.insert(indexedFiles).values(rows).onConflictDoUpdate({
  target: [indexedFiles.indexVersionId, indexedFiles.fileId],
  set: {
    path: sql`excluded.path`,
    contentHash: sql`excluded.content_hash`,
    metadataJson: sql`excluded.metadata_json`,
  },
});
```

For most final tables keyed by a fresh `index_version_id`, conflicts should be rare. If conflicts occur during normal import, treat that as either:

```text
- duplicate record in the artifact
- retry into a partially imported failed version
```

MVP recommendation:

```text
Create a fresh index_version per import attempt.
Use insert only.
Treat duplicate primary keys as artifact errors.
```

### 15.2 Performance path: PostgreSQL COPY

For large repos, switch typed importers to `COPY FROM STDIN` using a raw `pg` connection.

Keep the typed importer interface the same:

```ts
interface TypedRecordWriter<T> {
  writeBatch(rows: T[]): Promise<void>;
  close(): Promise<void>;
}
```

Implementations:

```text
DrizzleBatchWriter
PostgresCopyWriter
```

This keeps the importer logic independent of the write strategy.

### 15.3 Do not use one giant transaction for large imports

A huge transaction can create:

```text
- long locks
- excessive WAL pressure
- poor failure recovery
- delayed visibility of progress
- difficult cancellation
```

Instead:

```text
- create an index_version with status = importing
- insert rows in bounded transactions
- run integrity checks
- mark complete only after all checks pass
```

Retrieval ignores non-complete versions.

---

## 16. Integrity checks

Run integrity checks after all records are imported and before activation.

### 16.1 Count checks

Compare manifest counts with imported row counts.

```text
manifest.fileCount        == count(indexed_files)
manifest.symbolCount      == count(symbols)
manifest.chunkCount       == count(code_chunks)
manifest.edgeCount        == count(code_edges)
```

Allow optional counts to be omitted or marked approximate only if the manifest supports it.

MVP recommendation:

```text
Counts must be exact.
```

### 16.2 Duplicate checks

Check uniqueness per index version:

```text
file_id
file path
symbol_id
chunk_id
edge_id
```

Duplicate file path in one index version should be rejected.

Duplicate symbol names are allowed. Duplicate symbol IDs are not.

### 16.3 Path checks

Every path must be:

```text
- relative
- normalized with forward slashes
- not empty
- not starting with /
- not containing ../
- not containing NUL bytes
- not a Windows drive path
```

### 16.4 Range checks

For symbols and chunks:

```text
start_line >= 1
end_line >= start_line
```

Optional stronger check:

```text
end_line <= indexed_files.line_count
```

Only enforce this if line count is present and reliable.

### 16.5 Reference checks

Validate references where required.

Required references:

```text
symbol.file_id -> indexed_files.file_id
chunk.file_id -> indexed_files.file_id
chunk.symbol_id -> symbols.symbol_id, if symbol_id is not null
```

Optional/soft references:

```text
edge.from_id
edge.to_id
route.handler_symbol_id
test_mapping.source_symbol_id
test_mapping.test_symbol_id
```

Edges often reference external or unresolved nodes. Validate based on endpoint kind.

Example policy:

```text
if edge.from_kind = 'symbol', from_id must exist in symbols
if edge.to_kind = 'symbol', to_id must exist in symbols
if edge.to_kind = 'external_package', to_id does not need local symbol resolution
if edge.to_kind = 'unresolved', to_id does not need local symbol resolution
```

### 16.6 Content hash checks

For chunks, optionally verify:

```text
sha256(chunk.text) == content_hash
```

Caveat: if the indexer uses a content hash that includes metadata such as path/range, the importer needs the same canonical hash function. Prefer a separate field if needed:

```text
textHash
contentHash
```

MVP recommendation:

```text
Trust contentHash shape, but do not recompute unless the index schema defines the exact hash algorithm.
```

### 16.7 Metadata size checks

Reject records with excessive metadata:

```text
metadataJson byte length > maxMetadataBytes
```

Recommended default:

```text
64 KB per record metadata
```

---

## 17. Activation strategy

A successful import should optionally become active.

Activation must be atomic.

Pseudo-transaction:

```sql
begin;

-- lock active index set for repo@commit/profile
select pg_advisory_xact_lock(:lock_key_1, :lock_key_2);

update repo_index_versions
set is_active = false,
    status = case when status = 'complete' then 'superseded' else status end,
    superseded_by_index_version_id = :new_index_version_id,
    updated_at = now()
where repo_id = :repo_id
  and commit_sha = :commit_sha
  and index_profile = :index_profile
  and is_active = true;

update repo_index_versions
set status = 'complete',
    is_active = true,
    completed_at = now(),
    updated_at = now()
where id = :new_index_version_id;

update index_import_batches
set status = 'complete',
    completed_at = now(),
    updated_at = now()
where id = :import_batch_id;

commit;
```

If `activate = false`, mark the index version complete but not active. This is useful for:

```text
- testing new indexer implementations
- comparing index artifacts
- offline evaluation
- blue/green indexing
```

---

## 18. Embedding planning

The importer should decide which chunk content hashes need embeddings.

### 18.1 Embedding profile

An embedding profile identifies:

```text
- provider
- model
- dimensions
- distance metric
- input normalization strategy
```

Example:

```ts
type EmbeddingProfile = {
  id: "default";
  provider: "openai";
  model: "text-embedding-3-large";
  dimensions: 1536;
  distance: "cosine";
};
```

Do not hard-code model details inside the importer. Resolve the profile through configuration.

### 18.2 Query missing embeddings

Pseudo-query:

```sql
select distinct c.content_hash
from code_chunks c
left join code_embedding_cache e
  on e.content_hash = c.content_hash
 and e.embedding_profile = :embedding_profile
where c.index_version_id = :index_version_id
  and e.content_hash is null;
```

If the database uses `code_chunk_embeddings` keyed by `chunk_id`, still consider adding a content-hash cache table. Content-hash caching is a major performance win across commits.

### 18.3 Create jobs in chunks

Do not create one job per chunk. Create batched jobs:

```text
embedding.batch
  indexVersionId
  embeddingProfile
  contentHashes[0..N]
```

Recommended initial batch sizes:

```text
64 to 256 content hashes per embedding job
```

Tune based on provider limits and chunk sizes.

### 18.4 Do not block index completion on embeddings

Recommended states:

```text
index_version.status = complete
embedding jobs = pending/running/complete
```

Retrieval can choose between:

```text
- semantic retrieval only when embeddings are ready
- structural retrieval fallback while embeddings are pending
```

Alternative:

```text
index_version.status = complete_without_embeddings
```

But that adds complexity. MVP can track embedding readiness separately.

Add fields if useful:

```text
repo_index_versions.embedding_status
repo_index_versions.embedding_profile
repo_index_versions.embedding_completed_at
```

---

## 19. Artifact storage

The importer should optionally copy artifacts to durable object storage.

Purpose:

```text
- replay import
- debug bad reviews
- compare indexer versions
- support auditability
- support eval harness
```

Recommended storage key:

```text
index-artifacts/org={orgId}/repo={repoId}/commit={commitSha}/profile={indexProfile}/artifact={artifactHash}/
  index-manifest.json
  records.jsonl.gz
```

Rules:

```text
- store compressed records when possible
- store original manifest exactly
- store artifactHash and manifestHash in DB
- do not expose artifact URIs to users without authz checks
- honor data retention policy
```

MVP option:

```text
storeArtifactCopy = false in local dev
storeArtifactCopy = true in production
```

---

## 20. Error model

Create explicit error types:

```ts
export class IndexImportError extends Error {
  code: IndexImportErrorCode;
  importBatchId?: ImportBatchId;
  indexVersionId?: IndexVersionId;
  details?: Record<string, unknown>;
}
```

Error codes:

```ts
export type IndexImportErrorCode =
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_HASH_MISMATCH"
  | "MANIFEST_NOT_FOUND"
  | "MANIFEST_INVALID_JSON"
  | "MANIFEST_SCHEMA_UNSUPPORTED"
  | "MANIFEST_VALIDATION_FAILED"
  | "MANIFEST_INPUT_MISMATCH"
  | "RECORDS_NOT_FOUND"
  | "RECORD_LINE_TOO_LARGE"
  | "RECORD_INVALID_JSON"
  | "RECORD_SCHEMA_VALIDATION_FAILED"
  | "RECORD_LIMIT_EXCEEDED"
  | "DUPLICATE_RECORD_ID"
  | "DUPLICATE_FILE_PATH"
  | "PATH_NOT_NORMALIZED"
  | "RANGE_INVALID"
  | "REFERENCE_INTEGRITY_FAILED"
  | "COUNT_MISMATCH"
  | "DB_WRITE_FAILED"
  | "IMPORT_CONFLICT"
  | "IMPORT_CANCELLED"
  | "EMBEDDING_PLANNING_FAILED"
  | "ARTIFACT_STORAGE_FAILED"
  | "UNKNOWN";
```

Store structured error details in `index_import_batches.error_json`.

Example:

```json
{
  "code": "RECORD_SCHEMA_VALIDATION_FAILED",
  "line": 18291,
  "recordType": "symbol",
  "recordId": "sym_abc",
  "schemaPath": "/startLine",
  "message": "startLine must be >= 1"
}
```

Do not include raw chunk text.

---

## 21. Idempotency and retry behavior

### 21.1 Same artifact imported twice

If a complete index version already exists for:

```text
repoId + commitSha + indexProfile + artifactHash
```

Return:

```text
status = already_complete
```

Do not import again.

### 21.2 Same commit, different artifact

If a different artifact is imported for the same commit/profile:

```text
- create a new index_version
- import normally
- if activate = true, supersede previous active complete version
```

This allows improved indexer versions to reindex old commits.

### 21.3 Failed previous import

If the exact artifact has a previous failed attempt:

MVP recommendation:

```text
- create a new index_import_batch
- create a new repo_index_version
- leave failed rows for cleanup job, or delete them immediately if safe
```

Cleanup job:

```text
delete from code_edges where index_version_id = failed_id;
delete from code_chunks where index_version_id = failed_id;
delete from symbols where index_version_id = failed_id;
delete from indexed_files where index_version_id = failed_id;
```

Keep the failed `repo_index_versions` row for diagnostics.

### 21.4 Worker crash mid-import

On startup or scheduled maintenance, reconcile imports:

```text
find index_import_batches where status not in ('complete', 'failed') and updated_at < now() - interval '30 minutes'
```

Then either:

```text
- mark stale import failed
- enqueue retry
- cleanup rows for failed index_version_id
```

Do not let abandoned importing versions become active.

---

## 22. Concurrency model

### 22.1 Same repo and commit

Only one import should activate an index for:

```text
repoId + commitSha + indexProfile
```

Use:

```text
- advisory lock around claim/activation
- unique index on active complete versions
- idempotency check by artifact hash
```

### 22.2 Different commits in same repo

Different commits may import concurrently if disk/database capacity allows.

Potential bottleneck:

```text
embedding job creation
DB write throughput
object storage uploads
```

### 22.3 Different repos

Different repos should import concurrently.

Worker concurrency should be configurable:

```text
INDEX_IMPORT_CONCURRENCY=2 or 4 initially
```

Large code imports can saturate DB write capacity, so do not set this too high early.

---

## 23. Performance considerations

### 23.1 Stream everything

Do not:

```text
const records = await fs.readFile(recordsPath, "utf8").then(JSON.parse)
```

Do:

```text
createReadStream(recordsPath)
  -> readline
  -> JSON.parse line
  -> validate
  -> batch insert
```

### 23.2 Keep per-import memory bounded

Importer memory should depend on:

```text
batchSize
schema validator state
small ID sets if enabled
```

not total repo size.

For duplicate detection at large scale, prefer SQL uniqueness constraints over huge in-memory sets.

### 23.3 Use batch writes

Avoid one insert per record.

Use:

```text
500–2,000 rows per batch
```

depending on table and row size.

### 23.4 Use COPY for very large repos

Add a threshold:

```text
if manifest.recordCount > 100_000:
  use PostgresCopyWriter
else:
  use DrizzleBatchWriter
```

This threshold should be benchmark-driven.

### 23.5 Avoid secondary index churn if needed

For huge imports, many secondary indexes can slow writes.

MVP should keep indexes reasonable. Do not prematurely drop/recreate indexes in production.

If imports become a bottleneck, evaluate:

```text
- partitioning by repo_id or index_version_id
- COPY writers
- staging tables
- narrower indexes
- background index maintenance
- moving vector search to Qdrant
```

### 23.6 Compression

If object-storing artifacts, compress `records.jsonl` after import.

Do not require the importer hot path to decompress multiple times. Resolve to a local readable file once.

---

## 24. Security considerations

The importer treats artifacts as untrusted input.

### 24.1 Path safety

Reject paths that:

```text
- are absolute
- include .. segments
- include backslash path traversal
- include NUL bytes
- include Windows drive prefixes
- are empty
```

Normalize all accepted paths to:

```text
forward/slash/relative/path.ts
```

### 24.2 JSON size limits

Set limits for:

```text
- manifest bytes
- record line bytes
- metadata bytes
- chunk text bytes
- total records
```

### 24.3 No execution

The importer must never execute anything from the artifact.

No dynamic imports. No eval. No shelling out based on artifact data.

### 24.4 Sensitive content logging

Do not log:

```text
- raw chunk text
- full file contents
- source code excerpts
- credentials
```

### 24.5 Tenant isolation

Every DB write should include:

```text
repo_id
commit_sha
index_version_id
```

Do not infer org from client-provided data. Resolve org/repo ownership through the database.

---

## 25. Observability

### 25.1 Logs

Use structured logs:

```json
{
  "event": "index_import.phase_completed",
  "repoId": "repo_123",
  "commitSha": "abc123",
  "indexVersionId": "idxv_123",
  "importBatchId": "imb_123",
  "phase": "importing_chunks",
  "durationMs": 1842,
  "recordsImported": 10000
}
```

### 25.2 Metrics

Recommended metrics:

```text
index_import_started_total
index_import_completed_total
index_import_failed_total
index_import_duration_ms
index_import_records_total
index_import_files_total
index_import_symbols_total
index_import_chunks_total
index_import_edges_total
index_import_db_write_duration_ms
index_import_integrity_check_duration_ms
index_import_embedding_jobs_created_total
index_import_artifact_bytes
index_import_failures_by_code_total
```

Dimensions:

```text
repo_id, if cardinality policy allows
language
indexer_name
indexer_version
schema_version
failure_code
```

Avoid high-cardinality dimensions in metrics systems that cannot handle them.

### 25.3 Traces

Trace phases:

```text
resolve_artifact
hash_artifact
validate_manifest
read_records
import_files
import_symbols
import_chunks
import_edges
integrity_checks
embedding_planning
activation
artifact_storage
```

Attach:

```text
repoId
commitSha
indexVersionId
importBatchId
artifactHash
```

---

## 26. Configuration

Environment variables:

```text
INDEX_IMPORT_BATCH_SIZE=1000
INDEX_IMPORT_MAX_RECORDS=1000000
INDEX_IMPORT_MAX_FILES=100000
INDEX_IMPORT_MAX_SYMBOLS=500000
INDEX_IMPORT_MAX_CHUNKS=500000
INDEX_IMPORT_MAX_EDGES=1000000
INDEX_IMPORT_MAX_RECORD_BYTES=2000000
INDEX_IMPORT_MAX_CHUNK_TEXT_BYTES=256000
INDEX_IMPORT_VALIDATE_REFERENCES=true
INDEX_IMPORT_STORE_ARTIFACT_COPY=true
INDEX_IMPORT_ARTIFACT_STORAGE_PREFIX=index-artifacts
INDEX_IMPORT_DEFAULT_PROFILE=default
INDEX_IMPORT_EMBEDDING_PROFILE=default
INDEX_IMPORT_USE_COPY_THRESHOLD=100000
```

Config object:

```ts
export type IndexImporterConfig = {
  batchSize: number;
  limits: {
    maxRecords: number;
    maxFiles: number;
    maxSymbols: number;
    maxChunks: number;
    maxEdges: number;
    maxRecordBytes: number;
    maxChunkTextBytes: number;
  };
  validation: {
    validateReferences: boolean;
    validateCounts: boolean;
    validatePaths: boolean;
    validateRanges: boolean;
  };
  artifactStorage: {
    enabled: boolean;
    prefix: string;
  };
  embeddings: {
    enqueueJobs: boolean;
    defaultProfile: string;
    batchSize: number;
  };
  writers: {
    strategy: "drizzle_batch" | "postgres_copy" | "auto";
    copyThresholdRecords: number;
  };
};
```

---

## 27. Repository/API modules

Keep SQL isolated in repository modules.

```text
import-batch-repository.ts
index-version-repository.ts
indexed-file-repository.ts
symbol-repository.ts
chunk-repository.ts
edge-repository.ts
embedding-job-repository.ts
```

Example:

```ts
export interface IndexVersionRepository {
  findCompletedByArtifactHash(input: {
    repoId: RepoId;
    commitSha: string;
    indexProfile: string;
    artifactHash: Sha256;
  }): Promise<RepoIndexVersionRow | null>;

  createImportingVersion(input: CreateIndexVersionInput): Promise<RepoIndexVersionRow>;

  markComplete(input: MarkIndexVersionCompleteInput): Promise<void>;

  markFailed(input: MarkIndexVersionFailedInput): Promise<void>;

  activate(input: ActivateIndexVersionInput): Promise<void>;
}
```

This makes it easier to test the importer without sprinkling Drizzle queries across the orchestration logic.

---

## 28. Worker integration

The `repo.index` job should call the importer after the indexer finishes.

```ts
export async function handleIndexRepoCommitJob(job: IndexRepoCommitJob) {
  const workspace = await repoSync.checkoutCommit({
    repoId: job.repoId,
    commitSha: job.commitSha,
    installationId: job.installationId,
  });

  try {
    const indexResult = await indexerDriver.index({
      repoId: job.repoId,
      commitSha: job.commitSha,
      workspacePath: workspace.path,
      indexProfile: job.indexProfile ?? "default",
    });

    const importResult = await indexImporter.importArtifact({
      repoId: job.repoId,
      commitSha: job.commitSha,
      indexProfile: job.indexProfile ?? "default",
      artifactUri: indexResult.artifactUri,
      expectedArtifactHash: indexResult.artifactHash,
      sourceJobId: job.id,
      indexRequestId: indexResult.requestId,
      activate: true,
      cleanupFailedPreviousImport: true,
    });

    await markIndexJobComplete(job.id, importResult.indexVersionId);
  } finally {
    await workspace.release();
  }
}
```

Important:

```text
The review worker should not import artifacts directly unless it is executing an index job inline for MVP.
```

Preferred production flow:

```text
repo.index job
  -> indexer
  -> importer
  -> embedding jobs
  -> index ready

pr.review job
  -> ensure required index versions are complete
  -> retrieve context
```

---

## 29. CLI/dev tooling

Add developer commands, likely under `/apps/worker` or `/tools/dev`:

```text
pnpm dev:validate-artifact --artifact /tmp/artifact
pnpm dev:import-artifact --repo-id repo_123 --commit abc123 --artifact /tmp/artifact
pnpm dev:cleanup-import --index-version-id idxv_123
pnpm dev:show-index-version --index-version-id idxv_123
pnpm dev:compare-import-counts --index-version-id idxv_123
```

Command behavior:

```text
validate-artifact
  - does not write to DB
  - validates manifest and records
  - prints stats and warnings

import-artifact
  - writes to DB
  - optionally disables activation
  - optionally disables embedding job enqueueing

cleanup-import
  - deletes imported rows for failed index version
  - never deletes active complete versions unless --force
```

---

## 30. Testing strategy

### 30.1 Unit tests

Test:

```text
- manifest validation
- hash verification
- record parsing
- record validation
- path normalization
- range validation
- duplicate detection
- batch buffering
- error mapping
```

### 30.2 Fixture import tests

Use fixtures from #10 and #11.

Fixtures:

```text
valid-small-typescript-artifact
valid-small-python-artifact
valid-mixed-artifact
invalid-manifest-schema
wrong-repo-id
wrong-commit-sha
duplicate-file-id
duplicate-file-path
chunk-missing-file
symbol-missing-file
edge-unresolved-allowed
edge-symbol-missing-rejected
bad-path-traversal
oversized-record-line
oversized-chunk-text
count-mismatch
```

### 30.3 Idempotency tests

Scenarios:

```text
import same artifact twice returns already_complete
import same commit different artifact creates new index version
activate new artifact supersedes old artifact
failed import does not become visible
retry after failed import succeeds
```

### 30.4 Concurrency tests

Scenarios:

```text
two workers import same artifact concurrently
  -> one imports, one returns already_complete

two workers import different artifacts for same commit/profile
  -> both may complete if allowed, only one active

two workers import different commits
  -> both can proceed
```

### 30.5 Crash recovery tests

Simulate:

```text
crash after files imported
crash after chunks imported
crash before activation
crash after activation but before batch complete
```

Expected:

```text
- no partial index version is active
- maintenance can mark stale import failed
- retry can import cleanly
```

### 30.6 Embedding planner tests

Scenarios:

```text
all chunk content hashes missing -> jobs created
some content hashes already embedded -> only missing queued
duplicate content hashes in same index -> one embedding request
different embedding profile -> embeddings required again
```

---

## 31. Implementation sequence

### PR 1 — Package shell and interfaces

Implement:

```text
/packages/index-importer package
IndexImporter interface
ImportIndexArtifactInput
ImportIndexArtifactResult
IndexImportStats
IndexImportError
config loader
fake importer
```

Definition of done:

```text
- package builds
- types exported
- fake importer usable from tests
```

### PR 2 — Artifact resolver and hasher

Implement:

```text
artifact-resolver.ts
artifact-hasher.ts
local file artifact support
hash verification
basic tests
```

Definition of done:

```text
- local artifact path resolves
- manifest/records are found
- hashes are computed
- expected hash mismatch fails
```

### PR 3 — Manifest validation

Implement:

```text
manifest-validator.ts
schema compatibility checks
input mismatch checks
manifest warnings
```

Definition of done:

```text
- valid manifest passes
- unsupported schema fails
- wrong repo/commit fails
```

### PR 4 — Streaming record reader

Implement:

```text
record-reader.ts
max line size
JSON parse errors
schema validation
record stats
```

Definition of done:

```text
- records.jsonl stream validates
- invalid lines include line number in errors
- memory usage is bounded
```

### PR 5 — Import batch and index version state

Implement:

```text
index_import_batches repository
repo_index_versions repository
create importing version
mark failed
mark complete
activation transaction
```

Definition of done:

```text
- import state visible in DB
- failed import recorded
- activation is atomic
```

### PR 6 — File/symbol/chunk importers

Implement:

```text
file importer
symbol importer
chunk importer
batch buffering
path/range validation
count checks
```

Definition of done:

```text
- small artifact imports into DB
- counts match manifest
- retrieval can query files/symbols/chunks
```

### PR 7 — Edge and optional record importers

Implement:

```text
edge importer
diagnostic importer
dependency importer
route importer
test mapping importer
```

Definition of done:

```text
- all record types from #10 are accepted
- optional record counts validated when present
```

### PR 8 — Integrity checks

Implement:

```text
reference checks
duplicate checks
path checks
range checks
metadata size checks
```

Definition of done:

```text
- invalid references fail before activation
- failed versions are not active
```

### PR 9 — Embedding job planner

Implement:

```text
missing content hash query
embedding batch job creation
embedding profile config
usage event for planned embeddings
```

Definition of done:

```text
- new chunks create embedding jobs
- existing content hashes are reused
- duplicate content hashes are deduped
```

### PR 10 — Idempotency and concurrency

Implement:

```text
artifact hash lookup
same artifact already complete handling
activation locks
stale import reconciliation hooks
concurrency tests
```

Definition of done:

```text
- duplicate import safe
- concurrent import safe
- active index uniqueness enforced
```

### PR 11 — Artifact storage

Implement:

```text
artifact copy to S3/R2/local storage
compressed records storage
artifact URI persistence
retention hooks
```

Definition of done:

```text
- production can retain artifacts for replay
- local dev can disable artifact storage
```

### PR 12 — Dev CLI and diagnostics

Implement:

```text
validate-artifact command
import-artifact command
cleanup-failed-import command
show-index-version command
```

Definition of done:

```text
- developer can import a fixture artifact manually
- developer can inspect import counts and failures
```

---

## 32. MVP cut

For the first working version, implement:

```text
- IndexImporter interface
- local artifact resolver
- manifest validation
- streaming record reader
- direct typed batch inserts
- file importer
- symbol importer
- chunk importer
- edge importer
- count checks
- index version state machine
- activation
- embedding job planning
- idempotency by artifact hash
- basic failed import cleanup
- fixture tests
```

Defer:

```text
- Postgres COPY writer
- generic staging tables
- object storage copy
- route/test mapping import if indexer does not produce them yet
- deep reference validation for every edge kind
- partitioning
- Qdrant integration
- advanced stale import reconciliation
```

---

## 33. Definition of done

The importer is done for MVP when:

```text
1. A valid artifact from #11 imports into Postgres.
2. A completed repo_index_version is created.
3. Files, symbols, chunks, and edges are queryable by index_version_id.
4. Retrieval can resolve the active complete index for repo@commit/profile.
5. Importing the same artifact twice is safe.
6. Failed imports never become active.
7. Chunk content hashes generate durable embedding jobs.
8. Invalid artifacts fail with structured errors.
9. Import phases and stats are visible in the database.
10. Fixture tests cover valid, invalid, duplicate, and retry cases.
```

---

## 34. Practical recommendations

### 34.1 Start direct, design for staging

Do not overbuild staging tables on day one. Use direct typed batch inserts into final tables with `status = importing` and retrieval gating on `status = complete`.

Keep the writer interface abstract so a staging/COPY path can replace the insert strategy later.

### 34.2 Store by index version

Every imported row should carry:

```text
index_version_id
repo_id
commit_sha
```

This makes cleanup, replay, comparison, and retrieval much easier.

### 34.3 Use content-hash embedding reuse

Do not plan embeddings by chunk ID only. Plan by:

```text
embedding_profile + content_hash
```

This avoids re-embedding unchanged chunks across commits and reindexed artifacts.

### 34.4 Make activation explicit

Support:

```text
activate = true
activate = false
```

This lets you import experimental artifacts without affecting production retrieval.

### 34.5 Keep failed versions inspectable

Do not immediately erase all evidence of a failed import.

Keep:

```text
index_import_batch
repo_index_version row
structured error
stats up to failure
```

Optionally clean data rows separately.

---

## 35. Example end-to-end import

```text
1. indexer-driver returns artifactUri=/tmp/index/repo_123/abc123
2. importer resolves manifest and records
3. importer computes artifactHash
4. importer validates manifest
5. importer checks no completed import exists for same artifact
6. importer creates index_import_batch=imb_123
7. importer creates repo_index_version=idxv_123, status=importing
8. importer streams records.jsonl
9. importer writes files/symbols/chunks/edges in batches
10. importer validates counts and references
11. importer creates embedding.batch jobs for missing content hashes
12. importer marks idxv_123 complete and active
13. importer marks imb_123 complete
14. retrieval can now use idxv_123
```

---

## 36. Example code skeleton

```ts
export class DefaultIndexImporter implements IndexImporter {
  constructor(
    private readonly deps: {
      artifactResolver: ArtifactResolver;
      artifactHasher: ArtifactHasher;
      manifestValidator: ManifestValidator;
      recordReader: IndexRecordReader;
      repositories: IndexImportRepositories;
      writers: TypedRecordWriterFactory;
      embeddingPlanner: EmbeddingPlanner;
      artifactStorage: ArtifactStorage;
      locks: ImportLockManager;
      logger: Logger;
      metrics: Metrics;
    },
    private readonly config: IndexImporterConfig,
  ) {}

  async importArtifact(input: ImportIndexArtifactInput): Promise<ImportIndexArtifactResult> {
    const options = mergeImportOptions(this.config, input.options);
    const artifact = await this.deps.artifactResolver.resolve(input.artifactUri);
    const hashes = await this.deps.artifactHasher.hash(artifact);

    assertExpectedHashes(input, hashes);

    return this.deps.locks.withActivationLock(
      input.repoId,
      input.commitSha,
      input.indexProfile,
      async () => {
        const existing = await this.deps.repositories.indexVersions.findCompletedByArtifactHash({
          repoId: input.repoId,
          commitSha: input.commitSha,
          indexProfile: input.indexProfile,
          artifactHash: hashes.artifactHash,
        });

        if (existing) {
          return buildAlreadyCompleteResult(existing);
        }

        const batch = await this.deps.repositories.importBatches.create({ input, hashes });

        try {
          const manifest = await this.deps.manifestValidator.validate({
            manifestPath: artifact.manifestPath,
            input,
            hashes,
          });

          const indexVersion = await this.deps.repositories.indexVersions.createImporting({
            input,
            manifest,
            hashes,
            importBatchId: batch.id,
          });

          const stats = await this.importRecords({
            recordsPath: artifact.recordsPath,
            manifest,
            indexVersion,
            options,
          });

          await this.runIntegrityChecks(indexVersion.id, manifest, stats);

          const embeddingJobs = options.enqueueEmbeddingJobs
            ? await this.deps.embeddingPlanner.plan({
                indexVersionId: indexVersion.id,
                embeddingProfile: options.embeddingProfile,
              })
            : [];

          const storedUri = options.storeArtifactCopy
            ? await this.deps.artifactStorage.store({ artifact, hashes, input })
            : undefined;

          await this.deps.repositories.indexVersions.activateAndComplete({
            indexVersionId: indexVersion.id,
            importBatchId: batch.id,
            activate: input.activate ?? true,
            storedUri,
            stats,
          });

          return buildCompleteResult({ batch, indexVersion, stats, embeddingJobs, storedUri });
        } catch (error) {
          await this.deps.repositories.importBatches.markFailed(batch.id, toImportError(error));
          throw error;
        } finally {
          await artifact.cleanup?.();
        }
      },
    );
  }
}
```

---

## 37. Open decisions

These can be decided during implementation:

```text
1. Should embeddings be cached by content_hash in a separate table from chunk rows?
   Recommendation: yes.

2. Should failed index_version rows retain partial imported rows?
   Recommendation: keep metadata rows, cleanup data rows asynchronously.

3. Should route/test mapping records be part of MVP?
   Recommendation: support schemas, but only import if produced by the indexer.

4. Should activation happen by default?
   Recommendation: yes for normal index jobs, no for eval/experimental jobs.

5. Should COPY be implemented immediately?
   Recommendation: no. Add writer abstraction now, COPY later.

6. Should manifest counts be exact?
   Recommendation: yes for MVP.

7. Should edge target integrity be strict?
   Recommendation: strict for local symbol/file endpoints, soft for external/unresolved endpoints.
```

---

## 38. References

Useful primary references for implementation details:

```text
PostgreSQL COPY documentation:
https://www.postgresql.org/docs/current/sql-copy.html

PostgreSQL explicit/advisory locking documentation:
https://www.postgresql.org/docs/current/explicit-locking.html

Drizzle ORM transactions documentation:
https://orm.drizzle.team/docs/transactions

Drizzle ORM upsert guide:
https://orm.drizzle.team/docs/guides/upsert

pgvector documentation:
https://github.com/pgvector/pgvector
```
