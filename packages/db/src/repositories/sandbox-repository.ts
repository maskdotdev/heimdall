import { and, asc, eq, inArray, lt } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { sandboxArtifacts, sandboxRuns } from "../schema";

/** Database surface required by sandbox repository methods. */
type SandboxRepositoryDatabase = Pick<HeimdallDatabase, "delete" | "select">;

/** Input used to list old sandbox runs for retention cleanup. */
export type ListSandboxRunCleanupTargetsInput = {
  /** Exclusive sandbox run creation cutoff. */
  readonly cutoff: Date;
  /** Maximum number of sandbox runs to return. */
  readonly limit?: number | undefined;
  /** Optional repository scope for the cleanup pass. */
  readonly repoId?: string | undefined;
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
  public constructor(private readonly db: SandboxRepositoryDatabase) {}

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

/** Returns stable unique string values while preserving caller order. */
function uniqueStableStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
