#!/usr/bin/env bun

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChunkRecord,
  diffIndexArtifacts,
  type EdgeRecord,
  type FileRecord,
  INDEX_ARTIFACT_SCHEMA_VERSION,
  INDEX_RECORD_SCHEMA_VERSION,
  type IndexArtifact,
  type SymbolRecord,
  stringifyIndexManifestJson,
  validateIndexArtifact,
} from "./index";
import { readIndexArtifactPath, writeSplitIndexArtifactDirectory } from "./node";

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
type GeneratedFixtureName = "minimal-valid-artifact" | "valid-typescript-artifact";

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
  /** Whether the generated fixture passed schema-owned validation after writing. */
  readonly valid: boolean;
};

const GENERATED_FIXTURE_NAMES = [
  "minimal-valid-artifact",
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

  const artifact = await readIndexArtifactPath(resolve(parsed.command.artifactPath));
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

  const outputPath = resolve(parsed.command.outputPath);
  await writeSplitIndexArtifactDirectory(
    outputPath,
    generatedFixtureArtifact(parsed.command.fixtureName),
  );
  const artifact = await readIndexArtifactPath(outputPath);
  const validationErrors = validateIndexArtifact(artifact);
  const summary = {
    artifactId: artifact.manifest.artifactId,
    fixtureName: parsed.command.fixtureName,
    outputPath,
    recordCount: artifact.manifest.recordCount,
    valid: validationErrors.length === 0,
  } satisfies GenerateFixtureSummary;

  io.stdout.write(`${JSON.stringify(summary)}\n`);
  return validationErrors.length === 0 ? 0 : 6;
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

/** Builds one built-in fixture artifact. */
function generatedFixtureArtifact(fixtureName: GeneratedFixtureName): IndexArtifact {
  if (fixtureName === "minimal-valid-artifact") {
    return fixtureArtifact({
      artifactId: "art_fixture_minimal_valid",
      languages: [],
      records: [],
    });
  }

  return validTypeScriptFixtureArtifact();
}

/** Builds the built-in valid TypeScript fixture artifact. */
function validTypeScriptFixtureArtifact(): IndexArtifact {
  const file = generatedFileRecord();
  const symbol = generatedSymbolRecord(file);
  const chunk = generatedChunkRecord(file, symbol);
  const edge = generatedExternalEdgeRecord(file);

  return fixtureArtifact({
    artifactId: "art_fixture_valid_typescript",
    languages: ["typescript"],
    records: [file, symbol, chunk, edge],
  });
}

/** Builds a complete fixture artifact manifest around supplied records. */
function fixtureArtifact(input: {
  /** Generated artifact ID. */
  readonly artifactId: string;
  /** Languages to declare in the manifest. */
  readonly languages: IndexArtifact["manifest"]["languages"];
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
      parserVersions: { typescript: "5.0.0" },
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
