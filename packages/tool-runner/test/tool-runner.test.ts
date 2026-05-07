import { describe, expect, it } from "vitest";
import {
  createFakeToolRunner,
  createLocalToolRunner,
  redactedDisplayCommand,
  type ToolCommandSpec,
} from "../src/index";

const command = {
  args: ["--format", "json"],
  cwd: "/workspace/repo",
  displayCommand: "eslint --token abc123 --format json",
  env: {},
  executable: "eslint",
  filesystemPolicy: "read_only",
  networkPolicy: "none",
} satisfies ToolCommandSpec;

/** Creates a local Node command spec for process-backed runner tests. */
const nodeCommand = (script: string, overrides: Partial<ToolCommandSpec> = {}) =>
  ({
    args: ["-e", script],
    cwd: process.cwd(),
    displayCommand: `${process.execPath} -e <script>`,
    env: {},
    executable: process.execPath,
    filesystemPolicy: "read_only",
    networkPolicy: "none",
    ...overrides,
  }) satisfies ToolCommandSpec;

describe("tool runner", () => {
  it("returns deterministic fake output and truncates by byte budget", async () => {
    const runner = createFakeToolRunner([{ executable: "eslint", stdout: "abcdef", exitCode: 0 }]);
    const result = await runner.run({
      command,
      maxOutputBytes: 3,
      planId: "plan_1",
      startedAt: "2026-05-06T00:00:00.000Z",
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "abc",
      stdoutBytes: 3,
      truncated: true,
    });
  });

  it("redacts sensitive display command flags", () => {
    expect(redactedDisplayCommand(command)).toBe("eslint --token <redacted> --format json");
  });

  it("runs local shell-free commands with explicit environment", async () => {
    const runner = createLocalToolRunner();
    const result = await runner.run({
      command: nodeCommand('process.stdout.write(process.env.HEIMDALL_TOOL_RUNNER_TEST ?? "");', {
        env: { HEIMDALL_TOOL_RUNNER_TEST: "available" },
      }),
      maxOutputBytes: 1_000,
      planId: "plan_local_success",
      startedAt: "2026-05-06T00:00:00.000Z",
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      status: "succeeded",
      stdout: "available",
      stdoutBytes: 9,
      timedOut: false,
      truncated: false,
    });
  });

  it("bounds local command output across captured streams", async () => {
    const runner = createLocalToolRunner();
    const result = await runner.run({
      command: nodeCommand('process.stdout.write("abcdef");'),
      maxOutputBytes: 3,
      planId: "plan_local_truncated",
      startedAt: "2026-05-06T00:00:00.000Z",
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      stdout: "abc",
      stdoutBytes: 3,
      truncated: true,
    });
  });

  it("marks local commands as timed out when the process exceeds the budget", async () => {
    const runner = createLocalToolRunner({ timeoutKillGraceMs: 10 });
    const result = await runner.run({
      command: nodeCommand("setTimeout(() => {}, 5_000);"),
      maxOutputBytes: 1_000,
      planId: "plan_local_timeout",
      startedAt: "2026-05-06T00:00:00.000Z",
      timeoutMs: 25,
    });

    expect(result).toMatchObject({
      status: "timed_out",
      timedOut: true,
    });
  });

  it("normalizes local spawn failures into failed results", async () => {
    const runner = createLocalToolRunner();
    const result = await runner.run({
      command: {
        ...command,
        args: [],
        cwd: process.cwd(),
        displayCommand: "/does/not/exist",
        executable: "/does/not/exist",
      },
      maxOutputBytes: 1_000,
      planId: "plan_local_missing",
      startedAt: "2026-05-06T00:00:00.000Z",
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      exitCode: null,
      status: "failed",
    });
    expect(result.stderr).toContain("Failed to start command:");
  });
});
