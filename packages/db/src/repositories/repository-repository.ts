import type { Repository, RepositorySettings } from "@repo/contracts";
import { eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { repositories, repositorySettings } from "../schema";
import { toRepository, toRepositorySettings } from "./row-mappers";

const requireReturnedRow = <T>(row: T | undefined): T => {
  if (!row) {
    throw new Error("Database write did not return a row.");
  }

  return row;
};

/** Query helper for repository records and their mutable settings. */
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

  /** Gets a repository by Heimdall repository ID. */
  public async getRepository(repoId: string): Promise<Repository | undefined> {
    const [row] = await this.db.select().from(repositories).where(eq(repositories.repoId, repoId));
    return row ? toRepository(row) : undefined;
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

  /** Gets mutable settings for a repository. */
  public async getSettings(repoId: string): Promise<RepositorySettings | undefined> {
    const [row] = await this.db
      .select()
      .from(repositorySettings)
      .where(eq(repositorySettings.repoId, repoId));

    return row ? toRepositorySettings(row) : undefined;
  }
}
