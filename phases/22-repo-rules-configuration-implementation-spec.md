# #22 Repo Rules and Configuration Implementation Spec

## Status

Proposed implementation spec.

This document defines the **Repo Rules and Configuration** system for the code review agent. It is the policy layer that controls when reviews run, which files are considered, what kinds of findings are allowed, how aggressive the reviewer should be, and how repo/team preferences are applied consistently.

The core idea:

```text
System defaults
  -> org settings
  -> repo settings
  -> repo-local config file
  -> explicit repo rules
  -> memory-derived suppressions
  -> immutable ReviewPolicySnapshot
  -> decisions used by webhook, indexing, retrieval, validation, and publishing
```

Rules and settings should be explicit, typed, explainable, auditable, and safe to evaluate. This system should not become an arbitrary scripting engine.

---

## 1. Scope

This workstream implements the durable policy/configuration layer for the reviewer.

Recommended package:

```text
/packages/rules
```

Additional integrations:

```text
/apps/api
/apps/web
/apps/worker
/packages/db
/packages/contracts
/packages/github
/packages/repo-sync
/packages/indexer-driver
/packages/retrieval
/packages/review-engine
/packages/publisher
/packages/memory
/packages/observability
```

The package should provide:

```text
- RepositorySettings schema support
- OrgSettings schema support
- RepoRule schema support
- ReviewPolicySnapshot builder
- rule evaluation engine
- glob/path matching utilities
- config validation
- config merge/precedence logic
- policy decision traces
- dashboard/API DTO support
- config file parser
- rule test utilities
- audit hooks
```

This section is cross-cutting. It affects:

```text
webhook ingestion       -> should this PR enqueue review work?
repo sync/indexing      -> which paths are skipped?
retrieval               -> which context sources are enabled?
review passes           -> which categories/passes are allowed?
finding validation      -> which findings are suppressed or downgraded?
publisher               -> summary/check/comment behavior
memory                  -> which memory facts are allowed to suppress findings?
dashboard/API           -> how users configure and inspect behavior
```

---

## 2. Non-goals

Do **not** implement these in the first version:

```text
- arbitrary JavaScript rule execution
- user-authored code running inside workers
- full OPA/Rego policy engine
- complex natural-language rules that the model interprets directly
- automatic high-impact setting changes from one user comment
- branch protection management
- GitHub Ruleset management
- cross-repo hidden policy inheritance users cannot inspect
- billing-plan enforcement inside the rule evaluator
- permission decisions based only on untrusted repo-local config
```

This system controls reviewer behavior. It should not replace GitHub branch protection, organization compliance policies, or CI/CD policy engines.

---

## 3. Design principles

### 3.1 Configuration is explicit state

A setting or rule should be a structured object, not buried in prompts.

Bad:

```text
The prompt says: "Be stricter for security files and don't review generated code."
```

Good:

```ts
{
  pathFilters: {
    ignoredPaths: ["**/generated/**", "**/*.pb.ts"]
  },
  findingPolicy: {
    enabledCategories: ["correctness", "security", "test_coverage"],
    severityThreshold: "medium"
  }
}
```

The review engine may receive human-readable policy summaries, but the source of truth should be typed configuration.

### 3.2 Every decision should be explainable

A user should be able to ask:

```text
Why did the bot review this PR?
Why did it skip this file?
Why was this finding suppressed?
Why did it post only a summary?
Why was the max comment count 3?
```

The system should answer with a `PolicyDecisionTrace`.

Example:

```json
{
  "decision": "suppressed",
  "reasonCode": "path_ignored",
  "matchedRuleIds": ["rule_ignore_generated"],
  "details": {
    "path": "src/generated/client.ts",
    "pattern": "**/generated/**"
  }
}
```

### 3.3 Rules are evaluated on snapshots

A review run should not use live mutable settings throughout execution.

At review start, build and persist:

```text
ReviewPolicySnapshot
```

It captures:

```text
- system defaults version
- org settings version
- repo settings version
- repo-local config version/hash
- active rule IDs and versions
- memory policy version
- effective policy JSON
- policy hash
```

All stages of that review run use the same snapshot.

### 3.4 Repo-local config is useful but partially untrusted

A repo-local config file is useful for keeping review behavior close to the codebase.

Example:

```text
.ai-reviewer.yml
```

But a PR author could modify that file in their branch. Therefore:

```text
For normal PR review, use config from the trusted base SHA.
```

If the PR changes the config file, the reviewer can mention that the policy file changed, but the changed config should not be allowed to lower review strictness or suppress findings in the same PR unless the PR is trusted and merged.

### 3.5 Avoid arbitrary policy languages early

Typed rules are enough for the MVP.

Prefer:

```ts
RuleCondition
RuleAction
RulePriority
RuleScope
```

Avoid:

```text
custom JS expressions
custom SQL expressions
free-form LLM-interpreted policy
full Rego policies
```

A future enterprise version can integrate a real policy engine, but the first version should prioritize safety, auditability, and low operational complexity.

### 3.6 Memory and rules are different

Rules are explicit configuration.

Memory is feedback-derived preference/context.

They can interact, but they should not be conflated.

```text
RepoRule:
  Created by repo admin.
  Explicitly active.
  Directly controls policy.

MemoryFact:
  Created from feedback or command.
  May need approval.
  Used by retrieval/validation as context or suppression evidence.
```

### 3.7 Precedence must be deterministic

When settings conflict, there should be one obvious outcome.

Recommended precedence:

```text
1. System safety floor
2. Plan/entitlement constraints
3. Org settings
4. Repo settings from dashboard/API
5. Repo-local config file from trusted base SHA
6. Explicit active RepoRules
7. Manual review-run override
8. Safety validation floor
```

Important nuance:

```text
System safety floor and validation floor always win.
```

For example, a user should not be able to set:

```text
minimumConfidence = 0.05
```

if the product-wide safety floor is:

```text
minimumConfidence >= 0.65
```

---

## 4. Conceptual architecture

```text
                ┌──────────────────────┐
                │ System Defaults       │
                └──────────┬───────────┘
                           │
                ┌──────────v───────────┐
                │ Org Settings          │
                └──────────┬───────────┘
                           │
                ┌──────────v───────────┐
                │ Repo Settings         │
                └──────────┬───────────┘
                           │
                ┌──────────v───────────┐
                │ Repo-local Config     │
                └──────────┬───────────┘
                           │
                ┌──────────v───────────┐
                │ Active Repo Rules     │
                └──────────┬───────────┘
                           │
                ┌──────────v───────────┐
                │ Policy Compiler       │
                └──────────┬───────────┘
                           │
                ┌──────────v───────────┐
                │ ReviewPolicySnapshot │
                └──────────┬───────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          v                v                v
   Webhook gate       Retrieval        Validation/publish
```

Recommended package boundary:

```text
/packages/rules
  src/
    index.ts
    types.ts
    defaults.ts
    compiler.ts
    evaluator.ts
    matcher.ts
    config-file.ts
    validation.ts
    traces.ts
    repo-rule-store.ts
    policy-store.ts
    api-dto.ts
    fixtures.ts
```

The rule package should not call GitHub, clone repos, invoke LLMs, or publish comments. It should receive data and return decisions.

---

## 5. Main objects

### 5.1 RepositorySettings

This is the durable, user-configured repo-level setting object.

Existing table from #2:

```text
repository_settings
```

Recommended contract shape:

```ts
export type RepositorySettings = {
  schemaVersion: "repository_settings.v1";
  repoId: RepoId;
  orgId: OrgId;

  enabled: boolean;
  reviewMode: ReviewMode;

  triggerPolicy: ReviewTriggerPolicy;
  pathPolicy: PathPolicy;
  findingPolicy: FindingPolicy;
  retrievalPolicy: RetrievalPolicy;
  reviewPassPolicy: ReviewPassPolicy;
  publishingPolicy: PublishingPolicy;
  memoryPolicy: MemoryPolicy;
  staticAnalysisPolicy: StaticAnalysisPolicy;

  configFilePolicy: ConfigFilePolicy;

  updatedAt: IsoDateTime;
  updatedByUserId: UserId | null;
  version: number;
};
```

