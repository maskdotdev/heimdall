# #14 Retrieval Engine — Implementation Spec

**Package:** `/packages/retrieval`  
**Primary app consumers:** `/apps/worker`, `/packages/review-engine`, `/packages/embedding`, `/packages/db`  
**Status:** Implementation-ready spec  
**Runtime target:** TypeScript, Bun-compatible, Node-compatible where possible  
**Primary storage target:** Postgres + pgvector  
**Future vector target:** Qdrant  
**Upstream dependencies:**  
- `#0 Core Contracts and Shared Types`
- `#2 Database Layer`
- `#10 Index Artifact Schema`
- `#12 Index Importer`
- `#13 Embedding Pipeline`

---

## 1. Purpose

The retrieval engine is the component that turns an indexed repository and a pull request snapshot into a compact, high-signal context bundle for review.

The review engine should not read the whole repo. It should receive a structured, ranked, deduplicated, explainable bundle of code snippets and metadata that are likely to matter for the pull request.

The retrieval engine answers:

```text
Given this PR, what code, tests, configs, dependencies, rules, and team memory should the reviewer see?
```

The output is:

```ts
ContextBundle
```

The review engine then consumes:

```text
PullRequestSnapshot
ChangedSymbol[]
ContextBundle
RepoRule[]
MemoryFact[]
```

and produces:

```text
CandidateFinding[]
```

---

## 2. Retrieval design principle

The retrieval engine should be **deterministic, explainable, and source-aware**.

This means every context item should answer:

```text
What is this?
Where did it come from?
Why was it included?
Which commit/index version does it belong to?
Which changed file/symbol caused it to be retrieved?
How was it scored?
How many tokens does it cost?
```

A context item should never be a mystery blob of code.

Bad:

```json
{
  "text": "some code"
}
```

Good:

```json
{
  "type": "code_snippet",
  "source": "direct_callee",
  "repoId": "repo_123",
  "commitSha": "abc123",
  "indexVersionId": "idx_456",
  "filePath": "src/auth/session.ts",
  "startLine": 44,
  "endLine": 88,
  "symbolId": "sym_789",
  "symbolName": "validateSession",
  "triggeredBy": [
    {
      "kind": "changed_symbol",
      "id": "changed_sym_001",
      "filePath": "src/api/login.ts",
      "symbolName": "loginHandler"
    }
  ],
  "score": 0.82,
  "rank": 3,
  "reasons": [
    "Changed symbol calls this function",
    "Security-sensitive auth path",
    "Within 1 graph hop"
  ],
  "text": "export function validateSession(...) { ... }",
  "estimatedTokens": 216
}
```

The retrieval engine should be optimized for **review quality**, not for generic semantic search.

---

## 3. Scope

The retrieval engine implements:

```text
- Changed-symbol detection
- Same-file context retrieval
- Graph-based retrieval
- Test retrieval
- Semantic vector retrieval
- Lexical/text retrieval
- Config/dependency retrieval
- Route/API mapping retrieval
- Rule and memory retrieval
- Candidate normalization
- Deduplication
- Ranking/fusion
- Token budget management
- Context packing
- Retrieval trace generation
- Retrieval artifact persistence
```

The retrieval engine does **not** implement:

```text
- GitHub API access
- repo cloning/fetching
- code parsing/indexing
- embedding generation
- LLM review logic
- finding validation
- comment publishing
- memory creation from feedback
```

Those belong to other packages.

---

## 4. High-level flow

```text
PullRequestSnapshot
        |
        v
RetrieveContextInput
        |
        v
Change Analyzer
        |
        v
Retrieval Queries
        |
        +--> Same-file retriever
        +--> Symbol graph retriever
        +--> Caller/callee retriever
        +--> Related test retriever
        +--> Semantic retriever
        +--> Lexical retriever
        +--> Config/dependency retriever
        +--> Route/API retriever
        +--> Rules/memory retriever
        |
        v
ContextCandidate[]
        |
        v
Normalize + dedupe
        |
        v
Rank/fuse
        |
        v
Budget + pack
        |
        v
ContextBundle
        |
        v
Review Engine
```

The canonical service method:

```ts
const contextBundle = await retrievalEngine.retrieveContext(input);
```

---

## 5. Package layout

Recommended structure:

```text
/packages/retrieval
  package.json
  tsconfig.json
  src
    index.ts

    config.ts
    errors.ts
    logger.ts

    service
      retrieval-engine.ts
      context-pipeline.ts
      context-bundle-builder.ts

    inputs
      retrieve-context-input.ts
      input-validator.ts

    change-analysis
      change-set-analyzer.ts
      changed-symbol-detector.ts
      diff-line-index.ts
      changed-file-classifier.ts

    retrievers
      retriever.ts
      same-file-retriever.ts
      symbol-graph-retriever.ts
      caller-callee-retriever.ts
      related-test-retriever.ts
      semantic-code-retriever.ts
      lexical-code-retriever.ts
      config-retriever.ts
      dependency-retriever.ts
      route-retriever.ts
      repo-rules-retriever.ts
      memory-retriever.ts

    ranking
      candidate-normalizer.ts
      deduper.ts
      scorer.ts
      rrf.ts
      reranker.ts
      diversity.ts
      source-weights.ts

    budget
      token-estimator.ts
      context-budget.ts
      context-packer.ts
      truncation.ts

    adapters
      code-index-store.ts
      postgres-code-index-store.ts
      vector-store.ts
      pgvector-vector-store.ts
      qdrant-vector-store.ts
      lexical-store.ts
      postgres-lexical-store.ts
      rules-store.ts
      memory-store.ts

    trace
      retrieval-trace.ts
      trace-recorder.ts
      artifact-writer.ts

    testing
      fake-code-index-store.ts
      fake-vector-store.ts
      fake-retrieval-engine.ts
      fixtures.ts

  test
    change-analysis.test.ts
    same-file-retriever.test.ts
    graph-retriever.test.ts
    semantic-retriever.test.ts
    lexical-retriever.test.ts
    dedupe.test.ts
    ranking.test.ts
    context-packer.test.ts
    retrieval-engine.test.ts
```

The public API should be small:

```ts
export { createRetrievalEngine } from "./service/retrieval-engine";
export type {
  RetrievalEngine,
  RetrieveContextInput,
  RetrievalConfig,
  ContextCandidate,
  RetrievalTrace
} from "./types";
```

---

## 6. Required package dependencies

MVP dependencies:

```json
{
  "dependencies": {
    "@repo/contracts": "workspace:*",
    "@repo/db": "workspace:*",
    "@repo/embedding": "workspace:*",
    "@repo/observability": "workspace:*",
    "@sinclair/typebox": "^0.34.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  }
}
```

`@repo/embedding` is allowed here only as the owner/exporter of the `SemanticSearchService` port. Retrieval must depend on that interface or facade, not embedding providers, vector-store schema, cache internals, or any package that depends back on retrieval.

Optional dependencies:

```text
- js-tiktoken or a provider-specific tokenizer for better token estimation
- lru-cache for short-lived in-process retrieval cache
- fast-glob only for fixture/dev utility paths, not production repo walking
```

The retrieval engine should mostly query the database, vector store, and imported index tables. It should not scan worktrees directly except in carefully isolated debug tooling.

---

## 7. Core interfaces

### 7.1 RetrievalEngine

```ts
export interface RetrievalEngine {
  retrieveContext(input: RetrieveContextInput): Promise<ContextBundle>;
}
```

### 7.2 RetrieveContextInput

```ts
export type RetrieveContextInput = {
  schemaVersion: "retrieve_context_input.v1";

  orgId: OrgId;
  repoId: RepoId;
  repositoryId: RepositoryId;

  reviewRunId: ReviewRunId;
  pullRequestSnapshot: PullRequestSnapshot;

  baseIndexVersionId: CodeIndexVersionId;
  headIndexVersionId: CodeIndexVersionId;

  settings: RepositorySettingsSnapshot;

  options?: RetrievalOptions;

  trace?: {
    enabled: boolean;
    persistArtifact: boolean;
  };
};
```

### 7.3 RetrievalOptions

```ts
export type RetrievalOptions = {
  mode?: "fast" | "balanced" | "deep";

  maxTotalTokens?: number;
  maxCandidatesBeforeRanking?: number;
  maxContextItems?: number;

  includeSemantic?: boolean;
  includeLexical?: boolean;
  includeGraph?: boolean;
  includeTests?: boolean;
  includeRules?: boolean;
  includeMemory?: boolean;
  includeConfigs?: boolean;
  includeDependencies?: boolean;
  includeRoutes?: boolean;

  graphDepth?: number;

  perSourceLimits?: Partial<Record<ContextSourceType, number>>;

  changedFileLimit?: number;
  changedSymbolLimit?: number;

  debug?: boolean;
};
```

Recommended defaults:

