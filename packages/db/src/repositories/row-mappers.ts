import type {
  CandidateFinding,
  CodeIndexVersion,
  PullRequestSnapshot,
  Repository,
  RepositorySettings,
  ReviewRun,
  ValidatedFinding,
} from "@repo/contracts";
import {
  CandidateFindingSchema,
  CodeIndexVersionSchema,
  PullRequestSnapshotSchema,
  parseWithSchema,
  RepositorySchema,
  RepositorySettingsSchema,
  ReviewRunSchema,
  ValidatedFindingSchema,
} from "@repo/contracts";

const toIso = (value: Date): string => value.toISOString();

const optionalRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const optionalString = (value: string | null): string | undefined => value ?? undefined;

const withOptional = <T extends object, K extends string, V>(
  key: K,
  value: V | undefined,
): T | Record<K, V> => (value === undefined ? ({} as T) : ({ [key]: value } as Record<K, V>));

/** Converts a repository row to the public repository contract. */
export const toRepository = (row: {
  repoId: string;
  orgId: string;
  installationId: string;
  provider: string;
  providerRepoId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string | null;
  cloneUrl: string | null;
  visibility: string;
  isArchived: boolean;
  isFork: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  metadata: unknown;
}): Repository =>
  parseWithSchema("Repository", RepositorySchema, {
    repoId: row.repoId,
    orgId: row.orgId,
    installationId: row.installationId,
    provider: row.provider as Repository["provider"],
    providerRepoId: row.providerRepoId,
    owner: row.owner,
    name: row.name,
    fullName: row.fullName,
    ...withOptional("defaultBranch", optionalString(row.defaultBranch)),
    ...withOptional("cloneUrl", optionalString(row.cloneUrl)),
    visibility: row.visibility as Repository["visibility"],
    isArchived: row.isArchived,
    isFork: row.isFork,
    enabled: row.enabled,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    ...withOptional("metadata", optionalRecord(row.metadata)),
  });

/** Converts a repository settings row to the repository settings contract. */
export const toRepositorySettings = (row: {
  repoId: string;
  reviewPolicy: string;
  severityThreshold: string;
  maxCommentsPerReview: number;
  ignoredPaths: unknown;
  ignoredAuthors: unknown;
  ignoredLabels: unknown;
  requireLabel: string | null;
  skipGeneratedFiles: boolean;
  skipDraftPullRequests: boolean;
  enabledLanguages: unknown;
  customInstructions: string | null;
  createdAt: Date;
  updatedAt: Date;
}): RepositorySettings =>
  parseWithSchema("RepositorySettings", RepositorySettingsSchema, {
    repoId: row.repoId,
    reviewPolicy: row.reviewPolicy as RepositorySettings["reviewPolicy"],
    severityThreshold: row.severityThreshold as RepositorySettings["severityThreshold"],
    maxCommentsPerReview: row.maxCommentsPerReview,
    ignoredPaths: row.ignoredPaths as RepositorySettings["ignoredPaths"],
    ignoredAuthors: row.ignoredAuthors as RepositorySettings["ignoredAuthors"],
    ignoredLabels: row.ignoredLabels as RepositorySettings["ignoredLabels"],
    ...withOptional("requireLabel", optionalString(row.requireLabel)),
    skipGeneratedFiles: row.skipGeneratedFiles,
    skipDraftPullRequests: row.skipDraftPullRequests,
    ...withOptional(
      "enabledLanguages",
      row.enabledLanguages === null
        ? undefined
        : (row.enabledLanguages as RepositorySettings["enabledLanguages"]),
    ),
    ...withOptional("customInstructions", optionalString(row.customInstructions)),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  });

/** Converts a code index row to the code index version contract. */
export const toCodeIndexVersion = (row: {
  indexVersionId: string;
  repoId: string;
  commitSha: string;
  status: string;
  artifactUri: string;
  artifactHash: string | null;
  indexerName: string;
  indexerVersion: string;
  chunkerVersion: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  chunkCount: number;
  embeddedChunkCount: number;
  createdAt: Date;
  completedAt: Date | null;
  error: unknown;
}): CodeIndexVersion =>
  parseWithSchema("CodeIndexVersion", CodeIndexVersionSchema, {
    indexVersionId: row.indexVersionId,
    repoId: row.repoId,
    commitSha: row.commitSha,
    status: row.status as CodeIndexVersion["status"],
    artifactUri: row.artifactUri,
    ...withOptional("artifactHash", optionalString(row.artifactHash)),
    indexerName: row.indexerName,
    indexerVersion: row.indexerVersion,
    chunkerVersion: row.chunkerVersion,
    fileCount: row.fileCount,
    symbolCount: row.symbolCount,
    edgeCount: row.edgeCount,
    chunkCount: row.chunkCount,
    embeddedChunkCount: row.embeddedChunkCount,
    createdAt: toIso(row.createdAt),
    ...withOptional("completedAt", row.completedAt ? toIso(row.completedAt) : undefined),
    ...withOptional("error", optionalRecord(row.error) as CodeIndexVersion["error"]),
  });

