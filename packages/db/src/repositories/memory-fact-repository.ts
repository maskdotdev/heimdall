import { and, asc, desc, eq, gt, isNull, or, type SQL, sql } from "drizzle-orm";
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

/** Input used to list repository and organization memory facts for an inspected repository. */
export type ListRepositoryMemoryFactsInput = {
  /** Organization that owns the repository. */
  readonly orgId: string;
  /** Repository being inspected. */
  readonly repoId: string;
  /** Whether organization-scoped facts should be included with repository facts. */
  readonly includeOrgFacts?: boolean | undefined;
  /** Optional lifecycle status filter. */
  readonly status?: string | undefined;
  /** Optional fact type filter. */
  readonly factType?: string | undefined;
  /** Optional maximum number of rows to return. */
  readonly limit?: number | undefined;
};

/** Input used to insert a durable memory fact when the ID is not already present. */
export type CreateMemoryFactInput = {
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
};

/** Input used to replace mutable fields for one durable memory fact. */
export type UpdateMemoryFactInput = {
  /** Stable memory fact ID. */
  readonly memoryFactId: string;
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
  /** Timestamp to store as the last update time. */
  readonly updatedAt?: Date | undefined;
};

/** Input used to disable one durable memory fact. */
export type DisableMemoryFactInput = {
  /** Stable memory fact ID. */
  readonly memoryFactId: string;
  /** Product metadata to store with the disabled fact. */
  readonly metadata: unknown;
  /** Timestamp to store as the last update time. */
  readonly updatedAt?: Date | undefined;
};

/** Query helper for durable memory facts. */
export class MemoryFactRepository {
  /** Creates a memory fact query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Gets one durable memory fact by ID. */
  public async getMemoryFact(memoryFactId: string): Promise<MemoryFactRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(memoryFacts)
      .where(eq(memoryFacts.memoryFactId, memoryFactId))
      .limit(1);

    return row ? toMemoryFactRecord(row) : undefined;
  }

  /** Creates one durable memory fact or returns the existing row for the same ID. */
  public async createMemoryFactIfAbsent(input: CreateMemoryFactInput): Promise<MemoryFactRecord> {
    const [inserted] = await this.db
      .insert(memoryFacts)
      .values({
        body: input.body,
        confidence: input.confidence,
        expiresAt: input.expiresAt,
        factType: input.factType,
        memoryFactId: input.memoryFactId,
        metadata: input.metadata,
        orgId: input.orgId,
        repoId: input.repoId,
        status: input.status,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      return toMemoryFactRecord(inserted);
    }

    const existing = await this.getMemoryFact(input.memoryFactId);
    if (!existing) {
      throw new Error(`Memory fact ${input.memoryFactId} was not found after conflict handling.`);
    }

    return existing;
  }

  /** Updates one durable memory fact and returns the stored row when it exists. */
  public async updateMemoryFact(
    input: UpdateMemoryFactInput,
  ): Promise<MemoryFactRecord | undefined> {
    const [row] = await this.db
      .update(memoryFacts)
      .set({
        body: input.body,
        confidence: input.confidence,
        expiresAt: input.expiresAt,
        factType: input.factType,
        metadata: input.metadata,
        status: input.status,
        updatedAt: input.updatedAt ?? new Date(),
      })
      .where(eq(memoryFacts.memoryFactId, input.memoryFactId))
      .returning();

    return row ? toMemoryFactRecord(row) : undefined;
  }

  /** Disables one durable memory fact and returns the stored row when it exists. */
  public async disableMemoryFact(
    input: DisableMemoryFactInput,
  ): Promise<MemoryFactRecord | undefined> {
    const [row] = await this.db
      .update(memoryFacts)
      .set({
        metadata: input.metadata,
        status: "disabled",
        updatedAt: input.updatedAt ?? new Date(),
      })
      .where(eq(memoryFacts.memoryFactId, input.memoryFactId))
      .returning();

    return row ? toMemoryFactRecord(row) : undefined;
  }

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

  /** Lists repository and organization memory facts that can apply to one repository. */
  public async listRepositoryMemoryFacts(
    input: ListRepositoryMemoryFactsInput,
  ): Promise<readonly MemoryFactRecord[]> {
    const scopeCondition =
      input.includeOrgFacts === false
        ? eq(memoryFacts.repoId, input.repoId)
        : or(
            eq(memoryFacts.repoId, input.repoId),
            and(eq(memoryFacts.orgId, input.orgId), isNull(memoryFacts.repoId)),
          );
    const filters: SQL[] = [scopeCondition ?? sql`false`];
    if (input.status) {
      filters.push(eq(memoryFacts.status, input.status));
    }
    if (input.factType) {
      filters.push(eq(memoryFacts.factType, input.factType));
    }

    const query = this.db
      .select()
      .from(memoryFacts)
      .where(and(...filters))
      .orderBy(asc(memoryFacts.status), desc(memoryFacts.updatedAt), asc(memoryFacts.memoryFactId));
    const rows =
      input.limit === undefined ? await query : await query.limit(memoryListLimit(input.limit));

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

/** Validates a bounded memory inspection list limit. */
function memoryListLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Memory inspection list limit must be an integer between 1 and 500.");
  }

  return limit;
}
