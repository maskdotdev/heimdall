import type { Org, ProviderInstallation } from "@repo/contracts";
import { and, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { orgs, providerInstallations } from "../schema";
import { toProviderInstallation } from "./row-mappers";

/** Input for upserting a provider account organization and its installation. */
export type UpsertProviderInstallationInput = {
  /** Organization row that owns the provider installation. */
  readonly org: Org;
  /** Provider installation row to insert or update. */
  readonly installation: ProviderInstallation;
};

const requireReturnedRow = <T>(row: T | undefined): T => {
  if (!row) {
    throw new Error("Database write did not return a row.");
  }

  return row;
};

/** Input for bounded provider installation listing. */
export type ListProviderInstallationsInput = {
  /** Organization IDs to include. Omit to include every organization. */
  readonly orgIds?: readonly string[];
  /** Git provider filter. */
  readonly provider?: string;
  /** Free-text search over account login and provider installation ID. */
  readonly search?: string;
  /** Maximum number of installation rows to return. */
  readonly limit: number;
};

/** Input for listing recent provider installations. */
export type ListRecentProviderInstallationsInput = {
  /** Maximum number of installation rows to return. */
  readonly limit: number;
};

/** Query helper for provider installation records. */
export class ProviderInstallationRepository {
  /** Creates a provider installation query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Inserts or updates a provider account organization and its installation. */
  public async upsertProviderInstallation(
    input: UpsertProviderInstallationInput,
  ): Promise<ProviderInstallation> {
    await this.db
      .insert(orgs)
      .values({
        createdAt: new Date(input.org.createdAt),
        metadata: input.org.metadata ?? null,
        name: input.org.name,
        orgId: input.org.orgId,
        slug: input.org.slug,
        updatedAt: new Date(input.org.updatedAt),
      })
      .onConflictDoUpdate({
        target: orgs.orgId,
        set: {
          metadata: input.org.metadata ?? null,
          name: input.org.name,
          slug: input.org.slug,
          updatedAt: new Date(input.org.updatedAt),
        },
      });

    const [row] = await this.db
      .insert(providerInstallations)
      .values({
        accountLogin: input.installation.accountLogin,
        accountType: input.installation.accountType,
        deletedAt: input.installation.deletedAt ? new Date(input.installation.deletedAt) : null,
        installationId: input.installation.installationId,
        installedAt: new Date(input.installation.installedAt),
        metadata: input.installation.metadata ?? null,
        orgId: input.installation.orgId,
        permissions: input.installation.permissions,
        provider: input.installation.provider,
        providerInstallationId: input.installation.providerInstallationId,
        suspendedAt: input.installation.suspendedAt
          ? new Date(input.installation.suspendedAt)
          : null,
      })
      .onConflictDoUpdate({
        target: [providerInstallations.provider, providerInstallations.providerInstallationId],
        set: {
          accountLogin: input.installation.accountLogin,
          accountType: input.installation.accountType,
          deletedAt: input.installation.deletedAt ? new Date(input.installation.deletedAt) : null,
          metadata: input.installation.metadata ?? null,
          orgId: input.installation.orgId,
          permissions: input.installation.permissions,
          suspendedAt: input.installation.suspendedAt
            ? new Date(input.installation.suspendedAt)
            : null,
        },
      })
      .returning();

    return toProviderInstallation(requireReturnedRow(row));
  }

  /** Gets one provider installation by durable installation ID. */
  public async getProviderInstallation(
    installationId: string,
  ): Promise<ProviderInstallation | undefined> {
    const [row] = await this.db
      .select()
      .from(providerInstallations)
      .where(eq(providerInstallations.installationId, installationId))
      .limit(1);

    return row ? toProviderInstallation(row) : undefined;
  }

  /** Lists non-deleted provider installations for visible organizations. */
  public async listActiveProviderInstallationsForOrgs(
    orgIds: readonly string[],
  ): Promise<readonly ProviderInstallation[]> {
    const uniqueOrgIds = uniqueStrings(orgIds);
    if (uniqueOrgIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select()
      .from(providerInstallations)
      .where(
        and(
          inArray(providerInstallations.orgId, uniqueOrgIds),
          isNull(providerInstallations.deletedAt),
        ),
      )
      .orderBy(desc(providerInstallations.installedAt));

    return rows.map(toProviderInstallation);
  }

  /** Lists recent provider installations for onboarding and status surfaces. */
  public async listRecentProviderInstallations(
    input: ListRecentProviderInstallationsInput,
  ): Promise<readonly ProviderInstallation[]> {
    const rows = await this.db
      .select()
      .from(providerInstallations)
      .orderBy(desc(providerInstallations.installedAt))
      .limit(providerInstallationLimit(input.limit));

    return rows.map(toProviderInstallation);
  }

  /** Lists provider installations with scoped filters for admin discovery. */
  public async listProviderInstallations(
    input: ListProviderInstallationsInput,
  ): Promise<readonly ProviderInstallation[]> {
    const filters = providerInstallationFilters(input);
    const rows = await this.db
      .select()
      .from(providerInstallations)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(providerInstallations.installedAt))
      .limit(providerInstallationLimit(input.limit));

    return rows.map(toProviderInstallation);
  }
}

/** Builds provider installation discovery filters. */
function providerInstallationFilters(input: ListProviderInstallationsInput): SQL[] {
  const filters: SQL[] = [];
  if (input.orgIds !== undefined) {
    const orgIds = uniqueStrings(input.orgIds);
    filters.push(orgIds.length > 0 ? inArray(providerInstallations.orgId, orgIds) : sql`false`);
  }
  if (input.provider) {
    filters.push(eq(providerInstallations.provider, input.provider));
  }

  const search = input.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    const searchFilter = or(
      ilike(providerInstallations.accountLogin, pattern),
      ilike(providerInstallations.providerInstallationId, pattern),
    );
    if (searchFilter) {
      filters.push(searchFilter);
    }
  }

  return filters;
}

/** Validates and returns a provider installation list limit. */
function providerInstallationLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Provider installation list limit must be an integer from 1 through 100.");
  }
  return limit;
}

/** Returns unique strings while preserving first-seen order. */
function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
