# #26 Evaluation Harness Implementation Spec

## Status

**Document:** #26 Evaluation Harness  
**System:** Codebase-aware PR review agent  
**Primary package:** `/packages/evaluation`  
**Supporting apps/packages:** `/apps/worker`, `/apps/web`, `/packages/review-orchestrator`, `/packages/retrieval`, `/packages/review-engine`, `/packages/llm-gateway`, `/packages/index-schema`, `/packages/db`, `/packages/observability`  
**Primary goal:** Create a repeatable system for measuring whether changes to indexing, retrieval, prompts, models, validation, policy, and publishing improve review quality without increasing noise, latency, or cost beyond acceptable limits.

Split this work into two tracks:

```text
26A. Evaluation harness MVP
26B. Advanced evaluation harness
```

`26A` is part of the first production MVP because review quality cannot be managed safely without fixture replay, anchor grading, no-finding cases, and baseline comparison. `26B` can add production import, human labeling UI, live-model suites, and external eval integrations later.

---

## 1. Why this exists

For this product, evaluation is not a nice-to-have. It is the main way to avoid shipping a noisy reviewer.

A code review agent can look impressive in demos but fail in production because it posts too many low-value comments, misses important cross-file bugs, anchors comments on the wrong line, or regresses silently when prompts, models, retrieval, or indexing changes.

The evaluation harness exists to answer questions like:

```text
Did this change improve useful findings?
Did it reduce false positives?
Did retrieval include the right context?
Did the new model catch more real bugs?
Did the new prompt become noisier?
Did the indexer replacement preserve important symbols and edges?
Did validation suppress too much?
Did latency or cost regress?
```

The evaluation system should be treated as a product subsystem, not a one-off script.

---

## 2. Core recommendation

Build a first-party evaluation harness that can replay the entire review pipeline over versioned fixtures.

The core shape:

```text
Fixture repositories + fixture PRs + expected labels
        |
        v
Evaluation runner
        |
        +--> indexer evaluation
        +--> retrieval evaluation
        +--> review finding evaluation
        +--> line-anchor evaluation
        +--> validation/ranking evaluation
        +--> latency/cost evaluation
        |
        v
Evaluation report
        |
        +--> CI gates
        +--> dashboard
        +--> historical trend storage
```

Important principle:

```text
Production artifacts become eval candidates.
Eval fixtures become regression tests.
Regression tests become release gates.
```

The harness should support both:

```text
offline deterministic evals
live model evals
```

Offline deterministic evals should run often and cheaply. Live model evals should run before model/prompt/retrieval/indexing releases and on a scheduled basis.

---

## 3. Boundary

The evaluation harness should measure the system. It should not become the system.

### It owns

```text
- eval suite definitions
- fixture repository references
- fixture PR definitions
- gold labels and expected findings
- dataset loading
- pipeline replay
- scoring
- reports
- regression gates
- historical results
- comparison between variants
- reviewer output normalization for scoring
- human labeling workflows
```

### It does not own

```text
- GitHub webhooks
- production review orchestration
- production publishing
- model provider implementation
- retrieval implementation
- indexer implementation
- dashboard app shell
```

It should call existing package interfaces:

```text
IndexerDriver
IndexImporter
EmbeddingPipeline
RetrievalEngine
ReviewEngine
FindingValidationEngine
Publisher renderer only, not live publisher
LLMGateway
```

It should not reimplement review logic.

---

## 4. Relationship to previous specs

This section depends on:

```text
#0  Core contracts and shared types
#2  Database layer
#7  Job queue and orchestration
#9  Indexer boundary
#10 Index artifact schema
#11 TypeScript indexer implementation
#12 Index importer
#13 Embedding pipeline
#14 Retrieval engine
#15 PR snapshot and diff model
#16 Review orchestrator
#17 LLM gateway
#18 Review passes
#19 Finding validation, dedupe, and ranking
#20 Publisher
#21 Feedback and memory
#22 Repo rules and configuration
#23 Static analysis integration
#25 Observability
```

The evaluation harness should reuse contracts from #0 and artifacts from the rest of the system.

The cleanest integration point is:

```text
EvalCase
  -> replay pipeline pieces
  -> collect outputs
  -> score against expected labels
```

---

## 5. Mental model

Think of every evaluation as a controlled experiment.

```text
Dataset:     Which PRs/cases are we testing?
Variant:     Which system configuration are we testing?
Runner:      Which pipeline stages do we execute?
Outputs:     What did the system produce?
Grader:      How do we score those outputs?
Report:      What changed versus baseline?
Gate:        Should this change be allowed to ship?
```

A concrete example:

```text
Dataset:
  typescript-auth-regression-v1

Variant A:
  retrieval_v3 + prompt_correctness_v2 + model_a

Variant B:
  retrieval_v4 + prompt_correctness_v2 + model_a

Runner:
  full_review_pipeline

Graders:
  expected finding recall
  false positive rate
  anchor accuracy
  comment usefulness judge
  cost and latency

Decision:
  ship retrieval_v4 if recall improves >= 5%, false positives do not increase,
  anchor accuracy stays >= 98%, p95 cost remains within budget.
```

---

## 6. Evaluation dimensions

The harness should evaluate multiple layers, not just final comments.

### 6.1 Indexer quality

Measure whether indexing produces the expected structural representation.

Questions:

```text
Did the indexer discover the expected files?
Did it detect the expected symbols?
Did it produce valid line ranges?
Did it produce stable IDs?
Did it emit expected imports/edges/routes/test mappings?
Did the artifact schema remain compatible?
Did symbol/chunk boundaries change unexpectedly?
```

Metrics:

```text
file recall
symbol recall
symbol precision
edge recall
chunk stability
line-range validity
artifact validation pass rate
index time
index output size
```

### 6.2 Embedding/retrieval quality

Measure whether retrieval includes the context needed to review correctly.

Questions:

```text
Did retrieval include the changed symbol?
Did it include the relevant caller/callee?
Did it include related tests?
Did it include the repo convention example?
Did it include the relevant config/migration/schema file?
Was important context packed within the token budget?
Did irrelevant context crowd out important context?
```

Metrics:

```text
context recall@k
context precision@k
MRR
NDCG
gold context coverage
token budget utilization
context diversity
irrelevant context rate
retrieval latency
retrieval cost
```

### 6.3 Review generation quality

Measure whether review passes generate the right candidate findings.

Questions:

```text
Did the candidate set contain the known bug?
Did it produce spurious issues?
Did it explain the issue with accurate evidence?
Did it choose appropriate severity?
Did it propose a useful fix?
Did it cite real code context?
```

Metrics:

```text
candidate recall
candidate precision
severity calibration
category accuracy
evidence accuracy
fix usefulness
hallucinated reference rate
```

### 6.4 Validation/ranking quality

Measure whether #19 makes good publishing decisions.

Questions:

```text
Did validation reject false positives?
Did it accidentally suppress true positives?
Did it enforce max comment budgets correctly?
Did it rank high-impact findings above low-impact ones?
Did memory/rules suppress the right things?
```

Metrics:

```text
publish precision
publish recall
false positive suppression rate
true positive suppression rate
ranking NDCG
budget compliance
policy trace correctness
```

### 6.5 Line anchoring quality

Measure whether comments can be correctly anchored to the PR diff.

Questions:

```text
Is the file path correct?
Is the line inside the diff?
Is the side correct?
Is the start_line valid for ranges?
Does GitHub accept the anchor?
Does the comment point to the most relevant line?
```

Metrics:

```text
anchor validity rate
anchor semantic correctness
fallback anchor rate
file-level fallback rate
GitHub publish simulation pass rate
```

### 6.6 End-to-end review quality

Measure final review usefulness.

Questions:

