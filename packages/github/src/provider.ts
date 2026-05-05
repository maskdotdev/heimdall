import { createHash, createSign } from "node:crypto";
import type { ChangedFile, CodeLanguage, PullRequestSnapshot, Repository } from "@repo/contracts";
import {
  GitHubInstallationSuspendedError,
  GitHubNotFoundError,
  GitHubPermissionError,
  GitHubProviderError,
  GitHubRateLimitError,
  GitHubSecondaryRateLimitError,
  GitHubTokenError,
  GitHubUnavailableError,
  GitHubValidationError,
} from "./errors";
import type {
  CheckRunAnnotation,
  CloneAuth,
  CreateOrUpdateCheckRunInput,
  ExistingBotComment,
  GitHubFetch,
  GitHubInstallationRef,
  GitHubProviderConfig,
  GitHubPullRequestRef,
  GitHubRepositoryRef,
  GitProvider,
  ProviderCheckRun,
  PublishedReview,
  PublishedSummaryComment,
  PublishReviewInput,
  PublishSummaryCommentInput,
  SyncInstallationInput,
  SyncInstallationResult,
} from "./types";

type JsonRecord = Record<string, unknown>;

type CachedToken = {
  readonly token: string;
  readonly expiresAt: string;
};

type GitHubInstallationTokenResponse = {
  readonly token?: string;
  readonly expires_at?: string;
  readonly expiresAt?: string;
};

type GitHubProviderDependencies = {
  readonly fetch?: GitHubFetch;
  readonly now?: () => Date;
};

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_WEB_BASE_URL = "https://github.com";
const DEFAULT_API_VERSION = "2022-11-28";
const DEFAULT_USER_AGENT = "heimdall/0.1.0";
const DEFAULT_TOKEN_EXPIRY_BUFFER_SECONDS = 300;
const DEFAULT_MAX_PR_FILES = 3000;
const DEFAULT_MAX_DIFF_BYTES = 8_000_000;

const base64Url = (input: string | Buffer): string =>
  Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const sha256 = (value: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const stableId = (prefix: string, parts: readonly (number | string | undefined)[]): string =>
  `${prefix}_${createHash("sha256")
    .update(parts.filter((part): part is number | string => part !== undefined).join(":"))
    .digest("hex")
    .slice(0, 32)}`;

const asRecord = (value: unknown, name: string): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubValidationError(`GitHub response is missing ${name}.`, {});
  }

  return value as JsonRecord;
};

const optionalRecord = (value: unknown): JsonRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;

const asString = (record: JsonRecord, key: string): string => {
  const value = record[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }

  throw new GitHubValidationError(`GitHub response field ${key} must be a string.`, {});
};

const optionalString = (record: JsonRecord, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const withOptional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

const asNumber = (record: JsonRecord, key: string): number => {
  const value = record[key];
  if (typeof value === "number") {
    return value;
  }

  throw new GitHubValidationError(`GitHub response field ${key} must be a number.`, {});
};

const optionalBoolean = (record: JsonRecord, key: string, fallback = false): boolean => {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
};

const languageForPath = (path: string): CodeLanguage => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".js")) return "javascript";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "kotlin";
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".cpp") || lower.endsWith(".cc") || lower.endsWith(".cxx")) return "cpp";
  if (lower.endsWith(".c") || lower.endsWith(".h")) return "c";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".php")) return "php";
  if (lower.endsWith(".swift")) return "swift";
  return "unknown";
};

const isTestPath = (path: string): boolean =>
  /(^|\/)(__tests__|test|tests|spec)\//u.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/u.test(path);

const isGeneratedPath = (path: string): boolean =>
  path.endsWith(".lock") ||
  path.includes("/generated/") ||
  path.includes("/dist/") ||
  path.includes("/build/");

const normalizeInstallationId = (input: GitHubInstallationRef): string =>
  input.providerInstallationId ?? input.installationId.replace(/^inst_/u, "");

const normalizeContext = (
  input: GitHubInstallationRef & { readonly orgId?: string },
): {
  readonly installationId: string;
  readonly providerInstallationId: string;
  readonly orgId?: string;
} => ({
  installationId: input.installationId,
  providerInstallationId: normalizeInstallationId(input),
  ...withOptional("orgId", input.orgId),
});

const splitFullName = (fullName: string): { readonly owner: string; readonly repo: string } => {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    throw new GitHubValidationError(`Invalid GitHub repository full name: ${fullName}.`, {});
  }

  return { owner, repo };
};