### 5.2 OrgSettings

Org settings provide defaults for repos.

```ts
export type OrgSettings = {
  schemaVersion: "org_settings.v1";
  orgId: OrgId;

  defaultReviewMode: ReviewMode;
  defaultTriggerPolicy: ReviewTriggerPolicy;
  defaultFindingPolicy: FindingPolicy;
  defaultPublishingPolicy: PublishingPolicy;
  defaultMemoryPolicy: MemoryPolicy;

  allowedModelProfiles?: string[];
  allowRepoLocalConfig: boolean;
  allowMemorySuppression: boolean;
  allowUserDefinedRules: boolean;

  updatedAt: IsoDateTime;
  updatedByUserId: UserId | null;
  version: number;
};
```

MVP can skip full org settings if needed, but the contracts should leave room for them.

### 5.3 RepoRule

A repo rule is a typed condition/action rule.

```ts
export type RepoRule = {
  schemaVersion: "repo_rule.v1";
  ruleId: RepoRuleId;
  orgId: OrgId;
  repoId?: RepoId;

  name: string;
  description?: string;
  status: "active" | "disabled" | "draft" | "archived";

  scope: RuleScope;
  priority: number;

  conditions: RuleConditionGroup;
  action: RuleAction;

  source: "dashboard" | "api" | "config_file" | "memory_candidate" | "system";

  createdAt: IsoDateTime;
  createdByUserId: UserId | null;
  updatedAt: IsoDateTime;
  updatedByUserId: UserId | null;

  version: number;
};
```

### 5.4 ReviewPolicySnapshot

This is the immutable policy object used by a review run.

```ts
export type ReviewPolicySnapshot = {
  schemaVersion: "review_policy_snapshot.v1";

  policySnapshotId: PolicySnapshotId;
  reviewRunId?: ReviewRunId;
  orgId: OrgId;
  repoId: RepoId;

  createdAt: IsoDateTime;

  systemDefaultsVersion: string;
  orgSettingsVersion?: number;
  repositorySettingsVersion: number;
  repoConfigFileHash?: Sha256;
  activeRuleVersions: Array<{
    ruleId: RepoRuleId;
    version: number;
  }>;

  effectivePolicy: EffectiveReviewPolicy;
  policyHash: Sha256;

  decisionInputs: PolicySnapshotInputSummary;
};
```

This should be persisted as a review artifact and referenced from `review_runs`.

### 5.5 EffectiveReviewPolicy

This is the compiled form that all components consume.

```ts
export type EffectiveReviewPolicy = {
  enabled: boolean;
  reviewMode: ReviewMode;

  trigger: CompiledTriggerPolicy;
  paths: CompiledPathPolicy;
  findings: CompiledFindingPolicy;
  retrieval: CompiledRetrievalPolicy;
  reviewPasses: CompiledReviewPassPolicy;
  publishing: CompiledPublishingPolicy;
  memory: CompiledMemoryPolicy;
  staticAnalysis: CompiledStaticAnalysisPolicy;

  instructions: PolicyInstruction[];
  suppressions: CompiledSuppressionRule[];

  safetyFloor: SafetyFloorPolicy;
};
```

### 5.6 PolicyDecisionTrace

Every rule decision should return a trace.

```ts
export type PolicyDecisionTrace = {
  schemaVersion: "policy_decision_trace.v1";

  decisionType:
    | "should_review_pr"
    | "should_index_file"
    | "should_retrieve_context"
    | "should_run_pass"
    | "should_publish_finding"
    | "comment_budget"
    | "memory_allowed";

  decision: string;
  reasonCode: string;
  matchedRuleIds: RepoRuleId[];
  evaluatedRuleCount: number;
  details: Record<string, unknown>;
};
```

---

## 6. Review modes

Recommended enum:

```ts
export type ReviewMode =
  | "off"
  | "dry_run"
  | "summary_only"
  | "check_run_only"
  | "inline_comments"
  | "inline_comments_with_summary";
```

Meaning:

```text
off
  Do not enqueue or perform reviews.

dry_run
  Run review, store artifacts, publish nothing.

summary_only
  Publish PR summary only; no inline comments.

check_run_only
  Publish check run only. Useful for CI-style usage.

inline_comments
  Publish inline comments only.

inline_comments_with_summary
  Publish inline comments plus PR summary.
```

Recommended MVP default:

```text
inline_comments_with_summary
```

Recommended conservative default for early private beta:

```text
summary_only or dry_run for first run after install
```

---

## 7. Trigger policy

The trigger policy decides whether a PR event should create or resume a review.

```ts
export type ReviewTriggerPolicy = {
  reviewOnOpen: boolean;
  reviewOnSynchronize: boolean;
  reviewOnReopen: boolean;
  reviewOnReadyForReview: boolean;
  reviewOnLabelAdded: boolean;
  reviewOnManualRequest: boolean;

  skipDraftPullRequests: boolean;
  skipDependabotPullRequests: boolean;
  skipBotAuthors: boolean;

  requireAnyLabel?: string[];
  requireAllLabels?: string[];
  skipIfAnyLabel?: string[];

  includeBaseBranches?: string[];
  excludeBaseBranches?: string[];
  includeHeadBranches?: string[];
  excludeHeadBranches?: string[];

  includeAuthors?: string[];
  excludeAuthors?: string[];

  maxChangedFiles?: number;
  maxChangedLines?: number;
  maxDiffBytes?: number;

  debounceSeconds: number;
};
```

Example:

```json
{
  "reviewOnOpen": true,
  "reviewOnSynchronize": true,
  "reviewOnReopen": true,
  "reviewOnReadyForReview": true,
  "reviewOnLabelAdded": true,
  "reviewOnManualRequest": true,
  "skipDraftPullRequests": true,
  "skipDependabotPullRequests": false,
  "skipBotAuthors": false,
  "requireAnyLabel": [],
  "skipIfAnyLabel": ["no-ai-review"],
  "includeBaseBranches": ["main", "master", "release/**"],
  "excludeBaseBranches": [],
  "maxChangedFiles": 300,
  "maxChangedLines": 5000,
  "maxDiffBytes": 2000000,
  "debounceSeconds": 20
}
```

Webhook ingestion should not run a complex review. It should evaluate a cheap trigger decision and enqueue durable jobs.

```text
pull_request.opened
  -> build lightweight PR event input
  -> evaluate shouldReviewPr
  -> if true, create review job
  -> if false, persist skip decision
```

Decision output:

```ts
export type ShouldReviewPrDecision = {
  shouldReview: boolean;
  reviewMode: ReviewMode;
  reasonCode:
    | "repo_disabled"
    | "review_mode_off"
    | "event_not_enabled"
    | "draft_pr_skipped"
    | "missing_required_label"
    | "blocked_label_present"
    | "base_branch_excluded"
    | "author_excluded"
    | "diff_too_large"
    | "allowed";
  trace: PolicyDecisionTrace;
};
```

---

## 8. Path policy

Path policy controls which files are considered by indexing, retrieval, review, validation, and publishing.

```ts
export type PathPolicy = {
  ignoredPaths: string[];
  includedPaths?: string[];
  generatedPaths: string[];
  vendoredPaths: string[];
  testPaths: string[];
  configPaths: string[];
  documentationPaths: string[];

  maxFileBytes: number;
  maxFileLines: number;

  includeBinaryFiles: false;
  followSymlinks: false;

  pathMatchingMode: "picomatch";
};
```

Recommended defaults:

```ts
export const DEFAULT_PATH_POLICY: PathPolicy = {
  ignoredPaths: [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/.next/**",
    "**/.turbo/**",
    "**/.cache/**",
    "**/vendor/**",
    "**/*.min.js",
    "**/*.map"
  ],
  generatedPaths: [
    "**/generated/**",
    "**/__generated__/**",
    "**/*.generated.*",
    "**/*.pb.*",
    "**/*.gen.*"
  ],
  vendoredPaths: [
    "**/vendor/**",
    "**/third_party/**"
  ],
  testPaths: [
    "**/*.test.*",
    "**/*.spec.*",
    "**/__tests__/**",
    "**/tests/**"
  ],
  configPaths: [
    "package.json",
    "pnpm-lock.yaml",
    "bun.lockb",
    "tsconfig*.json",
    "pyproject.toml",
    "go.mod",
    "Cargo.toml",
    ".github/workflows/**"
  ],
  documentationPaths: [
    "**/*.md",
    "docs/**"
  ],
  maxFileBytes: 512_000,
  maxFileLines: 10000,
  includeBinaryFiles: false,
  followSymlinks: false,
  pathMatchingMode: "picomatch"
};
```

### 8.1 Path normalization

All paths must be normalized before matching:

```text
- POSIX-style `/` separators
- no leading `./`
- no leading `/`
- no `..` segments
- no null bytes
- Unicode normalized to NFC
- case-sensitive by default
```

Example helper:

```ts
export function normalizeRepoPath(input: string): RepoPath {
  const path = input.replaceAll("\\", "/");
  // reject absolute, reject .., strip leading ./, validate chars
  return RepoPathSchema.parse(path);
}
```

### 8.2 Include/exclude semantics

Prefer explicit include/exclude arrays over negated globs.

```ts
export type PathMatcherInput = {
  path: RepoPath;
  language?: Language;
  sizeBytes?: number;
  lineCount?: number;
};
```

Semantics:

```text
1. If includedPaths is non-empty, path must match at least one included path.
2. If path matches ignoredPaths, skip.
3. If path matches generatedPaths, mark generated.
4. If path matches vendoredPaths, mark vendored.
5. If file size or line count exceeds limits, skip or degrade.
```

Return:

```ts
export type PathClassification = {
  path: RepoPath;
  included: boolean;
  ignored: boolean;
  generated: boolean;
  vendored: boolean;
  test: boolean;
  config: boolean;
  documentation: boolean;
  reasonCodes: string[];
  matchedPatterns: string[];
};
```

---

## 9. Finding policy

Finding policy controls what kinds of findings can be published.

```ts
export type FindingPolicy = {
  enabledCategories: FindingCategory[];
  disabledCategories: FindingCategory[];

  severityThreshold: FindingSeverity;
  minimumConfidence: number;

  maxCommentsPerPr: number;
  maxCommentsPerFile: number;
  maxCommentsPerCategory: Partial<Record<FindingCategory, number>>;

  allowStyleFindings: boolean;
  allowLowSeverityFindings: boolean;
  allowSuggestionsWithoutConcreteEvidence: boolean;

  suppressGeneratedFileFindings: boolean;
  suppressVendoredFileFindings: boolean;
  suppressDocumentationOnlyFindings: boolean;

  categoryThresholds?: Partial<Record<FindingCategory, {
    severityThreshold?: FindingSeverity;
    minimumConfidence?: number;
    maxComments?: number;
  }>>;
};
```

Recommended defaults:

```ts
export const DEFAULT_FINDING_POLICY: FindingPolicy = {
  enabledCategories: [
    "correctness",
    "security",
    "test_coverage",
    "performance",
    "architecture"
  ],
  disabledCategories: [],
  severityThreshold: "medium",
  minimumConfidence: 0.75,
  maxCommentsPerPr: 5,
  maxCommentsPerFile: 2,
  maxCommentsPerCategory: {
    security: 3,
    correctness: 3,
    test_coverage: 2,
    performance: 1,
    architecture: 1
  },
  allowStyleFindings: false,
  allowLowSeverityFindings: false,
  allowSuggestionsWithoutConcreteEvidence: false,
  suppressGeneratedFileFindings: true,
  suppressVendoredFileFindings: true,
  suppressDocumentationOnlyFindings: true
};
```

### 9.1 Safety floor

A safety floor prevents configuration from making the bot noisy or unsafe.

```ts
export type SafetyFloorPolicy = {
  minimumAllowedConfidence: number;
  minimumPublishSeverity: FindingSeverity;
  maxAllowedCommentsPerPr: number;
  alwaysSuppressGeneratedFiles: boolean;
  alwaysRequireLineAnchorForInlineComments: boolean;
  alwaysRequireEvidence: boolean;
};
```

Recommended MVP safety floor:

```ts
{
  minimumAllowedConfidence: 0.65,
  minimumPublishSeverity: "medium",
  maxAllowedCommentsPerPr: 10,
  alwaysSuppressGeneratedFiles: false,
  alwaysRequireLineAnchorForInlineComments: true,
  alwaysRequireEvidence: true
}
```

Do not let repo config bypass the final validator from #19.

---

## 10. Retrieval policy

Retrieval policy controls how context is assembled.

```ts
export type RetrievalPolicy = {
  maxContextTokens: number;

  enableSameFileContext: boolean;
  enableImportContext: boolean;
  enableCallerCalleeContext: boolean;
  enableRelatedTests: boolean;
  enableSemanticSearch: boolean;
  enableLexicalSearch: boolean;
  enableConfigContext: boolean;
  enableMemoryContext: boolean;
  enableCodeownersContext: boolean;

  maxContextItemsPerSource: Partial<Record<ContextSourceKind, number>>;

  includeGeneratedContext: boolean;
  includeVendoredContext: boolean;
  includeDocumentationContext: boolean;

  semanticSearchLimit: number;
  lexicalSearchLimit: number;
  graphSearchDepth: number;
};
```

Recommended default:

```ts
export const DEFAULT_RETRIEVAL_POLICY: RetrievalPolicy = {
  maxContextTokens: 32000,
  enableSameFileContext: true,
  enableImportContext: true,
  enableCallerCalleeContext: true,
  enableRelatedTests: true,
  enableSemanticSearch: true,
  enableLexicalSearch: true,
  enableConfigContext: true,
  enableMemoryContext: true,
  enableCodeownersContext: false,
  maxContextItemsPerSource: {
    same_file: 8,
    graph: 12,
    related_tests: 8,
    semantic: 16,
    lexical: 8,
    config: 6,
    memory: 6
  },
  includeGeneratedContext: false,
  includeVendoredContext: false,
  includeDocumentationContext: true,
  semanticSearchLimit: 24,
  lexicalSearchLimit: 16,
  graphSearchDepth: 1
};
```

Retrieval should return trace data showing which policy constraints shaped the context bundle.

---

## 11. Review pass policy

This controls which specialized passes run.

```ts
export type ReviewPassPolicy = {
  enabledPasses: ReviewPassName[];
  disabledPasses: ReviewPassName[];

  passBudgets: Partial<Record<ReviewPassName, {
    maxInputTokens?: number;
    maxOutputFindings?: number;
    modelProfile?: string;
    timeoutMs?: number;
  }>>;

  categoryToPasses: Partial<Record<FindingCategory, ReviewPassName[]>>;
};
```

Recommended default:

```ts
{
  enabledPasses: [
    "pr_summary",
    "behavior_change",
    "correctness",
    "security",
    "test_coverage",
    "finding_judge"
  ],
  disabledPasses: [],
  passBudgets: {
    correctness: { maxOutputFindings: 8 },
    security: { maxOutputFindings: 6 },
    test_coverage: { maxOutputFindings: 4 }
  },
  categoryToPasses: {
    correctness: ["correctness", "behavior_change"],
    security: ["security"],
    test_coverage: ["test_coverage"]
  }
}
```

The review engine should not independently decide to run disabled passes.

---

## 12. Publishing policy

Publishing policy controls what is shown on GitHub.

```ts
export type PublishingPolicy = {
  publishInlineComments: boolean;
  publishSummaryComment: boolean;
  publishCheckRun: boolean;

  updateExistingSummaryComment: boolean;
  groupInlineCommentsIntoReview: boolean;

  includeSkippedReasonInSummary: boolean;
  includeConfidenceInComments: boolean;
  includeEvidenceInComments: boolean;
  includeSuggestedFixes: boolean;

  commentTone: "concise" | "normal" | "detailed";
  botSignature: "none" | "short" | "full";

  failCheckOnCriticalFindings: boolean;
  failCheckOnHighFindings: boolean;

  staleReviewBehavior: "do_not_publish" | "publish_summary_only";
};
```

