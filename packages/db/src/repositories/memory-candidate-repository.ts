import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
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
};

/** Query helper for durable memory candidates. */
export class MemoryCandidateRepository {
  /** Creates a memory candidate query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Lists repository and organization memory candidates that can apply to one repository. */
  public async listRepositoryMemoryCandidates(
    input: ListRepositoryMemoryCandidatesInput,
  ): Promise<readonly MemoryCandidateRecord[]> {
    const rows = await this.db
      .select()
      .from(memoryCandidates)
      .where(
        or(
          eq(memoryCandidates.repoId, input.repoId),
          and(eq(memoryCandidates.orgId, input.orgId), isNull(memoryCandidates.repoId)),
        ),
      )
      .orderBy(
        asc(memoryCandidates.status),
        desc(memoryCandidates.updatedAt),
        asc(memoryCandidates.memoryCandidateId),
      );

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
