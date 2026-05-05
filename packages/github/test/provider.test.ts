import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GitHubFetch } from "../src";
import { createGitHubProvider, GitHubNotFoundError, GitHubRateLimitError } from "../src";

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

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "x-github-request-id": "request-1" },
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

const createProvider = (fetcher: GitHubFetch) =>
  createGitHubProvider(
    {
      appId: "12345",
      privateKey,
      tokenExpiryBufferSeconds: 300,
    },
    {
      fetch: fetcher,
      now: () => new Date("2026-05-05T12:00:00.000Z"),
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

describe("GitHubAppProvider", () => {
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
          additions: 3,
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
            additions: 3,
            deletions: 1,
            changes: 4,
            patch: "@@ -1 +1 @@",
          },
        ]),
      },
      {
        match: (url, init) =>
          url.endsWith("/repos/acme/api/pulls/7") &&
          (init?.headers as Record<string, string> | undefined)?.accept ===
            "application/vnd.github.v3.diff",
        response: textResponse("diff --git a/src/index.ts b/src/index.ts\n"),
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
          additions: 3,
          deletions: 1,
          isBinary: false,
        },
      ],
      diffHash: "sha256:1bf4fcc26d8874b8c276b08749bf22799ae398f9f1681bb02d3dd828cef8df3e",
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
    const fetcher = createMockFetch([
      tokenRoute,
      {
        match: (url) => url.includes("/repos/acme/api/pulls/7/comments?per_page=100&page=1"),
        response: jsonResponse([]),
      },
      {
        match: (url) => url.endsWith("/repos/acme/api/pulls/7/reviews"),
        response: jsonResponse({ id: 12, comments: [{ id: 13 }] }),
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
        comments: [{ path: "src/index.ts", line: 3, side: "RIGHT", body: "Finding" }],
      }),
    ).resolves.toEqual({ providerReviewId: "12", commentIds: ["13"] });
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
    ).resolves.toEqual({
      providerReviewId: expect.stringMatching(/^review_[a-f0-9]{32}$/u),
      commentIds: ["13"],
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

  it("maps GitHub API errors to typed provider errors", async () => {
    const provider = createProvider(
      createMockFetch([
        {
          match: (url) => url.endsWith("/app/installations/99/access_tokens"),
          response: jsonResponse({ message: "API rate limit exceeded" }, 403),
        },
      ]),
    );

    await expect(
      provider.getInstallationToken({ provider: "github", installationId: "99" }),
    ).rejects.toBeInstanceOf(GitHubRateLimitError);

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
