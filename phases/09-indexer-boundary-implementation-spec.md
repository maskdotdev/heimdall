# #9 Indexer Boundary Implementation Spec

Status: Draft v1  
Target packages: `/packages/indexer-driver`, `/packages/index-schema`, `/packages/config`, `/packages/observability`  
Primary app users: `/apps/worker`, `/apps/indexer-cli`, `/packages/index-importer`, `/packages/retrieval`  
Primary runtime: Bun/Node-compatible TypeScript  
Future runtime support: Rust CLI, Go CLI, remote indexing service  
Primary dependencies: repo workspace from `/packages/repo-sync`, index artifact schema from `/packages/index-schema`, queue jobs from `/packages/queue`

---

## 1. Purpose

The indexer boundary is the seam between the rest of the application and whichever implementation is currently responsible for analyzing source code.

It must let us start with a TypeScript indexer and later replace it with a faster implementation without rewriting the review system.

The boundary owns this contract:

```text
repo workspace at exact commit SHA
  -> indexer driver
  -> versioned index artifact
  -> artifact validation
  -> artifact reference returned to caller
```

The rest of the system should not care whether indexing is performed by:

```text
- an in-process TypeScript package
- a TypeScript CLI
- a Rust CLI
- a Go CLI
- a remote indexing service
- a future language-specific analyzer fleet
```

It should only care that the indexer produces a valid artifact matching the shared schema.

---

## 2. Why this component matters

The indexer is likely to become one of the most performance-sensitive parts of the whole product.

It will process:

```text
- large repositories
- many files
- many languages
- many commits
- many PR updates
- repeated incremental indexing runs
```

Early on, a TypeScript implementation is the fastest path to learning. Later, you may want to replace parts of it with Rust, Go, language-server-backed services, or a distributed remote indexer.

If the review worker directly imports parser internals, replacing the indexer becomes painful.

Bad architecture:

```text
review worker
  -> tree-sitter parser
  -> symbol extractor internals
  -> chunking internals
  -> direct DB writes
  -> embedding calls
  -> review engine
```

Good architecture:

```text
review worker
  -> repo sync gives workspace
  -> indexer driver returns artifact
  -> importer writes artifact to DB
  -> embedding worker embeds chunks
  -> retriever builds context
  -> review engine reviews PR
```

The boundary lets us change the left side without disturbing the right side.

---

## 3. Design goals

### 3.1 Replaceable

The indexer implementation must be replaceable without changing review orchestration, retrieval, publishing, database access, or GitHub integration.

The stable contract is:

```text
IndexRequest -> IndexResult
```

Not:

```text
parseFile() -> extractFunctions() -> insertSymbols() -> createEmbeddings()
```

---

### 3.2 Artifact-first

The indexer produces a versioned artifact.

It does not directly write application tables.

Preferred flow:

```text
Indexer -> artifact -> importer -> storage
```

Avoid:

```text
Indexer -> Postgres
Indexer -> pgvector
Indexer -> Qdrant
Indexer -> review engine
```

The artifact gives us:

```text
- replayability
- artifact diffing
- indexer benchmarking
- schema compatibility checks
- blue/green indexer rollout
- easier migration to Rust or remote indexing
- easier debugging of bad review runs
```

---

### 3.3 Deterministic

For the same input repo commit, indexer version, schema version, and options, the output should be stable.

Good:

```text
repoId=repo_123
commitSha=abc123
indexerVersion=ts-indexer@0.2.1
chunkerVersion=chunker.v1
schemaVersion=index_artifact.v1
```

Bad:

```text
index whatever is currently on main
emit random DB IDs
change chunk boundaries without versioning
include local absolute paths in artifact records
```

---

### 3.4 Safe

The indexer should parse and inspect source code, not execute arbitrary project code.

The indexer boundary must enforce:

```text
- no GitHub credentials passed to parser processes
- no secrets in logs
- no unsanitized shell execution
- timeouts
- workspace path validation
- output path validation
- artifact size limits
- process cleanup
```

---

### 3.5 Observable

Every index run should be explainable.

We should be able to answer:

```text
- which driver ran?
- which implementation version ran?
- what commit was indexed?
- how many files were scanned?
- how many records were emitted?
- how long did it take?
- why did it fail?
- where is the artifact?
- was the artifact imported?
```

---

### 3.6 Idempotent

Running the same index request twice should be safe.

The orchestrator may retry jobs. The indexer driver should not create duplicate durable application state. Artifact names may include unique run IDs, but the logical index result should be deduplicated by:

```text
repoId
commitSha
indexerVersion
schemaVersion
indexOptionsHash
```

---

## 4. Non-goals

This section does not implement the actual TypeScript parser. That is #11.

It also does not implement the detailed artifact schema. That is #10.

It does not import artifacts into Postgres. That is #12.

It does not generate embeddings. That is #13.

It does not assemble review context. That is #14.

This section implements the boundary, lifecycle, drivers, protocol, validation handoff, error model, observability, and testing harness around indexer execution.

---

## 5. High-level architecture

```text
/apps/worker
  |
  | indexRepoCommit job
  v
/packages/repo-sync
  |
  | workspace lease
  v
/packages/indexer-driver
  |
  | active driver selected by config
  v
+--------------------------+
| InProcess TS Driver      |
| CLI Driver               |
| Remote Driver            |
| Fake/Test Driver         |
+--------------------------+
  |
  | IndexResult
  v
/packages/index-schema
  |
  | validate manifest + records
  v
artifact store / local artifact path
  |
  v
/packages/index-importer
```

The indexer driver should be a thin adapter around one implementation. It should not contain the full parser.

---

## 6. Package responsibilities

### 6.1 `/packages/indexer-driver`

Owns:

```text
- Indexer interface
- driver registry
- driver selection from config
- in-process driver wrapper
- CLI driver wrapper
- remote driver wrapper placeholder
- fake driver for tests
- timeout handling
- process spawning
- artifact output directory management
- result normalization
- error normalization
- metrics and logging
```

Does not own:

```text
- tree-sitter extraction logic
- artifact schema details beyond validation call
- Postgres imports
- embedding generation
- retrieval
- review prompts
```

---

### 6.2 `/packages/index-schema`

Owns:

```text
- IndexManifest schema
- IndexRecord schemas
- schema version constants
- artifact validation helpers
- JSONL readers/writers
- compatibility checks
```

The driver calls this package to validate the artifact before returning success.

---

### 6.3 `/apps/indexer-cli`

Owns:

```text
- command-line entrypoint
- request file parsing
- calling the actual TypeScript indexer implementation
- writing index-manifest.json
- writing records.jsonl
- exit codes
```

This may initially wrap `/packages/indexer-ts`.

---

### 6.4 `/packages/indexer-ts`

