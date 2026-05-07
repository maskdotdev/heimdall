import { createHash } from "node:crypto";
import type { ChangedFile, PullRequestSnapshot, Repository } from "@repo/contracts";
import { hashRawDiff } from "@repo/pr-snapshot";
import type {
  CloneAuth,
  CreateOrUpdateCheckRunInput,
  ExistingBotComment,
  GitHubInstallationRef,
  GitHubPullRequestRef,
  GitHubRepositoryRef,
  GitProvider,
  ProviderCheckRun,
  PublishedReview,
  PublishedSummaryComment,
  PublishReviewInput,
  PublishSummaryCommentInput,
  PullRequestSnapshotWithRawDiff,
  SyncInstallationInput,
  SyncInstallationResult,
} from "./types";

/** Options used to seed a deterministic in-memory Git provider. */
export type FakeGitProviderOptions = {
  /** Repositories visible to installation sync calls. */
  readonly repositories?: readonly Repository[];
  /** Pull request snapshots keyed by owner/repo/number. */
  readonly pullRequestSnapshots?: readonly PullRequestSnapshot[];
  /** Existing bot issue comments keyed by owner/repo/number. */
  readonly existingBotComments?: readonly ExistingBotComment[];
  /** Whether inline review publishing should fail. */
  readonly failReviewPublishing?: boolean;
};

/** In-memory Git provider for publisher and worker tests. */
export class FakeGitProvider implements GitProvider {
  /** Provider discriminator. */
  public readonly provider = "github" as const;

  /** Published review inputs in call order. */
  public readonly publishedReviews: PublishReviewInput[] = [];

  /** Published summary comment inputs in call order. */
  public readonly publishedSummaryComments: PublishSummaryCommentInput[] = [];

  /** Check-run inputs in call order. */
  public readonly checkRuns: CreateOrUpdateCheckRunInput[] = [];

  private readonly repositories: readonly Repository[];
  private readonly pullRequestSnapshots: Map<string, PullRequestSnapshot>;
  private readonly botComments: ExistingBotComment[];
  private readonly failReviewPublishing: boolean;

  /** Creates a seeded fake provider. */
  public constructor(options: FakeGitProviderOptions = {}) {
    this.repositories = options.repositories ?? [];
    this.pullRequestSnapshots = new Map();
    for (const snapshot of options.pullRequestSnapshots ?? []) {
      this.pullRequestSnapshots.set(snapshotKey(snapshot), snapshot);
    }
    this.botComments = [...(options.existingBotComments ?? [])];
    this.failReviewPublishing = options.failReviewPublishing ?? false;
  }

  /** Generates a deterministic fake installation token. */
  public async getInstallationToken(
    input: GitHubInstallationRef,
  ): Promise<{ readonly token: string; readonly expiresAt: string }> {
    return {
      token: `fake-token-${input.installationId}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  }

  /** Lists seeded repositories. */
  public async listInstallationRepositories(): Promise<readonly Repository[]> {
    return this.repositories;
  }

  /** Syncs seeded repositories. */
  public async syncInstallation(_input: SyncInstallationInput): Promise<SyncInstallationResult> {
    return { repositories: this.repositories };
  }

  /** Fetches a seeded repository. */
  public async fetchRepository(input: GitHubRepositoryRef): Promise<Repository> {
    const repository = this.repositories.find(
      (candidate) => candidate.owner === input.owner && candidate.name === input.repo,
    );
    if (!repository) {
      throw new Error(`Fake repository ${input.owner}/${input.repo} was not found.`);
    }

    return repository;
  }

  /** Fetches a seeded pull request snapshot. */
  public async fetchPullRequestSnapshot(input: GitHubPullRequestRef): Promise<PullRequestSnapshot> {
    const snapshot = this.pullRequestSnapshots.get(pullRequestKey(input));
    if (!snapshot) {
      throw new Error(
        `Fake pull request ${input.owner}/${input.repo}#${input.pullRequestNumber} was not found.`,
      );
    }

