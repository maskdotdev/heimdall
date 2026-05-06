import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { inspect, promisify } from "node:util";
import { JOB_TYPES } from "@repo/contracts";
import {
  computeGitHubWebhookSignature,
  createGitHubProvider,
  type GitHubFetch,
} from "@repo/github";
import postgres from "postgres";
import { loadSmokeEnv, optionalEnv, optionalIntegerEnv } from "./smoke-env";

/** Live PR review smoke configuration. */
type ReviewSmokeConfig = {
  /** Postgres connection string used by API, worker, and smoke proof polling. */
  readonly databaseUrl: string;
  /** GitHub REST API base URL. */
  readonly githubApiBaseUrl: string;
  /** GitHub App ID. */
  readonly githubAppId: string;
  /** GitHub App private key. */
  readonly githubPrivateKey: string;
  /** Heimdall installation ID used in local database rows. */
  readonly installationId: string;
  /** GitHub installation ID. */
  readonly providerInstallationId: string;
  /** Repository owner login. */
  readonly owner: string;
  /** Repository name. */
  readonly repo: string;
  /** Optional base branch override. */
  readonly baseBranch?: string;
  /** Throwaway branch that the smoke creates or updates. */
  readonly smokeBranch: string;
  /** Throwaway file path changed by the smoke branch. */
  readonly smokeFilePath: string;
  /** Local API webhook URL. */
  readonly webhookUrl: string;
  /** Webhook secret shared with the local API. */
  readonly webhookSecret: string;
  /** Maximum time to wait for webhook-to-publish completion. */
  readonly timeoutMs: number;
  /** Poll interval while waiting for database proof. */
  readonly pollIntervalMs: number;
  /** Explicit write guard. */
  readonly allowWrite: boolean;
  /** Optional token used only to mutate the throwaway branch and PR. */
  readonly mutationToken?: string;
  /** Whether to fall back to the local gh token when the App cannot mutate refs. */
  readonly allowGhTokenFallback: boolean;
};

/** Minimal raw GitHub repository payload fields used to synthesize a webhook. */
type RawGitHubRepository = JsonRecord & {
  /** GitHub repository ID. */
  readonly id: number | string;
  /** Repository full name. */
  readonly full_name: string;
  /** Repository name. */
  readonly name: string;
  /** Repository owner object. */
  readonly owner: JsonRecord;
  /** Default branch name. */
  readonly default_branch?: string;
};

/** Minimal raw GitHub pull request payload fields used to synthesize a webhook. */
type RawGitHubPullRequest = JsonRecord & {
  /** GitHub PR ID. */
  readonly id: number | string;
  /** Pull request number. */
  readonly number: number;
  /** Pull request URL. */
  readonly html_url?: string;
  /** Pull request head object. */
  readonly head: JsonRecord;
};

/** GitHub branch ref response. */
type GitRefResponse = {
  /** Full Git ref, such as refs/heads/main. */
  readonly ref: string;
  /** Ref object containing the commit SHA. */
  readonly object: {
    /** Commit SHA. */
    readonly sha: string;
  };
};

/** GitHub contents response for a single file. */
type GitHubContentResponse = {
  /** Blob SHA for update calls. */
  readonly sha: string;
};

/** GitHub contents write response. */
type GitHubContentUpdateResponse = {
  /** Commit created by the contents write. */
  readonly commit: {
    /** Commit SHA. */
    readonly sha: string;
  };
};

/** Result of opening or updating the throwaway PR. */
type ThrowawayPullRequest = {
  /** Whether the smoke created a new PR or updated an existing one. */
  readonly action: "opened" | "synchronize";
  /** Raw GitHub repository payload. */
  readonly repository: RawGitHubRepository;
  /** Raw GitHub pull request payload. */
  readonly pullRequest: RawGitHubPullRequest;
  /** Pull request number. */
  readonly pullRequestNumber: number;
  /** Pull request HTML URL when GitHub returns it. */
  readonly pullRequestUrl?: string;
  /** Head SHA after the smoke update. */
  readonly headSha: string;
};

