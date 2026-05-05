import {
  type IndexManifest,
  IndexManifestSchema,
  type IndexRecord,
  IndexRecordSchema,
} from "@repo/index-schema";
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
    | "filesystem_error"
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
      readonly diagnostics: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: IndexerFailure;
      readonly diagnostics: readonly string[];
    };

/** Contract implemented by local, remote, or sandboxed code indexers. */
export type CodeIndexerDriver = {
  /** Stable driver name. */
  readonly name: string;
  /** Driver implementation version. */
  readonly version: string;
  /** Indexes a checked-out repository commit into a durable artifact. */
  readonly indexRepository: (input: IndexRepositoryInput) => Promise<IndexRepositoryResult>;
};

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

  return errors;
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
