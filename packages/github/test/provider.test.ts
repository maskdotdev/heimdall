import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  CheckRunAnnotation,
  GitHubFetch,
  GitHubRequestObservation,
  GitHubRequestObserver,
} from "../src";
import {
  createFakeGitProvider,
  createGitHubProvider,
  GitHubNotFoundError,
  GitHubRateLimitError,
  readGitHubRateLimitSnapshot,
} from "../src";

type MockRoute = {
  readonly match: (url: string, init?: RequestInit) => boolean;
  readonly response: Response;
};

type MockFetch = GitHubFetch & {
  readonly calls: Array<{ readonly url: string; readonly init?: RequestInit }>;
};

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  format: "pem",
  type: "pkcs1",
}) as string;

const jsonResponse = (
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "x-github-request-id": "request-1",
      ...headers,
    },
  });

const textResponse = (value: string, status = 200): Response =>
  new Response(value, {
    status,
    headers: { "content-type": "text/plain", "x-github-request-id": "request-1" },
  });

const createMockFetch = (routes: readonly MockRoute[]): MockFetch => {
  const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  const fetcher: GitHubFetch = async (url, init) => {
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    const route = routes.find((candidate) => candidate.match(url, init));
    if (!route) {
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }

    return route.response.clone();
  };

  return Object.assign(fetcher, { calls });
};

const dedupeMarker = (body: string, reviewRunId: string, findingId?: string): string => {
  const fingerprint = `sha256:${createHash("sha256")
    .update(`${reviewRunId}:${findingId ?? "summary"}:${body}`)
    .digest("hex")}`;
  return `<!-- heimdall:${reviewRunId}:${findingId ?? "summary"}:${fingerprint} -->`;
};

const createProvider = (fetcher: GitHubFetch, observeRequest?: GitHubRequestObserver) =>
  createGitHubProvider(
    {
      appId: "12345",
      privateKey,
      tokenExpiryBufferSeconds: 300,
    },
    {
      fetch: fetcher,
      now: () => new Date("2026-05-05T12:00:00.000Z"),
      ...(observeRequest ? { observeRequest } : {}),
    },
  );

const tokenRoute = {
  match: (url: string) => url.endsWith("/app/installations/99/access_tokens"),
  response: jsonResponse({ token: "ghs_token", expires_at: "2026-05-05T13:00:00.000Z" }),
};

const repositoryPayload = {
  id: 100,
  full_name: "acme/api",
  name: "api",
  owner: { id: 200, login: "acme" },
  private: true,
  archived: false,
  fork: false,
  default_branch: "main",
  clone_url: "https://github.com/acme/api.git",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-05-01T00:00:00.000Z",
};

const rateLimitHeaders = {
  "retry-after": "60",
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4999",
  "x-ratelimit-reset": "1770000000",
  "x-ratelimit-resource": "core",
  "x-ratelimit-used": "1",
};