/** Credential source used to mutate the throwaway branch and PR. */
type MutationCredentialSource = "github_app" | "env_token" | "gh_auth_token";

/** Database-backed smoke proof for one durable job. */
type JobProof = {
  /** Durable background job row ID. */
  readonly backgroundJobId: string;
  /** Queue name. */
  readonly queueName: string;
  /** Durable job type. */
  readonly jobType: string;
  /** Durable idempotency key. */
  readonly jobKey: string;
  /** Job-envelope ID from the persisted payload. */
  readonly envelopeJobId?: string;
  /** Current durable job status. */
  readonly status: string;
  /** Number of worker attempts. */
  readonly attempts: number;
  /** Stored error payload when the job failed. */
  readonly error?: unknown;
};

/** Current proof state observed while polling. */
type ObservedSmokeState = {
  /** Webhook event ID returned by the API. */
  readonly webhookEventId?: string;
  /** Repo ID that owns the review. */
  readonly repoId: string;
  /** Pull request number under review. */
  readonly pullRequestNumber: number;
  /** Head SHA under review. */
  readonly headSha: string;
  /** Review run ID once the review job starts. */
  readonly reviewRunId?: string;
  /** Review run status once available. */
  readonly reviewRunStatus?: string;
  /** Durable publish run ID once available. */
  readonly publishRunId?: string;
  /** Durable publish run status once available. */
  readonly publishRunStatus?: string;
  /** Provider check run ID once published. */
  readonly providerCheckRunId?: string;
  /** Provider review ID once inline publishing runs. */
  readonly providerReviewId?: string;
  /** Provider comment ID from an inline or fallback summary comment. */
  readonly providerCommentId?: string;
  /** Provider summary comment ID when fallback publishing runs. */
  readonly providerSummaryCommentId?: string;
  /** Durable job proof rows. */
  readonly jobs: readonly JobProof[];
};

/** JSON object shape used by API helpers. */
type JsonRecord = Record<string, unknown>;

/** Error type that carries the latest observed smoke state. */
class ReviewSmokeError extends Error {
  /** Creates a smoke error with optional proof details. */
  public constructor(
    message: string,
    /** Last observed state to print in failure output. */
    public readonly observed?: ObservedSmokeState,
  ) {
    super(message);
    this.name = "ReviewSmokeError";
  }
}

/** Error raised when a GitHub API request fails. */
class GitHubSmokeRequestError extends Error {
  /** Creates a GitHub smoke request error. */
  public constructor(
    /** HTTP status code. */
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubSmokeRequestError";
  }
}

const execFileAsync = promisify(execFile);

/** Logs GitHub request outcomes for live smoke diagnostics without exposing credentials. */
const loggingGitHubFetch: GitHubFetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = new URL(input);
  console.error(
    `[github-review-smoke] ${init?.method ?? "GET"} ${url.pathname} -> ${response.status}`,
  );
  return response;
};

