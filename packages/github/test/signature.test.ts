import { describe, expect, it } from "vitest";
import {
  computeGitHubWebhookSignature,
  readGitHubWebhookHeaders,
  verifyGitHubWebhookSignature,
} from "../src";

describe("GitHub webhook signatures", () => {
  it("computes and verifies sha256 signatures over raw bytes", () => {
    const rawBody = new TextEncoder().encode('{"zen":"Keep it logically awesome."}');
    const signature = computeGitHubWebhookSignature("secret", rawBody);

    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/u);
    expect(
      verifyGitHubWebhookSignature({
        secret: "secret",
        rawBody,
        signature256: signature,
      }),
    ).toBe(true);
    expect(
      verifyGitHubWebhookSignature({
        secret: "wrong",
        rawBody,
        signature256: signature,
      }),
    ).toBe(false);
  });

  it("extracts required webhook headers", () => {
    expect(
      readGitHubWebhookHeaders(
        new Headers({
          "x-github-delivery": "delivery-1",
          "x-github-event": "pull_request",
          "x-hub-signature-256": "sha256=abc",
        }),
      ),
    ).toEqual({
      deliveryId: "delivery-1",
      eventName: "pull_request",
      signature256: "sha256=abc",
    });
  });
});
