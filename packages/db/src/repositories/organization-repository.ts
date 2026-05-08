import { and, asc, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { orgs, providerInstallations, repositories } from "../schema";

/** Input for listing organization summaries with aggregate counts. */
export type ListOrganizationSummariesInput = {
  /** Organization IDs to include. Omit to include every organization. */
  readonly orgIds?: readonly string[] | undefined;
  /** Free-text search over organization name, slug, and durable ID. */
  readonly search?: string | undefined;
  /** Maximum number of rows to return. */
  readonly limit: number;
};

/** Organization row with provider-installation and repository aggregate counts. */
export type OrganizationSummaryRecord = {
  /** Organization ID. */
  readonly orgId: string;
  /** Organization display name. */
  readonly name: string;
  /** URL-safe organization slug. */
  readonly slug: string;
  /** Product-safe organization metadata. */
  readonly metadata: unknown;
  /** Number of provider installations associated with the organization. */
  readonly installationCount: number;
  /** Number of repositories associated with the organization. */
  readonly repositoryCount: number;
  /** Creation timestamp. */
  readonly createdAt: Date;
  /** Update timestamp. */
  readonly updatedAt: Date;
};

/** Query helper for organization discovery and scoped aggregate summaries. */
export class OrganizationRepository {
  /** Creates an organization query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Lists organization summaries in deterministic display order. */
  public async listOrganizationSummaries(
    input: ListOrganizationSummariesInput,
  ): Promise<readonly OrganizationSummaryRecord[]> {
    const conditions = organizationSummaryFilters(input);
    return this.db
      .select(organizationSummarySelect())
      .from(orgs)
      .leftJoin(providerInstallations, eq(providerInstallations.orgId, orgs.orgId))
      .leftJoin(repositories, eq(repositories.orgId, orgs.orgId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(orgs.orgId, orgs.name, orgs.slug, orgs.metadata, orgs.createdAt, orgs.updatedAt)
      .orderBy(asc(orgs.name), asc(orgs.slug))
      .limit(organizationSummaryLimit(input.limit));
  }

  /** Gets one organization summary by durable organization ID. */
  public async getOrganizationSummary(
    orgId: string,
  ): Promise<OrganizationSummaryRecord | undefined> {
    const [row] = await this.db
      .select(organizationSummarySelect())
      .from(orgs)
      .leftJoin(providerInstallations, eq(providerInstallations.orgId, orgs.orgId))
      .leftJoin(repositories, eq(repositories.orgId, orgs.orgId))
      .where(eq(orgs.orgId, orgId))
      .groupBy(orgs.orgId, orgs.name, orgs.slug, orgs.metadata, orgs.createdAt, orgs.updatedAt)
      .limit(1);

    return row;
  }
}

/** Select shape shared by organization summary reads. */
function organizationSummarySelect() {
  return {
    createdAt: orgs.createdAt,
    installationCount: sql<number>`count(distinct ${providerInstallations.installationId})::int`,
    metadata: orgs.metadata,
    name: orgs.name,
    orgId: orgs.orgId,
    repositoryCount: sql<number>`count(distinct ${repositories.repoId})::int`,
    slug: orgs.slug,
    updatedAt: orgs.updatedAt,
  };
}

/** Builds filters for organization summary discovery. */
function organizationSummaryFilters(input: ListOrganizationSummariesInput): SQL[] {
  const conditions: SQL[] = [];
  if (input.orgIds !== undefined) {
    const orgIds = uniqueStrings(input.orgIds);
    conditions.push(orgIds.length > 0 ? inArray(orgs.orgId, orgIds) : sql`false`);
  }

  const search = input.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    const searchCondition = or(
      ilike(orgs.name, pattern),
      ilike(orgs.slug, pattern),
      ilike(orgs.orgId, pattern),
    );
    if (searchCondition) {
      conditions.push(searchCondition);
    }
  }

  return conditions;
}

/** Validates and returns an organization summary list limit. */
function organizationSummaryLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Organization summary list limit must be an integer from 1 through 100.");
  }
  return limit;
}

/** Returns unique strings while preserving first-seen order. */
function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
