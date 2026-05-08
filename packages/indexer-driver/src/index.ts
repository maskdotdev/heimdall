import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type CodeLanguage,
  INDEX_ARTIFACT_SCHEMA_VERSION,
  type IndexManifest,
  IndexManifestSchema,
  type IndexRecord,
  IndexRecordSchema,
} from "@repo/index-schema";
import {
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryAttributeValue,
  type TelemetryMetricRecorder,
  type TelemetrySpanRecorder,
  type TelemetryTraceContextInput,
} from "@repo/observability";
import { Value } from "@sinclair/typebox/value";

export const packageName = "@repo/indexer-driver" as const;

/** Repository commit input consumed by durable index drivers. */
export type IndexRepositoryInput = {
  /** Heimdall repository ID. */
  readonly repoId: string;
  /** Commit SHA to index. */
  readonly commitSha: string;
  /** Absolute workspace path checked out at commitSha. */
  readonly workspacePath: string;
  /** Optional previous imported index version for incremental drivers. */
  readonly previousIndexVersionId?: string;
  /** Optional cancellation signal propagated by driver wrappers. */
  readonly signal?: AbortSignal;
  /** Optional product-safe telemetry passed through driver wrappers and implementations. */
  readonly telemetry?: IndexerTelemetryOptions;
};

/** Validated index artifact emitted by a driver before database import. */
export type IndexArtifact = {
  /** Artifact manifest with counts and provenance. */
  readonly manifest: IndexManifest;
  /** Line-oriented artifact records. */
  readonly records: readonly IndexRecord[];
};

/** Durable failure category used by workers and job metadata. */
export type IndexerFailure = {
  /** Machine-readable failure code. */
  readonly code:
    | "artifact_invalid"
    | "cancelled"
    | "filesystem_error"
    | "process_exit_nonzero"
    | "process_signal"
    | "request_invalid"
    | "remote_job_failed"
    | "remote_unavailable"
    | "unsupported_language"
    | "timeout"
    | "unknown";
  /** Human-readable failure message. */
  readonly message: string;
  /** Optional structured context safe for job metadata. */
  readonly details?: Record<string, unknown>;
};

/** Result returned by any code indexer implementation. */
export type IndexRepositoryResult =
  | {
      readonly ok: true;
      readonly artifact: IndexArtifact;
      /** Durable artifact URI returned by drivers that already persisted the artifact. */
      readonly artifactUri?: string;
      readonly diagnostics: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: IndexerFailure;
      readonly diagnostics: readonly string[];
    };

/** Indexer request schema currently produced by worker-side driver adapters. */
export const INDEX_REQUEST_SCHEMA_VERSION = "index_request.v1" as const;

/** Artifact schema version currently accepted by the importer boundary. */
export const CURRENT_INDEX_ARTIFACT_SCHEMA_VERSION = INDEX_ARTIFACT_SCHEMA_VERSION;

/** Record types that an indexer implementation can emit. */
export type IndexerRecordType = IndexRecord["type"];

/** Capabilities exposed by one concrete indexer implementation. */
export type IndexerCapabilities = {
  /** Stable driver or implementation name. */
  readonly driverName: string;
  /** Driver or implementation version. */
  readonly driverVersion: string;
  /** Request schema versions accepted by the driver. */
  readonly supportedRequestSchemaVersions: readonly string[];
  /** Artifact schema versions emitted by the driver. */
  readonly supportedArtifactSchemaVersions: readonly string[];
  /** Source languages the driver can index. */
  readonly supportedLanguages: readonly CodeLanguage[];
  /** Artifact record types the driver can emit. */
  readonly supportedRecordTypes: readonly IndexerRecordType[];
  /** Whether the driver supports incremental indexing in any mode. */
  readonly supportsIncremental: boolean;
  /** Whether the driver can consume a previous artifact as incremental input. */
  readonly supportsPreviousArtifact: boolean;
  /** Whether the driver supports cancellation while indexing. */
  readonly supportsCancellation: boolean;
  /** Whether the driver can stream progress while indexing. */
  readonly supportsStreamingProgress: boolean;
  /** Whether the driver can return already-persisted remote artifact URIs. */
  readonly supportsRemoteArtifacts: boolean;
  /** Maximum file size accepted by the driver when known. */
  readonly maxFileBytes?: number;
  /** Maximum file count accepted by the driver when known. */
  readonly maxFiles?: number;
  /** Maximum total indexed bytes accepted by the driver when known. */
  readonly maxTotalBytes?: number;
};

/** Contract implemented by local, remote, or sandboxed code indexers. */
export type CodeIndexerDriver = {
  /** Stable driver name. */
  readonly name: string;
  /** Driver implementation version. */
  readonly version: string;
  /** Returns the driver's supported schemas, languages, records, and runtime features. */
  readonly getCapabilities: () => Promise<IndexerCapabilities>;
  /** Indexes a checked-out repository commit into a durable artifact. */
  readonly indexRepository: (input: IndexRepositoryInput) => Promise<IndexRepositoryResult>;
};

/** Registry for selecting an indexer driver by stable name. */
export type IndexerDriverRegistry = {
  /** Returns registered driver names. */
  readonly names: () => readonly string[];
  /** Returns a registered driver by name when present. */
  readonly get: (name: string) => CodeIndexerDriver | undefined;
};

/** Options for creating a deterministic fake indexer driver. */
export type FakeIndexerDriverOptions = {
  /** Stable driver name. */
  readonly name?: string;
  /** Driver implementation version. */
  readonly version?: string;
  /** Successful artifact returned by the fake driver. */
  readonly artifact?: IndexArtifact;
  /** Durable artifact URI returned with successful fake results. */
  readonly artifactUri?: string;
  /** Capabilities returned by the fake driver. */
  readonly capabilities?: Partial<IndexerCapabilities>;
  /** Failure returned by the fake driver. */
  readonly failure?: IndexerFailure;
  /** Diagnostics returned with either success or failure. */
  readonly diagnostics?: readonly string[];
};

/** Options for creating a CLI-backed indexer driver. */
export type CliIndexerDriverOptions = {
  /** Stable driver name. */
  readonly name?: string;
  /** Driver implementation version. */
  readonly version?: string;
  /** Executable path used for process spawning. */
  readonly command: string;
  /** Command arguments that precede the index protocol arguments. */
  readonly args?: readonly string[];
  /** Root directory where per-run request, logs, and artifacts are written. */
  readonly artifactRootPath: string;
  /** Optional workspace root that all index workspaces must stay inside. */
  readonly workspaceRootPath?: string;
  /** Environment variable names allowed through to the CLI process. */
  readonly envAllowlist?: readonly string[];
  /** Maximum stdout bytes retained in memory and logs. */
  readonly stdoutMaxBytes?: number;
  /** Maximum stderr bytes retained in memory and logs. */
  readonly stderrMaxBytes?: number;
  /** Maximum time one process may run before it is terminated. */
  readonly timeoutMs?: number;
  /** Time to wait after SIGTERM before sending SIGKILL. */
  readonly killGraceMs?: number;
};

/** Options for creating an HTTP remote indexer driver. */
export type RemoteIndexerDriverOptions = {
  /** Stable driver name. */
  readonly name?: string;
  /** Driver implementation version. */
  readonly version?: string;
  /** Remote indexer service base URL. */
  readonly baseUrl: string;
  /** Optional bearer token for the remote indexer control API. */
  readonly bearerToken?: string;
  /** Fetch implementation used by production code or tests. */
  readonly fetch?: RemoteIndexerFetch;
  /** Delay between remote job status polls. */
  readonly pollIntervalMs?: number;
  /** Maximum time to poll one remote job before returning timeout. */
  readonly maxPollMs?: number;
};

/** Fetch implementation consumed by the remote indexer driver. */
export type RemoteIndexerFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Request JSON written for CLI indexer processes. */
export type CliIndexerRequestFile = {
  /** Heimdall repository ID. */
  readonly repoId: string;
  /** Commit SHA to index. */
  readonly commitSha: string;
  /** Absolute workspace path checked out at commitSha. */
  readonly workspacePath: string;
  /** Output artifact JSON path expected from the CLI. */
  readonly outputPath: string;
  /** Optional previous imported index version for incremental drivers. */
  readonly previousIndexVersionId?: string;
};

