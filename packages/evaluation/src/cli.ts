#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  assertEvalGate,
  buildEvalHistoryWrite,
  type EvalReportArtifacts,
  type EvalSuite,
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
  /** Optional database URL for eval history persistence. */
  readonly databaseUrl?: string;
  /** Whether to persist eval history after writing artifacts. */
  readonly persistHistory: boolean;
  /** Actor or automation that triggered this eval run. */
  readonly triggeredBy: string;
  /** Runtime environment label for persisted eval history. */
  readonly historyEnvironment: string;
  /** Optional commit SHA under evaluation. */
  readonly gitCommitSha?: string;
  /** Optional branch under evaluation. */
  readonly branch?: string;
  /** Whether this run should become the active baseline for its suite and variant. */
  readonly setActiveBaseline: boolean;
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
  process.stdout.write(
    `Artifacts:\n- ${artifacts.markdownPath}\n- ${artifacts.htmlPath}\n- ${artifacts.jsonPath}\n- ${artifacts.junitPath}\n`,
  );

  if (options.persistHistory) {
    const evalRunId = await persistEvalHistory({ artifacts, options, report, suite });
    process.stdout.write(`Persisted eval history: ${evalRunId}\n`);
  }

  if (options.failOnThreshold) {
    assertEvalGate(report);
  }
}

/** Input for persisting one eval run from the CLI. */
type PersistEvalHistoryInput = {
  /** Artifact paths written by the eval runner. */
  readonly artifacts: EvalReportArtifacts;
  /** Parsed CLI options. */
  readonly options: EvalCliOptions;
  /** Evaluation report to persist. */
  readonly report: ReturnType<typeof runEvaluation>;
  /** Evaluation suite used for the run. */
  readonly suite: EvalSuite;
};

/** Persists eval history using the DB package only when the CLI requests it. */
async function persistEvalHistory(input: PersistEvalHistoryInput): Promise<string> {
  const { createDatabaseClient, EvaluationRepository } = await import("@repo/db");
  const client = createDatabaseClient({
    ...(input.options.databaseUrl ? { url: input.options.databaseUrl } : {}),
    maxConnections: 1,
  });

  try {
    const repository = new EvaluationRepository(client.db);
    const run = await repository.recordEvalHistory(
      buildEvalHistoryWrite({
        artifacts: input.artifacts,
        environment: input.options.historyEnvironment,
        report: input.report,
        setAsActiveBaseline: input.options.setActiveBaseline,
        suite: input.suite,
        triggeredBy: input.options.triggeredBy,
        ...(input.options.branch ? { branch: input.options.branch } : {}),
        ...(input.options.gitCommitSha ? { gitCommitSha: input.options.gitCommitSha } : {}),
      }),
    );

    return run.evalRunId;
  } finally {
    await client.close();
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
  let databaseUrl: string | undefined;
  let persistHistory = false;
  let triggeredBy = "eval-cli";
  let historyEnvironment = "local";
  let gitCommitSha: string | undefined;
  let branch: string | undefined;
  let setActiveBaseline = false;
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
      case "--database-url":
        databaseUrl = readOptionValue(args, index, arg);
        persistHistory = true;
        index += 1;
        break;
      case "--persist-history":
        persistHistory = true;
        break;
      case "--triggered-by":
        triggeredBy = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--history-environment":
        historyEnvironment = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--git-commit":
        gitCommitSha = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--branch":
        branch = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--set-active-baseline":
        setActiveBaseline = true;
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
    ...(databaseUrl ? { databaseUrl } : {}),
    persistHistory,
    triggeredBy,
    historyEnvironment,
    ...(gitCommitSha ? { gitCommitSha } : {}),
    ...(branch ? { branch } : {}),
    setActiveBaseline,
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
