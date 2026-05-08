import { createHash } from "node:crypto";
import type { ChangedFile, PullRequestSnapshot, Repository } from "@repo/contracts";
import { hashRawDiff } from "@repo/pr-snapshot";
import {
  buildGitHubReviewCommentMarker,
  buildGitHubSummaryCommentMarker,
  hasGitHubCommentMarker,
} from "./markers";
import type {
  CloneAuth,
  CreateOrUpdateCheckRunInput,
  ExistingBotComment,
  ExistingReviewThreadState,
  FetchFileContentInput,
  GitHubInstallationRef,
  GitHubPullRequestRef,
  GitHubRepositoryRef,
  GitProvider,
  GitProviderFileContent,
  ProviderCheckRun,
  PublishedReview,
  PublishedSummaryComment,
  PublishReviewInput,
  PublishSummaryCommentInput,
  PullRequestSnapshotWithRawDiff,
  SyncInstallationInput,
  SyncInstallationResult,
} from "./types";

/** Seeded fake repository file content. */
export type FakeGitProviderFileContent = {
  /** Repository owner login. */
  readonly owner: string;
  /** Repository name. */
  readonly repo: string;
  /** Provider ref or commit SHA. */
  readonly ref: string;
  /** Repository-relative file path. */
  readonly path: string;
  /** UTF-8 file content. */
  readonly content: string;
  /** Optional provider blob SHA. */
  readonly sha?: string;
};

/** Options used to seed a deterministic in-memory Git provider. */
export type FakeGitProviderOptions = {
  /** Repositories visible to installation sync calls. */
  readonly repositories?: readonly Repository[];
  /** Pull request snapshots keyed by owner/repo/number. */
  readonly pullRequestSnapshots?: readonly PullRequestSnapshot[];
  /** Repository file contents keyed by owner/repo/ref/path. */
  readonly fileContents?: readonly FakeGitProviderFileContent[];
  /** Existing bot issue comments keyed by owner/repo/number. */
  readonly existingBotComments?: readonly ExistingBotComment[];
  /** Existing bot inline review comments keyed by owner/repo/number. */
  readonly existingReviewComments?: readonly ExistingBotComment[];
  /** Existing review thread states keyed by owner/repo/number. */
  readonly reviewThreadStates?: readonly ExistingReviewThreadState[];
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
  private readonly fileContents: Map<string, FakeGitProviderFileContent>;
  private readonly botComments: ExistingBotComment[];
  private readonly reviewComments: ExistingBotComment[];
  private readonly reviewThreadStates: readonly ExistingReviewThreadState[];
  private readonly failReviewPublishing: boolean;

  /** Creates a seeded fake provider. */
  public constructor(options: FakeGitProviderOptions = {}) {
    this.repositories = options.repositories ?? [];
    this.pullRequestSnapshots = new Map();
    for (const snapshot of options.pullRequestSnapshots ?? []) {
      this.pullRequestSnapshots.set(snapshotKey(snapshot), snapshot);
    }
    this.fileContents = new Map();
    for (const fileContent of options.fileContents ?? []) {
      this.fileContents.set(fileContentKey(fileContent), fileContent);
    }
    this.botComments = [...(options.existingBotComments ?? [])];
    this.reviewComments = [...(options.existingReviewComments ?? [])];
    this.reviewThreadStates = options.reviewThreadStates ?? [];
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

  /** Fetches seeded repository file content for a specific ref. */
  public async fetchFileContent(
    input: FetchFileContentInput,
  ): Promise<GitProviderFileContent | undefined> {
    const fileContent = this.fileContents.get(fileContentKey(input));
    if (!fileContent) {
      return undefined;
    }

    const sizeBytes = Buffer.byteLength(fileContent.content, "utf8");
    if (input.maxBytes !== undefined && sizeBytes > input.maxBytes) {
      throw new Error(`Fake file ${input.path} exceeds configured maxBytes.`);
    }

    return {
      content: fileContent.content,
      path: fileContent.path,
      ref: fileContent.ref,
      ...(fileContent.sha ? { sha: fileContent.sha } : {}),
      sizeBytes,
    };
  }

  /** Fetches seeded bot comments. */
  public async fetchExistingBotComments(): Promise<readonly ExistingBotComment[]> {
    return this.botComments;
  }

  /** Fetches seeded inline review comments. */
  public async fetchExistingReviewComments(): Promise<readonly ExistingBotComment[]> {
    return this.reviewComments;
  }

  /** Fetches seeded review thread states. */
  public async fetchReviewThreadStates(): Promise<readonly ExistingReviewThreadState[]> {
    return this.reviewThreadStates;
  }

  /** Publishes a fake review and records the input. */
  public async publishReview(input: PublishReviewInput): Promise<PublishedReview> {
    if (this.failReviewPublishing) {
      throw new Error("Fake review publishing failed.");
    }

    this.publishedReviews.push(input);
    const commentIds = input.comments.map((comment) =>
      stableId("comment", [input.reviewRunId, comment.findingId ?? comment.body]),
    );
    const commentIdsByFindingId = Object.fromEntries(
      input.comments.flatMap((comment, index) =>
        comment.findingId
          ? [
              [
                comment.findingId,
                commentIds[index] ?? stableId("comment", [input.reviewRunId, comment.body]),
              ],
            ]
          : [],
      ),
    );
    this.reviewComments.push(
      ...input.comments.map((comment, index) => {
        const marker = buildGitHubReviewCommentMarker({
          body: comment.body,
          ...(comment.findingId ? { findingId: comment.findingId } : {}),
          reviewRunId: input.reviewRunId,
        });
        return {
          providerCommentId: commentIds[index] ?? stableId("comment", [input.reviewRunId, index]),
          body: `${comment.body}\n\n${marker}`,
          authorLogin: "heimdall[bot]",
        };
      }),
    );

    return {
      providerReviewId: stableId("review", [input.owner, input.repo, input.reviewRunId]),
      commentIds,
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
    const stableMarker = buildGitHubSummaryCommentMarker(input);
    const legacyMarker = buildGitHubReviewCommentMarker({
      body: input.body,
      reviewRunId: input.reviewRunId,
    });
    const body = withSummaryDedupeMarkers(input);
    const existingCommentIndex = this.botComments.findIndex(
      (comment) =>
        hasGitHubCommentMarker(comment.body, stableMarker) ||
        hasGitHubCommentMarker(comment.body, legacyMarker),
    );
    const existingComment =
      existingCommentIndex >= 0 ? this.botComments[existingCommentIndex] : undefined;
    if (existingComment) {
      if (
        existingComment.body !== body &&
        !hasGitHubCommentMarker(existingComment.body, legacyMarker)
      ) {
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

const fileContentKey = (input: {
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly path: string;
}): string => `${input.owner}/${input.repo}:${input.ref}:${input.path}`;

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

const withSummaryDedupeMarkers = (input: PublishSummaryCommentInput): string =>
  [
    input.body,
    "",
    buildGitHubSummaryCommentMarker(input),
    buildGitHubReviewCommentMarker({ body: input.body, reviewRunId: input.reviewRunId }),
  ].join("\n");
