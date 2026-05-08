#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChunkRecord,
  diffIndexArtifacts,
  type EdgeRecord,
  type FileRecord,
  INDEX_ARTIFACT_SCHEMA_VERSION,
  INDEX_MANIFEST_FILE_NAME,
  INDEX_RECORD_SCHEMA_VERSION,
  type IndexArtifact,
  type IndexManifest,
  parseIndexManifestJson,
  type SymbolRecord,
  stringifyIndexManifestJson,
  validateIndexArtifact,
} from "./index";
import {
  createIndexArtifactWriter,
  readIndexArtifactPath,
  writeSplitIndexArtifactDirectory,
} from "./node";

/** Minimal writer used by the index-schema CLI runner and tests. */
export type IndexSchemaCliWriter = {
  /** Writes one string chunk to the target stream. */
  readonly write: (chunk: string) => unknown;
};

/** IO streams used by the index-schema CLI runner. */
export type IndexSchemaCliIo = {
  /** Standard output stream. */
  readonly stdout: IndexSchemaCliWriter;
  /** Standard error stream. */
  readonly stderr: IndexSchemaCliWriter;
};

/** Parsed single-artifact command input. */
type ArtifactPathCommand = {
  /** Path to a whole-artifact JSON file or split artifact directory. */
  readonly artifactPath: string;
};

/** Parsed two-artifact diff command input. */
type ArtifactDiffCommand = {
  /** Baseline whole-artifact JSON file or split artifact directory. */
  readonly baselinePath: string;
  /** Candidate whole-artifact JSON file or split artifact directory. */
  readonly candidatePath: string;
};

/** Names of built-in fixtures that the CLI can generate. */
type GeneratedFixtureName =
  | "invalid-bad-checksum"
  | "invalid-bad-path"
  | "invalid-missing-reference"
  | "invalid-out-of-order-records"
  | "invalid-unknown-record-type"
  | "minimal-valid-artifact"
  | "valid-python-artifact"
  | "valid-typescript-artifact";

/** Parsed generate-fixture command input. */
type GenerateFixtureCommand = {
  /** Built-in fixture to generate. */
  readonly fixtureName: GeneratedFixtureName;
  /** Output split artifact directory. */
  readonly outputPath: string;
};

/** Machine-readable validation summary printed by the validate command. */
type ArtifactValidationSummary = {
  /** Artifact ID when the artifact could be read. */
  readonly artifactId?: string;
  /** Number of chunk records declared by the manifest. */
  readonly chunkCount?: number;
  /** Number of edge records declared by the manifest. */
  readonly edgeCount?: number;
  /** Validation error count. */
  readonly errorCount: number;
  /** Validation errors, when validation fails. */
  readonly errors?: readonly string[];
  /** Number of file records declared by the manifest. */
  readonly fileCount?: number;
  /** Total record count declared by the manifest. */
  readonly recordCount?: number;
  /** Number of symbol records declared by the manifest. */
  readonly symbolCount?: number;
  /** Whether the artifact passed schema-owned validation. */
  readonly valid: boolean;
};

/** Machine-readable record-count summary printed by the count-records command. */
type ArtifactRecordCountSummary = {
  /** Artifact ID. */
  readonly artifactId: string;
  /** Number of chunk records declared by the manifest. */
  readonly chunkCount: number;
  /** Number of edge records declared by the manifest. */
  readonly edgeCount: number;
  /** Number of file records declared by the manifest. */
  readonly fileCount: number;
  /** Number of parsed records. */
  readonly parsedRecordCount: number;
  /** Total record count declared by the manifest. */
  readonly recordCount: number;
  /** Number of manifest-declared record files. */
  readonly recordFileCount: number;
  /** Number of symbol records declared by the manifest. */
  readonly symbolCount: number;
};

/** Machine-readable summary printed by the generate-fixture command. */
type GenerateFixtureSummary = {
  /** Artifact ID generated for the fixture. */
  readonly artifactId: string;
  /** Built-in fixture name. */
  readonly fixtureName: GeneratedFixtureName;
  /** Output split artifact directory. */
  readonly outputPath: string;
  /** Total record count declared by the generated manifest. */
  readonly recordCount: number;
  /** Validation errors for intentionally invalid fixtures. */
  readonly errors?: readonly string[];
  /** Whether the generated fixture passed schema-owned validation after writing. */
  readonly valid: boolean;
};