```text
Did the review catch important issues?
Did it avoid noise?
Would a human reviewer act on the comments?
Did it reduce risk before merge?
Was it fast enough?
Was it cheap enough?
```

Metrics:

```text
final finding precision
final finding recall
false positive rate
comment usefulness score
bugs caught
comments per PR
cost per PR
latency per PR
human acceptance rate
```

### 6.7 Safety and prompt-injection robustness

Measure behavior under adversarial repository content.

Questions:

```text
Does the reviewer follow repo-injected instructions inside comments/docs?
Does it leak secrets from context artifacts?
Does it reveal hidden prompts?
Does it execute unsafe commands?
Does it ignore trusted policy snapshots?
```

Metrics:

```text
prompt-injection pass rate
secret leakage rate
unsafe action rate
policy violation rate
untrusted-instruction compliance rate
```

---

## 7. Package structure

Create:

```text
/packages/evaluation
  /src
    index.ts
    types.ts
    config.ts

    /datasets
      dataset-loader.ts
      dataset-registry.ts
      fixture-repo-loader.ts
      production-case-importer.ts
      label-loader.ts

    /cases
      eval-case.ts
      case-builder.ts
      case-normalizer.ts
      case-validator.ts
      case-fingerprints.ts

    /runners
      eval-runner.ts
      indexer-eval-runner.ts
      retrieval-eval-runner.ts
      review-eval-runner.ts
      full-pipeline-eval-runner.ts
      shadow-eval-runner.ts

    /variants
      variant.ts
      variant-registry.ts
      variant-resolver.ts
      baseline.ts

    /graders
      index.ts
      grader.ts
      exact-finding-grader.ts
      semantic-finding-grader.ts
      anchor-grader.ts
      retrieval-grader.ts
      indexer-grader.ts
      ranking-grader.ts
      cost-latency-grader.ts
      safety-grader.ts
      judge-grader.ts
      human-label-grader.ts

    /matching
      finding-matcher.ts
      context-matcher.ts
      anchor-matcher.ts
      fingerprint.ts

    /reports
      eval-report.ts
      markdown-report.ts
      json-report.ts
      junit-report.ts
      html-report.ts
      comparison-report.ts

    /ci
      gate.ts
      thresholds.ts
      github-actions-output.ts

    /storage
      eval-run-repository.ts
      eval-artifact-store.ts
      eval-result-writer.ts

    /fixtures
      fixture-generator.ts
      fixture-validator.ts
      snapshot-writer.ts

    /human-labeling
      labeling-queue.ts
      label-schema.ts
      adjudication.ts

    /utils
      statistics.ts
      bootstrap.ts
      sampling.ts
      stable-sort.ts
      redaction.ts
      timers.ts
      seeded-random.ts

  /fixtures
    /repos
    /cases
    /labels
    /expected

  /scripts
    run-eval.ts
    compare-evals.ts
    import-production-case.ts
    validate-dataset.ts
    generate-report.ts
```

Add optional CLI app later:

```text
/apps/eval-cli
```

But MVP can expose scripts through `/packages/evaluation/scripts`.

---

## 8. Core concepts and types

The types below should live in `/packages/evaluation/src/types.ts` or be added to `/packages/contracts` if they are cross-boundary system contracts.

### 8.1 EvalSuite

An eval suite is a named collection of cases with shared purpose and thresholds.

```ts
export type EvalSuiteId = string & { readonly __brand: "EvalSuiteId" };

export type EvalSuite = {
  id: EvalSuiteId;
  name: string;
  description: string;
  version: string;
  owner: string;
  tags: string[];
  caseIds: EvalCaseId[];
  defaultRunner: EvalRunnerKind;
  defaultGraders: GraderConfig[];
  thresholds: EvalThresholds;
  createdAt: string;
  updatedAt: string;
};
```

Examples:

```text
typescript-correctness-smoke-v1
typescript-security-regressions-v1
python-test-coverage-v1
retrieval-gold-context-v1
line-anchor-edge-cases-v1
prompt-injection-robustness-v1
full-review-nightly-v1
```

### 8.2 EvalCase

An eval case is one PR-like scenario.

```ts
export type EvalCaseId = string & { readonly __brand: "EvalCaseId" };

export type EvalCase = {
  id: EvalCaseId;
  schemaVersion: "eval_case.v1";
  name: string;
  description: string;
  language: string;
  tags: string[];

  fixture: EvalFixtureRef;
  input: EvalInput;
  labels: EvalLabels;
  expected: EvalExpectations;

  difficulty: "easy" | "medium" | "hard" | "adversarial";
  source: "synthetic" | "production" | "human_curated" | "benchmark";
  privacyLevel: "public" | "internal" | "customer_redacted" | "customer_private";

  createdAt: string;
  updatedAt: string;
};
```

### 8.3 EvalFixtureRef

The fixture should reference immutable inputs.

```ts
export type EvalFixtureRef = {
  repoFixtureId: string;
  baseSha: string;
  headSha: string;
  pullRequestSnapshotUri: string;
  rawDiffUri: string;
  optionalArtifacts?: {
    baseIndexArtifactUri?: string;
    headIndexArtifactUri?: string;
    staticAnalysisReportUri?: string;
    contextBundleUri?: string;
  };
};
```

A fixture repo can be:

```text
- local git repository under fixtures/repos
- downloaded public repo fixture
- redacted production snapshot
- generated synthetic repo
- minimal inline repo generated at eval time
```

### 8.4 EvalInput

```ts
export type EvalInput = {
  pullRequestNumber?: number;
  title: string;
  description: string;
  author: string;
  labels: string[];
  changedFiles: string[];
  reviewPolicySnapshotUri?: string;
  memoryFactsUri?: string;
  repoRulesUri?: string;
};
```

### 8.5 EvalLabels

Labels represent ground truth.

```ts
export type EvalLabels = {
  expectedFindings: ExpectedFinding[];
  expectedContext?: ExpectedContextItem[];
  expectedIndexerRecords?: ExpectedIndexerRecord[];
  expectedSuppressedFindings?: ExpectedSuppressedFinding[];
  expectedNoFindingReason?: string;
  notes?: string;
};
```

### 8.6 ExpectedFinding

An expected finding is not necessarily identical to the generated finding text. It describes the issue that should be caught.

```ts
export type ExpectedFinding = {
  id: string;
  title: string;
  description: string;
  category:
    | "correctness"
    | "security"
    | "performance"
    | "test_coverage"
    | "architecture"
    | "api_contract"
    | "maintainability";
  severity: "low" | "medium" | "high" | "critical";

  expectedLocations: ExpectedLocation[];
  acceptableLocations?: ExpectedLocation[];

  mustMention?: string[];
  shouldMention?: string[];
  mustNotMention?: string[];

  evidenceRefs?: string[];
  fixHints?: string[];

  importance: number; // 0..1
  publishExpected: boolean;
};
```

### 8.7 ExpectedLocation

```ts
export type ExpectedLocation = {
  filePath: string;
  startLine?: number;
  endLine?: number;
  side?: "LEFT" | "RIGHT";
  semanticAnchor?: string;
  allowNearbyLines?: number;
};
```

`semanticAnchor` is useful when line numbers shift but the finding should still target a symbol or patch hunk.

Example:

```json
{
  "filePath": "src/auth/session.ts",
  "semanticAnchor": "validateSession accepts expired token",
  "allowNearbyLines": 5
}
```

### 8.8 ExpectedContextItem

```ts
export type ExpectedContextItem = {
  id: string;
  kind:
    | "changed_symbol"
    | "caller"
    | "callee"
    | "related_test"
    | "similar_pattern"
    | "config"
    | "dependency"
    | "memory"
    | "repo_rule";
  filePath?: string;
  symbolName?: string;
  textMustContain?: string[];
  importance: number;
};
```

### 8.9 EvalVariant

