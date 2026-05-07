import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type {
  SandboxExecutionCategory,
  SandboxImageSpec,
  SandboxNetworkPolicy,
  SandboxRunner,
  SandboxRunRequest,
  SandboxRunResult,
  SandboxTrustLevel,
} from "@repo/sandbox";
import {
  DEFAULT_SANDBOX_ARTIFACT_POLICY,
  DEFAULT_SANDBOX_ENVIRONMENT,
  DEFAULT_SANDBOX_NETWORK_POLICY,
  DEFAULT_SANDBOX_OUTPUT_POLICY,
  DEFAULT_SANDBOX_RESOURCE_LIMITS,
  DEFAULT_SANDBOX_SECURITY_POLICY,
} from "@repo/sandbox";

/** Command network access policy. */
export type ToolNetworkPolicy = "none" | "metadata_only" | "allow";

/** Command filesystem access policy. */
export type ToolFilesystemPolicy = "read_only" | "read_write_tmp";

/** Review-owned sandbox metadata carried by tool executions. */
export type ToolRunnerSandboxContext = {
  /** Organization ID that owns the tool run. */
  readonly orgId: string;
  /** Repository ID that owns the tool run. */
  readonly repoId: string;
  /** Workspace lease ID available to the sandbox runner. */
  readonly workspaceId?: string | undefined;
  /** Review run ID that owns the tool run. */
  readonly reviewRunId?: string | undefined;
  /** Static-analysis run ID that owns the tool run. */
  readonly staticAnalysisRunId?: string | undefined;
  /** Commit SHA checked out in the workspace. */
  readonly commitSha: string;
  /** Optional base commit SHA for pull request analysis. */
  readonly baseSha?: string | undefined;
  /** Optional head commit SHA for pull request analysis. */
  readonly headSha?: string | undefined;
  /** Trust level assigned to the sandbox run. */
  readonly trustLevel?: SandboxTrustLevel | undefined;
};

/** Safe command specification passed to a tool runner. */
export type ToolCommandSpec = {
  /** Executable name or absolute path. */
  readonly executable: string;
  /** Command arguments. */
  readonly args: readonly string[];
  /** Working directory for the command. */
  readonly cwd: string;
  /** Explicit environment allowlist for the command. */
  readonly env: Readonly<Record<string, string>>;
  /** Optional standard input payload. */
  readonly stdin?: string | undefined;
  /** Redacted command string for logs and traces. */
  readonly displayCommand: string;
  /** Network policy requested for execution. */
  readonly networkPolicy: ToolNetworkPolicy;
  /** Filesystem policy requested for execution. */
  readonly filesystemPolicy: ToolFilesystemPolicy;
};

/** Tool runner execution status. */
export type ToolRunnerStatus = "succeeded" | "failed" | "timed_out" | "cancelled";

/** Input for running one planned tool command. */
export type ToolRunnerInput = {
  /** Tool plan ID that owns the command. */
  readonly planId: string;
  /** Command to execute. */
  readonly command: ToolCommandSpec;
  /** Wall-clock timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Maximum captured bytes across stdout and stderr. */
  readonly maxOutputBytes: number;
  /** Optional deterministic start timestamp. */
  readonly startedAt?: string | undefined;
  /** Optional sandbox metadata for runners that delegate to sandbox execution. */
  readonly sandboxContext?: ToolRunnerSandboxContext | undefined;
};

/** Result returned by a tool runner. */
export type ToolRunnerResult = {
  /** Execution status. */
  readonly status: ToolRunnerStatus;
  /** Process exit code when available. */
  readonly exitCode: number | null;
  /** Process signal when available. */
  readonly signal: string | null;
  /** Captured standard output. */
  readonly stdout: string;
  /** Captured standard error. */
  readonly stderr: string;
  /** Captured stdout byte count. */
  readonly stdoutBytes: number;
  /** Captured stderr byte count. */
  readonly stderrBytes: number;
  /** Execution start timestamp. */
  readonly startedAt: string;
  /** Execution finish timestamp. */
  readonly finishedAt: string;
  /** Execution duration in milliseconds. */
  readonly durationMs: number;
  /** Whether timeout ended execution. */
  readonly timedOut: boolean;
  /** Whether output capture was truncated. */
  readonly truncated: boolean;
};

