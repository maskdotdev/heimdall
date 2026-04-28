# #3 GitHub App Integration — Implementation Spec

**Status:** Draft for implementation  
**Target package:** `/packages/github`  
**Primary app consumers:** `/apps/api`, `/apps/worker`, `/packages/repo-sync`, `/packages/publisher`  
**Stack:** TypeScript, Octokit, Bun/Elysia runtime, Postgres/Drizzle persistence from #2  
**Last reviewed against public GitHub docs:** 2026-04-28

---

## 1. Purpose

This workstream implements the GitHub-facing integration for the code review agent.

The goal is to make the rest of the system interact with GitHub through a small, typed, provider-neutral interface. The review engine, indexer, retriever, memory service, and database layer should not know about Octokit response shapes, GitHub webhook payload quirks, GitHub installation token mechanics, or GitHub-specific comment APIs.

The GitHub integration should own:

```text
GitHub App auth
installation token generation/cache
repository discovery
pull request snapshot fetching
changed file fetching
raw diff fetching
review comment publishing
check run publishing
summary comment publishing
GitHub-specific error/rate-limit handling
GitHub webhook payload normalization helpers
```

The GitHub integration should not own:

```text
webhook HTTP route implementation             -> #4 Webhook Ingestion
business decision to review or skip a PR      -> #16 Review Orchestrator
repo checkout and worktree lifecycle          -> #8 Repo Sync
diff parsing and line-anchor validation        -> #15 PR Snapshot and Diff Model
finding generation                             -> #18 Review Passes
finding validation/ranking                     -> #19 Finding Validation
feedback/memory inference                      -> #21 Feedback and Memory
```

Clean mental model:

```text
GitHub-specific world
  -> /packages/github
  -> provider-neutral contracts
  -> rest of product
```

---

## 2. Design goals

### 2.1 Provider-neutral core

The review system should depend on provider-neutral contracts from `/packages/contracts`:

```ts
PullRequestSnapshot
Repository
ProviderInstallation
InlineComment
ReviewSummary
CheckRunInput
PublishedFinding
```

GitHub-specific fields can exist, but they should be isolated under explicit metadata objects:

```ts
provider: "github"
providerInstallationId: "123456"
providerRepoId: "987654321"
providerMetadata: {
  owner: "acme",
  repo: "api",
  nodeId: "...",
  htmlUrl: "..."
}
```

### 2.2 Installation-token based access

Use GitHub App installation access tokens for server-to-server repository access. Do not use long-lived personal access tokens for repo access.

GitHub installation tokens expire after one hour. The integration should cache tokens with an expiration buffer and regenerate them automatically.

### 2.3 Least privilege

The GitHub App should request only the permissions needed for the product surface.

Default MVP permissions:

```text
Contents:       read
Pull requests:  read/write
Checks:         read/write
Metadata:       read, implicit/required
Issues:         read/write only if using issue comments for PR summaries or slash commands
```

### 2.4 Snapshot-first

When asked to fetch a pull request, this package should return a stable `PullRequestSnapshot` object containing exact SHAs, diff metadata, changed files, labels, author, and raw diff hash.

The review pipeline should operate on that snapshot, not on live mutable GitHub state.

### 2.5 No token leaks

Installation tokens, app private keys, webhook secrets, and client secrets must never be logged, stored in raw review artifacts, included in errors, or added to traces.

### 2.6 Explicit failure modes

The adapter should convert GitHub API failures into typed product errors:

```text
GitHubPermissionError
GitHubRateLimitError
GitHubSecondaryRateLimitError
GitHubNotFoundError
GitHubValidationError
GitHubUnavailableError
GitHubInstallationSuspendedError
GitHubTokenError
GitHubUnknownError
```

### 2.7 Idempotent publishing

Publishing should be safe to retry. Duplicate inline comments are a trust killer.

Every published comment should have:

```text
reviewRunId
findingId
dedupe fingerprint
provider comment id
provider review id if available
headSha
filePath
line/side or position
```

---

## 3. External GitHub docs and constraints

The implementation should be checked against the latest GitHub docs during implementation. The following constraints are important for design:

1. GitHub App permissions determine what APIs the app can access and what webhooks it can receive. GitHub Apps start with no permissions and should use the minimum required permissions.  
   Reference: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app

2. To authenticate as an installation, generate an installation access token, then use it in REST/GraphQL requests. Installation tokens expire after one hour. Octokit can handle regeneration for you, but we should still wrap behavior in our own gateway.  
   Reference: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation

3. GitHub webhook delivery signatures are sent in `X-Hub-Signature-256` and are based on the raw payload body plus webhook secret. Verification must use the raw body, not a parsed JSON body.  
   Reference: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries

4. GitHub webhook deliveries include headers such as `X-GitHub-Event`, `X-GitHub-Delivery`, and `X-Hub-Signature-256`. The delivery ID is globally unique and should be used for idempotency.  
   Reference: https://docs.github.com/en/webhooks/webhook-events-and-payloads

5. Listing pull request files is paginated and GitHub documents a maximum of 3000 returned files for the endpoint. Large PR handling must account for that cap.  
   Reference: https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files

6. Pull request review comments are different from issue comments and commit comments. Inline PR review comments require Pull Requests write permission.  
   Reference: https://docs.github.com/en/rest/pulls/comments

7. GitHub has both `position` and `line`/`side` models for review comments. The docs indicate `position` is closing down for the create review comment endpoint, so prefer `line` + `side` where supported.  
   Reference: https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request

8. Check run creation requires a GitHub App and Checks write permission. OAuth apps and normal users cannot create check suites/runs.  
   Reference: https://docs.github.com/en/rest/checks/runs#create-a-check-run

9. Check run annotations have API limits. GitHub documents a maximum of 50 annotations per API request; more annotations require multiple update calls.  
   Reference: https://docs.github.com/en/rest/checks/runs#update-a-check-run

10. GitHub App installation REST API requests have primary rate limits. The documented minimum for installation access tokens is 5,000 requests/hour, with higher limits for Enterprise Cloud and scaling in some org/repo cases. Secondary rate limits can still apply.  
    Reference: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api

---

## 4. Package scope

Create:

```text
/packages/github
```

This package exports the GitHub adapter and helpers.

Recommended structure:

```text
/packages/github
  package.json
  tsconfig.json
  src/
    index.ts
    config.ts
    errors.ts
    constants.ts
    client/
      github-client-factory.ts
      octokit-types.ts
      request-options.ts
      pagination.ts
      rate-limit.ts
      retry.ts
    auth/
      app-auth-service.ts
      installation-token-cache.ts
      private-key.ts
      webhook-signature.ts
    installations/
      installation-service.ts
      installation-normalizer.ts
      repository-sync.ts
    repositories/
      repository-service.ts
      repository-normalizer.ts
      clone-auth.ts
    pull-requests/
      pull-request-service.ts
      pr-normalizer.ts
      diff-fetcher.ts
      changed-files.ts
      existing-comments.ts
    publishing/
      review-publisher.ts
      inline-comment-mapper.ts
      check-run-publisher.ts
      summary-publisher.ts
      markdown.ts
      dedupe.ts
    webhooks/
      payload-normalizer.ts
      event-types.ts
      event-router.ts
    testing/
      fixtures.ts
      fake-github-adapter.ts
      nock-helpers.ts
```

