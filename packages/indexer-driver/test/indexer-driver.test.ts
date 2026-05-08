import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryAttributeValue,
  type TelemetryMetricRecorder,
  type TelemetrySpanRecorder,
} from "@repo/observability";
import { afterEach, describe, expect, it } from "vitest";
import type { IndexArtifact, IndexerCapabilities, RemoteIndexerFetch } from "../src";
import {
  buildSafeIndexerEnv,
  createCliIndexerDriver,
  createFakeIndexerDriver,
  createIndexerDriverRegistry,
  createRemoteIndexerDriver,
  validateIndexArtifact,
  validateIndexArtifactForMode,
  withIndexerTelemetry,
  withIndexerTimeout,
} from "../src";

describe("buildSafeIndexerEnv", () => {
  it("passes only allowlisted process environment values plus NO_COLOR", () => {
    expect(
      buildSafeIndexerEnv({
        allowlist: ["PATH", "LANG"],
        sourceEnv: {
          DATABASE_URL: "postgres://secret",
          LANG: "C.UTF-8",
          PATH: "/usr/bin",
        },
      }),
    ).toEqual({
      LANG: "C.UTF-8",
      NO_COLOR: "1",
      PATH: "/usr/bin",
    });
  });
});

describe("validateIndexArtifact", () => {
  it("accepts artifacts with coherent cross-record references", () => {
    expect(validateIndexArtifact(validSemanticArtifact())).toEqual([]);
  });

  it("rejects artifacts that move backward in canonical record type order", () => {
    const artifact = validSemanticArtifact();
    const [file, symbol, chunk, edge] = artifact.records;
    if (!file || !symbol || !chunk || !edge) {
      throw new Error("Semantic validation fixture is missing records.");
    }

    expect(
      validateIndexArtifact({
        ...artifact,
        records: [edge, file, symbol, chunk],
      }),
    ).toEqual(expect.arrayContaining(["records[1].type file appears after edge records"]));
  });

  it("reports cross-record semantic errors without exposing record text", () => {
    const errors = validateIndexArtifact(invalidSemanticArtifact());

    expect(errors).toEqual(
      expect.arrayContaining([
        "records[1].fileId duplicates file_index",
        "records[1].path duplicates src/index.ts",
        "records[2].repoId repo_2 does not match repo_1",
        "records[2].commitSha def5678 does not match abc1234",
        "records[2].range.endLine 2 is before startLine 4",
        "records[2].selectionRange.endLine 3 is before startLine 5",
        "manifest.fileCount 1 does not match 2 records",
        "records[2].fileId references missing record file_missing",
        "records[3].fileId references missing record file_missing",
        "records[3].symbolId references missing record sym_missing",
        "records[4].fromId references missing symbol record sym_missing",
        "records[4].toId references missing chunk record chunk_missing",
        "records[5].handlerSymbolId references missing record sym_missing",
        "records[6].testFileId references missing record file_missing_test",
        "records[6].targetFileId references missing record file_missing_target",
        "records[6].targetSymbolId references missing record sym_missing",
      ]),
    );
    expect(errors.join("\n")).not.toContain("super-secret-token");
  });

  it("supports manifest-only boundary validation", () => {
    expect(
      validateIndexArtifactForMode(invalidSemanticArtifact(), { mode: "manifest_only" }),
    ).toEqual([]);
  });

  it("supports sampled boundary validation without walking unsampled record text", () => {
    const errors = validateIndexArtifactForMode(invalidSemanticArtifact(), {
      mode: "sample",
      sampleSize: 3,
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "records[2].repoId repo_2 does not match repo_1",
        "records[2].commitSha def5678 does not match abc1234",
        "records[2].range.endLine 2 is before startLine 4",
        "records[2].selectionRange.endLine 3 is before startLine 5",
      ]),
    );
    expect(errors.join("\n")).not.toContain("super-secret-token");
  });

  it("rejects unsupported required features in manifest-only validation", () => {
    const artifact = validSemanticArtifact();

    expect(
      validateIndexArtifactForMode(
        {
          ...artifact,
          manifest: {
            ...artifact.manifest,
            requiredFeatures: ["future_feature.v1", "future_feature.v1"],
          },
        },
        { mode: "manifest_only" },
      ),
    ).toEqual([
      "manifest.requiredFeatures includes unsupported feature future_feature.v1",
      "manifest.requiredFeatures duplicates future_feature.v1",
    ]);
  });
});

