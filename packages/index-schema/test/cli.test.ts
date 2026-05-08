import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
} from "../src";
import { runIndexSchemaCli } from "../src/cli";
import { writeSplitIndexArtifactDirectory } from "../src/node";

/** Temporary directories created by CLI tests. */
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { force: true, recursive: true })));
  tempRoots.length = 0;
});

describe("runIndexSchemaCli", () => {
  it("validates a split artifact and prints a machine-readable summary", async () => {
    const artifactDir = await writeArtifactFixture(artifactWithFiles([fileRecord("file_cli")]));
    const output = memoryIo();

    const exitCode = await runIndexSchemaCli(["validate", artifactDir], output.io);

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(JSON.parse(output.stdout())).toEqual({
      artifactId: "art_cli_fixture",
      chunkCount: 0,
      edgeCount: 0,
      errorCount: 0,
      fileCount: 1,
      recordCount: 1,
      symbolCount: 0,
      valid: true,
    });
  });

  it("returns validation errors with the validation exit code", async () => {
    const artifactDir = await writeArtifactFixture(artifactWithFiles([fileRecord("file_cli")]));
    const manifestPath = join(artifactDir, "index-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as IndexManifest;
    await writeFile(
      manifestPath,
      stringifyIndexManifestJson({ ...manifest, recordCount: manifest.recordCount + 1 }),
      "utf8",
    );
    const output = memoryIo();

    const exitCode = await runIndexSchemaCli(["validate", "--artifact", artifactDir], output.io);

    expect(exitCode).toBe(6);
    expect(output.stderr()).toBe("");
    expect(JSON.parse(output.stdout())).toEqual(
      expect.objectContaining({
        artifactId: "art_cli_fixture",
        errorCount: expect.any(Number),
        errors: expect.arrayContaining([expect.stringContaining("recordCount")]),
        valid: false,
      }),
    );
  });

  it("prints the manifest for a split artifact", async () => {
    const artifactDir = await writeArtifactFixture(artifactWithFiles([fileRecord("file_cli")]));
    const output = memoryIo();

    const exitCode = await runIndexSchemaCli(["print-manifest", artifactDir], output.io);

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(JSON.parse(output.stdout())).toEqual(
      expect.objectContaining({
        artifactId: "art_cli_fixture",
        recordCount: 1,
        recordFiles: [expect.objectContaining({ path: "records.jsonl", recordCount: 1 })],
      }),
    );
  });

  it("counts records for a split artifact", async () => {
    const artifactDir = await writeArtifactFixture(
      artifactWithFiles([fileRecord("file_cli"), fileRecord("file_cli_extra", "src/extra.ts")]),
    );
    const output = memoryIo();

    const exitCode = await runIndexSchemaCli(["count-records", artifactDir], output.io);

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(JSON.parse(output.stdout())).toEqual({
      artifactId: "art_cli_fixture",
      chunkCount: 0,
      edgeCount: 0,
      fileCount: 2,
      parsedRecordCount: 2,
      recordCount: 2,
      recordFileCount: 1,
      symbolCount: 0,
    });
  });

  it("diffs two readable artifacts", async () => {
    const baselineDir = await writeArtifactFixture(artifactWithFiles([fileRecord("file_cli")]));
    const candidateDir = await writeArtifactFixture(
      artifactWithFiles([fileRecord("file_cli"), fileRecord("file_cli_extra", "src/extra.ts")]),
    );
    const output = memoryIo();

    const exitCode = await runIndexSchemaCli(["diff", baselineDir, candidateDir], output.io);

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(JSON.parse(output.stdout())).toEqual(
      expect.objectContaining({
        addedRecords: [{ identity: "file:file_cli_extra", recordType: "file" }],
        summary: expect.objectContaining({ addedRecordCount: 1 }),
      }),
    );
  });

  it("generates a valid split artifact fixture", async () => {
    const root = await createTempRoot();
    const outputPath = join(root, "generated-typescript");
    const output = memoryIo();

    const exitCode = await runIndexSchemaCli(
      ["generate-fixture", "valid-typescript-artifact", "--output", outputPath],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(JSON.parse(output.stdout())).toEqual({
      artifactId: "art_fixture_valid_typescript",
      fixtureName: "valid-typescript-artifact",
      outputPath,
      recordCount: 4,
      valid: true,
    });

    const validationOutput = memoryIo();
    const validationExitCode = await runIndexSchemaCli(
      ["validate", outputPath],
      validationOutput.io,
    );

    expect(validationExitCode).toBe(0);
    expect(JSON.parse(validationOutput.stdout())).toEqual(
      expect.objectContaining({
        artifactId: "art_fixture_valid_typescript",
        recordCount: 4,
        valid: true,
      }),
    );
  });

  it("rejects unknown generated fixture names", async () => {
    const root = await createTempRoot();
    const output = memoryIo();

    const exitCode = await runIndexSchemaCli(
      ["generate-fixture", "unknown-fixture", "--output", join(root, "fixture")],
      output.io,
    );

    expect(exitCode).toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("Unknown generated fixture unknown-fixture");
  });
});

/** Creates a temporary directory and schedules cleanup after the test. */
async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heimdall-index-schema-cli-"));
  tempRoots.push(root);

  return root;
}

/** Writes a split artifact fixture into a temporary directory. */
async function writeArtifactFixture(artifact: IndexArtifact): Promise<string> {
  const root = await createTempRoot();
  await writeSplitIndexArtifactDirectory(root, artifact);

  return root;
}

/** Creates a complete artifact fixture from file records. */
function artifactWithFiles(records: readonly IndexRecord[]): IndexArtifact {
  return {
    manifest: {
      artifactId: "art_cli_fixture",
      chunkCount: 0,
      chunkerVersion: "fixture-chunker.v1",
      commitSha: "abcdef1234567890",
      edgeCount: 0,
      fileCount: records.filter((record) => record.type === "file").length,
      generatedAt: "2026-05-07T12:00:00.000Z",
      indexerName: "fixture-indexer",
      indexerVersion: "0.0.0",
      languages: ["typescript"],
      parserVersions: { typescript: "5.0.0" },
      recordCount: records.length,
      recordSchemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      repoId: "repo_cli_fixture",
      schemaVersion: INDEX_ARTIFACT_SCHEMA_VERSION,
      symbolCount: 0,
    },
    records: [...records],
  };
}

/** Creates a deterministic file record for CLI tests. */
function fileRecord(fileId: string, path = "src/example.ts"): IndexRecord {
  return {
    commitSha: "abcdef1234567890",
    contentHash: `sha256:${"a".repeat(64)}`,
    fileId,
    isBinary: false,
    isGenerated: false,
    isTest: path.endsWith(".test.ts"),
    isVendored: false,
    language: "typescript",
    lineCount: 4,
    path,
    repoId: "repo_cli_fixture",
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    sizeBytes: 64,
    type: "file",
  };
}

/** Creates in-memory stdout and stderr streams for CLI tests. */
function memoryIo(): {
  /** IO object accepted by the CLI runner. */
  readonly io: {
    /** In-memory stderr writer. */
    readonly stderr: { readonly write: (chunk: string) => void };
    /** In-memory stdout writer. */
    readonly stdout: { readonly write: (chunk: string) => void };
  };
  /** Returns accumulated stderr. */
  readonly stderr: () => string;
  /** Returns accumulated stdout. */
  readonly stdout: () => string;
} {
  const chunks = { stderr: "", stdout: "" };

  return {
    io: {
      stderr: {
        write: (chunk: string) => {
          chunks.stderr += chunk;
        },
      },
      stdout: {
        write: (chunk: string) => {
          chunks.stdout += chunk;
        },
      },
    },
    stderr: () => chunks.stderr,
    stdout: () => chunks.stdout,
  };
}