Public exports should be intentionally small:

```ts
export type { GitProvider } from "./types";
export { createGitHubProvider } from "./github-provider";
export { verifyGitHubWebhookSignature } from "./auth/webhook-signature";
export { normalizeGitHubWebhookEvent } from "./webhooks/payload-normalizer";
export * from "./errors";
```

Avoid exporting low-level Octokit helpers unless needed by tests.

---

## 5. Dependencies

Recommended dependencies:

```json
{
  "dependencies": {
    "@octokit/auth-app": "latest",
    "@octokit/core": "latest",
    "@octokit/plugin-paginate-rest": "latest",
    "@octokit/plugin-retry": "latest",
    "@octokit/plugin-throttling": "latest",
    "@octokit/rest": "latest",
    "@repo/contracts": "workspace:*",
    "@repo/config": "workspace:*",
    "@repo/observability": "workspace:*"
  },
  "devDependencies": {
    "nock": "latest",
    "vitest": "latest"
  }
}
```

Notes:

- `@octokit/rest` is straightforward for REST endpoints.
- `@octokit/auth-app` handles GitHub App JWT and installation auth mechanics.
- Retry/throttling plugins are strongly recommended because the product will make bursts of GitHub calls during PR review and repo sync.
- Keep the adapter wrapped. Do not let Octokit leak into the rest of the product.

---

## 6. Environment configuration

Add GitHub App config to `/packages/config` and consume it in `/packages/github`.

Required MVP environment variables:

```bash
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_PRIVATE_KEY_BASE64=
GITHUB_WEBHOOK_SECRET=
GITHUB_API_BASE_URL=https://api.github.com
GITHUB_WEB_BASE_URL=https://github.com
GITHUB_API_VERSION=2026-03-10
GITHUB_USER_AGENT=review-agent/0.1.0
```

Optional:

```bash
GITHUB_PRIVATE_KEY_PATH=
GITHUB_ENTERPRISE_ENABLED=false
GITHUB_TOKEN_CACHE_TTL_SECONDS=3300
GITHUB_INSTALLATION_TOKEN_EXPIRY_BUFFER_SECONDS=300
GITHUB_MAX_PR_FILES=3000
GITHUB_MAX_DIFF_BYTES=8000000
GITHUB_ENABLE_CHECK_RUNS=true
GITHUB_ENABLE_ISSUE_SUMMARY_COMMENTS=false
GITHUB_ENABLE_REVIEW_COMMENTS=true
GITHUB_ENABLE_REVIEW_SUMMARY=true
```

Private key handling:

```text
Preferred:   GITHUB_PRIVATE_KEY_BASE64
Fallback:    GITHUB_PRIVATE_KEY_PATH
Avoid:       raw multiline private key in .env when possible
```

Implementation:

```ts
export type GitHubConfig = {
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
  apiBaseUrl: string;
  webBaseUrl: string;
  apiVersion: string;
  userAgent: string;
  tokenCacheTtlSeconds: number;
  tokenExpiryBufferSeconds: number;
  maxPrFiles: number;
  maxDiffBytes: number;
  enableCheckRuns: boolean;
  enableIssueSummaryComments: boolean;
  enableReviewComments: boolean;
  enableReviewSummary: boolean;
};
```

Validation rules:

```text
- appId must be non-empty numeric string
- privateKey must parse into PEM form
- webhookSecret must be present in production
- apiBaseUrl and webBaseUrl must be valid URLs
- apiVersion should default to current configured version
```

---

## 7. GitHub App registration

Create one GitHub App per environment:

```text
dev:      review-agent-dev
staging:  review-agent-staging
prod:     review-agent
```

Avoid sharing one app across environments. Webhook delivery, permissions, installations, and callback URLs are easier to reason about when environments are isolated.

### 7.1 App settings

Suggested GitHub App settings:

```text
Homepage URL:       https://your-app.example.com
Webhook URL:        https://api.your-app.example.com/webhooks/github
Webhook secret:     strong random value from secrets manager
Callback URL:       https://your-app.example.com/auth/github/callback, if using GitHub user auth
Setup URL:          https://your-app.example.com/github/setup, optional
Expire user tokens: yes, if using user authorization
```

For MVP, user authorization through the GitHub App can be deferred if dashboard auth is handled separately. Installation access tokens are enough for server-side repo work.

### 7.2 Permissions

Recommended MVP permissions:

| Permission area | Permission | Access | Needed for |
|---|---:|---:|---|
| Repository | Metadata | Read | Basic repo metadata. Usually mandatory for GitHub Apps. |
| Repository | Contents | Read | Git clone/fetch via installation token, file contents if needed, repo archives if used. |
| Repository | Pull requests | Read/write | Fetch PR metadata/files/reviews and create inline review comments. |
| Repository | Checks | Read/write | Create/update check runs. |
| Repository | Issues | Read/write optional | PR conversation comments, summary comments, slash-command replies, issue_comment feedback. |
| Repository | Commit statuses | Read/write optional | Only if using commit statuses instead of Checks. |
| Repository | Actions | None | Not needed unless inspecting workflows/artifacts. |
| Repository | Administration | None | Avoid. Not needed for review agent MVP. |
| Organization | Members | Read optional | Only if dashboard needs org-member validation from GitHub. |

For the initial product, prefer:

```text
Contents:       read
Pull requests:  read/write
Checks:         read/write
Metadata:       read
Issues:         none unless summary comments/slash commands are required
```

If you want PR summary comments in the conversation tab rather than review summaries/check runs, enable Issues write because PR conversation comments are issue comments under GitHub's API model.

### 7.3 Webhook event subscriptions

Subscribe only to events you handle.

MVP:

```text
ping
installation
installation_repositories
pull_request
pull_request_review_comment
```

Recommended once feedback/memory exists:

```text
issue_comment
pull_request_review
check_run
check_suite
reaction
```

Event/action handling:

| Event | Actions | Product behavior |
|---|---|---|
| `ping` | n/a | Verify app/webhook connectivity. Store lightweight event. |
| `installation` | `created` | Store installation, sync repositories, enqueue initial indexing. |
| `installation` | `deleted` | Mark installation inactive, disable repos, stop future reviews. |
| `installation` | `suspend` / `suspended` | Mark installation suspended. Stop API calls except cleanup. |
| `installation` | `unsuspend` / `unsuspended` | Mark active, resync repos. |
| `installation` | `new_permissions_accepted` | Resync permissions/repositories. |
| `installation_repositories` | `added` | Add repos, enqueue indexing if enabled by default. |
| `installation_repositories` | `removed` | Mark repos inaccessible/disabled. |
| `pull_request` | `opened` | Enqueue review if repo enabled and PR eligible. |
| `pull_request` | `synchronize` | Enqueue review for new head SHA. |
| `pull_request` | `reopened` | Enqueue review. |
| `pull_request` | `ready_for_review` | Enqueue review if draft reviews were skipped. |
| `pull_request` | `converted_to_draft` | Cancel/skip pending review jobs if configured. |
| `pull_request` | `labeled` / `unlabeled` | Re-evaluate review rules if labels control review. |
| `pull_request` | `closed` | Mark PR closed/merged, stop pending reviews. |
| `pull_request_review_comment` | `created` | Feedback/memory input; detect replies to bot comments. |
| `pull_request_review_comment` | `edited` | Update feedback/memory input if reply edited. |
| `pull_request_review_comment` | `deleted` | Mark outcome or remove stale feedback reference. |
| `issue_comment` | `created` | Optional slash commands or feedback on summary comments. |
| `check_run` | `rerequested` | Optional rerun review. |
| `check_run` | `requested_action` | Optional UI actions from check runs. |