/** Converts a pull request snapshot row to the pull request snapshot contract. */
export const toPullRequestSnapshot = (row: {
  snapshotId: string;
  schemaVersion: string;
  provider: string;
  repoId: string;
  installationId: string;
  providerRepoId: string;
  providerPullRequestId: string;
  pullRequestNumber: number;
  title: string;
  body: string | null;
  authorLogin: string;
  authorAssociation: string | null;
  state: string;
  isDraft: boolean;
  labels: unknown;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  mergeBaseSha: string | null;
  changedFiles: unknown;
  diffHash: string;
  additions: number;
  deletions: number;
  changedFileCount: number;
  fetchedAt: Date;
  providerMetadata: unknown;
}): PullRequestSnapshot =>
  parseWithSchema("PullRequestSnapshot", PullRequestSnapshotSchema, {
    snapshotId: row.snapshotId,
    schemaVersion: row.schemaVersion as PullRequestSnapshot["schemaVersion"],
    provider: row.provider as PullRequestSnapshot["provider"],
    repoId: row.repoId,
    installationId: row.installationId,
    providerRepoId: row.providerRepoId,
    providerPullRequestId: row.providerPullRequestId,
    pullRequestNumber: row.pullRequestNumber,
    title: row.title,
    ...withOptional("body", optionalString(row.body)),
    authorLogin: row.authorLogin,
    ...withOptional("authorAssociation", optionalString(row.authorAssociation)),
    state: row.state as PullRequestSnapshot["state"],
    isDraft: row.isDraft,
    labels: row.labels as PullRequestSnapshot["labels"],
    baseRef: row.baseRef,
    baseSha: row.baseSha,
    headRef: row.headRef,
    headSha: row.headSha,
    ...withOptional("mergeBaseSha", optionalString(row.mergeBaseSha)),
    changedFiles: row.changedFiles as PullRequestSnapshot["changedFiles"],
    diffHash: row.diffHash,
    additions: row.additions,
    deletions: row.deletions,
    changedFileCount: row.changedFileCount,
    fetchedAt: toIso(row.fetchedAt),
    ...withOptional("providerMetadata", optionalRecord(row.providerMetadata)),
  });

/** Converts a review run row to the review run contract. */
export const toReviewRun = (row: {
  reviewRunId: string;
  schemaVersion: string;
  repoId: string;
  pullRequestSnapshotId: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  trigger: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  summary: string | null;
  artifactRefs: unknown;
  counts: unknown;
  error: unknown;
  metadata: unknown;
}): ReviewRun =>
  parseWithSchema("ReviewRun", ReviewRunSchema, {
    reviewRunId: row.reviewRunId,
    schemaVersion: row.schemaVersion as ReviewRun["schemaVersion"],
    repoId: row.repoId,
    pullRequestSnapshotId: row.pullRequestSnapshotId,
    pullRequestNumber: row.pullRequestNumber,
    baseSha: row.baseSha,
    headSha: row.headSha,
    trigger: row.trigger as ReviewRun["trigger"],
    status: row.status as ReviewRun["status"],
    ...withOptional("startedAt", row.startedAt ? toIso(row.startedAt) : undefined),
    ...withOptional("completedAt", row.completedAt ? toIso(row.completedAt) : undefined),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    ...withOptional("summary", optionalString(row.summary)),
    artifactRefs: row.artifactRefs as ReviewRun["artifactRefs"],
    counts: row.counts as ReviewRun["counts"],
    ...withOptional("error", optionalRecord(row.error) as ReviewRun["error"]),
    ...withOptional("metadata", optionalRecord(row.metadata)),
  });

/** Converts a candidate finding row to the candidate finding contract. */
export const toCandidateFinding = (row: {
  findingId: string;
  schemaVersion: string;
  reviewRunId: string;
  source: string;
  sourceName: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  location: unknown;
  evidence: unknown;
  suggestedFix: string | null;
  confidence: number;
  fingerprint: string;
  createdAt: Date;
  metadata: unknown;
}): CandidateFinding =>
  parseWithSchema("CandidateFinding", CandidateFindingSchema, {
    findingId: row.findingId,
    schemaVersion: row.schemaVersion as CandidateFinding["schemaVersion"],
    reviewRunId: row.reviewRunId,
    source: row.source as CandidateFinding["source"],
    sourceName: row.sourceName,
    category: row.category as CandidateFinding["category"],
    severity: row.severity as CandidateFinding["severity"],
    title: row.title,
    body: row.body,
    location: row.location as CandidateFinding["location"],
    evidence: row.evidence as CandidateFinding["evidence"],
    ...withOptional("suggestedFix", optionalString(row.suggestedFix)),
    confidence: row.confidence,
    fingerprint: row.fingerprint,
    createdAt: toIso(row.createdAt),
    ...withOptional("metadata", optionalRecord(row.metadata)),
  });

/** Converts a validated finding row to the validated finding contract. */
export const toValidatedFinding = (row: {
  findingId: string;
  candidateFindingId: string;
  reviewRunId: string;
  decision: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  location: unknown;
  evidence: unknown;
  confidence: number;
  validation: unknown;
  rank: number | null;
  fingerprint: string;
  metadata: unknown;
}): ValidatedFinding =>
  parseWithSchema("ValidatedFinding", ValidatedFindingSchema, {
    findingId: row.findingId,
    candidateFindingId: row.candidateFindingId,
    reviewRunId: row.reviewRunId,
    decision: row.decision as ValidatedFinding["decision"],
    category: row.category as ValidatedFinding["category"],
    severity: row.severity as ValidatedFinding["severity"],
    title: row.title,
    body: row.body,
    location: row.location as ValidatedFinding["location"],
    evidence: row.evidence as ValidatedFinding["evidence"],
    confidence: row.confidence,
    validation: row.validation as ValidatedFinding["validation"],
    ...withOptional("rank", row.rank ?? undefined),
    fingerprint: row.fingerprint,
    ...withOptional("metadata", optionalRecord(row.metadata)),
  });