/** Safe process environment input used by the CLI driver. */
export type BuildSafeIndexerEnvInput = {
  /** Source environment values. */
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  /** Environment variable names allowed to pass through. */
  readonly allowlist?: readonly string[];
};

/** Options for adding timeout handling around an indexer driver. */
export type IndexerTimeoutOptions = {
  /** Maximum time one index request may run before a timeout result is returned. */
  readonly timeoutMs: number;
};

/** Product-safe telemetry dependencies used by indexer driver wrappers. */
export type IndexerTelemetryOptions = {
  /** Optional metric recorder for low-cardinality indexer metrics. */
  readonly metrics?: TelemetryMetricRecorder;
  /** Optional span recorder for product-safe indexer traces. */
  readonly traces?: TelemetrySpanRecorder;
  /** Optional trace context propagated from durable job boundaries. */
  readonly traceContext?: TelemetryTraceContextInput;
};

/** Telemetry context for validating an artifact at an indexer boundary. */
export type IndexArtifactValidationTelemetryInput = IndexerTelemetryOptions & {
  /** Stable driver name attached to validation spans. */
  readonly driverName: string;
  /** Driver implementation version attached to validation spans. */
  readonly driverVersion: string;
};

/** Input used to validate CLI indexer filesystem boundaries. */
type ValidateCliIndexerPathsInput = {
  /** Root directory where artifacts are written. */
  readonly artifactRootPath: string;
  /** Workspace path supplied by the index job. */
  readonly workspacePath: string;
  /** Optional workspace root that must contain workspacePath. */
  readonly workspaceRootPath?: string;
};

/** Input used to run one CLI indexer process. */
type RunCliIndexerProcessInput = {
  /** Executable path used for process spawning. */
  readonly command: string;
  /** Spawn argument array. */
  readonly args: readonly string[];
  /** Safe process environment. */
  readonly env: Record<string, string>;
  /** Maximum stdout bytes retained. */
  readonly stdoutMaxBytes: number;
  /** Maximum stderr bytes retained. */
  readonly stderrMaxBytes: number;
  /** Maximum process runtime in milliseconds. */
  readonly timeoutMs: number;
  /** Grace period before force kill. */
  readonly killGraceMs: number;
  /** Optional external cancellation signal. */
  readonly signal?: AbortSignal;
};

/** Bounded process output captured from stdout or stderr. */
type CapturedProcessOutput = {
  /** Captured text, truncated if byte limits were exceeded. */
  readonly text: string;
  /** Total bytes observed before truncation. */
  readonly byteLength: number;
  /** Whether bytes were dropped after the configured limit. */
  readonly truncated: boolean;
};

/** Result of one CLI indexer process. */
type CliIndexerProcessResult =
  | {
      /** Process exited normally. */
      readonly status: "exited";
      /** Numeric process exit code. */
      readonly exitCode: number;
      /** Captured stdout. */
      readonly stdout: CapturedProcessOutput;
      /** Captured stderr. */
      readonly stderr: CapturedProcessOutput;
    }
  | {
      /** Process ended because of a signal. */
      readonly status: "signaled";
      /** Signal that ended the process. */
      readonly signal: string;
      /** Captured stdout. */
      readonly stdout: CapturedProcessOutput;
      /** Captured stderr. */
      readonly stderr: CapturedProcessOutput;
    }
  | {
      /** Process failed before it could start or complete. */
      readonly status: "error";
      /** Spawn or process error. */
      readonly error: Error;
      /** Captured stdout. */
      readonly stdout: CapturedProcessOutput;
      /** Captured stderr. */
      readonly stderr: CapturedProcessOutput;
    }
  | {
      /** Process exceeded the configured timeout. */
      readonly status: "timed_out";
      /** Captured stdout. */
      readonly stdout: CapturedProcessOutput;
      /** Captured stderr. */
      readonly stderr: CapturedProcessOutput;
    }
  | {
      /** Process was cancelled by the caller. */
      readonly status: "cancelled";
      /** Captured stdout. */
      readonly stdout: CapturedProcessOutput;
      /** Captured stderr. */
      readonly stderr: CapturedProcessOutput;
    };

/** Remote API request body sent when submitting an index run. */
type RemoteIndexerRequestBody = {
  /** Request schema version understood by the remote service. */
  readonly schemaVersion: "index_request.v1";
  /** Unique request ID for idempotent remote logs. */
  readonly requestId: string;
  /** Unique logical index run ID. */
  readonly runId: string;
  /** Heimdall repository ID. */
  readonly repoId: string;
  /** Commit SHA to index. */
  readonly commitSha: string;
  /** Absolute workspace path when the remote service shares worker storage. */
  readonly workspacePath: string;
  /** Optional previous imported index version for incremental drivers. */
  readonly previousIndexVersionId?: string;
};

/** Normalized remote run response after parsing an HTTP JSON body. */
type NormalizedRemoteIndexRun = {
  /** Remote run status. */
  readonly status: RemoteIndexRunStatus;
  /** Remote service run ID used for polling. */
  readonly remoteRunId?: string;
  /** Inline validated artifact candidate. */
  readonly artifact?: IndexArtifact;
  /** Durable artifact URI already written by the remote service. */
  readonly artifactUri?: string;
  /** HTTP URL from which the worker can download the artifact JSON. */
  readonly artifactUrl?: string;
  /** Diagnostics safe to attach to job metadata. */
  readonly diagnostics: readonly string[];
  /** Normalized terminal failure, when supplied by the remote service. */
  readonly error?: IndexerFailure;
};

/** Status values returned by the remote indexer protocol. */
type RemoteIndexRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "timed_out";

/** Bounded append-only capture buffer. */
type BoundedCapture = {
  /** Appends a stdout or stderr chunk. */
  readonly append: (chunk: Buffer | string) => void;
  /** Returns the current captured output. */
  readonly snapshot: () => CapturedProcessOutput;
};

/** Default CLI driver stdout or stderr capture limit. */
const DEFAULT_CLI_CAPTURE_MAX_BYTES = 64 * 1024;

/** Default CLI driver process timeout. */
const DEFAULT_CLI_TIMEOUT_MS = 120_000;

/** Default timeout for indexer capability handshake commands. */
const DEFAULT_CAPABILITIES_TIMEOUT_MS = 10_000;

/** Default grace period before force-killing timed-out CLI processes. */
const DEFAULT_CLI_KILL_GRACE_MS = 1_000;

/** Environment variables safe for parser-only indexer child processes by default. */
const DEFAULT_INDEXER_ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TMPDIR", "NO_COLOR"] as const;

/** Default delay between remote indexer poll requests. */
const DEFAULT_REMOTE_POLL_INTERVAL_MS = 1_000;

/** Default maximum time spent polling a remote indexer job. */
const DEFAULT_REMOTE_MAX_POLL_MS = 120_000;

