import type { CodeIndexVersion, ContractError } from "@repo/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { codeIndexVersions } from "../schema";
import { toCodeIndexVersion } from "./row-mappers";

type CodeIndexVersionRow = typeof codeIndexVersions.$inferSelect;

/** Database surface required by index version repository methods. */
type IndexVersionRepositoryDatabase = Pick<HeimdallDatabase, "insert" | "select" | "update">;

/** Natural lookup key for an index version. */
export type IndexVersionLookupInput = {
  /** Repository ID that owns the index version. */
  readonly repoId: string;
  /** Commit SHA indexed by the version. */
  readonly commitSha: string;
  /** Stable indexer/chunker key. */
  readonly indexKey: string;
};

/** Lookup key for latest ready indexes for one commit. */
export type LatestReadyIndexLookupInput = {
  /** Repository ID that owns the index versions. */
  readonly repoId: string;
  /** Commit SHA indexed by the versions. */
  readonly commitSha: string;
};

/** Counts written when an index import reaches a terminal ready state. */
export type IndexVersionCounts = Pick<
  CodeIndexVersion,
  "chunkCount" | "edgeCount" | "embeddedChunkCount" | "fileCount" | "symbolCount"
>;

/** Durable index-version record read through the database repository boundary. */
export type IndexVersionRecord = {
  /** Stable index version ID. */
  readonly indexVersionId: string;
  /** Repository that owns the index version. */
  readonly repoId: string;
  /** Commit SHA indexed by this version. */
  readonly commitSha: string;
  /** Stable indexer/chunker key. */
  readonly indexKey: string;
  /** Import lifecycle status. */
  readonly status: string;
  /** Artifact URI for the imported index payload. */
  readonly artifactUri: string;
  /** Optional artifact content hash. */
  readonly artifactHash: string | null;
  /** Indexer implementation name. */
  readonly indexerName: string;
  /** Indexer implementation version. */
  readonly indexerVersion: string;
  /** Chunker implementation version. */
  readonly chunkerVersion: string;
  /** Expected indexed file count. */
  readonly fileCount: number;
  /** Expected indexed symbol count. */
  readonly symbolCount: number;
  /** Expected code edge count. */
  readonly edgeCount: number;
  /** Expected code chunk count. */
  readonly chunkCount: number;
  /** Expected diagnostic count. */
  readonly diagnosticCount: number;
  /** Expected dependency count. */
  readonly dependencyCount: number;
  /** Expected route count. */
  readonly routeCount: number;
  /** Expected related-test mapping count. */
  readonly testMappingCount: number;
  /** Expected embedded chunk count. */
  readonly embeddedChunkCount: number;
  /** Completion timestamp for terminal states. */
  readonly completedAt: Date | null;
  /** Structured import failure payload when present. */
  readonly error: unknown;
  /** Creation timestamp. */
  readonly createdAt: Date;
};

/** Natural import key for one deterministic index artifact import. */
export type IndexVersionImportLookupInput = {
  /** Repository ID carried by the index artifact manifest. */
  readonly repoId: string;
  /** Commit SHA carried by the index artifact manifest. */
  readonly commitSha: string;
  /** Stable indexer/chunker key. */
  readonly indexKey: string;
  /** Artifact content hash used for idempotency. */
  readonly artifactHash: string;
};

/** Existing index version fields used by artifact import idempotency checks. */
export type IndexVersionImportRecord = Pick<
  IndexVersionRecord,
  | "artifactHash"
  | "chunkCount"
  | "dependencyCount"
  | "diagnosticCount"
  | "edgeCount"
  | "fileCount"
  | "indexVersionId"
  | "routeCount"
  | "status"
  | "symbolCount"
  | "testMappingCount"
>;

/** Input used to create or refresh an importing index version. */
export type UpsertImportingIndexVersionInput = {
  /** Deterministic index version ID. */
  readonly indexVersionId: string;
  /** Repository ID carried by the artifact. */
  readonly repoId: string;
  /** Commit SHA carried by the artifact. */
  readonly commitSha: string;
  /** Stable indexer/chunker key. */
  readonly indexKey: string;
  /** Artifact URI being imported. */
  readonly artifactUri: string;
  /** Artifact content hash used for idempotency. */
  readonly artifactHash: string;
  /** Indexer implementation name. */
  readonly indexerName: string;
  /** Indexer implementation version. */
  readonly indexerVersion: string;
  /** Chunker implementation version. */
  readonly chunkerVersion: string;
  /** Imported entity counts available before record writes begin. */
  readonly counts: Pick<
    IndexVersionRecord,
    | "chunkCount"
    | "dependencyCount"
    | "diagnosticCount"
    | "edgeCount"
    | "fileCount"
    | "routeCount"
    | "symbolCount"
    | "testMappingCount"
  >;
};

