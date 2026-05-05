# #23 Static Analysis Integration — Implementation Spec

## Status

Draft implementation spec.

This document defines the static-analysis integration layer for the code-review agent. It should be read after:

```text
#0  Core contracts and shared types
#1  Monorepo and build system
#2  Database layer
#3  GitHub App integration
#4  Webhook ingestion
#5  API server
#6  Web dashboard
#7  Job queue and orchestration
#8  Repo sync and workspace manager
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
#21 Feedback and memory system
#22 Repo rules and configuration
```

The static-analysis layer should be treated as a deterministic signal generator. It should run selected tools, normalize their diagnostics, and provide evidence to the review system. It should not publish comments directly, decide final finding validity, or execute untrusted project commands without the sandbox layer.

---

## 1. Executive summary

Static analysis should add deterministic, tool-backed evidence to the AI review pipeline.

The clean model is:

```text
PullRequestSnapshot
+ ReviewPolicySnapshot
+ WorkspaceLease
+ CodeIndexVersion
        |
        v
StaticAnalysisPlanner
        |
        v
ToolRunPlan[]
        |
        v
ToolRunner / SandboxRunner
        |
        v
Raw tool outputs
        |
        v
Tool adapters / parsers
        |
        v
NormalizedToolDiagnostic[]
        |
        v
StaticAnalysisReport
        |
        +--> Retrieval context
        +--> Review passes
        +--> Finding validation
        +--> Internal debug UI
```

The core recommendation:

```text
Treat static-analysis tools as evidence producers, not autonomous reviewers.

Tools generate diagnostics.
The review engine may synthesize them into CandidateFindings.
#19 still validates, dedupes, ranks, and decides publishability.
#20 still owns publishing.
```

Static analysis is valuable for:

```text
- type errors
- lint warnings
- security patterns
- dependency/config mistakes
- dead code
- unreachable code
- unsafe APIs
- missing imports
- broken generated types
- language-specific correctness checks
```

But static tools are noisy if naively posted. Their output should be filtered against the PR diff, repo policy, memory suppressions, and severity thresholds.

---

## 2. Goals

Implement a static-analysis integration layer that:

```text
- detects which tools apply to a repo/PR
- plans fast, bounded, non-mutating tool runs
- runs tools safely through a runner abstraction
- captures stdout/stderr/exit code/artifacts
- parses tool-specific output into normalized diagnostics
- maps diagnostics to files, lines, changed files, and diff anchors
- stores raw and normalized outputs for debugging
- feeds normalized diagnostics into review/retrieval/validation
- tracks tool latency, failure rate, and diagnostic usefulness
- supports project-local configuration without trusting PR-authored config blindly
- can later run in a hardened sandbox from #24
```

---

## 3. Non-goals

This section should not implement:

```text
- full sandbox isolation                         (#24)
- final finding validation/publishability        (#19)
- GitHub publishing                              (#20)
- repo indexing                                  (#9–#12)
- model reasoning over findings                  (#18)
- memory-derived suppression creation            (#21)
- dashboard UI pages beyond required API data     (#6 can render this later)
- billing policy                                 (#28)
```

It can define the contracts those sections consume.

---

## 4. High-level architecture

```text
/apps/worker
  review worker
  static-analysis worker
        |
        v
/packages/static-analysis
  planner
  registry
  adapters
  normalizers
  report builder
        |
        +------------------------------+
        |                              |
        v                              v
/packages/tool-runner            /packages/sandbox-runner  (future #24)
  command execution                 hardened execution
  timeout handling                  no-network policy
  output capture                    CPU/memory limits
  artifact capture                  filesystem isolation
        |
        v
WorkspaceLease from /packages/repo-sync
        |
        v
Tool outputs
        |
        v
Postgres + object storage
```

Suggested package split:

```text
/packages/static-analysis
  owns planning, adapters, parsers, normalization, reports

/packages/tool-runner
  owns process execution abstraction, timeouts, output capture

/packages/sandbox-runner
  optional/future hardened execution package from #24
```

For MVP, `/packages/tool-runner` may be implemented inside `/packages/static-analysis`, but it should still be designed as a separate abstraction.

---

## 5. Design principles

### 5.1 Deterministic before intelligent

The static-analysis layer should not ask an LLM to interpret raw stdout. It should parse tool output into structured records first.

Bad:

```text
Run eslint -> send raw eslint output to model -> ask model what to post
```

Good:

```text
Run eslint -> parse JSON -> normalize diagnostics -> map to diff -> pass structured diagnostics to review engine
```

### 5.2 Tools are not the final authority

A tool diagnostic may be:

```text
- high-value and publishable
- useful context only
- irrelevant to the PR
- already known
- suppressed by repo rules
- false positive
- caused by missing dependencies
- caused by incomplete workspace setup
```

So static diagnostics should become `ToolDiagnostic` records first, then `CandidateFinding` only if a synthesis pass or validation rule promotes them.

### 5.3 Prefer changed-scope analysis first

Full-repo analysis can be expensive and noisy. MVP should prioritize:

```text
- changed files
- containing packages/projects
- directly affected modules
- base-vs-head delta diagnostics
```

The ideal signal is not "this repo has 400 lint errors." The ideal signal is:

```text
"This PR introduced 2 new high-confidence diagnostics on changed lines."
```

### 5.4 Use base/head comparison when possible

Static tools often report pre-existing issues. The best filter is to compare diagnostics:

```text
base diagnostics
head diagnostics
        |
        v
introduced diagnostics = head - base
```

This is more expensive, so use it selectively:

```text
- fast changed-file tools: run on head only first
- high-noise tools: compare base vs head
- full-repo tools: run base/head only for enabled repos or larger plans
```

### 5.5 Do not mutate the workspace

Default commands should be non-mutating:

```text
eslint without --fix
ruff check without --fix
tsc --noEmit
pyright --outputjson
semgrep scan --json
staticcheck -f json
cargo check --message-format=json
cargo clippy --message-format=json without --fix
```

Mutating commands are out of scope until the sandbox and patch-suggestion flow exist.

### 5.6 Respect trusted configuration boundaries

Repo config files can influence static analysis:

```text
.eslintrc / eslint.config.js
pyproject.toml
ruff.toml
pyrightconfig.json
tsconfig.json
go.mod
Cargo.toml
.semgrep.yml
```

For PR reviews, default policy should be:

```text
- Use trusted base-SHA configuration for deciding which tools/rules are allowed.
- For tools that require head workspace config to type-check correctly, record that config came from head.
- If the PR changes tool configuration, mark results as config-sensitive.
```

Do not let a PR silently disable analysis by modifying configuration in the same PR.

### 5.7 Store raw outputs, but publish normalized findings only

Raw outputs are valuable for debugging and replay. They should be stored as artifacts, with redaction applied where needed.

Published user-facing comments should use normalized, concise explanations.

---

## 6. Package layout

```text
/packages/static-analysis
  package.json
  tsconfig.json
  src/
    index.ts
    contracts.ts
    registry.ts
    planner.ts
    policy.ts
    reports.ts
    normalize.ts
    diff-map.ts
    severity.ts
    fingerprint.ts
    adapters/
      eslint.adapter.ts
      typescript.adapter.ts
      ruff.adapter.ts
      pyright.adapter.ts
      mypy.adapter.ts
      semgrep.adapter.ts
      govet.adapter.ts
      staticcheck.adapter.ts
      cargoCheck.adapter.ts
      cargoClippy.adapter.ts
      biome.adapter.ts
      customCommand.adapter.ts
    parsers/
      eslint.parser.ts
      typescript.parser.ts
      ruff.parser.ts
      pyright.parser.ts
      mypy.parser.ts
      semgrep.parser.ts
      govet.parser.ts
      staticcheck.parser.ts
      rustc.parser.ts
    tools/
      discovery.ts
      versions.ts
      command-builder.ts
      path-filter.ts
    store/
      static-analysis.repository.ts
      static-analysis-artifacts.ts
    test/
      fixtures/
        eslint-output.json
        ruff-output.json
        pyright-output.json
        semgrep-output.json
        staticcheck-output.jsonl
        cargo-output.jsonl

/packages/tool-runner
  src/
    index.ts
    contracts.ts
    process-runner.ts
    output-capture.ts
    artifacts.ts
    limits.ts
    environment.ts
```

Optional future:

```text
/packages/sandbox-runner
  src/
    index.ts
    firecracker-runner.ts
    docker-runner.ts
    nsjail-runner.ts
    policy.ts
```

