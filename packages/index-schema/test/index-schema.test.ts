import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  diffIndexArtifacts,
  INDEX_ARTIFACT_SCHEMA_VERSION,
  INDEX_RECORD_SCHEMA_VERSION,
  type IndexArtifact,
  IndexArtifactSchema,
  type IndexRecord,
  IndexRecordSchema,
  isSupportedIndexArtifactFeature,
  isSupportedIndexManifestVersion,
  isSupportedIndexRecordVersion,
  parseIndexRecordsJsonl,
  stringifyIndexRecordsJsonl,
  validateIndexArtifact,
} from "../src";

const repoId = "repo_123";
const commitSha = "abcdef1234567890";
const fileId = "file_source";
const symbolId = "sym_service";
const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");

/** Expected compatibility outcome for a checked-in artifact fixture. */
interface CompatibilityFixtureExpectation {
  /** Fixture file name under packages/index-schema/fixtures. */
  readonly fileName: string;
  /** Whether the complete fixture should satisfy the current artifact schema. */
  readonly validArtifact: boolean;
  /** Whether the fixture manifest uses a supported artifact schema version. */
  readonly supportedManifestVersion: boolean;
  /** Whether every fixture record uses a supported record schema version. */
  readonly supportedRecordVersions: boolean;
}

/** Checked-in compatibility fixtures that pin current and stale version behavior. */
const compatibilityFixtureExpectations: readonly CompatibilityFixtureExpectation[] = [
  {
    fileName: "current-artifact.json",
    supportedManifestVersion: true,
    supportedRecordVersions: true,
    validArtifact: true,
  },
  {
    fileName: "metadata-extension-artifact.json",
    supportedManifestVersion: true,
    supportedRecordVersions: true,
    validArtifact: true,
  },
  {
    fileName: "stale-artifact-version.json",
    supportedManifestVersion: false,
    supportedRecordVersions: true,
    validArtifact: false,
  },
  {
    fileName: "stale-record-version.json",
    supportedManifestVersion: true,
    supportedRecordVersions: false,
    validArtifact: false,
  },
  {
    fileName: "unsafe-path-artifact.json",
    supportedManifestVersion: true,
    supportedRecordVersions: true,
    validArtifact: false,
  },
];

