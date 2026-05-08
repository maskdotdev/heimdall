import { and, desc, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { complianceEvidence } from "../schema";

/** Input used to record one compliance evidence row. */
export type RecordComplianceEvidenceInput = {
  /** Stable compliance evidence ID. */
  readonly complianceEvidenceId: string;
  /** Organization scope when the evidence is tenant-specific. */
  readonly orgId?: string | null | undefined;
  /** Stable control ID this evidence supports. */
  readonly controlId: string;
  /** Evidence artifact type. */
  readonly evidenceType: string;
  /** Durable URI for the evidence artifact or manifest. */
  readonly evidenceUri: string;
  /** Optional digest for the evidence artifact. */
  readonly evidenceHash?: string | null | undefined;
  /** Timestamp when evidence collection occurred. */
  readonly collectedAt: Date | string;
  /** Actor, service, or automation that collected the evidence. */
  readonly collectedBy: string;
  /** Service or automation source that collected the evidence. */
  readonly source: string;
  /** Evidence lifecycle status. Defaults to collected. */
  readonly status?: string | undefined;
  /** Product-safe summary metadata. */
  readonly summary?: Readonly<Record<string, unknown>> | undefined;
  /** Product-safe extended metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

/** Compliance evidence row returned by repository queries. */
export type ComplianceEvidenceRecord = {
  /** Stable compliance evidence ID. */
  readonly complianceEvidenceId: string;
  /** Organization scope when the evidence is tenant-specific. */
  readonly orgId: string | null;
  /** Stable control ID this evidence supports. */
  readonly controlId: string;
  /** Evidence artifact type. */
  readonly evidenceType: string;
  /** Durable URI for the evidence artifact or manifest. */
  readonly evidenceUri: string;
  /** Optional digest for the evidence artifact. */
  readonly evidenceHash: string | null;
  /** Timestamp when evidence collection occurred. */
  readonly collectedAt: Date;
  /** Actor, service, or automation that collected the evidence. */
  readonly collectedBy: string;
  /** Service or automation source that collected the evidence. */
  readonly source: string;
  /** Evidence lifecycle status. */
  readonly status: string;
  /** Product-safe summary metadata. */
  readonly summary: unknown;
  /** Product-safe extended metadata. */
  readonly metadata: unknown;
  /** Row creation timestamp. */
  readonly createdAt: Date;
  /** Row update timestamp. */
  readonly updatedAt: Date;
};

/** Input used to list compliance evidence rows with scoped filters. */
export type ListComplianceEvidenceInput = {
  /** Organization filter. */
  readonly orgId?: string | undefined;
  /** Control ID filter. */
  readonly controlId?: string | undefined;
  /** Evidence artifact type filter. */
  readonly evidenceType?: string | undefined;
  /** Evidence lifecycle status filter. */
  readonly status?: string | undefined;
  /** Service or automation source filter. */
  readonly source?: string | undefined;
  /** Free-text search over control, type, URI, collector, and metadata. */
  readonly search?: string | undefined;
  /** Maximum number of rows to return. */
  readonly limit: number;
};

/** Query helper for durable compliance evidence records. */
export class ComplianceEvidenceRepository {
  /** Creates a compliance evidence query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Records one compliance evidence row. */
  public async recordComplianceEvidence(
    input: RecordComplianceEvidenceInput,
  ): Promise<ComplianceEvidenceRecord> {
    const collectedAt = new Date(input.collectedAt);
    const [row] = await this.db
      .insert(complianceEvidence)
      .values({
        collectedAt,
        collectedBy: input.collectedBy,
        complianceEvidenceId: input.complianceEvidenceId,
        controlId: input.controlId,
        evidenceHash: input.evidenceHash ?? null,
        evidenceType: input.evidenceType,
        evidenceUri: input.evidenceUri,
        metadata: input.metadata ?? {},
        orgId: input.orgId ?? null,
        source: input.source,
        status: input.status ?? "collected",
        summary: input.summary ?? {},
        updatedAt: collectedAt,
      })
      .returning();

    if (!row) {
      throw new Error("Database write did not return a compliance evidence row.");
    }

    return row;
  }

  /** Lists compliance evidence rows with scoped filters and deterministic ordering. */
  public async listComplianceEvidence(
    input: ListComplianceEvidenceInput,
  ): Promise<readonly ComplianceEvidenceRecord[]> {
    const conditions = complianceEvidenceFilters(input);
    return this.db
      .select()
      .from(complianceEvidence)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(complianceEvidence.collectedAt), desc(complianceEvidence.complianceEvidenceId))
      .limit(complianceEvidenceListLimit(input.limit));
  }
}

/** Builds compliance evidence filters for admin inspection. */
function complianceEvidenceFilters(input: ListComplianceEvidenceInput): SQL[] {
  const conditions: SQL[] = [];
  if (input.orgId) {
    conditions.push(eq(complianceEvidence.orgId, input.orgId));
  }
  if (input.controlId) {
    conditions.push(eq(complianceEvidence.controlId, input.controlId));
  }
  if (input.evidenceType) {
    conditions.push(eq(complianceEvidence.evidenceType, input.evidenceType));
  }
  if (input.status) {
    conditions.push(eq(complianceEvidence.status, input.status));
  }
  if (input.source) {
    conditions.push(eq(complianceEvidence.source, input.source));
  }

  const search = input.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    const searchCondition = or(
      ilike(complianceEvidence.controlId, pattern),
      ilike(complianceEvidence.evidenceType, pattern),
      ilike(complianceEvidence.evidenceUri, pattern),
      ilike(complianceEvidence.collectedBy, pattern),
      ilike(sql<string>`${complianceEvidence.summary}::text`, pattern),
      ilike(sql<string>`${complianceEvidence.metadata}::text`, pattern),
    );
    if (searchCondition) {
      conditions.push(searchCondition);
    }
  }

  return conditions;
}

/** Validates and bounds compliance evidence list limits. */
function complianceEvidenceListLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Compliance evidence list limit must be an integer from 1 to 100.");
  }

  return limit;
}
