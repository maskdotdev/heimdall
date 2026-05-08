import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import {
  type ChunkRecord,
  type CodeLanguage,
  createStableId,
  type DependencyRecord,
  type EdgeRecord,
  type FileRecord,
  INDEX_ARTIFACT_SCHEMA_VERSION,
  INDEX_RECORD_SCHEMA_VERSION,
  type IndexRecord,
  type RouteRecord,
  type SymbolKind,
  type SymbolRecord,
  type TestMappingRecord,
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
const PYTHON_PARSER_VERSION = "heuristic-python-v1";
const MAX_FILE_BYTES = 1_000_000;
const BINARY_CONTENT_SAMPLE_BYTES = 8_192;
const MAX_BINARY_CONTROL_CHARACTER_RATIO = 0.3;
const GENERATED_CONTENT_HEADER_BYTES = 8_192;
const PACKAGE_JSON_FILE_NAME = "package.json";
const TYPESCRIPT_CONFIG_FILE_NAMES = ["tsconfig.json", "jsconfig.json"] as const;
const httpRouteMethods = new Set(["delete", "get", "head", "options", "patch", "post", "put"]);
const moduleResolutionExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;
const nextJsRouteMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
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

/** package.json fields that the indexer converts into dependency records. */
const packageDependencySections = [
  { dependencyType: "prod", fieldName: "dependencies" },
  { dependencyType: "dev", fieldName: "devDependencies" },
  { dependencyType: "peer", fieldName: "peerDependencies" },
  { dependencyType: "optional", fieldName: "optionalDependencies" },
] as const satisfies readonly PackageDependencySection[];

/** Python identifiers that should not be treated as meaningful same-file callees. */
const pythonCallExcludedNames = new Set([
  "bool",
  "dict",
  "float",
  "int",
  "len",
  "list",
  "print",
  "set",
  "str",
  "super",
  "tuple",
]);

/** package.json dependency section mapping. */
type PackageDependencySection = {
  /** Artifact dependency type emitted for dependencies in this section. */
  readonly dependencyType: NonNullable<DependencyRecord["dependencyType"]>;
  /** package.json object field containing dependency names and version ranges. */
  readonly fieldName: string;
};

/** Python symbol candidate discovered from indentation-aware source scanning. */
type PythonSymbolCandidate = {
  /** Indentation level of the declaration line. */
  readonly indent: number;
  /** Symbol kind emitted for the declaration. */
  readonly kind: SymbolKind;
  /** Unqualified symbol name. */
  readonly name: string;
  /** Fully qualified symbol name within Python nesting. */
  readonly qualifiedName: string;
  /** One-line declaration signature. */
  readonly signature: string;
  /** 1-based declaration line. */
  readonly startLine: number;
};

/** Stack entry used while building Python qualified names. */
type PythonSymbolStackEntry = {
  /** Indentation level where this declaration starts. */
  readonly indent: number;
  /** Symbol kind for this stack entry. */
  readonly kind: SymbolKind;
  /** Symbol name used in descendant qualified names. */
  readonly name: string;
};

/** Python import statement facts used to emit conservative import edges. */
type PythonImportFact = {
  /** Imported module path or package name. */
  readonly moduleName: string;
  /** Imported names when the source uses from-import syntax. */
  readonly importedNames: readonly string[];
  /** 1-based line where the import starts. */
  readonly lineNumber: number;
  /** Import syntax category. */
  readonly syntax: "import" | "from_import";
};

/** Python call expression fact used to emit same-file call edges. */
type PythonCallFact = {
  /** Direct callee identifier. */
  readonly calleeName: string;
  /** 1-based line where the call appears. */
  readonly lineNumber: number;
};

/** Python route decorator fact used to emit conservative route records. */
type PythonRouteDecoratorFact = {
  /** Raw decorator text without leading whitespace. */
  readonly decorator: string;
  /** 1-based line where the decorator appears. */
  readonly decoratorLine: number;
  /** HTTP method declared by the decorator. */
  readonly method: string;
  /** Route pattern declared by the decorator. */
  readonly routePattern: string;
  /** Receiver object used by the decorator, such as app or router. */
  readonly receiver: string;
  /** 1-based line where the decorated handler declaration starts. */
  readonly handlerLine: number;
};

/** Test target candidate inferred from a test file path. */
type TestTargetCandidate = {
  /** Source path that may be covered by the test file. */
  readonly path: string;
  /** Confidence assigned when the candidate exists in the artifact. */
  readonly confidence: number;
  /** Name of the deterministic heuristic that produced this candidate. */
  readonly heuristic: string;
};

/** TypeScript or JavaScript source file retained for repository-level resolution. */
type TypeScriptSourceExtraction = {
  /** File record for the parsed source. */
  readonly file: FileRecord;
  /** Parsed TypeScript compiler source file. */
  readonly sourceFile: ts.SourceFile;
  /** Symbols extracted from the source file. */
  readonly symbols: readonly SymbolRecord[];
};

/** Import module specifier fact from a TS/JS import declaration. */
type TypeScriptImportModuleFact = {
  /** Import module specifier exactly as declared. */
  readonly moduleSpecifier: string;
  /** 1-based line where the import declaration starts. */
  readonly lineNumber: number;
};

/** Named import binding fact from a TS/JS import declaration. */
type TypeScriptImportBindingFact = TypeScriptImportModuleFact & {
  /** Exported name requested from the imported module. */
  readonly importedName: string;
  /** Local binding name used in the importing file. */
  readonly localName: string;
};

/** Direct identifier call fact from a TS/JS call expression. */
type TypeScriptCallFact = {
  /** Direct callee identifier used at the call site. */
  readonly calleeName: string;
  /** 1-based line where the call expression starts. */
  readonly lineNumber: number;
};

/** Simple TS/JS path alias derived from tsconfig or jsconfig paths. */
type ModuleResolutionAlias = {
  /** Original import pattern, such as @/* or @lib/*. */
  readonly pattern: string;
  /** Prefix before the optional wildcard in the import pattern. */
  readonly patternPrefix: string;
  /** Suffix after the optional wildcard in the import pattern. */
  readonly patternSuffix: string;
  /** Original target pattern, such as src/*. */
  readonly target: string;
  /** Prefix before the optional wildcard in the target pattern. */
  readonly targetPrefix: string;
  /** Suffix after the optional wildcard in the target pattern. */
  readonly targetSuffix: string;
};

/** Indexed module file resolved from a module specifier. */
type ResolvedModuleFile = {
  /** Resolved indexed file. */
  readonly file: FileRecord;
  /** Resolution strategy that found the file. */
  readonly resolution: "alias" | "relative";
  /** Matched alias pattern when resolution used tsconfig/jsconfig paths. */
  readonly aliasPattern?: string;
};

/** Record groups emitted by the TypeScript indexer before canonical artifact ordering. */
type TypeScriptIndexRecordGroups = {
  /** Chunk records discovered from indexed files. */
  readonly chunks: ChunkRecord[];
  /** Dependency records discovered from package manifests. */
  readonly dependencies: DependencyRecord[];
  /** Edge records discovered from imports, definitions, and calls. */
  readonly edges: EdgeRecord[];
  /** File records discovered from workspace source files. */
  readonly files: FileRecord[];
  /** Route records discovered from cheap framework heuristics. */
  readonly routes: RouteRecord[];
  /** Symbol records discovered from parsed source files. */
  readonly symbols: SymbolRecord[];
  /** Test mapping records discovered from path/name heuristics. */
  readonly testMappings: TestMappingRecord[];
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
    supportedLanguages: ["typescript", "javascript", "tsx", "jsx", "python"],
    supportedRecordTypes: [
      "file",
      "symbol",
      "edge",
      "chunk",
      "dependency",
      "route",
      "test_mapping",
    ],
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
  const moduleAliases = await loadTypeScriptModuleAliases(input.workspacePath);
  const paths = await findIndexablePaths(input.workspacePath);
  const recordGroups: TypeScriptIndexRecordGroups = {
    chunks: [],
    dependencies: [],
    edges: [],
    files: [],
    routes: [],
    symbols: [],
    testMappings: [],
  };
  const languages = new Set<CodeLanguage>();
  const typeScriptSources: TypeScriptSourceExtraction[] = [];

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
    if (isPackageJsonPath(path)) {
      recordGroups.dependencies.push(
        ...dependencyRecordsForPackageJson(input.repoId, input.commitSha, path, content),
      );
      continue;
    }

    const language = languageForPath(path);
    const file = fileRecord(input.repoId, input.commitSha, path, language, content);
    if (language === "python") {
      const symbols = collectPythonSymbols(file, content);

      recordGroups.files.push(file);
      recordGroups.symbols.push(...symbols);
      recordGroups.chunks.push(...chunkRecordsForFile(file, content, symbols));
      recordGroups.routes.push(...pythonRouteRecordsForFile(file, content, symbols));
      recordGroups.edges.push(
        ...pythonEdgeRecordsForFile(input.repoId, input.commitSha, file.fileId, content, symbols),
      );
      languages.add(language);
      continue;
    }

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
    recordGroups.routes.push(...routeRecordsForFile(file, sourceFile, symbols));
    recordGroups.edges.push(
      ...edgeRecordsForFile(
        input.repoId,
        input.commitSha,
        file.fileId,
        path,
        sourceFile,
        symbols,
        moduleAliases,
      ),
    );
    typeScriptSources.push({ file, sourceFile, symbols });
    languages.add(language);
  }

  const filesByPath = new Map(recordGroups.files.map((file) => [file.path, file]));
  recordGroups.edges.push(
    ...resolvedImportEdgesForSources(
      input.repoId,
      input.commitSha,
      typeScriptSources,
      filesByPath,
      moduleAliases,
    ),
    ...importedCallEdgesForSources(
      input.repoId,
      input.commitSha,
      typeScriptSources,
      filesByPath,
      moduleAliases,
    ),
  );
  recordGroups.testMappings.push(
    ...testMappingRecordsForFiles(input.repoId, input.commitSha, recordGroups.files),
  );
  const records = orderedIndexRecords(recordGroups);

  return {
    manifest: {
      schemaVersion: INDEX_ARTIFACT_SCHEMA_VERSION,
      recordSchemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      artifactId: createStableId("art", [
        input.repoId,
        input.commitSha,
        INDEXER_NAME,
        INDEXER_VERSION,
      ]),
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
      parserVersions: parserVersionsFor(languages),
      ...(input.previousIndexVersionId ? { previousIndexId: input.previousIndexVersionId } : {}),
    },
    records,
  };
}

