import type { HeimdallDatabase } from "../client";
import { adminActions, debugExports, replayRuns, replayStageRuns } from "../schema";

/** Database surface required by admin debug repository methods. */
type AdminDebugRepositoryDatabase = Pick<HeimdallDatabase, "insert">;

/** Input used to record one privileged admin action. */
export type RecordAdminActionInput = {
  /** Stable admin action row ID. */
  readonly adminActionId: string;
  /** Admin action kind. */
  readonly kind: string;
  /** Admin action lifecycle status. */
  readonly status: string;
  /** Actor category that performed the action. */
  readonly actorType: string;
  /** Stable actor user or token ID. */
  readonly actorUserId: string;
  /** Organization scope when known. */
  readonly orgId?: string | null | undefined;
  /** Repository scope when known. */
  readonly repoId?: string | null | undefined;
  /** Review-run scope when known. */
  readonly reviewRunId?: string | null | undefined;
  /** Support-session ID when support access authorized the action. */
  readonly supportSessionId?: string | null | undefined;
  /** Human-readable reason for the action. */
  readonly reason: string;
  /** Product-safe request summary. */
  readonly request: unknown;
  /** Product-safe result summary when the action completed. */
  readonly result?: unknown;
  /** Product-safe error summary when the action failed. */
  readonly error?: unknown;
  /** Action start timestamp. */
  readonly startedAt?: Date | null | undefined;
  /** Action completion timestamp. */
  readonly completedAt?: Date | null | undefined;
};

/** Input used to record one debug export row. */
export type RecordDebugExportInput = {
  /** Stable debug export row ID. */
  readonly debugExportId: string;
  /** Admin action that authorized the export. */
  readonly adminActionId: string;
  /** Organization that owns the export. */
  readonly orgId: string;
  /** Repository scope when known. */
  readonly repoId?: string | null | undefined;
  /** Review-run scope when known. */
  readonly reviewRunId?: string | null | undefined;
  /** Debug export kind. */
  readonly exportKind: string;
  /** Durable artifact URI when the export is stored externally. */
  readonly artifactUri?: string | null | undefined;
  /** Hash of the exported artifact payload. */
  readonly artifactHash?: string | null | undefined;
  /** Redaction level applied to the export. */
  readonly redactionLevel: string;
  /** Export lifecycle status. */
  readonly status: string;
  /** Export expiration timestamp. */
  readonly expiresAt: Date;
  /** Actor category that created the export. */
  readonly createdByActorType: string;
  /** Stable actor user or token ID that created the export. */
  readonly createdByActorUserId: string;
  /** Export completion timestamp. */
  readonly completedAt?: Date | null | undefined;
  /** Product-safe error summary when the export failed. */
  readonly error?: unknown;
};

/** Product-safe replay stage summary stored on a replay run row. */
export type ReplayStageSummaryInput = {
  /** Replay stage name. */
  readonly stage: string;
  /** Durable queue name used for the replay job. */
  readonly queueName: string;
  /** Handler type used for the replay job. */
  readonly jobType: string;
  /** Replay source category. */
  readonly source: string;
  /** Durable replay job idempotency key. */
  readonly replayJobKey: string;
};

/** Input used to record one replay run row. */
export type RecordReplayRunInput = {
  /** Stable replay run row ID. */
  readonly replayRunId: string;
  /** Admin action that authorized the replay. */
  readonly adminActionId: string;
  /** Source review run when the replay is scoped to one review. */
  readonly sourceReviewRunId?: string | null | undefined;
  /** Organization scope when known. */
  readonly orgId?: string | null | undefined;
  /** Repository scope when known. */
  readonly repoId?: string | null | undefined;
  /** Replay execution mode. */
  readonly mode: string;
  /** Product-safe replay stage summaries. */
  readonly stages?: readonly ReplayStageSummaryInput[] | undefined;
  /** Product-safe replay configuration overrides. */
  readonly configOverrides?: Readonly<Record<string, unknown>> | undefined;
  /** Replay lifecycle status. */
  readonly status: string;
  /** Actor category that created the replay. */
  readonly createdByActorType: string;
  /** Stable actor user or token ID that created the replay. */
  readonly createdByActorUserId: string;
  /** Support-session ID when support access authorized the replay. */
  readonly supportSessionId?: string | null | undefined;
  /** Human-readable reason for the replay. */
  readonly reason: string;
  /** Product-safe replay result summary when complete. */
  readonly result?: unknown;
  /** Product-safe replay error summary when failed. */
  readonly error?: unknown;
  /** Replay start timestamp. */
  readonly startedAt?: Date | null | undefined;
  /** Replay completion timestamp. */
  readonly completedAt?: Date | null | undefined;
};