const GENERATED_FIXTURE_NAMES = [
  "invalid-bad-checksum",
  "invalid-bad-path",
  "invalid-missing-reference",
  "invalid-out-of-order-records",
  "invalid-unknown-record-type",
  "minimal-valid-artifact",
  "valid-python-artifact",
  "valid-typescript-artifact",
] as const satisfies readonly GeneratedFixtureName[];

const HELP_TEXT = `Usage:
  index-schema validate <artifact-path>
  index-schema print-manifest <artifact-path>
  index-schema count-records <artifact-path>
  index-schema diff <baseline-artifact> <candidate-artifact>
  index-schema generate-fixture <name> --output <artifact-dir>

Options:
  --artifact <path>  Artifact JSON file or split artifact directory for single-artifact commands.
  --output <path>    Output split artifact directory for generate-fixture.
  --help, -h         Print this help text.

Fixtures:
  ${GENERATED_FIXTURE_NAMES.join(", ")}
`;

/** Runs the index-schema CLI and returns a process-style exit code. */
export async function runIndexSchemaCli(
  argv: readonly string[],
  io: IndexSchemaCliIo = process,
): Promise<number> {
  const [command = "help", ...args] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    io.stdout.write(HELP_TEXT);
    return 0;
  }

  try {
    if (command === "validate") {
      return runValidateCommand(args, io);
    }
    if (command === "print-manifest") {
      return runPrintManifestCommand(args, io);
    }
    if (command === "count-records") {
      return runCountRecordsCommand(args, io);
    }
    if (command === "diff") {
      return runDiffCommand(args, io);
    }
    if (command === "generate-fixture") {
      return runGenerateFixtureCommand(args, io);
    }

    io.stderr.write(`Unknown index-schema command: ${command}\n\n${HELP_TEXT}`);
    return 1;
  } catch (error) {
    io.stderr.write(`Could not run index-schema ${command}: ${errorMessage(error)}\n`);
    return 1;
  }
}

/** Validates a whole or split artifact and prints a JSON summary. */
async function runValidateCommand(args: readonly string[], io: IndexSchemaCliIo): Promise<number> {
  const parsed = parseArtifactPathCommand(args);
  if (!parsed.ok) {
    io[parsed.help ? "stdout" : "stderr"].write(
      `${parsed.message ? `${parsed.message}\n\n` : ""}${HELP_TEXT}`,
    );
    return parsed.help ? 0 : 1;
  }

  const artifactResult = await readArtifactForValidation(resolve(parsed.command.artifactPath));
  if (!artifactResult.ok) {
    io.stdout.write(
      `${JSON.stringify({
        errorCount: artifactResult.errors.length,
        errors: artifactResult.errors,
        valid: false,
      })}\n`,
    );
    return 6;
  }

  const artifact = artifactResult.artifact;
  const errors = validateIndexArtifact(artifact);
  const summary = validationSummary(artifact, errors);

  io.stdout.write(`${JSON.stringify(summary)}\n`);
  return errors.length === 0 ? 0 : 6;
}

/** Prints a parsed artifact manifest as stable two-space JSON. */
async function runPrintManifestCommand(
  args: readonly string[],
  io: IndexSchemaCliIo,
): Promise<number> {
  const parsed = parseArtifactPathCommand(args);
  if (!parsed.ok) {
    io[parsed.help ? "stdout" : "stderr"].write(
      `${parsed.message ? `${parsed.message}\n\n` : ""}${HELP_TEXT}`,
    );
    return parsed.help ? 0 : 1;
  }

  const artifact = await readIndexArtifactPath(resolve(parsed.command.artifactPath));
  io.stdout.write(stringifyIndexManifestJson(artifact.manifest));

  return 0;
}

