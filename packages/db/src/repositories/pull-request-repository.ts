import type { PullRequestSnapshot } from "@repo/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { pullRequestSnapshots } from "../schema";
import { toPullRequestSnapshot } from "./row-mappers";

/** Query helper for immutable pull request snapshots. */
export class PullRequestRepository {
  /** Creates a pull request snapshot query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Inserts a pull request snapshot and preserves immutable existing rows. */
  public async insertSnapshot(snapshot: PullRequestSnapshot): Promise<PullRequestSnapshot> {
    const [row] = await this.db
      .insert(pullRequestSnapshots)
      .values({
        ...snapshot,
        fetchedAt: new Date(snapshot.fetchedAt),
      })
      .onConflictDoNothing()
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
}