/** Fetch-based GitHub App provider implementation. */
export class GitHubAppProvider implements GitProvider {
  /** Provider discriminator. */
  public readonly provider = "github" as const;

  private readonly config: Required<
    Pick<
      GitHubProviderConfig,
      | "apiBaseUrl"
      | "webBaseUrl"
      | "apiVersion"
      | "userAgent"
      | "tokenExpiryBufferSeconds"
      | "maxPrFiles"
      | "maxDiffBytes"
      | "enableCheckRuns"
      | "enableIssueSummaryComments"
      | "enableReviewComments"
    >
  > &
    Pick<GitHubProviderConfig, "appId" | "privateKey">;

  private readonly fetcher: GitHubFetch;
  private readonly now: () => Date;
  private readonly tokenCache = new Map<string, CachedToken>();

  /** Creates a GitHub App provider. */
  public constructor(config: GitHubProviderConfig, dependencies: GitHubProviderDependencies = {}) {
    this.config = {
      appId: config.appId,
      privateKey: config.privateKey,
      apiBaseUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      webBaseUrl: config.webBaseUrl ?? DEFAULT_WEB_BASE_URL,
      apiVersion: config.apiVersion ?? DEFAULT_API_VERSION,
      userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
      tokenExpiryBufferSeconds:
        config.tokenExpiryBufferSeconds ?? DEFAULT_TOKEN_EXPIRY_BUFFER_SECONDS,
      maxPrFiles: config.maxPrFiles ?? DEFAULT_MAX_PR_FILES,
      maxDiffBytes: config.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES,
      enableCheckRuns: config.enableCheckRuns ?? true,
      enableIssueSummaryComments: config.enableIssueSummaryComments ?? true,
      enableReviewComments: config.enableReviewComments ?? true,
    };
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
  }

