# #20 Publisher Implementation Spec

Status: Draft for implementation  
Last updated: 2026-04-28  
Primary package: `/packages/publisher`  
Primary worker job: `review.publish`  
Primary external provider for MVP: GitHub

---

## 1. Purpose

The Publisher is the final outbound boundary of the review system.

It consumes a validated, deduplicated, ranked `PublishPlan` from #19 and turns it into provider-specific external artifacts:

```text
ValidatedFinding[]
+ ReviewSummary
+ CheckRunPlan
+ repository settings
+ provider metadata
    -> PublishPlan
    -> GitHub pull request review
    -> GitHub inline review comments
    -> GitHub PR summary comment
    -> GitHub check run
    -> persisted PublishedFinding / PublishedReview / PublishedCheckRun rows
```

The Publisher does **not** decide whether a finding is correct. It does **not** call LLMs. It does **not** retrieve code. It does **not** validate line anchors from scratch except as a defensive last-mile check.

Its job is to safely publish already-approved review output and make every external side effect idempotent, observable, and recoverable.

The central rule:

```text
The Publisher only publishes a PublishPlan.
It never publishes raw CandidateFinding[] directly.
```

---

## 2. Design goals

### 2.1 Product goals

The Publisher should:

```text
- post useful inline comments on PR diffs
- post a concise PR-level review summary
- optionally create/update a GitHub Check Run
- avoid duplicate comments
- avoid stale comments on old commits
- avoid noisy notifications
- handle GitHub validation failures gracefully
- record every external ID for future feedback processing
- make manual and automated replay safe
```

### 2.2 Engineering goals

The Publisher should be:

```text
- provider-aware but review-engine-agnostic
- idempotent
- retry-safe
- rate-limit-aware
- easy to test with fake providers
- easy to extend to GitLab later
- deeply observable
- conservative with external writes
```

### 2.3 Trust goals

The Publisher is where the product becomes visible to developers. It must prioritize trust:

```text
- no duplicate comments
- no comments on stale commits
- no comments with broken anchors
- no overconfident wording
- no leaking prompts, raw context bundles, tokens, or secrets
- no hidden policy surprises
- no automatic approval or request-changes behavior in MVP
```

---

## 3. Non-goals

The Publisher should not implement:

```text
- LLM review logic
- context retrieval
- finding correctness validation
- ranking logic
- memory learning
- webhook ingestion
- GitHub App authentication internals
- raw diff parsing
- repo checkout
- index access
```

Those belong to other sections:

```text
#3  GitHub App Integration
#4  Webhook Ingestion
#14 Retrieval Engine
#15 PR Snapshot and Diff Model
#16 Review Orchestrator
#18 Review Passes
#19 Finding Validation, Dedupe, and Ranking
#21 Feedback and Memory System
```

---

## 4. Important GitHub constraints

These are the external constraints the Publisher must respect.

### 4.1 PR review comments are diff comments

GitHub pull request review comments are comments on a pull request diff. They are different from regular issue comments. For line comments, GitHub supports `line`, `side`, and optionally `start_line` / `start_side` for multi-line comments. The older `position` parameter is documented as closing down, so the MVP should prefer the modern line/side parameters.

Source: https://docs.github.com/en/rest/pulls/comments

### 4.2 Review comments need the correct commit

When creating a PR review comment, GitHub requires `commit_id`; using an old commit can cause comments to become outdated if the relevant line changes. The Publisher should publish only when the review run `headSha` still matches the current PR head SHA.

Source: https://docs.github.com/en/rest/pulls/comments

### 4.3 Pull request reviews group inline comments

GitHub pull request reviews can group review comments with a review state and optional summary body. For MVP, use review event `COMMENT`, not `APPROVE` or `REQUEST_CHANGES`.

Source: https://docs.github.com/en/rest/pulls/reviews

### 4.4 Pull requests are also issues for timeline comments

A PR-level timeline comment is created through the Issues Comments API because every pull request is also an issue. The Publisher should use issue comments for reusable summary comments when it wants an updateable summary separate from the grouped PR review.

Source: https://docs.github.com/en/rest/issues/comments

### 4.5 Check Runs require a GitHub App

Write access to the Checks API is only available to GitHub Apps, and creating check runs requires the `Checks` repository permission with write access.

Source: https://docs.github.com/en/rest/checks/runs

### 4.6 Check Run annotations are limited per request

GitHub Check Run annotations are limited to 50 annotations per API request. To attach more than 50 annotations, the app must make multiple update requests, and each update appends annotations.

Source: https://docs.github.com/en/rest/checks/runs

### 4.7 Secondary rate limits matter

GitHub enforces secondary rate limits, including content-generation limits. The official docs mention no more than 80 content-generating requests per minute and no more than 500 per hour in general, with some endpoints lower. The Publisher should throttle writes by installation and repository.

Source: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api

---

## 5. High-level architecture

```text
review.publish job
    |
    v
PublisherWorker
    |
    v
PublishService
    |
    +--> load ReviewRun
    +--> load PublishPlan
    +--> load Repository + ProviderInstallation
    +--> acquire publish lock
    +--> verify PR is still current
    +--> create/update Check Run: in_progress
    +--> fetch existing bot comments/reviews/checks
    +--> render markdown bodies
    +--> prepare provider operations
    +--> execute GitHub operations with throttling
    +--> persist external IDs
    +--> create/update Check Run: completed
    +--> mark publish complete
```

Provider-specific details stay behind the GitHub adapter and publisher provider interface.

