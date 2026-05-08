import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Dashboard source root checked by boundary tests. */
const WEB_SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** Dashboard app root used for readable relative paths. */
const WEB_APP_DIR = resolve(WEB_SRC_DIR, "..");

/** Dashboard API client file that owns direct browser fetch calls. */
const API_CLIENT_FILE = resolve(WEB_SRC_DIR, "api-client.ts");

/** Source file extensions checked by dashboard boundary tests. */
const SOURCE_FILE_PATTERN = /\.ts$/u;

/** Test source file suffix excluded from production boundary checks. */
const TEST_FILE_PATTERN = /\.test\.ts$/u;

/** Server-only workspace packages that dashboard code must not import directly. */
const SERVER_ONLY_PACKAGE_IMPORTS = [
  "@repo/db",
  "@repo/queue",
  "@repo/repo-sync",
  "@repo/indexer-ts",
  "@repo/index-importer",
  "@repo/embedding",
  "@repo/retrieval",
  "@repo/review-orchestrator",
  "@repo/review-engine",
  "@repo/llm-gateway",
  "@repo/publisher",
  "@repo/sandbox",
  "@repo/tool-runner",
] as const;

/** Production dashboard source file and its contents. */
type DashboardSourceFile = {
  /** Source path relative to the web app root. */
  readonly relativePath: string;
  /** Source text. */
  readonly source: string;
};

/** Recursively collects production dashboard TypeScript source files. */
function readDashboardSourceFiles(directory = WEB_SRC_DIR): readonly DashboardSourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return readDashboardSourceFiles(entryPath);
    }
    if (
      !entry.isFile() ||
      !SOURCE_FILE_PATTERN.test(entry.name) ||
      TEST_FILE_PATTERN.test(entry.name)
    ) {
      return [];
    }
    return [
      {
        relativePath: relative(WEB_APP_DIR, entryPath),
        source: readFileSync(entryPath, "utf8"),
      },
    ];
  });
}

describe("dashboard source boundaries", () => {
  it("keeps direct fetch calls inside the dashboard API client", () => {
    const violations = readDashboardSourceFiles()
      .filter((file) => resolve(WEB_APP_DIR, file.relativePath) !== API_CLIENT_FILE)
      .filter((file) => file.source.includes("fetch("))
      .map((file) => file.relativePath);

    expect(violations).toEqual([]);
  });

  it("does not import server-only workspace packages", () => {
    const violations = readDashboardSourceFiles().flatMap((file) =>
      SERVER_ONLY_PACKAGE_IMPORTS.filter(
        (packageName) =>
          file.source.includes(`"${packageName}"`) || file.source.includes(`'${packageName}'`),
      ).map((packageName) => `${file.relativePath}: ${packageName}`),
    );

    expect(violations).toEqual([]);
  });
});