  /** Generates or returns a cached installation token. */
  public async getInstallationToken(
    input: GitHubInstallationRef,
  ): Promise<{ readonly token: string; readonly expiresAt: string }> {
    const providerInstallationId = normalizeInstallationId(input);
    const cached = this.tokenCache.get(providerInstallationId);
    if (cached && this.isTokenUsable(cached)) {
      return cached;
    }

    const tokenResponse = await this.requestApp<GitHubInstallationTokenResponse>(
      `/app/installations/${providerInstallationId}/access_tokens`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    const tokenValue = tokenResponse.token;
    const expiresAt = tokenResponse.expires_at ?? tokenResponse.expiresAt;
    if (!tokenValue || !expiresAt) {
      throw new GitHubTokenError("GitHub installation token response was incomplete.", {});
    }

    const token = { token: tokenValue, expiresAt };
    this.tokenCache.set(providerInstallationId, token);
    return token;
  }

  /** Lists repositories visible to an installation. */
  public async listInstallationRepositories(
    input: GitHubInstallationRef & { readonly orgId?: string },
  ): Promise<readonly Repository[]> {
    const repositories = await this.paginateInstallation<JsonRecord>(
      input,
      "/installation/repositories",
      "repositories",
    );

    return repositories.map((repository) =>
      this.normalizeRepository(repository, normalizeContext(input)),
    );
  }

  /** Syncs an installation by discovering its repositories. */
  public async syncInstallation(input: SyncInstallationInput): Promise<SyncInstallationResult> {
    return {
      repositories: await this.listInstallationRepositories(input),
    };
  }

  /** Fetches one repository. */
  public async fetchRepository(
    input: GitHubRepositoryRef & { readonly orgId?: string },
  ): Promise<Repository> {
    const repository = await this.requestInstallation<JsonRecord>(
      input,
      `/repos/${input.owner}/${input.repo}`,
    );

    return this.normalizeRepository(repository, normalizeContext(input));
  }

  /** Fetches a snapshot with changed files and diff metadata. */
  public async fetchPullRequestSnapshot(input: GitHubPullRequestRef): Promise<PullRequestSnapshot> {
    const [pullRequest, changedFiles, rawDiff] = await Promise.all([
      this.requestInstallation<JsonRecord>(
        input,
        `/repos/${input.owner}/${input.repo}/pulls/${input.pullRequestNumber}`,
      ),
      this.fetchChangedFiles(input),
      this.fetchRawDiff(input),
    ]);
    const base = asRecord(pullRequest.base, "pull_request.base");
    const head = asRecord(pullRequest.head, "pull_request.head");
    const repository = asRecord(pullRequest.base, "pull_request.base").repo;
    const repositoryRecord = optionalRecord(repository);
    const providerRepoId =
      input.providerRepoId ?? (repositoryRecord ? asString(repositoryRecord, "id") : undefined);
    const fullName =
      repositoryRecord && optionalString(repositoryRecord, "full_name")
        ? asString(repositoryRecord, "full_name")
        : `${input.owner}/${input.repo}`;
    const baseSha = asString(base, "sha");
    const headSha = asString(head, "sha");
    const labels = Array.isArray(pullRequest.labels)
      ? pullRequest.labels
          .map((label) => optionalRecord(label)?.name)
          .filter((label): label is string => typeof label === "string")
      : [];
    const rawState = optionalString(pullRequest, "merged_at")
      ? "merged"
      : (optionalString(pullRequest, "state") ?? "unknown");
    const state =
      rawState === "open" || rawState === "closed" || rawState === "merged" ? rawState : "unknown";
    const providerPullRequestId = asString(pullRequest, "id");

    return {
      snapshotId: stableId("prs", ["github", providerRepoId, input.pullRequestNumber, headSha]),
      schemaVersion: "pull_request_snapshot.v1",
      provider: "github",
      repoId: stableId("repo", ["github", providerRepoId ?? fullName]),
      installationId: input.installationId,
      providerRepoId: providerRepoId ?? fullName,
      providerPullRequestId,
      pullRequestNumber: input.pullRequestNumber,
      title: asString(pullRequest, "title"),
      ...withOptional("body", optionalString(pullRequest, "body")),
      authorLogin: asString(asRecord(pullRequest.user, "pull_request.user"), "login"),
      ...withOptional("authorAssociation", optionalString(pullRequest, "author_association")),
      state,
      isDraft: optionalBoolean(pullRequest, "draft"),
      labels,
      baseRef: asString(base, "ref"),
      baseSha,
      headRef: asString(head, "ref"),
      headSha,
      ...withOptional("mergeBaseSha", optionalString(pullRequest, "merge_commit_sha")),
      changedFiles: changedFiles.slice(0, this.config.maxPrFiles),
      diffHash: sha256(rawDiff),
      additions: asNumber(pullRequest, "additions"),
      deletions: asNumber(pullRequest, "deletions"),
      changedFileCount: asNumber(pullRequest, "changed_files"),
      fetchedAt: this.now().toISOString(),
      ...withOptional("providerMetadata", pullRequest),
    };
  }

  /** Fetches changed files for a pull request. */
  public async fetchChangedFiles(input: GitHubPullRequestRef): Promise<readonly ChangedFile[]> {
    const files = await this.paginateInstallation<JsonRecord>(
      input,
      `/repos/${input.owner}/${input.repo}/pulls/${input.pullRequestNumber}/files`,
      undefined,
      this.config.maxPrFiles,
    );

    return files.map((file) => this.normalizeChangedFile(file));
  }

  /** Fetches branch and commit metadata. */
  public async fetchBranchCommit(
    input: GitHubRepositoryRef & { readonly ref: string },
  ): Promise<{ readonly ref: string; readonly sha: string; readonly metadata: JsonRecord }> {
    const branch = await this.requestInstallation<JsonRecord>(
      input,
      `/repos/${input.owner}/${input.repo}/branches/${encodeURIComponent(input.ref)}`,
    );
    const commit = asRecord(branch.commit, "branch.commit");

    return {
      ref: input.ref,
      sha: asString(commit, "sha"),
      metadata: branch,
    };
  }

  /** Fetches existing bot issue comments for dedupe. */
  public async fetchExistingBotComments(
    input: GitHubPullRequestRef,
  ): Promise<readonly ExistingBotComment[]> {
    const comments = await this.paginateInstallation<JsonRecord>(
      input,
      `/repos/${input.owner}/${input.repo}/issues/${input.pullRequestNumber}/comments`,
    );

    return comments.map((comment) => ({
      providerCommentId: asString(comment, "id"),
      body: asString(comment, "body"),
      authorLogin: asString(asRecord(comment.user, "comment.user"), "login"),
      ...withOptional("htmlUrl", optionalString(comment, "html_url")),
    }));
  }

  /** Publishes a PR review with inline comments. */
  public async publishReview(input: PublishReviewInput): Promise<PublishedReview> {
    if (!this.config.enableReviewComments) {
      throw new GitHubPermissionError("GitHub review comments are disabled by configuration.", {});
    }

    const existingComments = await this.fetchExistingReviewComments(input);
    const requestedComments = input.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: this.withDedupeMarker(comment.body, input.reviewRunId, comment.findingId),
      marker: this.createDedupeMarker(comment.body, input.reviewRunId, comment.findingId),
      ...(comment.findingId ? { findingId: comment.findingId } : {}),
    }));
    const comments = requestedComments.filter(
      (comment) =>
        !existingComments.some((existingComment) => existingComment.body.includes(comment.marker)),
    );

    if (comments.length === 0) {
      const commentIdsByFindingId = this.mapExistingCommentIdsByFindingId(
        requestedComments,
        existingComments,
      );
      const existingCommentIds = requestedComments
        .map(
          (comment) =>
            existingComments.find((existingComment) =>
              existingComment.body.includes(comment.marker),
            )?.providerCommentId,
        )
        .filter((commentId): commentId is string => Boolean(commentId));

      return {
        providerReviewId: stableId("review", [
          "github",
          input.owner,
          input.repo,
          input.pullRequestNumber,
          input.reviewRunId,
        ]),
        commentIds: existingCommentIds,
        commentIdsByFindingId,
      };
    }

    const review = await this.requestInstallation<JsonRecord>(
      input,
      `/repos/${input.owner}/${input.repo}/pulls/${input.pullRequestNumber}/reviews`,
      {
        method: "POST",
        body: JSON.stringify({
          commit_id: input.headSha,
          event: "COMMENT",
          body: input.body
            ? this.withDedupeMarker(input.body, input.reviewRunId)
            : `Heimdall review ${input.reviewRunId}`,
          comments: comments.map(
            ({ marker: _marker, findingId: _findingId, ...comment }) => comment,
          ),
        }),
      },
    );
    const providerReviewId = asString(review, "id");
    const returnedComments = Array.isArray(review.comments) ? review.comments : [];

    const returnedCommentIds = returnedComments
      .map((comment) => optionalRecord(comment)?.id)
      .filter((id): id is string | number => typeof id === "string" || typeof id === "number")
      .map(String);
    const commentIdsByFindingId = this.mapExistingCommentIdsByFindingId(
      requestedComments,
      existingComments,
    );
    for (const [index, comment] of comments.entries()) {
      const commentId = returnedCommentIds[index];
      if (comment.findingId && commentId) {
        commentIdsByFindingId[comment.findingId] = commentId;
      }
    }
    const existingCommentIds = requestedComments
      .map(
        (comment) =>
          existingComments.find((existingComment) => existingComment.body.includes(comment.marker))
            ?.providerCommentId,
      )
      .filter((commentId): commentId is string => Boolean(commentId));

    return {
      providerReviewId,
      commentIds: [...existingCommentIds, ...returnedCommentIds],
      commentIdsByFindingId,
    };
  }

  /** Publishes or creates a check run. */
  public async createOrUpdateCheckRun(
    input: CreateOrUpdateCheckRunInput,
  ): Promise<ProviderCheckRun> {
    if (!this.config.enableCheckRuns) {
      throw new GitHubPermissionError("GitHub check runs are disabled by configuration.", {});
    }

    const annotations = input.annotations ?? [];
    const firstBatch = annotations.slice(0, 50);
    const existingCheckRunId = await this.findExistingCheckRunId(input);
    const checkRun = existingCheckRunId
      ? await this.requestInstallation<JsonRecord>(
          input,
          `/repos/${input.owner}/${input.repo}/check-runs/${existingCheckRunId}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              name: input.name,
              status: input.status,
              conclusion: input.conclusion,
              output: {
                title: input.title,
                summary: input.summary,
                text: input.text,
                annotations: firstBatch.map(toGitHubAnnotation),
              },
            }),
          },
        )
      : await this.requestInstallation<JsonRecord>(
          input,
          `/repos/${input.owner}/${input.repo}/check-runs`,
          {
            method: "POST",
            body: JSON.stringify({
              name: input.name,
              head_sha: input.headSha,
              status: input.status,
              conclusion: input.conclusion,
              external_id: input.reviewRunId,
              output: {
                title: input.title,
                summary: input.summary,
                text: input.text,
                annotations: firstBatch.map(toGitHubAnnotation),
              },
            }),
          },
        );
    const providerCheckRunId = asString(checkRun, "id");

    for (let index = 50; index < annotations.length; index += 50) {
      await this.requestInstallation<JsonRecord>(
        input,
        `/repos/${input.owner}/${input.repo}/check-runs/${providerCheckRunId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            output: {
              title: input.title,
              summary: input.summary,
              annotations: annotations.slice(index, index + 50).map(toGitHubAnnotation),
            },
          }),
        },
      );
    }

    return {
      providerCheckRunId,
      ...withOptional("htmlUrl", optionalString(checkRun, "html_url")),
    };
  }

  /** Publishes a summary issue comment. */
  public async publishSummaryComment(
    input: PublishSummaryCommentInput,
  ): Promise<PublishedSummaryComment> {
    if (!this.config.enableIssueSummaryComments) {
      throw new GitHubPermissionError("GitHub summary comments are disabled by configuration.", {});
    }

    const marker = this.createDedupeMarker(input.body, input.reviewRunId);
    const [existingComment] = (await this.fetchExistingBotComments(input)).filter((comment) =>
      comment.body.includes(marker),
    );
    if (existingComment) {
      return {
        providerCommentId: existingComment.providerCommentId,
        ...withOptional("htmlUrl", existingComment.htmlUrl),
      };
    }

    const comment = await this.requestInstallation<JsonRecord>(
      input,
      `/repos/${input.owner}/${input.repo}/issues/${input.pullRequestNumber}/comments`,
      {
        method: "POST",
        body: JSON.stringify({
          body: this.withDedupeMarker(input.body, input.reviewRunId),
        }),
      },
    );

    return {
      providerCommentId: asString(comment, "id"),
      ...withOptional("htmlUrl", optionalString(comment, "html_url")),
    };
  }

  /** Returns clone credentials for repo-sync. */
  public async getCloneAuth(input: GitHubRepositoryRef): Promise<CloneAuth> {
    const installationToken = await this.getInstallationToken(input);

    return {
      cloneUrl: `${this.config.webBaseUrl}/${input.owner}/${input.repo}.git`,
      username: "x-access-token",
      password: installationToken.token,
      expiresAt: installationToken.expiresAt,
    };
  }

  private isTokenUsable(token: CachedToken): boolean {
    const refreshAt =
      new Date(token.expiresAt).getTime() - this.config.tokenExpiryBufferSeconds * 1000;
    return refreshAt > this.now().getTime();
  }

  private createAppJwt(): string {
    try {
      const issuedAt = Math.floor(this.now().getTime() / 1000) - 60;
      const payload = {
        iat: issuedAt,
        exp: issuedAt + 600,
        iss: this.config.appId,
      };
      const body = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
        JSON.stringify(payload),
      )}`;
      const signature = createSign("RSA-SHA256").update(body).sign(this.config.privateKey);
      return `${body}.${base64Url(signature)}`;
    } catch (error) {
      throw new GitHubTokenError("Failed to generate GitHub App JWT.", { cause: error });
    }
  }

  private async requestApp<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.request<T>(path, {
      ...init,
      headers: {
        ...this.baseHeaders(),
        authorization: `Bearer ${this.createAppJwt()}`,
        ...init.headers,
      },
    });
  }

  private async requestInstallation<T>(
    installation: GitHubInstallationRef,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const token = await this.getInstallationToken(installation);
    return this.request<T>(path, {
      ...init,
      headers: {
        ...this.baseHeaders(),
        authorization: `Bearer ${token.token}`,
        ...init.headers,
      },
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetcher(`${this.config.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        ...this.baseHeaders(),
        ...init.headers,
      },
    });

    if (!response.ok) {
      await raiseGitHubError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async paginateInstallation<T extends JsonRecord>(
    installation: GitHubInstallationRef,
    path: string,
    collectionKey?: string,
    maxItems = Number.POSITIVE_INFINITY,
  ): Promise<readonly T[]> {
    const output: T[] = [];
    let page = 1;
    while (output.length < maxItems) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.requestInstallation<unknown>(
        installation,
        `${path}${separator}per_page=100&page=${page}`,
      );
      const items = collectionKey
        ? asArray(asRecord(response, "paginated response")[collectionKey], collectionKey)
        : asArray(response, "paginated response");
      output.push(...items.map((item) => asRecord(item, "paginated item") as T));
      if (items.length < 100) {
        break;
      }
      page += 1;
    }

    return output.slice(0, maxItems);
  }

  private async fetchRawDiff(input: GitHubPullRequestRef): Promise<string> {
    const token = await this.getInstallationToken(input);
    const response = await this.fetcher(
      `${this.config.apiBaseUrl}/repos/${input.owner}/${input.repo}/pulls/${input.pullRequestNumber}`,
      {
        headers: {
          ...this.baseHeaders(),
          accept: "application/vnd.github.v3.diff",
          authorization: `Bearer ${token.token}`,
        },
      },
    );

    if (!response.ok) {
      await raiseGitHubError(response);
    }

    const diff = await response.text();
    if (Buffer.byteLength(diff, "utf8") > this.config.maxDiffBytes) {
      throw new GitHubValidationError(
        "GitHub pull request diff exceeds configured size limit.",
        errorOptions(response),
      );
    }

    return diff;
  }

  private async findExistingCheckRunId(
    input: CreateOrUpdateCheckRunInput,
  ): Promise<string | undefined> {
    const response = await this.requestInstallation<JsonRecord>(
      input,
      `/repos/${input.owner}/${input.repo}/commits/${input.headSha}/check-runs?check_name=${encodeURIComponent(
        input.name,
      )}`,
    );
    const checkRuns = asArray(response.check_runs, "check_runs")
      .map((checkRun) => asRecord(checkRun, "check_run"))
      .filter((checkRun) => optionalString(checkRun, "external_id") === input.reviewRunId);
    const [checkRun] = checkRuns;

    return checkRun ? asString(checkRun, "id") : undefined;
  }

  private normalizeRepository(
    repository: JsonRecord,
    input: {
      readonly installationId: string;
      readonly providerInstallationId: string;
      readonly orgId?: string;
    },
  ): Repository {
    const providerRepoId = asString(repository, "id");
    const fullName = asString(repository, "full_name");
    const { owner } = splitFullName(fullName);
    const organization = optionalRecord(repository.organization);
    const ownerRecord = optionalRecord(repository.owner);
    const orgProviderId =
      input.orgId ??
      stableId("org", [
        "github",
        organization
          ? asString(organization, "id")
          : ownerRecord
            ? asString(ownerRecord, "id")
            : owner,
      ]);
    const timestamp = this.now().toISOString();

    return {
      repoId: stableId("repo", ["github", providerRepoId]),
      orgId: orgProviderId,
      installationId: input.installationId,
      provider: "github",
      providerRepoId,
      owner,
      name: asString(repository, "name"),
      fullName,
      ...withOptional("defaultBranch", optionalString(repository, "default_branch")),
      ...withOptional(
        "cloneUrl",
        optionalString(repository, "clone_url") ?? optionalString(repository, "html_url"),
      ),
      visibility: optionalBoolean(repository, "private", true) ? "private" : "public",
      isArchived: optionalBoolean(repository, "archived"),
      isFork: optionalBoolean(repository, "fork"),
      enabled: true,
      createdAt: optionalString(repository, "created_at") ?? timestamp,
      updatedAt: optionalString(repository, "updated_at") ?? timestamp,
      ...withOptional("metadata", {
        ...repository,
        providerInstallationId: input.providerInstallationId,
      }),
    };
  }

  private normalizeChangedFile(file: JsonRecord): ChangedFile {
    const path = asString(file, "filename");
    const patch = optionalString(file, "patch");

    return {
      path,
      ...withOptional("oldPath", optionalString(file, "previous_filename")),
      status: normalizeFileStatus(asString(file, "status")),
      language: languageForPath(path),
      additions: asNumber(file, "additions"),
      deletions: asNumber(file, "deletions"),
      changes: asNumber(file, "changes"),
      isBinary: !patch,
      isGenerated: isGeneratedPath(path),
      isTest: isTestPath(path),
      ...withOptional("patch", patch),
      hunks: [],
    };
  }

  private baseHeaders(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      "user-agent": this.config.userAgent,
      "x-github-api-version": this.config.apiVersion,
    };
  }

  private withDedupeMarker(body: string, reviewRunId: string, findingId?: string): string {
    return `${body}\n\n${this.createDedupeMarker(body, reviewRunId, findingId)}`;
  }

  private createDedupeMarker(body: string, reviewRunId: string, findingId?: string): string {
    const fingerprint = sha256(`${reviewRunId}:${findingId ?? "summary"}:${body}`);
    return `<!-- heimdall:${reviewRunId}:${findingId ?? "summary"}:${fingerprint} -->`;
  }

  private mapExistingCommentIdsByFindingId(
    comments: readonly { readonly marker: string; readonly findingId?: string }[],
    existingComments: readonly ExistingBotComment[],
  ): Record<string, string> {
    const commentIdsByFindingId: Record<string, string> = {};

    for (const comment of comments) {
      const existingComment = existingComments.find((candidate) =>
        candidate.body.includes(comment.marker),
      );
      if (comment.findingId && existingComment) {
        commentIdsByFindingId[comment.findingId] = existingComment.providerCommentId;
      }
    }

    return commentIdsByFindingId;
  }

  private async fetchExistingReviewComments(
    input: GitHubPullRequestRef,
  ): Promise<readonly ExistingBotComment[]> {
    const comments = await this.paginateInstallation<JsonRecord>(
      input,
      `/repos/${input.owner}/${input.repo}/pulls/${input.pullRequestNumber}/comments`,
    );

    return comments
      .filter((comment) => optionalString(comment, "body")?.includes("<!-- heimdall:"))
      .map((comment) => ({
        providerCommentId: asString(comment, "id"),
        body: asString(comment, "body"),
        authorLogin: asString(asRecord(comment.user, "comment.user"), "login"),
        ...withOptional("htmlUrl", optionalString(comment, "html_url")),
      }));
  }
}

