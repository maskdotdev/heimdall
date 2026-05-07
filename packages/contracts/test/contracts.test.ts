import { describe, expect, it } from "vitest";
import {
  CreateBillingCheckoutSessionRequestSchema,
  CreateBillingPortalSessionRequestSchema,
} from "#contracts/api/billing";
import { ApiErrorResponseSchema } from "#contracts/api/errors";
import {
  ListRepositoriesResponseSchema,
  UpdateRepositorySettingsRequestSchema,
} from "#contracts/api/repositories";
import { GetReviewRunResponseSchema } from "#contracts/api/reviews";
import {
  CreateRepoRuleRequestSchema,
  ListRepoRulesResponseSchema,
  UpdateRepoRuleRequestSchema,
} from "#contracts/api/rules";
import { JOB_TYPES } from "#contracts/enums/jobs";
import {
  validCandidateFindingFixture,
  validPublishedFindingFixture,
  validValidatedFindingFixture,
} from "#contracts/fixtures/finding.fixture";
import {
  validOrgFixture,
  validProviderInstallationFixture,
  validUserFixture,
} from "#contracts/fixtures/identity.fixture";
import {
  validIndexManifestFixture,
  validIndexRecordsFixture,
} from "#contracts/fixtures/index-artifact.fixture";
import {
  validBillingReconcileJobPayloadFixture,
  validEmbeddingBatchJobPayloadFixture,
  validEmbeddingRepairJobPayloadFixture,
  validIndexRepoCommitJobPayloadFixture,
  validPublishReviewJobPayloadFixture,
  validReviewArtifactCleanupJobPayloadFixture,
  validReviewPullRequestJobPayloadFixture,
  validSandboxCleanupJobPayloadFixture,
  validSyncInstallationJobPayloadFixture,
  validUpdateMemoryJobPayloadFixture,
} from "#contracts/fixtures/jobs.fixture";
import {
  validFindingOutcomeFixture,
  validMemoryFactFixture,
  validRepoRuleFixture,
} from "#contracts/fixtures/memory.fixture";
import {
  validBillingAccountFixture,
  validBillingMeterEventFixture,
  validBillingPlanFixture,
  validBillingPlanVersionFixture,
  validCodeIndexVersionFixture,
  validCreditGrantFixture,
  validEntitlementDecisionFixture,
  validEntitlementFixture,
  validInvoiceFixture,
  validLLMCallFixture,
  validPlanSnapshotFixture,
  validPromptVersionFixture,
  validQuotaCounterFixture,
  validQuotaReservationFixture,
  validSubscriptionFixture,
  validSubscriptionItemFixture,
  validUsageEventFixture,
  validWebhookEventFixture,
} from "#contracts/fixtures/operations.fixture";
import {
  validChangeSetFixture,
  validPullRequestSnapshotFixture,
} from "#contracts/fixtures/pull-request.fixture";
import {
  validRepositoryFixture,
  validRepositorySettingsFixture,
} from "#contracts/fixtures/repository.fixture";
import {
  validContextBundleFixture,
  validReviewRunFixture,
} from "#contracts/fixtures/review.fixture";
import { ProviderInstallationSchema } from "#contracts/identity/installation";
import { OrgSchema } from "#contracts/identity/org";
import { UserSchema } from "#contracts/identity/user";
import { CodeIndexVersionSchema } from "#contracts/index-artifact/artifact";
import {
  IndexManifestSchema,
  isSupportedIndexManifestVersion,
} from "#contracts/index-artifact/manifest";
import {
  IndexRecordSchema,
  isSupportedIndexRecordVersion,
} from "#contracts/index-artifact/records";
import { JobEnvelopeSchema } from "#contracts/jobs/envelope";
import {
  BillingReconcileJobPayloadSchema,
  EmbeddingBatchJobPayloadSchema,
  EmbeddingRepairJobPayloadSchema,
  IndexRepoCommitJobPayloadSchema,
  PublishReviewJobPayloadSchema,
  ReviewArtifactCleanupJobPayloadSchema,
  ReviewPullRequestJobPayloadSchema,
  SandboxCleanupJobPayloadSchema,
  SyncInstallationJobPayloadSchema,
  UpdateMemoryJobPayloadSchema,
} from "#contracts/jobs/payloads";
import { LLMCallSchema } from "#contracts/llm/llm-call";
import { PromptVersionSchema } from "#contracts/llm/prompt";
import { FindingOutcomeSchema } from "#contracts/memory/finding-outcome";
import { MemoryFactSchema } from "#contracts/memory/memory-fact";
import { RepoRuleSchema } from "#contracts/memory/repo-rule";
import { RepoPathSchema } from "#contracts/primitives/paths";
import { ChangeSetSchema } from "#contracts/pull-request/change-set";
import { PullRequestSnapshotSchema } from "#contracts/pull-request/pull-request";
import { RepositorySchema } from "#contracts/repository/repository";
import { RepositorySettingsSchema } from "#contracts/repository/settings";
import { getReviewArtifactRedactionLevel } from "#contracts/review/artifacts";
import { ContextBundleSchema } from "#contracts/review/context";
import {
  CandidateFindingSchema,
  PublishedFindingSchema,
  ValidatedFindingSchema,
} from "#contracts/review/finding";
import { ReviewRunSchema } from "#contracts/review/review-run";
import {
  BillingAccountSchema,
  BillingMeterEventSchema,
  BillingPlanSchema,
  BillingPlanVersionSchema,
  CreditGrantSchema,
  EntitlementDecisionSchema,
  EntitlementSchema,
  InvoiceSchema,
  PlanSnapshotSchema,
  SubscriptionItemSchema,
  SubscriptionSchema,
} from "#contracts/usage/entitlements";
import { QuotaCounterSchema, QuotaReservationSchema } from "#contracts/usage/quota";
import { UsageEventSchema } from "#contracts/usage/usage-event";
import { parseWithSchema, safeParseWithSchema } from "#contracts/validation/parse";
import { WebhookEventSchema } from "#contracts/webhook/webhook-event";