/** Loads and validates the live GitHub PR review smoke configuration. */
function loadConfig(): ReviewSmokeConfig {
  loadSmokeEnv();
  const databaseUrl =
    optionalEnv("DATABASE_URL") ?? "postgresql://postgres:postgres@localhost:5432/review_agent";
  const githubPrivateKey =
    optionalEnv("GITHUB_PRIVATE_KEY") ?? optionalEnv("GITHUB_APP_PRIVATE_KEY");
  const githubAppId = optionalEnv("GITHUB_APP_ID");
  const providerInstallationId = optionalEnv("HEIMDALL_GITHUB_SMOKE_PROVIDER_INSTALLATION_ID");
  const owner = optionalEnv("HEIMDALL_GITHUB_SMOKE_OWNER");
  const repo = optionalEnv("HEIMDALL_GITHUB_SMOKE_REPO");
  const webhookSecret = optionalEnv("GITHUB_WEBHOOK_SECRET") ?? "local-smoke-secret";
  const webhookUrl =
    optionalEnv("HEIMDALL_GITHUB_REVIEW_SMOKE_WEBHOOK_URL") ??
    "http://localhost:3000/webhooks/github";
  const baseBranch = optionalEnv("HEIMDALL_GITHUB_REVIEW_SMOKE_BASE_BRANCH");
  const mutationToken =
    optionalEnv("HEIMDALL_GITHUB_REVIEW_SMOKE_MUTATION_TOKEN") ?? optionalEnv("GITHUB_TOKEN");
  const missing = [
    databaseUrl ? undefined : "DATABASE_URL",
    githubAppId ? undefined : "GITHUB_APP_ID",
    githubPrivateKey ? undefined : "GITHUB_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY",
    providerInstallationId ? undefined : "HEIMDALL_GITHUB_SMOKE_PROVIDER_INSTALLATION_ID",
    owner ? undefined : "HEIMDALL_GITHUB_SMOKE_OWNER",
    repo ? undefined : "HEIMDALL_GITHUB_SMOKE_REPO",
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    throw new Error(`Missing live PR review smoke configuration: ${missing.join(", ")}.`);
  }

  return {
    databaseUrl: databaseUrl ?? "",
    githubApiBaseUrl: optionalEnv("GITHUB_API_BASE_URL") ?? "https://api.github.com",
    githubAppId: githubAppId ?? "",
    githubPrivateKey: (githubPrivateKey ?? "").replaceAll("\\n", "\n"),
    installationId:
      optionalEnv("HEIMDALL_GITHUB_SMOKE_INSTALLATION_ID") ?? providerInstallationId ?? "",
    providerInstallationId: providerInstallationId ?? "",
    owner: owner ?? "",
    repo: repo ?? "",
    ...(baseBranch ? { baseBranch } : {}),
    smokeBranch: optionalEnv("HEIMDALL_GITHUB_REVIEW_SMOKE_BRANCH") ?? "heimdall/smoke-pr-review",
    smokeFilePath:
      optionalEnv("HEIMDALL_GITHUB_REVIEW_SMOKE_FILE") ?? "heimdall-smoke/pr-review-smoke.txt",
    webhookUrl,
    webhookSecret: webhookSecret ?? "",
    timeoutMs: optionalIntegerEnv("HEIMDALL_GITHUB_REVIEW_SMOKE_TIMEOUT_MS", 180_000),
    pollIntervalMs: optionalIntegerEnv("HEIMDALL_GITHUB_REVIEW_SMOKE_POLL_MS", 2_000),
    allowWrite: process.env.HEIMDALL_GITHUB_SMOKE_ALLOW_WRITE === "true",
    ...(mutationToken ? { mutationToken } : {}),
    allowGhTokenFallback: process.env.HEIMDALL_GITHUB_REVIEW_SMOKE_GH_TOKEN_FALLBACK === "true",
  };
}

