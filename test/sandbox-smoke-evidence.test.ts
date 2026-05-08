import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Local Docker sandbox smoke evidence path. */
const SANDBOX_EVIDENCE_FILE = resolve("docs/evidence/sandbox-docker-smoke-proof.json");

/** Root package manifest path. */
const PACKAGE_JSON_FILE = resolve("package.json");

/** Expected root command for rerunning the local sandbox smoke. */
const SANDBOX_SMOKE_SCRIPT = "pnpm --filter @repo/admin-tools smoke:sandbox:docker";

/** JSON object shape used by evidence files. */
type JsonRecord = Readonly<Record<string, unknown>>;

describe("sandbox smoke evidence", () => {
  it("records product-safe Docker sandbox smoke proof", () => {
    const evidence = parseJsonRecord(readFileSync(SANDBOX_EVIDENCE_FILE, "utf8"));
    const proof = recordField(evidence, "proof");
    const artifact = recordField(proof, "artifact");

    expect(evidence).toMatchObject({
      command: SANDBOX_SMOKE_SCRIPT,
      status: "sandbox docker smoke passed",
    });
    expect(stringField(evidence, "generatedAt")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(stringField(evidence, "dockerServerVersion")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(stringField(evidence, "imageId")).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(proof).toMatchObject({
      artifactCount: 1,
      image: "alpine:3.19",
      policyDeniedCount: 0,
      runner: "docker",
      status: "passed",
      stderrBytes: 0,
      stdoutBytes: 0,
    });
    expect(artifact).toMatchObject({
      name: "proof.json",
      sizeBytes: 52,
    });
    expect(stringField(artifact, "sha256")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("exposes a root script for rerunning the sandbox smoke", () => {
    const packageJson = parseJsonRecord(readFileSync(PACKAGE_JSON_FILE, "utf8"));
    const scripts = recordField(packageJson, "scripts");

    expect(scripts).toMatchObject({
      "smoke:sandbox:docker": SANDBOX_SMOKE_SCRIPT,
    });
  });
});

/** Parses JSON text as an object record. */
function parseJsonRecord(text: string): JsonRecord {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Expected a JSON object.");
  }

  return parsed;
}

/** Returns a nested object record from one record. */
function recordField(record: JsonRecord, field: string): JsonRecord {
  const value = record[field];
  return isRecord(value) ? value : {};
}

/** Returns an optional string from one record. */
function stringField(record: JsonRecord, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Returns whether a value is a JSON object record. */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