/** Input used to mark an index version ready. */
export type MarkIndexReadyInput = {
  /** Index version ID to update. */
  readonly indexVersionId: string;
  /** Imported record counts. */
  readonly counts: IndexVersionCounts;
  /** Completion timestamp, defaulting to now. */
  readonly completedAt?: string;
};

/** Input used to mark an index version failed. */
export type MarkIndexFailedInput = {
  /** Index version ID to update. */
  readonly indexVersionId: string;
  /** Stable product error code. */
  readonly errorCode?: string;
  /** Failure message safe for internal debugging. */
  readonly errorMessage: string;
  /** Whether the failure can be retried. */
  readonly retryable?: boolean;
  /** Completion timestamp, defaulting to now. */
  readonly completedAt?: string;
};

/** Input used to store a serialized importer failure without altering completion time. */
export type MarkIndexVersionFailedRecordInput = {
  /** Index version ID to update. */
  readonly indexVersionId: string;
  /** Serialized failure payload to persist. */
  readonly error: unknown;
};

/** Input used to mark an already-counted index version ready. */
export type MarkIndexVersionReadyRecordInput = {
  /** Index version ID to update. */
  readonly indexVersionId: string;
  /** Completion timestamp from the imported artifact manifest. */
  readonly completedAt: Date;
};

/** Returns a row from a write query or throws when the database returned nothing. */
const requireReturnedRow = <T>(row: T | undefined): T => {
  if (!row) {
    throw new Error("Database write did not return a row.");
  }

  return row;
};

/** Builds the durable index key from indexer and chunker versions. */
const indexKeyFor = (indexVersion: CodeIndexVersion): string =>
  [indexVersion.indexerName, indexVersion.indexerVersion, indexVersion.chunkerVersion].join(":");

/** Query helper for code index version metadata. */
export class IndexVersionRepository {
  /** Creates an index version query helper. */
  public constructor(private readonly db: IndexVersionRepositoryDatabase) {}

  /** Creates or updates an index version idempotently. */
  public async createIndexVersion(indexVersion: CodeIndexVersion): Promise<CodeIndexVersion> {
    return this.upsertIndexVersion(indexVersion);
  }

  /** Inserts an index version or updates its status for the same repo commit. */
  public async upsertIndexVersion(indexVersion: CodeIndexVersion): Promise<CodeIndexVersion> {
    const [row] = await this.db
      .insert(codeIndexVersions)
      .values({
        ...indexVersion,
        indexKey: indexKeyFor(indexVersion),
        createdAt: new Date(indexVersion.createdAt),
        completedAt: indexVersion.completedAt ? new Date(indexVersion.completedAt) : undefined,
      })
      .onConflictDoUpdate({
        target: [
          codeIndexVersions.repoId,
          codeIndexVersions.commitSha,
          codeIndexVersions.indexKey,
          codeIndexVersions.artifactHash,
        ],
        set: {
          status: indexVersion.status,
          artifactUri: indexVersion.artifactUri,
          artifactHash: indexVersion.artifactHash,
          fileCount: indexVersion.fileCount,
          symbolCount: indexVersion.symbolCount,
          edgeCount: indexVersion.edgeCount,
          chunkCount: indexVersion.chunkCount,
          embeddedChunkCount: indexVersion.embeddedChunkCount,
          completedAt: indexVersion.completedAt ? new Date(indexVersion.completedAt) : undefined,
          error: indexVersion.error,
        },
      })
      .returning();

    return toCodeIndexVersion(requireReturnedRow(row));
  }

  /** Finds a ready index version by repository, commit, and index key. */
  public async findReadyIndexVersion(
    input: IndexVersionLookupInput,
  ): Promise<CodeIndexVersion | undefined> {
    const [row] = await this.db
      .select()
      .from(codeIndexVersions)
      .where(
        and(
          eq(codeIndexVersions.repoId, input.repoId),
          eq(codeIndexVersions.commitSha, input.commitSha),
          eq(codeIndexVersions.indexKey, input.indexKey),
          eq(codeIndexVersions.status, "ready"),
        ),
      )
      .orderBy(desc(codeIndexVersions.completedAt), desc(codeIndexVersions.createdAt))
      .limit(1);

    return row ? toCodeIndexVersion(row) : undefined;
  }

