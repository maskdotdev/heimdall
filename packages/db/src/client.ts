import { loadRuntimeConfig } from "@repo/config";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/** Database type used by Heimdall repositories. */
export type HeimdallDatabase = PostgresJsDatabase<typeof schema>;

/** Options used to create a database client. */
export type CreateDatabaseOptions = {
  /** PostgreSQL connection string. */
  readonly url?: string;
  /** Maximum number of database connections for this client. */
  readonly maxConnections?: number;
};

/** Database client plus the underlying postgres.js connection. */
export type DatabaseClient = {
  /** Drizzle database facade. */
  readonly db: HeimdallDatabase;
  /** Closes the underlying database connection. */
  readonly close: () => Promise<void>;
};

/** Creates a Drizzle client backed by postgres.js. */
export function createDatabaseClient(options: CreateDatabaseOptions = {}): DatabaseClient {
  const runtimeConfig = options.url ? undefined : loadRuntimeConfig();
  const client = postgres(options.url ?? runtimeConfig?.databaseUrl ?? "", {
    max: options.maxConnections ?? 10,
  });

  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
}

/** Runs a callback inside a database transaction. */
export function withTransaction<T>(
  db: HeimdallDatabase,
  callback: Parameters<HeimdallDatabase["transaction"]>[0],
): Promise<T> {
  return db.transaction(callback) as Promise<T>;
}
