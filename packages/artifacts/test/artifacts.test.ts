import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReviewArtifactPayloadStoreFromEnvironment,
  FILE_SYSTEM_REVIEW_ARTIFACT_STORAGE_MODE,
  FileSystemReviewArtifactPayloadStore,
  hasReviewArtifactPayloadStorage,
  INLINE_REVIEW_ARTIFACT_STORAGE_MODE,
  InlineReviewArtifactPayloadStore,
  isReviewArtifactPayloadDescriptor,
  OBJECT_REVIEW_ARTIFACT_STORAGE_MODE,
  REVIEW_ARTIFACT_JSON_MEDIA_TYPE,
  REVIEW_ARTIFACT_PAYLOAD_DELETION_METADATA_KEY,
  REVIEW_ARTIFACT_PAYLOAD_STORAGE_METADATA_KEY,
  readInlineReviewArtifactPayload,
  reviewArtifactDatabaseUri,
  reviewArtifactPayloadDeletedMetadata,
  reviewArtifactPayloadDescriptor,
  S3CompatibleReviewArtifactPayloadStore,
} from "../src";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { force: true, recursive: true })));
  tempRoots.length = 0;
});

describe("InlineReviewArtifactPayloadStore", () => {
  it("stores JSON payloads with a durable descriptor and inline fallback metadata", async () => {
    const store = new InlineReviewArtifactPayloadStore();

    const record = await store.putJson({
      reviewRunId: "rrn_test",
      kind: "context_bundle",
      name: "context-bundle.json",
      payload: { schemaVersion: "context_bundle.v1", snippets: ["src/index.ts"] },
      metadata: { source: "review-orchestrator" },
    });

    expect(record).toMatchObject({
      mediaType: REVIEW_ARTIFACT_JSON_MEDIA_TYPE,
      mode: INLINE_REVIEW_ARTIFACT_STORAGE_MODE,
      sizeBytes: JSON.stringify({
        schemaVersion: "context_bundle.v1",
        snippets: ["src/index.ts"],
      }).length,
      uri: "db://review_artifacts/rrn_test/context_bundle/context-bundle.json",
      metadata: {
        payload: { schemaVersion: "context_bundle.v1", snippets: ["src/index.ts"] },
        source: "review-orchestrator",
      },
    });
    expect(record.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(record.metadata[REVIEW_ARTIFACT_PAYLOAD_STORAGE_METADATA_KEY]).toEqual(
      reviewArtifactPayloadDescriptor(record),
    );

    await expect(store.getJson({ uri: record.uri, metadata: record.metadata })).resolves.toEqual({
      exists: true,
      payload: { schemaVersion: "context_bundle.v1", snippets: ["src/index.ts"] },
    });
  });

  it("reads legacy inline payload metadata", () => {
    expect(readInlineReviewArtifactPayload({ payload: ["finding"] })).toEqual({
      exists: true,
      payload: ["finding"],
    });
  });

  it("reports payload storage from inline payloads or descriptors", async () => {
    const store = new InlineReviewArtifactPayloadStore();
    const record = await store.putJson({
      reviewRunId: "rrn_test",
      kind: "policy_snapshot",
      name: "policy-snapshot.json",
      payload: { enabled: true },
    });

    expect(hasReviewArtifactPayloadStorage({ payload: { enabled: true } })).toBe(true);
    expect(
      hasReviewArtifactPayloadStorage({
        [REVIEW_ARTIFACT_PAYLOAD_STORAGE_METADATA_KEY]: reviewArtifactPayloadDescriptor(record),
      }),
    ).toBe(true);
    expect(hasReviewArtifactPayloadStorage({ source: "metadata-only" })).toBe(false);
  });

  it("marks inline payloads as deleted so callers can scrub database metadata", async () => {
    const store = new InlineReviewArtifactPayloadStore();
    const record = await store.putJson({
      reviewRunId: "rrn_test",
      kind: "context_bundle",
      name: "context-bundle.json",
      payload: { snippets: ["src/index.ts"] },
    });

    await expect(store.deleteJson({ uri: record.uri, metadata: record.metadata })).resolves.toEqual(
      {
        deleted: true,
      },
    );

    const metadata = reviewArtifactPayloadDeletedMetadata({
      deletedAt: "2026-05-07T12:00:00.000Z",
      metadata: record.metadata,
      reason: "retention_policy",
    });
    expect(metadata).not.toHaveProperty("payload");
    expect(metadata).not.toHaveProperty(REVIEW_ARTIFACT_PAYLOAD_STORAGE_METADATA_KEY);
    expect(metadata[REVIEW_ARTIFACT_PAYLOAD_DELETION_METADATA_KEY]).toEqual({
      deletedAt: "2026-05-07T12:00:00.000Z",
      reason: "retention_policy",
    });
  });
});

describe("FileSystemReviewArtifactPayloadStore", () => {
  it("stores JSON payloads outside database metadata and reads them back from file URIs", async () => {
    const root = await createTempRoot();
    const store = new FileSystemReviewArtifactPayloadStore(root);

    const record = await store.putJson({
      reviewRunId: "rrn_test",
      kind: "orchestrator_trace",
      name: "orchestrator-trace.json",
      payload: { schemaVersion: "orchestrator_trace.v1", stages: ["snapshot"] },
    });

    expect(record).toMatchObject({
      mediaType: REVIEW_ARTIFACT_JSON_MEDIA_TYPE,
      mode: FILE_SYSTEM_REVIEW_ARTIFACT_STORAGE_MODE,
      metadata: {
        [REVIEW_ARTIFACT_PAYLOAD_STORAGE_METADATA_KEY]: reviewArtifactPayloadDescriptor(record),
      },
    });
    expect(record.metadata).not.toHaveProperty("payload");
    expect(record.uri).toMatch(/^file:/);
    expect(hasReviewArtifactPayloadStorage(record.metadata)).toBe(true);

    await expect(store.getJson({ uri: record.uri, metadata: record.metadata })).resolves.toEqual({
      exists: true,
      payload: { schemaVersion: "orchestrator_trace.v1", stages: ["snapshot"] },
    });
  });

  it("does not read file URIs outside the configured artifact root", async () => {
    const root = await createTempRoot();
    const outsideRoot = await createTempRoot();
    const outsideStore = new FileSystemReviewArtifactPayloadStore(outsideRoot);
    const outsideRecord = await outsideStore.putJson({
      reviewRunId: "rrn_test",
      kind: "debug_log",
      name: "debug-log.json",
      payload: { leak: false },
    });

    const store = new FileSystemReviewArtifactPayloadStore(root);

    await expect(
      store.getJson({ uri: outsideRecord.uri, metadata: outsideRecord.metadata }),
    ).resolves.toEqual({ exists: false });
  });

  it("deletes filesystem payloads within the configured artifact root", async () => {
    const root = await createTempRoot();
    const store = new FileSystemReviewArtifactPayloadStore(root);
    const record = await store.putJson({
      reviewRunId: "rrn_test",
      kind: "debug_log",
      name: "debug-log.json",
      payload: { leak: false },
    });

    await expect(store.deleteJson({ uri: record.uri, metadata: record.metadata })).resolves.toEqual(
      {
        deleted: true,
      },
    );
    await expect(store.getJson({ uri: record.uri, metadata: record.metadata })).resolves.toEqual({
      exists: false,
    });
  });
});

describe("S3CompatibleReviewArtifactPayloadStore", () => {
  it("stores JSON payloads in object storage and reads them back with signed requests", async () => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const objects = new Map<string, string>();
    const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      requests.push({ init, url });
      if (init?.method === "PUT") {
        objects.set(url, await new Response(init.body).text());
        return new Response(null, { status: 204 });
      }

      return new Response(objects.get(url), { status: objects.has(url) ? 200 : 404 });
    };
    const store = new S3CompatibleReviewArtifactPayloadStore({
      accessKeyId: "AKIA_TEST",
      bucket: "heimdall-artifacts",
      endpoint: "https://objects.example.test",
      fetch,
      now: () => new Date("2026-05-07T12:00:00.000Z"),
      region: "auto",
      secretAccessKey: "secret",
    });

    const record = await store.putJson({
      reviewRunId: "rrn_test",
      kind: "context_bundle",
      name: "context-bundle.json",
      payload: { schemaVersion: "context_bundle.v1" },
    });

    expect(record).toMatchObject({
      mediaType: REVIEW_ARTIFACT_JSON_MEDIA_TYPE,
      mode: OBJECT_REVIEW_ARTIFACT_STORAGE_MODE,
      metadata: {
        [REVIEW_ARTIFACT_PAYLOAD_STORAGE_METADATA_KEY]: reviewArtifactPayloadDescriptor(record),
      },
      uri: expect.stringMatching(
        /^s3:\/\/heimdall-artifacts\/rrn_test\/context_bundle\/context-bundle\.json-/,
      ),
    });
    expect(requests[0]).toMatchObject({
      init: {
        method: "PUT",
        headers: expect.objectContaining({
          authorization: expect.stringContaining("AWS4-HMAC-SHA256 Credential=AKIA_TEST/"),
          "content-type": REVIEW_ARTIFACT_JSON_MEDIA_TYPE,
          "x-amz-date": "20260507T120000Z",
        }),
      },
      url: expect.stringContaining(
        "https://objects.example.test/heimdall-artifacts/rrn_test/context_bundle/",
      ),
    });

    await expect(store.getJson({ uri: record.uri, metadata: record.metadata })).resolves.toEqual({
      exists: true,
      payload: { schemaVersion: "context_bundle.v1" },
    });
    expect(requests[1]).toMatchObject({
      init: {
        method: "GET",
        headers: expect.objectContaining({
          authorization: expect.stringContaining(
            "SignedHeaders=host;x-amz-content-sha256;x-amz-date",
          ),
        }),
      },
    });
  });

  it("creates short-lived signed object storage download URLs", async () => {
    const store = new S3CompatibleReviewArtifactPayloadStore({
      accessKeyId: "AKIA_TEST",
      bucket: "heimdall-artifacts",
      endpoint: "https://objects.example.test",
      fetch: async () => new Response(null, { status: 204 }),
      now: () => new Date("2026-05-07T12:00:00.000Z"),
      region: "auto",
      secretAccessKey: "secret",
      sessionToken: "session-token",
    });
    const record = await store.putJson({
      reviewRunId: "rrn_test",
      kind: "orchestrator_trace",
      name: "orchestrator-trace.json",
      payload: { schemaVersion: "orchestrator_trace.v1" },
    });

    const signedUrl = await store.createSignedGetUrl({
      expiresInSeconds: 120,
      metadata: record.metadata,
      responseContentDisposition: 'attachment; filename="orchestrator-trace.json"',
      responseContentType: REVIEW_ARTIFACT_JSON_MEDIA_TYPE,
      uri: record.uri,
    });

    expect(signedUrl).toMatchObject({
      exists: true,
      expiresAt: new Date("2026-05-07T12:02:00.000Z"),
    });
    if (!signedUrl.exists) {
      throw new Error("Expected signed URL to exist.");
    }
    const url = new URL(signedUrl.url);
    expect(url.origin).toBe("https://objects.example.test");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "AKIA_TEST/20260507/auto/s3/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260507T120000Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("session-token");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get("response-content-type")).toBe(REVIEW_ARTIFACT_JSON_MEDIA_TYPE);
  });

  it("returns missing when object storage returns 404", async () => {
    const store = new S3CompatibleReviewArtifactPayloadStore({
      accessKeyId: "AKIA_TEST",
      bucket: "heimdall-artifacts",
      fetch: async () => new Response(null, { status: 404 }),
      now: () => new Date("2026-05-07T12:00:00.000Z"),
      region: "us-east-1",
      secretAccessKey: "secret",
    });

    await expect(
      store.getJson({
        metadata: {
          payloadStorage: {
            hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            mediaType: REVIEW_ARTIFACT_JSON_MEDIA_TYPE,
            mode: OBJECT_REVIEW_ARTIFACT_STORAGE_MODE,
            sizeBytes: 0,
            uri: "s3://heimdall-artifacts/missing.json",
          },
        },
        uri: "s3://heimdall-artifacts/missing.json",
      }),
    ).resolves.toEqual({ exists: false });
  });

  it("deletes object-storage payloads with signed DELETE requests", async () => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      requests.push({ init, url: input.toString() });
      return new Response(null, { status: init?.method === "DELETE" ? 204 : 404 });
    };
    const store = new S3CompatibleReviewArtifactPayloadStore({
      accessKeyId: "AKIA_TEST",
      bucket: "heimdall-artifacts",
      endpoint: "https://objects.example.test",
      fetch,
      now: () => new Date("2026-05-07T12:00:00.000Z"),
      region: "auto",
      secretAccessKey: "secret",
    });

    await expect(
      store.deleteJson({
        metadata: {},
        uri: "s3://heimdall-artifacts/rrn_test/context_bundle/context-bundle.json",
      }),
    ).resolves.toEqual({ deleted: true });

    expect(requests[0]).toMatchObject({
      init: {
        method: "DELETE",
        headers: expect.objectContaining({
          authorization: expect.stringContaining("AWS4-HMAC-SHA256 Credential=AKIA_TEST/"),
          "x-amz-date": "20260507T120000Z",
        }),
      },
      url: "https://objects.example.test/heimdall-artifacts/rrn_test/context_bundle/context-bundle.json",
    });
  });

  it("copies object-storage payloads with signed CopyObject requests", async () => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      requests.push({ init, url: input.toString() });
      return new Response(null, { status: init?.method === "PUT" ? 200 : 404 });
    };
    const store = new S3CompatibleReviewArtifactPayloadStore({
      accessKeyId: "AKIA_TEST",
      bucket: "heimdall-artifacts",
      endpoint: "https://objects.example.test",
      fetch,
      keyPrefix: "copied",
      now: () => new Date("2026-05-07T12:00:00.000Z"),
      region: "auto",
      secretAccessKey: "secret",
    });

    const record = await store.copyJson({
      hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      kind: "index_artifact",
      name: "abc1234",
      reviewRunId: "index-artifacts",
      sizeBytes: 128,
      sourceUri: "s3://heimdall-artifacts/remote/repo_1/artifact.json",
    });

    expect(record).toMatchObject({
      hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mediaType: REVIEW_ARTIFACT_JSON_MEDIA_TYPE,
      mode: OBJECT_REVIEW_ARTIFACT_STORAGE_MODE,
      sizeBytes: 128,
      uri: expect.stringMatching(
        /^s3:\/\/heimdall-artifacts\/copied\/index-artifacts\/index_artifact\/abc1234-/u,
      ),
    });
    expect(requests).toEqual([
      expect.objectContaining({
        init: expect.objectContaining({
          headers: expect.objectContaining({
            authorization: expect.stringContaining(
              "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-copy-source;x-amz-date;x-amz-meta-sha256;x-amz-meta-size-bytes;x-amz-metadata-directive",
            ),
            "content-type": REVIEW_ARTIFACT_JSON_MEDIA_TYPE,
            "x-amz-copy-source": "/heimdall-artifacts/remote/repo_1/artifact.json",
            "x-amz-date": "20260507T120000Z",
            "x-amz-metadata-directive": "REPLACE",
          }),
          method: "PUT",
        }),
        url: expect.stringMatching(
          /^https:\/\/objects\.example\.test\/heimdall-artifacts\/copied\/index-artifacts\/index_artifact\/abc1234-/u,
        ),
      }),
    ]);
  });
});

