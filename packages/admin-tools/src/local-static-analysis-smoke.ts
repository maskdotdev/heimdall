import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import type { ChangedFile, PullRequestSnapshot } from "@repo/contracts";
import {
  runStaticAnalysis,
  type StaticAnalysisReport,
  type StaticAnalysisRequest,
  type StaticToolName,
} from "@repo/static-analysis";
import { createLocalToolRunner, type ToolRunnerResult } from "@repo/tool-runner";

/** Default Staticcheck package used when the smoke bootstraps a local binary. */
const DEFAULT_STATICCHECK_BOOTSTRAP_PACKAGE = "honnef.co/go/tools/cmd/staticcheck@v0.7.0";

/** Product-safe proof emitted by the local static-analysis smoke. */
type LocalStaticAnalysisSmokeProof = {
  /** Go static-analysis proof summary. */
  readonly go: LanguageSmokeProof;
  /** Rust static-analysis proof summary. */
  readonly rust: LanguageSmokeProof;
  /** Status of the smoke run. */
  readonly status: "passed";
  /** Toolchain versions observed by the smoke when available. */
  readonly toolchain: {
    /** Go version string from the report environment. */
    readonly go: "available";
    /** Cargo version string from the report environment. */
    readonly cargo: "available";
    /** Staticcheck availability or bootstrap status for this smoke run. */
    readonly staticcheck: StaticcheckSmokeProof;
  };
};

/** Product-safe Staticcheck availability proof. */
type StaticcheckSmokeProof = {
  /** How Staticcheck was made available to the smoke. */
  readonly mode: "available" | "bootstrapped" | "not_requested";
  /** Staticcheck version output when the smoke used Staticcheck. */
  readonly version?: string | undefined;
};

/** Product-safe proof for one language smoke report. */
type LanguageSmokeProof = {
  /** Static-analysis report status. */
  readonly reportStatus: StaticAnalysisReport["status"];
  /** Number of normalized diagnostics parsed from live tool output. */
  readonly diagnosticCount: number;
  /** New diagnostic count after report construction. */
  readonly newDiagnosticCount: number;
  /** Tool summaries emitted by the report. */
  readonly tools: readonly ToolSmokeProof[];
};

/** Product-safe proof for one static-analysis tool run. */
type ToolSmokeProof = {
  /** Number of normalized diagnostics attributed to the tool. */
  readonly diagnosticCount: number;
  /** Process exit code, when available. */
  readonly exitCode: number | null;
  /** Tool run status. */
  readonly status: StaticAnalysisReport["toolRuns"][number]["status"];
  /** Static-analysis tool name. */
  readonly tool: StaticToolName;
};

/** Parsed options for the local static-analysis smoke. */
type LocalStaticAnalysisSmokeOptions = {
  /** Whether the Go smoke should include Staticcheck. */
  readonly includeStaticcheck: boolean;
  /** Whether the smoke may install Staticcheck into the throwaway workspace. */
  readonly bootstrapStaticcheck: boolean;
  /** Go package reference used for Staticcheck bootstrap. */
  readonly staticcheckPackage: string;
};

/** Resolved Staticcheck setup for one smoke run. */
type StaticcheckSetup = {
  /** Optional binary directory that should be prepended to PATH. */
  readonly pathEntry?: string | undefined;
  /** Product-safe proof for the setup decision. */
  readonly proof: StaticcheckSmokeProof;
};

/** Local process environment settings for smoke tool runners. */
type LocalSmokeBaseEnvInput = {
  /** Optional throwaway root to use for cache and home directories. */
  readonly cacheRoot?: string | undefined;
  /** Optional binary directory that should be prepended to PATH. */
  readonly pathEntry?: string | undefined;
};

