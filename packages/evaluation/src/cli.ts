#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { EvalHumanLabelRow } from "@repo/db";
import {
  assertEvalGate,
  buildEvalHistoryWrite,
  createEvalHumanLabelFile,
  type EvalHumanLabelRecord,
  type EvalReportArtifacts,
  type EvalSuite,
  type EvalVariant,
  ensureParentDirectory,
  importEvalCaseIntoSuite,
  loadEvalSuiteFromFile,
  loadRegisteredEvalSuite,
  parseEvalCaseImportSource,
  parseEvalHumanFindingLabel,
  parseEvalHumanLabelFile,
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

/** Parsed CLI options for importing a reviewed eval case into a suite fixture. */
type EvalImportCaseCliOptions = {
  /** Suite JSON file to update or use as the input. */
  readonly suiteFile: string;
  /** JSON file containing an EvalCase or admin eval import draft. */
  readonly caseFile: string;
  /** Optional output suite file. Defaults to suiteFile. */
  readonly outputFile?: string;
  /** Whether to replace an existing case with the same ID. */
  readonly replaceExisting: boolean;
};

/** Parsed CLI options for importing human labels into eval history storage. */
type EvalImportLabelsCliOptions = {
  /** Database URL for label persistence. */
  readonly databaseUrl: string;
  /** JSON file containing an eval human-label export. */
  readonly labelsFile: string;
};

/** Parsed CLI options for exporting human labels from eval history storage. */
type EvalExportLabelsCliOptions = {
  /** Optional adjudication status filter. */
  readonly adjudicationStatus?: string;
  /** Database URL for label reads. */
  readonly databaseUrl: string;
  /** Optional single eval case ID filter. */
  readonly evalCaseId?: string;
  /** Optional labeler user ID filter. */
  readonly labelerUserId?: string;
  /** Maximum labels to export. */
  readonly limit: number;
  /** Output JSON file. */
  readonly outputFile: string;
  /** Optional suite fixture used to export labels for its case IDs. */
  readonly suiteFile?: string;
};

/** Entrypoint for the evaluation CLI. */
async function main(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "run") {
    await runEvalCommand(rest);
    return;
  }
  if (command === "import-case") {
    await importCaseCommand(rest);
    return;
  }
  if (command === "import-labels") {
    await importLabelsCommand(rest);
    return;
  }
  if (command === "export-labels") {
    await exportLabelsCommand(rest);
    return;
  }

  throw new Error(
    `Unknown evaluation command "${command ?? ""}". Expected "run", "import-case", "import-labels", or "export-labels".`,
  );
}