Owns the first implementation of source-code indexing.

This is #11, not #9.

The key point for #9 is that `/packages/indexer-ts` can be used in two modes:

```text
1. imported directly by InProcessTypeScriptIndexerDriver
2. invoked through /apps/indexer-cli by CliIndexerDriver
```

---

## 7. Core flow

### 7.1 Standard index flow

```text
indexRepoCommit job
  |
  v
repoSync.checkout(repoId, commitSha)
  |
  v
workspace lease returned
  |
  v
indexerDriver.index(IndexRequest)
  |
  v
artifact output created
  |
  v
artifact manifest validated
  |
  v
records validated or sampled depending on mode
  |
  v
IndexResult returned
  |
  v
index importer imports artifact
  |
  v
embedding jobs queued for new chunks
```

### 7.2 Driver selection flow

```text
config.INDEXER_DRIVER
  |
  +-- "in_process_ts" -> InProcessTypeScriptIndexerDriver
  +-- "cli"           -> CliIndexerDriver
  +-- "remote"        -> RemoteIndexerDriver
  +-- "fake"          -> FakeIndexerDriver
```

Do not hardcode the driver in workers.

---

## 8. TypeScript API

Create:

```text
/packages/indexer-driver/src/types.ts
```

### 8.1 `IndexRequest`

```ts
import type {
  CommitSha,
  IsoDateTime,
  RepoId,
  RepositoryProvider,
  RepositoryVisibility,
} from "@repo/contracts";

export type IndexRequest = {
  schemaVersion: "index_request.v1";

  requestId: string;
  runId: string;

  repoId: RepoId;
  provider: RepositoryProvider;
  owner: string;
  name: string;
  visibility: RepositoryVisibility;

  commitSha: CommitSha;
  defaultBranch?: string;

  /** Absolute local path returned by repo-sync. */
  workspacePath: string;

  /** Local output dir where the indexer should write the artifact. */
  outputPath: string;

  /** Optional previous index for incremental mode. */
  previousIndex?: {
    indexVersionId: string;
    commitSha: CommitSha;
    artifactUri?: string;
    manifestHash?: string;
  };

  /** Optional known changed file paths, usually from PR diff. */
  changedPaths?: string[];

  options: IndexOptions;

  /** Correlation fields for logs/traces. */
  trace: {
    orgId: string;
    jobId?: string;
    reviewRunId?: string;
    webhookEventId?: string;
    requestedAt: IsoDateTime;
  };
};
```

### 8.2 `IndexOptions`

```ts
export type IndexOptions = {
  languages?: string[];

  includeTests: boolean;
  includeGeneratedFiles: boolean;
  includeVendorFiles: boolean;
  includeDotFiles: boolean;

  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  maxRecords: number;

  chunkerVersion: string;
  parserProfile: "fast" | "balanced" | "deep";

  emitSymbols: boolean;
  emitEdges: boolean;
  emitChunks: boolean;
  emitDiagnostics: boolean;
  emitDependencies: boolean;
  emitRoutes: boolean;
  emitTestMappings: boolean;

  incrementalMode: "disabled" | "content_hash" | "previous_artifact";

  timeoutMs: number;
};
```

### 8.3 `IndexResult`

```ts
export type IndexResult = {
  schemaVersion: "index_result.v1";

  requestId: string;
  runId: string;

  status: "succeeded" | "failed" | "canceled" | "timed_out";

  driver: {
    name: string;
    mode: "in_process" | "cli" | "remote" | "fake";
    version: string;
  };

  artifact?: {
    localPath?: string;
    uri?: string;
    manifestPath: string;
    recordsPath: string;
    manifestHash: string;
    recordsHash?: string;
    sizeBytes: number;
  };

  manifest?: {
    schemaVersion: string;
    indexerName: string;
    indexerVersion: string;
    repoId: string;
    commitSha: string;
    recordCount: number;
    fileCount: number;
    symbolCount: number;
    edgeCount: number;
    chunkCount: number;
  };

  stats: IndexRunStats;
  errors: IndexerError[];
  warnings: IndexerWarning[];

  startedAt: string;
  finishedAt: string;
};
```

### 8.4 `IndexRunStats`

```ts
export type IndexRunStats = {
  durationMs: number;

  workspaceBytes?: number;
  scannedFileCount: number;
  skippedFileCount: number;
  parsedFileCount: number;
  failedFileCount: number;

  emittedFileRecords: number;
  emittedSymbolRecords: number;
  emittedEdgeRecords: number;
  emittedChunkRecords: number;
  emittedDiagnosticRecords: number;

  maxRssBytes?: number;
  stdoutBytes?: number;
  stderrBytes?: number;

  byLanguage: Record<
    string,
    {
      files: number;
      bytes: number;
      symbols: number;
      chunks: number;
      parseFailures: number;
    }
  >;
};
```

### 8.5 `IndexerError`

```ts
export type IndexerError = {
  code:
    | "workspace_not_found"
    | "workspace_invalid"
    | "output_path_invalid"
    | "unsupported_schema_version"
    | "unsupported_language"
    | "resource_limit_exceeded"
    | "timeout"
    | "process_exit_nonzero"
    | "process_signal"
    | "manifest_missing"
    | "manifest_invalid"
    | "records_missing"
    | "records_invalid"
    | "artifact_too_large"
    | "remote_unavailable"
    | "remote_job_failed"
    | "internal_error";

  message: string;
  severity: "warning" | "error" | "fatal";
  details?: Record<string, unknown>;
};
```

### 8.6 `IndexerWarning`

```ts
export type IndexerWarning = {
  code:
    | "file_skipped_large"
    | "file_skipped_generated"
    | "file_skipped_vendor"
    | "parse_failure"
    | "language_unsupported"
    | "edge_extraction_partial"
    | "record_limit_reached"
    | "stdout_truncated"
    | "stderr_truncated";

  message: string;
  path?: string;
  details?: Record<string, unknown>;
};
```

### 8.7 `IndexerDriver`

```ts
export interface IndexerDriver {
  readonly name: string;
  readonly mode: "in_process" | "cli" | "remote" | "fake";

  getCapabilities(): Promise<IndexerCapabilities>;

  index(request: IndexRequest): Promise<IndexResult>;

  cancel?(runId: string): Promise<void>;

  health?(): Promise<IndexerHealth>;
}
```

### 8.8 `IndexerCapabilities`

