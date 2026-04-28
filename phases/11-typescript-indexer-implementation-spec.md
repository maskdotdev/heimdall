# #11 TypeScript Indexer Implementation — Implementation Spec

## Status

Proposed implementation spec for the first real code indexer implementation.

This document describes how to implement the initial TypeScript-based indexer that consumes a checked-out repository workspace and emits the artifact contract from **#10 Index Artifact Schema**.

The goal is not to build the final fastest indexer. The goal is to build a correct, deterministic, observable, replaceable indexer that is good enough to power retrieval and PR review while preserving the ability to replace it with a Rust, Go, language-server-backed, or remote indexer later.

The guiding rule:

```text
The TypeScript indexer is an artifact producer.
It does not own storage, embeddings, retrieval, review, publishing, billing, or GitHub concerns.
```

---

## 1. Purpose

The TypeScript indexer turns this:

```text
Repo workspace at exact commit SHA
```

into this:

```text
index-manifest.json
records.jsonl
```

Those artifacts are then validated and imported by the importer.

The flow is:

```text
repo-sync / workspace-manager
        |
        v
workspace path at exact commit
        |
        v
indexer-driver
        |
        v
TypeScript indexer implementation
        |
        v
Index artifact
        |
        v
index-importer
        |
        v
Postgres / pgvector / retrieval
```

The TypeScript indexer should produce normalized records for:

```text
- files
- symbols
- chunks
- import/dependency edges
- basic call/reference edges
- diagnostics
- dependency manifests
- optional route/test mappings when cheap and reliable
```

---

## 2. Non-goals

The TypeScript indexer does **not** implement:

```text
- repository cloning
- GitHub API calls
- Postgres writes
- embedding generation
- vector search
- review logic
- LLM calls
- issue/comment publishing
- billing
- user-facing API routes
- dashboard rendering
- package install
- arbitrary repo command execution
```

It should not run:

```text
npm install
pnpm install
bun install
pytest
eslint
tsc
mypy
```

Those belong to the static-analysis and sandbox-execution sections later.

The indexer may read project metadata files such as:

```text
package.json
pnpm-lock.yaml
tsconfig.json
pyproject.toml
requirements.txt
```

but it should not execute code or install dependencies.

---

## 3. Primary design constraints

The implementation should optimize for:

```text
1. Determinism
2. Replaceability
3. Path safety
4. Good-enough code understanding
5. Low latency on normal repos
6. Predictable memory usage
7. Useful diagnostics
8. Runtime validation
9. Fixture-driven tests
10. Clear migration path to a faster indexer
```

The implementation should not optimize for:

```text
- perfect semantic analysis
- full type resolution
- exact call graph completeness
- every programming language
- parsing generated or vendored files
- executing repository code
- producing embeddings
- minimizing JSONL size at the expense of debuggability
```

---

## 4. Package layout

Add:

```text
/packages/indexer-ts
/apps/indexer-cli
```

Recommended layout:

```text
/packages/indexer-ts
  package.json
  tsconfig.json
  src/
    index.ts
    run-indexer.ts
    config.ts
    types.ts
    errors.ts
    stats.ts

    discovery/
      discover-files.ts
      git-ls-files.ts
      fs-walk.ts
      ignore-rules.ts
      language-detection.ts
      generated-detection.ts
      binary-detection.ts
      symlink-policy.ts

    content/
      read-file.ts
      normalize-text.ts
      line-index.ts
      hashing.ts
      ranges.ts
      path-normalization.ts

    parsers/
      parser-adapter.ts
      tree-sitter-native-adapter.ts
      tree-sitter-wasm-adapter.ts
      parser-registry.ts
      query-runner.ts

    languages/
      typescript/
        index.ts
        grammar.ts
        queries.ts
        extract-symbols.ts
        extract-imports.ts
        extract-exports.ts
        extract-calls.ts
        extract-routes.ts
        signatures.ts
      javascript/
        index.ts
      python/
        index.ts
        queries.ts
        extract-symbols.ts
        extract-imports.ts
        extract-calls.ts
        signatures.ts
      json/
        index.ts
        extract-dependencies.ts
      text/
        index.ts

    extraction/
      extracted-file.ts
      extracted-symbol.ts
      extracted-edge.ts
      extracted-diagnostic.ts
      resolve-symbols.ts
      resolve-imports.ts
      resolve-calls.ts
      module-resolver.ts

    chunking/
      chunker.ts
      symbol-chunker.ts
      file-chunker.ts
      dependency-chunker.ts
      chunk-budget.ts

    artifact/
      artifact-emitter.ts
      manifest-builder.ts
      record-sort.ts
      artifact-stats.ts

    cli/
      run.ts
      validate.ts
      print-stats.ts
      inspect-file.ts

  fixtures/
    repos/
      ts-basic/
      ts-react/
      ts-node-api/
      js-commonjs/
      py-basic/
      mixed-monorepo/
      generated-files/
      large-files/
      symlink-outside/
    expected/
      ...
  test/
    ...

/apps/indexer-cli
  package.json
  tsconfig.json
  src/
    main.ts
```

The CLI can be thin:

```text
/apps/indexer-cli
  -> imports @repo/indexer-ts
  -> parses request.json / CLI args
  -> invokes runTypeScriptIndexer
  -> exits with clear code
```

This preserves the boundary from **#9 Indexer Boundary** while letting the implementation live in a package.

---

## 5. Dependencies

Recommended runtime dependencies:

```text
@repo/contracts
@repo/index-schema
@sinclair/typebox
ajv
fast-glob or tiny-glob, optional fallback only
ignore or minimatch/picomatch
commander or cac, optional CLI parsing
p-limit, optional concurrency limiter
tree-sitter
```

Recommended language grammars:

```text
tree-sitter-typescript
tree-sitter-javascript
tree-sitter-python
```

Recommended dev dependencies:

```text
vitest
tsx, if Node fallback is needed
@types/node
```

### Parser dependency note

The indexer should hide parser implementation behind a `ParserAdapter`.

Tree-sitter is the recommended base because it can build concrete syntax trees for source files and supports query patterns over syntax trees. The implementation should use Tree-sitter queries for stable extraction rules where practical.

There are two viable parser adapter strategies:

```text
Native adapter:
  faster, usually best for production if compatible with runtime

WASM adapter:
  easier isolation/runtime compatibility, potentially slower
```

Do not let either adapter leak into extraction or artifact types.

---

## 6. Runtime recommendation

The indexer should be callable as a CLI process regardless of implementation language.

MVP:

```text
worker process
  -> indexer-driver CLI driver
  -> apps/indexer-cli
  -> @repo/indexer-ts
  -> artifact dir
```

Suggested runtime options:

```text
Option A:
  Bun runs apps/indexer-cli

Option B:
  Node + tsx runs apps/indexer-cli

Option C:
  Compiled JS runs under Node or Bun
```

The worker should not care.

The only required contract is:

```text
Input:
  request.json or equivalent CLI flags

Output:
  index-manifest.json
  records.jsonl
```

Recommended CLI command:

```bash
indexer-cli run \
  --request /tmp/index-request.json \
  --out /tmp/index-artifact
```

Later, this command can point to:

```bash
indexer-rs run --request /tmp/index-request.json --out /tmp/index-artifact
```

without changing importer, retrieval, review, or publishing.

---

## 7. Core interfaces

The TypeScript indexer package should expose a single high-level function:

```ts
export async function runTypeScriptIndexer(
  request: IndexRequest,
  options?: RunTypeScriptIndexerOptions,
): Promise<IndexResult>;
```

Where `IndexRequest` and `IndexResult` should come from the boundary contracts defined in **#9** and **#10**.

Recommended internal shape:

```ts
export type RunTypeScriptIndexerOptions = {
  now?: () => Date;
  logger?: IndexerLogger;
  parserAdapter?: ParserAdapter;
  fileDiscovery?: FileDiscovery;
  artifactEmitter?: ArtifactEmitter;
  abortSignal?: AbortSignal;
};
```

Internal pipeline:

```ts
export async function runTypeScriptIndexer(
  request: IndexRequest,
  options: RunTypeScriptIndexerOptions = {},
): Promise<IndexResult> {
  const ctx = createIndexingContext(request, options);

  const files = await discoverIndexableFiles(ctx);
  const extracted = await extractFiles(ctx, files);
  const resolved = await resolveRelationships(ctx, extracted);
  const chunks = await createChunks(ctx, resolved);

  const artifact = await emitArtifact(ctx, {
    files: resolved.files,
    symbols: resolved.symbols,
    edges: resolved.edges,
    chunks,
    diagnostics: resolved.diagnostics,
    dependencies: resolved.dependencies,
    routes: resolved.routes,
    testMappings: resolved.testMappings,
  });

  return artifact;
}
```

Important:

```text
Only runTypeScriptIndexer is public.
Most internals stay private to the package.
```

---

## 8. Input request contract

The indexer receives a workspace path at an exact commit.

Recommended request shape:

```ts
export type IndexRequest = {
  schemaVersion: "index_request.v1";
  requestId: string;
  repoId: string;
  repositoryProvider: "github" | "gitlab" | "bitbucket";
  repositoryFullName: string;
  commitSha: string;
  workspacePath: string;
  outputPath: string;
  defaultBranch?: string;
  previousIndexId?: string;
  languages?: SupportedLanguage[];
  options: IndexerOptions;
};
```

Recommended options:

```ts
export type IndexerOptions = {
  includeTests: boolean;
  includeGeneratedFiles: boolean;
  includeVendoredFiles: boolean;
  includeDependencies: boolean;
  includeRoutes: boolean;
  includeCallEdges: boolean;
  includeReferenceEdges: boolean;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxSymbolBytes: number;
  maxChunkBytes: number;
  maxChunkLines: number;
  fileConcurrency: number;
  parseTimeoutMsPerFile: number;
  totalTimeoutMs: number;
  ignoredPaths: string[];
  allowedExtensions?: string[];
  parserMode: "native" | "wasm" | "auto";
  extractionLevel: "minimal" | "standard" | "deep";
};
```

MVP defaults:

```ts
export const DEFAULT_INDEXER_OPTIONS = {
  includeTests: true,
  includeGeneratedFiles: false,
  includeVendoredFiles: false,
  includeDependencies: true,
  includeRoutes: true,
  includeCallEdges: true,
  includeReferenceEdges: false,
  maxFileBytes: 512_000,
  maxTotalBytes: 250_000_000,
  maxFiles: 25_000,
  maxSymbolBytes: 128_000,
  maxChunkBytes: 48_000,
  maxChunkLines: 500,
  fileConcurrency: 4,
  parseTimeoutMsPerFile: 5_000,
  totalTimeoutMs: 300_000,
  ignoredPaths: [],
  parserMode: "auto",
  extractionLevel: "standard",
} satisfies IndexerOptions;
```

These defaults are intentionally conservative. They should be configurable per worker deployment and per repository settings later.

---

## 9. Output artifact contract

The TypeScript indexer emits exactly:

```text
{outputPath}/index-manifest.json
{outputPath}/records.jsonl
```

Optional later:

```text
{outputPath}/records.jsonl.gz
{outputPath}/stats.json
{outputPath}/debug/
```

The required artifact must validate against **#10 Index Artifact Schema**.

Recommended `IndexResult`:

```ts
export type IndexResult = {
  schemaVersion: "index_result.v1";
  requestId: string;
  repoId: string;
  commitSha: string;
  artifactPath: string;
  manifestPath: string;
  recordsPath: string;
  manifestHash: string;
  recordsHash: string;
  startedAt: string;
  completedAt: string;
  stats: IndexerStats;
};
```

The indexer should validate its own artifact before returning, using the artifact validation helpers from `@repo/index-schema`.

---

## 10. High-level pipeline

Full pipeline:

```text
1. Parse request
2. Validate workspace path
3. Resolve output path
4. Initialize stats and manifest builder
5. Discover candidate files
6. Apply path/language/generated/vendored filters
7. Read and normalize files
8. Parse supported source files
9. Extract file records
10. Extract symbol records
11. Extract dependency/import/export records
12. Extract cheap relationship edges
13. Resolve imports and calls where possible
14. Generate chunks
15. Emit records in deterministic order
16. Emit manifest
17. Validate artifact
18. Return IndexResult
```

The pipeline should be deterministic:

```text
same request + same workspace + same indexer version
  -> same manifest metadata except timestamps/duration
  -> same records in same order
  -> same stable IDs
  -> same content hashes
```

---

## 11. Determinism rules

Implement these rules from day one:

```text
- Use lexicographic path ordering.
- Normalize paths to POSIX-style relative paths.
- Never emit absolute workspace paths in records.
- Normalize source text to LF for line/range calculations.
- Use stable IDs derived from repoId, commitSha, path, range, symbol kind, and content hash.
- Sort symbols by file path, start line, start column, kind, name.
- Sort edges by fromId, kind, toId, metadata hash.
- Sort chunks by file path, start line, start column, chunk kind.
- Sort diagnostics by file path, line, severity, code.
- Do not include nondeterministic object key order where hashes depend on JSON.
- Use canonical JSON serialization for artifact hashes if needed.
```

The indexer may include timings in the manifest, but record content should be deterministic.

---

## 12. Path safety

All paths emitted by the indexer must be repository-relative POSIX paths.

Valid examples:

```text
src/index.ts
packages/api/src/server.ts
pyproject.toml
```

Invalid examples:

```text
/src/index.ts
../outside.ts
C:\repo\src\index.ts
packages/api/../../secret.ts
```

Implement:

```ts
export function toRepoRelativePath(
  workspacePath: string,
  absolutePath: string,
): RepoPath;
```

Rules:

```text
- Resolve both paths with realpath if safe.
- Ensure file path remains inside workspace.
- Convert separators to `/`.
- Reject traversal.
- Reject empty path.
- Reject `.git` internals.
```

Symlink policy:

```text
MVP:
  skip symlinks and emit diagnostic

Later:
  allow symlink only if it resolves inside workspace and points to a regular file
```

Rationale: repositories can contain malicious or surprising paths. The indexer must not read outside the checked-out workspace.

---

## 13. File discovery

File discovery should prefer Git-tracked files.

Recommended strategy:

```text
1. Try `git ls-files -z` inside workspace.
2. If unavailable or fails, fallback to filesystem walk.
3. Normalize all paths.
4. Filter paths.
5. Sort paths lexicographically.
```

Why `git ls-files` first?

```text
- avoids untracked build artifacts
- avoids node_modules accidentally present in worktree
- respects the repository snapshot
- is usually faster than recursive walking
```

Implementation:

```ts
export interface FileDiscovery {
  discover(ctx: IndexingContext): Promise<DiscoveredFile[]>;
}
```

```ts
export type DiscoveredFile = {
  path: RepoPath;
  absolutePath: string;
  source: "git-ls-files" | "fs-walk";
  sizeBytes?: number;
  isSymlink?: boolean;
};
```

Fallback filesystem walk should skip obvious directories before stat/read:

```text
.git
.hg
.svn
node_modules
bower_components
vendor
dist
build
out
coverage
.next
.nuxt
.turbo
.cache
.parcel-cache
.vite
venv
.venv
__pycache__
target
bin
obj
.DS_Store
```

Do not rely only on this list. Also use size, extension, binary, generated, and settings filters.

---

## 14. Ignore rules

Combine ignore rules from multiple sources:

```text
1. Hardcoded safety exclusions
2. Repository settings ignoredPaths
3. IndexRequest ignoredPaths
4. Generated-file detection
5. Vendored-file detection
6. Language/extension allowlist
7. File-size limits
```

Do not use `.gitignore` as the primary source when using `git ls-files`, because `git ls-files` already returns tracked files. `.gitignore` mainly affects untracked files in fallback mode.

Recommended path matcher:

```ts
export interface PathFilter {
  shouldIndex(file: DiscoveredFile): FileDecision;
}
```

```ts
export type FileDecision =
  | { kind: "include" }
  | { kind: "skip"; reason: SkipReason; diagnosticCode: string };
```

Skip reasons:

```text
unsupported_language
ignored_path
generated_file
vendored_file
too_large
binary_file
symlink
unsafe_path
empty_file
max_files_exceeded
max_total_bytes_exceeded
```

Skipped files should usually emit `DiagnosticRecord` only when useful. Avoid flooding artifacts with diagnostics for every file in `node_modules` if fallback walking failed to skip it early.

---

## 15. Language detection

Use extension and filename heuristics.

MVP mapping:

```text
.ts      -> typescript
.tsx     -> tsx
.js      -> javascript
.jsx     -> jsx
.mjs     -> javascript
.cjs     -> javascript
.py      -> python
.json    -> json
```

Special files:

```text
package.json        -> json + dependency extraction
package-lock.json   -> dependency manifest, optional parse later
pnpm-lock.yaml      -> dependency manifest, optional parse later
yarn.lock           -> dependency manifest, optional parse later
tsconfig.json       -> json + config record/diagnostic metadata
pyproject.toml      -> dependency/config extraction later
requirements.txt    -> dependency extraction later
```

Recommended result:

```ts
export type DetectedLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "python"
  | "json"
  | "text"
  | "unknown";
```

The artifact schema may normalize `tsx`/`jsx` to language plus metadata:

```ts
language: "typescript",
metadata: { dialect: "tsx" }
```

or include dialect as its own language if #10 supports it. Choose one approach and keep it consistent.

---

## 16. Generated and vendored file detection

The indexer should skip generated and vendored files by default.

MVP generated-file heuristics:

```text
- path contains /generated/
- path contains /__generated__/
- path ends with .generated.ts, .generated.tsx, .generated.js, .generated.py
- path ends with .gen.ts, .gen.js, .pb.ts, .pb.go
- path ends with .d.ts and file is very large or from generated path
- first 4 KB contains common marker:
  - @generated
  - <auto-generated
  - Code generated by
  - THIS FILE IS AUTO-GENERATED
  - DO NOT EDIT
```

MVP vendored heuristics:

```text
- path starts with vendor/
- path contains /third_party/
- path contains /external/
- path contains /node_modules/
- path contains /.venv/
- path contains /site-packages/
```

Also consider `.gitattributes` linguist hints later:

```text
linguist-generated
linguist-vendored
linguist-language
```

MVP can include a lightweight `.gitattributes` parser or defer it. If deferred, document that path heuristics are used.

---

## 17. Binary and text handling

Implement safe text reading:

```ts
export async function readSourceFile(
  file: DiscoveredFile,
  options: ReadFileOptions,
): Promise<SourceFileContent | FileReadFailure>;
```

Rules:

```text
- stat file before reading
- reject directories and symlinks by default
- reject size over maxFileBytes
- read as Buffer
- detect binary files before UTF-8 decode
- reject invalid UTF-8 by default
- normalize CRLF/CR to LF for parsing and line ranges
- preserve original byte size and raw hash in metadata if useful
```

Binary detection MVP:

```text
- if buffer contains NUL byte in first 8 KB, treat as binary
- if extension is known binary asset, skip before reading fully
```

Known binary/static assets to skip:

```text
png jpg jpeg gif webp ico pdf zip gz tar tgz mp4 mp3 wav wasm so dylib dll exe jar class pyc
```

Do not emit source text for binary files.

---

## 18. Line index and ranges

Build a line index for each normalized source file.

```ts
export type LineIndex = {
  lineStarts: number[];
  getLineColumn(offset: number): { line: number; column: number };
  getOffset(line: number, column: number): number;
  sliceRange(range: TextRange): string;
};
```

Use 1-based line numbers in artifact records:

```ts
startLine: 1
endLine: 20
```

Columns should be 0-based or 1-based according to **#10**. Pick the contract standard and enforce it everywhere.

Recommended:

```text
line: 1-based
column: 0-based UTF-16 code unit offset, if using JS strings
```

But for line anchoring, line numbers matter more than columns.

If columns are ambiguous across Unicode encodings, keep columns as best-effort metadata and rely on line ranges.

---

## 19. Content hashing

Use SHA-256 and explicit namespaces.

Recommended helpers:

```ts
export function hashFileContent(normalizedText: string): Sha256;
export function hashSymbolContent(input: SymbolHashInput): Sha256;
export function hashChunkContent(text: string): Sha256;
export function stableId(namespace: string, parts: readonly string[]): string;
```

Hash namespaces:

```text
file-content.v1
symbol-content.v1
chunk-content.v1
file-id.v1
symbol-id.v1
chunk-id.v1
edge-id.v1
```

Stable file ID:

```ts
fileId = stableId("file-id.v1", [repoId, commitSha, path]);
```

Stable symbol ID:

```ts
symbolId = stableId("symbol-id.v1", [
  repoId,
  commitSha,
  path,
  kind,
  qualifiedName,
  String(startLine),
  contentHash,
]);
```

Stable chunk ID:

```ts
chunkId = stableId("chunk-id.v1", [
  repoId,
  commitSha,
  path,
  chunkKind,
  String(startLine),
  String(endLine),
  contentHash,
]);
```

Rationale:

```text
- IDs are deterministic.
- IDs do not depend on database sequences.
- Artifacts from different implementations can be compared.
- Importer can safely upsert records.
```

---

## 20. Parser adapter

Define a parser abstraction:

```ts
export interface ParserAdapter {
  name: string;
  version: string;
  supports(language: DetectedLanguage): boolean;
  parse(input: ParseInput): Promise<ParseResult>;
  dispose?(): Promise<void>;
}
```

```ts
export type ParseInput = {
  path: RepoPath;
  language: DetectedLanguage;
  text: string;
  abortSignal?: AbortSignal;
};

export type ParseResult = {
  path: RepoPath;
  language: DetectedLanguage;
  tree: unknown;
  parserName: string;
  parserVersion: string;
  hasSyntaxError: boolean;
  durationMs: number;
  diagnostics: ExtractedDiagnostic[];
};
```

The extraction layer should not know whether the tree came from native Tree-sitter, WASM Tree-sitter, or another parser.

But extraction functions may need a normalized tree node interface:

```ts
export interface SyntaxNodeView {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  child(index: number): SyntaxNodeView | undefined;
  namedChildren(): SyntaxNodeView[];
  childForFieldName(name: string): SyntaxNodeView | undefined;
}
```

Wrap third-party parser nodes rather than leaking them.

---

## 21. Query-based extraction

Use Tree-sitter queries where they are stable.

Tree-sitter query patterns allow matching nodes by syntax shape. The indexer should keep language queries in versioned files/modules so changes are testable.

Example TypeScript/JavaScript query categories:

```text
- function declarations
- class declarations
- method definitions
- interface declarations
- type aliases
- enum declarations
- variable declarators assigned to arrow/function expressions
- import declarations
- export declarations
- call expressions
- JSX component usage, optional
```

Example query module shape:

```ts
export const TYPESCRIPT_SYMBOL_QUERIES = {
  version: "typescript-symbol-queries.v1",
  patterns: `
    (function_declaration
      name: (identifier) @symbol.name) @symbol.function

    (class_declaration
      name: (type_identifier) @symbol.name) @symbol.class

    (method_definition
      name: (_) @symbol.name) @symbol.method

    (interface_declaration
      name: (type_identifier) @symbol.name) @symbol.interface

    (type_alias_declaration
      name: (type_identifier) @symbol.name) @symbol.type_alias

    (enum_declaration
      name: (identifier) @symbol.name) @symbol.enum
  `,
};
```

Do not rely only on query captures for all metadata. Often the extractor should inspect nearby children to determine:

```text
- exported
- default export
- async
- generator
- decorators
- parent class
- signature range
- body range
```

---

## 22. Extraction model

Extraction should produce intermediate records before converting to artifact records.

```ts
export type ExtractedFile = {
  path: RepoPath;
  language: DetectedLanguage;
  dialect?: string;
  fileId: string;
  sizeBytes: number;
  lineCount: number;
  contentHash: Sha256;
  rawContentHash?: Sha256;
  text: string;
  metadata: Record<string, unknown>;
};
```