describe("createCliIndexerDriver", () => {
  it("reads machine-readable CLI capabilities", async () => {
    const artifactRoot = await createTempRoot();
    const driver = createCliIndexerDriver({
      artifactRootPath: artifactRoot,
      args: ["-e", capabilitiesCliScript()],
      command: process.execPath,
    });

    await expect(driver.getCapabilities()).resolves.toMatchObject({
      driverName: "node-fake-cli",
      driverVersion: "0.0.0",
      supportedArtifactSchemaVersions: ["index_artifact.v1"],
    });
  });

  it("writes request files, captures logs, and reads valid CLI artifacts", async () => {
    const artifactRoot = await createTempRoot();
    const workspaceRoot = await createTempRoot();
    const workspacePath = await createTempRoot(workspaceRoot);
    const driver = createCliIndexerDriver({
      artifactRootPath: artifactRoot,
      args: ["-e", successfulCliScript()],
      command: process.execPath,
      envAllowlist: ["PATH"],
      name: "node-fake-cli",
      timeoutMs: 1_000,
      workspaceRootPath: workspaceRoot,
    });

    const result = await driver.indexRepository({
      commitSha: "abc1234",
      repoId: "repo_1",
      workspacePath,
    });

    expect(result).toMatchObject({
      artifact: {
        manifest: {
          artifactId: "art_repo_1_abc1234",
          recordCount: 0,
        },
      },
      diagnostics: expect.arrayContaining(["stdout: cli stdout", "stderr: cli stderr"]),
      ok: true,
    });
    const requestFiles = await findFiles(artifactRoot, "request.json");
    const stdoutLogs = await findFiles(artifactRoot, "stdout.log");
    const stderrLogs = await findFiles(artifactRoot, "stderr.log");
    expect(requestFiles).toHaveLength(1);
    expect(stdoutLogs).toHaveLength(1);
    expect(stderrLogs).toHaveLength(1);
    await expect(readJsonFile(requestFiles[0] ?? "")).resolves.toMatchObject({
      commitSha: "abc1234",
      repoId: "repo_1",
      workspacePath,
    });
    await expect(readFile(stdoutLogs[0] ?? "", "utf8")).resolves.toBe("cli stdout\n");
    await expect(readFile(stderrLogs[0] ?? "", "utf8")).resolves.toBe("cli stderr\n");
  });

  it("honors manifest-only validation mode for CLI artifacts", async () => {
    const artifactRoot = await createTempRoot();
    const workspacePath = await createTempRoot();
    const driver = createCliIndexerDriver({
      artifactRootPath: artifactRoot,
      args: ["-e", artifactCliScript(invalidSemanticArtifact())],
      command: process.execPath,
      timeoutMs: 1_000,
      validationMode: "manifest_only",
    });

    await expect(
      driver.indexRepository({
        commitSha: "abc1234",
        repoId: "repo_1",
        workspacePath,
      }),
    ).resolves.toMatchObject({
      artifact: {
        manifest: {
          artifactId: "art_repo_1_abc1234_semantic",
          recordCount: 7,
        },
      },
      ok: true,
    });
  });

  it("returns normalized failures for non-zero exits with truncated logs", async () => {
    const artifactRoot = await createTempRoot();
    const workspacePath = await createTempRoot();
    const driver = createCliIndexerDriver({
      artifactRootPath: artifactRoot,
      args: ["-e", failingCliScript()],
      command: process.execPath,
      stderrMaxBytes: 5,
      stdoutMaxBytes: 5,
      timeoutMs: 1_000,
    });

    await expect(
      driver.indexRepository({
        commitSha: "abc1234",
        repoId: "repo_1",
        workspacePath,
      }),
    ).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        "stdout: 12345",
        "stderr: abcde",
        "stdout truncated after 5 bytes.",
        "stderr truncated after 5 bytes.",
      ]),
      error: {
        code: "process_exit_nonzero",
        details: { exitCode: 2, stderr: "abcde" },
      },
      ok: false,
    });
  });

  it("terminates timed-out CLI processes", async () => {
    const artifactRoot = await createTempRoot();
    const workspacePath = await createTempRoot();
    const driver = createCliIndexerDriver({
      artifactRootPath: artifactRoot,
      args: ["-e", "setTimeout(() => undefined, 10_000);"],
      command: process.execPath,
      killGraceMs: 1,
      timeoutMs: 1,
    });

    await expect(
      driver.indexRepository({
        commitSha: "abc1234",
        repoId: "repo_1",
        workspacePath,
      }),
    ).resolves.toMatchObject({
      error: { code: "timeout" },
      ok: false,
    });
  });
});

