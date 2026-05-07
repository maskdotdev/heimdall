import type { ChangeSet } from "#contracts/pull-request/change-set";
import type { ChangedFile, DiffHunk } from "#contracts/pull-request/diff";
import type { PullRequestSnapshot } from "#contracts/pull-request/pull-request";
import { hashA, hashB, ids, now } from "./common";

export const validDiffHunkFixture = {
  hunkId: "hunk_1",
  header: "@@ -1,3 +1,5 @@",
  oldStart: 1,
  oldLines: 3,
  newStart: 1,
  newLines: 5,
  lines: [
    {
      kind: "context",
      content: "export function add(a: number, b: number) {",
      oldLine: 1,
      newLine: 1,
    },
    { kind: "deletion", content: "  return a + b", oldLine: 2 },
    { kind: "addition", content: "  return Number(a) + Number(b);", newLine: 2 },
    { kind: "context", content: "}", oldLine: 3, newLine: 3 },
  ],
} satisfies DiffHunk;

export const validChangedFileFixture = {
  path: "src/math.ts",
  status: "modified",
  language: "typescript",
  additions: 1,
  deletions: 1,
  changes: 2,
  isBinary: false,
  isGenerated: false,
  isTest: false,
  patch: "@@ -1,3 +1,5 @@",
  hunks: [validDiffHunkFixture],
  oldContentHash: hashA,
  newContentHash: hashB,
} satisfies ChangedFile;

export const validPullRequestSnapshotFixture = {
  snapshotId: ids.snapshotId,
  schemaVersion: "pull_request_snapshot.v1",
  provider: "github",
  repoId: ids.repoId,
  installationId: ids.installationId,
  providerRepoId: "123456789",
  providerPullRequestId: "987654321",
  pullRequestNumber: 42,
  title: "Tighten numeric addition",
  body: "Coerce inputs before adding.",
  authorLogin: "octocat",
  authorAssociation: "CONTRIBUTOR",
  state: "open",
  isDraft: false,
  labels: ["ready-for-review"],
  baseRef: "main",
  baseSha: "1111111",
  headRef: "feature/add-coercion",
  headSha: "2222222",
  mergeBaseSha: "1111111",
  changedFiles: [validChangedFileFixture],
  diffHash: hashA,
  additions: 1,
  deletions: 1,
  changedFileCount: 1,
  fetchedAt: now,
} satisfies PullRequestSnapshot;

export const validChangeSetFixture = {
  schemaVersion: "change_set.v1",
  repoId: ids.repoId,
  pullRequestNumber: 42,
  baseSha: "1111111",
  headSha: "2222222",
  mergeBaseSha: "1111111",
  files: [
    {
      path: "src/math.ts",
      status: "modified",
      hunkIds: ["hunk_1"],
      changedRanges: [
        {
          hunkId: "hunk_1",
          side: "RIGHT",
          startLine: 2,
          endLine: 2,
          kind: "added",
        },
        {
          hunkId: "hunk_1",
          side: "LEFT",
          startLine: 2,
          endLine: 2,
          kind: "deleted",
        },
      ],
      addedRanges: [
        {
          hunkId: "hunk_1",
          side: "RIGHT",
          startLine: 2,
          endLine: 2,
          kind: "added",
        },
      ],
      deletedRanges: [
        {
          hunkId: "hunk_1",
          side: "LEFT",
          startLine: 2,
          endLine: 2,
          kind: "deleted",
        },
      ],
      modifiedBlocks: [
        {
          hunkId: "hunk_1",
          oldRange: { startLine: 2, endLine: 2 },
          newRange: { startLine: 2, endLine: 2 },
          deletedLines: ["  return a + b"],
          addedLines: ["  return Number(a) + Number(b);"],
        },
      ],
      hasInlineCommentableLines: true,
      hasOnlyMetadataChanges: false,
      isBinary: false,
    },
  ],
  totalAddedLines: 1,
  totalDeletedLines: 1,
  totalContextLines: 2,
  changedPathSet: ["src/math.ts"],
  deletedPathSet: [],
  addedPathSet: [],
  renamedPathPairs: [],
  createdAt: now,
} satisfies ChangeSet;
