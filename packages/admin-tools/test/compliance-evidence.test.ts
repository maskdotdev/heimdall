import type { HeimdallDatabase } from "@repo/db";
import {
  auditLogs,
  complianceEvidence,
  orgMemberships,
  orgSettings,
  repositories,
  repositorySettings,
} from "@repo/db";
import { describe, expect, it } from "vitest";
import {
  collectAccessReviewEvidence,
  collectAuditLogEvidence,
  collectConfigSnapshotEvidence,
  createMemoryComplianceEvidenceArtifactStore,
} from "../src";

describe("compliance evidence collectors", () => {
  const now = new Date("2026-05-08T14:30:00.000Z");

  it("collects access review evidence and records a durable descriptor", async () => {
    const artifactStore = createMemoryComplianceEvidenceArtifactStore();
    const db = createComplianceEvidenceDatabaseStub(
      new Map<unknown, readonly unknown[]>([
        [
          orgMemberships,
          [
            {
              createdAt: now,
              metadata: { privateNote: "not exported" },
              orgId: "org_1",
              role: "owner",
              updatedAt: now,
              userId: "user_owner",
            } satisfies typeof orgMemberships.$inferSelect,
          ],
        ],
      ]),
    );

    const result = await collectAccessReviewEvidence({
      artifactStore,
      collectedBy: "admin_tool:test",
      db,
      orgId: "org_1",
      now: () => now,
    });

    expect(result.record).toMatchObject({
      collectedBy: "admin_tool:test",
      controlId: "soc2.cc6.1.access_review",
      evidenceType: "access_review_export",
      orgId: "org_1",
      source: "admin_tool",
      status: "collected",
    });
    expect(result.payload).toMatchObject({
      records: [
        {
          orgId: "org_1",
          role: "owner",
          userId: "user_owner",
        },
      ],
      summary: {
        membershipCount: 1,
        orgScoped: true,
      },
    });
    expect(artifactStore.artifacts()).toHaveLength(1);
  });

  it("exports audit evidence without raw metadata values", async () => {
    const artifactStore = createMemoryComplianceEvidenceArtifactStore();
    const db = createComplianceEvidenceDatabaseStub(
      new Map<unknown, readonly unknown[]>([
        [
          auditLogs,
          [
            {
              action: "repo.settings.updated",
              actorType: "admin",
              actorUserId: "user_admin",
              auditLogId: "audit_1",
              metadata: {
                secret: "github_pat_secret_value",
                ticket: "SUP-1",
              },
              occurredAt: now,
              orgId: "org_1",
              resourceId: "repo_1",
              resourceType: "repository",
            } satisfies typeof auditLogs.$inferSelect,
          ],
        ],
      ]),
    );

    const result = await collectAuditLogEvidence({
      artifactStore,
      collectedBy: "admin_tool:test",
      db,
      orgId: "org_1",
      now: () => now,
    });

    expect(result.payload.records).toEqual([
      expect.objectContaining({
        auditLogId: "audit_1",
        metadataKeys: ["secret", "ticket"],
      }),
    ]);
    expect(JSON.stringify(result.payload)).not.toContain("github_pat_secret_value");
    expect(result.record.evidenceHash).toMatch(/^sha256:/u);
  });

  it("exports config snapshots without raw custom instructions", async () => {
    const artifactStore = createMemoryComplianceEvidenceArtifactStore();
    const db = createComplianceEvidenceDatabaseStub(
      new Map<unknown, readonly unknown[]>([
        [
          orgSettings,
          [
            {
              createdAt: now,
              orgId: "org_1",
              settingsJson: { defaultReviewPolicy: "balanced", secret: "not exported as value" },
              updatedAt: now,
              updatedByUserId: "user_admin",
              version: 3,
            } satisfies typeof orgSettings.$inferSelect,
          ],
        ],
        [
          repositories,
          [
            {
              cloneUrl: null,
              createdAt: now,
              defaultBranch: "main",
              enabled: true,
              fullName: "acme/private",
              installationId: "inst_1",
              isArchived: false,
              isFork: false,
              metadata: null,
              name: "private",
              orgId: "org_1",
              owner: "acme",
              provider: "github",
              providerRepoId: "100",
              repoId: "repo_1",
              updatedAt: now,
              visibility: "private",
            } satisfies typeof repositories.$inferSelect,
          ],
        ],
        [
          repositorySettings,
          [
            {
              createdAt: now,
              customInstructions: "Never expose this private instruction.",
              enabledLanguages: ["typescript"],
              ignoredAuthors: ["dependabot"],
              ignoredLabels: ["wip"],
              ignoredPaths: ["vendor/**"],
              maxCommentsPerReview: 5,
              repoId: "repo_1",
              requireLabel: "review-me",
              reviewPolicy: "balanced",
              sandboxPolicy: { network: "none" },
              severityThreshold: "medium",
              skipDraftPullRequests: true,
              skipGeneratedFiles: true,
              updatedAt: now,
            } satisfies typeof repositorySettings.$inferSelect,
          ],
        ],
      ]),
    );

    const result = await collectConfigSnapshotEvidence({
      artifactStore,
      collectedBy: "admin_tool:test",
      db,
      orgId: "org_1",
      now: () => now,
    });

    expect(result.payload.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          configType: "org_settings",
          settingsKeys: ["defaultReviewPolicy", "secret"],
          version: 3,
        }),
        expect.objectContaining({
          configType: "repository_settings",
          customInstructionsHash: expect.stringMatching(/^sha256:/u),
          customInstructionsLength: 38,
          ignoredAuthorCount: 1,
          ignoredLabelCount: 1,
          ignoredPathCount: 1,
          repoId: "repo_1",
          sandboxPolicyKeys: ["network"],
        }),
      ]),
    );
    expect(JSON.stringify(result.payload)).not.toContain("Never expose this private instruction");
  });
});