Recommended default:

```ts
{
  publishInlineComments: true,
  publishSummaryComment: true,
  publishCheckRun: false,
  updateExistingSummaryComment: true,
  groupInlineCommentsIntoReview: true,
  includeSkippedReasonInSummary: false,
  includeConfidenceInComments: false,
  includeEvidenceInComments: true,
  includeSuggestedFixes: true,
  commentTone: "normal",
  botSignature: "short",
  failCheckOnCriticalFindings: true,
  failCheckOnHighFindings: false,
  staleReviewBehavior: "do_not_publish"
}
```

The publisher should still apply its own safety checks. This policy only defines the desired behavior.

---

## 13. Memory policy

Memory policy controls how feedback-derived memory can affect future reviews.

```ts
export type MemoryPolicy = {
  enableMemoryContext: boolean;
  enableMemorySuppression: boolean;
  requireApprovalForMemoryFacts: boolean;

  allowExactFindingSuppression: boolean;
  allowPathCategorySuppression: boolean;
  allowNaturalLanguageInstructions: boolean;

  maxMemoryFactsInContext: number;
  memoryTtlDays?: number;

  trustedFeedbackRoles: Array<"org_admin" | "repo_admin" | "maintainer" | "member">;
};
```

Recommended default:

```ts
{
  enableMemoryContext: true,
  enableMemorySuppression: true,
  requireApprovalForMemoryFacts: true,
  allowExactFindingSuppression: true,
  allowPathCategorySuppression: true,
  allowNaturalLanguageInstructions: true,
  maxMemoryFactsInContext: 6,
  memoryTtlDays: 180,
  trustedFeedbackRoles: ["org_admin", "repo_admin", "maintainer"]
}
```

Memory should not bypass the safety floor. For example, memory can suppress repeated false positives, but it should not suppress critical security findings unless the memory fact is explicit, trusted, and scoped.

---

## 14. Static analysis policy

This is initially optional, but define the policy now so #23 can integrate cleanly.

```ts
export type StaticAnalysisPolicy = {
  enabled: boolean;

  tools: Partial<Record<StaticAnalysisToolName, {
    enabled: boolean;
    mode: "detect_only" | "finding_source" | "context_only";
    timeoutMs: number;
    maxOutputBytes: number;
  }>>;

  allowDependencyInstall: boolean;
  allowNetworkAccess: boolean;
  sandboxRequired: boolean;
};
```

Recommended MVP default:

```ts
{
  enabled: false,
  tools: {},
  allowDependencyInstall: false,
  allowNetworkAccess: false,
  sandboxRequired: true
}
```

Do not allow repo config to enable dangerous command execution without explicit org/repo admin approval.

---

## 15. Repo-local configuration file

Allow teams to store reviewer config in the repo.

Recommended filename candidates:

```text
.ai-reviewer.yml
.ai-reviewer.yaml
.github/ai-reviewer.yml
.github/ai-reviewer.yaml
```

Policy:

```ts
export type ConfigFilePolicy = {
  enabled: boolean;
  allowedPaths: string[];
  trustMode: "base_sha_only" | "default_branch_only" | "disabled";
  allowConfigFileToDisableReviews: boolean;
  allowConfigFileToLowerSeverityThreshold: boolean;
  allowConfigFileToLowerConfidenceThreshold: boolean;
};
```

Recommended default:

```ts
{
  enabled: true,
  allowedPaths: [
    ".ai-reviewer.yml",
    ".ai-reviewer.yaml",
    ".github/ai-reviewer.yml",
    ".github/ai-reviewer.yaml"
  ],
  trustMode: "base_sha_only",
  allowConfigFileToDisableReviews: false,
  allowConfigFileToLowerSeverityThreshold: false,
  allowConfigFileToLowerConfidenceThreshold: false
}
```

### 15.1 Config file format

Example:

```yaml
version: 1

review:
  mode: inline_comments_with_summary
  max_comments_per_pr: 5
  severity_threshold: medium
  minimum_confidence: 0.75

triggers:
  skip_draft_pull_requests: true
  require_any_label: []
  skip_if_any_label:
    - no-ai-review
  include_base_branches:
    - main
    - release/**

paths:
  ignored:
    - "**/generated/**"
    - "**/*.pb.ts"
    - "**/vendor/**"
  tests:
    - "**/*.test.ts"
    - "**/*.spec.ts"
    - "**/__tests__/**"

categories:
  enabled:
    - correctness
    - security
    - test_coverage
  disabled:
    - style

publishing:
  summary: true
  inline_comments: true
  check_run: false

rules:
  - name: "Only security comments in generated config"
    when:
      paths:
        - ".github/workflows/**"
    action:
      enabled_categories:
        - security
        - correctness
      severity_threshold: high
```

### 15.2 Parsed config object

```ts
export type RepoLocalConfig = {
  schemaVersion: "repo_local_config.v1";
  configVersion: 1;
  sourcePath: RepoPath;
  sourceCommitSha: GitSha;
  sourceHash: Sha256;

  review?: Partial<ReviewSettingsConfig>;
  triggers?: Partial<ReviewTriggerPolicy>;
  paths?: Partial<PathPolicyConfig>;
  categories?: CategoryConfig;
  retrieval?: Partial<RetrievalPolicy>;
  publishing?: Partial<PublishingPolicy>;
  memory?: Partial<MemoryPolicy>;
  rules?: RepoRuleConfig[];
};
```

### 15.3 Config file safety

Hard rules:

```text
- parse from base SHA for PR reviews
- validate against strict schema
- reject unknown top-level keys by default
- reject arbitrary expressions
- reject extremely large config files
- reject dangerous path patterns
- store source path/hash in policy snapshot
- audit when config file changes
```

When a PR changes the config file:

```text
- use old/base policy for that review
- include config-file-change context if relevant
- optionally warn maintainers that reviewer behavior will change after merge
```

---

## 16. Rule condition model

Use a typed condition model.

```ts
export type RuleConditionGroup = {
  all?: RuleCondition[];
  any?: RuleCondition[];
  not?: RuleCondition[];
};
```

Supported conditions:

```ts
export type RuleCondition =
  | { type: "path_matches"; patterns: string[] }
  | { type: "path_not_matches"; patterns: string[] }
  | { type: "language_is"; languages: Language[] }
  | { type: "file_is_generated"; value: boolean }
  | { type: "file_is_test"; value: boolean }
  | { type: "finding_category_is"; categories: FindingCategory[] }
  | { type: "finding_severity_at_least"; severity: FindingSeverity }
  | { type: "finding_confidence_below"; confidence: number }
  | { type: "pr_has_any_label"; labels: string[] }
  | { type: "pr_has_all_labels"; labels: string[] }
  | { type: "pr_author_is"; authors: string[] }
  | { type: "base_branch_matches"; patterns: string[] }
  | { type: "head_branch_matches"; patterns: string[] }
  | { type: "changed_file_count_above"; count: number }
  | { type: "changed_line_count_above"; count: number }
  | { type: "symbol_kind_is"; kinds: SymbolKind[] }
  | { type: "review_pass_is"; passes: ReviewPassName[] };
```

Evaluation should be pure:

```ts
export function evaluateConditionGroup(
  group: RuleConditionGroup,
  input: RuleEvaluationInput,
  compiled: CompiledRuleAssets
): ConditionEvaluationResult;
```

### 16.1 Supported evaluation contexts

Not every condition is meaningful in every phase.

```ts
export type RuleEvaluationPhase =
  | "webhook_trigger"
  | "index_file"
  | "retrieve_context"
  | "review_pass"
  | "validate_finding"
  | "publish_review";
```

Example:

```text
finding_category_is
  valid in validate_finding
  invalid in webhook_trigger
```

Invalid phase/condition combinations should be caught at rule validation time.

---

## 17. Rule actions

Actions should be typed and limited.

