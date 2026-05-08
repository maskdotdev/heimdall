import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IndexManifest, IndexRecord } from "@repo/index-schema";
import { createTypeScriptIndexerDriver } from "@repo/indexer-ts";

/** Artifact output layouts supported by the CLI. */
export type IndexerCliOutputFormat = "json" | "split";

/** In-memory artifact shape that can be written to either supported CLI layout. */
type WritableIndexArtifact = {
  /** Artifact manifest. */
  readonly manifest: IndexManifest;
  /** Artifact records in canonical order. */
  readonly records: readonly IndexRecord[];
};

/** CLI request shape accepted through flags or request JSON. */
export type IndexerCliRequest = {
  /** Heimdall repository ID. */
  readonly repoId: string;
  /** Commit SHA to index. */
  readonly commitSha: string;
  /** Workspace path checked out at commitSha. */
  readonly workspacePath: string;
  /** Optional previous index version for incremental driver context. */
  readonly previousIndexVersionId?: string;
  /** Optional artifact output path. Use "-" or omit to write to stdout. */
  readonly outputPath?: string;
  /** Artifact output layout. */
  readonly outputFormat: IndexerCliOutputFormat;
  /** Whether JSON output should be formatted with indentation. */
  readonly pretty: boolean;
};

/** Minimal writer used by the CLI runner and tests. */
export type IndexerCliWriter = {
  /** Writes a string chunk to the target stream. */
  readonly write: (chunk: string) => unknown;
};

/** IO streams used by the CLI runner. */
export type IndexerCliIo = {
  /** Standard output stream. */
  readonly stdout: IndexerCliWriter;
  /** Standard error stream. */
  readonly stderr: IndexerCliWriter;
};

/** Parsed CLI command result. */
type ParseIndexerCliArgsResult =
  | {
      /** Parsed request. */
      readonly ok: true;
      /** Request to execute. */
      readonly request: IndexerCliRequest;
    }
  | {
      /** Parsed request. */
      readonly ok: false;
      /** Whether help text should be printed. */
      readonly help: boolean;
      /** Error message for invalid arguments. */
      readonly message?: string;
    };

/** Parsed flag result before request JSON is merged. */
type ParseIndexerCliFlagsResult =
  | {
      /** Whether flags were parsed. */
      readonly ok: true;
      /** Parsed flags. */
      readonly flags: IndexerCliFlagValues;
    }
  | {
      /** Whether flags were parsed. */
      readonly ok: false;
      /** Whether help text should be printed. */
      readonly help: false;
      /** Error message for invalid arguments. */
      readonly message: string;
    };

/** Internal flag bag before required values are validated. */
type IndexerCliFlagValues = {
  /** Request JSON path. */
  readonly requestPath?: string;
  /** Repository ID flag. */
  readonly repoId?: string;
  /** Commit SHA flag. */
  readonly commitSha?: string;
  /** Workspace path flag. */
  readonly workspacePath?: string;
  /** Previous index version flag. */
  readonly previousIndexVersionId?: string;
  /** Output artifact path flag. */
  readonly outputPath?: string;
  /** Output artifact layout flag. */
  readonly outputFormat?: IndexerCliOutputFormat;
  /** Whether pretty output was requested. */
  readonly pretty: boolean;
};

/** Canonical split artifact manifest file name. */
const INDEX_MANIFEST_FILE_NAME = "index-manifest.json";

/** Canonical split artifact records file name. */
const INDEX_RECORDS_FILE_NAME = "records.jsonl";

const HELP_TEXT = `Usage:
  indexer capabilities --json
  indexer index --repo-id <repo_id> --commit-sha <sha> --workspace <path> [--output <path>] [--format json|split] [--pretty]
  indexer index --request <request.json> [--output <path>] [--format json|split] [--pretty]

Options:
  capabilities --json                Print indexer capability metadata as JSON.
  --repo-id <repo_id>              Heimdall repository ID.
  --commit-sha <sha>               Commit SHA checked out in the workspace.
  --workspace <path>               Local workspace path to index.
  --previous-index-version-id <id> Previous index version for incremental context.
  --request <path>                 JSON request with repoId, commitSha, and workspacePath.
  --output <path>                  Artifact output path. Use "-" or omit for JSON stdout.
  --format <json|split>            Artifact output layout. Defaults to json.
  --pretty                         Format JSON artifact output with indentation.
`;

