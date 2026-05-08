import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  type CodeLanguage,
  INDEX_MANIFEST_FILE_NAME,
  INDEX_RECORDS_FILE_NAME,
  type IndexArtifact,
  type IndexArtifactInput,
  type IndexJsonlRecordLimits,
  type IndexManifest,
  type IndexRecord,
  type IndexRecordFile,
  type IndexRecordFileCompression,
  isNormalizedRepoPath,
  parseIndexArtifactJson,
  parseIndexManifestJson,
  parseIndexRecordJsonlLine,
  stringifyIndexManifestJson,
} from "./index";

/** Canonical record-type order used by the streaming artifact writer. */
const INDEX_RECORD_TYPE_ORDER = {
  file: 0,
  symbol: 1,
  chunk: 2,
  dependency: 3,
  route: 4,
  test_mapping: 5,
  edge: 6,
  diagnostic: 7,
} satisfies Record<IndexRecord["type"], number>;

/** Byte-level integrity metadata for one parsed JSONL record file. */
type IndexRecordsJsonlFileReadMetadata = {
  /** UTF-8 byte length of the exact file content. */
  readonly byteLength: number;
  /** Number of parsed records. */
  readonly recordCount: number;
  /** SHA-256 digest of the exact file content. */
  readonly sha256: `sha256:${string}`;
};

/** Records parsed from one JSONL file plus byte-level integrity metadata. */
type IndexRecordsJsonlFileReadResult = IndexRecordsJsonlFileReadMetadata & {
  /** Parsed records. */
  readonly records: readonly IndexRecord[];
};

/** Options for reading filesystem-backed index artifacts. */
export type ReadIndexArtifactPathOptions = {
  /** Optional record count and byte limits for split artifact JSONL reads. */
  readonly recordLimits?: IndexJsonlRecordLimits;
};

/** Input for opening a filesystem-backed split index artifact. */
export type OpenIndexArtifactInput = ReadIndexArtifactPathOptions & {
  /** Directory containing the split artifact manifest and record files. */
  readonly artifactDir: string;
};

/** Streaming reader for a filesystem-backed split index artifact. */
export type IndexArtifactReader = {
  /** Parsed manifest for the opened artifact. */
  readonly manifest: IndexManifest;
  /** Streams artifact records in manifest-declared order. */
  records(): AsyncGenerator<IndexRecord>;
};

/** Metadata returned after streaming a JSONL record file to disk. */
export type IndexRecordWriterCloseResult = {
  /** UTF-8 byte length written to disk. */
  readonly byteLength: number;
  /** Number of records written. */
  readonly recordCount: number;
  /** SHA-256 digest for the exact written bytes. */
  readonly sha256: `sha256:${string}`;
};

/** Streaming writer for one compact JSONL index record file. */
export type IndexRecordWriter = {
  /** Writes one record as compact JSON plus a final line break. */
  write(record: IndexRecord): Promise<void>;
  /** Finishes the file and returns integrity metadata for the written bytes. */
  close(): Promise<IndexRecordWriterCloseResult>;
};

/** Input for creating a compact JSONL index record writer. */
export type CreateIndexRecordWriterInput = {
  /** Destination JSONL file path. */
  readonly filePath: string;
  /** Optional compression mode. MVP writers support only uncompressed JSONL. */
  readonly compression?: IndexRecordFileCompression;
};

/** Manifest fields supplied by artifact producers before record metadata is known. */
export type IndexArtifactWriterManifestBase = Omit<
  IndexManifest,
  | "chunkCount"
  | "edgeCount"
  | "fileCount"
  | "languages"
  | "recordCount"
  | "recordFiles"
  | "symbolCount"
>;

/** Input accepted when finalizing a streaming split-artifact writer. */
export type IndexArtifactWriterCloseInput = {
  /** Manifest fields that are independent of the streamed record file. */
  readonly manifestBase: IndexArtifactWriterManifestBase;
  /** Optional language list override when a producer wants to preserve explicit manifest values. */
  readonly languages?: readonly CodeLanguage[];
};

/** Result returned after finalizing a split-artifact writer. */
export type IndexArtifactWriterCloseResult = {
  /** Directory containing the finalized split artifact. */
  readonly artifactDir: string;
  /** Final manifest written to index-manifest.json. */
  readonly manifest: IndexManifest;
};