/** Runs local Go and Rust static-analysis tools against generated throwaway projects. */
async function main(): Promise<void> {
  const options = smokeOptions(process.argv.slice(2), process.env);
  const root = await mkdtemp(join(tmpdir(), "heimdall-static-analysis-smoke-"));

  try {
    const goWorkspace = join(root, "go");
    const rustWorkspace = join(root, "rust");
    await Promise.all([writeGoFixture(goWorkspace), writeRustFixture(rustWorkspace)]);

    const staticcheck = await prepareStaticcheck(options, root);
    const goTools: readonly StaticToolName[] =
      staticcheck.proof.mode === "not_requested" ? ["go_vet"] : ["go_vet", "staticcheck"];
    const goRunner = createLocalToolRunner({
      baseEnv: localSmokeBaseEnv({ cacheRoot: root, pathEntry: staticcheck.pathEntry }),
    });
    const rustRunner = createLocalToolRunner({
      baseEnv: localSmokeBaseEnv({ pathEntry: undefined }),
    });
    const [goReport, rustReport] = await Promise.all([
      runStaticAnalysis({
        request: smokeRequest({
          changedFile: changedFile("pkg/foo.go", "go", 6),
          repoId: "repo_static_smoke_go",
          requestedTools: goTools,
          reviewRunId: "rrn_static_smoke_go",
          workspacePath: goWorkspace,
        }),
        runner: goRunner,
      }),
      runStaticAnalysis({
        request: smokeRequest({
          changedFile: changedFile("src/lib.rs", "rust", 2),
          repoId: "repo_static_smoke_rust",
          requestedTools: ["cargo_check", "cargo_clippy"],
          reviewRunId: "rrn_static_smoke_rust",
          workspacePath: rustWorkspace,
        }),
        runner: rustRunner,
      }),
    ]);

    assertSmokeReport("go", goReport, goTools);
    assertSmokeReport("rust", rustReport, ["cargo_check", "cargo_clippy"]);

    const proof: LocalStaticAnalysisSmokeProof = {
      go: languageProof(goReport),
      rust: languageProof(rustReport),
      status: "passed",
      toolchain: {
        cargo: "available",
        go: "available",
        staticcheck: staticcheck.proof,
      },
    };
    console.log(JSON.stringify(proof, null, 2));
  } finally {
    await removeSmokeRoot(root);
  }
}

/** Parses CLI flags and environment variables for local smoke options. */
function smokeOptions(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): LocalStaticAnalysisSmokeOptions {
  return {
    bootstrapStaticcheck:
      args.includes("--bootstrap-staticcheck") ||
      envFlagEnabled(env.HEIMDALL_STATIC_ANALYSIS_SMOKE_BOOTSTRAP_STATICCHECK),
    includeStaticcheck:
      args.includes("--include-staticcheck") ||
      envFlagEnabled(env.HEIMDALL_STATIC_ANALYSIS_SMOKE_INCLUDE_STATICCHECK),
    staticcheckPackage:
      env.HEIMDALL_STATIC_ANALYSIS_SMOKE_STATICCHECK_PACKAGE ??
      DEFAULT_STATICCHECK_BOOTSTRAP_PACKAGE,
  };
}

/** Returns true when an environment flag has an affirmative value. */
function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;

  return ["1", "true", "yes"].includes(value.toLowerCase());
}

/** Resolves Staticcheck availability for a smoke run. */
async function prepareStaticcheck(
  options: LocalStaticAnalysisSmokeOptions,
  root: string,
): Promise<StaticcheckSetup> {
  if (!options.includeStaticcheck) {
    return { proof: { mode: "not_requested" } };
  }

  const existingVersion = await staticcheckVersion({ pathEntry: undefined, root });
  if (existingVersion) {
    return { proof: { mode: "available", version: existingVersion } };
  }

  if (!options.bootstrapStaticcheck) {
    throw new Error(
      "Staticcheck is not available. Install staticcheck or rerun with --bootstrap-staticcheck.",
    );
  }

  const binDir = join(root, "staticcheck-bin");
  await mkdir(binDir, { recursive: true });
  await bootstrapStaticcheck({
    binDir,
    packageRef: options.staticcheckPackage,
    root,
  });

  const version = await staticcheckVersion({ pathEntry: binDir, root });
  if (!version) {
    throw new Error("Bootstrapped Staticcheck did not run successfully.");
  }

  return {
    pathEntry: binDir,
    proof: { mode: "bootstrapped", version },
  };
}

/** Installs Staticcheck into the throwaway smoke workspace. */
async function bootstrapStaticcheck(input: {
  /** Directory that receives the Staticcheck binary. */
  readonly binDir: string;
  /** Staticcheck Go package reference to install. */
  readonly packageRef: string;
  /** Root throwaway workspace for command working directories and caches. */
  readonly root: string;
}): Promise<void> {
  const result = await createLocalToolRunner({
    baseEnv: localSmokeBaseEnv({ cacheRoot: input.root, pathEntry: undefined }),
  }).run({
    command: {
      args: ["install", input.packageRef],
      cwd: input.root,
      displayCommand: `go install ${input.packageRef}`,
      env: {
        GOBIN: input.binDir,
        GOCACHE: join(input.root, "go-build-cache"),
        GOMODCACHE: join(input.root, "go-mod-cache"),
        GOPATH: join(input.root, "go-path"),
      },
      executable: "go",
      filesystemPolicy: "read_write_tmp",
      networkPolicy: "allow",
    },
    maxOutputBytes: 20_000,
    planId: "staticcheck_bootstrap",
    timeoutMs: 180_000,
  });

  if (result.status !== "succeeded" || result.exitCode !== 0) {
    throw new Error(
      `Staticcheck bootstrap failed with status ${result.status} and exit code ${
        result.exitCode ?? "none"
      }: ${compactToolOutput(result)}`,
    );
  }
}

