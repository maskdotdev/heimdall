import { describe, expect, it } from "vitest";
import {
  createDefaultSandboxEnvironment,
  createFakeSandboxRunner,
  createLocalProcessSandboxRunner,
  DEFAULT_SANDBOX_ARTIFACT_POLICY,
  DEFAULT_SANDBOX_NETWORK_POLICY,
  DEFAULT_SANDBOX_OUTPUT_POLICY,
  DEFAULT_SANDBOX_RESOURCE_LIMITS,
  DEFAULT_SANDBOX_SECURITY_POLICY,
  evaluateSandboxRequestSafety,
  parseSandboxRunRequest,
  parseSandboxRunResult,
  type SandboxRunRequest,
} from "../src/index";

describe("sandbox contracts", () => {
  it("parses a valid v1 sandbox request", () => {
    const request = createRequest();

    expect(parseSandboxRunRequest(request)).toEqual(request);
  });

  it("rejects shell command requests at the boundary", () => {
    const request = createRequest();
    const unsafeRequest = {
      ...request,
      command: {
        ...request.command,
        shell: true,
      },
    };

    expect(() => parseSandboxRunRequest(unsafeRequest)).toThrow();
  });

  it("detects baseline unsafe mounts before execution", () => {
    const request = createRequest({
      mounts: [
        {
          purpose: "workspace",
          readOnly: true,
          source: "/var/run/docker.sock",
          target: "/workspace",
          type: "bind",
        },
      ],
    });

    expect(evaluateSandboxRequestSafety(request)).toContainEqual({
      code: "docker_socket_mount_denied",
      message: "Sandbox requests must not mount the Docker socket.",
      status: "denied",
    });
  });
});

describe("FakeSandboxRunner", () => {
  it("redacts configured secrets and validates the result schema", async () => {
    const request = createRequest({
      environment: createDefaultSandboxEnvironment(["SECRET_VALUE"]),
      output: {
        ...DEFAULT_SANDBOX_OUTPUT_POLICY,
        maxStdoutBytes: 512,
      },
    });
    request.environment.env.SECRET_VALUE = "top-secret";
    const runner = createFakeSandboxRunner([
      {
        executable: "eslint",
        stdout: "token=abc123 SECRET_VALUE=top-secret",
      },
    ]);

    const result = await runner.run(request);

    expect(result.status).toBe("succeeded");
    expect(result.stdout.redacted).toBe(true);
    expect(result.stdout.text).toContain("<redacted>");
    expect(result.stdout.text).not.toContain("abc123");
    expect(result.stdout.text).not.toContain("top-secret");
    expect(parseSandboxRunResult(result)).toEqual(result);
  });

  it("truncates fake output by the request output budget", async () => {
    const request = createRequest({
      limits: {
        ...DEFAULT_SANDBOX_RESOURCE_LIMITS,
        maxStdoutBytes: 12,
      },
      output: {
        ...DEFAULT_SANDBOX_OUTPUT_POLICY,
        maxStdoutBytes: 12,
        truncateStrategy: "head",
      },
    });
    const runner = createFakeSandboxRunner([
      {
        executable: "eslint",
        stdout: "abcdefghijklmnopqrstuvwxyz",
      },
    ]);

    const result = await runner.run(request);

    expect(result.stdout.truncated).toBe(true);
    expect(result.stdout.bytes).toBeLessThanOrEqual(12);
    expect(result.stdout.text).toBe("abcdefghijkl");
  });

  it("returns policy_denied when baseline safety checks fail", async () => {
    const request = createRequest({
      image: {
        allowedImageClass: "blocked",
        image: "customer/image:latest",
        pullPolicy: "always",
      },
    });
    const runner = createFakeSandboxRunner();

    const result = await runner.run(request);

    expect(result.status).toBe("policy_denied");
    expect(result.exitCode).toBeNull();
    expect(result.error?.code).toBe("image_class_blocked");
  });
});

