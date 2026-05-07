import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HeimdallDatabase } from "@repo/db";
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
    expect(insertedRows).toHaveLength(4);
    expect(insertedRows[0]).toEqual(
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
    expect(insertedRows[1]).toEqual([
      expect.objectContaining({
        chunkId: "chunk_1",
        embeddingJobId: expect.stringMatching(/^embjob_/u),
        embeddingJobItemId: expect.stringMatching(/^embitem_/u),
        status: "pending",
      }),
    ]);
    expect(insertedRows[2]).toEqual(
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
    expect(insertedRows[3]).toEqual(
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
  return {
    manifest: {
      ...emptyArtifact().manifest,
      chunkCount: 1,
      fileCount: 1,
      languages: ["typescript"],
      recordCount: 2,
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
      {
        type: "chunk",
        schemaVersion: "index_record.v1",
        chunkId: "chunk_1",
        fileId: "file_1",
        repoId: "repo_1",
        commitSha: "abc1234",
        path: "src/index.ts",
        language: "typescript",
        range: { endLine: 2, startLine: 1 },
        kind: "file",
        text: "export const value = 1;",
        contentHash: `sha256:${"b".repeat(64)}`,
        tokenEstimate: 8,
      },
    ],
  };
}

/** Creates the minimum DB surface needed by empty artifact imports. */
function createImportDatabaseStub(): HeimdallDatabase {
  const tx = {
    insert: (_table: unknown) => ({
      values: (_values: unknown) => ({
        onConflictDoNothing: async () => undefined,
        onConflictDoUpdate: async (_input: unknown) => undefined,
      }),
    }),
  };
  const db = {
    transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx),
  };

  return db as unknown as HeimdallDatabase;
}

/** Creates the DB surface needed by embedding planner import tests. */
function createEmbeddingPlanningImportDatabaseStub(insertedRows: unknown[]): HeimdallDatabase {
  const tx = {
    insert: (_table: unknown) => ({
      values: (_values: unknown) => ({
        onConflictDoNothing: async () => undefined,
        onConflictDoUpdate: async (_input: unknown) => undefined,
      }),
    }),
  };
  const db = {
    insert: (_table: unknown) => ({
      values: (values: unknown) => {
        insertedRows.push(values);

        return {
          onConflictDoNothing: async () => undefined,
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve([{ orgId: "org_1" }]), {
            limit: async (count: number) => [{ orgId: "org_1" }].slice(0, count),
          }),
      }),
    }),
    transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx),
  };

  return db as unknown as HeimdallDatabase;
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