An eval variant is the system configuration under test.

```ts
export type EvalVariant = {
  id: string;
  name: string;
  description: string;

  indexer?: {
    driver: "typescript" | "cli" | "remote";
    version?: string;
  };

  retrieval?: {
    profile: string;
    vectorProfile?: string;
    rankerVersion?: string;
    contextBudgetTokens?: number;
  };

  review?: {
    reviewMode: string;
    enabledPasses: string[];
    promptVersions: Record<string, string>;
  };

  llm?: {
    modelProfile: string;
    temperature?: number;
    seed?: number;
  };

  validation?: {
    profile: string;
    minConfidence?: number;
    maxComments?: number;
  };

  policy?: {
    settingsOverrideUri?: string;
  };
};
```

Variants should be serializable and persisted with each eval run.

### 8.10 EvalRun

```ts
export type EvalRun = {
  id: string;
  suiteId: EvalSuiteId;
  variantId: string;
  baselineVariantId?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  triggeredBy: "manual" | "ci" | "nightly" | "release_gate" | "production_shadow";
  gitCommitSha?: string;
  branch?: string;
  environment: "local" | "ci" | "staging" | "production";
  caseCount: number;
  reportUri?: string;
  summary?: EvalRunSummary;
};
```

### 8.11 EvalCaseResult

```ts
export type EvalCaseResult = {
  evalRunId: string;
  caseId: EvalCaseId;
  status: "passed" | "failed" | "warning" | "skipped";

  outputs: EvalOutputs;
  scores: EvalScore[];
  matchedFindings: FindingMatch[];
  unmatchedExpectedFindings: ExpectedFinding[];
  unmatchedGeneratedFindings: CandidateOrPublishedFinding[];

  artifacts: EvalArtifactRef[];
  timings: Record<string, number>;
  costs: EvalCostSummary;

  error?: EvalError;
};
```

### 8.12 EvalScore

```ts
export type EvalScore = {
  name: string;
  value: number;
  unit?: string;
  passed?: boolean;
  threshold?: number;
  weight?: number;
  explanation?: string;
  grader: string;
};
```

---

## 9. Dataset taxonomy

The evaluation system should maintain several dataset classes.

### 9.1 Smoke datasets

Small, fast, deterministic.

Use in:

```text
- local development
- every CI run
- pre-commit optional checks
```

Goal:

```text
Catch obvious regressions in contracts, parsing, retrieval, validation, and review output structure.
```

Example suites:

```text
smoke-indexer-typescript-v1
smoke-retrieval-v1
smoke-review-correctness-v1
smoke-anchor-v1
```

### 9.2 Golden regression datasets

Curated cases with known expected findings.

Use in:

```text
- pull request CI for prompt/retrieval/review changes
- release gates
- model upgrades
```

Examples:

```text
golden-typescript-auth-v1
golden-python-api-contract-v1
golden-test-coverage-v1
golden-line-anchor-edge-cases-v1
```

### 9.3 Retrieval datasets

Cases where the correct context is labeled.

Goal:

```text
Evaluate #14 independent of model quality.
```

Example labels:

```text
This PR changes validateSession.
Correct context includes:
- src/auth/session.ts validateSession
- src/auth/middleware.ts caller
- tests/auth/session.test.ts
- src/config/session.ts
```

### 9.4 Indexer datasets

Fixture repos with expected symbols/edges/chunks.

Goal:

```text
Detect indexer regressions and enable TS -> Rust indexer comparisons.
```

### 9.5 Production-mined datasets

Cases imported from real review runs.

Sources:

```text
- accepted bot comments
- rejected bot comments
- human reviewer comments
- PRs with post-merge bug fixes
- PRs where users replied "wrong" or suppressed findings
```

Need strong privacy controls:

```text
- customer opt-in
- redaction
- no raw private code in shared eval reports
- tenant-scoped datasets
- access controls
```

### 9.6 Adversarial datasets

Cases for safety and robustness.

Examples:

```text
- prompt injection inside README
- prompt injection inside code comments
- malicious repo config attempting to disable reviewer
- generated files that look important
- dependency files with hidden instructions
- secrets in code that must not be echoed
- huge PRs designed to overflow context budget
```

### 9.7 No-finding datasets

Cases where the correct behavior is silence.

These are very important because the product should avoid noise.

Examples:

```text
- safe refactor
- style-only changes
- generated file updates
- dependency lockfile-only update
- trivial test snapshot update
- rename-only change
```

Metric:

```text
false positive rate on no-finding cases
```

---

## 10. Fixture layout

Store fixtures under:

```text
/packages/evaluation/fixtures
  /repos
    /typescript-auth-service
      .git or working tree
    /python-fastapi-service
    /line-anchor-cases

  /cases
    /typescript-auth-expired-session
      eval-case.json
      pull-request-snapshot.json
      raw.diff
      review-policy-snapshot.json
      memory-facts.json
      expected-context.json
      expected-findings.json

  /labels
    expected-findings.schema.json
    expected-context.schema.json

  /expected
    /indexer
      typescript-auth-service.base.records.snapshot.jsonl
    /retrieval
      typescript-auth-expired-session.context.snapshot.json
    /review
      typescript-auth-expired-session.findings.snapshot.json
```

For public/open fixtures, commit the repo state to the monorepo or use a submodule-like fixture loader.

For private/redacted fixtures, store artifacts in object storage and keep only metadata in git.

---

## 11. Fixture case example

```json
{
  "id": "case_ts_expired_session_001",
  "schemaVersion": "eval_case.v1",
  "name": "Expired session token accepted after auth refactor",
  "description": "A PR removes expiration validation from validateSession while preserving token signature validation.",
  "language": "typescript",
  "tags": ["typescript", "auth", "security", "correctness"],
  "fixture": {
    "repoFixtureId": "typescript-auth-service",
    "baseSha": "1111111",
    "headSha": "2222222",
    "pullRequestSnapshotUri": "fixture://cases/ts-expired-session/pull-request-snapshot.json",
    "rawDiffUri": "fixture://cases/ts-expired-session/raw.diff"
  },
  "input": {
    "title": "Refactor session validation",
    "description": "Simplifies validation by moving checks into middleware.",
    "author": "octocat",
    "labels": [],
    "changedFiles": ["src/auth/session.ts"]
  },
  "labels": {
    "expectedFindings": [
      {
        "id": "expected_expiration_check_missing",
        "title": "Session expiration is no longer validated",
        "description": "The new validation path accepts signed tokens without checking exp/expiry.",
        "category": "security",
        "severity": "high",
        "expectedLocations": [
          {
            "filePath": "src/auth/session.ts",
            "semanticAnchor": "validateSession returns session after signature check",
            "allowNearbyLines": 5,
            "side": "RIGHT"
          }
        ],
        "mustMention": ["expiration", "expired", "session"],
        "shouldMention": ["validateSession", "exp", "middleware"],
        "importance": 1,
        "publishExpected": true
      }
    ],
    "expectedContext": [
      {
        "id": "ctx_previous_exp_check",
        "kind": "similar_pattern",
        "filePath": "src/auth/middleware.ts",
        "textMustContain": ["expiresAt", "Date.now"],
        "importance": 0.9
      },
      {
        "id": "ctx_session_tests",
        "kind": "related_test",
        "filePath": "tests/auth/session.test.ts",
        "textMustContain": ["expired token"],
        "importance": 0.8
      }
    ]
  },
  "expected": {
    "maxPublishedFindings": 2,
    "minUsefulFindings": 1,
    "allowNoisyFindings": false
  },
  "difficulty": "medium",
  "source": "human_curated",
  "privacyLevel": "internal",
  "createdAt": "2026-04-29T00:00:00.000Z",
  "updatedAt": "2026-04-29T00:00:00.000Z"
}
```

---

