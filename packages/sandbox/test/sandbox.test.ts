import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryAttributeValue,
  type TelemetryMetricRecorder,
  type TelemetrySpanRecorder,
} from "@repo/observability";
import { describe, expect, it } from "vitest";
import {
  buildDockerSandboxCommand,
  createDefaultSandboxEnvironment,
  createDockerContainerSandboxRunner,
  createFakeSandboxRunner,
  createGVisorSandboxRunner,
  createLocalProcessSandboxRunner,
  DEFAULT_SANDBOX_ARTIFACT_POLICY,
  DEFAULT_SANDBOX_NETWORK_POLICY,
  DEFAULT_SANDBOX_OUTPUT_POLICY,
  DEFAULT_SANDBOX_RESOURCE_LIMITS,
  DEFAULT_SANDBOX_SECURITY_POLICY,
  DockerSandboxCommandPolicyError,
  type DockerSandboxProcessExecutorInput,
  evaluateSandboxRequestSafety,
  evaluateToolSandboxPolicy,
  parseSandboxRunRequest,
  parseSandboxRunResult,
  type SandboxRunRequest,
  type ToolSandboxPolicy,
  withSandboxTelemetry,
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

describe("withSandboxTelemetry", () => {
  it("records sandbox run metrics and spans without raw command output or paths", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const runner = withSandboxTelemetry(
      createFakeSandboxRunner([
        {
          artifacts: [
            {
              name: "report.json",
              sha256: "abc123",
              sizeBytes: 42,
              truncated: false,
              uri: "file:///tmp/workspace/report.json",
            },
          ],
          durationMs: 17,
          executable: "eslint",
          resourceUsage: {
            cpuTimeMs: 9,
            peakMemoryBytes: 1_024,
          },
          stderr: "diagnostic details",
          stdout: "raw lint output",
        },
      ]),
      {
        metrics: createRecordingMetrics(metrics),
        traces: createRecordingTraces(spans),
      },
    );

    const result = await runner.run(createRequest());

    expect(metrics).toContainEqual({
      kind: "counter",
      labels: {
        category: "lint",
        runner_kind: "fake",
        status: "succeeded",
        trust_level: "trusted_pr",
      },
      name: OBSERVABILITY_METRIC_NAMES.sandboxRunsTotal,
      value: 1,
    });
    expect(metrics).toContainEqual({
      kind: "histogram",
      labels: {
        category: "lint",
        runner_kind: "fake",
        status: "succeeded",
        trust_level: "trusted_pr",
      },
      name: OBSERVABILITY_METRIC_NAMES.sandboxDurationMs,
      unit: "ms",
      value: 17,
    });
    expect(metrics).toContainEqual({
      kind: "histogram",
      labels: {
        category: "lint",
        runner_kind: "fake",
        status: "succeeded",
        stream: "stdout",
        trust_level: "trusted_pr",
      },
      name: OBSERVABILITY_METRIC_NAMES.sandboxOutputBytes,
      unit: "bytes",
      value: result.stdout.bytes,
    });
    expect(metrics).toContainEqual({
      kind: "histogram",
      labels: {
        category: "lint",
        runner_kind: "fake",
        status: "succeeded",
        trust_level: "trusted_pr",
      },
      name: OBSERVABILITY_METRIC_NAMES.sandboxCpuMs,
      unit: "ms",
      value: 9,
    });
    expect(metrics).toContainEqual({
      kind: "histogram",
      labels: {
        category: "lint",
        runner_kind: "fake",
        status: "succeeded",
        trust_level: "trusted_pr",
      },
      name: OBSERVABILITY_METRIC_NAMES.sandboxMemoryPeakBytes,
      unit: "bytes",
      value: 1_024,
    });
    expect(spans).toContainEqual({
      endAttributes: expect.objectContaining({
        "sandbox.artifact_bytes": 42,
        "sandbox.artifact_count": 1,
        "sandbox.duration_ms": 17,
        "sandbox.runner_kind": "fake",
        "sandbox.status": "succeeded",
        "sandbox.stderr_bytes": result.stderr.bytes,
        "sandbox.stdout_bytes": result.stdout.bytes,
      }),
      name: OBSERVABILITY_SPAN_NAMES.sandboxRun,
      startAttributes: expect.objectContaining({
        "sandbox.category": "lint",
        "sandbox.network_mode": "none",
        "sandbox.trust_level": "trusted_pr",
      }),
      status: "ok",
    });
    const serializedTelemetry = JSON.stringify({ metrics, spans });
    expect(serializedTelemetry).not.toContain("raw lint output");
    expect(serializedTelemetry).not.toContain("diagnostic details");
    expect(serializedTelemetry).not.toContain("/tmp/workspace");
    expect(serializedTelemetry).not.toContain("file:///tmp");
  });

  it("records denied sandbox policy decisions as violation metrics", async () => {
    const metrics: RecordedMetric[] = [];
    const runner = withSandboxTelemetry(createFakeSandboxRunner(), {
      metrics: createRecordingMetrics(metrics),
    });

    const result = await runner.run(
      createRequest({
        image: {
          allowedImageClass: "blocked",
          image: "customer/image:latest",
          pullPolicy: "always",
        },
      }),
    );

    expect(result.status).toBe("policy_denied");
    expect(metrics).toContainEqual({
      kind: "counter",
      labels: {
        category: "lint",
        runner_kind: "fake",
        status: "policy_denied",
        trust_level: "trusted_pr",
        violation_type: "image_class_blocked",
      },
      name: OBSERVABILITY_METRIC_NAMES.sandboxViolationsTotal,
      value: 1,
    });
  });
});

