import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { ProductAuthRepository } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("ProductAuthRepository integration", () => {
  const schemaName = `heimdall_product_auth_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const productAuthRepository = new ProductAuthRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await seedProductAuthParents(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("creates and consumes OAuth state records exactly once", async () => {
    await productAuthRepository.createProductOAuthState({
      expiresAt: new Date("2026-05-08T00:10:00.000Z"),
      metadata: { provider: "github", requestId: "request_oauth" },
      oauthStateId: "oauth_product_auth_valid",
      redirectTo: "/repositories",
      stateHash: "state_hash_valid",
    });

    await expect(
      productAuthRepository.consumeProductOAuthState({
        consumedAt: new Date("2026-05-08T00:01:00.000Z"),
        expiresAfter: new Date("2026-05-08T00:01:00.000Z"),
        stateHash: "state_hash_valid",
      }),
    ).resolves.toEqual({ redirectTo: "/repositories" });
    await expect(
      productAuthRepository.consumeProductOAuthState({
        consumedAt: new Date("2026-05-08T00:02:00.000Z"),
        expiresAfter: new Date("2026-05-08T00:02:00.000Z"),
        stateHash: "state_hash_valid",
      }),
    ).resolves.toBeUndefined();

    await productAuthRepository.createProductOAuthState({
      expiresAt: new Date("2026-05-08T00:00:00.000Z"),
      metadata: { provider: "github", requestId: "request_expired" },
      oauthStateId: "oauth_product_auth_expired",
      redirectTo: "/expired",
      stateHash: "state_hash_expired",
    });
    await expect(
      productAuthRepository.consumeProductOAuthState({
        consumedAt: new Date("2026-05-08T00:02:00.000Z"),
        expiresAfter: new Date("2026-05-08T00:02:00.000Z"),
        stateHash: "state_hash_expired",
      }),
    ).resolves.toBeUndefined();
  });

  it("upserts OAuth users and preserves existing provider identity links", async () => {
    await expect(
      productAuthRepository.upsertProductOAuthUser({
        avatarUrl: "https://example.test/avatar-initial.png",
        displayName: "Initial User",
        fallbackUserId: "usr_product_auth_initial",
        primaryEmail: "initial@example.test",
        provider: "github",
        providerLogin: "initial-login",
        providerMetadata: { requestId: "request_initial" },
        providerUserId: "4242",
        updatedAt: new Date("2026-05-08T00:01:00.000Z"),
        userMetadata: { lastLoginProvider: "github", requestId: "request_initial" },
        userProviderAccountId: "upacct_product_auth_initial",
      }),
    ).resolves.toBe("usr_product_auth_initial");
    await expect(
      productAuthRepository.getProductProviderAccount({
        provider: "github",
        providerUserId: "4242",
      }),
    ).resolves.toEqual({ userId: "usr_product_auth_initial" });
    await expect(
      productAuthRepository.getExistingProductUserId("usr_product_auth_initial"),
    ).resolves.toBe("usr_product_auth_initial");
    await expect(
      productAuthRepository.getExistingProductUserId("usr_product_auth_missing"),
    ).resolves.toBeUndefined();

    await expect(
      productAuthRepository.upsertProductOAuthUser({
        avatarUrl: "https://example.test/avatar-updated.png",
        displayName: "Updated User",
        fallbackUserId: "usr_product_auth_replacement",
        primaryEmail: "updated@example.test",
        provider: "github",
        providerLogin: "updated-login",
        providerMetadata: { requestId: "request_updated" },
        providerUserId: "4242",
        updatedAt: new Date("2026-05-08T00:02:00.000Z"),
        userMetadata: { lastLoginProvider: "github", requestId: "request_updated" },
        userProviderAccountId: "upacct_product_auth_replacement",
      }),
    ).resolves.toBe("usr_product_auth_initial");

    const [row] = await sql`
      SELECT
        u.user_id,
        u.primary_email,
        u.display_name,
        u.avatar_url,
        upa.user_provider_account_id,
        upa.provider_login,
        upa.email
      FROM users u
      INNER JOIN user_provider_accounts upa ON upa.user_id = u.user_id
      WHERE upa.provider = 'github' AND upa.provider_user_id = '4242'
    `;
    expect(row).toMatchObject({
      avatar_url: "https://example.test/avatar-updated.png",
      display_name: "Updated User",
      email: "updated@example.test",
      primary_email: "updated@example.test",
      provider_login: "updated-login",
      user_id: "usr_product_auth_initial",
      user_provider_account_id: "upacct_product_auth_initial",
    });
  });

  it("creates, reads, lists memberships for, and revokes product sessions", async () => {
    await productAuthRepository.upsertProductOAuthUser({
      displayName: "Session User",
      fallbackUserId: "usr_product_auth_session",
      primaryEmail: "session@example.test",
      provider: "github",
      providerLogin: "session-login",
      providerMetadata: { requestId: "request_session" },
      providerUserId: "5252",
      userMetadata: { lastLoginProvider: "github", requestId: "request_session" },
      userProviderAccountId: "upacct_product_auth_session",
    });
    await sql`
      INSERT INTO org_memberships (org_id, user_id, role)
      VALUES
        ('org_product_auth_other', 'usr_product_auth_session', 'maintainer'),
        ('org_product_auth_test', 'usr_product_auth_session', 'owner')
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `;

    await productAuthRepository.createProductSession({
      expiresAt: new Date("2026-05-08T01:00:00.000Z"),
      metadata: { userAgent: "integration-test" },
      selectedOrgId: "org_product_auth_test",
      sessionHash: "session_hash_active",
      sessionId: "sess_product_auth_active",
      userId: "usr_product_auth_session",
    });
    await productAuthRepository.createProductSession({
      expiresAt: new Date("2026-05-08T00:00:00.000Z"),
      sessionHash: "session_hash_expired",
      sessionId: "sess_product_auth_expired",
      userId: "usr_product_auth_session",
    });

    await expect(
      productAuthRepository.getActiveProductSessionByHash({
        now: new Date("2026-05-08T00:05:00.000Z"),
        sessionHash: "session_hash_active",
      }),
    ).resolves.toMatchObject({
      displayName: "Session User",
      primaryEmail: "session@example.test",
      selectedOrgId: "org_product_auth_test",
      sessionId: "sess_product_auth_active",
      userId: "usr_product_auth_session",
    });
    await expect(
      productAuthRepository.getActiveProductSessionByHash({
        now: new Date("2026-05-08T00:05:00.000Z"),
        sessionHash: "session_hash_expired",
      }),
    ).resolves.toBeUndefined();
    await expect(
      productAuthRepository.listProductMemberships("usr_product_auth_session"),
    ).resolves.toEqual([
      { orgId: "org_product_auth_other", role: "maintainer" },
      { orgId: "org_product_auth_test", role: "owner" },
    ]);

    await productAuthRepository.revokeProductSession({
      revokedAt: new Date("2026-05-08T00:06:00.000Z"),
      sessionId: "sess_product_auth_active",
    });
    await expect(
      productAuthRepository.getActiveProductSessionByHash({
        now: new Date("2026-05-08T00:07:00.000Z"),
        sessionHash: "session_hash_active",
      }),
    ).resolves.toBeUndefined();
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

/** Inserts organization parents for product auth repository tests. */
async function seedProductAuthParents(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES
      ('org_product_auth_test', 'Product Auth Test Org', 'product-auth-test-org'),
      ('org_product_auth_other', 'Other Product Auth Org', 'product-auth-other-org')
  `;
}

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