```ts
export type RuleAction =
  | { type: "skip_review"; reason: string }
  | { type: "set_review_mode"; mode: ReviewMode }
  | { type: "set_max_comments"; maxComments: number }
  | { type: "set_severity_threshold"; severity: FindingSeverity }
  | { type: "set_minimum_confidence"; confidence: number }
  | { type: "enable_categories"; categories: FindingCategory[] }
  | { type: "disable_categories"; categories: FindingCategory[] }
  | { type: "suppress_findings"; reason: string }
  | { type: "downgrade_severity"; to: FindingSeverity; reason: string }
  | { type: "require_summary_only"; reason: string }
  | { type: "add_review_instruction"; instruction: string }
  | { type: "prioritize_context"; source: ContextSourceKind; boost: number }
  | { type: "disable_review_pass"; pass: ReviewPassName }
  | { type: "enable_review_pass"; pass: ReviewPassName };
```

### 17.1 Action application model

Some actions are compile-time settings:

```text
set_review_mode
set_max_comments
set_severity_threshold
enable_categories
disable_categories
```

Some are per-object decisions:

```text
suppress_findings
downgrade_severity
prioritize_context
```

Separate them internally:

```ts
export type PolicyCompileAction = ...;
export type RuntimeDecisionAction = ...;
```

This prevents webhook code from trying to evaluate finding-only actions.

---

## 18. Rule precedence and conflict resolution

### 18.1 Priority

Each rule has:

```ts
priority: number;
```

Recommended ranges:

```text
0-999       system rules
1000-1999   org rules
2000-2999   repo dashboard/API rules
3000-3999   repo-local config rules
4000-4999   memory-derived suppressions
9000+       safety floor / final validator rules
```

Lower number applies first. Higher priority can override where allowed.

### 18.2 Merge behavior

Settings merge behavior should be explicit by field.

```text
booleans
  later value overrides earlier value, unless safety floor forbids it

lists that represent allow-lists
  later value replaces by default

lists that represent suppressions/ignored paths
  append/union by default

thresholds
  stricter value wins when safety floor requires it

max comments
  lower value wins unless explicit override from admin/dashboard
```

Recommended helper:

```ts
export type MergePolicy =
  | "override"
  | "append_unique"
  | "min"
  | "max"
  | "stricter_threshold"
  | "looser_threshold"
  | "safety_clamped";
```

Define merge behavior in one table:

```ts
const FIELD_MERGE_POLICIES: Record<string, MergePolicy> = {
  "enabled": "override",
  "reviewMode": "override",
  "pathPolicy.ignoredPaths": "append_unique",
  "findingPolicy.minimumConfidence": "safety_clamped",
  "findingPolicy.maxCommentsPerPr": "safety_clamped"
};
```

### 18.3 Conflict examples

Example 1:

```text
Org: maxCommentsPerPr = 5
Repo: maxCommentsPerPr = 3
Effective: 3
```

Example 2:

```text
Repo-local config: minimumConfidence = 0.4
Safety floor: minimumConfidence >= 0.65
Effective: 0.65
Trace: config_clamped_by_safety_floor
```

Example 3:

```text
Rule A: suppress generated file findings
Rule B: enable security findings in generated files
Safety floor: require evidence + high confidence
Effective:
  security findings in generated files may be allowed only if Rule B has higher priority and generated suppression is not absolute.
```

This kind of ambiguity must be test-covered.

---

## 19. Policy compiler

The compiler builds an `EffectiveReviewPolicy`.

```ts
export type BuildPolicyInput = {
  orgId: OrgId;
  repoId: RepoId;
  baseSha?: GitSha;
  pullRequestNumber?: number;

  systemDefaults: SystemDefaults;
  orgSettings?: OrgSettings;
  repositorySettings: RepositorySettings;
  repoLocalConfig?: RepoLocalConfig;
  activeRules: RepoRule[];
  memoryFacts?: MemoryFact[];

  requestedModeOverride?: ReviewMode;
};
```

```ts
export type BuildPolicyResult = {
  snapshot: ReviewPolicySnapshot;
  warnings: PolicyWarning[];
  trace: PolicyCompilationTrace;
};
```

Compiler steps:

```text
1. Load system defaults.
2. Load org settings if available.
3. Load repository settings.
4. Load trusted repo-local config from base SHA if enabled.
5. Load active repo/org rules.
6. Filter rules by scope and status.
7. Validate all rules for phase/action compatibility.
8. Merge settings with deterministic precedence.
9. Clamp by safety floor.
10. Compile glob matchers.
11. Generate effective policy.
12. Hash policy JSON.
13. Persist ReviewPolicySnapshot.
```

### 19.1 Policy hash

Policy hash should be stable:

```ts
policyHash = sha256(canonicalJson(effectivePolicy));
```

Use canonical JSON with sorted object keys.

The same inputs should produce the same hash.

---

## 20. Rule evaluator

Recommended interface:

```ts
export interface RuleEvaluator {
  shouldReviewPr(input: ShouldReviewPrInput): ShouldReviewPrDecision;
  classifyPath(input: ClassifyPathInput): PathClassification;
  shouldIndexFile(input: ShouldIndexFileInput): PolicyDecision;
  shouldRetrieveContext(input: ShouldRetrieveContextInput): PolicyDecision;
  shouldRunReviewPass(input: ShouldRunReviewPassInput): PolicyDecision;
  evaluateFinding(input: EvaluateFindingPolicyInput): FindingPolicyDecision;
  getPublishingMode(input: GetPublishingModeInput): PublishingModeDecision;
}
```

### 20.1 Input objects

```ts
export type RuleEvaluationInput = {
  phase: RuleEvaluationPhase;
  policy: EffectiveReviewPolicy;

  pr?: PullRequestSnapshotSummary;
  path?: RepoPath;
  file?: FileSummary;
  changedFile?: ChangedFile;
  changedSymbol?: ChangedSymbol;
  finding?: CandidateFinding | ValidatedFinding;
  reviewPassName?: ReviewPassName;

  labels?: string[];
  author?: string;
  baseBranch?: string;
  headBranch?: string;
};
```

Keep inputs small. The rule evaluator should not need a full context bundle or full repo index.

### 20.2 Pure evaluation

Rule evaluation should be deterministic and side-effect-free.

Bad:

```ts
const setting = await db.query(...);
const ghLabels = await github.fetchLabels(...);
return evaluate(setting, ghLabels);
```

Good:

```ts
const input = { policy, labels, baseBranch, path };
return evaluator.shouldReviewPr(input);
```

The caller is responsible for fetching data.

---

## 21. Decision traces

Every evaluation should produce traces.

Example skip decision:

```json
{
  "schemaVersion": "policy_decision_trace.v1",
  "decisionType": "should_review_pr",
  "decision": "skip",
  "reasonCode": "blocked_label_present",
  "matchedRuleIds": [],
  "evaluatedRuleCount": 8,
  "details": {
    "label": "no-ai-review",
    "configuredLabels": ["no-ai-review"]
  }
}
```

Example finding suppression:

```json
{
  "schemaVersion": "policy_decision_trace.v1",
  "decisionType": "should_publish_finding",
  "decision": "suppress",
  "reasonCode": "category_disabled",
  "matchedRuleIds": ["rule_disable_style"],
  "evaluatedRuleCount": 14,
  "details": {
    "category": "style"
  }
}
```

Persist important traces:

```text
- review skip decisions
- policy snapshot compilation traces
- finding suppression traces
- publish mode decisions
```

Do not persist every tiny path classification unless debug mode is enabled.

---

## 22. Database model

Existing tables from #2:

```text
repository_settings
repo_rules
memory_facts
audit_logs
review_artifacts
```

Recommended additions/refinements:

### 22.1 `org_settings`

```sql
create table org_settings (
  org_id text primary key references orgs(id),
  settings_json jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_user_id text references users(id)
);
```

### 22.2 `repository_settings`

```sql
create table repository_settings (
  repo_id text primary key references repositories(id),
  org_id text not null references orgs(id),
  settings_json jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_user_id text references users(id)
);
```

Recommended indexes:

```sql
create index repository_settings_org_idx
on repository_settings (org_id);
```

### 22.3 `repo_rules`

```sql
create table repo_rules (
  id text primary key,
  org_id text not null references orgs(id),
  repo_id text references repositories(id),
  name text not null,
  description text,
  status text not null,
  scope text not null,
  priority integer not null,
  source text not null,
  rule_json jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  created_by_user_id text references users(id),
  updated_at timestamptz not null default now(),
  updated_by_user_id text references users(id)
);
```

Recommended indexes:

```sql
create index repo_rules_org_repo_status_idx
on repo_rules (org_id, repo_id, status);

create index repo_rules_priority_idx
on repo_rules (priority);
```

### 22.4 `policy_snapshots`

```sql
create table policy_snapshots (
  id text primary key,
  org_id text not null references orgs(id),
  repo_id text not null references repositories(id),
  review_run_id text references review_runs(id),

  policy_hash text not null,
  effective_policy_json jsonb not null,
  source_summary_json jsonb not null,
  compilation_trace_json jsonb,

  created_at timestamptz not null default now()
);
```

Recommended indexes:

```sql
create index policy_snapshots_review_run_idx
on policy_snapshots (review_run_id);

create index policy_snapshots_repo_hash_idx
on policy_snapshots (repo_id, policy_hash);
```

### 22.5 `policy_decision_traces`

Optional but useful.

```sql
create table policy_decision_traces (
  id text primary key,
  org_id text not null references orgs(id),
  repo_id text not null references repositories(id),
  review_run_id text references review_runs(id),
  finding_id text,
  decision_type text not null,
  decision text not null,
  reason_code text not null,
  trace_json jsonb not null,
  created_at timestamptz not null default now()
);
```

For MVP, store only high-value traces to avoid table bloat.

### 22.6 `rule_test_cases`

Optional dashboard feature.

```sql
create table rule_test_cases (
  id text primary key,
  org_id text not null references orgs(id),
  repo_id text references repositories(id),
  name text not null,
  input_json jsonb not null,
  expected_decision_json jsonb,
  created_at timestamptz not null default now(),
  created_by_user_id text references users(id)
);
```

---

## 23. API surface

Add API endpoints under `/api`.

### 23.1 Repository settings

```http
GET /orgs/:orgId/repos/:repoId/settings
PUT /orgs/:orgId/repos/:repoId/settings
PATCH /orgs/:orgId/repos/:repoId/settings
```

Request:

```ts
export type UpdateRepositorySettingsRequest = {
  settings: Partial<RepositorySettingsEditableFields>;
  expectedVersion?: number;
};
```

Response:

```ts
export type RepositorySettingsResponse = {
  repository: RepositorySummary;
  settings: RepositorySettings;
  effectivePolicyPreview?: EffectiveReviewPolicy;
};
```

Use optimistic concurrency:

```text
expectedVersion must match current version
```

If mismatch:

```json
{
  "error": {
    "code": "settings_version_conflict",
    "message": "Repository settings changed since you loaded them."
  }
}
```

### 23.2 Repo rules

```http
GET    /orgs/:orgId/repos/:repoId/rules
POST   /orgs/:orgId/repos/:repoId/rules
GET    /orgs/:orgId/repos/:repoId/rules/:ruleId
PUT    /orgs/:orgId/repos/:repoId/rules/:ruleId
DELETE /orgs/:orgId/repos/:repoId/rules/:ruleId
```

Soft-delete recommended:

```text
DELETE -> status = archived
```

### 23.3 Policy preview

```http
POST /orgs/:orgId/repos/:repoId/policy/preview
```

Use this to show users the effective policy before saving.

Request:

```ts
export type PolicyPreviewRequest = {
  repositorySettingsDraft?: Partial<RepositorySettings>;
  repoRulesDraft?: RepoRule[];
  samplePullRequest?: PullRequestSnapshotSummary;
};
```

Response:

```ts
export type PolicyPreviewResponse = {
  effectivePolicy: EffectiveReviewPolicy;
  warnings: PolicyWarning[];
  trace: PolicyCompilationTrace;
};
```

### 23.4 Rule test

```http
POST /orgs/:orgId/repos/:repoId/rules/test
```

Request:

```ts
export type RuleTestRequest = {
  ruleDraft?: RepoRule;
  phase: RuleEvaluationPhase;
  input: RuleEvaluationInputFixture;
};
```

Response:

```ts
export type RuleTestResponse = {
  result: PolicyDecision;
  trace: PolicyDecisionTrace;
};
```

### 23.5 Config file validation

```http
POST /orgs/:orgId/repos/:repoId/config-file/validate
```

Request:

```ts
export type ValidateConfigFileRequest = {
  content: string;
  format: "yaml" | "json";
};
```

Response:

```ts
export type ValidateConfigFileResponse = {
  valid: boolean;
  parsed?: RepoLocalConfig;
  errors: ValidationError[];
  warnings: PolicyWarning[];
};
```

---

## 24. Dashboard implementation

Dashboard sections:

```text
Repository -> Settings
Repository -> Rules
Repository -> Rules -> Test rule
Repository -> Rules -> Effective policy preview
Repository -> Review history -> Policy snapshot
Repository -> Review run -> Decision traces
```

### 24.1 Settings page

Sections:

```text
- Enable/disable reviewer
- Review mode
- Trigger settings
- Labels and branch filters
- Path ignores
- Finding categories
- Severity/confidence thresholds
- Comment budgets
- Publishing mode
- Memory behavior
- Static analysis placeholder
- Repo-local config behavior
```

### 24.2 Rules page

Table columns:

```text
Name
Status
Scope
Priority
Conditions summary
Action summary
Source
Last updated
```

Actions:

```text
Create rule
Edit rule
Disable rule
Archive rule
Duplicate rule
Test rule
View decision history
```

### 24.3 Rule builder UX

Avoid making users write JSON initially.

Rule builder flow:

```text
When...
  path matches [glob]
  and finding category is [security]

Then...
  set severity threshold to high
  or suppress finding
  or add review instruction
```

Also provide an advanced JSON editor for internal/admin use.

### 24.4 Effective policy preview

Show:

```text
- merged review mode
- trigger behavior
- ignored paths
- enabled categories
- thresholds
- active rules
- safety clamps
- warnings
```

Example warning:

```text
The repo-local config requested minimumConfidence=0.4, but the system safety floor clamps it to 0.65.
```

### 24.5 Review run policy view

For a given review run, show:

```text
- policy snapshot hash
- settings versions used
- repo-local config file hash
- active rules
- effective thresholds
- skip/suppression decisions
```

This is important for debugging.

---

## 25. Integration points

### 25.1 Webhook ingestion integration

Before creating review work:

```ts
const policy = await policyService.buildLightweightPolicy({ repoId });
const decision = ruleEvaluator.shouldReviewPr({
  policy,
  eventType,
  action,
  labels,
  author,
  baseBranch,
  headBranch,
  isDraft
});

if (!decision.shouldReview) {
  await storeSkipDecision(decision.trace);
  return;
}

await enqueueReviewJob(...);
```

For expensive decisions requiring full PR diff size, the review orchestrator can do a second-stage gate.

### 25.2 Review orchestrator integration

At review start:

```ts
const policySnapshot = await policyService.createReviewPolicySnapshot({
  orgId,
  repoId,
  reviewRunId,
  baseSha: snapshot.baseSha,
  pullRequestNumber: snapshot.pullRequestNumber
});
```

Persist:

```text
review_runs.policy_snapshot_id
```

All downstream stages use this snapshot.

### 25.3 Repo sync/indexer integration

The repo syncer and indexer receive path policy but do not load it themselves.

```ts
const pathPolicy = policySnapshot.effectivePolicy.paths;
await indexer.index({
  workspacePath,
  pathPolicy
});
```

The indexer can emit diagnostics for skipped files:

```text
skipped_large_file
skipped_ignored_path
skipped_binary_file
```

### 25.4 Retrieval integration

Retrieval receives:

```ts
ContextBundleRequest.policy = policySnapshot.effectivePolicy.retrieval
```