The webhook HTTP route and persistence are #4. This package should export enough payload normalization helpers to let #4 route events cleanly.

---

## 8. Main provider interface

The rest of the product should consume a provider-neutral interface.

Recommended shape:

```ts
export interface GitProvider {
  provider: "github";

  syncInstallation(input: SyncInstallationInput): Promise<SyncInstallationResult>;
  syncInstallationRepositories(input: SyncInstallationRepositoriesInput): Promise<SyncInstallationRepositoriesResult>;

  fetchRepository(input: FetchRepositoryInput): Promise<Repository>;
  listInstallationRepositories(input: ListInstallationRepositoriesInput): Promise<Repository[]>;

  fetchPullRequestSnapshot(input: FetchPullRequestSnapshotInput): Promise<PullRequestSnapshot>;
  fetchExistingBotComments(input: FetchExistingBotCommentsInput): Promise<ExistingBotComment[]>;

  publishReview(input: PublishReviewInput): Promise<PublishedReview>;
  createOrUpdateCheckRun(input: CreateOrUpdateCheckRunInput): Promise<ProviderCheckRun>;

  getCloneAuth(input: GetCloneAuthInput): Promise<CloneAuth>;
}
```

### 8.1 Inputs

```ts
export type GitHubInstallationRef = {
  provider: "github";
  installationId: string;
};

export type GitHubRepositoryRef = {
  provider: "github";
  installationId: string;
  owner: string;
  repo: string;
  providerRepoId?: string;
};

export type GitHubPullRequestRef = GitHubRepositoryRef & {
  pullRequestNumber: number;
};
```

### 8.2 Output principle

Outputs should be normalized to contracts.

Bad:

```ts
Promise<Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}"]["response"]["data"]>
```

Good:

```ts
Promise<PullRequestSnapshot>
```

Low-level Octokit response types should stay inside `/packages/github`.

---

## 9. Internal service boundaries

Recommended classes/services:

```ts
GitHubClientFactory
GitHubAppAuthService
GitHubInstallationTokenCache
GitHubInstallationService
GitHubRepositoryService
GitHubPullRequestService
GitHubPublisher
GitHubCheckRunPublisher
GitHubWebhookNormalizer
GitHubRateLimitTracker
```

### 9.1 `GitHubClientFactory`

Owns Octokit client construction.

Responsibilities:

```text
- set base URL
- set API version header
- set Accept header
- set User-Agent
- attach retry/throttling plugins
- inject auth token
- redacted request logging
- rate-limit header observation
```

API:

```ts
export interface GitHubClientFactory {
  createAppClient(): Octokit;
  createInstallationClient(input: {
    installationId: string;
    permissions?: Partial<GitHubInstallationPermissions>;
    repositoryIds?: number[];
  }): Promise<Octokit>;
}
```

### 9.2 `GitHubAppAuthService`

Owns GitHub App authentication mechanics.

Responsibilities:

```text
- load private key
- create app JWT when needed
- request installation token
- scope token by repo/permission when useful
- cache installation token
- refresh before expiration
```

### 9.3 `GitHubInstallationService`

Responsibilities:

```text
- get installation metadata
- normalize account/org/user
- sync installation repositories
- handle install/uninstall/suspend state transitions
```

### 9.4 `GitHubRepositoryService`

Responsibilities:

```text
- fetch repository metadata
- list installation repositories
- normalize repositories
- provide clone auth details to repo-sync
```

### 9.5 `GitHubPullRequestService`

Responsibilities:

```text
- fetch PR metadata
- fetch PR changed files with pagination
- fetch raw diff
- fetch existing bot comments
- normalize into PullRequestSnapshot
```

### 9.6 `GitHubPublisher`

Responsibilities:

```text
- create grouped PR review comments
- post or update summary
- create/update check run
- map product findings into GitHub payloads
- handle 422 comment validation failures gracefully
- store provider result metadata for the caller
```

---

## 10. Authentication implementation

### 10.1 Private key loading

```ts
export function loadGitHubPrivateKey(env: Env): string {
  if (env.GITHUB_PRIVATE_KEY_BASE64) {
    return Buffer.from(env.GITHUB_PRIVATE_KEY_BASE64, "base64").toString("utf8");
  }

  if (env.GITHUB_PRIVATE_KEY_PATH) {
    return readFileSync(env.GITHUB_PRIVATE_KEY_PATH, "utf8");
  }

  throw new GitHubConfigError("Missing GitHub private key");
}
```

Validation:

```text
- Must include BEGIN PRIVATE KEY or BEGIN RSA PRIVATE KEY
- Must not be logged
- Must be trimmed safely
```

### 10.2 Installation token cache

Tokens expire after one hour. Cache them with a buffer.

Cache key:

```text
github:installation-token:{installationId}:{repoScopeHash}:{permissionScopeHash}
```

MVP can use in-memory cache per process. For multi-worker deployments, use Redis if token churn or rate limits become an issue.

Data shape:

```ts
export type InstallationTokenCacheEntry = {
  token: string;
  expiresAt: Date;
  permissions: Record<string, string>;
  repositorySelection?: "all" | "selected";
  repositoryIds?: number[];
};
```

Fetch rule:

```ts
function shouldRefresh(entry: InstallationTokenCacheEntry, now: Date, bufferSeconds: number): boolean {
  return entry.expiresAt.getTime() - now.getTime() < bufferSeconds * 1000;
}
```

Concurrency rule:

```text
If 50 jobs ask for the same installation token at the same time, only one should call GitHub.
The others should await the same promise.
```

Pseudo-code:

```ts
const pending = new Map<string, Promise<InstallationTokenCacheEntry>>();

async function getInstallationToken(input: TokenInput): Promise<InstallationTokenCacheEntry> {
  const key = makeTokenCacheKey(input);
  const cached = cache.get(key);

  if (cached && !shouldRefresh(cached, new Date(), config.expiryBufferSeconds)) {
    return cached;
  }

  const existing = pending.get(key);
  if (existing) return existing;

  const promise = requestInstallationToken(input)
    .then((entry) => {
      cache.set(key, entry);
      return entry;
    })
    .finally(() => pending.delete(key));

  pending.set(key, promise);
  return promise;
}
```

### 10.3 Scoped tokens

GitHub allows installation tokens to be scoped down by repository and permissions. Use this when passing clone credentials into repo-sync or sandboxed code.

Recommended policy:

```text
API calls in adapter:        normal installation token
Repo sync clone/fetch:       token scoped to one repository, Contents read only
Publisher comments/checks:   token scoped to one repository, Pull requests/Checks write only if practical
```