describe("IndexArtifactSchema", () => {
  it("accepts the current compatibility fixture for every record variant", () => {
    const artifact = canonicalIndexArtifactFixture();

    expect(Value.Check(IndexArtifactSchema, artifact)).toBe(true);
    expect(artifact.records.map((record) => record.type)).toEqual([
      "file",
      "symbol",
      "edge",
      "chunk",
      "diagnostic",
      "dependency",
      "route",
      "test_mapping",
    ]);
    expect(artifact.records.every((record) => Value.Check(IndexRecordSchema, record))).toBe(true);
    expect(isSupportedIndexManifestVersion(artifact.manifest.schemaVersion)).toBe(true);
    expect(artifact.records.every((record) => isSupportedIndexRecordVersion(record))).toBe(true);
  });

  it("rejects stale artifact and record schema versions", () => {
    const artifact = canonicalIndexArtifactFixture();
    const staleArtifact = {
      ...artifact,
      manifest: {
        ...artifact.manifest,
        schemaVersion: "index_artifact.v0",
      },
    };
    const [firstRecord] = artifact.records;
    if (!firstRecord) {
      throw new Error("Compatibility fixture must include at least one record.");
    }
    const staleRecord = {
      ...firstRecord,
      schemaVersion: "index_record.v0",
    };

    expect(Value.Check(IndexArtifactSchema, staleArtifact)).toBe(false);
    expect(Value.Check(IndexRecordSchema, staleRecord)).toBe(false);
    expect(isSupportedIndexManifestVersion("index_artifact.v0")).toBe(false);
    expect(isSupportedIndexRecordVersion(staleRecord)).toBe(false);
  });

  it("rejects extra artifact root properties", () => {
    const artifact = {
      ...canonicalIndexArtifactFixture(),
      extra: true,
    };

    expect(Value.Check(IndexArtifactSchema, artifact)).toBe(false);
  });

  it("keeps checked-in compatibility fixtures aligned with version policy", () => {
    for (const fixture of compatibilityFixtureExpectations) {
      const artifact = readArtifactFixture(fixture.fileName);
      const manifestVersion = readManifestSchemaVersion(artifact);
      const recordVersions = readRecordVersionInputs(artifact);

      expect(Value.Check(IndexArtifactSchema, artifact), fixture.fileName).toBe(
        fixture.validArtifact,
      );
      expect(isSupportedIndexManifestVersion(manifestVersion), fixture.fileName).toBe(
        fixture.supportedManifestVersion,
      );
      expect(recordVersions.every(isSupportedIndexRecordVersion), fixture.fileName).toBe(
        fixture.supportedRecordVersions,
      );
    }
  });

  it("validates coherent checked-in artifacts with schema-owned semantic checks", () => {
    const artifact = readArtifactFixture("current-artifact.json");

    expect(validateIndexArtifact(artifact)).toEqual([]);
  });

  it("rejects unsupported required manifest features and ignores optional feature extensions", () => {
    const artifact = readArtifactFixture("current-artifact.json");
    const unsupportedRequiredFeatureArtifact = {
      ...asRecord(artifact),
      manifest: {
        ...asRecord(asRecord(artifact).manifest),
        requiredFeatures: ["record_ordering.v1", "future_required_feature.v1"],
      },
    };
    const optionalFeatureArtifact = {
      ...asRecord(artifact),
      manifest: {
        ...asRecord(asRecord(artifact).manifest),
        optionalFeatures: ["future_optional_feature.v1"],
      },
    };

    expect(isSupportedIndexArtifactFeature("record_ordering.v1")).toBe(true);
    expect(isSupportedIndexArtifactFeature("future_required_feature.v1")).toBe(false);
    expect(validateIndexArtifact(unsupportedRequiredFeatureArtifact)).toEqual(
      expect.arrayContaining([
        "manifest.requiredFeatures includes unsupported feature future_required_feature.v1",
      ]),
    );
    expect(validateIndexArtifact(optionalFeatureArtifact)).toEqual([]);
  });

  it("round-trips compact JSONL records and reports bounded parse failures", () => {
    const artifact = canonicalIndexArtifactFixture();
    const jsonl = stringifyIndexRecordsJsonl(artifact.records);

    expect(jsonl.endsWith("\n")).toBe(true);
    expect(jsonl).not.toContain("\n\n");
    expect(parseIndexRecordsJsonl(jsonl)).toEqual(artifact.records);
    expect(() => parseIndexRecordsJsonl("\n")).toThrow(
      "Invalid index artifact JSONL record at line 1: empty line.",
    );
    expect(() => parseIndexRecordsJsonl(`${jsonl}`, { limits: { maxRecords: 1 } })).toThrow(
      "Index artifact JSONL record count exceeds configured maximum 1.",
    );
    expect(() =>
      parseIndexRecordsJsonl(jsonl, {
        limits: { maxRecordBytes: 1 },
      }),
    ).toThrow("Index artifact JSONL record at line 1 exceeds configured maximum 1 bytes.");
  });

  it("diffs manifest and record-level artifact changes by stable identity", () => {
    const baseline = canonicalIndexArtifactFixture();
    const [fileRecord, ...remainingRecords] = baseline.records;
    if (!fileRecord || fileRecord.type !== "file") {
      throw new Error("Compatibility fixture must start with a file record.");
    }
    const changedFile = {
      ...fileRecord,
      contentHash: sha256Fixture("f"),
    } satisfies IndexRecord;
    const addedFile = {
      ...fileRecord,
      contentHash: sha256Fixture("e"),
      fileId: "file_added",
      path: "src/added.ts",
    } satisfies IndexRecord;
    const candidate = {
      manifest: {
        ...baseline.manifest,
        fileCount: baseline.manifest.fileCount + 1,
        recordCount: baseline.manifest.recordCount,
      },
      records: [changedFile, ...remainingRecords, addedFile],
    } satisfies IndexArtifact;

    const diff = diffIndexArtifacts(baseline, candidate);

    expect(diff.summary).toEqual({
      addedRecordCount: 1,
      changedRecordCount: 1,
      manifestChangeCount: 1,
      removedRecordCount: 0,
    });
    expect(diff.addedRecords).toEqual([{ identity: "file:file_added", recordType: "file" }]);
    expect(diff.changedRecords.map((record) => record.identity)).toEqual(["file:file_source"]);
    expect(diff.manifestChanges).toEqual([
      {
        baselineValue: 1,
        candidateValue: 2,
        field: "fileCount",
      },
    ]);
  });
});

/** Reads one checked-in artifact fixture as unknown boundary data. */
function readArtifactFixture(fileName: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, fileName), "utf8")) as unknown;
}

/** Reads an artifact fixture manifest schema version without trusting the full schema. */
function readManifestSchemaVersion(value: unknown): string {
  const manifest = asRecord(asRecord(value).manifest);
  const schemaVersion = manifest.schemaVersion;

  if (typeof schemaVersion !== "string") {
    throw new Error("Artifact fixture manifest must include a string schemaVersion.");
  }

  return schemaVersion;
}

