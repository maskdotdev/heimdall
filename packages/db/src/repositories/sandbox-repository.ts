import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { sandboxArtifacts, sandboxPolicyDecisions, sandboxRuns } from "../schema";

/** Insert row accepted for a persisted sandbox run. */
export type SandboxRunInsert = typeof sandboxRuns.$inferInsert;

/** Insert row accepted for a persisted sandbox artifact. */
export type SandboxArtifactInsert = typeof sandboxArtifacts.$inferInsert;

/** Insert row accepted for a persisted sandbox policy decision. */
export type SandboxPolicyDecisionInsert = typeof sandboxPolicyDecisions.$inferInsert;

/** Durable sandbox run row returned for debug inspection. */
export type SandboxRunRecord = typeof sandboxRuns.$inferSelect;

/** Durable sandbox artifact row returned for debug inspection. */
export type SandboxArtifactRecord = typeof sandboxArtifacts.$inferSelect;

/** Durable sandbox policy decision row returned for debug inspection. */
export type SandboxPolicyDecisionRecord = typeof sandboxPolicyDecisions.$inferSelect;

/** Input used to upsert a sandbox run and replace its child rows. */
export type UpsertSandboxRunWithChildrenInput = {
  /** Parent sandbox run row. */
  readonly run: SandboxRunInsert;
  /** Artifact rows attached to the sandbox run. */
  readonly artifacts?: readonly SandboxArtifactInsert[] | undefined;
  /** Policy decision rows attached to the sandbox run. */
  readonly policyDecisions?: readonly SandboxPolicyDecisionInsert[] | undefined;
};

/** Input used to list old sandbox runs for retention cleanup. */
export type ListSandboxRunCleanupTargetsInput = {
  /** Exclusive sandbox run creation cutoff. */
  readonly cutoff: Date;
  /** Maximum number of sandbox runs to return. */
  readonly limit?: number | undefined;
  /** Optional repository scope for the cleanup pass. */
  readonly repoId?: string | undefined;
};

/** Input used to list sandbox runs for operator inspection. */
export type ListSandboxRunsForInspectionInput = {
  /** Maximum sandbox runs to return. */
  readonly limit?: number | undefined;
  /** Optional repository scope for sandbox run history. */
  readonly repoId?: string | undefined;
  /** Optional review run scope for sandbox run history. */
  readonly reviewRunId?: string | undefined;
  /** Optional sandbox run status filter. */
  readonly status?: string | undefined;
};

/** Sandbox run selected for retention cleanup. */
export type SandboxRunCleanupTargetRecord = {
  /** Durable sandbox run ID. */
  readonly sandboxRunId: string;
};

/** Sandbox artifact URI selected for backing-file cleanup. */
export type SandboxArtifactUriRecord = {
  /** Artifact URI stored on the sandbox artifact row. */
  readonly uri: string;
};

/** Query helper for sandbox run persistence and retention cleanup. */
export class SandboxRepository {
  /** Creates a sandbox query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Lists sandbox runs linked to one review run in creation order. */
  public async listSandboxRunsForReviewRun(
    reviewRunId: string,
  ): Promise<readonly SandboxRunRecord[]> {
    return this.db
      .select()
      .from(sandboxRuns)
      .where(eq(sandboxRuns.reviewRunId, reviewRunId))
      .orderBy(asc(sandboxRuns.createdAt), asc(sandboxRuns.sandboxRunId));
  }

  /** Lists product-safe sandbox run history for operator inspection. */
  public async listSandboxRunsForInspection(
    input: ListSandboxRunsForInspectionInput,
  ): Promise<readonly SandboxRunRecord[]> {
    const conditions = [
      ...(input.repoId ? [eq(sandboxRuns.repoId, input.repoId)] : []),
      ...(input.reviewRunId ? [eq(sandboxRuns.reviewRunId, input.reviewRunId)] : []),
      ...(input.status ? [eq(sandboxRuns.status, input.status)] : []),
    ];

    return this.db
      .select()
      .from(sandboxRuns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(sandboxRuns.createdAt), desc(sandboxRuns.sandboxRunId))
      .limit(sandboxInspectionLimit(input.limit));
  }

  /** Lists artifact rows attached to the given sandbox runs. */
  public async listSandboxArtifactsForRuns(
    sandboxRunIds: readonly string[],
  ): Promise<readonly SandboxArtifactRecord[]> {
    const uniqueSandboxRunIds = uniqueStableStrings(sandboxRunIds);
    if (uniqueSandboxRunIds.length === 0) {
      return [];
    }

    return this.db
      .select()
      .from(sandboxArtifacts)
      .where(inArray(sandboxArtifacts.sandboxRunId, uniqueSandboxRunIds))
      .orderBy(asc(sandboxArtifacts.createdAt), asc(sandboxArtifacts.sandboxArtifactId));
  }