/** Abstraction for bounded tool execution. */
export interface ToolRunner {
  /** Runs one planned command and returns captured output. */
  run(input: ToolRunnerInput): Promise<ToolRunnerResult>;
}

/** Options for the local process-backed tool runner. */
export type LocalToolRunnerOptions = {
  /** Environment variables available to every local tool process. */
  readonly baseEnv?: Readonly<Record<string, string>> | undefined;
  /** Signal used when a tool exceeds its timeout. */
  readonly timeoutSignal?: NodeJS.Signals | undefined;
  /** Grace period before escalating timeout termination to SIGKILL. */
  readonly timeoutKillGraceMs?: number | undefined;
};

/** Options for the sandbox-backed tool runner adapter. */
export type SandboxToolRunnerOptions = {
  /** Sandbox runner implementation that executes translated requests. */
  readonly runner: SandboxRunner;
  /** Default organization ID when input sandbox context omits it. */
  readonly orgId?: string | undefined;
  /** Default repository ID when input sandbox context omits it. */
  readonly repoId?: string | undefined;
  /** Default workspace ID when input sandbox context omits it. */
  readonly workspaceId?: string | undefined;
  /** Default review run ID when input sandbox context omits it. */
  readonly reviewRunId?: string | undefined;
  /** Default static-analysis run ID when input sandbox context omits it. */
  readonly staticAnalysisRunId?: string | undefined;
  /** Default commit SHA when input sandbox context omits it. */
  readonly commitSha?: string | undefined;
  /** Default base commit SHA when input sandbox context omits it. */
  readonly baseSha?: string | undefined;
  /** Default head commit SHA when input sandbox context omits it. */
  readonly headSha?: string | undefined;
  /** Default sandbox trust level. */
  readonly trustLevel?: SandboxTrustLevel | undefined;
  /** Optional sandbox execution category override. */
  readonly category?: SandboxExecutionCategory | undefined;
  /** Optional sandbox image override. */
  readonly image?: SandboxImageSpec | undefined;
  /** Workspace mount path inside the sandbox. */
  readonly mountPath?: string | undefined;
  /** Writable output directory inside the sandbox. */
  readonly outputDirectory?: string | undefined;
  /** Exit codes that the sandbox runner should treat as expected. */
  readonly expectedExitCodes?: readonly number[] | undefined;
};

/** Fixture consumed by the fake tool runner. */
export type FakeToolRunnerFixture = {
  /** Optional plan ID to match. */
  readonly planId?: string | undefined;
  /** Optional executable to match. */
  readonly executable?: string | undefined;
  /** Fake stdout. */
  readonly stdout?: string | undefined;
  /** Fake stderr. */
  readonly stderr?: string | undefined;
  /** Fake exit code. */
  readonly exitCode?: number | null | undefined;
  /** Fake process signal. */
  readonly signal?: string | null | undefined;
  /** Fake execution status. */
  readonly status?: ToolRunnerStatus | undefined;
  /** Fake duration in milliseconds. */
  readonly durationMs?: number | undefined;
};

/** Creates a deterministic fake tool runner for tests and local planning. */
export function createFakeToolRunner(fixtures: readonly FakeToolRunnerFixture[] = []): ToolRunner {
  return {
    run: async (input) => fakeToolRun(input, fixtures),
  };
}

/** Creates a local shell-free process runner for trusted worker environments. */
export function createLocalToolRunner(options: LocalToolRunnerOptions = {}): ToolRunner {
  return {
    run: async (input) => runLocalTool(input, options),
  };
}

/** Creates a sandbox-backed tool runner for isolated static tool execution. */
export function createSandboxToolRunner(options: SandboxToolRunnerOptions): ToolRunner {
  return {
    run: async (input) => runSandboxTool(input, options),
  };
}

