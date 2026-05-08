import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { BillingRepository } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("BillingRepository integration", () => {
  const schemaName = `heimdall_billing_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const billingRepository = new BillingRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await seedBillingParents(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("records provider requests idempotently and lists failed requests", async () => {
    await billingRepository.recordBillingProviderRequest({
      completedAt: "2026-05-08T00:01:01.000Z",
      idempotencyKey: "billing-request-same",
      operation: "billing.meterEvents.create",
      orgId: "org_billing_repository_test",
      provider: "stripe",
      providerRequestId: "req_initial",
      requestMetadata: { meterKey: "review.credit" },
      responseMetadata: { providerMeterEventId: "mtr_initial" },
      startedAt: "2026-05-08T00:01:00.000Z",
      status: "succeeded",
    });
    await billingRepository.recordBillingProviderRequest({
      completedAt: "2026-05-08T00:02:01.000Z",
      errorCode: "rate_limited",
      errorMessage: "Stripe request was rate limited.",
      idempotencyKey: "billing-request-same",
      operation: "billing.meterEvents.create",
      orgId: "org_billing_repository_test",
      provider: "stripe",
      providerRequestId: "req_retry",
      requestMetadata: { meterKey: "review.credit" },
      responseMetadata: {},
      startedAt: "2026-05-08T00:02:00.000Z",
      status: "failed",
    });
    await billingRepository.recordBillingProviderRequest({
      completedAt: "2026-05-08T00:03:01.000Z",
      errorCode: "timeout",
      errorMessage: "Stripe request timed out.",
      idempotencyKey: "billing-request-timeout",
      operation: "subscriptions.retrieve",
      orgId: "org_billing_repository_test",
      provider: "stripe",
      requestMetadata: { providerSubscriptionId: "sub_test" },
      responseMetadata: {},
      startedAt: "2026-05-08T00:03:00.000Z",
      status: "failed",
    });
    await billingRepository.recordBillingProviderRequest({
      completedAt: "2026-05-08T00:04:01.000Z",
      errorMessage: "Other org failure.",
      idempotencyKey: "billing-request-other-org",
      operation: "subscriptions.retrieve",
      orgId: "org_billing_repository_other",
      provider: "stripe",
      requestMetadata: {},
      responseMetadata: {},
      startedAt: "2026-05-08T00:04:00.000Z",
      status: "failed",
    });

    const [counts] = await sql`
      SELECT
        count(*)::int AS total_rows,
        count(*) FILTER (WHERE idempotency_key = 'billing-request-same')::int AS same_key_rows
      FROM billing_provider_requests
    `;
    expect(counts).toMatchObject({ same_key_rows: 1, total_rows: 3 });

    await expect(
      billingRepository.listFailedBillingProviderRequests({
        limit: 10,
        orgId: "org_billing_repository_test",
      }),
    ).resolves.toMatchObject([
      {
        errorMessage: "Stripe request timed out.",
        operation: "subscriptions.retrieve",
        provider: "stripe",
      },
      {
        errorMessage: "Stripe request was rate limited.",
        operation: "billing.meterEvents.create",
        provider: "stripe",
      },
    ]);
    await expect(
      billingRepository.listFailedBillingProviderRequests({
        limit: 1,
        orgId: "org_billing_repository_test",
      }),
    ).resolves.toHaveLength(1);
    await expect(
      billingRepository.listFailedBillingProviderRequests({
        limit: 0,
        orgId: "org_billing_repository_test",
      }),
    ).rejects.toThrow(/limit must be an integer/u);
  });

  it("lists billing meter events and reconciliation issue rows", async () => {
    await seedBillingInspectionRows(sql);

    await expect(
      billingRepository.listBillingMeterEvents({
        limit: 10,
        orgId: "org_billing_repository_test",
      }),
    ).resolves.toMatchObject([
      { billingMeterEventId: "bme_billing_repository_fresh", status: "ready_to_send" },
      { billingMeterEventId: "bme_billing_repository_sent", status: "sent" },
      { billingMeterEventId: "bme_billing_repository_failed", status: "failed" },
      { billingMeterEventId: "bme_billing_repository_stale", status: "ready_to_send" },
    ]);
    await expect(
      billingRepository.listBillingMeterEvents({
        limit: 10,
        orgId: "org_billing_repository_test",
        periodKey: "2026-05",
        status: "failed",
      }),
    ).resolves.toMatchObject([{ billingMeterEventId: "bme_billing_repository_failed" }]);

    await expect(
      billingRepository.listBillingMeterSyncIssueRows({
        lagCutoff: new Date("2026-05-08T00:03:00.000Z"),
        limit: 10,
        orgId: "org_billing_repository_test",
        periodKey: "2026-05",
      }),
    ).resolves.toMatchObject([
      { billingMeterEventId: "bme_billing_repository_failed", status: "failed" },
      { billingMeterEventId: "bme_billing_repository_stale", status: "ready_to_send" },
    ]);
    await expect(
      billingRepository.listBillingMeterSyncIssueRows({
        lagCutoff: new Date("2026-05-08T00:03:00.000Z"),
        limit: 0,
        orgId: "org_billing_repository_test",
      }),
    ).rejects.toThrow(/limit must be an integer/u);

    await expect(
      billingRepository.listFailedBillingWebhookEvents({
        limit: 10,
        orgId: "org_billing_repository_test",
      }),
    ).resolves.toMatchObject([
      {
        billingWebhookEventId: "bwh_billing_repository_failed_latest",
        eventType: "customer.subscription.updated",
      },
      {
        billingWebhookEventId: "bwh_billing_repository_failed_oldest",
        eventType: "invoice.payment_failed",
      },
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

/** Inserts organization parents for billing repository tests. */
async function seedBillingParents(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES
      ('org_billing_repository_test', 'Billing Repository Test Org', 'billing-repo-test-org'),
      ('org_billing_repository_other', 'Other Billing Repository Org', 'billing-repo-other-org')
  `;
  await sql`
    INSERT INTO billing_accounts (
      billing_account_id,
      org_id,
      billing_mode,
      status,
      provider,
      provider_customer_id
    )
    VALUES (
      'ba_billing_repository_test',
      'org_billing_repository_test',
      'self_serve',
      'active',
      'stripe',
      'cus_billing_repository_test'
    )
  `;
}

/** Inserts billing meter and webhook rows for inspection tests. */
async function seedBillingInspectionRows(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO billing_meter_events (
      billing_meter_event_id,
      billing_account_id,
      org_id,
      provider,
      provider_customer_id,
      meter_key,
      provider_event_name,
      period_key,
      period_start,
      period_end,
      quantity,
      idempotency_key,
      status,
      attempt_count,
      last_error_code,
      last_error_message,
      source_usage_event_ids,
      sent_at,
      created_at,
      updated_at
    )
    VALUES
      (
        'bme_billing_repository_stale',
        'ba_billing_repository_test',
        'org_billing_repository_test',
        'stripe',
        'cus_billing_repository_test',
        'review.credit',
        'heimdall.review_credit',
        '2026-05',
        '2026-05-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
        3,
        'bme-stale',
        'ready_to_send',
        0,
        null,
        null,
        '["use_billing_repository_stale"]'::jsonb,
        null,
        '2026-05-08T00:01:00.000Z',
        '2026-05-08T00:01:00.000Z'
      ),
      (
        'bme_billing_repository_failed',
        'ba_billing_repository_test',
        'org_billing_repository_test',
        'stripe',
        'cus_billing_repository_test',
        'review.credit',
        'heimdall.review_credit',
        '2026-05',
        '2026-05-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
        5,
        'bme-failed',
        'failed',
        2,
        'rate_limited',
        'Stripe rate limited the request.',
        '["use_billing_repository_failed"]'::jsonb,
        null,
        '2026-05-08T00:05:00.000Z',
        '2026-05-08T00:05:00.000Z'
      ),
      (
        'bme_billing_repository_sent',
        'ba_billing_repository_test',
        'org_billing_repository_test',
        'stripe',
        'cus_billing_repository_test',
        'review.credit',
        'heimdall.review_credit',
        '2026-05',
        '2026-05-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
        7,
        'bme-sent',
        'sent',
        1,
        null,
        null,
        '["use_billing_repository_sent"]'::jsonb,
        '2026-05-08T00:07:00.000Z',
        '2026-05-08T00:07:00.000Z',
        '2026-05-08T00:07:00.000Z'
      ),
      (
        'bme_billing_repository_fresh',
        'ba_billing_repository_test',
        'org_billing_repository_test',
        'stripe',
        'cus_billing_repository_test',
        'review.credit',
        'heimdall.review_credit',
        '2026-05',
        '2026-05-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
        11,
        'bme-fresh',
        'ready_to_send',
        0,
        null,
        null,
        '["use_billing_repository_fresh"]'::jsonb,
        null,
        '2026-05-08T00:10:00.000Z',
        '2026-05-08T00:10:00.000Z'
      )
    ON CONFLICT (billing_meter_event_id) DO NOTHING
  `;
  await sql`
    INSERT INTO billing_webhook_events (
      billing_webhook_event_id,
      provider,
      provider_event_id,
      event_type,
      org_id,
      billing_account_id,
      provider_customer_id,
      status,
      payload_hash,
      payload,
      error,
      received_at
    )
    VALUES
      (
        'bwh_billing_repository_failed_oldest',
        'stripe',
        'evt_billing_repository_failed_oldest',
        'invoice.payment_failed',
        'org_billing_repository_test',
        'ba_billing_repository_test',
        'cus_billing_repository_test',
        'failed',
        'sha256:failed-oldest',
        '{}'::jsonb,
        '{"message":"Invoice payment failed."}'::jsonb,
        '2026-05-08T00:03:00.000Z'
      ),
      (
        'bwh_billing_repository_processed',
        'stripe',
        'evt_billing_repository_processed',
        'invoice.paid',
        'org_billing_repository_test',
        'ba_billing_repository_test',
        'cus_billing_repository_test',
        'processed',
        'sha256:processed',
        '{}'::jsonb,
        null,
        '2026-05-08T00:04:00.000Z'
      ),
      (
        'bwh_billing_repository_failed_latest',
        'stripe',
        'evt_billing_repository_failed_latest',
        'customer.subscription.updated',
        'org_billing_repository_test',
        'ba_billing_repository_test',
        'cus_billing_repository_test',
        'failed',
        'sha256:failed-latest',
        '{}'::jsonb,
        '{"message":"Subscription update failed."}'::jsonb,
        '2026-05-08T00:06:00.000Z'
      )
    ON CONFLICT (billing_webhook_event_id) DO NOTHING
  `;
}

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
