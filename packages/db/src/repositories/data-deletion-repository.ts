import type {
  DataDeletionManifest,
  DataDeletionReason,
  DataDeletionScope,
  DataDeletionStatus,
} from "@repo/contracts";
import { and, asc, desc, eq, inArray, like, not, or, type SQL } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import {
  backgroundJobs,
  codeChunkEmbeddings,
  dataDeletionRequests,
  repositories,
  reviewArtifacts,
} from "../schema";

/** Database surface required by the data-deletion repository. */
type DataDeletionRepositoryDatabase = Pick<
  HeimdallDatabase,
  "delete" | "insert" | "select" | "update"
>;

/** Input used to create one durable data-deletion request. */
export type CreateDataDeletionRequestInput = {
  /** Stable data-deletion request ID. */
  readonly dataDeletionRequestId: string;
  /** Organization scope when present. */
  readonly orgId?: string | null | undefined;
  /** User scope when present. */
  readonly userId?: string | null | undefined;
  /** Repository scope when present. */
  readonly repoId?: string | null | undefined;
  /** Deletion trigger reason. */
  readonly reason: DataDeletionReason;
  /** Deletion resource scope. */
  readonly scope: DataDeletionScope;
  /** Initial lifecycle state. Defaults to requested. */
  readonly status?: DataDeletionStatus | undefined;
  /** Actor or system identifier that requested the deletion. */
  readonly requestedBy: string;
  /** Request creation timestamp. Defaults to the database clock. */
  readonly requestedAt?: Date | string | undefined;
  /** Product-safe deletion manifest. */
  readonly manifest?: DataDeletionManifest | null | undefined;
  /** Product-safe request metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | null | undefined;
};

/** Result returned after idempotently creating a data-deletion request. */
export type CreateDataDeletionRequestResult = {
  /** Durable data-deletion request row. */
  readonly request: DataDeletionRequestRecord;
  /** Whether this call inserted the request row. */
  readonly inserted: boolean;
};

/** Input used to list data-deletion requests. */
export type ListDataDeletionRequestsInput = {
  /** Organization filter. */
  readonly orgId?: string | undefined;
  /** Repository filter. */
  readonly repoId?: string | undefined;
  /** Status filter. */
  readonly status?: DataDeletionStatus | undefined;
  /** Maximum rows to return. */
  readonly limit: number;
};

/** Input used to resolve repository rows covered by one deletion scope. */
export type ListDataDeletionRepositoryIdsInput = {
  /** Organization scope when present. */
  readonly orgId?: string | null | undefined;
  /** Repository scope when present. */
  readonly repoId?: string | null | undefined;
};

/** Repository identity included in a deletion scope. */
export type DataDeletionRepositoryIdRecord = {
  /** Stable repository ID. */
  readonly repoId: string;
};

/** Input used to list review artifacts whose payloads should be deleted. */
export type ListDataDeletionReviewArtifactTargetsInput = {
  /** URI prefix that marks already deleted artifact payloads. */
  readonly excludeUriPrefix: string;
  /** Maximum rows to return. */
  readonly limit: number;
  /** Repository IDs covered by the deletion request. */
  readonly repoIds: readonly string[];
};

/** Review artifact payload selected for data-deletion tombstoning. */
export type DataDeletionReviewArtifactTargetRecord = {
  /** Product-safe artifact metadata used by the payload store. */
  readonly metadata: unknown;
  /** Durable review artifact ID. */
  readonly reviewArtifactId: string;
  /** Payload URI to delete. */
  readonly uri: string;
};

/** Input used to cancel pending or queued durable jobs for a deletion scope. */
export type CancelPendingDataDeletionJobsInput = {
  /** Product-safe cancellation reason. */
  readonly reason: string;
  /** Organization scope when present. */
  readonly orgId?: string | null | undefined;
  /** Repository IDs covered by the deletion request. */
  readonly repoIds?: readonly string[] | undefined;
  /** Current timestamp for deterministic tests. */
  readonly now?: Date | string | undefined;
};

/** Input used to update a durable data-deletion request state. */
export type UpdateDataDeletionRequestStatusInput = {
  /** Stable data-deletion request ID. */
  readonly dataDeletionRequestId: string;
  /** New lifecycle state. */
  readonly status: DataDeletionStatus;
  /** Completion timestamp for terminal states. */
  readonly completedAt?: Date | string | null | undefined;
  /** Product-safe manifest generated during planning or deletion. */
  readonly manifest?: DataDeletionManifest | null | undefined;
  /** Product-safe metadata to replace the current metadata value. */
  readonly metadata?: Readonly<Record<string, unknown>> | null | undefined;
  /** Row update timestamp. Defaults to the database clock. */
  readonly now?: Date | string | undefined;
  /** Verification evidence artifact URI produced by the workflow. */
  readonly verificationArtifactUri?: string | null | undefined;
};

/** Durable data-deletion request row. */
export type DataDeletionRequestRecord = {
  /** Stable data-deletion request ID. */
  readonly dataDeletionRequestId: string;
  /** Organization scope when present. */
  readonly orgId: string | null;
  /** User scope when present. */
  readonly userId: string | null;
  /** Repository scope when present. */
  readonly repoId: string | null;
  /** Deletion trigger reason. */
  readonly reason: DataDeletionReason;
  /** Deletion resource scope. */
  readonly scope: DataDeletionScope;
  /** Current lifecycle state. */
  readonly status: DataDeletionStatus;
  /** Actor or system identifier that requested the deletion. */
  readonly requestedBy: string;
  /** Request creation timestamp. */
  readonly requestedAt: Date;
  /** Completion timestamp when present. */
  readonly completedAt: Date | null;
  /** Verification evidence artifact URI when present. */
  readonly verificationArtifactUri: string | null;
  /** Product-safe deletion manifest. */
  readonly manifest: unknown;
  /** Product-safe request metadata. */
  readonly metadata: unknown;
  /** Row creation time. */
  readonly createdAt: Date;
  /** Last row update time. */
  readonly updatedAt: Date;
};

const maxDataDeletionRequestListLimit = 100;
const maxDataDeletionRepositoryScopeLimit = 10_000;
const maxDataDeletionArtifactTargetLimit = 1_000;

/** Query helper for durable customer-data deletion requests. */
export class DataDeletionRepository {
  /** Creates a data-deletion query helper. */
  public constructor(private readonly db: DataDeletionRepositoryDatabase) {}

  /** Creates a data-deletion request without duplicating request IDs. */
  public async createDataDeletionRequest(
    input: CreateDataDeletionRequestInput,
  ): Promise<CreateDataDeletionRequestResult> {
    const [insertedRow] = await this.db
      .insert(dataDeletionRequests)
      .values({
        dataDeletionRequestId: input.dataDeletionRequestId,
        manifest: input.manifest ?? {},
        metadata: input.metadata ?? {},
        orgId: input.orgId ?? null,
        reason: input.reason,
        repoId: input.repoId ?? null,
        requestedAt: toOptionalDate(input.requestedAt),
        requestedBy: input.requestedBy,
        scope: input.scope,
        status: input.status ?? "requested",
        userId: input.userId ?? null,
      })
      .onConflictDoNothing({ target: dataDeletionRequests.dataDeletionRequestId })
      .returning();

    if (insertedRow) {
      return {
        inserted: true,
        request: toDataDeletionRequestRecord(insertedRow),
      };
    }

    const existing = await this.getDataDeletionRequest(input.dataDeletionRequestId);
    if (!existing) {
      throw new Error(
        "Data-deletion request insert conflicted but no existing request row was found.",
      );
    }

    return { inserted: false, request: existing };
  }

  /** Gets one data-deletion request by ID. */
  public async getDataDeletionRequest(
    dataDeletionRequestId: string,
  ): Promise<DataDeletionRequestRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(dataDeletionRequests)
      .where(eq(dataDeletionRequests.dataDeletionRequestId, dataDeletionRequestId))
      .limit(1);

    return row ? toDataDeletionRequestRecord(row) : undefined;
  }

  /** Lists data-deletion requests in newest-first order. */
  public async listDataDeletionRequests(
    input: ListDataDeletionRequestsInput,
  ): Promise<readonly DataDeletionRequestRecord[]> {
    const limit = normalizeDataDeletionRequestLimit(input.limit);
    const filters: SQL[] = [];

    if (input.orgId) {
      filters.push(eq(dataDeletionRequests.orgId, input.orgId));
    }
    if (input.repoId) {
      filters.push(eq(dataDeletionRequests.repoId, input.repoId));
    }
    if (input.status) {
      filters.push(eq(dataDeletionRequests.status, input.status));
    }

    const rows = await this.db
      .select()
      .from(dataDeletionRequests)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(
        desc(dataDeletionRequests.requestedAt),
        desc(dataDeletionRequests.dataDeletionRequestId),
      )
      .limit(limit);

    return rows.map(toDataDeletionRequestRecord);
  }

  /** Lists repository IDs covered by one deletion scope. */
  public async listRepositoryIdsForDeletionScope(
    input: ListDataDeletionRepositoryIdsInput,
  ): Promise<readonly DataDeletionRepositoryIdRecord[]> {
    const filters: SQL[] = [];

    if (input.orgId) {
      filters.push(eq(repositories.orgId, input.orgId));
    }
    if (input.repoId) {
      filters.push(eq(repositories.repoId, input.repoId));
    }
    if (filters.length === 0) {
      return [];
    }

    return this.db
      .select({ repoId: repositories.repoId })
      .from(repositories)
      .where(and(...filters))
      .orderBy(asc(repositories.repoId))
      .limit(maxDataDeletionRepositoryScopeLimit);
  }

  /** Disables repositories covered by a deletion request. */
  public async disableRepositoriesForDeletion(repoIds: readonly string[]): Promise<number> {
    const uniqueRepoIds = uniqueStableStrings(repoIds);
    if (uniqueRepoIds.length === 0) {
      return 0;
    }

    const rows = await this.db
      .update(repositories)
      .set({ enabled: false, updatedAt: new Date() })
      .where(inArray(repositories.repoId, [...uniqueRepoIds]))
      .returning({ repoId: repositories.repoId });

    return rows.length;
  }

  /** Lists review artifact payloads that need deletion tombstones. */
  public async listReviewArtifactPayloadDeletionTargets(
    input: ListDataDeletionReviewArtifactTargetsInput,
  ): Promise<readonly DataDeletionReviewArtifactTargetRecord[]> {
    const uniqueRepoIds = uniqueStableStrings(input.repoIds);
    if (uniqueRepoIds.length === 0) {
      return [];
    }

    const limit = normalizeDataDeletionArtifactTargetLimit(input.limit);

    return this.db
      .select({
        metadata: reviewArtifacts.metadata,
        reviewArtifactId: reviewArtifacts.reviewArtifactId,
        uri: reviewArtifacts.uri,
      })
      .from(reviewArtifacts)
      .where(
        and(
          inArray(reviewArtifacts.repoId, [...uniqueRepoIds]),
          not(like(reviewArtifacts.uri, `${input.excludeUriPrefix}%`)),
        ),
      )
      .orderBy(asc(reviewArtifacts.createdAt), asc(reviewArtifacts.reviewArtifactId))
      .limit(limit);
  }

  /** Deletes code chunk embedding vectors for repositories covered by a deletion request. */
  public async deleteCodeChunkEmbeddingsForRepositories(
    repoIds: readonly string[],
  ): Promise<number> {
    const uniqueRepoIds = uniqueStableStrings(repoIds);
    if (uniqueRepoIds.length === 0) {
      return 0;
    }

    const rows = await this.db
      .delete(codeChunkEmbeddings)
      .where(inArray(codeChunkEmbeddings.repoId, [...uniqueRepoIds]))
      .returning({ chunkEmbeddingId: codeChunkEmbeddings.chunkEmbeddingId });

    return rows.length;
  }

  /** Cancels pending or queued durable jobs covered by a deletion request. */
  public async cancelPendingBackgroundJobsForDeletionScope(
    input: CancelPendingDataDeletionJobsInput,
  ): Promise<number> {
    const uniqueRepoIds = uniqueStableStrings(input.repoIds ?? []);
    const scopeFilters: SQL[] = [];

    if (input.orgId) {
      scopeFilters.push(eq(backgroundJobs.orgId, input.orgId));
    }
    if (uniqueRepoIds.length > 0) {
      scopeFilters.push(inArray(backgroundJobs.repoId, [...uniqueRepoIds]));
    }

    const scopeFilter =
      scopeFilters.length === 1
        ? scopeFilters[0]
        : scopeFilters.length > 1
          ? or(...scopeFilters)
          : undefined;

    if (!scopeFilter) {
      return 0;
    }

    const now = input.now ? new Date(input.now) : new Date();
    const rows = await this.db
      .update(backgroundJobs)
      .set({
        completedAt: now,
        error: {
          message: input.reason,
          name: "DataDeletionCanceledJobError",
        },
        metadata: {
          cancellation: {
            canceledAt: now.toISOString(),
            reason: input.reason,
          },
        },
        startedAt: null,
        status: "canceled",
        updatedAt: now,
      })
      .where(and(inArray(backgroundJobs.status, ["pending", "queued"]), scopeFilter))
      .returning({ backgroundJobId: backgroundJobs.backgroundJobId });

    return rows.length;
  }

  /** Updates one data-deletion request lifecycle state. */
  public async updateDataDeletionRequestStatus(
    input: UpdateDataDeletionRequestStatusInput,
  ): Promise<DataDeletionRequestRecord | undefined> {
    const [row] = await this.db
      .update(dataDeletionRequests)
      .set({
        ...(input.completedAt === undefined
          ? {}
          : { completedAt: input.completedAt === null ? null : new Date(input.completedAt) }),
        ...(input.manifest === undefined ? {} : { manifest: input.manifest ?? {} }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata ?? {} }),
        status: input.status,
        updatedAt: input.now ? new Date(input.now) : new Date(),
        ...(input.verificationArtifactUri === undefined
          ? {}
          : { verificationArtifactUri: input.verificationArtifactUri }),
      })
      .where(eq(dataDeletionRequests.dataDeletionRequestId, input.dataDeletionRequestId))
      .returning();

    return row ? toDataDeletionRequestRecord(row) : undefined;
  }
}