/** Runs the live smoke and prints proof output. */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.allowWrite) {
    throw new Error("Set HEIMDALL_GITHUB_SMOKE_ALLOW_WRITE=true to mutate the throwaway PR.");
  }

  const provider = createGitHubProvider(
    {
      appId: config.githubAppId,
      privateKey: config.githubPrivateKey,
    },
    { fetch: loggingGitHubFetch },
  );
  const installationToken = await provider.getInstallationToken({
    provider: "github",
    installationId: config.installationId,
    providerInstallationId: config.providerInstallationId,
  });
  const { pullRequest, mutationCredentialSource } = await openOrUpdateWithFallback(
    config,
    installationToken.token,
  );
  const snapshot = await provider.fetchPullRequestSnapshot({
    provider: "github",
    installationId: config.installationId,
    providerInstallationId: config.providerInstallationId,
    owner: config.owner,
    repo: config.repo,
    providerRepoId: String(pullRequest.repository.id),
    pullRequestNumber: pullRequest.pullRequestNumber,
  });

  const delivery = await deliverWebhook(config, pullRequest);
  const sql = postgres(config.databaseUrl, { max: 1 });

  try {
    const observed = await waitForCompletion(sql, {
      config,
      repoId: snapshot.repoId,
      pullRequestNumber: pullRequest.pullRequestNumber,
      headSha: snapshot.headSha,
      webhookEventId: delivery.webhookEventId,
    });

    console.log(
      JSON.stringify(
        {
          status: "completed",
          owner: config.owner,
          repo: config.repo,
          pullRequestNumber: pullRequest.pullRequestNumber,
          pullRequestUrl: pullRequest.pullRequestUrl,
          action: pullRequest.action,
          mutationCredentialSource,
          deliveryId: delivery.deliveryId,
          webhookEventId: delivery.webhookEventId,
          reviewRunId: observed.reviewRunId,
          publishRunId: observed.publishRunId,
          providerCheckRunId: observed.providerCheckRunId,
          providerReviewId: observed.providerReviewId,
          providerCommentId: observed.providerCommentId,
          providerSummaryCommentId: observed.providerSummaryCommentId,
          jobs: observed.jobs,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

/** Opens or updates the PR using the App token or a guarded local mutation fallback. */
async function openOrUpdateWithFallback(
  config: ReviewSmokeConfig,
  installationToken: string,
): Promise<{
  readonly pullRequest: ThrowawayPullRequest;
  readonly mutationCredentialSource: MutationCredentialSource;
}> {
  if (config.mutationToken) {
    return {
      pullRequest: await openOrUpdateThrowawayPullRequest(config, config.mutationToken),
      mutationCredentialSource: "env_token",
    };
  }

  try {
    return {
      pullRequest: await openOrUpdateThrowawayPullRequest(config, installationToken),
      mutationCredentialSource: "github_app",
    };
  } catch (error) {
    if (
      !(error instanceof GitHubSmokeRequestError) ||
      error.status !== 403 ||
      !config.allowGhTokenFallback
    ) {
      throw error;
    }

    const ghToken = await loadGhAuthToken();
    console.error(
      "[github-review-smoke] GitHub App branch mutation returned 403; using gh auth token fallback.",
    );
    return {
      pullRequest: await openOrUpdateThrowawayPullRequest(config, ghToken),
      mutationCredentialSource: "gh_auth_token",
    };
  }
}

/** Loads the active GitHub CLI token for local throwaway branch mutation fallback. */
async function loadGhAuthToken(): Promise<string> {
  const { stdout } = await execFileAsync("gh", ["auth", "token"]);
  const token = stdout.trim();
  if (!token) {
    throw new Error("gh auth token returned an empty token.");
  }

  return token;
}

/** Creates or updates the throwaway branch and PR on GitHub. */
async function openOrUpdateThrowawayPullRequest(
  config: ReviewSmokeConfig,
  token: string,
): Promise<ThrowawayPullRequest> {
  const repository = await githubRequest<RawGitHubRepository>(config, token, repoPath(config, ""));
  const baseBranch = config.baseBranch ?? repository.default_branch ?? "main";
  const baseRef = await githubRequest<GitRefResponse>(
    config,
    token,
    repoPath(config, `/git/ref/heads/${encodeGitRef(baseBranch)}`),
  );
  const existingBranch = await githubRequestOptional<GitRefResponse>(
    config,
    token,
    repoPath(config, `/git/ref/heads/${encodeGitRef(config.smokeBranch)}`),
  );

  if (!existingBranch) {
    await githubRequest<JsonRecord>(config, token, repoPath(config, "/git/refs"), {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${config.smokeBranch}`,
        sha: baseRef.object.sha,
      }),
    });
  }

  const existingContent = await githubRequestOptional<GitHubContentResponse>(
    config,
    token,
    `${repoPath(config, `/contents/${encodeRepositoryPath(config.smokeFilePath)}`)}?ref=${encodeURIComponent(
      config.smokeBranch,
    )}`,
  );
  const contentUpdate = await githubRequest<GitHubContentUpdateResponse>(
    config,
    token,
    repoPath(config, `/contents/${encodeRepositoryPath(config.smokeFilePath)}`),
    {
      method: "PUT",
      body: JSON.stringify({
        message: `chore: update Heimdall PR review smoke ${new Date().toISOString()}`,
        content: Buffer.from(renderSmokeFile()).toString("base64"),
        branch: config.smokeBranch,
        ...(existingContent ? { sha: existingContent.sha } : {}),
      }),
    },
  );

  const existingPullRequest = await findOpenSmokePullRequest(config, token);
  const pullRequest = existingPullRequest
    ? await githubRequest<RawGitHubPullRequest>(
        config,
        token,
        repoPath(config, `/pulls/${existingPullRequest.number}`),
        {
          method: "PATCH",
          body: JSON.stringify({
            title: "Heimdall PR review smoke",
            body: "Throwaway PR used by the guarded Heimdall live PR review smoke.",
          }),
        },
      )
    : await githubRequest<RawGitHubPullRequest>(config, token, repoPath(config, "/pulls"), {
        method: "POST",
        body: JSON.stringify({
          title: "Heimdall PR review smoke",
          head: config.smokeBranch,
          base: baseBranch,
          body: "Throwaway PR used by the guarded Heimdall live PR review smoke.",
          maintainer_can_modify: true,
        }),
      });
  const refreshedPullRequest = await waitForPullRequestHead(
    config,
    token,
    pullRequest.number,
    contentUpdate.commit.sha,
  );
  const head = asRecord(refreshedPullRequest.head, "pull_request.head");

  return {
    action: existingPullRequest ? "synchronize" : "opened",
    repository,
    pullRequest: refreshedPullRequest,
    pullRequestNumber: refreshedPullRequest.number,
    ...(typeof refreshedPullRequest.html_url === "string"
      ? { pullRequestUrl: refreshedPullRequest.html_url }
      : {}),
    headSha: asString(head, "sha"),
  };
}

/** Waits until GitHub's PR API reflects the content update commit as the head SHA. */
async function waitForPullRequestHead(
  config: ReviewSmokeConfig,
  token: string,
  pullRequestNumber: number,
  expectedHeadSha: string,
): Promise<RawGitHubPullRequest> {
  const deadline = Date.now() + 30_000;
  let pullRequest = await githubRequest<RawGitHubPullRequest>(
    config,
    token,
    repoPath(config, `/pulls/${pullRequestNumber}`),
  );

  while (asString(asRecord(pullRequest.head, "pull_request.head"), "sha") !== expectedHeadSha) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for PR head ${expectedHeadSha}.`);
    }
    await sleep(1_000);
    pullRequest = await githubRequest<RawGitHubPullRequest>(
      config,
      token,
      repoPath(config, `/pulls/${pullRequestNumber}`),
    );
  }

  return pullRequest;
}

/** Finds the open throwaway PR for the configured smoke branch. */
async function findOpenSmokePullRequest(
  config: ReviewSmokeConfig,
  token: string,
): Promise<RawGitHubPullRequest | undefined> {
  const pullRequests = await githubRequest<unknown[]>(
    config,
    token,
    `${repoPath(config, "/pulls")}?state=open&head=${encodeURIComponent(
      `${config.owner}:${config.smokeBranch}`,
    )}`,
  );

  return pullRequests.map((value) => asPullRequest(value)).find(Boolean);
}

/** Posts a signed pull_request webhook payload to the local API. */
async function deliverWebhook(
  config: ReviewSmokeConfig,
  pullRequest: ThrowawayPullRequest,
): Promise<{ readonly deliveryId: string; readonly webhookEventId: string }> {
  await assertApiHealthy(config.webhookUrl);
  const deliveryId = randomUUID();
  const rawBody = new TextEncoder().encode(
    JSON.stringify({
      action: pullRequest.action,
      installation: {
        id: Number(config.providerInstallationId),
        account: pullRequest.repository.owner,
        permissions: {},
        created_at: new Date().toISOString(),
      },
      repository: pullRequest.repository,
      pull_request: pullRequest.pullRequest,
    }),
  );
  const response = await fetch(config.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "heimdall-pr-review-smoke",
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": computeGitHubWebhookSignature(config.webhookSecret, rawBody),
    },
    body: rawBody,
  });
  const responseText = await response.text();
  const responseBody = parseJsonResponse(responseText);
  if (!response.ok) {
    throw new Error(`Webhook delivery failed with HTTP ${response.status}: ${responseText}`);
  }
  if (!responseBody) {
    throw new Error(`Webhook delivery returned non-JSON HTTP ${response.status}: ${responseText}`);
  }
  const record = asRecord(responseBody, "webhook response");

  return {
    deliveryId,
    webhookEventId: asString(record, "webhookEventId"),
  };
}

/** Parses a response body as JSON when possible. */
function parseJsonResponse(responseText: string): unknown | undefined {
  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return undefined;
  }
}

/** Waits for durable review and publish proof rows to reach a completed state. */
async function waitForCompletion(
  sql: postgres.Sql,
  input: {
    readonly config: ReviewSmokeConfig;
    readonly repoId: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly webhookEventId: string;
  },
): Promise<ObservedSmokeState> {
  const deadline = Date.now() + input.config.timeoutMs;
  let observed = await queryObservedState(sql, input);

  while (Date.now() < deadline) {
    if (isComplete(observed)) {
      return observed;
    }
    const failedJob = observed.jobs.find(
      (job) =>
        job.status === "failed" &&
        (job.jobType === JOB_TYPES.ReviewPullRequest || job.jobType === JOB_TYPES.PublishReview),
    );
    if (failedJob) {
      throw new ReviewSmokeError(`Smoke job ${failedJob.jobType} failed.`, observed);
    }
    if (observed.publishRunStatus === "failed" || observed.publishRunStatus === "skipped") {
      throw new ReviewSmokeError(`Publish run ${observed.publishRunStatus}.`, observed);
    }

    await sleep(input.config.pollIntervalMs);
    observed = await queryObservedState(sql, input);
  }

  throw new ReviewSmokeError("Timed out waiting for webhook-to-publish completion.", observed);
}

/** Returns true when the observed state proves end-to-end completion. */
function isComplete(observed: ObservedSmokeState): boolean {
  return Boolean(
    observed.reviewRunId &&
      observed.reviewRunStatus === "completed" &&
      observed.publishRunId &&
      observed.publishRunStatus === "completed" &&
      observed.providerCheckRunId &&
      observed.providerCommentId &&
      observed.jobs.some(
        (job) => job.jobType === JOB_TYPES.ReviewPullRequest && job.status === "completed",
      ) &&
      observed.jobs.some(
        (job) => job.jobType === JOB_TYPES.PublishReview && job.status === "completed",
      ),
  );
}

/** Queries the current durable proof state from Postgres. */
async function queryObservedState(
  sql: postgres.Sql,
  input: {
    readonly repoId: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly webhookEventId: string;
  },
): Promise<ObservedSmokeState> {
  const [reviewRun] = await sql<ReviewRunRow[]>`
    SELECT review_run_id, status
    FROM review_runs
    WHERE repo_id = ${input.repoId}
      AND pull_request_number = ${input.pullRequestNumber}
      AND head_sha = ${input.headSha}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const jobKeys = [
    `github:index:${input.repoId}:${input.headSha}`,
    `github:review:${input.repoId}:${input.pullRequestNumber}:${input.headSha}`,
    ...(reviewRun ? [`review.publish.v1:${reviewRun.review_run_id}`] : []),
  ];
  const jobs = await sql<JobRow[]>`
    SELECT background_job_id, queue_name, job_key, job_type, status, attempts, payload, error
    FROM background_jobs
    WHERE job_key = ANY(${jobKeys})
    ORDER BY created_at ASC
  `;
  const publish = reviewRun ? await queryPublishState(sql, reviewRun.review_run_id) : undefined;

  return {
    webhookEventId: input.webhookEventId,
    repoId: input.repoId,
    pullRequestNumber: input.pullRequestNumber,
    headSha: input.headSha,
    ...(reviewRun
      ? { reviewRunId: reviewRun.review_run_id, reviewRunStatus: reviewRun.status }
      : {}),
    ...(publish?.publishRunId ? { publishRunId: publish.publishRunId } : {}),
    ...(publish?.publishRunStatus ? { publishRunStatus: publish.publishRunStatus } : {}),
    ...(publish?.providerCheckRunId ? { providerCheckRunId: publish.providerCheckRunId } : {}),
    ...(publish?.providerReviewId ? { providerReviewId: publish.providerReviewId } : {}),
    ...(publish?.providerCommentId ? { providerCommentId: publish.providerCommentId } : {}),
    ...(publish?.providerSummaryCommentId
      ? { providerSummaryCommentId: publish.providerSummaryCommentId }
      : {}),
    jobs: jobs.map(toJobProof),
  };
}

/** Queries publish rows associated with a review run. */
async function queryPublishState(
  sql: postgres.Sql,
  reviewRunId: string,
): Promise<
  | {
      readonly publishRunId?: string;
      readonly publishRunStatus?: string;
      readonly providerCheckRunId?: string;
      readonly providerReviewId?: string;
      readonly providerCommentId?: string;
      readonly providerSummaryCommentId?: string;
    }
  | undefined
> {
  const [publishRun] = await sql<PublishRunRow[]>`
    SELECT publish_run_id, status
    FROM publish_runs
    WHERE review_run_id = ${reviewRunId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!publishRun) {
    return undefined;
  }

  const [[checkRun], [review], [summaryComment], [findingComment]] = await Promise.all([
    sql<CheckRunRow[]>`
      SELECT provider_check_run_id
      FROM published_check_runs
      WHERE review_run_id = ${reviewRunId}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    sql<ReviewRow[]>`
      SELECT provider_review_id
      FROM published_reviews
      WHERE review_run_id = ${reviewRunId}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    sql<CommentRow[]>`
      SELECT provider_comment_id
      FROM published_summary_comments
      WHERE review_run_id = ${reviewRunId}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    sql<CommentRow[]>`
      SELECT provider_comment_id
      FROM published_findings
      WHERE review_run_id = ${reviewRunId}
        AND provider_comment_id IS NOT NULL
      ORDER BY published_at DESC
      LIMIT 1
    `,
  ]);

  return {
    publishRunId: publishRun.publish_run_id,
    publishRunStatus: publishRun.status,
    ...(checkRun ? { providerCheckRunId: checkRun.provider_check_run_id } : {}),
    ...(review ? { providerReviewId: review.provider_review_id } : {}),
    ...(findingComment ? { providerCommentId: findingComment.provider_comment_id } : {}),
    ...(summaryComment
      ? {
          providerCommentId:
            findingComment?.provider_comment_id ?? summaryComment.provider_comment_id,
          providerSummaryCommentId: summaryComment.provider_comment_id,
        }
      : {}),
  };
}

/** Converts a durable job row into proof output. */
function toJobProof(row: JobRow): JobProof {
  const payload = optionalRecord(row.payload);
  return {
    backgroundJobId: row.background_job_id,
    queueName: row.queue_name,
    jobType: row.job_type,
    jobKey: row.job_key,
    ...(typeof payload?.jobId === "string" ? { envelopeJobId: payload.jobId } : {}),
    status: row.status,
    attempts: row.attempts,
    ...(row.error ? { error: row.error } : {}),
  };
}

/** Poll sleep helper. */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Verifies that the local API is reachable before posting the webhook. */
async function assertApiHealthy(webhookUrl: string): Promise<void> {
  const healthUrl = new URL("/healthz", webhookUrl).toString();
  const response = await fetch(healthUrl);
  if (!response.ok) {
    throw new Error(`Local API health check failed with HTTP ${response.status}.`);
  }
}

/** Makes an authenticated GitHub API request. */
async function githubRequest<T>(
  config: ReviewSmokeConfig,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${config.githubApiBaseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "heimdall-pr-review-smoke",
      "x-github-api-version": "2022-11-28",
      ...init.headers,
    },
  });
  console.error(`[github-review-smoke] ${init.method ?? "GET"} ${path} -> ${response.status}`);
  if (!response.ok) {
    throw new GitHubSmokeRequestError(
      response.status,
      `GitHub request failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }

  return (await response.json()) as T;
}

/** Makes an authenticated GitHub API request that may return 404. */
async function githubRequestOptional<T>(
  config: ReviewSmokeConfig,
  token: string,
  path: string,
): Promise<T | undefined> {
  const response = await fetch(`${config.githubApiBaseUrl}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "heimdall-pr-review-smoke",
      "x-github-api-version": "2022-11-28",
    },
  });
  console.error(`[github-review-smoke] GET ${path} -> ${response.status}`);
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new GitHubSmokeRequestError(
      response.status,
      `GitHub request failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }

  return (await response.json()) as T;
}

/** Renders the throwaway file content committed to the smoke branch. */
function renderSmokeFile(): string {
  return [
    "Heimdall PR review smoke.",
    `Updated at: ${new Date().toISOString()}`,
    `Run ID: ${randomUUID()}`,
    "",
  ].join("\n");
}

/** Builds a repository-scoped GitHub API path. */
function repoPath(config: ReviewSmokeConfig, suffix: string): string {
  return `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}${suffix}`;
}

/** Encodes a repository content path while preserving path separators. */
function encodeRepositoryPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Encodes a Git ref name while preserving branch path separators. */
function encodeGitRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/** Converts an unknown value into a JSON object or throws. */
function asRecord(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }

  return value as JsonRecord;
}

/** Converts an unknown value into a JSON object when possible. */
function optionalRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/** Reads a required string-compatible field from a JSON object. */
function asString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }

  throw new Error(`${key} must be a string.`);
}

