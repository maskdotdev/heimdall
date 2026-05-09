import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Index importer source path relative to the repository root. */
const INDEX_IMPORTER_SOURCE_PATH = resolve("packages/index-importer/src/index.ts");

/** Table-level tokens that must stay inside @repo/db repository modules. */
const FORBIDDEN_IMPORTER_TOKENS = [
  'from "drizzle-orm"',
  "codeChunkEmbeddings",
  "codeChunks",
  "codeDependencies",
  "codeEdges",
  "codeIndexDiagnostics",
  "codeRoutes",
  "codeTestMappings",
  "embeddingJobItems",
  "embeddingJobs",
  "indexedFiles",
  "indexImportBatches",
  "symbols",
] as const;

describe("index importer database boundary", () => {
  it("keeps normalized index writes behind the DB repository boundary", () => {
    const source = readFileSync(INDEX_IMPORTER_SOURCE_PATH, "utf8");
    const violations = FORBIDDEN_IMPORTER_TOKENS.filter((token) => source.includes(token));

    expect(violations).toEqual([]);
    expect(source).toContain("IndexImportRepository");
  });
});