/** Converts nullable dates accepted by repository inputs. */
function toOptionalDate(value: Date | string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

/** Returns a bounded data-deletion request list limit. */
function normalizeDataDeletionRequestLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxDataDeletionRequestListLimit) {
    throw new Error(`limit must be an integer between 1 and ${maxDataDeletionRequestListLimit}.`);
  }

  return limit;
}

/** Returns a bounded data-deletion artifact target limit. */
function normalizeDataDeletionArtifactTargetLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxDataDeletionArtifactTargetLimit) {
    throw new Error(
      `limit must be an integer between 1 and ${maxDataDeletionArtifactTargetLimit}.`,
    );
  }

  return limit;
}

/** Returns stable unique string values while preserving caller order. */
function uniqueStableStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Maps a Drizzle data-deletion row to the repository record. */
function toDataDeletionRequestRecord(
  row: typeof dataDeletionRequests.$inferSelect,
): DataDeletionRequestRecord {
  return {
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    dataDeletionRequestId: row.dataDeletionRequestId,
    manifest: row.manifest,
    metadata: row.metadata,
    orgId: row.orgId,
    reason: row.reason as DataDeletionReason,
    repoId: row.repoId,
    requestedAt: row.requestedAt,
    requestedBy: row.requestedBy,
    scope: row.scope as DataDeletionScope,
    status: row.status as DataDeletionStatus,
    updatedAt: row.updatedAt,
    userId: row.userId,
    verificationArtifactUri: row.verificationArtifactUri,
  };
}
