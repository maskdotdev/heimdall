import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ORG_SETTINGS,
  type OrgSettings,
  type Repository,
  type RepositorySettings,
} from "@repo/contracts";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { RepositoryRepository } from "../src/repositories/repository-repository";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("RepositoryRepository integration", () => {
  const schemaName = `heimdall_repo_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const repositoryRepository = new RepositoryRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await seedRepositoryParents(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("finds repositories by provider ID and pages enabled repositories", async () => {
    await repositoryRepository.upsertRepository(
      repositoryFixture({
        fullName: "acme/alpha",
        name: "alpha",
        providerRepoId: "1001",
        repoId: "repo_repository_alpha",
      }),
    );
    await repositoryRepository.upsertRepository(
      repositoryFixture({
        fullName: "acme/beta",
        name: "beta",
        providerRepoId: "1002",
        repoId: "repo_repository_beta",
      }),
    );
    await repositoryRepository.upsertRepository(
      repositoryFixture({
        enabled: false,
        fullName: "acme/gamma",
        name: "gamma",
        providerRepoId: "1003",
        repoId: "repo_repository_gamma",
      }),
    );
    await repositoryRepository.upsertRepository(
      repositoryFixture({
        fullName: "other/enabled",
        installationId: "inst_repository_other",
        name: "enabled",
        orgId: "org_repository_other",
        providerRepoId: "2001",
        repoId: "repo_repository_other",
      }),
    );

    const foundByProvider = await repositoryRepository.getRepositoryByProviderId({
      provider: "github",
      providerRepoId: "1001",
    });
    expect(foundByProvider?.repoId).toBe("repo_repository_alpha");
    await expect(repositoryRepository.getRepositoryOrgId("repo_repository_alpha")).resolves.toBe(
      "org_repository_test",
    );
    await expect(repositoryRepository.getRepositoryOrgId("repo_repository_missing")).resolves.toBe(
      undefined,
    );
    await expect(
      repositoryRepository.getRepositoryProviderRef({
        provider: "github",
        repoId: "repo_repository_alpha",
      }),
    ).resolves.toMatchObject({
      installationId: "inst_repository_test",
      owner: "acme",
      provider: "github",
      providerInstallationId: "repository-test-installation",
      providerRepoId: "1001",
      repo: "alpha",
    });
    await expect(
      repositoryRepository.getRepositoryProviderRef({
        installationId: "inst_repository_other",
        provider: "github",
        repoId: "repo_repository_alpha",
      }),
    ).resolves.toBeUndefined();

    const firstPage = await repositoryRepository.listEnabledRepositories({
      orgId: "org_repository_test",
      limit: 1,
    });
    expect(firstPage.items.map((repository) => repository.repoId)).toEqual([
      "repo_repository_alpha",
    ]);
    expect(firstPage.pageInfo.hasNextPage).toBe(true);
    expect(firstPage.pageInfo.nextCursor).toEqual(expect.any(String));
    const nextCursor = firstPage.pageInfo.nextCursor;
    if (!nextCursor) {
      throw new Error("Expected the first repository page to include a next cursor.");
    }

    const secondPage = await repositoryRepository.listEnabledRepositories({
      orgId: "org_repository_test",
      limit: 1,
      cursor: nextCursor,
    });
    expect(secondPage.items.map((repository) => repository.repoId)).toEqual([
      "repo_repository_beta",
    ]);
    expect(secondPage.pageInfo).toEqual({ hasNextPage: false });

    await expect(
      repositoryRepository.listEnabledRepositories({
        orgId: "org_repository_test",
        limit: 0,
      }),
    ).rejects.toThrow(/limit must be an integer/u);
    await expect(
      repositoryRepository.listEnabledRepositories({
        cursor: "not-a-valid-cursor",
        orgId: "org_repository_test",
        limit: 1,
      }),
    ).rejects.toThrow(/Invalid repository pagination cursor/u);

    await repositoryRepository.updateRepositoryEnabled("repo_repository_alpha", false);
    const providerRefresh = await repositoryRepository.upsertProviderRepositoryMetadata(
      repositoryFixture({
        fullName: "acme/alpha-renamed",
        name: "alpha-renamed",
        providerRepoId: "1001",
        repoId: "repo_repository_alpha",
      }),
    );
    expect(providerRefresh).toMatchObject({
      enabled: false,
      fullName: "acme/alpha-renamed",
      repoId: "repo_repository_alpha",
    });

    const repositoriesById = await repositoryRepository.listRepositoriesByIds([
      "repo_repository_beta",
      "repo_repository_alpha",
    ]);
    expect(repositoriesById.map((repository) => repository.repoId)).toEqual([
      "repo_repository_alpha",
      "repo_repository_beta",
    ]);

    const settings = await repositoryRepository.insertSettingsIfAbsent(
      repositorySettingsFixture({
        repoId: "repo_repository_alpha",
        severityThreshold: "medium",
      }),
    );
    expect(settings.severityThreshold).toBe("medium");

    const preservedSettings = await repositoryRepository.insertSettingsIfAbsent(
      repositorySettingsFixture({
        repoId: "repo_repository_alpha",
        severityThreshold: "high",
      }),
    );
    expect(preservedSettings.severityThreshold).toBe("medium");

    const listedSettings = await repositoryRepository.listSettingsForRepositories([
      "repo_repository_alpha",
      "repo_repository_missing",
    ]);
    expect(listedSettings.map((row) => row.repoId)).toEqual(["repo_repository_alpha"]);

    await repositoryRepository.upsertOrgSettings(
      orgSettingsFixture({ orgId: "org_repository_test", version: 2 }),
    );
    const listedOrgSettings = await repositoryRepository.listOrgSettings([
      "org_repository_other",
      "org_repository_test",
    ]);
    expect(listedOrgSettings).toMatchObject([{ orgId: "org_repository_test", version: 2 }]);
  });
});

/** Applies all generated SQL migrations in lexical order to a test schema. */
async function applyMigrations(sql: postgres.Sql, schemaName: string): Promise<void> {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  for (const file of files) {
    await sql.unsafe(
      (await readFile(resolve(migrationsDirectory, file), "utf8")).replaceAll(
        '"public".',
        `${quoteIdentifier(schemaName)}.`,
      ),
    );
  }
}

/** Inserts parent organization and installation rows used by repository tests. */
async function seedRepositoryParents(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES
      ('org_repository_test', 'Repository Test Org', 'repository-test-org'),
      ('org_repository_other', 'Other Repository Test Org', 'repository-test-other-org')
  `;
  await sql`
    INSERT INTO provider_installations (
      installation_id,
      org_id,
      provider,
      provider_installation_id,
      account_login,
      account_type,
      installed_at
    )
    VALUES
      (
        'inst_repository_test',
        'org_repository_test',
        'github',
        'repository-test-installation',
        'acme',
        'organization',
        now()
      ),
      (
        'inst_repository_other',
        'org_repository_other',
        'github',
        'repository-other-installation',
        'other',
        'organization',
        now()
      )
  `;
}

/** Builds a repository contract fixture for repository query tests. */
function repositoryFixture(input: {
  /** Whether the repository is enabled. */
  readonly enabled?: boolean;
  /** Repository full name. */
  readonly fullName: string;
  /** Installation ID that owns the repository. */
  readonly installationId?: string;
  /** Repository short name. */
  readonly name: string;
  /** Organization ID that owns the repository. */
  readonly orgId?: string;
  /** Provider-native repository ID. */
  readonly providerRepoId: string;
  /** Durable repository ID. */
  readonly repoId: string;
}): Repository {
  return {
    cloneUrl: `https://github.com/${input.fullName}.git`,
    createdAt: "2026-05-08T00:00:00.000Z",
    defaultBranch: "main",
    enabled: input.enabled ?? true,
    fullName: input.fullName,
    installationId: input.installationId ?? "inst_repository_test",
    isArchived: false,
    isFork: false,
    name: input.name,
    orgId: input.orgId ?? "org_repository_test",
    owner: input.fullName.split("/")[0] ?? "acme",
    provider: "github",
    providerRepoId: input.providerRepoId,
    repoId: input.repoId,
    updatedAt: "2026-05-08T00:00:00.000Z",
    visibility: "private",
  };
}

/** Builds a repository settings contract fixture for repository query tests. */
function repositorySettingsFixture(
  overrides: Partial<RepositorySettings> = {},
): RepositorySettings {
  return {
    repoId: "repo_repository_alpha",
    reviewPolicy: "inline_comments_and_summary",
    severityThreshold: "medium",
    maxCommentsPerReview: 5,
    ignoredPaths: ["node_modules/**", "dist/**"],
    ignoredAuthors: [],
    ignoredLabels: [],
    skipGeneratedFiles: true,
    skipDraftPullRequests: true,
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

/** Builds an organization settings contract fixture for repository query tests. */
function orgSettingsFixture(overrides: Partial<OrgSettings> = {}): OrgSettings {
  return {
    schemaVersion: "org_settings.v1",
    orgId: "org_repository_test",
    defaultReviewPolicy: DEFAULT_ORG_SETTINGS.defaultReviewPolicy,
    defaultTriggerPolicy: {
      ...DEFAULT_ORG_SETTINGS.defaultTriggerPolicy,
      enabledActions: [...DEFAULT_ORG_SETTINGS.defaultTriggerPolicy.enabledActions],
      ignoredAuthors: [...DEFAULT_ORG_SETTINGS.defaultTriggerPolicy.ignoredAuthors],
      ignoredLabels: [...DEFAULT_ORG_SETTINGS.defaultTriggerPolicy.ignoredLabels],
    },
    defaultFindingPolicy: {
      ...DEFAULT_ORG_SETTINGS.defaultFindingPolicy,
      enabledCategories: [...DEFAULT_ORG_SETTINGS.defaultFindingPolicy.enabledCategories],
    },
    defaultPublishingPolicy: { ...DEFAULT_ORG_SETTINGS.defaultPublishingPolicy },
    defaultMemoryPolicy: {
      ...DEFAULT_ORG_SETTINGS.defaultMemoryPolicy,
      trustedFeedbackRoles: [...DEFAULT_ORG_SETTINGS.defaultMemoryPolicy.trustedFeedbackRoles],
    },
    allowRepoLocalConfig: DEFAULT_ORG_SETTINGS.allowRepoLocalConfig,
    allowMemorySuppression: DEFAULT_ORG_SETTINGS.allowMemorySuppression,
    allowUserDefinedRules: DEFAULT_ORG_SETTINGS.allowUserDefinedRules,
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    updatedByUserId: null,
    version: 1,
    ...overrides,
  };
}

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