  /** Lists policy decision rows attached to the given sandbox runs. */
  public async listSandboxPolicyDecisionsForRuns(
    sandboxRunIds: readonly string[],
  ): Promise<readonly SandboxPolicyDecisionRecord[]> {
    const uniqueSandboxRunIds = uniqueStableStrings(sandboxRunIds);
    if (uniqueSandboxRunIds.length === 0) {
      return [];
    }

    return this.db
      .select()
      .from(sandboxPolicyDecisions)
      .where(inArray(sandboxPolicyDecisions.sandboxRunId, uniqueSandboxRunIds))
      .orderBy(
        asc(sandboxPolicyDecisions.createdAt),
        asc(sandboxPolicyDecisions.sandboxPolicyDecisionId),
      );
  }

  /** Upserts one sandbox run and replaces child artifact and policy decision rows. */
  public async upsertSandboxRunWithChildren(
    input: UpsertSandboxRunWithChildrenInput,
  ): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await transaction
        .insert(sandboxRuns)
        .values(input.run)
        .onConflictDoUpdate({
          target: sandboxRuns.sandboxRunId,
          set: sandboxRunUpdateFromInsert(input.run),
        });
      await transaction
        .delete(sandboxArtifacts)
        .where(eq(sandboxArtifacts.sandboxRunId, input.run.sandboxRunId));
      await transaction
        .delete(sandboxPolicyDecisions)
        .where(eq(sandboxPolicyDecisions.sandboxRunId, input.run.sandboxRunId));

      if (input.artifacts && input.artifacts.length > 0) {
        await transaction.insert(sandboxArtifacts).values([...input.artifacts]);
      }
      if (input.policyDecisions && input.policyDecisions.length > 0) {
        await transaction.insert(sandboxPolicyDecisions).values([...input.policyDecisions]);
      }
    });
  }

  /** Lists old sandbox runs eligible for retention cleanup. */
  public async listSandboxRunCleanupTargets(
    input: ListSandboxRunCleanupTargetsInput,
  ): Promise<readonly SandboxRunCleanupTargetRecord[]> {
    const conditions = [
      lt(sandboxRuns.createdAt, input.cutoff),
      ...(input.repoId ? [eq(sandboxRuns.repoId, input.repoId)] : []),
    ];

    return this.db
      .select({
        sandboxRunId: sandboxRuns.sandboxRunId,
      })
      .from(sandboxRuns)
      .where(and(...conditions))
      .orderBy(asc(sandboxRuns.createdAt), asc(sandboxRuns.sandboxRunId))
      .limit(sandboxCleanupLimit(input.limit));
  }

  /** Lists artifact URIs attached to the given sandbox runs. */
  public async listSandboxArtifactUrisForRuns(
    sandboxRunIds: readonly string[],
  ): Promise<readonly SandboxArtifactUriRecord[]> {
    const uniqueSandboxRunIds = uniqueStableStrings(sandboxRunIds);
    if (uniqueSandboxRunIds.length === 0) {
      return [];
    }

    return this.db
      .select({ uri: sandboxArtifacts.uri })
      .from(sandboxArtifacts)
      .where(inArray(sandboxArtifacts.sandboxRunId, uniqueSandboxRunIds))
      .orderBy(asc(sandboxArtifacts.createdAt), asc(sandboxArtifacts.sandboxArtifactId));
  }

  /** Deletes sandbox runs and lets child artifact and policy rows cascade. */
  public async deleteSandboxRuns(sandboxRunIds: readonly string[]): Promise<void> {
    const uniqueSandboxRunIds = uniqueStableStrings(sandboxRunIds);
    if (uniqueSandboxRunIds.length === 0) {
      return;
    }

    await this.db.delete(sandboxRuns).where(inArray(sandboxRuns.sandboxRunId, uniqueSandboxRunIds));
  }
}

/** Validates a bounded sandbox cleanup batch size. */
function sandboxCleanupLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 100;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Sandbox cleanup list limit must be an integer between 1 and 1000.");
  }

  return limit;
}

/** Returns a bounded sandbox run inspection limit. */
function sandboxInspectionLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 25;
  }

  return Math.min(100, Math.max(1, limit));
}

/** Returns stable unique string values while preserving caller order. */
function uniqueStableStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Builds the mutable update payload for sandbox run upsert conflicts. */
function sandboxRunUpdateFromInsert(run: SandboxRunInsert): Partial<SandboxRunInsert> {
  return {
    category: run.category,
    commandJson: run.commandJson,
    errorJson: run.errorJson,
    exitCode: run.exitCode,
    finishedAt: run.finishedAt,
    image: run.image,
    imageDigest: run.imageDigest,
    limitsJson: run.limitsJson,
    policyJson: run.policyJson,
    resourceUsageJson: run.resourceUsageJson,
    reviewRunId: run.reviewRunId,
    runnerKind: run.runnerKind,
    signal: run.signal,
    startedAt: run.startedAt,
    staticAnalysisRunId: run.staticAnalysisRunId,
    status: run.status,
    stderrHash: run.stderrHash,
    stderrTruncated: run.stderrTruncated,
    stdoutHash: run.stdoutHash,
    stdoutTruncated: run.stdoutTruncated,
    toolRunId: run.toolRunId,
    trustLevel: run.trustLevel,
    updatedAt: run.updatedAt,
    warningsJson: run.warningsJson,
  };
}