---

## 7. Core contracts

These should be added to `/packages/contracts` or exported by `/packages/static-analysis` and re-exported from contracts.

### 7.1 StaticAnalysisRequest

```ts
export type StaticAnalysisRequest = {
  schemaVersion: "static_analysis_request.v1";

  orgId: OrgId;
  repoId: RepoId;
  reviewRunId: ReviewRunId;

  pullRequestSnapshotId: PullRequestSnapshotId;
  baseSha: CommitSha;
  headSha: CommitSha;

  workspace: {
    workspaceId: string;
    path: string;
    commitSha: CommitSha;
    isTrusted: boolean;
  };

  policySnapshotId: ReviewPolicySnapshotId;
  policy: ReviewPolicySnapshot;

  changedFiles: ChangedFile[];
  changedSymbols?: ChangedSymbol[];

  mode: StaticAnalysisMode;
  reason: "review" | "manual" | "replay" | "scheduled";

  budgets: StaticAnalysisBudgets;

  requestedTools?: StaticToolName[];
  disabledTools?: StaticToolName[];

  createdAt: IsoDateTime;
};
```

### 7.2 StaticAnalysisMode

```ts
export type StaticAnalysisMode =
  | "off"
  | "changed_files_fast"
  | "affected_projects"
  | "full_head"
  | "base_head_delta"
  | "security_only"
  | "debug_full";
```

Recommended modes:

| Mode | Use case | Behavior |
|---|---|---|
| `off` | disabled repo or policy | no tool runs |
| `changed_files_fast` | default MVP | run fast tools on changed files/head only |
| `affected_projects` | better TypeScript/Go/Rust support | run per affected project/package |
| `full_head` | manual/debug | run full tool suite on head only |
| `base_head_delta` | high-quality filtering | run selected tools on base and head, report introduced diagnostics |
| `security_only` | security-focused repos | run Semgrep/security tools only |
| `debug_full` | internal debugging | maximum detail, not default |

### 7.3 StaticAnalysisBudgets

```ts
export type StaticAnalysisBudgets = {
  maxWallClockMs: number;
  maxToolRuns: number;
  maxToolRunMs: number;
  maxOutputBytesPerTool: number;
  maxArtifactBytesPerTool: number;
  maxDiagnosticsPerTool: number;
  maxDiagnosticsTotal: number;
  maxChangedFilesForFastMode: number;
  allowFullRepoAnalysis: boolean;
};
```

Suggested MVP defaults:

```ts
export const DEFAULT_STATIC_ANALYSIS_BUDGETS: StaticAnalysisBudgets = {
  maxWallClockMs: 120_000,
  maxToolRuns: 8,
  maxToolRunMs: 45_000,
  maxOutputBytesPerTool: 10_000_000,
  maxArtifactBytesPerTool: 25_000_000,
  maxDiagnosticsPerTool: 500,
  maxDiagnosticsTotal: 1_500,
  maxChangedFilesForFastMode: 100,
  allowFullRepoAnalysis: false,
};
```

### 7.4 StaticToolName

```ts
export type StaticToolName =
  | "eslint"
  | "typescript"
  | "biome"
  | "ruff"
  | "pyright"
  | "mypy"
  | "semgrep"
  | "go_vet"
  | "staticcheck"
  | "cargo_check"
  | "cargo_clippy"
  | "custom_command";
```

### 7.5 ToolDescriptor

```ts
export type ToolDescriptor = {
  name: StaticToolName;
  displayName: string;
  languages: Language[];
  categories: FindingCategory[];

  defaultEnabled: boolean;
  supportsChangedFiles: boolean;
  supportsProjectScope: boolean;
  supportsFullRepo: boolean;
  supportsBaseHeadDelta: boolean;
  requiresDependencies: boolean;
  mayExecuteProjectCode: boolean;
  mayAccessNetwork: boolean;
  mutatesWorkspace: boolean;

  outputFormats: ToolOutputFormat[];
  preferredOutputFormat: ToolOutputFormat;

  defaultTimeoutMs: number;
  defaultMaxOutputBytes: number;
};
```

### 7.6 ToolOutputFormat

```ts
export type ToolOutputFormat =
  | "json"
  | "jsonl"
  | "sarif"
  | "text"
  | "junit_xml"
  | "github_annotations";
```

### 7.7 ToolRunPlan

```ts
export type ToolRunPlan = {
  planId: string;
  tool: StaticToolName;
  adapterVersion: string;

  scope: ToolRunScope;
  command: ToolCommandSpec;

  expectedOutputFormat: ToolOutputFormat;

  timeoutMs: number;
  maxOutputBytes: number;

  reason: string;
  policyDecisionTrace?: PolicyDecisionTrace;

  allowFailure: boolean;
  cacheKey?: string;
};
```

### 7.8 ToolRunScope

```ts
export type ToolRunScope = {
  kind:
    | "changed_files"
    | "affected_project"
    | "package"
    | "workspace"
    | "full_repo";

  paths: RepoPath[];
  projectRoot?: RepoPath;
  configPath?: RepoPath;
  packageName?: string;
  language?: Language;

  commitSha: CommitSha;
  configTrust: "base" | "head" | "mixed" | "unknown";
};
```

### 7.9 ToolCommandSpec

```ts
export type ToolCommandSpec = {
  executable: string;
  args: string[];
  cwd: string;

  env: Record<string, string>;

  stdin?: string;

  // For logging/debugging only. Must be redacted.
  displayCommand: string;

  networkPolicy: "none" | "metadata_only" | "allow";
  filesystemPolicy: "read_only" | "read_write_tmp";
};
```

### 7.10 ToolRunResult

```ts
export type ToolRunResult = {
  toolRunId: string;
  planId: string;
  tool: StaticToolName;

  status:
    | "succeeded"
    | "failed_with_diagnostics"
    | "failed_tool_error"
    | "timed_out"
    | "skipped"
    | "cancelled";

  startedAt: IsoDateTime;
  finishedAt: IsoDateTime;
  durationMs: number;

  exitCode: number | null;
  signal: string | null;

  stdoutArtifactUri?: string;
  stderrArtifactUri?: string;
  reportArtifactUri?: string;

  stdoutHash?: Sha256;
  stderrHash?: Sha256;
  reportHash?: Sha256;

  stdoutBytes: number;
  stderrBytes: number;

  parserWarnings: ToolParserWarning[];
  diagnostics: NormalizedToolDiagnostic[];

  toolVersion?: string;
  adapterVersion: string;

  error?: ToolRunError;
};
```

### 7.11 NormalizedToolDiagnostic

```ts
export type NormalizedToolDiagnostic = {
  diagnosticId: string;
  fingerprint: string;

  tool: StaticToolName;
  toolRunId: string;

  ruleId?: string;
  ruleName?: string;
  ruleUrl?: string;

  message: string;
  rawMessage?: string;

  severity: ToolDiagnosticSeverity;
  category: FindingCategory;
  confidence: number;

  location: ToolDiagnosticLocation;
  relatedLocations?: ToolDiagnosticLocation[];

  suggestion?: ToolDiagnosticSuggestion;

  isOnChangedLine: boolean;
  isInChangedFile: boolean;
  diffAnchor?: DiffAnchor;

  introducedByPr?: boolean;
  baselineStatus: "unknown" | "new" | "existing" | "fixed";

  sourceTrust: "tool_output" | "parsed_text" | "adapter_inferred";

  metadata: Record<string, unknown>;
};
```

### 7.12 ToolDiagnosticSeverity

```ts
export type ToolDiagnosticSeverity =
  | "info"
  | "warning"
  | "error"
  | "critical";
```

### 7.13 ToolDiagnosticLocation

```ts
export type ToolDiagnosticLocation = {
  filePath: RepoPath;
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;

  // Optional absolute path captured from tool output before normalization.
  originalPath?: string;

  snippet?: string;
};
```

### 7.14 ToolDiagnosticSuggestion

```ts
export type ToolDiagnosticSuggestion = {
  kind: "text" | "patch" | "replacement";
  message?: string;
  replacementText?: string;
  patch?: string;
  applicability?: "machine_applicable" | "maybe" | "manual" | "unknown";
};
```

### 7.15 StaticAnalysisReport

