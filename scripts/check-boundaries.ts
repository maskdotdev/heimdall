import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type DependencySection =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type WorkspacePackage = {
  name: string;
  relativeDir: string;
  dependencies: Map<string, string>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoots = ["apps", "packages"];
const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const satisfies readonly DependencySection[];

const implementationPackages = new Set([
  "@repo/db",
  "@repo/github",
  "@repo/webhook-ingestion",
  "@repo/queue",
  "@repo/repo-sync",
  "@repo/indexer-driver",
  "@repo/indexer-ts",
  "@repo/index-importer",
  "@repo/embedding",
  "@repo/retrieval",
  "@repo/review-orchestrator",
  "@repo/review-engine",
  "@repo/llm-gateway",
  "@repo/publisher",
  "@repo/memory",
  "@repo/observability",
  "@repo/security",
  "@repo/admin-tools",
]);

const forbiddenBySource = new Map<string, ReadonlySet<string>>([
  [
    "@repo/review-engine",
    new Set([
      "@repo/db",
      "@repo/github",
      "@repo/index-importer",
      "@repo/publisher",
      "@repo/queue",
      "@repo/repo-sync",
      "@repo/retrieval",
    ]),
  ],
  [
    "@repo/retrieval",
    new Set(["@repo/github", "@repo/llm-gateway", "@repo/publisher", "@repo/review-engine"]),
  ],
  [
    "@repo/artifacts",
    new Set([
      "@repo/github",
      "@repo/llm-gateway",
      "@repo/publisher",
      "@repo/retrieval",
      "@repo/review-engine",
      "@repo/review-orchestrator",
    ]),
  ],
]);

async function readPackageJson(packageJsonPath: string): Promise<PackageJson> {
  return JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJson;
}

function collectDependencies(pkg: PackageJson): Map<string, string> {
  const dependencies = new Map<string, string>();

  for (const section of dependencySections) {
    const sectionDeps = pkg[section];
    if (!sectionDeps) {
      continue;
    }

    for (const [name, version] of Object.entries(sectionDeps)) {
      dependencies.set(name, version);
    }
  }

  return dependencies;
}

async function collectWorkspacePackages(): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];

  for (const workspaceRoot of workspaceRoots) {
    const absoluteRoot = path.join(repoRoot, workspaceRoot);
    const entries = await readdir(absoluteRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const relativeDir = path.join(workspaceRoot, entry.name);
      const packageJsonPath = path.join(repoRoot, relativeDir, "package.json");
      const packageJson = await readPackageJson(packageJsonPath);

      if (!packageJson.name) {
        throw new Error(`${relativeDir}/package.json must define a package name`);
      }

      packages.push({
        name: packageJson.name,
        relativeDir,
        dependencies: collectDependencies(packageJson),
      });
    }
  }

  return packages;
}

function checkPackageDependencies(packages: WorkspacePackage[]): string[] {
  const errors: string[] = [];
  const workspaceNames = new Set(packages.map((pkg) => pkg.name));

  for (const pkg of packages) {
    for (const dependency of pkg.dependencies.keys()) {
      if (dependency.startsWith("@repo/") && !workspaceNames.has(dependency)) {
        errors.push(`${pkg.name} depends on unknown workspace package ${dependency}`);
      }

      if (pkg.relativeDir.startsWith("packages/") && dependency.startsWith("@app/")) {
        errors.push(`${pkg.name} must not depend on app package ${dependency}`);
      }

      if (pkg.name === "@repo/index-schema" && dependency.startsWith("@repo/")) {
        errors.push("@repo/index-schema must own artifact schemas without internal repo deps");
      }

      if (
        pkg.name === "@repo/contracts" &&
        dependency.startsWith("@repo/") &&
        dependency !== "@repo/index-schema"
      ) {
        errors.push(`@repo/contracts may only depend on @repo/index-schema, found ${dependency}`);
      }

      if (implementationPackages.has(dependency) && pkg.name === "@repo/contracts") {
        errors.push(`@repo/contracts must not depend on implementation package ${dependency}`);
      }

      const forbidden = forbiddenBySource.get(pkg.name);
      if (forbidden?.has(dependency)) {
        errors.push(`${pkg.name} must not depend on ${dependency}`);
      }
    }
  }

  return errors;
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".turbo") {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(absolutePath)));
      continue;
    }

    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(absolutePath);
    }
  }

  return files;
}

function findOwningPackage(
  filePath: string,
  packages: WorkspacePackage[],
): WorkspacePackage | undefined {
  const relativeFile = path.relative(repoRoot, filePath);

  return packages.find(
    (pkg) =>
      relativeFile === pkg.relativeDir || relativeFile.startsWith(`${pkg.relativeDir}${path.sep}`),
  );
}

function checkImportSpecifiers(
  filePath: string,
  source: string,
  packages: WorkspacePackage[],
): string[] {
  const errors: string[] = [];
  const owner = findOwningPackage(filePath, packages);
  const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
  let match = importPattern.exec(source);

  while (match) {
    const specifier = match[1];

    if (specifier.includes("/packages/") || specifier.includes("/apps/")) {
      errors.push(
        `${path.relative(repoRoot, filePath)} deep-imports a workspace path: ${specifier}`,
      );
    }

    if (/^@repo\/[^/]+\/src(?:\/|$)/.test(specifier)) {
      errors.push(`${path.relative(repoRoot, filePath)} deep-imports package source: ${specifier}`);
    }

    if (owner?.relativeDir.startsWith("packages/") && specifier.startsWith("@app/")) {
      errors.push(`${path.relative(repoRoot, filePath)} imports app package ${specifier}`);
    }

    match = importPattern.exec(source);
  }

  return errors;
}

async function checkSourceImports(packages: WorkspacePackage[]): Promise<string[]> {
  const errors: string[] = [];

  for (const workspaceRoot of workspaceRoots) {
    const files = await collectSourceFiles(path.join(repoRoot, workspaceRoot));

    for (const filePath of files) {
      errors.push(...checkImportSpecifiers(filePath, await readFile(filePath, "utf8"), packages));
    }
  }

  return errors;
}

const workspacePackages = await collectWorkspacePackages();
const errors = [
  ...checkPackageDependencies(workspacePackages),
  ...(await checkSourceImports(workspacePackages)),
];

if (errors.length > 0) {
  console.error("Workspace boundary check failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Workspace boundary check passed.");