/** Streaming writer for a complete split index artifact directory. */
export type IndexArtifactWriter = {
  /** Writes one canonical record into the artifact's JSONL record file. */
  writeRecord(record: IndexRecord): Promise<void>;
  /** Closes the record file and writes the manifest last. */
  close(input: IndexArtifactWriterCloseInput): Promise<IndexArtifactWriterCloseResult>;
};

/** Input for creating a streaming split-artifact writer. */
export type CreateIndexArtifactWriterInput = {
  /** Directory where the split artifact should be written. */
  readonly artifactDir: string;
  /** Repo-relative record-file path inside the artifact directory. */
  readonly recordFileName?: string;
  /** Optional compression mode. MVP writers support only uncompressed JSONL. */
  readonly compression?: IndexRecordFileCompression;
  /** Whether to reject records that move backward in canonical record-type order. */
  readonly enforceOrdering?: boolean;
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
  const reader = await openIndexArtifact({
    artifactDir: directoryPath,
    ...recordLimitOption(options),
  });
  const records: IndexRecord[] = [];
  for await (const record of reader.records()) {
    records.push(record);
  }

  return { manifest: reader.manifest, records };
}

/** Opens a split index artifact directory without eagerly loading every record. */
export async function openIndexArtifact(
  input: OpenIndexArtifactInput,
): Promise<IndexArtifactReader> {
  const manifest = await readSplitIndexManifestFile(input.artifactDir);

  return {
    manifest,
    records: () => streamIndexRecordFiles(input.artifactDir, manifest, input),
  };
}

/** Reads a compact JSONL records file without loading the full file into memory. */
export async function readIndexRecordsJsonlFile(
  recordsPath: string,
  options: ReadIndexArtifactPathOptions = {},
): Promise<IndexRecord[]> {
  return [...(await readIndexRecordsJsonlFileWithMetadata(recordsPath, options)).records];
}

/** Creates a streaming compact JSONL record writer with byte and hash tracking. */
export function createIndexRecordWriter(input: CreateIndexRecordWriterInput): IndexRecordWriter {
  const compression = input.compression ?? "none";
  if (compression !== "none") {
    throw new Error(`Unsupported index artifact record writer compression ${compression}.`);
  }

  const stream = createWriteStream(input.filePath, { flags: "w" });
  const hash = createHash("sha256");
  let byteLength = 0;
  let closed = false;
  let recordCount = 0;
  let streamError: unknown;

  stream.on("error", (error) => {
    streamError = error;
  });

  return {
    close: async () => {
      if (closed) {
        throw new Error("Index record writer is already closed.");
      }

      closed = true;
      throwStreamError(streamError);
      await finishWriteStream(stream);
      throwStreamError(streamError);

      return {
        byteLength,
        recordCount,
        sha256: `sha256:${hash.digest("hex")}`,
      };
    },
    write: async (record) => {
      if (closed) {
        throw new Error("Cannot write to a closed index record writer.");
      }

      const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      hash.update(bytes);
      byteLength += bytes.byteLength;
      recordCount += 1;

      throwStreamError(streamError);
      if (!stream.write(bytes)) {
        await waitForDrain(stream);
      }
      throwStreamError(streamError);
    },
  };
}

