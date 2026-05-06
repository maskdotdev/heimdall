import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Returns the nearest workspace root so package scripts can load repo-local env files. */
export function findWorkspaceRoot(startDirectory: string): string {
  let directory = startDirectory;
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    const parent = dirname(directory);
    if (parent === directory) {
      return startDirectory;
    }
    directory = parent;
  }
  return directory;
}

/** Removes matching single or double quotes from a dotenv value. */
export function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Parses a small dotenv-compatible file without overriding already exported variables. */
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const [rawName, ...rawValueParts] = trimmed.replace(/^export\s+/u, "").split("=");
    const name = rawName?.trim();
    if (!name || rawValueParts.length === 0 || process.env[name] !== undefined) {
      continue;
    }

    process.env[name] = unquoteEnvValue(rawValueParts.join("=")).replaceAll("\\n", "\n");
  }
}

/** Loads optional local smoke credentials from the repository root. */
export function loadSmokeEnv(): void {
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  loadEnvFile(join(workspaceRoot, ".env.smoke.local"));
}

/** Returns a non-empty environment variable value. */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** Parses an integer environment value with a bounded fallback. */
export function optionalIntegerEnv(name: string, fallback: number): number {
  const value = optionalEnv(name);
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