/** Redacts a command for product-safe logs. */
export function redactedDisplayCommand(command: ToolCommandSpec): string {
  return command.displayCommand
    .replace(/(token|secret|password|key)=\S+/giu, "$1=<redacted>")
    .replace(/--(token|secret|password|key)\s+\S+/giu, "--$1 <redacted>");
}

/** Runs one command as a local child process with bounded output capture. */
function runLocalTool(
  input: ToolRunnerInput,
  options: LocalToolRunnerOptions,
): Promise<ToolRunnerResult> {
  const startedAt = input.startedAt ?? new Date().toISOString();
  const startedTimeMs = Date.now();
  const output = createOutputCapture(input.maxOutputBytes);
  let timedOut = false;

  return new Promise((resolve) => {
    const child = spawn(input.command.executable, [...input.command.args], {
      cwd: input.command.cwd,
      env: localToolEnvironment(input.command.env, options.baseEnv),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill(options.timeoutSignal ?? "SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, options.timeoutKillGraceMs ?? 1_000);
    }, input.timeoutMs);

    const finish = (status: ToolRunnerStatus, exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const durationMs = Math.max(0, Date.now() - startedTimeMs);
      const finishedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();

      resolve({
        durationMs,
        exitCode,
        finishedAt,
        signal,
        startedAt,
        status,
        stderr: output.stderr(),
        stderrBytes: output.stderrBytes(),
        stdout: output.stdout(),
        stdoutBytes: output.stdoutBytes(),
        timedOut,
        truncated: output.truncated(),
      });
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      output.append("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      output.append("stderr", chunk);
    });
    child.once("error", (error) => {
      output.append("stderr", `Failed to start command: ${error.message}`);
      finish("failed", null, null);
    });
    child.once("close", (exitCode, signal) => {
      const status = timedOut ? "timed_out" : exitCode === 0 ? "succeeded" : "failed";
      finish(status, exitCode, signal);
    });

    if (input.command.stdin !== undefined) {
      child.stdin.end(input.command.stdin);
    } else {
      child.stdin.end();
    }
  });
}

/** Runs one command through the sandbox runner adapter. */
async function runSandboxTool(
  input: ToolRunnerInput,
  options: SandboxToolRunnerOptions,
): Promise<ToolRunnerResult> {
  const request = sandboxRequestFromToolInput(input, options);
  const result = await options.runner.run(request);

  return toolResultFromSandboxResult(input, result);
}

/** Converts generic tool input into a sandbox run request. */
function sandboxRequestFromToolInput(
  input: ToolRunnerInput,
  options: SandboxToolRunnerOptions,
): SandboxRunRequest {
  const createdAt = input.startedAt ?? new Date().toISOString();
  const mountPath = options.mountPath ?? "/workspace";
  const outputDirectory =
    options.outputDirectory ?? DEFAULT_SANDBOX_ARTIFACT_POLICY.outputDirectory;
  const context = resolveSandboxContext(input, options);

  return {
    artifacts: {
      ...DEFAULT_SANDBOX_ARTIFACT_POLICY,
      collectFiles: [...DEFAULT_SANDBOX_ARTIFACT_POLICY.collectFiles],
      outputDirectory,
    },
    category: options.category ?? categoryFromToolCommand(input.command),
    command: {
      argv: [input.command.executable, ...input.command.args],
      expectedExitCodes: [...(options.expectedExitCodes ?? [0, 1])],
      shell: false,
      stdin: sandboxStdin(input.command.stdin),
      ...(input.command.stdin ? { stdinText: input.command.stdin } : {}),
      workingDirectory: mountPath,
    },
    createdAt,
    environment: {
      env: { ...DEFAULT_SANDBOX_ENVIRONMENT, ...input.command.env },
      inheritHostEnv: false,
      redactedEnvKeys: redactedEnvKeys(input.command.env),
    },
    image: options.image ?? DEFAULT_SANDBOX_TOOL_IMAGE,
    limits: {
      ...DEFAULT_SANDBOX_RESOURCE_LIMITS,
      maxStderrBytes: input.maxOutputBytes,
      maxStdoutBytes: input.maxOutputBytes,
      timeoutMs: input.timeoutMs,
    },
    mounts: [
      {
        purpose: "workspace",
        readOnly: true,
        source: input.command.cwd,
        target: mountPath,
        type: "bind",
      },
      {
        purpose: "tmp",
        readOnly: false,
        sizeBytes: DEFAULT_SANDBOX_RESOURCE_LIMITS.maxDiskBytes,
        source: "tmpfs",
        target: "/tmp",
        type: "tmpfs",
      },
      {
        purpose: "output",
        readOnly: false,
        sizeBytes: DEFAULT_SANDBOX_RESOURCE_LIMITS.maxArtifactBytes,
        source: "tmpfs",
        target: outputDirectory,
        type: "tmpfs",
      },
    ],
    network: sandboxNetworkPolicy(input.command.networkPolicy),
    orgId: context.orgId,
    output: {
      ...DEFAULT_SANDBOX_OUTPUT_POLICY,
      maxStderrBytes: input.maxOutputBytes,
      maxStdoutBytes: input.maxOutputBytes,
    },
    repoId: context.repoId,
    requestId: stableToolRunnerId("sbr", [
      input.planId,
      input.command.displayCommand,
      input.command.cwd,
      createdAt,
    ]),
    schemaVersion: "sandbox_run_request.v1",
    security: {
      ...DEFAULT_SANDBOX_SECURITY_POLICY,
      allowedCapabilities: [...DEFAULT_SANDBOX_SECURITY_POLICY.allowedCapabilities],
    },
    toolRunId: input.planId,
    trustLevel: context.trustLevel,
    workspace: {
      allowedWritePaths: ["/tmp", outputDirectory],
      commitSha: context.commitSha,
      mode: "read_only",
      mountPath,
      workspaceId: context.workspaceId,
      workspacePath: input.command.cwd,
      ...(context.baseSha ? { baseSha: context.baseSha } : {}),
      ...(context.headSha ? { headSha: context.headSha } : {}),
    },
    ...(context.reviewRunId ? { reviewRunId: context.reviewRunId } : {}),
    ...(context.staticAnalysisRunId ? { staticAnalysisRunId: context.staticAnalysisRunId } : {}),
  };
}

/** Maps sandbox output and status back to the generic tool runner result. */
function toolResultFromSandboxResult(
  input: ToolRunnerInput,
  result: SandboxRunResult,
): ToolRunnerResult {
  const output = createOutputCapture(input.maxOutputBytes);
  output.append("stdout", result.stdout.text);
  output.append("stderr", result.stderr.text);

  return {
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    finishedAt: result.finishedAt,
    signal: result.signal ?? null,
    startedAt: result.startedAt,
    status: toolStatusFromSandboxStatus(result.status),
    stderr: output.stderr(),
    stderrBytes: output.stderrBytes(),
    stdout: output.stdout(),
    stdoutBytes: output.stdoutBytes(),
    timedOut: result.status === "timed_out",
    truncated: result.stdout.truncated || result.stderr.truncated || output.truncated(),
  };
}

/** Maps sandbox run status values to generic tool runner status values. */
function toolStatusFromSandboxStatus(status: SandboxRunResult["status"]): ToolRunnerStatus {
  if (status === "succeeded") return "succeeded";
  if (status === "timed_out") return "timed_out";
  if (status === "killed") return "cancelled";

  return "failed";
}

/** Runs one fake command fixture. */
function fakeToolRun(
  input: ToolRunnerInput,
  fixtures: readonly FakeToolRunnerFixture[],
): ToolRunnerResult {
  const fixture =
    fixtures.find((item) => item.planId === input.planId) ??
    fixtures.find((item) => item.executable === input.command.executable) ??
    {};
  const stdout = truncate(fixture.stdout ?? "", input.maxOutputBytes);
  const remainingBytes = Math.max(0, input.maxOutputBytes - byteLength(stdout.value));
  const stderr = truncate(fixture.stderr ?? "", remainingBytes);
  const startedAt = input.startedAt ?? "2026-01-01T00:00:00.000Z";
  const durationMs = fixture.durationMs ?? 1;
  const finishedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();
  const status = fixture.status ?? ((fixture.exitCode ?? 0) === 0 ? "succeeded" : "failed");

  return {
    status,
    exitCode: fixture.exitCode ?? (status === "succeeded" ? 0 : 1),
    signal: fixture.signal ?? null,
    stdout: stdout.value,
    stderr: stderr.value,
    stdoutBytes: byteLength(stdout.value),
    stderrBytes: byteLength(stderr.value),
    startedAt,
    finishedAt,
    durationMs,
    timedOut: status === "timed_out",
    truncated: stdout.truncated || stderr.truncated,
  };
}

/** Sandbox image used for first-party static tool execution. */
const DEFAULT_SANDBOX_TOOL_IMAGE = {
  allowedImageClass: "first_party_static_tools",
  image: "heimdall-static-tools:latest",
  pullPolicy: "if_not_present",
} as const satisfies SandboxImageSpec;

/** Fully resolved sandbox context values needed by request translation. */
type ResolvedSandboxContext = {
  /** Organization ID that owns the sandbox run. */
  readonly orgId: string;
  /** Repository ID that owns the sandbox run. */
  readonly repoId: string;
  /** Workspace ID mounted into the sandbox. */
  readonly workspaceId: string;
  /** Optional review run ID that owns the sandbox run. */
  readonly reviewRunId?: string | undefined;
  /** Optional static-analysis run ID that owns the sandbox run. */
  readonly staticAnalysisRunId?: string | undefined;
  /** Commit SHA checked out in the workspace. */
  readonly commitSha: string;
  /** Optional base commit SHA for pull request analysis. */
  readonly baseSha?: string | undefined;
  /** Optional head commit SHA for pull request analysis. */
  readonly headSha?: string | undefined;
  /** Trust level assigned to the sandbox run. */
  readonly trustLevel: SandboxTrustLevel;
};

/** Resolves sandbox context from per-run input and runner defaults. */
function resolveSandboxContext(
  input: ToolRunnerInput,
  options: SandboxToolRunnerOptions,
): ResolvedSandboxContext {
  const context = input.sandboxContext;
  const orgId = requiredSandboxValue("orgId", context?.orgId ?? options.orgId);
  const repoId = requiredSandboxValue("repoId", context?.repoId ?? options.repoId);
  const commitSha = requiredSandboxValue("commitSha", context?.commitSha ?? options.commitSha);
  const workspaceId =
    context?.workspaceId ??
    options.workspaceId ??
    stableToolRunnerId("ws", [repoId, input.command.cwd, commitSha]);

  return {
    orgId,
    repoId,
    workspaceId,
    commitSha,
    trustLevel: context?.trustLevel ?? options.trustLevel ?? "trusted_pr",
    ...((context?.reviewRunId ?? options.reviewRunId)
      ? { reviewRunId: context?.reviewRunId ?? options.reviewRunId }
      : {}),
    ...((context?.staticAnalysisRunId ?? options.staticAnalysisRunId)
      ? { staticAnalysisRunId: context?.staticAnalysisRunId ?? options.staticAnalysisRunId }
      : {}),
    ...((context?.baseSha ?? options.baseSha)
      ? { baseSha: context?.baseSha ?? options.baseSha }
      : {}),
    ...((context?.headSha ?? options.headSha)
      ? { headSha: context?.headSha ?? options.headSha }
      : {}),
  };
}

/** Returns a required non-empty sandbox context value. */
function requiredSandboxValue(name: string, value: string | undefined): string {
  if (value && value.trim().length > 0) {
    return value;
  }

  throw new Error(`Sandbox tool runner requires ${name}.`);
}

/** Maps a tool command executable to a sandbox execution category. */
function categoryFromToolCommand(command: ToolCommandSpec): SandboxExecutionCategory {
  const executable = command.executable.split("/").at(-1) ?? command.executable;
  if (executable === "eslint" || executable === "biome" || executable === "ruff") {
    return "lint";
  }
  if (executable === "tsc" || executable === "typescript" || executable === "pyright") {
    return "type_check";
  }
  if (executable === "semgrep") {
    return "security_scan";
  }

  return "static_tool";
}

/** Maps command network policy to the sandbox network contract. */
function sandboxNetworkPolicy(policy: ToolNetworkPolicy): SandboxNetworkPolicy {
  if (policy === "metadata_only") {
    return {
      ...DEFAULT_SANDBOX_NETWORK_POLICY,
      allowedPorts: [443],
      mode: "allowlist",
    };
  }

  if (policy === "allow") {
    return {
      ...DEFAULT_SANDBOX_NETWORK_POLICY,
      mode: "full_blocked_by_default",
    };
  }

  return { ...DEFAULT_SANDBOX_NETWORK_POLICY };
}

/** Returns the sandbox stdin mode for a tool input payload. */
function sandboxStdin(
  stdin: string | undefined,
): NonNullable<SandboxRunRequest["command"]["stdin"]> {
  if (stdin === undefined) return "none";
  if (stdin.length === 0) return "empty";

  return "provided";
}

/** Returns environment keys whose values should be redacted from sandbox output. */
function redactedEnvKeys(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env).filter((key) => /token|secret|password|key/iu.test(key));
}

