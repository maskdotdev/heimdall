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

/** Redacts a command for product-safe logs. */
export function redactedDisplayCommand(command: ToolCommandSpec): string {
  return command.displayCommand
    .replace(/(token|secret|password|key)=\S+/giu, "$1=<redacted>")
    .replace(/--(token|secret|password|key)\s+\S+/giu, "--$1 <redacted>");
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
