import { createHash } from "node:crypto";
import type {
  ChangedFile,
  ChangedFileChangeSet,
  ChangedRange,
  ChangeSet,
  DiffHunk,
  DiffLine,
  FileChangeStatus,
  LineRange,
  ModifiedBlock,
  PullRequestSnapshot,
} from "@repo/contracts";

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

/** Reason a finding is resolved to a file-level review comment instead of a line. */
export type FileAnchorReason =
  | "binary_file"
  | "renamed_without_hunks"
  | "metadata_only"
  | "line_not_in_diff"
  | "fallback";

/** Provider-neutral file-level target for findings that cannot safely use a line anchor. */
export type FileAnchor = {
  /** Repository path used by the provider for the review comment. */
  readonly path: string;
  /** GitHub-compatible subject type for file-level review comments. */
  readonly subjectType: "file";
  /** Why the finding was downgraded to a file-level target. */
  readonly reason: FileAnchorReason;
  /** Previous repository path when the target file was renamed. */
  readonly oldPath?: string;
  /** Changed-file status that produced the file anchor. */
  readonly status: FileChangeStatus;
};

/** Per-file anchor metadata, including whether line or file comments are available. */
export type FileAnchorInfo = {
  /** Repository path used by the provider for the review comment. */
  readonly path: string;
  /** Previous repository path when the target file was renamed. */
  readonly oldPath?: string;
  /** Changed-file status from the parsed diff. */
  readonly status: FileChangeStatus;
  /** Whether the parsed file has any diff hunks. */
  readonly hasHunks: boolean;
  /** Whether the file has any line-level anchors. */
  readonly hasCommentableLines: boolean;
  /** Whether the provider reports this file as binary. */
  readonly isBinary: boolean;
  /** Whether the provider can receive a file-level review comment for this file. */
  readonly supportsFileComment: boolean;
  /** Default fallback reason for file-level comments on this file. */
  readonly fallbackReason: FileAnchorReason;
};

/** GitHub pull request review file-comment anchor. */
export type GitHubFileReviewCommentAnchor = {
  /** Repository path passed to GitHub's review comment API. */
  readonly path: string;
  /** GitHub subject type for file-level review comments. */
  readonly subjectType: "file";
};

/** Metadata and parsed files used to extract a deterministic pull request change set. */
export type ExtractChangeSetInput = {
  /** Parsed changed files from a provider raw diff. */
  readonly files: readonly ChangedFile[];
  /** Timestamp supplied by the caller for deterministic artifact creation. */
  readonly createdAt: string;
  /** Optional repository identifier to include in the change-set artifact. */
  readonly repoId?: string;
  /** Optional pull request number to include in the change-set artifact. */
  readonly pullRequestNumber?: number;
  /** Optional base commit SHA for the parsed change set. */
  readonly baseSha?: string;
  /** Optional head commit SHA for the parsed change set. */
  readonly headSha?: string;
  /** Optional merge-base commit SHA for the parsed change set. */
  readonly mergeBaseSha?: string;
};