describe("createRemoteIndexerDriver", () => {
  it("loads remote capabilities", async () => {
    const fetcher: RemoteIndexerFetch = async (input, init) => {
      expect(`${init?.method ?? "GET"} ${String(input)}`).toBe(
        "GET https://indexer.example/v1/capabilities",
      );

      return jsonResponse(testCapabilities("remote-indexer"));
    };
    const driver = createRemoteIndexerDriver({
      baseUrl: "https://indexer.example/",
      fetch: fetcher,
    });

    await expect(driver.getCapabilities()).resolves.toMatchObject({
      driverName: "remote-indexer",
      supportedArtifactSchemaVersions: ["index_artifact.v1"],
    });
  });

  it("returns inline remote artifacts and preserves durable artifact URIs", async () => {
    const artifact = emptyArtifact();
    const calls: string[] = [];
    const fetcher: RemoteIndexerFetch = async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      expect(init?.headers).toMatchObject({ authorization: "Bearer remote-token" });

      return jsonResponse({
        artifact,
        artifactUri: "s3://heimdall-index-artifacts/repo_1/abc1234/artifact.json",
        diagnostics: ["remote complete"],
        status: "succeeded",
      });
    };
    const driver = createRemoteIndexerDriver({
      baseUrl: "https://indexer.example/",
      bearerToken: "remote-token",
      fetch: fetcher,
    });

    await expect(
      driver.indexRepository({
        commitSha: "abc1234",
        repoId: "repo_1",
        workspacePath: "/tmp/repo",
      }),
    ).resolves.toMatchObject({
      artifact,
      artifactUri: "s3://heimdall-index-artifacts/repo_1/abc1234/artifact.json",
      diagnostics: ["remote complete"],
      ok: true,
    });
    expect(calls).toEqual(["POST https://indexer.example/v1/index-runs"]);
  });

  it("honors manifest-only validation mode for inline remote artifacts", async () => {
    const artifact = invalidSemanticArtifact();
    const driver = createRemoteIndexerDriver({
      baseUrl: "https://indexer.example/",
      fetch: async () =>
        jsonResponse({
          artifact,
          diagnostics: ["remote complete"],
          status: "succeeded",
        }),
      validationMode: "manifest_only",
    });

    await expect(
      driver.indexRepository({
        commitSha: "abc1234",
        repoId: "repo_1",
        workspacePath: "/tmp/repo",
      }),
    ).resolves.toMatchObject({
      artifact,
      diagnostics: ["remote complete"],
      ok: true,
    });
  });

  it("polls pending remote runs and downloads artifact JSON", async () => {
    const artifact = emptyArtifact();
    const calls: string[] = [];
    const fetcher: RemoteIndexerFetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);

      if (url === "https://indexer.example/v1/index-runs" && init?.method === "POST") {
        return jsonResponse({
          diagnostics: ["queued"],
          remoteRunId: "remote_idxrun_1",
          status: "queued",
        });
      }
      if (url === "https://indexer.example/v1/index-runs/remote_idxrun_1") {
        return jsonResponse({
          artifactUri: "s3://heimdall-index-artifacts/repo_1/abc1234/artifact.json",
          artifactUrl: "https://storage.example/artifact.json",
          diagnostics: ["finished"],
          status: "succeeded",
        });
      }
      if (url === "https://storage.example/artifact.json") {
        expect(init?.headers).toMatchObject({ accept: "application/json" });

        return jsonResponse({ artifact });
      }

      return jsonResponse({ message: "not found" }, 404);
    };
    const driver = createRemoteIndexerDriver({
      baseUrl: "https://indexer.example",
      fetch: fetcher,
      maxPollMs: 100,
      pollIntervalMs: 1,
    });

    await expect(
      driver.indexRepository({
        commitSha: "abc1234",
        repoId: "repo_1",
        workspacePath: "/tmp/repo",
      }),
    ).resolves.toMatchObject({
      artifact,
      artifactUri: "s3://heimdall-index-artifacts/repo_1/abc1234/artifact.json",
      diagnostics: ["queued", "finished"],
      ok: true,
    });
    expect(calls).toEqual([
      "POST https://indexer.example/v1/index-runs",
      "GET https://indexer.example/v1/index-runs/remote_idxrun_1",
      "GET https://storage.example/artifact.json",
    ]);
  });

  it("normalizes failed remote jobs", async () => {
    const driver = createRemoteIndexerDriver({
      baseUrl: "https://indexer.example",
      fetch: async () =>
        jsonResponse({
          diagnostics: ["remote failed"],
          status: "failed",
        }),
    });

    await expect(
      driver.indexRepository({
        commitSha: "abc1234",
        repoId: "repo_1",
        workspacePath: "/tmp/repo",
      }),
    ).resolves.toMatchObject({
      diagnostics: ["remote failed"],
      error: { code: "remote_job_failed" },
      ok: false,
    });
  });
});

