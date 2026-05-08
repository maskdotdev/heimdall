import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  backgroundJobs,
  codeChunkEmbeddings,
  codeChunks,
  codeEdges,
  embeddingJobItems,
  embeddingJobs,
  type HeimdallDatabase,
  indexedFiles,
  symbols,
} from "@repo/db";
import type { IndexArtifact } from "@repo/indexer-driver";
import {
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricOptions,
  type TelemetryMetricRecorder,
  type TelemetrySpanEndOptions,
  type TelemetrySpanOptions,
  type TelemetrySpanRecorder,
} from "@repo/observability";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileSystemIndexArtifactResolver,
  createIndexArtifactResolverFromEnvironment,
  createIndexImportLimitsFromEnvironment,
  createS3CompatibleIndexArtifactResolver,
  importIndexArtifact,
  readIndexArtifactFromUri,
} from "../src";

/** Temporary directories created by tests. */
const tempRoots: string[] = [];

type RecordedMetric = {
  /** Metric instrument kind recorded by the fake recorder. */
  readonly kind: "counter" | "histogram";
  /** Low-cardinality metric labels. */
  readonly labels?: TelemetryMetricOptions["labels"] | undefined;
  /** Metric name. */
  readonly name: string;
  /** Metric unit. */
  readonly unit?: string | undefined;
  /** Metric value. */
  readonly value: number;
};

type RecordedSpan = {
  /** Attributes attached when the span ended. */
  readonly endAttributes?: TelemetrySpanEndOptions["attributes"] | undefined;
  /** Error attached when the span ended. */
  readonly error?: unknown;
  /** Span name. */
  readonly name: string;
  /** Attributes attached when the span started. */
  readonly startAttributes?: TelemetrySpanOptions["attributes"] | undefined;
  /** Span status attached when the span ended. */
  readonly status?: TelemetrySpanEndOptions["status"] | undefined;
};

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { force: true, recursive: true })));
  tempRoots.length = 0;
});

