# #15 PR Snapshot and Diff Model — Implementation Spec

## 1. Purpose

This document defines the implementation plan for the **PR Snapshot and Diff Model** layer.

This layer turns provider-specific pull request data into stable, immutable, provider-neutral objects that the rest of the system can safely use for:

```text
- review orchestration
- context retrieval
- changed-symbol detection
- finding validation
- GitHub inline comment anchoring
- duplicate comment prevention
- replay/debug tooling
- dashboard diff inspection
```

The goal is to make pull request review deterministic:

```text
GitHub PR state at time T
  -> PullRequestSnapshot
  -> Raw unified diff artifact
  -> Parsed DiffModel
  -> LineAnchorIndex
  -> ChangeSet
  -> ReviewRun
```

The reviewer should never reason over a moving PR. It should reason over a pinned snapshot.

---

## 2. Why this section matters

This layer is easy to underestimate.

For a code review agent, the difference between a good and bad product is often not the model. It is whether the system can answer these questions accurately:

```text
What exactly changed?
Which commit was reviewed?
Is this line commentable on GitHub?
Should this comment target the old side or new side?
Is this line still present after a force-push?
Did we already comment on this finding?
Can we replay this review later?
```

A vague diff model creates downstream pain:

```text
- comments rejected by GitHub
- comments anchored to the wrong line
- duplicate comments after synchronize events
- findings on deleted or non-commentable lines
- reviews generated against stale PR state
- retrieval using the wrong base/head commit
- inability to debug why a comment was posted
```

This spec makes the PR snapshot and diff model a first-class system boundary.

---

## 3. Scope

### 3.1 In scope

Implement a provider-neutral PR snapshot/diff package that supports:

```text
- normalized PullRequestSnapshot construction
- raw unified diff artifact handling
- unified diff parsing
- diff hunk/line modeling
- changed file modeling
- changed line/range extraction
- line anchor indexing
- GitHub review comment anchor conversion
- line commentability validation
- file-level fallback targeting
- snapshot hashing
- diff hashing
- snapshot persistence helpers
- fixture and golden tests
```

### 3.2 Out of scope

This section does **not** implement:

```text
- GitHub authentication
- webhook ingestion
- repo cloning/fetching
- code indexing
- symbol extraction
- semantic retrieval
- LLM review passes
- publishing comments
- feedback/memory learning
```

Those pieces consume the snapshot/diff model but should not own it.

---

## 4. Recommended package layout

Add one package:

```text
/packages/pr-snapshot
```

Suggested internal layout:

```text
/packages/pr-snapshot
  package.json
  tsconfig.json
  src/
    index.ts

    snapshot/
      build-pull-request-snapshot.ts
      snapshot-hash.ts
      snapshot-status.ts
      snapshot-validation.ts
      snapshot-artifacts.ts

    diff/
      parse-unified-diff.ts
      diff-types.ts
      diff-hash.ts
      diff-stats.ts
      path-parser.ts
      hunk-parser.ts
      line-parser.ts
      no-newline-marker.ts

    anchors/
      anchor-index.ts
      github-anchor.ts
      commentability.ts
      multiline-ranges.ts
      finding-anchor.ts

    changes/
      change-set.ts
      changed-ranges.ts
      changed-blocks.ts
      changed-file-classification.ts
      patch-size.ts

    persistence/
      persist-pr-snapshot.ts
      load-pr-snapshot.ts
      artifact-refs.ts

    fixtures/
      index.ts

    test-support/
      make-diff.ts
      make-snapshot.ts
      assert-anchor.ts
      golden.ts

  test/
    parse-unified-diff.test.ts
    anchor-index.test.ts
    github-anchor.test.ts
    change-set.test.ts
    snapshot-hash.test.ts
    fixtures/
      added-file.diff
      deleted-file.diff
      modified-file.diff
      renamed-file.diff
      copied-file.diff
      binary-file.diff
      mode-change.diff
      no-newline.diff
      spaces-in-path.diff
      multiple-hunks.diff
      mixed-add-delete.diff
```

### 4.1 Dependencies

The package should depend on:

```text
@repo/contracts
@repo/config
@repo/observability
@repo/db               # only in persistence submodule, or avoid entirely if you want pure package boundaries
```

Avoid dependencies on:

```text
@repo/github
@repo/retrieval
@repo/review-engine
@repo/publisher
@repo/llm-gateway
```

The PR snapshot/diff model should be **provider-neutral**. GitHub-specific conversion logic is allowed only at the boundary where a generic anchor becomes a GitHub API payload.

---

## 5. Design principles

### 5.1 Snapshots are immutable

Every review run should reference a specific snapshot.

A snapshot is identified by:

```text
repo_id
provider
pull_request_number
base_sha
head_sha
merge_base_sha
raw_diff_hash
snapshot_hash
fetched_at
```

Once written, a snapshot should not be mutated except for operational metadata such as persistence status.

If the PR changes, create a new snapshot.

### 5.2 Raw diff is source-of-truth for anchoring

For GitHub publishing, the parsed diff should be derived from the same raw diff representation GitHub uses for PR review comments.

GitHub review comments are made on portions of the unified diff, and GitHub documentation explicitly distinguishes pull request review comments from issue comments and commit comments.

### 5.3 Use `line`/`side`, not deprecated-style `position`, for new GitHub comments

GitHub still documents `position`, but it also says the `position` parameter is closing down and recommends `line`, `side`, `start_line`, and `start_side` for comments, especially multiline comments.

Therefore:

```text
Primary GitHub anchor format:
  path
  commit_id
  line
  side
  start_line?
  start_side?
  subject_type?

Secondary/fallback format:
  position
```

The system can compute `position` for diagnostics and fallback, but publishing should prefer `line` and `side`.

### 5.4 Snapshot first, review second

The review worker should not fetch PR details lazily during review.

Preferred flow:

```text
fetch PR snapshot
store snapshot + raw diff
parse diff
build anchor index
retrieve context
run review
validate anchors
publish
```

### 5.5 Commentability is part of validation

A finding is not publishable unless it can be mapped to a valid target:

```text
inline line comment
file-level comment
summary-only finding
```

A finding without a valid anchor should not be passed to the publisher as if it were a line comment.

### 5.6 Preserve provider-specific evidence, expose provider-neutral contracts

Keep provider raw metadata available for debugging, but do not let it leak everywhere.

Example:

```ts
providerMetadata: {
  githubPullRequestNodeId: string;
  githubRepositoryNodeId: string;
  diffUrl?: string;
}
```

But core review logic should operate on:

```ts
PullRequestSnapshot
DiffModel
LineAnchorIndex
ChangeSet
```

### 5.7 Prefer summary-only mode for unsafe/ambiguous diffs

If the diff cannot be parsed or line anchors cannot be trusted, the system should still be able to produce a PR summary or high-level review, but it should avoid inline comments.

For unsafe or ambiguous anchors, fallback order is exact diff anchor, file-level finding, then summary-only. Nearest-line fallback is an explicit opt-in, never the default.

---

## 6. High-level flow

