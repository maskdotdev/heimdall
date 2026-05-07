import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  INDEX_ARTIFACT_SCHEMA_VERSION,
  INDEX_RECORD_SCHEMA_VERSION,
  type IndexArtifact,
  IndexArtifactSchema,
  type IndexRecord,
  IndexRecordSchema,
  isSupportedIndexManifestVersion,
  isSupportedIndexRecordVersion,
} from "../src";

const repoId = "repo_123";
const commitSha = "abcdef1234567890";
const fileId = "file_source";
const symbolId = "sym_service";

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
});

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