```ts
export type IndexerCapabilities = {
  driverName: string;
  driverVersion: string;

  supportedRequestSchemaVersions: string[];
  supportedArtifactSchemaVersions: string[];

  supportedLanguages: string[];
  supportedRecordTypes: Array<
    | "file"
    | "symbol"
    | "edge"
    | "chunk"
    | "diagnostic"
    | "dependency"
    | "route"
    | "test_mapping"
  >;

  supportsIncremental: boolean;
  supportsPreviousArtifact: boolean;
  supportsCancellation: boolean;
  supportsStreamingProgress: boolean;
  supportsRemoteArtifacts: boolean;

  maxFileBytes?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
};
```

### 8.9 `IndexerHealth`

```ts
export type IndexerHealth = {
  status: "healthy" | "degraded" | "unhealthy";
  checkedAt: string;
  details?: Record<string, unknown>;
};
```

---

## 9. Driver registry

Create:

```text
/packages/indexer-driver/src/registry.ts
```

```ts
export type IndexerDriverName =
  | "in_process_ts"
  | "cli"
  | "remote"
  | "fake";

export type CreateIndexerDriverInput = {
  driverName: IndexerDriverName;
  config: IndexerDriverConfig;
  logger: Logger;
  metrics: Metrics;
};

export function createIndexerDriver(
  input: CreateIndexerDriverInput,
): IndexerDriver {
  switch (input.driverName) {
    case "in_process_ts":
      return new InProcessTypeScriptIndexerDriver(input);
    case "cli":
      return new CliIndexerDriver(input);
    case "remote":
      return new RemoteIndexerDriver(input);
    case "fake":
      return new FakeIndexerDriver(input);
    default:
      return assertNever(input.driverName);
  }
}
```

The worker should use the registry:

```ts
const indexer = createIndexerDriver({
  driverName: config.indexer.driver,
  config: config.indexer,
  logger,
  metrics,
});
```

Avoid:

```ts
import { parseRepository } from "@repo/indexer-ts";
```

inside worker jobs.

---

## 10. Configuration

Add to `/packages/config`:

```ts
export type IndexerConfig = {
  driver: "in_process_ts" | "cli" | "remote" | "fake";

  defaultTimeoutMs: number;
  maxTimeoutMs: number;

  artifactRootPath: string;
  artifactUploadMode: "local_only" | "object_storage";

  validateArtifacts: boolean;
  validateRecordMode: "full" | "sample" | "manifest_only";
  validationSampleSize: number;

  cli: {
    executablePath: string;
    workingDirectory?: string;
    extraArgs: string[];
    envAllowlist: string[];
    stdoutMaxBytes: number;
    stderrMaxBytes: number;
    killGraceMs: number;
  };

  remote: {
    baseUrl: string;
    authMode: "none" | "bearer" | "hmac" | "mtls";
    timeoutMs: number;
    pollIntervalMs: number;
    maxPollMs: number;
  };
};
```

Environment variables:

```text
INDEXER_DRIVER=cli
INDEXER_DEFAULT_TIMEOUT_MS=120000
INDEXER_MAX_TIMEOUT_MS=600000
INDEXER_ARTIFACT_ROOT_PATH=/var/lib/app/index-artifacts
INDEXER_ARTIFACT_UPLOAD_MODE=local_only
INDEXER_VALIDATE_ARTIFACTS=true
INDEXER_VALIDATE_RECORD_MODE=full
INDEXER_CLI_EXECUTABLE_PATH=/usr/local/bin/indexer
INDEXER_CLI_STDOUT_MAX_BYTES=1048576
INDEXER_CLI_STDERR_MAX_BYTES=1048576
INDEXER_CLI_KILL_GRACE_MS=5000
INDEXER_REMOTE_BASE_URL=http://indexer:8080
```

Recommended defaults:

```text
local dev:       in_process_ts or cli
MVP production:  cli
future scale:    remote
unit tests:      fake
```

Why CLI in MVP production?

```text
- isolates parser crashes from worker process
- frees memory after process exit
- makes Rust replacement easier
- keeps worker orchestration separate from CPU-heavy parsing
```

---

## 11. Artifact output layout

The indexer driver should create a unique output directory per run.

Example:

```text
/var/lib/app/index-artifacts/
  repo_123/
    abc123/
      idxrun_01HY.../
        request.json
        index-manifest.json
        records.jsonl
        logs/
          stdout.log
          stderr.log
        result.json
```

Required files:

```text
request.json
index-manifest.json
records.jsonl
result.json
```

Optional files:

```text
records.jsonl.zst
records.pb
diagnostics.jsonl
progress.jsonl
logs/stdout.log
logs/stderr.log
```

The driver owns creating the output directory and passing it to the implementation. The implementation owns writing the manifest and records.

### 11.1 Path safety

The driver must verify:

```text
- output path is under configured artifactRootPath
- workspace path exists
- workspace path is not artifactRootPath
- output path does not already contain old artifacts unless in explicit overwrite mode
- no artifact file path escapes output directory
```

---

## 12. CLI protocol

The CLI protocol is the most important replacement seam.

The worker should be able to switch from:

```text
bun run apps/indexer-cli/src/index.ts
```

to:

```text
/usr/local/bin/indexer-rs
```

without changing the worker.

---

### 12.1 Command shape

Preferred command:

```bash
indexer run \
  --request /path/to/request.json \
  --output /path/to/output-dir
```

Optional command for capabilities:

```bash
indexer capabilities --json
```

Optional command for version:

```bash
indexer version --json
```

---

### 12.2 `request.json`

The driver writes the full `IndexRequest` to:

```text
output/request.json
```

Then invokes:

```bash
indexer run --request output/request.json --output output
```

This avoids huge command-line payloads.

---

### 12.3 CLI stdout/stderr policy

Use this policy:

```text
stdout: machine-readable single final status or empty
stderr: human-readable logs
artifact files: source of truth
```

Do not depend on streaming stdout for the actual artifact.

Allowed stdout:

```json
{"status":"succeeded","manifestPath":"/tmp/out/index-manifest.json","recordsPath":"/tmp/out/records.jsonl"}
```

But the driver should still validate artifact files directly.

---

### 12.4 Exit codes

Recommended exit codes:

```text
0   success
1   generic failure
2   invalid request
3   unsupported schema version
4   workspace invalid
5   output path invalid
6   resource limit exceeded
7   timeout handled by indexer
8   artifact write failure
9   parse/index internal failure
10  cancellation
```

The driver maps exit codes to `IndexerError.code`.

---

### 12.5 Process spawn policy

Use spawn with argument arrays, not shell strings.

Good:

```ts
Bun.spawn([
  executablePath,
  "run",
  "--request",
  requestPath,
  "--output",
  outputPath,
]);
```

Bad:

```ts
Bun.spawn(`${executablePath} run --request ${requestPath}`);
```

Never pass untrusted input through a shell.

---

### 12.6 `CliIndexerDriver` sketch

