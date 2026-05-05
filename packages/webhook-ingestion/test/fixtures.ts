/** GitHub installation webhook fixture. */
export const installationPayload = {
  action: "created",
  installation: {
    id: 123456,
    created_at: "2026-01-01T00:00:00Z",
    account: {
      id: 42,
      login: "acme",
      type: "Organization",
    },
    permissions: {
      contents: "read",
      pull_requests: "write",
    },
  },
  repositories: [
    {
      id: 987654,
      name: "heimdall",
      full_name: "acme/heimdall",
      private: true,
      archived: false,
      fork: false,
      default_branch: "main",
      clone_url: "https://github.com/acme/heimdall.git",
      owner: {
        login: "acme",
      },
    },
  ],
} as const;

/** GitHub pull_request webhook fixture. */
export const pullRequestPayload = {
  action: "opened",
  installation: installationPayload.installation,
  repository: installationPayload.repositories[0],
  pull_request: {
    id: 555,
    number: 7,
    title: "Improve webhook ingestion",
    body: "Adds durable webhook handling.",
    state: "open",
    draft: false,
    additions: 12,
    deletions: 3,
    changed_files: 2,
    merge_commit_sha: "1234567",
    author_association: "CONTRIBUTOR",
    user: {
      login: "octocat",
    },
    labels: [
      {
        name: "ready-for-review",
      },
    ],
    base: {
      ref: "main",
      sha: "1111111",
    },
    head: {
      ref: "feature/webhooks",
      sha: "2222222",
    },
  },
} as const;