/** Validates an index artifact before it crosses the importer boundary. */
export function validateIndexArtifact(artifact: IndexArtifact): readonly string[] {
  const errors: string[] = [];

  if (!Value.Check(IndexManifestSchema, artifact.manifest)) {
    errors.push(
      ...[...Value.Errors(IndexManifestSchema, artifact.manifest)].map((error) => error.message),
    );
  }

  for (const [index, record] of artifact.records.entries()) {
    if (!Value.Check(IndexRecordSchema, record)) {
      errors.push(
        ...[...Value.Errors(IndexRecordSchema, record)].map(
          (error) => `records[${index}] ${error.path}: ${error.message}`,
        ),
      );
    }
  }

  if (artifact.manifest.recordCount !== artifact.records.length) {
    errors.push(
      `manifest.recordCount ${artifact.manifest.recordCount} does not match ${artifact.records.length} records`,
    );
  }
  errors.push(...validateIndexArtifactRecordSemantics(artifact));

  return errors;
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

  artifact.records.forEach((record, index) => {
    collectRecordIdentity(errors, {
      index,
      record,
      fileIds,
      filePaths,
      symbolIds,
      chunkIds,
      edgeIds,
      counts,
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

/** Validates an index artifact and emits a product-safe validation span when configured. */
export function validateIndexArtifactWithTelemetry(
  artifact: IndexArtifact,
  input: IndexArtifactValidationTelemetryInput,
): readonly string[] {
  const span = input.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.indexerDriverValidateResult, {
    attributes: {
      ...indexArtifactValidationAttributes(artifact),
      "indexer_driver.driver": normalizeTelemetryLabel(input.driverName),
      "indexer_driver.version": input.driverVersion,
    },
    kind: "internal",
    ...(input.traceContext ? { traceContext: input.traceContext } : {}),
  });

  try {
    const validationErrors = validateIndexArtifact(artifact);
    span?.end({
      attributes: {
        "indexer_driver.status": validationErrors.length === 0 ? "succeeded" : "failed",
        "indexer_driver.validation_error_count": validationErrors.length,
      },
      status: validationErrors.length === 0 ? "ok" : "error",
    });

    return validationErrors;
  } catch (error) {
    span?.end({
      attributes: {
        "indexer_driver.error_class": "validation_error",
        "indexer_driver.status": "failed",
      },
      status: "error",
    });
    throw error;
  }
}

/** Converts an unknown thrown value to a durable indexer failure. */
export function toIndexerFailure(
  error: unknown,
  code: IndexerFailure["code"] = "unknown",
): IndexerFailure {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Parses and validates an indexer capability payload from a driver, CLI, or remote service. */
export function parseIndexerCapabilities(value: unknown): IndexerCapabilities {
  const errors = validateIndexerCapabilities(value);
  if (errors.length > 0) {
    throw new Error(`Invalid indexer capabilities: ${errors.join("; ")}`);
  }

  const record = value as Record<string, unknown>;

  return {
    driverName: record.driverName as string,
    driverVersion: record.driverVersion as string,
    supportedArtifactSchemaVersions: record.supportedArtifactSchemaVersions as readonly string[],
    supportedLanguages: record.supportedLanguages as readonly CodeLanguage[],
    supportedRecordTypes: record.supportedRecordTypes as readonly IndexerRecordType[],
    supportedRequestSchemaVersions: record.supportedRequestSchemaVersions as readonly string[],
    supportsCancellation: record.supportsCancellation as boolean,
    supportsIncremental: record.supportsIncremental as boolean,
    supportsPreviousArtifact: record.supportsPreviousArtifact as boolean,
    supportsRemoteArtifacts: record.supportsRemoteArtifacts as boolean,
    supportsStreamingProgress: record.supportsStreamingProgress as boolean,
    ...(typeof record.maxFileBytes === "number" ? { maxFileBytes: record.maxFileBytes } : {}),
    ...(typeof record.maxFiles === "number" ? { maxFiles: record.maxFiles } : {}),
    ...(typeof record.maxTotalBytes === "number" ? { maxTotalBytes: record.maxTotalBytes } : {}),
  };
}

/** Validates an indexer capability payload without throwing. */
export function validateIndexerCapabilities(value: unknown): readonly string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["capabilities must be a JSON object"];
  }

  requireString(value, "driverName", errors);
  requireString(value, "driverVersion", errors);
  requireStringArray(value, "supportedRequestSchemaVersions", errors);
  requireStringArray(value, "supportedArtifactSchemaVersions", errors);
  requireStringArray(value, "supportedLanguages", errors);
  requireStringArray(value, "supportedRecordTypes", errors);
  requireBoolean(value, "supportsIncremental", errors);
  requireBoolean(value, "supportsPreviousArtifact", errors);
  requireBoolean(value, "supportsCancellation", errors);
  requireBoolean(value, "supportsStreamingProgress", errors);
  requireBoolean(value, "supportsRemoteArtifacts", errors);
  requireOptionalNonNegativeNumber(value, "maxFileBytes", errors);
  requireOptionalNonNegativeNumber(value, "maxFiles", errors);
  requireOptionalNonNegativeNumber(value, "maxTotalBytes", errors);

  return errors;
}

/** Throws when a driver does not emit artifacts compatible with the current importer. */
export function assertIndexerSupportsCurrentArtifactSchema(
  capabilities: IndexerCapabilities,
): void {
  if (
    !capabilities.supportedArtifactSchemaVersions.includes(CURRENT_INDEX_ARTIFACT_SCHEMA_VERSION)
  ) {
    throw new Error(
      `Indexer ${capabilities.driverName}@${capabilities.driverVersion} does not support ${CURRENT_INDEX_ARTIFACT_SCHEMA_VERSION}.`,
    );
  }
}

/** Creates a registry from explicitly provided indexer drivers. */
export function createIndexerDriverRegistry(
  drivers: readonly CodeIndexerDriver[],
): IndexerDriverRegistry {
  const byName = new Map<string, CodeIndexerDriver>();
  for (const driver of drivers) {
    if (byName.has(driver.name)) {
      throw new Error(`Duplicate indexer driver registered: ${driver.name}`);
    }
    byName.set(driver.name, driver);
  }

  return {
    names: () => [...byName.keys()].sort(),
    get: (name) => byName.get(name),
  };
}

/** Creates a deterministic fake indexer driver for tests and local smoke wiring. */
export function createFakeIndexerDriver(options: FakeIndexerDriverOptions = {}): CodeIndexerDriver {
  const name = options.name ?? "fake";
  const version = options.version ?? "0.0.0";
  const diagnostics = options.diagnostics ?? [];

  return {
    name,
    version,
    getCapabilities: async () =>
      defaultIndexerCapabilities({
        driverName: name,
        driverVersion: version,
        supportsCancellation: true,
        ...(options.capabilities ?? {}),
      }),
    indexRepository: async (input) => {
      if (options.failure) {
        return { ok: false, diagnostics, error: options.failure };
      }

      return {
        ok: true,
        artifact: options.artifact ?? emptyIndexArtifact(input, name, version),
        ...(options.artifactUri ? { artifactUri: options.artifactUri } : {}),
        diagnostics,
      };
    },
  };
}

/** Creates a remote HTTP indexer driver with submit, poll, and artifact validation handling. */
export function createRemoteIndexerDriver(options: RemoteIndexerDriverOptions): CodeIndexerDriver {
  const name = options.name ?? "remote";
  const version = options.version ?? "0.0.0";
  const baseUrl = normalizeRemoteBaseUrl(options.baseUrl);
  const fetcher = options.fetch ?? fetch;
  const pollIntervalMs = normalizedPositiveInteger(
    options.pollIntervalMs,
    DEFAULT_REMOTE_POLL_INTERVAL_MS,
  );
  const maxPollMs = normalizedPositiveInteger(options.maxPollMs, DEFAULT_REMOTE_MAX_POLL_MS);

  return {
    name,
    version,
    getCapabilities: async () => {
      const response = await fetchRemoteJson(fetcher, remoteUrl(baseUrl, "/v1/capabilities"), {
        headers: remoteControlHeaders(options.bearerToken),
        method: "GET",
      });

      return parseIndexerCapabilities(response);
    },
    indexRepository: async (input) => {
      const diagnostics: string[] = [];
      const startedAt = Date.now();

      try {
        const submitted = await submitRemoteIndexRun({
          baseUrl,
          fetcher,
          input,
          ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
        });
        diagnostics.push(...submitted.diagnostics);

        let current = submitted;
        while (current.status === "queued" || current.status === "running") {
          if (!current.remoteRunId) {
            return {
              ok: false,
              diagnostics,
              error: {
                code: "remote_unavailable",
                message: "Remote indexer did not return remoteRunId for a pending run.",
              },
            };
          }
          if (Date.now() - startedAt >= maxPollMs) {
            return {
              ok: false,
              diagnostics,
              error: {
                code: "timeout",
                details: { driverName: name, maxPollMs },
                message: `Remote indexer ${name} did not finish within ${maxPollMs}ms.`,
              },
            };
          }

          await waitForRemotePoll(pollIntervalMs, input.signal);
          current = await fetchRemoteIndexRun({
            baseUrl,
            fetcher,
            remoteRunId: current.remoteRunId,
            ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          });
          diagnostics.push(...current.diagnostics);
        }

        return await remoteTerminalResult({
          diagnostics,
          driverName: name,
          driverVersion: version,
          fetcher,
          run: current,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.telemetry?.traceContext ? { traceContext: input.telemetry.traceContext } : {}),
          ...(input.telemetry?.traces ? { traces: input.telemetry.traces } : {}),
        });
      } catch (error) {
        if (input.signal?.aborted) {
          return {
            ok: false,
            diagnostics,
            error: {
              code: "cancelled",
              message: "Remote indexer request was cancelled.",
            },
          };
        }

        return {
          ok: false,
          diagnostics,
          error: toIndexerFailure(error, "remote_unavailable"),
        };
      }
    },
  };
}

/** Creates a CLI-backed indexer driver that executes the indexer in a child process. */
export function createCliIndexerDriver(options: CliIndexerDriverOptions): CodeIndexerDriver {
  const name = options.name ?? "cli";
  const version = options.version ?? "0.0.0";
  const artifactRootPath = resolve(options.artifactRootPath);
  const workspaceRootPath = options.workspaceRootPath
    ? resolve(options.workspaceRootPath)
    : undefined;
  const stdoutMaxBytes = normalizedPositiveInteger(
    options.stdoutMaxBytes,
    DEFAULT_CLI_CAPTURE_MAX_BYTES,
  );
  const stderrMaxBytes = normalizedPositiveInteger(
    options.stderrMaxBytes,
    DEFAULT_CLI_CAPTURE_MAX_BYTES,
  );
  const timeoutMs = normalizedPositiveInteger(options.timeoutMs, DEFAULT_CLI_TIMEOUT_MS);
  const killGraceMs = normalizedPositiveInteger(options.killGraceMs, DEFAULT_CLI_KILL_GRACE_MS);

  return {
    name,
    version,
    getCapabilities: async () => {
      const processResult = await runCliIndexerProcess({
        args: [...(options.args ?? []), "capabilities", "--json"],
        command: options.command,
        env: buildSafeIndexerEnv({
          sourceEnv: process.env,
          ...(options.envAllowlist ? { allowlist: options.envAllowlist } : {}),
        }),
        killGraceMs,
        stderrMaxBytes,
        stdoutMaxBytes,
        timeoutMs: DEFAULT_CAPABILITIES_TIMEOUT_MS,
      });
      if (processResult.status !== "exited") {
        throw new Error(cliCapabilitiesFailureMessage(processResult, name));
      }
      if (processResult.exitCode !== 0) {
        throw new Error(
          `Indexer CLI ${name} capabilities command exited with code ${processResult.exitCode}: ${processResult.stderr.text}`,
        );
      }

      return parseIndexerCapabilities(JSON.parse(processResult.stdout.text) as unknown);
    },
    indexRepository: async (input) => {
      const pathError = await validateCliIndexerPaths({
        artifactRootPath,
        workspacePath: input.workspacePath,
        ...(workspaceRootPath ? { workspaceRootPath } : {}),
      });
      if (pathError) {
        return { ok: false, diagnostics: [], error: pathError };
      }

      const runId = `idxrun_${randomUUID()}`;
      const outputDir = join(
        artifactRootPath,
        safeArtifactPathSegment(input.repoId),
        safeArtifactPathSegment(input.commitSha),
        runId,
      );
      const requestPath = join(outputDir, "request.json");
      const artifactPath = join(outputDir, "artifact.json");
      const stdoutPath = join(outputDir, "logs", "stdout.log");
      const stderrPath = join(outputDir, "logs", "stderr.log");

      try {
        await mkdir(dirname(stdoutPath), { recursive: true });
        await writeCliIndexerRequestFile(requestPath, {
          commitSha: input.commitSha,
          outputPath: artifactPath,
          repoId: input.repoId,
          workspacePath: resolve(input.workspacePath),
          ...(input.previousIndexVersionId
            ? { previousIndexVersionId: input.previousIndexVersionId }
            : {}),
        });
      } catch (error) {
        return {
          ok: false,
          diagnostics: [],
          error: toIndexerFailure(error, "filesystem_error"),
        };
      }

      const processResult = await runCliIndexerProcessWithTelemetry({
        args: [
          ...(options.args ?? []),
          "index",
          "--request",
          requestPath,
          "--output",
          artifactPath,
        ],
        command: options.command,
        env: buildSafeIndexerEnv({
          sourceEnv: process.env,
          ...(options.envAllowlist ? { allowlist: options.envAllowlist } : {}),
        }),
        killGraceMs,
        stderrMaxBytes,
        stdoutMaxBytes,
        timeoutMs,
        driverName: name,
        driverVersion: version,
        ...(input.telemetry?.metrics ? { metrics: input.telemetry.metrics } : {}),
        ...(input.telemetry?.traceContext ? { traceContext: input.telemetry.traceContext } : {}),
        ...(input.telemetry?.traces ? { traces: input.telemetry.traces } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const diagnostics = cliProcessDiagnostics(processResult);

      await Promise.all([
        writeFile(stdoutPath, processResult.stdout.text, "utf8"),
        writeFile(stderrPath, processResult.stderr.text, "utf8"),
      ]);

      if (processResult.status !== "exited") {
        return {
          ok: false,
          diagnostics,
          error: cliProcessFailure(processResult, name),
        };
      }
      if (processResult.exitCode !== 0) {
        return {
          ok: false,
          diagnostics,
          error: {
            code: "process_exit_nonzero",
            details: { exitCode: processResult.exitCode, stderr: processResult.stderr.text },
            message: `Indexer CLI exited with code ${processResult.exitCode}.`,
          },
        };
      }

      try {
        const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as IndexArtifact;
        const validationErrors = validateIndexArtifactWithTelemetry(artifact, {
          driverName: name,
          driverVersion: version,
          ...(input.telemetry?.traceContext ? { traceContext: input.telemetry.traceContext } : {}),
          ...(input.telemetry?.traces ? { traces: input.telemetry.traces } : {}),
        });
        if (validationErrors.length > 0) {
          return {
            ok: false,
            diagnostics,
            error: {
              code: "artifact_invalid",
              details: { validationErrors },
              message: `Indexer CLI wrote an invalid artifact: ${validationErrors.join("; ")}`,
            },
          };
        }

        return { ok: true, artifact, diagnostics };
      } catch (error) {
        return {
          ok: false,
          diagnostics,
          error: toIndexerFailure(error, "artifact_invalid"),
        };
      }
    },
  };
}

/** Builds the minimal process environment passed to CLI indexers. */
export function buildSafeIndexerEnv(input: BuildSafeIndexerEnvInput): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: "1" };
  for (const key of input.allowlist ?? DEFAULT_INDEXER_ENV_ALLOWLIST) {
    const value = input.sourceEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

/** Submits one remote index run to the configured control API. */
async function submitRemoteIndexRun(input: {
  /** Remote service base URL. */
  readonly baseUrl: string;
  /** Optional bearer token for the remote service. */
  readonly bearerToken?: string;
  /** Fetch implementation used for the request. */
  readonly fetcher: RemoteIndexerFetch;
  /** Index repository input to submit. */
  readonly input: IndexRepositoryInput;
}): Promise<NormalizedRemoteIndexRun> {
  const body = buildRemoteIndexerRequestBody(input.input);
  const response = await fetchRemoteJson(
    input.fetcher,
    remoteUrl(input.baseUrl, "/v1/index-runs"),
    {
      body: `${JSON.stringify(body)}\n`,
      headers: remoteControlHeaders(input.bearerToken),
      method: "POST",
      ...(input.input.signal ? { signal: input.input.signal } : {}),
    },
  );

  return parseRemoteIndexRun(response);
}

/** Fetches one remote index run status by remote run ID. */
async function fetchRemoteIndexRun(input: {
  /** Remote service base URL. */
  readonly baseUrl: string;
  /** Optional bearer token for the remote service. */
  readonly bearerToken?: string;
  /** Fetch implementation used for the request. */
  readonly fetcher: RemoteIndexerFetch;
  /** Remote service run ID. */
  readonly remoteRunId: string;
  /** Optional cancellation signal. */
  readonly signal?: AbortSignal;
}): Promise<NormalizedRemoteIndexRun> {
  const response = await fetchRemoteJson(
    input.fetcher,
    remoteUrl(input.baseUrl, `/v1/index-runs/${encodeURIComponent(input.remoteRunId)}`),
    {
      headers: remoteControlHeaders(input.bearerToken),
      method: "GET",
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );

  return parseRemoteIndexRun(response);
}

/** Converts a terminal remote status into the local indexer-driver result shape. */
async function remoteTerminalResult(input: {
  /** Terminal remote run response. */
  readonly run: NormalizedRemoteIndexRun;
  /** Stable driver name attached to validation spans. */
  readonly driverName: string;
  /** Driver implementation version attached to validation spans. */
  readonly driverVersion: string;
  /** Diagnostics accumulated while submitting and polling. */
  readonly diagnostics: readonly string[];
  /** Fetch implementation used to download remote artifacts. */
  readonly fetcher: RemoteIndexerFetch;
  /** Optional cancellation signal. */
  readonly signal?: AbortSignal;
  /** Optional span recorder for product-safe validation traces. */
  readonly traces?: TelemetrySpanRecorder;
  /** Optional trace context propagated from durable job boundaries. */
  readonly traceContext?: TelemetryTraceContextInput;
}): Promise<IndexRepositoryResult> {
  if (input.run.status !== "succeeded") {
    return {
      ok: false,
      diagnostics: input.diagnostics,
      error: input.run.error ?? remoteStatusFailure(input.run.status),
    };
  }

  const artifactResult = await loadRemoteArtifact(input.run, input.fetcher, input.signal);
  if (!artifactResult.ok) {
    return {
      ok: false,
      diagnostics: input.diagnostics,
      error: artifactResult.error,
    };
  }

  const validationErrors = validateIndexArtifactWithTelemetry(artifactResult.artifact, {
    driverName: input.driverName,
    driverVersion: input.driverVersion,
    ...(input.traceContext ? { traceContext: input.traceContext } : {}),
    ...(input.traces ? { traces: input.traces } : {}),
  });
  if (validationErrors.length > 0) {
    return {
      ok: false,
      diagnostics: input.diagnostics,
      error: {
        code: "artifact_invalid",
        details: { validationErrors },
        message: `Remote indexer returned an invalid artifact: ${validationErrors.join("; ")}`,
      },
    };
  }

  return {
    ok: true,
    artifact: artifactResult.artifact,
    ...(input.run.artifactUri ? { artifactUri: input.run.artifactUri } : {}),
    diagnostics: input.diagnostics,
  };
}

/** Loads an artifact from either an inline remote response or a remote artifact URL. */
async function loadRemoteArtifact(
  run: NormalizedRemoteIndexRun,
  fetcher: RemoteIndexerFetch,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly artifact: IndexArtifact }
  | { readonly ok: false; readonly error: IndexerFailure }
> {
  if (run.artifact) {
    return { ok: true, artifact: run.artifact };
  }
  if (!run.artifactUrl) {
    return {
      ok: false,
      error: {
        code: "artifact_invalid",
        message: "Remote indexer completed without an inline artifact or artifactUrl.",
      },
    };
  }

  try {
    const value = await fetchRemoteJson(fetcher, run.artifactUrl, {
      headers: { accept: "application/json" },
      method: "GET",
      ...(signal ? { signal } : {}),
    });
    const artifact = parseRemoteArtifactBody(value);

    return { ok: true, artifact };
  } catch (error) {
    return {
      ok: false,
      error: toIndexerFailure(error, signal?.aborted ? "cancelled" : "remote_unavailable"),
    };
  }
}

/** Builds the remote index request body from the local driver input. */
function buildRemoteIndexerRequestBody(input: IndexRepositoryInput): RemoteIndexerRequestBody {
  return {
    schemaVersion: "index_request.v1",
    requestId: `idxreq_${randomUUID()}`,
    runId: `idxrun_${randomUUID()}`,
    repoId: input.repoId,
    commitSha: input.commitSha,
    workspacePath: resolve(input.workspacePath),
    ...(input.previousIndexVersionId
      ? { previousIndexVersionId: input.previousIndexVersionId }
      : {}),
  };
}

/** Fetches and parses one JSON response from a remote indexer endpoint. */
async function fetchRemoteJson(
  fetcher: RemoteIndexerFetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetcher(url, init);
  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    const details = responseBody.trim() ? `: ${responseBody.trim().slice(0, 200)}` : "";
    throw new Error(`Remote indexer request failed with HTTP ${response.status}${details}.`);
  }

  return (await response.json()) as unknown;
}

/** Parses a remote index run response into a normalized local shape. */
function parseRemoteIndexRun(value: unknown): NormalizedRemoteIndexRun {
  if (!isRecord(value)) {
    throw new Error("Remote indexer response must be a JSON object.");
  }

  const status = parseRemoteIndexRunStatus(value.status);
  const artifact =
    value.artifact === undefined ? undefined : parseRemoteArtifactBody(value.artifact);
  const error = parseRemoteIndexerFailure(value.error, status);
  const remoteRunId = typeof value.remoteRunId === "string" ? value.remoteRunId : undefined;
  const artifactUri = typeof value.artifactUri === "string" ? value.artifactUri : undefined;
  const artifactUrl =
    typeof value.artifactUrl === "string"
      ? value.artifactUrl
      : typeof value.artifactDownloadUrl === "string"
        ? value.artifactDownloadUrl
        : undefined;

  return {
    status,
    diagnostics: parseStringArray(value.diagnostics),
    ...(remoteRunId ? { remoteRunId } : {}),
    ...(artifact ? { artifact } : {}),
    ...(artifactUri ? { artifactUri } : {}),
    ...(artifactUrl ? { artifactUrl } : {}),
    ...(error ? { error } : {}),
  };
}

/** Parses an artifact JSON body, accepting either the artifact itself or a wrapper object. */
function parseRemoteArtifactBody(value: unknown): IndexArtifact {
  if (isRecord(value) && value.artifact !== undefined) {
    return value.artifact as IndexArtifact;
  }

  return value as IndexArtifact;
}

/** Parses and validates a remote run status value. */
function parseRemoteIndexRunStatus(value: unknown): RemoteIndexRunStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "canceled" ||
    value === "timed_out"
  ) {
    return value;
  }

  throw new Error("Remote indexer response included an unsupported status.");
}

/** Parses a remote error object into a normalized indexer failure. */
function parseRemoteIndexerFailure(
  value: unknown,
  status: RemoteIndexRunStatus,
): IndexerFailure | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const code = typeof value.code === "string" ? parseIndexerFailureCode(value.code) : undefined;
  const message =
    typeof value.message === "string" ? value.message : remoteStatusFailure(status).message;
  const details = isRecord(value.details) ? value.details : undefined;

  return {
    code: code ?? remoteStatusFailure(status).code,
    message,
    ...(details ? { details } : {}),
  };
}

/** Maps a remote terminal status to a normalized default failure. */
function remoteStatusFailure(status: RemoteIndexRunStatus): IndexerFailure {
  if (status === "canceled") {
    return { code: "cancelled", message: "Remote indexer job was cancelled." };
  }
  if (status === "timed_out") {
    return { code: "timeout", message: "Remote indexer job timed out." };
  }

  return { code: "remote_job_failed", message: "Remote indexer job failed." };
}

/** Parses a failure code only when it is part of the durable local error vocabulary. */
function parseIndexerFailureCode(value: string): IndexerFailure["code"] | undefined {
  if (
    value === "artifact_invalid" ||
    value === "cancelled" ||
    value === "filesystem_error" ||
    value === "process_exit_nonzero" ||
    value === "process_signal" ||
    value === "request_invalid" ||
    value === "remote_job_failed" ||
    value === "remote_unavailable" ||
    value === "unsupported_language" ||
    value === "timeout" ||
    value === "unknown"
  ) {
    return value;
  }

  return undefined;
}

/** Returns string diagnostics from a JSON value. */
function parseStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Returns whether an unknown JSON value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Waits between remote status polls while respecting cancellation. */
async function waitForRemotePoll(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    throw new Error("Remote indexer request was cancelled.");
  }

  await new Promise<void>((resolveWait, rejectWait) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolveWait();
    }, ms);
    const abort = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      rejectWait(new Error("Remote indexer request was cancelled."));
    };

    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Builds request headers for the remote indexer control API. */
