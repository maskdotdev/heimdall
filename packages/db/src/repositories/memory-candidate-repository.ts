import { and, asc, desc, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { memoryCandidates } from "../schema";

type MemoryCandidateRow = typeof memoryCandidates.$inferSelect;

/** Durable memory candidate record read through the database repository boundary. */
export type MemoryCandidateRecord = {
  /** Stable memory candidate ID. */
  readonly memoryCandidateId: string;
  /** Organization that owns the candidate. */
  readonly orgId: string;
  /** Optional repository scope for repository-specific candidates. */
  readonly repoId: string | null;
  /** Source that proposed the candidate. */
  readonly sourceKind: string;
  /** Durable candidate kind stored by the memory system. */
  readonly candidateKind: string;
  /** Proposed memory content. */
  readonly proposedContent: string;
  /** Proposed memory scope payload. */
  readonly proposedScope: unknown;
  /** Proposed applies-to payload. */
  readonly proposedAppliesTo: unknown;
  /** Confidence score assigned to the candidate. */
  readonly confidence: number;
  /** Trust level assigned to the proposing actor or source. */
  readonly trustLevel: string;
  /** Durable candidate lifecycle status. */
  readonly status: string;
  /** User login that created the candidate when present. */
  readonly createdByLogin: string | null;
  /** Feedback event that produced the candidate when present. */
  readonly sourceFeedbackEventId: string | null;
  /** Published finding that produced the candidate when present. */
  readonly sourceFindingId: string | null;
  /** Memory fact created from the candidate when approved. */
  readonly approvedMemoryFactId: string | null;
  /** User that made the moderation decision when present. */
  readonly decidedByUserId: string | null;
  /** Decision timestamp when present. */
  readonly decidedAt: Date | null;
  /** Optional expiration timestamp for temporary candidates. */
  readonly expiresAt: Date | null;
  /** Product metadata used by callers to derive source details. */
  readonly metadata: unknown;
  /** Creation timestamp. */
  readonly createdAt: Date;
  /** Last update timestamp. */
  readonly updatedAt: Date;
};

/** Input used to list repository and organization memory candidates for inspection. */
export type ListRepositoryMemoryCandidatesInput = {
  /** Organization that owns the repository. */
  readonly orgId: string;
  /** Repository being inspected. */
  readonly repoId: string;
  /** Whether organization-scoped candidates should be included with repository candidates. */
  readonly includeOrgCandidates?: boolean | undefined;
  /** Optional lifecycle status filter. */
  readonly status?: string | undefined;
  /** Optional candidate kind filter. */
  readonly candidateKind?: string | undefined;
  /** Optional maximum number of rows to return. */
  readonly limit?: number | undefined;
};

/** Input used to approve one durable memory candidate. */
export type ApproveMemoryCandidateInput = {
  /** Stable memory candidate ID. */
  readonly memoryCandidateId: string;
  /** Durable memory fact created from the candidate. */
  readonly memoryFactId: string;
  /** User that made the moderation decision when present. */
  readonly decidedByUserId: string | null;
  /** Product metadata to store with the approved candidate. */
  readonly metadata: unknown;
  /** Decision timestamp to store on the candidate. */
  readonly decidedAt?: Date | undefined;
};

/** Input used to reject one durable memory candidate. */
export type RejectMemoryCandidateInput = {
  /** Stable memory candidate ID. */
  readonly memoryCandidateId: string;
  /** User that made the moderation decision when present. */
  readonly decidedByUserId: string | null;
  /** Product metadata to store with the rejected candidate. */
  readonly metadata: unknown;
  /** Decision timestamp to store on the candidate. */
  readonly decidedAt?: Date | undefined;
};

/** Query helper for durable memory candidates. */
export class MemoryCandidateRepository {
  /** Creates a memory candidate query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Gets one durable memory candidate by ID. */
  public async getMemoryCandidate(
    memoryCandidateId: string,
  ): Promise<MemoryCandidateRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(memoryCandidates)
      .where(eq(memoryCandidates.memoryCandidateId, memoryCandidateId))
      .limit(1);

    return row ? toMemoryCandidateRecord(row) : undefined;
  }

  /** Marks one durable memory candidate approved and returns the stored row when it exists. */
  public async approveMemoryCandidate(
    input: ApproveMemoryCandidateInput,
  ): Promise<MemoryCandidateRecord | undefined> {
    const decidedAt = input.decidedAt ?? new Date();
    const [row] = await this.db
      .update(memoryCandidates)
      .set({
        approvedMemoryFactId: input.memoryFactId,
        decidedAt,
        decidedByUserId: input.decidedByUserId,
        metadata: input.metadata,
        status: "approved",
        updatedAt: decidedAt,
      })
      .where(eq(memoryCandidates.memoryCandidateId, input.memoryCandidateId))
      .returning();

    return row ? toMemoryCandidateRecord(row) : undefined;
  }

  /** Marks one durable memory candidate rejected and returns the stored row when it exists. */
  public async rejectMemoryCandidate(
    input: RejectMemoryCandidateInput,
  ): Promise<MemoryCandidateRecord | undefined> {
    const decidedAt = input.decidedAt ?? new Date();
    const [row] = await this.db
      .update(memoryCandidates)
      .set({
        decidedAt,
        decidedByUserId: input.decidedByUserId,
        metadata: input.metadata,
        status: "rejected",
        updatedAt: decidedAt,
      })
      .where(eq(memoryCandidates.memoryCandidateId, input.memoryCandidateId))
      .returning();

    return row ? toMemoryCandidateRecord(row) : undefined;
  }

  /** Lists repository and organization memory candidates that can apply to one repository. */
  public async listRepositoryMemoryCandidates(
    input: ListRepositoryMemoryCandidatesInput,
  ): Promise<readonly MemoryCandidateRecord[]> {
    const scopeCondition =
      input.includeOrgCandidates === false
        ? eq(memoryCandidates.repoId, input.repoId)
        : or(
            eq(memoryCandidates.repoId, input.repoId),
            and(eq(memoryCandidates.orgId, input.orgId), isNull(memoryCandidates.repoId)),
          );
    const filters: SQL[] = [scopeCondition ?? sql`false`];
    if (input.status) {
      filters.push(eq(memoryCandidates.status, input.status));
    }
    if (input.candidateKind) {
      filters.push(eq(memoryCandidates.candidateKind, input.candidateKind));
    }

    const query = this.db
      .select()
      .from(memoryCandidates)
      .where(and(...filters))
      .orderBy(
        asc(memoryCandidates.status),
        desc(memoryCandidates.updatedAt),
        asc(memoryCandidates.memoryCandidateId),
      );
    const rows =
      input.limit === undefined ? await query : await query.limit(memoryListLimit(input.limit));

    return rows.map(toMemoryCandidateRecord);
  }
}

/** Converts a durable memory candidate row to the repository record shape. */
function toMemoryCandidateRecord(row: MemoryCandidateRow): MemoryCandidateRecord {
  return {
    approvedMemoryFactId: row.approvedMemoryFactId,
    candidateKind: row.candidateKind,
    confidence: row.confidence,
    createdAt: row.createdAt,
    createdByLogin: row.createdByLogin,
    decidedAt: row.decidedAt,
    decidedByUserId: row.decidedByUserId,
    expiresAt: row.expiresAt,
    memoryCandidateId: row.memoryCandidateId,
    metadata: row.metadata,
    orgId: row.orgId,
    proposedAppliesTo: row.proposedAppliesTo,
    proposedContent: row.proposedContent,
    proposedScope: row.proposedScope,
    repoId: row.repoId,
    sourceFeedbackEventId: row.sourceFeedbackEventId,
    sourceFindingId: row.sourceFindingId,
    sourceKind: row.sourceKind,
    status: row.status,
    trustLevel: row.trustLevel,
    updatedAt: row.updatedAt,
  };
}

/** Validates a bounded memory inspection list limit. */
function memoryListLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Memory inspection list limit must be an integer between 1 and 500.");
  }

  return limit;
}