```text
Review job
  |
  v
GitHub adapter fetches PR metadata
  |
  v
GitHub adapter fetches changed files
  |
  v
GitHub adapter fetches raw PR diff
  |
  v
PR Snapshot Builder
  |
  +--> PullRequestSnapshot
  +--> raw-diff artifact
  +--> diff hash
  |
  v
Unified Diff Parser
  |
  v
DiffModel
  |
  v
LineAnchorIndex
  |
  v
ChangeSet
  |
  v
Review Orchestrator / Retrieval / Publisher
```

---

## 7. Data contracts

Most contracts should live in:

```text
/packages/contracts
```

This package should implement behavior around those contracts.

### 7.1 `PullRequestSnapshot`

```ts
export type PullRequestSnapshot = {
  schemaVersion: "pull_request_snapshot.v1";

  snapshotId: PrSnapshotId;
  snapshotHash: Sha256;

  provider: "github" | "gitlab" | "bitbucket";

  orgId: OrgId;
  repoId: RepoId;
  repositoryFullName: string;

  pullRequestId: PullRequestId;
  providerPullRequestId: string;
  providerPullRequestNodeId?: string;
  pullRequestNumber: number;

  title: string;
  body: string | null;
  authorLogin: string;
  authorId?: string;
  authorAssociation?: string;

  state: "open" | "closed" | "merged";
  draft: boolean;
  locked: boolean;

  baseRef: string;
  baseSha: GitSha;
  baseRepositoryFullName: string;

  headRef: string;
  headSha: GitSha;
  headRepositoryFullName: string;
  isFromFork: boolean;

  mergeBaseSha: GitSha | null;

  labels: PullRequestLabel[];
  assignees: ProviderUserRef[];
  requestedReviewers: ProviderUserRef[];
  requestedTeams: ProviderTeamRef[];

  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  closedAt: IsoDateTime | null;
  mergedAt: IsoDateTime | null;
  fetchedAt: IsoDateTime;

  changedFilesCount: number;
  additions: number;
  deletions: number;
  commitsCount: number;

  changedFiles: ChangedFile[];

  filesTruncated: boolean;
  filesTruncationReason?:
    | "provider_file_limit"
    | "provider_patch_limit"
    | "local_limit"
    | "unknown";

  rawDiff: ArtifactRef;
  rawDiffHash: Sha256;
  rawDiffBytes: number;

  parsedDiff?: ArtifactRef;
  parsedDiffHash?: Sha256;

  sourceWebhookEventId?: WebhookEventId;

  providerMetadata: Record<string, unknown>;
};
```

### 7.2 `ChangedFile`

This is the provider-neutral changed file summary. It is not the full parsed diff.

```ts
export type ChangedFile = {
  path: RepoPath;
  previousPath: RepoPath | null;

  status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "type_changed"
    | "unchanged";

  additions: number;
  deletions: number;
  changes: number;

  blobSha: GitSha | null;
  oldBlobSha?: GitSha | null;
  newBlobSha?: GitSha | null;

  patchHash?: Sha256;
  hasPatch: boolean;
  patchTruncated: boolean;

  isBinary: boolean;
  isSubmodule: boolean;
  isGenerated: boolean;
  isVendored: boolean;
  isLarge: boolean;

  oldMode?: string | null;
  newMode?: string | null;

  language?: SupportedLanguage | "unknown";

  providerMetadata?: Record<string, unknown>;
};
```

### 7.3 `DiffModel`

```ts
export type DiffModel = {
  schemaVersion: "diff_model.v1";

  provider: "github" | "gitlab" | "bitbucket" | "local_git";

  repoId: RepoId;
  pullRequestNumber?: number;

  baseSha: GitSha;
  headSha: GitSha;
  mergeBaseSha: GitSha | null;

  rawDiffHash: Sha256;
  diffHash: Sha256;
  parserVersion: string;

  files: DiffFile[];

  stats: DiffStats;
  warnings: DiffWarning[];

  parsedAt: IsoDateTime;
};
```

### 7.4 `DiffFile`

```ts
export type DiffFile = {
  fileIndex: number;

  oldPath: RepoPath | null;
  newPath: RepoPath | null;
  displayPath: RepoPath;

  status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "type_changed"
    | "binary"
    | "unknown";

  oldMode?: string | null;
  newMode?: string | null;

  oldBlobSha?: GitSha | null;
  newBlobSha?: GitSha | null;

  similarity?: number | null;
  dissimilarity?: number | null;

  isBinary: boolean;
  isSubmodule: boolean;

  extendedHeaders: DiffExtendedHeader[];
  hunks: DiffHunk[];

  additions: number;
  deletions: number;
  changes: number;

  rawHeaderStartLine: number;
  rawHeaderEndLine: number;

  warnings: DiffWarning[];
};
```

### 7.5 `DiffHunk`

```ts
export type DiffHunk = {
  hunkIndex: number;

  header: string;
  sectionHeader: string | null;

  oldStart: number;
  oldLines: number;

  newStart: number;
  newLines: number;

  rawStartLine: number;
  rawEndLine: number;

  lines: DiffLine[];
};
```

### 7.6 `DiffLine`

```ts
export type DiffLine = {
  hunkLineIndex: number;

  /** 1-based raw diff line number across the whole raw diff artifact. */
  rawDiffLine: number;

  /**
   * GitHub's legacy diff position concept:
   * number of lines down from the first @@ hunk header in this file,
   * increasing across hunks until the next file.
   */
  providerPosition: number | null;

  kind:
    | "context"
    | "added"
    | "deleted"
    | "no_newline_marker"
    | "metadata";

  side: "LEFT" | "RIGHT" | "BOTH" | null;

  oldLineNumber: number | null;
  newLineNumber: number | null;

  /** Content without the leading diff marker. */
  content: string;

  /** Full raw line including marker. */
  raw: string;

  isCommentable: boolean;
};
```

### 7.7 `LineAnchor`

A provider-neutral line target.

```ts
export type LineAnchor = {
  filePath: RepoPath;
  side: "LEFT" | "RIGHT";
  line: number;

  startLine?: number;
  startSide?: "LEFT" | "RIGHT";

  providerPosition?: number | null;

  hunkIndex: number;
  hunkLineIndex: number;

  kind: "added" | "deleted" | "context";

  rawDiffLine: number;
};
```

### 7.8 `FileAnchor`

Used when a line-specific target is unavailable but a file-level comment is still valid.

```ts
export type FileAnchor = {
  filePath: RepoPath;
  subjectType: "file";
  reason:
    | "binary_file"
    | "renamed_without_hunks"
    | "line_not_in_diff"
    | "large_or_truncated_patch"
    | "fallback";
};
```

### 7.9 `CommentTarget`

```ts
export type CommentTarget =
  | {
      type: "line";
      anchor: LineAnchor;
    }
  | {
      type: "range";
      anchor: LineAnchor;
      startLine: number;
      startSide: "LEFT" | "RIGHT";
    }
  | {
      type: "file";
      anchor: FileAnchor;
    }
  | {
      type: "summary";
      reason: string;
    };
```

### 7.10 `ChangeSet`

