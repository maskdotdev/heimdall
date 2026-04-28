import { Type, type Static } from "@sinclair/typebox";

export const PrefixedIdSchema = Type.String({
  minLength: 4,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9]*_[A-Za-z0-9_-]+$"
});
export type PrefixedId = Static<typeof PrefixedIdSchema>;

export const OrgIdSchema = Type.String({ pattern: "^org_[A-Za-z0-9_-]+$" });
export type OrgId = Static<typeof OrgIdSchema>;

export const UserIdSchema = Type.String({ pattern: "^usr_[A-Za-z0-9_-]+$" });
export type UserId = Static<typeof UserIdSchema>;

export const InstallationIdSchema = Type.String({ pattern: "^inst_[A-Za-z0-9_-]+$" });
export type InstallationId = Static<typeof InstallationIdSchema>;

export const RepoIdSchema = Type.String({ pattern: "^repo_[A-Za-z0-9_-]+$" });
export type RepoId = Static<typeof RepoIdSchema>;

export const PullRequestIdSchema = Type.String({ pattern: "^pr_[A-Za-z0-9_-]+$" });
export type PullRequestId = Static<typeof PullRequestIdSchema>;

export const PullRequestSnapshotIdSchema = Type.String({ pattern: "^prs_[A-Za-z0-9_-]+$" });
export type PullRequestSnapshotId = Static<typeof PullRequestSnapshotIdSchema>;

export const IndexVersionIdSchema = Type.String({ pattern: "^idx_[A-Za-z0-9_-]+$" });
export type IndexVersionId = Static<typeof IndexVersionIdSchema>;

export const ReviewRunIdSchema = Type.String({ pattern: "^rrn_[A-Za-z0-9_-]+$" });
export type ReviewRunId = Static<typeof ReviewRunIdSchema>;

export const ArtifactIdSchema = Type.String({ pattern: "^art_[A-Za-z0-9_-]+$" });
export type ArtifactId = Static<typeof ArtifactIdSchema>;

export const FindingIdSchema = Type.String({ pattern: "^fnd_[A-Za-z0-9_-]+$" });
export type FindingId = Static<typeof FindingIdSchema>;

export const OutcomeIdSchema = Type.String({ pattern: "^out_[A-Za-z0-9_-]+$" });
export type OutcomeId = Static<typeof OutcomeIdSchema>;

export const MemoryFactIdSchema = Type.String({ pattern: "^mem_[A-Za-z0-9_-]+$" });
export type MemoryFactId = Static<typeof MemoryFactIdSchema>;

export const RepoRuleIdSchema = Type.String({ pattern: "^rule_[A-Za-z0-9_-]+$" });
export type RepoRuleId = Static<typeof RepoRuleIdSchema>;

export const LLMCallIdSchema = Type.String({ pattern: "^llm_[A-Za-z0-9_-]+$" });
export type LLMCallId = Static<typeof LLMCallIdSchema>;

export const UsageEventIdSchema = Type.String({ pattern: "^usage_[A-Za-z0-9_-]+$" });
export type UsageEventId = Static<typeof UsageEventIdSchema>;

export const WebhookEventIdSchema = Type.String({ pattern: "^webhook_[A-Za-z0-9_-]+$" });
export type WebhookEventId = Static<typeof WebhookEventIdSchema>;

export const FileIdSchema = Type.String({ pattern: "^file_[A-Za-z0-9_-]+$" });
export type FileId = Static<typeof FileIdSchema>;

export const SymbolIdSchema = Type.String({ pattern: "^sym_[A-Za-z0-9_-]+$" });
export type SymbolId = Static<typeof SymbolIdSchema>;

export const ChunkIdSchema = Type.String({ pattern: "^chunk_[A-Za-z0-9_-]+$" });
export type ChunkId = Static<typeof ChunkIdSchema>;

export const EdgeIdSchema = Type.String({ pattern: "^edge_[A-Za-z0-9_-]+$" });
export type EdgeId = Static<typeof EdgeIdSchema>;

export const DiagnosticIdSchema = Type.String({ pattern: "^diag_[A-Za-z0-9_-]+$" });
export type DiagnosticId = Static<typeof DiagnosticIdSchema>;