  /** Gets the latest ready index version for a repository commit. */
  public async getLatestReadyIndexForCommit(
    input: LatestReadyIndexLookupInput,
  ): Promise<CodeIndexVersion | undefined> {
    const [row] = await this.db
      .select()
      .from(codeIndexVersions)
      .where(
        and(
          eq(codeIndexVersions.repoId, input.repoId),
          eq(codeIndexVersions.commitSha, input.commitSha),
          eq(codeIndexVersions.status, "ready"),
        ),
      )
      .orderBy(desc(codeIndexVersions.completedAt), desc(codeIndexVersions.createdAt))
      .limit(1);

    return row ? toCodeIndexVersion(row) : undefined;
  }

  /** Gets an index version by ID. */
  public async getIndexVersion(indexVersionId: string): Promise<CodeIndexVersion | undefined> {
    const [row] = await this.db
      .select()
      .from(codeIndexVersions)
      .where(eq(codeIndexVersions.indexVersionId, indexVersionId));

    return row ? toCodeIndexVersion(row) : undefined;
  }

  /** Gets an index version record by ID, including DB-only inspection counts. */
  public async getIndexVersionRecord(
    indexVersionId: string,
  ): Promise<IndexVersionRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(codeIndexVersions)
      .where(eq(codeIndexVersions.indexVersionId, indexVersionId))
      .limit(1);

