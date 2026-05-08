import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { memoryFacts } from "../schema";

type MemoryFactRow = typeof memoryFacts.$inferSelect;

/** Durable memory fact record read through the database repository boundary. */
export type MemoryFactRecord = {
  /** Stable memory fact ID. */
  readonly memoryFactId: string;
  /** Organization that owns the memory fact. */
  readonly orgId: string;
  /** Optional repository scope for repository-specific facts. */
  readonly repoId: string | null;
  /** Durable memory fact kind stored by the memory system. */
  readonly factType: string;
  /** Human-readable memory fact content. */
  readonly body: string;
  /** Durable memory fact lifecycle status. */
  readonly status: string;
  /** Confidence score assigned to the fact. */
  readonly confidence: number;
  /** Optional expiration timestamp for temporary facts. */
  readonly expiresAt: Date | null;
  /** Product metadata used by callers to derive memory scope and source details. */
  readonly metadata: unknown;
  /** Creation timestamp. */
  readonly createdAt: Date;
  /** Last update timestamp. */
  readonly updatedAt: Date;
};

/** Input used to list active memory facts that can affect one repository review. */
export type ListActiveReviewMemoryFactsInput = {
  /** Organization that owns the repository. */
  readonly orgId: string;
  /** Repository being reviewed. */
  readonly repoId: string;
  /** Timestamp used for expiration filtering. */
  readonly now: Date;
  /** Maximum number of facts to return. */
  readonly limit: number;
};

/** Query helper for durable memory facts. */
export class MemoryFactRepository {
  /** Creates a memory fact query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Lists active repository and organization memory facts visible to one review. */
  public async listActiveReviewMemoryFacts(
    input: ListActiveReviewMemoryFactsInput,
  ): Promise<readonly MemoryFactRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("Memory fact list limit must be an integer between 1 and 100.");
    }

    const rows = await this.db
      .select()
      .from(memoryFacts)
      .where(
        and(
          eq(memoryFacts.orgId, input.orgId),
          eq(memoryFacts.status, "active"),
          or(eq(memoryFacts.repoId, input.repoId), isNull(memoryFacts.repoId)),
          or(isNull(memoryFacts.expiresAt), gt(memoryFacts.expiresAt, input.now)),
        ),
      )
      .orderBy(desc(memoryFacts.updatedAt), asc(memoryFacts.memoryFactId))
      .limit(input.limit);

    return rows.map(toMemoryFactRecord);
  }
}

/** Converts a durable memory fact row to the repository record shape. */
function toMemoryFactRecord(row: MemoryFactRow): MemoryFactRecord {
  return {
    body: row.body,
    confidence: row.confidence,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    factType: row.factType,
    memoryFactId: row.memoryFactId,
    metadata: row.metadata,
    orgId: row.orgId,
    repoId: row.repoId,
    status: row.status,
    updatedAt: row.updatedAt,
  };
}
