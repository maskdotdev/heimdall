import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Workspace roots that should participate in the root TypeScript project graph. */
const WORKSPACE_ROOTS = ["apps", "packages"] as const;

/** Root TypeScript project file path. */
const ROOT_TSCONFIG_FILE = resolve("tsconfig.json");

/** Minimal root tsconfig shape needed by the project-reference guard. */
type RootTsconfig = {
  /** TypeScript project references declared by the root config. */
  readonly references?: readonly {
    /** Workspace-relative referenced project path. */
    readonly path?: string;
  }[];
};

/** Reads and parses the root TypeScript config. */
function readRootTsconfig(): RootTsconfig {
  return JSON.parse(readFileSync(ROOT_TSCONFIG_FILE, "utf8")) as RootTsconfig;
}

/** Returns every workspace directory that owns a package-local TypeScript config. */
function workspaceProjectsWithTsconfig(): readonly string[] {
  return WORKSPACE_ROOTS.flatMap((workspaceRoot) =>
    readdirSync(resolve(workspaceRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(workspaceRoot, entry.name))
      .filter((workspacePath) => existsSync(join(workspacePath, "tsconfig.json"))),
  ).sort();
}

/** Normalizes a root project reference path into repository-relative form. */
function normalizeProjectReferencePath(referencePath: string): string {
  return relative(resolve("."), resolve(referencePath));
}

describe("root TypeScript project references", () => {
  it("keeps every workspace TypeScript project in the root graph", () => {
    const expectedProjects = workspaceProjectsWithTsconfig();
    const actualProjects = (readRootTsconfig().references ?? [])
      .map((reference) => reference.path)
      .filter((referencePath): referencePath is string => typeof referencePath === "string")
      .map(normalizeProjectReferencePath)
      .sort();

    expect(actualProjects).toEqual(expectedProjects);
  });
});