/** Counts parsed records and prints manifest count fields as JSON. */
async function runCountRecordsCommand(
  args: readonly string[],
  io: IndexSchemaCliIo,
): Promise<number> {
  const parsed = parseArtifactPathCommand(args);
  if (!parsed.ok) {
    io[parsed.help ? "stdout" : "stderr"].write(
      `${parsed.message ? `${parsed.message}\n\n` : ""}${HELP_TEXT}`,
    );
    return parsed.help ? 0 : 1;
  }

  const artifact = await readIndexArtifactPath(resolve(parsed.command.artifactPath));
  io.stdout.write(`${JSON.stringify(recordCountSummary(artifact))}\n`);

  return 0;
}

/** Diffs two readable artifacts and prints the schema-owned diff report as JSON. */
async function runDiffCommand(args: readonly string[], io: IndexSchemaCliIo): Promise<number> {
  const parsed = parseArtifactDiffCommand(args);
  if (!parsed.ok) {
    io[parsed.help ? "stdout" : "stderr"].write(
      `${parsed.message ? `${parsed.message}\n\n` : ""}${HELP_TEXT}`,
    );
    return parsed.help ? 0 : 1;
  }

  const [baseline, candidate] = await Promise.all([
    readIndexArtifactPath(resolve(parsed.command.baselinePath)),
    readIndexArtifactPath(resolve(parsed.command.candidatePath)),
  ]);
  const validationErrors = [
    ...validateIndexArtifact(baseline).map((error) => `baseline: ${error}`),
    ...validateIndexArtifact(candidate).map((error) => `candidate: ${error}`),
  ];
  if (validationErrors.length > 0) {
    io.stdout.write(
      `${JSON.stringify({
        errorCount: validationErrors.length,
        errors: validationErrors,
        valid: false,
      })}\n`,
    );
    return 6;
  }

  io.stdout.write(`${JSON.stringify(diffIndexArtifacts(baseline, candidate))}\n`);
  return 0;
}

/** Generates a built-in split artifact fixture and prints a JSON summary. */
async function runGenerateFixtureCommand(
  args: readonly string[],
  io: IndexSchemaCliIo,
): Promise<number> {
  const parsed = parseGenerateFixtureCommand(args);
  if (!parsed.ok) {
    io[parsed.help ? "stdout" : "stderr"].write(
      `${parsed.message ? `${parsed.message}\n\n` : ""}${HELP_TEXT}`,
    );
    return parsed.help ? 0 : 1;
  }

  const generated = await writeGeneratedFixture(parsed.command);
  const summary = {
    artifactId: generated.artifact.manifest.artifactId,
    fixtureName: parsed.command.fixtureName,
    outputPath: generated.outputPath,
    recordCount: generated.artifact.manifest.recordCount,
    ...(generated.validationErrors.length > 0 ? { errors: generated.validationErrors } : {}),
    valid: generated.validationErrors.length === 0,
  } satisfies GenerateFixtureSummary;

  io.stdout.write(`${JSON.stringify(summary)}\n`);
  return 0;
}

/** Converts an artifact and validation errors into CLI output. */
function validationSummary(
  artifact: IndexArtifact,
  errors: readonly string[],
): ArtifactValidationSummary {
  if (errors.length > 0) {
    return {
      artifactId: artifact.manifest.artifactId,
      errorCount: errors.length,
      errors,
      valid: false,
    };
  }

  return {
    artifactId: artifact.manifest.artifactId,
    chunkCount: artifact.manifest.chunkCount,
    edgeCount: artifact.manifest.edgeCount,
    errorCount: 0,
    fileCount: artifact.manifest.fileCount,
    recordCount: artifact.manifest.recordCount,
    symbolCount: artifact.manifest.symbolCount,
    valid: true,
  };
}

/** Converts an artifact into a count-records output payload. */
function recordCountSummary(artifact: IndexArtifact): ArtifactRecordCountSummary {
  return {
    artifactId: artifact.manifest.artifactId,
    chunkCount: artifact.manifest.chunkCount,
    edgeCount: artifact.manifest.edgeCount,
    fileCount: artifact.manifest.fileCount,
    parsedRecordCount: artifact.records.length,
    recordCount: artifact.manifest.recordCount,
    recordFileCount: artifact.manifest.recordFiles?.length ?? 0,
    symbolCount: artifact.manifest.symbolCount,
  };
}