```text
/packages/publisher
    |
    +--> provider-neutral publish logic
    +--> publish plan loading
    +--> staleness/idempotency/dedupe
    +--> markdown rendering
    +--> persistence
    +--> metrics

/packages/github
    |
    +--> GitHub REST calls
    +--> Octokit usage
    +--> provider response normalization
    +--> token handling
```

The Publisher may call functions from `/packages/github`, but no lower-level component should call GitHub directly for publishing.

---

## 6. Package layout

```text
/packages/publisher
  package.json
  tsconfig.json
  src/
    index.ts

    contracts/
      publish-plan.ts
      published-artifact.ts
      provider.ts
      errors.ts
      markdown.ts

    service/
      publish-service.ts
      publish-state-machine.ts
      publish-locks.ts
      staleness-guard.ts
      idempotency.ts
      existing-artifact-loader.ts
      publish-result-recorder.ts

    render/
      markdown-renderer.ts
      inline-comment-renderer.ts
      summary-renderer.ts
      check-run-renderer.ts
      hidden-marker.ts
      sanitization.ts

    github/
      github-publisher.ts
      github-anchor-mapper.ts
      github-review-builder.ts
      github-summary-comment.ts
      github-check-run.ts
      github-rate-limit.ts
      github-error-map.ts

    db/
      publish-repository.ts
      published-findings-repository.ts
      published-reviews-repository.ts
      published-check-runs-repository.ts

    jobs/
      publish-review-job-handler.ts
      reconcile-publishing-job-handler.ts

    testing/
      fake-publisher.ts
      fake-github-publisher.ts
      fixtures.ts
      assertions.ts
```

MVP can collapse some files, but keep these conceptual boundaries.

---

## 7. Inputs and outputs

### 7.1 Input: `PublishReviewJob`

From #7 queue contracts:

```ts
export type PublishReviewJob = {
  jobType: "review.publish";
  reviewRunId: ReviewRunId;
  publishPlanId: PublishPlanId;
  repoId: RepoId;
  pullRequestNumber: number;
  installationId: InstallationId;
  headSha: GitCommitSha;
  attempt: number;
  requestedAt: IsoDateTime;
};
```

### 7.2 Input: `PublishPlan`

Produced by #19.

```ts
export type PublishPlan = {
  schemaVersion: "publish_plan.v1";
  publishPlanId: PublishPlanId;
  reviewRunId: ReviewRunId;
  repoId: RepoId;
  pullRequestNumber: number;
  baseSha: GitCommitSha;
  headSha: GitCommitSha;

  mode: PublishMode;
  summary: ReviewSummaryPlan;
  inlineComments: InlineCommentPlan[];
  checkRun: CheckRunPlan | null;

  budgets: PublishBudgets;
  createdAt: IsoDateTime;
};
```

### 7.3 Output: `PublishResult`

```ts
export type PublishResult = {
  schemaVersion: "publish_result.v1";
  publishRunId: PublishRunId;
  publishPlanId: PublishPlanId;
  reviewRunId: ReviewRunId;
  repoId: RepoId;
  pullRequestNumber: number;
  headSha: GitCommitSha;

  status: "published" | "partially_published" | "skipped" | "failed";
  skipReason?: PublishSkipReason;
  failureReason?: PublishFailureReason;

  externalArtifacts: PublishedExternalArtifact[];
  publishedFindingIds: PublishedFindingId[];
  startedAt: IsoDateTime;
  completedAt: IsoDateTime;
};
```

### 7.4 External artifact types

```ts
export type PublishedExternalArtifact =
  | PublishedPullRequestReview
  | PublishedReviewComment
  | PublishedIssueComment
  | PublishedCheckRun;
```

---

## 8. Provider-neutral interface

The review orchestrator should depend on this package-level interface, not on GitHub-specific operations.

```ts
export interface ReviewPublisher {
  publishReview(input: PublishReviewInput): Promise<PublishResult>;
}

export type PublishReviewInput = {
  reviewRunId: ReviewRunId;
  publishPlanId: PublishPlanId;
  requestedBy: "worker" | "manual_replay" | "admin";
  dryRun?: boolean;
};
```

The GitHub implementation:

```ts
export class GitHubReviewPublisher implements ReviewPublisher {
  async publishReview(input: PublishReviewInput): Promise<PublishResult> {
    // load plan, guard, publish, persist
  }
}
```

Provider-specific lower-level interface:

```ts
export interface ProviderPublisher {
  getCurrentPullRequestState(input: ProviderPRRef): Promise<ProviderPRState>;
  listExistingBotArtifacts(input: ProviderPRRef): Promise<ExistingProviderArtifacts>;
  createPullRequestReview(input: CreateProviderReviewInput): Promise<ProviderReviewResult>;
  createOrUpdateSummaryComment(input: SummaryCommentInput): Promise<ProviderIssueCommentResult>;
  createOrUpdateCheckRun(input: CheckRunPublishInput): Promise<ProviderCheckRunResult>;
}
```

For MVP, only `GitHubProviderPublisher` is implemented.

---

## 9. Publish modes

The Publisher should support these modes because different teams will want different visibility levels.

Use the canonical `PublishMode` contract from #0:

```text
disabled | summary_only | inline_comments_only | check_run_only | inline_comments_and_summary | inline_comments_summary_and_check_run
```

Recommended MVP default:

```text
inline_comments_and_summary
```

Optional check run can be enabled per repo later.

### 9.1 Mode behavior

| Mode | Inline review comments | PR summary | Check run |
|---|---:|---:|---:|
| `disabled` | No | No | No |
| `summary_only` | No | Yes | Optional later |
| `inline_comments_only` | Yes | No | No |
| `check_run_only` | No | No | Yes |
| `inline_comments_and_summary` | Yes | Yes | No |
| `inline_comments_summary_and_check_run` | Yes | Yes | Yes |