/** Reads the Staticcheck version using the current or bootstrapped PATH. */
async function staticcheckVersion(input: {
  /** Optional binary directory to prepend to PATH. */
  readonly pathEntry?: string | undefined;
  /** Root throwaway workspace used as the command working directory. */
  readonly root: string;
}): Promise<string | null> {
  const result = await createLocalToolRunner({
    baseEnv: localSmokeBaseEnv({ cacheRoot: input.root, pathEntry: input.pathEntry }),
  }).run({
    command: {
      args: ["-version"],
      cwd: input.root,
      displayCommand: "staticcheck -version",
      env: {},
      executable: "staticcheck",
      filesystemPolicy: "read_only",
      networkPolicy: "none",
    },
    maxOutputBytes: 4_000,
    planId: "staticcheck_version",
    timeoutMs: 30_000,
  });

  if (result.status !== "succeeded" || result.exitCode !== 0) {
    return null;
  }

  return firstNonEmptyLine(result.stdout) ?? firstNonEmptyLine(result.stderr) ?? "available";
}

/** Builds the product-safe environment allowlist for local smoke tool runs. */
function localSmokeBaseEnv(input: LocalSmokeBaseEnvInput): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  const path = input.pathEntry ? pathWithPrependedEntry(input.pathEntry) : process.env.PATH;
  if (path && path.length > 0) {
    env.PATH = path;
  }
  if (input.cacheRoot) {
    env.HOME = input.cacheRoot;
    env.XDG_CACHE_HOME = join(input.cacheRoot, "xdg-cache");
  }

  return env;
}

/** Prepends one directory to the current process PATH. */
function pathWithPrependedEntry(pathEntry: string): string {
  const currentPath = process.env.PATH;
  if (!currentPath || currentPath.length === 0) {
    return pathEntry;
  }

  return `${pathEntry}:${currentPath}`;
}

/** Returns the first non-empty line from tool output. */
function firstNonEmptyLine(output: string): string | undefined {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/** Returns a bounded output excerpt for smoke setup failures. */
function compactToolOutput(result: ToolRunnerResult): string {
  const output = [result.stdout.trim(), result.stderr.trim()]
    .filter((stream) => stream.length > 0)
    .join("\n");
  if (output.length === 0) {
    return "no output";
  }

  return output.length > 1_000 ? `${output.slice(0, 1_000)}...` : output;
}

/** Writes a minimal Go module with one vet-detectable issue. */
async function writeGoFixture(workspacePath: string): Promise<void> {
  await mkdir(join(workspacePath, "pkg"), { recursive: true });
  await Promise.all([
    writeFile(
      join(workspacePath, "go.mod"),
      ["module example.com/heimdall-static-smoke", "", "go 1.22", ""].join("\n"),
      "utf8",
    ),
    writeFile(
      join(workspacePath, "pkg/foo.go"),
      [
        "package pkg",
        "",
        'import "fmt"',
        "",
        "func Smoke() {",
        '  fmt.Printf("%d", "text")',
        "}",
        "",
      ].join("\n"),
      "utf8",
    ),
  ]);
}

/** Writes a minimal Rust crate with one compiler warning. */
async function writeRustFixture(workspacePath: string): Promise<void> {
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      join(workspacePath, "Cargo.toml"),
      [
        "[package]",
        'name = "heimdall_static_smoke"',
        'version = "0.1.0"',
        'edition = "2021"',
        "",
        "[lib]",
        'path = "src/lib.rs"',
        "",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      join(workspacePath, "Cargo.lock"),
      [
        "# This file is automatically @generated by Cargo.",
        "# It is not intended for manual editing.",
        "version = 4",
        "",
        "[[package]]",
        'name = "heimdall_static_smoke"',
        'version = "0.1.0"',
        "",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      join(workspacePath, "src/lib.rs"),
      ["pub fn smoke() -> i32 {", "    let value = 1;", "    2", "}", ""].join("\n"),
      "utf8",
    ),
  ]);
}