/** Runs a deterministic eval suite and writes report artifacts. */
async function runEvalCommand(args: readonly string[]): Promise<void> {
  const options = parseRunOptions(args);
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

/** Imports a reviewed eval case or admin eval import draft into a suite fixture file. */
async function importCaseCommand(args: readonly string[]): Promise<void> {
  const options = parseImportCaseOptions(args);
  const suitePath = resolveWorkspacePath(options.suiteFile);
  const casePath = resolveWorkspacePath(options.caseFile);
  const outputPath = resolveWorkspacePath(options.outputFile ?? options.suiteFile);
  const suite = await loadEvalSuiteFromFile(suitePath);
  const evalCase = parseEvalCaseImportSource(JSON.parse(await readFile(casePath, "utf8")));
  const result = importEvalCaseIntoSuite({
    evalCase,
    replaceExisting: options.replaceExisting,
    suite,
  });

  await writeFile(outputPath, `${JSON.stringify(result.suite, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${result.replaced ? "Replaced" : "Imported"} eval case ${evalCase.caseId} in ${outputPath} (${result.caseCount} cases).\n`,
  );
}

/** Imports a portable human-label file into eval history storage. */
async function importLabelsCommand(args: readonly string[]): Promise<void> {
  const options = parseImportLabelsOptions(args);
  const labelsPath = resolveWorkspacePath(options.labelsFile);
  const labelFile = parseEvalHumanLabelFile(JSON.parse(await readFile(labelsPath, "utf8")));
  const { createDatabaseClient, EvaluationRepository } = await import("@repo/db");
  const client = createDatabaseClient({ maxConnections: 1, url: options.databaseUrl });

  try {
    const repository = new EvaluationRepository(client.db);
    const rows = await repository.upsertEvalHumanLabels(
      labelFile.labels.map(evalHumanLabelRecordToDbInsert),
    );
    process.stdout.write(`Imported ${rows.length} human labels from ${labelsPath}.\n`);
  } finally {
    await client.close();
  }
}

/** Exports persisted human labels into a portable JSON file. */
async function exportLabelsCommand(args: readonly string[]): Promise<void> {
  const options = parseExportLabelsOptions(args);
  const outputPath = resolveWorkspacePath(options.outputFile);
  const suite = options.suiteFile
    ? await loadEvalSuiteFromFile(resolveWorkspacePath(options.suiteFile))
    : undefined;
  const evalCaseIds = suite?.cases.map((evalCase) => evalCase.caseId);
  const { createDatabaseClient, EvaluationRepository } = await import("@repo/db");
  const client = createDatabaseClient({ maxConnections: 1, url: options.databaseUrl });

  try {
    const repository = new EvaluationRepository(client.db);
    const labels = await repository.listEvalHumanLabels({
      ...(options.adjudicationStatus ? { adjudicationStatus: options.adjudicationStatus } : {}),
      ...(options.evalCaseId ? { evalCaseId: options.evalCaseId } : {}),
      ...(evalCaseIds ? { evalCaseIds } : {}),
      ...(options.labelerUserId ? { labelerUserId: options.labelerUserId } : {}),
      limit: options.limit,
    });
    const labelFile = createEvalHumanLabelFile({
      labels: labels.map(evalHumanLabelRowToRecord),
      ...(suite ? { suiteId: suite.suiteId } : {}),
    });

    await ensureParentDirectory(outputPath);
    await writeFile(outputPath, `${JSON.stringify(labelFile, null, 2)}\n`, "utf8");
    process.stdout.write(`Exported ${labelFile.labels.length} human labels to ${outputPath}.\n`);
  } finally {
    await client.close();
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

/** Parses `eval import-case` command options. */
function parseImportCaseOptions(args: readonly string[]): EvalImportCaseCliOptions {
  let suiteFile: string | undefined;
  let caseFile: string | undefined;
  let outputFile: string | undefined;
  let replaceExisting = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--suite-file":
        suiteFile = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--case-file":
        caseFile = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--output-file":
        outputFile = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--replace":
        replaceExisting = true;
        break;
      default:
        throw new Error(`Unknown evaluation import-case option "${arg}".`);
    }
  }

  if (!suiteFile) {
    throw new Error("Missing required --suite-file for eval import-case.");
  }
  if (!caseFile) {
    throw new Error("Missing required --case-file for eval import-case.");
  }

  return {
    caseFile,
    ...(outputFile ? { outputFile } : {}),
    replaceExisting,
    suiteFile,
  };
}

/** Parses `eval import-labels` command options. */
function parseImportLabelsOptions(args: readonly string[]): EvalImportLabelsCliOptions {
  let databaseUrl: string | undefined;
  let labelsFile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--database-url":
        databaseUrl = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--labels-file":
        labelsFile = readOptionValue(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown evaluation import-labels option "${arg}".`);
    }
  }

  if (!databaseUrl) {
    throw new Error("Missing required --database-url for eval import-labels.");
  }
  if (!labelsFile) {
    throw new Error("Missing required --labels-file for eval import-labels.");
  }

  return {
    databaseUrl,
    labelsFile,
  };
}

/** Parses `eval export-labels` command options. */
function parseExportLabelsOptions(args: readonly string[]): EvalExportLabelsCliOptions {
  let adjudicationStatus: string | undefined;
  let databaseUrl: string | undefined;
  let evalCaseId: string | undefined;
  let labelerUserId: string | undefined;
  let limit = 1000;
  let outputFile: string | undefined;
  let suiteFile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--database-url":
        databaseUrl = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--output-file":
        outputFile = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--suite-file":
        suiteFile = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--case-id":
        evalCaseId = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--status":
        adjudicationStatus = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--labeler-user-id":
        labelerUserId = readOptionValue(args, index, arg);
        index += 1;
        break;
      case "--limit":
        limit = parsePositiveInteger(readOptionValue(args, index, arg), arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown evaluation export-labels option "${arg}".`);
    }
  }

  if (!databaseUrl) {
    throw new Error("Missing required --database-url for eval export-labels.");
  }
  if (!outputFile) {
    throw new Error("Missing required --output-file for eval export-labels.");
  }

  return {
    ...(adjudicationStatus ? { adjudicationStatus } : {}),
    databaseUrl,
    ...(evalCaseId ? { evalCaseId } : {}),
    ...(labelerUserId ? { labelerUserId } : {}),
    limit,
    outputFile,
    ...(suiteFile ? { suiteFile } : {}),
  };
}

/** Converts a portable human-label record into an eval DB insert row. */
function evalHumanLabelRecordToDbInsert(record: EvalHumanLabelRecord): {
  readonly adjudicationStatus: string;
  readonly createdAt?: Date;
  readonly evalCaseId: string;
  readonly evalHumanLabelId: string;
  readonly findingFingerprint?: string;
  readonly label: EvalHumanLabelRecord["label"];
  readonly labelerUserId?: string;
  readonly updatedAt?: Date;
} {
  return {
    adjudicationStatus: record.adjudicationStatus,
    ...(record.createdAt ? { createdAt: parseCliDate(record.createdAt, "createdAt") } : {}),
    evalCaseId: record.evalCaseId,
    evalHumanLabelId: record.evalHumanLabelId,
    ...(record.findingFingerprint ? { findingFingerprint: record.findingFingerprint } : {}),
    label: record.label,
    ...(record.labelerUserId ? { labelerUserId: record.labelerUserId } : {}),
    ...(record.updatedAt ? { updatedAt: parseCliDate(record.updatedAt, "updatedAt") } : {}),
  };
}

/** Converts a DB human-label row into a portable export record. */
function evalHumanLabelRowToRecord(row: EvalHumanLabelRow): EvalHumanLabelRecord {
  return {
    adjudicationStatus: row.adjudicationStatus as EvalHumanLabelRecord["adjudicationStatus"],
    createdAt: row.createdAt.toISOString(),
    evalCaseId: row.evalCaseId,
    evalHumanLabelId: row.evalHumanLabelId,
    ...(row.findingFingerprint ? { findingFingerprint: row.findingFingerprint } : {}),
    label: parseEvalHumanFindingLabel(row.label),
    ...(row.labelerUserId ? { labelerUserId: row.labelerUserId } : {}),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Parses a positive integer CLI value. */
function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return parsed;
}

/** Parses a timestamp from a CLI label file. */
function parseCliDate(value: string, fieldName: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid timestamp.`);
  }

  return date;
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