Do not overcomplicate MVP, but design the interface to support scoping.

### 10.4 Clone auth

`/packages/repo-sync` should not know how to mint GitHub tokens. It should ask this package for clone credentials.

```ts
export type CloneAuth = {
  provider: "github";
  cloneUrl: string;
  username: "x-access-token";
  password: string;
  expiresAt: string;
};
```

Important:

```text
- Never log cloneUrl with token in it.
- Prefer cloneUrl without embedded token plus username/password values.
- If shelling out to git, pass token through a credential helper or carefully redacted environment.
```

---

## 11. Webhook signature verification helper

The Elysia route is #4, but `/packages/github` should expose verification.

Signature function:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGitHubWebhookSignature(input: {
  rawBody: Buffer | Uint8Array | string;
  signatureHeader: string | undefined;
  secret: string;
}): boolean {
  const { rawBody, signatureHeader, secret } = input;

  if (!signatureHeader?.startsWith("sha256=")) return false;

  const bodyBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(rawBody);

  const expected = `sha256=${createHmac("sha256", secret)
    .update(bodyBuffer)
    .digest("hex")}`;

  const actualBuffer = Buffer.from(signatureHeader, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
```

Route requirements for #4:

```text
- capture raw body before JSON parsing
- read X-Hub-Signature-256
- read X-GitHub-Delivery
- read X-GitHub-Event
- reject invalid signatures before doing business logic
- store delivery ID for idempotency
```

Never verify against `JSON.stringify(parsedBody)` because whitespace, escaping, and ordering can change.

---

## 12. Installation sync

### 12.1 `installation.created`

Flow:

```text
Receive normalized event
  -> upsert provider_installations
  -> list installation repositories
  -> upsert repositories
  -> apply default repository settings
  -> enqueue repo.index for enabled repos, if default auto-enable is true
```

Implementation API:

```ts
export async function syncInstallation(input: {
  installationId: string;
  accountLogin?: string;
  reason: "webhook" | "manual" | "startup";
}): Promise<SyncInstallationResult>;
```

Result:

```ts
export type SyncInstallationResult = {
  installation: ProviderInstallation;
  repositories: Repository[];
  addedRepositoryIds: string[];
  removedRepositoryIds: string[];
  updatedRepositoryIds: string[];
};
```

### 12.2 `installation.deleted`

Do not delete rows. Mark inaccessible.

```text
provider_installations.status = 'deleted'
repositories.access_status = 'removed'
repository_settings.enabled = false
```

Reason:

```text
- preserve review history
- preserve billing/audit history
- prevent accidental data loss
- allow clean re-install handling
```

### 12.3 Suspended installations

When suspended:

```text
provider_installations.status = 'suspended'
repositories.access_status = 'suspended'
```

Pending jobs should skip with a typed reason:

```text
github_installation_suspended
```

### 12.4 Repository additions/removals

For `installation_repositories.added`:

```text
- upsert new repositories
- create default settings
- enqueue index job if auto-enabled
```

For `installation_repositories.removed`:

```text
- mark repositories removed/inaccessible
- disable settings
- cancel pending reviews/indexing if job system supports cancellation
```

---

## 13. Repository discovery and normalization

### 13.1 Repository shape

Normalize GitHub repository payloads into `/packages/contracts`:

```ts
export type Repository = {
  id: RepoId;
  provider: "github";
  providerRepoId: string;
  installationId: InstallationId;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string | null;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  htmlUrl: string;
  cloneUrl: string;
  accessStatus: "active" | "removed" | "suspended" | "unknown";
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  syncedAt: ISODateTime;
};
```

### 13.2 Repository identity

Use app-generated internal IDs, not GitHub IDs as primary keys.

Recommended stable mapping:

```text
provider = github
providerRepoId = repository.id from GitHub
```

Internal ID may be:

```text
repo_{ulid}
```

Unique constraint:

```sql
unique(provider, provider_repo_id)
```

This allows repository renames without breaking identity.

### 13.3 Pagination

Implement generic pagination helper:

```ts
export async function paginate<T>(input: {
  octokit: Octokit;
  route: string;
  parameters: Record<string, unknown>;
  perPage?: number;
  maxPages?: number;
}): Promise<T[]>;
```

For repository listing, use max `per_page` supported by the endpoint.

---

## 14. Pull request snapshot fetching

This is one of the most important parts of the adapter.

### 14.1 Public API

```ts
export async function fetchPullRequestSnapshot(input: {
  installationId: string;
  owner: string;
  repo: string;
  pullRequestNumber: number;
}): Promise<PullRequestSnapshot>;
```

### 14.2 Fetch sequence

Recommended sequence:

```text
1. Create installation Octokit client
2. GET pull request metadata
3. List pull request files with pagination
4. Fetch raw unified diff
5. Compute diffHash
6. Normalize changed files
7. Normalize labels, author, base/head refs
8. Return PullRequestSnapshot
```

Pseudo-code:

```ts
async function fetchPullRequestSnapshot(input: FetchPullRequestSnapshotInput): Promise<PullRequestSnapshot> {
  const octokit = await clientFactory.createInstallationClient({
    installationId: input.installationId,
  });

  const pr = await octokit.rest.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullRequestNumber,
  });

  const files = await paginatePullRequestFiles({
    octokit,
    owner: input.owner,
    repo: input.repo,
    pullNumber: input.pullRequestNumber,
  });

  const rawDiff = await fetchPullRequestDiff({
    octokit,
    owner: input.owner,
    repo: input.repo,
    pullNumber: input.pullRequestNumber,
  });

  return normalizePullRequestSnapshot({
    provider: "github",
    installationId: input.installationId,
    pr: pr.data,
    files,
    rawDiff,
    fetchedAt: new Date(),
  });
}
```

### 14.3 Pull request metadata to capture

Capture at minimum:

```text
provider
providerRepoId
repoId if known
installationId
owner
repo
pullRequestNumber
providerPullRequestId
htmlUrl
apiUrl
state
isDraft
isMerged if closed/known
title
body
authorLogin
authorAssociation
baseRefName
baseSha
baseRepoFullName
headRefName
headSha
headRepoFullName
headRepoOwner
headRepoIsFork
mergeCommitSha if available
labels
createdAt
updatedAt
fetchedAt
```

### 14.4 Changed files to capture

For each file:

```text
path
previousPath if renamed
status: added | modified | removed | renamed | copied | changed | unchanged
additions
deletions
changes
patch if GitHub includes it
sha/blob sha if available
rawUrl/blobUrl if useful
isBinary if inferred
isTruncated if patch missing/truncated
```

GitHub may omit or truncate patch content for very large files. The snapshot should preserve this state explicitly.

### 14.5 Raw diff fetching

Fetch with GitHub's diff media type:

```ts
const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
  owner,
  repo,
  pull_number: pullNumber,
  headers: {
    accept: "application/vnd.github.v3.diff",
  },
});
```

Store:

```text
rawDiff in object storage via #16/#29 artifact handling, or return it to caller
rawDiffHash in PullRequestSnapshot
diffBytes
isDiffTruncated if exceeds configured max
```

Do not store extremely large raw diffs inline in Postgres.

### 14.6 Large PR handling

Limits/policies:

```text
maxPrFiles:       default 3000 because GitHub list files endpoint caps there
maxDiffBytes:     configurable, e.g. 8 MB
maxPatchBytes:    configurable per file
```

If exceeded:

```text
PullRequestSnapshot.isTruncated = true
PullRequestSnapshot.truncationReason = 'too_many_files' | 'diff_too_large' | 'patch_missing'
```

Review orchestrator can then choose:

```text
- summary only
- skip with explanation
- use git checkout diff via repo-sync
- review only high-signal files
```

### 14.7 Fork PRs

PRs from forks require careful handling.

Capture:

```text
baseRepoFullName
headRepoFullName
headRepoIsFork
headSha
baseSha
```

For repo checkout, prefer fetching the PR ref from the base repository when possible:

```text
refs/pull/{number}/head
refs/pull/{number}/merge, if useful
```

Do not assume the app is installed on the fork. For private forks or deleted forks, access may be limited. The GitHub adapter should return the metadata accurately; repo-sync should handle checkout fallback.

### 14.8 Draft PR policy

The adapter should expose `isDraft`. It should not decide whether to skip. The review orchestrator/repo settings should decide.

---

## 15. Existing bot comments and duplicate prevention

Before publishing new comments, fetch existing bot comments for the PR.

### 15.1 Why

We need to prevent:

```text
- duplicate comments after retry
- duplicate comments after PR synchronize
- duplicate summary comments
- stale check run confusion
```

### 15.2 Existing comment fetch

Use PR review comment listing for inline comments:

```ts
GET /repos/{owner}/{repo}/pulls/{pull_number}/comments
```

Use issue comments if summary comments are enabled:

```ts
GET /repos/{owner}/{repo}/issues/{issue_number}/comments
```

Normalize only comments authored by the app/bot and/or containing hidden markers.

### 15.3 Hidden markers

Every bot comment should include hidden metadata:

```md
<!-- review-agent:finding-id=find_01HX... -->
<!-- review-agent:review-run-id=rrun_01HX... -->
<!-- review-agent:fingerprint=sha256:abc... -->
```

Summary comment:

```md
<!-- review-agent:summary repo-id=repo_... pr=123 -->
```

Fingerprint should be stable across retries:

```ts
fingerprint = sha256([
  repoId,
  pullRequestNumber,
  headSha,
  filePath,
  line,
  category,
  normalizedTitle,
  normalizedEvidenceHash,
].join("\n"));
```

Potential policy:

```text
same fingerprint + same headSha       -> do not repost
same fingerprint + new headSha        -> update or let old comment become outdated, then repost only if still valid
same findingId                         -> do not repost
```

---

## 16. Publishing inline review comments

### 16.1 Publishing modes

Support multiple modes:

Use the canonical `PublishMode` contract from #0. The GitHub adapter maps those provider-neutral modes onto grouped PR reviews, issue comments, and check runs.

Recommended MVP:

```text
- create check run at start/completion
- create a pull request review with inline comments and summary body when comments exist
- use check run summary if no inline comments
```

### 16.2 Public API

```ts
export async function publishReview(input: {
  installationId: string;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headSha: string;
  reviewRunId: string;
  summaryMarkdown: string;
  comments: InlineReviewComment[];
  mode: PublishMode;
}): Promise<PublishedReview>;
```

### 16.3 Inline review comment contract

```ts
export type InlineReviewComment = {
  findingId: string;
  filePath: string;
  bodyMarkdown: string;
  line: number;
  side: "RIGHT" | "LEFT";
  startLine?: number;
  startSide?: "RIGHT" | "LEFT";
  fallbackPosition?: number;
  fingerprint: string;
};
```

Preferred GitHub payload:

```ts
{
  path: comment.filePath,
  line: comment.line,
  side: comment.side,
  start_line: comment.startLine,
  start_side: comment.startSide,
  body: withHiddenMetadata(comment.bodyMarkdown, comment),
}
```

Fallback only if needed:

```ts
{
  path,
  position,
  body,
}
```

### 16.4 Batch review creation

Use `Create a review for a pull request` for grouped comments:

```ts
await octokit.rest.pulls.createReview({
  owner,
  repo,
  pull_number: pullRequestNumber,
  commit_id: headSha,
  body: summaryMarkdown,
  event: "COMMENT",
  comments: comments.map(toGitHubReviewComment),
});
```

Benefits:

```text
- comments appear as one bot review
- fewer notifications than individual comment calls
- easier to reason about published review metadata
```

Potential downside:

```text
- one invalid comment can fail the whole review with 422
```

Mitigation:

```text
1. pre-validate line anchors in #19
2. on 422, retry with comments removed one at a time or in halves to isolate invalid anchors
3. fallback invalid comments to check annotations or summary text
```

### 16.5 422 handling strategy

GitHub returns 422 for invalid review comment locations or spam/validation failures.

Recommended algorithm:

```text
Attempt grouped review with all comments.
If success: done.
If 422:
  - split comments into halves
  - retry each half
  - recursively isolate failing comments
  - publish valid comments
  - record invalid comments as publishing failures
  - include invalid but important findings in check run summary if needed