function remoteControlHeaders(bearerToken: string | undefined): Record<string, string> {
  return {
    accept: "application/json",
    ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
    "content-type": "application/json",
  };
}

/** Normalizes a remote indexer base URL and removes trailing slashes. */
function normalizeRemoteBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("Remote indexer baseUrl is required.");
  }

  return normalized;
}

/** Joins a normalized remote base URL with a protocol path. */
function remoteUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

/** Builds conservative default capabilities for local and fake drivers. */
function defaultIndexerCapabilities(
  input: Pick<IndexerCapabilities, "driverName" | "driverVersion"> &
    Partial<Omit<IndexerCapabilities, "driverName" | "driverVersion">>,
): IndexerCapabilities {
  return {
    driverName: input.driverName,
    driverVersion: input.driverVersion,
    supportedArtifactSchemaVersions: input.supportedArtifactSchemaVersions ?? [
      INDEX_ARTIFACT_SCHEMA_VERSION,
    ],
    supportedLanguages: input.supportedLanguages ?? [],
    supportedRecordTypes: input.supportedRecordTypes ?? [
      "file",
      "symbol",
      "edge",
      "chunk",
      "diagnostic",
      "dependency",
      "route",
      "test_mapping",
    ],
    supportedRequestSchemaVersions: input.supportedRequestSchemaVersions ?? [
      INDEX_REQUEST_SCHEMA_VERSION,
    ],
    supportsCancellation: input.supportsCancellation ?? false,
    supportsIncremental: input.supportsIncremental ?? false,
    supportsPreviousArtifact: input.supportsPreviousArtifact ?? false,
    supportsRemoteArtifacts: input.supportsRemoteArtifacts ?? false,
    supportsStreamingProgress: input.supportsStreamingProgress ?? false,
    ...(input.maxFileBytes !== undefined ? { maxFileBytes: input.maxFileBytes } : {}),
    ...(input.maxFiles !== undefined ? { maxFiles: input.maxFiles } : {}),
    ...(input.maxTotalBytes !== undefined ? { maxTotalBytes: input.maxTotalBytes } : {}),
  };
}