describe("evaluateToolSandboxPolicy", () => {
  it("allows requests that match the tool command, image, path, and limit policy", () => {
    const request = createRequest();
    const result = evaluateToolSandboxPolicy({
      request,
      toolPolicy: createToolPolicy(),
    });

    expect(result.allowed).toBe(true);
    expect(result.decisions.some((decision) => decision.status === "denied")).toBe(false);
  });

  it("denies commands outside the tool allowlist", () => {
    const request = createRequest({
      command: {
        argv: ["npm", "install"],
        expectedExitCodes: [0],
        shell: false,
        stdin: "none",
        workingDirectory: "/workspace",
      },
    });
    const result = evaluateToolSandboxPolicy({
      request,
      toolPolicy: createToolPolicy(),
    });

    expect(result.allowed).toBe(false);
    expect(result.decisions).toContainEqual({
      code: "command_not_allowlisted",
      message: "Sandbox command is not allowlisted for this tool.",
      status: "denied",
    });
  });

  it("denies secret-looking environment variables", () => {
    const request = createRequest({
      environment: {
        env: { NPM_TOKEN: "secret" },
        inheritHostEnv: false,
        redactedEnvKeys: ["NPM_TOKEN"],
      },
    });
    const result = evaluateToolSandboxPolicy({
      request,
      toolPolicy: createToolPolicy(),
    });

    expect(result.allowed).toBe(false);
    expect(result.decisions).toContainEqual({
      code: "secret_environment_denied",
      message: "Secret-looking environment variables must not be passed to sandbox commands.",
      status: "denied",
    });
  });

  it("denies unsafe path arguments and limits above policy maximums", () => {
    const request = createRequest({
      command: {
        argv: ["eslint", "../outside.ts"],
        expectedExitCodes: [0],
        shell: false,
        stdin: "none",
        workingDirectory: "/workspace",
      },
      limits: {
        ...DEFAULT_SANDBOX_RESOURCE_LIMITS,
        maxMemoryBytes: DEFAULT_SANDBOX_RESOURCE_LIMITS.maxMemoryBytes + 1,
      },
    });
    const result = evaluateToolSandboxPolicy({
      request,
      toolPolicy: createToolPolicy(),
    });

    expect(result.allowed).toBe(false);
    expect(result.decisions.map((decision) => decision.code)).toEqual(
      expect.arrayContaining(["resource_limit_exceeds_policy", "unsafe_command_argument"]),
    );
  });
});

