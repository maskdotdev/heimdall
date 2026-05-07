import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
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
  validateIndexArtifact,
} from "@repo/indexer-driver";
import ts from "typescript";

export const packageName = "@repo/indexer-ts" as const;

const INDEXER_NAME = "heimdall-typescript-indexer";
const INDEXER_VERSION = "0.1.0";
const CHUNKER_VERSION = "line-symbol-v1";
const MAX_FILE_BYTES = 1_000_000;

/** Creates a TypeScript and JavaScript artifact indexer. */
export function createTypeScriptIndexerDriver(): CodeIndexerDriver {
  return {
    name: INDEXER_NAME,
    version: INDEXER_VERSION,
    getCapabilities: async () => getTypeScriptIndexerCapabilities(),
    indexRepository: async (input) => {
      try {
        const artifact = await indexTypeScriptRepository(input);
        const diagnostics = validateIndexArtifact(artifact);
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
    supportsIncremental: true,
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
  const paths = await findSourceFiles(input.workspacePath);
  const records: IndexRecord[] = [];
  const languages = new Set<CodeLanguage>();

  for (const path of paths) {
    const content = await readFile(join(input.workspacePath, path), "utf8");
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

    records.push(file, ...symbols, ...chunkRecordsForFile(file, content, symbols));
    records.push(
      ...edgeRecordsForFile(input.repoId, input.commitSha, file.fileId, path, sourceFile, symbols),
    );
    languages.add(language);
  }

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

async function findSourceFiles(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name).split(sep).join("/");
      if (entry.isDirectory()) {
        return isVendoredPath(path) || path.startsWith(".git") ? [] : findSourceFiles(root, path);
      }
      if (!isSupportedPath(path)) {
        return [];
      }
      const info = await stat(join(root, path));
      return info.size > MAX_FILE_BYTES ? [] : [path];
    }),
  );

  return files.flat().sort();
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
  return /\.(ts|tsx|js|jsx|mts|cts)$/.test(path) && !path.endsWith(".d.ts");
}

function languageForPath(path: string): CodeLanguage {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".js")) return "javascript";
  return "typescript";
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isGeneratedPath(path: string): boolean {
  return path.includes(".generated.") || path.includes("/generated/") || path.endsWith(".min.js");
}

function isTestPath(path: string): boolean {
  return /(^|[/.])(test|spec)\.[cm]?[jt]sx?$/.test(path) || path.includes("__tests__/");
}

function isVendoredPath(path: string): boolean {
  return (
    path.startsWith("node_modules/") || path.startsWith("dist/") || path.startsWith("coverage/")
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
