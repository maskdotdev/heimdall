import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { findWorkspaceRoot, loadSmokeEnv, optionalEnv } from "./smoke-env";

/** Local infrastructure migration configuration. */
type LocalInfraConfig = {
  /** Postgres connection string used by API, worker, and smoke commands. */
  readonly databaseUrl: string;
  /** Absolute workspace root path. */
  readonly workspaceRoot: string;
};

/** Loads repeatable local infrastructure setup configuration. */
function loadConfig(): LocalInfraConfig {
  loadSmokeEnv();
  const databaseUrl =
    optionalEnv("DATABASE_URL") ?? "postgresql://postgres:postgres@localhost:5432/review_agent";

  return {
    databaseUrl,
    workspaceRoot: findWorkspaceRoot(process.cwd()),
  };
}

/** Applies bootstrap extensions and Drizzle migrations to the configured database. */
async function main(): Promise<void> {
  const config = loadConfig();
  const sql = postgres(config.databaseUrl, { max: 1 });
  const db = drizzle(sql);

  try {
    await sql.unsafe(
      await readFile(
        join(config.workspaceRoot, "packages/db/bootstrap/0000_extensions.sql"),
        "utf8",
      ),
    );
    const schemaAlreadyPresent = await hasCurrentFoundationSchema(sql);
    if (!schemaAlreadyPresent) {
      await migrate(db, {
        migrationsFolder: join(config.workspaceRoot, "packages/db/migrations"),
      });
    }

    console.log(
      JSON.stringify(
        {
          status: "completed",
          database: schemaAlreadyPresent ? "already_present" : "migrated",
          bootstrap: "applied",
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

/** Returns whether the current one-file foundation schema is already present. */
async function hasCurrentFoundationSchema(sql: postgres.Sql): Promise<boolean> {
  const rows = await sql<{ readonly table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('orgs', 'background_jobs', 'review_runs', 'publish_runs')
  `;
  return rows.length === 4;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : inspect(error));
  process.exitCode = 1;
});