describe("createReviewArtifactPayloadStoreFromEnvironment", () => {
  it("prefers filesystem storage when a local artifact root is configured", () => {
    expect(
      createReviewArtifactPayloadStoreFromEnvironment({
        HEIMDALL_REVIEW_ARTIFACT_ROOT: "/tmp/heimdall-artifacts",
      }),
    ).toBeInstanceOf(FileSystemReviewArtifactPayloadStore);
  });

  it("uses S3-compatible storage when object storage credentials are configured", () => {
    expect(
      createReviewArtifactPayloadStoreFromEnvironment({
        HEIMDALL_REVIEW_ARTIFACT_ACCESS_KEY_ID: "AKIA_TEST",
        HEIMDALL_REVIEW_ARTIFACT_BUCKET: "heimdall-artifacts",
        HEIMDALL_REVIEW_ARTIFACT_SECRET_ACCESS_KEY: "secret",
      }),
    ).toBeInstanceOf(S3CompatibleReviewArtifactPayloadStore);
  });
});

describe("review artifact payload descriptors", () => {
  it("validates descriptor shape before treating metadata as stored payload", async () => {
    const store = new InlineReviewArtifactPayloadStore();
    const record = await store.putJson({
      reviewRunId: "rrn_test",
      kind: "plan_snapshot",
      name: "plan-snapshot.json",
      payload: { planKey: "free" },
    });

    expect(isReviewArtifactPayloadDescriptor(reviewArtifactPayloadDescriptor(record))).toBe(true);
    expect(isReviewArtifactPayloadDescriptor({ ...record, sizeBytes: -1 })).toBe(false);
  });

  it("builds database fallback URIs consistently", () => {
    expect(
      reviewArtifactDatabaseUri({
        reviewRunId: "rrn_test",
        kind: "validated_findings",
        name: "validated-findings.json",
      }),
    ).toBe("db://review_artifacts/rrn_test/validated_findings/validated-findings.json");
  });
});

/** Creates a temporary artifact root for filesystem store tests. */
async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heimdall-artifacts-"));
  tempRoots.push(root);

  return root;
}