### 9.2 Safe default for no findings

If the review finds nothing publishable:

```text
Default: post nothing, unless repo setting says summary_on_clean_review=true.
```

For teams that want explicit confirmation, support:

```ts
summaryOnNoFindings: boolean;
```

---

## 10. Publishing strategy recommendation

Use **three separate channels**, each with a distinct purpose.

### 10.1 Inline comments

Use inline PR review comments for high-confidence, line-specific findings.

```text
Purpose: actionable feedback on exact code lines.
Use for: correctness, security, missing validation, broken contract, risky logic.
Avoid for: long summaries, general observations, low-confidence notes.
```

### 10.2 PR summary comment

Use a PR-level issue comment for a compact summary.

```text
Purpose: stable overview of the bot review.
Use for: number of findings, highest severity, links, skipped status, review metadata.
Behavior: update existing bot summary comment for this PR/headSha when possible.
```

### 10.3 Check run

Use Check Runs for structured status and optional annotations.

```text
Purpose: machine-readable status and Checks tab visibility.
Use for: completed/in_progress status, summary, annotations when inline comments are disabled or as complement.
Default: optional in MVP.
```

---

## 11. Database ownership

#2 is the canonical schema owner for publisher persistence. It defines `publish_runs`, `published_reviews`, `published_findings`, `published_summary_comments`, `published_check_runs`, and `publish_operations`.

This phase owns publish behavior and repository interfaces only. It must not redefine publisher table columns, indexes, or status vocabularies.

Operation types:

```text
fetch_current_pr_state
list_existing_artifacts
create_pr_review
create_review_comment
create_summary_comment
update_summary_comment
create_check_run
update_check_run
persist_external_ids
```

---

## 12. Idempotency model

Publishing is dangerous because it creates user-visible side effects. Every write must be idempotent.

### 12.1 Publish run idempotency key

```ts
const publishRunIdempotencyKey = hash([
  "publish_run.v1",
  publishPlanId,
  reviewRunId,
  repoId,
  pullRequestNumber,
  headSha,
  mode,
]);
```

If the same publish job is retried, it should resolve to the same `publish_run` row.

### 12.2 Finding fingerprint

#19 should produce stable finding fingerprints. The Publisher relies on them.

```ts
const findingPublicationKey = hash([
  "published_finding.v1",
  repoId,
  pullRequestNumber,
  headSha,
  finding.fingerprint,
  finding.filePath,
  finding.anchor.line,
  finding.anchor.side,
]);
```

### 12.3 Hidden markers

Every bot-created comment should include a hidden HTML marker.

```md
<!-- ai-reviewer
review_run_id=rr_123
publish_plan_id=pp_456
validated_finding_id=vf_789
fingerprint=sha256:abc
head_sha=abc123
-->
```

Rules:

```text
- Marker must be at the bottom of the comment.
- Marker must not contain secrets, prompts, or raw code context.
- Marker must include enough data to dedupe and map feedback later.
- Marker must be robust to Markdown rendering.
```

### 12.4 Summary marker

Summary comments need a different marker:

```md
<!-- ai-reviewer-summary
repo_id=repo_123
pull_request_number=42
review_run_id=rr_123
head_sha=abc123
-->
```

This allows summary updates instead of summary duplication.

### 12.5 Database uniqueness

Use uniqueness constraints as the final guard:

```text
unique(repo_id, pull_request_number, head_sha, fingerprint, artifact_type)
unique(review_run_id, publish_plan_id, mode)
unique(provider, external_comment_id)
unique(provider, external_review_id)
unique(provider, external_check_run_id)
```

---

## 13. Staleness guard

Before publishing anything, the Publisher must confirm the PR still points at the review run `headSha`.

```ts
async function assertCurrentHead(input: {
  repoId: RepoId;
  pullRequestNumber: number;
  expectedHeadSha: GitCommitSha;
}): Promise<StalenessResult> {
  const current = await provider.getCurrentPullRequestState(input);

  if (current.state !== "open") {
    return { ok: false, reason: "pull_request_not_open" };
  }

  if (current.headSha !== input.expectedHeadSha) {
    return {
      ok: false,
      reason: "head_sha_changed",
      currentHeadSha: current.headSha,
    };
  }

  return { ok: true, current };
}
```

If stale:

```text
- do not publish inline comments
- do not publish summary comments by default
- mark publish run skipped: head_sha_changed
- let webhook/review orchestration schedule a new review for latest head
```

Optional advanced behavior:

```text
- update check run on old head as skipped/stale if one already exists
- never comment on the PR timeline just to say the bot was stale
```

---

## 14. Publish state machine

```text
pending
  -> acquiring_lock
  -> checking_staleness
  -> preparing
  -> publishing_check_run_started
  -> publishing_review
  -> publishing_summary
  -> publishing_check_run_completed
  -> recording_results
  -> published
```

Alternative terminal paths:

```text
skipped
failed
partially_published
canceled
```

State transition table:

| State | Description | Retryable? |
|---|---|---:|
| `pending` | Publish run created | Yes |
| `acquiring_lock` | Acquiring repo/PR publish lock | Yes |
| `checking_staleness` | Confirming current PR head | Yes |
| `preparing` | Loading plan, existing comments, rendering bodies | Yes |
| `publishing_check_run_started` | Creating/updating in-progress check run | Yes |
| `publishing_review` | Creating grouped PR review/comments | Partially |
| `publishing_summary` | Creating/updating PR summary | Yes |
| `publishing_check_run_completed` | Completing check run | Yes |
| `recording_results` | Persisting external IDs | Yes |
| `published` | All intended artifacts published | Terminal |
| `partially_published` | Some artifacts published, some failed | Terminal or retryable depending on failure |
| `skipped` | No external publish due to policy/staleness | Terminal |
| `failed` | Could not publish | Terminal or retryable |

