# #19 Finding Validation, Deduplication, and Ranking - Implementation Spec

## Status

Recommended package:

```text
/packages/review-engine/src/validation
```

Optional dedicated package if the module grows:

```text
/packages/finding-validation
```

Recommended app integration:

```text
/apps/worker
  review.pr / review.resume jobs call validation before review.publish
```

Primary upstream dependencies:

```text
#0  Core contracts and shared types
#2  Database layer
#14 Retrieval engine
#15 PR snapshot and diff model
#16 Review orchestrator
#18 Review passes
```

Primary downstream dependencies:

```text
#20 Publisher
#21 Feedback and memory system
#22 Repo rules and configuration
#25 Observability
#26 Evaluation harness
```

---

## 1. Purpose

The finding validation module is the product quality gate.

The LLM and deterministic tools are allowed to generate many imperfect `CandidateFinding` objects. This module decides which findings are real, useful, non-duplicative, line-anchorable, and worth showing to a developer.

The central rule:

```text
Review passes generate candidates.
Validation decides publishability.
Publisher only publishes a PublishPlan.
```

This module protects users from:

```text
- hallucinated comments
- comments on lines that GitHub cannot anchor
- duplicated comments from multiple review passes
- low-confidence or vague comments
- style nitpicks when the repo asks for substantive review
- repeated comments the team already rejected
- comments contradicted by retrieved context
- comments on generated/vendored/ignored code
- comments that are technically true but not worth developer attention
```

For this product, bad comments are worse than missing comments. A quiet reviewer that catches a few real issues earns trust. A noisy reviewer loses trust quickly.

---

## 2. Mental model

Think of the validation system as a compiler pipeline for findings.

```text
CandidateFinding[]
  -> normalize
  -> schema validate
  -> anchor validate
  -> evidence validate
  -> policy validate
  -> suppress
  -> dedupe/group
  -> score/rank
  -> enforce budgets
  -> emit PublishPlan
```

The output is not just `Finding[]`. The output should include rejected findings and reasons, because those are crucial for debugging and evaluation.

```text
ValidationResult
  - accepted findings
  - rejected findings
  - duplicate groups
  - rank scores
  - publish plan
  - validation trace
```

---

## 3. Goals

Implement a deterministic, inspectable module that can answer:

```text
Why was this finding published?
Why was this finding rejected?
Why was this lower ranked than another finding?
Why did this duplicate get collapsed?
Why was this comment not posted inline?
Which policy/rule/memory fact suppressed it?
```

Concrete goals:

```text
- Validate every CandidateFinding against contracts.
- Ensure inline comments can be mapped to the PR diff.
- Reject findings with missing evidence or low confidence.
- Reject findings that violate repo settings or explicit rules.
- Reject findings that are style-only unless specifically enabled.
- Deduplicate candidates from multiple passes and tools.
- Rank accepted findings using explicit scoring.
- Respect comment budgets and severity thresholds.
- Produce a deterministic PublishPlan for #20 Publisher.
- Persist accepted, rejected, and grouped findings for debugging.
- Emit metrics and traces for product quality.
```

---

## 4. Non-goals

This module should not:

```text
- call GitHub directly
- post comments
- fetch PR metadata
- retrieve additional code context directly
- clone repos
- run static analysis tools
- call arbitrary LLM providers outside the LLM Gateway
- mutate repo rules or memory facts
- decide if a review job should start
```

Optional LLM-based judging may be invoked through `/packages/llm-gateway`, but deterministic validation should remain the default and primary gate.

---

## 5. Where this sits in the pipeline

```text
Review Orchestrator
  -> Review Engine
       -> ReviewPass[]
       -> CandidateFinding[]
  -> Finding Validation / Dedupe / Ranking
       -> ValidatedFinding[]
       -> RejectedFinding[]
       -> PublishPlan
  -> Publisher
       -> GitHub comments/checks/summary
```

Expanded:

```text
PullRequestSnapshot
ChangeSet
ContextBundle
CandidateFinding[]
RepositorySettings
RepoRule[]
MemoryFact[]
PreviousPublishedFinding[]
LineAnchorIndex
  |
  v
FindingValidationEngine
  |
  +-- candidate normalization
  +-- basic contract validation
  +-- diff anchor validation
  +-- evidence validation
  +-- suppression checks
  +-- dedupe/grouping
  +-- scoring/ranking
  +-- comment budget selection
  |
  v
PublishPlan
```

---

## 6. Package layout

Recommended layout inside `/packages/review-engine`:

```text
/packages/review-engine/src/validation
  index.ts
  engine.ts
  types.ts
  config.ts

  normalize/
    normalize-candidate.ts
    normalize-body.ts
    normalize-severity.ts
    normalize-path.ts
    normalize-fingerprint.ts

  validators/
    candidate-schema-validator.ts
    snapshot-freshness-validator.ts
    path-validator.ts
    file-state-validator.ts
    diff-anchor-validator.ts
    evidence-validator.ts
    context-reference-validator.ts
    confidence-validator.ts
    severity-validator.ts
    category-validator.ts
    style-nit-validator.ts
    actionability-validator.ts
    generated-file-validator.ts
    suppressed-path-validator.ts
    repo-rule-validator.ts
    memory-suppression-validator.ts
    previous-comment-validator.ts
    secret-leak-validator.ts
    suggested-fix-validator.ts
    contradiction-validator.ts

  dedupe/
    fingerprint.ts
    exact-dedupe.ts
    location-dedupe.ts
    semantic-dedupe.ts
    root-cause-dedupe.ts
    group-findings.ts

  ranking/
    score.ts
    severity-score.ts
    evidence-score.ts
    category-priority.ts
    source-priority.ts
    novelty-score.ts
    budget.ts
    rank-findings.ts

  publish-plan/
    build-publish-plan.ts
    select-inline-comments.ts
    select-check-annotations.ts
    select-summary-items.ts

  persistence/
    save-validation-result.ts
    save-validation-events.ts

  testing/
    fake-line-anchor-index.ts
    fake-context-bundle.ts
    finding-builders.ts
```

If extracted to its own package later:

```text
/packages/finding-validation
  src/...
```

Keep the public API small either way.

---

## 7. Public interface

### 7.1 Core engine interface

```ts
export interface FindingValidationEngine {
  validate(input: ValidateFindingsInput): Promise<ValidateFindingsResult>;
}
```

### 7.2 Input