```ts
export type ChangeSet = {
  schemaVersion: "change_set.v1";

  repoId: RepoId;
  pullRequestNumber: number;
  baseSha: GitSha;
  headSha: GitSha;
  mergeBaseSha: GitSha | null;

  files: ChangedFileChangeSet[];

  totalAddedLines: number;
  totalDeletedLines: number;
  totalContextLines: number;

  changedPathSet: RepoPath[];
  deletedPathSet: RepoPath[];
  addedPathSet: RepoPath[];
  renamedPathPairs: Array<{
    oldPath: RepoPath;
    newPath: RepoPath;
  }>;

  createdAt: IsoDateTime;
};
```

```ts
export type ChangedFileChangeSet = {
  path: RepoPath;
  previousPath: RepoPath | null;
  status: DiffFile["status"];

  hunks: ChangedHunk[];
  changedRanges: ChangedRange[];
  addedRanges: LineRange[];
  deletedRanges: LineRange[];

  hasInlineCommentableLines: boolean;
  hasOnlyMetadataChanges: boolean;
  isBinary: boolean;
};
```

```ts
export type ChangedRange = {
  side: "LEFT" | "RIGHT";
  startLine: number;
  endLine: number;
  kind: "added" | "deleted" | "modified_block";
  hunkIndex: number;
};
```

---

## 8. Artifact strategy

### 8.1 Raw diff artifact

Store the raw diff artifact outside Postgres.

Recommended path:

```text
s3://review-artifacts/orgs/{orgId}/repos/{repoId}/prs/{prNumber}/snapshots/{snapshotId}/raw.diff
```

Metadata:

```ts
type RawDiffArtifactMetadata = {
  contentType: "text/x-diff";
  encoding: "utf-8";
  sha256: string;
  bytes: number;
  provider: "github";
  fetchedAt: string;
  baseSha: string;
  headSha: string;
};
```

### 8.2 Parsed diff artifact

Parsed diffs may become large. Store them as compressed JSON.

```text
s3://review-artifacts/orgs/{orgId}/repos/{repoId}/prs/{prNumber}/snapshots/{snapshotId}/diff-model.json.gz
```

### 8.3 Snapshot JSON artifact

Also store the normalized snapshot as an artifact.

```text
s3://review-artifacts/orgs/{orgId}/repos/{repoId}/prs/{prNumber}/snapshots/{snapshotId}/snapshot.json.gz
```

This makes review replay possible even if DB rows are compacted later.

---

## 9. Hashing rules

### 9.1 Raw diff hash

```text
rawDiffHash = sha256(raw diff bytes exactly as fetched)
```

Do not normalize line endings before hashing raw diff bytes.

### 9.2 Parsed diff hash

```text
parsedDiffHash = sha256(canonical_json(diffModelWithoutParsedAt))
```

Exclude volatile fields like `parsedAt`.

### 9.3 Snapshot hash

```text
snapshotHash = sha256(canonical_json(snapshotWithoutFetchedAtAndArtifactUris))
```

Exclude:

```text
- fetchedAt
- artifact presigned URLs
- trace IDs
- temporary storage paths
```

Include:

```text
- repoId
- PR number
- baseSha
- headSha
- mergeBaseSha
- changed files
- rawDiffHash
- title/body/labels/draft state
```

This allows deduping equivalent snapshots while still preserving multiple fetch attempts if needed.

---

## 10. GitHub fetch strategy

The GitHub adapter owns provider API calls, but this section defines what it must supply to the snapshot builder.

### 10.1 Required GitHub inputs

```ts
export type BuildPullRequestSnapshotInput = {
  orgId: OrgId;
  repoId: RepoId;
  installationId: ProviderInstallationId;

  provider: "github";
  repositoryFullName: string;
  owner: string;
  repo: string;
  pullRequestNumber: number;

  pr: GitHubPullRequestDetails;
  changedFiles: GitHubPullRequestFile[];
  rawDiff: string;

  mergeBaseSha?: GitSha | null;

  sourceWebhookEventId?: WebhookEventId;
  fetchedAt: IsoDateTime;
};
```

### 10.2 Pull request metadata

Fetch the pull request metadata from GitHub's pull request endpoint.

The snapshot needs:

```text
- title
- body
- author
- state
- draft
- locked
- labels via issue endpoint or webhook payload
- base ref and SHA
- head ref and SHA
- base repository
- head repository
- merge state where available
- additions/deletions/changed_files/commits
- created/updated/closed/merged timestamps
```

### 10.3 Changed files

Fetch changed files through the PR files endpoint with pagination.

Important provider limit:

```text
GitHub PR files responses include a maximum of 3000 files.
```

Use:

```text
per_page=100
page=1..N
```

If the endpoint indicates the PR exceeds the file limit or if fetched count is suspiciously truncated, mark:

```ts
filesTruncated = true;
filesTruncationReason = "provider_file_limit";
```

### 10.4 Raw PR diff

Fetch the raw PR diff by requesting the pull request endpoint with GitHub's diff media type.

The raw diff is needed because:

```text
- files API patches can be missing or truncated
- line anchoring depends on the PR diff
- parser should see the full unified diff, not isolated file snippets
- providerPosition can only be computed correctly across hunks within a file
```

### 10.5 Merge base SHA

GitHub PR metadata gives base/head SHAs, but not necessarily the exact merge base SHA needed for local diff reproduction.

Recommended strategy:

```text
1. Prefer local git merge-base after repo sync has fetched both SHAs.
2. If unavailable, store null initially.
3. Do not block snapshot creation on merge-base if raw GitHub diff exists.
4. Later review/index jobs can fill mergeBaseSha via local git and update a derived field if needed.
```

For local diff reproduction, use merge base semantics equivalent to:

```bash
git diff $(git merge-base <baseSha> <headSha>) <headSha>
```

or:

```bash
git diff <baseSha>...<headSha>
```

when operating in a local git repository.

### 10.6 Prefer GitHub raw diff for publishable anchors

Local git diffs are useful for fallback and debugging, but GitHub's own raw PR diff should be the primary anchor source for publishing GitHub review comments.

Reason:

```text
GitHub comment APIs validate line anchors against GitHub's PR diff representation.
```

---

## 11. Unified diff parser

### 11.1 Parser input

```ts
export type ParseUnifiedDiffInput = {
  repoId: RepoId;
  provider: "github" | "gitlab" | "bitbucket" | "local_git";
  baseSha: GitSha;
  headSha: GitSha;
  mergeBaseSha: GitSha | null;
  rawDiff: string;
  rawDiffHash: Sha256;
};
```

### 11.2 Parser output

```ts
export type ParseUnifiedDiffOutput = {
  diffModel: DiffModel;
  anchorIndex: LineAnchorIndex;
  changeSet: ChangeSet;
};
```

### 11.3 Parser state machine

Use a line-oriented parser.

```text
state: outside_file
  line starts with "diff --git "
    -> start DiffFile
    -> state: file_header

state: file_header
  line starts with extended header
    -> parse old/new mode, rename, copy, similarity, index
  line starts with "--- "
    -> parse old path
  line starts with "+++ "
    -> parse new path
  line starts with "@@ "
    -> start hunk
    -> state: hunk
  line starts with "Binary files "
    -> mark binary
  line starts with "diff --git "
    -> finish previous file, start next

state: hunk
  line starts with "@@ "
    -> finish previous hunk, start next hunk
  line starts with "diff --git "
    -> finish hunk, finish file, start next file
  line starts with "+"
    -> added line
  line starts with "-"
    -> deleted line
  line starts with " "
    -> context line
  line starts with "\\ No newline at end of file"
    -> no_newline_marker
```