---

## 15. Publish flow

### 15.1 Worker handler

```ts
export async function handlePublishReviewJob(job: PublishReviewJob): Promise<void> {
  await publisher.publishReview({
    reviewRunId: job.reviewRunId,
    publishPlanId: job.publishPlanId,
    requestedBy: "worker",
  });
}
```

### 15.2 Service flow

```ts
export async function publishReview(input: PublishReviewInput): Promise<PublishResult> {
  const publishRun = await repository.getOrCreatePublishRun(input);

  return withPublishLock(publishRun.lockKey, async () => {
    const plan = await repository.loadPublishPlan(input.publishPlanId);
    const reviewRun = await repository.loadReviewRun(input.reviewRunId);
    const repo = await repository.loadRepository(plan.repoId);

    await state.transition(publishRun.id, "checking_staleness");
    const staleness = await stalenessGuard.check(plan);
    if (!staleness.ok) {
      return skipPublish(publishRun, staleness.reason);
    }

    await state.transition(publishRun.id, "preparing");
    const existing = await provider.listExistingBotArtifacts(plan.providerRef);
    const rendered = await renderer.render(plan, existing);
    const operations = await operationPlanner.plan({ plan, existing, rendered });

    const results: PublishedExternalArtifact[] = [];

    if (operations.checkRunStart) {
      results.push(await provider.createOrUpdateCheckRun(operations.checkRunStart));
    }

    if (operations.pullRequestReview) {
      results.push(await provider.createPullRequestReview(operations.pullRequestReview));
    }

    if (operations.summaryComment) {
      results.push(await provider.createOrUpdateSummaryComment(operations.summaryComment));
    }

    if (operations.checkRunComplete) {
      results.push(await provider.createOrUpdateCheckRun(operations.checkRunComplete));
    }

    return await recorder.recordPublishedArtifacts(publishRun, results);
  });
}
```

---

## 16. Operation planning

The Publisher should plan all external operations before executing them.

```ts
export type PublishOperationPlan = {
  checkRunStart?: CheckRunPublishInput;
  pullRequestReview?: CreateProviderReviewInput;
  summaryComment?: SummaryCommentInput;
  checkRunComplete?: CheckRunPublishInput;
};
```

Operation planning decides:

```text
- whether to create or update a summary comment
- whether comments are already published
- whether to skip a duplicate finding
- whether check run should be created or updated
- whether check run annotations are needed
- whether inline comments need splitting into batches
```

Do not interleave planning with GitHub writes unless necessary.

---

## 17. Existing artifact loading

Before publishing, fetch existing bot artifacts.

### 17.1 Load from DB first

```text
published_reviews
published_findings
published_summary_comments
published_check_runs
```

### 17.2 Verify against provider when needed

Fetch from GitHub when:

```text
- DB says publish happened but job is retrying after a crash
- DB is missing external IDs for a previous partial publish
- manual replay is requested
- summary comment may exist from before DB migration
```

### 17.3 What to inspect on GitHub

For MVP:

```text
- PR review comments by bot user
- issue comments on PR by bot user
- reviews by bot user
- existing check runs with configured check name and external_id
```

### 17.4 Marker parsing

```ts
export type ParsedHiddenMarker = {
  markerKind: "finding" | "summary";
  reviewRunId?: ReviewRunId;
  publishPlanId?: PublishPlanId;
  validatedFindingId?: ValidatedFindingId;
  fingerprint?: string;
  headSha?: GitCommitSha;
};
```

If marker is missing, do not assume it is ours unless the author is the app and the body has a known prefix. Legacy behavior can be added later.

---

## 18. GitHub inline review publishing

### 18.1 Prefer grouped PR reviews

For most publish plans, create one grouped pull request review with multiple comments.

```ts
type CreateGitHubReviewInput = {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
  event: "COMMENT";
  body?: string;
  comments: GitHubReviewCommentInput[];
};
```

```ts
type GitHubReviewCommentInput = {
  path: string;
  body: string;
  line: number;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  subject_type?: "line" | "file";
};
```

MVP rule:

```text
Always use event=COMMENT.
Never use APPROVE.
Never use REQUEST_CHANGES unless explicitly enabled later by repo setting.
```

### 18.2 Why grouped reviews

Grouped reviews are better than posting individual review comments because:

```text
- fewer notification bursts
- one logical review artifact
- easier feedback mapping
- cleaner PR UI
- fewer content-generating API requests
```

### 18.3 Review body

The grouped review body should be short.

Example:

```md
AI review found 3 high-confidence issues worth checking.

- 1 high severity security issue
- 2 medium severity correctness issues

Full run: <dashboard-url>
```

If a separate summary comment is enabled, keep the review body even shorter:

```md
AI review added 3 inline comments. See the summary comment for details.
```

### 18.4 Comment anchor rules

The Publisher receives already-validated anchors from #19. It should still assert:

```text
- file path exists in snapshot diff
- line is commentable
- side is LEFT or RIGHT
- headSha matches current PR head
- deleted lines use LEFT
- added/context lines use RIGHT
- multi-line ranges are valid and contiguous in the diff
```

If the anchor is invalid at publish time:

```text
- skip that comment
- mark finding publication status as skipped_invalid_anchor
- continue with other comments if safe
- include skipped count in publish diagnostics, not necessarily PR summary
```

### 18.5 File-level comments

GitHub supports `subject_type=file` for file-level review comments. Use this sparingly.

Recommended MVP policy:

```text
- Do not use file-level comments for normal findings.
- Allow file-level comments only for finding categories that cannot be line-anchored but are high value, such as missing file-wide tests or missing migration file.
- Prefer summary-only fallback instead of file-level comments if unsure.
```

### 18.6 Multi-line comments

Support later after single-line comments are stable.

MVP:

```text
- Single-line inline comments only.
```

Phase 2:

```text
- Multi-line comments using start_line/start_side/line/side.
```

### 18.7 Handling one invalid comment in a grouped review

GitHub may reject the whole review if one comment is invalid. Use a defensive strategy.

MVP strategy:

```text
1. Pre-validate all anchors.
2. Submit grouped review.
3. If 422 validation failure occurs:
   - mark grouped review attempt failed
   - try binary search or per-comment fallback only if safe
   - publish valid comments in a smaller grouped review
   - never retry the same invalid payload indefinitely
```

Suggested fallback:

```ts
async function publishReviewWithFallback(comments: CommentInput[]) {
  try {
    return await createGroupedReview(comments);
  } catch (error) {
    if (!isGitHubValidationError(error)) throw error;

    const valid: CommentInput[] = [];
    const invalid: CommentInput[] = [];

    for (const comment of comments) {
      try {
        await validateCommentDryRunOrSingle(comment);
        valid.push(comment);
      } catch {
        invalid.push(comment);
      }
    }

    if (valid.length === 0) throw error;
    return await createGroupedReview(valid);
  }
}
```

Because GitHub has no true dry-run for review comments, this fallback needs care. In MVP, prefer to mark publish failed and rely on #19/#15 tests rather than creating individual comments that may spam.

---

## 19. PR summary publishing

### 19.1 Summary as issue comment

Use the Issues Comments API to create or update a PR timeline summary.

Summary behavior:

```text
- If an existing summary marker for this PR/headSha exists, update it.
- If an existing summary marker for the PR exists but a different headSha, either update it to latest or create a new summary depending on setting.
- Default: one active summary comment per PR, updated across head SHAs.
```

Recommended setting:

```ts
export type SummaryCommentPolicy =
  | "none"
  | "one_per_pr"
  | "one_per_head_sha";
```

MVP default:

```text
one_per_pr
```

Why one per PR?

```text
- avoids summary spam
- keeps latest bot result easy to find
- minimizes GitHub content creation
```

### 19.2 Summary body template

```md
## AI Review Summary

Reviewed commit: `abc1234`

Found **3** high-confidence findings:

| Severity | Category | Location |
|---|---|---|
| High | Security | `src/auth/session.ts:42` |
| Medium | Correctness | `src/billing/plan.ts:118` |
| Medium | Tests | `src/api/users.ts:77` |

Inline comments were added where relevant.

[View full review details](https://app.example.com/org/.../reviews/rr_123)

<!-- ai-reviewer-summary
review_run_id=rr_123
publish_plan_id=pp_456
head_sha=abc123
-->
```

### 19.3 Summary with no findings

If enabled:

```md
## AI Review Summary

Reviewed commit: `abc1234`

No high-confidence findings were found. This does not guarantee the PR is bug-free.

[View full review details](...)

<!-- ai-reviewer-summary ... -->
```

Always include uncertainty. Do not imply formal correctness.

### 19.4 Summary safety

The summary must not include:

```text
- raw prompts
- raw context bundles
- secrets
- full code snippets unless necessary
- model provider identifiers if hidden by product policy
- internal stack traces
```

---

## 20. Check Run publishing

### 20.1 Check run name

Use a stable check run name.

```text
AI Code Review
```

Do not create a unique name per review run. GitHub limits the number of check runs with the same name in a check suite before older runs are automatically deleted, but stable names still make status checks easier to understand.

### 20.2 External ID

Use `reviewRunId` or `publishPlanId`.

```ts
external_id = reviewRunId;
```

### 20.3 Status flow

If check runs are enabled:

```text
create/update check run: in_progress
publish review/summary
update check run: completed
```

Conclusions:

| Review result | Conclusion |
|---|---|
| No publishable findings | `success` |
| Informational findings only | `neutral` |
| Medium/high findings found | `neutral` by default |
| Critical finding and blocking mode enabled | `action_required` or `failure` |
| Review skipped due to config | `skipped` |
| Review failed due to infrastructure | `timed_out` or `failure` |

MVP recommendation:

```text
Use neutral for findings.
Do not fail CI by default.
```

This avoids surprising teams.

### 20.4 Check output

```ts
type CheckRunOutput = {
  title: string;
  summary: string;
  text?: string;
  annotations?: CheckRunAnnotation[];
};
```

Example:

```md
AI review completed for `abc1234`.

Findings:
- High: 1
- Medium: 2

Inline comments were added to the PR.
```

### 20.5 Check annotations

Annotations are useful when inline comments are disabled or when a team wants findings visible in the Checks tab.

MVP policy:

```text
- If inline comments are enabled, do not duplicate every finding as a check annotation by default.
- If check_run_only mode is enabled, convert findings into annotations.
- Cap annotations to 50 for a single update request.
```

Annotation level mapping:

```ts
function toAnnotationLevel(severity: FindingSeverity): "notice" | "warning" | "failure" {
  switch (severity) {
    case "critical": return "failure";
    case "high": return "failure";
    case "medium": return "warning";
    case "low": return "notice";
  }
}
```

### 20.6 More than 50 annotations

If publishing annotations and there are more than 50:

```text
- create or update check run with first 50 annotations
- then send additional update requests with subsequent batches of 50
- record every batch operation
```

But in practice, the validator should cap findings far below this.

---

## 21. Markdown rendering

