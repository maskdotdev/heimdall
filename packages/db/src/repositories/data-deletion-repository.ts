import type {
  DataDeletionManifest,
  DataDeletionReason,
  DataDeletionScope,
  DataDeletionStatus,
} from "@repo/contracts";
import { and, desc, eq, type SQL } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { dataDeletionRequests } from "../schema";

/** Database surface required by the data-deletion repository. */
type DataDeletionRepositoryDatabase = Pick<HeimdallDatabase, "insert" | "select" | "update">;

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