/** Reads an artifact for validation while keeping read-time failures as validation issues. */
async function readArtifactForValidation(
  artifactPath: string,
): Promise<
  | { readonly ok: true; readonly artifact: IndexArtifact }
  | { readonly ok: false; readonly errors: readonly string[] }
> {
  try {
    return { artifact: await readIndexArtifactPath(artifactPath), ok: true };
  } catch (error) {
    return { errors: [errorMessage(error)], ok: false };
  }
}

/** Writes a built-in fixture artifact and returns validation evidence for the written files. */
async function writeGeneratedFixture(input: GenerateFixtureCommand): Promise<{
  /** Artifact used as the source for fixture generation. */
  readonly artifact: IndexArtifact;
  /** Resolved output artifact directory. */
  readonly outputPath: string;
  /** Schema-owned validation errors observed after writing. */
  readonly validationErrors: readonly string[];
}> {
  const outputPath = resolve(input.outputPath);
  const artifact = generatedFixtureArtifact(input.fixtureName);

  if (input.fixtureName === "invalid-out-of-order-records") {
    await writeSplitIndexArtifactDirectoryWithoutOrdering(outputPath, artifact);
  } else {
    await writeSplitIndexArtifactDirectory(outputPath, artifact);
  }
  if (input.fixtureName === "invalid-bad-checksum") {
    await corruptRecordFileChecksum(outputPath);
  }

  return {
    artifact,
    outputPath,
    validationErrors: await validateGeneratedFixturePath(outputPath),
  };
}

/** Validates a generated fixture path while preserving read-time integrity errors as issues. */
async function validateGeneratedFixturePath(outputPath: string): Promise<readonly string[]> {
  try {
    return validateIndexArtifact(await readIndexArtifactPath(outputPath));
  } catch (error) {
    return [errorMessage(error)];
  }
}

/** Writes a split artifact without enforcing record ordering for invalid fixture generation. */
async function writeSplitIndexArtifactDirectoryWithoutOrdering(
  outputPath: string,
  artifact: IndexArtifact,
): Promise<void> {
  const writer = createIndexArtifactWriter({ artifactDir: outputPath, enforceOrdering: false });
  for (const record of artifact.records) {
    await writer.writeRecord(record);
  }

  await writer.close({
    languages: artifact.manifest.languages,
    manifestBase: manifestBaseFromManifest(artifact.manifest),
  });
}

/** Corrupts the manifest checksum for the canonical record file. */
async function corruptRecordFileChecksum(outputPath: string): Promise<void> {
  const manifestPath = join(outputPath, INDEX_MANIFEST_FILE_NAME);
  const manifest = parseIndexManifestJson(await readFile(manifestPath, "utf8"));
  const recordFiles = manifest.recordFiles ?? [];
  const [recordFile] = recordFiles;
  if (!recordFile) {
    throw new Error("Cannot corrupt checksum for a fixture without recordFiles metadata.");
  }

  await writeFile(
    manifestPath,
    stringifyIndexManifestJson({
      ...manifest,
      recordFiles: [{ ...recordFile, sha256: `sha256:${"0".repeat(64)}` }, ...recordFiles.slice(1)],
    }),
    "utf8",
  );
}

/** Removes record-derived manifest fields so a custom writer can regenerate them. */
function manifestBaseFromManifest(
  manifest: IndexManifest,
): Omit<
  IndexManifest,
  | "chunkCount"
  | "edgeCount"
  | "fileCount"
  | "languages"
  | "recordCount"
  | "recordFiles"
  | "symbolCount"
> {
  const {
    chunkCount: _chunkCount,
    edgeCount: _edgeCount,
    fileCount: _fileCount,
    languages: _languages,
    recordCount: _recordCount,
    recordFiles: _recordFiles,
    symbolCount: _symbolCount,
    ...manifestBase
  } = manifest;

  return manifestBase;
}