```

Do not silently drop failed comments. Store provider publish failures in `published_findings` or review artifacts.

### 16.6 Comment body format

Keep comments concise and actionable.

Template:

```md
**Potential issue:** Session expiration is not checked before accepting the token.

This path now accepts `validateSessionToken()` results without checking `expiresAt`, while the existing middleware rejects expired sessions before loading user state.

Suggested fix: reject sessions whose `expiresAt` is before `Date.now()` before returning the user.

<!-- review-agent:finding-id=find_... -->
<!-- review-agent:review-run-id=rrun_... -->
<!-- review-agent:fingerprint=sha256:... -->
```

Avoid:

```text
- giant explanations
- style nits
- speculative language without evidence
- raw prompt/model metadata visible to users
```

---

## 17. Publishing PR summaries

Two viable approaches:

### 17.1 Review body summary

When creating a PR review, include summary in `body`.

Pros:

```text
- requires only Pull requests write permission
- tied naturally to inline review comments
- less permission surface
```

Cons:

```text
- harder to update later
- can be buried in review timeline
```

### 17.2 Issue comment summary

Create or update an issue comment on the PR conversation.

Pros:

```text
- easy to update one persistent bot summary
- easy to support slash commands/replies later
- visible in conversation tab
```

Cons:

```text
- requires Issues write permission
- more risk of noisy conversation
```

MVP recommendation:

```text
Use review body summary by default.
Enable issue comment summary only for teams that want persistent summaries or commands.
```

### 17.3 Summary content

Template:

```md
## AI review summary

Reviewed commit `abc1234`.

Found **3 high-confidence issues**:

1. Missing session expiration check in `src/auth/session.ts`.
2. New API path bypasses existing input validation in `src/routes/users.ts`.
3. Tests do not cover the failed update path.

No comments were posted for low-confidence or style-only observations.

<!-- review-agent:summary review-run-id=rrun_... head-sha=abc123... -->
```

If no issues:

```md
## AI review summary