```ts
export type StaticAnalysisReport = {
  schemaVersion: "static_analysis_report.v1";
  reportId: string;
  reviewRunId: ReviewRunId;
  repoId: RepoId;
  commitSha: CommitSha;

  mode: StaticAnalysisMode;

  status:
    | "succeeded"
    | "partially_succeeded"
    | "failed"
    | "skipped";

  startedAt: IsoDateTime;
  finishedAt: IsoDateTime;
  durationMs: number;

  toolRuns: ToolRunResultSummary[];

  diagnostics: NormalizedToolDiagnostic[];

  summary: {
    toolRunCount: number;
    succeededToolRunCount: number;
    failedToolRunCount: number;
    timedOutToolRunCount: number;
    diagnosticCount: number;
    changedLineDiagnosticCount: number;
    newDiagnosticCount: number;
    highSeverityDiagnosticCount: number;
  };

  artifactRefs: ArtifactRef[];
  warnings: StaticAnalysisWarning[];
};
```

### 7.16 ToolAdapter interface

```ts
export interface StaticToolAdapter {
  descriptor: ToolDescriptor;

  isApplicable(input: ToolApplicabilityInput): Promise<ToolApplicability>;

  plan(input: ToolPlanningInput): Promise<ToolRunPlan[]>;

  parse(input: ToolParseInput): Promise<ToolParseResult>;

  normalize(input: ToolNormalizeInput): Promise<NormalizedToolDiagnostic[]>;
}
```

---

## 8. Database additions

The #2 database spec should be extended with these tables.

### 8.1 static_analysis_reports

```sql
create table static_analysis_reports (
  id text primary key,
  org_id text not null references orgs(id),
  repo_id text not null references repositories(id),
  review_run_id text not null references review_runs(id),

  commit_sha text not null,
  mode text not null,
  status text not null,

  started_at timestamptz not null,
  finished_at timestamptz,
  duration_ms integer,

  summary jsonb not null default '{}',
  warnings jsonb not null default '[]',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index static_analysis_reports_review_idx
  on static_analysis_reports (review_run_id);

create index static_analysis_reports_repo_commit_idx
  on static_analysis_reports (repo_id, commit_sha);
```

### 8.2 static_tool_runs

```sql
create table static_tool_runs (
  id text primary key,
  static_analysis_report_id text not null references static_analysis_reports(id),
  review_run_id text not null references review_runs(id),
  repo_id text not null references repositories(id),

  tool text not null,
  adapter_version text not null,
  tool_version text,

  status text not null,
  exit_code integer,
  signal text,

  scope jsonb not null,
  command_display text not null,
  expected_output_format text not null,

  started_at timestamptz not null,
  finished_at timestamptz,
  duration_ms integer,

  stdout_artifact_uri text,
  stderr_artifact_uri text,
  report_artifact_uri text,

  stdout_hash text,
  stderr_hash text,
  report_hash text,

  stdout_bytes integer not null default 0,
  stderr_bytes integer not null default 0,

  parser_warnings jsonb not null default '[]',
  error jsonb,

  created_at timestamptz not null default now()
);

create index static_tool_runs_report_idx
  on static_tool_runs (static_analysis_report_id);

create index static_tool_runs_review_tool_idx
  on static_tool_runs (review_run_id, tool);
```

### 8.3 static_tool_diagnostics

```sql
create table static_tool_diagnostics (
  id text primary key,
  static_analysis_report_id text not null references static_analysis_reports(id),
  tool_run_id text not null references static_tool_runs(id),
  review_run_id text not null references review_runs(id),
  repo_id text not null references repositories(id),

  tool text not null,
  fingerprint text not null,

  rule_id text,
  rule_name text,
  rule_url text,

  message text not null,
  raw_message text,

  severity text not null,
  category text not null,
  confidence numeric not null,

  file_path text not null,
  start_line integer not null,
  start_column integer,
  end_line integer,
  end_column integer,

  is_on_changed_line boolean not null default false,
  is_in_changed_file boolean not null default false,
  diff_anchor jsonb,

  introduced_by_pr boolean,
  baseline_status text not null default 'unknown',

  suggestion jsonb,
  related_locations jsonb not null default '[]',
  metadata jsonb not null default '{}',

  created_at timestamptz not null default now()
);

create unique index static_tool_diagnostics_fingerprint_run_idx
  on static_tool_diagnostics (tool_run_id, fingerprint);

create index static_tool_diagnostics_review_idx
  on static_tool_diagnostics (review_run_id);

create index static_tool_diagnostics_changed_idx
  on static_tool_diagnostics (review_run_id, is_on_changed_line, severity);

create index static_tool_diagnostics_file_idx
  on static_tool_diagnostics (repo_id, file_path, start_line);
```

### 8.4 static_tool_availability

Optional but useful for caching tool detection.

```sql
create table static_tool_availability (
  id text primary key,
  repo_id text not null references repositories(id),
  commit_sha text not null,

  tool text not null,
  available boolean not null,
  version text,
  reason text,

  detected_at timestamptz not null default now(),

  unique (repo_id, commit_sha, tool)
);
```

### 8.5 static_analysis_cache_entries

Optional future table.

```sql
create table static_analysis_cache_entries (
  id text primary key,
  repo_id text not null references repositories(id),
  cache_key text not null,
  tool text not null,
  artifact_uri text not null,
  artifact_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,

  unique (repo_id, cache_key)
);
```

---

## 9. Integration points

### 9.1 With #16 Review Orchestrator

The orchestrator should own when static analysis runs.

Recommended stage order:

```text
snapshot
policy
index_dependencies
embedding_coverage
changeset
static_analysis
retrieval
review_passes
validation
publish_enqueue
```

For MVP:

```text
snapshot
policy
changeset
static_analysis
retrieval
review_passes
validation
publish_enqueue
```

The orchestrator calls:

```ts
const staticReport = await staticAnalysisEngine.run({
  orgId,
  repoId,
  reviewRunId,
  pullRequestSnapshotId,
  baseSha,
  headSha,
  workspace,
  policy,
  changedFiles,
  changedSymbols,
  mode: policy.staticAnalysis.mode,
  budgets: policy.staticAnalysis.budgets,
});
```

Then stores the `StaticAnalysisReport` as a review artifact.

### 9.2 With #14 Retrieval Engine

Retrieval should be able to include static diagnostics as context items:

```ts
type StaticAnalysisContextItem = {
  kind: "static_diagnostic";
  diagnostic: NormalizedToolDiagnostic;
  reason: "changed_line" | "changed_file" | "introduced_by_pr" | "high_severity";
};
```

Retrieval should prefer:

```text
- diagnostics on changed lines
- diagnostics newly introduced by the PR
- high/critical diagnostics in changed files
- security diagnostics from Semgrep or equivalent tools
```

### 9.3 With #18 Review Passes

Review passes receive static diagnostics through the `ReviewFrame`.

Example:

```ts
type ReviewFrame = {
  snapshot: PullRequestSnapshot;
  changeSet: ChangeSet;
  contextBundle: ContextBundle;
  staticAnalysisReport?: StaticAnalysisReport;
  policy: ReviewPolicySnapshot;
};
```

A dedicated pass should synthesize high-value tool diagnostics:

```text
Static Tool Synthesis Pass
  -> reads NormalizedToolDiagnostic[]
  -> groups diagnostics by file/root cause
  -> turns important diagnostics into CandidateFinding[]
```

### 9.4 With #19 Finding Validation

Validation should check whether a CandidateFinding came from a tool:

```ts
source: "static_tool" | "llm" | "hybrid"
```

For tool-backed findings, validation can require:

```text
- diagnostic is in changed file or newly introduced
- diagnostic location maps to diff anchor or fallback summary
- tool output exists in static_tool_diagnostics
- rule is not suppressed by repo policy/memory
```

### 9.5 With #22 Repo Rules

Rules should compile into a policy snapshot:

```ts
type StaticAnalysisPolicy = {
  enabled: boolean;
  mode: StaticAnalysisMode;
  enabledTools: StaticToolName[];
  disabledTools: StaticToolName[];
  severityThreshold: ToolDiagnosticSeverity;
  requireChangedLine: boolean;
  allowBaseHeadDelta: boolean;
  allowFullRepoTools: boolean;
  allowDependencyInstall: boolean;
  allowNetwork: boolean;
  customCommands: CustomStaticAnalysisCommand[];
  budgets: StaticAnalysisBudgets;
};
```

### 9.6 With #24 Sandbox Execution

Static analysis should define execution requirements, but delegate enforcement to the runner.