```ts
export const DEFAULT_RETRIEVAL_OPTIONS: Required<RetrievalOptions> = {
  mode: "balanced",

  maxTotalTokens: 30_000,
  maxCandidatesBeforeRanking: 300,
  maxContextItems: 80,

  includeSemantic: true,
  includeLexical: true,
  includeGraph: true,
  includeTests: true,
  includeRules: true,
  includeMemory: true,
  includeConfigs: true,
  includeDependencies: true,
  includeRoutes: true,

  graphDepth: 1,

  perSourceLimits: {
    diff: 50,
    changed_symbol: 50,
    same_file: 30,
    direct_dependency: 30,
    direct_caller: 20,
    direct_callee: 20,
    related_test: 30,
    semantic_match: 40,
    lexical_match: 30,
    config: 20,
    dependency_manifest: 20,
    route_mapping: 20,
    repo_rule: 20,
    memory_fact: 20
  },

  changedFileLimit: 200,
  changedSymbolLimit: 300,

  debug: false
};
```

---

## 8. Context source types

Define source types centrally in `@repo/contracts`, then use them here.

Recommended enum:

```ts
export const ContextSourceType = {
  Diff: "diff",
  ChangedFile: "changed_file",
  ChangedSymbol: "changed_symbol",
  SameFile: "same_file",
  NeighboringSymbol: "neighboring_symbol",
  DirectDependency: "direct_dependency",
  DirectCaller: "direct_caller",
  DirectCallee: "direct_callee",
  RelatedTest: "related_test",
  SemanticMatch: "semantic_match",
  LexicalMatch: "lexical_match",
  Config: "config",
  DependencyManifest: "dependency_manifest",
  RouteMapping: "route_mapping",
  RepoRule: "repo_rule",
  MemoryFact: "memory_fact",
  PriorFinding: "prior_finding",
  StaticDiagnostic: "static_diagnostic"
} as const;
```

The same physical code snippet may be discovered by several sources. Example:

```text
src/auth/session.ts:validateSession
```

could be retrieved as:

```text
- direct_callee
- semantic_match
- lexical_match
- same_file
```

The deduper should merge those sources into one candidate with multiple reasons, not include duplicate snippets.

---

## 9. Data flow in detail

### Step 1 — Validate input

Validate:

```text
- pull request snapshot schema
- repo ID consistency
- base/head SHAs exist
- base/head index versions belong to repo
- base/head index versions are complete
- settings snapshot exists
- retrieval options are sane
```

Reject with typed errors:

```text
retrieval.invalid_input
retrieval.index_version_missing
retrieval.index_version_not_complete
retrieval.repo_mismatch
retrieval.unsupported_pr_size
```

### Step 2 — Analyze change set

Build:

```ts
type ChangeSetAnalysis = {
  changedFiles: ChangedFile[];
  changedLinesByFile: Map<RepoPath, ChangedLineSet>;
  changedSymbols: ChangedSymbol[];
  fileClassifications: ChangedFileClassification[];
  queryHints: RetrievalQueryHint[];
  riskHints: RiskHint[];
};
```

This phase identifies:

```text
- changed files
- changed line ranges
- changed symbols
- added/deleted/renamed files
- likely tests
- likely generated files
- config/dependency file changes
- route/API changes
- security-sensitive files
- migration files
- schema/model changes
```

### Step 3 — Create retrieval queries

Convert change analysis into several query types:

```ts
type RetrievalQuery =
  | SymbolContextQuery
  | GraphContextQuery
  | SemanticContextQuery
  | LexicalContextQuery
  | TestContextQuery
  | ConfigContextQuery
  | RuleContextQuery
  | MemoryContextQuery;
```

### Step 4 — Run retrievers

Run independent retrievers concurrently, with timeouts and per-source limits:

```ts
const results = await Promise.allSettled([
  sameFileRetriever.retrieve(input),
  graphRetriever.retrieve(input),
  testRetriever.retrieve(input),
  semanticRetriever.retrieve(input),
  lexicalRetriever.retrieve(input),
  configRetriever.retrieve(input),
  rulesRetriever.retrieve(input),
  memoryRetriever.retrieve(input)
]);
```

Do not fail the whole retrieval if one optional retriever fails.

Recommended behavior:

```text
- required retrievers: diff, changed symbols, same-file
- optional retrievers: semantic, lexical, graph, tests, rules, memory, configs
```

If a required retriever fails, return a retrieval error.

If an optional retriever fails, record a warning in the trace and continue.

### Step 5 — Normalize candidates

All retrievers emit:

```ts
ContextCandidate[]
```

Normalize them to consistent keys:

```text
candidate ID
dedupe key
source type
path
line range
symbol ID if available
commit SHA
index version
text
score
reason
```

### Step 6 — Dedupe

Merge duplicate or overlapping snippets.

Dedupe by:

```text
- exact chunk ID
- exact symbol ID
- same file + overlapping ranges
- same content hash
- same memory/rule ID
```

### Step 7 — Rank/fuse

Score candidates using:

```text
- source priority
- graph distance
- changed-symbol proximity
- semantic similarity
- lexical score
- test relevance
- file importance
- risk hints
- recency/version
- team rules/memory relevance
```

Use source-specific scores plus rank fusion.

### Step 8 — Pack context

Apply token budgets:

```text
- reserve space for PR summary/diff
- reserve space for changed symbols
- reserve space for high-priority rules
- allocate remaining budget across sources
```

Truncate long snippets safely.

### Step 9 — Emit ContextBundle

Return and optionally persist:

```text
ContextBundle
RetrievalTrace
ContextBundle artifact
```

---

## 10. Changed-symbol detection

Changed-symbol detection is the first important retrieval step.

The goal:

```text
Map changed diff lines to indexed symbols in base/head indexes.
```

### 10.1 Inputs

```text
PullRequestSnapshot.changedFiles
Diff hunks
head index symbols
base index symbols
```

### 10.2 Rules by file status

#### Added file

Use head index only.

```text
changed lines -> containing head symbols
```

#### Modified file

Use head index for additions/context.

Use base index for deleted-only ranges when relevant.

```text
new changed lines -> containing head symbols
old changed lines -> containing base symbols
```

#### Deleted file

Use base index only.

```text
deleted ranges -> containing base symbols
```

#### Renamed file

Use both paths:

```text
old path -> base index
new path -> head index
```

If content is mostly unchanged, treat rename as low risk unless changed hunks exist.

### 10.3 Algorithm

```ts
export async function detectChangedSymbols(input: {
  snapshot: PullRequestSnapshot;
  baseIndexVersionId: CodeIndexVersionId;
  headIndexVersionId: CodeIndexVersionId;
  store: CodeIndexStore;
}): Promise<ChangedSymbol[]> {
  const changedSymbols: ChangedSymbol[] = [];

  for (const file of input.snapshot.changedFiles) {
    const changedLineRanges = extractChangedLineRanges(file.diffHunks);

    if (file.status !== "deleted") {
      const headSymbols = await input.store.findSymbolsContainingLines({
        indexVersionId: input.headIndexVersionId,
        filePath: file.path,
        lineRanges: changedLineRanges.newLineRanges
      });

      changedSymbols.push(...toChangedSymbols(headSymbols, file, "head"));
    }

    if (file.status === "deleted" || hasDeletedLines(file)) {
      const baseSymbols = await input.store.findSymbolsContainingLines({
        indexVersionId: input.baseIndexVersionId,
        filePath: file.previousPath ?? file.path,
        lineRanges: changedLineRanges.oldLineRanges
      });

      changedSymbols.push(...toChangedSymbols(baseSymbols, file, "base"));
    }
  }

  return dedupeChangedSymbols(changedSymbols);
}
```

### 10.4 Symbol containment query

A symbol contains a line range if:

```sql
symbol.start_line <= changed_range.end
AND symbol.end_line >= changed_range.start
```

Prefer exact containing symbols, then parent symbols.

For nested symbols:

```text
function inside class
method inside class
nested function inside function
```

Prefer the most specific symbol first.

### 10.5 Fallback

If no symbol is found:

```text
- create line-range changed symbol fallback
- include same-file surrounding context
- include semantic/lexical retrieval from the changed lines
```

Fallback object:

```ts
type ChangedSymbolFallback = {
  kind: "line_range";
  filePath: RepoPath;
  changeType: "added" | "modified" | "deleted";
  startLine: number;
  endLine: number;
  patch: string;
};
```

---

## 11. Changed-file classification

Each changed file should be classified to guide retrieval.

```ts
type ChangedFileClassification = {
  filePath: RepoPath;
  language?: LanguageId;
  role:
    | "source"
    | "test"
    | "config"
    | "dependency_manifest"
    | "migration"
    | "schema"
    | "generated"
    | "docs"
    | "binary"
    | "unknown";
  riskTags: RiskTag[];
  shouldIncludeInDiffContext: boolean;
  shouldTriggerSpecializedRetrieval: boolean;
};
```

Recommended risk tags:

```text
auth
security
database
migration
schema
payment
permissions
routing
api_contract
concurrency
serialization
dependency_change
test_only
generated
large_file
```

Heuristics:

```text
auth:
  paths containing auth, session, token, jwt, oauth, permission, acl

database:
  migrations, schema, prisma, drizzle, sequelize, alembic

routing:
  route.ts, router.ts, controller, handler, pages/api, app/api, endpoints

dependency_change:
  package.json, pnpm-lock.yaml, bun.lockb, package-lock.json, pyproject.toml,
  poetry.lock, requirements.txt, go.mod, Cargo.toml, pom.xml

test:
  *.test.ts, *.spec.ts, __tests__, test/, tests/

generated:
  generated/, gen/, __generated__, .pb.go, .generated.ts, openapi-generated
```

These are not final judgments. They are retrieval hints.

---

## 12. ContextCandidate

Every retriever emits `ContextCandidate`.

```ts
export type ContextCandidate = {
  id: string;

  sourceType: ContextSourceType;

  repoId: RepoId;
  indexVersionId?: CodeIndexVersionId;
  commitSha?: CommitSha;

  filePath?: RepoPath;
  language?: LanguageId;

  symbolId?: SymbolId;
  chunkId?: ChunkId;

  range?: LineRange;

  title?: string;
  text: string;

  score: number;
  rank?: number;

  triggeredBy: RetrievalTrigger[];

  reasons: string[];

  evidence?: {
    graphDistance?: number;
    vectorDistance?: number;
    lexicalScore?: number;
    edgeKinds?: CodeEdgeKind[];
    matchingTerms?: string[];
    contentHash?: Sha256;
  };

  metadata?: Record<string, unknown>;

  estimatedTokens?: number;

  dedupeKey: string;
};
```

Source-specific candidates are transformed into this generic shape.

---

## 13. Same-file retrieval

Same-file retrieval is the highest-confidence context source.

For each changed file:

```text
- include the changed hunks
- include the containing symbol
- include nearby sibling symbols
- include imports/exports at top of file
- include file-level comments if relevant
```

### 13.1 Same-file candidate types

```text
same_file.containing_symbol
same_file.nearby_symbol_before
same_file.nearby_symbol_after
same_file.file_imports
same_file.file_exports
same_file.module_header
same_file.changed_hunk
```

### 13.2 Algorithm

```ts
for each changedSymbol:
  include containing symbol body
  include parent symbol if small
  include sibling symbol before if close
  include sibling symbol after if close
  include import/export region if language supports it
```

### 13.3 Limits

Recommended defaults:

```text
max containing symbols per file: 10
max sibling symbols per changed symbol: 2 before + 2 after
max same-file tokens per file: 4,000
max same-file total tokens: 10,000
```

### 13.4 Why same-file retrieval matters

Many code review issues are local:

```text
- added validation but not used
- changed return shape but caller in same file not updated
- missing error handling in nearby branch
- inconsistent local helper use
- duplicate logic
```

Same-file context should almost always survive final packing.

---

## 14. Graph-based retrieval

Graph retrieval uses imported `code_edges`.

Edges may include:

```text
imports
exports
calls
references
defines
extends
implements
tests
configures
routes_to
reads
writes
```

### 14.1 Graph retriever input

```ts
type GraphRetrievalInput = {
  repoId: RepoId;
  indexVersionId: CodeIndexVersionId;
  changedSymbols: ChangedSymbol[];
  maxDepth: number;
  maxCandidates: number;
};
```

### 14.2 Direct dependencies

For each changed symbol:

```text
symbol -> calls/references/imports -> target symbols/chunks
```

Retrieve:

```text
- functions it calls
- classes/types it uses
- imported modules
- constants/config values it references
```

Use when reviewing:

```text
- does changed code call dependency correctly?
- did API contract change?
- did type/return shape change?
```

### 14.3 Direct callers

For each changed symbol:

```text
source symbols -> calls/references -> changed symbol
```

Retrieve callers when:

```text
- changed public function signature
- changed return type
- changed behavior/side effects
- changed validation rules
- deleted symbol
```

Callers are often more important than callees for regressions.

### 14.4 Graph depth

MVP should use:

```text
depth = 1
```

Deep retrieval should allow:

```text
depth = 2
```

But cap aggressively.

Recommended:

```text
depth 1 default
depth 2 only for deep mode or high-risk changes
never depth > 2 in MVP
```

### 14.5 Graph candidate scoring

Suggested scoring:

```ts
score =
  sourceWeight
  * edgeKindWeight
  * graphDistancePenalty
  * changedSymbolImportance
  * symbolSizePenalty
```

Example weights:

```ts
const EDGE_KIND_WEIGHTS = {
  calls: 1.0,
  references: 0.85,
  imports: 0.7,
  tests: 0.9,
  routes_to: 0.95,
  configures: 0.8,
  extends: 0.75,
  implements: 0.75,
  reads: 0.8,
  writes: 0.9
};

const distancePenalty = (distance: number) => 1 / distance;
```

### 14.6 Cycles

Avoid cycles:

```text
visited symbol IDs
visited edge IDs
max expansion per symbol
max expansion per file
```

### 14.7 Graph retrieval output reasons

Examples:

```text
"Changed function calls this dependency"
"Changed symbol is called by this API handler"
"Changed class implements this interface"
"Changed module imports this config value"
```

---

## 15. Related test retrieval

Test retrieval answers:

```text
Which tests are likely to cover the changed code?
Which tests should have been updated?
```

### 15.1 Sources

Use several signals:

```text
- explicit test_mapping records from indexer
- code_edges kind = tests
- path similarity
- symbol name similarity
- semantic search limited to test files
- lexical search limited to test files
- same package/directory convention
```

### 15.2 Common path conventions

```text
src/foo/bar.ts -> src/foo/bar.test.ts
src/foo/bar.ts -> src/foo/__tests__/bar.test.ts
src/foo/bar.ts -> test/foo/bar.test.ts
src/foo/bar.ts -> tests/foo/bar.test.ts

app/api/user/route.ts -> app/api/user/route.test.ts
controllers/user.ts -> controllers/user.spec.ts
```

### 15.3 Algorithm

```ts
async function retrieveRelatedTests(input): Promise<ContextCandidate[]> {
  const byExplicitMapping = await store.findTestMappings(changedSymbols);

  const byPath = await store.findFilesByLikelyTestPaths(changedFiles);

  const bySymbolName = await store.findTestChunksMentioningSymbols({
    symbolNames: changedSymbols.map(s => s.name)
  });

  const bySemantic = await vectorStore.search({
    query: buildTestSearchQuery(input),
    filters: { role: "test" }
  });

  return normalizeAndMerge([
    byExplicitMapping,
    byPath,
    bySymbolName,
    bySemantic
  ]);
}
```

### 15.4 Test retrieval output

Context candidates should identify why a test was included:

```text
"Test file path matches changed source file"
"Test imports changed symbol"
"Test name references changed function"
"Semantic match to changed behavior"
```

### 15.5 Test coverage hints

The retrieval engine should not decide whether tests are missing. But it can produce hints:

```ts
type TestCoverageRetrievalHint = {
  changedFilePath: RepoPath;
  relatedTestCount: number;
  relatedTests: ContextCandidate[];
  likelyMissingTests: boolean;
  reason: string;
};
```

The review engine can use this during the test coverage pass.

---

## 16. Semantic vector retrieval

Semantic retrieval finds code that is conceptually similar to the change.

### 16.1 Vector store interface

```ts
export interface VectorStore {
  searchCode(input: VectorCodeSearchInput): Promise<VectorSearchResult[]>;
}
```

```ts
export type VectorCodeSearchInput = {
  repoId: RepoId;
  indexVersionId: CodeIndexVersionId;
  query: string;
  queryEmbedding?: number[];

  limit: number;

  filters?: {
    languages?: LanguageId[];
    pathsInclude?: string[];
    pathsExclude?: string[];
    roles?: FileRole[];
    symbolKinds?: SymbolKind[];
    excludeChunkIds?: ChunkId[];
  };

  minSimilarity?: number;
};
```

### 16.2 Pgvector MVP

The MVP adapter reads `code_chunk_embeddings`.

```sql
SELECT
  cc.id AS chunk_id,
  cc.file_path,
  cc.start_line,
  cc.end_line,
  cc.text,
  cce.embedding <=> $1::vector AS cosine_distance
FROM code_chunk_embeddings cce
JOIN code_chunks cc ON cc.id = cce.chunk_id
WHERE cc.repo_id = $2
  AND cc.index_version_id = $3
ORDER BY cce.embedding <=> $1::vector
LIMIT $4;
```

For cosine similarity:

```text
similarity = 1 - cosine_distance
```

### 16.3 Query construction

Use a structured query string built from:

```text
PR title
PR description
changed file paths
changed symbol names
changed hunk summaries
important string literals
API route paths
error messages
config keys
risk tags
```

Do not send the entire diff as a semantic query.

