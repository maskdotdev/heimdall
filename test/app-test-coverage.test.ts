import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Workspace apps directory path. */
const APPS_DIR = resolve("apps");

/** Test file names that count as app-level behavior coverage. */
const TEST_FILE_PATTERN = /\.test\.[cm]?[jt]sx?$/u;

/** Generated or dependency directories that should not be scanned for tests. */
const IGNORED_TEST_SCAN_DIRECTORIES = new Set([
  ".output",
  ".tanstack",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

/** Minimal app package manifest shape used by the coverage guard. */
interface AppManifest {
  /** App package name from package.json. */
  readonly name: string;

  /** App package scripts from package.json. */
  readonly scripts: Readonly<Record<string, string>>;
}

/** App test coverage metadata. */
interface AppTestCoverage {
  /** App package name from package.json. */
  readonly packageName: string;

  /** App directory relative to the repository root. */
  readonly appDir: string;

  /** App-local test script configured in package.json. */
  readonly testScript: string | undefined;

  /** App-local test files relative to the repository root. */
  readonly testFiles: readonly string[];
}

/** Reads the app manifest as a strongly typed subset. */
const readAppManifest = (appDir: string): AppManifest => {
  const packageJsonPath = join(appDir, "package.json");
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid app manifest: ${packageJsonPath}`);
  }

  const manifest = parsed as Record<string, unknown>;
  const scriptsValue = manifest.scripts;
  const scripts =
    typeof scriptsValue === "object" && scriptsValue !== null && !Array.isArray(scriptsValue)
      ? Object.fromEntries(
          Object.entries(scriptsValue as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};

  return {
    name: typeof manifest.name === "string" ? manifest.name : basename(appDir),
    scripts,
  };
};

/** Recursively collects app-local test files. */
const collectTestFiles = (directory: string): readonly string[] => {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        return IGNORED_TEST_SCAN_DIRECTORIES.has(entry.name) ? [] : collectTestFiles(entryPath);
      }

      if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        return [relative(resolve("."), entryPath)];
      }

      return [];
    })
    .sort();
};

/** Reads test coverage metadata for every workspace app. */
const readAppTestCoverage = (): readonly AppTestCoverage[] =>
  readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const appDir = join(APPS_DIR, entry.name);
      const manifest = readAppManifest(appDir);

      return {
        appDir: relative(resolve("."), appDir),
        packageName: manifest.name,
        testFiles: collectTestFiles(appDir),
        testScript: manifest.scripts.test,
      };
    })
    .sort((left, right) => left.packageName.localeCompare(right.packageName));

describe("workspace app test coverage", () => {
  it("keeps every app in the public test gate", () => {
    const appCoverage = readAppTestCoverage();
    const appsWithoutTestScripts = appCoverage.filter(
      (coverage) => !coverage.testScript?.includes("vitest run"),
    );
    const appsWithoutTestFiles = appCoverage.filter((coverage) => coverage.testFiles.length === 0);

    expect(appCoverage.length).toBeGreaterThan(0);
    expect(appsWithoutTestScripts).toEqual([]);
    expect(appsWithoutTestFiles).toEqual([]);
  });
});