```ts
type ExecutionSecurityProfile =
  | "safe_local_readonly"
  | "tool_sandbox_no_network"
  | "tool_sandbox_allow_package_cache"
  | "unsafe_disabled";
```

For MVP, run only non-mutating commands with strict timeouts and no secrets in env. For production, run project tools through #24.

---

## 10. Planning flow

```text
StaticAnalysisRequest
        |
        v
Load policy snapshot
        |
        v
Detect repo languages and changed file types
        |
        v
Check tool availability
        |
        v
Select applicable adapters
        |
        v
Select scope per tool
        |
        v
Build ToolRunPlan[]
        |
        v
Apply budgets and priorities
        |
        v
Run selected plans
```

### 10.1 Applicability input

```ts
export type ToolApplicabilityInput = {
  repoId: RepoId;
  commitSha: CommitSha;
  workspacePath: string;
  changedFiles: ChangedFile[];
  languages: Language[];
  policy: ReviewPolicySnapshot;
};
```

### 10.2 Applicability result

```ts
export type ToolApplicability = {
  applicable: boolean;
  confidence: number;
  reason: string;
  detectedConfigPaths: RepoPath[];
  detectedProjectRoots: RepoPath[];
  requiredExecutables: string[];
  warnings: string[];
};
```

### 10.3 Tool priority

Suggested priority order for MVP:

```text
1. TypeScript compiler diagnostics for TS repos
2. ESLint diagnostics for JS/TS repos
3. Ruff diagnostics for Python repos
4. Pyright diagnostics for Python repos if configured or installed
5. Semgrep security diagnostics if enabled
6. Go vet/staticcheck for Go repos
7. Cargo check/clippy for Rust repos
```

### 10.4 Budget enforcement

If the PR is too large:

```text
- Skip slow full-repo tools.
- Run only changed-file tools.
- Run security-only pass if enabled.
- Emit a warning into StaticAnalysisReport.
```

Example warning:

```json
{
  "kind": "budget_exceeded",
  "message": "Skipped pyright full-project analysis because changed file count exceeded static analysis budget.",
  "metadata": {
    "changedFileCount": 482,
    "budget": 100
  }
}
```

---

## 11. Tool runner contract

The runner should be provider-neutral:

```ts
export interface ToolRunner {
  run(command: ToolCommandSpec, limits: ToolExecutionLimits): Promise<ToolProcessResult>;
}
```

```ts
export type ToolExecutionLimits = {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxArtifactBytes: number;
  killGracePeriodMs: number;
};
```

```ts
export type ToolProcessResult = {
  status: "completed" | "timed_out" | "killed" | "failed_to_start";
  exitCode: number | null;
  signal: string | null;
  stdoutPath: string;
  stderrPath: string;
  stdoutBytes: number;
  stderrBytes: number;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
};
```

Runner requirements:

```text
- no shell interpolation by default
- executable + args array, never raw shell string
- timeout and kill tree
- stdout/stderr byte limits
- redacted command display
- safe environment construction
- cwd must be inside workspace
- output artifacts must be written outside the repo workspace
- do not pass GitHub tokens or model API keys
- collect process group descendants if possible
```

---

## 12. Security posture

Static analysis tools can be risky because they may:

```text
- load project-local plugins
- execute package manager hooks
- evaluate configuration files
- invoke build scripts
- access dependency caches
- read local environment variables
- phone home for rules/metadata
```

Security defaults:

```text
- no secrets in env
- no GitHub token in env
- no model provider keys in env
- no network unless explicitly allowed by policy
- no dependency installation by default
- non-mutating commands only
- run from checked-out worktree with controlled cwd
- set HOME to an empty temp directory
- set cache dirs to controlled temp/cache paths
- redact paths/secrets before storage
```

Suggested env:

```ts
const safeEnv = {
  "CI": "true",
  "NO_COLOR": "1",
  "HOME": tempHome,
  "XDG_CACHE_HOME": cacheDir,
  "TMPDIR": tmpDir,
  "PATH": safePath,

  // Tool-specific safety toggles where applicable.
  "SEMGREP_SEND_METRICS": "off",
  "GIT_LFS_SKIP_SMUDGE": "1",
};
```

Do not pass:

```text
GITHUB_TOKEN
OPENAI_API_KEY
ANTHROPIC_API_KEY
DATABASE_URL
REDIS_URL
AWS_SECRET_ACCESS_KEY
```

---

## 13. Tool adapters

Each adapter should implement:

```text
- applicability detection
- command planning
- output parsing
- diagnostic normalization
- severity/category mapping
- result fingerprinting
```

### 13.1 ESLint adapter

#### Purpose

JavaScript/TypeScript lint diagnostics.

#### Applicability

Applicable when repo contains:

```text
eslint.config.js
eslint.config.mjs
eslint.config.cjs
.eslintrc
.eslintrc.js
.eslintrc.json
package.json with eslint dependency/script
changed .js/.jsx/.ts/.tsx files
```

#### Preferred execution

Use CLI JSON output first:

```text
eslint --format json --no-error-on-unmatched-pattern <changed files>
```

Possible workspace command:

```text
pnpm exec eslint --format json --no-error-on-unmatched-pattern <files>
npm exec eslint -- --format json --no-error-on-unmatched-pattern <files>
bunx eslint --format json --no-error-on-unmatched-pattern <files>
```

Prefer the package manager detected in the repo:

```text
pnpm-lock.yaml -> pnpm exec
bun.lock / bun.lockb -> bunx or bun run
package-lock.json -> npx / npm exec
yarn.lock -> yarn exec / yarn eslint
```

#### Node API option

The ESLint Node.js API can be used when running from a Node-compatible tool runner and project plugins are safe to load. It provides structured results without shelling out. Still treat it as untrusted because project-local plugins/config can execute code.

#### Parsing

ESLint JSON result shape includes per-file results and messages. Normalize each message:

```ts
{
  tool: "eslint",
  ruleId: message.ruleId,
  severity: message.severity === 2 ? "error" : "warning",
  message: message.message,
  location: {
    filePath: normalizePath(result.filePath),
    startLine: message.line,
    startColumn: message.column,
    endLine: message.endLine,
    endColumn: message.endColumn,
  },
  suggestion: message.fix || message.suggestions ? ... : undefined,
}
```

#### Severity mapping

```text
ESLint severity 2 -> error
ESLint severity 1 -> warning
```

Category mapping:

```text
security plugin rules -> security
no-unsafe-* / no-floating-promises / exhaustive-deps -> correctness
complexity/style/import order -> maintainability or suppressed by policy
```

#### Common pitfalls

```text
- ESLint config can execute JS.
- Plugins may be missing if dependencies are not installed.
- Flat config may behave differently than legacy config.
- Running on individual files can miss project-level type-aware rules.
- Type-aware ESLint rules may require tsconfig and be slow.
```

#### MVP behavior

```text
- Run only if eslint is installed or repo has config.
- Run changed files only.
- Parse JSON.
- Promote only errors or configured high-signal rules.
```

---

### 13.2 TypeScript adapter

#### Purpose

TypeScript type-check diagnostics.

#### Applicability

Applicable when repo contains:

```text
tsconfig.json
tsconfig.*.json
package.json with typescript dependency
changed .ts/.tsx files
```

#### Preferred execution

Option A: TypeScript compiler API.

Pros:

```text
- structured diagnostics
- no brittle text parsing
- direct access to file/line/category/code
```

Cons:

```text
- loads project configuration in process
- may be memory-heavy
- project-local TypeScript version concerns
```

Option B: CLI.

```text
tsc -p <tsconfig> --noEmit --pretty false
```

`--noEmit` ensures compiler output files are not generated.

#### Project selection

For changed files:

```text
- find nearest tsconfig.json upward from each changed TS file
- group files by tsconfig
- run once per affected tsconfig
```

If monorepo references exist:

```text
- detect references in tsconfig
- for MVP, run nearest project only
- later, use tsc --build --dry? or compiler API project graph
```

#### Parsing compiler API diagnostics

Normalize:

```ts
const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
```

Diagnostic fields:

```text
code
category
messageText
file.fileName
start
length
relatedInformation
```

#### Severity mapping

```text
Error -> error
Warning/Suggestion -> warning/info
```

#### Common pitfalls

```text
- TypeScript has no official stable JSON CLI output; prefer compiler API for structured diagnostics.
- Full type checking can be expensive.
- Dependencies may not be installed.
- Generated files and project references can inflate scope.
- `skipLibCheck` and config may hide issues.
```

#### MVP behavior