Example query:

```text
PR changes login session validation in src/api/login.ts.
Changed symbols: loginHandler, createSessionCookie.
Risk tags: auth, security, token.
Important literals: "session", "expiresAt", "Set-Cookie".
Find similar auth/session validation patterns and related tests.
```

### 16.4 Multiple semantic queries

Use multiple query variants rather than one giant query:

```text
behavior query
symbol query
risk query
test query
pattern query
```

Example:

```ts
type SemanticQueryPlan = {
  queries: {
    name: string;
    query: string;
    filters?: VectorCodeSearchInput["filters"];
    limit: number;
    weight: number;
  }[];
};
```

Recommended queries:

```text
source_pattern_query
related_tests_query
risk_specific_query
api_contract_query
error_handling_query
```

### 16.5 Semantic retrieval limits

Recommended defaults:

```text
queries per PR: 3-6
results per query: 10-20
total semantic candidates before dedupe: <= 80
```

### 16.6 Semantic retrieval scoring

Raw vector score alone is not enough.

Adjust by:

```text
- whether file is same module/package
- whether symbol name overlaps
- whether path role matches intent
- whether item is generated/vendor code
- whether candidate is from tests when looking for tests
- whether item is too large
```

### 16.7 Avoid semantic retrieval pitfalls

Common problems:

```text
- semantically similar but irrelevant helper code
- unrelated files with same domain words
- tests ranking above source when looking for implementation patterns
- generated code ranking highly due repeated text
- long chunks crowding out precise snippets
```

Mitigations:

```text
- path filters
- role filters
- generated-file suppression
- source-specific quotas
- re-ranking
- dedupe against graph/same-file candidates
```

---

## 17. Lexical retrieval

Lexical retrieval finds exact or near-exact references that embeddings may miss.

Use it for:

```text
symbol names
API route strings
error messages
config keys
environment variable names
database table names
feature flags
permission names
literal values
```

### 17.1 Lexical store interface

```ts
export interface LexicalStore {
  search(input: LexicalSearchInput): Promise<LexicalSearchResult[]>;
}
```

```ts
export type LexicalSearchInput = {
  repoId: RepoId;
  indexVersionId: CodeIndexVersionId;
  queries: string[];
  limit: number;
  filters?: {
    pathsInclude?: string[];
    pathsExclude?: string[];
    roles?: FileRole[];
    languages?: LanguageId[];
  };
};
```

### 17.2 PostgreSQL full-text search

Add search materialization to code chunks:

```sql
ALTER TABLE code_chunks
ADD COLUMN search_vector tsvector;
```

Populate with weighted fields:

```sql
setweight(to_tsvector('simple', coalesce(symbol_name, '')), 'A') ||
setweight(to_tsvector('simple', coalesce(file_path, '')), 'B') ||
setweight(to_tsvector('simple', coalesce(text, '')), 'C')
```

Use `simple` config for code to avoid natural-language stemming surprises.

Query:

```sql
SELECT
  cc.*,
  ts_rank_cd(cc.search_vector, websearch_to_tsquery('simple', $1)) AS rank
FROM code_chunks cc
WHERE cc.repo_id = $2
  AND cc.index_version_id = $3
  AND cc.search_vector @@ websearch_to_tsquery('simple', $1)
ORDER BY rank DESC
LIMIT $4;
```

### 17.3 Trigram search

Use `pg_trgm` for fuzzy name/path/literal matching.

Useful for:

```text
slightly changed symbol names
snake_case vs camelCase
misspellings
similar route paths
similar config keys
```

Candidate query:

```sql
SELECT
  cc.*,
  similarity(cc.text, $1) AS similarity
FROM code_chunks cc
WHERE cc.repo_id = $2
  AND cc.index_version_id = $3
  AND cc.text % $1
ORDER BY similarity DESC
LIMIT $4;
```

In practice, trigram should be used carefully because code chunks can be long. It is often better against normalized symbol names, paths, route strings, and dependency names.

### 17.4 Query extraction

Extract lexical queries from:

```text
changed symbol names
imported symbol names
string literals in changed hunks
route paths
environment variables
permission names
database table/column names
error codes
feature flags
package names
```

Ignore noisy literals:

```text
"true"
"false"
"ok"
"id"
"name"
"data"
"error"
"test"
empty strings
very long blobs
```

### 17.5 Lexical score

Suggested scoring:

```ts
score =
  exactSymbolNameMatch * 1.0
  + exactStringLiteralMatch * 0.9
  + exactPathMatch * 0.8
  + fullTextRankNormalized * 0.7
  + trigramSimilarity * 0.5
```

Then normalize to `0..1`.

---

## 18. Config and dependency retrieval

Config changes frequently affect behavior outside the changed code.

### 18.1 Config files

Retrieve relevant config files when changed files or imports suggest them:

```text
tsconfig.json
package.json
pnpm-workspace.yaml
bun.lockb
eslint.config.js
biome.json
vite.config.ts
next.config.js
tailwind.config.ts
drizzle.config.ts
prisma/schema.prisma
pyproject.toml
ruff.toml
mypy.ini
go.mod
Cargo.toml
Dockerfile
docker-compose.yml
kubernetes manifests
.env.example
```

### 18.2 Dependency manifests

When dependency files change, retrieve:

```text
- changed dependency record
- package manifest
- lockfile summary if available
- code imports referencing changed package
- tests touching changed package behavior
```

Do not include entire lockfiles in context. Include a summarized or targeted diff.

### 18.3 Dependency retrieval candidates

```ts
type DependencyContextCandidate = ContextCandidate & {
  metadata: {
    packageName?: string;
    oldVersion?: string;
    newVersion?: string;
    manifestPath?: RepoPath;
    dependencyKind?: "prod" | "dev" | "peer" | "optional";
  };
};
```

### 18.4 Config retrieval examples

If `tsconfig.json` changes:

```text
retrieve files affected by compiler options
retrieve package config
retrieve representative TS files if option is risky
```

If `next.config.js` changes:

```text
retrieve routes/pages/app config
retrieve middleware
retrieve deployment config if indexed
```

If `.github/workflows` changes:

```text
retrieve package scripts referenced by workflow
retrieve Dockerfile if workflow builds image
```

---

## 19. Route/API retrieval

Route retrieval is important for web apps.

Sources:

```text
RouteRecord from index artifact
RouteMappingRecord
file path conventions
framework-specific route files
string literals
controller annotations
```

Examples:

```text
Next.js app/api/users/route.ts
Express router.get("/users/:id", handler)
FastAPI @app.get("/users/{id}")
Rails routes.rb if supported later
```

For changed route handlers, retrieve:

```text
- route definition
- middleware
- auth guards
- request schema
- response schema
- tests for endpoint
- callers/clients if indexed
```

Route context candidate:

```ts
type RouteContextMetadata = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathPattern: string;
  handlerSymbolId?: SymbolId;
  middlewareSymbolIds?: SymbolId[];
  framework?: string;
};
```

---

## 20. Repo rules retrieval

Repo rules are explicit instructions configured by the team.

Examples:

```text
- Do not review generated files.
- Only comment on correctness/security in this repo.
- Session cookies must use httpOnly, secure, and sameSite.
- Public API changes must update docs.
- New database migrations must include rollback guidance.
```

### 20.1 Rules store interface

```ts
export interface RulesStore {
  findRelevantRules(input: {
    orgId: OrgId;
    repoId: RepoId;
    changedFiles: ChangedFile[];
    changedSymbols: ChangedSymbol[];
    riskTags: RiskTag[];
    limit: number;
  }): Promise<RepoRule[]>;
}
```

### 20.2 Matching strategy

Match rules by:

```text
- path globs
- languages
- risk tags
- categories
- enabled state
- severity
- explicit trigger terms
```

### 20.3 Rule context item

Rules should be included as context items, not hidden behavior.

```json
{
  "sourceType": "repo_rule",
  "title": "Session cookie security",
  "text": "Session cookies must use httpOnly, secure, and sameSite.",
  "reasons": ["Changed file has risk tag auth", "Path matches src/auth/**"]
}
```

The review engine can use this to judge whether a finding violates a team rule.

---

## 21. Memory retrieval

Memory facts are learned or explicitly approved facts about the repo/team.

Examples:

```text
- Ignore import-order comments.
- The custom SessionToken class validates expiration internally.
- Generated files under src/generated are intentionally committed.
- The team wants no style comments.
- This service uses optimistic locking in BaseRepository.
```

### 21.1 Memory store interface

```ts
export interface MemoryStore {
  findRelevantMemory(input: {
    orgId: OrgId;
    repoId: RepoId;
    changedFiles: ChangedFile[];
    changedSymbols: ChangedSymbol[];
    riskTags: RiskTag[];
    lexicalHints: string[];
    limit: number;
  }): Promise<MemoryFact[]>;
}
```

### 21.2 Matching memory

Use:

```text
- path filters
- symbol names
- risk tags
- categories
- text search
- embeddings later
- recency
- confidence
- explicit user approval
```

### 21.3 Memory should be inspectable

Do not silently suppress context because of invisible memory.

Instead, retrieval should include relevant memory facts in the context bundle with a source type:

```text
memory_fact
```

Then validation can use memory to suppress or downrank findings, but the review artifacts should explain why.

---

## 22. Candidate deduplication

Retrievers will overlap. Deduping is mandatory.

### 22.1 Dedupe keys

Use strongest available key:

```text
chunk:<chunk_id>
symbol:<symbol_id>
file-range:<index_version_id>:<file_path>:<start_line>:<end_line>
content:<content_hash>
rule:<rule_id>
memory:<memory_fact_id>
```

### 22.2 Overlap merging

Two snippets overlap if:

```text
same file path
same index version
line ranges overlap significantly
```

Overlap ratio:

```ts
overlap = intersectionLength / min(lengthA, lengthB)
```

If overlap > `0.6`, merge.

Prefer:

```text
- symbol range over arbitrary chunk
- smaller precise range over huge range
- higher source priority
- more reasons/evidence
```

### 22.3 Merge behavior

When merging candidates:

```text
- keep highest score
- keep all source types
- merge reasons
- merge triggeredBy references
- merge evidence
- keep best text representation
- accumulate rank-fusion features
```

Merged candidate:

```ts
type MergedContextCandidate = ContextCandidate & {
  sourceTypes: ContextSourceType[];
  mergedFrom: string[];
  sourceScores: Partial<Record<ContextSourceType, number>>;
  sourceRanks: Partial<Record<ContextSourceType, number>>;
};
```

---

## 23. Ranking and rank fusion

Ranking should combine multiple evidence sources.

### 23.1 Why rank fusion

Different retrieval sources produce scores on different scales:

```text
vector cosine similarity
full-text search rank
graph distance
path similarity
rule priority
test mapping confidence
```

Do not naively add raw scores.

Use rank-based fusion first, then apply domain-specific boosts.

### 23.2 Reciprocal Rank Fusion

For each source list:

```text
score(item) += weight(source) / (k + rank_in_source)
```

Recommended:

```text
k = 60
```

For smaller lists, values between 20 and 60 are reasonable. Keep it configurable.

```ts
export function reciprocalRankFusion(
  rankedLists: RankedList[],
  options: { k: number; sourceWeights: Record<string, number> }
): Map<string, number> {
  const scores = new Map<string, number>();

  for (const list of rankedLists) {
    const weight = options.sourceWeights[list.source] ?? 1;

    for (const [index, item] of list.items.entries()) {
      const rank = index + 1;
      const previous = scores.get(item.id) ?? 0;
      scores.set(item.id, previous + weight / (options.k + rank));
    }
  }

  return scores;
}
```

### 23.3 Source weights

Initial source weights:

```ts
const SOURCE_WEIGHTS = {
  diff: 3.0,
  changed_symbol: 2.8,
  same_file: 2.5,
  direct_caller: 2.4,
  direct_callee: 2.2,
  direct_dependency: 2.0,
  related_test: 1.9,
  route_mapping: 1.8,
  config: 1.7,
  dependency_manifest: 1.7,
  repo_rule: 2.6,
  memory_fact: 2.3,
  lexical_match: 1.4,
  semantic_match: 1.2,
  neighboring_symbol: 1.1,
  prior_finding: 1.0
};
```

Explanation:

```text
Same-file, changed symbols, rules, and direct graph edges are usually more reliable than generic semantic matches.
```

### 23.4 Domain-specific boosts

After fusion, apply boosts:

```text
same path as changed file
same directory/package
same symbol name
same route path
same risk tag
test file for changed source file
security-sensitive path
high-priority repo rule
explicit memory fact
```

### 23.5 Domain-specific penalties

Apply penalties:

```text
generated file
vendor directory
very large snippet
low-confidence edge
distant graph hop
docs-only file when source context needed
semantic-only match with no lexical/path overlap
test-only context when reviewing implementation
```

### 23.6 Final score shape

```ts
finalScore =
  rrfScore
  * sourceReliabilityMultiplier
  * proximityMultiplier
  * riskMultiplier
  * freshnessMultiplier
  * diversityMultiplier
  * sizePenalty
  * generatedPenalty;
```

Normalize final scores to `0..1`.

---

## 24. Diversity and anti-crowding

Without diversity controls, one file can dominate context.

### 24.1 Per-file caps

Recommended defaults:

```text
max context items per file: 5
max tokens per file: 4,000
max semantic-only items per file: 2
```

### 24.2 Per-source caps

Recommended defaults:

```text
diff: always include within budget
changed_symbol: high priority
same_file: <= 30 items
graph: <= 50 items
tests: <= 30 items
semantic: <= 40 items
lexical: <= 30 items
rules: <= 20 items
memory: <= 20 items
```

### 24.3 MMR-style diversity

Optional later:

```text
select next candidate that maximizes relevance - similarity_to_selected
```

MVP can use simpler caps and dedupe.

---

## 25. Token budget management

The retrieval engine must fit context into a bounded token budget.

### 25.1 Budget profile

```ts
type ContextBudgetProfile = {
  maxTotalTokens: number;

  reserved: {
    prMetadata: number;
    diffSummary: number;
    instructions: number;
  };

  sourceBudgets: Partial<Record<ContextSourceType, number>>;
};
```

Default balanced profile:

```ts
const BALANCED_CONTEXT_BUDGET: ContextBudgetProfile = {
  maxTotalTokens: 30_000,

  reserved: {
    prMetadata: 1_500,
    diffSummary: 4_000,
    instructions: 2_000
  },

  sourceBudgets: {
    diff: 6_000,
    changed_symbol: 8_000,
    same_file: 8_000,
    direct_caller: 4_000,
    direct_callee: 4_000,
    related_test: 5_000,
    semantic_match: 4_000,
    lexical_match: 3_000,
    config: 2_000,
    repo_rule: 2_000,
    memory_fact: 2_000
  }
};
```

The sum can exceed the max because final packing is adaptive.

### 25.2 Mode profiles

Fast mode:

```text
max 15k tokens
no deep semantic queries
graph depth 1
minimal tests
```

Balanced mode:

```text
max 30k tokens
semantic + lexical + graph
good test retrieval
```

Deep mode:

```text
max 60k tokens
more semantic queries
graph depth 2
larger test/context budget
```

### 25.3 Token estimation

MVP estimate:

```ts
estimatedTokens = Math.ceil(text.length / 4);
```

Later:

```text
provider/model-specific tokenizer
```

### 25.4 Snippet truncation

Long snippets should be truncated semantically:

```text
- keep function signature
- keep changed lines
- keep surrounding lines
- keep return/error handling
- remove middle if necessary
```

Example packed snippet:

```text
src/auth/session.ts:42-118 validateSession

[beginning]
export function validateSession(token: string) {
  ...
[omitted 37 lines]
  if (!payload.exp) return null;
  ...
}
[end]
```

Never truncate in a way that hides line numbers.

### 25.5 Context item priority

Packing priority:

```text
1. PR metadata and changed hunks
2. changed symbols
3. repo rules and high-confidence memory
4. same-file context
5. direct callers/callees
6. related tests
7. configs/dependencies/routes
8. lexical exact matches
9. semantic matches
10. low-priority memory
```

---

## 26. ContextBundle contract

The existing `ContextBundle` from #0 should be used. If extending, do so in a schema-compatible way.

Recommended shape:

```ts
export type ContextBundle = {
  schemaVersion: "context_bundle.v1";

  id: ContextBundleId;
  reviewRunId: ReviewRunId;
  repoId: RepoId;

  baseIndexVersionId: CodeIndexVersionId;
  headIndexVersionId: CodeIndexVersionId;

  pullRequestNumber: number;
  baseSha: CommitSha;
  headSha: CommitSha;

  strategy: {
    name: string;
    version: string;
    mode: "fast" | "balanced" | "deep";
    optionsHash: Sha256;
  };

  budget: {
    maxTotalTokens: number;
    estimatedTotalTokens: number;
    truncated: boolean;
  };

  changedFiles: ChangedFileContext[];
  changedSymbols: ChangedSymbol[];

  items: ContextItem[];

  warnings: RetrievalWarning[];

  stats: RetrievalStats;

  artifact?: ArtifactRef;

  createdAt: IsoDateTime;
};
```

### 26.1 ContextItem

```ts
export type ContextItem = {
  id: ContextItemId;

  sourceTypes: ContextSourceType[];
  primarySourceType: ContextSourceType;

  title: string;
  text: string;

  repoId?: RepoId;
  indexVersionId?: CodeIndexVersionId;
  commitSha?: CommitSha;

  filePath?: RepoPath;
  language?: LanguageId;
  range?: LineRange;

  symbolId?: SymbolId;
  symbolName?: string;
  symbolKind?: SymbolKind;

  chunkId?: ChunkId;

  score: number;
  rank: number;

  reasons: string[];

  triggeredBy: RetrievalTrigger[];

  estimatedTokens: number;

  metadata?: Record<string, unknown>;
};
```

