#!/usr/bin/env bun

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  diffIndexArtifacts,
  type IndexArtifact,
  stringifyIndexManifestJson,
  validateIndexArtifact,
} from "./index";
import { readIndexArtifactPath } from "./node";

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

const HELP_TEXT = `Usage:
  index-schema validate <artifact-path>
  index-schema print-manifest <artifact-path>
  index-schema count-records <artifact-path>
  index-schema diff <baseline-artifact> <candidate-artifact>

Options:
  --artifact <path>  Artifact JSON file or split artifact directory for single-artifact commands.
  --help, -h         Print this help text.
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