Reviewed commit `abc1234`. I did not find any high-confidence issues worth commenting on.

<!-- review-agent:summary review-run-id=rrun_... head-sha=abc123... -->
```

---

## 18. Check run publishing

Checks are useful for:

```text
- showing review status while analysis is running
- providing summary even when no inline comments are posted
- surfacing non-commentable findings as annotations
- supporting re-run actions later
```

### 18.1 Public API

```ts
export async function createOrUpdateCheckRun(input: {
  installationId: string;
  owner: string;
  repo: string;
  headSha: string;
  reviewRunId: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "neutral" | "failure" | "canceled" | "timed_out" | "action_required" | "skipped";
  title: string;
  summaryMarkdown: string;
  textMarkdown?: string;
  annotations?: CheckRunAnnotation[];
  detailsUrl?: string;
}): Promise<ProviderCheckRun>;
```

### 18.2 Check run lifecycle

On review job start:

```text
create check run:
  name: AI Code Review
  head_sha: PR head SHA
  status: in_progress
  external_id: reviewRunId
  details_url: dashboard review run URL
```

On review complete:

```text
update check run:
  status: completed
  conclusion:
    success  -> no publishable issues
    neutral  -> issues found but not blocking
    failure  -> critical issues if configured as blocking
  output.title
  output.summary
  output.text
  annotations
```

### 18.3 Annotation policy

Use annotations for:

```text
- findings that are useful but not worth inline comments
- findings whose line could not be commented on
- static analyzer diagnostics
```

Respect GitHub's annotation batch limit:

```text
max 50 annotations per create/update request
```

Implementation:

```ts
for (const batch of chunk(annotations, 50)) {
  await octokit.rest.checks.update({
    owner,
    repo,
    check_run_id: checkRunId,
    output: {
      title,
      summary,
      annotations: batch,
    },
  });
}
```

### 18.4 Conclusion policy

Recommended default:

```text
success: no publishable findings
neutral: one or more non-critical findings
failure: critical finding and repo setting says checks should fail
```

Do not fail checks by default. Teams should opt into blocking behavior.

---

## 19. Markdown rendering

Keep rendering in `/packages/github/publishing/markdown.ts` because GitHub-specific Markdown features and hidden markers are provider-specific.

Functions:

```ts
renderFindingComment(finding: ValidatedFinding, metadata: CommentMetadata): string
renderReviewSummary(input: ReviewSummaryInput): string
renderCheckRunSummary(input: CheckRunSummaryInput): string
appendHiddenMetadata(markdown: string, metadata: Record<string, string>): string
extractHiddenMetadata(markdown: string): Record<string, string>
```

Rules:

```text
- keep inline comments under configured character budget
- include hidden metadata markers
- do not include raw prompt/model output
- escape or sanitize user-controlled strings where needed
- redact secrets from code snippets before rendering if not already redacted
```

Visible severity labels:

```text
Critical
High
Medium
Low, rarely published
```

Possible template:

```md
**High confidence correctness issue**

{body}

**Why this matters:** {impact}

**Suggested fix:** {suggestedFix}

<!-- review-agent:finding-id=... -->
```

---

## 20. Rate limit and retry handling

### 20.1 Capture rate limit headers

For every GitHub response, capture if available:

```text
x-ratelimit-limit
x-ratelimit-remaining
x-ratelimit-reset
x-ratelimit-used
x-ratelimit-resource
retry-after
```

Emit metrics:

```text
github.request.count
github.request.latency_ms
github.rate_limit.remaining
github.rate_limit.reset_seconds
github.secondary_rate_limit.count
github.error.count
```

Dimensions:

```text
installationId
owner
repo
endpoint group
status
method
```

Do not include raw URLs with tokens.

### 20.2 Retry policy

Retry:

```text
- 502
- 503
- 504
- network timeouts
- selected 403 secondary rate limit after backoff
```

Do not retry blindly:

```text
- 401 token invalid without refreshing first
- 403 missing permission
- 404 not found unless consistency race is suspected
- 422 validation failure
```

Backoff:

```text
exponential backoff + jitter
respect Retry-After header
respect x-ratelimit-reset when primary rate limit exhausted
```

### 20.3 Secondary rate limits

GitHub can apply secondary limits for bursty behavior. Protect publishing especially:

```text
- group inline comments into one review
- avoid posting too many summary updates
- limit concurrent requests per installation
- queue publish operations with per-installation concurrency
```

Recommended queue-level concurrency:

```text
per installation GitHub API concurrency: 5-10 initially
per repo publish concurrency: 1
```

---

## 21. Error model

Define typed errors:

```ts
export class GitHubError extends Error {
  readonly provider = "github";
  constructor(
    message: string,
    public readonly details: {
      status?: number;
      endpoint?: string;
      installationId?: string;
      owner?: string;
      repo?: string;
      requestId?: string;
      rateLimit?: GitHubRateLimitState;
      cause?: unknown;
    },
  ) {
    super(message);
  }
}