/** Formats an abnormal CLI capabilities result as a startup-safe error message. */
function cliCapabilitiesFailureMessage(
  processResult: Exclude<CliIndexerProcessResult, { readonly status: "exited" }>,
  driverName: string,
): string {
  if (processResult.status === "timed_out") {
    return `Indexer CLI ${driverName} capabilities command timed out.`;
  }
  if (processResult.status === "cancelled") {
    return `Indexer CLI ${driverName} capabilities command was cancelled.`;
  }
  if (processResult.status === "signaled") {
    return `Indexer CLI ${driverName} capabilities command exited from signal ${processResult.signal}.`;
  }

  return `Indexer CLI ${driverName} capabilities command failed: ${processResult.error.message}`;
}

/** Adds a validation error when a required property is not a string. */
function requireString(
  record: Record<string, unknown>,
  key: keyof IndexerCapabilities,
  errors: string[],
): void {
  if (typeof record[key] !== "string") {
    errors.push(`${String(key)} must be a string`);
  }
}

/** Adds a validation error when a required property is not a string array. */
function requireStringArray(
  record: Record<string, unknown>,
  key: keyof IndexerCapabilities,
  errors: string[],
): void {
  if (!Array.isArray(record[key]) || !record[key].every((entry) => typeof entry === "string")) {
    errors.push(`${String(key)} must be an array of strings`);
  }
}