describe("createIndexerDriverRegistry", () => {
  it("resolves registered drivers by stable name", () => {
    const fake = createFakeIndexerDriver({ name: "fake-a" });
    const registry = createIndexerDriverRegistry([
      createFakeIndexerDriver({ name: "fake-b" }),
      fake,
    ]);

    expect(registry.names()).toEqual(["fake-a", "fake-b"]);
    expect(registry.get("fake-a")).toBe(fake);
    expect(registry.get("missing")).toBeUndefined();
  });

  it("rejects duplicate driver names", () => {
    expect(() =>
      createIndexerDriverRegistry([
        createFakeIndexerDriver({ name: "fake" }),
        createFakeIndexerDriver({ name: "fake" }),
      ]),
    ).toThrow("Duplicate indexer driver registered: fake");
  });
});

describe("createFakeIndexerDriver", () => {
  it("returns configured capabilities", async () => {
    const driver = createFakeIndexerDriver({
      capabilities: {
        supportedArtifactSchemaVersions: ["index_artifact.v1", "index_artifact.v2"],
        supportsRemoteArtifacts: true,
      },
      name: "fake-capabilities",
    });

    await expect(driver.getCapabilities()).resolves.toMatchObject({
      driverName: "fake-capabilities",
      supportedArtifactSchemaVersions: ["index_artifact.v1", "index_artifact.v2"],
      supportsRemoteArtifacts: true,
    });
  });

  it("returns deterministic empty artifacts by default", async () => {
    const driver = createFakeIndexerDriver({ diagnostics: ["fake diagnostic"] });

    await expect(
      driver.indexRepository({
        commitSha: "abc1234",
        repoId: "repo_1",
        workspacePath: "/tmp/repo",
      }),
    ).resolves.toMatchObject({
      artifact: {
        manifest: {
          artifactId: "art_repo_1_abc1234",
          indexerName: "fake",
          recordCount: 0,
        },
        records: [],
      },
      diagnostics: ["fake diagnostic"],
      ok: true,
    });
  });

  it("returns configured failures", async () => {
    const driver = createFakeIndexerDriver({
      failure: { code: "unsupported_language", message: "No supported files." },
    });

    await expect(
      driver.indexRepository({
        commitSha: "abc1234",
        repoId: "repo_1",
        workspacePath: "/tmp/repo",
      }),
    ).resolves.toMatchObject({
      error: { code: "unsupported_language", message: "No supported files." },
      ok: false,
    });
  });
});

