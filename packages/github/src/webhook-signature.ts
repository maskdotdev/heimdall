import { createHmac, timingSafeEqual } from "node:crypto";

/** GitHub webhook headers consumed by Heimdall. */
export type GitHubWebhookHeaders = {
  /** GitHub delivery UUID. */
  readonly deliveryId: string;
  /** GitHub event name, such as `pull_request`. */
  readonly eventName: string;
  /** HMAC SHA-256 signature in GitHub's `sha256=<hex>` format. */
  readonly signature256: string;
};

/** Error raised when required GitHub webhook headers are absent. */
export class GitHubWebhookHeaderError extends Error {
  /** Creates a GitHub webhook header error. */
  public constructor(message: string) {
    super(message);
    this.name = "GitHubWebhookHeaderError";
  }
}

const getHeader = (headers: Headers, name: string): string | undefined =>
  headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;

/** Extracts and validates required GitHub webhook headers. */
export function readGitHubWebhookHeaders(headers: Headers): GitHubWebhookHeaders {
  const deliveryId = getHeader(headers, "x-github-delivery");
  const eventName = getHeader(headers, "x-github-event");
  const signature256 = getHeader(headers, "x-hub-signature-256");

  if (!deliveryId) {
    throw new GitHubWebhookHeaderError("Missing X-GitHub-Delivery header.");
  }

  if (!eventName) {
    throw new GitHubWebhookHeaderError("Missing X-GitHub-Event header.");
  }

  if (!signature256) {
    throw new GitHubWebhookHeaderError("Missing X-Hub-Signature-256 header.");
  }

  return { deliveryId, eventName, signature256 };
}

/** Computes GitHub's HMAC SHA-256 webhook signature for a raw body. */
export function computeGitHubWebhookSignature(secret: string, rawBody: Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** Verifies a GitHub webhook signature using constant-time comparison. */
export function verifyGitHubWebhookSignature(options: {
  readonly secret: string;
  readonly rawBody: Uint8Array;
  readonly signature256: string;
}): boolean {
  const expected = Buffer.from(
    computeGitHubWebhookSignature(options.secret, options.rawBody),
    "utf8",
  );
  const actual = Buffer.from(options.signature256, "utf8");

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