export class GitHubPermissionError extends GitHubError {}
export class GitHubRateLimitError extends GitHubError {}
export class GitHubSecondaryRateLimitError extends GitHubError {}
export class GitHubNotFoundError extends GitHubError {}
export class GitHubValidationError extends GitHubError {}
export class GitHubUnavailableError extends GitHubError {}
export class GitHubInstallationSuspendedError extends GitHubError {}
export class GitHubTokenError extends GitHubError {}
export class GitHubConfigError extends GitHubError {}
```

Error mapping:

| GitHub status/signal | Product error |
|---|---|
| 401 | `GitHubTokenError`, refresh token once then retry |
| 403 + permission signal | `GitHubPermissionError` |
| 403 + rate limit headers exhausted | `GitHubRateLimitError` |
| 403 + secondary rate message | `GitHubSecondaryRateLimitError` |
| 404 | `GitHubNotFoundError` |
| 422 | `GitHubValidationError` |
| 502/503/504 | `GitHubUnavailableError` |

When returning errors to API/dashboard:

```text
- never include token
- never include private key
- never include full raw webhook payload by default
- include GitHub request ID if available
- include endpoint group, not full secret-bearing URL
```

---

## 22. Webhook payload normalization

The webhook HTTP route will live in #4, but this package should provide normalization helpers.

### 22.1 Normalized event

```ts
export type NormalizedGitHubWebhookEvent = {
  provider: "github";
  deliveryId: string;
  eventName: string;
  action?: string;
  installationId?: string;
  providerRepoId?: string;
  owner?: string;
  repo?: string;
  pullRequestNumber?: number;
  senderLogin?: string;
  occurredAt: string;
  payloadHash: string;
  rawHeaders: Record<string, string>;
  normalized: Record<string, unknown>;
};
```

### 22.2 Normalization function

```ts
export function normalizeGitHubWebhookEvent(input: {
  headers: Record<string, string | undefined>;
  payload: unknown;
  rawBody: Buffer | Uint8Array | string;
}): NormalizedGitHubWebhookEvent;
```

Rules:

```text
- deliveryId from X-GitHub-Delivery
- eventName from X-GitHub-Event
- action from payload.action if present
- installationId from payload.installation.id if present
- providerRepoId from payload.repository.id if present
- owner/repo from payload.repository.full_name if present
- pullRequestNumber from payload.pull_request.number or issue.number if issue.pull_request exists
- payloadHash = sha256(rawBody)
```

### 22.3 Event-specific helpers

```ts
isPullRequestEvent(event): boolean
isInstallationEvent(event): boolean
isReviewCommentEvent(event): boolean
isIssueCommentOnPullRequest(event): boolean
getPullRequestRefFromEvent(event): GitHubPullRequestRef | null
getInstallationRefFromEvent(event): GitHubInstallationRef | null
```

Do not put database writes here.

---

## 23. Database integration points

This package should not own Drizzle table definitions, but it should return data that maps cleanly to #2 tables.

### 23.1 Tables touched by callers

The API/worker layers will use results from this package to update:

```text
provider_installations
repositories
repository_settings
webhook_events
pull_requests
pull_request_snapshots
review_runs
published_findings
finding_outcomes
usage_events
```

### 23.2 Adapter should not write directly by default

Recommended:

```text
/packages/github returns normalized objects
/apps/worker or service layer persists them in transactions
```

Reason:

```text
- easier tests
- less coupling to DB
- easier provider replacement
- clearer transaction boundaries
```

Exception:

```text
If you later create a provider service package that owns persistence, keep it above /packages/github rather than inside it.
```

---

## 24. Pull request review command support, optional

Optional future support:

```text
@agent review again
@agent explain finding X
@agent ignore this finding
@agent summarize
```

This requires:

```text
- issue_comment webhook
- permission to read/write Issues comments
- command parser
- actor authorization
- enqueueing jobs
```

Do not implement command execution in `/packages/github`.

This package can provide:

```ts
extractPullRequestCommandFromIssueComment(event): PullRequestCommand | null
```

But command handling should live in a higher-level service.

---

## 25. Security requirements

### 25.1 Secrets

Never log:

```text
GITHUB_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
GITHUB_CLIENT_SECRET
installation access tokens
clone passwords
Authorization headers
raw signed webhook body when it might contain private repo data
```

### 25.2 Token handling

```text
- installation tokens should generally be in memory/Redis only
- do not persist installation access tokens in Postgres
- clone tokens should be short-lived and scoped when practical
- redact tokens from command args, logs, traces, errors
```

### 25.3 Webhook validation

```text
- reject invalid signatures
- use raw body
- use constant-time comparison
- enforce reasonable body size limit
- store payload hash for replay/debug
- idempotency by delivery ID
```

### 25.4 Repo path safety

GitHub file paths should be normalized before passing to repo-sync/indexer/publisher.

Rules:

```text
- no absolute paths
- no path traversal
- no NUL bytes
- preserve case
- preserve forward slashes
```

### 25.5 GitHub Enterprise Server

If GHES support is planned:

```text
- configurable apiBaseUrl
- configurable webBaseUrl
- configurable upload/api URLs if needed
- potentially different API version behavior
- enterprise installations may have different constraints
```

Do not hardcode `github.com` except in defaults.

---

## 26. Observability

Emit structured logs and traces for each provider operation.

### 26.1 Trace spans

Recommended spans:

```text
github.create_installation_client
github.list_installation_repositories
github.fetch_pull_request
github.fetch_pull_request_files
github.fetch_pull_request_diff
github.create_review
github.create_check_run
github.update_check_run
github.list_review_comments
```

Span attributes:

```text
provider=github
installation_id
owner
repo
pull_request_number
endpoint_group
http_status
rate_limit_remaining
rate_limit_reset
request_id
```

Do not include:

```text
token
raw Authorization header
private repo source code
full raw diff by default
```

### 26.2 Metrics

```text
github_api_requests_total
github_api_request_duration_ms
github_api_errors_total
github_rate_limit_remaining
github_secondary_rate_limit_total
github_installation_token_refresh_total
github_pr_snapshot_fetch_duration_ms
github_publish_review_duration_ms
github_publish_comment_failures_total
```

### 26.3 Review-run correlation

When called from review/publish jobs, pass `reviewRunId` into log context.

```ts
logger.info("publishing GitHub review", {
  reviewRunId,
  installationId,
  owner,
  repo,
  pullRequestNumber,
  commentCount,
});
```

---

## 27. Testing strategy

### 27.1 Unit tests

Test:

```text
- config validation
- private key loading
- webhook signature verification
- token cache refresh logic
- token cache concurrency de-dupe
- repository normalization
- PR normalization
- changed file normalization
- hidden marker rendering/extraction
- error mapping
- rate-limit header parsing
```

### 27.2 Contract tests

Use fixtures that represent real GitHub payload shapes:

```text
fixtures/github/webhooks/installation.created.json
fixtures/github/webhooks/installation.deleted.json
fixtures/github/webhooks/installation_repositories.added.json
fixtures/github/webhooks/pull_request.opened.json
fixtures/github/webhooks/pull_request.synchronize.json
fixtures/github/webhooks/pull_request_review_comment.created.json
fixtures/github/rest/pull-request.get.json
fixtures/github/rest/pull-request-files.list.json
fixtures/github/rest/review-comments.list.json
```

Validate that normalized outputs satisfy `/packages/contracts` schemas.

### 27.3 HTTP mocking tests

Use `nock` or equivalent to test Octokit calls without network.

Cases:

```text
- list installation repositories paginated
- fetch PR snapshot happy path
- fetch PR files over multiple pages
- fetch PR files at cap/truncated state
- fetch raw diff with diff accept header
- create review happy path
- create review 422 fallback
- create check run and update annotations in batches
- 401 token refresh retry
- 403 permission error
- 403 rate limit error
- 404 repo removed
```

### 27.4 Integration tests, optional

Use a dedicated private test org and test repo with the dev GitHub App installed.

Test manually or in gated CI:

```text
- install app
- sync repos
- open PR
- fetch snapshot
- publish review comment
- publish check run
- rerun same publish and confirm no duplicate comments
- uninstall app and confirm disabled repos
```

Do not run live GitHub integration tests in every PR unless secrets and rate limits are carefully managed.

---

## 28. Fake GitHub adapter

Create a fake adapter for higher-level tests.

```ts
export class FakeGitProvider implements GitProvider {
  snapshots = new Map<string, PullRequestSnapshot>();
  publishedReviews: PublishReviewInput[] = [];
  checkRuns: CreateOrUpdateCheckRunInput[] = [];

  async fetchPullRequestSnapshot(input: FetchPullRequestSnapshotInput) {
    const key = `${input.owner}/${input.repo}#${input.pullRequestNumber}`;
    const snapshot = this.snapshots.get(key);
    if (!snapshot) throw new Error(`No fake snapshot for ${key}`);
    return snapshot;
  }

