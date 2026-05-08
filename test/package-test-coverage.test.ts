import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Workspace packages directory path. */
const PACKAGES_DIR = resolve("packages");

/** Test file names that count as package-level public behavior coverage. */
const TEST_FILE_PATTERN = /\.test\.[cm]?[jt]sx?$/u;

/** Minimal package manifest shape used by the coverage guard. */
interface PackageManifest {
  /** Package name from package.json. */
  readonly name: string;

  /** Package scripts from package.json. */
  readonly scripts: Readonly<Record<string, string>>;
}

/** Package test coverage metadata. */
interface PackageTestCoverage {
  /** Package name from package.json. */
  readonly packageName: string;

  /** Package directory relative to the repository root. */
  readonly packageDir: string;

  /** Test script configured in package.json. */
  readonly testScript: string | undefined;

  /** Package-local test files relative to the repository root. */
  readonly testFiles: readonly string[];
}

/** Reads the package manifest as a strongly typed subset. */
const readPackageManifest = (packageDir: string): PackageManifest => {
  const packageJsonPath = join(packageDir, "package.json");
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid package manifest: ${packageJsonPath}`);
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
    name: typeof manifest.name === "string" ? manifest.name : basename(packageDir),
    scripts,
  };
};

/** Recursively collects package-local test files. */
const collectTestFiles = (directory: string): readonly string[] => {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        return collectTestFiles(entryPath);
      }

      if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        return [relative(resolve("."), entryPath)];
      }

      return [];
    })
    .sort();
};

/** Reads test coverage metadata for every workspace package. */
const readPackageTestCoverage = (): readonly PackageTestCoverage[] =>
  readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageDir = join(PACKAGES_DIR, entry.name);
      const manifest = readPackageManifest(packageDir);

      return {
        packageDir: relative(resolve("."), packageDir),
        packageName: manifest.name,
        testFiles: collectTestFiles(join(packageDir, "test")),
        testScript: manifest.scripts.test,
      };
    })
    .sort((left, right) => left.packageName.localeCompare(right.packageName));

describe("workspace package test coverage", () => {
  it("keeps every package in the public test gate", () => {
    const packageCoverage = readPackageTestCoverage();
    const packagesWithoutTestScripts = packageCoverage.filter(
      (coverage) => !coverage.testScript?.includes("vitest run"),
    );
    const packagesWithoutTestFiles = packageCoverage.filter(
      (coverage) => coverage.testFiles.length === 0,
    );

    expect(packageCoverage.length).toBeGreaterThan(0);
    expect(packagesWithoutTestScripts).toEqual([]);
    expect(packagesWithoutTestFiles).toEqual([]);
  });
});