describe("GitHubAppProvider", () => {
  it("parses GitHub rate-limit headers", () => {
    expect(readGitHubRateLimitSnapshot(new Headers(rateLimitHeaders))).toEqual({
      limit: 5000,
      remaining: 4999,
      resetEpochSeconds: 1770000000,
      used: 1,
      resource: "core",
      retryAfterSeconds: 60,
    });
    expect(readGitHubRateLimitSnapshot(new Headers())).toBeUndefined();
  });

  it("generates and caches installation tokens", async () => {
    const fetcher = createMockFetch([tokenRoute]);
    const provider = createProvider(fetcher);

    await expect(
      provider.getInstallationToken({ provider: "github", installationId: "99" }),
    ).resolves.toEqual({
      token: "ghs_token",
      expiresAt: "2026-05-05T13:00:00.000Z",
    });
    await provider.getInstallationToken({ provider: "github", installationId: "99" });

    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]?.init?.headers).toMatchObject({
      authorization: expect.stringMatching(/^Bearer /u),
    });
  });

  it("observes rate-limit headers from successful GitHub responses", async () => {
    const observations: GitHubRequestObservation[] = [];
    const fetcher = createMockFetch([
      {
        match: (url: string) => url.endsWith("/app/installations/99/access_tokens"),
        response: jsonResponse(
          { token: "ghs_token", expires_at: "2026-05-05T13:00:00.000Z" },
          201,
          rateLimitHeaders,
        ),
      },
    ]);
    const provider = createProvider(fetcher, (observation) => observations.push(observation));

    await provider.getInstallationToken({ provider: "github", installationId: "99" });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      authenticationKind: "app",
      method: "POST",
      path: "/app/installations/99/access_tokens",
      status: 201,
      ok: true,
      observedAt: "2026-05-05T12:00:00.000Z",
      requestId: "request-1",
      rateLimit: {
        limit: 5000,
        remaining: 4999,
        resetEpochSeconds: 1770000000,
        used: 1,
        resource: "core",
        retryAfterSeconds: 60,
      },
    });
    expect(observations[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(provider.getRecentRequestObservations?.()).toEqual(observations);
  });

  it("discovers installation repositories", async () => {
    const fetcher = createMockFetch([
      tokenRoute,
      {
        match: (url) => url.includes("/installation/repositories?per_page=100&page=1"),
        response: jsonResponse({ repositories: [repositoryPayload] }),
      },
    ]);
    const provider = createProvider(fetcher);

    await expect(
      provider.listInstallationRepositories({
        provider: "github",
        installationId: "99",
        orgId: "org_1",
      }),
    ).resolves.toMatchObject([
      {
        provider: "github",
        providerRepoId: "100",
        owner: "acme",
        name: "api",
        fullName: "acme/api",
        orgId: "org_1",
      },
    ]);
  });

  it("fetches pull request snapshots with changed files and raw diff hash", async () => {
    const fetcher = createMockFetch([
      tokenRoute,
      {
        match: (url, init) =>
          url.endsWith("/repos/acme/api/pulls/7") &&
          (init?.headers as Record<string, string> | undefined)?.accept !==
            "application/vnd.github.v3.diff",
        response: jsonResponse({
          id: 777,
          number: 7,
          title: "Add API",
          body: "Body",
          user: { login: "octo" },
          author_association: "MEMBER",
          state: "open",
          draft: false,
          labels: [{ name: "backend" }],
          base: { ref: "main", sha: "abcdef1", repo: repositoryPayload },
          head: { ref: "feature", sha: "1234567" },
          merge_commit_sha: "7654321",
          additions: 2,
          deletions: 1,
          changed_files: 1,
        }),
      },
      {
        match: (url) => url.includes("/repos/acme/api/pulls/7/files?per_page=100&page=1"),
        response: jsonResponse([
          {
            filename: "src/index.ts",
            status: "modified",
            additions: 2,
            deletions: 1,
            changes: 3,
            patch: [
              "@@ -1,2 +1,4 @@",
              " export const oldValue = 1;",
              "-export const removed = true;",
              "+export const value = 2;",
              "+export const smoke = true;",
            ].join("\n"),
          },
        ]),
      },
      {
        match: (url, init) =>
          url.endsWith("/repos/acme/api/pulls/7") &&
          (init?.headers as Record<string, string> | undefined)?.accept ===
            "application/vnd.github.v3.diff",
        response: textResponse(
          [
            "diff --git a/src/index.ts b/src/index.ts",
            "--- a/src/index.ts",
            "+++ b/src/index.ts",
            "@@ -1,2 +1,4 @@",
            " export const oldValue = 1;",
            "-export const removed = true;",
            "+export const value = 2;",
            "+export const smoke = true;",
            "",
          ].join("\n"),
        ),
      },
    ]);
    const provider = createProvider(fetcher);

    await expect(
      provider.fetchPullRequestSnapshot({
        provider: "github",
        installationId: "99",
        owner: "acme",
        repo: "api",
        pullRequestNumber: 7,
      }),
    ).resolves.toMatchObject({
      provider: "github",
      providerRepoId: "100",
      pullRequestNumber: 7,
      title: "Add API",
      baseSha: "abcdef1",
      headSha: "1234567",
      changedFiles: [
        {
          path: "src/index.ts",
          language: "typescript",
          additions: 2,
          deletions: 1,
          isBinary: false,
          hunks: [
            {
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 4,
              lines: [
                { kind: "context", oldLine: 1, newLine: 1 },
                { kind: "deletion", oldLine: 2 },
                { kind: "addition", newLine: 2 },
                { kind: "addition", newLine: 3 },
              ],
            },
          ],
        },
      ],
      diffHash: "sha256:c1fb5e6c0fa1b437573372d5d629e605aacf62da27796f0516134135f699a70a",
    });
  });

  it("publishes reviews, summaries, clone auth, branch metadata, and check runs", async () => {
    const annotations = Array.from({ length: 51 }, (_, index) => ({
      path: "src/index.ts",
      startLine: index + 1,
      endLine: index + 1,
      annotationLevel: "warning" as const,
      message: `message ${index}`,
    }));
    let reviewCommentListRequests = 0;
    const fetcher = createMockFetch([
      tokenRoute,
      {
        match: (url) =>
          url.includes("/repos/acme/api/pulls/7/comments?per_page=100&page=1") &&
          reviewCommentListRequests++ === 0,
        response: jsonResponse([]),
      },
      {
        match: (url) => url.endsWith("/repos/acme/api/pulls/7/reviews"),
        response: jsonResponse({ id: 12 }),
      },
      {
        match: (url) => url.includes("/repos/acme/api/pulls/7/comments?per_page=100&page=1"),
        response: jsonResponse([
          {
            id: 13,
            body: `Finding\n\n${dedupeMarker("Finding", "rev_1", "fnd_1")}`,
            user: { login: "heimdall[bot]" },
            html_url: "https://github.com/acme/api/pull/7#discussion_r13",
          },
        ]),
      },
      {
        match: (url) => url.includes("/repos/acme/api/issues/7/comments?per_page=100&page=1"),
        response: jsonResponse([]),
      },
      {
        match: (url) => url.endsWith("/repos/acme/api/issues/7/comments"),
        response: jsonResponse({ id: 14, html_url: "https://github.com/acme/api/pull/7#comment" }),
      },
      {
        match: (url) => url.endsWith("/repos/acme/api/branches/main"),
        response: jsonResponse({ name: "main", commit: { sha: "abcdef1" } }),
      },
      {
        match: (url) =>
          url.endsWith("/repos/acme/api/commits/abcdef1/check-runs?check_name=Heimdall"),
        response: jsonResponse({ check_runs: [] }),
      },
      {
        match: (url) => url.endsWith("/repos/acme/api/check-runs"),
        response: jsonResponse({ id: 15, html_url: "https://github.com/acme/api/checks/15" }),
      },
      {
        match: (url, init) =>
          url.endsWith("/repos/acme/api/check-runs/15") && init?.method === "PATCH",
        response: jsonResponse({ id: 15 }),
      },
    ]);
    const provider = createProvider(fetcher);
    const ref = {
      provider: "github" as const,
      installationId: "99",
      owner: "acme",
      repo: "api",
      pullRequestNumber: 7,
    };

    await expect(
      provider.publishReview({
        ...ref,
        reviewRunId: "rev_1",
        headSha: "abcdef1",
        body: "Summary",
        comments: [
          { path: "src/index.ts", line: 3, side: "RIGHT", body: "Finding", findingId: "fnd_1" },
        ],
      }),
    ).resolves.toMatchObject({
      providerReviewId: "12",
      commentIds: ["13"],
      commentIdsByFindingId: { fnd_1: "13" },
    });
    await expect(
      provider.publishSummaryComment({ ...ref, reviewRunId: "rev_1", body: "Done" }),
    ).resolves.toMatchObject({ providerCommentId: "14" });
    await expect(provider.fetchBranchCommit({ ...ref, ref: "main" })).resolves.toMatchObject({
      ref: "main",
      sha: "abcdef1",
    });
    await expect(
      provider.createOrUpdateCheckRun({
        ...ref,
        reviewRunId: "rev_1",
        name: "Heimdall",
        headSha: "abcdef1",
        status: "completed",
        conclusion: "success",
        title: "Review complete",
        summary: "No findings",
        annotations,
      }),
    ).resolves.toEqual({
      providerCheckRunId: "15",
      htmlUrl: "https://github.com/acme/api/checks/15",
    });
    await expect(provider.getCloneAuth(ref)).resolves.toMatchObject({
      cloneUrl: "https://github.com/acme/api.git",
      username: "x-access-token",
      password: "ghs_token",
    });
  });

  it("skips already published review comments by hidden marker", async () => {
    const fetcher = createMockFetch([
      tokenRoute,
      {
        match: (url) => url.includes("/repos/acme/api/pulls/7/comments?per_page=100&page=1"),
        response: jsonResponse([
          {
            id: 13,
            body: `Finding\n\n${dedupeMarker("Finding", "rev_1", "fnd_1")}`,
            user: { login: "heimdall[bot]" },
            html_url: "https://github.com/acme/api/pull/7#discussion_r13",
          },
        ]),
      },
    ]);
    const provider = createProvider(fetcher);

    await expect(
      provider.publishReview({
        provider: "github",
        installationId: "99",
        owner: "acme",
        repo: "api",
        pullRequestNumber: 7,
        reviewRunId: "rev_1",
        headSha: "abcdef1",
        body: "Summary",
        comments: [
          { path: "src/index.ts", line: 3, side: "RIGHT", body: "Finding", findingId: "fnd_1" },
        ],
      }),
    ).resolves.toMatchObject({
      providerReviewId: expect.stringMatching(/^review_[A-Za-z0-9_-]{26}$/u),
      commentIds: ["13"],
      commentIdsByFindingId: { fnd_1: "13" },
    });
    expect(fetcher.calls.some((call) => call.url.endsWith("/repos/acme/api/pulls/7/reviews"))).toBe(
      false,
    );
  });

  it("updates an existing check run with a matching review run id", async () => {
    const fetcher = createMockFetch([
      tokenRoute,
      {
        match: (url) =>
          url.endsWith("/repos/acme/api/commits/abcdef1/check-runs?check_name=Heimdall"),
        response: jsonResponse({ check_runs: [{ id: 15, external_id: "rev_1" }] }),
      },
      {
        match: (url, init) =>
          url.endsWith("/repos/acme/api/check-runs/15") && init?.method === "PATCH",
        response: jsonResponse({ id: 15, html_url: "https://github.com/acme/api/checks/15" }),
      },
    ]);
    const provider = createProvider(fetcher);

    await expect(
      provider.createOrUpdateCheckRun({
        provider: "github",
        installationId: "99",
        owner: "acme",
        repo: "api",
        reviewRunId: "rev_1",
        name: "Heimdall",
        headSha: "abcdef1",
        status: "completed",
        conclusion: "success",
        title: "Review complete",
        summary: "No findings",
      }),
    ).resolves.toMatchObject({ providerCheckRunId: "15" });
  });

  it("dedupes summary comments by hidden marker", async () => {
    const fetcher = createMockFetch([
      tokenRoute,
      {
        match: (url) => url.includes("/repos/acme/api/issues/7/comments?per_page=100&page=1"),
        response: jsonResponse([
          {
            id: 14,
            body: `Done\n\n${dedupeMarker("Done", "rev_1")}`,
            user: { login: "heimdall[bot]" },
            html_url: "https://github.com/acme/api/pull/7#issuecomment-14",
          },
        ]),
      },
    ]);
    const provider = createProvider(fetcher);

    await expect(
      provider.publishSummaryComment({
        provider: "github",
        installationId: "99",
        owner: "acme",
        repo: "api",
        pullRequestNumber: 7,
        reviewRunId: "rev_1",
        body: "Done",
      }),
    ).resolves.toEqual({
      providerCommentId: "14",
      htmlUrl: "https://github.com/acme/api/pull/7#issuecomment-14",
    });
    expect(
      fetcher.calls.some((call) => call.url.endsWith("/repos/acme/api/issues/7/comments")),
    ).toBe(false);
  });

  it("provides fake provider coverage for publishing primitives", async () => {
    const provider = createFakeGitProvider();

    await expect(
      provider.publishReview({
        provider: "github",
        installationId: "99",
        owner: "acme",
        repo: "api",
        pullRequestNumber: 7,
        reviewRunId: "rev_1",
        headSha: "abcdef1",
        comments: [
          { path: "src/index.ts", line: 3, side: "RIGHT", body: "Finding", findingId: "fnd_1" },
        ],
      }),
    ).resolves.toMatchObject({
      providerReviewId: expect.stringMatching(/^review_[a-f0-9]{24}$/u),
      commentIds: [expect.stringMatching(/^comment_[a-f0-9]{24}$/u)],
    });
    await provider.publishSummaryComment({
      provider: "github",
      installationId: "99",
      owner: "acme",
      repo: "api",
      pullRequestNumber: 7,
      reviewRunId: "rev_1",
      body: "Summary",
    });
    await provider.publishSummaryComment({
      provider: "github",
      installationId: "99",
      owner: "acme",
      repo: "api",
      pullRequestNumber: 7,
      reviewRunId: "rev_1",
      body: "Summary",
    });
    await provider.createOrUpdateCheckRun({
      provider: "github",
      installationId: "99",
      owner: "acme",
      repo: "api",
      reviewRunId: "rev_1",
      name: "Heimdall",
      headSha: "abcdef1",
      status: "completed",
      conclusion: "success",
      title: "Review complete",
      summary: "Done",
      annotations: [] satisfies CheckRunAnnotation[],
    });

    expect(provider.publishedReviews).toHaveLength(1);
    expect(provider.publishedSummaryComments).toHaveLength(1);
    expect(provider.checkRuns).toHaveLength(1);
  });

  it("maps GitHub API errors to typed provider errors", async () => {
    const provider = createProvider(
      createMockFetch([
        {
          match: (url) => url.endsWith("/app/installations/99/access_tokens"),
          response: jsonResponse({ message: "API rate limit exceeded" }, 403, rateLimitHeaders),
        },
      ]),
    );

    const tokenRequest = provider.getInstallationToken({
      provider: "github",
      installationId: "99",
    });
    await expect(tokenRequest).rejects.toBeInstanceOf(GitHubRateLimitError);
    await expect(tokenRequest).rejects.toMatchObject({
      requestId: "request-1",
      retryAfterSeconds: 60,
      rateLimit: {
        limit: 5000,
        remaining: 4999,
        resetEpochSeconds: 1770000000,
        used: 1,
        resource: "core",
        retryAfterSeconds: 60,
      },
    });

    const notFoundProvider = createProvider(
      createMockFetch([
        tokenRoute,
        {
          match: (url) => url.endsWith("/repos/acme/api"),
          response: jsonResponse({ message: "Not Found" }, 404),
        },
      ]),
    );

    await expect(
      notFoundProvider.fetchRepository({
        provider: "github",
        installationId: "99",
        owner: "acme",
        repo: "api",
      }),
    ).rejects.toBeInstanceOf(GitHubNotFoundError);
  });
});