/** Adds a validation error when a required property is not a boolean. */
function requireBoolean(
  record: Record<string, unknown>,
  key: keyof IndexerCapabilities,
  errors: string[],
): void {
  if (typeof record[key] !== "boolean") {
    errors.push(`${String(key)} must be a boolean`);
  }
}

/** Adds a validation error when an optional numeric limit is invalid. */
function requireOptionalNonNegativeNumber(
  record: Record<string, unknown>,
  key: keyof IndexerCapabilities,
  errors: string[],
): void {
  if (
    record[key] !== undefined &&
    (typeof record[key] !== "number" || !Number.isFinite(record[key]) || record[key] < 0)
  ) {
    errors.push(`${String(key)} must be a non-negative number when present`);
  }
}

/** Wraps a driver with product-safe run metrics and tracing. */
export function withIndexerTelemetry(
  driver: CodeIndexerDriver,
  options: IndexerTelemetryOptions,
): CodeIndexerDriver {
  return {
    name: driver.name,
    version: driver.version,
    getCapabilities: () => driver.getCapabilities(),
    indexRepository: async (input) => {
      const telemetry = mergeIndexerTelemetry(input.telemetry, options);
      const startedAt = Date.now();
      const span = telemetry.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.indexerDriverRun, {
        attributes: {
          "app.repo_id": input.repoId,
          "indexer_driver.driver": normalizeTelemetryLabel(driver.name),
          "indexer_driver.previous_index_available": input.previousIndexVersionId !== undefined,
          "indexer_driver.version": driver.version,
        },
        kind: "internal",
        ...(telemetry.traceContext ? { traceContext: telemetry.traceContext } : {}),
      });

      try {
        const result = await driver.indexRepository({ ...input, telemetry });
        const durationMs = Date.now() - startedAt;
        const status = result.ok ? "succeeded" : "failed";
        const errorClass = result.ok ? undefined : indexerFailureErrorClass(result.error);

        recordIndexerRunMetrics(telemetry.metrics, {
          driverName: driver.name,
          durationMs,
          ...(errorClass ? { errorClass } : {}),
          ...(result.ok ? {} : { failureCode: result.error.code }),
          status,
        });
        span?.end({
          attributes: {
            ...indexerRunResultAttributes(result),
            "indexer_driver.duration_ms": durationMs,
            ...(errorClass ? { "indexer_driver.error_class": errorClass } : {}),
            "indexer_driver.status": status,
          },
          status: result.ok ? "ok" : "error",
        });

        return result;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const errorClass = "unknown_error";
        recordIndexerRunMetrics(telemetry.metrics, {
          driverName: driver.name,
          durationMs,
          errorClass,
          status: "failed",
        });
        span?.end({
          attributes: {
            "indexer_driver.duration_ms": durationMs,
            "indexer_driver.error_class": errorClass,
            "indexer_driver.status": "failed",
          },
          status: "error",
        });
        throw error;
      }
    },
  };
}