describe("withIndexerTimeout", () => {
  it("returns successful driver results before the timeout", async () => {
    let signal: AbortSignal | undefined;
    const driver = withIndexerTimeout(
      {
        name: "fake-indexer",
        version: "0.0.0",
        getCapabilities: async () => testCapabilities("fake-indexer"),
        indexRepository: async (input) => {
          signal = input.signal;

          return { ok: true, artifact: emptyArtifact(), diagnostics: [] };
        },
      },
      { timeoutMs: 100 },
    );

    await expect(
      driver.indexRepository({
        commitSha: "abc123",
        repoId: "repo_1",
        workspacePath: "/tmp/repo",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(signal?.aborted).toBe(false);
  });

  it("returns a normalized timeout result and aborts the wrapped driver signal", async () => {
    let signal: AbortSignal | undefined;
    const driver = withIndexerTimeout(
      {
        name: "hanging-indexer",
        version: "0.0.0",
        getCapabilities: async () => testCapabilities("hanging-indexer"),
        indexRepository: (input) => {
          signal = input.signal;

          return new Promise(() => undefined);
        },
      },
      { timeoutMs: 1 },
    );

    await expect(
      driver.indexRepository({
        commitSha: "abc123",
        repoId: "repo_1",
        workspacePath: "/tmp/repo",
      }),
    ).resolves.toMatchObject({
      diagnostics: ["Indexer hanging-indexer timed out after 1ms."],
      error: {
        code: "timeout",
        details: { driverName: "hanging-indexer", timeoutMs: 1 },
      },
      ok: false,
    });
    expect(signal?.aborted).toBe(true);
  });
});

describe("withIndexerTelemetry", () => {
  it("records successful run metrics and spans without workspace paths", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const driver = withIndexerTelemetry(createFakeIndexerDriver({ name: "Fake Driver" }), {
      metrics: createRecordingMetrics(metrics),
      traceContext: { requestId: "req_indexer_success" },
      traces: createRecordingTraces(spans),
    });

    await expect(
      driver.indexRepository({
        commitSha: "abc123",
        repoId: "repo_1",
        workspacePath: "/tmp/private-indexer-workspace",
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "counter",
          labels: { driver: "fake_driver", status: "succeeded" },
          name: OBSERVABILITY_METRIC_NAMES.indexerDriverRunsTotal,
        }),
        expect.objectContaining({
          kind: "histogram",
          labels: { driver: "fake_driver", status: "succeeded" },
          name: OBSERVABILITY_METRIC_NAMES.indexerDriverDurationMs,
          unit: "ms",
        }),
      ]),
    );
    expect(spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endAttributes: expect.objectContaining({
            "indexer_driver.status": "succeeded",
          }),
          name: OBSERVABILITY_SPAN_NAMES.indexerDriverRun,
          status: "ok",
        }),
      ]),
    );
    expect(JSON.stringify({ metrics, spans })).not.toContain("/tmp/private-indexer-workspace");
  });

  it("records failed timeout results with bounded error labels", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const driver = withIndexerTelemetry(
      createFakeIndexerDriver({
        failure: { code: "timeout", message: "Indexer timed out." },
        name: "timeout-driver",
      }),
      {
        metrics: createRecordingMetrics(metrics),
        traces: createRecordingTraces(spans),
      },
    );

    await expect(
      driver.indexRepository({
        commitSha: "abc123",
        repoId: "repo_1",
        workspacePath: "/tmp/private-indexer-workspace",
      }),
    ).resolves.toMatchObject({
      error: { code: "timeout" },
      ok: false,
    });

    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: {
            driver: "timeout-driver",
            error_class: "timeout_error",
            status: "failed",
          },
          name: OBSERVABILITY_METRIC_NAMES.indexerDriverRunsTotal,
        }),
        expect.objectContaining({
          labels: { driver: "timeout-driver" },
          name: OBSERVABILITY_METRIC_NAMES.indexerDriverTimeoutsTotal,
        }),
      ]),
    );
    expect(spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endAttributes: expect.objectContaining({
            "indexer_driver.error_class": "timeout_error",
            "indexer_driver.error_code": "timeout",
            "indexer_driver.status": "failed",
          }),
          name: OBSERVABILITY_SPAN_NAMES.indexerDriverRun,
          status: "error",
        }),
      ]),
    );
  });

  it("records CLI spawn spans and output byte metrics without raw process output", async () => {
    const artifactRoot = await createTempRoot();
    const workspaceRoot = await createTempRoot();
    const workspacePath = await createTempRoot(workspaceRoot);
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const driver = withIndexerTelemetry(
      createCliIndexerDriver({
        artifactRootPath: artifactRoot,
        args: ["-e", successfulCliScript()],
        command: process.execPath,
        envAllowlist: ["PATH"],
        name: "node-fake-cli",
        timeoutMs: 1_000,
        workspaceRootPath: workspaceRoot,
      }),
      {
        metrics: createRecordingMetrics(metrics),
        traces: createRecordingTraces(spans),
      },
    );

    await expect(
      driver.indexRepository({
        commitSha: "abc1234",
        repoId: "repo_1",
        workspacePath,
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "histogram",
          labels: { driver: "node-fake-cli", status: "exited", stream: "stdout" },
          name: OBSERVABILITY_METRIC_NAMES.indexerDriverOutputBytes,
          unit: "bytes",
          value: 11,
        }),
        expect.objectContaining({
          kind: "histogram",
          labels: { driver: "node-fake-cli", status: "exited", stream: "stderr" },
          name: OBSERVABILITY_METRIC_NAMES.indexerDriverOutputBytes,
          unit: "bytes",
          value: 11,
        }),
        expect.objectContaining({
          kind: "histogram",
          labels: { driver: "node-fake-cli", mode: "full", status: "succeeded" },
          name: OBSERVABILITY_METRIC_NAMES.indexerDriverValidationDurationMs,
          unit: "ms",
        }),
      ]),
    );
    expect(spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endAttributes: expect.objectContaining({
            "indexer_driver.process_status": "exited",
            "indexer_driver.stderr_bytes": 11,
            "indexer_driver.stdout_bytes": 11,
          }),
          name: OBSERVABILITY_SPAN_NAMES.indexerDriverSpawnCli,
          status: "ok",
        }),
        expect.objectContaining({
          name: OBSERVABILITY_SPAN_NAMES.indexerDriverValidateResult,
          status: "ok",
        }),
      ]),
    );
    expect(JSON.stringify({ metrics, spans })).not.toContain("cli stdout");
    expect(JSON.stringify({ metrics, spans })).not.toContain("cli stderr");
    expect(JSON.stringify({ metrics, spans })).not.toContain(workspacePath);
  });

  it("records validation failure and nonzero process metrics with bounded labels", async () => {
    const invalidArtifactRoot = await createTempRoot();
    const invalidWorkspacePath = await createTempRoot();
    const invalidMetrics: RecordedMetric[] = [];
    const invalidDriver = withIndexerTelemetry(
      createCliIndexerDriver({
        artifactRootPath: invalidArtifactRoot,
        args: ["-e", artifactCliScript(invalidSemanticArtifact())],
        command: process.execPath,
        name: "node-fake-cli",
        timeoutMs: 1_000,
        validationMode: "sample",
        validationSampleSize: 3,
      }),
      { metrics: createRecordingMetrics(invalidMetrics) },
    );

    await expect(
      invalidDriver.indexRepository({
        commitSha: "abc1234",
        repoId: "repo_1",
        workspacePath: invalidWorkspacePath,
      }),
    ).resolves.toMatchObject({
      error: { code: "artifact_invalid" },
      ok: false,
    });
    expect(invalidMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "counter",
          labels: { driver: "node-fake-cli", mode: "sample", reason: "record_invalid" },
          name: OBSERVABILITY_METRIC_NAMES.indexerDriverValidationFailuresTotal,
          unit: "1",
        }),
      ]),
    );

    const failingArtifactRoot = await createTempRoot();
    const failingWorkspacePath = await createTempRoot();
    const failingMetrics: RecordedMetric[] = [];
    const failingDriver = withIndexerTelemetry(
      createCliIndexerDriver({
        artifactRootPath: failingArtifactRoot,
        args: ["-e", failingCliScript()],
        command: process.execPath,
        name: "node-fake-cli",
        timeoutMs: 1_000,
      }),
      { metrics: createRecordingMetrics(failingMetrics) },
    );

    await expect(
      failingDriver.indexRepository({
        commitSha: "abc1234",
        repoId: "repo_1",
        workspacePath: failingWorkspacePath,
      }),
    ).resolves.toMatchObject({
      error: { code: "process_exit_nonzero" },
      ok: false,
    });
    expect(failingMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "counter",
          labels: { driver: "node-fake-cli", exit_code: 2 },
          name: OBSERVABILITY_METRIC_NAMES.indexerDriverProcessExitNonzeroTotal,
          unit: "1",
        }),
      ]),
    );
  });
});

