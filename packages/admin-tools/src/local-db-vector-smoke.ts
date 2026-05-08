import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import postgres from "postgres";
import { findWorkspaceRoot, loadSmokeEnv, optionalEnv } from "./smoke-env";

/** Default local Postgres URL used by compose.yaml. */
const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/review_agent";

/** Tables required by the vector smoke graph and nearest-neighbor query. */
const REQUIRED_VECTOR_TABLES = [
  "orgs",
  "provider_installations",
  "repositories",
  "code_index_versions",
  "indexed_files",
  "code_chunks",
  "code_chunk_embeddings",
] as const;

/** Configuration for the local DB vector smoke. */
type LocalDbVectorSmokeConfig = {
  /** Postgres connection string used by the smoke. */
  readonly databaseUrl: string;
  /** Absolute workspace root path. */
  readonly workspaceRoot: string;
};

/** Sanitized database target details for product-safe proof output. */
type DatabaseTarget = {
  /** Database name selected by the connection URL. */
  readonly database: string;
  /** Database host name or address. */
  readonly host: string;
  /** Database port. */
  readonly port: string;
};

/** Extension version details returned by Postgres. */
type ExtensionProof = {
  /** Installed extension name. */
  readonly name: string;
  /** Installed extension version. */
  readonly version: string;
};

/** Migration proof for the isolated smoke schema. */
type MigrationProof = {
  /** Number of migration files applied to the isolated schema. */
  readonly appliedCount: number;
  /** Migration isolation mode used by the smoke. */
  readonly mode: "isolated_schema";
  /** Temporary schema that received all migrations. */
  readonly schema: string;
};

/** Stable IDs used by one smoke run. */
type SmokeIds = {
  /** Smoke code chunk ID expected to rank first. */
  readonly nearChunkId: string;
  /** Smoke embedding row ID expected to rank first. */
  readonly nearEmbeddingId: string;
  /** Smoke code chunk ID expected to rank second. */
  readonly farChunkId: string;
  /** Smoke embedding row ID expected to rank second. */
  readonly farEmbeddingId: string;
  /** Smoke indexed file ID. */
  readonly fileId: string;
  /** Smoke index version ID. */
  readonly indexVersionId: string;
  /** Smoke provider installation ID. */
  readonly installationId: string;
  /** Smoke organization ID. */
  readonly orgId: string;
  /** Smoke repository ID. */
  readonly repoId: string;
  /** Temporary Postgres schema name used by the smoke. */
  readonly schemaName: string;
  /** Unique suffix shared by all smoke rows. */
  readonly suffix: string;
};

/** Nearest-neighbor row returned by pgvector. */
type NearestEmbeddingRow = {
  /** Candidate chunk ID. */
  readonly chunk_id: string;
  /** L2 distance from the query embedding. */
  readonly distance: number | string;
  /** Candidate embedding row ID. */
  readonly chunk_embedding_id: string;
  /** Candidate source path. */
  readonly path: string;
};

/** Product-safe proof emitted by the local DB vector smoke. */
type LocalDbVectorSmokeProof = {
  /** Sanitized database target. */
  readonly database: DatabaseTarget;
  /** Installed extension versions used by the smoke. */
  readonly extensions: readonly ExtensionProof[];
  /** Number of embedding rows inserted and queried. */
  readonly insertedEmbeddingCount: number;
  /** Migration proof for the isolated smoke schema. */
  readonly migration: MigrationProof;
  /** First nearest-neighbor result. */
  readonly nearest: {
    /** Nearest chunk ID. */
    readonly chunkId: string;
    /** Nearest embedding row ID. */
    readonly chunkEmbeddingId: string;
    /** L2 distance from the query vector. */
    readonly distance: number;
    /** Nearest indexed file path. */
    readonly path: string;
  };
  /** Number of nearest-neighbor rows returned by the query. */
  readonly resultCount: number;
  /** Smoke status. */
  readonly status: "passed";
};