### 21.1 Inline comment template

Inline comments should be concise and action-oriented.

```md
**Potential security issue:** Session expiration is not checked before trusting the decoded token.

`validateSessionToken()` can return a decoded token even when `exp` is already in the past. The existing middleware in `src/auth/middleware.ts` rejects expired tokens before creating a session, so this path may accept stale credentials.

Suggested fix: reject tokens whose `exp` is before `Date.now()` before returning the session.

<!-- ai-reviewer
review_run_id=rr_123
publish_plan_id=pp_456
validated_finding_id=vf_789
fingerprint=sha256:abc
head_sha=abc123
-->
```

### 21.2 Inline comment rules

Every inline comment should have:

```text
- short bold title
- why it matters
- concrete evidence
- optional suggested fix
- hidden marker
```

Avoid:

```text
- “maybe” everywhere
- broad style advice
- long essays
- hallucinated file paths
- raw chain-of-thought
- raw prompt fragments
- model uncertainty scores unless product wants them
```

### 21.3 Severity labels

Suggested labels:

```text
Critical: 🚨 Critical
High:     ⚠️ High
Medium:   ⚠️ Medium
Low:      ℹ️ Low
```

MVP recommendation:

```text
Avoid emoji in inline comments initially unless product tone wants it.
Use plain text labels for professionalism.
```

Example:

```md
**High confidence correctness issue:** This branch now skips validation for archived users.
```

### 21.4 Suggested patch formatting

Only include code patches when the fix is small and obvious.

```md
Suggested fix:

```ts
if (user.archived) {
  throw new ForbiddenError("Archived users cannot be updated");
}
```
```

Do not include multi-file patches in inline comments. Link to dashboard details instead.

### 21.5 Sanitization

The renderer must sanitize or escape:

```text
- accidental hidden marker text inside model output
- malformed Markdown tables
- unclosed code fences
- very long code blocks
- untrusted HTML
```

Markdown is rendered by GitHub, but do not rely on GitHub as your only safety layer.

### 21.6 Length limits

Enforce internal limits even if provider limits are higher.

```ts
const INLINE_COMMENT_MAX_CHARS = 3_500;
const SUMMARY_COMMENT_MAX_CHARS = 12_000;
const CHECK_RUN_SUMMARY_MAX_CHARS = 4_000;
const CHECK_RUN_TEXT_MAX_CHARS = 16_000;
```

If content exceeds limits:

```text
- shorten evidence
- remove verbose details
- link to dashboard artifact
- never truncate hidden marker
```

---

## 22. Anchor mapping

### 22.1 Input anchor from #19

```ts
export type ValidatedAnchor = {
  provider: "github";
  path: RepoPath;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  subjectType: "line" | "file";
};
```

### 22.2 GitHub comment payload

```ts
function toGitHubReviewComment(finding: ValidatedFinding): GitHubReviewCommentInput {
  const anchor = finding.anchor;

  if (anchor.subjectType === "file") {
    return {
      path: anchor.path,
      body: renderInlineComment(finding),
      subject_type: "file",
    };
  }

  return {
    path: anchor.path,
    body: renderInlineComment(finding),
    line: anchor.line,
    side: anchor.side,
    ...(anchor.startLine ? { start_line: anchor.startLine } : {}),
    ...(anchor.startSide ? { start_side: anchor.startSide } : {}),
  };
}
```

### 22.3 Defensive anchor validation

Before posting:

```ts
function assertPublishableAnchor(anchor: ValidatedAnchor, lineAnchorIndex: LineAnchorIndex) {
  const result = lineAnchorIndex.canComment(anchor);
  if (!result.ok) {
    throw new InvalidPublishAnchorError(result.reason);
  }
}
```

The Publisher should never silently alter the line anchor to a nearby line. If the anchor is wrong, skip or fail publishing for that finding.

---

## 23. Duplicate prevention

### 23.1 Duplicate levels

Prevent duplicates at four levels:

```text
1. PublishPlan-level duplicate
2. Finding-level duplicate
3. Provider existing-comment duplicate
4. Retry duplicate after partial failure
```

### 23.2 Duplicate logic

A finding is already published if:

```text
- DB has a published_findings row for same repo + PR + headSha + fingerprint
OR
- GitHub has a bot comment with matching hidden marker fingerprint + headSha
OR
- GitHub has a bot comment with same rendered body hash and same path/line/headSha
```

### 23.3 Body hash

```ts
const bodyHash = sha256(normalizeMarkdown(renderedBodyWithoutMarker));
```

Normalize:

```text
- trim trailing whitespace
- normalize line endings to \n
- remove hidden marker
- collapse internal generated run URL if configured
```

### 23.4 Handling previous head SHA comments

Do not delete old comments by default.

Policy:

```text
- Old inline comments can remain; GitHub may mark them outdated.
- Summary comment is updated to latest if policy=one_per_pr.
- Check run is per commit/head SHA and should not be overwritten across commits.
```

---

## 24. Failure handling

### 24.1 Error categories

```ts
export type PublishFailureReason =
  | "github_auth_failed"
  | "github_permission_denied"
  | "github_rate_limited"
  | "github_secondary_rate_limited"
  | "github_validation_failed"
  | "github_not_found"
  | "github_network_error"
  | "github_server_error"
  | "stale_head_sha"
  | "invalid_anchor"
  | "duplicate_detected"
  | "db_write_failed"
  | "unknown";
```

### 24.2 Retry policy

