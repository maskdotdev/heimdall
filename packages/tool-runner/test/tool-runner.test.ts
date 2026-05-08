import { createFakeSandboxRunner, type SandboxRunner, type SandboxRunRequest } from "@repo/sandbox";
import { describe, expect, it } from "vitest";
import {
  createFakeToolRunner,
  createLocalToolRunner,
  createSandboxToolRunner,
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

  it("runs sandbox commands through a sandbox runner and maps output", async () => {
    const capturedRequests: SandboxRunRequest[] = [];
    const fakeRunner = createFakeSandboxRunner([
      { executable: "eslint", stderr: "warn", stdout: "[]" },
    ]);
    const sandboxRunner: SandboxRunner = {
      run: async (request) => {
        capturedRequests.push(request);
        return fakeRunner.run(request);
      },
    };
    const runner = createSandboxToolRunner({
      commitSha: "abc123",
      orgId: "org_1",
      repoId: "repo_1",
      reviewRunId: "rrn_1",
      runner: sandboxRunner,
      staticAnalysisRunId: "star_1",
      workspaceId: "ws_1",
    });

    const result = await runner.run({
      command,
      maxOutputBytes: 1_000,
      planId: "plan_sandbox",
      startedAt: "2026-05-06T00:00:00.000Z",
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      status: "succeeded",
      stderr: "warn",
      stdout: "[]",
      truncated: false,
    });
    const request = capturedRequests[0];
    expect(request).toBeDefined();
    if (!request) throw new Error("Expected the sandbox request to be captured.");
    expect(request).toMatchObject({
      category: "lint",
      command: {
        argv: ["eslint", "--format", "json"],
        expectedExitCodes: [0, 1],
        shell: false,
        stdin: "none",
        workingDirectory: "/workspace",
      },
      environment: {
        inheritHostEnv: false,
      },
      orgId: "org_1",
      repoId: "repo_1",
      reviewRunId: "rrn_1",
      schemaVersion: "sandbox_run_request.v1",
      staticAnalysisRunId: "star_1",
      toolRunId: "plan_sandbox",
      workspace: {
        commitSha: "abc123",
        mode: "read_only",
        mountPath: "/workspace",
        workspaceId: "ws_1",
        workspacePath: "/workspace/repo",
      },
    });
    expect(request.network.blockMetadataEndpoints).toBe(true);
    expect(request.network.blockPrivateNetworks).toBe(true);
    expect(request.output.maxStdoutBytes).toBe(1_000);
    expect(request.security.noNewPrivileges).toBe(true);
  });

  it("maps sandbox timeouts to tool timeouts", async () => {
    const runner = createSandboxToolRunner({
      commitSha: "abc123",
      orgId: "org_1",
      repoId: "repo_1",
      runner: createFakeSandboxRunner([
        {
          executable: "eslint",
          exitCode: null,
          status: "timed_out",
        },
      ]),
    });

    const result = await runner.run({
      command,
      maxOutputBytes: 1_000,
      planId: "plan_sandbox_timeout",
      startedAt: "2026-05-06T00:00:00.000Z",
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      exitCode: null,
      status: "timed_out",
      timedOut: true,
    });
  });

  it("maps mypy sandbox commands to type-check execution", async () => {
    const capturedRequests: SandboxRunRequest[] = [];
    const fakeRunner = createFakeSandboxRunner([{ executable: "mypy", stdout: "" }]);
    const sandboxRunner: SandboxRunner = {
      run: async (request) => {
        capturedRequests.push(request);
        return fakeRunner.run(request);
      },
    };
    const runner = createSandboxToolRunner({
      commitSha: "abc123",
      orgId: "org_1",
      repoId: "repo_1",
      runner: sandboxRunner,
    });

    await runner.run({
      command: {
        ...command,
        args: ["--show-column-numbers", "src/app.py"],
        displayCommand: "mypy --show-column-numbers src/app.py",
        executable: "mypy",
      },
      maxOutputBytes: 1_000,
      planId: "plan_mypy",
      startedAt: "2026-05-06T00:00:00.000Z",
      timeoutMs: 1_000,
    });

    expect(capturedRequests[0]?.category).toBe("type_check");
  });

  it("enforces the shared tool output budget on sandbox streams", async () => {
    const runner = createSandboxToolRunner({
      commitSha: "abc123",
      orgId: "org_1",
      repoId: "repo_1",
      runner: createFakeSandboxRunner([
        {
          executable: "eslint",
          stderr: "efgh",
          stdout: "abcd",
        },
      ]),
    });

    const result = await runner.run({
      command,
      maxOutputBytes: 6,
      planId: "plan_sandbox_truncated",
      startedAt: "2026-05-06T00:00:00.000Z",
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      stderr: "ef",
      stderrBytes: 2,
      stdout: "abcd",
      stdoutBytes: 4,
      truncated: true,
    });
  });
});
