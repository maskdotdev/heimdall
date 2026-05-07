import { describe, expect, it } from "vitest";
import { adminCliUsage, parseAdminCliCommand, runAdminCli } from "../src/cli";

describe("parseAdminCliCommand", () => {
  it("parses review inspect and replay commands", () => {
    expect(parseAdminCliCommand(["review", "inspect", "rrn_1", "--json"])).toEqual({
      kind: "review_inspect",
      json: true,
      reviewRunId: "rrn_1",
    });

    expect(
      parseAdminCliCommand([
        "review",
        "replay",
        "rrn_1",
        "--execute",
        "--confirmation-token",
        "sha256:token",
      ]),
    ).toEqual({
      confirmationToken: "sha256:token",
      execute: true,
      json: false,
      kind: "review_replay",
      reviewRunId: "rrn_1",
      stage: "review",
    });

    expect(
      parseAdminCliCommand(["review", "replay", "rrn_1", "--stage", "validation", "--json"]),
    ).toEqual({
      execute: false,
      json: true,
      kind: "review_validation_replay",
      reviewRunId: "rrn_1",
    });

    expect(
      parseAdminCliCommand(["review", "replay", "rrn_1", "--stage", "retrieval", "--json"]),
    ).toEqual({
      execute: false,
      json: true,
      kind: "review_retrieval_replay",
      reviewRunId: "rrn_1",
    });

    expect(parseAdminCliCommand(["usage", "inspect", "rrn_1", "--json"])).toEqual({
      json: true,
      kind: "usage_inspect",
      reviewRunId: "rrn_1",
    });
  });

  it("documents the supported command surface", () => {
    expect(adminCliUsage()).toContain("admin review inspect <reviewRunId>");
    expect(adminCliUsage()).toContain("admin review replay <reviewRunId> --stage retrieval");
    expect(adminCliUsage()).toContain("admin review replay <reviewRunId> --stage validation");
    expect(adminCliUsage()).toContain("admin publisher dry-run <reviewRunId>");
    expect(adminCliUsage()).toContain("admin usage inspect <reviewRunId>");
  });
});

describe("runAdminCli", () => {
  it("refuses validation replay dispatch attempts", async () => {
    await expect(
      runAdminCli(["review", "replay", "rrn_1", "--stage", "validation", "--execute"], {
        NODE_ENV: "development",
      }),
    ).resolves.toMatchObject({
      exitCode: 2,
      stderr: expect.stringContaining("dry-run only"),
    });
  });

  it("refuses retrieval replay dispatch attempts", async () => {
    await expect(
      runAdminCli(["review", "replay", "rrn_1", "--stage", "retrieval", "--execute"], {
        NODE_ENV: "development",
      }),
    ).resolves.toMatchObject({
      exitCode: 2,
      stderr: expect.stringContaining("dry-run only"),
    });
  });

  it("refuses direct database mode in production by default", async () => {
    await expect(
      runAdminCli(["review", "inspect", "rrn_1"], {
        NODE_ENV: "production",
      }),
    ).resolves.toMatchObject({
      exitCode: 2,
      stderr: expect.stringContaining("disabled for production"),
    });
  });
});