describe("createFileSystemIndexArtifactResolver", () => {
  it("reads whole-artifact JSON from file URLs", async () => {
    const root = await createTempRoot();
    const artifactPath = join(root, "artifact.json");
    await writeArtifact(artifactPath, emptyArtifact());

    await expect(readIndexArtifactFromUri(pathToFileURL(artifactPath).toString())).resolves.toEqual(
      emptyArtifact(),
    );
  });

  it("reads relative artifact paths inside a configured root", async () => {
    const root = await createTempRoot();
    await writeArtifact(join(root, "repo_1", "artifact.json"), emptyArtifact());
    const resolver = createFileSystemIndexArtifactResolver({ rootPath: root });

    await expect(resolver.readArtifact("repo_1/artifact.json")).resolves.toEqual(emptyArtifact());
  });

  it("reads split artifact directories with manifest and JSONL records", async () => {
    const root = await createTempRoot();
    const artifact = artifactWithChunk();
    const artifactPath = join(root, "repo_1", "index-artifact");
    await writeSplitArtifact(artifactPath, artifact);
    const resolver = createFileSystemIndexArtifactResolver({ rootPath: root });

    await expect(resolver.readArtifact("repo_1/index-artifact")).resolves.toEqual(artifact);
    await expect(readIndexArtifactFromUri(pathToFileURL(artifactPath).toString())).resolves.toEqual(
      artifact,
    );
  });

  it("reports the JSONL line number for invalid split artifact records", async () => {
    const root = await createTempRoot();
    const artifactPath = join(root, "repo_1", "index-artifact");
    await mkdir(artifactPath, { recursive: true });
    await Promise.all([
      writeFile(
        join(artifactPath, "manifest.json"),
        `${JSON.stringify(emptyArtifact().manifest)}\n`,
      ),
      writeFile(join(artifactPath, "records.jsonl"), "{}\nnot-json\n"),
    ]);
    const resolver = createFileSystemIndexArtifactResolver({ rootPath: root });

    await expect(resolver.readArtifact("repo_1/index-artifact")).rejects.toThrow(
      "Invalid index artifact JSONL record at line 2.",
    );
  });

  it("enforces split artifact JSONL record count limits while reading", async () => {
    const root = await createTempRoot();
    const artifact = artifactWithFiles(2);
    const artifactPath = join(root, "repo_1", "index-artifact");
    await writeSplitArtifact(artifactPath, artifact);
    const resolver = createFileSystemIndexArtifactResolver({ rootPath: root });

    await expect(
      resolver.readArtifact("repo_1/index-artifact", {
        importLimits: { maxRecords: 1 },
      }),
    ).rejects.toThrow("Index artifact JSONL record count exceeds configured maximum 1.");
  });

  it("enforces split artifact JSONL line byte limits without echoing record text", async () => {
    const root = await createTempRoot();
    const artifact = artifactWithChunk();
    const artifactPath = join(root, "repo_1", "index-artifact");
    await writeSplitArtifact(artifactPath, artifact);

    let caughtError: unknown;
    try {
      await readIndexArtifactFromUri(pathToFileURL(artifactPath).toString(), {
        importLimits: { maxRecordBytes: 12 },
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    const message = caughtError instanceof Error ? caughtError.message : "";
    expect(message).toContain("line 1 exceeds configured maximum 12 bytes");
    expect(message).not.toContain("src/index.ts");
  });

  it("rejects paths outside a configured artifact root", async () => {
    const root = await createTempRoot();
    const resolver = createFileSystemIndexArtifactResolver({ rootPath: root });

    await expect(resolver.readArtifact("../outside.json")).rejects.toThrow(
      "Index artifact path is outside the configured artifact root.",
    );
  });

  it("rejects unsupported URI schemes without a custom resolver", async () => {
    await expect(readIndexArtifactFromUri("s3://bucket/key/artifact.json")).rejects.toThrow(
      "Unsupported index artifact URI scheme: s3:",
    );
  });

  it("reads whole-artifact JSON from S3-compatible object storage", async () => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const resolver = createS3CompatibleIndexArtifactResolver({
      accessKeyId: "AKIA_TEST",
      bucket: "heimdall-index-artifacts",
      endpoint: "https://objects.example.test",
      fetch: async (input, init) => {
        requests.push({ init, url: input.toString() });

        return new Response(JSON.stringify(emptyArtifact()), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
      now: () => new Date("2026-05-07T12:00:00.000Z"),
      region: "auto",
      secretAccessKey: "secret",
    });

    await expect(
      resolver.readArtifact("s3://heimdall-index-artifacts/repo_1/artifact.json"),
    ).resolves.toEqual(emptyArtifact());
    expect(requests).toEqual([
      expect.objectContaining({
        init: expect.objectContaining({
          headers: expect.objectContaining({
            authorization: expect.stringContaining("AWS4-HMAC-SHA256 Credential=AKIA_TEST/"),
            "x-amz-date": "20260507T120000Z",
          }),
          method: "GET",
        }),
        url: "https://objects.example.test/heimdall-index-artifacts/repo_1/artifact.json",
      }),
    ]);
  });

  it("treats R2 artifact URIs as S3-compatible object locations", async () => {
    const requestedUrls: string[] = [];
    const resolver = createS3CompatibleIndexArtifactResolver({
      accessKeyId: "AKIA_TEST",
      bucket: "heimdall-index-artifacts",
      endpoint: "https://objects.example.test",
      fetch: async (input) => {
        requestedUrls.push(input.toString());

        return new Response(JSON.stringify(emptyArtifact()), { status: 200 });
      },
      region: "auto",
      secretAccessKey: "secret",
    });

    await expect(
      resolver.readArtifact("r2://heimdall-index-artifacts/repo_1/artifact.json"),
    ).resolves.toEqual(emptyArtifact());
    expect(requestedUrls).toEqual([
      "https://objects.example.test/heimdall-index-artifacts/repo_1/artifact.json",
    ]);
  });

  it("creates a filesystem resolver from environment roots", async () => {
    const root = await createTempRoot();
    await writeArtifact(join(root, "artifact.json"), emptyArtifact());
    const resolver = createIndexArtifactResolverFromEnvironment({
      HEIMDALL_INDEX_ARTIFACT_ROOT: root,
    });

    await expect(resolver.readArtifact("artifact.json")).resolves.toEqual(emptyArtifact());
  });

  it("creates an S3-compatible resolver from environment object-storage settings", async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      requestedUrls.push(input.toString());

      return new Response(JSON.stringify(emptyArtifact()), { status: 200 });
    };
    globalThis.fetch = fakeFetch;

    try {
      const resolver = createIndexArtifactResolverFromEnvironment({
        HEIMDALL_INDEX_ARTIFACT_ACCESS_KEY_ID: "AKIA_TEST",
        HEIMDALL_INDEX_ARTIFACT_BUCKET: "heimdall-index-artifacts",
        HEIMDALL_INDEX_ARTIFACT_ENDPOINT: "https://objects.example.test",
        HEIMDALL_INDEX_ARTIFACT_REGION: "auto",
        HEIMDALL_INDEX_ARTIFACT_SECRET_ACCESS_KEY: "secret",
      });

      await expect(
        resolver.readArtifact("s3://heimdall-index-artifacts/repo_1/artifact.json"),
      ).resolves.toEqual(emptyArtifact());
      expect(requestedUrls).toEqual([
        "https://objects.example.test/heimdall-index-artifacts/repo_1/artifact.json",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("importIndexArtifact telemetry", () => {
  it("creates import limits from INDEX_IMPORT_MAX environment values", () => {
    expect(
      createIndexImportLimitsFromEnvironment({
        INDEX_IMPORT_MAX_CHUNK_TEXT_BYTES: "64",
        INDEX_IMPORT_MAX_CHUNKS: "6",
        INDEX_IMPORT_MAX_EDGES: "7",
        INDEX_IMPORT_MAX_FILES: "3",
        INDEX_IMPORT_MAX_RECORD_BYTES: "128",
        INDEX_IMPORT_MAX_RECORDS: "2",
        INDEX_IMPORT_MAX_SYMBOLS: "5",
      }),
    ).toMatchObject({
      maxChunkTextBytes: 64,
      maxChunks: 6,
      maxEdges: 7,
      maxFiles: 3,
      maxRecordBytes: 128,
      maxRecords: 2,
      maxSymbols: 5,
    });
  });

  it("records product-safe successful import metrics and spans", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const result = await importIndexArtifact(emptyArtifact(), {
      artifactUri: "file:///tmp/index-artifact.json",
      db: createImportDatabaseStub(),
      metrics: createRecordingMetrics(metrics),
      traces: createRecordingTraces(spans),
    });

    expect(result).toMatchObject({
      chunkCount: 0,
      edgeCount: 0,
      embeddingJobCount: 0,
      fileCount: 0,
      symbolCount: 0,
    });
    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: {
            indexer: "fake-indexer",
            status: "succeeded",
          },
          name: OBSERVABILITY_METRIC_NAMES.indexImporterImportsTotal,
        }),
        expect.objectContaining({
          kind: "histogram",
          labels: {
            indexer: "fake-indexer",
            status: "succeeded",
          },
          name: OBSERVABILITY_METRIC_NAMES.indexImporterDurationMs,
          unit: "ms",
        }),
      ]),
    );
    expect(spans).toEqual([
      expect.objectContaining({
        endAttributes: expect.objectContaining({
          "app.index_version_id": expect.stringMatching(/^idx_/u),
          "index_importer.embedding_job_count": 0,
          "index_importer.status": "succeeded",
        }),
        name: OBSERVABILITY_SPAN_NAMES.indexImporterImportArtifact,
        startAttributes: expect.objectContaining({
          "app.repo_id": "repo_1",
          "index_importer.indexer": "fake-indexer",
          "index_importer.record_count": 0,
        }),
        status: "ok",
      }),
    ]);
    expect(JSON.stringify(metrics)).not.toContain("index-artifact.json");
    expect(JSON.stringify(spans)).not.toContain("index-artifact.json");
  });

  it("writes normalized records in bounded insert batches", async () => {
    const insertedRows: unknown[] = [];
    const result = await importIndexArtifact(artifactWithFiles(5), {
      artifactUri: "file:///tmp/index-artifact.json",
      db: createRecordingImportDatabaseStub(insertedRows),
      importRecordBatchSize: 2,
    });

    const batchLengths = insertedRows.filter(isUnknownArray).map((batch) => batch.length);
    expect(result).toMatchObject({
      fileCount: 5,
    });
    expect(batchLengths).toEqual([2, 2, 1]);
  });

  it("records durable import batch progress and activation state", async () => {
    const insertedRows: unknown[] = [];
    const updatedRows: unknown[] = [];
    const result = await importIndexArtifact(artifactWithFiles(2), {
      artifactUri: "file:///tmp/index-artifact.json",
      db: createRecordingImportDatabaseStub(insertedRows, updatedRows),
      importRecordBatchSize: 2,
    });

    expect(result.importBatchId).toMatch(/^imb_/u);
    expect(insertedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chunkCount: 0,
          edgeCount: 0,
          fileCount: 2,
          indexImportBatchId: result.importBatchId,
          phase: "validating_manifest",
          recordCount: 2,
          status: "running",
          symbolCount: 0,
        }),
      ]),
    );
    expect(updatedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          indexVersionId: result.indexVersionId,
          phase: "writing_records",
        }),
        expect.objectContaining({
          status: "ready",
        }),
        expect.objectContaining({
          embeddingJobCount: 0,
          phase: "complete",
          status: "complete",
        }),
      ]),
    );
  });

  it("creates durable embedding planner rows and queued batch jobs", async () => {
    const insertedRows: unknown[] = [];
    const result = await importIndexArtifact(artifactWithChunk(), {
      artifactUri: "file:///tmp/index-artifact.json",
      db: createEmbeddingPlanningImportDatabaseStub(insertedRows),
      embeddingBatchSize: 1,
      embeddingDimensions: 2,
      embeddingModel: "text-embedding-3-small",
      embeddingProvider: "hash",
      enqueueEmbeddings: true,
    });

    expect(result).toMatchObject({
      chunkCount: 1,
      embeddingJobCount: 1,
    });
    expect(insertedRows.find(hasRecordKey("embeddingJobId"))).toEqual(
      expect.objectContaining({
        chunkCountPlanned: 1,
        dimensions: 2,
        embeddingJobId: expect.stringMatching(/^embjob_/u),
        embeddingProfileVersion: "code_embedding_profile.v1",
        model: "text-embedding-3-small",
        orgId: "org_1",
        provider: "hash",
        reason: "index_import",
        repoId: "repo_1",
        status: "pending",
      }),
    );
    expect(insertedRows.find(isEmbeddingJobItemBatch)).toEqual([
      expect.objectContaining({
        chunkId: "chunk_1",
        embeddingJobId: expect.stringMatching(/^embjob_/u),
        embeddingJobItemId: expect.stringMatching(/^embitem_/u),
        status: "pending",
      }),
    ]);
    expect(findRecordWithValue(insertedRows, "jobType", "embedding.batch.v1")).toEqual(
      expect.objectContaining({
        jobKey: expect.stringMatching(/^embedding:embjob_/u),
        jobType: "embedding.batch.v1",
        payload: expect.objectContaining({
          payload: expect.objectContaining({
            chunkIds: ["chunk_1"],
            embeddingJobId: expect.stringMatching(/^embjob_/u),
            embeddingProfileVersion: "code_embedding_profile.v1",
          }),
        }),
        queueName: "embedding",
        repoId: "repo_1",
        status: "pending",
      }),
    );
    expect(findRecordWithValue(insertedRows, "jobType", "embedding.repair.v1")).toEqual(
      expect.objectContaining({
        jobKey: expect.stringMatching(/^embedding:repair:embjob_/u),
        jobType: "embedding.repair.v1",
        payload: expect.objectContaining({
          payload: expect.objectContaining({
            dimensions: 2,
            embeddingJobId: expect.stringMatching(/^embjob_/u),
            embeddingProfileVersion: "code_embedding_profile.v1",
            indexVersionId: result.indexVersionId,
            model: "text-embedding-3-small",
            provider: "hash",
            repoId: "repo_1",
          }),
          scheduledFor: expect.any(String),
        }),
        queueName: "embedding",
        repoId: "repo_1",
        scheduledAt: expect.any(Date),
        status: "pending",
      }),
    );
  });

  it("writes embedding planner items in bounded insert batches", async () => {
    const insertedRows: unknown[] = [];
    const result = await importIndexArtifact(artifactWithChunks(5), {
      artifactUri: "file:///tmp/index-artifact.json",
      db: createEmbeddingPlanningImportDatabaseStub(insertedRows),
      embeddingBatchSize: 5,
      embeddingDimensions: 2,
      embeddingModel: "text-embedding-3-small",
      embeddingProvider: "hash",
      enqueueEmbeddings: true,
      importRecordBatchSize: 2,
    });

    expect(result).toMatchObject({
      chunkCount: 5,
      embeddingJobCount: 1,
    });
    expect(insertedRows.filter(isEmbeddingJobItemBatch).map((batch) => batch.length)).toEqual([
      2, 2, 1,
    ]);
  });

  it("returns existing ready imports without rewriting rows", async () => {
    const artifactHash = `sha256:${"c".repeat(64)}` as const;
    const insertedRows: unknown[] = [];

    const result = await importIndexArtifact(artifactWithHash(artifactWithChunk(), artifactHash), {
      artifactUri: "file:///tmp/index-artifact.json",
      db: createEmbeddingPlanningImportDatabaseStub(insertedRows, {
        existingIndexVersion: {
          artifactHash,
          chunkCount: 7,
          edgeCount: 3,
          fileCount: 2,
          indexVersionId: "idx_existing",
          status: "ready",
          symbolCount: 5,
        },
      }),
    });

    expect(result).toMatchObject({
      chunkCount: 7,
      edgeCount: 3,
      fileCount: 2,
      indexVersionId: "idx_existing",
      symbolCount: 5,
    });
    expect(insertedRows).toEqual([]);
  });

  it("cleans stale rows before retrying a failed import", async () => {
    const artifactHash = `sha256:${"d".repeat(64)}` as const;
    const deletedTables: unknown[] = [];

    await expect(
      importIndexArtifact(artifactWithHash(artifactWithChunk(), artifactHash), {
        artifactUri: "file:///tmp/index-artifact.json",
        db: createEmbeddingPlanningImportDatabaseStub([], {
          deletedTables,
          existingIndexVersion: {
            artifactHash,
            chunkCount: 1,
            edgeCount: 0,
            fileCount: 1,
            indexVersionId: "idx_failed",
            status: "failed",
            symbolCount: 0,
          },
        }),
      }),
    ).resolves.toMatchObject({
      chunkCount: 1,
      fileCount: 1,
    });

    expect(deletedTables).toEqual([
      backgroundJobs,
      embeddingJobItems,
      codeChunkEmbeddings,
      embeddingJobs,
      codeEdges,
      codeChunks,
      symbols,
      indexedFiles,
    ]);
  });

  it("cleans partial rows when embedding planner writes fail", async () => {
    const deletedTables: unknown[] = [];

    await expect(
      importIndexArtifact(artifactWithChunk(), {
        artifactUri: "file:///tmp/index-artifact.json",
        db: createEmbeddingPlanningImportDatabaseStub([], {
          deletedTables,
          failOnJobType: "embedding.batch.v1",
        }),
        embeddingBatchSize: 1,
        embeddingDimensions: 2,
        embeddingModel: "text-embedding-3-small",
        embeddingProvider: "hash",
        enqueueEmbeddings: true,
      }),
    ).rejects.toThrow("embedding planner write failed");

    expect(deletedTables).toEqual([
      backgroundJobs,
      embeddingJobItems,
      codeChunkEmbeddings,
      embeddingJobs,
      codeEdges,
      codeChunks,
      symbols,
      indexedFiles,
    ]);
  });

  it("creates distinct index versions for different artifact hashes", async () => {
    const first = await importIndexArtifact(
      artifactWithHash(artifactWithChunk(), `sha256:${"e".repeat(64)}`),
      {
        artifactUri: "file:///tmp/index-artifact-a.json",
        db: createImportDatabaseStub(),
      },
    );
    const second = await importIndexArtifact(
      artifactWithHash(artifactWithChunk(), `sha256:${"f".repeat(64)}`),
      {
        artifactUri: "file:///tmp/index-artifact-b.json",
        db: createImportDatabaseStub(),
      },
    );

    expect(first.indexVersionId).not.toBe(second.indexVersionId);
  });

  it("marks import batches failed when record writes fail", async () => {
    const insertedRows: unknown[] = [];
    const updatedRows: unknown[] = [];

    await expect(
      importIndexArtifact(artifactWithFiles(1), {
        artifactUri: "file:///tmp/index-artifact.json",
        db: createFailingImportDatabaseStub(insertedRows, updatedRows),
      }),
    ).rejects.toThrow("database write failed");

    expect(insertedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          indexImportBatchId: expect.stringMatching(/^imb_/u),
          phase: "validating_manifest",
          status: "running",
        }),
      ]),
    );
    expect(updatedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: expect.objectContaining({
            class: "db_error",
            message: "database write failed",
          }),
          phase: "failed",
          status: "failed",
        }),
      ]),
    );
  });

  it("rejects artifacts that exceed configured import record limits", async () => {
    const updatedRows: unknown[] = [];

    await expect(
      importIndexArtifact(artifactWithFiles(2), {
        artifactUri: "file:///tmp/index-artifact.json",
        db: createRecordingImportDatabaseStub([], updatedRows),
        importLimits: { maxFiles: 1, maxRecords: 1 },
      }),
    ).rejects.toThrow("validation limits exceeded");

    expect(updatedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: expect.objectContaining({
            class: "validation_error",
            message: expect.stringContaining("fileCount 2 exceeds configured maximum 1"),
          }),
          phase: "failed",
          status: "failed",
        }),
      ]),
    );
  });

  it("rejects chunk text that exceeds configured byte limits without echoing source text", async () => {
    const artifact = artifactWithChunks(1);
    const chunkText = "export const value1 = 1;";

    let caughtError: unknown;
    try {
      await importIndexArtifact(artifact, {
        artifactUri: "file:///tmp/index-artifact.json",
        db: createImportDatabaseStub(),
        importLimits: { maxChunkTextBytes: 8 },
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    const message = caughtError instanceof Error ? caughtError.message : "";
    expect(message).toContain("chunkTextBytes[1]");
    expect(message).not.toContain(chunkText);
  });

  it("records validation failure telemetry without importing records", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const invalidArtifact = {
      ...emptyArtifact(),
      manifest: { ...emptyArtifact().manifest, recordCount: 1 },
    } satisfies IndexArtifact;

    await expect(
      importIndexArtifact(invalidArtifact, {
        artifactUri: "file:///tmp/index-artifact.json",
        db: createImportDatabaseStub(),
        metrics: createRecordingMetrics(metrics),
        traces: createRecordingTraces(spans),
      }),
    ).rejects.toThrow("Invalid index artifact:");

    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: {
            error_class: "validation_error",
            indexer: "fake-indexer",
            status: "failed",
          },
          name: OBSERVABILITY_METRIC_NAMES.indexImporterImportsTotal,
        }),
        expect.objectContaining({
          labels: { indexer: "fake-indexer" },
          name: OBSERVABILITY_METRIC_NAMES.indexImporterValidationFailuresTotal,
          value: 1,
        }),
      ]),
    );
    expect(spans).toEqual([
      expect.objectContaining({
        endAttributes: expect.objectContaining({
          "index_importer.error_class": "validation_error",
          "index_importer.status": "failed",
          "index_importer.validation_failure_count": 1,
        }),
        status: "error",
      }),
    ]);
  });
});

