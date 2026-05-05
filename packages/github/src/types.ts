import type { ChangedFile, PullRequestSnapshot, Repository } from "@repo/contracts";

/** GitHub App provider configuration. */
export type GitHubProviderConfig = {
  /** Numeric GitHub App ID. */
  readonly appId: string;
  /** PEM encoded GitHub App private key. */
  readonly privateKey: string;
  /** GitHub REST API base URL. */
  readonly apiBaseUrl?: string;
  /** GitHub web base URL. */
  readonly webBaseUrl?: string;
  /** REST API version header. */
  readonly apiVersion?: string;
  /** User-Agent header value. */
  readonly userAgent?: string;
  /** Seconds before expiry when a cached token should be refreshed. */
  readonly tokenExpiryBufferSeconds?: number;
  /** Maximum number of PR files to fetch. */
  readonly maxPrFiles?: number;
  /** Maximum raw diff bytes to fetch. */
  readonly maxDiffBytes?: number;
  /** Enables check-run writes. */
  readonly enableCheckRuns?: boolean;
  /** Enables issue comment summary writes. */
  readonly enableIssueSummaryComments?: boolean;
  /** Enables inline review comment writes. */
  readonly enableReviewComments?: boolean;
};

/** Minimal fetch function used by tests and runtimes. */
export type GitHubFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** GitHub installation reference. */
export type GitHubInstallationRef = {
  /** Provider discriminator. */
  readonly provider: "github";
  /** Heimdall installation ID or GitHub numeric installation ID. */
  readonly installationId: string;
  /** GitHub numeric installation ID, when different from `installationId`. */
  readonly providerInstallationId?: string;
};

/** GitHub repository reference. */
export type GitHubRepositoryRef = GitHubInstallationRef & {
  /** Repository owner login. */
  readonly owner: string;
  /** Repository name. */
  readonly repo: string;
  /** GitHub repository ID, when known. */
  readonly providerRepoId?: string;
};

/** GitHub pull request reference. */
export type GitHubPullRequestRef = GitHubRepositoryRef & {
  /** Pull request number. */
  readonly pullRequestNumber: number;
};

/** Installation sync input. */
export type SyncInstallationInput = GitHubInstallationRef & {
  /** Existing Heimdall organization ID, when known from webhook ingestion. */
  readonly orgId?: string;
};

/** Installation sync result. */
export type SyncInstallationResult = {
  /** Normalized repositories visible to the installation. */
  readonly repositories: readonly Repository[];
};

/** Existing bot comment found on a PR. */
export type ExistingBotComment = {
  /** GitHub comment ID. */
  readonly providerCommentId: string;
  /** Comment body. */
  readonly body: string;
  /** Comment author login. */
  readonly authorLogin: string;
  /** Comment URL. */
  readonly htmlUrl?: string;
};

/** Clone authentication output for repo-sync. */
export type CloneAuth = {
  /** Sanitized clone URL without credentials. */
  readonly cloneUrl: string;
  /** Username to use for HTTPS clone authentication. */
  readonly username: string;
  /** Installation token. */
  readonly password: string;
  /** Token expiry. */
  readonly expiresAt: string;
};

/** Inline review comment input. */
export type PublishInlineCommentInput = {
  /** Repository path. */
  readonly path: string;
  /** 1-based line in the diff side. */
  readonly line: number;
  /** Diff side. */
  readonly side: "LEFT" | "RIGHT";
  /** Markdown body. */
  readonly body: string;
  /** Optional stable finding ID. */
  readonly findingId?: string;
};

/** Review publishing input. */
export type PublishReviewInput = GitHubPullRequestRef & {
  /** Commit SHA to attach review comments to. */
  readonly headSha: string;
  /** Optional review summary body. */
  readonly body?: string;
  /** Inline comments to publish. */
  readonly comments: readonly PublishInlineCommentInput[];
  /** Stable review run ID used for dedupe markers. */
  readonly reviewRunId: string;
};

/** Published review output. */
export type PublishedReview = {
  /** GitHub pull request review ID. */
  readonly providerReviewId: string;
  /** Published inline comment IDs, if GitHub returned them. */
  readonly commentIds: readonly string[];
};