/** Recorded metric point used by indexer-driver telemetry tests. */
type RecordedMetric = {
  /** Metric instrument kind. */
  readonly kind: "counter" | "histogram";
  /** Metric labels captured by the test recorder. */
  readonly labels?: Readonly<Record<string, TelemetryAttributeValue | undefined>> | undefined;
  /** Metric name. */
  readonly name: string;
  /** Metric unit. */
  readonly unit?: string | undefined;
  /** Metric value. */
  readonly value: number;
};

/** Recorded span payload used by indexer-driver telemetry tests. */
type RecordedSpan = {
  /** Span attributes captured when the span ended. */
  readonly endAttributes?:
    | Readonly<Record<string, TelemetryAttributeValue | undefined>>
    | undefined;
  /** Span name. */
  readonly name: string;
  /** Span attributes captured when the span started. */
  readonly startAttributes?:
    | Readonly<Record<string, TelemetryAttributeValue | undefined>>
    | undefined;
  /** Span status. */
  readonly status?: "error" | "ok" | "unset" | undefined;
};

/** Creates a metric recorder that stores metric points in memory. */
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

/** Creates a span recorder that stores span records in memory. */
function createRecordingTraces(records: RecordedSpan[]): TelemetrySpanRecorder {
  return {
    startSpan: (name, options) => ({
      end: (endOptions = {}) => {
        records.push({
          endAttributes: endOptions.attributes,
          name,
          startAttributes: options?.attributes,
          status: endOptions.status,
        });
        return undefined;
      },
    }),
  };
}