## 12. Evaluation runners

The harness should support multiple runner types.

### 12.1 IndexerEvalRunner

Purpose:

```text
Evaluate index artifact quality and stability.
```

Flow:

```text
load fixture repo
  -> checkout base/head
  -> run indexer driver
  -> validate artifact
  -> compare records against expected labels/snapshots
  -> score
```

Outputs:

```text
IndexArtifact
IndexManifest
record stats
symbol/edge/chunk diffs
scores
```

### 12.2 RetrievalEvalRunner

Purpose:

```text
Evaluate context retrieval independent of review model output.
```

Flow:

```text
load PR snapshot
  -> ensure index + embeddings
  -> run RetrievalEngine
  -> compare ContextBundle against expectedContext labels
  -> score context recall/precision/ranking/token use
```

Outputs:

```text
ContextBundle
RetrievalTrace
retrieval scores
```

### 12.3 ReviewEvalRunner

Purpose:

```text
Evaluate review passes and finding candidates using a fixed ContextBundle.
```

This is useful when you want to test prompts/models without retrieval changes.

Flow:

```text
load fixed ContextBundle
  -> run ReviewEngine
  -> run FindingValidationEngine optionally
  -> compare candidate/published findings to expected findings
  -> score
```

### 12.4 FullPipelineEvalRunner

Purpose:

```text
Evaluate the full pipeline except live publishing.
```

Flow:

```text
load fixture PR
  -> run indexer/importer/embedding as needed
  -> run retrieval
  -> run review passes
  -> run validation/ranking
  -> render publish plan
  -> score all layers
```

This should be the primary release-gate runner.

### 12.5 ShadowEvalRunner

Purpose:

```text
Run candidate variants against production-like review inputs without publishing.
```

Flow:

```text
sample production review runs
  -> replay with baseline and candidate variant
  -> compare outputs
  -> optionally send disagreements to human labeling queue
```

Use this before shipping major retrieval/model/prompt/indexer changes.

### 12.6 ProductionOutcomeEvalRunner

Purpose:

```text
Score using real production outcomes.
```

Signals:

```text
- user accepted/comment resolved
- user replied positively/negatively
- commit after comment fixed issue
- finding ignored
- finding suppressed by user
- PR author complained
```

This is noisier than curated evals, but useful for long-term product metrics.

---

## 13. Runner interface

```ts
export type EvalRunnerKind =
  | "indexer"
  | "retrieval"
  | "review"
  | "full_pipeline"
  | "shadow"
  | "production_outcome";

export interface EvalRunner {
  kind: EvalRunnerKind;

  run(input: EvalRunnerInput): Promise<EvalRunnerOutput>;
}

export type EvalRunnerInput = {
  evalRunId: string;
  suite: EvalSuite;
  cases: EvalCase[];
  variant: EvalVariant;
  baselineVariant?: EvalVariant;
  options: EvalRunOptions;
};

export type EvalRunOptions = {
  concurrency: number;
  failFast: boolean;
  liveModels: boolean;
  updateSnapshots: boolean;
  writeArtifacts: boolean;
  maxCases?: number;
  sampleSeed?: string;
  includeTags?: string[];
  excludeTags?: string[];
};

export type EvalRunnerOutput = {
  evalRun: EvalRun;
  caseResults: EvalCaseResult[];
  report: EvalReport;
};
```

---

## 14. Graders

A grader converts outputs into scores.

```ts
export interface Grader<TOutput = unknown> {
  name: string;
  version: string;
  kind: GraderKind;

  grade(input: GraderInput<TOutput>): Promise<GraderResult>;
}

export type GraderKind =
  | "exact"
  | "semantic"
  | "retrieval"
  | "anchor"
  | "ranking"
  | "latency_cost"
  | "llm_judge"
  | "human_label"
  | "safety";
```

### 14.1 ExactFindingGrader

Uses deterministic matching.

Good for:

```text
- category matching
- severity matching
- file path matching
- line range proximity
- required keywords
- expected no-finding cases
```

### 14.2 SemanticFindingGrader

Uses embeddings or an LLM judge to decide whether generated finding matches an expected finding.

Good for:

```text
- wording differences
- equivalent explanations
- different but acceptable fix suggestions
```

Must be backed by deterministic constraints.

Suggested hybrid:

```text
candidate match requires:
  same category or compatible category
  same file or acceptable file
  anchor near expected location or semantic anchor match
  semantic issue match >= threshold
```

Do not let semantic similarity alone mark a finding correct.

### 14.3 RetrievalGrader

Scores context items against expected context.

Metrics:

```text
recall@k
precision@k
MRR
NDCG
gold context token coverage
irrelevant context rate
```

### 14.4 AnchorGrader

Scores comment anchor validity and relevance.

Checks:

```text
file exists in diff
line is commentable
side is correct
range is valid
semantic anchor is reasonable
```

### 14.5 RankingGrader

Scores whether important findings rank above less important findings.

Metrics:

```text
NDCG@k
mean reciprocal rank for critical findings
high-severity top-k recall
```

### 14.6 LatencyCostGrader

Scores latency and cost.

Metrics:

```text
index_ms
embedding_ms
retrieval_ms
review_ms
validation_ms
end_to_end_ms
llm_input_tokens
llm_output_tokens
embedding_tokens
estimated_cost_usd
```

### 14.7 SafetyGrader

Checks for unsafe behavior.

Examples:

```text
- raw prompt leakage
- secret echoing
- following untrusted instructions
- unsafe command recommendation
- policy bypass
```

### 14.8 HumanLabelGrader

Uses human labels for final usefulness.

Label dimensions:

```text
- correct issue? yes/no/partial
- useful? yes/no/partial
- severity appropriate? yes/no
- actionability? 1..5
- would merge-block? yes/no
- noisy? yes/no
```

### 14.9 JudgeGrader

An LLM-as-judge grader can be useful, but it should be constrained.

Rules:

```text
- Always include rubrics.
- Always include expected finding labels.
- Do not let the judge see hidden implementation details irrelevant to the decision.
- Persist judge prompt/version/model.
- Calibrate judge against human labels.
- Use judge scores as advisory unless calibrated.
```

Example rubric:

```text
Score 1.0 if generated finding identifies the same underlying bug,
points to an acceptable location, and provides accurate evidence.
Score 0.5 if it identifies a related issue but misses a key causal detail.
Score 0.0 if it is unrelated, unsupported, or wrong.
```

---

## 15. Finding matching

Finding matching is central. Simple string comparison will fail.

### 15.1 Matching algorithm

For each expected finding:

```text
1. Filter generated findings by category compatibility.
2. Filter by file/location compatibility where labels require it.
3. Compute text similarity between expected description and generated title/body.
4. Check required keywords/must-mention terms.
5. Check evidence references when available.
6. Compute final match score.
7. Assign best generated finding using bipartite matching.
```

Use one-to-one matching so one generated finding cannot satisfy multiple expected findings unless explicitly allowed.

Pseudo-code:

```ts
export async function matchFindings(input: MatchFindingsInput): Promise<FindingMatchResult> {
  const candidates: PairScore[] = [];

  for (const expected of input.expectedFindings) {
    for (const generated of input.generatedFindings) {
      const deterministic = scoreDeterministicCompatibility(expected, generated);
      if (deterministic.hardReject) continue;

      const semantic = await scoreSemanticCompatibility(expected, generated, input.options);
      const finalScore = combineScores(deterministic, semantic);

      if (finalScore >= input.options.minPairScore) {
        candidates.push({ expected, generated, score: finalScore });
      }
    }
  }

  return assignBestOneToOneMatches(candidates);
}
```

### 15.2 Category compatibility

Some categories can match each other depending on label configuration.

Example:

```text
security expected can match correctness if generated explanation is auth/session vulnerability
api_contract expected can match correctness if issue is contract break
performance expected should not match style/maintainability
```

Keep this explicit.

### 15.3 Location compatibility

Location compatibility should support:

```text
exact line match
nearby line match
same hunk match
same symbol match
same file match
explicit acceptable locations
file-level fallback
```

Expected labels should specify how strict to be.

---

## 16. Scoring model

The final report should include layered scores.

### 16.1 Core review scores

```text
expected_finding_recall = matched expected findings / expected publishable findings
published_precision = matched published findings / generated published findings
false_positive_rate = unmatched published findings / generated published findings
no_finding_pass_rate = no-finding cases with zero published findings / no-finding cases
anchor_validity_rate = valid anchors / published findings
severity_accuracy = generated severity compatible with expected severity
category_accuracy = generated category compatible with expected category
```

### 16.2 Weighted recall

Not all expected findings are equally important.

```text
weighted_recall = sum(importance of matched expected findings) / sum(importance of expected findings)
```

### 16.3 Useful comment score

```text
useful_comment_score = weighted combination of:
  correctness
  actionability
  evidence quality
  severity appropriateness
  anchor relevance
  fix usefulness
```

### 16.4 Noise score

Noise matters more than many teams expect.

```text
noise_score = weighted combination of:
  false positive findings
  low-severity findings published
  style-only comments
  duplicate findings
  comments lacking actionable fixes
  comments outside changed behavior
```

Lower is better.

### 16.5 Retrieval scores

```text
gold_context_recall@k
context_precision@k
MRR
NDCG
important_context_in_budget_rate
irrelevant_context_token_share
```

### 16.6 Performance scores

```text
p50_latency_ms
p95_latency_ms
p99_latency_ms
mean_cost_usd
p95_cost_usd
llm_calls_per_review
embedding_calls_per_review
```

### 16.7 Composite release score

Use a composite score for reporting, but avoid using only the composite score for gates.

```ts
composite_quality_score =
  0.35 * weighted_recall +
  0.30 * published_precision +
  0.15 * anchor_validity_rate +
  0.10 * severity_accuracy +
  0.10 * useful_comment_score -
  0.20 * noise_score;
```

Gates should use separate thresholds:

```text
weighted_recall >= baseline - allowed_delta
published_precision >= threshold
false_positive_rate <= threshold
anchor_validity_rate >= threshold
p95_cost_usd <= threshold
p95_latency_ms <= threshold
```

---

## 17. Thresholds and gates

Define gates per suite.

```ts
export type EvalThresholds = {
  minWeightedRecall?: number;
  minPublishedPrecision?: number;
  maxFalsePositiveRate?: number;
  minAnchorValidityRate?: number;
  maxNoFindingFalsePositiveRate?: number;
  maxP95LatencyMs?: number;
  maxMeanCostUsd?: number;
  maxP95CostUsd?: number;
  maxRegressionFromBaseline?: Partial<Record<string, number>>;
  requiredCasePassRate?: number;
};
```

Example:

```json
{
  "minWeightedRecall": 0.70,
  "minPublishedPrecision": 0.85,
  "maxFalsePositiveRate": 0.15,
  "minAnchorValidityRate": 0.98,
  "maxNoFindingFalsePositiveRate": 0.05,
  "maxP95LatencyMs": 120000,
  "maxMeanCostUsd": 0.25,
  "requiredCasePassRate": 0.90
}
```

CI gate behavior:

```text
pass: all hard thresholds met
warn: quality improves but cost/latency near limits
fail: threshold missed or regression exceeds allowed delta
```

---

## 18. Eval artifacts

Every eval run should persist artifacts to make failures debuggable.

Artifacts:

```text
pull-request-snapshot.json
raw.diff
index-manifest.json
records.jsonl
context-bundle.json
retrieval-trace.json
review-frame.json
llm-call-summaries.json
candidate-findings.json
validated-findings.json
publish-plan.json
rendered-comments.md
scores.json
eval-report.md
```

For security, store redacted versions by default.

Rules:

```text
- Raw private code artifacts require explicit permission.
- CI reports should not include raw customer code.
- Prompt/response artifacts should be redacted unless local/internal.
- Eval reports should link to artifacts by URI, not inline everything.
```

---

## 19. Database tables

Add these tables to #2 or create in a later migration.

### 19.1 eval_suites

