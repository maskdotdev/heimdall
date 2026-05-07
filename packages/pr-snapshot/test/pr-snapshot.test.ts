import { ChangedFileSchema, ChangeSetSchema, parseWithSchema } from "@repo/contracts";
import { validPullRequestSnapshotFixture } from "@repo/contracts/fixtures/pull-request.fixture";
import { describe, expect, it } from "vitest";
import {
  buildCommentableLineIndex,
  buildFileAnchorIndex,
  computeSnapshotHash,
  extractChangeSet,
  hashCanonicalJson,
  hashRawDiff,
  isLineCommentable,
  parseUnifiedDiff,
  resolveFileAnchor,
  toGitHubFileReviewCommentAnchor,
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

  it("parses copied files without treating them as renames", () => {
    const [file] = parseUnifiedDiff(`diff --git a/src/source.ts b/src/copied.ts
similarity index 93%
copy from src/source.ts
copy to src/copied.ts
--- a/src/source.ts
+++ b/src/copied.ts
@@ -1 +1,2 @@
 export const source = true;
+export const copied = true;
`);

    expect(parseWithSchema("ChangedFile", ChangedFileSchema, file)).toMatchObject({
      additions: 1,
      deletions: 0,
      oldPath: "src/source.ts",
      path: "src/copied.ts",
      status: "copied",
    });
  });

  it("parses mode-only changes as metadata type changes", () => {
    const [file] = parseUnifiedDiff(`diff --git a/scripts/run.sh b/scripts/run.sh
old mode 100644
new mode 100755
`);

    expect(parseWithSchema("ChangedFile", ChangedFileSchema, file)).toMatchObject({
      additions: 0,
      changes: 0,
      deletions: 0,
      hunks: [],
      path: "scripts/run.sh",
      status: "type_changed",
    });
    expect(resolveFileAnchor(file ? [file] : [], "scripts/run.sh")).toEqual({
      path: "scripts/run.sh",
      reason: "metadata_only",
      status: "type_changed",
      subjectType: "file",
    });
  });

  it("parses quoted Git paths with spaces", () => {
    const [file] = parseUnifiedDiff(`diff --git "a/src/old file.ts" "b/src/new file.ts"
similarity index 88%
rename from "src/old file.ts"
rename to "src/new file.ts"
--- "a/src/old file.ts"
+++ "b/src/new file.ts"
@@ -1 +1 @@
-export const label = "old";
+export const label = "new";
`);

    expect(parseWithSchema("ChangedFile", ChangedFileSchema, file)).toMatchObject({
      oldPath: "src/old file.ts",
      path: "src/new file.ts",
      status: "renamed",
    });
    expect(buildCommentableLineIndex(file ? [file] : [])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 1, path: "src/new file.ts", side: "RIGHT" }),
        expect.objectContaining({ line: 1, path: "src/new file.ts", side: "LEFT" }),
      ]),
    );
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

describe("file anchors", () => {
  it("indexes file-level fallback targets for changed files without line anchors", () => {
    const files = parseUnifiedDiff(`diff --git a/assets/logo.png b/assets/logo.png
index 1111111..2222222 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 100%
rename from src/old-name.ts
rename to src/new-name.ts
diff --git a/scripts/run.sh b/scripts/run.sh
old mode 100644
new mode 100755
`);

    expect(buildFileAnchorIndex(files)).toEqual([
      expect.objectContaining({
        fallbackReason: "binary_file",
        hasCommentableLines: false,
        hasHunks: false,
        isBinary: true,
        path: "assets/logo.png",
        supportsFileComment: true,
      }),
      expect.objectContaining({
        fallbackReason: "renamed_without_hunks",
        oldPath: "src/old-name.ts",
        path: "src/new-name.ts",
      }),
      expect.objectContaining({
        fallbackReason: "metadata_only",
        path: "scripts/run.sh",
      }),
    ]);
  });

  it("converts resolved file anchors into GitHub review file-comment anchors", () => {
    const files = parseUnifiedDiff(`diff --git a/assets/logo.png b/assets/logo.png
index 1111111..2222222 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`);

    const anchor = resolveFileAnchor(files, "assets/logo.png", "line_not_in_diff");

    expect(anchor).toEqual({
      path: "assets/logo.png",
      reason: "line_not_in_diff",
      status: "modified",
      subjectType: "file",
    });
    expect(anchor ? toGitHubFileReviewCommentAnchor(anchor) : undefined).toEqual({
      path: "assets/logo.png",
      subjectType: "file",
    });
    expect(resolveFileAnchor(files, "src/missing.ts")).toBeUndefined();
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