```text
- Use compiler API when available.
- Fall back to CLI text parsing only for basic file:line diagnostics.
- Run affected tsconfig only.
- Limit output to changed files and introduced diagnostics when possible.
```

---

### 13.3 Biome adapter

#### Purpose

Fast JS/TS linting/format diagnostics where repos use Biome.

#### Applicability

Applicable when repo contains:

```text
biome.json
biome.jsonc
package.json with @biomejs/biome
changed JS/TS files
```

#### Execution

```text
biome check --reporter=json <files>
```

#### MVP behavior

Optional. Since ESLint is more common, Biome can be implemented after ESLint/TypeScript unless the target repos use Biome heavily.

---

### 13.4 Ruff adapter

#### Purpose

Fast Python lint diagnostics.

#### Applicability

Applicable when repo contains:

```text
pyproject.toml with ruff config
ruff.toml
.ruff.toml
changed .py files
```

#### Execution

```text
ruff check --output-format json <changed files>
```

If repo has a lockfile or tool is installed globally in the analysis image, prefer the pinned/global tool.

#### Parsing

Ruff JSON diagnostics generally include:

```text
code
message
filename
location
end_location
fix
url
```

Normalize:

```ts
{
  tool: "ruff",
  ruleId: item.code,
  ruleUrl: item.url,
  message: item.message,
  severity: mapRuffSeverity(item.code),
  location: {
    filePath: normalizePath(item.filename),
    startLine: item.location.row,
    startColumn: item.location.column,
    endLine: item.end_location?.row,
    endColumn: item.end_location?.column,
  },
  suggestion: item.fix ? ... : undefined,
}
```

#### Severity mapping

Ruff rule codes are not all equal. Suggested mapping:

```text
F/E9/B/SIM/security-like bugbear rules -> error/warning correctness
S* security rules -> security warning/error
I/import ordering, formatting-like rules -> maintainability, often suppressed
UP modernization -> maintainability, low priority
```

#### MVP behavior

```text
- Run changed Python files only.
- Parse JSON.
- Suppress style/import-order by default unless repo opts in.
```

---

### 13.5 Pyright adapter

#### Purpose

Python type diagnostics.

#### Applicability

Applicable when repo contains:

```text
pyrightconfig.json
pyproject.toml with pyright config
package.json with pyright
changed .py files
```

or when policy enables Python type checking.

#### Execution

```text
pyright --outputjson <paths>
```

For project-level analysis:

```text
pyright --outputjson --project <project-root-or-config>
```

#### Parsing

Pyright JSON output includes a summary and `generalDiagnostics` array.

Normalize each diagnostic:

```ts
{
  tool: "pyright",
  ruleId: diagnostic.rule,
  message: diagnostic.message,
  severity: mapPyrightSeverity(diagnostic.severity),
  location: {
    filePath: normalizePath(diagnostic.file),
    startLine: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLine: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
  }
}
```

#### Common pitfalls

```text
- Python import resolution depends heavily on venv/path config.
- Running changed files only may miss project-level type errors.
- Missing dependencies can produce noisy import errors.
```

#### MVP behavior

```text
- Run only if pyright config/tool is present or repo opts in.
- Deprioritize missing-import noise unless it appears introduced by PR.
- Prefer project-level run when config exists and budget allows.
```

---

### 13.6 Mypy adapter

#### Purpose

Python type diagnostics for repos that use mypy.

#### Applicability

Applicable when repo contains:

```text
mypy.ini
setup.cfg with mypy config
pyproject.toml with mypy config
changed .py files
```

#### Execution

```text
mypy --show-error-codes --no-error-summary <paths>
```

Optional flags:

```text
--hide-error-context
--no-color-output
```

#### Parsing

Mypy output is generally text-oriented. Parse common format:

```text
path/to/file.py:line: column: error: message [code]
path/to/file.py:line: error: message [code]
```

#### Common pitfalls

```text
- Text parsing is less reliable than Pyright JSON.
- Missing stubs can create noise.
- Full-project mypy can be slow.
```

#### MVP behavior

Optional. Prefer Pyright first unless target repos are mypy-heavy.

---

### 13.7 Semgrep adapter

#### Purpose

Security and pattern-based diagnostics.

#### Applicability

Applicable when:

```text
repo has .semgrep.yml / semgrep.yml
org policy enables Semgrep
security-only mode enabled
```

#### Execution

Preferred:

```text
semgrep scan --json --metrics=off --disable-version-check --config <local-rules> <paths>
```

Avoid fetching registry rules at runtime unless policy allows network and the execution sandbox permits it. For production, ship a pinned ruleset bundle or use repo-local rules from trusted base config.

#### Parsing

Semgrep JSON includes results with check ID, path, start/end positions, extra message, severity, metadata, and fix fields.

Normalize:

```ts
{
  tool: "semgrep",
  ruleId: result.check_id,
  ruleName: result.extra?.metadata?.name,
  ruleUrl: result.extra?.metadata?.source || result.extra?.metadata?.references?.[0],
  message: result.extra?.message,
  severity: mapSemgrepSeverity(result.extra?.severity),
  category: "security",
  location: {
    filePath: result.path,
    startLine: result.start.line,
    startColumn: result.start.col,
    endLine: result.end.line,
    endColumn: result.end.col,
  },
  suggestion: result.extra?.fix ? ... : undefined,
}
```

#### Common pitfalls

```text
- Registry configs may require network.
- Some rules are noisy without tuning.
- Dataflow/security findings may not sit exactly on changed lines.
- Rule IDs and severities vary by ruleset.
```

#### MVP behavior

```text
- Run only local or bundled rules.
- Prefer changed files first.
- Publish only high-confidence security diagnostics after #19 validation.
```

---

### 13.8 Go vet adapter

#### Purpose

Go suspicious-construct diagnostics.

#### Applicability

Applicable when repo contains:

```text
go.mod
go.work
changed .go files
```

#### Execution

```text
go vet -json ./...
```

For affected package scope, map changed `.go` files to packages and run:

```text
go vet -json <package patterns>
```

#### Parsing

`go vet -json` emits structured diagnostics. Be careful with stdout/stderr because Go tooling may write diagnostic streams in ways that require capturing both.

#### Common pitfalls

```text
- go vet can require module dependencies.
- build tags can affect results.
- running ./... can be expensive in large repos.
- generated code should usually be skipped.
```

#### MVP behavior

```text
- Run affected packages if package mapping is available.
- Fall back to ./... only when repo policy allows full analysis.
```

---

### 13.9 Staticcheck adapter

#### Purpose

Deeper Go static analysis.

#### Applicability

Applicable when:

```text
staticcheck available
repo has go.mod/go.work
policy enables staticcheck
```

#### Execution

```text
staticcheck -f json ./...
```

Staticcheck JSON format emits one JSON object per problem, not one JSON array.

#### Parsing

Parse JSONL-style stream:

```ts
for (const line of output.split("\n")) {
  if (!line.trim()) continue;
  const item = JSON.parse(line);
}
```

Normalize:

```ts
{
  tool: "staticcheck",
  ruleId: item.code,
  message: item.message,
  severity: mapStaticcheckSeverity(item.severity),
  location: {
    filePath: normalizePath(item.location.file),
    startLine: item.location.line,
    startColumn: item.location.column,
    endLine: item.end?.line,
    endColumn: item.end?.column,
  }
}
```

#### MVP behavior

Optional after go vet. Use only when installed in runner image or repo opts in.

---

### 13.10 Cargo check adapter

#### Purpose

Rust compiler diagnostics.

#### Applicability

Applicable when repo contains:

```text
Cargo.toml
Cargo.lock
changed .rs files
```

#### Execution

```text
cargo check --message-format=json
```

For workspaces:

```text
cargo check --workspace --message-format=json
```

#### Parsing

Cargo JSON messages are JSONL. Parse messages where:

```text
reason === "compiler-message"
message.level in error/warning
message.spans[] locations
```

Normalize primary span first:

```ts
const primary = message.spans.find(s => s.is_primary) ?? message.spans[0];
```

#### Common pitfalls

```text
- Cargo may run build scripts.
- Dependency compilation can be expensive.
- Network access may be required if dependencies are missing.
- This should run only in sandboxed/no-network mode with pre-populated cache, or policy approval.
```

#### MVP behavior

```text
- Implement parser first.
- Enable execution only for trusted/internal repos or sandboxed runner.
```

---

### 13.11 Cargo Clippy adapter

#### Purpose