```ts
export class CliIndexerDriver implements IndexerDriver {
  readonly name = "cli";
  readonly mode = "cli" as const;

  constructor(private readonly deps: CliIndexerDriverDeps) {}

  async getCapabilities(): Promise<IndexerCapabilities> {
    const result = await this.runJsonCommand(["capabilities", "--json"], {
      timeoutMs: 10_000,
    });

    return IndexerCapabilitiesSchema.parse(result);
  }

  async index(request: IndexRequest): Promise<IndexResult> {
    const startedAt = new Date();
    const outputPath = await this.prepareOutputDirectory(request);
    const requestPath = join(outputPath, "request.json");

    await writeJson(requestPath, {
      ...request,
      outputPath,
    });

    const procResult = await this.spawnIndexer({
      args: ["run", "--request", requestPath, "--output", outputPath],
      timeoutMs: request.options.timeoutMs,
      cwd: this.deps.config.cli.workingDirectory,
      env: this.buildSafeEnv(request),
    });

    if (!procResult.success) {
      return this.failedResultFromProcess(request, procResult, startedAt);
    }

    const artifact = await this.validateArtifact(outputPath, request);

    return {
      schemaVersion: "index_result.v1",
      requestId: request.requestId,
      runId: request.runId,
      status: "succeeded",
      driver: {
        name: this.name,
        mode: this.mode,
        version: await this.getDriverVersion(),
      },
      artifact,
      manifest: artifact.manifestSummary,
      stats: artifact.stats,
      errors: [],
      warnings: artifact.warnings,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }
}
```

---

## 13. In-process TypeScript driver

This driver exists for local development and early MVP speed.

It calls `/packages/indexer-ts` directly.

```ts
export class InProcessTypeScriptIndexerDriver implements IndexerDriver {
  readonly name = "in_process_ts";
  readonly mode = "in_process" as const;

  async getCapabilities(): Promise<IndexerCapabilities> {
    return getTypeScriptIndexerCapabilities();
  }

  async index(request: IndexRequest): Promise<IndexResult> {
    const startedAt = new Date();

    try {
      await runTypeScriptIndexer({
        request,
        outputPath: request.outputPath,
      });

      const artifact = await validateArtifactAtPath({
        outputPath: request.outputPath,
        request,
      });

      return makeSuccessIndexResult({
        request,
        startedAt,
        driver: this,
        artifact,
      });
    } catch (error) {
      return makeFailedIndexResult({
        request,
        startedAt,
        driver: this,
        error,
      });
    }
  }
}
```

Risks of in-process mode:

```text
- parser memory not fully freed until worker process exits
- parser crash can crash worker
- harder to apply CPU/memory isolation
- harder to swap language implementation
```

Use it for:

```text
- local dev
- tests
- fast initial implementation
```

Prefer CLI mode for production once stable.

---

## 14. Remote driver

The remote driver is not MVP, but design it now so the boundary holds.

### 14.1 Remote flow

```text
worker
  -> create workspace or archive pointer
  -> submit IndexRequest to remote service
  -> remote service indexes repo
  -> remote service writes artifact to object storage
  -> remote returns artifact URI
  -> worker validates/downloads manifest
  -> importer imports artifact
```

There are two remote modes:

```text
mode A: remote service receives a repo archive/workspace artifact
mode B: remote service fetches repo itself using scoped credentials
```

Mode A is safer initially because no GitHub credential crosses into the indexer service.

Preferred remote input:

```text
workspace archive URI + commit SHA + options
```

Avoid giving the remote service broad provider tokens unless required.

---

### 14.2 Remote API sketch

```http
POST /v1/index-runs
```

Request:

```json
{
  "schemaVersion": "index_request.v1",
  "requestId": "idxreq_...",
  "runId": "idxrun_...",
  "repoId": "repo_...",
  "commitSha": "abc123",
  "workspaceArchiveUri": "s3://...",
  "outputArtifactPrefix": "s3://...",
  "options": {}
}
```

Response:

```json
{
  "schemaVersion": "remote_index_run.v1",
  "remoteRunId": "remote_idxrun_...",
  "status": "queued"
}
```

Polling:

```http
GET /v1/index-runs/{remoteRunId}
```

Completion:

```json
{
  "status": "succeeded",
  "artifactUri": "s3://bucket/index-artifacts/repo_123/abc123/idxrun_.../",
  "manifestHash": "sha256:...",
  "stats": {}
}
```

Cancellation:

```http
DELETE /v1/index-runs/{remoteRunId}
```

---

### 14.3 Remote idempotency

Use an idempotency key:

```text
repoId:commitSha:indexerVersion:schemaVersion:indexOptionsHash
```

The remote service should return an existing successful artifact if the same idempotency key has already completed.

---

## 15. Artifact validation handoff

The driver validates enough to ensure that downstream systems will not crash.

Validation levels:

```text
manifest_only
  - verify manifest exists
  - verify schemaVersion
  - verify repoId and commitSha
  - verify record counts exist

sample
  - manifest checks
  - sample first N records
  - sample random records if file supports seek/index

full
  - parse every JSONL record
  - validate every record against schema
  - verify counts match manifest
  - verify required referenced IDs are internally consistent where feasible
```

Recommended:

```text
local dev:       full
MVP production:  full until artifact size pressure appears
large repos:     sample + importer full validation option
```

The importer should still validate before writing to DB. Driver validation is a fast failure gate.

---

## 16. Indexer capabilities handshake

All drivers should expose capabilities.

For CLI:

```bash
indexer capabilities --json
```

Example output:

```json
{
  "driverName": "ts-indexer-cli",
  "driverVersion": "0.1.0",
  "supportedRequestSchemaVersions": ["index_request.v1"],
  "supportedArtifactSchemaVersions": ["index_artifact.v1"],
  "supportedLanguages": ["typescript", "javascript", "python"],
  "supportedRecordTypes": ["file", "symbol", "edge", "chunk", "diagnostic"],
  "supportsIncremental": true,
  "supportsPreviousArtifact": false,
  "supportsCancellation": false,
  "supportsStreamingProgress": false,
  "supportsRemoteArtifacts": false,
  "maxFileBytes": 1048576,
  "maxFiles": 50000,
  "maxTotalBytes": 1000000000
}
```

The worker should call capabilities on startup and log them.

If the configured driver does not support the current artifact schema, fail startup rather than failing jobs later.

---

## 17. Incremental indexing boundary

Do not overbuild incremental indexing in #9, but include the contract.

### 17.1 Input fields

```ts
previousIndex?: {
  indexVersionId: string;
  commitSha: CommitSha;
  artifactUri?: string;
  manifestHash?: string;
};

changedPaths?: string[];

options: {
  incrementalMode: "disabled" | "content_hash" | "previous_artifact";
};
```

### 17.2 Supported modes

#### `disabled`

