import { validPullRequestSnapshotFixture } from "@repo/contracts/fixtures/pull-request.fixture";
import { describe, expect, it } from "vitest";
import { retrieveContext } from "../src/index";

describe("retrieveContext", () => {
  it("returns diff context with an explicit missing-index fallback", async () => {
    const bundle = await retrieveContext({
      reviewRunId: "rrn_01HREVIEW",
      snapshot: validPullRequestSnapshotFixture,
      indexAvailable: false,
      timestamp: "2026-05-05T00:00:00.000Z",
    });

    expect(bundle.metadata).toMatchObject({
      retrievalMode: "diff_fallback",
      indexAvailable: false,
    });
    expect(bundle.items[0]).toMatchObject({
      kind: "repo_rule",
      title: "Repository index unavailable",
    });
    expect(bundle.items.some((item) => item.kind === "diff")).toBe(true);
  });
});
