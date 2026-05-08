import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import {
  type ChunkRecord,
  type CodeLanguage,
  type EdgeRecord,
  type FileRecord,
  INDEX_ARTIFACT_SCHEMA_VERSION,
  INDEX_RECORD_SCHEMA_VERSION,
  type IndexRecord,
  type SymbolKind,
  type SymbolRecord,
} from "@repo/index-schema";
import type { CodeIndexerDriver, IndexArtifact, IndexerCapabilities } from "@repo/indexer-driver";
import {
  INDEX_REQUEST_SCHEMA_VERSION,
  toIndexerFailure,
  validateIndexArtifactWithTelemetry,
} from "@repo/indexer-driver";
import ts from "typescript";

export const packageName = "@repo/indexer-ts" as const;

const INDEXER_NAME = "heimdall-typescript-indexer";
const INDEXER_VERSION = "0.1.0";
const CHUNKER_VERSION = "line-symbol-v1";
const MAX_FILE_BYTES = 1_000_000;
const BINARY_CONTENT_SAMPLE_BYTES = 8_192;
const MAX_BINARY_CONTROL_CHARACTER_RATIO = 0.3;
const GENERATED_CONTENT_HEADER_BYTES = 8_192;
const generatedPathSegments = new Set(["generated", "__generated__"]);
const vendoredPathSegments = new Set([
  "bower_components",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "third_party",
  "vendor",
  "vendors",
]);

/** Record groups emitted by the TypeScript indexer before canonical artifact ordering. */
type TypeScriptIndexRecordGroups = {
  /** Chunk records discovered from indexed files. */
  readonly chunks: ChunkRecord[];
  /** Edge records discovered from imports, definitions, and calls. */
  readonly edges: EdgeRecord[];
  /** File records discovered from workspace source files. */
  readonly files: FileRecord[];
  /** Symbol records discovered from parsed source files. */
  readonly symbols: SymbolRecord[];
};

/** Creates a TypeScript and JavaScript artifact indexer. */
export function createTypeScriptIndexerDriver(): CodeIndexerDriver {
  return {
    name: INDEXER_NAME,
    version: INDEXER_VERSION,
    getCapabilities: async () => getTypeScriptIndexerCapabilities(),
    indexRepository: async (input) => {
      try {
        const artifact = await indexTypeScriptRepository(input);
        const diagnostics = validateIndexArtifactWithTelemetry(artifact, {
          driverName: INDEXER_NAME,
          driverVersion: INDEXER_VERSION,
          ...(input.telemetry?.traceContext ? { traceContext: input.telemetry.traceContext } : {}),
          ...(input.telemetry?.traces ? { traces: input.telemetry.traces } : {}),
        });
        if (diagnostics.length > 0) {
          return {
            ok: false,
            error: {
              code: "artifact_invalid",
              message: "TypeScript indexer produced an invalid artifact.",
              details: { diagnostics },
            },
            diagnostics,
          };
        }

        return { ok: true, artifact, diagnostics: [] };
      } catch (error) {
        return { ok: false, error: toIndexerFailure(error, "filesystem_error"), diagnostics: [] };
      }
    },
  };
}

/** Returns the schema, language, record, and feature support of the TypeScript indexer. */
export function getTypeScriptIndexerCapabilities(): IndexerCapabilities {
  return {
    driverName: INDEXER_NAME,
    driverVersion: INDEXER_VERSION,
    maxFileBytes: MAX_FILE_BYTES,
    supportedArtifactSchemaVersions: [INDEX_ARTIFACT_SCHEMA_VERSION],
    supportedLanguages: ["typescript", "javascript", "tsx", "jsx"],
    supportedRecordTypes: ["file", "symbol", "edge", "chunk"],
    supportedRequestSchemaVersions: [INDEX_REQUEST_SCHEMA_VERSION],
    supportsCancellation: false,
    supportsIncremental: false,
    supportsPreviousArtifact: false,
    supportsRemoteArtifacts: false,
    supportsStreamingProgress: false,
  };
}

