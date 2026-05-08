import type { CodeIndexVersion, ContractError } from "@repo/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { codeIndexVersions } from "../schema";
import { toCodeIndexVersion } from "./row-mappers";

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
  public constructor(private readonly db: HeimdallDatabase) {}

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
}

/** Builds a structured failure payload for an index version. */
function indexFailure(input: MarkIndexFailedInput): ContractError {
  return {
    code: input.errorCode ?? "index_version.failed",
    message: input.errorMessage,
    ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
  };
}
