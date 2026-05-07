import { JOB_TYPES } from "@repo/contracts";
import { validBillingReconcileJobPayloadFixture } from "@repo/contracts/fixtures/jobs.fixture";
import { createFakeIndexerDriver } from "@repo/indexer-driver";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkerHandlers,
  createWorkerIndexerDriverFromEnvironment,
  createWorkerReviewSmokeGateway,
  verifyWorkerIndexerCapabilities,
} from "./index";

describe("createWorkerReviewSmokeGateway", () => {
  it("emits one anchored smoke finding from the first added diff line", async () => {
    const gateway = createWorkerReviewSmokeGateway();

    const output = await gateway.generateReviewFindings({
      prompt: JSON.stringify({
        changedFiles: [
          {
            path: "heimdall-smoke/pr-review-smoke.txt",
            status: "modified",
            isGenerated: false,
            hunks: [
              {
                lines: [
                  { kind: "context", newLine: 1 },
                  { kind: "addition", newLine: 2 },
                ],
              },
            ],
          },
        ],
      }),
    });

    expect(output.findings).toEqual([
      expect.objectContaining({
        path: "heimdall-smoke/pr-review-smoke.txt",
        line: 2,
        severity: "low",
        category: "maintainability",
        title: "Live PR review smoke test",
      }),
    ]);
  });
});

describe("createWorkerHandlers", () => {
  it("dispatches billing reconciliation jobs through the configured reconciler", async () => {
    const payloads: unknown[] = [];
    const handlers = createWorkerHandlers({
      billingReconciler: async (payload) => {
        payloads.push(payload);
      },
      db: {} as never,
      gitProvider: {} as never,
    });

    await handlers[JOB_TYPES.BillingReconcile]?.({
      attempt: 0,
      createdAt: "2026-05-07T12:00:00.000Z",
      idempotencyKey: "billing:reconcile:org_01HXAMPLE:2026-05",
      jobId: "job_billing_reconcile",
      jobType: JOB_TYPES.BillingReconcile,
      maxAttempts: 3,
      payload: validBillingReconcileJobPayloadFixture,
      schemaVersion: "billing_reconcile_job.v1",
    });

    expect(payloads).toEqual([validBillingReconcileJobPayloadFixture]);
  });
});

describe("createWorkerIndexerDriverFromEnvironment", () => {
  it("keeps the in-process TypeScript indexer as the default driver", () => {
    expect(
      createWorkerIndexerDriverFromEnvironment(
        {},
        { indexArtifactRoot: ".heimdall/index-artifacts" },
      ),
    ).toBeUndefined();
  });

  it("creates a CLI driver from explicit worker environment", () => {
    const driver = createWorkerIndexerDriverFromEnvironment(
      {
        INDEXER_CLI_ARGS_JSON: JSON.stringify(["--fake"]),
        INDEXER_CLI_COMMAND: process.execPath,
        INDEXER_DRIVER: "cli",
      },
      {
        indexArtifactRoot: ".heimdall/index-artifacts",
        indexerTimeoutMs: 500,
        workspaceRoot: ".heimdall/workspaces",
      },
    );

    expect(driver).toMatchObject({ name: "cli", version: "0.0.0" });
  });

  it("creates a remote driver from explicit worker environment", () => {
    const driver = createWorkerIndexerDriverFromEnvironment(
      {
        INDEXER_DRIVER: "remote",
        INDEXER_REMOTE_BASE_URL: "https://indexer.example",
        INDEXER_REMOTE_BEARER_TOKEN: "remote-token",
        INDEXER_REMOTE_POLL_INTERVAL_MS: "25",
      },
      {
        indexArtifactRoot: ".heimdall/index-artifacts",
        indexerTimeoutMs: 500,
      },
    );

    expect(driver).toMatchObject({ name: "remote", version: "0.0.0" });
  });

  it("requires a remote base URL for remote indexer drivers", () => {
    expect(() =>
      createWorkerIndexerDriverFromEnvironment(
        { INDEXER_DRIVER: "remote" },
        { indexArtifactRoot: ".heimdall/index-artifacts" },
      ),
    ).toThrow("INDEXER_REMOTE_BASE_URL is required when INDEXER_DRIVER=remote.");
  });

  it("rejects unsupported indexer drivers", () => {
    expect(() =>
      createWorkerIndexerDriverFromEnvironment(
        { INDEXER_DRIVER: "bogus" },
        { indexArtifactRoot: ".heimdall/index-artifacts" },
      ),
    ).toThrow("Unsupported INDEXER_DRIVER: bogus");
  });
});

describe("verifyWorkerIndexerCapabilities", () => {
  it("returns capabilities when the selected indexer supports the current artifact schema", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const capabilities = await verifyWorkerIndexerCapabilities(createFakeIndexerDriver());
    info.mockRestore();

    expect(capabilities).toMatchObject({
      driverName: "fake",
      supportedArtifactSchemaVersions: ["index_artifact.v1"],
    });
  });

  it("rejects indexers that do not support the current artifact schema", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await expect(
      verifyWorkerIndexerCapabilities(
        createFakeIndexerDriver({
          capabilities: { supportedArtifactSchemaVersions: ["index_artifact.v0"] },
          name: "old-indexer",
        }),
      ),
    ).rejects.toThrow("Indexer old-indexer@0.0.0 does not support index_artifact.v1.");
    info.mockRestore();
  });
});
