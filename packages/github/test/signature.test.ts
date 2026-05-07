import { describe, expect, it } from "vitest";
import {
  computeGitHubWebhookSignature,
  readGitHubWebhookHeaders,
  verifyGitHubWebhookSignature,
  verifyGitHubWebhookSignatureWithSecrets,
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

  it("matches GitHub's documented sha256 test vector", () => {
    const rawBody = new TextEncoder().encode("Hello, World!");

    expect(computeGitHubWebhookSignature("It's a Secret to Everybody", rawBody)).toBe(
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    );
  });

  it("returns the matched secret version during rotation", () => {
    const rawBody = new TextEncoder().encode('{"zen":"rotate safely"}');
    const currentSignature = computeGitHubWebhookSignature("current-secret", rawBody);
    const previousSignature = computeGitHubWebhookSignature("previous-secret", rawBody);

    expect(
      verifyGitHubWebhookSignatureWithSecrets({
        rawBody,
        secrets: [
          { secret: "current-secret", version: "current" },
          { secret: "previous-secret", version: "previous" },
        ],
        signature256: currentSignature,
      }),
    ).toEqual({ matchedSecretVersion: "current", ok: true });
    expect(
      verifyGitHubWebhookSignatureWithSecrets({
        rawBody,
        secrets: [
          { secret: "current-secret", version: "current" },
          { secret: "previous-secret", version: "previous" },
        ],
        signature256: previousSignature,
      }),
    ).toEqual({ matchedSecretVersion: "previous", ok: true });
    expect(
      verifyGitHubWebhookSignatureWithSecrets({
        rawBody,
        secrets: [
          { secret: "current-secret", version: "current" },
          { secret: "previous-secret", version: "previous" },
        ],
        signature256: "sha256=too-short",
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
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