const asArray = (value: unknown, name: string): readonly unknown[] => {
  if (!Array.isArray(value)) {
    throw new GitHubValidationError(`GitHub response field ${name} must be an array.`, {});
  }

  return value;
};

const normalizeFileStatus = (status: string): ChangedFile["status"] => {
  if (
    status === "added" ||
    status === "modified" ||
    status === "deleted" ||
    status === "renamed" ||
    status === "copied" ||
    status === "unchanged"
  ) {
    return status;
  }

  return status === "changed" ? "type_changed" : "modified";
};

const toGitHubAnnotation = (annotation: CheckRunAnnotation): JsonRecord => ({
  path: annotation.path,
  start_line: annotation.startLine,
  end_line: annotation.endLine,
  annotation_level: annotation.annotationLevel,
  message: annotation.message,
  title: annotation.title,
});

const parseRetryAfter = (response: Response): number | undefined => {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number.parseInt(retryAfter, 10);
  return Number.isNaN(seconds) ? undefined : seconds;
};

const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const value = (await response.json()) as unknown;
    const record = optionalRecord(value);
    const message = record ? optionalString(record, "message") : undefined;
    return message ?? `GitHub request failed with status ${response.status}.`;
  } catch {
    return `GitHub request failed with status ${response.status}.`;
  }
};

