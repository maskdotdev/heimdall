import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import * as schema from "@repo/db";
import type { GitHubFetch } from "@repo/github";
import { createGitHubProvider } from "@repo/github";
import { publishReviewRun } from "@repo/publisher";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

type SmokeConfig = {
  readonly databaseUrl: string;
  readonly githubAppId: string;
  readonly githubPrivateKey: string;
  readonly installationId: string;
  readonly providerInstallationId: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
  readonly allowWrite: boolean;
};

/** Serializes a value for explicit jsonb casts in Bun-compatible postgres.js bindings. */
const toJsonb = (value: unknown): string => JSON.stringify(value);

/** Converts external IDs to compact database-safe smoke fixture IDs. */
const smokeIdPart = (value: string): string => value.replaceAll(/[^A-Za-z0-9_]/gu, "_");

/** Logs GitHub request outcomes for live smoke diagnostics without exposing credentials. */
const loggingGitHubFetch: GitHubFetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = new URL(input);
  console.error(`[github-smoke] ${init?.method ?? "GET"} ${url.pathname} -> ${response.status}`);
  return response;
};

/** Returns the nearest workspace root so package scripts can load repo-local env files. */
const findWorkspaceRoot = (startDirectory: string): string => {
  let directory = startDirectory;
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    const parent = dirname(directory);
    if (parent === directory) {
      return startDirectory;
    }
    directory = parent;
  }
  return directory;
};

/** Removes matching single or double quotes from a dotenv value. */
const unquoteEnvValue = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

/** Parses a small dotenv-compatible file without overriding already exported variables. */
const loadEnvFile = (path: string): void => {
  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const [rawName, ...rawValueParts] = trimmed.replace(/^export\s+/u, "").split("=");
    const name = rawName?.trim();
    if (!name || rawValueParts.length === 0 || process.env[name] !== undefined) {
      continue;
    }

    process.env[name] = unquoteEnvValue(rawValueParts.join("=")).replaceAll("\\n", "\n");
  }
};

/** Loads optional local smoke credentials from the repository root. */
const loadSmokeEnv = (): void => {
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  loadEnvFile(join(workspaceRoot, ".env.smoke.local"));
};

/** Returns a non-empty environment variable value. */
const optionalEnv = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
};

/** Loads and validates the live GitHub publisher smoke configuration. */
const loadConfig = (): SmokeConfig => {
  loadSmokeEnv();
  const databaseUrl = optionalEnv("HEIMDALL_DB_TEST_URL") ?? optionalEnv("DATABASE_URL");
  const githubPrivateKey =
    optionalEnv("GITHUB_PRIVATE_KEY") ?? optionalEnv("GITHUB_APP_PRIVATE_KEY");
  const githubAppId = optionalEnv("GITHUB_APP_ID");
  const providerInstallationId = optionalEnv("HEIMDALL_GITHUB_SMOKE_PROVIDER_INSTALLATION_ID");
  const owner = optionalEnv("HEIMDALL_GITHUB_SMOKE_OWNER");
  const repo = optionalEnv("HEIMDALL_GITHUB_SMOKE_REPO");
  const pullRequestNumber = optionalEnv("HEIMDALL_GITHUB_SMOKE_PR");
  const missing = [
    databaseUrl ? undefined : "HEIMDALL_DB_TEST_URL or DATABASE_URL",
    githubAppId ? undefined : "GITHUB_APP_ID",
    githubPrivateKey ? undefined : "GITHUB_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY",
    providerInstallationId ? undefined : "HEIMDALL_GITHUB_SMOKE_PROVIDER_INSTALLATION_ID",
    owner ? undefined : "HEIMDALL_GITHUB_SMOKE_OWNER",
    repo ? undefined : "HEIMDALL_GITHUB_SMOKE_REPO",
    pullRequestNumber ? undefined : "HEIMDALL_GITHUB_SMOKE_PR",
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    throw new Error(`Missing live publisher smoke configuration: ${missing.join(", ")}.`);
  }

  return {
    databaseUrl: databaseUrl ?? "",
    githubAppId: githubAppId ?? "",
    githubPrivateKey: (githubPrivateKey ?? "").replaceAll("\\n", "\n"),
    installationId:
      optionalEnv("HEIMDALL_GITHUB_SMOKE_INSTALLATION_ID") ?? providerInstallationId ?? "",
    providerInstallationId: providerInstallationId ?? "",
    owner: owner ?? "",
    repo: repo ?? "",
    pullRequestNumber: Number(pullRequestNumber),
    allowWrite: process.env.HEIMDALL_GITHUB_SMOKE_ALLOW_WRITE === "true",
  };
};