/** Indexes supported TS/JS files in a checked-out repository workspace. */
export async function indexTypeScriptRepository(input: {
  readonly repoId: string;
  readonly commitSha: string;
  readonly workspacePath: string;
  readonly previousIndexVersionId?: string;
}): Promise<IndexArtifact> {
  await validateWorkspacePath(input.workspacePath);
  const paths = await findSourceFiles(input.workspacePath);
  const recordGroups: TypeScriptIndexRecordGroups = {
    chunks: [],
    edges: [],
    files: [],
    symbols: [],
  };
  const languages = new Set<CodeLanguage>();

  for (const path of paths) {
    const rawContent = await readFile(join(input.workspacePath, path));
    if (isBinarySourceContent(rawContent)) {
      continue;
    }

    const rawText = rawContent.toString("utf8");
    if (shouldSkipSourceFile(path, rawText)) {
      continue;
    }

    const content = normalizeSourceText(rawText);
    const language = languageForPath(path);
    const file = fileRecord(input.repoId, input.commitSha, path, language, content);
    const sourceFile = ts.createSourceFile(
      path,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(path),
    );
    const symbols = collectSymbols(sourceFile, file, content);

    recordGroups.files.push(file);
    recordGroups.symbols.push(...symbols);
    recordGroups.chunks.push(...chunkRecordsForFile(file, content, symbols));
    recordGroups.edges.push(
      ...edgeRecordsForFile(input.repoId, input.commitSha, file.fileId, path, sourceFile, symbols),
    );
    languages.add(language);
  }

  const records = orderedIndexRecords(recordGroups);

  return {
    manifest: {
      schemaVersion: INDEX_ARTIFACT_SCHEMA_VERSION,
      recordSchemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      artifactId: stableId("art", [input.repoId, input.commitSha, INDEXER_NAME, INDEXER_VERSION]),
      repoId: input.repoId,
      commitSha: input.commitSha,
      indexerName: INDEXER_NAME,
      indexerVersion: INDEXER_VERSION,
      chunkerVersion: CHUNKER_VERSION,
      generatedAt: new Date().toISOString(),
      languages: [...languages].sort(),
      recordCount: records.length,
      fileCount: records.filter((record) => record.type === "file").length,
      symbolCount: records.filter((record) => record.type === "symbol").length,
      edgeCount: records.filter((record) => record.type === "edge").length,
      chunkCount: records.filter((record) => record.type === "chunk").length,
      parserVersions: { typescript: ts.version },
      ...(input.previousIndexVersionId ? { previousIndexId: input.previousIndexVersionId } : {}),
    },
    records,
  };
}

/** Returns records in the canonical artifact type order required by the schema spec. */
function orderedIndexRecords(groups: TypeScriptIndexRecordGroups): IndexRecord[] {
  return [...groups.files, ...groups.symbols, ...groups.chunks, ...groups.edges];
}

/** Validates a workspace root before recursively reading repository files. */
async function validateWorkspacePath(workspacePath: string): Promise<void> {
  const trimmedPath = workspacePath.trim();
  if (trimmedPath.length === 0) {
    throw new Error("Workspace path is required.");
  }

  const absolutePath = resolve(trimmedPath);
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) {
    throw new Error("Workspace path must not be a symbolic link.");
  }
  if (!info.isDirectory()) {
    throw new Error("Workspace path must be a directory.");
  }

  const resolvedPath = await realpath(absolutePath);
  if (isFilesystemRoot(resolvedPath)) {
    throw new Error("Workspace path must not be a filesystem root.");
  }
  if (resolvedPath === resolve(homedir())) {
    throw new Error("Workspace path must not be the user home directory.");
  }
}

async function findSourceFiles(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        return [];
      }
      if (entry.isDirectory()) {
        return shouldSkipDirectory(path) ? [] : findSourceFiles(root, path);
      }
      if (!isIndexableSourcePath(path)) {
        return [];
      }
      const info = await stat(join(root, path));
      return info.isFile() && info.size <= MAX_FILE_BYTES ? [path] : [];
    }),
  );

  return files.flat().sort();
}

/** Normalizes source text for deterministic parsing, ranges, chunks, and hashes. */
function normalizeSourceText(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

/** Returns whether file bytes look like binary content rather than source text. */
function isBinarySourceContent(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, BINARY_CONTENT_SAMPLE_BYTES));
  if (sample.includes(0)) {
    return true;
  }
  if (sample.length === 0) {
    return false;
  }

  const controlCharacters = sample.filter((byte) => isUnexpectedControlCharacter(byte)).length;
  return controlCharacters / sample.length > MAX_BINARY_CONTROL_CHARACTER_RATIO;
}

/** Returns whether a byte is an unexpected control character for source text. */
function isUnexpectedControlCharacter(byte: number): boolean {
  return byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13;
}

