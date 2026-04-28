Think of the product as **two systems**:

1. **A code understanding system** that keeps an indexed representation of each repo.
2. **A PR review system** that uses that index to produce useful, line-anchored findings.

Everything else is plumbing.

```text
                 ┌────────────────────┐
                 │     GitHub App      │
                 └─────────┬──────────┘
                           │ webhooks
                           v
┌────────────────────────────────────────────────────────┐
│                    Control Plane                       │
│                                                        │
│  Webhook API  ──>  Job Queue  ──>  Workers             │
│      │                  │              │               │
│      v                  v              v               │
│  Event Store      Review Jobs     Index Jobs           │
│                                                        │
└────────────────────────────────────────────────────────┘
                           │
                           v
┌────────────────────────────────────────────────────────┐
│                    Code Intelligence                   │
│                                                        │
│  Repo Sync  ->  Parser  ->  Graph  ->  Embeddings      │
│      │            │          │           │             │
│      v            v          v           v             │
│  Git Cache   Symbol Store  Code DB   Vector Store      │
│                                                        │
└────────────────────────────────────────────────────────┘
                           │
                           v
┌────────────────────────────────────────────────────────┐
│                    Review Engine                       │
│                                                        │
│  PR Snapshot -> Context Retrieval -> LLM Review        │
│       │              │                  │              │
│       v              v                  v              │
│  Diff Model     Context Bundle     Candidate Findings  │
│                                          │             │
│                                          v             │
│                              Dedupe / Rank / Validate  │
│                                          │             │
│                                          v             │
│                                  Publish to GitHub     │
│                                                        │
└────────────────────────────────────────────────────────┘
```

The clean mental model:

> **Index repos at commit SHAs. Review PRs against immutable snapshots. Publish only validated findings. Learn from feedback.**

That one sentence prevents a lot of architecture mess.

---

# 1. The simplest clean flow

There are four core flows.

## Flow A: Installation

```text
User installs GitHub App
        │
        v
Create org + installation records
        │
        v
Discover enabled repos
        │
        v
Enqueue initial indexing jobs
```

Do not review immediately unless the repo is indexed or you have a fallback mode.

Important rule:

> Treat installation as setup. Treat indexing as async. Treat review as a separate job.

---

## Flow B: Repository indexing

```text
IndexRepo(repo_id, commit_sha)
        │
        v
Clone/fetch repo
        │
        v
Checkout exact commit SHA
        │
        v
Parse files
        │
        v
Extract symbols
        │
        v
Build relationships
        │
        v
Chunk code
        │
        v
Create embeddings
        │
        v
Store CodeIndexVersion
```

Indexing should always be keyed by immutable commit SHA:

```text
repo_id + commit_sha -> CodeIndexVersion
```

Avoid indexing “main” as a moving target. Store:

```text
repo_id: abc
commit_sha: 91f2...
indexed_at: ...
files: [...]
symbols: [...]
edges: [...]
chunks: [...]
embeddings: [...]
summaries: [...]
```

This makes reviews reproducible.

---

## Flow C: PR review

```text
GitHub pull_request webhook
        │
        v
Create ReviewJob
        │
        v
Fetch PR snapshot
        │
        v
Ensure base/head index exists
        │
        v
Extract changed files + changed symbols
        │
        v
Retrieve relevant context
        │
        v
Run deterministic checks
        │
        v
Run LLM review passes
        │
        v
Generate candidate findings
        │
        v
Dedupe + rank + validate
        │
        v
Publish comments / summary
```

The review job should operate on a stable object:

```ts
type PullRequestSnapshot = {
  provider: "github";
  repoId: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  changedFiles: ChangedFile[];
  diff: UnifiedDiff;
  author: string;
  title: string;
  description: string;
};
```

The reviewer should not be asking GitHub random questions mid-review. Fetch the PR snapshot once, then review that snapshot.

---

## Flow D: Feedback learning

```text
User reacts / replies / resolves / ignores comment
        │
        v
GitHub webhook
        │
        v
Map event to previous finding
        │
        v
Update finding outcome
        │
        v
Update repo/team memory
```

Examples of memory:

```text
- Team dislikes style-only comments.
- Repo uses custom auth middleware.
- This pattern is intentional.
- Never complain about generated protobuf files.
- High-value reviewers care about migration safety.
```

Memory should not be magical at first. Store explicit, inspectable facts.

---

# 2. Recommended architecture

A clean production-ish architecture looks like this:

```text
                         ┌───────────────────┐
                         │    Web Frontend    │
                         └─────────┬─────────┘
                                   │
                                   v
                         ┌───────────────────┐
                         │      API Server    │
                         └─────────┬─────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
        v                          v                          v
┌───────────────┐          ┌──────────────┐          ┌────────────────┐
│ GitHub Adapter │          │  Job Queue   │          │ Settings Store │
└───────┬───────┘          └──────┬───────┘          └────────────────┘
        │                         │
        │                         v
        │              ┌────────────────────┐
        │              │  Review Orchestrator│
        │              └─────────┬──────────┘
        │                        │
        │       ┌────────────────┼────────────────┐
        │       │                │                │
        v       v                v                v
┌────────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────────┐
│ Repo Sync  │ │ Indexer  │ │  Retriever   │ │ LLM Gateway  │
└─────┬──────┘ └────┬─────┘ └──────┬───────┘ └──────┬───────┘
      │             │              │                │
      v             v              v                v
┌────────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────────┐
│ Git Cache  │ │ Code DB  │ │ Vector Store │ │ Model APIs   │
└────────────┘ └──────────┘ └──────────────┘ └──────────────┘
```

I would split the system into these services/modules.

| Component               | Responsibility                                                  |
| ----------------------- | --------------------------------------------------------------- |
| **GitHub Adapter**      | Webhooks, API calls, posting comments, check runs, permissions. |
| **API Server**          | Auth, settings, repo enablement, billing, admin UI APIs.        |
| **Job Queue**           | Async orchestration for indexing, reviews, feedback, retries.   |
| **Repo Sync**           | Securely clone/fetch repositories at specific SHAs.             |
| **Indexer**             | Parse code, extract symbols, build graph, generate embeddings.  |
| **Retriever**           | Given a PR diff, assemble the relevant code context.            |
| **Review Orchestrator** | Coordinates review stages and stores artifacts.                 |
| **LLM Gateway**         | Model routing, retries, caching, rate limits, usage tracking.   |
| **Publisher**           | Converts findings into GitHub comments/checks.                  |
| **Memory Service**      | Stores team preferences and feedback-derived rules.             |

For an MVP, these do not need to be separate deployable services. They can be separate modules in one backend. The important thing is that the boundaries are clean.

---

# 3. Keep the review pipeline deterministic

Avoid a vague “agent loop” initially.

Use a fixed pipeline:

```text
1. Normalize PR
2. Extract changed symbols
3. Retrieve context
4. Run static checks
5. Run LLM review
6. Generate candidate findings
7. Validate findings
8. Rank findings
9. Publish
10. Record outcomes
```

In code:

```ts
async function reviewPullRequest(job: ReviewJob): Promise<ReviewResult> {
  const snapshot = await github.fetchPullRequestSnapshot(job);

  await ensureIndexed(snapshot.repoId, snapshot.baseSha);
  await ensureIndexed(snapshot.repoId, snapshot.headSha);

  const changeSet = await extractChangeSet(snapshot);

  const context = await retrieveContext({
    repoId: snapshot.repoId,
    baseSha: snapshot.baseSha,
    headSha: snapshot.headSha,
    changeSet,
  });

  const toolFindings = await runStaticChecks(snapshot, context);

  const llmFindings = await runReviewPasses({
    snapshot,
    changeSet,
    context,
    toolFindings,
  });

  const findings = await postProcessFindings({
    snapshot,
    candidates: [...toolFindings, ...llmFindings],
  });

  await publishReview(snapshot, findings);

  return {
    snapshot,
    findings,
  };
}
```

This is easier to reason about than an unconstrained agent deciding what to do next.

---

# 4. The core data model

The architecture becomes clean when the data contracts are clean.

## `CodeIndexVersion`

Represents your understanding of a repo at one commit.

```ts
type CodeIndexVersion = {
  repoId: string;
  commitSha: string;
  createdAt: string;
  languages: string[];
  files: IndexedFile[];
  symbols: SymbolNode[];
  edges: CodeEdge[];
  chunks: CodeChunk[];
};
```