/** Creates a deterministic prefixed ID for tool-runner-owned records. */
function stableToolRunnerId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.map((part) => String(part)).join("\0"))
    .digest("base64url")
    .slice(0, 24)}`;
}

/** Truncates text to a byte budget. */
function truncate(
  value: string,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  if (byteLength(value) <= maxBytes) {
    return { value, truncated: false };
  }

  return {
    value: Buffer.from(value).subarray(0, Math.max(0, maxBytes)).toString(),
    truncated: true,
  };
}

/** Returns UTF-8 byte length for a string. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Creates environment variables for local tool execution. */
function localToolEnvironment(
  commandEnv: Readonly<Record<string, string>>,
  baseEnv: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  return {
    ...defaultLocalToolEnvironment(),
    ...baseEnv,
    ...commandEnv,
  };
}

/** Returns the default local environment allowlist. */
function defaultLocalToolEnvironment(): Readonly<Record<string, string>> {
  const path = process.env.PATH;
  if (!path) {
    return {};
  }

  return { PATH: path };
}

/** Stream name captured from a child process. */
type OutputStreamName = "stdout" | "stderr";

/** Bounded child-process output capture state. */
type OutputCapture = {
  /** Appends a chunk to one captured stream while honoring the shared byte budget. */
  readonly append: (stream: OutputStreamName, chunk: Buffer | string) => void;
  /** Returns captured stdout text. */
  readonly stdout: () => string;
  /** Returns captured stderr text. */
  readonly stderr: () => string;
  /** Returns captured stdout bytes. */
  readonly stdoutBytes: () => number;
  /** Returns captured stderr bytes. */
  readonly stderrBytes: () => number;
  /** Returns true when any stream exceeded the shared byte budget. */
  readonly truncated: () => boolean;
};

/** Creates a shared byte-budget output capture for stdout and stderr. */
function createOutputCapture(maxBytes: number): OutputCapture {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let consumedBytes = 0;
  let truncated = false;

  return {
    append: (stream, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remainingBytes = Math.max(0, maxBytes - consumedBytes);
      if (buffer.length === 0) return;
      if (remainingBytes === 0) {
        truncated = true;
        return;
      }

      const captured = buffer.subarray(0, remainingBytes);
      if (captured.length < buffer.length) {
        truncated = true;
      }
      consumedBytes += captured.length;

      if (stream === "stdout") {
        stdout.push(captured);
        stdoutBytes += captured.length;
        return;
      }

      stderr.push(captured);
      stderrBytes += captured.length;
    },
    stderr: () => Buffer.concat(stderr).toString("utf8"),
    stderrBytes: () => stderrBytes,
    stdout: () => Buffer.concat(stdout).toString("utf8"),
    stdoutBytes: () => stdoutBytes,
    truncated: () => truncated,
  };
}
