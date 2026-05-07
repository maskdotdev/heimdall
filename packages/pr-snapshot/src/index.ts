import { createHash } from "node:crypto";
import type { ChangedFile, DiffHunk, DiffLine, FileChangeStatus } from "@repo/contracts";

export const packageName = "@repo/pr-snapshot" as const;

/** GitHub-compatible diff side for review comment anchoring. */
export type DiffAnchorSide = "LEFT" | "RIGHT";

/** Provider-neutral line anchor derived from a parsed unified diff. */
export type LineAnchor = {
  /** Repository path used by the provider for the review comment. */
  readonly path: string;
  /** 1-based line number on the selected side. */
  readonly line: number;
  /** Side of the diff where the line appears. */
  readonly side: DiffAnchorSide;
};

/** Indexed commentable line for a changed file. */
export type CommentableLine = LineAnchor & {
  /** Diff hunk that contains the line. */
  readonly hunkId: string;
  /** Line kind inside the hunk. */
  readonly kind: DiffLine["kind"];
};

/** Provider-neutral range anchor to convert into a GitHub review-comment target. */
export type ReviewCommentRangeAnchor = LineAnchor & {
  /** Optional first line for a same-side multiline comment range. */
  readonly startLine?: number;
  /** Optional first-line side for a same-side multiline comment range. */
  readonly startSide?: DiffAnchorSide;
};

/** GitHub pull request review comment anchor using the modern line/side fields. */
export type GitHubReviewCommentAnchor = {
  /** Repository path passed to GitHub's review comment API. */
  readonly path: string;
  /** Last 1-based line in the selected diff side. */
  readonly line: number;
  /** Last diff side for the review comment. */
  readonly side: DiffAnchorSide;
  /** Optional first 1-based line for multiline comments. */
  readonly startLine?: number;
  /** Optional first diff side for multiline comments. */
  readonly startSide?: DiffAnchorSide;
};

type MutableChangedFile = {
  path: string;
  oldPath?: string;
  status?: FileChangeStatus;
  isBinary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
};

type HunkState = {
  oldLine: number;
  newLine: number;
  hunk: DiffHunk;
};

const HUNK_HEADER_PATTERN =
  /^@@ -(?<oldStart>\d+)(?:,(?<oldLines>\d+))? \+(?<newStart>\d+)(?:,(?<newLines>\d+))? @@/u;

/** Parses a Git unified diff into provider-neutral changed files. */
export function parseUnifiedDiff(diff: string): readonly ChangedFile[] {
  const files: MutableChangedFile[] = [];
  let currentFile: MutableChangedFile | undefined;
  let currentHunk: HunkState | undefined;

  for (const rawLine of diff.split(/\r?\n/u)) {
    if (rawLine.startsWith("diff --git ")) {
      currentFile = beginChangedFile(rawLine);
      files.push(currentFile);
      currentHunk = undefined;
      continue;
    }
    if (!currentFile) {
      continue;
    }
    if (rawLine.startsWith("new file mode ")) {
      currentFile.status = "added";
      continue;
    }
    if (rawLine.startsWith("deleted file mode ")) {
      currentFile.status = "deleted";
      continue;
    }
    if (rawLine.startsWith("rename from ")) {
      currentFile.oldPath = rawLine.slice("rename from ".length);
      currentFile.status = "renamed";
      continue;
    }
    if (rawLine.startsWith("rename to ")) {
      currentFile.path = rawLine.slice("rename to ".length);
      currentFile.status = "renamed";
      continue;
    }
    if (rawLine.startsWith("Binary files ")) {
      currentFile.isBinary = true;
      continue;
    }
    if (rawLine.startsWith("--- ")) {
      applyOldPathHeader(currentFile, rawLine);
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      applyNewPathHeader(currentFile, rawLine);
      continue;
    }
    if (rawLine.startsWith("@@ ")) {
      currentHunk = beginHunk(currentFile, rawLine);
      continue;
    }
    if (!currentHunk || rawLine.startsWith("\\ No newline at end of file")) {
      continue;
    }

    applyHunkLine(currentFile, currentHunk, rawLine);
  }

  return files.map(finalizeChangedFile);
}