```sql
create table eval_suites (
  id text primary key,
  name text not null,
  description text not null default '',
  version text not null,
  owner text not null,
  tags text[] not null default '{}',
  default_runner text not null,
  default_graders jsonb not null default '[]',
  thresholds jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### 19.2 eval_cases

```sql
create table eval_cases (
  id text primary key,
  suite_id text references eval_suites(id),
  name text not null,
  description text not null default '',
  language text not null,
  tags text[] not null default '{}',
  source text not null,
  privacy_level text not null,
  difficulty text not null,
  fixture jsonb not null,
  input jsonb not null,
  labels jsonb not null,
  expected jsonb not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### 19.3 eval_variants

```sql
create table eval_variants (
  id text primary key,
  name text not null,
  description text not null default '',
  config jsonb not null,
  git_commit_sha text,
  created_by text,
  created_at timestamptz not null default now()
);
```

### 19.4 eval_runs

```sql
create table eval_runs (
  id text primary key,
  suite_id text not null references eval_suites(id),
  variant_id text not null references eval_variants(id),
  baseline_variant_id text references eval_variants(id),
  status text not null,
  triggered_by text not null,
  environment text not null,
  git_commit_sha text,
  branch text,
  case_count int not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  report_uri text,
  summary jsonb,
  error jsonb
);
```

### 19.5 eval_case_results

```sql
create table eval_case_results (
  id text primary key,
  eval_run_id text not null references eval_runs(id) on delete cascade,
  case_id text not null references eval_cases(id),
  status text not null,
  scores jsonb not null default '[]',
  matched_findings jsonb not null default '[]',
  unmatched_expected_findings jsonb not null default '[]',
  unmatched_generated_findings jsonb not null default '[]',
  timings jsonb not null default '{}',
  costs jsonb not null default '{}',
  artifacts jsonb not null default '[]',
  error jsonb,
  created_at timestamptz not null default now(),
  unique (eval_run_id, case_id)
);
```

### 19.6 eval_human_labels

```sql
create table eval_human_labels (
  id text primary key,
  case_id text not null references eval_cases(id),
  finding_fingerprint text,
  labeler_user_id text,
  label jsonb not null,
  adjudication_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### 19.7 eval_baselines

```sql
create table eval_baselines (
  suite_id text not null references eval_suites(id),
  baseline_variant_id text not null references eval_variants(id),
  eval_run_id text references eval_runs(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (suite_id, baseline_variant_id)
);
```

---

## 20. CLI commands

Add commands under:

```text
pnpm eval ...
```

or:

```text
bun packages/evaluation/scripts/run-eval.ts ...
```

Suggested commands:

```bash
# Run a small suite locally
pnpm eval run --suite smoke-review-v1 --variant local

# Run retrieval-only evals
pnpm eval run --suite retrieval-gold-v1 --runner retrieval

# Run full eval against baseline
pnpm eval compare --suite golden-typescript-v1 --candidate pr-branch --baseline main

# Import a production review run as a candidate fixture
pnpm eval import-production-case --review-run rev_123 --redact

# Validate all datasets and labels
pnpm eval validate-dataset --suite golden-typescript-v1

# Update deterministic snapshots intentionally
pnpm eval update-snapshots --suite indexer-typescript-v1

# Generate markdown/html report from stored run
pnpm eval report --eval-run eval_123
```

---

## 21. CI integration

### 21.1 Pull request CI

Run cheap deterministic suites on every PR.

```text
contract validation
index artifact fixture validation
line-anchor fixture tests
no-model retrieval fixture tests
fake-LLM review engine tests
finding validation tests
```

Recommended CI jobs:

```text
pnpm test
pnpm eval run --suite smoke-indexer-v1 --no-live-models
pnpm eval run --suite smoke-retrieval-v1 --no-live-models
pnpm eval run --suite smoke-validation-v1 --no-live-models
```

### 21.2 Prompt/retrieval/model PR CI

If changed files touch:

```text
/packages/retrieval
/packages/review-engine
/packages/llm-gateway/prompts
/packages/indexer-ts
/packages/index-schema
```

Run broader suites:

```text
golden-retrieval-v1
golden-review-v1
line-anchor-edge-cases-v1
no-finding-v1
```

### 21.3 Nightly evals

Run expensive live model suites nightly.

```text
full-review-nightly-v1
security-regressions-v1
production-shadow-sample-v1
prompt-injection-v1
```

### 21.4 Release gate

Before deploying major changes:

```text
full pipeline eval vs current production baseline
cost/latency report
top regressions report
manual review of high-impact diffs
```

---

## 22. Local development workflow

Developers should be able to run one case quickly.

```bash
pnpm eval run-case --case case_ts_expired_session_001 --runner full_pipeline --variant local --debug
```

Debug output:

```text
- links to artifacts
- retrieval trace
- candidate findings
- rejected findings with reasons
- final publish plan
- score breakdown
```

A useful local debug view:

```text
Expected finding:
  Missing session expiration check

Generated finding:
  Token validation no longer checks expiry

Match score:
  0.91 pass

Anchor:
  src/auth/session.ts:47 RIGHT pass

Evidence:
  matched validateSession and session middleware context

Costs:
  $0.032
```

---

## 23. Snapshot strategy

Use snapshots carefully.

Good snapshot targets:

```text
index artifact record counts
normalized index records for small fixtures
retrieval context item IDs/ranks
validation rejection reasons
rendered comment markdown
publish plan shape
```

Bad snapshot targets:

```text
full LLM prose for live model calls
model outputs with nondeterministic wording
large private code snippets
```

For model outputs, prefer semantic/label-based grading over raw snapshot equality.

Snapshot rules:

```text
- deterministic snapshots can be updated with explicit command only
- snapshot updates require human review
- snapshots should be small enough to inspect
- snapshots should not include secrets/private code unless protected
```

Vitest snapshot tests can be used for deterministic objects like context packing output, validation decisions, rendered comment markdown, and fixture-normalized index records.

---

## 24. Human labeling workflow

Automated graders are not enough. The system needs human-labeled examples.

### 24.1 Label sources

```text
- manually curated fixture PRs
- production findings with user replies
- accepted/rejected findings
- model disagreements
- high-value review misses
- false positives reported by users
```

### 24.2 Label fields

```ts
export type HumanFindingLabel = {
  correctness: "correct" | "partially_correct" | "incorrect";
  usefulness: 1 | 2 | 3 | 4 | 5;
  severityAppropriate: boolean;
  categoryAppropriate: boolean;
  anchorAppropriate: boolean;
  evidenceAccurate: boolean;
  fixUseful: boolean;
  shouldPublish: boolean;
  notes?: string;
};
```

### 24.3 Adjudication

For important datasets:

```text
- require two independent labels
- resolve disagreements through adjudication
- store adjudicator decision
- preserve original labels
```

### 24.4 Dashboard queue

Add dashboard surfaces later:

```text
/evals/labeling
/evals/labeling/:caseId
/evals/runs/:evalRunId/disagreements
```

MVP can use JSON labels in fixture files.

---

## 25. Production case import

Production review runs are the best source of realistic eval cases.

Importer flow:

```text
review_run_id
  -> load PR snapshot
  -> load context bundle
  -> load candidate/validated/published findings
  -> load feedback outcomes
  -> redact according to policy
  -> create EvalCase draft
  -> optionally ask human to label
```

Command:

```bash
pnpm eval import-production-case --review-run rev_123 --suite production-candidates-v1 --redact
```

Redaction should remove:

```text
- customer identifiers
- secrets/tokens
- private URLs
- email addresses where unnecessary
- raw file contents if not permitted
```

Important:

```text
Never copy private customer code into a shared fixture dataset without explicit policy permission.
```

---

## 26. Baselines and comparisons

Every serious eval should compare against a baseline.

Baseline examples:

```text
current production config
last released config
main branch config
previous model version
previous retrieval version
no-context LLM baseline
static-analysis-only baseline
```

Comparison report should show:

```text
metric deltas
case-level improvements
case-level regressions
new false positives
new true positives
lost true positives
cost deltas
latency deltas
```

Example output:

```text
Candidate retrieval_v4 vs baseline retrieval_v3

Weighted recall:        0.74 -> 0.79  +0.05 PASS
Published precision:    0.88 -> 0.86  -0.02 PASS
False positive rate:    0.12 -> 0.14  +0.02 PASS
Anchor validity:        0.99 -> 0.99   0.00 PASS
Mean cost:              $0.21 -> $0.24 +$0.03 PASS
P95 latency:            91s -> 104s    +13s PASS

Regressions requiring review:
- case_py_contract_004 lost expected API break finding
- case_ts_no_finding_012 produced new style-only comment
```

---

## 27. Variant management

Variant configs should be committed or generated reproducibly.

Directory:

```text
/packages/evaluation/variants
  production.json
  main.json
  retrieval-v4.json
  model-upgrade-gpt55.json
  indexer-rust-v1.json
```

Example:

```json
{
  "id": "retrieval_v4_prompt_v2_model_prod",
  "name": "Retrieval v4 with production prompts/model",
  "description": "Tests retrieval ranking changes while keeping prompts and model stable.",
  "retrieval": {
    "profile": "retrieval.v4",
    "rankerVersion": "rrf.v2",
    "contextBudgetTokens": 24000
  },
  "review": {
    "reviewMode": "balanced",
    "enabledPasses": ["summary", "correctness", "security", "tests", "judge"],
    "promptVersions": {
      "review.correctness": "v2",
      "review.security": "v2",
      "finding.judge": "v1"
    }
  },
  "llm": {
    "modelProfile": "production.review",
    "temperature": 0
  },
  "validation": {
    "profile": "validation.v2",
    "minConfidence": 0.76,
    "maxComments": 5
  }
}
```

---

## 28. Evaluation report format

Generate Markdown, JSON, and optional HTML.

### 28.1 Markdown report

Structure:

```text
# Evaluation Report

Suite
Variant
Baseline
Git SHA
Run time
Case count

## Summary
Metric table
Pass/fail status

## Key Improvements

## Key Regressions

## Failed Gates

## Case Results
Per-case table

## Top False Positives

## Missed Expected Findings

## Cost and Latency

## Artifacts
```

### 28.2 JSON report

Machine-readable for dashboard and CI.

```ts
export type EvalReport = {
  evalRun: EvalRun;
  suite: EvalSuite;
  variant: EvalVariant;
  baseline?: EvalVariant;
  summary: EvalRunSummary;
  metrics: EvalMetricSummary[];
  gates: EvalGateResult[];
  caseResults: EvalCaseResultSummary[];
  regressions: EvalRegression[];
  improvements: EvalImprovement[];
  artifacts: EvalArtifactRef[];
};
```

### 28.3 JUnit report

Useful for CI systems.

Map:

```text
Eval case -> test case
Failed hard threshold -> test failure
Warnings -> skipped/system output
```

---

## 29. Dashboard surfaces

Add dashboard routes later:

```text
/evals
/evals/suites
/evals/suites/:suiteId
/evals/runs
/evals/runs/:evalRunId
/evals/runs/:evalRunId/cases/:caseId
/evals/variants
/evals/labeling
```

Core dashboard questions:

```text
Are we getting better?
What changed?
Which cases regressed?
Which expected findings were missed?
Which generated findings were false positives?
How much did cost and latency change?
Can I inspect the context/prompt/finding that caused a failure?
```

MVP can skip dashboard and produce Markdown/JSON reports.

---

## 30. API endpoints

Optional API endpoints:

```text
GET  /evals/suites
GET  /evals/suites/:suiteId
GET  /evals/runs
GET  /evals/runs/:evalRunId
GET  /evals/runs/:evalRunId/cases/:caseId
POST /evals/runs
POST /evals/runs/:evalRunId/cancel
GET  /evals/variants
POST /evals/production-cases/import
GET  /evals/labeling/queue
POST /evals/labeling/:itemId/label
```

Initial implementation can be CLI-only.

---

## 31. Integration with observability

Each eval case should emit spans and metrics.

Trace shape:

```text
evaluation.run
  evaluation.case
    indexer.run
    importer.import
    embedding.ensure
    retrieval.retrieve
    review_engine.run
    finding_validation.run
    eval.grade
```

Metric examples:

```text
eval.case.duration_ms
eval.case.cost_usd
eval.finding.recall
eval.finding.precision
eval.anchor.validity_rate
eval.retrieval.recall_at_k
eval.gate.pass_count
eval.gate.fail_count
```

Do not export raw code/prompt content as span attributes.

---

## 32. Integration with LLM Gateway

The evaluation harness should use #17 LLM Gateway, not provider SDKs directly.

Why:

```text
- consistent model routing
- consistent caching
- consistent logging/redaction
- cost tracking
- prompt version tracking
- rate limiting
```

Eval-specific gateway settings:

```text
- deterministic temperature where possible
- optional seed where supported
- cache enabled for repeat runs
- stricter budget limits
- explicit model profile in variant
```

For LLM-as-judge graders, define separate model profiles:

```text
judge.finding_match
judge.usefulness
judge.safety
```

Never reuse the exact same model/prompt as both generator and final judge without tracking that limitation.

---

## 33. Integration with retrieval

For retrieval evals, expose detailed traces from #14.

Context item fields needed:

```text
id
kind
filePath
symbolName
source
trigger
rank
score
tokens
included/excluded reason
```

Retrieval grader needs to compare expected context to actual context.

Matching can use:

```text
file path
symbol name
line range
text contains
chunk ID
semantic similarity
context kind
```

---

## 34. Integration with indexer replacement

The evaluation harness is critical for swapping the indexer.

When testing Rust indexer vs TypeScript indexer:

```text
run both on same fixture repos
validate artifacts
compare file/symbol/chunk/edge coverage
run retrieval evals using both
run full review evals using both
compare latency and artifact size
```

Key indexer replacement metrics:

```text
index_time_ms
artifact_size_bytes
file_record_delta
symbol_record_delta
edge_record_delta
chunk_boundary_delta
retrieval_recall_delta
review_quality_delta
```

Gates:

```text
new indexer must not reduce retrieval gold-context recall
new indexer must not break line ranges
new indexer must not reduce expected finding recall below threshold
new indexer should improve or preserve index time
```

---

## 35. Integration with feedback/memory

Production feedback should flow into evaluation.

Use cases:

```text
- convert accepted comments into positive labels
- convert dismissed/suppressed comments into false-positive candidates
- convert human reviewer comments into missed-finding labels
- build no-finding cases from quiet PRs that merged cleanly
```

Be cautious:

```text
A resolved comment does not always mean the bot was correct.
An ignored comment does not always mean the bot was wrong.
A commit after a comment may be unrelated.
```

Use feedback as a signal, then human-curate important cases.

---

## 36. Privacy and security

Evaluation data can contain private source code. Treat it like production data.

Rules:

```text
- Every eval case has privacyLevel.
- Every artifact has sensitivity metadata.
- Private customer artifacts require tenant-scoped access control.
- Reports should default to redacted snippets.
- CI should not print raw private code.
- Imported production cases should be redacted unless internal/private storage is explicitly allowed.
- Human labeling UI should enforce org access.
```

Artifact sensitivity levels:

```text
public
internal
customer_redacted
customer_private
secret_sensitive
```

Hard fail if secret scanner finds secrets in:

```text
- eval reports
- committed fixtures
- prompt artifacts
- generated markdown reports
```

---

## 37. Reproducibility

Every eval run should persist:

```text
git commit SHA
variant config
suite version
case versions
model profiles
prompt versions
retrieval profile
validation profile
indexer version
embedding profile
schema versions
random seed if any
environment
```

Goal:

```text
A failed eval from last month should be understandable and mostly replayable.
```

Model outputs are not always perfectly reproducible, so store model outputs and judge outputs with each run.

---

## 38. Cost controls

Live evals can get expensive.

Controls:

```text
- max cases per run
- max LLM calls per case
- max tokens per case
- max cost per run
- provider cache
- response cache for repeated variant/case inputs
- sample subsets for PR CI
- nightly full suite instead of every-PR full suite
```

Cache key for review pass output:

```text
case_id
variant_id
prompt_version
model_profile
context_bundle_hash
review_policy_hash
memory_hash
```

Do not cache if:

```text
- prompt version changed
- model profile changed
- context changed
- labels changed only scoring can be recomputed from outputs
```

Important optimization:

```text
Separate pipeline execution from scoring.
```

If labels or graders change, you should be able to rescore stored outputs without rerunning LLM calls.

---

## 39. Rescoring

Support rescoring old eval outputs.

Command:

```bash
pnpm eval rescore --eval-run eval_123 --grader-set current
```

Use cases:

```text
- improve matching algorithm
- add new labels
- change thresholds
- calibrate judge against human labels
- update report generation
```

Rescoring should not rerun:

```text
indexing
retrieval
review passes
LLM generation
```

unless explicitly requested.

---

## 40. Implementation plan

### PR 1: Package shell and core types

Implement:

```text
/packages/evaluation
  package.json
  tsconfig.json
  src/index.ts
  src/types.ts
  src/config.ts
```

Add:

```text
EvalSuite
EvalCase
EvalVariant
EvalRun
EvalCaseResult
EvalScore
EvalReport
```

Tests:

```text
schemas validate sample suite/case/variant
invalid cases fail validation
```

### PR 2: Dataset loader and fixtures

Implement:

```text
dataset registry
fixture loader
case loader
label loader
case validator
```

Add first fixtures:

```text
smoke-no-finding
smoke-line-anchor
smoke-typescript-correctness
smoke-retrieval
```

Tests:

```text
all fixtures load
all labels validate
all fixture URIs resolve
```

### PR 3: Grader framework

Implement:

```text
Grader interface
ExactFindingGrader
AnchorGrader
RetrievalGrader basic
LatencyCostGrader
score aggregation
```

Tests:

```text
exact expected finding match
nearby line match
no-finding false positive detection
anchor validity scoring
```

### PR 4: Finding matcher

Implement:

```text
finding fingerprinting
category compatibility
location compatibility
keyword checks
one-to-one matching
match reports
```

Tests:

```text
one generated finding cannot satisfy two expected findings
acceptable locations work
mustMention/mustNotMention work
partial match scoring works
```

### PR 5: Retrieval eval runner

Implement:

```text
RetrievalEvalRunner
ContextBundle loading
RetrievalEngine integration
expected context matching
retrieval report output
```

Tests:

```text
gold context recall@k
NDCG calculation
irrelevant context accounting
```

### PR 6: Review eval runner

Implement:

```text
ReviewEvalRunner
fixed ContextBundle input
ReviewEngine integration
FindingValidationEngine integration optional
finding scoring
```

Tests:

```text
fake review engine output scored correctly
validated findings scored correctly
no-finding cases pass/fail correctly
```

### PR 7: Full pipeline eval runner

Implement:

```text
FullPipelineEvalRunner
fixture repo checkout
index/import/embed/retrieve/review/validate path
publish plan rendering without live publishing
artifact persistence
```

Tests:

```text
full smoke case runs end-to-end with fake LLM
artifacts generated
report generated
```

### PR 8: Reports and CI gates

Implement:

```text
Markdown report
JSON report
JUnit report
threshold gates
GitHub Actions output
```

Tests:

```text
failing gate returns nonzero exit
report includes regressions and artifacts
JUnit output valid XML
```

### PR 9: Baseline comparison

Implement:

```text
comparison report
metric deltas
case-level diff
lost true positives
new false positives
```

Tests:

```text
baseline/candidate comparison flags expected regressions
```

### PR 10: Production case import MVP

Implement:

```text
load review_run artifacts
create EvalCase draft
redact basic sensitive strings
write fixture files
```

Tests:

```text
private artifacts not emitted unless allowed
redaction replaces secrets/emails/tokens
```

### PR 11: Human labeling MVP

Implement:

```text
human label schema
label file format
adjudication placeholder
label import/export
```

Dashboard can come later.

---

## 41. MVP cut

This is `26A. Evaluation harness MVP`.

For the first useful version, implement:

```text
- /packages/evaluation package
- EvalSuite/EvalCase/EvalVariant/EvalRun types
- fixture dataset loader
- 10-20 curated fixture cases
- ExactFindingGrader
- AnchorGrader
- RetrievalGrader basic
- LatencyCostGrader basic
- finding matcher
- RetrievalEvalRunner
- ReviewEvalRunner with fixed context bundles
- FullPipelineEvalRunner with fake LLM first
- Markdown + JSON reports
- CI gates
- baseline comparison
```

MVP suites:

```text
smoke-indexer-v1
smoke-retrieval-v1
smoke-review-v1
smoke-validation-v1
line-anchor-edge-cases-v1
no-finding-smoke-v1
```

MVP can defer:

```text
- production case import
- human labeling UI
- LLM-as-judge grader
- large-scale nightly eval orchestration
- dashboard views
- promptfoo/Langfuse/OpenAI Evals integrations
```

Those deferred items belong to `26B. Advanced evaluation harness`.

---

## 42. Good initial fixture cases

Start with roughly 20 cases.

### TypeScript correctness

```text
1. removed null check before property access
2. changed async function but forgot await
3. changed return type but caller still expects old shape
4. inverted condition in authorization check
5. removed error handling around external API call
```

### TypeScript security

```text
6. session expiration validation removed
7. authorization middleware bypass on new route
8. user-controlled redirect not validated
9. SQL-like query builder missing parameterization
10. secret accidentally logged
```

### Test coverage

```text
11. changed public API without updating tests
12. added new branch with no test for failure path
13. changed auth behavior but tests only cover happy path
```

### Retrieval

```text
14. bug requires caller context
15. bug requires related test context
16. bug requires config context
17. bug requires similar pattern context
```

### No-finding

```text
18. safe rename-only change
19. generated file update
20. style-only formatting change
```

### Line anchor edge cases

```text
21. renamed file
22. deleted file
23. finding belongs on added line in multi-hunk diff
24. multi-line finding
25. binary file skipped
```

### Safety

```text
26. README says "ignore all previous instructions"
27. code comment says "do not report this bug"
28. repo config changed in PR to disable security pass
29. fake secret in fixture should not be repeated verbatim
30. large irrelevant file tries to crowd out context
```

---

## 43. Optional integrations

The first-party harness should be the source of truth. External tools can be adapters.

### 43.1 OpenAI Evals

Useful for:

```text
- model-output evaluation
- datasets/eval runs on OpenAI platform
- graders for specific tasks
```

Keep it optional because our system needs to evaluate non-model layers too:

```text
indexing
retrieval
line anchors
validation
policy
cost/latency
```

### 43.2 promptfoo

Useful for:

```text
- prompt experiments
- red-team tests
- model/provider comparisons
- CI prompt evals
```

Potential adapter:

```text
export EvalCase -> promptfoo YAML
import promptfoo results -> EvalReport
```

### 43.3 Langfuse

Useful for:

```text
- LLM tracing
- prompt management
- experiments
- LLM-as-judge and human/heuristic evals
```

Potential adapter:

```text
send eval traces and scores to Langfuse
link eval report to Langfuse trace IDs
```

Do not make any of these required for MVP.

---

## 44. Anti-patterns

Avoid these:

```text
Only evaluating final prose.
Only using LLM-as-judge without human calibration.
Treating exact wording snapshots as model quality.
Ignoring no-finding cases.
Ignoring retrieval quality.
Ignoring anchor correctness.
Ignoring cost/latency.
Letting eval fixtures become stale.
Committing private customer code into public fixtures.
Changing prompts/models without running comparisons.
Using production feedback as ground truth without curation.
Optimizing for recall while allowing false positives to grow.
```

The most dangerous anti-pattern:

```text
A model change that catches two new bugs but adds twenty noisy comments.
```

The evaluation harness should catch that.

---

## 45. Definition of done

#26 is done when:

```text
- /packages/evaluation exists and builds.
- EvalSuite, EvalCase, EvalVariant, EvalRun, EvalCaseResult, EvalReport are implemented.
- Fixture loader validates cases and labels.
- At least 10 smoke cases exist.
- Exact finding matching works.
- Anchor grading works.
- Retrieval grading works for expected context labels.
- Review grading works with fixed ContextBundle fixtures.
- FullPipelineEvalRunner works with fake LLM outputs.
- Markdown and JSON reports are generated.
- CI can fail on gate thresholds.
- Baseline comparison report works.
- Reports include cost/latency where available.
- Eval artifacts are persisted or written to local artifact directory.
- Private/raw code content is not printed to CI logs by default.
```

---

## 46. Suggested implementation order summary

```text
1. Types and schemas
2. Dataset/fixture loader
3. Initial fixture cases
4. Grader framework
5. Finding matcher
6. Anchor grader
7. Retrieval grader
8. Review eval runner
9. Full pipeline runner with fake LLM
10. Reports
11. CI gates
12. Baseline comparison
13. Live model eval support
14. Production case import
15. Human labeling
16. Dashboard/API surfaces
```

---

## 47. Practical first milestone

The first milestone should be small but valuable:

```text
Run one command that evaluates 10 fixture PRs and tells us:

- expected finding recall
- false positives
- anchor validity
- retrieval gold-context recall
- p95 latency
- estimated cost
- pass/fail against thresholds
```

Command:

```bash
pnpm eval run --suite smoke-full-pipeline-v1 --variant local --no-live-models
```

Output:

```text
Evaluation: smoke-full-pipeline-v1
Variant: local
Cases: 10

Weighted recall:          0.80 PASS
Published precision:      0.90 PASS
False positive rate:      0.10 PASS
Anchor validity:          1.00 PASS
Retrieval recall@10:      0.85 PASS
Mean cost:                $0.00 PASS
P95 latency:              4.2s PASS

Failed cases:
- case_ts_missing_await_001: expected finding not matched

Artifacts:
/mnt/eval-runs/eval_abc/report.md
```

That gets the team into a measurement loop quickly.

---

## 48. Verified reference notes

These external references are useful for implementation choices, not required dependencies:

```text
OpenAI Evals API docs:
https://developers.openai.com/api/docs/guides/evals

OpenAI agent workflow evals:
https://developers.openai.com/api/docs/guides/agent-evals

Vitest snapshot testing:
https://vitest.dev/guide/snapshot

promptfoo intro and red-team docs:
https://www.promptfoo.dev/docs/intro/
https://www.promptfoo.dev/docs/red-team/

Langfuse evaluation overview:
https://langfuse.com/docs/evaluation/overview
```
