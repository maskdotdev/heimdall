import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INDEX_ARTIFACT_SCHEMA_VERSION,
  INDEX_RECORD_SCHEMA_VERSION,
  type IndexArtifact,
  type IndexManifest,
  type IndexRecord,
  stringifyIndexManifestJson,
  stringifyIndexRecordsJsonl,
} from "../src";
import { readSplitIndexArtifactDirectory, writeSplitIndexArtifactDirectory } from "../src/node";

/** Temporary directories created by Node helper tests. */
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { force: true, recursive: true })));
  tempRoots.length = 0;
});

describe("index artifact Node helpers", () => {
  it("writes the canonical single-record-file split layout", async () => {
    const root = await createTempRoot();
    const artifact = artifactWithTwoFiles();

    await writeSplitIndexArtifactDirectory(root, artifact);

    await expect(readSplitIndexArtifactDirectory(root)).resolves.toEqual({
      manifest: {
        ...artifact.manifest,
        recordFiles: [recordFileFor("records.jsonl", artifact.records)],
      },
      records: artifact.records,
    });
  });

  it("reads manifest-declared partitioned record files in order", async () => {
    const root = await createTempRoot();
    const artifact = artifactWithTwoFiles();
    const [firstRecord, secondRecord] = artifact.records;
    if (!firstRecord || !secondRecord) {
      throw new Error("Partitioned fixture must include two records.");
    }
    const manifest = {
      ...artifact.manifest,
      recordFiles: [
        recordFileFor("records/files.jsonl", [firstRecord]),
        recordFileFor("records/tests.jsonl", [secondRecord]),
      ],
    } satisfies IndexManifest;

    await mkdir(join(root, "records"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "index-manifest.json"), stringifyIndexManifestJson(manifest), "utf8"),
      writeFile(join(root, "records/files.jsonl"), stringifyIndexRecordsJsonl([firstRecord])),
      writeFile(join(root, "records/tests.jsonl"), stringifyIndexRecordsJsonl([secondRecord])),
    ]);

    await expect(readSplitIndexArtifactDirectory(root)).resolves.toEqual({
      manifest,
      records: artifact.records,
    });
  });

  it("rejects unsupported partitioned record-file compression", async () => {
    const root = await createTempRoot();
    const artifact = artifactWithTwoFiles();
    const manifest = {
      ...artifact.manifest,
      recordFiles: [
        {
          ...recordFileFor("records/files.jsonl.gz", artifact.records),
          compression: "gzip" as const,
        },
      ],
    } satisfies IndexManifest;

    await writeFile(join(root, "index-manifest.json"), stringifyIndexManifestJson(manifest));

    await expect(readSplitIndexArtifactDirectory(root)).rejects.toThrow(
      "Unsupported index artifact record file compression gzip for records/files.jsonl.gz.",
    );
  });

  it("rejects unsafe manifest record-file paths", async () => {
    const root = await createTempRoot();
    const artifact = artifactWithTwoFiles();
    const manifest = {
      ...artifact.manifest,
      recordFiles: [recordFileFor("records/..", artifact.records)],
    } satisfies IndexManifest;

    await writeFile(join(root, "index-manifest.json"), stringifyIndexManifestJson(manifest));

    await expect(readSplitIndexArtifactDirectory(root)).rejects.toThrow(
      "Invalid index artifact record file path records/..",
    );
  });
});

/** Creates manifest metadata for one compact JSONL record file. */
function recordFileFor(
  path: string,
  records: readonly IndexRecord[],
): NonNullable<IndexManifest["recordFiles"]>[number] {
  const text = stringifyIndexRecordsJsonl(records);

  return {
    byteLength: Buffer.byteLength(text, "utf8"),
    compression: "none",
    encoding: "utf-8",
    mediaType: "application/jsonl",
    path,
    recordCount: records.length,
    recordKind: "mixed",
    sha256: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
  };
}

/** Creates a temporary directory and schedules cleanup after the test. */
async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heimdall-index-schema-"));
  tempRoots.push(root);

  return root;
}

/** Creates a minimal artifact with two file records for filesystem helper tests. */
function artifactWithTwoFiles(): IndexArtifact {
  const records: IndexRecord[] = [
    fileRecord("file_source", "src/source.ts", "a"),
    fileRecord("file_test", "src/source.test.ts", "b"),
  ];

  return {
    manifest: {
      artifactId: "art_node_helper_fixture",
      chunkCount: 0,
      chunkerVersion: "fixture-chunker.v1",
      commitSha: "abcdef1234567890",
      edgeCount: 0,
      fileCount: 2,
      generatedAt: "2026-05-07T12:00:00.000Z",
      indexerName: "fixture-indexer",
      indexerVersion: "0.0.0",
      languages: ["typescript"],
      parserVersions: { typescript: "5.0.0" },
      recordCount: records.length,
      recordSchemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      repoId: "repo_node_fixture",
      schemaVersion: INDEX_ARTIFACT_SCHEMA_VERSION,
      symbolCount: 0,
    },
    records,
  };
}

/** Creates a deterministic file record for filesystem helper tests. */
function fileRecord(fileId: string, path: string, hashCharacter: string): IndexRecord {
  return {
    commitSha: "abcdef1234567890",
    contentHash: `sha256:${hashCharacter.repeat(64)}`,
    fileId,
    isBinary: false,
    isGenerated: false,
    isTest: path.endsWith(".test.ts"),
    isVendored: false,
    language: "typescript",
    lineCount: 4,
    path,
    repoId: "repo_node_fixture",
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    sizeBytes: 64,
    type: "file",
  };
}