/** Reads artifact fixture record schema versions without trusting the full schema. */
function readRecordVersionInputs(value: unknown): readonly { readonly schemaVersion: string }[] {
  const records = asRecord(value).records;

  if (!Array.isArray(records)) {
    throw new Error("Artifact fixture must include a records array.");
  }

  return records.map((record) => {
    const schemaVersion = asRecord(record).schemaVersion;
    if (typeof schemaVersion !== "string") {
      throw new Error("Artifact fixture record must include a string schemaVersion.");
    }

    return { schemaVersion };
  });
}

/** Narrows an unknown value to an object record for fixture boundary reads. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected artifact fixture value to be an object record.");
  }

  return value as Readonly<Record<string, unknown>>;
}

/** Creates a deterministic fixture that exercises every current index record variant. */
function canonicalIndexArtifactFixture(): IndexArtifact {
  const records: IndexRecord[] = [
    {
      type: "file",
      schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      fileId,
      repoId,
      commitSha,
      path: "src/service.ts",
      language: "typescript",
      contentHash: sha256Fixture("a"),
      sizeBytes: 128,
      lineCount: 12,
      isBinary: false,
      isGenerated: false,
      isTest: false,
      isVendored: false,
    },
    {
      type: "symbol",
      schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      symbolId,
      fileId,
      repoId,
      commitSha,
      path: "src/service.ts",
      language: "typescript",
      name: "Service",
      qualifiedName: "Service",
      kind: "class",
      range: { startLine: 1, endLine: 8 },
      selectionRange: { startLine: 1, endLine: 1 },
      signature: "export class Service",
      visibility: "public",
      contentHash: sha256Fixture("b"),
    },
    {
      type: "edge",
      schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      edgeId: "edge_file_defines_service",
      repoId,
      commitSha,
      fromId: fileId,
      toId: symbolId,
      fromKind: "file",
      toKind: "symbol",
      kind: "defines",
      confidence: 1,
    },
    {
      type: "chunk",
      schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      chunkId: "chunk_service",
      fileId,
      symbolId,
      repoId,
      commitSha,
      path: "src/service.ts",
      language: "typescript",
      range: { startLine: 1, endLine: 8 },
      kind: "symbol",
      text: "export class Service {}",
      contentHash: sha256Fixture("c"),
      tokenEstimate: 6,
    },
    {
      type: "diagnostic",
      schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      diagnosticId: "diag_tsc_123",
      repoId,
      commitSha,
      path: "src/service.ts",
      range: { startLine: 4, endLine: 4 },
      source: "tsc",
      severity: "warning",
      code: "TS6133",
      message: "Declared value is never read.",
    },
    {
      type: "dependency",
      schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      dependencyId: "dep_typescript",
      repoId,
      commitSha,
      manifestPath: "package.json",
      packageManager: "pnpm",
      name: "typescript",
      versionSpec: "^5.0.0",
      dependencyType: "dev",
    },
    {
      type: "route",
      schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      routeId: "route_get_health",
      repoId,
      commitSha,
      path: "src/service.ts",
      language: "typescript",
      routePattern: "/health",
      methods: ["GET"],
      handlerSymbolId: symbolId,
      range: { startLine: 10, endLine: 12 },
      framework: "fastify",
      confidence: 0.9,
    },
    {
      type: "test_mapping",
      schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      testMappingId: "testmap_service",
      repoId,
      commitSha,
      testFileId: "file_service_test",
      targetFileId: fileId,
      targetSymbolId: symbolId,
      confidence: 0.8,
    },
  ];

  return {
    manifest: {
      schemaVersion: INDEX_ARTIFACT_SCHEMA_VERSION,
      recordSchemaVersion: INDEX_RECORD_SCHEMA_VERSION,
      artifactId: "art_current_schema_fixture",
      repoId,
      commitSha,
      indexerName: "fixture-indexer",
      indexerVersion: "0.0.0",
      chunkerVersion: "fixture-chunker.v1",
      generatedAt: "2026-05-07T12:00:00.000Z",
      languages: ["typescript"],
      recordCount: records.length,
      fileCount: 1,
      symbolCount: 1,
      edgeCount: 1,
      chunkCount: 1,
      parserVersions: { typescript: "5.0.0" },
    },
    records,
  };
}

/** Returns a syntactically valid SHA-256 fixture hash for schema tests. */
function sha256Fixture(hexCharacter: string): `sha256:${string}` {
  return `sha256:${hexCharacter.repeat(64)}`;
}
