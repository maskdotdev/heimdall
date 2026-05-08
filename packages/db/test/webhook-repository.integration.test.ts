import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { WebhookRepository } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("WebhookRepository integration", () => {
  const schemaName = `heimdall_webhook_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const webhookRepository = new WebhookRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await seedWebhookParents(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("inserts deliveries idempotently and applies status transitions", async () => {
    const inserted = await webhookRepository.insertWebhookEvent({
      webhookEventId: "webhook_repository_delivery",
      provider: "github",
      deliveryId: "delivery-webhook-repository",
      eventName: "pull_request",
      action: "opened",
      installationId: "inst_webhook_repository_test",
      orgId: "org_webhook_repository_test",
      repoId: "repo_webhook_repository_test",
      payloadHash: `sha256:${"a".repeat(64)}`,
      payload: { action: "opened" },
      status: "received",
      receivedAt: "2026-05-08T00:00:00.000Z",
      metadata: { secretVersion: "current" },
    });
    expect(inserted).toMatchObject({
      inserted: true,
      event: {
        action: "opened",
        deliveryId: "delivery-webhook-repository",
        status: "received",
        webhookEventId: "webhook_repository_delivery",
      },
    });

    const duplicate = await webhookRepository.insertWebhookEvent({
      webhookEventId: "webhook_repository_delivery_duplicate",
      provider: "github",
      deliveryId: "delivery-webhook-repository",
      eventName: "pull_request",
      action: "closed",
      installationId: "inst_webhook_repository_test",
      orgId: "org_webhook_repository_test",
      repoId: "repo_webhook_repository_test",
      payloadHash: `sha256:${"b".repeat(64)}`,
      payload: { action: "closed" },
      status: "received",
      receivedAt: "2026-05-08T00:01:00.000Z",
    });
    expect(duplicate).toMatchObject({
      inserted: false,
      event: {
        action: "opened",
        payloadHash: `sha256:${"a".repeat(64)}`,
        webhookEventId: "webhook_repository_delivery",
      },
    });

    const processing = await webhookRepository.markWebhookProcessing("webhook_repository_delivery");
    expect(processing.status).toBe("processing");

    const processed = await webhookRepository.markWebhookProcessed(
      "webhook_repository_delivery",
      "2026-05-08T00:02:00.000Z",
    );
    expect(processed).toMatchObject({
      processedAt: "2026-05-08T00:02:00.000Z",
      status: "processed",
    });

    const failedInsert = await webhookRepository.insertWebhookEvent({
      webhookEventId: "webhook_repository_failed",
      provider: "github",
      deliveryId: "delivery-webhook-repository-failed",
      eventName: "push",
      installationId: "inst_webhook_repository_test",
      orgId: "org_webhook_repository_test",
      payloadHash: `sha256:${"c".repeat(64)}`,
      status: "received",
      receivedAt: "2026-05-08T00:03:00.000Z",
    });
    expect(failedInsert.inserted).toBe(true);

    const failed = await webhookRepository.markWebhookFailed({
      error: {
        code: "webhook.processing_failed",
        message: "Webhook payload could not be planned.",
        retryable: true,
      },
      processedAt: "2026-05-08T00:04:00.000Z",
      webhookEventId: "webhook_repository_failed",
    });
    expect(failed).toMatchObject({
      error: {
        code: "webhook.processing_failed",
        message: "Webhook payload could not be planned.",
        retryable: true,
      },
      status: "failed",
    });

    const fetched = await webhookRepository.getWebhookEventByDelivery({
      deliveryId: "delivery-webhook-repository",
      provider: "github",
    });
    expect(fetched?.webhookEventId).toBe("webhook_repository_delivery");
    await expect(
      webhookRepository.getWebhookEventRecord("webhook_repository_delivery"),
    ).resolves.toMatchObject({
      action: "opened",
      payload: { action: "opened" },
      status: "processed",
      webhookEventId: "webhook_repository_delivery",
    });

    await expect(webhookRepository.getWebhookActivitySummary()).resolves.toEqual({
      latest: {
        action: null,
        eventName: "push",
        receivedAt: new Date("2026-05-08T00:03:00.000Z"),
        status: "failed",
      },
      totalDeliveries: 2,
    });
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

/** Inserts parent rows required by webhook event foreign keys. */
async function seedWebhookParents(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES ('org_webhook_repository_test', 'Webhook Repository Test Org', 'webhook-repository-test-org')
  `;
  await sql`
    INSERT INTO provider_installations (
      installation_id,
      org_id,
      provider,
      provider_installation_id,
      account_login,
      account_type,
      installed_at
    )
    VALUES (
      'inst_webhook_repository_test',
      'org_webhook_repository_test',
      'github',
      'webhook-repository-test-installation',
      'acme',
      'organization',
      now()
    )
  `;
  await sql`
    INSERT INTO repositories (
      repo_id,
      org_id,
      installation_id,
      provider,
      provider_repo_id,
      owner,
      name,
      full_name,
      visibility
    )
    VALUES (
      'repo_webhook_repository_test',
      'org_webhook_repository_test',
      'inst_webhook_repository_test',
      'github',
      'webhook-repository-test-repo',
      'acme',
      'heimdall',
      'acme/heimdall',
      'private'
    )
  `;
}

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