describe("LocalProcessSandboxRunner", () => {
  it("runs local fixture commands with explicit environment and bounded output", async () => {
    const runner = createLocalProcessSandboxRunner({ nodeEnv: "test" });
    const request = createLocalProcessRequest({
      command: {
        argv: [
          process.execPath,
          "-e",
          'process.stdout.write((process.env.SANDBOX_TEST_VALUE ?? "") + ":abcdef");',
        ],
        expectedExitCodes: [0],
        shell: false,
        stdin: "none",
        workingDirectory: "/workspace",
      },
      environment: {
        env: { SANDBOX_TEST_VALUE: "ok" },
        inheritHostEnv: false,
        redactedEnvKeys: [],
      },
      output: {
        ...DEFAULT_SANDBOX_OUTPUT_POLICY,
        maxStdoutBytes: 5,
        truncateStrategy: "head",
      },
    });

    const result = await runner.run(request);

    expect(result.status).toBe("succeeded");
    expect(result.runner.kind).toBe("local_process");
    expect(result.stdout.text).toBe("ok:ab");
    expect(result.stdout.truncated).toBe(true);
    expect(result.policyDecisions).toContainEqual({
      code: "local_process_runner_unsafe",
      message: "Local process sandbox runner is unsafe and allowed only for local development.",
      status: "warning",
    });
  });

  it("marks local fixture commands as timed out when they exceed the limit", async () => {
    const runner = createLocalProcessSandboxRunner({ nodeEnv: "test", timeoutKillGraceMs: 10 });
    const result = await runner.run(
      createLocalProcessRequest({
        command: {
          argv: [process.execPath, "-e", "setTimeout(() => {}, 5_000);"],
          expectedExitCodes: [0],
          shell: false,
          stdin: "none",
          workingDirectory: "/workspace",
        },
        limits: {
          ...DEFAULT_SANDBOX_RESOURCE_LIMITS,
          timeoutMs: 25,
        },
      }),
    );

    expect(result.status).toBe("timed_out");
    expect(result.exitCode).toBeNull();
  });

  it("denies local fixture commands whose working directory is outside bind mounts", async () => {
    const runner = createLocalProcessSandboxRunner({ nodeEnv: "test" });
    const result = await runner.run(
      createLocalProcessRequest({
        command: {
          argv: [process.execPath, "-e", 'process.stdout.write("nope");'],
          expectedExitCodes: [0],
          shell: false,
          stdin: "none",
          workingDirectory: "/outside",
        },
      }),
    );

    expect(result.status).toBe("policy_denied");
    expect(result.error?.code).toBe("working_directory_outside_mount");
  });

  it("rejects local process runner construction in production", () => {
    expect(() => createLocalProcessSandboxRunner({ nodeEnv: "production" })).toThrow(
      "local_process sandbox runner is forbidden in production.",
    );
  });
});

/** Creates a valid sandbox request fixture with optional overrides. */
function createRequest(overrides: Partial<SandboxRunRequest> = {}): SandboxRunRequest {
  return {
    artifacts: {
      ...DEFAULT_SANDBOX_ARTIFACT_POLICY,
      collectFiles: [...DEFAULT_SANDBOX_ARTIFACT_POLICY.collectFiles],
    },
    category: "lint",
    command: {
      argv: ["eslint", "src/example.ts", "--format", "json"],
      expectedExitCodes: [0, 1],
      shell: false,
      stdin: "none",
      workingDirectory: "/workspace",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    environment: createDefaultSandboxEnvironment(),
    image: {
      allowedImageClass: "first_party_static_tools",
      digest: "sha256:abc123",
      image: "reviewer-tools-node",
      pullPolicy: "never",
    },
    limits: { ...DEFAULT_SANDBOX_RESOURCE_LIMITS },
    mounts: [
      {
        purpose: "workspace",
        readOnly: true,
        source: "/tmp/workspace",
        target: "/workspace",
        type: "bind",
      },
    ],
    network: { ...DEFAULT_SANDBOX_NETWORK_POLICY },
    orgId: "org_123",
    output: { ...DEFAULT_SANDBOX_OUTPUT_POLICY },
    repoId: "repo_123",
    requestId: "sandbox_request_123",
    schemaVersion: "sandbox_run_request.v1",
    security: {
      ...DEFAULT_SANDBOX_SECURITY_POLICY,
      allowedCapabilities: [],
    },
    trustLevel: "trusted_pr",
    workspace: {
      allowedWritePaths: ["/tmp", "/out"],
      commitSha: "abc123",
      mode: "read_only",
      mountPath: "/workspace",
      workspaceId: "workspace_123",
      workspacePath: "/tmp/workspace",
    },
    ...overrides,
  };
}

/** Creates a sandbox request that can execute as a local process in tests. */
function createLocalProcessRequest(overrides: Partial<SandboxRunRequest> = {}): SandboxRunRequest {
  return createRequest({
    command: {
      argv: [process.execPath, "-e", 'process.stdout.write("ok");'],
      expectedExitCodes: [0],
      shell: false,
      stdin: "none",
      workingDirectory: "/workspace",
    },
    image: {
      allowedImageClass: "first_party_static_tools",
      image: "local-process-test",
      pullPolicy: "never",
    },
    limits: {
      ...DEFAULT_SANDBOX_RESOURCE_LIMITS,
      timeoutMs: 1_000,
    },
    mounts: [
      {
        purpose: "workspace",
        readOnly: true,
        source: process.cwd(),
        target: "/workspace",
        type: "bind",
      },
    ],
    output: {
      ...DEFAULT_SANDBOX_OUTPUT_POLICY,
      maxStderrBytes: 1_000,
      maxStdoutBytes: 1_000,
      truncateStrategy: "head",
    },
    ...overrides,
  });
}
