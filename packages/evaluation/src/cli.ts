#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  assertEvalGate,
  type EvalVariant,
  loadEvalSuiteFromFile,
  loadRegisteredEvalSuite,
  renderEvalReportMarkdown,
  runEvaluation,
  writeEvalReportArtifacts,
} from "./index";

/** Parsed CLI options for the eval runner. */
type EvalCliOptions = {
  /** Registered suite ID to load. */
  readonly suiteId: string;
  /** Optional explicit suite JSON path. */
  readonly suiteFile?: string;
  /** Variant ID to include in the report. */
  readonly variantId: string;
  /** Whether the runner may call a live model. */
  readonly liveModel: boolean;
  /** Directory that receives report artifacts. */
  readonly outputDir: string;
  /** Whether to remove the output directory before writing artifacts. */
  readonly cleanOutput: boolean;
  /** Whether to exit nonzero when gate thresholds fail. */
  readonly failOnThreshold: boolean;
};

/** Entrypoint for the evaluation CLI. */
async function main(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command !== "run") {
    throw new Error(`Unknown evaluation command "${command ?? ""}". Expected "run".`);
  }

  const options = parseRunOptions(rest);
  const suite = options.suiteFile
    ? await loadEvalSuiteFromFile(options.suiteFile)
    : await loadRegisteredEvalSuite(options.suiteId);
  const variant = {
    variantId: options.variantId,
    label: options.liveModel ? `${options.variantId} live model` : `${options.variantId} fake LLM`,
    liveModel: options.liveModel,
  } satisfies EvalVariant;
  const report = runEvaluation({ suite, variant });
  const outputDir = resolveWorkspacePath(options.outputDir);

  if (options.cleanOutput) {
    await rm(outputDir, { force: true, recursive: true });
  }

  const artifacts = await writeEvalReportArtifacts(report, outputDir);
  process.stdout.write(renderEvalReportMarkdown(report));
  process.stdout.write(`Artifacts:\n- ${artifacts.markdownPath}\n- ${artifacts.jsonPath}\n`);

  if (options.failOnThreshold) {
    assertEvalGate(report);
  }
}

/** Resolves a CLI path relative to the workspace root when it is not absolute. */
function resolveWorkspacePath(path: string): string {
  if (isAbsolute(path)) {
    return path;
  }

  return resolve(findWorkspaceRoot(process.cwd()), path);
}

/** Finds the nearest pnpm workspace root above the current package. */
function findWorkspaceRoot(startDir: string): string {
  let currentDir = startDir;

  while (!existsSync(resolve(currentDir, "pnpm-workspace.yaml"))) {
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return startDir;
    }
    currentDir = parentDir;
  }

  return currentDir;
}

/** Parses `eval run` command options. */
function parseRunOptions(args: readonly string[]): EvalCliOptions {
  let suiteId = "smoke-full-pipeline-v1";
  let suiteFile: string | undefined;
  let variantId = "local";
  let liveModel = false;
  let outputDir = ".heimdall/eval-runs/smoke-full-pipeline-v1";
  let cleanOutput = false;
  let failOnThreshold = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--suite":
        suiteId = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--suite-file":
        suiteFile = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--variant":
        variantId = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--output-dir":
        outputDir = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--clean-output":
        cleanOutput = true;
        break;
      case "--no-live-models":
        liveModel = false;
        break;
      case "--live-models":
        liveModel = true;
        break;
      case "--no-fail-on-threshold":
        failOnThreshold = false;
        break;
      default:
        throw new Error(`Unknown evaluation option "${arg}".`);
    }
  }

  return {
    suiteId,
    ...(suiteFile ? { suiteFile } : {}),
    variantId,
    liveModel,
    outputDir,
    cleanOutput,
    failOnThreshold,
  };
}

/** Reads an option value from the following CLI argument. */
function readOptionValue(args: readonly string[], index: number, optionName: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${optionName}.`);
  }

  return value;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
