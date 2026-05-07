# GitHub Dev App Runbook

Use this runbook to create a development GitHub App, install it on a test repository, and verify the
GitHub provider path with the guarded smoke commands.

Do not use a production GitHub App or a production repository for this runbook.

## Prerequisites

- A GitHub organization or account that can create GitHub Apps.
- A disposable repository where the app can create a throwaway branch and PR.
- Local Postgres and Redis from `compose.yaml`.
- A local copy of `.env.smoke.example` at `.env.smoke.local`.

## Create The App

1. Create a GitHub App for the development environment.
2. Set the webhook URL to the local tunnel or staging API URL that reaches `/webhooks/github`.
3. Set the webhook secret to the same value as `GITHUB_WEBHOOK_SECRET`.
4. Enable these repository permissions:

| Permission | Access | Required for |
| --- | --- | --- |
| Metadata | Read | Repository identity and installation metadata. |
| Contents | Read | Runtime clone and PR snapshot fetches. |
| Contents | Write | The guarded live PR smoke, unless you use a separate mutation token. |
| Pull requests | Read/write | PR metadata, review comments, and PR updates in the smoke. |
| Checks | Read/write | Check run creation and updates. |
| Issues | Read/write | Summary comments when enabled. |

5. Subscribe to `ping`, `installation`, `installation_repositories`, and `pull_request`.
6. Generate a private key for the app.
7. Install the app on the disposable test repository.

## Configure Local Smoke

Copy `.env.smoke.example` to `.env.smoke.local`, then set:

```bash
GITHUB_APP_ID="<dev app id>"
GITHUB_PRIVATE_KEY="<pem private key with \\n line breaks>"
GITHUB_WEBHOOK_SECRET="<dev webhook secret>"
HEIMDALL_GITHUB_SMOKE_PROVIDER_INSTALLATION_ID="<GitHub installation id>"
HEIMDALL_GITHUB_SMOKE_OWNER="<owner>"
HEIMDALL_GITHUB_SMOKE_REPO="<repo>"
HEIMDALL_GITHUB_SMOKE_PR="<existing disposable PR number>"
HEIMDALL_GITHUB_SMOKE_ALLOW_WRITE=true
```

Set `HEIMDALL_GITHUB_SMOKE_INSTALLATION_ID` only when the local Heimdall installation ID differs
from the GitHub provider installation ID.

For the full PR review smoke, set:

```bash
HEIMDALL_GITHUB_REVIEW_SMOKE_WEBHOOK_URL="http://localhost:3000/webhooks/github"
HEIMDALL_GITHUB_REVIEW_SMOKE_BRANCH="heimdall/smoke-pr-review"
HEIMDALL_GITHUB_REVIEW_SMOKE_FILE="heimdall-smoke/pr-review-smoke.txt"
```

If the app has `Contents: read` only, set `HEIMDALL_GITHUB_REVIEW_SMOKE_MUTATION_TOKEN` to a
short-lived token that can update the disposable branch, or set
`HEIMDALL_GITHUB_REVIEW_SMOKE_GH_TOKEN_FALLBACK=true` to use the active `gh auth token`.

## Prepare Local Services

Run migrations and start local dependencies:

```bash
pnpm infra:prepare
```

Start the API and worker in separate terminals:

```bash
pnpm smoke:api
pnpm smoke:worker
```

## Verify Publishing

Run the publisher smoke against the existing disposable PR:

```bash
pnpm --filter @repo/admin-tools smoke:publisher:github
```

Expected result:

- The command exits with status `0`.
- GitHub shows a Heimdall check run on the PR head commit.
- GitHub shows the fallback summary comment when summary comments are enabled.
- The command prints provider IDs for the check run and comment.

Run the command a second time.

Expected result:

- The smoke exits with status `0`.
- The PR does not receive duplicate comments for the same smoke review run.

Run the stale-head smoke mode:

```bash
HEIMDALL_GITHUB_SMOKE_MODE=stale_head pnpm --filter @repo/admin-tools smoke:publisher:github
```

Expected result:

- The command exits with status `0`.
- The JSON output includes `"mode": "stale_head"` and `"staleHead": true`.
- GitHub does not receive a new check run, PR review, or summary comment for that smoke run.

## Verify Webhook-To-Publish

Run the full guarded smoke:

```bash
pnpm smoke:review:github
```

Expected result:

- The command creates or updates the configured throwaway branch.
- The command opens or updates the smoke PR.
- The local API accepts the signed `pull_request` webhook.
- The worker completes review and publish jobs.
- The command prints `webhookEventId`, `reviewRunId`, job IDs, `publishRunId`, check run ID, and
  published comment or review IDs.

Record the printed JSON as runbook evidence when using this result to close Phase 3 acceptance.

## Verify Rate-Limit Observation

The GitHub provider parses `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`,
`x-ratelimit-used`, `x-ratelimit-resource`, and `retry-after` headers for each received GitHub
response. To inspect the latest observations in code, call
`GitHubAppProvider.getRecentRequestObservations()`. To wire metrics, pass `observeRequest` to
`createGitHubProvider`.

Expected result:

- Successful responses expose status, method, path, request ID, latency, and rate-limit values when
  GitHub returns those headers.
- Typed provider errors include the same parsed `rateLimit` snapshot.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `401` or token errors | Confirm `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY` match the same app. |
| `403` permission errors | Confirm the app is installed on the repository and has the required permission. |
| Branch mutation returns `403` | Grant `Contents: write`, set `HEIMDALL_GITHUB_REVIEW_SMOKE_MUTATION_TOKEN`, or enable the guarded `gh` fallback. |
| Webhook signature failure | Confirm the app webhook secret and `GITHUB_WEBHOOK_SECRET` match. |
| Worker does not complete | Confirm `pnpm smoke:worker` is running with the same database and Redis URLs as the API. |
| Duplicate comments appear | Confirm the smoke uses the same review run path and hidden markers are present in prior comments. |