describe("buildDockerSandboxCommand", () => {
  it("builds hardened shell-free docker argv data", () => {
    const command = buildDockerSandboxCommand(createRequest(), {
      containerNamePrefix: "heimdall-test",
      dockerExecutable: "docker",
    });

    expect(command.executable).toBe("docker");
    expect(command.args).toEqual(
      expect.arrayContaining([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "65532:65532",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "128",
        "--memory",
        "536870912b",
        "--cpus",
        "1",
        "--workdir",
        "/workspace",
        "reviewer-tools-node@sha256:abc123",
        "eslint",
        "src/example.ts",
        "--format",
        "json",
      ]),
    );
    expect(command.args.some((argument) => argument.startsWith("heimdall-test-run_"))).toBe(true);
    expect(command.args).toContain("type=bind,src=/tmp/workspace,dst=/workspace,readonly");
    expect(command.args).toContain("CI");
    expect(command.env.CI).toBe("true");
    expect(command.displayCommand).not.toContain("top-secret");
  });

  it("keeps docker environment values out of argv", () => {
    const command = buildDockerSandboxCommand(
      createRequest({
        environment: {
          env: { SECRET_VALUE: "top-secret" },
          inheritHostEnv: false,
          redactedEnvKeys: ["SECRET_VALUE"],
        },
      }),
    );

    expect(command.args).toContain("SECRET_VALUE");
    expect(command.args).not.toContain("top-secret");
    expect(command.env.SECRET_VALUE).toBe("top-secret");
    expect(command.displayCommand).not.toContain("top-secret");
  });

  it("rejects docker commands for unsupported network policies", () => {
    const request = createRequest({
      network: {
        ...DEFAULT_SANDBOX_NETWORK_POLICY,
        allowedHosts: ["example.com"],
        allowedPorts: [443],
        mode: "allowlist",
      },
    });

    try {
      buildDockerSandboxCommand(request);
      throw new Error("Expected Docker command builder to reject the request.");
    } catch (error) {
      expect(error).toBeInstanceOf(DockerSandboxCommandPolicyError);
      const policyError = error as DockerSandboxCommandPolicyError;
      expect(policyError.decisions).toContainEqual({
        code: "docker_network_policy_unsupported",
        message: "Docker sandbox command builder only supports no-network requests.",
        status: "denied",
      });
    }
  });
});