Rust lint diagnostics.

#### Applicability

Applicable when:

```text
Cargo.toml exists
clippy component available
policy enables Rust linting
```

#### Execution

```text
cargo clippy --message-format=json -- -D warnings
```

Do not use `-D warnings` by default for PR review unless repo already uses it. Better:

```text
cargo clippy --message-format=json
```

#### Parsing

Same as Cargo check/rustc JSON diagnostics.

#### MVP behavior

Optional. Add after cargo check parser exists.

---

### 13.12 Custom command adapter

#### Purpose

Allow teams to define custom static-analysis commands.

#### Policy

Disabled by default. Requires explicit org/repo admin opt-in.

#### Config

```ts
type CustomStaticAnalysisCommand = {
  id: string;
  name: string;
  command: string[];
  cwd?: RepoPath;
  outputFormat: ToolOutputFormat;
  parser: "sarif" | "eslint_json" | "semgrep_json" | "text_regex";
  timeoutMs?: number;
  networkPolicy: "none" | "allow";
};
```

#### Safety

Custom commands should require #24 sandbox before production use.

---

## 14. SARIF support

SARIF should be supported as an import format, not necessarily as the internal format.

Why:

```text
- many tools can emit SARIF
- GitHub code scanning supports SARIF
- it is a standard static-analysis result format
```

Internal format should remain `NormalizedToolDiagnostic` because it is smaller, easier to query, and review-agent-specific.

Implement:

```text
SARIF parser
  -> run.results[]
  -> rule metadata
  -> physicalLocation artifactLocation.uri
  -> region startLine/startColumn/endLine/endColumn
  -> severity from level/properties
  -> NormalizedToolDiagnostic
```

Do not upload SARIF to GitHub code scanning by default. This product publishes PR review comments/checks through #20. SARIF upload can be a later enterprise integration.

---

## 15. Diagnostic fingerprinting

Tool diagnostics need stable fingerprints for:

```text
- base/head comparison
- duplicate suppression
- feedback correlation
- repeated review runs
- not reposting same issue
```

Recommended fingerprint input:

```ts
const fingerprintInput = {
  tool,
  ruleId,
  normalizedMessage: normalizeMessage(message),
  filePath,
  startLineBucket: stableLineBucket(filePath, startLine, codeContextHash),
  codeContextHash,
};
```

For better stability across line movement:

```text
- include file path
- include rule ID
- include normalized message
- include hash of the nearest symbol or line context
- avoid depending only on absolute line number
```

Example:

```ts
function diagnosticFingerprint(d: NormalizedToolDiagnostic): string {
  return sha256([
    d.tool,
    d.ruleId ?? "unknown",
    normalizeMessage(d.message),
    d.location.filePath,
    d.metadata.nearestSymbolId ?? "",
    d.metadata.codeContextHash ?? "",
  ].join("\n"));
}
```

---

## 16. Base/head delta comparison

### 16.1 Why

Without baseline comparison, the bot may report pre-existing repo problems.

### 16.2 Flow

```text
Run selected tool on base workspace
Run selected tool on head workspace
Normalize both result sets
Fingerprint both sets
Compare fingerprints
        |
        +-- new: in head, not in base
        +-- existing: in both
        +-- fixed: in base, not in head
```

### 16.3 Optimization

Use base/head delta only for:

```text
- Semgrep security findings
- TypeScript compiler diagnostics in affected project
- tools with high pre-existing noise
- manual/debug review mode
```

### 16.4 Data model

```ts
baselineStatus: "unknown" | "new" | "existing" | "fixed";
introducedByPr: boolean;
```

### 16.5 Caveat

Tool output can differ across base/head because dependencies/config changed. Record:

```text
- tool version
- config hash
- package lock hash
- command plan hash
```

Then only compare diagnostics with compatible execution context.

---

## 17. Diff anchoring and line mapping

Each diagnostic should be mapped to the PR diff model from #15.

```text
NormalizedToolDiagnostic.location
        |
        v
LineAnchorIndex
        |
        v
DiffAnchor | undefined
```

Fields:

```ts
isInChangedFile: boolean;
isOnChangedLine: boolean;
diffAnchor?: DiffAnchor;
```

Validation logic:

```text
If diagnostic line maps to added/modified line:
  eligible for inline comment

If diagnostic is in changed file but not changed line:
  eligible for summary or context only

If diagnostic is outside changed files:
  context only unless high-security and policy allows
```

This prevents a tool from spamming old unrelated diagnostics.

---

## 18. Severity and category calibration

Tool severity does not directly equal review severity.

Example:

```text
ESLint "error" may be a style rule.
Semgrep "warning" may be serious security risk.
Ruff "F821 undefined name" is correctness-critical.
```

Use a calibration layer:

```ts
type ToolSeverityCalibrationRule = {
  tool: StaticToolName;
  rulePattern: string;
  category: FindingCategory;
  severity: FindingSeverity;
  confidenceBoost: number;
  publishDefault: boolean;
};
```

Examples:

```text
eslint:@typescript-eslint/no-floating-promises -> correctness/high
eslint:react-hooks/exhaustive-deps -> correctness/medium
ruff:F821 undefined name -> correctness/high
ruff:I* import sorting -> maintainability/low/suppress
pyright:reportGeneralTypeIssues -> correctness/medium
semgrep:*xss* -> security/high
staticcheck:SA* -> correctness/medium-high
cargo_check:error -> correctness/high
```

---

## 19. Tool-result promotion strategy

Static diagnostics can be used in three ways.

### 19.1 Context only

Useful for LLM reasoning, but not directly published.

Examples:

```text
- lint style issue
- pre-existing type error
- diagnostic outside changed files
```

### 19.2 Direct candidate finding

Can become a `CandidateFinding` without LLM synthesis.

Examples:

```text
- TypeScript compile error on changed line
- Ruff F821 undefined name on changed line
- cargo check compiler error on changed line
```

### 19.3 Hybrid finding

Tool diagnostic plus LLM explanation.

Examples:

```text
- Semgrep flags tainted input path; LLM adds repo-specific explanation.
- Pyright flags optional value access; LLM finds caller impact.
```

Recommended MVP:

```text
- Directly promote compiler/type errors on changed lines.
- Let LLM synthesize security findings from Semgrep diagnostics.
- Keep style diagnostics context-only or suppressed.
```

---

## 20. CandidateFinding conversion

```ts
function diagnosticToCandidateFinding(
  diagnostic: NormalizedToolDiagnostic,
  context: DiagnosticPromotionContext,
): CandidateFinding {
  return {
    id: newCandidateFindingId(),
    reviewRunId: context.reviewRunId,
    source: "static_tool",
    sourceRefs: [
      {
        kind: "static_tool_diagnostic",
        id: diagnostic.diagnosticId,
      },
    ],
    filePath: diagnostic.location.filePath,
    line: diagnostic.location.startLine,
    severity: mapToolDiagnosticToFindingSeverity(diagnostic),
    category: diagnostic.category,
    title: titleFromDiagnostic(diagnostic),
    body: bodyFromDiagnostic(diagnostic),
    evidence: [
      {
        kind: "tool_diagnostic",
        tool: diagnostic.tool,
        ruleId: diagnostic.ruleId,
        message: diagnostic.message,
      },
    ],
    suggestedFix: suggestionFromDiagnostic(diagnostic),
    confidence: diagnostic.confidence,
    metadata: {
      tool: diagnostic.tool,
      ruleId: diagnostic.ruleId,
      fingerprint: diagnostic.fingerprint,
    },
  };
}
```

#19 should still validate:

```text
- anchor validity
- duplicate status
- severity threshold
- suppression rules
- comment budget
```

---

## 21. Execution modes

### 21.1 Fast changed-files mode

Default MVP.

```text
- runs quick tools only
- targets changed files
- no dependency installation
- skips full project type-check if too expensive
```

Typical tools:

```text
eslint changed JS/TS files
ruff changed Python files
semgrep changed files with local/bundled rules
```

### 21.2 Affected project mode

More accurate.

```text
- group changed files by project/package
- run TypeScript project type-check
- run Pyright project check
- run Go affected packages
- run Cargo package check
```

### 21.3 Full head mode

Useful for manual/debug or small repos.

```text
- run full repo tools on head commit
- mark diagnostics as baseline unknown unless base comparison enabled
```

### 21.4 Base/head delta mode

Highest quality, higher cost.

```text
- run selected tools on base and head
- compare diagnostics
- publish only new diagnostics by default
```