/** Check run status. */
export type ProviderCheckRunStatus = "queued" | "in_progress" | "completed";

/** Check run conclusion. */
export type ProviderCheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required";

/** Check run annotation. */
export type CheckRunAnnotation = {
  /** Annotation file path. */
  readonly path: string;
  /** Start line. */
  readonly startLine: number;
  /** End line. */
  readonly endLine: number;
  /** Annotation level. */
  readonly annotationLevel: "notice" | "warning" | "failure";
  /** Annotation message. */
  readonly message: string;
  /** Optional title. */
  readonly title?: string;
};

/** Check run input. */
export type CreateOrUpdateCheckRunInput = GitHubRepositoryRef & {
  /** Stable Heimdall review run ID. */
  readonly reviewRunId: string;
  /** Check run name. */
  readonly name: string;
  /** Head SHA for the check run. */
  readonly headSha: string;
  /** Check run status. */
  readonly status: ProviderCheckRunStatus;
  /** Check run conclusion. */
  readonly conclusion?: ProviderCheckRunConclusion;
  /** Summary title. */
  readonly title: string;
  /** Summary markdown. */
  readonly summary: string;
  /** Optional text details. */
  readonly text?: string;
  /** Annotations to attach to the check run. */
  readonly annotations?: readonly CheckRunAnnotation[];
};

/** Provider check run output. */
export type ProviderCheckRun = {
  /** GitHub check run ID. */
  readonly providerCheckRunId: string;
  /** Check run URL. */
  readonly htmlUrl?: string;
};

/** Summary comment input. */
export type PublishSummaryCommentInput = GitHubPullRequestRef & {
  /** Stable review run ID. */
  readonly reviewRunId: string;
  /** Markdown body. */
  readonly body: string;
};

/** Published summary comment output. */
export type PublishedSummaryComment = {
  /** GitHub issue comment ID. */
  readonly providerCommentId: string;
  /** Comment URL. */
  readonly htmlUrl?: string;
};

/** Provider-neutral GitHub adapter consumed by workers and publishers. */
export interface GitProvider {
  /** Provider discriminator. */
  readonly provider: "github";
  /** Generates or returns a cached installation token. */
  getInstallationToken(
    input: GitHubInstallationRef,
  ): Promise<{ readonly token: string; readonly expiresAt: string }>;
  /** Lists repositories visible to an installation. */
  listInstallationRepositories(
    input: GitHubInstallationRef & { readonly orgId?: string },
  ): Promise<readonly Repository[]>;
  /** Syncs an installation by discovering its repositories. */
  syncInstallation(input: SyncInstallationInput): Promise<SyncInstallationResult>;
  /** Fetches one repository. */
  fetchRepository(input: GitHubRepositoryRef & { readonly orgId?: string }): Promise<Repository>;
  /** Fetches a snapshot with changed files and diff metadata. */
  fetchPullRequestSnapshot(input: GitHubPullRequestRef): Promise<PullRequestSnapshot>;
  /** Fetches changed files for a pull request. */
  fetchChangedFiles(input: GitHubPullRequestRef): Promise<readonly ChangedFile[]>;
  /** Fetches branch and commit metadata. */
  fetchBranchCommit(input: GitHubRepositoryRef & { readonly ref: string }): Promise<{
    readonly ref: string;
    readonly sha: string;
    readonly metadata: Record<string, unknown>;
  }>;
  /** Fetches existing bot issue comments for dedupe. */
  fetchExistingBotComments(input: GitHubPullRequestRef): Promise<readonly ExistingBotComment[]>;
  /** Publishes a PR review with inline comments. */
  publishReview(input: PublishReviewInput): Promise<PublishedReview>;
  /** Publishes or creates a check run. */
  createOrUpdateCheckRun(input: CreateOrUpdateCheckRunInput): Promise<ProviderCheckRun>;
  /** Publishes a summary issue comment. */
  publishSummaryComment(input: PublishSummaryCommentInput): Promise<PublishedSummaryComment>;
  /** Returns clone credentials for repo-sync. */
  getCloneAuth(input: GitHubRepositoryRef): Promise<CloneAuth>;
}