describe("contract validation", () => {
  it("validates primitive repo paths", () => {
    expect(safeParseWithSchema("RepoPath", RepoPathSchema, "src/index.ts").ok).toBe(true);
    expect(safeParseWithSchema("RepoPath", RepoPathSchema, "/src/index.ts").ok).toBe(false);
    expect(safeParseWithSchema("RepoPath", RepoPathSchema, "../secret.ts").ok).toBe(false);
    expect(safeParseWithSchema("RepoPath", RepoPathSchema, "src\\index.ts").ok).toBe(false);
  });

  it("validates billing API request contracts", () => {
    expect(
      parseWithSchema(
        "CreateBillingCheckoutSessionRequest",
        CreateBillingCheckoutSessionRequestSchema,
        {
          cancelUrl: "https://app.example.test/billing",
          orgId: "org_01HXAMPLE",
          planKey: "team",
          quantity: 3,
          successUrl: "https://app.example.test/billing/success",
        },
      ),
    ).toEqual({
      cancelUrl: "https://app.example.test/billing",
      orgId: "org_01HXAMPLE",
      planKey: "team",
      quantity: 3,
      successUrl: "https://app.example.test/billing/success",
    });
    expect(
      parseWithSchema(
        "CreateBillingPortalSessionRequest",
        CreateBillingPortalSessionRequestSchema,
        {
          orgId: "org_01HXAMPLE",
          returnUrl: "https://app.example.test/billing",
        },
      ),
    ).toEqual({
      orgId: "org_01HXAMPLE",
      returnUrl: "https://app.example.test/billing",
    });
  });

  it("validates pull request snapshot fixtures", () => {
    expect(
      parseWithSchema(
        "PullRequestSnapshot",
        PullRequestSnapshotSchema,
        validPullRequestSnapshotFixture,
      ),
    ).toEqual(validPullRequestSnapshotFixture);
    expect(parseWithSchema("ChangeSet", ChangeSetSchema, validChangeSetFixture)).toEqual(
      validChangeSetFixture,
    );
  });

  it("validates identity and repository contract fixtures", () => {
    expect(parseWithSchema("Org", OrgSchema, validOrgFixture)).toEqual(validOrgFixture);
    expect(parseWithSchema("User", UserSchema, validUserFixture)).toEqual(validUserFixture);
    expect(
      parseWithSchema(
        "ProviderInstallation",
        ProviderInstallationSchema,
        validProviderInstallationFixture,
      ),
    ).toEqual(validProviderInstallationFixture);
    expect(parseWithSchema("Repository", RepositorySchema, validRepositoryFixture)).toEqual(
      validRepositoryFixture,
    );
    expect(
      parseWithSchema(
        "RepositorySettings",
        RepositorySettingsSchema,
        validRepositorySettingsFixture,
      ),
    ).toEqual(validRepositorySettingsFixture);
  });

  it("validates index manifest and record fixtures", () => {
    expect(
      parseWithSchema("IndexManifest", IndexManifestSchema, validIndexManifestFixture),
    ).toEqual(validIndexManifestFixture);
    expect(
      parseWithSchema("CodeIndexVersion", CodeIndexVersionSchema, validCodeIndexVersionFixture),
    ).toEqual(validCodeIndexVersionFixture);

    for (const record of validIndexRecordsFixture) {
      expect(parseWithSchema("IndexRecord", IndexRecordSchema, record)).toEqual(record);
      expect(isSupportedIndexRecordVersion(record)).toBe(true);
    }
  });

  it("validates review and finding fixtures", () => {
    expect(
      parseWithSchema("ContextBundle", ContextBundleSchema, validContextBundleFixture),
    ).toEqual(validContextBundleFixture);
    expect(parseWithSchema("ReviewRun", ReviewRunSchema, validReviewRunFixture)).toEqual(
      validReviewRunFixture,
    );
    expect(
      parseWithSchema("CandidateFinding", CandidateFindingSchema, validCandidateFindingFixture),
    ).toEqual(validCandidateFindingFixture);
    expect(
      parseWithSchema("ValidatedFinding", ValidatedFindingSchema, validValidatedFindingFixture),
    ).toEqual(validValidatedFindingFixture);
    expect(
      parseWithSchema("PublishedFinding", PublishedFindingSchema, validPublishedFindingFixture),
    ).toEqual(validPublishedFindingFixture);
  });

  it("maps review artifact kinds to observability redaction levels", () => {
    expect(getReviewArtifactRedactionLevel("context_bundle")).toBe("contains_code");
    expect(getReviewArtifactRedactionLevel("llm_prompt")).toBe("contains_prompt");
    expect(getReviewArtifactRedactionLevel("policy_snapshot")).toBe("safe");
    expect(getReviewArtifactRedactionLevel("pull_request_snapshot")).toBe("contains_sensitive");
  });

  it("validates memory, LLM, usage, and webhook fixtures", () => {
    expect(
      parseWithSchema("FindingOutcome", FindingOutcomeSchema, validFindingOutcomeFixture),
    ).toEqual(validFindingOutcomeFixture);
    expect(parseWithSchema("RepoRule", RepoRuleSchema, validRepoRuleFixture)).toEqual(
      validRepoRuleFixture,
    );
    expect(parseWithSchema("MemoryFact", MemoryFactSchema, validMemoryFactFixture)).toEqual(
      validMemoryFactFixture,
    );
    expect(parseWithSchema("LLMCall", LLMCallSchema, validLLMCallFixture)).toEqual(
      validLLMCallFixture,
    );
    expect(
      parseWithSchema("PromptVersion", PromptVersionSchema, validPromptVersionFixture),
    ).toEqual(validPromptVersionFixture);
    expect(parseWithSchema("UsageEvent", UsageEventSchema, validUsageEventFixture)).toEqual(
      validUsageEventFixture,
    );
    expect(parseWithSchema("BillingPlan", BillingPlanSchema, validBillingPlanFixture)).toEqual(
      validBillingPlanFixture,
    );
    expect(
      parseWithSchema(
        "BillingPlanVersion",
        BillingPlanVersionSchema,
        validBillingPlanVersionFixture,
      ),
    ).toEqual(validBillingPlanVersionFixture);
    expect(
      parseWithSchema("BillingAccount", BillingAccountSchema, validBillingAccountFixture),
    ).toEqual(validBillingAccountFixture);
    expect(parseWithSchema("Subscription", SubscriptionSchema, validSubscriptionFixture)).toEqual(
      validSubscriptionFixture,
    );
    expect(
      parseWithSchema("SubscriptionItem", SubscriptionItemSchema, validSubscriptionItemFixture),
    ).toEqual(validSubscriptionItemFixture);
    expect(parseWithSchema("CreditGrant", CreditGrantSchema, validCreditGrantFixture)).toEqual(
      validCreditGrantFixture,
    );
    expect(parseWithSchema("Invoice", InvoiceSchema, validInvoiceFixture)).toEqual(
      validInvoiceFixture,
    );
    expect(
      parseWithSchema("BillingMeterEvent", BillingMeterEventSchema, validBillingMeterEventFixture),
    ).toEqual(validBillingMeterEventFixture);
    expect(parseWithSchema("Entitlement", EntitlementSchema, validEntitlementFixture)).toEqual(
      validEntitlementFixture,
    );
    expect(parseWithSchema("PlanSnapshot", PlanSnapshotSchema, validPlanSnapshotFixture)).toEqual(
      validPlanSnapshotFixture,
    );
    expect(
      parseWithSchema(
        "EntitlementDecision",
        EntitlementDecisionSchema,
        validEntitlementDecisionFixture,
      ),
    ).toEqual(validEntitlementDecisionFixture);
    expect(parseWithSchema("QuotaCounter", QuotaCounterSchema, validQuotaCounterFixture)).toEqual(
      validQuotaCounterFixture,
    );
    expect(
      parseWithSchema("QuotaReservation", QuotaReservationSchema, validQuotaReservationFixture),
    ).toEqual(validQuotaReservationFixture);
    expect(parseWithSchema("WebhookEvent", WebhookEventSchema, validWebhookEventFixture)).toEqual(
      validWebhookEventFixture,
    );
  });

  it("validates job payload fixtures", () => {
    expect(
      parseWithSchema(
        "SyncInstallationJobPayload",
        SyncInstallationJobPayloadSchema,
        validSyncInstallationJobPayloadFixture,
      ),
    ).toEqual(validSyncInstallationJobPayloadFixture);
    expect(
      parseWithSchema(
        "IndexRepoCommitJobPayload",
        IndexRepoCommitJobPayloadSchema,
        validIndexRepoCommitJobPayloadFixture,
      ),
    ).toEqual(validIndexRepoCommitJobPayloadFixture);
    expect(
      parseWithSchema(
        "EmbeddingBatchJobPayload",
        EmbeddingBatchJobPayloadSchema,
        validEmbeddingBatchJobPayloadFixture,
      ),
    ).toEqual(validEmbeddingBatchJobPayloadFixture);
    expect(
      parseWithSchema(
        "EmbeddingRepairJobPayload",
        EmbeddingRepairJobPayloadSchema,
        validEmbeddingRepairJobPayloadFixture,
      ),
    ).toEqual(validEmbeddingRepairJobPayloadFixture);
    expect(
      parseWithSchema(
        "ReviewPullRequestJobPayload",
        ReviewPullRequestJobPayloadSchema,
        validReviewPullRequestJobPayloadFixture,
      ),
    ).toEqual(validReviewPullRequestJobPayloadFixture);
    expect(
      parseWithSchema(
        "PublishReviewJobPayload",
        PublishReviewJobPayloadSchema,
        validPublishReviewJobPayloadFixture,
      ),
    ).toEqual(validPublishReviewJobPayloadFixture);
    expect(
      parseWithSchema(
        "UpdateMemoryJobPayload",
        UpdateMemoryJobPayloadSchema,
        validUpdateMemoryJobPayloadFixture,
      ),
    ).toEqual(validUpdateMemoryJobPayloadFixture);
    expect(
      parseWithSchema(
        "BillingReconcileJobPayload",
        BillingReconcileJobPayloadSchema,
        validBillingReconcileJobPayloadFixture,
      ),
    ).toEqual(validBillingReconcileJobPayloadFixture);
    expect(
      parseWithSchema(
        "SandboxCleanupJobPayload",
        SandboxCleanupJobPayloadSchema,
        validSandboxCleanupJobPayloadFixture,
      ),
    ).toEqual(validSandboxCleanupJobPayloadFixture);
    expect(
      parseWithSchema(
        "ReviewArtifactCleanupJobPayload",
        ReviewArtifactCleanupJobPayloadSchema,
        validReviewArtifactCleanupJobPayloadFixture,
      ),
    ).toEqual(validReviewArtifactCleanupJobPayloadFixture);

    const envelope = {
      jobId: "job_01HXAMPLE",
      jobType: JOB_TYPES.ReviewPullRequest,
      schemaVersion: "job_envelope.v1",
      idempotencyKey: "repo_01HXAMPLE:42:2222222",
      createdAt: "2026-04-28T12:00:00.000Z",
      attempt: 0,
      maxAttempts: 3,
      traceContext: {
        parentEventId: "webhook_01HXAMPLE",
        requestId: "req_01HXAMPLE",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=value",
      },
      payload: validReviewPullRequestJobPayloadFixture,
    };

    expect(
      parseWithSchema(
        "ReviewPullRequestJobEnvelope",
        JobEnvelopeSchema(ReviewPullRequestJobPayloadSchema),
        envelope,
      ),
    ).toEqual(envelope);
  });

  it("validates API DTO contracts", () => {
    expect(
      safeParseWithSchema("ApiErrorResponse", ApiErrorResponseSchema, {
        error: {
          code: "contract.validation_failed",
          message: "Invalid input",
        },
      }).ok,
    ).toBe(true);

    expect(
      safeParseWithSchema("ListRepositoriesResponse", ListRepositoriesResponseSchema, {
        data: {
          repositories: [],
        },
      }).ok,
    ).toBe(true);

    expect(
      safeParseWithSchema(
        "UpdateRepositorySettingsRequest",
        UpdateRepositorySettingsRequestSchema,
        {
          severityThreshold: "high",
          maxCommentsPerReview: 10,
        },
      ).ok,
    ).toBe(true);

    expect(
      safeParseWithSchema("GetReviewRunResponse", GetReviewRunResponseSchema, {
        data: {
          reviewRun: validReviewRunFixture,
          findings: [validPublishedFindingFixture],
        },
      }).ok,
    ).toBe(true);

    expect(
      safeParseWithSchema("ListRepoRulesResponse", ListRepoRulesResponseSchema, {
        data: {
          rules: [validRepoRuleFixture],
        },
      }).ok,
    ).toBe(true);

    expect(
      safeParseWithSchema("CreateRepoRuleRequest", CreateRepoRuleRequestSchema, {
        name: "Suppress generated files",
        effect: "suppress",
        matcher: { paths: ["**/*.generated.ts"] },
        instruction: "Do not publish generated-file findings.",
        priority: 100,
        enabled: true,
      }).ok,
    ).toBe(true);

    expect(
      safeParseWithSchema("UpdateRepoRuleRequest", UpdateRepoRuleRequestSchema, {
        enabled: false,
      }).ok,
    ).toBe(true);
  });

  it("rejects invalid fixtures", () => {
    const invalidSnapshot = {
      ...validPullRequestSnapshotFixture,
      schemaVersion: "pull_request_snapshot.v2",
    };

    const result = safeParseWithSchema(
      "PullRequestSnapshot",
      PullRequestSnapshotSchema,
      invalidSnapshot,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("contract.validation_failed");
      expect(result.error.issues.length).toBeGreaterThan(0);
    }

    expect(
      safeParseWithSchema("CandidateFinding", CandidateFindingSchema, {
        ...validCandidateFindingFixture,
        evidence: [],
      }).ok,
    ).toBe(false);

    expect(
      safeParseWithSchema("Repository", RepositorySchema, {
        ...validRepositoryFixture,
        installationToken: "must-not-be-in-contracts",
      }).ok,
    ).toBe(false);
  });

  it("reports supported schema versions", () => {
    expect(isSupportedIndexManifestVersion("index_artifact.v1")).toBe(true);
    expect(isSupportedIndexManifestVersion("index_artifact.v2")).toBe(false);
  });
});
