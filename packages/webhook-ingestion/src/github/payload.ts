import type { PullRequestSnapshot, Repository, RepositorySettings } from "@repo/contracts";
import { DEFAULT_REPOSITORY_SETTINGS } from "@repo/contracts";
import { sha256, stableId } from "../ids";
import { WebhookPayloadError } from "../types";

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown, name: string): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebhookPayloadError(`GitHub payload is missing ${name}.`);
  }

  return value as JsonRecord;
};

const optionalRecord = (value: unknown): JsonRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;

const stringValue = (record: JsonRecord, key: string): string => {
  const value = record[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  throw new WebhookPayloadError(`GitHub payload field ${key} must be a string.`);
};

const optionalString = (record: JsonRecord, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const optionalProviderId = (record: JsonRecord, key: string): string | undefined => {
  const value = record[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
};

const withOptional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

const numberValue = (record: JsonRecord, key: string): number => {
  const value = record[key];
  if (typeof value === "number") {
    return value;
  }

  throw new WebhookPayloadError(`GitHub payload field ${key} must be a number.`);
};

const booleanValue = (record: JsonRecord, key: string, fallback = false): boolean => {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
};

const nowIso = (): string => new Date().toISOString();

/** Minimal normalized GitHub account. */
export type NormalizedGitHubAccount = {
  readonly orgId: string;
  readonly login: string;
  readonly accountType: "user" | "organization" | "unknown";
  readonly metadata: JsonRecord;
};

/** Minimal normalized GitHub installation. */
export type NormalizedGitHubInstallation = {
  readonly installationId: string;
  readonly providerInstallationId: string;
  readonly orgId: string;
  readonly accountLogin: string;
  readonly accountType: "user" | "organization" | "unknown";
  readonly permissions: JsonRecord;
  readonly installedAt: string;
  readonly metadata: JsonRecord;
};

/** Repository plus default settings derived from GitHub payloads. */
export type NormalizedGitHubRepository = {
  readonly repository: Repository;
  readonly settings: RepositorySettings;
};

/** Pull request state and snapshot derived from a GitHub pull_request webhook. */
export type NormalizedGitHubPullRequest = {
  readonly pullRequestId: string;
  readonly snapshot: PullRequestSnapshot;
};

/** Provider feedback event normalized from GitHub PR comments or reactions. */
export type NormalizedGitHubFeedback = {
  /** Stable feedback event ID derived from provider-owned identifiers. */
  readonly feedbackEventId: string;
  /** Provider event name that delivered the feedback. */
  readonly eventName: "issue_comment" | "pull_request_review_comment" | "reaction";
  /** Provider event action. */
  readonly action: string;
  /** Repository that owns the comment or reaction. */
  readonly repoId: string;
  /** Installation that delivered the event. */
  readonly installationId: string;
  /** Pull request number when the feedback belongs to a PR. */
  readonly pullRequestNumber?: number | undefined;
  /** Classified feedback signal for downstream memory processing. */
  readonly feedbackKind:
    | "comment_reply"
    | "comment_edited"
    | "comment_deleted"
    | "positive_reaction"
    | "negative_reaction";
  /** Provider comment ID when the event is tied to a comment. */
  readonly externalCommentId?: string | undefined;
  /** Provider parent comment ID for inline replies. */
  readonly externalParentCommentId?: string | undefined;
  /** Provider reaction ID when the event is tied to a reaction. */
  readonly externalReactionId?: string | undefined;
  /** Login for the actor that produced the signal. */
  readonly actorLogin?: string | undefined;
  /** SHA-256 hash of comment text when available. */
  readonly bodyHash?: `sha256:${string}` | undefined;
};

/** Extracts a GitHub installation account. */
export function normalizeGitHubAccount(payload: JsonRecord): NormalizedGitHubAccount {
  const installation = asRecord(payload.installation, "installation");
  const account = asRecord(installation.account, "installation.account");
  const providerAccountId = stringValue(account, "id");
  const login = stringValue(account, "login");
  const rawType = optionalString(account, "type")?.toLowerCase();
  const accountType =
    rawType === "organization" ? "organization" : rawType === "user" ? "user" : "unknown";

  return {
    orgId: stableId("org", ["github", providerAccountId]),
    login,
    accountType,
    metadata: account,
  };
}

/** Extracts a GitHub installation. */
export function normalizeGitHubInstallation(payload: JsonRecord): NormalizedGitHubInstallation {
  const installation = asRecord(payload.installation, "installation");
  const account = normalizeGitHubAccount(payload);
  const providerInstallationId = stringValue(installation, "id");

  return {
    installationId: stableId("inst", ["github", providerInstallationId]),
    providerInstallationId,
    orgId: account.orgId,
    accountLogin: account.login,
    accountType: account.accountType,
    permissions: optionalRecord(installation.permissions) ?? {},
    installedAt: optionalString(installation, "created_at") ?? nowIso(),
    metadata: installation,
  };
}

/** Builds default settings for a repository. */
export function buildRepositorySettings(repoId: string, timestamp = nowIso()): RepositorySettings {
  return {
    repoId,
    reviewPolicy: DEFAULT_REPOSITORY_SETTINGS.reviewPolicy,
    severityThreshold: DEFAULT_REPOSITORY_SETTINGS.severityThreshold,
    maxCommentsPerReview: DEFAULT_REPOSITORY_SETTINGS.maxCommentsPerReview,
    ignoredPaths: [...DEFAULT_REPOSITORY_SETTINGS.ignoredPaths],
    ignoredAuthors: [...DEFAULT_REPOSITORY_SETTINGS.ignoredAuthors],
    ignoredLabels: [...DEFAULT_REPOSITORY_SETTINGS.ignoredLabels],
    skipGeneratedFiles: DEFAULT_REPOSITORY_SETTINGS.skipGeneratedFiles,
    skipDraftPullRequests: DEFAULT_REPOSITORY_SETTINGS.skipDraftPullRequests,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Extracts a repository from a GitHub payload repository object. */
export function normalizeGitHubRepository(
  payload: JsonRecord,
  repositoryValue = payload.repository,
): NormalizedGitHubRepository {
  const repository = asRecord(repositoryValue, "repository");
  const installation = normalizeGitHubInstallation(payload);
  const providerRepoId = stringValue(repository, "id");
  const fullName = stringValue(repository, "full_name");
  const ownerRecord = optionalRecord(repository.owner);
  const owner = ownerRecord
    ? stringValue(ownerRecord, "login")
    : (fullName.split("/")[0] ?? fullName);
  const repoId = stableId("repo", ["github", providerRepoId]);
  const timestamp = nowIso();

  return {
    repository: {
      repoId,
      orgId: installation.orgId,
      installationId: installation.installationId,
      provider: "github",
      providerRepoId,
      owner,
      name: stringValue(repository, "name"),
      fullName,
      ...withOptional("defaultBranch", optionalString(repository, "default_branch")),
      ...withOptional(
        "cloneUrl",
        optionalString(repository, "clone_url") ?? optionalString(repository, "html_url"),
      ),
      visibility: booleanValue(repository, "private", true) ? "private" : "public",
      isArchived: booleanValue(repository, "archived"),
      isFork: booleanValue(repository, "fork"),
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: repository,
    },
    settings: buildRepositorySettings(repoId, timestamp),
  };
}

/** Extracts repositories from installation/repository webhook payloads. */
export function normalizeGitHubRepositories(
  payload: JsonRecord,
): readonly NormalizedGitHubRepository[] {
  if (payload.repository) {
    return [normalizeGitHubRepository(payload)];
  }

  const repositories = Array.isArray(payload.repositories) ? payload.repositories : [];
  return repositories.map((repository) => normalizeGitHubRepository(payload, repository));
}

/** Extracts pull request state and immutable snapshot from a GitHub pull_request payload. */
export function normalizeGitHubPullRequest(payload: JsonRecord): NormalizedGitHubPullRequest {
  const pr = asRecord(payload.pull_request, "pull_request");
  const repository = normalizeGitHubRepository(payload).repository;
  const installation = normalizeGitHubInstallation(payload);
  const base = asRecord(pr.base, "pull_request.base");
  const head = asRecord(pr.head, "pull_request.head");
  const providerPullRequestId = stringValue(pr, "id");
  const pullRequestNumber = numberValue(pr, "number");
  const baseSha = stringValue(base, "sha");
  const headSha = stringValue(head, "sha");
  const timestamp = nowIso();

  const rawState = optionalString(pr, "merged_at")
    ? "merged"
    : (optionalString(pr, "state") ?? "unknown");
  const state: PullRequestSnapshot["state"] =
    rawState === "open" || rawState === "closed" || rawState === "merged" ? rawState : "unknown";

  const snapshot: PullRequestSnapshot = {
    snapshotId: stableId("prs", ["github", repository.providerRepoId, pullRequestNumber, headSha]),
    schemaVersion: "pull_request_snapshot.v1",
    provider: "github",
    repoId: repository.repoId,
    installationId: installation.installationId,
    providerRepoId: repository.providerRepoId,
    providerPullRequestId,
    pullRequestNumber,
    title: stringValue(pr, "title"),
    ...withOptional("body", optionalString(pr, "body")),
    authorLogin: stringValue(asRecord(pr.user, "pull_request.user"), "login"),
    ...withOptional("authorAssociation", optionalString(pr, "author_association")),
    state,
    isDraft: booleanValue(pr, "draft"),
    labels: Array.isArray(pr.labels)
      ? pr.labels
          .map((label) => optionalRecord(label)?.name)
          .filter((label): label is string => typeof label === "string")
      : [],
    baseRef: stringValue(base, "ref"),
    baseSha,
    headRef: stringValue(head, "ref"),
    headSha,
    ...withOptional("mergeBaseSha", optionalString(pr, "merge_commit_sha")),
    changedFiles: [],
    diffHash: sha256(`${repository.repoId}:${pullRequestNumber}:${baseSha}:${headSha}`),
    additions: numberValue(pr, "additions"),
    deletions: numberValue(pr, "deletions"),
    changedFileCount: numberValue(pr, "changed_files"),
    fetchedAt: timestamp,
    providerMetadata: pr,
  };

  return {
    pullRequestId: stableId("pr", ["github", providerPullRequestId]),
    snapshot,
  };
}

/** Extracts a normalized feedback signal from GitHub comment and reaction webhooks. */
export function normalizeGitHubFeedback(
  payload: JsonRecord,
  eventName: string,
): NormalizedGitHubFeedback | undefined {
  if (eventName === "issue_comment") {
    return normalizeIssueCommentFeedback(payload);
  }

  if (eventName === "pull_request_review_comment") {
    return normalizeReviewCommentFeedback(payload);
  }

  if (eventName === "reaction") {
    return normalizeReactionFeedback(payload);
  }

  return undefined;
}

/** Parses a raw JSON webhook body. */
export function parseGitHubWebhookPayload(rawBody: Uint8Array): JsonRecord {
  const parsed = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
  return asRecord(parsed, "root");
}

function normalizeIssueCommentFeedback(payload: JsonRecord): NormalizedGitHubFeedback | undefined {
  const issue = asRecord(payload.issue, "issue");
  if (!optionalRecord(issue.pull_request)) {
    return undefined;
  }

  const repository = normalizeGitHubRepository(payload).repository;
  const installation = normalizeGitHubInstallation(payload);
  const comment = asRecord(payload.comment, "comment");
  const action = optionalString(payload, "action") ?? "unknown";
  const externalCommentId = stringValue(comment, "id");
  const body = optionalString(comment, "body");

  return {
    action,
    ...withOptional("actorLogin", actorLogin(payload, comment)),
    ...withOptional("bodyHash", body ? sha256(body) : undefined),
    eventName: "issue_comment",
    externalCommentId,
    feedbackEventId: stableId("fb", ["github", "issue_comment", action, externalCommentId]),
    feedbackKind: commentFeedbackKind(action),
    installationId: installation.installationId,
    pullRequestNumber: numberValue(issue, "number"),
    repoId: repository.repoId,
  };
}

function normalizeReviewCommentFeedback(payload: JsonRecord): NormalizedGitHubFeedback {
  const repository = normalizeGitHubRepository(payload).repository;
  const installation = normalizeGitHubInstallation(payload);
  const comment = asRecord(payload.comment, "comment");
  const pullRequest = optionalRecord(payload.pull_request);
  const action = optionalString(payload, "action") ?? "unknown";
  const externalCommentId = stringValue(comment, "id");
  const parentCommentId = optionalProviderId(comment, "in_reply_to_id");
  const body = optionalString(comment, "body");

  return {
    action,
    ...withOptional("actorLogin", actorLogin(payload, comment)),
    ...withOptional("bodyHash", body ? sha256(body) : undefined),
    eventName: "pull_request_review_comment",
    externalCommentId,
    ...withOptional("externalParentCommentId", parentCommentId),
    feedbackEventId: stableId("fb", [
      "github",
      "pull_request_review_comment",
      action,
      externalCommentId,
    ]),
    feedbackKind: commentFeedbackKind(action),
    installationId: installation.installationId,
    ...withOptional(
      "pullRequestNumber",
      pullRequest ? numberValue(pullRequest, "number") : undefined,
    ),
    repoId: repository.repoId,
  };
}

function normalizeReactionFeedback(payload: JsonRecord): NormalizedGitHubFeedback | undefined {
  const repository = normalizeGitHubRepository(payload).repository;
  const installation = normalizeGitHubInstallation(payload);
  const reaction = asRecord(payload.reaction, "reaction");
  const feedbackKind = reactionFeedbackKind(stringValue(reaction, "content"));
  if (!feedbackKind) {
    return undefined;
  }

  const action = optionalString(payload, "action") ?? "unknown";
  const comment = optionalRecord(payload.comment);
  const issue = optionalRecord(payload.issue);
  const externalReactionId = stringValue(reaction, "id");
  const externalCommentId = comment ? stringValue(comment, "id") : undefined;
  const pullRequestNumber =
    issue && optionalRecord(issue.pull_request) ? numberValue(issue, "number") : undefined;

  return {
    action,
    ...withOptional("actorLogin", actorLogin(payload, reaction)),
    eventName: "reaction",
    ...(externalCommentId ? { externalCommentId } : {}),
    externalReactionId,
    feedbackEventId: stableId("fb", ["github", "reaction", action, externalReactionId]),
    feedbackKind,
    installationId: installation.installationId,
    ...withOptional("pullRequestNumber", pullRequestNumber),
    repoId: repository.repoId,
  };
}

function actorLogin(payload: JsonRecord, fallbackSource: JsonRecord): string | undefined {
  const sender = optionalRecord(payload.sender);
  const user = optionalRecord(fallbackSource.user);
  return (sender && optionalString(sender, "login")) ?? (user && optionalString(user, "login"));
}

function commentFeedbackKind(
  action: string,
): "comment_reply" | "comment_edited" | "comment_deleted" {
  if (action === "edited") {
    return "comment_edited";
  }
  if (action === "deleted") {
    return "comment_deleted";
  }
  return "comment_reply";
}

function reactionFeedbackKind(
  content: string,
): "positive_reaction" | "negative_reaction" | undefined {
  if (["+1", "heart", "hooray", "rocket"].includes(content)) {
    return "positive_reaction";
  }
  if (["-1", "confused"].includes(content)) {
    return "negative_reaction";
  }
  return undefined;
}