/** Wraps a driver with timeout handling and abort-signal propagation. */
export function withIndexerTimeout(
  driver: CodeIndexerDriver,
  options: IndexerTimeoutOptions,
): CodeIndexerDriver {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);

  return {
    name: driver.name,
    version: driver.version,
    getCapabilities: () => driver.getCapabilities(),
    indexRepository: async (input) => {
      const abortController = new AbortController();
      const abortFromCaller = () => abortController.abort(input.signal?.reason);
      if (input.signal?.aborted) {
        abortFromCaller();
      } else {
        input.signal?.addEventListener("abort", abortFromCaller, { once: true });
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutResult = new Promise<IndexRepositoryResult>((resolve) => {
          timeoutId = setTimeout(() => {
            abortController.abort(new Error(`Indexer timed out after ${timeoutMs}ms.`));
            resolve({
              ok: false,
              diagnostics: [`Indexer ${driver.name} timed out after ${timeoutMs}ms.`],
              error: {
                code: "timeout",
                details: { driverName: driver.name, timeoutMs },
                message: `Indexer ${driver.name} timed out after ${timeoutMs}ms.`,
              },
            });
          }, timeoutMs);
        });

        return await Promise.race([
          driver.indexRepository({ ...input, signal: abortController.signal }),
          timeoutResult,
        ]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        input.signal?.removeEventListener("abort", abortFromCaller);
      }
    },
  };
}

/** Normalizes timeout options to a positive integer millisecond value. */
function normalizeTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return 1;
  }

  return Math.floor(timeoutMs);
}

/** Bounded run outcome labels used by indexer driver metrics. */
type IndexerRunTelemetryStatus = "failed" | "succeeded";

/** Input used when recording one indexer run's metrics. */
type RecordIndexerRunMetricsInput = {
  /** Stable driver name. */
  readonly driverName: string;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** Coarse product-safe error class for failed runs. */
  readonly errorClass?: TelemetryAttributeValue;
  /** Durable driver failure code when the run returned a normalized failure. */
  readonly failureCode?: IndexerFailure["code"];
  /** Bounded run status label. */
  readonly status: IndexerRunTelemetryStatus;
};

/** Merges wrapper-level telemetry with telemetry already present on an index request. */
function mergeIndexerTelemetry(
  inputTelemetry: IndexerTelemetryOptions | undefined,
  wrapperTelemetry: IndexerTelemetryOptions,
): IndexerTelemetryOptions {
  const metrics = inputTelemetry?.metrics ?? wrapperTelemetry.metrics;
  const traceContext = inputTelemetry?.traceContext ?? wrapperTelemetry.traceContext;
  const traces = inputTelemetry?.traces ?? wrapperTelemetry.traces;

  return {
    ...(metrics ? { metrics } : {}),
    ...(traceContext ? { traceContext } : {}),
    ...(traces ? { traces } : {}),
  };
}

/** Records low-cardinality metrics for one completed indexer run. */
function recordIndexerRunMetrics(
  metrics: TelemetryMetricRecorder | undefined,
  input: RecordIndexerRunMetricsInput,
): void {
  if (!metrics) {
    return;
  }

  const labels = {
    driver: normalizeTelemetryLabel(input.driverName),
    ...(input.errorClass ? { error_class: input.errorClass } : {}),
    status: input.status,
  };
  metrics.count(OBSERVABILITY_METRIC_NAMES.indexerDriverRunsTotal, {
    labels,
    unit: "1",
  });
  metrics.histogram(OBSERVABILITY_METRIC_NAMES.indexerDriverDurationMs, input.durationMs, {
    labels,
    unit: "ms",
  });
  if (input.failureCode === "timeout") {
    metrics.count(OBSERVABILITY_METRIC_NAMES.indexerDriverTimeoutsTotal, {
      labels: {
        driver: normalizeTelemetryLabel(input.driverName),
      },
      unit: "1",
    });
  }
}

/** Returns product-safe span attributes from an indexer result. */
function indexerRunResultAttributes(
  result: IndexRepositoryResult,
): Readonly<Record<string, TelemetryAttributeValue>> {
  if (!result.ok) {
    return {
      "indexer_driver.error_code": result.error.code,
    };
  }

  return {
    "indexer_driver.artifact_remote": result.artifactUri !== undefined,
    "indexer_driver.chunk_count": result.artifact.manifest.chunkCount,
    "indexer_driver.diagnostic_count": result.diagnostics.length,
    "indexer_driver.edge_count": result.artifact.manifest.edgeCount,
    "indexer_driver.file_count": result.artifact.manifest.fileCount,
    "indexer_driver.record_count": result.artifact.manifest.recordCount,
    "indexer_driver.symbol_count": result.artifact.manifest.symbolCount,
  };
}

/** Returns product-safe span attributes for an artifact validation handoff. */
function indexArtifactValidationAttributes(
  artifact: IndexArtifact,
): Readonly<Record<string, TelemetryAttributeValue>> {
  const manifest = isRecord((artifact as { readonly manifest?: unknown }).manifest)
    ? (artifact as { readonly manifest: Record<string, unknown> }).manifest
    : {};
  const attributes: Record<string, TelemetryAttributeValue> = {};
  addStringAttribute(attributes, "app.repo_id", manifest.repoId);
  addNumberAttribute(attributes, "indexer_driver.chunk_count", manifest.chunkCount);
  addNumberAttribute(attributes, "indexer_driver.edge_count", manifest.edgeCount);
  addNumberAttribute(attributes, "indexer_driver.file_count", manifest.fileCount);
  addNumberAttribute(attributes, "indexer_driver.record_count", manifest.recordCount);
  addNumberAttribute(attributes, "indexer_driver.symbol_count", manifest.symbolCount);

  return attributes;
}

/** Maps durable indexer failures to product-safe telemetry error classes. */
function indexerFailureErrorClass(failure: IndexerFailure): TelemetryAttributeValue {
  switch (failure.code) {
    case "artifact_invalid":
    case "request_invalid":
    case "unsupported_language":
      return "validation_error";
    case "cancelled":
    case "timeout":
      return "timeout_error";
    case "process_exit_nonzero":
    case "process_signal":
    case "remote_job_failed":
    case "remote_unavailable":
      return "provider_error";
    case "filesystem_error":
    case "unknown":
      return "unknown_error";
  }
}

/** Records stdout and stderr byte counts without exporting raw output content. */
function recordCliOutputMetrics(
  metrics: TelemetryMetricRecorder | undefined,
  driverName: string,
  result: CliIndexerProcessResult,
): void {
  if (!metrics) {
    return;
  }

  for (const stream of ["stdout", "stderr"] as const) {
    metrics.histogram(
      OBSERVABILITY_METRIC_NAMES.indexerDriverOutputBytes,
      result[stream].byteLength,
      {
        labels: {
          driver: normalizeTelemetryLabel(driverName),
          status: result.status,
          stream,
        },
        unit: "bytes",
      },
    );
  }
}

/** Returns product-safe span attributes for one CLI process result. */
function cliProcessTelemetryAttributes(
  result: CliIndexerProcessResult,
): Readonly<Record<string, TelemetryAttributeValue>> {
  return {
    ...(result.status === "exited" ? { "indexer_driver.exit_code": result.exitCode } : {}),
    ...(result.status === "signaled" ? { "indexer_driver.signal": result.signal } : {}),
    "indexer_driver.process_status": result.status,
    "indexer_driver.stderr_bytes": result.stderr.byteLength,
    "indexer_driver.stderr_truncated": result.stderr.truncated,
    "indexer_driver.stdout_bytes": result.stdout.byteLength,
    "indexer_driver.stdout_truncated": result.stdout.truncated,
  };
}

/** Maps CLI process outcomes to span status without including raw stdout or stderr. */
function cliProcessSpanStatus(result: CliIndexerProcessResult): "error" | "ok" {
  return result.status === "exited" && result.exitCode === 0 ? "ok" : "error";
}

/** Normalizes user- or provider-supplied labels to bounded telemetry cardinality. */
function normalizeTelemetryLabel(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 80);

  return normalized.length > 0 ? normalized : "unknown";
}

/** Adds a telemetry attribute when the unknown value is a string. */
function addStringAttribute(
  attributes: Record<string, TelemetryAttributeValue>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "string") {
    attributes[key] = value;
  }
}

/** Adds a telemetry attribute when the unknown value is a finite number. */
function addNumberAttribute(
  attributes: Record<string, TelemetryAttributeValue>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    attributes[key] = value;
  }
}