/** Creates a minimal valid index artifact for timeout wrapper tests. */
function emptyArtifact(): IndexArtifact {
  return {
    manifest: {
      artifactId: "art_1",
      chunkerVersion: "chunker.v1",
      chunkCount: 0,
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

/** Stable valid SHA-256 hash used by artifact validation fixtures. */
const VALID_CONTENT_HASH =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Creates a valid cross-record artifact for semantic validation tests. */
function validSemanticArtifact(): IndexArtifact {
  return {
    manifest: {
      artifactId: "art_repo_1_abc1234_semantic",
      chunkCount: 1,
      chunkerVersion: "chunker.v1",
      commitSha: "abc1234",
      edgeCount: 1,
      fileCount: 1,
      generatedAt: "2026-05-07T12:00:00.000Z",
      indexerName: "semantic-fixture-indexer",
      indexerVersion: "0.0.0",
      languages: ["typescript"],
      parserVersions: { typescript: "5.8.0" },
      recordCount: 4,
      recordSchemaVersion: "index_record.v1",
      repoId: "repo_1",
      schemaVersion: "index_artifact.v1",
      symbolCount: 1,
    },
    records: [
      {
        commitSha: "abc1234",
        contentHash: VALID_CONTENT_HASH,
        fileId: "file_index",
        isBinary: false,
        isGenerated: false,
        isTest: false,
        isVendored: false,
        language: "typescript",
        lineCount: 8,
        path: "src/index.ts",
        repoId: "repo_1",
        schemaVersion: "index_record.v1",
        sizeBytes: 128,
        type: "file",
      },
      {
        commitSha: "abc1234",
        contentHash: VALID_CONTENT_HASH,
        fileId: "file_index",
        kind: "function",
        language: "typescript",
        name: "handler",
        path: "src/index.ts",
        range: { endLine: 4, startLine: 1 },
        repoId: "repo_1",
        schemaVersion: "index_record.v1",
        selectionRange: { endLine: 1, startLine: 1 },
        symbolId: "sym_handler",
        type: "symbol",
      },
      {
        chunkId: "chunk_handler",
        commitSha: "abc1234",
        contentHash: VALID_CONTENT_HASH,
        fileId: "file_index",
        kind: "symbol",
        language: "typescript",
        path: "src/index.ts",
        range: { endLine: 4, startLine: 1 },
        repoId: "repo_1",
        schemaVersion: "index_record.v1",
        symbolId: "sym_handler",
        text: "export function handler() { return true; }",
        tokenEstimate: 8,
        type: "chunk",
      },
      {
        commitSha: "abc1234",
        confidence: 0.9,
        edgeId: "edge_handler_external",
        fromId: "sym_handler",
        fromKind: "symbol",
        kind: "calls",
        repoId: "repo_1",
        schemaVersion: "index_record.v1",
        toId: "npm:react",
        toKind: "external",
        type: "edge",
      },
    ],
  };
}

/** Creates an artifact with semantic errors that TypeBox alone cannot reject. */
function invalidSemanticArtifact(): IndexArtifact {
  const artifact = validSemanticArtifact();

  return {
    manifest: {
      ...artifact.manifest,
      fileCount: 1,
      recordCount: 7,
    },
    records: [
      {
        commitSha: "abc1234",
        contentHash: VALID_CONTENT_HASH,
        fileId: "file_index",
        isBinary: false,
        isGenerated: false,
        isTest: false,
        isVendored: false,
        language: "typescript",
        lineCount: 8,
        path: "src/index.ts",
        repoId: "repo_1",
        schemaVersion: "index_record.v1",
        sizeBytes: 128,
        type: "file",
      },
      {
        commitSha: "abc1234",
        contentHash: VALID_CONTENT_HASH,
        fileId: "file_index",
        isBinary: false,
        isGenerated: false,
        isTest: false,
        isVendored: false,
        language: "typescript",
        lineCount: 12,
        path: "src/index.ts",
        repoId: "repo_1",
        schemaVersion: "index_record.v1",
        sizeBytes: 256,
        type: "file",
      },
      {
        commitSha: "def5678",
        contentHash: VALID_CONTENT_HASH,
        fileId: "file_missing",
        kind: "function",
        language: "typescript",
        name: "orphan",
        path: "src/orphan.ts",
        range: { endLine: 2, startLine: 4 },
        repoId: "repo_2",
        schemaVersion: "index_record.v1",
        selectionRange: { endLine: 3, startLine: 5 },
        symbolId: "sym_orphan",
        type: "symbol",
      },
      {
        chunkId: "chunk_orphan",
        commitSha: "abc1234",
        contentHash: VALID_CONTENT_HASH,
        fileId: "file_missing",
        kind: "symbol",
        language: "typescript",
        path: "src/orphan.ts",
        range: { endLine: 6, startLine: 3 },
        repoId: "repo_1",
        schemaVersion: "index_record.v1",
        symbolId: "sym_missing",
        text: "super-secret-token",
        tokenEstimate: 3,
        type: "chunk",
      },
      {
        commitSha: "abc1234",
        confidence: 0.9,
        edgeId: "edge_missing_endpoint",
        fromId: "sym_missing",
        fromKind: "symbol",
        kind: "references",
        repoId: "repo_1",
        schemaVersion: "index_record.v1",
        toId: "chunk_missing",
        toKind: "chunk",
        type: "edge",
      },
      {
        commitSha: "abc1234",
        confidence: 0.8,
        handlerSymbolId: "sym_missing",
        language: "typescript",
        methods: ["GET"],
        path: "src/routes.ts",
        repoId: "repo_1",
        routeId: "route_health",
        routePattern: "/health",
        schemaVersion: "index_record.v1",
        type: "route",
      },
      {
        commitSha: "abc1234",
        confidence: 0.7,
        repoId: "repo_1",
        schemaVersion: "index_record.v1",
        targetFileId: "file_missing_target",
        targetSymbolId: "sym_missing",
        testFileId: "file_missing_test",
        testMappingId: "test_map_orphan",
        type: "test_mapping",
      },
    ],
  };
}

/** Creates a temporary root directory and schedules cleanup. */
async function createTempRoot(parent = tmpdir()): Promise<string> {
  const root = await mkdtemp(join(parent, "heimdall-indexer-driver-"));
  tempRoots.push(root);

  return root;
}

/** Temporary directories created by tests. */
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { force: true, recursive: true })));
  tempRoots.length = 0;
});

