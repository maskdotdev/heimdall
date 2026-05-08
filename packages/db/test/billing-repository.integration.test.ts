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
}

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