    return row ? toIndexVersionRecord(row) : undefined;
  }

  /** Gets one index version status by ID. */
  public async getIndexVersionStatus(indexVersionId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ status: codeIndexVersions.status })
      .from(codeIndexVersions)
      .where(eq(codeIndexVersions.indexVersionId, indexVersionId))
      .limit(1);

    return row?.status;
  }

  /** Finds an existing index version for an artifact import idempotency key. */
  public async findIndexVersionForImport(
    input: IndexVersionImportLookupInput,
  ): Promise<IndexVersionImportRecord | undefined> {
    const [row] = await this.db
      .select({
        artifactHash: codeIndexVersions.artifactHash,
        chunkCount: codeIndexVersions.chunkCount,
        dependencyCount: codeIndexVersions.dependencyCount,
        diagnosticCount: codeIndexVersions.diagnosticCount,
        edgeCount: codeIndexVersions.edgeCount,
        fileCount: codeIndexVersions.fileCount,
        indexVersionId: codeIndexVersions.indexVersionId,
        routeCount: codeIndexVersions.routeCount,
        status: codeIndexVersions.status,
        symbolCount: codeIndexVersions.symbolCount,
        testMappingCount: codeIndexVersions.testMappingCount,
      })
      .from(codeIndexVersions)
      .where(
        and(
          eq(codeIndexVersions.repoId, input.repoId),
          eq(codeIndexVersions.commitSha, input.commitSha),
          eq(codeIndexVersions.indexKey, input.indexKey),
          eq(codeIndexVersions.artifactHash, input.artifactHash),
        ),
      )
      .limit(1);

    return row;
  }

  /** Inserts or refreshes an importing index version for an artifact import. */
  public async upsertImportingIndexVersion(input: UpsertImportingIndexVersionInput): Promise<void> {
    await this.db
      .insert(codeIndexVersions)
      .values({
        artifactHash: input.artifactHash,
        artifactUri: input.artifactUri,
        chunkCount: input.counts.chunkCount,
        chunkerVersion: input.chunkerVersion,
        commitSha: input.commitSha,
        completedAt: null,
        dependencyCount: input.counts.dependencyCount,
        diagnosticCount: input.counts.diagnosticCount,
        edgeCount: input.counts.edgeCount,
        embeddedChunkCount: 0,
        error: null,
        fileCount: input.counts.fileCount,
        indexKey: input.indexKey,
        indexerName: input.indexerName,
        indexerVersion: input.indexerVersion,
        indexVersionId: input.indexVersionId,
        repoId: input.repoId,
        routeCount: input.counts.routeCount,
        status: "importing",
        symbolCount: input.counts.symbolCount,
        testMappingCount: input.counts.testMappingCount,
      })
      .onConflictDoUpdate({
        target: [
          codeIndexVersions.repoId,
          codeIndexVersions.commitSha,
          codeIndexVersions.indexKey,
          codeIndexVersions.artifactHash,
        ],
        set: {
          artifactHash: input.artifactHash,
          artifactUri: input.artifactUri,
          chunkCount: input.counts.chunkCount,
          completedAt: null,
          dependencyCount: input.counts.dependencyCount,
          diagnosticCount: input.counts.diagnosticCount,
          edgeCount: input.counts.edgeCount,
          error: null,
          fileCount: input.counts.fileCount,
          routeCount: input.counts.routeCount,
          status: "importing",
          symbolCount: input.counts.symbolCount,
          testMappingCount: input.counts.testMappingCount,
        },
      });
  }

  /** Marks an index version as importing. */
  public async markIndexImporting(indexVersionId: string): Promise<CodeIndexVersion> {
    const [row] = await this.db
      .update(codeIndexVersions)
      .set({
        completedAt: null,
        error: null,
        status: "importing",
      })
      .where(eq(codeIndexVersions.indexVersionId, indexVersionId))
      .returning();

    return toCodeIndexVersion(requireReturnedRow(row));
  }

  /** Marks an index version as ready with imported counts. */
  public async markIndexReady(input: MarkIndexReadyInput): Promise<CodeIndexVersion> {
    const [row] = await this.db
      .update(codeIndexVersions)
      .set({
        chunkCount: input.counts.chunkCount,
        completedAt: new Date(input.completedAt ?? new Date().toISOString()),
        edgeCount: input.counts.edgeCount,
        embeddedChunkCount: input.counts.embeddedChunkCount,
        error: null,
        fileCount: input.counts.fileCount,
        status: "ready",
        symbolCount: input.counts.symbolCount,
      })
      .where(eq(codeIndexVersions.indexVersionId, input.indexVersionId))
      .returning();

    return toCodeIndexVersion(requireReturnedRow(row));
  }

  /** Marks an index version as failed with a structured error. */
  public async markIndexFailed(input: MarkIndexFailedInput): Promise<CodeIndexVersion> {
    const [row] = await this.db
      .update(codeIndexVersions)
      .set({
        completedAt: new Date(input.completedAt ?? new Date().toISOString()),
        error: indexFailure(input),
        status: "failed",
      })
      .where(eq(codeIndexVersions.indexVersionId, input.indexVersionId))
      .returning();

    return toCodeIndexVersion(requireReturnedRow(row));
  }

  /** Marks an index version failed with a caller-provided serialized error payload. */
  public async markIndexVersionFailedRecord(
    input: MarkIndexVersionFailedRecordInput,
  ): Promise<void> {
    await this.db
      .update(codeIndexVersions)
      .set({
        error: input.error,
        status: "failed",
      })
      .where(eq(codeIndexVersions.indexVersionId, input.indexVersionId));
  }

  /** Marks an index version ready without changing its precomputed import counts. */
  public async markIndexVersionReadyRecord(input: MarkIndexVersionReadyRecordInput): Promise<void> {
    await this.db
      .update(codeIndexVersions)
      .set({
        completedAt: input.completedAt,
        error: null,
        status: "ready",
      })
      .where(eq(codeIndexVersions.indexVersionId, input.indexVersionId));
  }
}

/** Converts a durable index version row to the repository record shape. */
function toIndexVersionRecord(row: CodeIndexVersionRow): IndexVersionRecord {
  return {
    artifactHash: row.artifactHash,
    artifactUri: row.artifactUri,
    chunkCount: row.chunkCount,
    chunkerVersion: row.chunkerVersion,
    commitSha: row.commitSha,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    dependencyCount: row.dependencyCount,
    diagnosticCount: row.diagnosticCount,
    edgeCount: row.edgeCount,
    embeddedChunkCount: row.embeddedChunkCount,
    error: row.error,
    fileCount: row.fileCount,
    indexKey: row.indexKey,
    indexerName: row.indexerName,
    indexerVersion: row.indexerVersion,
    indexVersionId: row.indexVersionId,
    repoId: row.repoId,
    routeCount: row.routeCount,
    status: row.status,
    symbolCount: row.symbolCount,
    testMappingCount: row.testMappingCount,
  };
}

/** Builds a structured failure payload for an index version. */
function indexFailure(input: MarkIndexFailedInput): ContractError {
  return {
    code: input.errorCode ?? "index_version.failed",
    message: input.errorMessage,
    ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
  };
}