async function main(): Promise<void> {
  const config = loadConfig();
  if (!Number.isInteger(config.pullRequestNumber) || config.pullRequestNumber <= 0) {
    throw new Error("HEIMDALL_GITHUB_SMOKE_PR must be a positive integer.");
  }
  if (!config.allowWrite) {
    throw new Error("Set HEIMDALL_GITHUB_SMOKE_ALLOW_WRITE=true to publish to the smoke PR.");
  }

  const sql = postgres(config.databaseUrl, { max: 1 });
  const db = drizzle(sql, { schema });
  const provider = createGitHubProvider(
    {
      appId: config.githubAppId,
      privateKey: config.githubPrivateKey,
    },
    { fetch: loggingGitHubFetch },
  );

  try {
    const repository = await provider.fetchRepository({
      provider: "github",
      installationId: config.installationId,
      providerInstallationId: config.providerInstallationId,
      owner: config.owner,
      repo: config.repo,
    });
    const pullRequest = await provider.fetchPullRequestSnapshot({
      provider: "github",
      installationId: config.installationId,
      providerInstallationId: config.providerInstallationId,
      owner: config.owner,
      repo: config.repo,
      providerRepoId: repository.providerRepoId,
      pullRequestNumber: config.pullRequestNumber,
    });
    const smokeId = randomUUID().replaceAll("-", "").slice(0, 16);
    const orgId = `org_smoke_${smokeIdPart(config.providerInstallationId)}`;
    const repoId = `repo_smoke_${smokeIdPart(repository.providerRepoId)}`;
    const snapshotId = `prs_smoke_${smokeIdPart(pullRequest.providerPullRequestId)}`;
    const reviewRunId = `rrn_smoke_${smokeId}`;
    const candidateFindingId = `fnd_smoke_candidate_${smokeId}`;
    const validatedFindingId = `fnd_smoke_validated_${smokeId}`;
    const now = new Date();

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO orgs (org_id, name, slug)
        VALUES (${orgId}, 'GitHub Publisher Smoke', ${`github-publisher-smoke-${smokeId}`})
        ON CONFLICT (org_id) DO UPDATE
        SET updated_at = now()
      `;
      await transaction`
        INSERT INTO provider_installations (
          installation_id,
          org_id,
          provider,
          provider_installation_id,
          account_login,
          account_type,
          installed_at
        )
        VALUES (
          ${config.installationId},
          ${orgId},
          'github',
          ${config.providerInstallationId},
          ${config.owner},
          'Organization',
          ${now.toISOString()}
        )
        ON CONFLICT (provider, provider_installation_id) DO UPDATE
        SET
          account_login = EXCLUDED.account_login,
          account_type = EXCLUDED.account_type,
          deleted_at = NULL
      `;
      await transaction`
        INSERT INTO repositories (
          repo_id,
          org_id,
          installation_id,
          provider,
          provider_repo_id,
          owner,
          name,
          full_name,
          default_branch,
          clone_url,
          visibility
        )
        VALUES (
          ${repoId},
          ${orgId},
          ${config.installationId},
          'github',
          ${repository.providerRepoId},
          ${repository.owner},
          ${repository.name},
          ${repository.fullName},
          ${repository.defaultBranch ?? "main"},
          ${repository.cloneUrl ?? null},
          ${repository.visibility}
        )
        ON CONFLICT (provider, provider_repo_id) DO UPDATE
        SET
          org_id = EXCLUDED.org_id,
          installation_id = EXCLUDED.installation_id,
          owner = EXCLUDED.owner,
          name = EXCLUDED.name,
          full_name = EXCLUDED.full_name,
          default_branch = EXCLUDED.default_branch,
          clone_url = EXCLUDED.clone_url,
          visibility = EXCLUDED.visibility,
          updated_at = now()
      `;
      await transaction`
        INSERT INTO pull_request_snapshots (
          snapshot_id,
          schema_version,
          provider,
          repo_id,
          installation_id,
          provider_repo_id,
          provider_pull_request_id,
          pull_request_number,
          title,
          body,
          author_login,
          author_association,
          state,
          is_draft,
          labels,
          base_ref,
          base_sha,
          head_ref,
          head_sha,
          changed_files,
          diff_hash,
          additions,
          deletions,
          changed_file_count,
          fetched_at,
          provider_metadata
        )
        VALUES (
          ${snapshotId},
          ${pullRequest.schemaVersion},
          ${pullRequest.provider},
          ${repoId},
          ${config.installationId},
          ${pullRequest.providerRepoId},
          ${pullRequest.providerPullRequestId},
          ${pullRequest.pullRequestNumber},
          ${pullRequest.title},
          ${pullRequest.body ?? null},
          ${pullRequest.authorLogin},
          ${pullRequest.authorAssociation ?? null},
          ${pullRequest.state},
          ${pullRequest.isDraft},
          ${toJsonb(pullRequest.labels)}::jsonb,
          ${pullRequest.baseRef},
          ${pullRequest.baseSha},
          ${pullRequest.headRef},
          ${pullRequest.headSha},
          ${toJsonb(pullRequest.changedFiles)}::jsonb,
          ${pullRequest.diffHash},
          ${pullRequest.additions},
          ${pullRequest.deletions},
          ${pullRequest.changedFileCount},
          ${pullRequest.fetchedAt},
          ${toJsonb({ smoke: true, sourceSnapshotId: pullRequest.snapshotId })}::jsonb
        )
        ON CONFLICT (repo_id, pull_request_number, head_sha) DO UPDATE
        SET
          title = EXCLUDED.title,
          body = EXCLUDED.body,
          author_login = EXCLUDED.author_login,
          author_association = EXCLUDED.author_association,
          state = EXCLUDED.state,
          is_draft = EXCLUDED.is_draft,
          labels = EXCLUDED.labels,
          base_ref = EXCLUDED.base_ref,
          base_sha = EXCLUDED.base_sha,
          head_ref = EXCLUDED.head_ref,
          changed_files = EXCLUDED.changed_files,
          diff_hash = EXCLUDED.diff_hash,
          additions = EXCLUDED.additions,
          deletions = EXCLUDED.deletions,
          changed_file_count = EXCLUDED.changed_file_count,
          fetched_at = EXCLUDED.fetched_at,
          provider_metadata = EXCLUDED.provider_metadata
      `;
      await transaction`
        INSERT INTO review_runs (
          review_run_id,
          schema_version,
          repo_id,
          pull_request_snapshot_id,
          pull_request_number,
          base_sha,
          head_sha,
          trigger,
          status,
          completed_at,
          counts,
          metadata
        )
        VALUES (
          ${reviewRunId},
          'review_run.v1',
          ${repoId},
          ${snapshotId},
          ${pullRequest.pullRequestNumber},
          ${pullRequest.baseSha},
          ${pullRequest.headSha},
          'manual',
          'completed',
          ${now.toISOString()},
          '{"candidateFindings":1,"validatedFindings":1,"publishedFindings":0,"rejectedFindings":0}'::jsonb,
          '{"smoke":true,"purpose":"live_github_publisher_smoke"}'::jsonb
        )
      `;
      await transaction`
        INSERT INTO candidate_findings (
          finding_id,
          schema_version,
          review_run_id,
          source,
          source_name,
          category,
          severity,
          title,
          body,
          location,
          evidence,
          confidence,
          fingerprint
        )
        VALUES (
          ${candidateFindingId},
          'candidate_finding.v1',
          ${reviewRunId},
          'static_analysis',
          'live-github-publisher-smoke',
          'maintainability',
          'low',
          'Live publisher smoke test',
          'This is a controlled Heimdall publisher smoke test against a development GitHub App installation.',
          ${toJsonb({
            path: pullRequest.changedFiles[0]?.path ?? "README.md",
            line: 1,
            side: "RIGHT",
            isInDiff: false,
          })}::jsonb,
          '[{"evidenceId":"ev_smoke","kind":"diff","summary":"Live smoke fixture","confidence":1}]'::jsonb,
          1,
          ${`fp_smoke_${smokeId}`}
        )
      `;
      await transaction`
        INSERT INTO validated_findings (
          finding_id,
          candidate_finding_id,
          review_run_id,
          decision,
          category,
          severity,
          title,
          body,
          location,
          evidence,
          confidence,
          validation,
          rank,
          fingerprint
        )
        VALUES (
          ${validatedFindingId},
          ${candidateFindingId},
          ${reviewRunId},
          'publish',
          'maintainability',
          'low',
          'Live publisher smoke test',
          'This is a controlled Heimdall publisher smoke test against a development GitHub App installation.',
          ${toJsonb({
            path: pullRequest.changedFiles[0]?.path ?? "README.md",
            line: 1,
            side: "RIGHT",
            isInDiff: false,
          })}::jsonb,
          '[{"evidenceId":"ev_smoke","kind":"diff","summary":"Live smoke fixture","confidence":1}]'::jsonb,
          1,
          ${toJsonb({
            validatedAt: now.toISOString(),
            validatorVersion: "live-smoke",
            reasons: [],
          })}::jsonb,
          1,
          ${`fp_smoke_${smokeId}`}
        )
      `;
    });

    const result = await publishReviewRun(
      {
        reviewRunId,
        repoId,
        pullRequestNumber: pullRequest.pullRequestNumber,
      },
      {
        db,
        gitProvider: provider,
      },
    );

    console.log(
      JSON.stringify(
        {
          status: "completed",
          owner: config.owner,
          repo: config.repo,
          pullRequestNumber: pullRequest.pullRequestNumber,
          reviewRunId,
          publishRunId: result.publishRunId,
          providerCheckRunId: result.providerCheckRunId,
          providerSummaryCommentId: result.providerSummaryCommentId,
          annotationCount: result.annotationCount,
          inlineCommentCount: result.inlineCommentCount,
          staleHead: result.staleHead,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : inspect(error));
  process.exitCode = 1;
});