/** Creates a streaming split-artifact writer that writes the manifest after records are closed. */
export function createIndexArtifactWriter(
  input: CreateIndexArtifactWriterInput,
): IndexArtifactWriter {
  const recordFileName = input.recordFileName ?? INDEX_RECORDS_FILE_NAME;
  assertSafeRecordFilePath(recordFileName);

  const compression = input.compression ?? "none";
  if (compression !== "none") {
    throw new Error(`Unsupported index artifact record writer compression ${compression}.`);
  }

  const artifactDir = input.artifactDir;
  const recordFilePath = join(artifactDir, recordFileName);
  const writerPromise = mkdir(dirname(recordFilePath), { recursive: true }).then(() =>
    createIndexRecordWriter({ compression, filePath: recordFilePath }),
  );
  const counters = createEmptyArtifactWriterCounters();
  const enforceOrdering = input.enforceOrdering ?? true;
  let closed = false;
  let highestRecordTypeOrder = -1;
  let highestRecordType: IndexRecord["type"] | undefined;

  return {
    close: async (closeInput) => {
      if (closed) {
        throw new Error("Index artifact writer is already closed.");
      }

      closed = true;
      const writer = await writerPromise;
      const metadata = await writer.close();
      const manifest = createFinalManifest({
        closeInput,
        counters,
        recordFile: {
          ...metadata,
          compression,
          encoding: "utf-8",
          mediaType: "application/jsonl",
          path: recordFileName,
          recordKind: "mixed",
        },
      });

      await writeFile(
        join(artifactDir, INDEX_MANIFEST_FILE_NAME),
        stringifyIndexManifestJson(manifest),
        "utf8",
      );

      return { artifactDir, manifest };
    },
    writeRecord: async (record) => {
      if (closed) {
        throw new Error("Cannot write to a closed index artifact writer.");
      }
      if (enforceOrdering) {
        const order = INDEX_RECORD_TYPE_ORDER[record.type];
        if (order < highestRecordTypeOrder) {
          throw new Error(
            `Index artifact record type ${record.type} cannot be written after ${highestRecordType} records.`,
          );
        }
        if (order > highestRecordTypeOrder) {
          highestRecordTypeOrder = order;
          highestRecordType = record.type;
        }
      }

      const writer = await writerPromise;
      await writer.write(record);
      collectArtifactWriterCounters(counters, record);
    },
  };
}

/** Reads a compact JSONL records file and returns integrity metadata. */
async function readIndexRecordsJsonlFileWithMetadata(
  recordsPath: string,
  options: ReadIndexArtifactPathOptions = {},
): Promise<IndexRecordsJsonlFileReadResult> {
  const records: IndexRecord[] = [];
  const iterator = readIndexRecordsJsonlFileStreamWithMetadata(recordsPath, options)[
    Symbol.asyncIterator
  ]();

  while (true) {
    const result = await iterator.next();
    if (result.done) {
      return { ...result.value, records };
    }

    records.push(result.value);
  }
}

/** Streams a compact JSONL records file and returns integrity metadata when fully consumed. */
async function* readIndexRecordsJsonlFileStreamWithMetadata(
  recordsPath: string,
  options: ReadIndexArtifactPathOptions = {},
): AsyncGenerator<IndexRecord, IndexRecordsJsonlFileReadMetadata, void> {
  const hash = createHash("sha256");
  let byteLength = 0;
  let recordCount = 0;
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
      recordCount + 1 > options.recordLimits.maxRecords
    ) {
      throw new Error(
        `Index artifact JSONL record count exceeds configured maximum ${options.recordLimits.maxRecords}.`,
      );
    }

    recordCount += 1;
    yield record;
  }

  return {
    byteLength,
    recordCount,
    sha256: `sha256:${hash.digest("hex")}`,
  };
}

/** Writes an index artifact as a canonical split artifact directory. */
export async function writeSplitIndexArtifactDirectory(
  directoryPath: string,
  artifact: IndexArtifactInput,
): Promise<void> {
  const writer = createIndexArtifactWriter({ artifactDir: directoryPath });
  for (const record of artifact.records) {
    await writer.writeRecord(record);
  }

  await writer.close({
    languages: artifact.manifest.languages,
    manifestBase: manifestBaseFromManifest(artifact.manifest),
  });
}

