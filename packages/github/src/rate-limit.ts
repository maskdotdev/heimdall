import type { GitHubRateLimitSnapshot } from "./types";

/** Reads GitHub REST API rate-limit headers into a typed snapshot. */
export function readGitHubRateLimitSnapshot(headers: Headers): GitHubRateLimitSnapshot | undefined {
  const snapshot = {
    ...withOptional("limit", parseIntegerHeader(headers, "x-ratelimit-limit")),
    ...withOptional("remaining", parseIntegerHeader(headers, "x-ratelimit-remaining")),
    ...withOptional("resetEpochSeconds", parseIntegerHeader(headers, "x-ratelimit-reset")),
    ...withOptional("used", parseIntegerHeader(headers, "x-ratelimit-used")),
    ...withOptional("resource", parseStringHeader(headers, "x-ratelimit-resource")),
    ...withOptional("retryAfterSeconds", parseIntegerHeader(headers, "retry-after")),
  };

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

/** Parses one integer response header. */
function parseIntegerHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Parses one non-empty string response header. */
function parseStringHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  return value ? value : undefined;
}

/** Adds an optional object field only when a value is defined. */
function withOptional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
