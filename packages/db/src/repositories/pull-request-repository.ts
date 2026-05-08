import type { PullRequestSnapshot } from "@repo/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { pullRequestSnapshots, pullRequests } from "../schema";
import { toPullRequestSnapshot } from "./row-mappers";

/** Mutable pull request state stored from the latest provider snapshot. */
export type PullRequestRecord = {
  /** Durable pull request ID. */
  readonly pullRequestId: string;
  /** Repository that owns the pull request. */
  readonly repoId: string;
  /** Source code provider. */
  readonly provider: PullRequestSnapshot["provider"];
  /** Provider-native pull request ID. */
  readonly providerPullRequestId: string;
  /** Provider-visible pull request number. */
  readonly pullRequestNumber: number;
  /** Latest pull request title. */
  readonly title: string;
  /** Provider login that authored the pull request. */
  readonly authorLogin: string;
  /** Latest provider pull request state. */
  readonly state: PullRequestSnapshot["state"];
  /** Whether the pull request is currently a draft. */
  readonly isDraft: boolean;
  /** Base branch name. */
  readonly baseRef: string;
  /** Base commit SHA. */
  readonly baseSha: string;
  /** Head branch name. */
  readonly headRef: string;
  /** Head commit SHA. */
  readonly headSha: string;
  /** Latest immutable snapshot ID for the pull request. */
  readonly latestSnapshotId?: string | undefined;
  /** Provider-specific metadata captured with the latest snapshot. */
  readonly metadata?: Record<string, unknown> | undefined;
  /** Creation timestamp. */
  readonly createdAt: string;
  /** Last update timestamp. */
  readonly updatedAt: string;
};

/** Input for inserting or refreshing a mutable pull request row. */
export type UpsertPullRequestInput = {
  /** Durable pull request ID to use when inserting a new row. */
  readonly pullRequestId: string;
  /** Immutable snapshot that provides the latest mutable PR state. */
  readonly snapshot: PullRequestSnapshot;
  /** Observation time to use for inserted or updated mutable state. */
  readonly observedAt?: string | undefined;
};

/** Query helper for immutable pull request snapshots and mutable pull request state. */
export class PullRequestRepository {
  /** Creates a pull request query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Inserts a snapshot and upserts the mutable pull request row that points at it. */
  public async upsertPullRequest(input: UpsertPullRequestInput): Promise<PullRequestRecord> {
    const snapshot = await this.insertSnapshot(input.snapshot);
    const observedAt = input.observedAt ? new Date(input.observedAt) : new Date();
    const [row] = await this.db
      .insert(pullRequests)
      .values({
        pullRequestId: input.pullRequestId,
        repoId: snapshot.repoId,
        provider: snapshot.provider,
        providerPullRequestId: snapshot.providerPullRequestId,
        pullRequestNumber: snapshot.pullRequestNumber,
        title: snapshot.title,
        authorLogin: snapshot.authorLogin,
        state: snapshot.state,
        isDraft: snapshot.isDraft,
        baseRef: snapshot.baseRef,
        baseSha: snapshot.baseSha,
        headRef: snapshot.headRef,
        headSha: snapshot.headSha,
        latestSnapshotId: snapshot.snapshotId,
        metadata: snapshot.providerMetadata,
        createdAt: observedAt,
        updatedAt: observedAt,
      })
      .onConflictDoUpdate({
        target: [pullRequests.repoId, pullRequests.pullRequestNumber],
        set: {
          title: snapshot.title,
          authorLogin: snapshot.authorLogin,
          state: snapshot.state,
          isDraft: snapshot.isDraft,
          baseRef: snapshot.baseRef,
          baseSha: snapshot.baseSha,
          headRef: snapshot.headRef,
          headSha: snapshot.headSha,
          latestSnapshotId: snapshot.snapshotId,
          metadata: snapshot.providerMetadata,
          updatedAt: observedAt,
        },
      })
      .returning();

    return row
      ? toPullRequestRecord(row)
      : this.getRequiredPullRequest(snapshot.repoId, snapshot.pullRequestNumber);
  }

  /** Inserts or refreshes a pull request snapshot row for the same provider snapshot ID. */
  public async insertSnapshot(snapshot: PullRequestSnapshot): Promise<PullRequestSnapshot> {
    const [row] = await this.db
      .insert(pullRequestSnapshots)
      .values({
        ...snapshot,
        fetchedAt: new Date(snapshot.fetchedAt),
      })
      .onConflictDoUpdate({
        target: pullRequestSnapshots.snapshotId,
        set: {
          title: snapshot.title,
          body: snapshot.body,
          authorLogin: snapshot.authorLogin,
          authorAssociation: snapshot.authorAssociation,
          state: snapshot.state,
          isDraft: snapshot.isDraft,
          labels: snapshot.labels,
          baseRef: snapshot.baseRef,
          baseSha: snapshot.baseSha,
          headRef: snapshot.headRef,
          headSha: snapshot.headSha,
          mergeBaseSha: snapshot.mergeBaseSha,
          changedFiles: snapshot.changedFiles,
          diffHash: snapshot.diffHash,
          additions: snapshot.additions,
          deletions: snapshot.deletions,
          changedFileCount: snapshot.changedFileCount,
          fetchedAt: new Date(snapshot.fetchedAt),
          providerMetadata: snapshot.providerMetadata,
        },
      })
      .returning();

    return row ? toPullRequestSnapshot(row) : snapshot;
  }

