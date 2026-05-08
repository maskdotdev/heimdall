import { Buffer } from "node:buffer";
import type { OrgSettings, PageInfo, Repository, RepositorySettings } from "@repo/contracts";
import { and, asc, eq, gt, inArray, or, type SQL } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { orgSettings, repositories, repositorySettings } from "../schema";
import { toOrgSettings, toRepository, toRepositorySettings } from "./row-mappers";

/** Provider identity used to find a repository row. */
export type RepositoryProviderIdentity = {
  /** Git provider that owns the repository. */
  readonly provider: Repository["provider"];
  /** Provider-native repository ID. */
  readonly providerRepoId: string;
};

/** Input for listing enabled repositories within one organization. */
export type ListEnabledRepositoriesInput = {
  /** Organization ID that owns the repositories. */
  readonly orgId: string;
  /** Maximum number of repository rows to return. */
  readonly limit: number;
  /** Opaque cursor returned by a previous page. */
  readonly cursor?: string;
};

/** Cursor-paginated repository page. */
export type RepositoryPage = {
  /** Repository rows in deterministic order. */
  readonly items: readonly Repository[];
  /** Page metadata and optional next cursor. */
  readonly pageInfo: PageInfo;
};

/** Decoded cursor for deterministic repository pagination. */
type RepositoryCursor = {
  /** Last repository full name from the previous page. */
  readonly fullName: string;
  /** Last repository ID from the previous page. */
  readonly repoId: string;
};

const requireReturnedRow = <T>(row: T | undefined): T => {
  if (!row) {
    throw new Error("Database write did not return a row.");
  }

  return row;
};

/** Query helper for repository records, repository settings, and organization defaults. */
export class RepositoryRepository {
  /** Creates a repository query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Inserts or updates a repository by its provider identity. */
  public async upsertRepository(repository: Repository): Promise<Repository> {
    const [row] = await this.db
      .insert(repositories)
      .values({
        ...repository,
        createdAt: new Date(repository.createdAt),
        updatedAt: new Date(repository.updatedAt),
      })
      .onConflictDoUpdate({
        target: [repositories.provider, repositories.providerRepoId],
        set: {
          owner: repository.owner,
          name: repository.name,
          fullName: repository.fullName,
          defaultBranch: repository.defaultBranch,
          cloneUrl: repository.cloneUrl,
          visibility: repository.visibility,
          isArchived: repository.isArchived,
          isFork: repository.isFork,
          enabled: repository.enabled,
          metadata: repository.metadata,
          updatedAt: new Date(repository.updatedAt),
        },
      })
      .returning();

    return toRepository(requireReturnedRow(row));
  }

  /** Inserts or updates provider-owned repository metadata while preserving product enablement. */
  public async upsertProviderRepositoryMetadata(repository: Repository): Promise<Repository> {
    const [row] = await this.db
      .insert(repositories)
      .values({
        ...repository,
        createdAt: new Date(repository.createdAt),
        updatedAt: new Date(repository.updatedAt),
      })
      .onConflictDoUpdate({
        target: [repositories.provider, repositories.providerRepoId],
        set: {
          owner: repository.owner,
          name: repository.name,
          fullName: repository.fullName,
          defaultBranch: repository.defaultBranch,
          cloneUrl: repository.cloneUrl,
          visibility: repository.visibility,
          isArchived: repository.isArchived,
          isFork: repository.isFork,
          metadata: repository.metadata,
          updatedAt: new Date(repository.updatedAt),
        },
      })
      .returning();

    return toRepository(requireReturnedRow(row));
  }

  /** Gets a repository by Heimdall repository ID. */
  public async getRepository(repoId: string): Promise<Repository | undefined> {
    return this.getRepositoryById(repoId);
  }

  /** Gets a repository by Heimdall repository ID. */
  public async getRepositoryById(repoId: string): Promise<Repository | undefined> {
    const [row] = await this.db.select().from(repositories).where(eq(repositories.repoId, repoId));
    return row ? toRepository(row) : undefined;
  }