/** Runs the indexer CLI and returns a process-style exit code. */
export async function runIndexerCli(
  argv: readonly string[],
  io: IndexerCliIo = process,
): Promise<number> {
  if (argv[0] === "capabilities") {
    return runCapabilitiesCommand(argv.slice(1), io);
  }

  const parsed = await parseIndexerCliArgs(argv);
  if (!parsed.ok) {
    io[parsed.help ? "stdout" : "stderr"].write(
      `${parsed.message ? `${parsed.message}\n\n` : ""}${HELP_TEXT}`,
    );
    return parsed.help ? 0 : 1;
  }

  const splitOutputPath = splitArtifactOutputPath(parsed.request);
  if (parsed.request.outputFormat === "split" && !splitOutputPath) {
    io.stderr.write("Split artifact output requires --output <directory>.\n");
    return 1;
  }

  const driver = createTypeScriptIndexerDriver();
  const result = await driver.indexRepository({
    commitSha: parsed.request.commitSha,
    repoId: parsed.request.repoId,
    workspacePath: resolve(parsed.request.workspacePath),
    ...(parsed.request.previousIndexVersionId
      ? { previousIndexVersionId: parsed.request.previousIndexVersionId }
      : {}),
  });

  if (!result.ok) {
    io.stderr.write(`${result.error.code}: ${result.error.message}\n`);
    for (const diagnostic of result.diagnostics) {
      io.stderr.write(`- ${diagnostic}\n`);
    }
    return 1;
  }

  if (parsed.request.outputFormat === "split") {
    if (!splitOutputPath) {
      io.stderr.write("Split artifact output requires --output <directory>.\n");
      return 1;
    }

    const outputPath = resolve(splitOutputPath);
    await writeSplitIndexArtifact(outputPath, result.artifact);
    io.stdout.write(
      JSON.stringify({
        artifactId: result.artifact.manifest.artifactId,
        format: "split",
        outputPath,
        recordCount: result.artifact.manifest.recordCount,
      }),
    );
    io.stdout.write("\n");

    return 0;
  }

  const json = `${JSON.stringify(result.artifact, null, parsed.request.pretty ? 2 : 0)}\n`;
  if (!parsed.request.outputPath || parsed.request.outputPath === "-") {
    io.stdout.write(json);
    return 0;
  }

  const outputPath = resolve(parsed.request.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, json, "utf8");
  io.stdout.write(
    JSON.stringify({
      artifactId: result.artifact.manifest.artifactId,
      format: "json",
      outputPath,
      recordCount: result.artifact.manifest.recordCount,
    }),
  );
  io.stdout.write("\n");

  return 0;
}

/** Prints TypeScript indexer capabilities as machine-readable JSON. */
async function runCapabilitiesCommand(flags: readonly string[], io: IndexerCliIo): Promise<number> {
  if (flags.length > 0 && (flags.length !== 1 || flags[0] !== "--json")) {
    io.stderr.write(`Unknown capabilities option: ${flags.join(" ")}\n\n${HELP_TEXT}`);
    return 1;
  }

  io.stdout.write(`${JSON.stringify(await createTypeScriptIndexerDriver().getCapabilities())}\n`);

  return 0;
}

/** Parses indexer CLI arguments into a complete request. */
export async function parseIndexerCliArgs(
  argv: readonly string[],
): Promise<ParseIndexerCliArgsResult> {
  const [command = "help", ...flags] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    return { ok: false, help: true };
  }
  if (command !== "index") {
    return { ok: false, help: false, message: `Unknown command: ${command}` };
  }

  const parsedFlags = parseFlagValues(flags);
  if (!parsedFlags.ok) {
    return parsedFlags;
  }

  const emptyRequest = { ok: true as const, value: {} as Partial<IndexerCliRequest> };
  const request = parsedFlags.flags.requestPath
    ? await readRequestFile(parsedFlags.flags.requestPath)
    : emptyRequest;
  if (!request.ok) {
    return request;
  }

  return completeRequest(parsedFlags.flags, request.value);
}