/** Validates path constraints before a CLI indexer can run. */
async function validateCliIndexerPaths(
  input: ValidateCliIndexerPathsInput,
): Promise<IndexerFailure | undefined> {
  const workspacePath = resolve(input.workspacePath);
  if (!isAbsolute(input.workspacePath) || workspacePath === "/") {
    return {
      code: "request_invalid",
      message: "Indexer workspacePath must be an absolute non-root path.",
    };
  }
  if (
    input.workspaceRootPath &&
    !isPathInsideRoot(resolve(input.workspaceRootPath), workspacePath)
  ) {
    return {
      code: "request_invalid",
      message: "Indexer workspacePath is outside the configured workspace root.",
    };
  }
  if (
    workspacePath === input.artifactRootPath ||
    isPathInsideRoot(workspacePath, input.artifactRootPath) ||
    isPathInsideRoot(input.artifactRootPath, workspacePath)
  ) {
    return {
      code: "request_invalid",
      message: "Indexer workspacePath and artifactRootPath must be separate directories.",
    };
  }

  try {
    await access(workspacePath);
  } catch {
    return {
      code: "request_invalid",
      message: "Indexer workspacePath does not exist.",
    };
  }

  return undefined;
}

/** Writes the request JSON consumed by a CLI indexer. */
async function writeCliIndexerRequestFile(
  requestPath: string,
  request: CliIndexerRequestFile,
): Promise<void> {
  await mkdir(dirname(requestPath), { recursive: true });
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
}

/** Runs one CLI indexer process with bounded output capture and termination handling. */
async function runCliIndexerProcess(
  input: RunCliIndexerProcessInput,
): Promise<CliIndexerProcessResult> {
  const stdout = createBoundedCapture(input.stdoutMaxBytes);
  const stderr = createBoundedCapture(input.stderrMaxBytes);

  return await new Promise<CliIndexerProcessResult>((resolveProcess) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let killGraceId: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(input.command, [...input.args], {
      env: input.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (result: CliIndexerProcessResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (killGraceId) {
        clearTimeout(killGraceId);
      }
      input.signal?.removeEventListener("abort", abortFromCaller);
      resolveProcess(result);
    };
    const terminate = () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      killGraceId = setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, input.killGraceMs);
    };
    const abortFromCaller = () => {
      cancelled = true;
      terminate();
    };

    child.stdout.on("data", (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.append(chunk));
    child.on("error", (error) =>
      finish({ error, status: "error", stderr: stderr.snapshot(), stdout: stdout.snapshot() }),
    );
    child.on("close", (exitCode, signal) => {
      if (timedOut) {
        finish({ status: "timed_out", stderr: stderr.snapshot(), stdout: stdout.snapshot() });
        return;
      }
      if (cancelled) {
        finish({ status: "cancelled", stderr: stderr.snapshot(), stdout: stdout.snapshot() });
        return;
      }
      if (signal) {
        finish({
          signal,
          status: "signaled",
          stderr: stderr.snapshot(),
          stdout: stdout.snapshot(),
        });
        return;
      }

      finish({
        exitCode: exitCode ?? 1,
        status: "exited",
        stderr: stderr.snapshot(),
        stdout: stdout.snapshot(),
      });
    });

    timeoutId = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);

    if (input.signal?.aborted) {
      abortFromCaller();
    } else {
      input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
  });
}

/** Runs one CLI indexer process and emits bounded spawn/output telemetry. */
async function runCliIndexerProcessWithTelemetry(
  input: RunCliIndexerProcessInput &
    IndexerTelemetryOptions & {
      /** Stable driver name attached to process telemetry. */
      readonly driverName: string;
      /** Driver implementation version attached to process telemetry. */
      readonly driverVersion: string;
    },
): Promise<CliIndexerProcessResult> {
  const { driverName, driverVersion, metrics, traces, traceContext, ...processInput } = input;
  const span = traces?.startSpan(OBSERVABILITY_SPAN_NAMES.indexerDriverSpawnCli, {
    attributes: {
      "indexer_driver.cli_arg_count": processInput.args.length,
      "indexer_driver.driver": normalizeTelemetryLabel(driverName),
      "indexer_driver.version": driverVersion,
    },
    kind: "client",
    ...(traceContext ? { traceContext } : {}),
  });
  const result = await runCliIndexerProcess(processInput);
  recordCliOutputMetrics(metrics, driverName, result);
  span?.end({
    attributes: cliProcessTelemetryAttributes(result),
    status: cliProcessSpanStatus(result),
  });

  return result;
}

/** Creates diagnostics from bounded CLI process output. */
function cliProcessDiagnostics(processResult: CliIndexerProcessResult): readonly string[] {
  const diagnostics: string[] = [];
  if (processResult.stdout.text.trim().length > 0) {
    diagnostics.push(`stdout: ${processResult.stdout.text.trim()}`);
  }
  if (processResult.stderr.text.trim().length > 0) {
    diagnostics.push(`stderr: ${processResult.stderr.text.trim()}`);
  }
  if (processResult.stdout.truncated) {
    diagnostics.push(`stdout truncated after ${processResult.stdout.text.length} bytes.`);
  }
  if (processResult.stderr.truncated) {
    diagnostics.push(`stderr truncated after ${processResult.stderr.text.length} bytes.`);
  }

  return diagnostics;
}

/** Converts an abnormal CLI process result into a normalized indexer failure. */
function cliProcessFailure(
  processResult: Exclude<CliIndexerProcessResult, { readonly status: "exited" }>,
  driverName: string,
): IndexerFailure {
  if (processResult.status === "timed_out") {
    return {
      code: "timeout",
      details: { driverName },
      message: `Indexer CLI ${driverName} timed out.`,
    };
  }
  if (processResult.status === "cancelled") {
    return {
      code: "cancelled",
      details: { driverName },
      message: `Indexer CLI ${driverName} was cancelled.`,
    };
  }
  if (processResult.status === "signaled") {
    return {
      code: "process_signal",
      details: { driverName, signal: processResult.signal },
      message: `Indexer CLI ${driverName} exited from signal ${processResult.signal}.`,
    };
  }

  return {
    code: "filesystem_error",
    details: { driverName },
    message: processResult.error.message,
  };
}

/** Creates a bounded stdout or stderr capture buffer. */
function createBoundedCapture(maxBytes: number): BoundedCapture {
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  let totalBytes = 0;
  let truncated = false;

  return {
    append: (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      const remainingBytes = maxBytes - retainedBytes;
      if (remainingBytes <= 0) {
        truncated = true;
        return;
      }

      const retained = buffer.subarray(0, remainingBytes);
      chunks.push(retained);
      retainedBytes += retained.byteLength;
      truncated ||= retained.byteLength < buffer.byteLength;
    },
    snapshot: () => ({
      byteLength: totalBytes,
      text: Buffer.concat(chunks).toString("utf8"),
      truncated,
    }),
  };
}

/** Normalizes optional positive integer config values. */
function normalizedPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

/** Returns whether a path is inside a root directory. */
function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(targetPath));

  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/** Creates a valid empty index artifact for fake-driver success results. */
function emptyIndexArtifact(
  input: IndexRepositoryInput,
  indexerName: string,
  indexerVersion: string,
): IndexArtifact {
  return {
    manifest: {
      artifactId: `art_${safeArtifactIdSegment(input.repoId)}_${safeArtifactIdSegment(
        input.commitSha,
      )}`,
      chunkCount: 0,
      chunkerVersion: "chunker.fake.v1",
      commitSha: input.commitSha,
      edgeCount: 0,
      fileCount: 0,
      generatedAt: new Date(0).toISOString(),
      indexerName,
      indexerVersion,
      languages: [],
      parserVersions: {},
      recordCount: 0,
      recordSchemaVersion: "index_record.v1",
      repoId: input.repoId,
      schemaVersion: "index_artifact.v1",
      symbolCount: 0,
    },
    records: [],
  };
}

/** Returns a conservative ID segment for generated fake artifacts. */
function safeArtifactIdSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+$/, "value");
}

/** Returns a conservative filesystem path segment for indexer artifact directories. */
function safeArtifactPathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+$/, "value");
}
