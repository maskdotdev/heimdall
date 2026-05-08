import type { CodeIndexVersion } from "@repo/contracts";
import { eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { codeIndexVersions } from "../schema";
import { toCodeIndexVersion } from "./row-mappers";

const requireReturnedRow = <T>(row: T | undefined): T => {
  if (!row) {
    throw new Error("Database write did not return a row.");
  }

  return row;
};

const indexKeyFor = (indexVersion: CodeIndexVersion): string =>
  [indexVersion.indexerName, indexVersion.indexerVersion, indexVersion.chunkerVersion].join(":");

/** Query helper for code index version metadata. */
export class IndexVersionRepository {
  /** Creates an index version query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Inserts an index version or updates its status for the same repo commit. */
  public async upsertIndexVersion(indexVersion: CodeIndexVersion): Promise<CodeIndexVersion> {
    const [row] = await this.db
      .insert(codeIndexVersions)
      .values({
        ...indexVersion,
        indexKey: indexKeyFor(indexVersion),
        createdAt: new Date(indexVersion.createdAt),
        completedAt: indexVersion.completedAt ? new Date(indexVersion.completedAt) : undefined,
      })
      .onConflictDoUpdate({
        target: [
          codeIndexVersions.repoId,
          codeIndexVersions.commitSha,
          codeIndexVersions.indexKey,
          codeIndexVersions.artifactHash,
        ],
        set: {
          status: indexVersion.status,
          artifactUri: indexVersion.artifactUri,
          artifactHash: indexVersion.artifactHash,
          fileCount: indexVersion.fileCount,
          symbolCount: indexVersion.symbolCount,
          edgeCount: indexVersion.edgeCount,
          chunkCount: indexVersion.chunkCount,
          embeddedChunkCount: indexVersion.embeddedChunkCount,
          completedAt: indexVersion.completedAt ? new Date(indexVersion.completedAt) : undefined,
          error: indexVersion.error,
        },
      })
      .returning();

    return toCodeIndexVersion(requireReturnedRow(row));
  }

  /** Gets an index version by ID. */
  public async getIndexVersion(indexVersionId: string): Promise<CodeIndexVersion | undefined> {
    const [row] = await this.db
      .select()
      .from(codeIndexVersions)
      .where(eq(codeIndexVersions.indexVersionId, indexVersionId));

    return row ? toCodeIndexVersion(row) : undefined;
  }
}