/** Builds a static-analysis request for one local smoke fixture. */
function smokeRequest(input: {
  /** Changed file used to select static-analysis tools. */
  readonly changedFile: ChangedFile;
  /** Repository ID used for product-safe report IDs. */
  readonly repoId: string;
  /** Tool allowlist for this smoke request. */
  readonly requestedTools: readonly StaticToolName[];
  /** Review run ID used for product-safe report IDs. */
  readonly reviewRunId: string;
  /** Local throwaway workspace path. */
  readonly workspacePath: string;
}): StaticAnalysisRequest {
  return {
    createdAt: "2026-05-08T00:00:00.000Z",
    mode: "changed_files_fast",
    orgId: "org_static_smoke",
    reason: "manual",
    repoId: input.repoId,
    requestedTools: input.requestedTools,
    reviewRunId: input.reviewRunId,
    schemaVersion: "static_analysis_request.v1",
    snapshot: smokeSnapshot(input.repoId, input.changedFile),
    workspace: {
      commitSha: "smoke_head",
      isTrusted: true,
      path: input.workspacePath,
      workspaceId: `ws_${input.repoId}`,
    },
  };
}

/** Builds a minimal pull request snapshot for local static-analysis smoke planning. */
function smokeSnapshot(repoId: string, changedFile: ChangedFile): PullRequestSnapshot {
  return {
    additions: 1,
    authorLogin: "heimdall-smoke",
    baseRef: "main",
    baseSha: "smoke_base",
    changedFileCount: 1,
    changedFiles: [changedFile],
    deletions: 0,
    diffHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    fetchedAt: "2026-05-08T00:00:00.000Z",
    headRef: "heimdall-static-smoke",
    headSha: "smoke_head",
    installationId: "inst_static_smoke",
    isDraft: false,
    labels: [],
    provider: "github",
    providerPullRequestId: "1",
    providerRepoId: "1",
    pullRequestNumber: 1,
    repoId,
    schemaVersion: "pull_request_snapshot.v1",
    snapshotId: `prs_${repoId}`,
    state: "open",
    title: "Static analysis smoke",
  };
}

/** Builds a minimal changed-file record with one added line. */
function changedFile(
  path: string,
  language: ChangedFile["language"],
  changedLine: number,
): ChangedFile {
  return {
    additions: 1,
    changes: 1,
    deletions: 0,
    hunks: [
      {
        header: `@@ -${changedLine},0 +${changedLine},1 @@`,
        hunkId: `hunk_${path.replaceAll(/[^A-Za-z0-9]/gu, "_")}`,
        lines: [{ content: "static analysis smoke", kind: "addition", newLine: changedLine }],
        newLines: 1,
        newStart: changedLine,
        oldLines: 0,
        oldStart: changedLine,
      },
    ],
    isBinary: false,
    isGenerated: false,
    isTest: false,
    language,
    path,
    status: "modified",
  };
}

/** Verifies that the smoke report exercised expected tools and parsed diagnostics. */
function assertSmokeReport(
  language: "go" | "rust",
  report: StaticAnalysisReport,
  expectedTools: readonly StaticToolName[],
): void {
  const observedTools = new Set(report.toolRuns.map((toolRun) => toolRun.tool));
  const missingTools = expectedTools.filter((tool) => !observedTools.has(tool));
  if (missingTools.length > 0) {
    throw new Error(`${language} static-analysis smoke did not run: ${missingTools.join(", ")}`);
  }
  const toolsWithoutDiagnostics = expectedTools.filter(
    (tool) => (report.toolRuns.find((toolRun) => toolRun.tool === tool)?.diagnosticCount ?? 0) < 1,
  );
  if (toolsWithoutDiagnostics.length > 0) {
    throw new Error(
      `${language} static-analysis smoke parsed no diagnostics for: ${toolsWithoutDiagnostics.join(
        ", ",
      )}`,
    );
  }
}

/** Converts a static-analysis report into product-safe smoke proof. */
function languageProof(report: StaticAnalysisReport): LanguageSmokeProof {
  return {
    diagnosticCount: report.summary.diagnosticCount,
    newDiagnosticCount: report.summary.newDiagnosticCount,
    reportStatus: report.status,
    tools: report.toolRuns.map((toolRun) => ({
      diagnosticCount: toolRun.diagnosticCount,
      exitCode: toolRun.exitCode,
      status: toolRun.status,
      tool: toolRun.tool,
    })),
  };
}

/** Removes the throwaway smoke workspace, including read-only Go module cache files. */
async function removeSmokeRoot(root: string): Promise<void> {
  await makeTreeWritable(root);
  await rm(root, { force: true, recursive: true });
}

/** Makes a file tree writable enough for recursive deletion. */
async function makeTreeWritable(path: string): Promise<void> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch {
    return;
  }

  await chmod(path, stats.mode | (stats.isDirectory() ? 0o700 : 0o600)).catch(() => undefined);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return;
  }

  const entries = await readdir(path);
  await Promise.all(entries.map((entry) => makeTreeWritable(join(path, entry))));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : inspect(error));
  process.exitCode = 1;
});