/** Builds parser version metadata for languages present in the emitted artifact. */
function parserVersionsFor(languages: ReadonlySet<CodeLanguage>): Record<string, string> {
  const parserVersions: Record<string, string> = {};
  if (
    languages.has("typescript") ||
    languages.has("javascript") ||
    languages.has("tsx") ||
    languages.has("jsx")
  ) {
    parserVersions.typescript = ts.version;
  }
  if (languages.has("python")) {
    parserVersions.python = PYTHON_PARSER_VERSION;
  }

  return parserVersions;
}

/** Returns records in the canonical artifact type order required by the schema spec. */
function orderedIndexRecords(groups: TypeScriptIndexRecordGroups): IndexRecord[] {
  return [
    ...groups.files,
    ...groups.symbols,
    ...groups.chunks,
    ...groups.dependencies,
    ...groups.routes,
    ...groups.testMappings,
    ...groups.edges,
  ];
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

/** Finds source and package manifest paths that can produce index records. */
async function findIndexablePaths(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        return [];
      }
      if (entry.isDirectory()) {
        return shouldSkipDirectory(path) ? [] : findIndexablePaths(root, path);
      }
      if (!isIndexablePath(path)) {
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
    fileId: createStableId("file", [repoId, commitSha, path]),
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
        symbolId: createStableId("sym", [
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

/** Extracts conservative class, function, and method symbols from Python source text. */
function collectPythonSymbols(file: FileRecord, content: string): SymbolRecord[] {
  const lines = content.split("\n");
  const candidates = pythonSymbolCandidates(lines);

  return candidates.map((candidate) => {
    const range = {
      endLine: pythonSymbolEndLine(lines, candidate),
      startLine: candidate.startLine,
    };

    return {
      commitSha: file.commitSha,
      contentHash: sha256(textForLineRange(content, range)),
      fileId: file.fileId,
      kind: candidate.kind,
      language: file.language,
      name: candidate.name,
      path: file.path,
      qualifiedName: candidate.qualifiedName,
      range,
      repoId: file.repoId,
      schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      selectionRange: range,
      signature: candidate.signature,
      symbolId: createStableId("sym", [
        file.repoId,
        file.commitSha,
        file.path,
        candidate.qualifiedName,
        range.startLine,
      ]),
      type: "symbol",
      visibility: "unknown",
    };
  });
}

/** Finds Python declarations with enough structure to emit stable symbols. */
function pythonSymbolCandidates(lines: readonly string[]): PythonSymbolCandidate[] {
  const candidates: PythonSymbolCandidate[] = [];
  const stack: PythonSymbolStackEntry[] = [];

  lines.forEach((line, index) => {
    const candidate = pythonDeclarationCandidate(line, index + 1, stack);
    if (!candidate) {
      return;
    }

    while (stack.length > 0 && (stack.at(-1)?.indent ?? -1) >= candidate.indent) {
      stack.pop();
    }

    const qualifiedName = [...stack.map((entry) => entry.name), candidate.name].join(".");
    const symbol = { ...candidate, qualifiedName };

    candidates.push(symbol);
    stack.push({
      indent: candidate.indent,
      kind: candidate.kind,
      name: candidate.name,
    });
  });

  return candidates;
}

/** Converts one Python declaration line into a symbol candidate when supported. */
function pythonDeclarationCandidate(
  line: string,
  lineNumber: number,
  stack: readonly PythonSymbolStackEntry[],
): Omit<PythonSymbolCandidate, "qualifiedName"> | undefined {
  const classMatch = line.match(/^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\b[^:]*:/);
  if (classMatch?.[1] !== undefined && classMatch[2]) {
    return {
      indent: pythonIndent(classMatch[1]),
      kind: "class",
      name: classMatch[2],
      signature: line.trim(),
      startLine: lineNumber,
    };
  }

  const functionMatch = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\b[^:]*:/);
  if (functionMatch?.[1] === undefined || !functionMatch[2]) {
    return undefined;
  }

  const indent = pythonIndent(functionMatch[1]);
  const parent = [...stack].reverse().find((entry) => entry.indent < indent);

  return {
    indent,
    kind: parent?.kind === "class" ? "method" : "function",
    name: functionMatch[2],
    signature: line.trim(),
    startLine: lineNumber,
  };
}

/** Computes a Python declaration end line from indentation boundaries. */
function pythonSymbolEndLine(lines: readonly string[], candidate: PythonSymbolCandidate): number {
  let lastContentLine = candidate.startLine;

  for (let lineNumber = candidate.startLine + 1; lineNumber <= lines.length; lineNumber += 1) {
    const line = lines[lineNumber - 1] ?? "";
    if (line.trim().length === 0) {
      continue;
    }
    if (pythonIndent(line.match(/^\s*/)?.[0] ?? "") <= candidate.indent) {
      break;
    }
    lastContentLine = lineNumber;
  }

  return Math.max(candidate.startLine, lastContentLine);
}

/** Converts Python leading whitespace into a deterministic indentation value. */
function pythonIndent(leadingWhitespace: string): number {
  return leadingWhitespace.replaceAll("\t", "    ").length;
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
  const text = textForLineRange(content, range);
  return {
    type: "chunk",
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    chunkId: createStableId("chunk", [
      file.fileId,
      symbolId ?? "file",
      range.startLine,
      range.endLine,
    ]),
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

/** Returns source text covered by a 1-based line range. */
function textForLineRange(
  content: string,
  range: { readonly startLine: number; readonly endLine: number },
): string {
  return content
    .split("\n")
    .slice(range.startLine - 1, range.endLine)
    .join("\n");
}

/** Extracts dependency records from a package.json document. */
function dependencyRecordsForPackageJson(
  repoId: string,
  commitSha: string,
  manifestPath: string,
  content: string,
): DependencyRecord[] {
  const manifest = parseJsonObject(content);
  if (!manifest) {
    return [];
  }

  const packageManager = packageManagerName(manifest);

  return packageDependencySections.flatMap(({ dependencyType, fieldName }) => {
    const dependencies = stringRecord(manifest[fieldName]);
    if (!dependencies) {
      return [];
    }

    return Object.entries(dependencies)
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
      .map(([name, versionSpec]) => ({
        commitSha,
        dependencyId: createStableId("dep", [
          repoId,
          commitSha,
          manifestPath,
          dependencyType,
          name,
        ]),
        dependencyType,
        manifestPath,
        metadata: { packageJsonField: fieldName },
        name,
        ...(packageManager ? { packageManager } : {}),
        repoId,
        schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
        type: "dependency" as const,
        versionSpec,
      }));
  });
}

/** Parses a JSON document into an object without throwing for malformed input. */
function parseJsonObject(content: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value = JSON.parse(content) as unknown;
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Returns a package manager name declared by package.json when present. */
function packageManagerName(manifest: Readonly<Record<string, unknown>>): string | undefined {
  const packageManager = manifest.packageManager;
  if (typeof packageManager !== "string") {
    return undefined;
  }

  const trimmed = packageManager.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const versionDelimiter = trimmed.lastIndexOf("@");
  return versionDelimiter > 0 ? trimmed.slice(0, versionDelimiter) : trimmed;
}

/** Reads a package.json dependency field as a string-to-string map. */
function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, entryValue]) => [key, entryValue.trim()] as const)
    .filter(([, entryValue]) => entryValue.length > 0);

  return Object.fromEntries(entries);
}

/** Returns whether a JSON value is a non-array object. */
function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Loads simple module-resolution aliases from root tsconfig/jsconfig files. */
async function loadTypeScriptModuleAliases(
  workspacePath: string,
): Promise<ModuleResolutionAlias[]> {
  const aliases = await Promise.all(
    TYPESCRIPT_CONFIG_FILE_NAMES.map(async (fileName) => {
      try {
        const content = await readFile(join(workspacePath, fileName), "utf8");
        return moduleAliasesFromTypeScriptConfig(content);
      } catch {
        return [];
      }
    }),
  );

  return uniqueModuleResolutionAliases(aliases.flat());
}

/** Extracts simple paths aliases from one tsconfig/jsconfig document. */
function moduleAliasesFromTypeScriptConfig(content: string): ModuleResolutionAlias[] {
  const config = parseJsonObject(content);
  const compilerOptions = isJsonObject(config?.compilerOptions)
    ? config.compilerOptions
    : undefined;
  const paths = isJsonObject(compilerOptions?.paths) ? compilerOptions.paths : undefined;
  if (!paths) {
    return [];
  }

  const baseUrl = typeof compilerOptions?.baseUrl === "string" ? compilerOptions.baseUrl : "";
  if (isAbsoluteLikeConfigPath(baseUrl)) {
    return [];
  }
  const normalizedBaseUrl = normalizeRepoPath(baseUrl) ?? "";

  return Object.entries(paths)
    .sort(([leftPattern], [rightPattern]) => leftPattern.localeCompare(rightPattern))
    .flatMap(([pattern, targets]) =>
      stringArray(targets).flatMap((target) =>
        moduleResolutionAliasFromPathsEntry(pattern, target, normalizedBaseUrl),
      ),
    );
}

/** Converts one paths entry into a supported simple alias. */
function moduleResolutionAliasFromPathsEntry(
  pattern: string,
  target: string,
  baseUrl: string,
): ModuleResolutionAlias[] {
  if (isAbsoluteLikeConfigPath(target)) {
    return [];
  }

  const splitPattern = splitSingleWildcardPattern(pattern);
  const normalizedTarget = normalizeRepoPath(joinRepoPath(baseUrl, target));
  const splitTarget = normalizedTarget ? splitSingleWildcardPattern(normalizedTarget) : undefined;
  if (!splitPattern || !splitTarget) {
    return [];
  }

  return [
    {
      pattern,
      patternPrefix: splitPattern.prefix,
      patternSuffix: splitPattern.suffix,
      target,
      targetPrefix: splitTarget.prefix,
      targetSuffix: splitTarget.suffix,
    },
  ];
}

/** Returns whether a config path is absolute or drive-qualified. */
function isAbsoluteLikeConfigPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[/\\]/u.test(path);
}

/** Splits an exact or single-wildcard path mapping pattern. */
function splitSingleWildcardPattern(
  pattern: string,
): { readonly prefix: string; readonly suffix: string } | undefined {
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex < 0) {
    return { prefix: pattern, suffix: "" };
  }
  if (pattern.indexOf("*", wildcardIndex + 1) >= 0) {
    return undefined;
  }

  return {
    prefix: pattern.slice(0, wildcardIndex),
    suffix: pattern.slice(wildcardIndex + 1),
  };
}