It should:

```text
- filter ignored/generated/vendored paths
- cap context by policy budget
- include/exclude memory
- include/exclude graph/semantic/lexical sources
- add policy trace to retrieval artifact
```

### 25.5 Review pass integration

Review engine receives:

```ts
ReviewInput.policy = policySnapshot.effectivePolicy.reviewPasses
ReviewInput.instructions = policySnapshot.effectivePolicy.instructions
```

Review passes should not interpret raw repo rules. They consume compiled instructions and pass settings.

### 25.6 Finding validation integration

#19 should use:

```text
finding policy
suppression rules
memory policy
safety floor
```

Example:

```ts
const decision = ruleEvaluator.evaluateFinding({
  policy: effectivePolicy,
  finding,
  fileClassification,
  prSummary
});
```

### 25.7 Publisher integration

#20 should use publishing policy:

```text
publish inline comments?
publish summary?
publish check run?
include evidence?
include confidence?
```

Publisher still applies staleness and idempotency rules.

### 25.8 Memory integration

#21 should use memory policy:

```text
Can this feedback create memory?
Does memory require approval?
Can this memory fact suppress future findings?
How many memory facts can retrieval include?
```

Memory does not directly mutate repository settings unless a trusted user explicitly approves a memory candidate as a repo rule.

---

## 26. CODEOWNERS integration

Optional but useful.

Potential uses:

```text
- annotate context with owner information
- prioritize files owned by platform/security teams
- generate rule suggestions
- route notifications later
```

Do not use CODEOWNERS as a permission source inside this product unless you have explicitly mapped GitHub identities to your org memberships.

Recommended import behavior:

```text
- parse CODEOWNERS from base SHA
- store owner mappings as context metadata
- expose in retrieval as optional context
- optionally allow rules such as "for files owned by @org/security, security findings only"
```

Contract:

```ts
export type CodeOwnersMapping = {
  sourcePath: RepoPath;
  sourceCommitSha: GitSha;
  entries: Array<{
    pattern: string;
    owners: string[];
    line: number;
  }>;
  errors: Array<{
    line: number;
    message: string;
  }>;
};
```

MVP can skip this or only parse for display.

---

## 27. Security model

### 27.1 Permissions

Only authorized users should edit settings/rules.

Recommended permissions:

```text
org_admin
  can edit org settings and all repo settings

repo_admin
  can edit settings for their repo

maintainer
  can propose memory/rules, optionally edit if org policy allows

member
  can view settings and review traces

external_pr_author
  cannot change durable settings through comments/config
```

### 27.2 Repo-local config trust

Never allow untrusted PR head config to weaken the review.

Rules:

```text
- read config from base SHA for PR reviews
- if PR changes config, flag it as a relevant change
- if reviewing default branch directly, read config from that commit
- never accept arbitrary code or commands from config
```

### 27.3 Pattern safety

Glob patterns can still cause issues if you allow unlimited complexity.

Validation limits:

```text
- max pattern length
- max number of patterns
- max total config size
- reject null bytes
- reject absolute paths
- reject path traversal
- reject unsupported extglob features if necessary
- precompile patterns and catch errors
```

### 27.4 No arbitrary expressions

Do not allow:

```text
condition: "eval(finding.confidence < 0.5 && path.includes('auth'))"
```

Allow:

```json
{
  "type": "path_matches",
  "patterns": ["src/auth/**"]
}
```

### 27.5 Audit logging

Audit every setting/rule change:

```text
actor
org/repo
old value hash
new value hash
changed fields
source IP/user agent if available
timestamp
```

Also audit policy-affecting repo-local config changes when detected in PRs.

---

## 28. Validation rules

Validation should happen at multiple layers.

### 28.1 Schema validation

Use strict TypeBox/Ajv schemas from #0.

```text
additionalProperties: false
```

### 28.2 Semantic validation

Examples:

```text
minimumConfidence must be between 0 and 1
maxCommentsPerPr must be between 0 and safety max
required labels cannot be empty strings
path patterns must compile
rule action must be valid for its condition phase
repo-local config cannot disable reviews if policy forbids it
static analysis cannot enable network access unless org policy allows it
```

### 28.3 Warnings vs errors

Errors prevent save/import.

Warnings allow save but should be shown.

Examples:

```text
Error:
  Unknown finding category "securty".

Warning:
  Pattern "src/**" may include most of the repository.
```

---

## 29. Rule testing utilities

Implement test helpers in `/packages/rules`.

```ts
export function createPolicyFixture(overrides?: Partial<EffectiveReviewPolicy>): EffectiveReviewPolicy;
export function createPrInputFixture(overrides?: Partial<ShouldReviewPrInput>): ShouldReviewPrInput;
export function createFindingInputFixture(overrides?: Partial<EvaluateFindingPolicyInput>): EvaluateFindingPolicyInput;
```

CLI/dev command:

```bash
pnpm dev:rule-test --repo repo_123 --rule rule_abc --fixture fixtures/security-finding.json
```

Or:

```bash
pnpm dev:policy-preview --repo repo_123 --base-sha abc123
```

These tools make policy behavior debuggable.

---

## 30. Observability

Metrics:

```text
policy_compile_duration_ms
policy_compile_errors_total
policy_snapshot_created_total
rule_evaluations_total
rule_matches_total
review_skipped_by_policy_total
finding_suppressed_by_policy_total
finding_downgraded_by_policy_total
config_file_parse_errors_total
settings_update_total
```

Trace spans:

```text
policy.compile
policy.load_settings
policy.load_repo_config
policy.validate_rules
policy.evaluate.should_review_pr
policy.evaluate.finding
```

Log fields:

```text
orgId
repoId
reviewRunId
policySnapshotId
policyHash
ruleId
reasonCode
```

Do not log full source code or full prompts in policy traces.

---

## 31. Testing strategy

### 31.1 Unit tests

```text
- default settings validate
- repository settings validate
- repo rules validate
- config file parser accepts valid YAML
- config file parser rejects unknown keys
- glob matching behavior
- path normalization
- trigger decisions
- finding policy decisions
- rule condition group all/any/not
- action application
- conflict resolution
- safety floor clamping
- policy hash stability
```

### 31.2 Integration tests

```text
- settings save through API
- rules CRUD through API
- policy snapshot creation
- webhook skip by label
- review run uses immutable snapshot
- finding suppressed by ignored path
- publishing mode set by policy
- repo-local config from base SHA only
```

### 31.3 Golden tests

Create fixtures:

```text
fixtures/policies/default.json
fixtures/policies/summary-only.json
fixtures/policies/security-strict.json
fixtures/policies/ignore-generated.json
fixtures/policies/label-required.json
fixtures/repo-config/valid-basic.yml
fixtures/repo-config/invalid-unknown-key.yml
fixtures/repo-config/malicious-disable-review.yml
```

Golden scenarios:

```text
1. PR with no required label -> skipped
2. PR with no-ai-review label -> skipped
3. PR changing generated file -> summary only or suppressed findings
4. Security finding in auth path -> allowed even with strict thresholds
5. Style finding -> rejected
6. Repo-local config tries to lower confidence -> clamped
7. Config changed in head branch -> ignored for current review
```

### 31.4 Property-style tests

Useful invariants:

```text
- policy compile is deterministic
- same policy input produces same policy hash
- safety floor always clamps below-min confidence
- generated ignored path never produces publishable finding unless explicit override allows it
- disabled repo never reviews PRs
```

---

## 32. Implementation sequence

### PR 1: Package shell and schemas

```text
- create /packages/rules
- define RepositorySettings defaults if not already in contracts
- define OrgSettings
- define RepoRule
- define EffectiveReviewPolicy
- define ReviewPolicySnapshot
- define PolicyDecisionTrace
- add TypeBox/Ajv schemas
- add fixtures
- add validation tests
```

### PR 2: Path matching and trigger policy

```text
- implement path normalization
- implement glob matcher wrapper
- implement path classification
- implement shouldReviewPr
- add trigger decision traces
- add unit tests
```