/** Loads repeatable local DB vector smoke configuration. */
function loadConfig(): LocalDbVectorSmokeConfig {
  loadSmokeEnv();

  return {
    databaseUrl: optionalEnv("DATABASE_URL") ?? DEFAULT_DATABASE_URL,
    workspaceRoot: findWorkspaceRoot(process.cwd()),
  };
}

/** Runs the local DB vector smoke and prints product-safe proof JSON. */
async function main(): Promise<void> {
  const config = loadConfig();
  const sql = postgres(config.databaseUrl, { max: 1, onnotice: () => undefined });
  const ids = createSmokeIds();

  try {
    const migration = await prepareIsolatedSchema(sql, config.workspaceRoot, ids.schemaName);
    const extensions = await getRequiredExtensions(sql);

    await insertSmokeRows(sql, ids);
    const nearestRows = await queryNearestEmbeddings(sql, ids.repoId);
    const nearest = nearestRows.at(0);
    if (!nearest) {
      throw new Error("DB vector smoke returned no nearest-neighbor rows.");
    }
    if (nearest.chunk_id !== ids.nearChunkId) {
      throw new Error(
        `DB vector smoke expected ${ids.nearChunkId} first, got ${nearest.chunk_id}.`,
      );
    }
    if (nearestRows.length !== 2) {
      throw new Error(
        `DB vector smoke expected 2 nearest-neighbor rows, got ${nearestRows.length}.`,
      );
    }

    const proof: LocalDbVectorSmokeProof = {
      database: databaseTarget(config.databaseUrl),
      extensions,
      insertedEmbeddingCount: 2,
      migration,
      nearest: {
        chunkEmbeddingId: nearest.chunk_embedding_id,
        chunkId: nearest.chunk_id,
        distance: Number(nearest.distance),
        path: nearest.path,
      },
      resultCount: nearestRows.length,
      status: "passed",
    };
    console.log(JSON.stringify(proof, null, 2));
  } finally {
    await cleanupSmokeSchema(sql, ids.schemaName);
    await sql.end();
  }
}

/** Applies bootstrap extensions and all migrations to an isolated smoke schema. */
async function prepareIsolatedSchema(
  sql: postgres.Sql,
  workspaceRoot: string,
  schemaName: string,
): Promise<MigrationProof> {
  await sql.unsafe(
    await readFile(join(workspaceRoot, "packages/db/bootstrap/0000_extensions.sql"), "utf8"),
  );
  await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);

  const appliedCount = await applyMigrations(sql, workspaceRoot, schemaName);
  await assertRequiredTables(sql, schemaName);

  return {
    appliedCount,
    mode: "isolated_schema",
    schema: schemaName,
  };
}

/** Returns installed versions for pgvector and pgcrypto. */
async function getRequiredExtensions(sql: postgres.Sql): Promise<readonly ExtensionProof[]> {
  const rows = await sql<{ readonly extname: string; readonly extversion: string }[]>`
    SELECT extname, extversion
    FROM pg_extension
    WHERE extname IN ('vector', 'pgcrypto')
    ORDER BY extname
  `;
  const extensions = rows.map((row) => ({
    name: row.extname,
    version: row.extversion,
  }));
  const missing = ["pgcrypto", "vector"].filter(
    (name) => !extensions.some((extension) => extension.name === name),
  );
  if (missing.length > 0) {
    throw new Error(`DB vector smoke is missing required extensions: ${missing.join(", ")}`);
  }

  return extensions;
}

/** Applies all generated SQL migrations in lexical order to the smoke schema. */
async function applyMigrations(
  sql: postgres.Sql,
  workspaceRoot: string,
  schemaName: string,
): Promise<number> {
  const migrationsDirectory = join(workspaceRoot, "packages/db/migrations");
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  for (const file of files) {
    const migrationSql = await readFile(join(migrationsDirectory, file), "utf8");
    await sql.unsafe(migrationSql.replaceAll('"public".', `${quoteIdentifier(schemaName)}.`));
  }

  return files.length;
}