type MutableChangedFile = {
  path: string;
  oldPath?: string;
  status?: FileChangeStatus;
  isBinary: boolean;
  hasModeChange: boolean;
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
    if (rawLine.startsWith("old mode ") || rawLine.startsWith("new mode ")) {
      currentFile.hasModeChange = true;
      continue;
    }
    if (rawLine.startsWith("rename from ")) {
      currentFile.oldPath = normalizeDiffPath(rawLine.slice("rename from ".length));
      currentFile.status = "renamed";
      continue;
    }
    if (rawLine.startsWith("rename to ")) {
      currentFile.path = normalizeDiffPath(rawLine.slice("rename to ".length));
      currentFile.status = "renamed";
      continue;
    }
    if (rawLine.startsWith("copy from ")) {
      currentFile.oldPath = normalizeDiffPath(rawLine.slice("copy from ".length));
      currentFile.status = "copied";
      continue;
    }
    if (rawLine.startsWith("copy to ")) {
      currentFile.path = normalizeDiffPath(rawLine.slice("copy to ".length));
      currentFile.status = "copied";
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
  return hashString(diff);
}

/** Hashes JSON data after sorting object keys and omitting undefined object fields. */
export function hashCanonicalJson(value: unknown): `sha256:${string}` {
  return hashString(canonicalJson(value));
}

/** Hashes the stable semantic content of a pull request snapshot. */
export function computeSnapshotHash(snapshot: PullRequestSnapshot): `sha256:${string}` {
  const { fetchedAt: _fetchedAt, snapshotId: _snapshotId, ...stableSnapshot } = snapshot;

  return hashCanonicalJson(stableSnapshot);
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

/** Returns file-level anchor metadata for every parsed changed file. */
export function buildFileAnchorIndex(files: readonly ChangedFile[]): readonly FileAnchorInfo[] {
  return files.map((file) => {
    const hasCommentableLines = buildCommentableLineIndex([file]).length > 0;

    return {
      fallbackReason: defaultFileAnchorReason(file),
      hasCommentableLines,
      hasHunks: file.hunks.length > 0,
      isBinary: file.isBinary,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      path: file.path,
      status: file.status,
      supportsFileComment: true,
    };
  });
}

/** Returns whether a provider-neutral line anchor appears in the parsed diff. */
export function isLineCommentable(files: readonly ChangedFile[], anchor: LineAnchor): boolean {
  return buildCommentableLineIndex(files).some(
    (line) => line.path === anchor.path && line.line === anchor.line && line.side === anchor.side,
  );
}

/** Resolves a provider-neutral file-level anchor for a changed file path. */
export function resolveFileAnchor(
  files: readonly ChangedFile[],
  path: string,
  reason?: FileAnchorReason,
): FileAnchor | undefined {
  const info = buildFileAnchorIndex(files).find((file) => file.path === path);
  if (!info?.supportsFileComment) {
    return undefined;
  }

  return {
    ...(info.oldPath ? { oldPath: info.oldPath } : {}),
    path: info.path,
    reason: reason ?? info.fallbackReason,
    status: info.status,
    subjectType: "file",
  };
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

/** Converts a provider-neutral file anchor into a GitHub review file-comment anchor. */
export function toGitHubFileReviewCommentAnchor(anchor: FileAnchor): GitHubFileReviewCommentAnchor {
  return {
    path: anchor.path,
    subjectType: anchor.subjectType,
  };
}

/** Extracts changed ranges, modified blocks, and path sets from parsed changed files. */
export function extractChangeSet(input: ExtractChangeSetInput): ChangeSet {
  const files = input.files.map(extractChangedFileChangeSet);

  return {
    schemaVersion: "change_set.v1",
    ...(input.repoId !== undefined ? { repoId: input.repoId } : {}),
    ...(input.pullRequestNumber !== undefined
      ? { pullRequestNumber: input.pullRequestNumber }
      : {}),
    ...(input.baseSha !== undefined ? { baseSha: input.baseSha } : {}),
    ...(input.headSha !== undefined ? { headSha: input.headSha } : {}),
    ...(input.mergeBaseSha !== undefined ? { mergeBaseSha: input.mergeBaseSha } : {}),
    addedPathSet: uniquePaths(
      input.files.filter((file) => file.status === "added").map((file) => file.path),
    ),
    changedPathSet: uniquePaths(input.files.map((file) => file.path)),
    createdAt: input.createdAt,
    deletedPathSet: uniquePaths(
      input.files.filter((file) => file.status === "deleted").map((file) => file.path),
    ),
    files,
    renamedPathPairs: input.files.flatMap((file) =>
      file.status === "renamed" && file.oldPath
        ? [{ newPath: file.path, oldPath: file.oldPath }]
        : [],
    ),
    totalAddedLines: sumChangedLines(input.files, "addition"),
    totalContextLines: sumChangedLines(input.files, "context"),
    totalDeletedLines: sumChangedLines(input.files, "deletion"),
  };
}

/** Converts a parsed changed file into a minimal patch text. */
export function patchForChangedFile(file: ChangedFile): string {
  return patchForHunks(file.hunks);
}

function beginChangedFile(line: string): MutableChangedFile {
  const [rawOldPath, rawNewPath] = parseDiffGitPaths(line);
  const oldPath = normalizeDiffPath(rawOldPath ?? "");
  const path = normalizeDiffPath(rawNewPath ?? oldPath);

  return {
    additions: 0,
    deletions: 0,
    hasModeChange: false,
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
  if (file.hasModeChange) {
    return "type_changed";
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

/** Returns the default file-level fallback reason for one changed file. */
function defaultFileAnchorReason(file: ChangedFile): FileAnchorReason {
  if (file.isBinary) {
    return "binary_file";
  }
  if (file.status === "renamed" && file.hunks.length === 0) {
    return "renamed_without_hunks";
  }
  if (file.hunks.length === 0 && file.additions === 0 && file.deletions === 0) {
    return "metadata_only";
  }

  return "fallback";
}

/** Extracts range and block metadata for one parsed changed file. */
function extractChangedFileChangeSet(file: ChangedFile): ChangedFileChangeSet {
  const addedRanges = file.hunks.flatMap((hunk) => rangesForDiffLineKind(hunk, "addition"));
  const deletedRanges = file.hunks.flatMap((hunk) => rangesForDiffLineKind(hunk, "deletion"));

  return {
    addedRanges,
    changedRanges: [...addedRanges, ...deletedRanges],
    deletedRanges,
    hasInlineCommentableLines: buildCommentableLineIndex([file]).length > 0,
    hasOnlyMetadataChanges:
      !file.isBinary && file.hunks.length === 0 && file.additions === 0 && file.deletions === 0,
    hunkIds: file.hunks.map((hunk) => hunk.hunkId),
    isBinary: file.isBinary,
    modifiedBlocks: file.hunks.flatMap(modifiedBlocksForHunk),
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    path: file.path,
    status: file.status,
  };
}

/** Collapses contiguous added or deleted lines from one hunk into changed ranges. */
function rangesForDiffLineKind(
  hunk: DiffHunk,
  kind: Extract<DiffLine["kind"], "addition" | "deletion">,
): ChangedRange[] {
  const ranges: ChangedRange[] = [];
  let startLine: number | undefined;
  let endLine: number | undefined;

  const flushRange = (): void => {
    if (startLine === undefined || endLine === undefined) {
      return;
    }

    ranges.push({
      endLine,
      hunkId: hunk.hunkId,
      kind: kind === "addition" ? "added" : "deleted",
      side: kind === "addition" ? "RIGHT" : "LEFT",
      startLine,
    });
    startLine = undefined;
    endLine = undefined;
  };

  for (const line of hunk.lines) {
    const lineNumber = kind === "addition" ? line.newLine : line.oldLine;
    if (line.kind !== kind || lineNumber === undefined) {
      flushRange();
      continue;
    }

    if (endLine !== undefined && lineNumber === endLine + 1) {
      endLine = lineNumber;
      continue;
    }

    flushRange();
    startLine = lineNumber;
    endLine = lineNumber;
  }

  flushRange();

  return ranges;
}

/** Groups adjacent additions and deletions in one hunk into conservative modified blocks. */
function modifiedBlocksForHunk(hunk: DiffHunk): ModifiedBlock[] {
  const blocks: ModifiedBlock[] = [];
  let addedLines: string[] = [];
  let deletedLines: string[] = [];
  let oldStart: number | undefined;
  let oldEnd: number | undefined;
  let newStart: number | undefined;
  let newEnd: number | undefined;

  const flushBlock = (): void => {
    if (addedLines.length > 0 && deletedLines.length > 0) {
      blocks.push({
        addedLines,
        deletedLines,
        hunkId: hunk.hunkId,
        ...(oldStart !== undefined && oldEnd !== undefined
          ? { oldRange: lineRange(oldStart, oldEnd) }
          : {}),
        ...(newStart !== undefined && newEnd !== undefined
          ? { newRange: lineRange(newStart, newEnd) }
          : {}),
      });
    }

    addedLines = [];
    deletedLines = [];
    oldStart = undefined;
    oldEnd = undefined;
    newStart = undefined;
    newEnd = undefined;
  };

  for (const line of hunk.lines) {
    if (line.kind === "addition" && line.newLine !== undefined) {
      addedLines.push(line.content);
      newStart = newStart ?? line.newLine;
      newEnd = line.newLine;
      continue;
    }
    if (line.kind === "deletion" && line.oldLine !== undefined) {
      deletedLines.push(line.content);
      oldStart = oldStart ?? line.oldLine;
      oldEnd = line.oldLine;
      continue;
    }

    flushBlock();
  }

  flushBlock();

  return blocks;
}

/** Creates a line range with inclusive bounds. */
function lineRange(startLine: number, endLine: number): LineRange {
  return { endLine, startLine };
}

/** Counts parsed diff lines of one kind across all files. */
function sumChangedLines(files: readonly ChangedFile[], kind: DiffLine["kind"]): number {
  return files.reduce(
    (total, file) =>
      total +
      file.hunks.reduce(
        (fileTotal, hunk) => fileTotal + hunk.lines.filter((line) => line.kind === kind).length,
        0,
      ),
    0,
  );
}

/** Returns paths in first-seen order without duplicates. */
function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
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
  const trimmed = unquoteGitPath(path.trim());
  if (trimmed === "/dev/null") {
    return trimmed;
  }

  return trimmed.replace(/^[ab]\//u, "");
}

/** Splits a diff --git header into old and new path tokens, preserving quoted spaces. */
function parseDiffGitPaths(line: string): readonly [string | undefined, string | undefined] {
  const remainder = line.slice("diff --git ".length);
  const tokens = tokenizeGitPathHeader(remainder);

  return [tokens[0], tokens[1]];
}

/** Tokenizes a Git diff path header while respecting simple double-quoted path tokens. */
function tokenizeGitPathHeader(input: string): readonly string[] {
  const tokens: string[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    while (input[cursor] === " ") {
      cursor += 1;
    }
    if (cursor >= input.length) {
      break;
    }

    const parsed =
      input[cursor] === '"' ? readQuotedToken(input, cursor) : readBareToken(input, cursor);
    tokens.push(parsed.token);
    cursor = parsed.nextCursor;
  }

  return tokens;
}

/** Reads one quoted path token from a Git diff header. */
function readQuotedToken(
  input: string,
  startCursor: number,
): { readonly token: string; readonly nextCursor: number } {
  let cursor = startCursor + 1;
  let token = '"';
  let escaped = false;

  while (cursor < input.length) {
    const char = input[cursor] ?? "";
    token += char;
    cursor += 1;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      break;
    }
  }

  return { nextCursor: cursor, token };
}

/** Reads one unquoted path token from a Git diff header. */
function readBareToken(
  input: string,
  startCursor: number,
): { readonly token: string; readonly nextCursor: number } {
  let cursor = startCursor;
  while (cursor < input.length && input[cursor] !== " ") {
    cursor += 1;
  }

  return { nextCursor: cursor, token: input.slice(startCursor, cursor) };
}

/** Removes simple Git double-quote wrapping and unescapes common quoted path sequences. */
function unquoteGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) {
    return path;
  }

  return path.slice(1, -1).replace(/\\(["\\nt])/gu, (_match, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "t") return "\t";

    return escaped;
  });
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

/** Serializes a value as canonical JSON with sorted object keys. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

/** Converts a value into a JSON-safe structure with sorted object keys. */
function toCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toCanonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, toCanonicalValue(entryValue)]),
    );
  }

  return value;
}

/** Returns a sha256 content hash. */
function hashString(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
