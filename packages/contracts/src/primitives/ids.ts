import { type Static, Type } from "@sinclair/typebox";

export const PrefixedIdSchema = Type.String({
  minLength: 4,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9]*_[A-Za-z0-9_-]+$",
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

export const BillingAccountIdSchema = Type.String({ pattern: "^bill_[A-Za-z0-9_-]+$" });
export type BillingAccountId = Static<typeof BillingAccountIdSchema>;

export const BillingPlanIdSchema = Type.String({ pattern: "^plan_[A-Za-z0-9_-]+$" });
export type BillingPlanId = Static<typeof BillingPlanIdSchema>;

export const BillingPlanVersionIdSchema = Type.String({ pattern: "^planv_[A-Za-z0-9_-]+$" });
export type BillingPlanVersionId = Static<typeof BillingPlanVersionIdSchema>;

export const SubscriptionIdSchema = Type.String({ pattern: "^sub_[A-Za-z0-9_-]+$" });
export type SubscriptionId = Static<typeof SubscriptionIdSchema>;

export const SubscriptionItemIdSchema = Type.String({ pattern: "^subitem_[A-Za-z0-9_-]+$" });
export type SubscriptionItemId = Static<typeof SubscriptionItemIdSchema>;

export const CreditGrantIdSchema = Type.String({ pattern: "^cred_[A-Za-z0-9_-]+$" });
export type CreditGrantId = Static<typeof CreditGrantIdSchema>;

export const InvoiceIdSchema = Type.String({ pattern: "^inv_[A-Za-z0-9_-]+$" });
export type InvoiceId = Static<typeof InvoiceIdSchema>;

export const BillingMeterEventIdSchema = Type.String({ pattern: "^bmtr_[A-Za-z0-9_-]+$" });
export type BillingMeterEventId = Static<typeof BillingMeterEventIdSchema>;

export const EntitlementIdSchema = Type.String({ pattern: "^ent_[A-Za-z0-9_-]+$" });
export type EntitlementId = Static<typeof EntitlementIdSchema>;

export const QuotaCounterIdSchema = Type.String({ pattern: "^qctr_[A-Za-z0-9_-]+$" });
export type QuotaCounterId = Static<typeof QuotaCounterIdSchema>;

export const QuotaReservationIdSchema = Type.String({ pattern: "^qres_[A-Za-z0-9_-]+$" });
export type QuotaReservationId = Static<typeof QuotaReservationIdSchema>;

export const DataDeletionRequestIdSchema = Type.String({ pattern: "^ddr_[A-Za-z0-9_-]+$" });
export type DataDeletionRequestId = Static<typeof DataDeletionRequestIdSchema>;

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