Indexer scans the full workspace.

#### `content_hash`

Indexer still walks the repo but may skip expensive parsing/chunking for unchanged file content hashes if it has a local cache.

#### `previous_artifact`

Indexer can read a previous artifact and emit records reused from the prior index plus records for changed files.

### 17.3 Important rule

Even in incremental mode, the output artifact should represent the full index for the requested commit.

Good:

```text
artifact contains all current file/symbol/chunk records for commit abc123
```

Risky:

```text
artifact contains only changed records and requires hidden downstream merge semantics
```

For MVP, prefer full logical artifacts even if internally built incrementally.

---

## 18. Security requirements

### 18.1 No credentials passed to indexer

The indexer should not receive GitHub App installation tokens.

Repo sync handles Git network access before indexing.

The indexer receives:

```text
workspacePath
outputPath
repo metadata
commit SHA
options
```

Not:

```text
GitHub token
private key
webhook secret
database URL
LLM API key
```

---

### 18.2 Sanitized environment

The CLI driver should pass a minimal environment.

Example allowlist:

```text
PATH
HOME only if needed and set to safe temp home
LANG
LC_ALL
TMPDIR
NO_COLOR
```

Avoid passing:

```text
DATABASE_URL
GITHUB_APP_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
OPENAI_API_KEY
ANTHROPIC_API_KEY
REDIS_URL
AWS_SECRET_ACCESS_KEY
```

Implementation:

```ts
function buildSafeEnv(config: IndexerConfig): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of config.cli.envAllowlist) {
    if (process.env[key]) env[key] = process.env[key]!;
  }

  env.NO_COLOR = "1";
  return env;
}
```

---

### 18.3 Do not use shell execution

Never call the CLI through a shell with interpolated strings.

Use argument arrays.

---

### 18.4 Workspace restrictions

The driver should reject requests where:

```text
workspacePath does not exist
workspacePath is not absolute
workspacePath is outside configured workspace root, if configured
workspacePath equals / or another unsafe path
workspacePath is the same as outputPath
outputPath is inside workspacePath, unless explicitly allowed
```

Recommended:

```text
workspacePath: /var/lib/app/workspaces/repo_123/abc123/...
outputPath:    /var/lib/app/index-artifacts/repo_123/abc123/...
```

Do not write artifacts inside the repository worktree by default.

---

### 18.5 User code execution policy

The indexer boundary should default to parse-only behavior.

It should not run:

```text
npm install
pnpm install
bun install
pytest
npm test
eslint project scripts
custom package.json scripts
```