/** Builds one built-in fixture artifact. */
function generatedFixtureArtifact(fixtureName: GeneratedFixtureName): IndexArtifact {
  switch (fixtureName) {
    case "invalid-bad-checksum":
      return validTypeScriptFixtureArtifact("art_fixture_invalid_bad_checksum");
    case "invalid-bad-path":
      return invalidBadPathFixtureArtifact();
    case "invalid-missing-reference":
      return invalidMissingReferenceFixtureArtifact();
    case "invalid-out-of-order-records":
      return invalidOutOfOrderFixtureArtifact();
    case "invalid-unknown-record-type":
      return invalidUnknownRecordTypeFixtureArtifact();
    case "minimal-valid-artifact":
      return fixtureArtifact({
        artifactId: "art_fixture_minimal_valid",
        languages: [],
        parserVersions: {},
        records: [],
      });
    case "valid-python-artifact":
      return validPythonFixtureArtifact();
    case "valid-typescript-artifact":
      return validTypeScriptFixtureArtifact("art_fixture_valid_typescript");
  }
}

/** Builds the built-in valid TypeScript fixture artifact. */
function validTypeScriptFixtureArtifact(artifactId: string): IndexArtifact {
  const file = generatedFileRecord();
  const symbol = generatedSymbolRecord(file);
  const chunk = generatedChunkRecord(file, symbol);
  const edge = generatedExternalEdgeRecord(file);

  return fixtureArtifact({
    artifactId,
    languages: ["typescript"],
    parserVersions: { typescript: "5.0.0" },
    records: [file, symbol, chunk, edge],
  });
}

/** Builds the built-in valid Python fixture artifact. */
function validPythonFixtureArtifact(): IndexArtifact {
  const file = generatedPythonFileRecord();
  const symbol = generatedPythonSymbolRecord(file);
  const chunk = generatedPythonChunkRecord(file, symbol);

  return fixtureArtifact({
    artifactId: "art_fixture_valid_python",
    languages: ["python"],
    parserVersions: { python: "3.11" },
    records: [file, symbol, chunk],
  });
}

/** Builds the invalid bad-path fixture artifact. */
function invalidBadPathFixtureArtifact(): IndexArtifact {
  return fixtureArtifact({
    artifactId: "art_fixture_invalid_bad_path",
    languages: ["typescript"],
    parserVersions: { typescript: "5.0.0" },
    records: [
      {
        ...generatedFileRecord(),
        fileId: "file_fixture_invalid_bad_path",
        path: "src/./example.ts",
      },
    ],
  });
}

/** Builds the invalid missing-reference fixture artifact. */
function invalidMissingReferenceFixtureArtifact(): IndexArtifact {
  return fixtureArtifact({
    artifactId: "art_fixture_invalid_missing_reference",
    languages: ["typescript"],
    parserVersions: { typescript: "5.0.0" },
    records: [
      {
        ...generatedSymbolRecord(generatedFileRecord()),
        fileId: "file_fixture_missing_reference_target",
        symbolId: "sym_fixture_invalid_missing_reference",
      },
    ],
  });
}

/** Builds the invalid out-of-order fixture artifact. */
function invalidOutOfOrderFixtureArtifact(): IndexArtifact {
  const file = generatedFileRecord();
  const edge = generatedExternalEdgeRecord(file);

  return fixtureArtifact({
    artifactId: "art_fixture_invalid_out_of_order",
    languages: ["typescript"],
    parserVersions: { typescript: "5.0.0" },
    records: [edge, file],
  });
}

/** Builds the invalid unknown-record-type fixture artifact. */
function invalidUnknownRecordTypeFixtureArtifact(): IndexArtifact {
  const record = {
    commitSha: "abcdef1234567890",
    recordId: "unknown_fixture_record",
    repoId: "repo_fixture_generated",
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    type: "unknown_record",
  } satisfies Readonly<Record<string, unknown>>;

  return fixtureArtifact({
    artifactId: "art_fixture_invalid_unknown_record_type",
    languages: [],
    parserVersions: {},
    records: [record as unknown as IndexArtifact["records"][number]],
  });
}

