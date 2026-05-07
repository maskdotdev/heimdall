import { describe, expect, it } from "vitest";
import { createLLMGateway, FakeLLMProvider, LLMGatewayError, type LLMProvider } from "../src/index";

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
    await expect(gateway.generateReviewFindings({ prompt: "{}" })).rejects.toMatchObject({
      code: "schema_validation_failed",
      retryable: false,
    });
  });

  it("retries retryable provider failures", async () => {
    const provider = new FakeLLMProvider({
      failuresBeforeSuccess: 1,
      defaultObject: {
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
      },
    });
    const gateway = createLLMGateway(provider, { retryPolicy: { maxAttempts: 2 } });

    await expect(gateway.generateReviewFindings({ prompt: "{}" })).resolves.toMatchObject({
      findings: [{ path: "src/math.ts", line: 2 }],
    });
  });

  it("does not retry non-retryable provider failures", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      id: "fake",
      generateObject: async (input) => {
        callCount += 1;
        throw new LLMGatewayError("Provider auth failed.", {
          code: "provider_auth_failed",
          provider: "fake",
          retryable: false,
          task: input.task,
        });
      },
    };
    const gateway = createLLMGateway(provider, { retryPolicy: { maxAttempts: 3 } });

    await expect(gateway.generateReviewFindings({ prompt: "{}" })).rejects.toMatchObject({
      code: "provider_auth_failed",
      retryable: false,
    });
    expect(callCount).toBe(1);
  });

  it("selects fake provider fixtures from metadata", async () => {
    const gateway = createLLMGateway(
      new FakeLLMProvider({
        fixtures: {
          finding: {
            findings: [
              {
                path: "src/string.ts",
                line: 5,
                severity: "high",
                category: "security",
                title: "Reject unsafe input",
                body: "The changed parser now trusts raw user input.",
                evidence: ["The added line passes request data directly to eval."],
                confidence: 0.9,
              },
            ],
          },
        },
      }),
    );

    await expect(
      gateway.generateReviewFindings({ prompt: "{}", metadata: { fixtureKey: "finding" } }),
    ).resolves.toMatchObject({
      findings: [{ path: "src/string.ts", line: 5 }],
    });
  });
});
