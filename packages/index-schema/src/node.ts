import { createHash } from "node:crypto";
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
  type IndexRecordFile,
  isNormalizedRepoPath,
  parseIndexArtifactJson,
  parseIndexManifestJson,
  parseIndexRecordJsonlLine,
  stringifyIndexManifestJson,
  stringifyIndexRecordsJsonl,
} from "./index";

/** Records parsed from one JSONL file plus byte-level integrity metadata. */
type IndexRecordsJsonlFileReadResult = {
  /** UTF-8 byte length of the exact file content. */
  readonly byteLength: number;
  /** Parsed records. */
  readonly records: readonly IndexRecord[];
  /** SHA-256 digest of the exact file content. */
  readonly sha256: `sha256:${string}`;
};

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
  const manifest = await readSplitIndexManifestFile(directoryPath);
  const records = await readIndexRecordFiles(directoryPath, manifest, options);

  return { manifest, records };
}

/** Reads a compact JSONL records file without loading the full file into memory. */
export async function readIndexRecordsJsonlFile(
  recordsPath: string,
  options: ReadIndexArtifactPathOptions = {},
): Promise<IndexRecord[]> {
  return [...(await readIndexRecordsJsonlFileWithMetadata(recordsPath, options)).records];
}

/** Reads a compact JSONL records file and returns integrity metadata. */
async function readIndexRecordsJsonlFileWithMetadata(
  recordsPath: string,
  options: ReadIndexArtifactPathOptions = {},
): Promise<IndexRecordsJsonlFileReadResult> {
  const records: IndexRecord[] = [];
  const hash = createHash("sha256");
  let byteLength = 0;
  const stream = createReadStream(recordsPath);
  stream.on("data", (chunk) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    hash.update(bytes);
    byteLength += bytes.byteLength;
  });
  const lines = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: stream,
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

  return {
    byteLength,
    records,
    sha256: `sha256:${hash.digest("hex")}`,
  };
}

/** Writes an index artifact as a canonical split artifact directory. */
export async function writeSplitIndexArtifactDirectory(
  directoryPath: string,
  artifact: IndexArtifactInput,
): Promise<void> {
  const manifest = withCanonicalRecordFile(artifact);

  await mkdir(directoryPath, { recursive: true });
  await Promise.all([
    writeFile(
      join(directoryPath, INDEX_MANIFEST_FILE_NAME),
      stringifyIndexManifestJson(manifest),
      "utf8",
    ),
    writeFile(
      join(directoryPath, INDEX_RECORDS_FILE_NAME),
      stringifyIndexRecordsJsonl(artifact.records),
      "utf8",
    ),
  ]);
}

/** Reads all record files declared by the manifest, or the canonical MVP record file. */
async function readIndexRecordFiles(
  directoryPath: string,
  manifest: IndexManifest,
  options: ReadIndexArtifactPathOptions,
): Promise<IndexRecord[]> {
  if (!manifest.recordFiles) {
    return readIndexRecordsJsonlFile(join(directoryPath, INDEX_RECORDS_FILE_NAME), options);
  }

  const recordFiles = manifest.recordFiles;
  const records: IndexRecord[] = [];

  for (const recordFile of recordFiles) {
    assertSafeRecordFilePath(recordFile.path);
    if (recordFile.compression !== "none") {
      throw new Error(
        `Unsupported index artifact record file compression ${recordFile.compression} for ${recordFile.path}.`,
      );
    }

    const result = await readIndexRecordsJsonlFileWithMetadata(
      join(directoryPath, recordFile.path),
      options.recordLimits === undefined ? {} : { recordLimits: options.recordLimits },
    );
    validateRecordFileMetadata(recordFile, result);
    const fileRecords = result.records;
    records.push(...fileRecords);
    if (
      options.recordLimits?.maxRecords !== undefined &&
      records.length > options.recordLimits.maxRecords
    ) {
      throw new Error(
        `Index artifact JSONL record count exceeds configured maximum ${options.recordLimits.maxRecords}.`,
      );
    }
  }

  return records;
}

/** Throws when a manifest record-file path could escape the artifact directory. */
function assertSafeRecordFilePath(path: string): void {
  if (!isNormalizedRepoPath(path)) {
    throw new Error(`Invalid index artifact record file path ${path}.`);
  }
}

/** Validates one record file read result against its manifest metadata. */
function validateRecordFileMetadata(
  recordFile: IndexRecordFile,
  result: IndexRecordsJsonlFileReadResult,
): void {
  if (result.records.length !== recordFile.recordCount) {
    throw new Error(
      `Index artifact record file ${recordFile.path} contains ${result.records.length} records but manifest declares ${recordFile.recordCount}.`,
    );
  }
  if (result.byteLength !== recordFile.byteLength) {
    throw new Error(
      `Index artifact record file ${recordFile.path} byteLength ${result.byteLength} does not match manifest byteLength ${recordFile.byteLength}.`,
    );
  }
  if (result.sha256 !== recordFile.sha256) {
    throw new Error(
      `Index artifact record file ${recordFile.path} sha256 ${result.sha256} does not match manifest sha256 ${recordFile.sha256}.`,
    );
  }
}

/** Returns a manifest that declares the canonical single records.jsonl file. */
function withCanonicalRecordFile(artifact: IndexArtifactInput): IndexManifest {
  const recordsJsonl = stringifyIndexRecordsJsonl(artifact.records);

  return {
    ...artifact.manifest,
    recordFiles: [
      {
        byteLength: Buffer.byteLength(recordsJsonl, "utf8"),
        compression: "none",
        encoding: "utf-8",
        mediaType: "application/jsonl",
        path: INDEX_RECORDS_FILE_NAME,
        recordKind: "mixed",
        recordCount: artifact.records.length,
        sha256: sha256Text(recordsJsonl),
      },
    ] satisfies readonly IndexRecordFile[],
  };
}

/** Returns a canonical SHA-256 digest for UTF-8 text. */
function sha256Text(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
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