  /** Gets the latest snapshot for a repository pull request number. */
  public async getLatestSnapshot(
    repoId: string,
    pullRequestNumber: number,
  ): Promise<PullRequestSnapshot | undefined> {
    const [row] = await this.db
      .select()
      .from(pullRequestSnapshots)
      .where(
        and(
          eq(pullRequestSnapshots.repoId, repoId),
          eq(pullRequestSnapshots.pullRequestNumber, pullRequestNumber),
        ),
      )
      .orderBy(desc(pullRequestSnapshots.fetchedAt))
      .limit(1);

    return row ? toPullRequestSnapshot(row) : undefined;
  }

  /** Gets one immutable pull request snapshot by its durable snapshot ID. */
  public async getSnapshot(snapshotId: string): Promise<PullRequestSnapshot | undefined> {
    const [row] = await this.db
      .select()
      .from(pullRequestSnapshots)
      .where(eq(pullRequestSnapshots.snapshotId, snapshotId))
      .limit(1);

    return row ? toPullRequestSnapshot(row) : undefined;
  }

  /** Gets the mutable pull request row for a repository pull request number. */
  public async getPullRequest(
    repoId: string,
    pullRequestNumber: number,
  ): Promise<PullRequestRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(pullRequests)
      .where(
        and(eq(pullRequests.repoId, repoId), eq(pullRequests.pullRequestNumber, pullRequestNumber)),
      )
      .limit(1);

    return row ? toPullRequestRecord(row) : undefined;
  }

  /** Gets the mutable pull request row by provider-native pull request ID. */
  public async getPullRequestByProviderId(input: {
    /** Source code provider. */
    readonly provider: PullRequestSnapshot["provider"];
    /** Provider-native pull request ID. */
    readonly providerPullRequestId: string;
  }): Promise<PullRequestRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.provider, input.provider),
          eq(pullRequests.providerPullRequestId, input.providerPullRequestId),
        ),
      )
      .limit(1);

    return row ? toPullRequestRecord(row) : undefined;
  }

  /** Gets a pull request after an upsert and throws if the row is unexpectedly missing. */
  private async getRequiredPullRequest(
    repoId: string,
    pullRequestNumber: number,
  ): Promise<PullRequestRecord> {
    const row = await this.getPullRequest(repoId, pullRequestNumber);
    if (!row) {
      throw new Error(`Pull request was not returned after upsert: ${repoId}#${pullRequestNumber}`);
    }
    return row;
  }
}

/** Converts a date to an ISO 8601 timestamp. */
const toIso = (value: Date): string => value.toISOString();

/** Returns an object record only when the value is a non-array object. */
const optionalRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Converts a nullable string to an optional string. */
const optionalString = (value: string | null): string | undefined => value ?? undefined;

/** Adds an optional key/value pair to an object when the value is present. */
const withOptional = <T extends object, K extends string, V>(
  key: K,
  value: V | undefined,
): T | Record<K, V> => (value === undefined ? ({} as T) : ({ [key]: value } as Record<K, V>));

/** Converts a mutable pull request row to the repository boundary type. */
const toPullRequestRecord = (row: {
  pullRequestId: string;
  repoId: string;
  provider: string;
  providerPullRequestId: string;
  pullRequestNumber: number;
  title: string;
  authorLogin: string;
  state: string;
  isDraft: boolean;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  latestSnapshotId: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): PullRequestRecord => ({
  pullRequestId: row.pullRequestId,
  repoId: row.repoId,
  provider: row.provider as PullRequestRecord["provider"],
  providerPullRequestId: row.providerPullRequestId,
  pullRequestNumber: row.pullRequestNumber,
  title: row.title,
  authorLogin: row.authorLogin,
  state: row.state as PullRequestRecord["state"],
  isDraft: row.isDraft,
  baseRef: row.baseRef,
  baseSha: row.baseSha,
  headRef: row.headRef,
  headSha: row.headSha,
  ...withOptional("latestSnapshotId", optionalString(row.latestSnapshotId)),
  ...withOptional("metadata", optionalRecord(row.metadata)),
  createdAt: toIso(row.createdAt),
  updatedAt: toIso(row.updatedAt),
});