/** Builds a complete fixture artifact manifest around supplied records. */
function fixtureArtifact(input: {
  /** Generated artifact ID. */
  readonly artifactId: string;
  /** Languages to declare in the manifest. */
  readonly languages: IndexArtifact["manifest"]["languages"];
  /** Parser versions to declare in the manifest. */
  readonly parserVersions: IndexArtifact["manifest"]["parserVersions"];
  /** Records to include in the fixture. */
  readonly records: readonly IndexArtifact["records"][number][];
}): IndexArtifact {
  return {
    manifest: {
      artifactId: input.artifactId,
      chunkCount: input.records.filter((record) => record.type === "chunk").length,
      chunkerVersion: "fixture-chunker.v1",
      commitSha: "abcdef1234567890",
      edgeCount: input.records.filter((record) => record.type === "edge").length,
      fileCount: input.records.filter((record) => record.type === "file").length,
      generatedAt: "2026-05-07T12:00:00.000Z",
      indexerName: "fixture-indexer",
      indexerVersion: "0.0.0",
      languages: [...input.languages],
      parserVersions: input.parserVersions,
      recordCount: input.records.length,
      recordSchemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      repoId: "repo_fixture_generated",
      schemaVersion: INDEX_ARTIFACT_SCHEMA_VERSION,
      symbolCount: input.records.filter((record) => record.type === "symbol").length,
    },
    records: [...input.records],
  };
}

/** Creates the file record for the built-in TypeScript fixture. */
function generatedFileRecord(): FileRecord {
  return {
    commitSha: "abcdef1234567890",
    contentHash: `sha256:${"a".repeat(64)}`,
    fileId: "file_fixture_valid_typescript",
    isBinary: false,
    isGenerated: false,
    isTest: false,
    isVendored: false,
    language: "typescript",
    lineCount: 5,
    path: "src/example.ts",
    repoId: "repo_fixture_generated",
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    sizeBytes: 96,
    type: "file",
  };
}

/** Creates the file record for the built-in Python fixture. */
function generatedPythonFileRecord(): FileRecord {
  return {
    commitSha: "abcdef1234567890",
    contentHash: `sha256:${"d".repeat(64)}`,
    fileId: "file_fixture_valid_python",
    isBinary: false,
    isGenerated: false,
    isTest: false,
    isVendored: false,
    language: "python",
    lineCount: 3,
    path: "app/main.py",
    repoId: "repo_fixture_generated",
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    sizeBytes: 64,
    type: "file",
  };
}

/** Creates the symbol record for the built-in TypeScript fixture. */
function generatedSymbolRecord(file: FileRecord): SymbolRecord {
  return {
    commitSha: file.commitSha,
    contentHash: `sha256:${"b".repeat(64)}`,
    fileId: file.fileId,
    kind: "function",
    language: file.language,
    name: "greet",
    path: file.path,
    qualifiedName: "greet",
    range: { endLine: 3, startLine: 1 },
    repoId: file.repoId,
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    signature: "export function greet(name: string): string",
    symbolId: "sym_fixture_valid_typescript_greet",
    type: "symbol",
  };
}

/** Creates the symbol record for the built-in Python fixture. */
function generatedPythonSymbolRecord(file: FileRecord): SymbolRecord {
  return {
    commitSha: file.commitSha,
    contentHash: `sha256:${"e".repeat(64)}`,
    fileId: file.fileId,
    kind: "function",
    language: file.language,
    name: "greet",
    path: file.path,
    qualifiedName: "greet",
    range: { endLine: 2, startLine: 1 },
    repoId: file.repoId,
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    signature: "def greet(name: str) -> str",
    symbolId: "sym_fixture_valid_python_greet",
    type: "symbol",
  };
}

/** Creates the chunk record for the built-in TypeScript fixture. */
function generatedChunkRecord(file: FileRecord, symbol: SymbolRecord): ChunkRecord {
  return {
    chunkId: "chunk_fixture_valid_typescript_greet",
    commitSha: file.commitSha,
    contentHash: `sha256:${"c".repeat(64)}`,
    fileId: file.fileId,
    kind: "symbol",
    language: file.language,
    path: file.path,
    range: symbol.range,
    repoId: file.repoId,
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    symbolId: symbol.symbolId,
    text: 'export function greet(name: string): string {\n  return "hello " + name;\n}',
    tokenEstimate: 16,
    type: "chunk",
  };
}