describe("DockerContainerSandboxRunner", () => {
  it("runs through an injected executor and collects declared artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "heimdall-docker-runner-test-"));
    const artifactRoot = join(root, "artifacts");
    const temporaryRoot = join(root, "tmp");
    let observedInput: DockerSandboxProcessExecutorInput | undefined;
    let outputSource: string | undefined;

    try {
      const runner = createDockerContainerSandboxRunner({
        artifactRoot,
        dockerProcessEnv: { PATH: "/usr/bin" },
        executor: async (input) => {
          observedInput = input;
          const outputMount = input.request.mounts.find((mount) => mount.purpose === "output");
          if (!outputMount) {
            throw new Error("Expected Docker runner to materialize an output mount.");
          }
          outputSource = outputMount.source;
          await mkdir(outputMount.source, { recursive: true });
          await writeFile(join(outputMount.source, "report.json"), '{"ok":true}');

          return {
            durationMs: 17,
            exitCode: 0,
            stderr: "debug",
            stdout: "done",
          };
        },
        temporaryRoot,
      });
      const result = await runner.run(
        createRequest({
          mounts: [
            {
              purpose: "workspace",
              readOnly: true,
              source: "/tmp/workspace",
              target: "/workspace",
              type: "bind",
            },
            {
              purpose: "output",
              readOnly: false,
              source: "tmpfs",
              target: "/out",
              type: "tmpfs",
            },
          ],
        }),
      );

      expect(result.status).toBe("succeeded");
      expect(result.runner.kind).toBe("docker");
      expect(result.stdout.text).toBe("done");
      expect(result.stderr.text).toBe("debug");
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0]?.name).toBe("report.json");
      expect(await readFile(fileURLToPath(result.artifacts[0]?.uri ?? ""), "utf8")).toBe(
        '{"ok":true}',
      );
      expect(observedInput?.command.env.PATH).toBe("/usr/bin");
      expect(observedInput?.command.args).toContain(`type=bind,src=${outputSource},dst=/out`);
      if (!outputSource) {
        throw new Error("Expected Docker runner executor to observe an output source.");
      }
      await expect(stat(dirname(outputSource))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns policy denied before invoking Docker for unsupported network requests", async () => {
    let called = false;
    const runner = createDockerContainerSandboxRunner({
      executor: async () => {
        called = true;
        return { exitCode: 0 };
      },
    });
    const result = await runner.run(
      createRequest({
        network: {
          ...DEFAULT_SANDBOX_NETWORK_POLICY,
          allowedHosts: ["example.com"],
          allowedPorts: [443],
          mode: "allowlist",
        },
      }),
    );

    expect(called).toBe(false);
    expect(result.status).toBe("policy_denied");
    expect(result.error?.code).toBe("docker_network_policy_unsupported");
  });

  it("skips symlink artifacts that escape the output directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "heimdall-docker-artifact-escape-test-"));
    const outsideDirectory = join(root, "outside");
    const artifactRoot = join(root, "artifacts");
    const temporaryRoot = join(root, "tmp");
    const outsideSecretPath = join(outsideDirectory, "secret.json");

    try {
      await mkdir(outsideDirectory, { recursive: true });
      await writeFile(outsideSecretPath, '{"secret":true}');
      const runner = createDockerContainerSandboxRunner({
        artifactRoot,
        executor: async (input) => {
          const outputMount = input.request.mounts.find((mount) => mount.purpose === "output");
          if (!outputMount) {
            throw new Error("Expected Docker runner to materialize an output mount.");
          }
          await mkdir(outputMount.source, { recursive: true });
          await symlink(outsideSecretPath, join(outputMount.source, "report.json"));

          return {
            exitCode: 0,
            stderr: "",
            stdout: "",
          };
        },
        temporaryRoot,
      });

      const result = await runner.run(createRequest());

      expect(result.status).toBe("succeeded");
      expect(result.artifacts).toEqual([]);
      expect(result.warnings).toContainEqual({
        code: "sandbox_artifact_path_denied",
        message: "Sandbox artifact collection skipped a symlink escape artifact.",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses the gVisor Docker runtime when creating a gVisor runner", async () => {
    const runner = createGVisorSandboxRunner({
      executor: async (input) => {
        expect(input.command.args).toEqual(expect.arrayContaining(["--runtime", "runsc"]));

        return { exitCode: 0 };
      },
    });

    const result = await runner.run(createRequest());

    expect(result.status).toBe("succeeded");
    expect(result.runner.kind).toBe("gvisor");
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

/** Metric record captured by telemetry assertions. */
type RecordedMetric = {
  /** Metric instrument kind. */
  readonly kind: "counter" | "histogram";
  /** Metric labels attached to the record. */
  readonly labels?: Readonly<Record<string, TelemetryAttributeValue | undefined>> | undefined;
  /** Metric name. */
  readonly name: string;
  /** Metric unit. */
  readonly unit?: string | undefined;
  /** Metric value. */
  readonly value: number;
};

/** Span record captured by telemetry assertions. */
type RecordedSpan = {
  /** Span attributes captured when the span ended. */
  readonly endAttributes?:
    | Readonly<Record<string, TelemetryAttributeValue | undefined>>
    | undefined;
  /** Span name. */
  readonly name: string;
  /** Span attributes captured when the span started. */
  readonly startAttributes?:
    | Readonly<Record<string, TelemetryAttributeValue | undefined>>
    | undefined;
  /** Span status. */
  readonly status?: "error" | "ok" | "unset" | undefined;
};

/** Creates a metric recorder that stores metric records in memory. */
function createRecordingMetrics(records: RecordedMetric[]): TelemetryMetricRecorder {
  return {
    count: (name, options) => {
      records.push({
        kind: "counter",
        labels: options?.labels,
        name,
        unit: options?.unit,
        value: options?.value ?? 1,
      });
    },
    gauge: () => undefined,
    histogram: (name, value, options) => {
      records.push({
        kind: "histogram",
        labels: options?.labels,
        name,
        unit: options?.unit,
        value,
      });
    },
  };
}

/** Creates a span recorder that stores span records in memory. */
function createRecordingTraces(records: RecordedSpan[]): TelemetrySpanRecorder {
  return {
    startSpan: (name, options) => ({
      end: (endOptions = {}) => {
        records.push({
          endAttributes: endOptions.attributes,
          name,
          startAttributes: options?.attributes,
          status: endOptions.status,
        });
        return undefined;
      },
    }),
  };
}

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

/** Creates a tool sandbox policy fixture with optional overrides. */
function createToolPolicy(overrides: Partial<ToolSandboxPolicy> = {}): ToolSandboxPolicy {
  return {
    allowDependencyInstall: false,
    allowedCommands: [["eslint"]],
    allowedImages: ["reviewer-tools-node"],
    allowedWritePaths: ["/tmp", "/out"],
    allowNetwork: false,
    allowRepoConfigExecution: true,
    allowShell: false,
    defaultImage: {
      allowedImageClass: "first_party_static_tools",
      image: "reviewer-tools-node",
      pullPolicy: "never",
    },
    defaultLimits: { ...DEFAULT_SANDBOX_RESOURCE_LIMITS },
    maxLimits: { ...DEFAULT_SANDBOX_RESOURCE_LIMITS },
    toolName: "eslint",
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