/** Reads a JSON value as a sorted array of non-empty strings. */
function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .sort()
    : [];
}

/** Drops duplicate aliases while preserving deterministic priority order. */
function uniqueModuleResolutionAliases(
  aliases: readonly ModuleResolutionAlias[],
): ModuleResolutionAlias[] {
  const seen = new Set<string>();

  return aliases.filter((alias) => {
    const key = [alias.pattern, alias.target].join("\0");
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

/** Emits file-to-file import edges for relative imports that resolve to indexed files. */
function resolvedImportEdgesForSources(
  repoId: string,
  commitSha: string,
  sources: readonly TypeScriptSourceExtraction[],
  filesByPath: ReadonlyMap<string, FileRecord>,
  moduleAliases: readonly ModuleResolutionAlias[],
): EdgeRecord[] {
  return uniqueEdges(
    sources.flatMap((source) =>
      typeScriptImportModuleFacts(source.sourceFile).flatMap((fact) => {
        const resolvedModule = resolveModuleFile(
          source.file.path,
          fact.moduleSpecifier,
          filesByPath,
          moduleAliases,
        );
        if (!resolvedModule) {
          return [];
        }

        return [
          {
            type: "edge" as const,
            schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
            edgeId: createStableId("edge", [
              repoId,
              commitSha,
              source.file.fileId,
              "imports",
              resolvedModule.file.fileId,
              fact.lineNumber,
            ]),
            repoId,
            commitSha,
            fromId: source.file.fileId,
            toId: resolvedModule.file.fileId,
            fromKind: "file" as const,
            toKind: "file" as const,
            kind: "imports" as const,
            confidence: 0.9,
            metadata: {
              ...(resolvedModule.aliasPattern ? { aliasPattern: resolvedModule.aliasPattern } : {}),
              importPath: fact.moduleSpecifier,
              lineNumber: fact.lineNumber,
              resolution: resolvedModule.resolution,
              resolvedPath: resolvedModule.file.path,
            },
          },
        ];
      }),
    ),
  );
}

/** Emits symbol call edges for direct calls through simple named relative imports. */
function importedCallEdgesForSources(
  repoId: string,
  commitSha: string,
  sources: readonly TypeScriptSourceExtraction[],
  filesByPath: ReadonlyMap<string, FileRecord>,
  moduleAliases: readonly ModuleResolutionAlias[],
): EdgeRecord[] {
  const symbolsByPathAndName = symbolsByFilePathAndName(
    sources.flatMap((source) => source.symbols),
  );

  return uniqueEdges(
    sources.flatMap((source) => {
      const importsByLocalName = new Map(
        typeScriptImportBindingFacts(source.sourceFile).map((fact) => [fact.localName, fact]),
      );

      return typeScriptDirectCallFacts(source.sourceFile).flatMap((fact) => {
        const importFact = importsByLocalName.get(fact.calleeName);
        if (!importFact) {
          return [];
        }

        const resolvedModule = resolveModuleFile(
          source.file.path,
          importFact.moduleSpecifier,
          filesByPath,
          moduleAliases,
        );
        if (!resolvedModule) {
          return [];
        }

        const callee = symbolsByPathAndName
          .get(resolvedModule.file.path)
          ?.get(importFact.importedName);
        const caller = symbolContainingLine(source.symbols, fact.lineNumber);
        if (!caller || !callee || caller.symbolId === callee.symbolId) {
          return [];
        }

        return [
          {
            type: "edge" as const,
            schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
            edgeId: createStableId("edge", [
              repoId,
              commitSha,
              caller.symbolId,
              "calls",
              callee.symbolId,
              "imported",
              fact.lineNumber,
            ]),
            repoId,
            commitSha,
            fromId: caller.symbolId,
            toId: callee.symbolId,
            fromKind: "symbol" as const,
            toKind: "symbol" as const,
            kind: "calls" as const,
            confidence: 0.9,
            metadata: {
              ...(resolvedModule.aliasPattern ? { aliasPattern: resolvedModule.aliasPattern } : {}),
              importedName: importFact.importedName,
              importPath: importFact.moduleSpecifier,
              lineNumber: fact.lineNumber,
              localName: importFact.localName,
              resolution: resolvedModule.resolution,
              resolvedPath: resolvedModule.file.path,
            },
          },
        ];
      });
    }),
  );
}

/** Extracts module specifier facts from TS/JS import declarations. */
function typeScriptImportModuleFacts(sourceFile: ts.SourceFile): TypeScriptImportModuleFact[] {
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return [];
    }

    return [
      {
        lineNumber: lineRange(sourceFile, statement).startLine,
        moduleSpecifier: statement.moduleSpecifier.text,
      },
    ];
  });
}