/** Creates a small Drizzle-like DB facade for compliance evidence collector tests. */
function createComplianceEvidenceDatabaseStub(
  rows: ReadonlyMap<unknown, readonly unknown[]>,
): HeimdallDatabase {
  return {
    insert: (table: unknown) => new ComplianceEvidenceInsertStub(table),
    select: () => new ComplianceEvidenceSelectStub(rows),
  } as unknown as HeimdallDatabase;
}

/** Minimal select builder backed by table-indexed rows. */
class ComplianceEvidenceSelectStub {
  /** Currently selected table. */
  private table: unknown = undefined;

  /** Creates a fake select builder. */
  public constructor(private readonly rows: ReadonlyMap<unknown, readonly unknown[]>) {}

  /** Records the selected table and returns this fake builder. */
  public from(table: unknown): this {
    this.table = table;
    return this;
  }

  /** Ignores predicates because tests provide only relevant scoped rows. */
  public where(): this {
    return this;
  }

  /** Ignores sort expressions and returns this fake builder. */
  public orderBy(): this {
    return this;
  }

  /** Resolves at most the requested number of fake rows. */
  public limit(count: number): Promise<readonly unknown[]> {
    return Promise.resolve((this.rows.get(this.table) ?? []).slice(0, count));
  }
}

/** Minimal insert builder that returns compliance evidence rows. */
class ComplianceEvidenceInsertStub {
  /** Insert values recorded by the fake builder. */
  private value: Record<string, unknown> | undefined;

  /** Creates a fake insert builder. */
  public constructor(private readonly table: unknown) {}

  /** Records insert values and returns this fake builder. */
  public values(value: Record<string, unknown>): this {
    this.value = value;
    return this;
  }

  /** Returns the inserted row with timestamp defaults. */
  public returning(): readonly Record<string, unknown>[] {
    if (this.table !== complianceEvidence || !this.value) {
      return [];
    }

    return [
      {
        createdAt: this.value.collectedAt,
        updatedAt: this.value.updatedAt,
        ...this.value,
      },
    ];
  }
}
