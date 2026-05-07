import type { GitHubRateLimitSnapshot } from "@repo/github";
import {
  GitHubNotFoundError,
  GitHubPermissionError,
  GitHubRateLimitError,
  GitHubValidationError,
} from "@repo/github";
import { describe, expect, it } from "vitest";
import { serializePublisherError } from "../src";

describe("serializePublisherError", () => {
  it("maps GitHub permission failures to non-retryable structured metadata", () => {
    const error = new GitHubPermissionError("Resource not accessible by integration.", {
      requestId: "req_permission",
      status: 403,
    });

    expect(serializePublisherError(error, "publisher.failed")).toMatchObject({
      code: "publisher.failed",
      details: {
        name: "GitHubPermissionError",
        providerCode: "github_permission",
      },
      message: "Resource not accessible by integration.",
      provider: "github",
      reason: "github_permission",
      requestId: "req_permission",
      retryable: false,
      status: 403,
    });
  });

  it("maps GitHub missing-resource failures to non-retryable structured metadata", () => {
    const error = new GitHubNotFoundError("Not Found.", {
      requestId: "req_not_found",
      status: 404,
    });

    expect(serializePublisherError(error, "publisher.failed")).toMatchObject({
      code: "publisher.failed",
      message: "Not Found.",
      provider: "github",
      reason: "github_not_found",
      requestId: "req_not_found",
      retryable: false,
      status: 404,
    });
  });

  it("maps GitHub validation failures to non-retryable structured metadata", () => {
    const error = new GitHubValidationError("Validation Failed.", {
      requestId: "req_validation",
      status: 422,
    });

    expect(serializePublisherError(error, "publisher.inline_comments_failed")).toMatchObject({
      code: "publisher.inline_comments_failed",
      message: "Validation Failed.",
      provider: "github",
      reason: "github_validation",
      requestId: "req_validation",
      retryable: false,
      status: 422,
    });
  });

  it("maps GitHub rate limits to retryable structured metadata", () => {
    const rateLimit = {
      limit: 5000,
      remaining: 0,
      resetEpochSeconds: 1770000000,
      resource: "core",
      retryAfterSeconds: 60,
      used: 5000,
    } satisfies GitHubRateLimitSnapshot;
    const error = new GitHubRateLimitError("API rate limit exceeded.", {
      rateLimit,
      requestId: "req_rate_limit",
      retryAfterSeconds: 60,
      status: 403,
    });

    expect(serializePublisherError(error, "publisher.failed")).toMatchObject({
      code: "publisher.failed",
      message: "API rate limit exceeded.",
      provider: "github",
      rateLimit,
      reason: "github_rate_limit",
      requestId: "req_rate_limit",
      retryable: true,
      retryAfterSeconds: 60,
      status: 403,
    });
  });

  it("preserves generic publisher failures", () => {
    expect(
      serializePublisherError(new Error("Database write failed."), "publisher.failed"),
    ).toMatchObject({
      code: "publisher.failed",
      details: { name: "Error" },
      message: "Database write failed.",
      reason: "publisher_error",
      retryable: true,
    });
  });
});