/** Extracts named import bindings from TS/JS import declarations. */
function typeScriptImportBindingFacts(sourceFile: ts.SourceFile): TypeScriptImportBindingFact[] {
  return sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause?.isTypeOnly
    ) {
      return [];
    }

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      return [];
    }

    const lineNumber = lineRange(sourceFile, statement).startLine;
    const moduleSpecifier = statement.moduleSpecifier.text;
    return namedBindings.elements.flatMap((specifier) => {
      if (specifier.isTypeOnly) {
        return [];
      }

      return [
        {
          importedName: specifier.propertyName?.text ?? specifier.name.text,
          lineNumber,
          localName: specifier.name.text,
          moduleSpecifier,
        },
      ];
    });
  });
}

/** Extracts direct identifier call facts from TS/JS source. */
function typeScriptDirectCallFacts(sourceFile: ts.SourceFile): TypeScriptCallFact[] {
  const facts: TypeScriptCallFact[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      facts.push({
        calleeName: node.expression.text,
        lineNumber: lineRange(sourceFile, node).startLine,
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return facts;
}

/** Builds a nested lookup of extracted symbols by file path and local symbol name. */
function symbolsByFilePathAndName(
  symbols: readonly SymbolRecord[],
): ReadonlyMap<string, ReadonlyMap<string, SymbolRecord>> {
  const symbolsByPath = new Map<string, Map<string, SymbolRecord>>();
  for (const symbol of symbols) {
    const symbolsByName = symbolsByPath.get(symbol.path) ?? new Map<string, SymbolRecord>();
    if (!symbolsByPath.has(symbol.path)) {
      symbolsByPath.set(symbol.path, symbolsByName);
    }
    if (!symbolsByName.has(symbol.name)) {
      symbolsByName.set(symbol.name, symbol);
    }
  }

  return symbolsByPath;
}

/** Resolves a TS/JS module specifier to an indexed source file when it is local. */
function resolveModuleFile(
  importerPath: string,
  moduleSpecifier: string,
  filesByPath: ReadonlyMap<string, FileRecord>,
  moduleAliases: readonly ModuleResolutionAlias[],
): ResolvedModuleFile | undefined {
  const relativePath = resolveRelativeModulePath(importerPath, moduleSpecifier);
  const relativeFile = relativePath
    ? indexedSourceFileForModulePath(relativePath, filesByPath)
    : undefined;
  if (relativeFile) {
    return { file: relativeFile, resolution: "relative" };
  }

  return resolveAliasModuleFile(moduleSpecifier, filesByPath, moduleAliases);
}

/** Resolves a module specifier through tsconfig/jsconfig path aliases. */
function resolveAliasModuleFile(
  moduleSpecifier: string,
  filesByPath: ReadonlyMap<string, FileRecord>,
  moduleAliases: readonly ModuleResolutionAlias[],
): ResolvedModuleFile | undefined {
  for (const alias of moduleAliases) {
    const aliasPath = resolveAliasModulePath(moduleSpecifier, alias);
    const file = aliasPath ? indexedSourceFileForModulePath(aliasPath, filesByPath) : undefined;
    if (file) {
      return { aliasPattern: alias.pattern, file, resolution: "alias" };
    }
  }

  return undefined;
}

/** Finds an indexed source file for a resolved module path candidate. */
function indexedSourceFileForModulePath(
  resolvedPath: string,
  filesByPath: ReadonlyMap<string, FileRecord>,
): FileRecord | undefined {
  for (const candidate of relativeModulePathCandidates(resolvedPath)) {
    const file = filesByPath.get(candidate);
    if (file && isSupportedSourcePath(file.path)) {
      return file;
    }
  }

  return undefined;
}

/** Resolves a non-relative module specifier through one paths alias. */
function resolveAliasModulePath(
  moduleSpecifier: string,
  alias: ModuleResolutionAlias,
): string | undefined {
  if (!alias.pattern.includes("*")) {
    return moduleSpecifier === alias.pattern
      ? normalizeRepoPath(`${alias.targetPrefix}${alias.targetSuffix}`)
      : undefined;
  }

  if (
    !moduleSpecifier.startsWith(alias.patternPrefix) ||
    !moduleSpecifier.endsWith(alias.patternSuffix)
  ) {
    return undefined;
  }

  const wildcard = moduleSpecifier.slice(
    alias.patternPrefix.length,
    moduleSpecifier.length - alias.patternSuffix.length,
  );

  return normalizeRepoPath(`${alias.targetPrefix}${wildcard}${alias.targetSuffix}`);
}

/** Resolves a relative import path against a POSIX repository path. */
function resolveRelativeModulePath(
  importerPath: string,
  moduleSpecifier: string,
): string | undefined {
  if (!isRelativeModuleSpecifier(moduleSpecifier)) {
    return undefined;
  }

  const normalized = normalizeRepoPath(joinRepoPath(pathDirectory(importerPath), moduleSpecifier));
  return normalized && !normalized.startsWith("../") && normalized !== ".."
    ? normalized
    : undefined;
}

/** Returns candidate source paths for a resolved extensionless module path. */
function relativeModulePathCandidates(path: string): readonly string[] {
  if (sourceExtension(path)) {
    return [path];
  }

  return [
    ...moduleResolutionExtensions.map((extension) => `${path}${extension}`),
    ...moduleResolutionExtensions.map((extension) => `${path}/index${extension}`),
  ];
}

/** Returns whether a module specifier points to a relative module path. */
function isRelativeModuleSpecifier(moduleSpecifier: string): boolean {
  return moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../");
}

/** Returns whether a module specifier matches any configured local alias pattern. */
function moduleSpecifierMatchesAlias(
  moduleSpecifier: string,
  moduleAliases: readonly ModuleResolutionAlias[],
): boolean {
  return moduleAliases.some(
    (alias) =>
      (!alias.pattern.includes("*") && moduleSpecifier === alias.pattern) ||
      (alias.pattern.includes("*") &&
        moduleSpecifier.startsWith(alias.patternPrefix) &&
        moduleSpecifier.endsWith(alias.patternSuffix)),
  );
}

/** Normalizes a POSIX repository path without allowing an absolute result. */
function normalizeRepoPath(path: string): string | undefined {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return undefined;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.length > 0 ? segments.join("/") : undefined;
}

/** Emits route records for clear TypeScript and JavaScript framework patterns. */
function routeRecordsForFile(
  file: FileRecord,
  sourceFile: ts.SourceFile,
  symbols: readonly SymbolRecord[],
): RouteRecord[] {
  return uniqueRoutes([
    ...routeCallRecordsForFile(file, sourceFile, symbols),
    ...nextJsRouteRecordsForFile(file, symbols),
  ]);
}

/** Emits route records for app/router HTTP method calls with literal paths. */
function routeCallRecordsForFile(
  file: FileRecord,
  sourceFile: ts.SourceFile,
  symbols: readonly SymbolRecord[],
): RouteRecord[] {
  const symbolsByName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
  const routes: RouteRecord[] = [];

  const visit = (node: ts.Node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
      ts.forEachChild(node, visit);
      return;
    }

    const method = httpMethodFromName(node.expression.name.text);
    const routePattern = firstStringArgument(node);
    const receiverText = node.expression.expression.getText(sourceFile);
    const framework = httpRouterFramework(receiverText);
    if (!method || !routePattern || !framework) {
      ts.forEachChild(node, visit);
      return;
    }

    const range = lineRange(sourceFile, node);
    const handler = routeHandlerSymbolForExpression(node.arguments[1], symbolsByName);
    routes.push({
      type: "route",
      schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      routeId: createStableId("route", [
        file.repoId,
        file.commitSha,
        file.fileId,
        "call",
        method,
        routePattern,
        range.startLine,
      ]),
      repoId: file.repoId,
      commitSha: file.commitSha,
      path: file.path,
      language: file.language,
      routePattern,
      methods: [method],
      ...(handler ? { handlerSymbolId: handler.symbolId } : {}),
      range,
      framework,
      confidence: 0.85,
      metadata: { receiver: receiverText },
    });

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return routes;
}

/** Emits Next.js app-router route records from exported HTTP method symbols. */
function nextJsRouteRecordsForFile(
  file: FileRecord,
  symbols: readonly SymbolRecord[],
): RouteRecord[] {
  const routePattern = nextJsRoutePattern(file.path);
  if (!routePattern) {
    return [];
  }

  return symbols
    .filter((symbol) => nextJsRouteMethods.has(symbol.name))
    .map((symbol) => ({
      type: "route" as const,
      schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      routeId: createStableId("route", [
        file.repoId,
        file.commitSha,
        file.fileId,
        "next",
        symbol.name,
      ]),
      repoId: file.repoId,
      commitSha: file.commitSha,
      path: file.path,
      language: file.language,
      routePattern,
      methods: [symbol.name],
      handlerSymbolId: symbol.symbolId,
      range: symbol.range,
      framework: "nextjs",
      confidence: 0.9,
      metadata: { router: "app" },
    }));
}

/** Emits FastAPI/Flask-like route records from Python decorators. */
function pythonRouteRecordsForFile(
  file: FileRecord,
  content: string,
  symbols: readonly SymbolRecord[],
): RouteRecord[] {
  const symbolsByStartLine = new Map(symbols.map((symbol) => [symbol.range.startLine, symbol]));

  return uniqueRoutes(
    pythonRouteDecoratorFacts(content).flatMap((fact) => {
      const handler = symbolsByStartLine.get(fact.handlerLine);
      if (!handler) {
        return [];
      }

      return [
        {
          type: "route" as const,
          schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
          routeId: createStableId("route", [
            file.repoId,
            file.commitSha,
            file.fileId,
            "python-decorator",
            fact.method,
            fact.routePattern,
            fact.decoratorLine,
          ]),
          repoId: file.repoId,
          commitSha: file.commitSha,
          path: file.path,
          language: file.language,
          routePattern: fact.routePattern,
          methods: [fact.method],
          handlerSymbolId: handler.symbolId,
          range: handler.range,
          framework: "python-web",
          confidence: 0.85,
          metadata: {
            decorator: fact.decorator,
            decoratorLine: fact.decoratorLine,
            receiver: fact.receiver,
          },
        },
      ];
    }),
  );
}

/** Extracts Python route decorators and the handler line they decorate. */
function pythonRouteDecoratorFacts(content: string): PythonRouteDecoratorFact[] {
  const facts: PythonRouteDecoratorFact[] = [];
  let pendingDecorators: PythonRouteDecoratorFact[] = [];

  content.split("\n").forEach((line, index) => {
    const lineNumber = index + 1;
    const statement = stripPythonInlineComment(line).trim();
    if (statement.length === 0 || statement.startsWith("#")) {
      return;
    }

    const decoratorFact = pythonRouteDecoratorFactFromLine(statement, lineNumber);
    if (decoratorFact) {
      pendingDecorators = [...pendingDecorators, decoratorFact];
      return;
    }

    if (/^(?:async\s+)?def\s+[A-Za-z_][A-Za-z0-9_]*\b/u.test(statement)) {
      facts.push(
        ...pendingDecorators.map((fact) => ({
          ...fact,
          handlerLine: lineNumber,
        })),
      );
    }

    pendingDecorators = [];
  });

  return facts;
}

/** Converts one Python decorator line into a route fact when it is clear. */
function pythonRouteDecoratorFactFromLine(
  statement: string,
  lineNumber: number,
): PythonRouteDecoratorFact | undefined {
  const match = statement.match(
    /^@([A-Za-z_][A-Za-z0-9_]*)\.(delete|get|head|options|patch|post|put)\(\s*(["'])(.*?)\3/u,
  );
  if (!match?.[1] || !match[2] || !match[4]?.startsWith("/")) {
    return undefined;
  }

  return {
    decorator: statement,
    decoratorLine: lineNumber,
    handlerLine: lineNumber,
    method: match[2].toUpperCase(),
    receiver: match[1],
    routePattern: match[4],
  };
}

/** Returns a route pattern from the first call argument when it is a literal path. */
function firstStringArgument(node: ts.CallExpression): string | undefined {
  const firstArgument = node.arguments[0];
  if (
    !firstArgument ||
    (!ts.isStringLiteral(firstArgument) && !ts.isNoSubstitutionTemplateLiteral(firstArgument))
  ) {
    return undefined;
  }

  return firstArgument.text.startsWith("/") ? firstArgument.text : undefined;
}

/** Resolves a handler expression to an extracted same-file symbol when possible. */
function routeHandlerSymbolForExpression(
  expression: ts.Expression | undefined,
  symbolsByName: ReadonlyMap<string, SymbolRecord>,
): SymbolRecord | undefined {
  if (!expression || !ts.isIdentifier(expression)) {
    return undefined;
  }

  return symbolsByName.get(expression.text);
}

/** Converts a framework method property name into an uppercase HTTP method. */
function httpMethodFromName(name: string): string | undefined {
  return httpRouteMethods.has(name) ? name.toUpperCase() : undefined;
}

/** Classifies supported router receivers and filters out unrelated `.get()` calls. */
function httpRouterFramework(receiverText: string): string | undefined {
  if (receiverText.includes("Elysia")) {
    return "elysia";
  }

  const receiver = receiverText.trim().toLowerCase();
  if (receiver === "fastify") {
    return "fastify";
  }
  if (receiver === "app" || receiver === "router" || receiver === "server") {
    return "http-router";
  }

  return undefined;
}

/** Returns a Next.js app-router path pattern for route module paths. */
function nextJsRoutePattern(path: string): string | undefined {
  const match = path.match(/(?:^|\/)app(?:\/(.+))?\/route\.[cm]?[jt]sx?$/u);
  if (!match) {
    return undefined;
  }

  return routePatternFromSegments(match[1]?.split("/") ?? []);
}

/** Converts framework path segments into an HTTP route pattern. */
function routePatternFromSegments(segments: readonly string[]): string {
  const routeSegments = segments
    .filter((segment) => segment.length > 0 && !segment.startsWith("(") && !segment.startsWith("@"))
    .map((segment) => {
      const optionalCatchAll = segment.match(/^\[\[\.\.\.([A-Za-z0-9_-]+)\]\]$/u);
      if (optionalCatchAll?.[1]) {
        return `*${optionalCatchAll[1]}`;
      }

      const catchAll = segment.match(/^\[\.\.\.([A-Za-z0-9_-]+)\]$/u);
      if (catchAll?.[1]) {
        return `*${catchAll[1]}`;
      }

      const dynamic = segment.match(/^\[([A-Za-z0-9_-]+)\]$/u);
      return dynamic?.[1] ? `:${dynamic[1]}` : segment;
    });

  return routeSegments.length === 0 ? "/" : `/${routeSegments.join("/")}`;
}

/** Drops duplicate route IDs while preserving deterministic order. */
function uniqueRoutes(routes: readonly RouteRecord[]): RouteRecord[] {
  const seen = new Set<string>();

  return routes.filter((route) => {
    if (seen.has(route.routeId)) {
      return false;
    }

    seen.add(route.routeId);
    return true;
  });
}

/** Emits simple test-to-source mappings when a unique target file exists. */
function testMappingRecordsForFiles(
  repoId: string,
  commitSha: string,
  files: readonly FileRecord[],
): TestMappingRecord[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));

  return files.flatMap((testFile) => {
    if (!testFile.isTest) {
      return [];
    }

    const candidate = matchingTestTargetCandidate(testFile.path, filesByPath);
    const targetFile = candidate ? filesByPath.get(candidate.path) : undefined;
    if (!candidate || !targetFile || targetFile.isTest) {
      return [];
    }

    return [
      {
        type: "test_mapping" as const,
        schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
        testMappingId: createStableId("testmap", [
          repoId,
          commitSha,
          testFile.fileId,
          targetFile.fileId,
        ]),
        repoId,
        commitSha,
        testFileId: testFile.fileId,
        targetFileId: targetFile.fileId,
        confidence: candidate.confidence,
        metadata: {
          heuristic: candidate.heuristic,
          targetPath: targetFile.path,
          testPath: testFile.path,
        },
      },
    ];
  });
}

/** Finds the first candidate that points to an indexed file. */
function matchingTestTargetCandidate(
  testPath: string,
  filesByPath: ReadonlyMap<string, FileRecord>,
): TestTargetCandidate | undefined {
  return testTargetCandidatesForPath(testPath).find((candidate) => filesByPath.has(candidate.path));
}

/** Produces deterministic source candidates for one test file path. */
function testTargetCandidatesForPath(testPath: string): readonly TestTargetCandidate[] {
  const fileName = pathFileName(testPath);
  const directory = pathDirectory(testPath);
  const testName = testBaseName(fileName);
  const extension = sourceExtension(fileName);
  if (!testName || !extension) {
    return [];
  }

  const candidates: TestTargetCandidate[] = [];
  const directDirectory = directory
    .split("/")
    .filter((segment) => segment !== "__tests__")
    .join("/");
  for (const path of sourcePathVariants(joinRepoPath(directDirectory, testName), extension)) {
    candidates.push({ confidence: 0.9, heuristic: "same-directory-test-name", path });
  }

  const testDirectoryIndex = directory
    .split("/")
    .findIndex((segment) => segment === "test" || segment === "tests");
  if (testDirectoryIndex >= 0) {
    const suffix = directory
      .split("/")
      .slice(testDirectoryIndex + 1)
      .join("/");
    const suffixBasePath = joinRepoPath(suffix, testName);
    for (const root of ["src", "app", ""]) {
      for (const path of sourcePathVariants(joinRepoPath(root, suffixBasePath), extension)) {
        candidates.push({ confidence: 0.75, heuristic: "mirrored-test-directory", path });
      }
    }
  }

  return uniqueTestTargetCandidates(candidates).filter((candidate) => candidate.path !== testPath);
}

/** Returns the production base name implied by a test file name. */
function testBaseName(fileName: string): string | undefined {
  const extension = sourceExtension(fileName);
  if (!extension) {
    return undefined;
  }

  const baseName = fileName.slice(0, -extension.length);
  const normalized = baseName
    .replace(/\.(test|spec)$/u, "")
    .replace(/^test_/u, "")
    .replace(/_test$/u, "");

  return normalized.length > 0 && normalized !== baseName ? normalized : undefined;
}

/** Returns source path variants that may match a test target. */
function sourcePathVariants(basePath: string, extension: string): readonly string[] {
  if (extension === ".py") {
    return [`${basePath}.py`];
  }

  const extensionGroup =
    extension === ".tsx" || extension === ".ts" ? [".ts", ".tsx"] : [".js", ".jsx", ".mjs", ".cjs"];

  return extensionGroup.map((candidateExtension) => `${basePath}${candidateExtension}`);
}

/** Returns a supported source extension for source and test files. */
function sourceExtension(path: string): string | undefined {
  const match = path.match(/(\.[cm]?js|\.jsx|\.tsx|\.ts|\.py)$/u);
  return match?.[1];
}

/** Joins repository path parts without introducing absolute paths. */
function joinRepoPath(...parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join("/");
}

/** Returns the final path segment of a POSIX repository path. */
function pathFileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** Returns the directory portion of a POSIX repository path. */
function pathDirectory(path: string): string {
  const segments = path.split("/");
  return segments.length > 1 ? segments.slice(0, -1).join("/") : "";
}

/** Drops duplicate test target candidates by path while preserving priority order. */
function uniqueTestTargetCandidates(
  candidates: readonly TestTargetCandidate[],
): TestTargetCandidate[] {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) {
      return false;
    }

    seen.add(candidate.path);
    return true;
  });
}

function edgeRecordsForFile(
  repoId: string,
  commitSha: string,
  fileId: string,
  path: string,
  sourceFile: ts.SourceFile,
  symbols: readonly SymbolRecord[],
  moduleAliases: readonly ModuleResolutionAlias[],
): EdgeRecord[] {
  const edges: EdgeRecord[] = [];

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !isRelativeModuleSpecifier(statement.moduleSpecifier.text) &&
      !moduleSpecifierMatchesAlias(statement.moduleSpecifier.text, moduleAliases)
    ) {
      const toId = `external:${statement.moduleSpecifier.text}`;
      edges.push({
        type: "edge",
        schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
        edgeId: createStableId("edge", [repoId, commitSha, fileId, "imports", toId]),
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

  return uniqueEdges([
    ...edges,
    ...callEdgesForFile(repoId, commitSha, sourceFile, symbols),
    ...defineEdgesForSymbols(repoId, commitSha, fileId, symbols),
  ]);
}

/** Emits Python import, same-file call, and define edges for one source file. */
function pythonEdgeRecordsForFile(
  repoId: string,
  commitSha: string,
  fileId: string,
  content: string,
  symbols: readonly SymbolRecord[],
): EdgeRecord[] {
  return uniqueEdges([
    ...pythonImportFacts(content).map((fact) => pythonImportEdge(repoId, commitSha, fileId, fact)),
    ...pythonCallEdgesForFile(repoId, commitSha, content, symbols),
    ...defineEdgesForSymbols(repoId, commitSha, fileId, symbols),
  ]);
}

/** Emits file-to-symbol definition edges for symbols extracted from one file. */
function defineEdgesForSymbols(
  repoId: string,
  commitSha: string,
  fileId: string,
  symbols: readonly SymbolRecord[],
): EdgeRecord[] {
  return symbols.map((symbol) => ({
    type: "edge" as const,
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    edgeId: createStableId("edge", [repoId, commitSha, fileId, "defines", symbol.symbolId]),
    repoId,
    commitSha,
    fromId: fileId,
    toId: symbol.symbolId,
    fromKind: "file" as const,
    toKind: "symbol" as const,
    kind: "defines" as const,
    confidence: 1,
  }));
}

/** Drops duplicate edge IDs while preserving deterministic order. */
function uniqueEdges(edges: readonly EdgeRecord[]): EdgeRecord[] {
  const seen = new Set<string>();

  return edges.filter((edge) => {
    if (seen.has(edge.edgeId)) {
      return false;
    }

    seen.add(edge.edgeId);
    return true;
  });
}

/** Converts one Python import fact into a file-to-external import edge. */
function pythonImportEdge(
  repoId: string,
  commitSha: string,
  fileId: string,
  fact: PythonImportFact,
): EdgeRecord {
  const toId = `external:${fact.moduleName}`;

  return {
    type: "edge",
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    edgeId: createStableId("edge", [repoId, commitSha, fileId, "imports", toId, fact.lineNumber]),
    repoId,
    commitSha,
    fromId: fileId,
    toId,
    fromKind: "file",
    toKind: "external",
    kind: "imports",
    confidence: 1,
    metadata: {
      importedNames: [...fact.importedNames],
      lineNumber: fact.lineNumber,
      syntax: fact.syntax,
    },
  };
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
          edgeId: createStableId("edge", [
            repoId,
            commitSha,
            caller.symbolId,
            "calls",
            callee.symbolId,
          ]),
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

/** Extracts import statements from Python source text. */
function pythonImportFacts(content: string): PythonImportFact[] {
  return content.split("\n").flatMap((line, index): PythonImportFact[] => {
    const lineNumber = index + 1;
    const statement = stripPythonInlineComment(line).trim();
    if (statement.length === 0) {
      return [];
    }

    const importMatch = statement.match(/^import\s+(.+)$/);
    if (importMatch?.[1]) {
      return importedNamesFromPythonList(importMatch[1]).map((moduleName) => ({
        importedNames: [],
        lineNumber,
        moduleName,
        syntax: "import" as const,
      }));
    }

    const fromImportMatch = statement.match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
    if (!fromImportMatch?.[1] || !fromImportMatch[2]) {
      return [];
    }

    const importedNames = importedNamesFromPythonList(fromImportMatch[2]);
    return [
      {
        importedNames,
        lineNumber,
        moduleName: fromImportMatch[1],
        syntax: "from_import" as const,
      },
    ];
  });
}

/** Extracts direct same-file Python call edges from source text. */
function pythonCallEdgesForFile(
  repoId: string,
  commitSha: string,
  content: string,
  symbols: readonly SymbolRecord[],
): EdgeRecord[] {
  const symbolsByName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
  const edges: EdgeRecord[] = [];

  for (const fact of pythonCallFacts(content)) {
    const caller = symbolContainingLine(symbols, fact.lineNumber);
    const callee = symbolsByName.get(fact.calleeName);
    if (!caller || !callee || caller.symbolId === callee.symbolId) {
      continue;
    }

    edges.push({
      type: "edge",
      schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      edgeId: createStableId("edge", [
        repoId,
        commitSha,
        caller.symbolId,
        "calls",
        callee.symbolId,
        fact.lineNumber,
      ]),
      repoId,
      commitSha,
      fromId: caller.symbolId,
      toId: callee.symbolId,
      fromKind: "symbol",
      toKind: "symbol",
      kind: "calls",
      confidence: 1,
      metadata: { lineNumber: fact.lineNumber },
    });
  }

  return uniqueEdges(edges);
}

/** Extracts direct call identifiers from Python source lines. */
function pythonCallFacts(content: string): PythonCallFact[] {
  return content.split("\n").flatMap((line, index) => {
    const lineNumber = index + 1;
    const statement = stripPythonInlineComment(line).trim();
    if (isNonCallPythonStatement(statement)) {
      return [];
    }

    const facts: PythonCallFact[] = [];
    const callPattern = /(^|[^\w.])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    for (const match of statement.matchAll(callPattern)) {
      const calleeName = match[2];
      if (!calleeName || pythonCallExcludedNames.has(calleeName)) {
        continue;
      }

      facts.push({ calleeName, lineNumber });
    }

    return facts;
  });
}

/** Returns whether a Python line cannot contain a useful direct call edge. */
function isNonCallPythonStatement(statement: string): boolean {
  return (
    statement.length === 0 ||
    statement.startsWith("#") ||
    statement.startsWith("def ") ||
    statement.startsWith("async def ") ||
    statement.startsWith("class ") ||
    statement.startsWith("import ") ||
    statement.startsWith("from ")
  );
}

/** Pulls imported identifiers or modules out of a comma-delimited Python import list. */
function importedNamesFromPythonList(value: string): readonly string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== "*")
    .map((entry) => entry.split(/\s+as\s+/u)[0]?.trim())
    .filter((entry): entry is string => entry !== undefined && entry.length > 0)
    .sort();
}

/** Removes a simple Python inline comment from a source line. */
function stripPythonInlineComment(line: string): string {
  return line.split("#", 1)[0] ?? "";
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
  if (ts.isFunctionDeclaration(node)) {
    return nextJsRouteMethods.has(name) || !/^[A-Z]/.test(name) ? "function" : "component";
  }
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

function isSupportedSourcePath(path: string): boolean {
  return /\.(cjs|cts|js|jsx|mjs|mts|py|ts|tsx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path);
}

/** Returns whether a source or package manifest path should be considered for indexing. */
function isIndexablePath(path: string): boolean {
  return (
    (isSupportedSourcePath(path) || isPackageJsonPath(path)) &&
    !isGeneratedPath(path) &&
    !isVendoredPath(path)
  );
}

/** Returns whether a path points to a package.json manifest. */
function isPackageJsonPath(path: string): boolean {
  return path === PACKAGE_JSON_FILE_NAME || path.endsWith(`/${PACKAGE_JSON_FILE_NAME}`);
}

function languageForPath(path: string): CodeLanguage {
  if (path.endsWith(".py")) return "python";
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
    /\.(generated|gen)\.(?:[cm]?[jt]sx?|py)$/.test(fileName) ||
    fileName.endsWith(".min.js") ||
    fileName.endsWith(".pb.ts") ||
    fileName.endsWith(".graphql.ts")
  );
}

function isTestPath(path: string): boolean {
  return (
    /(^|[/.])(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|[/.])(test|spec)\.py$/.test(path) ||
    /(^|\/)(test_.+|.+_test)\.py$/.test(path) ||
    path.includes("__tests__/") ||
    path.includes("tests/")
  );
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
