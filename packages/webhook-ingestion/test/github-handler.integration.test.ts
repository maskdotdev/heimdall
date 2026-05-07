import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@repo/db";
import { computeGitHubWebhookSignature } from "@repo/github";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { GitHubWebhookHandler } from "../src";
import { pullRequestPayload } from "./fixtures";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../../db/bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../../db/migrations");

describe.runIf(integrationDatabaseUrl)("GitHub webhook handler integration", () => {
  const schemaName = `heimdall_webhook_${process.pid}_${Date.now()}`.replace(/[^A-Za-z0-9_]/g, "_");
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1 });
  const db = drizzle(sql, { schema });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await sql.end();
  });

  it("persists a pull_request delivery and plans pending idempotent jobs", async () => {
    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await sql.unsafe(`SET search_path TO "${schemaName}", public`);
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await applyMigrations(sql, schemaName);

    const rawBody = new TextEncoder().encode(JSON.stringify(pullRequestPayload));
    const signature = computeGitHubWebhookSignature("secret", rawBody);
    const handler = new GitHubWebhookHandler({
      db,
      webhookSecret: "secret",
    });

    const result = await handler.handle({
      headers: new Headers({
        "x-github-delivery": "delivery-pr-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature,
      }),
      rawBody,
    });

    expect(result.status).toBe("accepted");
    expect(result.jobs).toHaveLength(2);

    const [counts] = await sql`
      SELECT
        (SELECT count(*)::int FROM webhook_events) AS webhook_events,
        (SELECT count(*)::int FROM provider_installations) AS installations,
        (SELECT count(*)::int FROM repositories) AS repositories,
        (SELECT count(*)::int FROM repository_settings) AS repository_settings,
        (SELECT count(*)::int FROM pull_requests) AS pull_requests,
        (SELECT count(*)::int FROM pull_request_snapshots) AS pull_request_snapshots,
        (SELECT count(*)::int FROM background_jobs) AS background_jobs
    `;

    expect(counts).toEqual({
      webhook_events: 1,
      installations: 1,
      repositories: 1,
      repository_settings: 1,
      pull_requests: 1,
      pull_request_snapshots: 1,
      background_jobs: 2,
    });

    const duplicate = await handler.handle({
      headers: new Headers({
        "x-github-delivery": "delivery-pr-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature,
      }),
      rawBody,
    });

    expect(duplicate.status).toBe("duplicate");

    const [jobStatuses] = await sql`
      SELECT array_agg(status ORDER BY job_type) AS statuses
      FROM background_jobs
    `;

    expect(jobStatuses).toEqual({ statuses: ["pending", "pending"] });
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
        `"${schemaName}".`,
      ),
    );
  }
}