/** Recursively finds files with a specific basename. */
async function findFiles(root: string, basename: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const matches = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        return findFiles(path, basename);
      }

      return entry.name === basename ? [path] : [];
    }),
  );

  return matches.flat();
}

/** Reads a JSON file as an unknown value. */
async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

/** Creates a JSON Fetch response for remote-driver tests. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

/** Creates a minimal valid capabilities object for driver tests. */
function testCapabilities(driverName: string): IndexerCapabilities {
  return {
    driverName,
    driverVersion: "0.0.0",
    supportedArtifactSchemaVersions: ["index_artifact.v1"],
    supportedLanguages: ["typescript"],
    supportedRecordTypes: ["file", "symbol", "edge", "chunk"],
    supportedRequestSchemaVersions: ["index_request.v1"],
    supportsCancellation: false,
    supportsIncremental: false,
    supportsPreviousArtifact: false,
    supportsRemoteArtifacts: false,
    supportsStreamingProgress: false,
  };
}

/** Returns a fake CLI script that prints capabilities JSON. */
function capabilitiesCliScript(): string {
  return `
const args = process.argv.slice(1);
if (args[0] !== "capabilities" || args[1] !== "--json") {
  process.exit(1);
}
console.log(JSON.stringify({
  driverName: "node-fake-cli",
  driverVersion: "0.0.0",
  supportedArtifactSchemaVersions: ["index_artifact.v1"],
  supportedLanguages: ["typescript"],
  supportedRecordTypes: ["file", "symbol", "edge", "chunk"],
  supportedRequestSchemaVersions: ["index_request.v1"],
  supportsCancellation: false,
  supportsIncremental: false,
  supportsPreviousArtifact: false,
  supportsRemoteArtifacts: false,
  supportsStreamingProgress: false
}));
`;
}

/** Returns a fake CLI script that writes a valid empty artifact. */
function successfulCliScript(): string {
  return `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(1);
const requestPath = args[args.indexOf("--request") + 1];
const outputPath = args[args.indexOf("--output") + 1];
const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
console.log("cli stdout");
console.error("cli stderr");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify({
  manifest: {
    artifactId: "art_" + request.repoId + "_" + request.commitSha,
    chunkCount: 0,
    chunkerVersion: "chunker.fake.v1",
    commitSha: request.commitSha,
    edgeCount: 0,
    fileCount: 0,
    generatedAt: "2026-05-07T12:00:00.000Z",
    indexerName: "node-fake-cli",
    indexerVersion: "0.0.0",
    languages: [],
    parserVersions: {},
    recordCount: 0,
    recordSchemaVersion: "index_record.v1",
    repoId: request.repoId,
    schemaVersion: "index_artifact.v1",
    symbolCount: 0
  },
  records: []
}));
`;
}

/** Returns a fake CLI script that writes the provided artifact JSON. */
function artifactCliScript(artifact: IndexArtifact): string {
  return `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(1);
const outputPath = args[args.indexOf("--output") + 1];
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, ${JSON.stringify(JSON.stringify(artifact))});
`;
}

/** Returns a fake CLI script that exits unsuccessfully after noisy output. */
function failingCliScript(): string {
  return `
process.stdout.write("1234567890");
process.stderr.write("abcdefghij");
process.exit(2);
`;
}