/** Streams all record files declared by the manifest, or the canonical MVP record file. */
async function* streamIndexRecordFiles(
  directoryPath: string,
  manifest: IndexManifest,
  options: ReadIndexArtifactPathOptions,
): AsyncGenerator<IndexRecord> {
  if (!manifest.recordFiles) {
    yield* readIndexRecordsJsonlFileStreamWithMetadata(
      join(directoryPath, INDEX_RECORDS_FILE_NAME),
      options,
    );
    return;
  }

  const recordFiles = manifest.recordFiles;
  let totalRecordCount = 0;

  for (const recordFile of recordFiles) {
    assertSafeRecordFilePath(recordFile.path);
    if (recordFile.compression !== "none") {
      throw new Error(
        `Unsupported index artifact record file compression ${recordFile.compression} for ${recordFile.path}.`,
      );
    }

    const result = yield* readIndexRecordsJsonlFileStreamWithMetadata(
      join(directoryPath, recordFile.path),
      recordLimitOption(options),
    );
    validateRecordFileMetadata(recordFile, result);
    totalRecordCount += result.recordCount;
    if (
      options.recordLimits?.maxRecords !== undefined &&
      totalRecordCount > options.recordLimits.maxRecords
    ) {
      throw new Error(
        `Index artifact JSONL record count exceeds configured maximum ${options.recordLimits.maxRecords}.`,
      );
    }
  }
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
  result: IndexRecordsJsonlFileReadMetadata,
): void {
  if (result.recordCount !== recordFile.recordCount) {
    throw new Error(
      `Index artifact record file ${recordFile.path} contains ${result.recordCount} records but manifest declares ${recordFile.recordCount}.`,
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

/** Waits for a writable stream to drain or throw its write error. */
async function waitForDrain(stream: WriteStream): Promise<void> {
  await Promise.race([
    once(stream, "drain").then(() => undefined),
    once(stream, "error").then(([error]) => {
      throw error;
    }),
  ]);
}

/** Ends a writable stream and waits for its final flush or write error. */
async function finishWriteStream(stream: WriteStream): Promise<void> {
  stream.end();
  await Promise.race([
    once(stream, "finish").then(() => undefined),
    once(stream, "error").then(([error]) => {
      throw error;
    }),
  ]);
}

/** Throws a captured write-stream error when one has occurred. */
function throwStreamError(error: unknown): void {
  if (error) {
    throw error;
  }
}

/** Returns a record-limit option object without writing exact-optional undefined fields. */
function recordLimitOption(options: ReadIndexArtifactPathOptions): ReadIndexArtifactPathOptions {
  return options.recordLimits === undefined ? {} : { recordLimits: options.recordLimits };
}

/** Mutable record counters tracked by the streaming artifact writer. */
type IndexArtifactWriterCounters = {
  /** Number of chunk records written. */
  chunkCount: number;
  /** Number of edge records written. */
  edgeCount: number;
  /** Number of file records written. */
  fileCount: number;
  /** Languages observed in records that carry a language field. */
  languages: Set<CodeLanguage>;
  /** Total records written. */
  recordCount: number;
  /** Number of symbol records written. */
  symbolCount: number;
};

/** Input used to build the final manifest from writer state. */
type CreateFinalManifestInput = {
  /** Manifest finalization input supplied by the caller. */
  readonly closeInput: IndexArtifactWriterCloseInput;
  /** Counters collected while records streamed. */
  readonly counters: IndexArtifactWriterCounters;
  /** Final JSONL record file metadata. */
  readonly recordFile: IndexRecordFile;
};

/** Creates an empty mutable counter bag for streamed record metadata. */
function createEmptyArtifactWriterCounters(): IndexArtifactWriterCounters {
  return {
    chunkCount: 0,
    edgeCount: 0,
    fileCount: 0,
    languages: new Set<CodeLanguage>(),
    recordCount: 0,
    symbolCount: 0,
  };
}

/** Updates manifest counters from one streamed record. */
function collectArtifactWriterCounters(
  counters: IndexArtifactWriterCounters,
  record: IndexRecord,
): void {
  counters.recordCount += 1;

  switch (record.type) {
    case "chunk":
      counters.chunkCount += 1;
      counters.languages.add(record.language);
      return;
    case "edge":
      counters.edgeCount += 1;
      return;
    case "file":
      counters.fileCount += 1;
      counters.languages.add(record.language);
      return;
    case "symbol":
      counters.symbolCount += 1;
      counters.languages.add(record.language);
      return;
    case "route":
      counters.languages.add(record.language);
      return;
    case "dependency":
    case "diagnostic":
    case "test_mapping":
      return;
  }
}

/** Builds the final manifest from the immutable base plus streamed record metadata. */
function createFinalManifest(input: CreateFinalManifestInput): IndexManifest {
  const languages = input.closeInput.languages
    ? [...input.closeInput.languages].sort()
    : [...input.counters.languages].sort();

  return {
    ...input.closeInput.manifestBase,
    chunkCount: input.counters.chunkCount,
    edgeCount: input.counters.edgeCount,
    fileCount: input.counters.fileCount,
    languages,
    recordCount: input.counters.recordCount,
    recordFiles: [input.recordFile],
    symbolCount: input.counters.symbolCount,
  };
}

/** Removes record-derived manifest fields so the streaming writer can regenerate them. */
function manifestBaseFromManifest(manifest: IndexManifest): IndexArtifactWriterManifestBase {
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