/** Asserts that all vector-smoke tables are present after preparation. */
async function assertRequiredTables(sql: postgres.Sql, schemaName: string): Promise<void> {
  const tables = await existingTables(sql, schemaName, REQUIRED_VECTOR_TABLES);
  const missing = REQUIRED_VECTOR_TABLES.filter((table) => !tables.has(table));
  if (missing.length > 0) {
    throw new Error(`DB vector smoke is missing required tables: ${missing.join(", ")}`);
  }
}

/** Returns the schema tables that exist from a fixed candidate list. */
async function existingTables(
  sql: postgres.Sql,
  schemaName: string,
  tableNames: readonly string[],
): Promise<ReadonlySet<string>> {
  const rows = await sql<{ readonly table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = ${schemaName}
      AND table_name IN ${sql(tableNames)}
  `;
  return new Set(rows.map((row) => row.table_name));
}

/** Creates deterministic row IDs with a unique suffix for one smoke run. */
function createSmokeIds(): SmokeIds {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  return {
    farChunkId: `chunk_db_vector_smoke_far_${suffix}`,
    farEmbeddingId: `emb_db_vector_smoke_far_${suffix}`,
    fileId: `file_db_vector_smoke_${suffix}`,
    indexVersionId: `idx_db_vector_smoke_${suffix}`,
    installationId: `inst_db_vector_smoke_${suffix}`,
    nearChunkId: `chunk_db_vector_smoke_near_${suffix}`,
    nearEmbeddingId: `emb_db_vector_smoke_near_${suffix}`,
    orgId: `org_db_vector_smoke_${suffix}`,
    repoId: `repo_db_vector_smoke_${suffix}`,
    schemaName: `heimdall_db_vector_smoke_${suffix}`,
    suffix,
  };
}

/** Inserts a minimal indexed repository graph plus two embeddings. */
async function insertSmokeRows(sql: postgres.Sql, ids: SmokeIds): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES (${ids.orgId}, 'DB Vector Smoke Org', ${`db-vector-smoke-${ids.suffix}`})
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
      ${ids.installationId},
      ${ids.orgId},
      'github',
      ${`db-vector-smoke-${ids.suffix}`},
      'db-vector-smoke',
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
      ${ids.repoId},
      ${ids.orgId},
      ${ids.installationId},
      'github',
      ${`db-vector-smoke-${ids.suffix}`},
      'db-vector-smoke',
      'heimdall',
      'db-vector-smoke/heimdall',
      'private'
    )
  `;
  await sql`
    INSERT INTO code_index_versions (
      index_version_id,
      repo_id,
      commit_sha,
      index_key,
      status,
      artifact_uri,
      artifact_hash,
      indexer_name,
      indexer_version,
      chunker_version,
      file_count,
      chunk_count,
      embedded_chunk_count,
      completed_at
    )
    VALUES (
      ${ids.indexVersionId},
      ${ids.repoId},
      'dbvectorsmokecommit',
      'local-db-vector-smoke',
      'ready',
      ${`smoke://db-vector/${ids.suffix}`},
      ${`artifact-hash-${ids.suffix}`},
      'local-db-vector-smoke',
      '1',
      '1',
      1,
      2,
      2,
      now()
    )
  `;
  await sql`
    INSERT INTO indexed_files (
      file_id,
      index_version_id,
      repo_id,
      commit_sha,
      path,
      language,
      content_hash,
      size_bytes,
      line_count
    )
    VALUES (
      ${ids.fileId},
      ${ids.indexVersionId},
      ${ids.repoId},
      'dbvectorsmokecommit',
      'src/vector-smoke.ts',
      'typescript',
      ${`content-hash-${ids.suffix}`},
      128,
      12
    )
  `;
  await sql`
    INSERT INTO code_chunks (
      chunk_id,
      index_version_id,
      file_id,
      repo_id,
      path,
      start_line,
      end_line,
      content_hash,
      embedding_status
    )
    VALUES
      (
        ${ids.nearChunkId},
        ${ids.indexVersionId},
        ${ids.fileId},
        ${ids.repoId},
        'src/vector-smoke.ts',
        1,
        6,
        ${`near-content-hash-${ids.suffix}`},
        'embedded'
      ),
      (
        ${ids.farChunkId},
        ${ids.indexVersionId},
        ${ids.fileId},
        ${ids.repoId},
        'src/vector-smoke.ts',
        7,
        12,
        ${`far-content-hash-${ids.suffix}`},
        'embedded'
      )
  `;
  await sql`
    INSERT INTO code_chunk_embeddings (
      chunk_embedding_id,
      chunk_id,
      repo_id,
      index_version_id,
      embedding_model,
      embedding,
      content_hash,
      input_hash,
      input_kind,
      embedding_cache_key,
      embedding_profile_version,
      provider
    )
    VALUES
      (
        ${ids.nearEmbeddingId},
        ${ids.nearChunkId},
        ${ids.repoId},
        ${ids.indexVersionId},
        'local-db-vector-smoke',
        ('[1,' || repeat('0,', 1534) || '0]')::vector,
        ${`near-content-hash-${ids.suffix}`},
        ${`near-input-hash-${ids.suffix}`},
        'code_chunk',
        ${`near-cache-key-${ids.suffix}`},
        'code_embedding_profile.v1',
        'local'
      ),
      (
        ${ids.farEmbeddingId},
        ${ids.farChunkId},
        ${ids.repoId},
        ${ids.indexVersionId},
        'local-db-vector-smoke',
        ('[0,' || repeat('0,', 1534) || '1]')::vector,
        ${`far-content-hash-${ids.suffix}`},
        ${`far-input-hash-${ids.suffix}`},
        'code_chunk',
        ${`far-cache-key-${ids.suffix}`},
        'code_embedding_profile.v1',
        'local'
      )
  `;
}

/** Queries embeddings by pgvector L2 distance from a fixed query vector. */
async function queryNearestEmbeddings(
  sql: postgres.Sql,
  repoId: string,
): Promise<readonly NearestEmbeddingRow[]> {
  return sql<NearestEmbeddingRow[]>`
    SELECT
      code_chunks.chunk_id,
      code_chunk_embeddings.chunk_embedding_id,
      code_chunks.path,
      (
        code_chunk_embeddings.embedding <-> ('[0.98,' || repeat('0,', 1534) || '0.02]')::vector
      )::float8 AS distance
    FROM code_chunk_embeddings
    INNER JOIN code_chunks ON code_chunks.chunk_id = code_chunk_embeddings.chunk_id
    WHERE code_chunk_embeddings.repo_id = ${repoId}
      AND code_chunk_embeddings.embedding_model = 'local-db-vector-smoke'
    ORDER BY code_chunk_embeddings.embedding <-> ('[0.98,' || repeat('0,', 1534) || '0.02]')::vector
    LIMIT 2
  `;
}

/** Drops the isolated smoke schema and all rows inside it. */
async function cleanupSmokeSchema(sql: postgres.Sql, schemaName: string): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
}

/** Returns product-safe database target details without credentials. */
function databaseTarget(databaseUrl: string): DatabaseTarget {
  const url = new URL(databaseUrl);
  return {
    database: url.pathname.replace(/^\//u, ""),
    host: url.hostname,
    port: url.port || defaultDatabasePort(url.protocol),
  };
}

/** Returns the default port for a database URL protocol. */
function defaultDatabasePort(protocol: string): string {
  return protocol === "postgres:" || protocol === "postgresql:" ? "5432" : "";
}

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : inspect(error));
  process.exitCode = 1;
});