### 26.2 RetrievalStats

```ts
export type RetrievalStats = {
  durationMs: number;

  changedFileCount: number;
  changedSymbolCount: number;

  candidatesBySource: Record<ContextSourceType, number>;
  selectedItemsBySource: Record<ContextSourceType, number>;

  totalCandidates: number;
  dedupedCandidates: number;
  selectedItems: number;

  estimatedTokensBeforePacking: number;
  estimatedTokensAfterPacking: number;

  retrieverTimingsMs: Record<string, number>;

  vectorQueries: number;
  lexicalQueries: number;
  graphQueries: number;
};
```

---

## 27. Retrieval trace

A trace should be persisted for debugging.

```ts
type RetrievalTrace = {
  schemaVersion: "retrieval_trace.v1";

  retrievalId: RetrievalId;
  reviewRunId: ReviewRunId;
  repoId: RepoId;

  startedAt: IsoDateTime;
  completedAt?: IsoDateTime;

  inputSummary: {
    pullRequestNumber: number;
    baseSha: CommitSha;
    headSha: CommitSha;
    changedFileCount: number;
    options: RetrievalOptions;
  };

  changeAnalysis: ChangeSetAnalysis;

  retrieverRuns: {
    name: string;
    status: "succeeded" | "failed" | "skipped";
    durationMs: number;
    candidateCount: number;
    error?: string;
    warnings?: string[];
  }[];

  candidatesBeforeDedupe: ContextCandidate[];
  candidatesAfterDedupe: MergedContextCandidate[];
  selectedItems: ContextItem[];

  budget: {
    beforeTokens: number;
    afterTokens: number;
    truncatedItemIds: string[];
    droppedItemIds: string[];
  };

  warnings: RetrievalWarning[];
};
```

### 27.1 Trace size control

Retrieval traces can become large. Use object storage for full traces.

In Postgres, store only:

```text
review_artifacts row
artifact kind = retrieval_trace
artifact_uri
sha256
size_bytes
```

Dashboard can load trace artifact on demand.

### 27.2 Redaction

Trace text may include source code. Respect org/repo data retention settings.

Do not write traces if:

```text
repository_settings.store_debug_artifacts = false
```

or if enterprise policy forbids code artifact storage.

---

## 28. Persistence

### 28.1 Context bundle artifact

Persist context bundle as an artifact:

```text
review_artifacts
  kind = context_bundle
  uri = s3://...
  sha256 = ...
  size_bytes = ...
```

### 28.2 Retrieval trace artifact

Persist full trace separately:

```text
review_artifacts
  kind = retrieval_trace
  uri = s3://...
  sha256 = ...
  size_bytes = ...
```

### 28.3 Database references

`review_runs` should reference:

```text
context_bundle_artifact_id
retrieval_trace_artifact_id
```

or use `review_artifacts` lookup by `review_run_id + kind`.

---

## 29. Storage queries

### 29.1 CodeIndexStore interface

```ts
export interface CodeIndexStore {
  getIndexVersion(id: CodeIndexVersionId): Promise<CodeIndexVersion>;

  findSymbolsContainingLines(input: {
    indexVersionId: CodeIndexVersionId;
    filePath: RepoPath;
    lineRanges: LineRange[];
    preferMostSpecific?: boolean;
  }): Promise<IndexedSymbol[]>;

  findSymbolsByIds(input: {
    indexVersionId: CodeIndexVersionId;
    symbolIds: SymbolId[];
  }): Promise<IndexedSymbol[]>;

  findChunksBySymbolIds(input: {
    indexVersionId: CodeIndexVersionId;
    symbolIds: SymbolId[];
  }): Promise<CodeChunk[]>;

  findChunksByFileRanges(input: {
    indexVersionId: CodeIndexVersionId;
    filePath: RepoPath;
    ranges: LineRange[];
  }): Promise<CodeChunk[]>;

  findNeighborSymbols(input: {
    indexVersionId: CodeIndexVersionId;
    filePath: RepoPath;
    symbolId: SymbolId;
    before: number;
    after: number;
  }): Promise<IndexedSymbol[]>;

  findOutgoingEdges(input: {
    indexVersionId: CodeIndexVersionId;
    symbolIds: SymbolId[];
    edgeKinds?: CodeEdgeKind[];
    limit: number;
  }): Promise<CodeEdgeWithTarget[]>;

  findIncomingEdges(input: {
    indexVersionId: CodeIndexVersionId;
    symbolIds: SymbolId[];
    edgeKinds?: CodeEdgeKind[];
    limit: number;
  }): Promise<CodeEdgeWithSource[]>;

  findRelatedTestMappings(input: {
    indexVersionId: CodeIndexVersionId;
    filePaths: RepoPath[];
    symbolIds: SymbolId[];
    limit: number;
  }): Promise<TestMappingRecord[]>;

  findConfigRecords(input: {
    indexVersionId: CodeIndexVersionId;
    filePaths?: RepoPath[];
    limit: number;
  }): Promise<ConfigRecord[]>;

  findDependencyRecords(input: {
    indexVersionId: CodeIndexVersionId;
    packageNames?: string[];
    filePaths?: RepoPath[];
    limit: number;
  }): Promise<DependencyRecord[]>;
}
```

### 29.2 Important indexes

From #2 database layer, ensure these exist:

```sql
CREATE INDEX symbols_index_file_range_idx
ON symbols (index_version_id, file_path, start_line, end_line);

CREATE INDEX code_edges_from_idx
ON code_edges (index_version_id, from_symbol_id, kind);

CREATE INDEX code_edges_to_idx
ON code_edges (index_version_id, to_symbol_id, kind);

CREATE INDEX code_chunks_symbol_idx
ON code_chunks (index_version_id, symbol_id);

CREATE INDEX code_chunks_file_range_idx
ON code_chunks (index_version_id, file_path, start_line, end_line);

CREATE INDEX code_chunks_search_vector_idx
ON code_chunks USING GIN (search_vector);

CREATE INDEX code_chunk_embeddings_vector_idx
ON code_chunk_embeddings USING hnsw (embedding vector_cosine_ops);
```

### 29.3 Query performance rules

```text
- Always filter by repo_id and index_version_id.
- Never vector-search across all repos.
- Avoid returning raw huge code chunks without a limit.
- Use batching for symbol/edge lookups.
- Prefer keyset pagination for debug endpoints.
- Use statement timeouts on retrieval queries.
```

---

## 30. Caching

Caching is useful, but should not compromise correctness.

### 30.1 Safe cache keys

Use immutable inputs:

```text
repo_id
base_index_version_id
head_index_version_id
pull_request_snapshot.diff_hash
retrieval_strategy_version
retrieval_options_hash
repository_settings_hash
memory_version_hash
repo_rules_version_hash
```

Context cache key:

```ts
contextCacheKey = sha256([
  repoId,
  baseIndexVersionId,
  headIndexVersionId,
  snapshot.diffHash,
  retrievalStrategyVersion,
  optionsHash,
  settingsHash,
  rulesVersionHash,
  memoryVersionHash
].join(":"));
```

### 30.2 In-process cache

Use small short-lived cache for:

```text
symbol lookups
chunk lookups
edge lookups
token estimates
```

Do not rely on in-process cache for durable correctness.

### 30.3 Durable cache

Optional later:

```text
context_bundles table/artifact cache
```

Cache hit should be allowed only when all immutable keys match.

---

## 31. Failure behavior

### 31.1 Required retrieval failure

If these fail, retrieval should fail:

```text
input validation
base/head index lookup
changed-file/diff analysis
changed-symbol fallback construction
same-file changed hunk context
```

### 31.2 Optional retrieval failure

If these fail, continue with warning:

```text
semantic retrieval
lexical retrieval
graph retrieval
test retrieval
config retrieval
memory retrieval
rules retrieval
route retrieval
```

### 31.3 ContextBundle warnings

```ts
type RetrievalWarning = {
  code:
    | "semantic_retrieval_failed"
    | "lexical_retrieval_failed"
    | "graph_retrieval_failed"
    | "test_retrieval_failed"
    | "token_budget_exceeded"
    | "large_pr_context_truncated"
    | "index_missing_edges"
    | "no_changed_symbols_detected";
  message: string;
  severity: "low" | "medium" | "high";
  metadata?: Record<string, unknown>;
};
```

The review engine should see warnings and adjust confidence.

---

## 32. Large PR handling

Large PRs require special strategy.

### 32.1 Size-class policy

```text
Use the canonical ReviewSizeClass policy from #0:

small:  changedLines <= 100,  changedFiles <= 10,  rawDiffBytes <= 256 KiB
medium: changedLines <= 500,  changedFiles <= 50,  rawDiffBytes <= 1 MiB
large:  changedLines <= 3,000, changedFiles <= 100, rawDiffBytes <= 2 MiB
huge:   anything above large, or any hard parser/gating cap exceeded
```

