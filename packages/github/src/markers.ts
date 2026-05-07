import { createHash } from "node:crypto";
import type { GitHubPullRequestRef } from "./types";

/** Parsed Heimdall marker embedded in a GitHub bot comment. */
export type GitHubCommentMarker =
  | {
      /** Marker format discriminator. */
      readonly markerFormat: "heimdall.v1";
      /** Marker attached to an inline finding comment. */
      readonly kind: "finding";
      /** Review run that rendered the comment. */
      readonly reviewRunId: string;
      /** Validated finding ID when present. */
      readonly findingId: string;
      /** Body fingerprint embedded in the marker. */
      readonly fingerprint: `sha256:${string}`;
      /** Exact hidden HTML comment marker. */
      readonly raw: string;
    }
  | {
      /** Marker format discriminator. */
      readonly markerFormat: "heimdall.v1";
      /** Marker attached to a PR summary comment. */
      readonly kind: "summary";
      /** Marker scope used by stable PR-level summary comments. */
      readonly scope: "pull_request";
      /** Pull request number embedded in the marker. */
      readonly pullRequestNumber: number;
      /** PR fingerprint embedded in the marker. */
      readonly fingerprint: `sha256:${string}`;
      /** Exact hidden HTML comment marker. */
      readonly raw: string;
    }
  | {
      /** Marker format discriminator. */
      readonly markerFormat: "heimdall.v1";
      /** Marker attached to a legacy per-body summary comment. */
      readonly kind: "summary";
      /** Marker scope used by legacy summary comments. */
      readonly scope: "review_run";
      /** Review run that rendered the legacy summary comment. */
      readonly reviewRunId: string;
      /** Body fingerprint embedded in the marker. */
      readonly fingerprint: `sha256:${string}`;
      /** Exact hidden HTML comment marker. */
      readonly raw: string;
    };

/** Input used to build a legacy review-run-scoped marker. */
export type GitHubReviewCommentMarkerInput = {
  /** Rendered comment body covered by the marker fingerprint. */
  readonly body: string;
  /** Review run that rendered the comment. */
  readonly reviewRunId: string;
  /** Validated finding ID for inline comments. Omit for legacy summaries. */
  readonly findingId?: string;
};

const HEIMDALL_MARKER_PATTERN =
  /<!--\s*heimdall:([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):(sha256:[a-f0-9]{64})\s*-->/giu;

/** Builds the legacy Heimdall marker used for inline finding comments. */
export function buildGitHubReviewCommentMarker(input: GitHubReviewCommentMarkerInput): string {
  const fingerprint = sha256(`${input.reviewRunId}:${input.findingId ?? "summary"}:${input.body}`);
  return `<!-- heimdall:${input.reviewRunId}:${input.findingId ?? "summary"}:${fingerprint} -->`;
}

/** Builds the stable Heimdall marker used for one active summary comment per PR. */
export function buildGitHubSummaryCommentMarker(input: GitHubPullRequestRef): string {
  const fingerprint = sha256(
    `summary:${input.providerRepoId ?? `${input.owner}/${input.repo}`}:${input.pullRequestNumber}`,
  );
  return `<!-- heimdall:summary:${input.pullRequestNumber}:${fingerprint} -->`;
}

/** Parses all Heimdall hidden markers from a GitHub comment body. */
export function parseGitHubCommentMarkers(markdown: string): readonly GitHubCommentMarker[] {
  return [...markdown.matchAll(HEIMDALL_MARKER_PATTERN)].flatMap((match) =>
    parsedMarkerFromMatch(match),
  );
}

/** Returns whether a comment body contains the exact rendered marker. */
export function hasGitHubCommentMarker(markdown: string, marker: string): boolean {
  return parseGitHubCommentMarkers(markdown).some((parsed) => parsed.raw === marker);
}

function parsedMarkerFromMatch(match: RegExpMatchArray): readonly GitHubCommentMarker[] {
  const first = match[1];
  const second = match[2];
  const fingerprint = match[3];
  const raw = match[0];
  if (!first || !second || !isSha256Fingerprint(fingerprint) || !raw) {
    return [];
  }

  if (first === "summary") {
    const pullRequestNumber = Number(second);
    return Number.isInteger(pullRequestNumber) && pullRequestNumber > 0
      ? [
          {
            markerFormat: "heimdall.v1",
            kind: "summary",
            scope: "pull_request",
            pullRequestNumber,
            fingerprint,
            raw,
          },
        ]
      : [];
  }

  if (second === "summary") {
    return [
      {
        markerFormat: "heimdall.v1",
        kind: "summary",
        scope: "review_run",
        reviewRunId: first,
        fingerprint,
        raw,
      },
    ];
  }

  return [
    {
      markerFormat: "heimdall.v1",
      kind: "finding",
      reviewRunId: first,
      findingId: second,
      fingerprint,
      raw,
    },
  ];
}

function isSha256Fingerprint(value: string | undefined): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

const sha256 = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