/** Creates the chunk record for the built-in Python fixture. */
function generatedPythonChunkRecord(file: FileRecord, symbol: SymbolRecord): ChunkRecord {
  return {
    chunkId: "chunk_fixture_valid_python_greet",
    commitSha: file.commitSha,
    contentHash: `sha256:${"f".repeat(64)}`,
    fileId: file.fileId,
    kind: "symbol",
    language: file.language,
    path: file.path,
    range: symbol.range,
    repoId: file.repoId,
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    symbolId: symbol.symbolId,
    text: 'def greet(name: str) -> str:\n    return "hello " + name',
    tokenEstimate: 12,
    type: "chunk",
  };
}

/** Creates an external import edge for the built-in TypeScript fixture. */
function generatedExternalEdgeRecord(file: FileRecord): EdgeRecord {
  return {
    commitSha: file.commitSha,
    confidence: 1,
    edgeId: "edge_fixture_valid_typescript_external",
    fromId: file.fileId,
    fromKind: "file",
    kind: "imports",
    repoId: file.repoId,
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    toId: "external:node:path",
    toKind: "external",
    type: "edge",
  };
}

/** Parses one artifact path from a command argument list. */
function parseArtifactPathCommand(
  args: readonly string[],
):
  | { readonly ok: true; readonly command: ArtifactPathCommand }
  | { readonly ok: false; readonly help: boolean; readonly message?: string } {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { help: true, ok: false };
  }
  if (args.length === 1 && args[0] && !args[0].startsWith("--")) {
    return { command: { artifactPath: args[0] }, ok: true };
  }
  if (args.length === 2 && args[0] === "--artifact" && args[1] && !args[1].startsWith("--")) {
    return { command: { artifactPath: args[1] }, ok: true };
  }

  return {
    help: false,
    message: "Expected exactly one artifact path.",
    ok: false,
  };
}

/** Parses two artifact paths from the diff command argument list. */
function parseArtifactDiffCommand(
  args: readonly string[],
):
  | { readonly ok: true; readonly command: ArtifactDiffCommand }
  | { readonly ok: false; readonly help: boolean; readonly message?: string } {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { help: true, ok: false };
  }
  if (
    args.length === 2 &&
    args[0] &&
    args[1] &&
    !args[0].startsWith("--") &&
    !args[1].startsWith("--")
  ) {
    return {
      command: {
        baselinePath: args[0],
        candidatePath: args[1],
      },
      ok: true,
    };
  }

  return {
    help: false,
    message: "Expected baseline and candidate artifact paths.",
    ok: false,
  };
}

/** Parses generate-fixture command arguments. */
function parseGenerateFixtureCommand(
  args: readonly string[],
):
  | { readonly ok: true; readonly command: GenerateFixtureCommand }
  | { readonly ok: false; readonly help: boolean; readonly message?: string } {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { help: true, ok: false };
  }

  const [fixtureName, outputFlag, outputPath] = args;
  if (!isGeneratedFixtureName(fixtureName)) {
    return {
      help: false,
      message: `Unknown generated fixture ${fixtureName ?? ""}. Expected one of: ${GENERATED_FIXTURE_NAMES.join(", ")}.`,
      ok: false,
    };
  }
  if (outputFlag !== "--output" || !outputPath || outputPath.startsWith("--")) {
    return {
      help: false,
      message: "Expected generate-fixture <name> --output <artifact-dir>.",
      ok: false,
    };
  }
  if (args.length !== 3) {
    return {
      help: false,
      message: "Unexpected extra generate-fixture arguments.",
      ok: false,
    };
  }

  return { command: { fixtureName, outputPath }, ok: true };
}

/** Returns whether a string is a supported generated fixture name. */
function isGeneratedFixtureName(value: unknown): value is GeneratedFixtureName {
  return (
    typeof value === "string" && GENERATED_FIXTURE_NAMES.includes(value as GeneratedFixtureName)
  );
}

/** Formats an unknown error as a CLI-safe message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Returns whether this module is the process entrypoint. */
function isEntrypoint(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
}

if (isEntrypoint()) {
  process.exitCode = await runIndexSchemaCli(process.argv.slice(2));
}
