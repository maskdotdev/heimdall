import { spawn } from "node:child_process";

/** Command network access policy. */
export type ToolNetworkPolicy = "none" | "metadata_only" | "allow";

/** Command filesystem access policy. */
export type ToolFilesystemPolicy = "read_only" | "read_write_tmp";

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
