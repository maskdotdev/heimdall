import type { Repository } from "#contracts/repository/repository";
import {
  DEFAULT_ORG_SETTINGS,
  type OrgSettings,
  type RepositorySettings,
} from "#contracts/repository/settings";
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
  updatedAt: now,
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
  updatedAt: now,
} satisfies RepositorySettings;

export const validOrgSettingsFixture = {
  schemaVersion: "org_settings.v1",
  orgId: ids.orgId,
  defaultReviewPolicy: DEFAULT_ORG_SETTINGS.defaultReviewPolicy,
  defaultTriggerPolicy: {
    ...DEFAULT_ORG_SETTINGS.defaultTriggerPolicy,
    enabledActions: [...DEFAULT_ORG_SETTINGS.defaultTriggerPolicy.enabledActions],
    ignoredAuthors: [...DEFAULT_ORG_SETTINGS.defaultTriggerPolicy.ignoredAuthors],
    ignoredLabels: [...DEFAULT_ORG_SETTINGS.defaultTriggerPolicy.ignoredLabels],
  },
  defaultFindingPolicy: {
    ...DEFAULT_ORG_SETTINGS.defaultFindingPolicy,
    enabledCategories: [...DEFAULT_ORG_SETTINGS.defaultFindingPolicy.enabledCategories],
  },
  defaultPublishingPolicy: {
    ...DEFAULT_ORG_SETTINGS.defaultPublishingPolicy,
  },
  defaultMemoryPolicy: {
    ...DEFAULT_ORG_SETTINGS.defaultMemoryPolicy,
    trustedFeedbackRoles: [...DEFAULT_ORG_SETTINGS.defaultMemoryPolicy.trustedFeedbackRoles],
  },
  allowRepoLocalConfig: DEFAULT_ORG_SETTINGS.allowRepoLocalConfig,
  allowMemorySuppression: DEFAULT_ORG_SETTINGS.allowMemorySuppression,
  allowUserDefinedRules: DEFAULT_ORG_SETTINGS.allowUserDefinedRules,
  createdAt: now,
  updatedAt: now,
  updatedByUserId: null,
  version: 1,
} satisfies OrgSettings;