/** Input used to record one replay stage run row. */
export type RecordReplayStageRunInput = {
  /** Stable replay stage run row ID. */
  readonly replayStageRunId: string;
  /** Replay run that owns this stage. */
  readonly replayRunId: string;
  /** Replay stage name. */
  readonly stage: string;
  /** Replay stage lifecycle status. */
  readonly status: string;
  /** Product-safe input artifact reference. */
  readonly inputArtifactRef?: unknown;
  /** Product-safe output artifact reference. */
  readonly outputArtifactRef?: unknown;
  /** Product-safe stage metrics. */
  readonly metrics?: Readonly<Record<string, unknown>> | undefined;
  /** Product-safe stage error summary. */
  readonly error?: unknown;
  /** Stage start timestamp. */
  readonly startedAt?: Date | null | undefined;
  /** Stage completion timestamp. */
  readonly completedAt?: Date | null | undefined;
};

/** Repository for durable admin debug action and replay history writes. */
export class AdminDebugRepository {
  /** Database handle used by repository methods. */
  private readonly db: AdminDebugRepositoryDatabase;

  /** Creates a repository backed by a Drizzle database or transaction. */
  public constructor(db: AdminDebugRepositoryDatabase) {
    this.db = db;
  }

  /** Records one privileged admin action. */
  public async recordAdminAction(input: RecordAdminActionInput): Promise<void> {
    await this.db.insert(adminActions).values({
      adminActionId: input.adminActionId,
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      completedAt: input.completedAt,
      error: input.error,
      kind: input.kind,
      orgId: input.orgId,
      reason: input.reason,
      repoId: input.repoId,
      request: input.request,
      result: input.result,
      reviewRunId: input.reviewRunId,
      startedAt: input.startedAt,
      status: input.status,
      supportSessionId: input.supportSessionId,
    });
  }

  /** Records one durable debug export. */
  public async recordDebugExport(input: RecordDebugExportInput): Promise<void> {
    await this.db.insert(debugExports).values({
      adminActionId: input.adminActionId,
      artifactHash: input.artifactHash,
      artifactUri: input.artifactUri,
      completedAt: input.completedAt,
      createdByActorType: input.createdByActorType,
      createdByActorUserId: input.createdByActorUserId,
      debugExportId: input.debugExportId,
      error: input.error,
      expiresAt: input.expiresAt,
      exportKind: input.exportKind,
      orgId: input.orgId,
      redactionLevel: input.redactionLevel,
      repoId: input.repoId,
      reviewRunId: input.reviewRunId,
      status: input.status,
    });
  }

  /** Records one durable replay run. */
  public async recordReplayRun(input: RecordReplayRunInput): Promise<void> {
    await this.db.insert(replayRuns).values({
      replayRunId: input.replayRunId,
      adminActionId: input.adminActionId,
      completedAt: input.completedAt,
      configOverrides: input.configOverrides ?? {},
      createdByActorType: input.createdByActorType,
      createdByActorUserId: input.createdByActorUserId,
      error: input.error,
      mode: input.mode,
      orgId: input.orgId,
      reason: input.reason,
      repoId: input.repoId,
      result: input.result,
      sourceReviewRunId: input.sourceReviewRunId,
      stages: input.stages ?? [],
      startedAt: input.startedAt,
      status: input.status,
      supportSessionId: input.supportSessionId,
    });
  }

  /** Records replay stage rows in a single batch when any stages exist. */
  public async recordReplayStageRuns(input: readonly RecordReplayStageRunInput[]): Promise<void> {
    if (input.length === 0) {
      return;
    }

    await this.db.insert(replayStageRuns).values(
      input.map((stageRun) => ({
        replayStageRunId: stageRun.replayStageRunId,
        replayRunId: stageRun.replayRunId,
        completedAt: stageRun.completedAt,
        error: stageRun.error,
        inputArtifactRef: stageRun.inputArtifactRef,
        metrics: stageRun.metrics ?? {},
        outputArtifactRef: stageRun.outputArtifactRef,
        stage: stageRun.stage,
        startedAt: stageRun.startedAt,
        status: stageRun.status,
      })),
    );
  }
}
