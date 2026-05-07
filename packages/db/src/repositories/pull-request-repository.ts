import type { PullRequestSnapshot } from "@repo/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { pullRequestSnapshots } from "../schema";
import { toPullRequestSnapshot } from "./row-mappers";

/** Query helper for immutable pull request snapshots. */
export class PullRequestRepository {
  /** Creates a pull request snapshot query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

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
}
