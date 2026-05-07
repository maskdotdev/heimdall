import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Local compose file path. */
const COMPOSE_FILE = resolve("compose.yaml");

/** Local infrastructure documentation path. */
const INFRA_README_FILE = resolve("infra/README.md");

/** Review artifact environment variables required for local object storage. */
const REVIEW_ARTIFACT_ENV = [
  "HEIMDALL_REVIEW_ARTIFACT_BUCKET",
  "HEIMDALL_REVIEW_ARTIFACT_ENDPOINT",
  "HEIMDALL_REVIEW_ARTIFACT_REGION",
  "HEIMDALL_REVIEW_ARTIFACT_ACCESS_KEY_ID",
  "HEIMDALL_REVIEW_ARTIFACT_SECRET_ACCESS_KEY",
  "HEIMDALL_REVIEW_ARTIFACT_FORCE_PATH_STYLE",
];

describe("local infrastructure manifest", () => {
  it("starts object storage alongside Postgres and Redis", () => {
    const compose = readFileSync(COMPOSE_FILE, "utf8");

    expect(compose).toContain("postgres:");
    expect(compose).toContain("redis:");
    expect(compose).toContain("object-storage:");
    expect(compose).toContain("image: minio/minio:latest");
    expect(compose).toContain('"9000:9000"');
    expect(compose).toContain('"9001:9001"');
    expect(compose).toContain("object-storage-init:");
    expect(compose).toContain("heimdall-review-artifacts");
    expect(compose).toContain("object_storage_data:");
  });

  it("documents local review artifact object-storage settings", () => {
    const readme = readFileSync(INFRA_README_FILE, "utf8");

    for (const envName of REVIEW_ARTIFACT_ENV) {
      expect(readme).toContain(envName);
    }
    expect(readme).toContain("http://localhost:9000");
    expect(readme).toContain("heimdall-review-artifacts");
  });
});
