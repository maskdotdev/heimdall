import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IndexArtifact, IndexerCapabilities, RemoteIndexerFetch } from "../src";
import {
  buildSafeIndexerEnv,
  createCliIndexerDriver,
  createFakeIndexerDriver,
  createIndexerDriverRegistry,
  createRemoteIndexerDriver,
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

/** Returns a fake CLI script that exits unsuccessfully after noisy output. */
function failingCliScript(): string {
  return `
process.stdout.write("1234567890");
process.stderr.write("abcdefghij");
process.exit(2);
`;
}
