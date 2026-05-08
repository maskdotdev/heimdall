import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  INDEX_MANIFEST_FILE_NAME,
  INDEX_RECORDS_FILE_NAME,
  type IndexArtifact,
  type IndexArtifactInput,
  type IndexJsonlRecordLimits,
  type IndexManifest,
  type IndexRecord,
  parseIndexArtifactJson,
  parseIndexManifestJson,
  parseIndexRecordJsonlLine,
  stringifyIndexManifestJson,
  stringifyIndexRecordsJsonl,
} from "./index";

/** Options for reading filesystem-backed index artifacts. */
export type ReadIndexArtifactPathOptions = {
  /** Optional record count and byte limits for split artifact JSONL reads. */
  readonly recordLimits?: IndexJsonlRecordLimits;
};

/** Reads either a whole-artifact JSON file or a split artifact directory. */
export async function readIndexArtifactPath(
  artifactPath: string,
  options: ReadIndexArtifactPathOptions = {},
): Promise<IndexArtifact> {
  const info = await stat(artifactPath);
  if (info.isDirectory()) {
    return readSplitIndexArtifactDirectory(artifactPath, options);
  }

  return parseIndexArtifactJson(await readFile(artifactPath, "utf8"));
}

/** Reads the canonical split artifact directory layout. */
export async function readSplitIndexArtifactDirectory(
  directoryPath: string,
  options: ReadIndexArtifactPathOptions = {},
): Promise<IndexArtifact> {
  const [manifest, records] = await Promise.all([
    readSplitIndexManifestFile(directoryPath),
    readIndexRecordsJsonlFile(join(directoryPath, INDEX_RECORDS_FILE_NAME), options),
  ]);

  return { manifest, records };
}

/** Reads a compact JSONL records file without loading the full file into memory. */
export async function readIndexRecordsJsonlFile(
  recordsPath: string,
  options: ReadIndexArtifactPathOptions = {},
): Promise<IndexRecord[]> {
  const records: IndexRecord[] = [];
  const lines = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: createReadStream(recordsPath, { encoding: "utf8" }),
  });
  let lineNumber = 0;

  for await (const line of lines) {
    lineNumber += 1;
    const parseOptions = options.recordLimits === undefined ? {} : { limits: options.recordLimits };
    const record = parseIndexRecordJsonlLine(line, lineNumber, parseOptions);
    if (
      options.recordLimits?.maxRecords !== undefined &&
      records.length + 1 > options.recordLimits.maxRecords
    ) {
      throw new Error(
        `Index artifact JSONL record count exceeds configured maximum ${options.recordLimits.maxRecords}.`,
      );
    }

    records.push(record);
  }

  return records;
}

/** Writes an index artifact as a canonical split artifact directory. */
export async function writeSplitIndexArtifactDirectory(
  directoryPath: string,
  artifact: IndexArtifactInput,
): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
  await Promise.all([
    writeFile(
      join(directoryPath, INDEX_MANIFEST_FILE_NAME),
      stringifyIndexManifestJson(artifact.manifest),
      "utf8",
    ),
    writeFile(
      join(directoryPath, INDEX_RECORDS_FILE_NAME),
      stringifyIndexRecordsJsonl(artifact.records),
      "utf8",
    ),
  ]);
}

/** Reads the canonical split artifact manifest file. */
async function readSplitIndexManifestFile(directoryPath: string): Promise<IndexManifest> {
  const manifestPath = join(directoryPath, INDEX_MANIFEST_FILE_NAME);
  try {
    return parseIndexManifestJson(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      throw new Error(`Index artifact directory is missing ${INDEX_MANIFEST_FILE_NAME}.`, {
        cause: error,
      });
    }

    throw error;
  }
}

/** Returns whether an unknown error has the supplied Node error code. */
function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