/** Narrows an unknown value to a raw GitHub pull request payload. */
function asPullRequest(value: unknown): RawGitHubPullRequest | undefined {
  const record = optionalRecord(value);
  return record && typeof record.number === "number" ? (record as RawGitHubPullRequest) : undefined;
}

/** Durable review run row selected during proof polling. */
type ReviewRunRow = {
  /** Review run ID. */
  readonly review_run_id: string;
  /** Review run status. */
  readonly status: string;
};

/** Durable background job row selected during proof polling. */
type JobRow = {
  /** Background job ID. */
  readonly background_job_id: string;
  /** Queue name. */
  readonly queue_name: string;
  /** Job key. */
  readonly job_key: string;
  /** Job type. */
  readonly job_type: string;
  /** Job status. */
  readonly status: string;
  /** Attempt count. */
  readonly attempts: number;
  /** Raw job payload. */
  readonly payload: unknown;
  /** Raw job error. */
  readonly error: unknown;
};

/** Durable publish run row selected during proof polling. */
type PublishRunRow = {
  /** Publish run ID. */
  readonly publish_run_id: string;
  /** Publish run status. */
  readonly status: string;
};

/** Published check run row selected during proof polling. */
type CheckRunRow = {
  /** Provider check run ID. */
  readonly provider_check_run_id: string;
};

/** Published review row selected during proof polling. */
type ReviewRow = {
  /** Provider review ID. */
  readonly provider_review_id: string;
};

/** Published comment row selected during proof polling. */
type CommentRow = {
  /** Provider comment ID. */
  readonly provider_comment_id: string;
};

main().catch((error: unknown) => {
  const observed = error instanceof ReviewSmokeError ? error.observed : undefined;
  console.error(error instanceof Error ? (error.stack ?? error.message) : inspect(error));
  console.log(
    JSON.stringify(
      {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        ...(observed ? { observed } : {}),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
