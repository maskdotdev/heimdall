import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { IndexArtifact } from "@repo/indexer-driver";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileSystemIndexArtifactResolver,
  createIndexArtifactResolverFromEnvironment,
  createS3CompatibleIndexArtifactResolver,
  readIndexArtifactFromUri,
} from "../src";

/** Temporary directories created by tests. */
const tempRoots: string[] = [];

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