/** Creates a temporary root directory and schedules cleanup. */
async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heimdall-index-importer-"));
  tempRoots.push(root);

  return root;
}

/** Writes an index artifact JSON file to disk. */
async function writeArtifact(path: string, artifact: IndexArtifact): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

/** Writes a split manifest and JSONL records artifact directory to disk. */
async function writeSplitArtifact(path: string, artifact: IndexArtifact): Promise<void> {
  await mkdir(path, { recursive: true });
  await Promise.all([
    writeFile(join(path, "manifest.json"), `${JSON.stringify(artifact.manifest, null, 2)}\n`),
    writeFile(
      join(path, "records.jsonl"),
      `${artifact.records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    ),
  ]);
}

/** Creates a minimal valid index artifact for resolver tests. */
function emptyArtifact(): IndexArtifact {
  return {
    manifest: {
      artifactId: "art_1",
      chunkCount: 0,
      chunkerVersion: "chunker.v1",
      commitSha: "abc1234",
      edgeCount: 0,
      fileCount: 0,
      generatedAt: "2026-05-07T12:00:00.000Z",
      indexerName: "fake-indexer",
      indexerVersion: "0.0.0",
      languages: [],
      parserVersions: {},
      recordCount: 0,
      recordSchemaVersion: "index_record.v1",
      repoId: "repo_1",
      schemaVersion: "index_artifact.v1",
      symbolCount: 0,
    },
    records: [],
  };
}

/** Creates a minimal valid index artifact with one file and one chunk. */
function artifactWithChunk(): IndexArtifact {
  return artifactWithChunks(1);
}

/** Returns an artifact with an explicit manifest hash for deterministic idempotency tests. */
function artifactWithHash(
  artifact: IndexArtifact,
  artifactHash: `sha256:${string}`,
): IndexArtifact {
  return {
    ...artifact,
    manifest: {
      ...artifact.manifest,
      artifactHash,
    },
  };
}

/** Creates a valid index artifact with one file and several chunks. */
function artifactWithChunks(count: number): IndexArtifact {
  return {
    manifest: {
      ...emptyArtifact().manifest,
      chunkCount: count,
      fileCount: 1,
      languages: ["typescript"],
      recordCount: count + 1,
    },
    records: [
      {
        type: "file",
        schemaVersion: "index_record.v1",
        fileId: "file_1",
        repoId: "repo_1",
        commitSha: "abc1234",
        path: "src/index.ts",
        language: "typescript",
        contentHash: `sha256:${"a".repeat(64)}`,
        sizeBytes: 42,
        lineCount: 2,
        isBinary: false,
        isGenerated: false,
        isTest: false,
        isVendored: false,
      },
      ...Array.from({ length: count }, (_, index) => ({
        type: "chunk" as const,
        schemaVersion: "index_record.v1" as const,
        chunkId: `chunk_${index + 1}`,
        fileId: "file_1",
        repoId: "repo_1",
        commitSha: "abc1234",
        path: "src/index.ts",
        language: "typescript" as const,
        range: { endLine: 2, startLine: 1 },
        kind: "file" as const,
        text: `export const value${index + 1} = ${index + 1};`,
        contentHash: `sha256:${(index + 1).toString(16).padStart(64, "b")}`,
        tokenEstimate: 8,
      })),
    ],
  };
}

/** Creates a valid index artifact with only file records. */
function artifactWithFiles(count: number): IndexArtifact {
  return {
    manifest: {
      ...emptyArtifact().manifest,
      fileCount: count,
      languages: ["typescript"],
      recordCount: count,
    },
    records: Array.from({ length: count }, (_, index) => ({
      type: "file",
      schemaVersion: "index_record.v1",
      fileId: `file_${index + 1}`,
      repoId: "repo_1",
      commitSha: "abc1234",
      path: `src/file-${index + 1}.ts`,
      language: "typescript",
      contentHash: `sha256:${index.toString(16).padStart(64, "0")}`,
      sizeBytes: 42,
      lineCount: 2,
      isBinary: false,
      isGenerated: false,
      isTest: false,
      isVendored: false,
    })),
  };
}

/** Creates the minimum DB surface needed by empty artifact imports. */
function createImportDatabaseStub(): HeimdallDatabase {
  return createRecordingImportDatabaseStub([]);
}

/** Creates the minimum DB surface and records transaction insert payloads. */
function createRecordingImportDatabaseStub(
  insertedRows: unknown[],
  updatedRows: unknown[] = [],
): HeimdallDatabase {
  const tx = {
    delete: (_table: unknown) => ({
      where: async (_input: unknown) => undefined,
    }),
    insert: (_table: unknown) => ({
      values: (values: unknown) => {
        insertedRows.push(values);

        return {
          onConflictDoNothing: async () => undefined,
          onConflictDoUpdate: async (_input: unknown) => undefined,
        };
      },
    }),
    update: (_table: unknown) => ({
      set: (values: unknown) => {
        updatedRows.push(values);

        return {
          where: async (_input: unknown) => undefined,
        };
      },
    }),
  };
  const db = {
    insert: (_table: unknown) => ({
      values: (values: unknown) => {
        insertedRows.push(values);

        return {
          onConflictDoNothing: async () => undefined,
          onConflictDoUpdate: async (_input: unknown) => undefined,
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve([]), {
            limit: async () => [],
          }),
      }),
    }),
    transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx),
    update: (_table: unknown) => ({
      set: (values: unknown) => {
        updatedRows.push(values);

        return {
          where: async (_input: unknown) => undefined,
        };
      },
    }),
  };

  return db as unknown as HeimdallDatabase;
}

/** Creates a DB stub that fails when the importer enters the record transaction. */
function createFailingImportDatabaseStub(
  insertedRows: unknown[],
  updatedRows: unknown[],
): HeimdallDatabase {
  const db = createRecordingImportDatabaseStub(insertedRows, updatedRows) as unknown as {
    /** Failing transaction replacement for write-error tests. */
    transaction: (callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  db.transaction = async () => {
    throw new Error("database write failed");
  };

  return db as unknown as HeimdallDatabase;
}

/** Narrows an unknown value to an array for insert-batch assertions. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Narrows an unknown value to a plain record. */
function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Creates a predicate that matches inserted row records containing a key. */
function hasRecordKey(key: string): (value: unknown) => value is Readonly<Record<string, unknown>> {
  return (value): value is Readonly<Record<string, unknown>> =>
    isUnknownRecord(value) && key in value;
}

/** Finds the first recorded row object with an exact key/value pair. */
function findRecordWithValue(
  values: readonly unknown[],
  key: string,
  expected: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return values.find(
    (value): value is Readonly<Record<string, unknown>> =>
      isUnknownRecord(value) && value[key] === expected,
  );
}

/** Narrows an inserted value to a batch of embedding job item rows. */
function isEmbeddingJobItemBatch(value: unknown): value is readonly unknown[] {
  return (
    isUnknownArray(value) &&
    value.every((row) => isUnknownRecord(row) && "embeddingJobItemId" in row)
  );
}

/** Creates the DB surface needed by embedding planner import tests. */
function createEmbeddingPlanningImportDatabaseStub(
  insertedRows: unknown[],
  options: {
    /** Tables passed to delete statements. */
    readonly deletedTables?: unknown[];
    /** Job type that should fail when inserted through the root DB facade. */
    readonly failOnJobType?: string;
    /** Existing index version row returned by the import preflight. */
    readonly existingIndexVersion?: Readonly<Record<string, unknown>>;
  } = {},
): HeimdallDatabase {
  const updatedRows: unknown[] = [];
  const tx = {
    delete: (table: unknown) => ({
      where: async (_input: unknown) => {
        options.deletedTables?.push(table);
      },
    }),
    insert: (_table: unknown) => ({
      values: (_values: unknown) => ({
        onConflictDoNothing: async () => undefined,
        onConflictDoUpdate: async (_input: unknown) => undefined,
      }),
    }),
    update: (_table: unknown) => ({
      set: (values: unknown) => {
        updatedRows.push(values);

        return {
          where: async (_input: unknown) => undefined,
        };
      },
    }),
  };
  const db = {
    insert: (_table: unknown) => ({
      values: (values: unknown) => {
        insertedRows.push(values);

        return {
          onConflictDoNothing: async () => {
            if (
              isUnknownRecord(values) &&
              options.failOnJobType !== undefined &&
              values.jobType === options.failOnJobType
            ) {
              throw new Error("embedding planner write failed");
            }
          },
          onConflictDoUpdate: async (_input: unknown) => undefined,
        };
      },
    }),
    select: (selection?: Readonly<Record<string, unknown>>) => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve(selectRowsForImportStub(selection, options)), {
            limit: async (count: number) =>
              selectRowsForImportStub(selection, options).slice(0, count),
          }),
      }),
    }),
    transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx),
    update: (_table: unknown) => ({
      set: (values: unknown) => {
        updatedRows.push(values);

        return {
          where: async (_input: unknown) => undefined,
        };
      },
    }),
  };

  return db as unknown as HeimdallDatabase;
}

/** Returns canned select rows for importer preflight and repository-owner lookups. */
function selectRowsForImportStub(
  selection: Readonly<Record<string, unknown>> | undefined,
  options: {
    /** Existing index version row returned by the import preflight. */
    readonly existingIndexVersion?: Readonly<Record<string, unknown>>;
  },
): readonly Readonly<Record<string, unknown>>[] {
  if (selection && "orgId" in selection) {
    return [{ orgId: "org_1" }];
  }

  return options.existingIndexVersion ? [options.existingIndexVersion] : [];
}

function createRecordingMetrics(records: RecordedMetric[]): TelemetryMetricRecorder {
  return {
    count: (name, options) => {
      records.push({
        kind: "counter",
        labels: options?.labels,
        name,
        unit: options?.unit,
        value: options?.value ?? 1,
      });
    },
    gauge: () => undefined,
    histogram: (name, value, options) => {
      records.push({
        kind: "histogram",
        labels: options?.labels,
        name,
        unit: options?.unit,
        value,
      });
    },
  };
}

function createRecordingTraces(records: RecordedSpan[]): TelemetrySpanRecorder {
  return {
    startSpan: (name, options) => ({
      end: (endOptions = {}) => {
        records.push({
          endAttributes: endOptions.attributes,
          error: endOptions.error,
          name,
          startAttributes: options?.attributes,
          status: endOptions.status,
        });
        return undefined;
      },
    }),
  };
}