const raiseGitHubError = async (response: Response): Promise<never> => {
  const message = await readErrorMessage(response);
  const options = errorOptions(response);
  const lowerMessage = message.toLowerCase();

  if (response.status === 401 || response.status === 403) {
    if (lowerMessage.includes("secondary rate limit")) {
      throw new GitHubSecondaryRateLimitError(message, options);
    }
    if (lowerMessage.includes("rate limit")) {
      throw new GitHubRateLimitError(message, options);
    }
    if (lowerMessage.includes("suspended")) {
      throw new GitHubInstallationSuspendedError(message, options);
    }
    throw new GitHubPermissionError(message, options);
  }
  if (response.status === 404) {
    throw new GitHubNotFoundError(message, options);
  }
  if (response.status === 422) {
    throw new GitHubValidationError(message, options);
  }
  if (response.status >= 500) {
    throw new GitHubUnavailableError(message, options);
  }

  throw new GitHubProviderError("github_unknown", message, options);
};

const errorOptions = (
  response: Response,
): {
  readonly status: number;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
} => ({
  status: response.status,
  ...withOptional("requestId", response.headers.get("x-github-request-id") ?? undefined),
  ...withOptional("retryAfterSeconds", parseRetryAfter(response)),
});

/** Creates a GitHub App provider. */
export function createGitHubProvider(
  config: GitHubProviderConfig,
  dependencies: GitHubProviderDependencies = {},
): GitProvider {
  return new GitHubAppProvider(config, dependencies);
}