### PR 3: Policy compiler

```text
- load defaults/settings/rules from repositories
- merge settings
- apply safety floor
- build policy hash
- persist policy_snapshots
- add compilation traces
- tests for precedence/conflict behavior
```

### PR 4: API endpoints

```text
- settings GET/PATCH
- rules CRUD
- policy preview
- rule test endpoint
- validation errors
- optimistic concurrency
- audit logs
```

### PR 5: Dashboard settings UI

```text
- repository settings page
- review mode controls
- trigger controls
- path ignores
- finding thresholds
- publishing settings
- save/reset UX
```

### PR 6: Dashboard rules UI

```text
- rule list
- rule create/edit
- basic rule builder
- rule test drawer
- effective policy preview
```

### PR 7: Review pipeline integration

```text
- webhook trigger gating
- review policy snapshot in orchestrator
- pass policy to retrieval/review/validation/publisher
- store decision traces
- show policy snapshot on review run detail
```

### PR 8: Repo-local config file support

```text
- read config from base SHA
- parse YAML/JSON
- validate config
- merge into effective policy
- show config file source/hash
- warn on config changes in PR
```

### PR 9: Memory and advanced suppression integration

```text
- memory policy support
- memory suppression controls
- exact/path/category suppressions
- dashboard memory-to-rule promotion
```

### PR 10: Hardening

```text
- config size limits
- pattern complexity limits
- permissions hardening
- audit coverage
- policy replay tools
- observability dashboards
```

---

## 33. MVP cut

The first useful version should include:

```text
- /packages/rules package
- default RepositorySettings
- ReviewMode enum usage
- trigger policy
- path policy
- finding policy
- publishing policy
- basic memory policy placeholder
- path matcher
- shouldReviewPr decision
- classifyPath decision
- evaluateFinding policy decision
- policy compiler
- policy snapshot persistence
- settings GET/PATCH API
- basic settings dashboard
- ignored paths
- severity threshold
- minimum confidence
- max comments per PR
- skip draft PRs
- require/skip labels
- publish summary/inline toggles
- review run policy snapshot view
- tests for precedence and safety floor
```

Defer:

```text
- full rule builder
- repo-local config file
- CODEOWNERS integration
- static analysis policy controls
- advanced memory-to-rule promotion
- policy import/export
- org-level settings UI
- OPA/Rego-like policy engine
```

---

## 34. Definition of done

This section is complete when:

```text
- settings and rules are strict runtime-validated schemas
- repo settings can be read/updated through the API
- settings edits are audit-logged
- policy snapshots are created for review runs
- shouldReviewPr can skip/allow PRs deterministically
- path classification is deterministic and tested
- finding policy decisions can suppress/downgrade candidates
- review orchestrator uses immutable policy snapshots
- publisher respects publishing mode
- dashboard exposes basic repo settings
- review run detail shows policy snapshot and key decisions
- unsafe repo-local/head-branch config cannot weaken a review
- safety floor cannot be bypassed by repo settings
- all major decisions have reason codes/traces
```

---

## 35. Example end-to-end behavior

### Scenario A: Skip by label

Config:

```yaml
triggers:
  skip_if_any_label:
    - no-ai-review
```

PR labels:

```text
no-ai-review
```

Decision:

```json
{
  "shouldReview": false,
  "reasonCode": "blocked_label_present"
}
```

Persist:

```text
review skipped event
policy decision trace
```

No review job runs.

### Scenario B: Strict security-only path

Rule:

```json
{
  "name": "Auth paths are security/correctness only",
  "conditions": {
    "all": [
      { "type": "path_matches", "patterns": ["src/auth/**"] }
    ]
  },
  "action": {
    "type": "enable_categories",
    "categories": ["security", "correctness"]
  }
}
```

Finding:

```text
category = architecture
file = src/auth/session.ts
```

Decision:

```text
suppress or deprioritize, depending on rule action semantics
```

Trace explains which rule matched.

### Scenario C: Repo-local config tries to reduce confidence

Config file:

```yaml
review:
  minimum_confidence: 0.3
```

Safety floor:

```text
minimumConfidence >= 0.65
```

Effective policy:

```text
minimumConfidence = 0.65
```

Warning:

```text
Repo-local config requested minimumConfidence=0.3, clamped to safety floor 0.65.
```

### Scenario D: Review mode summary-only

Settings:

```json
{
  "reviewMode": "summary_only"
}
```

Pipeline:

```text
review orchestrator still runs
candidate findings are generated and stored
validation may still run
publisher posts only summary
inline comments are not posted
```

This is useful for early trials and noisy repositories.

---

## 36. Recommended initial defaults

```ts
export const INITIAL_REPOSITORY_SETTINGS: RepositorySettings = {
  schemaVersion: "repository_settings.v1",
  enabled: true,
  reviewMode: "inline_comments_with_summary",
  triggerPolicy: {
    reviewOnOpen: true,
    reviewOnSynchronize: true,
    reviewOnReopen: true,
    reviewOnReadyForReview: true,
    reviewOnLabelAdded: true,
    reviewOnManualRequest: true,
    skipDraftPullRequests: true,
    skipDependabotPullRequests: false,
    skipBotAuthors: false,
    requireAnyLabel: [],
    requireAllLabels: [],
    skipIfAnyLabel: ["no-ai-review"],
    includeBaseBranches: [],
    excludeBaseBranches: [],
    includeHeadBranches: [],
    excludeHeadBranches: [],
    includeAuthors: [],
    excludeAuthors: [],
    maxChangedFiles: 300,
    maxChangedLines: 5000,
    maxDiffBytes: 2000000,
    debounceSeconds: 20
  },
  pathPolicy: DEFAULT_PATH_POLICY,
  findingPolicy: DEFAULT_FINDING_POLICY,
  retrievalPolicy: DEFAULT_RETRIEVAL_POLICY,
  reviewPassPolicy: DEFAULT_REVIEW_PASS_POLICY,
  publishingPolicy: DEFAULT_PUBLISHING_POLICY,
  memoryPolicy: DEFAULT_MEMORY_POLICY,
  staticAnalysisPolicy: DEFAULT_STATIC_ANALYSIS_POLICY,
  configFilePolicy: DEFAULT_CONFIG_FILE_POLICY
};
```

Early beta alternative:

```text
reviewMode = summary_only
maxCommentsPerPr = 3
severityThreshold = high
minimumConfidence = 0.8
```

This gives users trust before the bot becomes more assertive.

---

## 37. Open questions

Questions to settle during implementation:

```text
1. Should repo-local config be enabled in the MVP or delayed until after dashboard settings?
2. Should org settings exist immediately, or should repo settings be the only editable layer at first?
3. Should security findings be allowed in generated files if explicitly configured?
4. Should label-required review mode be a first-class mode or just trigger policy?
5. Should memory suppressions appear as repo rules in the UI, or as a separate memory tab?
6. Should user-defined natural language instructions be allowed early, or only typed rules?
7. Should config file changes produce a special review warning/comment?
8. Should rules support CODEOWNERS predicates in v1?
```

Recommended answers for MVP:

```text
1. Delay repo-local config until dashboard settings work.
2. Implement repo settings first; add org settings schema but not UI.
3. Suppress generated files by default, allow explicit high-confidence security override later.
4. Use trigger policy, not a separate mode.
5. Keep memory separate, with optional promotion to repo rule.
6. Allow only short explicit instructions with strict length and scope limits.
7. Yes, but summary only.
8. No, defer CODEOWNERS predicates.
```

---

## 38. The clean boundary

The important boundary is:

```text
Rules/configuration produce a ReviewPolicySnapshot.
Every downstream component consumes the snapshot.
No downstream component loads mutable settings directly.
```

The product flow becomes:

```text
Settings + rules + trusted repo config + memory policy
  -> compile immutable ReviewPolicySnapshot
  -> webhook trigger decision
  -> review orchestration
  -> retrieval constraints
  -> review pass selection
  -> finding validation/suppression
  -> publishing mode
  -> explainable traces
```

That keeps the reviewer configurable without making it unpredictable.