/** Parses flag tokens into a flag bag. */
function parseFlagValues(flags: readonly string[]): ParseIndexerCliFlagsResult {
  const values: {
    requestPath?: string;
    repoId?: string;
    commitSha?: string;
    workspacePath?: string;
    previousIndexVersionId?: string;
    outputPath?: string;
    outputFormat?: IndexerCliOutputFormat;
    pretty: boolean;
  } = { pretty: false };

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--pretty") {
      values.pretty = true;
      continue;
    }

    const value = flags[index + 1];
    if (!value || value.startsWith("--")) {
      return { ok: false, help: false, message: `Missing value for ${flag}` };
    }

    if (flag === "--request") {
      values.requestPath = value;
    } else if (flag === "--repo-id") {
      values.repoId = value;
    } else if (flag === "--commit-sha") {
      values.commitSha = value;
    } else if (flag === "--workspace") {
      values.workspacePath = value;
    } else if (flag === "--previous-index-version-id") {
      values.previousIndexVersionId = value;
    } else if (flag === "--output") {
      values.outputPath = value;
    } else if (flag === "--format") {
      const outputFormat = outputFormatValue(value);
      if (!outputFormat) {
        return {
          ok: false,
          help: false,
          message: `Invalid artifact output format: ${value}`,
        };
      }
      values.outputFormat = outputFormat;
    } else {
      return { ok: false, help: false, message: `Unknown option: ${flag}` };
    }

    index += 1;
  }

  return { ok: true, flags: values };
}

/** Reads request JSON from disk. */
async function readRequestFile(
  requestPath: string,
): Promise<
  | { readonly ok: true; readonly value: Partial<IndexerCliRequest> }
  | { readonly ok: false; readonly help: false; readonly message: string }
> {
  try {
    const value = JSON.parse(await readFile(resolve(requestPath), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, help: false, message: "Request JSON must be an object." };
    }

    return { ok: true, value: value as Partial<IndexerCliRequest> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, help: false, message: `Could not read request JSON: ${message}` };
  }
}

/** Completes and validates the final request after merging file and flag input. */
function completeRequest(
  flags: IndexerCliFlagValues,
  request: Partial<IndexerCliRequest>,
): ParseIndexerCliArgsResult {
  const repoId = flags.repoId ?? stringValue(request.repoId);
  const commitSha = flags.commitSha ?? stringValue(request.commitSha);
  const workspacePath = flags.workspacePath ?? stringValue(request.workspacePath);
  const previousIndexVersionId =
    flags.previousIndexVersionId ?? stringValue(request.previousIndexVersionId);
  const outputPath = flags.outputPath ?? stringValue(request.outputPath);
  const requestOutputFormat = outputFormatValue(request.outputFormat);

  if (!flags.outputFormat && request.outputFormat !== undefined && !requestOutputFormat) {
    return {
      ok: false,
      help: false,
      message: `Invalid artifact output format: ${String(request.outputFormat)}`,
    };
  }

  const outputFormat = flags.outputFormat ?? requestOutputFormat ?? ("json" as const);

  if (!repoId || !commitSha || !workspacePath) {
    return {
      ok: false,
      help: false,
      message: "repoId, commitSha, and workspacePath are required.",
    };
  }

  return {
    ok: true,
    request: {
      commitSha,
      outputFormat,
      pretty: flags.pretty || request.pretty === true,
      repoId,
      workspacePath,
      ...(previousIndexVersionId ? { previousIndexVersionId } : {}),
      ...(outputPath ? { outputPath } : {}),
    },
  };
}

/** Returns the split artifact output directory when the request has one. */
function splitArtifactOutputPath(request: IndexerCliRequest): string | undefined {
  return request.outputPath && request.outputPath !== "-" ? request.outputPath : undefined;
}

/** Writes an index artifact as a canonical split artifact directory. */
async function writeSplitIndexArtifact(
  outputPath: string,
  artifact: WritableIndexArtifact,
): Promise<void> {
  await mkdir(outputPath, { recursive: true });

  const recordsJsonl = artifact.records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(
    join(outputPath, INDEX_RECORDS_FILE_NAME),
    recordsJsonl.length > 0 ? `${recordsJsonl}\n` : "",
    "utf8",
  );
  await writeFile(
    join(outputPath, INDEX_MANIFEST_FILE_NAME),
    `${JSON.stringify(artifact.manifest, null, 2)}\n`,
    "utf8",
  );
}

/** Returns a supported artifact output format when the input is valid. */
function outputFormatValue(value: unknown): IndexerCliOutputFormat | undefined {
  return value === "json" || value === "split" ? value : undefined;
}

/** Returns the string value when the input is a string. */
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Returns whether this module is the process entrypoint. */
function isEntrypoint(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
}

if (isEntrypoint()) {
  const exitCode = await runIndexerCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
