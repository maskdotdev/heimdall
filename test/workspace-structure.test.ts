import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Root files required by the Phase #1 workspace contract. */
const REQUIRED_ROOT_FILES = [
  ".env.example",
  ".env.test.example",
  ".gitignore",
  ".npmrc",
  "README.md",
  "biome.json",
  "compose.yaml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "turbo.json",
  "vitest.config.ts",
  "vitest.workspace.ts",
] as const;

/** Root scripts required for the common developer workflow. */
const REQUIRED_ROOT_SCRIPTS = [
  "build",
  "boundaries:check",
  "check",
  "clean",
  "dev",
  "env:check",
  "format",
  "infra:up",
  "lint",
  "test",
  "typecheck",
  "workspace:print",
] as const;

/** Scripts required on every workspace app. */
const REQUIRED_APP_SCRIPTS = [
  "build",
  "clean",
  "dev",
  "format",
  "lint",
  "test",
  "typecheck",
] as const;

/** Scripts required on every workspace package. */
const REQUIRED_PACKAGE_SCRIPTS = ["build", "clean", "format", "lint", "test", "typecheck"] as const;

/** App source entrypoints accepted by the workspace guard. */
const APP_ENTRYPOINT_FILES = [
  "src/index.ts",
  "src/index.tsx",
  "src/main.ts",
  "src/main.tsx",
] as const;

/** Minimal package manifest shape needed by workspace structure checks. */
type WorkspaceManifest = {
  /** Workspace package name. */
  readonly name?: string;
  /** Whether the workspace package is private. */
  readonly private?: boolean;
  /** Package scripts. */
  readonly scripts?: Readonly<Record<string, string>>;
};

/** Workspace project metadata used by structure checks. */
type WorkspaceProject = {
  /** Workspace kind. */
  readonly kind: "app" | "package";
  /** Project directory relative to the repository root. */
  readonly projectDir: string;
  /** Parsed project manifest. */
  readonly manifest: WorkspaceManifest;
};

/** Reads one JSON file as an unknown value. */
function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

/** Reads a package manifest as a validated subset. */
function readWorkspaceManifest(packageJsonPath: string): WorkspaceManifest {
  const parsed = readJsonFile(packageJsonPath);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid workspace manifest: ${packageJsonPath}`);
  }

  const record = parsed as Record<string, unknown>;
  const scripts =
    typeof record.scripts === "object" && record.scripts !== null && !Array.isArray(record.scripts)
      ? Object.fromEntries(
          Object.entries(record.scripts as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;

  return {
    name: typeof record.name === "string" ? record.name : undefined,
    private: typeof record.private === "boolean" ? record.private : undefined,
    scripts,
  };
}

/** Returns every workspace project under the provided root. */
function readWorkspaceProjects(root: "apps" | "packages"): readonly WorkspaceProject[] {
  return readdirSync(resolve(root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const projectDir = join(root, entry.name);

      return {
        kind: root === "apps" ? "app" : "package",
        manifest: readWorkspaceManifest(join(projectDir, "package.json")),
        projectDir,
      };
    })
    .sort((left, right) => left.projectDir.localeCompare(right.projectDir));
}

/** Returns missing files relative to the repository root. */
function missingFiles(files: readonly string[]): readonly string[] {
  return files.filter((file) => !existsSync(resolve(file)));
}

/** Returns missing scripts for a workspace manifest. */
function missingScripts(
  manifest: WorkspaceManifest,
  requiredScripts: readonly string[],
): readonly string[] {
  return requiredScripts.filter((scriptName) => !manifest.scripts?.[scriptName]);
}

/** Returns the first app entrypoint path found for one app directory. */
function appEntrypoint(appDir: string): string | undefined {
  return APP_ENTRYPOINT_FILES.find((entrypoint) => existsSync(join(appDir, entrypoint)));
}

describe("workspace structure", () => {
  it("keeps the Phase #1 root setup files and scripts present", () => {
    const rootManifest = readWorkspaceManifest(resolve("package.json"));
    const missingRootScripts = missingScripts(rootManifest, REQUIRED_ROOT_SCRIPTS);

    expect(missingFiles(REQUIRED_ROOT_FILES)).toEqual([]);
    expect(rootManifest.private).toBe(true);
    expect(missingRootScripts).toEqual([]);
  });

  it("keeps every app runnable through the shared workspace script contract", () => {
    const apps = readWorkspaceProjects("apps");
    const violations = apps.flatMap((app) => {
      const missing = missingScripts(app.manifest, REQUIRED_APP_SCRIPTS);
      const entrypoint = appEntrypoint(app.projectDir);

      return [
        ...(app.manifest.name?.startsWith("@app/") ? [] : [`${app.projectDir}: missing @app name`]),
        ...(app.manifest.private === true ? [] : [`${app.projectDir}: private must be true`]),
        ...(existsSync(join(app.projectDir, "tsconfig.json"))
          ? []
          : [`${app.projectDir}: missing tsconfig.json`]),
        ...(entrypoint ? [] : [`${app.projectDir}: missing app source entrypoint`]),
        ...missing.map((scriptName) => `${app.projectDir}: missing script ${scriptName}`),
      ];
    });

    expect(apps.map((app) => app.projectDir)).toEqual([
      "apps/admin-gateway",
      "apps/api",
      "apps/indexer-cli",
      "apps/marketing",
      "apps/web",
      "apps/worker",
    ]);
    expect(violations).toEqual([]);
  });

  it("keeps every package buildable through the shared workspace script contract", () => {
    const packages = readWorkspaceProjects("packages");
    const violations = packages.flatMap((workspacePackage) => {
      const missing = missingScripts(workspacePackage.manifest, REQUIRED_PACKAGE_SCRIPTS);
      const packageIndex = join(workspacePackage.projectDir, "src/index.ts");

      return [
        ...(workspacePackage.manifest.name?.startsWith("@repo/")
          ? []
          : [`${workspacePackage.projectDir}: missing @repo name`]),
        ...(workspacePackage.manifest.private === true
          ? []
          : [`${workspacePackage.projectDir}: private must be true`]),
        ...(existsSync(join(workspacePackage.projectDir, "tsconfig.json"))
          ? []
          : [`${workspacePackage.projectDir}: missing tsconfig.json`]),
        ...(existsSync(join(workspacePackage.projectDir, "tsconfig.build.json"))
          ? []
          : [`${workspacePackage.projectDir}: missing tsconfig.build.json`]),
        ...(existsSync(packageIndex)
          ? []
          : [
              `${workspacePackage.projectDir}: missing ${relative(workspacePackage.projectDir, packageIndex)}`,
            ]),
        ...missing.map(
          (scriptName) => `${workspacePackage.projectDir}: missing script ${scriptName}`,
        ),
      ];
    });

    expect(packages.length).toBeGreaterThan(0);
    expect(packages.map((workspacePackage) => basename(workspacePackage.projectDir))).toEqual(
      [...packages.map((workspacePackage) => basename(workspacePackage.projectDir))].sort(),
    );
    expect(violations).toEqual([]);
  });
});
