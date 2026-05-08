import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { QueueHealthRepository } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("QueueHealthRepository integration", () => {
  const schemaName = `heimdall_queue_health_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const queueHealthRepository = new QueueHealthRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("records and lists recent queue health snapshots", async () => {
    const olderSampledAt = new Date("2026-05-08T12:00:00.000Z");
    const newerSampledAt = new Date("2026-05-08T12:01:00.000Z");

    await expect(
      queueHealthRepository.recordQueueHealthSnapshots({
        snapshots: [
          {
            activeCount: 1,
            completedCount: 8,
            delayedCount: 2,
            failedCount: 3,
            oldestWaitingAgeMs: 5_000,
            queueName: "review",
            sampledAt: olderSampledAt,
            waitingCount: 4,
          },
          {
            activeCount: 0,
            completedCount: 9,
            delayedCount: 0,
            failedCount: 1,
            oldestWaitingAgeMs: 0,
            queueName: "review",
            sampledAt: newerSampledAt,
            waitingCount: 0,
          },
          {
            activeCount: 2,
            completedCount: 5,
            delayedCount: 1,
            failedCount: 0,
            oldestWaitingAgeMs: 2_500,
            queueName: "indexing",
            sampledAt: newerSampledAt,
            waitingCount: 7,
          },
        ],
      }),
    ).resolves.toHaveLength(3);

    await expect(
      queueHealthRepository.listRecentQueueHealthSnapshots({ queueName: "review", limit: 2 }),
    ).resolves.toEqual([
      expect.objectContaining({
        activeCount: 0,
        completedCount: 9,
        failedCount: 1,
        oldestWaitingAgeMs: 0,
        queueName: "review",
        sampledAt: newerSampledAt,
        waitingCount: 0,
      }),
      expect.objectContaining({
        activeCount: 1,
        completedCount: 8,
        delayedCount: 2,
        failedCount: 3,
        oldestWaitingAgeMs: 5_000,
        queueName: "review",
        sampledAt: olderSampledAt,
        waitingCount: 4,
      }),
    ]);
    await expect(
      queueHealthRepository.listRecentQueueHealthSnapshots({ limit: 2 }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ queueName: "review", sampledAt: newerSampledAt }),
        expect.objectContaining({ queueName: "indexing", sampledAt: newerSampledAt }),
      ]),
    );
  });

  it("normalizes invalid counts before persisting snapshots", async () => {
    const sampledAt = new Date("2026-05-08T12:02:00.000Z");

    await queueHealthRepository.recordQueueHealthSnapshots({
      snapshots: [
        {
          activeCount: Number.POSITIVE_INFINITY,
          completedCount: 1.9,
          delayedCount: -1,
          failedCount: Number.NaN,
          oldestWaitingAgeMs: 123.9,
          queueName: "publishing",
          sampledAt,
          waitingCount: -10,
        },
      ],
    });

    await expect(
      queueHealthRepository.listRecentQueueHealthSnapshots({
        limit: 1,
        queueName: "publishing",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        activeCount: 0,
        completedCount: 1,
        delayedCount: 0,
        failedCount: 0,
        oldestWaitingAgeMs: 123,
        waitingCount: 0,
      }),
    ]);
  });
});

/** Applies all generated SQL migrations in lexical order to a test schema. */
async function applyMigrations(sql: postgres.Sql, schemaName: string): Promise<void> {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  for (const file of files) {
    await sql.unsafe(
      (await readFile(resolve(migrationsDirectory, file), "utf8")).replaceAll(
        '"public".',
        `${quoteIdentifier(schemaName)}.`,
      ),
    );
  }
}

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