---

## 22. Dependency installation policy

Default:

```text
No dependency install during PR review.
```

Reasons:

```text
- package install scripts can execute code
- network access can leak metadata
- dependency installation is slow
- lockfiles can be changed by PR author
```

Allowed safe alternatives:

```text
- use prebuilt analysis images with common tools installed
- use repo's existing checked-in dependencies if present
- use controlled dependency cache from previous trusted default-branch builds
- run install only in #24 sandbox with no secrets and restricted network
```

Policy fields:

```ts
allowDependencyInstall: boolean;
dependencyInstallMode: "never" | "trusted_default_branch_only" | "sandboxed";
allowPackageScripts: boolean;
```

If dependencies are missing:

```text
- mark tool run as skipped_unavailable or failed_missing_dependencies
- do not treat missing dependency output as a code finding
- include warning in StaticAnalysisReport
```

---

## 23. Tool discovery

Tool discovery should answer:

```text
- Is this tool relevant?
- Is this tool available?
- Which command should run it?
- Which config files apply?
- Which project/package roots apply?
```

### 23.1 File-based discovery

```ts
type ToolDiscoveryResult = {
  tool: StaticToolName;
  relevant: boolean;
  available: boolean;
  version?: string;
  configPaths: RepoPath[];
  projectRoots: RepoPath[];
  executable?: string;
  packageManager?: "pnpm" | "bun" | "npm" | "yarn" | "system";
  reason: string;
};
```

### 23.2 Executable discovery

Search order:

```text
1. repo-local package manager command, if safe and dependencies exist
2. tool binary in analysis image
3. configured absolute executable path
4. unavailable
```

Do not run arbitrary scripts from `package.json` by default. Prefer invoking known tool binaries with explicit args.

Bad:

```text
pnpm run lint
```

Better:

```text
pnpm exec eslint --format json <files>
```

`pnpm run lint` may do anything; `pnpm exec eslint` is narrower, though still loads project-local ESLint/config/plugins.

---

## 24. Output artifact strategy

For each tool run, store:

```text
stdout.txt or stdout.json/jsonl
stderr.txt
parsed-diagnostics.json
tool-run-manifest.json
```

Object storage path:

```text
s3://.../orgs/{orgId}/repos/{repoId}/reviews/{reviewRunId}/static-analysis/{toolRunId}/stdout.json
s3://.../orgs/{orgId}/repos/{repoId}/reviews/{reviewRunId}/static-analysis/{toolRunId}/stderr.txt
s3://.../orgs/{orgId}/repos/{repoId}/reviews/{reviewRunId}/static-analysis/{toolRunId}/diagnostics.json
```

Manifest:

```json
{
  "schemaVersion": "tool_run_manifest.v1",
  "toolRunId": "str_...",
  "tool": "eslint",
  "adapterVersion": "eslint-adapter@0.1.0",
  "toolVersion": "9.0.0",
  "commandDisplay": "eslint --format json --no-error-on-unmatched-pattern src/foo.ts",
  "cwdRepoPath": ".",
  "startedAt": "2026-04-28T00:00:00.000Z",
  "finishedAt": "2026-04-28T00:00:03.211Z",
  "exitCode": 1,
  "stdoutBytes": 12345,
  "stderrBytes": 234,
  "stdoutHash": "sha256:...",
  "stderrHash": "sha256:..."
}
```

---

## 25. Error model

Tool failures are expected and should not usually fail the whole review.

```ts
type ToolRunErrorKind =
  | "tool_unavailable"
  | "config_not_found"
  | "missing_dependencies"
  | "unsupported_language"
  | "command_failed"
  | "timed_out"
  | "output_too_large"
  | "parse_error"
  | "sandbox_denied"
  | "policy_denied"
  | "internal_error";
```

Classification:

```text
Tool exits nonzero with parseable diagnostics:
  status = failed_with_diagnostics

Tool exits nonzero without parseable diagnostics:
  status = failed_tool_error

Tool missing:
  status = skipped
  error.kind = tool_unavailable

Output parse fails:
  status = failed_tool_error or partially_succeeded
  error.kind = parse_error
```

Review behavior:

```text
- Do not block review for optional tool failure.
- Do block only if policy requires tool success for a check run.
- Surface failures in debug UI and review artifacts.
```

---

## 26. Performance strategy

### 26.1 Avoid slow tools by default

Default MVP should target:

```text
eslint changed files
ruff changed files
semgrep changed files with small ruleset
```

Type checking can be expensive, so use affected-project mode and budgets.

### 26.2 Cache by command context

Cache key:

```ts
const cacheKey = sha256(JSON.stringify({
  tool,
  adapterVersion,
  toolVersion,
  repoId,
  commitSha,
  scopeHash,
  configHash,
  lockfileHash,
  commandArgs,
  policyRelevantFields,
}));
```

### 26.3 Avoid duplicate runs

If multiple review jobs target the same repo/head SHA and same command context, reuse result.

### 26.4 Bound output

Large outputs are often a sign of misconfiguration.

```text
- stop reading after maxOutputBytes
- kill process if output keeps growing after limit
- mark output_too_large
- parse partial only if safe
```

### 26.5 Parallelize carefully

Run independent tools in parallel, but cap concurrency:

```text
per review: 2–4 tool runs concurrently
per repo: 1–2 static-analysis jobs concurrently
per org: configurable
```

Avoid starting TypeScript, Pyright, Semgrep, and Cargo simultaneously on the same large repo if they compete for CPU/memory.

---

## 27. Observability

Metrics:

```text
static_analysis.report.duration_ms
static_analysis.tool_run.duration_ms
static_analysis.tool_run.count
static_analysis.tool_run.failure_count
static_analysis.tool_run.timeout_count
static_analysis.diagnostic.count
static_analysis.diagnostic.changed_line_count
static_analysis.diagnostic.promoted_count
static_analysis.cache.hit_count
static_analysis.cache.miss_count
```

Dimensions:

```text
org_id
repo_id
tool
mode
language
status
failure_kind
```

Traces:

```text
review.static_analysis
  planner
  tool.discovery
  tool.run eslint
  tool.parse eslint
  tool.normalize eslint
  report.persist
```

Logs should include:

```text
reviewRunId
staticAnalysisReportId
toolRunId
tool
status
durationMs
exitCode
outputBytes
```

Never log raw source snippets, secrets, or full diagnostics by default.

---

## 28. Testing strategy

### 28.1 Unit tests

```text
- adapter applicability
- command planning
- output parsers
- severity mapping
- category mapping
- path normalization
- fingerprinting
- baseline comparison
- diff anchor mapping
```

### 28.2 Fixture tests

Fixtures:

```text
fixtures/eslint/basic-output.json
fixtures/eslint/fix-suggestions.json
fixtures/ruff/basic-output.json
fixtures/pyright/basic-output.json
fixtures/semgrep/basic-output.json
fixtures/staticcheck/jsonl-output.jsonl
fixtures/cargo/compiler-message.jsonl
```

Expected normalized snapshots:

```text
fixtures/expected/eslint-normalized.json
fixtures/expected/ruff-normalized.json
...
```

### 28.3 Integration tests

Use small fixture repos:

```text
fixture-ts-eslint
fixture-ts-type-error
fixture-python-ruff
fixture-python-pyright
fixture-go-vet
fixture-rust-cargo-check
fixture-semgrep-security
```

Run real tools only in CI jobs that have those tools installed. Mark external-tool tests separately:

```text
pnpm test:unit
pnpm test:static-tools
```

### 28.4 Golden review tests

For a fixture PR:

```text
- run static analysis
- assert introduced diagnostics
- assert only changed-line diagnostics are promoted
- assert review pipeline receives static context
```

---

## 29. API/dashboard surfaces

The API server should expose read-only endpoints for static analysis reports.

```text
GET /api/reviews/:reviewRunId/static-analysis
GET /api/reviews/:reviewRunId/static-analysis/tool-runs
GET /api/reviews/:reviewRunId/static-analysis/diagnostics
GET /api/static-analysis/tool-runs/:toolRunId/artifacts
```

Dashboard should show:

```text
- tools run
- tools skipped and why
- duration per tool
- diagnostics by severity/category
- diagnostics on changed lines
- raw output artifact links for admins
- parse warnings
- failure reasons
```

Do not expose raw source-heavy artifacts to users without RBAC and redaction policy.

---

## 30. Rule/config integration

Repo settings should include:

```ts
type StaticAnalysisSettings = {
  enabled: boolean;
  mode: StaticAnalysisMode;
  enabledTools: StaticToolName[];
  disabledTools: StaticToolName[];
  severityThreshold: ToolDiagnosticSeverity;
  requireChangedLineForPromotion: boolean;
  allowFullRepoAnalysis: boolean;
  allowBaseHeadDelta: boolean;
  allowDependencyInstall: boolean;
  allowNetwork: boolean;
  maxToolRunMs: number;
  maxTotalMs: number;
  customCommands: CustomStaticAnalysisCommand[];
};
```

Default settings:

```json
{
  "enabled": true,
  "mode": "changed_files_fast",
  "enabledTools": ["eslint", "typescript", "ruff", "pyright", "semgrep"],
  "disabledTools": [],
  "severityThreshold": "warning",
  "requireChangedLineForPromotion": true,
  "allowFullRepoAnalysis": false,
  "allowBaseHeadDelta": false,
  "allowDependencyInstall": false,
  "allowNetwork": false,
  "maxToolRunMs": 45000,
  "maxTotalMs": 120000,
  "customCommands": []
}
```

---

## 31. Implementation sequence

### PR 1: Package shell and contracts

```text
- create /packages/static-analysis
- create /packages/tool-runner
- add contracts
- add ToolDescriptor registry
- add fake adapter
- add fake runner
- add unit tests
```

### PR 2: Database tables and repository

```text
- add migrations for static_analysis_reports
- add static_tool_runs
- add static_tool_diagnostics
- add repository methods
- add artifact refs
```

### PR 3: Planner

```text
- implement StaticAnalysisPlanner
- language/changed-file detection
- policy integration
- budget enforcement
- tool plan generation
```

### PR 4: Tool runner

```text
- process runner with executable+args
- timeout handling
- output byte limits
- safe env builder
- artifact capture
- tests
```

### PR 5: ESLint adapter

```text
- applicability detection
- command planning
- JSON parser
- normalization
- fixture tests
```

### PR 6: TypeScript adapter

```text
- tsconfig discovery
- compiler API diagnostics
- affected project grouping
- normalization
- fixture tests
```

### PR 7: Ruff adapter

```text
- config discovery
- changed-file command planning
- JSON parser
- severity mapping
- fixture tests
```

### PR 8: Pyright adapter

```text
- config discovery
- outputjson parser
- missing-import noise handling
- fixture tests
```

### PR 9: Semgrep adapter

```text
- local/bundled ruleset support
- JSON parser
- severity mapping
- security categorization
- fixture tests
```

### PR 10: Report builder and persistence

```text
- run planned tools
- persist tool runs
- persist diagnostics
- write report artifact
- static analysis report summary
```

### PR 11: Orchestrator integration

```text
- add static_analysis stage to #16
- pass report to #14/#18
- persist artifact ref
- handle skips/failures
```

### PR 12: Diagnostic promotion

```text
- convert high-signal tool diagnostics to CandidateFinding
- integrate with #18 Static Tool Synthesis Pass
- integrate with #19 validation
```

### PR 13: Dashboard/API read surfaces

```text
- API endpoints
- dashboard static analysis panel
- tool-run detail
- diagnostic table
```

### PR 14: Go/Rust adapters

```text
- go vet parser/planner
- staticcheck parser/planner
- cargo check parser/planner
- cargo clippy parser/planner
```

### PR 15: Base/head delta

```text
- run selected tools on base and head
- compare fingerprints
- mark baselineStatus
- update promotion policy
```

---

## 32. MVP cut

Implement first:

```text
- /packages/static-analysis shell
- /packages/tool-runner shell
- StaticAnalysisRequest / StaticAnalysisReport / NormalizedToolDiagnostic
- static_analysis_reports table
- static_tool_runs table
- static_tool_diagnostics table
- planner
- fake runner/adapter
- process runner
- ESLint adapter
- TypeScript adapter using compiler API or CLI fallback
- Ruff adapter
- Pyright adapter if config/tool available
- Semgrep adapter with local/bundled rules only
- changed-files-fast mode
- diff anchor mapping
- report persistence
- orchestrator integration
- static tool synthesis pass for high-signal diagnostics
- dashboard read-only report panel
```

Defer:

```text
- mypy
- Go vet/staticcheck
- cargo check/clippy
- custom commands
- base/head delta for every tool
- dependency installation
- network-enabled tools
- SARIF upload to GitHub code scanning
- full sandbox enforcement (#24)
```

---

## 33. Definition of done

This section is done when:

```text
- StaticAnalysisEngine can run from a review job.
- At least ESLint, TypeScript, Ruff, and Semgrep adapters are implemented or stubbed behind policy.
- Tool output is parsed into NormalizedToolDiagnostic records.
- Diagnostics are persisted and queryable by review run.
- Diagnostics are mapped to changed files/diff anchors.
- High-signal diagnostics can become CandidateFindings.
- Tool failures do not crash review jobs.
- Raw outputs are stored as artifacts with hashes.
- The dashboard/API can show which tools ran, what they found, and why tools skipped.
- The system works with no dependency install and no secrets in env.
- Unit and fixture tests cover all implemented parsers.
```

---

## 34. Key risks

### 34.1 Noise

Static tools can overwhelm review quality. Mitigation:

```text
- require changed-line or introduced diagnostics for publishing
- suppress style rules by default
- use repo policy and memory suppressions
- cap comments
```

### 34.2 Unsafe execution

Tools may run untrusted code. Mitigation:

```text
- no secrets in env
- no install by default
- no network by default
- non-mutating commands
- #24 sandbox for production execution
```

### 34.3 Missing dependencies

Analysis can fail without installed dependencies. Mitigation:

```text
- classify missing dependency failures
- do not publish them as code issues
- support controlled caches later
```

### 34.4 Slow full-project checks

Mitigation:

```text
- changed-files-fast mode
- affected project detection
- budgets/timeouts
- cache results by commit/config/tool
```

### 34.5 Config trust

PR-authored config may disable checks. Mitigation:

```text
- policy from trusted base snapshot
- mark head-config-sensitive runs
- alert when PR changes static-analysis config
```

---

## 35. Reference commands

```bash
# ESLint
pnpm exec eslint --format json --no-error-on-unmatched-pattern src/foo.ts

# TypeScript
pnpm exec tsc -p tsconfig.json --noEmit --pretty false

# Ruff
ruff check --output-format json src/foo.py

# Pyright
pyright --outputjson

# Mypy
mypy --show-error-codes --no-error-summary src/foo.py

# Semgrep
semgrep scan --json --metrics=off --disable-version-check --config .semgrep.yml src/

# Go vet
go vet -json ./...

# Staticcheck
staticcheck -f json ./...

# Cargo check
cargo check --message-format=json

# Cargo clippy
cargo clippy --message-format=json
```

---

## 36. Reference sources

Official and primary references used for this spec:

```text
ESLint formatters:
https://eslint.org/docs/latest/use/formatters/

ESLint Node.js API:
https://eslint.org/docs/latest/integrate/nodejs-api

TypeScript compiler options:
https://www.typescriptlang.org/docs/handbook/compiler-options.html

TypeScript noEmit:
https://www.typescriptlang.org/tsconfig/noEmit.html

TypeScript compiler API:
https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API

Ruff settings and output formats:
https://docs.astral.sh/ruff/settings/

Pyright command-line JSON output:
https://github.com/microsoft/pyright/blob/main/docs/command-line.md

Pyright configuration:
https://github.com/microsoft/pyright/blob/main/docs/configuration.md

Mypy command line:
https://mypy.readthedocs.io/en/stable/command_line.html

Semgrep CLI reference:
https://semgrep.dev/docs/cli-reference

Semgrep local CLI scans:
https://semgrep.dev/docs/getting-started/cli

Go vet:
https://pkg.go.dev/cmd/vet

Staticcheck CLI:
https://staticcheck.dev/docs/running-staticcheck/cli/

Staticcheck formatters:
https://staticcheck.dev/docs/running-staticcheck/cli/formatters/

Cargo clippy:
https://doc.rust-lang.org/cargo/commands/cargo-clippy.html

Cargo JSON messages:
https://doc.rust-lang.org/cargo/reference/external-tools.html

rustc JSON diagnostics:
https://doc.rust-lang.org/rustc/json.html

SARIF 2.1.0 specification:
https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html

GitHub SARIF support:
https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support-for-code-scanning
```