  /** Gets a repository by provider and provider-native repository ID. */
  public async getRepositoryByProviderId(
    input: RepositoryProviderIdentity,
  ): Promise<Repository | undefined> {
    const [row] = await this.db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.provider, input.provider),
          eq(repositories.providerRepoId, input.providerRepoId),
        ),
      )
      .limit(1);

    return row ? toRepository(row) : undefined;
  }

  /** Lists repositories by durable IDs. */
  public async listRepositoriesByIds(repoIds: readonly string[]): Promise<readonly Repository[]> {
    const uniqueRepoIds = uniqueStrings(repoIds);
    if (uniqueRepoIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select()
      .from(repositories)
      .where(inArray(repositories.repoId, uniqueRepoIds))
      .orderBy(asc(repositories.repoId));

    return rows.map(toRepository);
  }

  /** Lists enabled repositories for an organization with stable cursor pagination. */
  public async listEnabledRepositories(
    input: ListEnabledRepositoriesInput,
  ): Promise<RepositoryPage> {
    const limit = repositoryPageLimit(input.limit);
    const filters: SQL[] = [eq(repositories.orgId, input.orgId), eq(repositories.enabled, true)];
    const cursor = input.cursor ? decodeRepositoryCursor(input.cursor) : undefined;
    if (cursor) {
      const cursorFilter = or(
        gt(repositories.fullName, cursor.fullName),
        and(eq(repositories.fullName, cursor.fullName), gt(repositories.repoId, cursor.repoId)),
      );
      if (cursorFilter) {
        filters.push(cursorFilter);
      }
    }

    const rows = await this.db
      .select()
      .from(repositories)
      .where(and(...filters))
      .orderBy(asc(repositories.fullName), asc(repositories.repoId))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(toRepository);

    return {
      items,
      pageInfo: repositoryPageInfo(items, rows.length > limit),
    };
  }

  /** Updates whether a repository is enabled for automated review. */
  public async updateRepositoryEnabled(repoId: string, enabled: boolean): Promise<Repository> {
    const [row] = await this.db
      .update(repositories)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(repositories.repoId, repoId))
      .returning();

    return toRepository(requireReturnedRow(row));
  }

  /** Inserts or updates mutable repository settings. */
  public async upsertSettings(settings: RepositorySettings): Promise<RepositorySettings> {
    const [row] = await this.db
      .insert(repositorySettings)
      .values({
        ...settings,
        createdAt: new Date(settings.createdAt),
        updatedAt: new Date(settings.updatedAt),
      })
      .onConflictDoUpdate({
        target: repositorySettings.repoId,
        set: {
          reviewPolicy: settings.reviewPolicy,
          severityThreshold: settings.severityThreshold,
          maxCommentsPerReview: settings.maxCommentsPerReview,
          ignoredPaths: settings.ignoredPaths,
          ignoredAuthors: settings.ignoredAuthors,
          ignoredLabels: settings.ignoredLabels,
          requireLabel: settings.requireLabel,
          skipGeneratedFiles: settings.skipGeneratedFiles,
          skipDraftPullRequests: settings.skipDraftPullRequests,
          enabledLanguages: settings.enabledLanguages,
          customInstructions: settings.customInstructions,
          sandboxPolicy: settings.sandboxPolicy,
          updatedAt: new Date(settings.updatedAt),
        },
      })
      .returning();

    return toRepositorySettings(requireReturnedRow(row));
  }

  /** Inserts repository settings only when no row exists yet. */
  public async insertSettingsIfAbsent(settings: RepositorySettings): Promise<RepositorySettings> {
    const [row] = await this.db
      .insert(repositorySettings)
      .values({
        ...settings,
        createdAt: new Date(settings.createdAt),
        updatedAt: new Date(settings.updatedAt),
      })
      .onConflictDoNothing()
      .returning();

    if (row) {
      return toRepositorySettings(row);
    }

    const existing = await this.getSettings(settings.repoId);
    if (!existing) {
      throw new Error(`Repository settings row was not returned after insert: ${settings.repoId}`);
    }

    return existing;
  }

  /** Gets mutable settings for a repository. */
  public async getSettings(repoId: string): Promise<RepositorySettings | undefined> {
    const [row] = await this.db
      .select()
      .from(repositorySettings)
      .where(eq(repositorySettings.repoId, repoId));

    return row ? toRepositorySettings(row) : undefined;
  }

  /** Lists mutable settings for repositories by durable IDs. */
  public async listSettingsForRepositories(
    repoIds: readonly string[],
  ): Promise<readonly RepositorySettings[]> {
    const uniqueRepoIds = uniqueStrings(repoIds);
    if (uniqueRepoIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select()
      .from(repositorySettings)
      .where(inArray(repositorySettings.repoId, uniqueRepoIds))
      .orderBy(asc(repositorySettings.repoId));

    return rows.map(toRepositorySettings);
  }

  /** Inserts or updates mutable organization policy defaults. */
  public async upsertOrgSettings(settings: OrgSettings): Promise<OrgSettings> {
    const [row] = await this.db
      .insert(orgSettings)
      .values({
        orgId: settings.orgId,
        settingsJson: toOrgSettingsJson(settings),
        version: settings.version,
        updatedByUserId: settings.updatedByUserId,
        createdAt: new Date(settings.createdAt),
        updatedAt: new Date(settings.updatedAt),
      })
      .onConflictDoUpdate({
        target: orgSettings.orgId,
        set: {
          settingsJson: toOrgSettingsJson(settings),
          version: settings.version,
          updatedByUserId: settings.updatedByUserId,
          updatedAt: new Date(settings.updatedAt),
        },
      })
      .returning();

    return toOrgSettings(requireReturnedRow(row));
  }

  /** Gets mutable organization policy defaults. */
  public async getOrgSettings(orgId: string): Promise<OrgSettings | undefined> {
    const [row] = await this.db.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
    return row ? toOrgSettings(row) : undefined;
  }

  /** Lists mutable organization policy defaults by durable organization IDs. */
  public async listOrgSettings(orgIds: readonly string[]): Promise<readonly OrgSettings[]> {
    const uniqueOrgIds = uniqueStrings(orgIds);
    if (uniqueOrgIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select()
      .from(orgSettings)
      .where(inArray(orgSettings.orgId, uniqueOrgIds))
      .orderBy(asc(orgSettings.orgId));

    return rows.map(toOrgSettings);
  }
}

/** Returns the JSON payload stored in the organization settings row. */
function toOrgSettingsJson(settings: OrgSettings): Record<string, unknown> {
  return {
    schemaVersion: settings.schemaVersion,
    defaultReviewPolicy: settings.defaultReviewPolicy,
    defaultTriggerPolicy: settings.defaultTriggerPolicy,
    defaultFindingPolicy: settings.defaultFindingPolicy,
    defaultPublishingPolicy: settings.defaultPublishingPolicy,
    defaultMemoryPolicy: settings.defaultMemoryPolicy,
    ...(settings.allowedModelProfiles
      ? { allowedModelProfiles: settings.allowedModelProfiles }
      : {}),
    allowRepoLocalConfig: settings.allowRepoLocalConfig,
    allowMemorySuppression: settings.allowMemorySuppression,
    allowUserDefinedRules: settings.allowUserDefinedRules,
  };
}

/** Validates and returns a repository page limit. */
function repositoryPageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Repository page limit must be an integer from 1 through 100.");
  }
  return limit;
}

/** Builds page metadata for a repository page. */
function repositoryPageInfo(items: readonly Repository[], hasNextPage: boolean): PageInfo {
  const lastItem = items.at(-1);
  return {
    hasNextPage,
    ...(hasNextPage && lastItem ? { nextCursor: encodeRepositoryCursor(lastItem) } : {}),
  };
}

/** Encodes a repository position as an opaque pagination cursor. */
function encodeRepositoryCursor(repository: Repository): string {
  return Buffer.from(
    JSON.stringify({
      fullName: repository.fullName,
      repoId: repository.repoId,
    } satisfies RepositoryCursor),
    "utf8",
  ).toString("base64url");
}

/** Decodes and validates an opaque repository pagination cursor. */
function decodeRepositoryCursor(cursor: string): RepositoryCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (isRepositoryCursor(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to the shared error below.
  }

  throw new Error("Invalid repository pagination cursor.");
}

/** Returns whether a decoded value has the repository cursor shape. */
function isRepositoryCursor(value: unknown): value is RepositoryCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.fullName === "string" && typeof record.repoId === "string";
}

/** Returns unique strings while preserving first-seen order. */
function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