  async publishReview(input: PublishReviewInput) {
    this.publishedReviews.push(input);
    return makeFakePublishedReview(input);
  }
}
```

This lets review orchestrator tests avoid Octokit entirely.

---

## 29. Implementation order

### PR 1: package shell and config

```text
- create /packages/github
- add package.json/tsconfig
- add GitHubConfig schema in /packages/config
- add constants and errors
- add public exports
- add basic tests
```

Definition of done:

```text
- package builds
- config validates
- errors are typed
```

### PR 2: auth and client factory

```text
- private key loader
- installation token cache
- Octokit client factory
- retry/throttle setup
- rate-limit header parser
- unit tests for token cache
```

Definition of done:

```text
- can create installation client using test credentials in manual test
- token cache refreshes before expiration
- secrets are redacted in logs
```

### PR 3: webhook verification and normalization helpers

```text
- verifyGitHubWebhookSignature
- normalizeGitHubWebhookEvent
- event type helpers
- webhook fixture tests
```

Definition of done:

```text
- valid signatures pass
- invalid signatures fail
- delivery/event/action/installation/repo/PR fields normalize correctly
```

### PR 4: installation and repository sync

```text
- list installation repositories
- normalize installation metadata
- normalize repositories
- pagination helper
- fake fixtures
```

Definition of done:

```text
- installation.created can be converted into normalized installation + repositories
- repository renames preserve providerRepoId identity
```

### PR 5: PR snapshot fetcher

```text
- GET PR metadata
- list PR files with pagination
- fetch raw diff
- normalize PullRequestSnapshot
- large PR/truncated flags
```

Definition of done:

```text
- snapshot satisfies contract schema
- head/base SHAs correct
- changed files and raw diff hash captured
```

### PR 6: existing bot comment fetch and markers

```text
- list PR review comments
- optional issue comment fetch
- hidden metadata extract/render
- duplicate fingerprint utilities
```

Definition of done:

```text
- can identify prior bot comments by hidden marker
- can derive stable dedupe fingerprints
```

### PR 7: review publisher

```text
- render inline comment bodies
- create grouped PR review
- handle 422 fallback
- return PublishedReview metadata
```

Definition of done:

```text
- publishes grouped review in manual test repo
- retry does not duplicate comments when existing markers are present
```

### PR 8: check run publisher

```text
- create check run
- update check run
- annotation batching
- conclusion policy helper
```

Definition of done:

```text
- check run appears on PR head commit
- annotations are batched at <= 50 per request
```

### PR 9: docs and hardening

```text
- integration docs
- permission checklist
- manual test runbook
- rate-limit dashboards
- GHES configuration notes
```

Definition of done:

```text
- a new developer can create/install dev GitHub App and verify end-to-end PR review publishing
```

---

## 30. Manual test runbook

### 30.1 Create dev app

```text
1. Create GitHub App in dev account/org.
2. Add webhook URL pointing to local tunnel or staging API.
3. Add webhook secret from secrets manager.
4. Set permissions.
5. Subscribe to MVP events.
6. Generate private key.
7. Base64 encode private key and set env var.
8. Install app on a test repository.
```

### 30.2 Verify auth

Run:

```bash
pnpm dev:github:auth-check
```

Expected:

```text
- app authentication succeeds
- installation token generated
- list repositories returns test repo
```

### 30.3 Verify webhook

```text
1. Redeliver ping from GitHub App settings.
2. Confirm signature validation passes.
3. Confirm webhook_events row persisted by #4.
4. Confirm normalized event logs show delivery ID.
```

### 30.4 Verify PR snapshot

```bash
pnpm dev:github:fetch-pr --owner acme --repo test-repo --pr 1
```

Expected:

```text
- baseSha/headSha present
- changed files present
- raw diff hash present
- snapshot validates against contract
```

### 30.5 Verify publishing

```bash
pnpm dev:github:publish-test-review --owner acme --repo test-repo --pr 1
```

Expected:

```text
- one GitHub review appears
- inline comment appears on valid changed line
- hidden metadata exists
- published result contains provider comment/review IDs
```

### 30.6 Verify idempotency

Run same command again.

Expected:

```text
- no duplicate inline comment
- logs explain duplicate skip
```

### 30.7 Verify check run

```bash
pnpm dev:github:create-test-check --owner acme --repo test-repo --sha HEAD_SHA
```

Expected:

```text
- check run appears on commit/PR
- check run updates to completed
- annotations appear if included
```

---

## 31. CLI/dev tools

Add developer commands through `/apps/worker` or `/packages/github` scripts:

```text
pnpm github:auth-check
pnpm github:list-installations
pnpm github:list-repos --installation-id 123
pnpm github:fetch-pr --owner acme --repo api --pr 42
pnpm github:fetch-diff --owner acme --repo api --pr 42
pnpm github:list-comments --owner acme --repo api --pr 42
pnpm github:publish-test-review --owner acme --repo api --pr 42
pnpm github:create-test-check --owner acme --repo api --sha abc123
pnpm github:verify-webhook-fixture fixtures/github/webhooks/pull_request.opened.json
```

These should be safe-by-default:

```text
- require explicit --confirm for publishing commands
- print redacted config only
- never print tokens
```

---

## 32. Open questions

Resolve before or during implementation:

1. Should PR summaries be review-body only for MVP, or issue comments too?
2. Do we want check runs enabled by default, or only after inline comments are working?
3. Do we want to fail checks for critical findings, or always use neutral by default?
4. Will dashboard auth use GitHub App user authorization, separate OAuth, or another auth provider?
5. Do we need GitHub Enterprise Server support in MVP?
6. Do we support PRs from forks immediately, or mark some fork cases as summary-only until repo-sync is hardened?
7. Should installation tokens be cached per process only or shared through Redis from day one?
8. Should we use GraphQL for some PR metadata batching, or keep MVP REST-only?

Recommended MVP answers:

```text
1. Review-body summary only.
2. Check runs enabled by default.
3. Never fail checks by default; use neutral unless configured.
4. Separate decision in #5 API/Auth.
5. Configurable base URLs now, full GHES testing later.
6. Support fork metadata and diff; repo-sync handles checkout fallback.
7. In-memory token cache first.
8. REST-only first.
```

---

## 33. Definition of done for #3

#3 is complete when:

```text
- /packages/github exists and builds
- GitHub config validates
- webhook signature helper works against fixtures
- installation token generation/cache works
- installation repository listing works
- repository normalization works
- PR snapshot fetching works
- changed files and raw diff are captured
- existing bot comments can be found by hidden markers
- grouped PR review publishing works
- check run create/update works
- GitHub errors map to typed product errors
- basic rate-limit headers are observed
- fake adapter exists for higher-level tests
- manual dev app runbook succeeds on a test repository
```

Minimum MVP acceptance test:

```text
Install dev GitHub App on a test repo.
Open a PR.
Fetch PullRequestSnapshot.
Publish one inline comment and one check run.
Re-run publish.
Confirm no duplicate comment.
```

---

## 34. Summary architecture

The GitHub package should be a replaceable provider adapter:

```text
GitHub App + Octokit + REST API
        |
        v
/packages/github
        |
        v
Provider-neutral contracts
        |
        +--> #4 webhook ingestion
        +--> #8 repo sync
        +--> #16 review orchestrator
        +--> #20 publisher
        +--> #21 memory
```

The critical design rule:

```text
No Octokit response shape should leak past /packages/github.
No GitHub token should leak into logs, DB rows, traces, review artifacts, or model prompts.
```

That keeps the integration easy to test, easy to replace, and safe enough to touch private source code.