```ts
export type ExtractedSymbol = {
  symbolId: string;
  fileId: string;
  path: RepoPath;
  language: DetectedLanguage;
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  signature?: string;
  docstring?: string;
  parentSymbolId?: string;
  contentHash: Sha256;
  metadata: Record<string, unknown>;
};
```

```ts
export type ExtractedEdge = {
  edgeId: string;
  kind: CodeEdgeKind;
  fromId: string;
  toId?: string;
  unresolvedTarget?: string;
  confidence: number;
  metadata: Record<string, unknown>;
};
```

```ts
export type ExtractedDiagnostic = {
  path?: RepoPath;
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  startLine?: number;
  endLine?: number;
  metadata?: Record<string, unknown>;
};
```

Convert these into **#10** artifact records only at emission time.

---

## 23. File records

Emit one `FileRecord` for each included source/config file.

File record should include:

```text
- fileId
- path
- language
- contentHash
- sizeBytes
- lineCount
- indexedAt or artifact-level timestamp only
- metadata
```

Metadata examples:

```json
{
  "dialect": "tsx",
  "rawContentHash": "sha256:...",
  "isTest": false,
  "isConfig": false,
  "isGenerated": false,
  "detectedBy": "extension",
  "parser": "tree-sitter-typescript"
}
```

For skipped files, usually emit diagnostics, not file records.

---

## 24. TypeScript and JavaScript symbol extraction

MVP symbol kinds for TS/JS:

```text
module
function
arrow_function
class
method
constructor
interface
type_alias
enum
variable
object_method
react_component
route_handler
```

Extract from:

```text
function_declaration
class_declaration
method_definition
interface_declaration
type_alias_declaration
enum_declaration
lexical_declaration / variable_declarator
export_statement
assignment_expression, limited CJS support
```

### Function declarations

Example:

```ts
export async function getUser(id: string): Promise<User> {
  ...
}
```

Emit:

```text
kind: function
name: getUser
qualifiedName: getUser
signature: export async function getUser(id: string): Promise<User>
metadata.exported: true
metadata.async: true
```

### Arrow function variables

Example:

```ts
export const getUser = async (id: string) => {
  ...
};
```

Emit:

```text
kind: function or arrow_function
name: getUser
qualifiedName: getUser
signature: export const getUser = async (id: string) => ...
metadata.exported: true
metadata.async: true
metadata.declarationKind: const
```

Recommended artifact kind:

```text
function
```

with:

```json
{ "functionSyntax": "arrow" }
```

This keeps retrieval simpler.

### Classes and methods

Example:

```ts
export class UserService {
  async updateEmail(userId: string, email: string) {
    ...
  }
}
```

Emit symbols:

```text
class UserService
method UserService.updateEmail
```

Method metadata:

```json
{
  "async": true,
  "visibility": "public",
  "static": false,
  "parentKind": "class",
  "parentName": "UserService"
}
```

### Interfaces and type aliases

Example:

```ts
export interface User {
  id: string;
  email: string;
}
```

Emit:

```text
kind: interface
name: User
```

These are important for retrieval, especially when PRs change API contracts.

### React component heuristic

A symbol can be tagged as a React component when:

```text
- name starts with uppercase
- function/arrow function returns JSX or contains JSX
- file extension is .tsx/.jsx
```

Metadata:

```json
{
  "frameworkHints": ["react"],
  "component": true
}
```

Do not overfit. This should be a hint, not a separate deeply semantic system.

### CommonJS support

MVP should detect obvious CJS exports:

```js
module.exports = router;
exports.handler = async function handler(req, res) {}
```

Emit export metadata when easy.

Do not attempt full CommonJS resolution in MVP.

---

## 25. Python symbol extraction

MVP symbol kinds for Python:

```text
module
function
class
method
variable
```

Extract from:

```text
function_definition
class_definition
decorated_definition
assignment, only top-level constants optionally
import_statement
import_from_statement
call
```

Function example:

```py
def validate_session(token: str) -> Session | None:
    ...
```

Emit:

```text
kind: function
name: validate_session
qualifiedName: validate_session
signature: def validate_session(token: str) -> Session | None
```

Class method example:

```py
class UserService:
    def update_email(self, user_id: str, email: str):
        ...
```

Emit:

```text
class UserService
method UserService.update_email
```

Decorator metadata:

```json
{
  "decorators": ["app.post", "router.get", "classmethod"]
}
```

Route handler hint:

```text
If decorator resembles app.get/post/put/delete/patch or router.get/post/etc., tag as route_handler and optionally emit RouteRecord.
```

---

## 26. JSON/config extraction

Parse JSON files safely with `JSON.parse` after size checks.

Important files:

```text
package.json
tsconfig.json
jsconfig.json
```

For `package.json`, emit dependency records for:

```text
dependencies
devDependencies
peerDependencies
optionalDependencies
```

Also emit metadata hints:

```json
{
  "packageManager": "pnpm",
  "scripts": {
    "test": "vitest",
    "lint": "biome check ."
  },
  "frameworkHints": ["next", "react", "elysia"]
}
```

Do not emit huge script values or secrets.

For `tsconfig.json`, emit config metadata:

```json
{
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  }
}
```

Use this later for module resolution.

---

## 27. Import/export extraction

For TS/JS extract imports:

```ts
import { foo } from "./foo";
import type { User } from "@/types";
import * as fs from "node:fs";
const express = require("express");
const mod = await import("./mod");
```

Emit intermediate import facts:

```ts
export type ImportFact = {
  fileId: string;
  path: RepoPath;
  source: string;
  kind: "esm" | "type-only" | "commonjs" | "dynamic";
  importedNames: string[];
  localNames: string[];
  startLine: number;
  metadata: Record<string, unknown>;
};
```

For Python:

```py
import os
import app.services.users as users
from app.auth import validate_session
```

Emit:

```ts
kind: "python-import" | "python-from-import"
source: "app.auth"
importedNames: ["validate_session"]
```

Resolver should attempt to map relative imports to files in the same repo.

MVP TypeScript module resolution:

```text
Relative imports:
  ./foo -> ./foo.ts, ./foo.tsx, ./foo.js, ./foo.jsx, ./foo/index.ts, ...

Basic alias imports:
  if tsconfig paths are parsed, support simple @/* -> src/*

External imports:
  node:fs, react, lodash -> dependency/external target metadata
```

MVP Python module resolution:

```text
Relative-ish project imports based on file path and repo root.
Best-effort only.
```

Emit `imports`/`references` edges where the artifact schema allows.

If the target cannot be resolved, emit metadata or diagnostic, but do not fail indexing.

---

## 28. Call extraction

Call graph extraction should be explicitly best-effort.

For TS/JS, extract:

```text
call_expression
new_expression
await expression wrapping call_expression
member_expression calls
```

Examples:

```ts
validateSession(token)
userService.updateEmail(id, email)
new UserService()
await fetchUser(id)
```

Intermediate call fact:

```ts
export type CallFact = {
  fromSymbolId?: string;
  fromFileId: string;
  calleeText: string;
  calleeName?: string;
  receiverText?: string;
  startLine: number;
  startColumn: number;
  confidence: number;
};
```

Resolution levels:

```text
Level 1:
  same-file named function/class references

Level 2:
  imported symbol references via explicit imports

Level 3:
  member calls with known class instances, optional later
```

MVP should implement Level 1 and simple Level 2.

For Python, extract:

```py
validate_session(token)
service.update_email(user_id, email)
UserService()
```

MVP should resolve same-file calls and simple imported functions when possible.

Do not claim high confidence for unresolved or ambiguous member calls.

Edge confidence guidance:

```text
1.00 exact same-file symbol match
0.90 explicit imported name to exported symbol
0.70 default import to module export heuristic
0.50 ambiguous member call
0.30 unresolved call fact, usually do not emit as edge
```

Only emit `calls` edges when confidence is at least `0.7` for MVP.

---

## 29. Reference/type extraction

Reference extraction is optional for MVP.

Useful references later:

```text
- TypeScript type annotations
- interface implementation
- class extends
- enum references
- Python base classes
```

MVP should extract cheap structural edges:

```text
extends
implements
```

Examples:

```ts
class AdminUser extends User implements Auditable {}
```

Emit edges:

```text
AdminUser -> User       kind: extends
AdminUser -> Auditable  kind: implements
```

Resolve only if target symbol exists in repo or imported symbols are clear.

Do not spend too much time building full type resolution in the TypeScript indexer. If full type analysis becomes necessary, use the TypeScript compiler API or language-server-based analyzer later.

---

## 30. Route extraction

Route extraction is optional but useful because PR reviewers often need framework context.

MVP TS/JS route heuristics:

```text
Elysia:
  new Elysia().get("/path", handler)
  app.get("/path", handler)
  app.post("/path", handler)

Express/Fastify-like:
  router.get("/path", handler)
  app.post("/path", handler)

Next.js app router:
  app/**/route.ts exports GET/POST/PUT/PATCH/DELETE

Next.js pages router:
  pages/api/**
```

MVP Python route heuristics:

```text
FastAPI/Flask-like decorators:
  @app.get("/path")
  @router.post("/path")
```

Emit `RouteRecord` only when path and method are clear.

Metadata:

```json
{
  "framework": "elysia",
  "method": "GET",
  "path": "/users/:id",
  "handlerSymbolId": "sym_...",
  "confidence": 0.85
}
```

Route extraction should never fail the whole indexer.

---

## 31. Test detection and test mappings

Detect test files using path/name heuristics:

```text
*.test.ts
*.spec.ts
*.test.tsx
*.spec.tsx
*.test.js
*.spec.js
__tests__/**
test/**
tests/**
*.test.py
*_test.py
test_*.py
```

File metadata:

```json
{ "isTest": true }
```

Optional `TestMappingRecord` heuristics:

```text
src/foo.ts -> src/foo.test.ts
src/foo.ts -> test/foo.test.ts
app/services/user.py -> tests/services/test_user.py
```

This is useful for retrieval:

```text
changed symbol -> related tests
```

MVP should emit file `isTest` metadata and optional simple test mappings. Deep test coverage mapping can wait.

---

## 32. Dependency extraction

Dependency records should be emitted for files like:

```text
package.json
pyproject.toml
requirements.txt
```

MVP dependency extraction:

```text
package.json only
```

For each dependency:

```ts
export type ExtractedDependency = {
  name: string;
  versionRange: string;
  dependencyKind: "runtime" | "dev" | "peer" | "optional";
  manifestPath: RepoPath;
  ecosystem: "npm" | "python";
};
```

Later:

```text
pnpm-lock.yaml
yarn.lock
package-lock.json
pyproject.toml
poetry.lock
requirements.txt
```

Dependency records are useful for security/config/framework retrieval but should not dominate indexing effort.

---

## 33. Chunk generation

Chunking should be symbol-first.

Chunk kinds:

```text
symbol
file_section
file_summary_input
dependency_manifest
config
```

MVP chunking policy:

```text
1. For each symbol with body <= maxChunkBytes and line count <= maxChunkLines:
   emit one symbol chunk.

2. For large symbols:
   split by child syntax nodes if possible, else line windows.

3. For files with no extracted symbols:
   emit file_section chunks.

4. For package/config files:
   emit config/dependency chunks with trimmed text.

5. Do not chunk skipped/generated/binary files.
```

Symbol chunk text should be exact source text for the symbol range, normalized to LF.

Recommended chunk metadata:

```json
{
  "chunkKind": "symbol",
  "symbolKind": "function",
  "symbolName": "validateSession",
  "qualifiedName": "validateSession",
  "language": "typescript",
  "isTest": false
}
```

Should chunks include enriched headers?

Recommended:

```text
Artifact chunk text:
  exact source text only

Embedding pipeline:
  may build enriched embedding text from chunk text + metadata
```

This keeps artifact records grounded and avoids conflating indexing with embedding strategy.

---

## 34. Chunk budget

Default chunk limits:

```text
maxChunkBytes: 48 KB
maxChunkLines: 500
largeSymbolSplitLines: 200
largeFileWindowLines: 200
overlapLines: 20
```

Fallback line-window chunking:

```text
lines 1-200
lines 181-380
lines 361-560
```

Do not overuse overlap. Overlap increases embedding cost.

For code review retrieval, symbol chunks are usually more valuable than arbitrary windows.

---

## 35. Record emission order

Emit records in deterministic groups:

```text
1. file records
2. dependency records
3. symbol records
4. edge records
5. chunk records
6. route records
7. test mapping records
8. diagnostic records
```

Within each group, sort deterministically.

Rationale:

```text
- Easier artifact diffing
- Easier snapshot tests
- More stable hashes
- Easier manual inspection
```

Do not interleave records based on async completion order.

---

## 36. Artifact emitter

The artifact emitter converts extracted intermediate objects into **#10** records.

Interface:

```ts
export interface ArtifactEmitter {
  emit(input: EmitArtifactInput): Promise<IndexResult>;
}
```

Implementation responsibilities:

```text
- create output directory safely
- write records.jsonl.tmp
- write index-manifest.json.tmp
- fsync or durable-enough rename if needed
- validate artifact
- compute artifact hashes
- rename temp files atomically
- return IndexResult
```

Recommended temp layout:

```text
{outputPath}/.tmp-{requestId}/records.jsonl
{outputPath}/.tmp-{requestId}/index-manifest.json
```

Then atomically rename into final output path.

If the output path already exists:

```text
- fail by default
- allow overwrite only when request explicitly permits it
```

---

## 37. Manifest contents

The manifest should include:

```text
schemaVersion
artifactKind
repoId
commitSha
repositoryFullName
indexerName
indexerVersion
indexerRuntime
indexerConfigHash
parserVersions
queryVersions
chunkerVersion
generatedAt
recordCounts
fileCounts
languageCounts
skipCounts
hashes
features
```

Example:

```json
{
  "schemaVersion": "index_artifact_manifest.v1",
  "artifactKind": "code_index",
  "repoId": "repo_123",
  "commitSha": "abc123",
  "indexerName": "@repo/indexer-ts",
  "indexerVersion": "0.1.0",
  "indexerRuntime": "bun-1.2.x",
  "chunkerVersion": "symbol-chunker.v1",
  "features": [
    "files",
    "symbols",
    "chunks",
    "imports",
    "calls-basic",
    "dependencies-package-json"
  ],
  "recordCounts": {
    "file": 420,
    "symbol": 2300,
    "edge": 4100,
    "chunk": 2600,
    "diagnostic": 8
  }
}
```

The exact schema comes from **#10**.

---

## 38. Diagnostics

Diagnostics should be useful but not noisy.

Diagnostic categories:

```text
file_skipped
parse_error
syntax_error
unsupported_language
unsafe_path
too_large
binary_file
generated_file
vendored_file
import_unresolved
symbol_extraction_warning
chunking_warning
artifact_validation_error
```

Severity guidance:

```text
info:
  normal skips, unsupported language, generated file

warning:
  parse error in a supported source file, unresolved import if many are unresolved

error:
  artifact validation failure, unsafe path, workspace invalid
```

Do not emit one diagnostic per expected skipped file in huge directories.

Useful diagnostic metadata:

```json
{
  "sizeBytes": 1024000,
  "maxFileBytes": 512000,
  "language": "typescript",
  "parser": "tree-sitter-typescript"
}
```

Diagnostics should be included in artifact records so the dashboard/internal tooling can explain indexing behavior.

---

## 39. Error model

Use explicit error classes:

```ts
export class IndexerError extends Error {
  code: string;
  severity: "fatal" | "recoverable";
  metadata?: Record<string, unknown>;
}

export class WorkspaceValidationError extends IndexerError {}
export class FileDiscoveryError extends IndexerError {}
export class ParserInitializationError extends IndexerError {}
export class ArtifactEmissionError extends IndexerError {}
export class ArtifactValidationError extends IndexerError {}
```

Fatal errors:

```text
- workspace path invalid
- output path invalid
- parser registry cannot initialize any requested language
- artifact cannot be written
- artifact fails validation
- request exceeds hard timeout
```

Recoverable per-file errors:

```text
- parse error
- unsupported language
- file too large
- invalid UTF-8
- unresolved import
- symbol extraction failure for one file
```

Recoverable errors should become diagnostics. Fatal errors should fail the indexer run.

---

## 40. Workspace validation

Before discovery:

```ts
validateWorkspace(request.workspacePath)
validateOutputPath(request.outputPath)
```

Rules:

```text
- workspacePath exists
- workspacePath is a directory
- workspacePath is not `/`
- workspacePath is not user home
- workspacePath is not inside outputPath
- outputPath is empty or creatable
- outputPath is not inside workspace source tree unless explicitly allowed
```

The indexer should never delete arbitrary paths. Cleanup belongs to workspace manager and indexer-driver temp output management.

---

## 41. Security model

The TypeScript indexer reads files and parses text. It must not execute repository code.

Security rules:

```text
- no dependency install
- no running repo scripts
- no evaluating config files with `require`
- no loading tsconfig via dynamic import
- no loading eslint/webpack/vite config as code
- no network access required
- no env secrets passed to parser logic
- no absolute paths in artifacts
- no credentials in diagnostics/logs
- no reading outside workspace
- skip symlinks by default
```

When reading JSON:

```text
use JSON.parse on text
never require(packageJsonPath)
```

When reading TOML/YAML later:

```text
use parser libraries only
never execute code
```

---

## 42. Observability and stats

Collect stats for every run:

```ts
export type IndexerStats = {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  discoveredFileCount: number;
  indexedFileCount: number;
  skippedFileCount: number;
  totalBytesRead: number;
  languageCounts: Record<string, number>;
  skipCounts: Record<string, number>;
  parseErrorCount: number;
  syntaxErrorCount: number;
  symbolCount: number;
  edgeCount: number;
  chunkCount: number;
  diagnosticCount: number;
  dependencyCount: number;
  routeCount: number;
  testMappingCount: number;
  phaseDurationsMs: Record<string, number>;
};
```

Phase timings:

```text
validate_request
discover_files
read_files
parse_files
extract_symbols
resolve_relationships
chunk
emit_artifact
validate_artifact
```

Logs should include:

```text
requestId
repoId
commitSha
phase
path, only repo-relative
language
counts
duration
```

Do not log file contents.

---

## 43. Performance design

The indexer should be performant without being overly complex.

MVP performance choices:

```text
- prefer git ls-files
- skip irrelevant directories early
- size check before read
- binary check before UTF-8 decode
- parse only supported source files
- extract only useful symbol kinds
- stream artifact writing
- use deterministic sorting after extraction
- cap file count/byte count
- collect stats for bottleneck discovery
```

Concurrency:

```text
- IO reading can be concurrent
- parsing is CPU-bound and may not benefit much from async concurrency
- use small concurrency, default 4
- make concurrency configurable
```

Avoid:

```text
- unbounded Promise.all over files
- storing entire ASTs after extraction
- expensive regex over huge files
- full type-checking in MVP
- lockfile deep parsing in MVP
```

Memory policy:

```text
- keep normalized text only while extracting/chunking that file
- keep extracted records and symbol indexes
- do not keep all parser trees in memory
- store chunk text because artifact needs it, but avoid duplicate copies where possible
```

For very large repos, a future implementation can use:

```text
- worker_threads
- streaming record generation with two-pass resolution
- Rust parser binary
- partial/incremental indexing
```

---

## 44. Two-pass extraction and resolution

Recommended implementation:

```text
Pass 1: per-file extraction
  - file records
  - symbol records
  - import facts
  - call facts
  - dependency facts
  - route hints
  - raw chunks or chunk inputs

Pass 2: repository-level resolution
  - build export index
  - build path/module index
  - resolve imports
  - resolve same-file calls
  - resolve imported calls
  - emit edges
  - produce test mappings
```

Indexes:

```ts
export type RepositoryExtractionIndex = {
  filesByPath: Map<RepoPath, ExtractedFile>;
  symbolsById: Map<string, ExtractedSymbol>;
  symbolsByFile: Map<string, ExtractedSymbol[]>;
  topLevelSymbolsByName: Map<string, ExtractedSymbol[]>;
  exportedSymbolsByFileAndName: Map<string, Map<string, ExtractedSymbol>>;
  defaultExportByFile: Map<string, ExtractedSymbol>;
  modulePathToFile: Map<string, ExtractedFile>;
};
```

Do not attempt a full compiler-level symbol table.

---

## 45. Module resolution details

### TypeScript/JavaScript relative resolution

For import source `./foo` from `src/bar.ts`, attempt:

```text
src/foo.ts
src/foo.tsx
src/foo.js
src/foo.jsx
src/foo.mjs
src/foo.cjs
src/foo/index.ts
src/foo/index.tsx
src/foo/index.js
src/foo/index.jsx
```

For import source with extension:

```text
./foo.ts -> exact path
```

For alias resolution:

```text
- parse nearest tsconfig.json/jsconfig.json
- support simple baseUrl
- support simple paths like @/* -> src/*
```

Do not implement every TypeScript module-resolution edge case in MVP.

### External packages

For:

```ts
import React from "react";
import { z } from "zod";
import fs from "node:fs";
```

Emit dependency/external metadata but not code edges to repo symbols.

### Python resolution

MVP:

```text
- map from app.auth import foo -> app/auth.py or app/auth/__init__.py
- map import app.auth -> app/auth.py or app/auth/__init__.py
```

Use repo root as the primary source root. Later use pyproject and package layout hints.

---

## 46. Signature extraction

Signatures are valuable retrieval hints.

For each symbol, derive a concise signature:

```text
- function declaration line up to body start
- class declaration line up to `{` or `:`
- interface/type alias declaration header
- Python def/class line including decorators optionally
```

Rules:

```text
- normalize whitespace
- limit length, default 500 chars
- do not include full body
- include decorators in metadata, not necessarily signature
```

Example TypeScript:

```text
export async function updateEmail(userId: string, email: string): Promise<User>
```

Example Python:

```text
def update_email(user_id: str, email: str) -> User
```

For overloaded TypeScript functions, MVP may capture the implementation signature only. Later can capture overload signatures in metadata.

---

## 47. Docstring/comment extraction

Optional but useful.

MVP:

```text
- TypeScript/JavaScript: JSDoc block immediately preceding symbol
- Python: first string literal inside function/class body
```

Docstring limits:

```text
maxDocstringChars: 2000
```

Do not include massive comment blocks.

Metadata:

```json
{
  "hasDocstring": true,
  "docstringHash": "sha256:..."
}
```

The symbol record can include the actual docstring if #10 allows it, otherwise put a trimmed version in metadata.

---

## 48. Parent/child symbols

Maintain parent relationships:

```text
class -> method
module -> top-level symbol
function -> nested function, optional
```

Recommended:

```text
- emit file/module as implicit container metadata but not necessarily a symbol
- set parentSymbolId for class methods
- set parentSymbolId for nested functions when extracted
```

Qualified names:

```text
UserService.updateEmail
outer.inner
```

Avoid overly clever names for anonymous functions.

Anonymous function handling:

```text
- if assigned to variable/property, use assigned name
- if passed inline callback, do not emit symbol unless extractionLevel=deep
```

---

## 49. Export metadata

Track exports because they help dependency retrieval.

Metadata fields:

```json
{
  "exported": true,
  "exportKind": "named",
  "defaultExport": false,
  "reExportedFrom": null
}
```

Export forms:

```ts
export function foo() {}
export const foo = () => {}
export default function foo() {}
export default class Foo {}
export { foo, bar };
export { foo as baz } from "./foo";
export * from "./foo";
```

MVP:

```text
- handle direct declarations
- handle export lists in same file
- record re-exports as import/export facts, but resolution can be basic
```

---

## 50. Framework hints

The indexer should collect lightweight hints for retrieval.

Examples:

```text
- package.json dependencies include elysia -> framework hint: elysia
- package.json dependencies include express -> framework hint: express
- package.json dependencies include next -> framework hint: nextjs
- package.json dependencies include react -> framework hint: react
- Python imports fastapi -> framework hint: fastapi
```

Metadata can be placed on file, symbol, route, or manifest.

This helps later review passes ask better questions, such as:

```text
- Did an API handler validate input?
- Did a Next route export correct HTTP methods?
- Did a React component handle async state safely?
```

Do not make framework hints drive complex behavior in MVP.

---

## 51. CLI design

`apps/indexer-cli` should expose commands:

```bash
indexer-cli run --request request.json --out artifact-dir
indexer-cli validate --artifact artifact-dir
indexer-cli print-stats --artifact artifact-dir
indexer-cli inspect-file --request request.json --path src/foo.ts
```

MVP only requires:

```bash
indexer-cli run
indexer-cli validate
```

### `run`

```bash
indexer-cli run \
  --request /tmp/index-request.json \
  --out /tmp/index-artifact
```

Behavior:

```text
- read request JSON
- validate request schema
- override outputPath if --out supplied
- run indexer
- print IndexResult JSON to stdout
- print logs to stderr or structured logger
- exit 0 on success
```

### `validate`

```bash
indexer-cli validate --artifact /tmp/index-artifact
```

Behavior:

```text
- call @repo/index-schema validator
- print validation summary
- exit 0 if valid
- exit non-zero if invalid
```

### Exit codes

```text
0 success
1 generic failure
2 invalid request
3 workspace validation failure
4 parser initialization failure
5 artifact emission failure
6 artifact validation failure
7 timeout
```

The indexer-driver from #9 should map these to structured driver errors.

---

## 52. Request file protocol

Example request file:

```json
{
  "schemaVersion": "index_request.v1",
  "requestId": "idxreq_123",
  "repoId": "repo_123",
  "repositoryProvider": "github",
  "repositoryFullName": "acme/app",
  "commitSha": "abc123",
  "workspacePath": "/tmp/workspaces/repo_123_abc123",
  "outputPath": "/tmp/artifacts/idxreq_123",
  "defaultBranch": "main",
  "languages": ["typescript", "javascript", "python"],
  "options": {
    "includeTests": true,
    "includeGeneratedFiles": false,
    "includeVendoredFiles": false,
    "includeDependencies": true,
    "includeRoutes": true,
    "includeCallEdges": true,
    "includeReferenceEdges": false,
    "maxFileBytes": 512000,
    "maxTotalBytes": 250000000,
    "maxFiles": 25000,
    "maxSymbolBytes": 128000,
    "maxChunkBytes": 48000,
    "maxChunkLines": 500,
    "fileConcurrency": 4,
    "parseTimeoutMsPerFile": 5000,
    "totalTimeoutMs": 300000,
    "ignoredPaths": ["dist/**", "coverage/**"],
    "parserMode": "auto",
    "extractionLevel": "standard"
  }
}
```

The CLI should not require environment-specific data beyond optional parser/runtime settings.

---

## 53. Environment variables

Optional environment variables:

```text
INDEXER_LOG_LEVEL
INDEXER_PARSER_MODE
INDEXER_MAX_FILE_BYTES
INDEXER_TOTAL_TIMEOUT_MS
INDEXER_DEBUG_DIR
INDEXER_DISABLE_GIT_LS_FILES
```

Request options should win over environment variables where both are provided, unless the env var is a deployment-level hard cap.

Hard cap examples:

```text
INDEXER_HARD_MAX_FILE_BYTES
INDEXER_HARD_MAX_FILES
INDEXER_HARD_TOTAL_TIMEOUT_MS
```

Never pass GitHub tokens or customer secrets to the indexer environment if not needed.

---

## 54. Integration with indexer-driver

The `CliIndexerDriver` should:

```text
- create request.json
- create temp output dir
- spawn indexer-cli
- enforce timeout
- capture stdout/stderr
- parse IndexResult JSON from stdout
- validate artifact path
- call artifact validator
- return IndexResult
```

The TypeScript indexer should:

```text
- not know about BullMQ
- not know about Postgres
- not know about GitHub
- not know about workers
```

This keeps #11 removable.

---

## 55. Integration with index-importer

The importer consumes artifacts, not indexer internals.

Contract:

```text
indexer-ts emits artifact
indexer-driver validates artifact
index-importer imports artifact
embedding worker embeds chunks
retrieval queries normalized storage
```

The importer should not import from `@repo/indexer-ts`.

Allowed imports:

```text
@repo/index-schema
@repo/contracts
```

Forbidden imports:

```text
@repo/indexer-ts
```

This should be enforceable by dependency-direction rules.

---

## 56. Testing strategy

Tests should be fixture-heavy.

### Unit tests

```text
path normalization
language detection
binary detection
generated detection
content hashing
line index
signature extraction
chunking
module resolution
stable ID generation
```

### Language extraction tests

For each language fixture:

```text
- parse file
- extract symbols
- assert names/kinds/ranges/signatures
- assert imports/exports
- assert chunks
- assert diagnostics
```

### Artifact tests

```text
- run indexer on fixture repo
- validate artifact
- compare normalized records to golden snapshot
- assert deterministic rerun has same records hash
```

### CLI tests

```text
- valid request succeeds
- invalid request fails with exit code 2
- invalid workspace fails with exit code 3
- output path already exists behavior
- timeout behavior
```

### Security tests

```text
- symlink pointing outside workspace is skipped
- path traversal is rejected
- absolute paths are not emitted
- binary files are skipped
- generated files are skipped by default
- huge files are skipped
```

### Regression tests

Every extraction bug should get a fixture.

---

## 57. Fixture repositories

Create small fixture repos:

```text
fixtures/repos/ts-basic
  src/math.ts
  src/math.test.ts
  src/index.ts
  package.json
  tsconfig.json

fixtures/repos/ts-react
  src/components/UserCard.tsx
  src/hooks/useUser.ts
  package.json

fixtures/repos/ts-node-api
  src/server.ts
  src/routes/users.ts
  src/services/user-service.ts
  package.json

fixtures/repos/js-commonjs
  src/index.js
  src/router.js
  package.json

fixtures/repos/py-basic
  app/main.py
  app/auth.py
  tests/test_auth.py
  pyproject.toml

fixtures/repos/mixed-monorepo
  packages/api/src/index.ts
  packages/web/src/App.tsx
  services/worker/main.py
  package.json

fixtures/repos/generated-files
  src/generated/client.ts
  src/user.generated.ts

fixtures/repos/large-files
  src/huge.ts

fixtures/repos/symlink-outside
  safe.ts
  outside-link -> /tmp/outside-secret.ts
```

Golden expectations should focus on stable semantic facts, not exact incidental metadata.

Example assertion:

```text
- symbol validateSession exists
- validateSession has kind function
- validateSession starts at line 10
- auth.ts imports ./tokens
- auth.ts has chunk covering validateSession
- generated client is skipped
```

---

## 58. Golden artifact snapshots

Snapshot testing should avoid brittle timestamps.

Normalize before snapshot:

```text
- remove generatedAt
- remove durationMs
- sort object keys
- keep stable IDs
- keep hashes
```

For each fixture:

```text
expected/{fixture}/records.normalized.jsonl
expected/{fixture}/manifest.normalized.json
```

Also test deterministic hashing:

```text
run indexer twice
normalize artifacts
assert same records hash
```

---

## 59. TypeScript compiler API option

The MVP should primarily use Tree-sitter.

However, for TypeScript-specific deep extraction, later versions may use the TypeScript compiler API for:

```text
- better module resolution
- type-aware relationships
- symbols across files
- interface/type references
- project references
- tsconfig path handling
```

Do not add full compiler API dependency to the core path unless there is a clear need.

Potential V2 design:

```text
Tree-sitter:
  fast syntax extraction and chunks

TypeScript compiler API:
  optional enrichment pass for TS projects
```

Keep the enrichment pass optional and artifact-compatible.

---

## 60. Python parser limitations

Python extraction is useful but should remain conservative.

MVP should not attempt:

```text
- import resolution using virtualenvs
- dynamic import analysis
- type checking
- data flow analysis
- framework-specific dependency injection
```

MVP should extract:

```text
- functions
- classes
- methods
- decorators
- imports
- same-file calls
- route decorators
- test file metadata
```

This is enough to support retrieval and review context.

---

## 61. Handling syntax errors

Tree-sitter can often produce trees even when source contains syntax errors. The indexer should:

```text
- emit a parse/syntax diagnostic
- still extract reliable symbols if possible
- avoid emitting low-confidence edges from broken regions
- mark file metadata hasSyntaxError: true
```

Do not fail the whole repo because one file has a syntax error.

A PR may intentionally contain incomplete code; the review engine should know the index is partial.

---

## 62. Handling renames/deletes

The indexer indexes a single commit snapshot. It does not know PR rename/delete status.

Renames/deletes are handled by:

```text
PR snapshot/diff model
retrieval engine
review orchestrator
```

The indexer only emits records for files present in the workspace at `commitSha`.

---

## 63. Incremental indexing future

MVP can emit full artifacts for each commit.

Design for future incremental support:

```ts
previousIndexId?: string;
previousArtifactUri?: string;
changedPaths?: RepoPath[];
```

Future incremental behavior:

```text
- reuse records for unchanged file content hashes
- emit tombstones for deleted files
- emit changed records only
- importer composes full index version
```

Do not implement incremental mode in MVP unless necessary. The content-hash strategy and artifact schema should make it possible later.

---

## 64. Caching

The TypeScript indexer itself should have minimal persistent caching.

Recommended MVP:

```text
- no persistent cache inside indexer
- importer/DB handles content-hash reuse
- embedding pipeline handles embedding cache
```

Optional local cache later:

```text
workspace-local parse cache keyed by file content hash + parser version
```

But avoid cache complexity until indexing latency proves painful.

---

## 65. Validation levels

The indexer should call artifact validation with at least:

```text
Level 1: manifest JSON schema
Level 2: records JSON schema
Level 3: referential integrity within artifact
Level 4: path/range sanity
```

Examples:

```text
- chunk.fileId exists
- symbol.fileId exists
- edge.fromId exists
- edge.toId exists when present
- line ranges are positive
- startLine <= endLine
- file paths are safe
```

If validation fails, the run should fail fatally. Do not emit invalid artifacts.

---

## 66. Internal debug output

Optional debug mode:

```text
INDEXER_DEBUG_DIR=/tmp/indexer-debug
```

Can write:

```text
- discovered-files.json
- skipped-files.json
- extracted-symbols.json
- import-facts.json
- call-facts.json
- resolution-debug.json
```

Debug mode should be disabled by default. Debug files may include code-derived details, so treat them as sensitive artifacts.

---

## 67. Implementation sequence

### PR 1: package shell

Implement:

```text
/packages/indexer-ts package
/apps/indexer-cli package
runTypeScriptIndexer stub
CLI run command
request parsing
result printing
basic tests
```

Output can be an empty valid artifact for an empty repo fixture.

### PR 2: workspace/path/content utilities

Implement:

```text
workspace validation
path normalization
safe output path handling
file read utility
binary detection
text normalization
line index
hashing
stable IDs
```

### PR 3: file discovery and filters

Implement:

```text
git ls-files discovery
filesystem walk fallback
hardcoded exclusions
ignoredPaths
language detection
generated/vendored heuristics
size limits
skip diagnostics
```

### PR 4: artifact emitter

Implement:

```text
manifest builder
records writer
record sorting
artifact validation call
artifact hashes
stats
```

### PR 5: parser adapter

Implement:

```text
ParserAdapter interface
Tree-sitter native or WASM adapter
parser registry
parse diagnostics
syntax error detection
```

### PR 6: TypeScript/JavaScript file and symbol extraction

Implement:

```text
TS/JS queries
function/class/method/interface/type/enum extraction
signature extraction
parent relationships
export metadata basics
symbol chunks
fixture tests
```

### PR 7: TS/JS import/export/dependency extraction

Implement:

```text
import facts
export facts
package.json dependencies
tsconfig parsing basics
relative module resolution
imports edges
```

### PR 8: TS/JS call extraction

Implement:

```text
call facts
same-file call resolution
explicit import call resolution
calls edges
confidence thresholds
```

### PR 9: Python extraction

Implement:

```text
Python parser
function/class/method extraction
decorators
imports
same-file calls
Python chunks
fixture tests
```

### PR 10: chunking improvements

Implement:

```text
symbol-first chunker
large symbol splitting
file-section chunking
config/dependency chunks
chunk metadata
```

### PR 11: route and test hints

Implement:

```text
Elysia/Express/Fastify route hints
Next.js route hints
FastAPI/Flask decorator route hints
test file detection
simple test mappings
```

### PR 12: hardening and determinism

Implement:

```text
golden snapshots
determinism tests
security fixtures
large file tests
timeouts
concurrency controls
metrics/stats polish
```

### PR 13: worker integration

Implement:

```text
CliIndexerDriver integration
index worker calls CLI
artifact validation handoff
error mapping
observability
```

---

## 68. MVP cut

For the first usable version, implement:

```text
- CLI run command
- request validation
- workspace validation
- git ls-files discovery with filesystem fallback
- path normalization
- size/binary/generated filters
- language detection for TS/TSX/JS/JSX/Python/JSON
- Tree-sitter parser adapter
- TS/JS symbol extraction
- Python symbol extraction
- package.json dependency extraction
- basic imports extraction
- same-file call extraction
- symbol-first chunks
- file-section fallback chunks
- diagnostics
- manifest/stats
- records.jsonl emission
- artifact validation
- fixture tests
```

Defer:

```text
- full TypeScript compiler API analysis
- full cross-file call graph
- deep Python import resolution
- lockfile parsing
- static analysis execution
- incremental indexing
- persistent parser cache
- worker_threads parser pool
- complete framework-specific route extraction
- reference/type edge completeness
```

---

## 69. Definition of done

#11 is complete when:

```text
- @repo/indexer-ts builds cleanly
- apps/indexer-cli builds cleanly
- indexer-cli run accepts request.json and output dir
- indexer-cli emits valid index-manifest.json and records.jsonl
- artifact validates with @repo/index-schema
- TypeScript files produce file/symbol/chunk records
- JavaScript files produce file/symbol/chunk records
- Python files produce file/symbol/chunk records
- package.json emits dependency records
- imports produce basic edges/facts
- same-file calls produce calls edges where confidence is high
- generated/vendored/large/binary files are skipped safely
- no absolute paths appear in artifacts
- symlink-outside fixture is skipped/rejected
- deterministic fixture test passes across two runs
- CLI returns structured errors and useful exit codes
- indexer-driver can invoke the CLI without importing parser internals
- index-importer can consume artifacts without importing @repo/indexer-ts
```

---

## 70. Final architecture reminder

The TypeScript indexer is the first implementation, not the permanent architecture.

Keep this true:

```text
TypeScript indexer
  -> index artifact
  -> importer
  -> retrieval
  -> review engine
```

Never let this happen:

```text
review engine
  -> TypeScript parser internals
```

or this:

```text
index importer
  -> @repo/indexer-ts extraction types
```

or this:

```text
indexer
  -> Postgres directly
```

If the indexer becomes too slow, replace this:

```text
apps/indexer-cli -> @repo/indexer-ts
```

with this:

```text
apps/indexer-rs
```

while preserving:

```text
index-manifest.json
records.jsonl
```

That is the entire point of #9, #10, and #11 working together.

---

## 71. Reference notes

Useful implementation references:

```text
Tree-sitter overview:
  https://tree-sitter.github.io/

Tree-sitter parser usage:
  https://tree-sitter.github.io/tree-sitter/using-parsers/

Tree-sitter query syntax:
  https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html

Node bindings for Tree-sitter:
  https://github.com/tree-sitter/node-tree-sitter

TypeScript compiler API:
  https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API

GitHub Linguist generated/vendored hints:
  https://github.com/github-linguist/linguist/blob/main/docs/how-linguist-works.md
  https://docs.github.com/en/repositories/working-with-files/managing-files/customizing-how-changed-files-appear-on-github
```

These references are not contracts. The contracts are the schemas in `@repo/contracts` and `@repo/index-schema`.