| Failure | Retry? | Notes |
|---|---:|---|
| Network error | Yes | Exponential backoff |
| GitHub 5xx | Yes | Exponential backoff |
| Primary rate limit | Yes | Wait until reset |
| Secondary rate limit | Yes | Respect retry-after or conservative delay |
| 403 permission denied | No | Mark repo permission issue |
| 404 repo/PR not found | No or later retry | Depends on installation state |
| 422 invalid anchor | No for that comment | Mark finding skipped |
| 422 spam/abuse | Yes later | Treat as secondary/content rate limit if indicated |
| Stale head SHA | No | Enqueue new review via orchestrator if needed |
| DB write failure after external publish | Yes reconciliation | Needs external artifact recovery |

### 24.3 Partial publish handling

The worst case is: GitHub publish succeeds, then DB persistence fails.

Mitigation:

```text
- record operation before executing external write
- after external write, immediately persist response
- include hidden markers in all comments
- reconciliation job can discover external comments later
```

If publish partially succeeds:

```text
- mark publish run partially_published
- record which artifacts succeeded
- enqueue reconciliation job
- do not blindly retry all comments
```

### 24.4 Reconciliation job

```ts
export type ReconcilePublishingJob = {
  jobType: "review.publish.reconcile";
  publishRunId: PublishRunId;
  reviewRunId: ReviewRunId;
  repoId: RepoId;
  pullRequestNumber: number;
};
```

Reconciliation flow:

```text
load publish run
fetch existing bot artifacts from GitHub
parse hidden markers
match to publish plan
insert missing published_* rows
mark unresolved artifacts
optionally retry missing safe operations
```

---

## 25. Rate limiting and throttling

### 25.1 Where throttling lives

Rate limit handling should be shared with `/packages/github`, but publishing needs additional content-specific throttling.

```text
/packages/github
  - primary rate limit headers
  - secondary rate limit detection
  - retry-after parsing
  - token-level throttling

/packages/publisher
  - content write pacing
  - per-installation publish queue limits
  - max comments per publish plan
  - summary update dedupe
```

### 25.2 Suggested limits

MVP conservative defaults:

```ts
const PUBLISH_LIMITS = {
  maxInlineCommentsPerReview: 8,
  maxSummaryCommentsPerPrPerHour: 4,
  maxPublishOperationsPerRepoPerMinute: 10,
  maxPublishOperationsPerInstallationPerMinute: 30,
};
```

### 25.3 Content write minimization

Prefer:

```text
- one grouped review instead of N individual comment calls
- one summary comment updated in place
- check run updates only when status changes
```

Do not:

```text
- post a comment per internal stage
- update summary repeatedly during one review
- duplicate inline comments as annotations unless configured
```

---

## 26. Permissions

The GitHub App should request only the permissions required by enabled features.

### 26.1 Required for inline review comments

```text
Pull requests: write
Contents: read
Metadata: read
```

### 26.2 Required for summary comments

```text
Issues: write
```

Because PR timeline comments are issue comments.

### 26.3 Required for check runs

```text
Checks: write
```

### 26.4 Feature gating by permissions

If permissions are missing:

```text
- inline comments disabled if Pull requests: write is missing
- summary comments disabled if Issues: write is missing
- check runs disabled if Checks: write is missing
```

The Publisher should degrade gracefully and surface setup guidance in the dashboard, not crash the review pipeline.

---

## 27. Security and privacy

### 27.1 Never publish secrets

Before rendering and before publishing, run all text through redaction.

```text
- finding body
- evidence snippets
- suggested fixes
- summary text
- check run output
- annotation messages
```

Use the same redaction utilities from #17 LLM Gateway and #27 Security.

### 27.2 Do not publish internal artifacts

Never publish:

```text
- prompt text
- raw LLM responses
- context bundle dumps
- stack traces
- provider API keys
- installation tokens
- internal database IDs unless intentionally hidden markers
```

Hidden markers can include internal IDs because they are not secret, but they should not include sensitive data.

### 27.3 User-facing URLs

Dashboard URLs should be signed or authorization-protected.

```text
Good: https://app.example.com/org/org_123/repos/repo_123/reviews/rr_123
Bad:  https://app.example.com/raw-context/artifact-unguarded
```

### 27.4 Markdown injection

The model or finding body may contain untrusted content. Sanitize before publishing:

```text
- strip hidden marker-looking strings from model content
- close unclosed code fences
- avoid raw HTML except hidden marker comments
- normalize links
- remove javascript: URLs
```

---

## 28. Observability

### 28.1 Logs

Every publish run log line should include:

```text
publishRunId
reviewRunId
repoId
pullRequestNumber
headSha
installationId
operationType
provider
dryRun
```

Never log:

```text
installation tokens
raw large comment bodies
raw code snippets unless redacted and explicitly enabled
```

### 28.2 Metrics

```text
publisher.publish_runs_total{status,mode,provider}
publisher.publish_duration_ms{provider,mode}
publisher.inline_comments_planned_total
publisher.inline_comments_published_total
publisher.inline_comments_skipped_total{reason}
publisher.summary_comments_created_total
publisher.summary_comments_updated_total
publisher.check_runs_created_total
publisher.check_runs_updated_total
publisher.github_errors_total{status,reason}
publisher.rate_limit_wait_ms{provider,installation}
publisher.partial_publish_total
```

### 28.3 Traces

Trace stages:

```text
publisher.load_plan
publisher.acquire_lock
publisher.check_staleness
publisher.load_existing_artifacts
publisher.render_markdown
publisher.plan_operations
publisher.github.create_review
publisher.github.create_summary_comment
publisher.github.update_summary_comment
publisher.github.create_check_run
publisher.github.update_check_run
publisher.record_results
```

### 28.4 Publish artifacts

Persist sanitized artifacts:

```text
- rendered inline comment bodies, redacted
- rendered summary body, redacted
- check run output, redacted
- provider request hashes
- provider response metadata
```

Do not persist unredacted code comments beyond what is already visible on GitHub unless product retention policy allows it.

---

## 29. Testing strategy

### 29.1 Unit tests

Test:

```text
- hidden marker rendering/parsing
- comment body rendering
- summary rendering
- check run output rendering
- markdown sanitization
- body hashing
- duplicate detection
- staleness guard behavior
- operation planning by publish mode
- failure reason mapping
```

### 29.2 Contract tests

Use fake provider responses to validate:

```text
- grouped review payload shape
- line/side anchor payloads
- file-level comment payloads
- check run payload shape
- annotation batching
```

### 29.3 Integration tests with fake GitHub provider

Scenarios:

```text
- publish 0 findings with summary disabled
- publish 0 findings with summary enabled
- publish 3 inline findings + summary
- retry same publish job; no duplicate comments
- stale head SHA; skip publish
- one finding already published in DB; skip duplicate
- hidden marker exists on GitHub but missing DB row; reconcile
- GitHub 422 on review creation; mark failed/skipped appropriately
- GitHub secondary rate limit; retry with backoff
- summary comment exists; update instead of create
- check run enabled; create in_progress then completed
```

### 29.4 Golden Markdown tests

Fixtures:

```text
fixtures/publisher/inline-comment-basic.md
fixtures/publisher/inline-comment-security.md
fixtures/publisher/summary-three-findings.md
fixtures/publisher/summary-clean-review.md
fixtures/publisher/check-run-output.md
```

Golden tests should normalize hidden marker IDs or use deterministic IDs.

### 29.5 End-to-end test with a real test repo

Manual or staging flow:

```text
1. Open fixture PR.
2. Run review pipeline.
3. Publish comments.
4. Verify inline comments appear at correct lines.
5. Verify summary comment exists once.
6. Retry publish job.
7. Verify no duplicates.
8. Push new commit.
9. Retry old publish job.
10. Verify stale job does not publish.
```

---

## 30. Implementation sequence

### PR 1: Package skeleton and contracts

Implement:

```text
/packages/publisher
  contracts
  PublishPlan types
  PublishResult types
  ProviderPublisher interface
  error types
```

Add tests for type/schema validation.

### PR 2: Markdown renderer

Implement:

```text
inline comment renderer
summary renderer
check run renderer
hidden marker renderer/parser
body hashing
sanitization basics
```

Add golden Markdown tests.

### PR 3: Publish repository and DB writes

Implement:

```text
publish_runs repository
published_findings repository
published_summary_comments repository
published_reviews repository
published_check_runs repository
operation logging
```

Add idempotency tests.

### PR 4: Fake provider and operation planner

Implement:

```text
FakeProviderPublisher
ExistingArtifacts loader
operation planner
publish modes
summary update/create decisions
inline duplicate detection
```

Add integration tests with fake provider.

### PR 5: GitHub provider publisher

Implement:

```text
createPullRequestReview
createOrUpdateSummaryComment
createOrUpdateCheckRun
listExistingBotArtifacts
GitHub error mapping
rate-limit hooks
```

Use `/packages/github` for Octokit/auth.

### PR 6: Publish service state machine

Implement:

```text
publishReview service
publish lock
staleness guard
state transitions
partial publish handling
reconciliation job skeleton
```

### PR 7: Worker integration

Implement:

```text
review.publish job handler
queue registration
retry config
metrics/tracing
worker tests
```

### PR 8: Staging GitHub E2E

Implement or document:

```text
fixture repo
manual runbook
staging app permissions
real PR publishing test
retry/no-duplicate test
```

---

## 31. MVP cut

Build this first:

```text
- /packages/publisher package
- PublishPlan / PublishResult contracts
- hidden marker render/parse
- inline comment renderer
- summary renderer
- body hashing
- idempotent publish_runs
- staleness guard
- duplicate detection against DB
- duplicate detection against GitHub hidden markers
- GitHub grouped review publishing
- GitHub summary issue comment create/update
- publish state machine
- publish worker job handler
- fake provider tests
- staging GitHub smoke test
```

Defer:

```text
- check run annotations
- multi-line comments
- file-level comments except maybe fallback
- REQUEST_CHANGES mode
- APPROVE mode
- advanced reconciliation
- GitLab publisher
- dashboard-triggered manual replay UI
```

---

## 32. Definition of done

#20 is done when:

```text
- A PublishPlan can be published to GitHub as grouped inline review comments.
- A PR summary comment can be created and updated without duplication.
- Retrying the same publish job does not duplicate comments.
- Publishing is skipped when the PR head SHA changed.
- External review/comment IDs are persisted.
- Hidden markers can be parsed from GitHub comments.
- Invalid anchors do not create broken comments.
- GitHub 403/404/422/rate-limit errors are mapped to structured failure reasons.
- Publish state is visible in the dashboard/debug views.
- The Publisher can run in dry-run mode and show the planned operations.
- Unit, fake-provider integration, and staging smoke tests pass.
```

---

## 33. Key implementation principles

```text
1. Publish only a validated PublishPlan.
2. Never post if the PR head SHA changed.
3. Prefer one grouped review over many individual comment calls.
4. Use one updateable summary comment per PR by default.
5. Add hidden markers to every bot-created comment.
6. Persist every external ID immediately.
7. Make retries safe by design.
8. Treat GitHub 422 as a validation signal, not a blind retry target.
9. Do not fail CI by default.
10. Keep publishing provider-specific, but finding semantics provider-neutral.
```

The Publisher is the product’s public voice. It should be conservative, predictable, and quiet unless it has something useful to say.