```ts
export type ValidateFindingsInput = {
  reviewRunId: ReviewRunId;
  repoId: RepoId;
  orgId: OrgId;

  snapshot: PullRequestSnapshot;
  changeSet: ChangeSet;
  contextBundle: ContextBundle;
  lineAnchorIndex: LineAnchorIndex;

  candidates: CandidateFinding[];

  repositorySettings: RepositorySettings;
  repoRules: RepoRule[];
  memoryFacts: MemoryFact[];

  previousPublishedFindings: PublishedFinding[];
  previousRejectedFingerprints?: string[];

  validationProfile: FindingValidationProfile;
  budget: FindingBudget;

  now: IsoDateTime;
};
```

### 7.3 Output

```ts
export type ValidateFindingsResult = {
  reviewRunId: ReviewRunId;
  accepted: ValidatedFinding[];
  rejected: RejectedFinding[];
  duplicateGroups: FindingDuplicateGroup[];
  publishPlan: PublishPlan;
  stats: FindingValidationStats;
  trace: FindingValidationTrace;
};
```

### 7.4 Publish plan

```ts
export type PublishPlan = {
  reviewRunId: ReviewRunId;
  planId: PublishPlanId;
  headSha: GitSha;
  createdAt: IsoDateTime;

  mode: PublishMode;

  inlineComments: PlannedInlineComment[];
  fileComments: PlannedFileComment[];
  checkAnnotations: PlannedCheckAnnotation[];
  summary: PlannedReviewSummary;

  suppressedCount: number;
  rejectedCount: number;
  duplicateCount: number;
};
```

The publisher should receive a `PublishPlan`, not raw `ValidatedFinding[]`.
`PublishMode` is the canonical publisher mode contract from #0.

---

## 8. Required contract additions

The #0 contracts package should already contain most base types. #19 will likely need the following additions or refinements.

### 8.1 Finding validation profile

```ts
export type FindingValidationProfile = {
  profileVersion: "finding_validation.v1";

  minConfidenceBySeverity: {
    medium: number;
    high: number;
    critical: number;
  };

  enabledCategories: FindingCategory[];
  disabledCategories: FindingCategory[];

  allowStyleFindings: boolean;
  allowFileLevelComments: boolean;
  allowCheckAnnotations: boolean;
  allowSummaryOnlyFindings: boolean;

  requireEvidence: boolean;
  requireChangedLineAnchor: boolean;
  requireContextReferences: boolean;

  maxBodyChars: number;
  maxTitleChars: number;
  maxEvidenceItems: number;

  dedupe: {
    enableExactDedupe: boolean;
    enableLocationDedupe: boolean;
    enableSemanticDedupe: boolean;
    semanticSimilarityThreshold: number;
  };

  ranking: {
    preferSecurity: boolean;
    preferCorrectness: boolean;
    penalizeStyle: boolean;
    penalizeSummaryOnly: boolean;
    boostToolFindings: boolean;
  };
};
```

### 8.2 Finding budget

```ts
export type FindingBudget = {
  maxInlineComments: number;
  maxFileComments: number;
  maxCheckAnnotations: number;
  maxSummaryItems: number;

  maxInlineCommentsPerFile: number;
  maxInlineCommentsPerCategory: Partial<Record<FindingCategory, number>>;

  minSeverityForInline: FindingSeverity;
  minSeverityForCheckAnnotation: FindingSeverity;

  reserveSlots?: {
    security?: number;
    correctness?: number;
    testCoverage?: number;
  };
};
```

### 8.3 Rejected finding

```ts
export type RejectedFinding = {
  id: FindingId;
  candidateId: CandidateFindingId;
  reviewRunId: ReviewRunId;

  normalizedFingerprint: FindingFingerprint;
  source: FindingSource;
  sourcePassName?: string;

  filePath?: RepoPath;
  line?: number;
  category?: FindingCategory;
  severity?: FindingSeverity;
  confidence?: number;

  rejectedAt: IsoDateTime;
  rejectionReasons: FindingRejectionReason[];
  primaryRejectionReason: FindingRejectionReason;

  validationEvents: FindingValidationEvent[];
};
```

### 8.4 Rejection reasons

Use the canonical `FindingRejectionReason` contract from #0. This phase may add validation events and ranking metadata, but it must not create a phase-local rejection-reason enum.

### 8.5 Duplicate group

```ts
export type FindingDuplicateGroup = {
  groupId: FindingDuplicateGroupId;
  reviewRunId: ReviewRunId;

  canonicalFindingId: FindingId;
  duplicateFindingIds: FindingId[];

  groupKind: "exact" | "location" | "semantic" | "root_cause" | "previous_comment";
  confidence: number;
  reason: string;
};
```

### 8.6 Validation event

```ts
export type FindingValidationEvent = {
  eventId: FindingValidationEventId;
  findingId: FindingId;
  stage:
    | "normalize"
    | "schema"
    | "anchor"
    | "evidence"
    | "policy"
    | "suppression"
    | "dedupe"
    | "ranking"
    | "budget"
    | "publish_plan";
  status: "passed" | "failed" | "warning" | "adjusted";
  reason?: FindingRejectionReason;
  message: string;
  metadata?: JsonObject;
  createdAt: IsoDateTime;
};
```

---

## 9. Candidate normalization

Review passes may produce slightly inconsistent output. Normalize before validation.

Normalization should be deterministic and side-effect-free.

### 9.1 Normalize file paths

Rules:

```text
- Use POSIX-style `/` separators.
- Remove leading `./`.
- Reject absolute paths.
- Reject paths containing `..` segments.
- Preserve case.
- Do not URL-decode unless the upstream contract requires it.
- Map renamed paths to the current PR-side path where possible.
```

Example:

```ts
export function normalizeRepoPath(path: string): RepoPath | null {
  const trimmed = path.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("../")) return null;
  return trimmed.replace(/^\.\//, "") as RepoPath;
}
```

### 9.2 Normalize severity

The review engine may return severity with uncertain calibration. Normalize and optionally adjust.

```text
critical - exploitable security/data-loss/prod outage class issue
high     - likely real bug, security bug, broken behavior, serious regression
medium   - useful issue, likely worth attention, not urgent
low      - minor, usually summary-only or rejected by default
```

Default publish threshold:

```text
inline comment: medium+
summary item: low+
```

But MVP should probably avoid publishing low severity findings entirely.

### 9.3 Normalize confidence

All candidates should use `0.0 <= confidence <= 1.0`.

If a pass omits confidence:

```text
LLM candidate without judge: default 0.50
Static tool diagnostic: default 0.80
Finding judge accepted: use judge confidence
Critical security deterministic signal: cap may be 0.95
```

Never upgrade confidence merely because the prose sounds assertive.

### 9.4 Normalize title/body

Rules:

```text
- Trim whitespace.
- Collapse repeated blank lines.
- Strip markdown headings from inline comments.
- Reject bodies over max length unless summarizable.
- Remove any chain-of-thought or internal prompt text.
- Remove raw context IDs from user-facing body unless debug mode.
- Avoid mentioning internal pass names in user-facing comments.
```

A title should be short and specific:

```text
Bad:  Possible issue
Good: Expired sessions can still pass validation
```

### 9.5 Normalize evidence

Evidence should become a list of structured references:

```ts
export type NormalizedEvidence = {
  kind: "diff" | "context_item" | "static_tool" | "repo_rule" | "memory" | "model_reasoning";
  contextItemId?: ContextItemId;
  filePath?: RepoPath;
  lineRange?: LineRange;
  quote?: string;
  explanation: string;
};
```

Do not include long code quotes. Inline comments should explain enough to be useful but should not dump large snippets.

---

## 10. Validation stages

Run validation as a series of independent stages. Each stage emits events.

```ts
export type FindingValidator = {
  name: string;
  validate(input: SingleFindingValidationInput): Promise<ValidatorResult>;
};
```

Recommended stage order:

```text
1. Candidate schema validation
2. Path and file-state validation
3. Diff anchor validation
4. Evidence validation
5. Context reference validation
6. Confidence/severity/category validation
7. Actionability and style-nit validation
8. Repo rule suppression
9. Memory suppression
10. Previous comment suppression
11. Secret/safety validation
12. Suggested fix validation
13. Optional contradiction validation
```

### 10.1 Candidate schema validation

Reject if the candidate does not conform to the expected contract.

Checks:

```text
- required fields exist
- schema version supported
- title/body are strings
- severity/category/source enums are valid
- confidence is numeric 0..1
- filePath/line are present when target is inline
- evidence array exists when requireEvidence=true
```

This should run before all other validators.

### 10.2 Path validator

Reject if:

```text
- path is empty
- path is absolute
- path contains traversal
- path is not in the PR snapshot when inline target is requested
- path is not in the active index when context reference requires indexed file
```

Allow summary-only findings without a file path if explicitly configured.

### 10.3 File-state validator

Use `ChangedFile.status` and snapshot metadata.

Rules:

```text
added      - allow comments on RIGHT-side lines
modified   - allow comments on RIGHT or LEFT depending on finding target
deleted    - usually reject inline unless deletion-specific and LEFT-side anchor exists
renamed    - normalize to new path for RIGHT; allow old path for LEFT deletion-specific findings
binary     - reject inline; optionally summary-only
large/truncated - reject inline unless anchor is known from raw diff
```

### 10.4 Diff anchor validator

This is one of the most important validators.

The candidate must map to a valid `DiffAnchor` from #15.

```ts
export type DiffAnchor = {
  filePath: RepoPath;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  commitSha: GitSha;
  isMultiLine: boolean;
  hunkId: DiffHunkId;
};
```

Rules:

```text
- Inline findings must be anchored to a line present in GitHub's PR diff representation.
- Prefer RIGHT-side anchors for added/modified code.
- Use LEFT-side anchors only for deletion-specific comments.
- If a candidate refers to a context line outside the diff, convert to summary-only or reject.
- If a multiline range crosses hunks or sides, downgrade to single-line or reject.
- If the PR snapshot is stale relative to current head SHA, reject/defer.
```

GitHub currently recommends `line`, `side`, and optionally `start_line`/`start_side` for review comments; the older `position` parameter is described by GitHub as closing down. A comment should therefore be validated against the diff anchor model before #20 Publisher attempts to call GitHub.

### 10.5 Evidence validator

Every publishable finding should have concrete evidence.

Minimum evidence standard:

```text
- The finding references the exact changed code or directly related context.
- The evidence explains why the issue follows from the code.
- Evidence is not merely "the model thinks so".
- Evidence has at least one file/line or context item reference.
```

Reject if:

```text
- no evidence exists
- evidence references nonexistent context items
- evidence only repeats the claim
- evidence is unrelated to the finding file/category
- evidence relies on inaccessible or hallucinated code
```

Example weak evidence:

```text
"This might break auth."
```

Example strong evidence:

```text
"The changed `validateSession` path no longer checks `expiresAt`, while the existing `requireSession` middleware treats `expiresAt` as the session validity boundary."
```

### 10.6 Context reference validator

If a finding cites context items, verify them.

Checks:

```text
- contextItemId exists in ContextBundle
- context item belongs to same repo/index version
- file path and line range are valid
- referenced code is not hidden from model/user for policy reasons
- referenced context was actually supplied to the review pass or judge
```

This prevents findings from citing context that was not retrieved.

### 10.7 Confidence validator

Default thresholds:

```text
critical: >= 0.70
high:     >= 0.72
medium:   >= 0.78
low:      summary-only or rejected
```

Why medium has a higher threshold than critical/high:

```text
Critical/high issues may have large impact but uncertain details.
Medium issues are easier to overproduce and should be filtered harder.
```

These thresholds should be configurable by repo/org.

Reject if:

```text
candidate.confidence < thresholdFor(candidate.severity)
```

### 10.8 Severity validator

Reject or downgrade findings that are over-severed.

Examples:

```text
- Missing test for a minor helper is usually medium, not high.
- Possible style inconsistency is low, not medium.
- Potential data exposure is high/critical if concrete, otherwise reject.
```

This can be deterministic with category rules plus optional judge pass.

### 10.9 Category validator

Repo settings may disable categories:

```text
- style
- maintainability
- performance
- test_coverage
- architecture
```

MVP recommended enabled categories:

```text
- correctness
- security
- test_coverage
```

Architecture/performance can be summary-only until quality is proven.

### 10.10 Style-nit validator

Reject style-only comments unless explicitly enabled.

Style-only examples:

```text
- naming preferences
- import order
- whitespace
- minor formatting
- "consider simplifying" without correctness impact
- broad readability comments
```

Allow style comments only if:

```text
- repo rule explicitly asks for them
- static tool produces a configured blocking diagnostic
- comment is summary-only
```

### 10.11 Actionability validator

A publishable finding should answer:

```text
What is wrong?
Where is it wrong?
Why does it matter?
What should change?
```

Reject if:

```text
- too vague
- no clear fix path
- speculative without concrete failure mode
- purely asks a question without evidence
- only says "double-check this"
```

Examples:

```text
Reject: "This may cause bugs."
Accept: "This branch now returns `undefined`, but callers destructure `.id`; add an explicit `null` return or handle the missing session before destructuring."
```

### 10.12 Generated/vendored file validator

Reject comments on generated or vendored code by default.

Sources:

```text
- indexed file metadata
- repo settings ignored paths
- file path heuristics
- generated-file classifier from indexer
- Linguist-style generated/vendored attributes if later supported
```

Allow only if:

```text
- finding is critical security
- repo explicitly enables generated-file review
- file was manually edited in PR and not merely regenerated
```

### 10.13 Repo rule suppression validator

Repo rules can suppress or require findings.

Examples:

```text
- Ignore `src/generated/**`.
- Never comment on import ordering.
- Only security/correctness inline comments.
- Do not comment on tests unless issue is high severity.
- For migrations, always check rollback safety.
```

Rule evaluation should produce explicit events:

```json
{
  "stage": "suppression",
  "status": "failed",
  "reason": "suppressed_by_repo_rule",
  "message": "Suppressed by rule repo_rule_123: Ignore generated files"
}
```

### 10.14 Memory suppression validator

Memory facts from #21 may suppress repeated bad comments.

Examples:

```text
- Team rejected this exact pattern 5 times.
- This project intentionally uses custom auth middleware.
- The team does not want missing-test comments on storybook files.
```

Rules:

```text
- Only use active memory facts.
- Memory facts should be inspectable and cite their source/outcome.
- Expired or low-confidence memory should not suppress high-severity findings.
- Critical security findings should bypass most memory suppression unless rule is explicit.
```

### 10.15 Previous comment suppression validator

Avoid reposting the same finding across review reruns.

Compare candidate against:

```text
- existing bot comments on the same PR
- previous published findings for same review lineage
- previous review runs for same head SHA
- unresolved previous comments
```

Reject if:

```text
- same fingerprint already published for current head SHA
- same issue exists as unresolved bot thread
- candidate is a minor variant of previous comment
```

Allow if:

```text
- previous comment is outdated and new code still has issue
- severity increased due to new evidence
- previous issue moved to a new file/line after refactor
```

### 10.16 Secret leak validator

Never publish secrets or sensitive values in comments.

Check:

```text
- title
- body
- evidence quotes
- suggested fix
- debug metadata if visible
```

Reject or redact if content contains:

```text
- API keys
- access tokens
- private keys
- credentials
- session cookies
- authorization headers
- customer/user PII if not necessary
```

A secret-specific finding can say:

```text
"This appears to introduce a hard-coded secret. Rotate it and move it to the configured secret store."
```

But should not repeat the secret value.

### 10.17 Suggested fix validator

Suggested fixes should be safe and scoped.

Reject or strip suggested fix if:

```text
- fix changes unrelated code
- fix is not supported by evidence
- fix introduces a new security risk
- fix includes fabricated APIs
- fix is too large for a comment
- fix contains secrets
```

Inline comments may include a short code snippet, but do not require one.

### 10.18 Contradiction validator

This can be deterministic at first, optional LLM later.

Reject if:

```text
- context explicitly disproves the finding
- the code already handles the mentioned case
- the finding is based on old base code, not head code
- a repo rule says the pattern is intentional
```

Optional judge prompt can ask:

```text
Given this finding and the supplied context, is the finding contradicted by the context?
Return: supported | contradicted | insufficient_evidence
```

Use LLM Gateway only. Persist the judge output.

---

## 11. Diff anchoring details

The validator should consume `LineAnchorIndex` from #15 rather than parse diffs itself.

### 11.1 Required anchor APIs

```ts
export interface LineAnchorIndex {
  canAnchorLine(input: {
    filePath: RepoPath;
    line: number;
    side: "LEFT" | "RIGHT";
  }): boolean;

  resolveAnchor(input: FindingAnchorRequest): DiffAnchorResolution;

  getNearestAnchor(input: {
    filePath: RepoPath;
    line: number;
    preferredSide: "LEFT" | "RIGHT";
    maxDistance: number;
  }): DiffAnchorResolution | null;
}
```

### 11.2 Anchor resolution

```ts
export type DiffAnchorResolution = {
  status: "resolved" | "nearest" | "file_only" | "unavailable";
  anchor?: DiffAnchor;
  reason?: FindingRejectionReason;
  distance?: number;
};
```

### 11.3 Anchor policy

Recommended policy:

```text
Exact anchor exists:
  accept

Candidate line is not in diff but nearest changed/context line is within 3 lines:
  use nearest anchor only if finding still makes sense and body references the changed line

Candidate line is outside GitHub-diff commentable region:
  summary-only if severity high/critical and allowSummaryOnlyFindings=true
  otherwise reject

Candidate file changed but no line anchor possible:
  file-level comment only if allowFileLevelComments=true and severity high+
  otherwise summary-only/reject
```

Do not invent anchors. If #20 Publisher cannot publish it, #19 should not mark it as inline publishable.

---

## 12. Deduplication

Deduplication is needed because the same issue may be produced by:

```text
- correctness pass
- security pass
- test coverage pass
- static tool pass
- finding judge pass
- reruns of the same PR review
```

Dedupe in layers.

```text
1. Exact fingerprint dedupe
2. Location dedupe
3. Message/title similarity dedupe
4. Root-cause dedupe
5. Previous comment dedupe
```

### 12.1 Finding fingerprint

Each finding should have multiple fingerprints.

```ts
export type FindingFingerprints = {
  exact: string;
  location: string;
  rootCause: string;
  semantic?: string;
  previousComment?: string;
};
```

Recommended exact fingerprint inputs:

```text
repoId
pullRequestNumber
headSha or normalized diff hash
filePath
side
line
category
normalized title
normalized body claim
primary evidence context item IDs
```

Recommended root-cause fingerprint inputs:

```text
repoId
filePath
changedSymbolId if available
category
normalized issue class
normalized affected API/model/entity
```

Example implementation:

```ts
export function findingFingerprint(input: FingerprintInput): FindingFingerprint {
  return sha256Hex([
    input.repoId,
    input.prNumber,
    input.filePath ?? "no-file",
    input.line?.toString() ?? "no-line",
    input.category,
    normalizeForFingerprint(input.title),
    normalizeForFingerprint(input.claim),
    ...input.primaryEvidenceKeys.sort(),
  ].join("\u001f")) as FindingFingerprint;
}
```

### 12.2 Exact dedupe

If exact fingerprints match, keep one.

Canonical selection:

```text
1. higher severity
2. higher confidence
3. deterministic/tool source over LLM source if same claim
4. richer evidence
5. shorter body if equivalent
6. stable candidate ID order
```

### 12.3 Location dedupe

Candidates on the same file/line/category are often duplicates.

Group if:

```text
same filePath
same side
line distance <= 2
same category or compatible category
normalized titles similar
```

Compatible categories:

```text
correctness + security        possible if auth/data validation
correctness + test_coverage   keep correctness; tests can be summary support
performance + architecture    group if same root cause
```

### 12.4 Semantic dedupe

Optional in MVP. Useful when candidates use different wording.

Options:

```text
- Cheap lexical similarity over normalized title + body claim
- Existing embedding model over finding claim
- LLM judge for borderline duplicate groups
```

MVP recommendation:

```text
Use lexical similarity and root-cause heuristics first.
Add embeddings/LLM only after seeing real duplicate pain.
```

### 12.5 Root-cause dedupe

Sometimes multiple line-level findings are symptoms of one issue.

Example:

```text
Line 42: validation deleted
Line 87: caller now accepts invalid input
Line 114: test missing invalid-input case
```

If one root cause explains all, publish the highest-value finding and mention the rest in the body or summary.

Root-cause grouping should be conservative. Do not collapse genuinely distinct bugs.

### 12.6 Previous comment dedupe

Compare against previous bot comments.

Inputs:

```text
published_findings rows
GitHub comment IDs
existing bot comments fetched by publisher/GitHub adapter
finding outcomes
```

Reject if same unresolved issue already exists.

This check prevents comment spam when users push multiple commits.

---

## 13. Ranking

After validation and dedupe, rank accepted findings.

Ranking should be explicit, explainable, and easy to tune.

### 13.1 Ranking output

```ts
export type RankedFinding = ValidatedFinding & {
  rankScore: number;
  rankReasons: RankReason[];
};
```

### 13.2 Base score

Recommended scoring model:

```ts
score =
  severityScore
  + confidenceScore
  + categoryScore
  + evidenceScore
  + sourceScore
  + anchorScore
  + noveltyScore
  + changedCodeProximityScore
  + repoRuleBoost
  + memoryBoost
  - stylePenalty
  - verbosityPenalty
  - uncertaintyPenalty
  - duplicatePenalty
  - fileCrowdingPenalty;
```

### 13.3 Severity score

```text
critical: 1000
high:      700
medium:    400
low:       100
```

### 13.4 Confidence score

```ts
confidenceScore = Math.round(confidence * 100);
```

Apply cap or penalty when confidence is poorly calibrated:

```text
- LLM-generated without judge: max 0.75
- Finding with weak evidence: max 0.60
- Static tool with exact diagnostic: may keep 0.85+
```

### 13.5 Category score

Default:

```text
security:       +120
correctness:    +100
test_coverage:   +40
performance:     +35
architecture:    +25
maintainability: +10
style:           -50
```

Repo settings can modify category priority.

### 13.6 Evidence score

```text
strong evidence:       +80
multiple evidence:     +40
direct diff evidence:  +40
related context:       +25
weak evidence:         -80
no evidence:           reject before ranking
```

### 13.7 Source score

```text
static tool exact:       +80
static tool heuristic:   +30
LLM pass:                +0
multiple passes agree:   +60
finding judge accepted:  +40
memory/rule backed:      +30
```

### 13.8 Anchor score

```text
exact changed line:      +80
context line in diff:    +40
nearest anchor:          -20
file-level only:         -80
summary-only:           -120
```

### 13.9 Novelty score

```text
new issue:                 +30
similar rejected before:   -100
already commented:         reject
previously accepted class: +30
```

### 13.10 Changed-code proximity score

```text
candidate on added/modified line: +60
within 3 lines of change:         +30
same changed symbol:              +40
same file but outside change:     -30
external context only:            -80
```

### 13.11 File crowding penalty

Avoid piling comments on one file unless all are high severity.

```text
first finding in file:      0
second finding in file:   -20
third finding in file:    -60
fourth+ finding in file: -120
```

### 13.12 Final ordering

Sort by:

```text
1. publishability target priority: inline > file > check > summary
2. rankScore descending
3. severity descending
4. confidence descending
5. category priority
6. file path stable sort
7. line number stable sort
8. candidate ID stable sort
```

Stable sorting is important for reproducible review runs.

---

## 14. Comment budget enforcement

Budgets are essential for product quality.

### 14.1 Default budgets

Recommended MVP defaults:

```text
Use ReviewSizeClass from #0:

small:   max 2 inline comments
medium:  max 4 inline comments
large:   max 6 inline comments
huge:    max 8 inline comments, summary-first, and inline only when anchors are exact
```

Alternative based on files:

```text
maxInlineComments = min(repoSettingMax, ceil(log2(changedLines + 1)) + 1)
```

### 14.2 Reserve slots

Reserve slots for high-value categories:

```text
security:    at least 1 if security finding exists
correctness: at least 1 if correctness finding exists
tests:       at most 1 unless repo asks for more
```

### 14.3 Per-file caps

Default:

```text
max 2 inline comments per file
max 1 style/maintainability comment per file
no cap for critical security if real, but group summary may be better
```

### 14.4 Budget overflow handling

Findings beyond budget should not disappear entirely.

Options:

```text
- include in internal rejected list with reason budget_exceeded
- include top overflow items in PR summary if allowSummaryOnlyFindings
- persist for evaluation
```

Do not publish a long dump of overflow findings. The point of budget enforcement is attention management.

---

## 15. Publish target selection

A validated finding may map to different publish targets.

```text
inline comment       - best for exact changed line issues
file-level comment   - useful for file-wide issue, if provider supports it
check annotation     - useful for tool-like diagnostics
PR summary item      - useful for non-anchorable but important context
internal-only        - useful for evaluation/debugging but not user-visible
```

### 15.1 Inline comment criteria

All must be true:

```text
- exact or acceptable anchor exists
- severity meets inline threshold
- not duplicate previous inline comment
- body is concise and actionable
- category is inline-enabled
- comment budget available
```

### 15.2 File-level comment criteria

Use sparingly.

```text
- no exact line anchor exists
- issue is file-wide
- severity is high+
- file-level comments are enabled
- publisher supports file-level target
```

### 15.3 Check annotation criteria

Good for deterministic tool diagnostics.

```text
- finding source is static tool or deterministic validator
- severity maps to annotation level
- line range exists
- check annotations enabled
```

### 15.4 Summary-only criteria

Use when:

```text
- issue is important but not line-anchorable
- issue is broad architecture/API risk
- issue is a missing test recommendation
- issue is below inline threshold but useful
```

MVP should be conservative with summary-only issues to avoid essay-like reviews.

---

## 16. Persistence

Persist enough to debug every validation decision.

Use the canonical #2 persistence model:

```text
candidate_findings
review_artifacts: validated_findings
review_artifacts: rejected_findings
review_artifacts: ranking_report
review_artifacts: publish_plan
published_findings
```

This phase should not introduce new validation tables unless #2 is updated first.

### 16.1 candidate_findings

Already produced by #18.

Important columns:

```text
id
review_run_id
source
source_pass_name
schema_version
raw_payload_json
normalized_payload_json
file_path
line
category
severity
confidence
fingerprint_exact
fingerprint_location
fingerprint_root_cause
created_at
```

### 16.2 validated_findings

```text
id
candidate_id
review_run_id
file_path
line
side
start_line
start_side
category
severity
confidence
rank_score
title
body
evidence_json
fingerprints_json
publish_target
created_at
```

### 16.3 rejected_findings

```text
id
candidate_id
review_run_id
primary_rejection_reason
rejection_reasons_json
file_path
line
category
severity
confidence
fingerprint_exact
created_at
```

### 16.4 finding_validation_events

```text
id
review_run_id
finding_id
candidate_id
stage
status
reason
message
metadata_json
created_at
```

### 16.5 finding_duplicate_groups

```text
id
review_run_id
canonical_finding_id
group_kind
confidence
reason
duplicate_finding_ids_json
created_at
```

### 16.6 publish_plans

```text
id
review_run_id
head_sha
mode
inline_comments_json
file_comments_json
check_annotations_json
summary_json
stats_json
created_at
```

### 16.7 Idempotency

Use stable keys:

```text
review_run_id + candidate_fingerprint_exact
review_run_id + duplicate_group_fingerprint
review_run_id + publish_plan_version
```

Validation should be safe to rerun for the same review run.

---

## 17. Database transaction strategy

The validation engine can run mostly in memory, then persist in one transaction.

Recommended:

```text
1. Load candidates/settings/rules/memory outside transaction.
2. Run validation in memory.
3. Open transaction.
4. Delete/replace previous validation result for same review_run_id and validation_attempt if rerun mode.
5. Insert validated_findings.
6. Insert rejected_findings.
7. Insert validation events.
8. Insert duplicate groups.
9. Insert publish plan.
10. Update review_run validation stage status.
11. Commit.
```

Use a review-run stage lock from #16 to avoid concurrent validation for the same review run.

---

## 18. Error handling

Validation should distinguish product rejections from internal failures.

Product rejection:

```text
Candidate is invalid, low-quality, duplicate, suppressed, or unpublishable.
This is normal and should not fail the review run.
```

Internal failure:

```text
Validator crashed, line anchor index missing, invalid context bundle, DB write failed.
This may fail or pause the review run.
```

### 18.1 Error model

```ts
export type FindingValidationError = {
  code:
    | "MISSING_LINE_ANCHOR_INDEX"
    | "INVALID_CONTEXT_BUNDLE"
    | "VALIDATION_CONFIG_ERROR"
    | "PERSISTENCE_ERROR"
    | "INTERNAL_VALIDATOR_ERROR";
  message: string;
  metadata?: JsonObject;
};
```

### 18.2 Fail-open vs fail-closed

Default:

```text
fail closed for user-visible publishing
fail open for internal artifact persistence when safe
```

If validation crashes, do not publish raw candidate findings.

---

## 19. Configuration

### 19.1 Environment-level config

```ts
export type FindingValidationEnvConfig = {
  defaultProfileName: string;
  enableSemanticDedupe: boolean;
  enableLlmContradictionJudge: boolean;
  maxCandidatesPerReview: number;
  maxValidationMs: number;
  persistRejectedFindings: boolean;
  persistValidationEvents: boolean;
};
```

### 19.2 Repo-level settings

From `RepositorySettings`:

```text
review_policy
severity_threshold
max_comments_per_pr
max_comments_per_file
ignored_paths
enabled_categories
disabled_categories
skip_generated_files
allow_summary_only_findings
allow_file_level_comments
allow_check_annotations
custom_rules
```

### 19.3 Validation profiles

Suggested profiles:

```text
strict_default
  - fewer comments
  - high confidence threshold
  - no style comments
  - no summary-only low severity

security_focused
  - security boosted
  - critical/high security bypasses some budget rules

high_recall_dry_run
  - lower confidence threshold
  - persists many rejected/candidate findings
  - publishes none or summary-only

eval_mode
  - no budget rejection
  - no previous-comment suppression
  - all scores persisted
```

---

## 20. Integration with repo rules

Repo rules should be evaluated as declarative policies where possible.

Example rule contract:

```ts
export type RepoRule = {
  id: RepoRuleId;
  repoId: RepoId;
  kind: "suppress" | "require" | "boost" | "threshold";
  enabled: boolean;
  name: string;
  description?: string;
  matcher: RepoRuleMatcher;
  action: RepoRuleAction;
  priority: number;
};
```

Example matchers:

```ts
export type RepoRuleMatcher = {
  pathGlob?: string;
  category?: FindingCategory[];
  severity?: FindingSeverity[];
  source?: FindingSource[];
  titleContains?: string[];
  bodyContains?: string[];
};
```

Example actions:

```ts
export type RepoRuleAction =
  | { type: "suppress"; reason: string }
  | { type: "boost"; points: number; reason: string }
  | { type: "set_min_confidence"; confidence: number }
  | { type: "force_summary_only"; reason: string }
  | { type: "force_inline_allowed"; reason: string };
```

Policy precedence:

```text
1. Security/safety hard blocks
2. Explicit suppress rules
3. Explicit repo/category disablement
4. Memory suppression
5. Threshold rules
6. Boost rules
7. Default validation profile
```

---

## 21. Integration with memory

Memory facts should be treated as input signals, not hidden magic.

Memory fact examples:

```text
Team rejected missing-test comments for snapshot-only changes.
Team accepts strict security comments even on generated config files.
This repo intentionally uses nullable returns in service methods.
```

Memory influence types:

```text
suppress
boost
lower_threshold
raise_threshold
summary_only
```

Rules:

```text
- Every memory-based decision must cite memoryFactId in validation events.
- Memory should not suppress critical security findings unless explicit and high-confidence.
- Memory facts should have confidence and expiration.
- Memory should be visible in the dashboard.
```

---

## 22. Integration with publisher

The publisher should trust but verify.

#19 guarantees:

```text
- inline comments have validated anchors
- body/title are user-safe
- duplicate publishing is minimized
- budget is enforced
- summary text is bounded
```

#20 Publisher should still verify:

```text
- head SHA still matches
- GitHub API accepts anchor
- duplicate GitHub comment was not posted concurrently
- body does not exceed provider limits
```

If Publisher rejects a planned comment due to provider validation, store that as a publishing failure, not as a validation failure.

---

## 23. Integration with review orchestrator

The orchestrator should call validation after review passes and before publish job enqueue.

```ts
const validationResult = await findingValidationEngine.validate({
  reviewRunId,
  repoId,
  orgId,
  snapshot,
  changeSet,
  contextBundle,
  lineAnchorIndex,
  candidates,
  repositorySettings,
  repoRules,
  memoryFacts,
  previousPublishedFindings,
  validationProfile,
  budget,
  now,
});

await reviewRunRepository.saveValidationResult(validationResult);

if (validationResult.publishPlan.mode !== "none") {
  await queue.enqueue("review.publish", {
    reviewRunId,
    publishPlanId: validationResult.publishPlan.planId,
  });
}
```

If all findings are rejected, the review can still publish a summary if configured, or do nothing.

Recommended default:

```text
No findings -> no inline comments.
Optionally update check run with "No high-confidence issues found".
```

---

## 24. Observability

### 24.1 Logs

Log at review-run level:

```text
reviewRunId
repoId
pullRequestNumber
candidateCount
acceptedCount
rejectedCount
duplicateCount
publishableInlineCount
publishPlanMode
validationDurationMs
```

Do not log raw code snippets by default.

### 24.2 Metrics

```text
finding_validation.candidates.count
finding_validation.accepted.count
finding_validation.rejected.count
finding_validation.duplicates.count
finding_validation.duration_ms
finding_validation.rejection_reason.count
finding_validation.rank_score.histogram
finding_validation.budget_exceeded.count
finding_validation.anchor_unavailable.count
finding_validation.suppressed_by_rule.count
finding_validation.suppressed_by_memory.count
```

### 24.3 Traces

Span structure:

```text
finding_validation.validate
  finding_validation.normalize
  finding_validation.schema
  finding_validation.anchor
  finding_validation.evidence
  finding_validation.suppression
  finding_validation.dedupe
  finding_validation.ranking
  finding_validation.publish_plan
  finding_validation.persist
```

Attach safe metadata only:

```text
reviewRunId
repoId
candidateCount
acceptedCount
rejectedCount
duplicateCount
```

---

## 25. Testing strategy

This module needs heavy unit tests and fixture tests.

### 25.1 Unit tests

Test each validator independently.

```text
path validator
file-state validator
diff-anchor validator
evidence validator
context reference validator
confidence validator
style-nit validator
repo-rule validator
memory suppression validator
secret leak validator
suggested-fix validator
dedupe/ranking/budget functions
```

### 25.2 Fixture tests

Create fixtures under:

```text
/packages/review-engine/test/fixtures/validation
```

Recommended fixtures:

```text
valid-correctness-finding.json
valid-security-finding.json
invalid-line-not-in-diff.json
invalid-missing-evidence.json
duplicate-same-line-two-passes.json
duplicate-root-cause-multiple-lines.json
suppressed-generated-file.json
suppressed-repo-rule.json
suppressed-memory.json
budget-exceeded-large-pr.json
summary-only-high-severity.json
previous-comment-duplicate.json
secret-redaction.json
```

### 25.3 Golden tests

For each fixture, assert:

```text
accepted finding IDs
rejected candidate IDs
primary rejection reasons
duplicate group canonical ID
rank order
publish plan shape
```

### 25.4 Property tests

Useful invariants:

```text
Ranking is deterministic for same input.
Dedupe never increases finding count.
Budget output never exceeds configured max.
Rejected findings are never in publish plan.
All inline publish plan comments have anchors.
No visible comment body contains secret-like values.
```

### 25.5 End-to-end fake PR tests

Use fake `PullRequestSnapshot`, fake `LineAnchorIndex`, and fake review pass outputs.

Test scenarios:

```text
one good finding -> one inline comment planned
five duplicate candidates -> one planned comment
candidate outside diff -> rejected or summary-only
all candidates low confidence -> no publish plan
same candidate previously published -> no new inline comment
```

---

## 26. Performance considerations

Validation should be cheap relative to LLM calls and indexing.

### 26.1 Candidate caps

Set a hard cap:

```text
maxCandidatesPerReview = 200 default
```

If review passes produce more, keep the highest preliminary score per source/category and reject the rest as overflow.

### 26.2 Avoid O(n^2) semantic dedupe at scale

For dedupe:

```text
- bucket by file path/category first
- exact fingerprint map first
- location buckets second
- semantic compare only within likely buckets
```

Pseudo:

```ts
const buckets = groupBy(candidates, c => `${c.filePath}:${c.category}`);
for (const bucket of buckets.values()) {
  dedupeWithinBucket(bucket);
}
```

### 26.3 No extra model calls by default

Optional contradiction/semantic judges should be disabled in MVP or used only for top candidates.

Recommended:

```text
Run LLM judge only on top 20 preliminary candidates.
Do not run LLM judge on findings that deterministic validation already rejects.
```

### 26.4 Cache previous comment fingerprints

When validating a rerun, load previous fingerprints once.

```text
Set<fingerprint_exact>
Set<fingerprint_root_cause>
```

---

## 27. Security and privacy

Validation sees sensitive code-derived content. Treat it accordingly.

Rules:

```text
- Never log full finding bodies with code snippets by default.
- Redact secret-like values before persistence if visible to users.
- Keep raw candidate payloads in restricted debug artifacts if needed.
- Do not include private code in metrics labels.
- Do not include prompt text or retrieved snippets in validation traces.
- Enforce org/repo access checks for dashboard views of validation artifacts.
```

Secret redaction should happen before:

```text
- visible comment body
- visible evidence quote
- check annotation message
- PR summary item
```

---

## 28. Implementation sequence

### PR 1 - Package shell and types

Implement:

```text
/packages/review-engine/src/validation
  engine interface
  input/output types
  validation profile
  budget types
  rejection reason enum
  test builders
```

Deliverables:

```text
- compiles
- fixture builders
- no real validation yet
```

### PR 2 - Candidate normalization

Implement:

```text
normalize path
normalize severity
normalize confidence
normalize title/body
normalize evidence
fingerprint helpers
```

Tests:

```text
path normalization
bad path rejection
stable fingerprint generation
body length trimming/rejection
```

### PR 3 - Core validators

Implement:

```text
schema validator
path validator
file-state validator
confidence validator
severity/category validator
evidence validator
context reference validator
```

Tests:

```text
valid candidate accepted by core validators
missing evidence rejected
low confidence rejected
category disabled rejected
invalid context item rejected
```

### PR 4 - Diff anchor validator

Implement:

```text
LineAnchorIndex integration
inline anchor resolution
nearest-anchor policy
summary-only fallback
anchor events
```

Tests:

```text
line in diff accepted
line outside diff rejected
LEFT/RIGHT side handling
renamed file handling
deleted file handling
multiline range handling
```

### PR 5 - Policy and suppression validators

Implement:

```text
style-nit validator
generated file validator
ignored path validator
repo rule validator
memory suppression validator
previous comment validator
secret leak validator
```

Tests:

```text
generated path rejected
repo rule suppresses finding
memory suppresses finding
previous comment duplicate rejected
secret content redacted/rejected
```

### PR 6 - Dedupe

Implement:

```text
exact dedupe
location dedupe
root-cause dedupe
canonical selection
duplicate group output
```

Tests:

```text
same exact fingerprint collapses
same location similar claim collapses
canonical keeps higher severity/confidence
non-duplicates preserved
```

### PR 7 - Ranking and budgets

Implement:

```text
rank score function
rank reasons
category/source/evidence scoring
comment budget enforcement
per-file cap
reserved category slots
```

Tests:

```text
security beats style
high confidence beats low confidence
budget caps inline comments
per-file caps work
rank order deterministic
```

### PR 8 - Publish plan

Implement:

```text
inline comment selection
summary item selection
check annotation selection
publish plan creation
mode selection
```

Tests:

```text
accepted inline finding becomes planned comment
unanchorable high finding becomes summary-only
no accepted findings -> mode none
check annotation plan for tool finding
```

### PR 9 - Persistence

Implement:

```text
save validation result
insert accepted/rejected/groups/events/publish plan
idempotent rerun behavior
review run stage update
```

Tests:

```text
transaction rollback
rerun replaces previous validation attempt
publish plan persisted
```

### PR 10 - Orchestrator integration

Implement:

```text
#16 calls validation after #18 review passes
publish job receives publishPlanId
review run artifacts updated
metrics emitted
```

Tests:

```text
end-to-end fake review with publish plan
all rejected -> no publish job
```

---

## 29. MVP cut

Build this first:

```text
- FindingValidationEngine interface
- validation profile and budget types
- candidate normalization
- schema/path/file-state validators
- diff anchor validator
- evidence/context validators
- confidence/severity/category validators
- generated/ignored path validator
- exact and location dedupe
- simple ranking function
- comment budget enforcement
- publish plan builder
- persistence of accepted/rejected findings
- validation metrics
- unit + fixture tests
```

Defer:

```text
- semantic dedupe embeddings
- LLM contradiction judge
- advanced memory suppression
- complex root-cause grouping
- auto-generated suggested fix validation
- provider-specific fallback strategies beyond GitHub
```

---

## 30. Definition of done

#19 is done when:

```text
- Every CandidateFinding is either accepted or rejected with explicit reasons.
- Every planned inline comment has a valid diff anchor.
- Rejected findings are persisted or artifacted for debugging.
- Duplicate findings from multiple passes are collapsed deterministically.
- Ranking is deterministic and explainable.
- Comment budgets are enforced.
- Repo settings and ignored paths affect validation.
- Previous published bot comments prevent duplicate reposting.
- Validation never publishes raw, unvalidated model output.
- The orchestrator can call validation and enqueue publisher with a PublishPlan.
- Unit tests cover each validator.
- Fixture tests cover good, bad, duplicate, suppressed, and budgeted findings.
```

---

## 31. Example end-to-end validation trace

Input candidates:

```text
1. correctness finding on src/auth/session.ts:84
2. security finding on src/auth/session.ts:84 with same root cause
3. missing-test finding for same issue
4. style finding about variable name
5. correctness finding on line outside diff
```

Validation output:

```text
Accepted:
  - security finding on src/auth/session.ts:84

Rejected:
  - correctness duplicate -> duplicate_root_cause
  - missing-test duplicate -> duplicate_root_cause / summary support
  - style finding -> style_only
  - outside-diff finding -> line_not_in_diff

PublishPlan:
  - one inline comment at src/auth/session.ts:84 RIGHT
  - PR summary mentions one lower-priority test suggestion only if configured
```

This is the behavior we want: one useful comment, not five noisy comments.

---

## 32. Example code skeleton

```ts
export class DefaultFindingValidationEngine implements FindingValidationEngine {
  constructor(
    private readonly validators: FindingValidator[],
    private readonly deduper: FindingDeduper,
    private readonly ranker: FindingRanker,
    private readonly publishPlanner: PublishPlanner,
    private readonly repository: FindingValidationRepository,
  ) {}

  async validate(input: ValidateFindingsInput): Promise<ValidateFindingsResult> {
    const normalized = input.candidates.map((candidate) =>
      normalizeCandidate(candidate, input),
    );

    const validationResults = [];

    for (const candidate of normalized) {
      const result = await validateOneCandidate({
        candidate,
        input,
        validators: this.validators,
      });

      validationResults.push(result);
    }

    const prelimAccepted = validationResults
      .filter((result) => result.status === "accepted")
      .map((result) => result.finding);

    const prelimRejected = validationResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.rejectedFinding);

    const dedupeResult = await this.deduper.dedupe({
      findings: prelimAccepted,
      previousPublishedFindings: input.previousPublishedFindings,
    });

    const ranked = this.ranker.rank({
      findings: dedupeResult.canonicalFindings,
      input,
    });

    const publishPlan = this.publishPlanner.build({
      rankedFindings: ranked,
      duplicateGroups: dedupeResult.groups,
      input,
    });

    const result: ValidateFindingsResult = {
      reviewRunId: input.reviewRunId,
      accepted: ranked.filter((finding) => publishPlan.includes(finding.id)),
      rejected: [
        ...prelimRejected,
        ...dedupeResult.rejectedDuplicates,
        ...publishPlan.rejectedByBudget,
      ],
      duplicateGroups: dedupeResult.groups,
      publishPlan,
      stats: computeStats(validationResults, dedupeResult, publishPlan),
      trace: buildTrace(validationResults, dedupeResult, publishPlan),
    };

    await this.repository.save(result);

    return result;
  }
}
```

---

## 33. References

Official provider details that affect validation and publishing:

```text
GitHub REST API - Pull request review comments
https://docs.github.com/en/rest/pulls/comments

GitHub REST API - Pull request reviews
https://docs.github.com/en/rest/pulls/reviews

GitHub REST API guide - Working with comments
https://docs.github.com/en/rest/guides/working-with-comments
```

Important current details reflected in this spec:

```text
- PR review comments are comments on the pull request diff.
- GitHub recommends line/side and start_line/start_side for line comments.
- The legacy position parameter is described as closing down.
- Creating comments too quickly can trigger secondary rate limiting.
- GitHub distinguishes PR timeline comments from review comments on specific lines.
```