Static analysis tool execution is a separate sandboxed section (#23/#24).

---

## 19. Timeout and cancellation

### 19.1 Timeout behavior

Every index request has:

```ts
request.options.timeoutMs
```

The driver clamps it:

```ts
const timeoutMs = Math.min(
  request.options.timeoutMs,
  config.indexer.maxTimeoutMs,
);
```

For CLI mode:

```text
- start process
- start timer
- on timeout, send termination signal
- wait killGraceMs
- force kill if still running
- mark result timed_out
```

### 19.2 Cancellation

Worker shutdown or job cancellation should abort the process when possible.

For Bun runtime, use `AbortSignal` where supported.

For Node fallback, use `child_process.spawn` and process signals.

### 19.3 Result semantics

Timeout result:

```ts
{
  status: "timed_out",
  errors: [{ code: "timeout", severity: "fatal", message: "..." }]
}
```

Do not return partial artifacts as successful.

If the indexer writes a partial artifact before timeout, the driver should either delete it or mark it unusable.

---

## 20. Logging and output capture

### 20.1 Capture limits

Configure:

```text
stdoutMaxBytes
stderrMaxBytes
```

If exceeded:

```text
- truncate logs
- add warning stdout_truncated/stderr_truncated
- do not keep unbounded memory buffers
```

### 20.2 Redaction

Before persisting logs, redact patterns like:

```text
- GitHub tokens
- API keys
- Authorization headers
- database URLs
- private keys
- common secret formats
```

Even though secrets should not be passed to the indexer, defense-in-depth is required.

### 20.3 Structured events

The driver should emit structured logs like:

```ts
logger.info("indexer.run.started", {
  runId: request.runId,
  repoId: request.repoId,
  commitSha: request.commitSha,
  driver: this.name,
});
```

Avoid logging:

```text
- full source code
- raw artifact records
- credentials
- unredacted environment
```

---

## 21. Observability

### 21.1 Metrics

Emit:

```text
indexer_run_total{driver,status}
indexer_run_duration_ms{driver,status}
indexer_artifact_size_bytes{driver}
indexer_records_total{driver,record_type}
indexer_files_scanned_total{driver,language}
indexer_parse_failures_total{driver,language}
indexer_timeout_total{driver}
indexer_process_exit_nonzero_total{driver,exit_code}
indexer_validation_duration_ms{mode}
indexer_validation_failures_total{reason}
```

### 21.2 Traces

Create spans:

```text
indexer.prepare_output
indexer.write_request
indexer.spawn_cli
indexer.wait_process
indexer.validate_artifact
indexer.collect_stats
```

Attach attributes:

```text
repo.id
commit.sha
indexer.driver
indexer.version
indexer.schema_version
indexer.run_id
```

### 21.3 Artifact references

Every index run should persist or expose:

```text
runId
requestId
repoId
commitSha
driver name/version
artifact local path or URI
manifest hash
record count
status
error codes
```

This may be stored by #2 DB tables and #7 job records, but the driver should produce the data.

---

## 22. Error handling model

### 22.1 Error categories

Use normalized error categories so workers can make decisions.

```text
retryable:
  remote_unavailable
  process_signal if worker shutdown
  artifact store temporary failure

not retryable:
  unsupported_schema_version
  workspace_invalid
  output_path_invalid
  manifest_invalid
  records_invalid

maybe retryable:
  timeout
  resource_limit_exceeded
  process_exit_nonzero
```

### 22.2 Worker retry behavior

The driver should not decide job retry policy. It returns a normalized result.

The worker/job layer decides based on:

```text
error code
attempt number
repo size
job priority
whether review can fall back to diff-only mode
```

### 22.3 Partial failure behavior

If indexing fails but the PR can still be reviewed diff-only, review orchestration may choose fallback mode.

The driver should simply report the indexing failure accurately.

---

## 23. Artifact upload

MVP can keep artifacts on local disk for local development.

Production should support object storage.

### 23.1 Artifact store interface

```ts
export interface IndexArtifactStore {
  putArtifact(input: {
    runId: string;
    repoId: string;
    commitSha: string;
    localPath: string;
  }): Promise<{
    uri: string;
    manifestUri: string;
    recordsUri: string;
    sizeBytes: number;
  }>;

  getArtifact(input: {
    uri: string;
    destinationPath: string;
  }): Promise<void>;
}
```

### 23.2 Upload policy

Recommended:

```text
local dev: local_only
MVP production: object_storage
```

Why upload artifacts?

```text
- workers are ephemeral
- importer may run on a different worker
- review replay/debug needs old artifacts
- blue/green indexer comparisons need preserved outputs
```

### 23.3 Hashing

Compute and store:

```text
manifestHash
recordsHash
artifactDirectoryHash optional
```

Use these to detect corruption or mismatched imports.

---

## 24. Blue/green indexer rollout

The boundary should support testing a new indexer implementation against the current one.

### 24.1 Shadow mode

Run primary indexer and shadow indexer:

```text
primary: ts-indexer-cli
shadow:  rust-indexer-cli
```

Only primary artifact is imported.

Shadow artifact is stored and compared.

### 24.2 Compare outputs

Compare:

```text
file count
symbol count
edge count
chunk count
language counts
parse failures
manifest fields
artifact size
runtime
```

Optional deeper comparison:

```text
stable IDs found by both
symbols only in primary
symbols only in shadow
chunk boundary differences
edge differences
```

### 24.3 Rollout config

```text
INDEXER_DRIVER=cli
INDEXER_SHADOW_DRIVER=rust_cli
INDEXER_SHADOW_PERCENT=5
```

Shadow mode is not MVP, but the driver/result model should not prevent it.

---

## 25. Integration with worker jobs

The worker job should call the indexer boundary like this:

```ts
export async function indexRepoCommitJob(job: IndexRepoCommitJob) {
  const workspace = await repoSync.checkout({
    repoId: job.repoId,
    commitSha: job.commitSha,
    installationId: job.installationId,
  });

  try {
    const request = buildIndexRequest({
      job,
      workspacePath: workspace.path,
      outputPath: createArtifactOutputPath(job),
      options: await resolveIndexOptions(job.repoId),
    });

    const result = await indexer.index(request);

    await recordIndexRunResult(result);

    if (result.status !== "succeeded") {
      throw new IndexingFailedError(result);
    }

    await enqueueImportArtifactJob({
      repoId: job.repoId,
      commitSha: job.commitSha,
      runId: result.runId,
      artifactUri: result.artifact?.uri ?? result.artifact?.localPath,
      manifestHash: result.artifact?.manifestHash,
    });
  } finally {
    await workspace.release();
  }
}
```

Important:

```text
- workspace release is always in finally
- indexer does not import DB rows
- import job can be separate from index job
- embedding jobs are queued by importer, not indexer driver
```

---

## 26. Integration with DB layer

The indexer driver itself should not write a lot of DB state.

However, the worker can persist:

```text
repo_index_versions pending/running/succeeded/failed
background_jobs status
review_artifacts or index_artifacts references
index run stats
```

Recommended status flow:

```text
repo_index_versions.status = pending
  -> running when driver starts
  -> artifact_created when driver succeeds
  -> importing when importer starts
  -> complete when importer succeeds
  -> failed when driver/importer fails
```

Do not mark an index version complete just because the driver produced an artifact. It is complete only after the importer validates and writes it.

---

## 27. Integration with index artifact schema (#10)

The driver should depend on `/packages/index-schema` for:

```text
- request schema validation
- manifest validation
- record validation
- compatibility checks
```

Example:

```ts
import {
  validateIndexManifestFile,
  validateIndexRecordsFile,
  assertArtifactCompatible,
} from "@repo/index-schema";
```

Driver success requires:

```text
- manifest exists
- records file exists
- manifest schema is supported
- manifest repoId matches request repoId
- manifest commitSha matches request commitSha
- record count <= configured limit
- artifact size <= configured limit
```

Full record referential integrity can be owned by #12 importer.

---

## 28. Integration with the future TypeScript indexer (#11)

The TypeScript indexer should expose a function like:

```ts
export async function runTypeScriptIndexer(input: {
  request: IndexRequest;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<void>;
```

It writes:

```text
index-manifest.json
records.jsonl
```

It should not return a huge object in memory.

The artifact file is the output.

This avoids loading millions of records into the worker process.

---

## 29. Integration with index importer (#12)

The importer receives:

```ts
type ImportIndexArtifactJob = {
  repoId: string;
  commitSha: string;
  indexRunId: string;
  artifactUri: string;
  manifestHash: string;
};
```

The importer should not care whether the artifact came from:

```text
- in-process TypeScript indexer
- CLI TypeScript indexer
- Rust CLI indexer
- remote indexer
```

This is the success criterion for #9.

---

## 30. Integration with retrieval and review

Retrieval and review should never call the indexer directly except through orchestration.

Correct dependency direction:

```text
review orchestrator
  -> ensureIndexExists
  -> indexer boundary if missing
  -> importer
  -> retriever
  -> review engine
```

Incorrect:

```text
retriever imports parser
review engine asks indexer for AST nodes
LLM prompt uses tree-sitter node object shape
```

Retrieval should query normalized DB/vector/graph records after import.

---

## 31. Stable IDs and boundary expectations

The indexer implementation should emit stable IDs. The boundary should not generate record IDs after the fact except for run metadata.

Expected stable ID inputs:

```text
repoId
commitSha
path
symbol name/kind/location
content hash
chunker version
```

The driver can validate ID shape but should not rewrite IDs.

Reason:

```text
TS indexer and Rust indexer should be comparable.
```

If IDs are random or DB-generated, artifact comparison becomes much less useful.

---

## 32. Resource limits

The indexer boundary should enforce request-level limits.

Limits:

```text
timeoutMs
maxFileBytes
maxFiles
maxTotalBytes
maxRecords
maxArtifactBytes
stdoutMaxBytes
stderrMaxBytes
```

Some limits are enforced by the indexer implementation; some by the driver.

Driver-enforced:

```text
timeout
stdout/stderr capture
artifact size
manifest existence
output path safety
```

Indexer-enforced:

```text
max file bytes
max file count
max total bytes
max records
```

Importer-enforced:

```text
record validity
referential integrity
DB row limits
```

---

## 33. Local development workflow

### 33.1 Run indexer directly

```bash
pnpm indexer -- run \
  --request ./fixtures/requests/simple-repo.request.json \
  --output ./tmp/index/simple-repo
```

### 33.2 Validate artifact

```bash
pnpm indexer -- validate \
  --artifact ./tmp/index/simple-repo
```

### 33.3 Worker-driven indexing

```bash
pnpm dev:worker
pnpm queue:enqueue index.repo --repo repo_123 --commit abc123
```

### 33.4 Compare drivers

```bash
pnpm indexer -- compare \
  --left ./tmp/index/ts \
  --right ./tmp/index/rust
```

The compare command may live in #32 CLI/dev tools, but the artifact format should support it.

---

## 34. Suggested files

```text
/packages/indexer-driver
  package.json
  tsconfig.json
  src/index.ts
  src/types.ts
  src/config.ts
  src/registry.ts
  src/errors.ts
  src/result.ts
  src/path-safety.ts
  src/output-dir.ts
  src/artifact-store.ts
  src/artifact-validation.ts
  src/drivers/in-process-ts-driver.ts
  src/drivers/cli-driver.ts
  src/drivers/remote-driver.ts
  src/drivers/fake-driver.ts
  src/process/spawn-indexer.ts
  src/process/capture-output.ts
  src/process/safe-env.ts
  src/testing/create-fake-artifact.ts
  src/testing/fake-indexer-driver.ts
  test/cli-driver.test.ts
  test/path-safety.test.ts
  test/artifact-validation.test.ts
  test/fake-driver.test.ts

/apps/indexer-cli
  package.json
  tsconfig.json
  src/index.ts
  src/commands/run.ts
  src/commands/capabilities.ts
  src/commands/version.ts
  src/commands/validate.ts
```

---

## 35. `package.json` for `/packages/indexer-driver`

```json
{
  "name": "@repo/indexer-driver",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing/index.ts"
  },
  "dependencies": {
    "@repo/contracts": "workspace:*",
    "@repo/index-schema": "workspace:*",
    "@repo/config": "workspace:*",
    "@repo/observability": "workspace:*"
  },
  "devDependencies": {
    "typescript": "catalog:",
    "vitest": "catalog:"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "biome check .",
    "format": "biome format --write ."
  }
}
```

---

## 36. Path safety helper

```ts
import { resolve, relative, isAbsolute } from "node:path";

export function assertPathInside(input: {
  path: string;
  root: string;
  label: string;
}): string {
  if (!isAbsolute(input.path)) {
    throw new Error(`${input.label} must be absolute`);
  }

  const resolvedPath = resolve(input.path);
  const resolvedRoot = resolve(input.root);
  const rel = relative(resolvedRoot, resolvedPath);

  if (rel.startsWith("..") || rel === ".." || isAbsolute(rel)) {
    throw new Error(`${input.label} must be inside configured root`);
  }

  return resolvedPath;
}
```

Use for:

```text
outputPath under artifactRootPath
workspacePath under workspaceRoot when configured
```

---

## 37. Safe environment helper

```ts
const DEFAULT_ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TMPDIR"];

export function buildSafeIndexerEnv(input: {
  allowlist?: string[];
  extra?: Record<string, string>;
}): Record<string, string> {
  const allowlist = input.allowlist ?? DEFAULT_ENV_ALLOWLIST;
  const env: Record<string, string> = {};

  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  env.NO_COLOR = "1";

  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (isDisallowedSecretKey(key)) {
      throw new Error(`Refusing to pass secret-like env var to indexer: ${key}`);
    }
    env[key] = value;
  }

  return env;
}

function isDisallowedSecretKey(key: string): boolean {
  return /(TOKEN|SECRET|KEY|PASSWORD|DATABASE_URL|REDIS_URL)/i.test(key);
}
```

---

## 38. Spawn helper

Create a runtime-compatible wrapper.

```ts
export type SpawnIndexerInput = {
  executablePath: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  timeoutMs: number;
  killGraceMs: number;
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
};

export type SpawnIndexerResult = {
  success: boolean;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
};
```

Implementation options:

```text
- Bun.spawn when running under Bun
- node:child_process.spawn fallback when running under Node
```

Use a single exported wrapper so the rest of the driver does not care about runtime differences.

---

## 39. Result helpers

Create:

```text
/packages/indexer-driver/src/result.ts
```

Helpers:

```ts
export function makeSuccessIndexResult(input: ...): IndexResult;
export function makeFailedIndexResult(input: ...): IndexResult;
export function mapExitCodeToError(exitCode: number | null): IndexerError;
export function classifyIndexerError(error: unknown): IndexerError;
```

This keeps error mapping consistent across drivers.

---

## 40. Artifact validation helper

```ts
export async function validateArtifactAtPath(input: {
  request: IndexRequest;
  outputPath: string;
  mode: "manifest_only" | "sample" | "full";
  sampleSize: number;
  maxArtifactBytes: number;
}): Promise<ValidatedIndexArtifact> {
  const manifestPath = join(input.outputPath, "index-manifest.json");
  const recordsPath = join(input.outputPath, "records.jsonl");

  assertFileExists(manifestPath);
  assertFileExists(recordsPath);

  const manifest = await validateIndexManifestFile(manifestPath);

  if (manifest.repoId !== input.request.repoId) {
    throw new ArtifactValidationError("manifest repoId mismatch");
  }

  if (manifest.commitSha !== input.request.commitSha) {
    throw new ArtifactValidationError("manifest commitSha mismatch");
  }

  if (input.mode === "full") {
    await validateIndexRecordsFile(recordsPath, { manifest });
  } else if (input.mode === "sample") {
    await validateIndexRecordsSample(recordsPath, {
      manifest,
      sampleSize: input.sampleSize,
    });
  }

  return buildValidatedArtifactSummary({
    manifest,
    manifestPath,
    recordsPath,
  });
}
```

---

## 41. Testing strategy

### 41.1 Unit tests

Test:

```text
- driver registry selection
- config parsing
- safe env allowlist
- disallow secret-like env vars
- output path generation
- path safety
- timeout clamping
- exit code mapping
- artifact validation success
- artifact validation failure
```

### 41.2 CLI driver tests

Use a fake CLI script that can:

```text
- write a valid artifact
- exit nonzero
- sleep past timeout
- write huge stdout/stderr
- write invalid manifest
- write invalid records
- omit records file
```

Test:

```text
- successful run
- failure maps to normalized error
- timeout kills process
- stdout/stderr truncation
- invalid artifact returns failed result
- no shell interpolation
```

### 41.3 In-process driver tests

Test:

```text
- calls fake in-process implementation
- catches thrown errors
- validates artifact
- returns normalized result
```

### 41.4 Remote driver tests

Mock HTTP:

```text
- submit success
- poll success
- poll timeout
- remote failure
- remote unavailable
- cancellation
```

Remote driver can be skeletal in MVP, but tests should define the contract.

### 41.5 Contract tests

Create a fixture artifact and verify all drivers can return equivalent `IndexResult` for it.

---

## 42. Integration tests

Use a tiny fixture repo:

```text
fixtures/repos/simple-ts
  src/index.ts
  src/math.ts
  package.json
```

Run:

```text
repo-sync checkout fixture
  -> CLI indexer
  -> validate artifact
  -> importer dry run
```

Expected:

```text
- result status succeeded
- manifest repoId and commitSha match
- file records exist
- symbol records exist
- chunk records exist
- no absolute local paths in records
```

---

## 43. Definition of done

#9 is complete when:

```text
- /packages/indexer-driver exists
- IndexerDriver interface is implemented
- driver registry works
- fake driver works
- in-process driver shell exists
- CLI driver works against a fake CLI
- remote driver placeholder exists with typed interface
- config is defined and validated
- safe env helper exists
- path safety helper exists
- output directory creation works
- request.json writing works
- process timeout/cancellation works
- stdout/stderr capture and truncation work
- artifact validation handoff works
- normalized IndexResult is returned
- unit tests cover success/failure/timeout/invalid artifact
- worker can call indexer through the boundary without importing parser internals
```

It is okay if the real TypeScript indexer is still minimal. The boundary is the deliverable.

---

## 44. Implementation sequence

### PR 1: Package shell and types

Implement:

```text
/packages/indexer-driver/package.json
/packages/indexer-driver/src/types.ts
/packages/indexer-driver/src/index.ts
basic exports
unit tests for type helpers if needed
```

Deliverable:

```text
IndexRequest, IndexResult, IndexerDriver, capabilities types
```

---

### PR 2: Config and registry

Implement:

```text
IndexerConfig
config env parsing
createIndexerDriver registry
FakeIndexerDriver
```

Deliverable:

```text
worker can instantiate fake driver from config
```

---

### PR 3: Path/output helpers

Implement:

```text
output directory generation
path safety helper
request.json writer
artifact path constants
```

Deliverable:

```text
driver can prepare an output directory safely
```

---

### PR 4: Artifact validation handoff

Implement:

```text
validateArtifactAtPath
manifest-only validation
full validation stub calling /packages/index-schema
hash computation
artifact summary
```

Deliverable:

```text
valid fixture artifact produces ValidatedIndexArtifact
invalid artifact fails clearly
```

---

### PR 5: CLI spawn wrapper

Implement:

```text
spawnIndexer
stdout/stderr capture
truncation
timeout
kill grace period
exit code mapping
safe env builder
```

Deliverable:

```text
fake CLI can be run, timed out, and failed deterministically
```

---

### PR 6: CliIndexerDriver

Implement:

```text
capabilities command
version command
run command
IndexResult normalization
logs capture
artifact validation
```

Deliverable:

```text
CLI driver works against fake CLI and produces normalized results
```

---

### PR 7: InProcessTypeScriptIndexerDriver shell

Implement:

```text
in-process driver that calls injected function
real /packages/indexer-ts integration can wait
```

Deliverable:

```text
local dev can run in-process mode against fake implementation
```

---

### PR 8: Remote driver placeholder

Implement:

```text
RemoteIndexerDriver typed API
submit/poll/cancel contract
mock tests
```

Deliverable:

```text
future remote indexer path is defined
```

---

### PR 9: Worker integration

Implement:

```text
indexRepoCommit job calls IndexerDriver
stores IndexResult summary
queues import artifact job on success
```

Deliverable:

```text
worker no longer imports parser internals
```

---

## 45. MVP cut

For MVP, implement:

```text
- IndexerDriver interface
- IndexRequest/IndexResult
- config
- registry
- fake driver
- CLI driver
- output directory management
- request.json protocol
- safe env
- timeout handling
- artifact validation handoff
- worker integration
```

Defer:

```text
- remote driver production support
- shadow indexer mode
- advanced incremental indexing
- object storage artifact upload if local-only dev is enough
- deep artifact comparison tooling
- resource cgroups/container sandboxing
```

---

## 46. Recommended default configuration by environment

### Local dev

```text
INDEXER_DRIVER=in_process_ts
INDEXER_VALIDATE_RECORD_MODE=full
INDEXER_ARTIFACT_UPLOAD_MODE=local_only
```

### CI

```text
INDEXER_DRIVER=cli
INDEXER_VALIDATE_RECORD_MODE=full
INDEXER_ARTIFACT_UPLOAD_MODE=local_only
```

### MVP production

```text
INDEXER_DRIVER=cli
INDEXER_VALIDATE_RECORD_MODE=full
INDEXER_ARTIFACT_UPLOAD_MODE=object_storage
```

### Future high-scale production

```text
INDEXER_DRIVER=remote
INDEXER_VALIDATE_RECORD_MODE=sample
INDEXER_ARTIFACT_UPLOAD_MODE=object_storage
```

The importer should still do strong validation before writing durable index records.

---

## 47. Risks and mitigations

### Risk: artifact schema changes too often

Mitigation:

```text
- schemaVersion required in manifest
- compatibility checks
- migration helpers
- fixture tests
```

### Risk: CLI indexer emits too much stdout/stderr

Mitigation:

```text
- capture limits
- truncation warnings
- prefer artifact files over stdout
```

### Risk: parser crashes worker

Mitigation:

```text
- use CLI mode in production
- process isolation
- timeout and kill behavior
```

### Risk: new Rust indexer emits incompatible IDs

Mitigation:

```text
- stable ID rules
- artifact comparison tests
- shadow mode
```

### Risk: remote indexer needs credentials

Mitigation:

```text
- prefer workspace archive handoff
- never pass broad GitHub tokens
- use scoped short-lived artifact URLs
```

### Risk: validation duplicates importer work

Mitigation:

```text
- driver validation is a fast gate
- importer remains source of truth for DB safety
- validation mode can be tuned
```

---

## 48. Success criteria

The indexer boundary is successful if we can do this later:

```text
INDEXER_DRIVER=cli
INDEXER_CLI_EXECUTABLE_PATH=/usr/local/bin/indexer-rs
```

and the rest of the system continues to work.

Specifically:

```text
- worker still calls indexer.index(request)
- importer still receives artifact URI
- retrieval still queries normalized DB rows
- review engine still receives ContextBundle
- publisher still receives findings
```

No changes should be required in:

```text
/packages/retrieval
/packages/review-engine
/packages/publisher
/packages/github
/apps/web
```

That is the whole point of #9.

---

## 49. Final architecture summary

```text
/apps/worker
  -> /packages/repo-sync gives workspace
  -> /packages/indexer-driver invokes active indexer
  -> indexer emits artifact
  -> /packages/index-schema validates artifact
  -> /packages/index-importer imports artifact
  -> /packages/embedding embeds chunks
  -> /packages/retrieval builds ContextBundle
  -> /packages/review-engine reviews PR
```

The key rule:

```text
The indexer is a producer of versioned artifacts, not an internal parser library that the rest of the app reaches into.
```

Build this boundary well, and the future high-performance indexer is a deployment/configuration change instead of a rewrite.