/** Hashes raw diff text with the repository hash format. */
export function hashRawDiff(diff: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(diff).digest("hex")}`;
}

/** Returns all provider-commentable lines from parsed changed files. */
export function buildCommentableLineIndex(
  files: readonly ChangedFile[],
): readonly CommentableLine[] {
  return files.flatMap((file) =>
    file.hunks.flatMap((hunk) =>
      hunk.lines.flatMap((line) => commentableLineForDiffLine(file.path, hunk.hunkId, line)),
    ),
  );
}

/** Returns whether a provider-neutral line anchor appears in the parsed diff. */
export function isLineCommentable(files: readonly ChangedFile[], anchor: LineAnchor): boolean {
  return buildCommentableLineIndex(files).some(
    (line) => line.path === anchor.path && line.line === anchor.line && line.side === anchor.side,
  );
}

/** Converts a verified provider-neutral anchor into a GitHub review-comment anchor. */
export function toGitHubReviewCommentAnchor(
  files: readonly ChangedFile[],
  anchor: ReviewCommentRangeAnchor,
): GitHubReviewCommentAnchor | undefined {
  if (!isLineCommentable(files, anchor)) {
    return undefined;
  }

  if (anchor.startLine === undefined) {
    return {
      line: anchor.line,
      path: anchor.path,
      side: anchor.side,
    };
  }

  const startSide = anchor.startSide ?? anchor.side;
  if (startSide !== anchor.side || anchor.startLine > anchor.line) {
    return undefined;
  }

  if (anchor.startLine === anchor.line) {
    return {
      line: anchor.line,
      path: anchor.path,
      side: anchor.side,
    };
  }

  if (
    !isSameSideRangeCommentable(files, {
      line: anchor.line,
      path: anchor.path,
      side: anchor.side,
      startLine: anchor.startLine,
    })
  ) {
    return undefined;
  }

  return {
    line: anchor.line,
    path: anchor.path,
    side: anchor.side,
    startLine: anchor.startLine,
    startSide,
  };
}

/** Converts a parsed changed file into a minimal patch text. */
export function patchForChangedFile(file: ChangedFile): string {
  return patchForHunks(file.hunks);
}

function beginChangedFile(line: string): MutableChangedFile {
  const [, rawOldPath, rawNewPath] = /^diff --git (.+) (.+)$/u.exec(line) ?? [];
  const oldPath = normalizeDiffPath(rawOldPath ?? "");
  const path = normalizeDiffPath(rawNewPath ?? oldPath);

  return {
    additions: 0,
    deletions: 0,
    hunks: [],
    isBinary: false,
    path,
    ...(oldPath === path ? {} : { oldPath }),
  };
}

function applyOldPathHeader(file: MutableChangedFile, line: string): void {
  const oldPath = normalizeDiffPath(line.slice("--- ".length));
  if (oldPath !== "/dev/null" && oldPath !== file.path) {
    file.oldPath = oldPath;
  }
  if (line.includes("/dev/null")) {
    file.status = "added";
  }
}

function applyNewPathHeader(file: MutableChangedFile, line: string): void {
  const newPath = normalizeDiffPath(line.slice("+++ ".length));
  if (newPath !== "/dev/null") {
    file.path = newPath;
  } else {
    file.status = "deleted";
  }
}

function beginHunk(file: MutableChangedFile, header: string): HunkState {
  const match = HUNK_HEADER_PATTERN.exec(header);
  if (!match?.groups) {
    throw new Error(`Invalid unified diff hunk header: ${header}`);
  }

  const hunk: DiffHunk = {
    header,
    hunkId: stableId("hunk", [file.path, file.hunks.length, header]),
    lines: [],
    newLines: numberFromGroup(match.groups.newLines, 1),
    newStart: numberFromGroup(match.groups.newStart, 0),
    oldLines: numberFromGroup(match.groups.oldLines, 1),
    oldStart: numberFromGroup(match.groups.oldStart, 0),
  };
  file.hunks.push(hunk);

  return {
    hunk,
    newLine: hunk.newStart,
    oldLine: hunk.oldStart,
  };
}

function applyHunkLine(file: MutableChangedFile, state: HunkState, rawLine: string): void {
  const marker = rawLine.at(0);
  const content = rawLine.slice(1);

  if (marker === "+") {
    state.hunk.lines.push({ content, kind: "addition", newLine: state.newLine });
    state.newLine += 1;
    file.additions += 1;
    return;
  }
  if (marker === "-") {
    state.hunk.lines.push({ content, kind: "deletion", oldLine: state.oldLine });
    state.oldLine += 1;
    file.deletions += 1;
    return;
  }
  if (marker === " ") {
    state.hunk.lines.push({
      content,
      kind: "context",
      newLine: state.newLine,
      oldLine: state.oldLine,
    });
    state.newLine += 1;
    state.oldLine += 1;
  }
}

function finalizeChangedFile(file: MutableChangedFile): ChangedFile {
  const status = file.status ?? inferStatus(file);

  return {
    additions: file.additions,
    changes: file.additions + file.deletions,
    deletions: file.deletions,
    hunks: file.hunks,
    isBinary: file.isBinary,
    isGenerated: isGeneratedPath(file.path),
    isTest: isTestPath(file.path),
    language: languageForPath(file.path),
    ...(file.oldPath && file.oldPath !== file.path ? { oldPath: file.oldPath } : {}),
    ...(file.hunks.length > 0 ? { patch: patchForHunks(file.hunks) } : {}),
    path: file.path,
    status,
  };
}

function inferStatus(file: MutableChangedFile): FileChangeStatus {
  if (file.oldPath && file.oldPath !== file.path) {
    return "renamed";
  }

  return "modified";
}

function patchForHunks(hunks: readonly DiffHunk[]): string {
  return hunks
    .flatMap((hunk) => [
      hunk.header,
      ...hunk.lines.map((line) => `${prefixForDiffLine(line.kind)}${line.content}`),
    ])
    .join("\n");
}

function commentableLineForDiffLine(
  path: string,
  hunkId: string,
  line: DiffLine,
): readonly CommentableLine[] {
  if (line.kind === "addition" && line.newLine) {
    return [{ hunkId, kind: line.kind, line: line.newLine, path, side: "RIGHT" }];
  }
  if (line.kind === "deletion" && line.oldLine) {
    return [{ hunkId, kind: line.kind, line: line.oldLine, path, side: "LEFT" }];
  }
  if (line.kind === "context" && line.newLine && line.oldLine) {
    return [
      { hunkId, kind: line.kind, line: line.oldLine, path, side: "LEFT" },
      { hunkId, kind: line.kind, line: line.newLine, path, side: "RIGHT" },
    ];
  }

  return [];
}

/** Checks whether every line in a same-side review range can receive a comment. */
function isSameSideRangeCommentable(
  files: readonly ChangedFile[],
  anchor: Required<Pick<ReviewCommentRangeAnchor, "line" | "path" | "side" | "startLine">>,
): boolean {
  for (let line = anchor.startLine; line <= anchor.line; line += 1) {
    if (!isLineCommentable(files, { line, path: anchor.path, side: anchor.side })) {
      return false;
    }
  }

  return true;
}

function normalizeDiffPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/dev/null") {
    return trimmed;
  }

  return trimmed.replace(/^[ab]\//u, "");
}

function numberFromGroup(value: string | undefined, fallback: number): number {
  return value === undefined ? fallback : Number.parseInt(value, 10);
}

function languageForPath(path: string): ChangedFile["language"] {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "ts") return "typescript";
  if (extension === "tsx") return "tsx";
  if (extension === "js") return "javascript";
  if (extension === "jsx") return "jsx";
  if (extension === "py") return "python";
  if (extension === "go") return "go";
  if (extension === "rs") return "rust";
  if (extension === "java") return "java";
  if (extension === "kt" || extension === "kts") return "kotlin";
  if (extension === "cs") return "csharp";
  if (extension === "cpp" || extension === "cc" || extension === "cxx" || extension === "hpp") {
    return "cpp";
  }
  if (extension === "c" || extension === "h") return "c";
  if (extension === "rb") return "ruby";
  if (extension === "php") return "php";
  if (extension === "swift") return "swift";

  return "unknown";
}

function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)\/|(\.|-)(test|spec)\.[^.]+$/u.test(path);
}

function isGeneratedPath(path: string): boolean {
  return /(^|\/)(generated|dist|build|coverage)\//u.test(path);
}

function prefixForDiffLine(kind: DiffLine["kind"]): string {
  return kind === "addition" ? "+" : kind === "deletion" ? "-" : " ";
}

function stableId(prefix: string, parts: readonly unknown[]): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26);

  return `${prefix}_${hash}`;
}