function fileRecord(
  repoId: string,
  commitSha: string,
  path: string,
  language: CodeLanguage,
  content: string,
): FileRecord {
  return {
    type: "file",
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    fileId: stableId("file", [repoId, commitSha, path]),
    repoId,
    commitSha,
    path,
    language,
    contentHash: sha256(content),
    sizeBytes: Buffer.byteLength(content),
    lineCount: content.split("\n").length,
    isBinary: false,
    isGenerated: isGeneratedPath(path),
    isTest: isTestPath(path),
    isVendored: isVendoredPath(path),
  };
}

function collectSymbols(
  sourceFile: ts.SourceFile,
  file: FileRecord,
  content: string,
): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const visit = (node: ts.Node, parents: readonly string[]) => {
    const name = symbolName(node);
    if (name) {
      const range = lineRange(sourceFile, node);
      const qualifiedName = [...parents, name].join(".");
      const signature = signatureForNode(node, sourceFile);
      symbols.push({
        type: "symbol",
        schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
        symbolId: stableId("sym", [
          file.repoId,
          file.commitSha,
          file.path,
          qualifiedName,
          range.startLine,
        ]),
        fileId: file.fileId,
        repoId: file.repoId,
        commitSha: file.commitSha,
        path: file.path,
        language: file.language,
        name,
        qualifiedName,
        kind: symbolKind(node, name),
        range,
        selectionRange: range,
        ...(signature ? { signature } : {}),
        visibility: "unknown",
        contentHash: sha256(content.slice(node.getStart(sourceFile), node.getEnd())),
      });
    }

    ts.forEachChild(node, (child) => visit(child, name ? [...parents, name] : parents));
  };

  visit(sourceFile, []);
  return symbols;
}

function chunkRecordsForFile(
  file: FileRecord,
  content: string,
  symbols: readonly SymbolRecord[],
): ChunkRecord[] {
  if (symbols.length === 0) {
    return [chunkForRange(file, content, { startLine: 1, endLine: Math.max(1, file.lineCount) })];
  }

  return symbols.map((symbol) =>
    chunkForRange(file, content, symbol.range, symbol.symbolId, file.isTest ? "test" : "symbol"),
  );
}

function chunkForRange(
  file: FileRecord,
  content: string,
  range: { readonly startLine: number; readonly endLine: number },
  symbolId?: string,
  kind: ChunkRecord["kind"] = "file",
): ChunkRecord {
  const text = content
    .split("\n")
    .slice(range.startLine - 1, range.endLine)
    .join("\n");
  return {
    type: "chunk",
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    chunkId: stableId("chunk", [file.fileId, symbolId ?? "file", range.startLine, range.endLine]),
    fileId: file.fileId,
    ...(symbolId ? { symbolId } : {}),
    repoId: file.repoId,
    commitSha: file.commitSha,
    path: file.path,
    language: file.language,
    range,
    kind,
    text,
    contentHash: sha256(text),
    tokenEstimate: estimateTokens(text),
  };
}

function edgeRecordsForFile(
  repoId: string,
  commitSha: string,
  fileId: string,
  path: string,
  sourceFile: ts.SourceFile,
  symbols: readonly SymbolRecord[],
): EdgeRecord[] {
  const edges: EdgeRecord[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const toId = `external:${statement.moduleSpecifier.text}`;
      edges.push({
        type: "edge",
        schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
        edgeId: stableId("edge", [repoId, commitSha, fileId, "imports", toId]),
        repoId,
        commitSha,
        fromId: fileId,
        toId,
        fromKind: "file",
        toKind: "external",
        kind: "imports",
        confidence: 1,
        metadata: { path },
      });
    }
  }

  return [
    ...edges,
    ...callEdgesForFile(repoId, commitSha, sourceFile, symbols),
    ...symbols.map((symbol) => ({
      type: "edge" as const,
      schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      edgeId: stableId("edge", [repoId, commitSha, fileId, "defines", symbol.symbolId]),
      repoId,
      commitSha,
      fromId: fileId,
      toId: symbol.symbolId,
      fromKind: "file" as const,
      toKind: "symbol" as const,
      kind: "defines" as const,
      confidence: 1,
    })),
  ];
}

