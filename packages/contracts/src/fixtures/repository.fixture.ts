import type { Repository } from "#contracts/repository/repository";
import type { RepositorySettings } from "#contracts/repository/settings";
import { ids, now } from "./common";

export const validRepositoryFixture = {
  repoId: ids.repoId,
  orgId: ids.orgId,
  installationId: ids.installationId,
  provider: "github",
  providerRepoId: "123456789",
  owner: "acme",
  name: "heimdall-example",
  fullName: "acme/heimdall-example",
  defaultBranch: "main",
  cloneUrl: "https://github.com/acme/heimdall-example.git",
  visibility: "private",
  isArchived: false,
  isFork: false,
  enabled: true,
  createdAt: now,
  updatedAt: now
} satisfies Repository;

export const validRepositorySettingsFixture = {
  repoId: ids.repoId,
  reviewPolicy: "inline_comments_and_summary",
  severityThreshold: "medium",
  maxCommentsPerReview: 5,
  ignoredPaths: ["node_modules/**", "dist/**"],
  ignoredAuthors: [],
  ignoredLabels: [],
  skipGeneratedFiles: true,
  skipDraftPullRequests: true,
  enabledLanguages: ["typescript", "tsx"],
  customInstructions: "Prefer actionable correctness and security findings.",
  createdAt: now,
  updatedAt: now
} satisfies RepositorySettings;
