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

/** GitHub issue_comment webhook fixture for a PR-level comment. */
export const issueCommentPayload = {
  action: "created",
  installation: installationPayload.installation,
  repository: installationPayload.repositories[0],
  issue: {
    id: 777,
    number: 7,
    pull_request: {
      url: "https://api.github.com/repos/acme/heimdall/pulls/7",
    },
  },
  comment: {
    id: 888,
    author_association: "MEMBER",
    body: "@heimdall false positive on finding fnd_123",
    user: {
      login: "maintainer",
      type: "User",
    },
  },
  sender: {
    login: "maintainer",
    type: "User",
  },
} as const;

/** GitHub reaction webhook fixture for a reaction on a PR comment. */
export const reactionPayload = {
  action: "created",
  installation: installationPayload.installation,
  repository: installationPayload.repositories[0],
  issue: {
    id: 777,
    number: 7,
    pull_request: {
      url: "https://api.github.com/repos/acme/heimdall/pulls/7",
    },
  },
  comment: {
    id: 888,
    user: {
      login: "heimdall-app",
    },
  },
  reaction: {
    id: 999,
    content: "-1",
    user: {
      login: "maintainer",
    },
  },
  sender: {
    login: "maintainer",
  },
} as const;

/** GitHub pull_request_review_thread webhook fixture for a resolved bot thread. */
export const reviewThreadPayload = {
  action: "resolved",
  installation: installationPayload.installation,
  repository: installationPayload.repositories[0],
  pull_request: {
    number: 7,
  },
  thread: {
    id: 444,
    is_resolved: true,
    author_association: "MEMBER",
    comments: [
      {
        id: 888,
        user: {
          login: "heimdall-app",
          type: "Bot",
        },
      },
    ],
    user: {
      login: "maintainer",
      type: "User",
    },
  },
  sender: {
    login: "maintainer",
    type: "User",
  },
} as const;