function callEdgesForFile(
  repoId: string,
  commitSha: string,
  sourceFile: ts.SourceFile,
  symbols: readonly SymbolRecord[],
): EdgeRecord[] {
  const symbolsByName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
  const edges: EdgeRecord[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const caller = symbolContainingLine(symbols, lineRange(sourceFile, node).startLine);
      const calleeName = callName(node.expression);
      const callee = calleeName ? symbolsByName.get(calleeName) : undefined;
      if (caller && callee && caller.symbolId !== callee.symbolId) {
        edges.push({
          type: "edge",
          schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
          edgeId: stableId("edge", [repoId, commitSha, caller.symbolId, "calls", callee.symbolId]),
          repoId,
          commitSha,
          fromId: caller.symbolId,
          toId: callee.symbolId,
          fromKind: "symbol",
          toKind: "symbol",
          kind: "calls",
          confidence: 0.7,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return edges;
}

function symbolContainingLine(
  symbols: readonly SymbolRecord[],
  line: number,
): SymbolRecord | undefined {
  return [...symbols]
    .filter((symbol) => symbol.range.startLine <= line && symbol.range.endLine >= line)
    .sort(
      (left, right) =>
        left.range.endLine - left.range.startLine - (right.range.endLine - right.range.startLine),
    )[0];
}

function callName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }

  return undefined;
}

function symbolName(node: ts.Node): string | undefined {
  if (
    (ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name
  ) {
    return node.name.text;
  }
  if (
    (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }

  return undefined;
}

function symbolKind(node: ts.Node, name: string): SymbolKind {
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isPropertyDeclaration(node)) return "property";
  if (ts.isVariableDeclaration(node)) return /^[A-Z0-9_]+$/.test(name) ? "constant" : "variable";
  if (ts.isFunctionDeclaration(node)) return /^[A-Z]/.test(name) ? "component" : "function";
  return "unknown";
}

function signatureForNode(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const text = node.getText(sourceFile).split("\n")[0]?.trim();
  return text && text.length <= 240 ? text : undefined;
}

function lineRange(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { readonly startLine: number; readonly endLine: number } {
  const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { startLine, endLine: Math.max(startLine, endLine) };
}

function isSupportedPath(path: string): boolean {
  return /\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path);
}

/** Returns whether a source file should be considered for indexing. */
function isIndexableSourcePath(path: string): boolean {
  return isSupportedPath(path) && !isGeneratedPath(path) && !isVendoredPath(path);
}

function languageForPath(path: string): CodeLanguage {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";
  if (/\.[cm]?js$/.test(path)) return "javascript";
  return "typescript";
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isGeneratedPath(path: string): boolean {
  const fileName = path.split("/").at(-1) ?? path;

  return (
    hasPathSegment(path, generatedPathSegments) ||
    /\.(generated|gen)\.[cm]?[jt]sx?$/.test(fileName) ||
    fileName.endsWith(".min.js") ||
    fileName.endsWith(".pb.ts") ||
    fileName.endsWith(".graphql.ts")
  );
}

function isTestPath(path: string): boolean {
  return /(^|[/.])(test|spec)\.[cm]?[jt]sx?$/.test(path) || path.includes("__tests__/");
}

function isVendoredPath(path: string): boolean {
  return hasPathSegment(path, vendoredPathSegments);
}

/** Returns whether a directory should be skipped while walking the workspace. */
function shouldSkipDirectory(path: string): boolean {
  return isGitDirectory(path) || isGeneratedPath(path) || isVendoredPath(path);
}

/** Returns whether a file should be skipped after content inspection. */
function shouldSkipSourceFile(path: string, content: string): boolean {
  return isGeneratedPath(path) || isVendoredPath(path) || hasGeneratedContentMarker(content);
}

/** Returns whether a path points at the Git metadata directory. */
function isGitDirectory(path: string): boolean {
  return path === ".git" || path.startsWith(".git/");
}

/** Returns whether a path resolves to a filesystem root. */
function isFilesystemRoot(path: string): boolean {
  const resolvedPath = resolve(path);

  return resolvedPath === parse(resolvedPath).root;
}

/** Returns whether a normalized path contains any matching segment. */
function hasPathSegment(path: string, segments: ReadonlySet<string>): boolean {
  return path.split("/").some((segment) => segments.has(segment));
}

/** Returns whether file content contains common generated-code markers near the top. */
function hasGeneratedContentMarker(content: string): boolean {
  const header = content.slice(0, GENERATED_CONTENT_HEADER_BYTES).toLowerCase();

  return (
    header.includes("@generated") ||
    header.includes("<auto-generated") ||
    header.includes("automatically generated") ||
    header.includes("code generated by") ||
    header.includes("this file was generated") ||
    (header.includes("do not edit") && header.includes("generated"))
  );
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function sha256(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function stableId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26)}`;
}
