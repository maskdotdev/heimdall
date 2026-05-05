import { describe, expect, it } from "vitest";
import { createLLMGateway } from "../src/index";

describe("createLLMGateway", () => {
  it("validates structured review finding output", async () => {
    const gateway = createLLMGateway({
      generateObject: async () => ({
        findings: [
          {
            path: "src/math.ts",
            line: 2,
            severity: "medium",
            category: "correctness",
            title: "Handle non-finite values",
            body: "The changed coercion accepts NaN and Infinity.",
            evidence: ["The added line calls Number() without a finite check."],
            confidence: 0.82,
          },
        ],
      }),
    });

    await expect(gateway.generateReviewFindings({ prompt: "{}" })).resolves.toMatchObject({
      findings: [{ path: "src/math.ts", line: 2 }],
    });
  });

  it("rejects provider output that cannot become a candidate finding", async () => {
    const gateway = createLLMGateway({
      generateObject: async () => ({
        findings: [
          {
            path: "src/math.ts",
            line: 2,
            severity: "medium",
            category: "correctness",
            title: "",
            body: "The changed coercion accepts NaN and Infinity.",
            evidence: ["The added line calls Number() without a finite check."],
            confidence: 0.82,
          },
        ],
      }),
    });

    await expect(gateway.generateReviewFindings({ prompt: "{}" })).rejects.toThrow(
      /LLMFindingOutput/u,
    );
  });
});