### 11.4 Hunk header regex

Support traditional unified diff hunk headers:

```text
@@ -oldStart,oldLen +newStart,newLen @@ optional section header
```

Regex:

```ts
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
```

Defaults:

```text
oldLen omitted -> 1
newLen omitted -> 1
```

Support zero-line ranges:

```text
@@ -0,0 +1,10 @@
```

### 11.5 Line counter algorithm

For each hunk:

```ts
let oldLine = hunk.oldStart;
let newLine = hunk.newStart;
let providerPosition = previousProviderPositionForFile;

for (const rawLine of hunkBodyLines) {
  if (rawLine.startsWith("+")) {
    providerPosition++;
    emit({
      kind: "added",
      side: "RIGHT",
      oldLineNumber: null,
      newLineNumber: newLine,
      providerPosition,
      content: rawLine.slice(1),
      isCommentable: true,
    });
    newLine++;
  } else if (rawLine.startsWith("-")) {
    providerPosition++;
    emit({
      kind: "deleted",
      side: "LEFT",
      oldLineNumber: oldLine,
      newLineNumber: null,
      providerPosition,
      content: rawLine.slice(1),
      isCommentable: true,
    });
    oldLine++;
  } else if (rawLine.startsWith(" ")) {
    providerPosition++;
    emit({
      kind: "context",
      side: "BOTH",
      oldLineNumber: oldLine,
      newLineNumber: newLine,
      providerPosition,
      content: rawLine.slice(1),
      isCommentable: true,
    });
    oldLine++;
    newLine++;
  } else if (rawLine === "\\ No newline at end of file") {
    emit({
      kind: "no_newline_marker",
      side: null,
      oldLineNumber: null,
      newLineNumber: null,
      providerPosition: null,
      content: "",
      isCommentable: false,
    });
  } else {
    emitWarning("unrecognized_hunk_line");
  }
}
```

Provider position continues across hunks until the next file. This matches GitHub's documented `position` behavior.

### 11.6 File header parsing

Parse these extended headers:

```text
old mode <mode>
new mode <mode>
deleted file mode <mode>
new file mode <mode>
copy from <path>
copy to <path>
rename from <path>
rename to <path>
similarity index <number>%
dissimilarity index <number>%
index <oldHash>..<newHash> <mode>
Binary files <old> and <new> differ
```

### 11.7 Git path parsing

Git patch headers look like:

```text
diff --git a/file1 b/file2
```

For creation/deletion, the `diff --git` header still uses `a/` and `b/` names. `/dev/null` appears in the `---` or `+++` lines, not necessarily in the `diff --git` header.

Rules:

```text
- oldPath from --- line when available
- newPath from +++ line when available
- /dev/null means null path on that side
- rename/copy headers override display semantics
- displayPath prefers newPath, falls back to oldPath
```

### 11.8 Unsupported diff formats

Initially reject or warn on:

```text
- combined merge diffs using @@@ hunk headers
- extremely malformed patches
- diffs with unknown binary patch structure
```

Do not crash. Emit:

```ts
warnings.push({
  kind: "unsupported_diff_format",
  severity: "high",
  message: "Combined diff format is not supported for inline review anchors."
});
```

Then set:

```text
inlineCommentMode = disabled
summaryReviewPolicy = allowed
```

---

## 12. Line anchor index

### 12.1 Purpose

The anchor index answers:

```text
Can we comment on this file/line/side?
If yes, what payload should the publisher send?
```

### 12.2 Structure

```ts
export type LineAnchorIndex = {
  byRightLine: Map<string, LineAnchor>;
  byLeftLine: Map<string, LineAnchor>;
  byProviderPosition: Map<string, LineAnchor>;
  byFile: Map<RepoPath, FileAnchorInfo>;

  stats: {
    filesWithAnchors: number;
    totalLineAnchors: number;
    rightLineAnchors: number;
    leftLineAnchors: number;
    contextAnchors: number;
  };
};
```

Key helpers:

```ts
function rightKey(path: RepoPath, line: number): string {
  return `${path}:RIGHT:${line}`;
}

function leftKey(path: RepoPath, line: number): string {
  return `${path}:LEFT:${line}`;
}

function positionKey(path: RepoPath, position: number): string {
  return `${path}:POSITION:${position}`;
}
```

### 12.3 Anchor indexing rules

For each `DiffLine`:

#### Added line

```text
side: RIGHT
line: newLineNumber
```

Index:

```text
newPath + RIGHT + newLineNumber
providerPosition
```

#### Deleted line

```text
side: LEFT
line: oldLineNumber
```

Index:

```text
oldPath or displayPath + LEFT + oldLineNumber
providerPosition
```

For GitHub publishing, `path` should generally be the pull request file path. For deleted files this is the deleted path.

#### Context line

Context lines exist on both sides. For publishing, prefer:

```text
side: RIGHT
line: newLineNumber
```

Also index a LEFT alias if oldLineNumber exists, but mark it as less preferred.

#### No newline marker

Not commentable.

### 12.4 File-level anchors

Create file-level anchor info for every changed file, even if there are no hunks.

```ts
export type FileAnchorInfo = {
  path: RepoPath;
  previousPath: RepoPath | null;
  status: DiffFile["status"];
  hasHunks: boolean;
  hasCommentableLines: boolean;
  isBinary: boolean;
  supportsFileComment: boolean;
};
```

Use file-level fallback for:

```text
- binary files
- rename-only changes
- mode-only changes
- large/truncated patches
- findings about the whole file
```

---

## 13. GitHub anchor conversion

### 13.1 Single-line comment payload

Generic line anchor:

```ts
const anchor: LineAnchor = {
  filePath: "src/auth/session.ts",
  side: "RIGHT",
  line: 128,
  providerPosition: 42,
  hunkIndex: 0,
  hunkLineIndex: 15,
  kind: "added",
  rawDiffLine: 99,
};
```

GitHub review comment payload:

```ts
export type GitHubReviewCommentLocation = {
  path: string;
  body: string;
  line: number;
  side: "LEFT" | "RIGHT";
};
```

When posting individual review comments, include:

```ts
{
  commit_id: snapshot.headSha,
  path: anchor.filePath,
  line: anchor.line,
  side: anchor.side,
  body
}
```

### 13.2 Multiline comment payload

```ts
export type GitHubMultiLineReviewCommentLocation = {
  path: string;
  body: string;
  start_line: number;
  start_side: "LEFT" | "RIGHT";
  line: number;
  side: "LEFT" | "RIGHT";
};
```

MVP rule:

```text
Only allow multiline comments when all lines are on the same side and in the same file.
```

Later expansion:

```text
Support mixed deletion/addition ranges if verified against GitHub behavior.
```

### 13.3 File-level comment payload

GitHub supports `subject_type: "file"` for review comments.

Payload:

```ts
{
  commit_id: snapshot.headSha,
  path: fileAnchor.filePath,
  subject_type: "file",
  body
}
```

Use sparingly. File-level comments are less precise and can be noisy.

### 13.4 Review-batch payload

When creating a pull request review with multiple comments:

```ts
{
  commit_id: snapshot.headSha,
  body: summaryBody,
  event: "COMMENT",
  comments: [
    {
      path: "src/auth/session.ts",
      line: 128,
      side: "RIGHT",
      body: "..."
    }
  ]
}
```

Keep both single-comment and review-batch conversion helpers because publisher strategy may change.

---

## 14. Commentability rules

### 14.1 `isLineCommentable`

```ts
export function isLineCommentable(input: {
  diffModel: DiffModel;
  filePath: RepoPath;
  side: "LEFT" | "RIGHT";
  line: number;
}): boolean;
```

Returns `true` only when:

```text
- file exists in DiffModel
- file is not binary
- file has hunks
- line appears in anchor index for that side
- line is not metadata/no-newline marker
```

### 14.2 `resolveCommentTarget`

```ts
export function resolveCommentTarget(input: {
  finding: CandidateFinding;
  snapshot: PullRequestSnapshot;
  diffModel: DiffModel;
  anchorIndex: LineAnchorIndex;
}): CommentTarget;
```

Resolution order:

```text
1. Exact finding file + line + preferred side
2. Exact file + inferred side from diff line type
3. Nearest changed line in same changed block
4. File-level comment if allowed
5. Summary-only fallback
```

### 14.3 Inference rules for findings

If the finding has only a file and line:

```text
- If the line exists on RIGHT, use RIGHT.
- Else if the line exists on LEFT, use LEFT.
- Else if file-level fallback is enabled, downgrade to a file-level finding.
- Else summary-only.
```

If the finding explicitly refers to deleted code:

```text
prefer LEFT
```

If the finding refers to newly introduced behavior:

```text
prefer RIGHT
```

### 14.4 Nearest-line fallback

Nearest-line fallback is disabled by default. Only use it when a repo or manual replay explicitly opts in and all strict rules pass:

```text
- same file
- same hunk
- within configurable distance, default 3 lines
- finding body still makes sense at fallback line
- validation records fallback reason
- publish path records that the anchor was approximate
```

Record:

```ts
anchorResolution: {
  strategy: "nearest_changed_line";
  requestedLine: 124;
  resolvedLine: 126;
  distance: 2;
}
```

Avoid silently moving comments far from the issue. If exact anchoring fails and nearest-line fallback is not explicitly enabled, the safe order is exact anchor -> file-level finding -> summary-only.

---

## 15. Changed range extraction

The ChangeSet layer is used by retrieval and changed-symbol detection.

### 15.1 Added ranges

Collapse contiguous added lines within the same hunk:

```text
+ line 10
+ line 11
+ line 12
```

into:

```ts
{ side: "RIGHT", startLine: 10, endLine: 12, kind: "added" }
```

### 15.2 Deleted ranges

Collapse contiguous deleted lines:

```ts
{ side: "LEFT", startLine: 20, endLine: 23, kind: "deleted" }
```

### 15.3 Modified blocks

A modified block is usually a nearby deletion/addition group in one hunk.

Example:

```diff
- if (!user) return null;
+ if (!user || user.disabled) return null;
```

Represent as:

```ts
{
  kind: "modified_block",
  left: { startLine: 42, endLine: 42 },
  right: { startLine: 42, endLine: 42 },
  hunkIndex: 0
}
```

Suggested type:

```ts
export type ModifiedBlock = {
  filePath: RepoPath;
  hunkIndex: number;
  oldRange: LineRange | null;
  newRange: LineRange | null;
  addedLines: string[];
  deletedLines: string[];
};
```

### 15.4 Changed block algorithm

Within each hunk:

```text
1. Walk hunk lines.
2. Group consecutive added/deleted lines separated by at most N context lines.
3. Default N = 0 for strict grouping.
4. For modified block detection, allow N = 1 if context line is tiny/whitespace.
5. Emit modified_block when both deleted and added lines appear in the same group.
6. Emit added/deleted ranges otherwise.
```

Keep this deterministic and conservative.

---

## 16. Snapshot builder

### 16.1 Interface

```ts
export interface PullRequestSnapshotBuilder {
  build(input: BuildPullRequestSnapshotInput): Promise<BuildPullRequestSnapshotResult>;
}
```

```ts
export type BuildPullRequestSnapshotResult = {
  snapshot: PullRequestSnapshot;
  diffModel: DiffModel;
  anchorIndex: LineAnchorIndex;
  changeSet: ChangeSet;
  artifacts: {
    rawDiff: ArtifactRef;
    parsedDiff: ArtifactRef;
    snapshotJson: ArtifactRef;
  };
};
```

### 16.2 Build steps

```text
1. Validate provider input.
2. Compute rawDiffHash.
3. Parse raw diff into DiffModel.
4. Build LineAnchorIndex.
5. Extract ChangeSet.
6. Normalize changed files from provider file list.
7. Reconcile provider file list with parsed diff files.
8. Detect truncation/patch gaps.
9. Compute snapshot hash.
10. Write artifacts.
11. Return immutable result.
```

### 16.3 Reconciliation rules

You will have two sources:

```text
GitHub changed files endpoint
GitHub raw diff
```

They can differ in edge cases.

Reconcile as follows:

```text
- Use changed files endpoint for counts, blob SHAs, provider file statuses.
- Use raw diff for hunks and line anchors.
- If a file appears in API but not raw diff, create ChangedFile but no DiffFile hunks.
- If a file appears in raw diff but not API list, include it in DiffModel and emit warning.
- If counts differ, trust raw diff for line-level stats and API for provider summary stats.
```

Warnings:

```ts
{
  kind: "provider_diff_file_mismatch",
  severity: "medium",
  message: "File appears in changed files API but not raw diff.",
  filePath: "..."
}
```

---

## 17. Persistence

### 17.1 Database tables touched

From #2 database spec:

```text
pull_requests
pull_request_snapshots
review_artifacts
```

Potential helper tables:

```text
parsed_diff_files
parsed_diff_hunks
```

But for MVP, prefer artifact storage over storing every diff line in Postgres.

### 17.2 `pull_requests`

Durable current PR metadata:

```text
repo_id
provider
pull_request_number
latest_snapshot_id
latest_head_sha
state
draft
title
author_login
last_seen_at
```

### 17.3 `pull_request_snapshots`

Immutable snapshot row:

```text
id
repo_id
pull_request_number
provider
base_sha
head_sha
merge_base_sha
snapshot_hash
raw_diff_hash
parsed_diff_hash
raw_diff_artifact_id
parsed_diff_artifact_id
snapshot_artifact_id
changed_files_count
additions
deletions
files_truncated
created_at
```

### 17.4 `review_artifacts`

Artifacts:

```text
raw_diff
diff_model
pull_request_snapshot
change_set
line_anchor_index optional
```

Do not store raw diffs directly in Postgres unless they are tiny.
Artifact kind names must match `ReviewArtifactKind` in #0 and the `review_artifacts` table in #2.

---

## 18. Integration points

### 18.1 GitHub adapter

GitHub adapter provides:

```text
- raw PR details
- raw changed files
- raw diff
```

Then calls:

```ts
const result = await prSnapshotBuilder.build(input);
```

GitHub adapter should not parse diff hunks itself.

### 18.2 Review orchestrator

Review orchestrator receives:

```ts
PullRequestSnapshot
DiffModel
LineAnchorIndex
ChangeSet
```

It passes `ChangeSet` to retrieval and `LineAnchorIndex` to finding validation.

### 18.3 Retrieval engine

Retrieval uses:

```text
changed files
changed ranges
renamed paths
deleted paths
added paths
modified blocks
```

Retrieval should not parse raw diffs.

### 18.4 Finding validator

Finding validator uses:

```text
LineAnchorIndex
CommentTarget resolution
commentability checks
snapshot head SHA
```

### 18.5 Publisher

Publisher converts validated anchors to GitHub comment payloads.

Publisher should not decide whether a line is commentable. It should assume validation already happened, and fail closed if invalid.

### 18.6 Dashboard

Dashboard can show:

```text
- PR snapshot metadata
- parsed diff summary
- changed files
- anchor resolution logs
- rejected findings due to anchor failure
```

---

## 19. Failure modes and handling

### 19.1 Raw diff fetch fails

Behavior:

```text
- mark snapshot build failed
- do not run inline review
- optionally enqueue retry
```

If PR metadata and file list exist, a summary-only review may be possible, but MVP should require raw diff for review.

### 19.2 Raw diff too large

Behavior:

```text
- store large artifact if within configured max
- if above max, mark diffTooLarge
- allow summary-only review
- disable inline comments
```

Config:

```ts
MAX_RAW_DIFF_BYTES = 25 * 1024 * 1024;
MAX_PARSED_DIFF_LINES = 250_000;
```

Tune later.

### 19.3 Parser warnings

Warnings do not necessarily block review.

Blocking warnings:

```text
- unsupported combined diff
- hunk counter mismatch
- impossible line numbers
- file path parse failure for all files
```

Non-blocking warnings:

```text
- unknown extended header
- file appears in API but not diff
- patch count mismatch
```

### 19.4 Force-push during review

Before publishing, publisher should verify:

```text
current PR head SHA == snapshot.headSha
```

If not:

```text
- do not publish inline comments
- mark review_run as stale
- enqueue a new review job for latest head
```

### 19.5 GitHub rejects anchor

Publisher should record:

```text
published_findings.status = "publish_failed"
publish_error_kind = "invalid_anchor"
```

Then:

```text
- optionally retry as file-level comment if configured
- otherwise include in summary only
```

Do not blindly retry the same invalid line anchor.

---

## 20. Edge cases

### 20.1 Added file

```text
oldPath: null or /dev/null
newPath: path
allowed sides: RIGHT
```

Deleted-side comments are impossible.

### 20.2 Deleted file

```text
oldPath: path
newPath: null or /dev/null
allowed sides: LEFT
```

New-side comments are impossible.

### 20.3 Modified file

```text
allowed sides:
  RIGHT for added/context lines
  LEFT for deleted/context lines
```

Prefer RIGHT for context.

### 20.4 Renamed file with content changes

```text
previousPath: old path
path: new path
status: renamed
hunks: may exist
```

For comments on changed content, use the new path when the line exists on RIGHT.

For deleted lines in renamed files, test GitHub behavior. MVP should use `displayPath` from the PR files endpoint and validate against actual GitHub acceptance in integration tests.

### 20.5 Rename-only change

No hunks.

Use file-level comment only if needed.

### 20.6 Binary file

No line anchors.

Use file-level comments or summary-only.

### 20.7 Mode-only change

No line anchors.

Usually skip. Summary-only if security relevant, for example executable bit changes.

### 20.8 Submodule change

Treat as type/submodule metadata change.

No line anchors unless GitHub emits a normal diff.

### 20.9 No newline marker

` No newline at end of file` is not a real code line and should not be commentable.

The actual marker in raw diff is:

```text
\ No newline at end of file
```

### 20.10 Huge PRs

For huge PRs:

```text
- cap parsing by bytes and lines
- mark snapshot as large
- reduce retrieval scope
- summary-only or limited review mode
```

### 20.11 More than 3000 changed files

GitHub's PR files endpoint has a 3000 file maximum.

If reached:

```text
filesTruncated = true
reviewPolicy = summary_only or disabled by default
```

### 20.12 Paths with spaces or unusual characters

Git can quote unusual paths in diff output.

Parser should support:

```text
diff --git "a/file with spaces.ts" "b/file with spaces.ts"
--- "a/file with spaces.ts"
+++ "b/file with spaces.ts"
```

Implement path unquoting carefully and test it.

### 20.13 CRLF files

Raw diff lines will be line-oriented. Preserve line content after the diff marker.

Do not normalize content before line number counting.

### 20.14 Combined diffs

Combined diffs use `@@@` hunk headers and are not the normal PR review target.

MVP behavior:

```text
- parse as unsupported
- disable inline comments
- allow summary-only
```

---

## 21. Public API

Export these functions from `/packages/pr-snapshot`:

```ts
export { buildPullRequestSnapshot } from "./snapshot/build-pull-request-snapshot";
export { parseUnifiedDiff } from "./diff/parse-unified-diff";
export { buildLineAnchorIndex } from "./anchors/anchor-index";
export { resolveCommentTarget } from "./anchors/finding-anchor";
export { toGitHubReviewCommentLocation } from "./anchors/github-anchor";
export { isLineCommentable } from "./anchors/commentability";
export { extractChangeSet } from "./changes/change-set";
export { computeRawDiffHash, computeSnapshotHash } from "./snapshot/snapshot-hash";
```

### 21.1 `parseUnifiedDiff`

```ts
export function parseUnifiedDiff(input: ParseUnifiedDiffInput): ParseUnifiedDiffOutput;
```

This should be pure and deterministic.

### 21.2 `buildLineAnchorIndex`

```ts
export function buildLineAnchorIndex(diffModel: DiffModel): LineAnchorIndex;
```

This should be pure and deterministic.

### 21.3 `resolveCommentTarget`

```ts
export function resolveCommentTarget(input: ResolveCommentTargetInput): CommentTargetResolution;
```

```ts
export type CommentTargetResolution = {
  target: CommentTarget;
  strategy:
    | "exact_line"
    | "inferred_side"
    | "nearest_changed_line"
    | "file_level"
    | "summary_only";
  confidence: number;
  warnings: string[];
};
```

### 21.4 `toGitHubReviewCommentLocation`

```ts
export function toGitHubReviewCommentLocation(input: {
  target: CommentTarget;
  body: string;
}):
  | GitHubLineReviewCommentLocation
  | GitHubFileReviewCommentLocation
  | null;
```

Return `null` for summary-only targets.

---

## 22. Example: parsed diff

Raw diff:

```diff
diff --git a/src/auth/session.ts b/src/auth/session.ts
index 1111111..2222222 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -40,7 +40,8 @@ export function validateSession(token: string) {
   const session = decode(token);
-  if (!session) return null;
+  if (!session || session.disabled) return null;
+  if (session.expiresAt < Date.now()) return null;
   return session;
 }
```

Parsed hunk lines:

```ts
[
  {
    kind: "context",
    side: "BOTH",
    oldLineNumber: 40,
    newLineNumber: 40,
    providerPosition: 1,
    content: "  const session = decode(token);"
  },
  {
    kind: "deleted",
    side: "LEFT",
    oldLineNumber: 41,
    newLineNumber: null,
    providerPosition: 2,
    content: "  if (!session) return null;"
  },
  {
    kind: "added",
    side: "RIGHT",
    oldLineNumber: null,
    newLineNumber: 41,
    providerPosition: 3,
    content: "  if (!session || session.disabled) return null;"
  },
  {
    kind: "added",
    side: "RIGHT",
    oldLineNumber: null,
    newLineNumber: 42,
    providerPosition: 4,
    content: "  if (session.expiresAt < Date.now()) return null;"
  },
  {
    kind: "context",
    side: "BOTH",
    oldLineNumber: 42,
    newLineNumber: 43,
    providerPosition: 5,
    content: "  return session;"
  },
  {
    kind: "context",
    side: "BOTH",
    oldLineNumber: 43,
    newLineNumber: 44,
    providerPosition: 6,
    content: "}"
  }
]
```

GitHub line anchor for added expiry check:

```ts
{
  path: "src/auth/session.ts",
  line: 42,
  side: "RIGHT"
}
```

---

## 23. Validation rules

### 23.1 Diff parse validation

After parsing each hunk, verify:

```text
actual old-side line count == hunk.oldLines
actual new-side line count == hunk.newLines
```

Where:

```text
old-side lines = deleted + context
new-side lines = added + context
```

If mismatch:

```text
- emit high severity warning
- mark file anchors unsafe
```

### 23.2 Path validation

All paths must be normalized repo-relative paths.

Reject:

```text
absolute paths
paths containing .. segments
empty paths except /dev/null markers
NUL bytes
```

### 23.3 Anchor validation

Before publishing:

```text
- target path exists in DiffModel
- target line exists in LineAnchorIndex
- target side matches line kind
- target is not metadata/no-newline marker
- snapshot headSha is still current
```

### 23.4 Snapshot freshness validation

```ts
export type SnapshotFreshnessResult =
  | { status: "fresh" }
  | { status: "stale"; currentHeadSha: GitSha; snapshotHeadSha: GitSha };
```

Publisher should check freshness via GitHub adapter before posting.

---

## 24. Configuration

Add config:

```ts
export type PrSnapshotConfig = {
  maxRawDiffBytes: number;
  maxDiffFiles: number;
  maxParsedDiffLines: number;
  maxChangedFilesForInlineReview: number;

  allowFileLevelFallback: boolean;
  allowNearestLineFallback: boolean;
  nearestLineFallbackMaxDistance: number;

  storeParsedDiffArtifact: boolean;
  storeAnchorIndexArtifact: boolean;

  disableInlineCommentsOnParserWarnings: boolean;
};
```

Suggested defaults:

```ts
export const defaultPrSnapshotConfig: PrSnapshotConfig = {
  maxRawDiffBytes: 25 * 1024 * 1024,
  maxDiffFiles: 3000,
  maxParsedDiffLines: 250_000,
  maxChangedFilesForInlineReview: 100,

  allowFileLevelFallback: true,
  allowNearestLineFallback: false,
  nearestLineFallbackMaxDistance: 3,

  storeParsedDiffArtifact: true,
  storeAnchorIndexArtifact: false,

  disableInlineCommentsOnParserWarnings: true,
};
```

`maxChangedFilesForInlineReview` aligns with the upper bound for the canonical `large` ReviewSizeClass from #0. Larger PRs should default to summary-only unless a later product policy explicitly opts in.

---

## 25. Observability

Emit metrics:

```text
pr_snapshot.build.duration_ms
pr_snapshot.raw_diff.bytes
pr_snapshot.raw_diff.lines
pr_snapshot.changed_files.count
pr_snapshot.files_truncated.count
pr_snapshot.diff_parse.duration_ms
pr_snapshot.diff_parse.warning_count
pr_snapshot.anchor_index.total_anchors
pr_snapshot.anchor_resolution.success_count
pr_snapshot.anchor_resolution.failure_count
pr_snapshot.anchor_resolution.strategy_count
```

Log fields:

```text
org_id
repo_id
pull_request_number
snapshot_id
base_sha
head_sha
raw_diff_hash
changed_files_count
files_truncated
parser_version
```

Do not log raw diff contents by default.

---

## 26. Security and privacy

### 26.1 Do not log raw code

Raw diffs contain source code. Treat them as sensitive.

Logs should include:

```text
hashes
counts
paths when acceptable
line numbers
warning types
```

Logs should not include:

```text
raw diff lines
file contents
model prompts containing code
access tokens
```

### 26.2 Artifact access control

Artifacts should be scoped by org/repo and subject to the same access controls as review runs.

### 26.3 Path safety

Never use diff paths directly for filesystem access without validation.

Reject:

```text
../
absolute paths
NUL bytes
control characters when unsafe
```

### 26.4 Fork PRs

Fork PRs can come from untrusted authors.

Snapshot/diff parsing is okay, but any later execution of commands on forked code must happen in sandboxed tooling, not in this package.

---

## 27. Testing strategy

### 27.1 Golden diff parsing tests

For each fixture diff, assert parsed model exactly matches expected JSON.

Fixtures:

```text
added-file.diff
modified-file.diff
deleted-file.diff
renamed-file-with-changes.diff
rename-only.diff
copied-file.diff
binary-file.diff
mode-only.diff
submodule-change.diff
multiple-hunks.diff
no-newline.diff
spaces-in-path.diff
quoted-path.diff
large-hunk.diff
zero-line-range.diff
```

### 27.2 Hunk line counter tests

Assert:

```text
old line numbers increment on deleted/context
new line numbers increment on added/context
no-newline marker increments neither
providerPosition increments for added/deleted/context only
providerPosition continues across hunks within same file
providerPosition resets for new file
```

### 27.3 Anchor tests

For each fixture:

```text
given file + side + line
expect anchor exists or does not exist
expect GitHub payload shape
```

Examples:

```text
added line -> RIGHT anchor exists
added line -> LEFT anchor does not exist
deleted line -> LEFT anchor exists
deleted line -> RIGHT anchor does not exist
context line -> RIGHT anchor exists
no-newline marker -> no anchor
binary file -> no line anchor
```

### 27.4 Multiline tests

Assert:

```text
same-side contiguous range -> valid
cross-file range -> invalid
non-contiguous range -> invalid
metadata line in range -> invalid
mixed-side range -> invalid for MVP
```

### 27.5 Snapshot hash tests

Assert:

```text
same semantic snapshot with different fetchedAt has same snapshotHash
same raw diff has same rawDiffHash
changed headSha changes snapshotHash
changed raw diff changes snapshotHash
```

### 27.6 Provider reconciliation tests

Cases:

```text
file in API and diff -> normal
file in API but not diff -> warning
file in diff but not API -> warning
API says renamed but diff says modified -> warning
API patch missing but raw diff has hunks -> okay
```

### 27.7 Property-style parser tests

Generate simple diffs and assert invariants:

```text
hunk old count matches deleted+context
hunk new count matches added+context
line anchors are unique per file/side/line
provider positions are increasing within file
```

### 27.8 Integration tests with fake GitHub payloads

Use fixture PR payloads from `/packages/github` and raw diffs from this package.

Assert:

```text
builder creates snapshot
builder stores artifacts
builder parses diff
builder creates change set
publisher can convert anchors
```

---

## 28. Implementation sequence

### PR 1: Package shell and basic types

Implement:

```text
/packages/pr-snapshot
basic exports
config
test setup
fixture layout
```

### PR 2: Raw diff hashing and snapshot hashing

Implement:

```text
computeRawDiffHash
computeCanonicalJsonHash
computeSnapshotHash
hash tests
```

### PR 3: Unified diff parser MVP

Support:

```text
modified files
added files
deleted files
multiple hunks
no-newline marker
basic extended headers
```

### PR 4: Anchor index

Implement:

```text
buildLineAnchorIndex
isLineCommentable
single-line GitHub conversion
anchor tests
```

### PR 5: ChangeSet extraction

Implement:

```text
changed ranges
added/deleted ranges
modified blocks
renamed path pairs
change stats
```

### PR 6: Snapshot builder

Implement:

```text
buildPullRequestSnapshot
changed file normalization
raw diff artifact write
parsed diff artifact write
reconciliation warnings
```

### PR 7: Persistence helpers

Implement:

```text
persistPullRequestSnapshot
loadPullRequestSnapshot
artifact refs
DB transaction helper
```

### PR 8: Edge cases

Add support/tests for:

```text
renames
copies
binary files
mode-only changes
quoted paths
submodules
large diff handling
```

### PR 9: Integration with review orchestrator

Wire:

```text
review job -> snapshot builder -> diff model -> change set -> retrieval
finding validator -> anchor index
publisher -> GitHub conversion helper
```

### PR 10: Debug tooling

Implement CLI commands:

```bash
pnpm dev:parse-diff path/to/raw.diff
pnpm dev:anchors path/to/raw.diff src/file.ts:42
pnpm dev:changes path/to/raw.diff
```

---

## 29. MVP cut

For MVP, implement:

```text
- PullRequestSnapshot builder
- raw diff artifact storage
- parse unified diff
- modified/added/deleted files
- multiple hunks
- no-newline marker
- basic rename detection
- line anchor index
- single-line GitHub anchor conversion
- file-level fallback
- changed ranges
- snapshot hash
- parser golden tests
- anchor tests
```

Defer:

```text
- mixed-side multiline comments
- combined diffs
- full quoted path edge cases beyond basic tests
- parsed diff DB table decomposition
- local git diff fallback as primary source
- advanced hunk grouping heuristics
```

---

## 30. Definition of done

This section is complete when:

```text
- Review worker can create a PullRequestSnapshot from provider input.
- Raw diff is stored as an artifact and hash-addressed.
- Unified diff parser produces a DiffModel for normal GitHub PR diffs.
- LineAnchorIndex can answer whether a file/line/side is commentable.
- GitHub line comment payloads can be generated from anchors.
- Deleted lines map to LEFT and added lines map to RIGHT.
- Context lines prefer RIGHT.
- Binary/rename-only/mode-only files do not produce fake line anchors.
- ChangeSet exposes changed ranges to retrieval.
- Finding validator can reject non-commentable findings before publisher sees them.
- Parser and anchor fixtures cover common and edge diff cases.
- Force-push/stale snapshot behavior is defined before publishing.
```

---

## 31. Key implementation decisions

### 31.1 Use raw GitHub diff for publishable anchors

Use local git diffs for fallback/debugging, but not as the source of truth for GitHub comment anchors unless GitHub raw diff is unavailable and publishing mode is reduced.

### 31.2 Store parsed diff as artifact, not rows, at first

Postgres should not become a giant diff-line store in MVP.

Use object storage for:

```text
raw.diff
snapshot.json.gz
diff-model.json.gz
change-set.json.gz
```

### 31.3 Keep parser pure

The parser should not:

```text
- call GitHub
- read/write Postgres
- call object storage
- call LLMs
- know about review findings
```

It should only parse text into typed objects.

### 31.4 Make anchor failures visible

When a finding is rejected due to anchor failure, store:

```text
requested file
requested line
requested side
reason
nearest candidate anchor if any
snapshot id
raw diff hash
```

This is essential for debugging.

---

## 32. Example end-to-end object flow

```ts
const snapshotResult = await buildPullRequestSnapshot({
  orgId,
  repoId,
  provider: "github",
  repositoryFullName: "acme/api",
  owner: "acme",
  repo: "api",
  pullRequestNumber: 42,
  pr: githubPr,
  changedFiles: githubFiles,
  rawDiff,
  mergeBaseSha,
  fetchedAt: now,
});

await persistPullRequestSnapshot(snapshotResult);

const context = await retrieval.retrieve({
  snapshot: snapshotResult.snapshot,
  changeSet: snapshotResult.changeSet,
});

const candidates = await reviewEngine.review({
  snapshot: snapshotResult.snapshot,
  context,
});

const validated = candidates.map((finding) =>
  validateFinding({
    finding,
    snapshot: snapshotResult.snapshot,
    diffModel: snapshotResult.diffModel,
    anchorIndex: snapshotResult.anchorIndex,
  })
);

await publisher.publish({
  snapshot: snapshotResult.snapshot,
  findings: validated.filter((f) => f.status === "publishable"),
});
```

---

## 33. Local developer commands

Add commands:

```bash
# Parse raw diff and print summary
pnpm pr-snapshot parse ./fixtures/modified-file.diff

# Print commentable anchors
pnpm pr-snapshot anchors ./fixtures/modified-file.diff

# Resolve a target
pnpm pr-snapshot resolve ./fixtures/modified-file.diff --file src/auth.ts --line 42 --side RIGHT

# Validate all fixtures
pnpm pr-snapshot test-fixtures
```

Potential package scripts:

```json
{
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "dev:parse": "tsx src/cli/parse.ts",
    "dev:anchors": "tsx src/cli/anchors.ts"
  }
}
```

---

## 34. Review orchestrator checklist

When using this package in the review orchestrator:

```text
1. Fetch provider PR data.
2. Build snapshot.
3. Persist snapshot and artifacts.
4. If diff parsing unsafe, switch to summary-only.
5. Pass ChangeSet to retrieval.
6. Pass LineAnchorIndex to finding validator.
7. Before publishing, verify current headSha.
8. Publish only validated anchors.
9. Store anchor resolution result per finding.
```

---

## 35. Source notes

The implementation should stay aligned with these provider/documentation facts:

```text
- GitHub pull request review comments are comments on the unified diff, not issue comments.
- GitHub PR files endpoint is paginated and has a maximum of 3000 files.
- GitHub's review creation docs explain legacy `position` as lines down from the first @@ hunk header in a file.
- GitHub review comment docs now prefer `line`, `side`, `start_line`, and `start_side`; `position` is described as closing down.
- Git supports patch text generated with `-p`, including `diff --git` headers and extended headers such as old/new mode, rename, copy, similarity, and index lines.
- Git's `A...B` diff form is equivalent to diffing from `merge-base(A,B)` to `B`.
```

References:

```text
https://docs.github.com/en/rest/pulls/comments
https://docs.github.com/en/rest/pulls/reviews
https://docs.github.com/en/rest/pulls/pulls
https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api
https://git-scm.com/docs/diff-format
https://git-scm.com/docs/git-diff
```
