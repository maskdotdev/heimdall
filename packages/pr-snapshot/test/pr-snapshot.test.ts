import { ChangedFileSchema, ChangeSetSchema, parseWithSchema } from "@repo/contracts";
import { validPullRequestSnapshotFixture } from "@repo/contracts/fixtures/pull-request.fixture";
import { describe, expect, it } from "vitest";
import {
  buildCommentableLineIndex,
  computeSnapshotHash,
  extractChangeSet,
  hashCanonicalJson,
  hashRawDiff,
  isLineCommentable,
  parseUnifiedDiff,
  toGitHubReviewCommentAnchor,
} from "../src";

describe("parseUnifiedDiff", () => {
  it("parses modified files into changed-file contracts", () => {
    const [file] = parseUnifiedDiff(`diff --git a/src/math.ts b/src/math.ts
index 1111111..2222222 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,4 @@
 export function add(a: number, b: number) {
-  return a + b
+  return Number(a) + Number(b);
 }
+export const value = 1;
`);

    expect(parseWithSchema("ChangedFile", ChangedFileSchema, file)).toMatchObject({
      additions: 2,
      changes: 3,
      deletions: 1,
      isBinary: false,
      language: "typescript",
      path: "src/math.ts",
      status: "modified",
    });
    expect(file?.hunks[0]?.lines.map((line) => line.kind)).toEqual([
      "context",
      "deletion",
      "addition",
      "context",
      "addition",
    ]);
  });

  it("parses renamed files and preserves old paths", () => {
    const [file] = parseUnifiedDiff(`diff --git a/src/old.ts b/src/new.ts
similarity index 80%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1 +1 @@
-export const oldName = true;
+export const newName = true;
`);

    expect(file).toMatchObject({
      oldPath: "src/old.ts",
      path: "src/new.ts",
      status: "renamed",
    });
  });

  it("marks binary files as non-hunk changed files", () => {
    const [file] = parseUnifiedDiff(`diff --git a/assets/logo.png b/assets/logo.png
index 1111111..2222222 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`);

    expect(file).toMatchObject({
      additions: 0,
      deletions: 0,
      hunks: [],
      isBinary: true,
      path: "assets/logo.png",
    });
  });
});

describe("line anchors", () => {
  it("indexes commentable left and right side lines", () => {
    const files = parseUnifiedDiff(`diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,2 +1,2 @@
 export function add(a: number, b: number) {
-  return a + b
+  return Number(a) + Number(b);
`);

    expect(buildCommentableLineIndex(files)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 1, path: "src/math.ts", side: "LEFT" }),
        expect.objectContaining({ line: 1, path: "src/math.ts", side: "RIGHT" }),
        expect.objectContaining({ line: 2, path: "src/math.ts", side: "LEFT" }),
        expect.objectContaining({ line: 2, path: "src/math.ts", side: "RIGHT" }),
      ]),
    );
    expect(isLineCommentable(files, { line: 2, path: "src/math.ts", side: "RIGHT" })).toBe(true);
    expect(isLineCommentable(files, { line: 3, path: "src/math.ts", side: "RIGHT" })).toBe(false);
  });

  it("converts only verified diff lines into GitHub review comment anchors", () => {
    const files = parseUnifiedDiff(`diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,4 @@
 export function add(a: number, b: number) {
-  return a + b
+  return Number(a) + Number(b);
 }
+export const value = 1;
`);

    expect(
      toGitHubReviewCommentAnchor(files, { line: 2, path: "src/math.ts", side: "RIGHT" }),
    ).toEqual({
      line: 2,
      path: "src/math.ts",
      side: "RIGHT",
    });
    expect(
      toGitHubReviewCommentAnchor(files, { line: 2, path: "src/math.ts", side: "LEFT" }),
    ).toEqual({
      line: 2,
      path: "src/math.ts",
      side: "LEFT",
    });
    expect(
      toGitHubReviewCommentAnchor(files, { line: 99, path: "src/math.ts", side: "RIGHT" }),
    ).toBeUndefined();
    expect(
      toGitHubReviewCommentAnchor(files, {
        line: 2,
        path: "src/math.ts",
        side: "RIGHT",
        startLine: 2,
        startSide: "LEFT",
      }),
    ).toBeUndefined();
  });

  it("converts same-side multiline ranges only when every line is commentable", () => {
    const files = parseUnifiedDiff(`diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,2 +1,3 @@
 export function add(a: number, b: number) {
+  const sum = Number(a) + Number(b);
   return a + b;
`);

    expect(
      toGitHubReviewCommentAnchor(files, {
        line: 2,
        path: "src/math.ts",
        side: "RIGHT",
        startLine: 1,
      }),
    ).toEqual({
      line: 2,
      path: "src/math.ts",
      side: "RIGHT",
      startLine: 1,
      startSide: "RIGHT",
    });
    expect(
      toGitHubReviewCommentAnchor(files, {
        line: 2,
        path: "src/math.ts",
        side: "RIGHT",
        startLine: 1,
        startSide: "LEFT",
      }),
    ).toBeUndefined();
    expect(
      toGitHubReviewCommentAnchor(files, {
        line: 4,
        path: "src/math.ts",
        side: "RIGHT",
        startLine: 1,
      }),
    ).toBeUndefined();
  });
});