## `SymbolNode`

Represents functions, classes, methods, modules, etc.

```ts
type SymbolNode = {
  id: string;
  repoId: string;
  commitSha: string;
  filePath: string;
  name: string;
  kind: "function" | "class" | "method" | "module" | "variable" | "type";
  startLine: number;
  endLine: number;
  signature?: string;
  docstring?: string;
};
```

## `CodeEdge`

Represents relationships.

```ts
type CodeEdge = {
  fromSymbolId: string;
  toSymbolId: string;
  kind:
    | "calls"
    | "imports"
    | "extends"
    | "implements"
    | "references"
    | "tests"
    | "configures";
};
```

## `ChangedSymbol`

Represents what the PR touched.

```ts
type ChangedSymbol = {
  symbolId?: string;
  filePath: string;
  name?: string;
  kind?: string;
  oldRange?: LineRange;
  newRange?: LineRange;
  changeType: "added" | "modified" | "deleted";
  patch: string;
};
```

## `ContextBundle`

This is what the LLM receives.

```ts
type ContextBundle = {
  prSummary: string;
  changedFiles: ChangedFileContext[];
  changedSymbols: ChangedSymbol[];
  directDependencies: CodeSnippet[];
  directCallers: CodeSnippet[];
  similarPatterns: CodeSnippet[];
  relatedTests: CodeSnippet[];
  configs: CodeSnippet[];
  repoRules: RepoRule[];
  teamMemory: MemoryFact[];
};
```

## `Finding`

This is the only thing allowed to become a comment.

```ts
type Finding = {
  id: string;
  filePath: string;
  line: number;
  severity: "low" | "medium" | "high" | "critical";
  category:
    | "correctness"
    | "security"
    | "performance"
    | "test_coverage"
    | "maintainability"
    | "architecture";
  title: string;
  body: string;
  evidence: Evidence[];
  suggestedFix?: string;
  confidence: number;
  shouldPublish: boolean;
};
```

The critical thing: make the LLM output structured findings, then validate them before publishing.

---

# 5. The clean context retrieval model

For each changed symbol or changed file, retrieve context in layers.

```text
Layer 0: The PR diff itself
Layer 1: Full changed function/class
Layer 2: Nearby code in same file
Layer 3: Direct imports/dependencies
Layer 4: Direct callers/callees
Layer 5: Related tests
Layer 6: Similar patterns elsewhere
Layer 7: Repo rules and team memory
```

A simple retrieval algorithm:

```ts
async function retrieveContext(input: RetrieveInput): Promise<ContextBundle> {
  const changedSymbols = await getChangedSymbols(input);

  const sameFileContext = await getContainingFilesAndNeighbors(changedSymbols);

  const dependencyContext = await getImportsAndCallees(changedSymbols);

  const callerContext = await getCallers(changedSymbols);

  const testContext = await findRelatedTests(changedSymbols);

  const semanticContext = await vectorSearchSimilarCode({
    repoId: input.repoId,
    commitSha: input.baseSha,
    query: summarizeChange(input.changeSet),
  });

  const rules = await getRepoRules(input.repoId);

  const memory = await getRelevantMemory(input.repoId, input.changeSet);

  return {
    changedSymbols,
    changedFiles: sameFileContext,
    directDependencies: dependencyContext,
    directCallers: callerContext,
    relatedTests: testContext,
    similarPatterns: semanticContext,
    repoRules: rules,
    teamMemory: memory,
    prSummary: "",
    configs: [],
  };
}
```

This keeps retrieval explainable. You can inspect why each piece of code was included.

---

# 6. Review passes

Do not ask the model to “review the PR” once.

Use specialized passes.

```text
Pass 1: What changed?
Pass 2: What could break?
Pass 3: What security assumptions changed?
Pass 4: Are tests missing?
Pass 5: Does this violate repo patterns?
Pass 6: Which findings are actually worth publishing?
```

A good review engine has two stages:

```text
Generate candidates
        │
        v
Judge candidates
        │
        v
Publish only high-confidence findings
```

Example:

```ts
const candidates = await Promise.all([
  reviewCorrectness(context),
  reviewSecurity(context),
  reviewTests(context),
  reviewPatterns(context),
]);

const judged = await judgeFindings({
  candidates: candidates.flat(),
  diff: snapshot.diff,
  context,
});

const publishable = judged.filter(f =>
  f.confidence >= 0.75 &&
  f.severity !== "low" &&
  f.hasSpecificLineAnchor &&
  f.hasConcreteEvidence
);
```

This is where you prevent noisy comments.

---

# 7. Finding validation

Before posting a comment, validate:

```text
Can this line be commented on in the GitHub diff?
Does the finding reference real code?
Is the finding duplicated?
Is the finding actionable?
Is it more than a style nit?
Is the confidence high enough?
Has the team rejected this pattern before?
```

The validation stage is important enough to be its own module.

```ts
function validateFinding(finding: Finding, snapshot: PullRequestSnapshot): ValidationResult {
  if (!isLineInDiff(finding.filePath, finding.line, snapshot.diff)) {
    return reject("line_not_in_diff");
  }

  if (!finding.evidence.length) {
    return reject("missing_evidence");
  }

  if (finding.confidence < 0.75) {
    return reject("low_confidence");
  }

  if (isStyleOnly(finding)) {
    return reject("style_nit");
  }

  return accept();
}
```

A Greptile-like product wins or loses on this part.

The hard problem is not generating comments. It is **not posting bad comments**.

---

# 8. Storage layout

For an MVP, use this:

```text
Postgres
  orgs
  users
  installations
  repositories
  repo_index_versions
  indexed_files
  symbols
  code_edges
  code_chunks
  review_jobs
  review_runs
  findings
  finding_outcomes
  repo_rules
  memory_facts

pgvector
  code_chunk_embeddings
  symbol_embeddings
  summary_embeddings

Object storage
  raw diffs
  repo snapshots if needed
  review artifacts
  prompt/response logs, redacted

Redis / queue
  indexing jobs
  review jobs
  feedback jobs
```

You can start with **Postgres + pgvector + Redis** and get surprisingly far.

---

# 9. Service boundaries that stay sane

The easiest way to keep this architecture clean is to prevent components from knowing too much.

## GitHub Adapter

Knows about GitHub.

Does not know about LLMs.

```ts
interface GitProvider {
  fetchPullRequestSnapshot(input: PRRef): Promise<PullRequestSnapshot>;
  postInlineComment(input: InlineComment): Promise<void>;
  postCheckRun(input: CheckRun): Promise<void>;
  fetchRepoArchive(input: RepoRef): Promise<RepoArchive>;
}
```

## Indexer

Knows about code.

Does not know about PR comments.

```ts
interface Indexer {
  indexRepo(input: IndexRepoInput): Promise<CodeIndexVersion>;
}
```

## Retriever

Knows about context.

Does not post anything.

```ts
interface Retriever {
  retrieve(input: RetrieveInput): Promise<ContextBundle>;
}
```

## Review Engine

Knows about reasoning.

Does not call GitHub directly.

```ts
interface ReviewEngine {
  review(input: ReviewInput): Promise<Finding[]>;
}
```

## Publisher

Knows how to turn findings into provider-specific comments.

```ts
interface Publisher {
  publish(input: PublishReviewInput): Promise<PublishedReview>;
}
```

This gives you clean tests and clean failure modes.

---

# 10. The ideal MVP architecture

For the first version, I would not overbuild.

```text
Next.js dashboard
        │
        v
FastAPI / Node API
        │
        ├── GitHub webhook endpoint
        ├── GitHub App auth
        ├── Repo settings
        └── Review status API

Postgres + pgvector
        │
        ├── app data
        ├── symbols
        ├── chunks
        └── embeddings

Redis queue
        │
        ├── index_repo jobs
        └── review_pr jobs

Worker service
        │
        ├── repo sync
        ├── tree-sitter parsing
        ├── embedding generation
        ├── context retrieval
        ├── LLM review
        └── GitHub publishing
```

One API service, one worker service, one database, one queue.

That is enough.

---

# 11. Suggested implementation phases

## Phase 1: Diff-aware reviewer

Build:

```text
GitHub App
Webhook receiver
PR diff fetcher
Basic review worker
LLM review over diff + neighboring files
Inline comments
PR summary
```

No graph yet. No deep memory. No GitLab. No self-hosting.

You are proving: “Can this thing make useful PR comments?”

---

## Phase 2: Repo-aware reviewer

Add:

```text
Repo indexing
Tree-sitter parsing
Code chunks
Embeddings
Semantic retrieval
Related file retrieval
Basic test discovery
```

Now your reviewer can answer:

```text
“Is this change consistent with the rest of the repo?”
“Did they update the matching tests?”
“Does this function have callers that now break?”
```

---

## Phase 3: Symbol-aware reviewer

Add:

```text
Function/class extraction
Import graph
Call graph where possible
Changed-symbol detection
Caller/callee retrieval
Module summaries
```

This is where the product starts feeling materially better than a generic LLM wrapper.

---

## Phase 4: Team-aware reviewer

Add:

```text
Custom rules
Ignored paths
Reviewer feedback
Suppression memory
Accepted/rejected finding tracking
Repo-specific style and architecture preferences
```

This reduces noise and makes the bot feel like it belongs to the team.

---

## Phase 5: Enterprise

Add:

```text
SSO/SAML
Audit logs
Self-hosting
Bring-your-own-model
Data retention controls
Role-based access
SOC2 path
GitLab/Bitbucket support
```

---

# 12. Clean sequence diagram

A PR update should look like this:

```text
GitHub
  │
  │ pull_request.synchronize
  v
Webhook API
  │
  │ verify signature
  │ store event
  │ enqueue ReviewJob
  v
Queue
  │
  v
Review Worker
  │
  │ fetch PR snapshot
  v
GitHub Adapter
  │
  │ baseSha, headSha, diff, files
  v
Review Worker
  │
  │ ensure base/head indexed
  v
Indexer
  │
  │ parse, chunk, embed, store
  v
Code Index
  │
  v
Retriever
  │
  │ changed symbols, callers, tests, similar code
  v
Context Bundle
  │
  v
Review Engine
  │
  │ structured candidate findings
  v
Finding Validator
  │
  │ confidence, line anchor, dedupe
  v
Publisher
  │
  │ inline comments + summary
  v
GitHub
```

---

# 13. What to make immutable

This matters a lot.

Make these immutable:

```text
PR snapshot
Diff
Base SHA
Head SHA
Index version
Context bundle
LLM prompt
LLM response
Candidate findings
Published findings
```

Then you can debug any bad review later.

You want to be able to say:

```text
For review run 123:
- This was the diff.
- This was the retrieved context.
- This was the prompt.
- This was the model output.
- These findings were rejected.
- These findings were published.
```

That is how you improve the product systematically.

---

# 14. What not to do initially

Avoid these early:

```text
Fully autonomous agent loops
Multi-provider Git support
Huge code graph ambitions
Trying to support every language deeply
Posting style comments
Long review essays
Real-time indexing of everything
Training/fine-tuning on customer code
Complex memory systems
```

The MVP should be narrow and reliable.

A good first target:

```text
GitHub App
TypeScript + Python support
Postgres + pgvector
Tree-sitter parser
Diff + semantic repo retrieval
3–5 high-confidence comments max per PR
PR summary
Simple dashboard
```

---

# 15. Clean repo structure

Something like this:

```text
/apps
  /web
  /api
  /worker

/packages
  /contracts
  /github
  /repo-sync
  /parser
  /indexer
  /retrieval
  /review-engine
  /llm-gateway
  /publisher
  /memory
  /observability

/infra
  docker-compose.yml
  migrations
  terraform
```

The most important package is probably `/contracts`.

Define your core types there:

```text
PullRequestSnapshot
CodeIndexVersion
ChangedSymbol
ContextBundle
Finding
ReviewRun
FindingOutcome
```

Everything else should move those objects through the pipeline.

---

# 16. The architecture in one sentence

Build it as a **snapshot-based PR review pipeline**:

```text
GitHub event
  -> immutable PR snapshot
  -> indexed repo context
  -> retrieved context bundle
  -> structured candidate findings
  -> validation/ranking
  -> published comments
  -> feedback memory
```

That is the cleanest architecture for this kind of product.

