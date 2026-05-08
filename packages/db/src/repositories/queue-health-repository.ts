import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { queueHealthSnapshots } from "../schema";

/** Database surface required by queue health repository methods. */
type QueueHealthRepositoryDatabase = Pick<HeimdallDatabase, "insert" | "select">;

/** One queue health snapshot ready to persist. */
export type QueueHealthSnapshotInput = {
  /** Logical queue name sampled from the worker runtime. */
  readonly queueName: string;
  /** Number of jobs currently waiting. */
  readonly waitingCount: number;
  /** Number of delayed jobs currently scheduled. */
  readonly delayedCount: number;
  /** Number of active jobs currently running. */
  readonly activeCount: number;
  /** Number of completed jobs retained by the queue backend. */
  readonly completedCount: number;
  /** Number of failed jobs retained by the queue backend. */
  readonly failedCount: number;
  /** Age of the oldest waiting or delayed job in milliseconds. */
  readonly oldestWaitingAgeMs: number;
  /** Time when the queue backend was sampled. */
  readonly sampledAt: Date;
};

/** Input used to persist one or more queue health snapshots. */
export type RecordQueueHealthSnapshotsInput = {
  /** Queue health snapshots to append. */
  readonly snapshots: readonly QueueHealthSnapshotInput[];
};

/** Input used to list recent queue health snapshots. */
export type ListRecentQueueHealthSnapshotsInput = {
  /** Optional queue name filter. */
  readonly queueName?: string | undefined;
  /** Maximum number of rows to return. */
  readonly limit?: number | undefined;
};

/** Durable queue health snapshot row used by operational views. */
export type QueueHealthSnapshotRecord = QueueHealthSnapshotInput & {
  /** Durable queue health snapshot row ID. */
  readonly queueHealthSnapshotId: string;
  /** Row creation timestamp. */
  readonly createdAt: Date;
  /** Row update timestamp. */
  readonly updatedAt: Date;
};

const defaultQueueHealthSnapshotLimit = 100;
const maxQueueHealthSnapshotLimit = 500;

/** Query helper for persisted queue health snapshots. */
export class QueueHealthRepository {
  /** Creates a queue health query helper. */
  public constructor(private readonly db: QueueHealthRepositoryDatabase) {}

  /** Appends queue health snapshots for dashboard and admin inspection. */
  public async recordQueueHealthSnapshots(
    input: RecordQueueHealthSnapshotsInput,
  ): Promise<readonly QueueHealthSnapshotRecord[]> {
    if (input.snapshots.length === 0) {
      return [];
    }

    const now = new Date();
    const rows = await this.db
      .insert(queueHealthSnapshots)
      .values(
        input.snapshots.map((snapshot) => ({
          activeCount: normalizeQueueMetricCount(snapshot.activeCount),
          completedCount: normalizeQueueMetricCount(snapshot.completedCount),
          createdAt: now,
          delayedCount: normalizeQueueMetricCount(snapshot.delayedCount),
          failedCount: normalizeQueueMetricCount(snapshot.failedCount),
          oldestWaitingAgeMs: normalizeQueueMetricCount(snapshot.oldestWaitingAgeMs),
          queueHealthSnapshotId: randomUUID(),
          queueName: snapshot.queueName,
          sampledAt: snapshot.sampledAt,
          updatedAt: now,
          waitingCount: normalizeQueueMetricCount(snapshot.waitingCount),
        })),
      )
      .returning();

    return rows.map(toQueueHealthSnapshotRecord);
  }

  /** Lists recent queue health snapshots with newest samples first. */
  public async listRecentQueueHealthSnapshots(
    input: ListRecentQueueHealthSnapshotsInput = {},
  ): Promise<readonly QueueHealthSnapshotRecord[]> {
    const limit = normalizeQueueHealthSnapshotLimit(input.limit);

    const rows = input.queueName
      ? await this.db
          .select()
          .from(queueHealthSnapshots)
          .where(eq(queueHealthSnapshots.queueName, input.queueName))
          .orderBy(desc(queueHealthSnapshots.sampledAt), desc(queueHealthSnapshots.createdAt))
          .limit(limit)
      : await this.db
          .select()
          .from(queueHealthSnapshots)
          .orderBy(desc(queueHealthSnapshots.sampledAt), desc(queueHealthSnapshots.createdAt))
          .limit(limit);

    return rows.map(toQueueHealthSnapshotRecord);
  }
}

/** Normalizes queue metric counts before writing durable snapshots. */
function normalizeQueueMetricCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Normalizes list limits to a bounded positive integer. */
function normalizeQueueHealthSnapshotLimit(limit: number | undefined): number {
  const requestedLimit =
    limit === undefined || !Number.isFinite(limit) || limit <= 0
      ? defaultQueueHealthSnapshotLimit
      : Math.trunc(limit);

  return Math.min(maxQueueHealthSnapshotLimit, Math.max(1, requestedLimit));
}

/** Maps a queue health snapshot row to the repository contract. */
function toQueueHealthSnapshotRecord(
  row: typeof queueHealthSnapshots.$inferSelect,
): QueueHealthSnapshotRecord {
  return {
    activeCount: row.activeCount,
    completedCount: row.completedCount,
    createdAt: row.createdAt,
    delayedCount: row.delayedCount,
    failedCount: row.failedCount,
    oldestWaitingAgeMs: row.oldestWaitingAgeMs,
    queueHealthSnapshotId: row.queueHealthSnapshotId,
    queueName: row.queueName,
    sampledAt: row.sampledAt,
    updatedAt: row.updatedAt,
    waitingCount: row.waitingCount,
  };
}