Retrieval may also treat `changedSymbols > 300` as a local high-risk signal inside the canonical size class, but it must not create a separate large-PR threshold.

### 32.2 Large PR strategy

For large PRs:

```text
- classify changed files first
- ignore generated/vendor/docs unless configured
- group by module/directory
- retrieve top risky files first
- reduce same-file sibling context
- run fewer semantic queries
- retrieve tests only for high-risk source files
- pack by module groups
```

### 32.3 Giant PR fallback

For giant PRs, output a context bundle optimized for summary rather than inline review:

```text
- PR summary context
- changed file clusters
- dependency/config changes
- high-risk symbols
- no deep semantic retrieval unless explicitly enabled
```

Review engine should produce fewer or no inline comments.

---

## 33. Multi-commit and base/head semantics

Retrieval should know which index version to use.

### 33.1 Head index

Use head index for:

```text
new code
modified code
current callers/callees after PR
current test files
current config files
```

### 33.2 Base index

Use base index for:

```text
deleted symbols
before/after comparison
prior caller/callee shape
detecting changed signatures or deleted behavior
```

### 33.3 Mixed context items

Context items should explicitly say:

```text
commitSha
indexVersionId
snapshotSide: "base" | "head"
```

If a snippet is from base, its title should make that clear:

```text
[base] src/auth/session.ts:42-88 validateSession
```

---

## 34. Query planning

Instead of each retriever guessing independently, build a query plan.

```ts
type RetrievalQueryPlan = {
  schemaVersion: "retrieval_query_plan.v1";
  reviewRunId: ReviewRunId;

  changedFiles: ChangedFile[];
  changedSymbols: ChangedSymbol[];

  semanticQueries: SemanticQuerySpec[];
  lexicalQueries: LexicalQuerySpec[];
  graphQueries: GraphQuerySpec[];
  testQueries: TestQuerySpec[];
  configQueries: ConfigQuerySpec[];
  ruleQueries: RuleQuerySpec[];
  memoryQueries: MemoryQuerySpec[];

  riskHints: RiskHint[];
};
```

This makes retrieval testable.

### 34.1 Semantic query specs

```ts
type SemanticQuerySpec = {
  id: string;
  name:
    | "implementation_pattern"
    | "related_tests"
    | "error_handling"
    | "security_pattern"
    | "api_contract"
    | "similar_change";
  query: string;
  filters?: VectorCodeSearchInput["filters"];
  limit: number;
  weight: number;
};
```

### 34.2 Lexical query specs

```ts
type LexicalQuerySpec = {
  id: string;
  terms: string[];
  reason: string;
  filters?: LexicalSearchInput["filters"];
  limit: number;
  weight: number;
};
```

---

## 35. Source-specific implementation details

### 35.1 Diff context retriever

This retriever packages the actual PR diff.

It should include:

```text
- changed hunk text
- file status
- old/new ranges
- changed line markers
- path rename metadata
```

Do not include full file content unless small.

### 35.2 Changed symbol retriever

This retriever packages the full current changed symbols.

For modified symbols:

```text
head symbol body
base symbol body if useful and small
```

For deleted symbols:

```text
base symbol body
```

For added symbols:

```text
head symbol body
```

### 35.3 Same-file retriever

See Section 13.

### 35.4 Graph retriever

See Section 14.

### 35.5 Test retriever

See Section 15.

### 35.6 Semantic retriever

See Section 16.

### 35.7 Lexical retriever

See Section 17.

### 35.8 Config retriever

See Section 18.

### 35.9 Route retriever

See Section 19.

### 35.10 Rule retriever

See Section 20.

### 35.11 Memory retriever

See Section 21.

---

## 36. Security and privacy

Retrieval handles source code and potentially secrets.

### 36.1 Never log raw code by default

Structured logs should include:

```text
repo_id
review_run_id
candidate counts
timings
artifact IDs
```

Do not log:

```text
code text
diff text
tokens
secret-looking literals
full prompts
```

### 36.2 Secret redaction

Before persisting artifacts or sending to review engine, optionally redact secret-like values.

Patterns:

```text
API keys
private keys
tokens
password literals
connection strings
JWTs
cloud credentials
```

Redaction should preserve context:

```text
process.env.STRIPE_SECRET_KEY
```

is fine, but literal values should be masked:

```text
"sk_live_..." -> "[REDACTED_SECRET_LITERAL]"
```

### 36.3 Tenant isolation

Every query must filter by:

```text
org_id or repo_id
index_version_id
```

Never join code chunks without repository/index filters.

### 36.4 Debug artifact policy

Respect:

```text
repository_settings.store_debug_artifacts
repository_settings.store_code_context_artifacts
org_settings.data_retention_days
```

If disabled, return context in memory to review engine but do not persist full artifacts.

---

## 37. Observability

### 37.1 Metrics

Emit:

```text
retrieval.duration_ms
retrieval.candidates_total
retrieval.candidates_by_source
retrieval.selected_items_total
retrieval.estimated_tokens
retrieval.vector_query_count
retrieval.lexical_query_count
retrieval.graph_query_count
retrieval.semantic_latency_ms
retrieval.lexical_latency_ms
retrieval.graph_latency_ms
retrieval.test_latency_ms
retrieval.cache_hit_count
retrieval.cache_miss_count
retrieval.warning_count
retrieval.failure_count
```

Tags:

```text
org_id
repo_id
review_run_id
mode
language
retrieval_strategy_version
```

Be careful about high-cardinality tags. Use IDs selectively.

### 37.2 Tracing spans

Recommended spans:

```text
retrieval.retrieve_context
retrieval.validate_input
retrieval.analyze_changes
retrieval.detect_changed_symbols
retrieval.build_query_plan
retrieval.same_file
retrieval.graph
retrieval.semantic
retrieval.lexical
retrieval.tests
retrieval.rules
retrieval.memory
retrieval.dedupe
retrieval.rank
retrieval.pack
retrieval.persist_artifact
```

### 37.3 Debug dashboard support

The dashboard should show:

```text
retrieval source counts
selected context items
dropped context items
ranking reasons
warnings
token budget
retriever timings
```

This is essential for improving review quality.

---

## 38. Testing strategy

### 38.1 Unit tests

Test:

```text
diff line parsing
changed-symbol detection
same-file retrieval
graph retrieval
test retrieval
lexical query extraction
semantic query plan generation
dedupe keys
overlap merging
RRF scoring
source weights
token packing
large PR mode
warnings
```

### 38.2 Fixture repositories

Create small fixture repos:

```text
fixtures/ts-auth-service
fixtures/ts-api-routes
fixtures/python-fastapi-service
fixtures/monorepo-packages
fixtures/generated-files
```

Each fixture should have:

```text
base index records
head index records
PR snapshot
expected changed symbols
expected top context items
```

### 38.3 Golden tests

For a given PR snapshot and index fixture, assert:

```text
- changed symbols detected correctly
- required same-file context included
- direct callers/callees included
- relevant tests included
- generated files excluded
- no duplicate context items
- context within token budget
```

### 38.4 Retrieval quality tests

Create labeled queries:

```text
"changed validateSession should retrieve session tests"
"changed route should retrieve middleware"
"changed dependency should retrieve package usage"
"deleted function should retrieve callers"
```

Measure:

```text
Recall@K
MRR
NDCG@K
context token cost
latency
```

### 38.5 Regression tests

Every time retrieval changes, run:

```text
fixture retrieval test suite
golden context bundle snapshot diff
review eval harness later
```

Do not snapshot exact ordering too aggressively unless stable; allow rank tolerance where needed.

---

## 39. Performance targets

Initial targets:

```text
small PR retrieval: < 2 seconds
medium PR retrieval: < 5 seconds
large PR retrieval: < 12 seconds
semantic retrieval per query: < 500ms after embedding available
changed-symbol detection: < 1 second
graph retrieval: < 2 seconds
packing/ranking: < 500ms
```

These are aspirational but useful.

### 39.1 Performance tactics

```text
- batch DB queries
- avoid N+1 symbol/chunk lookup
- filter by index_version_id
- cap candidates before expensive work
- run retrievers concurrently
- timebox optional retrievers
- use HNSW/IVFFlat vector index when data size justifies
- materialize search vectors for lexical search
- skip semantic retrieval on huge PRs unless deep mode
```

### 39.2 Timeouts

Recommended per-retriever timeouts:

```text
same-file: 1s
changed-symbol: 1s
graph: 2s
test: 2s
semantic: 3s
lexical: 2s
config: 1s
rules: 500ms
memory: 1s
```

Overall balanced mode timeout:

```text
8s
```

The review job can still proceed with partial context.

---

## 40. Implementation plan

### PR 1 — Package skeleton and interfaces