    return snapshot;
  }

  /** Fetches a seeded pull request snapshot with a synthetic raw diff for artifact tests. */
  public async fetchPullRequestSnapshotWithRawDiff(
    input: GitHubPullRequestRef,
  ): Promise<PullRequestSnapshotWithRawDiff> {
    const snapshot = await this.fetchPullRequestSnapshot(input);
    const rawDiff = syntheticRawDiff(snapshot.changedFiles);
    const rawDiffHash = hashRawDiff(rawDiff);

    return {
      rawDiff,
      rawDiffBytes: Buffer.byteLength(rawDiff, "utf8"),
      rawDiffHash,
      snapshot: { ...snapshot, diffHash: rawDiffHash },
    };
  }

  /** Fetches changed files from a seeded pull request snapshot. */
  public async fetchChangedFiles(input: GitHubPullRequestRef): Promise<readonly ChangedFile[]> {
    return (await this.fetchPullRequestSnapshot(input)).changedFiles;
  }

  /** Fetches branch commit metadata from a seeded repository snapshot. */
  public async fetchBranchCommit(input: GitHubRepositoryRef & { readonly ref: string }): Promise<{
    readonly ref: string;
    readonly sha: string;
    readonly metadata: Record<string, unknown>;
  }> {
    const snapshot = [...this.pullRequestSnapshots.values()].find(
      (candidate) =>
        candidate.providerRepoId === input.providerRepoId ||
        (candidate.provider === "github" && input.owner.length > 0 && input.repo.length > 0),
    );

    return {
      ref: input.ref,
      sha: snapshot?.headRef === input.ref ? (snapshot.headSha ?? "") : (snapshot?.baseSha ?? ""),
      metadata: {},
    };
  }

  /** Fetches seeded bot comments. */
  public async fetchExistingBotComments(): Promise<readonly ExistingBotComment[]> {
    return this.botComments;
  }

  /** Publishes a fake review and records the input. */
  public async publishReview(input: PublishReviewInput): Promise<PublishedReview> {
    if (this.failReviewPublishing) {
      throw new Error("Fake review publishing failed.");
    }

    this.publishedReviews.push(input);
    const commentIdsByFindingId = Object.fromEntries(
      input.comments
        .filter((comment) => comment.findingId)
        .map((comment) => [
          comment.findingId ?? "",
          stableId("comment", [input.reviewRunId, comment.findingId ?? comment.body]),
        ]),
    );

    return {
      providerReviewId: stableId("review", [input.owner, input.repo, input.reviewRunId]),
      commentIds: input.comments.map((comment) =>
        stableId("comment", [input.reviewRunId, comment.findingId ?? comment.body]),
      ),
      commentIdsByFindingId,
    };
  }

  /** Creates or updates a fake check run and records the input. */
  public async createOrUpdateCheckRun(
    input: CreateOrUpdateCheckRunInput,
  ): Promise<ProviderCheckRun> {
    this.checkRuns.push(input);
    return {
      providerCheckRunId: stableId("check", [input.owner, input.repo, input.reviewRunId]),
      htmlUrl: `https://github.example/${input.owner}/${input.repo}/checks/${input.reviewRunId}`,
    };
  }

  /** Publishes a fake summary comment with marker-based dedupe. */
  public async publishSummaryComment(
    input: PublishSummaryCommentInput,
  ): Promise<PublishedSummaryComment> {
    const stableMarker = createSummaryDedupeMarker(input);
    const legacyMarker = createDedupeMarker(input.body, input.reviewRunId);
    const body = withSummaryDedupeMarkers(input);
    const existingCommentIndex = this.botComments.findIndex(
      (comment) => comment.body.includes(stableMarker) || comment.body.includes(legacyMarker),
    );
    const existingComment =
      existingCommentIndex >= 0 ? this.botComments[existingCommentIndex] : undefined;
    if (existingComment) {
      if (existingComment.body !== body && !existingComment.body.includes(legacyMarker)) {
        this.publishedSummaryComments.push(input);
        this.botComments[existingCommentIndex] = {
          ...existingComment,
          body,
        };
      }

      return {
        providerCommentId: existingComment.providerCommentId,
        ...(existingComment.htmlUrl ? { htmlUrl: existingComment.htmlUrl } : {}),
      };
    }

    this.publishedSummaryComments.push(input);
    const providerCommentId = stableId("summary", [input.owner, input.repo, input.reviewRunId]);
    this.botComments.push({
      providerCommentId,
      body,
      authorLogin: "heimdall[bot]",
    });

    return { providerCommentId };
  }

  /** Returns deterministic fake clone credentials. */
  public async getCloneAuth(input: GitHubRepositoryRef): Promise<CloneAuth> {
    return {
      cloneUrl: `https://github.example/${input.owner}/${input.repo}.git`,
      username: "x-access-token",
      password: `fake-token-${input.installationId}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  }
}

/** Creates a deterministic in-memory Git provider. */
export const createFakeGitProvider = (options: FakeGitProviderOptions = {}): FakeGitProvider =>
  new FakeGitProvider(options);

const pullRequestKey = (input: GitHubPullRequestRef): string =>
  `${input.providerRepoId ?? `${input.owner}/${input.repo}`}#${input.pullRequestNumber}`;

const snapshotKey = (snapshot: PullRequestSnapshot): string =>
  `${snapshot.providerRepoId}#${snapshot.pullRequestNumber}`;

const syntheticRawDiff = (files: readonly ChangedFile[]): string =>
  files.map(syntheticRawDiffFile).join("\n");

const syntheticRawDiffFile = (file: ChangedFile): string => {
  const oldPath = file.oldPath ?? file.path;
  const header = [
    `diff --git ${quoteDiffPath("a", oldPath)} ${quoteDiffPath("b", file.path)}`,
    `--- ${file.status === "added" ? "/dev/null" : quoteDiffPath("a", oldPath)}`,
    `+++ ${file.status === "deleted" ? "/dev/null" : quoteDiffPath("b", file.path)}`,
  ];

  return [...header, file.patch ?? ""].join("\n");
};

const quoteDiffPath = (prefix: "a" | "b", path: string): string =>
  `"${prefix}/${path.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;

const stableId = (prefix: string, parts: readonly unknown[]): string =>
  `${prefix}_${createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("hex")
    .slice(0, 24)}`;

const createDedupeMarker = (body: string, reviewRunId: string): string => {
  const fingerprint = `sha256:${createHash("sha256")
    .update(`${reviewRunId}:summary:${body}`)
    .digest("hex")}`;
  return `<!-- heimdall:${reviewRunId}:summary:${fingerprint} -->`;
};

const createSummaryDedupeMarker = (input: GitHubPullRequestRef): string => {
  const fingerprint = `sha256:${createHash("sha256")
    .update(
      `summary:${input.providerRepoId ?? `${input.owner}/${input.repo}`}:${input.pullRequestNumber}`,
    )
    .digest("hex")}`;
  return `<!-- heimdall:summary:${input.pullRequestNumber}:${fingerprint} -->`;
};

const withSummaryDedupeMarkers = (input: PublishSummaryCommentInput): string =>
  [
    input.body,
    "",
    createSummaryDedupeMarker(input),
    createDedupeMarker(input.body, input.reviewRunId),
  ].join("\n");
