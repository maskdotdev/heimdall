import { describe, expect, it } from "vitest";
import { createWorkerReviewSmokeGateway } from "./index";

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