Implement:

```text
/packages/retrieval
RetrievalEngine interface
RetrieveContextInput
RetrievalOptions
ContextCandidate
retriever interface
fake retriever
unit test setup
```

Exit criteria:

```text
package builds
package exports types
fake retrieval engine can return an empty ContextBundle
```

### PR 2 — CodeIndexStore adapter

Implement:

```text
CodeIndexStore interface
PostgresCodeIndexStore
symbol lookup
chunk lookup
edge lookup
test mapping lookup stubs
config/dependency lookup stubs
```

Exit criteria:

```text
changed-symbol detection can query real DB fixture rows
```

### PR 3 — Changed-symbol detection

Implement:

```text
diff line index
changed-file classification
changed-symbol detector
fallback line-range symbols
tests for added/modified/deleted/renamed files
```

Exit criteria:

```text
fixture PRs produce expected ChangedSymbol[]
```

### PR 4 — Same-file retriever

Implement:

```text
containing symbol retrieval
neighbor symbol retrieval
import/header retrieval if indexed
same-file candidate normalization
same-file budget limits
```

Exit criteria:

```text
changed source file produces containing symbol + nearby context
```

### PR 5 — Graph retriever

Implement:

```text
outgoing edge retrieval
incoming edge retrieval
direct caller/callee/dependency candidates
depth 1 graph traversal
cycle prevention
graph candidate scoring
```

Exit criteria:

```text
changed function retrieves direct callers and callees from fixture graph
```

### PR 6 — Test retriever

Implement:

```text
test mapping lookup
path convention lookup
symbol name lexical lookup for tests
test candidate scoring
```

Exit criteria:

```text
changed source file retrieves likely related tests
```

### PR 7 — Semantic retriever

Implement:

```text
SemanticQueryPlan
VectorStore interface integration
PgvectorVectorStore usage
multi-query semantic retrieval
semantic candidate normalization
```

Exit criteria:

```text
semantic search retrieves code chunks for fixture queries
```

### PR 8 — Lexical retriever

Implement:

```text
lexical query extraction
Postgres FTS adapter
optional trigram adapter
lexical candidate scoring
```

Exit criteria:

```text
symbol names, route strings, config keys retrieve exact matches
```

### PR 9 — Config/dependency/route retrievers

Implement:

```text
config file retrieval
dependency manifest retrieval
route mapping retrieval
risk-based triggering
```

Exit criteria:

```text
package.json and route changes retrieve relevant context
```

### PR 10 — Rules and memory retrievers

Implement:

```text
RulesStore
MemoryStore
path/risk/category matching
candidate generation
```

Exit criteria:

```text
repo rules and memory facts appear in context bundle when relevant
```

### PR 11 — Dedupe, ranking, and fusion

Implement:

```text
dedupe keys
overlap merge
RRF
source weights
domain boosts/penalties
diversity caps
```

Exit criteria:

```text
multiple retrievers producing same chunk merge into one ranked item
```

### PR 12 — Token budget and context packing

Implement:

```text
token estimator
budget profiles
source budgets
truncation
context packer
large PR mode
```

Exit criteria:

```text
ContextBundle respects maxTotalTokens and source caps
```

### PR 13 — Trace and artifact persistence

Implement:

```text
RetrievalTrace
artifact writer
context bundle artifact persistence
redaction hooks
dashboard-friendly summaries
```

Exit criteria:

```text
review run can inspect context bundle and retrieval trace artifacts
```

### PR 14 — End-to-end retrieval engine

Implement:

```text
createRetrievalEngine factory
full retrieveContext pipeline
concurrent retriever execution
timeouts
warnings
observability
integration tests
```

Exit criteria:

```text
review worker can call retrieveContext and receive a packed ContextBundle
```

---

## 41. MVP cut

For MVP, implement:

```text
- RetrievalEngine interface
- changed-symbol detection
- changed-file classification
- same-file retrieval
- direct graph retrieval if edges exist
- related test retrieval by path conventions
- semantic vector retrieval through pgvector
- lexical retrieval through Postgres FTS
- repo rule retrieval
- candidate dedupe
- basic RRF ranking
- token budget packing
- context bundle artifact
- retrieval trace summary
```

Skip initially:

```text
- Qdrant adapter
- deep graph traversal
- advanced MMR diversity
- memory embeddings
- route framework-specific extraction beyond imported RouteRecords
- dependency impact analysis beyond manifests and lexical usage
- model-based reranking
```

---

## 42. Definition of done

#14 is implemented when:

```text
- /packages/retrieval builds and has stable exported interfaces
- retrieveContext(input) returns a valid ContextBundle
- context bundle is runtime-validated against contracts
- changed symbols are detected from PR diffs
- same-file context is always included for changed source
- direct callers/callees are included when graph data exists
- related tests are included through at least path conventions
- semantic vector search works through pgvector
- lexical search works through Postgres full-text search
- repo rules appear when relevant
- duplicate snippets are merged
- final context respects token budget
- retrieval trace records why items were included
- review worker can call retrieval engine without knowing DB internals
- dashboard can inspect selected context items and warnings
- fixture tests cover added/modified/deleted/renamed file cases
```

---

## 43. Example end-to-end retrieval

### Input PR

```text
PR title:
  Harden session cookie validation

Changed files:
  src/api/login.ts
  src/auth/session.ts
  src/auth/session.test.ts
```

### Changed symbols

```text
loginHandler
createSessionCookie
validateSession
```

### Query hints

```text
risk tags:
  auth
  security
  cookie
  token

lexical terms:
  "session"
  "Set-Cookie"
  "httpOnly"
  "sameSite"
  "expiresAt"

semantic query:
  "auth session cookie validation expiration sameSite httpOnly"
```

### Retrieved context

```text
diff:
  changed hunks in login.ts and session.ts

changed_symbol:
  full createSessionCookie implementation
  full validateSession implementation

same_file:
  parseSessionCookie helper
  SESSION_COOKIE_NAME constant

direct_caller:
  authMiddleware that calls validateSession
  logoutHandler that clears session cookie

direct_callee:
  signSessionToken
  verifySessionToken

related_test:
  session.test.ts
  auth-middleware.test.ts

semantic_match:
  previous csrf cookie validation pattern
  password reset token expiration pattern

lexical_match:
  usages of "Set-Cookie"
  usages of "sameSite"

repo_rule:
  "Session cookies must use httpOnly, secure, and sameSite."

memory_fact:
  "SessionToken verifies signature but not expiration; expiration is checked by validateSession."
```

### Packed ContextBundle

```text
estimated tokens: 19,450
items: 37
warnings: []
```

The review engine now has enough context to catch:

```text
- missing expiration validation
- cookie missing secure flag
- tests not covering expired token behavior
- API route caller breakage
```

---

## 44. Future upgrades

### 44.1 Model-based reranker

After deterministic ranking, optionally ask a cheap model to rerank candidates.

Input:

```text
PR summary
candidate titles/reasons only
no full code initially
```

Output:

```text
top candidate IDs
```

Use only after deterministic retrieval is working.

### 44.2 Hybrid search with Qdrant

Move semantic/lexical fusion into Qdrant later:

```text
dense vector
sparse vector
payload filters
server-side fusion
```

This is useful when:

```text
pgvector retrieval gets slow
repos are large
hybrid retrieval quality matters
Postgres vector load interferes with app DB
```

### 44.3 Incremental retrieval cache

Cache partial retrieval outputs by:

```text
changed symbol content hash
file content hash
query plan hash
```

Useful for repeated PR synchronize events.

### 44.4 Cross-repo retrieval

For monorepos and dependency graphs across repos:

```text
org-level shared packages
SDK usage examples
internal platform patterns
```

This requires strict access control and should not be MVP.

### 44.5 Prior findings retrieval

Retrieve prior findings for similar code changes:

```text
same rule
same file
same symbol
same risk tag
similar patch
```

Useful for consistency and learning.

---

## 45. References

Useful external references for implementation decisions:

- pgvector supports vector similarity search in Postgres, including exact search and approximate indexes such as HNSW and IVFFlat: <https://github.com/pgvector/pgvector>
- PostgreSQL full-text search uses `tsvector` and `tsquery` types for searchable document representation and queries: <https://www.postgresql.org/docs/current/datatype-textsearch.html>
- PostgreSQL text-search functions such as `to_tsvector`, `tsquery`, and ranking functions are documented here: <https://www.postgresql.org/docs/current/textsearch-controls.html>
- PostgreSQL `pg_trgm` provides trigram-based similarity functions and operators: <https://www.postgresql.org/docs/current/pgtrgm.html>
- Qdrant supports hybrid and multi-stage queries with dense and sparse retrieval patterns: <https://qdrant.tech/documentation/search/hybrid-queries/>
- Reciprocal Rank Fusion was introduced by Cormack, Clarke, and Büttcher in SIGIR 2009: <https://dl.acm.org/doi/10.1145/1571941.1572114>
