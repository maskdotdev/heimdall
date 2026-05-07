import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildGitHubReviewCommentMarker,
  buildGitHubSummaryCommentMarker,
  hasGitHubCommentMarker,
  parseGitHubCommentMarkers,
} from "../src";

describe("GitHub comment markers", () => {
  it("round-trips finding markers", () => {
    const marker = buildGitHubReviewCommentMarker({
      body: "Finding body",
      findingId: "fnd_1",
      reviewRunId: "rev_1",
    });

    expect(parseGitHubCommentMarkers(`Finding body\n\n${marker}`)).toEqual([
      {
        markerFormat: "heimdall.v1",
        kind: "finding",
        reviewRunId: "rev_1",
        findingId: "fnd_1",
        fingerprint: sha256("rev_1:fnd_1:Finding body"),
        raw: marker,
      },
    ]);
  });

  it("parses stable PR summary and legacy review-run summary markers", () => {
    const stableMarker = buildGitHubSummaryCommentMarker({
      provider: "github",
      installationId: "inst_1",
      owner: "acme",
      repo: "api",
      providerRepoId: "100",
      pullRequestNumber: 7,
    });
    const legacyMarker = buildGitHubReviewCommentMarker({
      body: "Summary body",
      reviewRunId: "rev_1",
    });

    expect(parseGitHubCommentMarkers(`${stableMarker}\n${legacyMarker}`)).toEqual([
      {
        markerFormat: "heimdall.v1",
        kind: "summary",
        scope: "pull_request",
        pullRequestNumber: 7,
        fingerprint: sha256("summary:100:7"),
        raw: stableMarker,
      },
      {
        markerFormat: "heimdall.v1",
        kind: "summary",
        scope: "review_run",
        reviewRunId: "rev_1",
        fingerprint: sha256("rev_1:summary:Summary body"),
        raw: legacyMarker,
      },
    ]);
  });

  it("ignores invalid marker-like text", () => {
    expect(parseGitHubCommentMarkers("<!-- heimdall:summary:not-a-pr:sha256:bad -->")).toEqual([]);
    expect(hasGitHubCommentMarker("<!-- heimdall:rev_1:fnd_1:sha256:bad -->", "missing")).toBe(
      false,
    );
  });
});

const sha256 = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