describe("hashRawDiff", () => {
  it("hashes raw diff text with the repository hash prefix", () => {
    expect(hashRawDiff("diff --git a/a b/a\n")).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});

describe("snapshot hashing", () => {
  it("hashes canonical JSON independent of object key order", () => {
    expect(hashCanonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe(
      hashCanonicalJson({ a: { d: 2 }, b: 1 }),
    );
  });

  it("keeps equivalent snapshots stable while hashing semantic changes", () => {
    const first = {
      ...validPullRequestSnapshotFixture,
      fetchedAt: "2026-05-07T00:00:00.000Z",
      snapshotId: "prs_first",
    };
    const second = {
      ...validPullRequestSnapshotFixture,
      fetchedAt: "2026-05-07T01:00:00.000Z",
      snapshotId: "prs_second",
    };
    const changedHead = {
      ...second,
      headSha: "3333333",
    };

    expect(computeSnapshotHash(first)).toBe(computeSnapshotHash(second));
    expect(computeSnapshotHash(changedHead)).not.toBe(computeSnapshotHash(second));
  });
});

describe("extractChangeSet", () => {
  it("extracts changed ranges, modified blocks, and path sets", () => {
    const files = parseUnifiedDiff(`diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,4 +1,5 @@
 const one = 1;
-const value = one;
-const result = value;
+const value = Number(one);
+const result = value + 1;
 return result;
+export const extra = result;
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 100%
rename from src/old-name.ts
rename to src/new-name.ts
`);

    const changeSet = extractChangeSet({
      baseSha: "1111111",
      createdAt: "2026-05-07T00:00:00.000Z",
      files,
      headSha: "2222222",
      pullRequestNumber: 7,
      repoId: "repo_123",
    });

    expect(parseWithSchema("ChangeSet", ChangeSetSchema, changeSet)).toEqual(changeSet);
    expect(changeSet).toMatchObject({
      addedPathSet: [],
      changedPathSet: ["src/math.ts", "src/new-name.ts"],
      deletedPathSet: [],
      renamedPathPairs: [{ newPath: "src/new-name.ts", oldPath: "src/old-name.ts" }],
      totalAddedLines: 3,
      totalContextLines: 2,
      totalDeletedLines: 2,
    });
    expect(changeSet.files[0]).toMatchObject({
      addedRanges: [
        { endLine: 3, kind: "added", side: "RIGHT", startLine: 2 },
        { endLine: 5, kind: "added", side: "RIGHT", startLine: 5 },
      ],
      deletedRanges: [{ endLine: 3, kind: "deleted", side: "LEFT", startLine: 2 }],
      hasInlineCommentableLines: true,
      hasOnlyMetadataChanges: false,
      modifiedBlocks: [
        {
          addedLines: ["const value = Number(one);", "const result = value + 1;"],
          deletedLines: ["const value = one;", "const result = value;"],
          newRange: { endLine: 3, startLine: 2 },
          oldRange: { endLine: 3, startLine: 2 },
        },
      ],
    });
    expect(changeSet.files[1]).toMatchObject({
      hasInlineCommentableLines: false,
      hasOnlyMetadataChanges: true,
      oldPath: "src/old-name.ts",
      path: "src/new-name.ts",
      status: "renamed",
    });
  });
});
