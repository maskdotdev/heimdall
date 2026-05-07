import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Trust level assigned to a sandbox execution request. */
export const SandboxTrustLevelSchema = Type.Union([
  Type.Literal("metadata_only"),
  Type.Literal("trusted_repo"),
  Type.Literal("trusted_pr"),
  Type.Literal("untrusted_pr"),
  Type.Literal("external_fork"),
  Type.Literal("enterprise_strict"),
]);

/** Trust level assigned to a sandbox execution request. */
export type SandboxTrustLevel = Static<typeof SandboxTrustLevelSchema>;

/** Sandbox command category used by policy and runner selection. */
export const SandboxExecutionCategorySchema = Type.Union([
  Type.Literal("static_tool"),
  Type.Literal("type_check"),
  Type.Literal("lint"),
  Type.Literal("security_scan"),
  Type.Literal("dependency_scan"),
  Type.Literal("test"),
  Type.Literal("custom_command"),
  Type.Literal("indexer_auxiliary"),
]);

/** Sandbox command category used by policy and runner selection. */
export type SandboxExecutionCategory = Static<typeof SandboxExecutionCategorySchema>;

/** Supported sandbox runner implementation kind. */
export const SandboxRunnerKindSchema = Type.Union([
  Type.Literal("fake"),
  Type.Literal("local_process"),
  Type.Literal("docker"),
  Type.Literal("gvisor"),
  Type.Literal("microvm"),
  Type.Literal("remote"),
]);

/** Supported sandbox runner implementation kind. */
export type SandboxRunnerKind = Static<typeof SandboxRunnerKindSchema>;

/** Workspace mount mode for sandbox execution. */
export const SandboxWorkspaceModeSchema = Type.Union([
  Type.Literal("read_only"),
  Type.Literal("copy_on_write"),
  Type.Literal("writable_disposable"),
]);

/** Workspace mount mode for sandbox execution. */
export type SandboxWorkspaceMode = Static<typeof SandboxWorkspaceModeSchema>;

/** Workspace details mounted into a sandbox. */
export const SandboxWorkspaceSpecSchema = Type.Object(
  {
    allowedWritePaths: Type.Array(Type.String({ minLength: 1 })),
    baseSha: Type.Optional(Type.String({ minLength: 1 })),
    commitSha: Type.String({ minLength: 1 }),
    headSha: Type.Optional(Type.String({ minLength: 1 })),
    mode: SandboxWorkspaceModeSchema,
    mountPath: Type.String({ minLength: 1 }),
    workspaceId: Type.String({ minLength: 1 }),
    workspacePath: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Workspace details mounted into a sandbox. */
export type SandboxWorkspaceSpec = Static<typeof SandboxWorkspaceSpecSchema>;

/** Shell-free command specification for sandbox execution. */
export const SandboxCommandSpecSchema = Type.Object(
  {
    argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    expectedExitCodes: Type.Array(Type.Integer(), { minItems: 1 }),
    shell: Type.Literal(false),
    stdin: Type.Optional(
      Type.Union([Type.Literal("none"), Type.Literal("empty"), Type.Literal("provided")]),
    ),
    stdinText: Type.Optional(Type.String()),
    workingDirectory: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Shell-free command specification for sandbox execution. */
export type SandboxCommandSpec = Static<typeof SandboxCommandSpecSchema>;

/** Image class allowed by sandbox policy. */
export const SandboxAllowedImageClassSchema = Type.Union([
  Type.Literal("first_party_static_tools"),
  Type.Literal("first_party_language_tools"),
  Type.Literal("customer_provided"),
  Type.Literal("blocked"),
]);

/** Image class allowed by sandbox policy. */
export type SandboxAllowedImageClass = Static<typeof SandboxAllowedImageClassSchema>;

/** Container image requested for a sandbox run. */
export const SandboxImageSpecSchema = Type.Object(
  {
    allowedImageClass: SandboxAllowedImageClassSchema,
    digest: Type.Optional(Type.String({ minLength: 1 })),
    image: Type.String({ minLength: 1 }),
    pullPolicy: Type.Union([
      Type.Literal("never"),
      Type.Literal("if_not_present"),
      Type.Literal("always"),
    ]),
  },
  { additionalProperties: false },
);

/** Container image requested for a sandbox run. */
export type SandboxImageSpec = Static<typeof SandboxImageSpecSchema>;

/** Explicit sandbox environment specification. */
export const SandboxEnvironmentSpecSchema = Type.Object(
  {
    env: Type.Record(Type.String(), Type.String()),
    inheritHostEnv: Type.Literal(false),
    redactedEnvKeys: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** Explicit sandbox environment specification. */
export type SandboxEnvironmentSpec = Static<typeof SandboxEnvironmentSpecSchema>;

/** Sandbox mount purpose. */
export const SandboxMountPurposeSchema = Type.Union([
  Type.Literal("workspace"),
  Type.Literal("tmp"),
  Type.Literal("cache"),
  Type.Literal("output"),
  Type.Literal("tooling"),
  Type.Literal("none"),
]);

/** Sandbox mount purpose. */
export type SandboxMountPurpose = Static<typeof SandboxMountPurposeSchema>;

/** Mount specification for a sandbox run. */
export const SandboxMountSpecSchema = Type.Object(
  {
    purpose: SandboxMountPurposeSchema,
    readOnly: Type.Boolean(),
    sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    source: Type.String({ minLength: 1 }),
    target: Type.String({ minLength: 1 }),
    type: Type.Union([Type.Literal("bind"), Type.Literal("tmpfs"), Type.Literal("volume")]),
  },
  { additionalProperties: false },
);

/** Mount specification for a sandbox run. */
export type SandboxMountSpec = Static<typeof SandboxMountSpecSchema>;

/** Network access policy for a sandbox run. */
export const SandboxNetworkPolicySchema = Type.Object(
  {
    allowedHosts: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    allowedPorts: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 65_535 }))),
    blockMetadataEndpoints: Type.Boolean(),
    blockPrivateNetworks: Type.Boolean(),
    mode: Type.Union([
      Type.Literal("none"),
      Type.Literal("loopback_only"),
      Type.Literal("allowlist"),
      Type.Literal("full_blocked_by_default"),
    ]),
  },
  { additionalProperties: false },
);

/** Network access policy for a sandbox run. */
export type SandboxNetworkPolicy = Static<typeof SandboxNetworkPolicySchema>;

/** Resource limits for a sandbox run. */
export const SandboxResourceLimitsSchema = Type.Object(
  {
    gracefulShutdownMs: Type.Integer({ minimum: 0 }),
    maxArtifactBytes: Type.Integer({ minimum: 0 }),
    maxCpuCount: Type.Integer({ minimum: 1 }),
    maxDiskBytes: Type.Integer({ minimum: 0 }),
    maxMemoryBytes: Type.Integer({ minimum: 1 }),
    maxPids: Type.Integer({ minimum: 1 }),
    maxStderrBytes: Type.Integer({ minimum: 0 }),
    maxStdoutBytes: Type.Integer({ minimum: 0 }),
    timeoutMs: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

/** Resource limits for a sandbox run. */
export type SandboxResourceLimits = Static<typeof SandboxResourceLimitsSchema>;

/** Security controls required for a sandbox run. */
export const SandboxSecurityPolicySchema = Type.Object(
  {
    allowDeviceMounts: Type.Literal(false),
    allowDockerSocket: Type.Literal(false),
    allowHostIpc: Type.Literal(false),
    allowHostNetwork: Type.Literal(false),
    allowHostPid: Type.Literal(false),
    allowedCapabilities: Type.Array(Type.String({ minLength: 1 })),
    appArmorProfile: Type.Optional(Type.String({ minLength: 1 })),
    dropAllCapabilities: Type.Boolean(),
    noNewPrivileges: Type.Boolean(),
    privileged: Type.Literal(false),
    readOnlyRootFilesystem: Type.Boolean(),
    runAsGroup: Type.Integer({ minimum: 1 }),
    runAsUser: Type.Integer({ minimum: 1 }),
    seccompProfile: Type.Union([
      Type.Literal("runtime_default"),
      Type.Literal("strict"),
      Type.Literal("custom"),
    ]),
    selinuxType: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** Security controls required for a sandbox run. */
export type SandboxSecurityPolicy = Static<typeof SandboxSecurityPolicySchema>;

/** Output capture controls for a sandbox run. */
export const SandboxOutputPolicySchema = Type.Object(
  {
    captureStderr: Type.Boolean(),
    captureStdout: Type.Boolean(),
    maxStderrBytes: Type.Integer({ minimum: 0 }),
    maxStdoutBytes: Type.Integer({ minimum: 0 }),
    normalizeAnsi: Type.Boolean(),
    redactSecrets: Type.Boolean(),
    storeRawOutput: Type.Boolean(),
    truncateStrategy: Type.Union([
      Type.Literal("head"),
      Type.Literal("tail"),
      Type.Literal("head_and_tail"),
    ]),
  },
  { additionalProperties: false },
);

/** Output capture controls for a sandbox run. */
export type SandboxOutputPolicy = Static<typeof SandboxOutputPolicySchema>;

/** Artifact glob collected from sandbox output. */
export const SandboxArtifactGlobSchema = Type.Object(
  {
    pattern: Type.String({ minLength: 1 }),
    required: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Artifact glob collected from sandbox output. */
export type SandboxArtifactGlob = Static<typeof SandboxArtifactGlobSchema>;

/** Artifact capture policy for a sandbox run. */
export const SandboxArtifactPolicySchema = Type.Object(
  {
    collectFiles: Type.Array(SandboxArtifactGlobSchema),
    maxBytesPerFile: Type.Integer({ minimum: 0 }),
    maxFiles: Type.Integer({ minimum: 0 }),
    maxTotalBytes: Type.Integer({ minimum: 0 }),
    outputDirectory: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Artifact capture policy for a sandbox run. */
export type SandboxArtifactPolicy = Static<typeof SandboxArtifactPolicySchema>;

/** Sandbox run request boundary schema. */
export const SandboxRunRequestSchema = Type.Object(
  {
    artifacts: SandboxArtifactPolicySchema,
    category: SandboxExecutionCategorySchema,
    command: SandboxCommandSpecSchema,
    createdAt: Type.String({ minLength: 1 }),
    environment: SandboxEnvironmentSpecSchema,
    expiresAt: Type.Optional(Type.String({ minLength: 1 })),
    image: SandboxImageSpecSchema,
    limits: SandboxResourceLimitsSchema,
    mounts: Type.Array(SandboxMountSpecSchema),
    network: SandboxNetworkPolicySchema,
    orgId: Type.String({ minLength: 1 }),
    output: SandboxOutputPolicySchema,
    repoId: Type.String({ minLength: 1 }),
    requestId: Type.String({ minLength: 1 }),
    reviewRunId: Type.Optional(Type.String({ minLength: 1 })),
    schemaVersion: Type.Literal("sandbox_run_request.v1"),
    security: SandboxSecurityPolicySchema,
    staticAnalysisRunId: Type.Optional(Type.String({ minLength: 1 })),
    toolRunId: Type.Optional(Type.String({ minLength: 1 })),
    trustLevel: SandboxTrustLevelSchema,
    workspace: SandboxWorkspaceSpecSchema,
  },
  { additionalProperties: false },
);

/** Sandbox run request boundary type. */
export type SandboxRunRequest = Static<typeof SandboxRunRequestSchema>;

/** Sandbox run status. */
export const SandboxRunStatusSchema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("timed_out"),
  Type.Literal("killed"),
  Type.Literal("policy_denied"),
  Type.Literal("resource_exceeded"),
  Type.Literal("runner_error"),
]);

/** Sandbox run status. */
export type SandboxRunStatus = Static<typeof SandboxRunStatusSchema>;

/** Captured sandbox output stream. */
export const SandboxCapturedOutputSchema = Type.Object(
  {
    bytes: Type.Integer({ minimum: 0 }),
    hash: Type.String({ minLength: 1 }),
    redacted: Type.Boolean(),
    text: Type.String(),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Captured sandbox output stream. */
export type SandboxCapturedOutput = Static<typeof SandboxCapturedOutputSchema>;

/** Sandbox resource usage summary. */
export const SandboxResourceUsageSchema = Type.Object(
  {
    cpuTimeMs: Type.Optional(Type.Integer({ minimum: 0 })),
    diskWrittenBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    networkRxBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    networkTxBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    pidsPeak: Type.Optional(Type.Integer({ minimum: 0 })),
    peakMemoryBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

/** Sandbox resource usage summary. */
export type SandboxResourceUsage = Static<typeof SandboxResourceUsageSchema>;

/** Artifact captured from a sandbox run. */
export const SandboxRunArtifactSchema = Type.Object(
  {
    contentType: Type.Optional(Type.String({ minLength: 1 })),
    name: Type.String({ minLength: 1 }),
    sha256: Type.String({ minLength: 1 }),
    sizeBytes: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
    uri: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Artifact captured from a sandbox run. */
export type SandboxRunArtifact = Static<typeof SandboxRunArtifactSchema>;

/** Runner metadata attached to sandbox results. */
export const SandboxRunnerInfoSchema = Type.Object(
  {
    isolation: Type.String({ minLength: 1 }),
    kind: SandboxRunnerKindSchema,
    name: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Runner metadata attached to sandbox results. */
export type SandboxRunnerInfo = Static<typeof SandboxRunnerInfoSchema>;

/** Policy decision status. */
export const SandboxPolicyDecisionStatusSchema = Type.Union([
  Type.Literal("allowed"),
  Type.Literal("denied"),
  Type.Literal("warning"),
]);

/** Policy decision status. */
export type SandboxPolicyDecisionStatus = Static<typeof SandboxPolicyDecisionStatusSchema>;

/** Product-safe policy decision emitted during sandbox planning or execution. */
export const SandboxPolicyDecisionSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    status: SandboxPolicyDecisionStatusSchema,
  },
  { additionalProperties: false },
);

/** Product-safe policy decision emitted during sandbox planning or execution. */
export type SandboxPolicyDecision = Static<typeof SandboxPolicyDecisionSchema>;

/** Product-safe sandbox warning. */
export const SandboxRunWarningSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Product-safe sandbox warning. */
export type SandboxRunWarning = Static<typeof SandboxRunWarningSchema>;

/** Product-safe sandbox error. */
export const SandboxRunErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Product-safe sandbox error. */
export type SandboxRunError = Static<typeof SandboxRunErrorSchema>;

/** Tool-specific sandbox policy used to validate one requested command. */
export type ToolSandboxPolicy = {
  /** Tool name used in decisions and dashboards. */
  readonly toolName: string;
  /** Container image names or digests allowed for this tool. */
  readonly allowedImages: readonly string[];
  /** Default image selected when planning this tool. */
  readonly defaultImage: SandboxImageSpec;
  /** Allowed argv prefixes for this tool. */
  readonly allowedCommands: readonly (readonly string[])[];
  /** Whether this tool may use shell execution. */
  readonly allowShell: boolean;
  /** Whether this tool may request network access. */
  readonly allowNetwork: boolean;
  /** Whether repository configuration for this tool may execute code. */
  readonly allowRepoConfigExecution: boolean;
  /** Whether this tool may install dependencies. */
  readonly allowDependencyInstall: boolean;
  /** Writable sandbox paths allowed for this tool. */
  readonly allowedWritePaths: readonly string[];
  /** Default resource limits selected when planning this tool. */
  readonly defaultLimits: SandboxResourceLimits;
  /** Maximum resource limits allowed for this tool. */
  readonly maxLimits: SandboxResourceLimits;
};

/** Input for evaluating one sandbox request against a tool policy. */
export type EvaluateToolSandboxPolicyInput = {
  /** Sandbox request to evaluate. */
  readonly request: SandboxRunRequest;
  /** Tool-specific policy to evaluate. */
  readonly toolPolicy: ToolSandboxPolicy;
};

/** Result of evaluating one sandbox request against a tool policy. */
export type EvaluateToolSandboxPolicyResult = {
  /** Whether all policy decisions allow execution. */
  readonly allowed: boolean;
  /** Product-safe policy decisions emitted by the evaluator. */
  readonly decisions: readonly SandboxPolicyDecision[];
};

/** Sandbox run result boundary schema. */
export const SandboxRunResultSchema = Type.Object(
  {
    artifacts: Type.Array(SandboxRunArtifactSchema),
    durationMs: Type.Integer({ minimum: 0 }),
    error: Type.Optional(SandboxRunErrorSchema),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    finishedAt: Type.String({ minLength: 1 }),
    policyDecisions: Type.Array(SandboxPolicyDecisionSchema),
    requestId: Type.String({ minLength: 1 }),
    resourceUsage: Type.Optional(SandboxResourceUsageSchema),
    runId: Type.String({ minLength: 1 }),
    runner: SandboxRunnerInfoSchema,
    schemaVersion: Type.Literal("sandbox_run_result.v1"),
    signal: Type.Optional(Type.String({ minLength: 1 })),
    startedAt: Type.String({ minLength: 1 }),
    status: SandboxRunStatusSchema,
    stderr: SandboxCapturedOutputSchema,
    stdout: SandboxCapturedOutputSchema,
    warnings: Type.Array(SandboxRunWarningSchema),
  },
  { additionalProperties: false },
);

/** Sandbox run result boundary type. */
export type SandboxRunResult = Static<typeof SandboxRunResultSchema>;

/** Default environment passed into sandboxed commands. */
export const DEFAULT_SANDBOX_ENVIRONMENT = {
  CARGO_HOME: "/tmp/cache/cargo",
  CI: "true",
  GOCACHE: "/tmp/cache/go-build",
  GOMODCACHE: "/tmp/cache/go-mod",
  HOME: "/tmp/home",
  NO_COLOR: "1",
  PIP_CACHE_DIR: "/tmp/cache/pip",
  RUSTUP_HOME: "/tmp/cache/rustup",
  TERM: "dumb",
  TMPDIR: "/tmp",
  XDG_CACHE_HOME: "/tmp/cache",
  npm_config_cache: "/tmp/cache/npm",
} as const satisfies Readonly<Record<string, string>>;

/** Default small static-tool sandbox resource limits. */
export const DEFAULT_SANDBOX_RESOURCE_LIMITS = {
  gracefulShutdownMs: 2_000,
  maxArtifactBytes: 25_000_000,
  maxCpuCount: 1,
  maxDiskBytes: 536_870_912,
  maxMemoryBytes: 536_870_912,
  maxPids: 128,
  maxStderrBytes: 1_048_576,
  maxStdoutBytes: 1_048_576,
  timeoutMs: 30_000,
} as const satisfies SandboxResourceLimits;

/** Default no-network sandbox policy. */
export const DEFAULT_SANDBOX_NETWORK_POLICY = {
  blockMetadataEndpoints: true,
  blockPrivateNetworks: true,
  mode: "none",
} as const satisfies SandboxNetworkPolicy;

/** Default hardened sandbox security policy. */
export const DEFAULT_SANDBOX_SECURITY_POLICY = {
  allowDeviceMounts: false,
  allowDockerSocket: false,
  allowHostIpc: false,
  allowHostNetwork: false,
  allowHostPid: false,
  allowedCapabilities: [],
  dropAllCapabilities: true,
  noNewPrivileges: true,
  privileged: false,
  readOnlyRootFilesystem: true,
  runAsGroup: 65_532,
  runAsUser: 65_532,
  seccompProfile: "runtime_default",
} as const satisfies SandboxSecurityPolicy;

/** Default bounded sandbox output policy. */
export const DEFAULT_SANDBOX_OUTPUT_POLICY = {
  captureStderr: true,
  captureStdout: true,
  maxStderrBytes: 1_048_576,
  maxStdoutBytes: 1_048_576,
  normalizeAnsi: true,
  redactSecrets: true,
  storeRawOutput: false,
  truncateStrategy: "head_and_tail",
} as const satisfies SandboxOutputPolicy;

/** Default artifact capture policy for static-analysis reports. */
export const DEFAULT_SANDBOX_ARTIFACT_POLICY = {
  collectFiles: [
    { pattern: "report.json", required: false },
    { pattern: "tool-output.json", required: false },
    { pattern: "sarif.json", required: false },
  ],
  maxBytesPerFile: 5_000_000,
  maxFiles: 8,
  maxTotalBytes: 25_000_000,
  outputDirectory: "/out",
} as const satisfies SandboxArtifactPolicy;

/** Input for creating a captured sandbox output value. */
export type CaptureSandboxOutputInput = {
  /** Raw output text. */
  readonly text: string;
  /** Maximum captured bytes. */
  readonly maxBytes: number;
  /** Whether to strip ANSI and unsafe control characters. */
  readonly normalizeAnsi?: boolean | undefined;
  /** Whether to redact secret-looking data. */
  readonly redactSecrets?: boolean | undefined;
  /** Concrete secret values to redact. */
  readonly redactionValues?: readonly string[] | undefined;
  /** Byte truncation strategy. */
  readonly truncateStrategy?: SandboxOutputPolicy["truncateStrategy"] | undefined;
};

/** Options for the unsafe local-process sandbox runner. */
export type LocalProcessSandboxRunnerOptions = {
  /** Node environment name used to forbid production construction. */
  readonly nodeEnv?: string | undefined;
  /** Signal used when a local sandbox process exceeds its timeout. */
  readonly timeoutSignal?: NodeJS.Signals | undefined;
  /** Grace period before escalating timeout termination to SIGKILL. */
  readonly timeoutKillGraceMs?: number | undefined;
};

/** Abstraction implemented by sandbox runners. */
export interface SandboxRunner {
  /** Runs one sandbox request and returns a bounded result. */
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
}

/** Fixture consumed by the deterministic fake sandbox runner. */
export type FakeSandboxRunnerFixture = {
  /** Optional request ID to match. */
  readonly requestId?: string | undefined;
  /** Optional tool run ID to match. */
  readonly toolRunId?: string | undefined;
  /** Optional executable name to match. */
  readonly executable?: string | undefined;
  /** Fake run ID. */
  readonly runId?: string | undefined;
  /** Fake stdout. */
  readonly stdout?: string | undefined;
  /** Fake stderr. */
  readonly stderr?: string | undefined;
  /** Fake artifacts. */
  readonly artifacts?: readonly SandboxRunArtifact[] | undefined;
  /** Fake exit code. */
  readonly exitCode?: number | null | undefined;
  /** Fake process signal. */
  readonly signal?: string | undefined;
  /** Fake status. */
  readonly status?: SandboxRunStatus | undefined;
  /** Fake duration in milliseconds. */
  readonly durationMs?: number | undefined;
  /** Fake resource usage. */
  readonly resourceUsage?: SandboxResourceUsage | undefined;
  /** Fake warnings. */
  readonly warnings?: readonly SandboxRunWarning[] | undefined;
};

/** Deterministic fake sandbox runner for tests and local planning. */
export class FakeSandboxRunner implements SandboxRunner {
  private readonly fixtures: readonly FakeSandboxRunnerFixture[];

  /** Creates a fake runner with optional matching fixtures. */
  public constructor(fixtures: readonly FakeSandboxRunnerFixture[] = []) {
    this.fixtures = fixtures;
  }

  /** Runs a fake sandbox request with deterministic output capture. */
  public async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    return fakeSandboxRun(request, this.fixtures);
  }
}

/** Unsafe local-process runner for local development and trusted fixtures only. */
export class LocalProcessSandboxRunner implements SandboxRunner {
  private readonly options: LocalProcessSandboxRunnerOptions;

  /** Creates a local-process runner and rejects production environments. */
  public constructor(options: LocalProcessSandboxRunnerOptions = {}) {
    const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
    if (process.env.NODE_ENV === "production" || nodeEnv === "production") {
      throw new Error("local_process sandbox runner is forbidden in production.");
    }

    this.options = options;
  }

  /** Runs one sandbox request as a local child process with bounded output. */
  public async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    return runLocalProcessSandbox(request, this.options);
  }
}

/** Creates a deterministic fake sandbox runner. */
export function createFakeSandboxRunner(
  fixtures: readonly FakeSandboxRunnerFixture[] = [],
): SandboxRunner {
  return new FakeSandboxRunner(fixtures);
}

/** Creates an unsafe local-process sandbox runner for local development only. */
export function createLocalProcessSandboxRunner(
  options: LocalProcessSandboxRunnerOptions = {},
): SandboxRunner {
  return new LocalProcessSandboxRunner(options);
}

/** Parses unknown data into a sandbox run request. */
export function parseSandboxRunRequest(value: unknown): SandboxRunRequest {
  return Value.Parse(SandboxRunRequestSchema, value);
}

/** Parses unknown data into a sandbox run result. */
export function parseSandboxRunResult(value: unknown): SandboxRunResult {
  return Value.Parse(SandboxRunResultSchema, value);
}

/** Creates a default sandbox environment with optional redacted keys. */
export function createDefaultSandboxEnvironment(
  redactedEnvKeys: readonly string[] = [],
): SandboxEnvironmentSpec {
  return {
    env: { ...DEFAULT_SANDBOX_ENVIRONMENT },
    inheritHostEnv: false,
    redactedEnvKeys: [...redactedEnvKeys],
  };
}

/** Captures, normalizes, redacts, truncates, and hashes sandbox output. */
export function createSandboxCapturedOutput(
  input: CaptureSandboxOutputInput,
): SandboxCapturedOutput {
  const normalized =
    input.normalizeAnsi === false ? input.text : normalizeSandboxOutputText(input.text);
  const redaction =
    input.redactSecrets === false
      ? { redacted: false, text: normalized }
      : redactSandboxTextWithStatus(normalized, input.redactionValues ?? []);
  const truncated = truncateSandboxText(
    redaction.text,
    Math.max(0, input.maxBytes),
    input.truncateStrategy ?? "head_and_tail",
  );

  return {
    bytes: byteLength(truncated.text),
    hash: sha256Hex(truncated.text),
    redacted: redaction.redacted,
    text: truncated.text,
    truncated: truncated.truncated,
  };
}

/** Executes one sandbox request through the unsafe local-process runner. */
async function runLocalProcessSandbox(
  request: SandboxRunRequest,
  options: LocalProcessSandboxRunnerOptions,
): Promise<SandboxRunResult> {
  const parsedRequest = parseSandboxRunRequest(request);
  const plan = createLocalProcessExecutionPlan(parsedRequest);
  const deniedDecision = plan.policyDecisions.find((decision) => decision.status === "denied");

  if (deniedDecision || !plan.workingDirectory) {
    return localProcessNonExecutionResult(parsedRequest, plan.policyDecisions, {
      code: deniedDecision?.code ?? "working_directory_outside_mount",
      message: deniedDecision?.message ?? "Local process working directory is outside bind mounts.",
      retryable: false,
    });
  }

  return executeLocalProcessSandbox(
    parsedRequest,
    { ...plan, workingDirectory: plan.workingDirectory },
    options,
  );
}

/** Executes one validated local-process sandbox plan. */
function executeLocalProcessSandbox(
  request: SandboxRunRequest,
  plan: LocalProcessExecutionPlan & { readonly workingDirectory: string },
  options: LocalProcessSandboxRunnerOptions,
): Promise<SandboxRunResult> {
  const startedAt = request.createdAt;
  const startedTimeMs = Date.now();
  const output = createLocalProcessOutputCapture({
    stderrMaxBytes: Math.min(request.output.maxStderrBytes, request.limits.maxStderrBytes),
    stdoutMaxBytes: Math.min(request.output.maxStdoutBytes, request.limits.maxStdoutBytes),
  });
  let timedOut = false;

  return new Promise((resolveResult) => {
    const executable = request.command.argv[0] ?? "";
    const child = spawn(executable, request.command.argv.slice(1), {
      cwd: plan.workingDirectory,
      env: request.environment.env,
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
      }, options.timeoutKillGraceMs ?? request.limits.gracefulShutdownMs);
    }, request.limits.timeoutMs);

    const finish = (
      status: SandboxRunStatus,
      exitCode: number | null,
      signal: string | null,
      error?: SandboxRunError | undefined,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const durationMs = Math.max(0, Date.now() - startedTimeMs);
      const finishedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();

      resolveResult({
        artifacts: [],
        durationMs,
        exitCode,
        finishedAt,
        policyDecisions: [...plan.policyDecisions],
        requestId: request.requestId,
        runId: stableSandboxId("srun", request.requestId),
        runner: localProcessRunnerInfo(),
        schemaVersion: "sandbox_run_result.v1",
        startedAt,
        status,
        stderr: localProcessCapturedOutput(request, output, "stderr"),
        stdout: localProcessCapturedOutput(request, output, "stdout"),
        warnings: [],
        ...(error ? { error } : {}),
        ...(signal ? { signal } : {}),
      });
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      output.append("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      output.append("stderr", chunk);
    });
    child.once("error", (error) => {
      output.append("stderr", `Failed to start sandbox command: ${error.message}`);
      finish("runner_error", null, null, {
        code: "local_process_spawn_failed",
        message: "Local process sandbox runner could not start the command.",
        retryable: false,
      });
    });
    child.once("close", (exitCode, signal) => {
      const status = timedOut
        ? "timed_out"
        : exitCode !== null && request.command.expectedExitCodes.includes(exitCode)
          ? "succeeded"
          : "failed";
      finish(status, exitCode, signal);
    });

    if (request.command.stdin === "provided") {
      child.stdin.end(request.command.stdinText ?? "");
      return;
    }

    child.stdin.end();
  });
}

/** Local-process execution plan after policy and path checks. */
type LocalProcessExecutionPlan = {
  /** Policy decisions emitted before execution. */
  readonly policyDecisions: readonly SandboxPolicyDecision[];
  /** Host working directory mapped from the sandbox request. */
  readonly workingDirectory?: string | undefined;
};

/** Creates a local-process plan and policy decisions for a sandbox request. */
function createLocalProcessExecutionPlan(request: SandboxRunRequest): LocalProcessExecutionPlan {
  const policyDecisions: SandboxPolicyDecision[] = [
    ...evaluateSandboxRequestSafety(request),
    {
      code: "local_process_runner_unsafe",
      message: "Local process sandbox runner is unsafe and allowed only for local development.",
      status: "warning",
    },
  ];

  if (request.network.mode !== "none") {
    policyDecisions.push({
      code: "local_process_network_policy_unsupported",
      message: "Local process sandbox runner only supports no-network requests.",
      status: "denied",
    });
  }

  const workingDirectory = hostPathForSandboxPath(request, request.command.workingDirectory);
  if (!workingDirectory) {
    policyDecisions.push({
      code: "working_directory_outside_mount",
      message: "Sandbox command working directory must be inside a bind mount.",
      status: "denied",
    });
  }

  return {
    policyDecisions: [...policyDecisions],
    ...(workingDirectory ? { workingDirectory } : {}),
  };
}

/** Maps a sandbox path to a host bind-mount path for local-process execution. */
function hostPathForSandboxPath(
  request: SandboxRunRequest,
  sandboxPath: string,
): string | undefined {
  const normalizedSandboxPath = posix.resolve("/", sandboxPath);
  const bindMounts = request.mounts
    .filter((mount) => mount.type === "bind")
    .sort((left, right) => right.target.length - left.target.length);

  for (const mount of bindMounts) {
    const normalizedTarget = posix.resolve("/", mount.target);
    const isInsideTarget =
      normalizedSandboxPath === normalizedTarget ||
      normalizedSandboxPath.startsWith(`${normalizedTarget}/`);
    if (!isInsideTarget) continue;

    const relativeSandboxPath = posix.relative(normalizedTarget, normalizedSandboxPath);
    const hostPath =
      relativeSandboxPath.length === 0
        ? resolve(mount.source)
        : resolve(mount.source, ...relativeSandboxPath.split("/"));

    return isPathInside(hostPath, mount.source) ? hostPath : undefined;
  }

  return undefined;
}

/** Returns true when a child path is contained by a parent path. */
function isPathInside(childPath: string, parentPath: string): boolean {
  const normalizedParent = resolve(parentPath);
  const normalizedChild = resolve(childPath);
  const relativePath = relative(normalizedParent, normalizedChild);

  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/** Creates a policy-denied local-process result without executing a command. */
function localProcessNonExecutionResult(
  request: SandboxRunRequest,
  policyDecisions: readonly SandboxPolicyDecision[],
  error: SandboxRunError,
): SandboxRunResult {
  return {
    artifacts: [],
    durationMs: 0,
    error,
    exitCode: null,
    finishedAt: request.createdAt,
    policyDecisions: [...policyDecisions],
    requestId: request.requestId,
    runId: stableSandboxId("srun", request.requestId),
    runner: localProcessRunnerInfo(),
    schemaVersion: "sandbox_run_result.v1",
    startedAt: request.createdAt,
    status: "policy_denied",
    stderr: emptyCapturedOutput(),
    stdout: emptyCapturedOutput(),
    warnings: [],
  };
}

/** Local process output stream name. */
type LocalProcessOutputStreamName = "stdout" | "stderr";

/** Bounded local-process output capture. */
type LocalProcessOutputCapture = {
  /** Appends a chunk to one stream while honoring that stream's byte budget. */
  readonly append: (stream: LocalProcessOutputStreamName, chunk: Buffer | string) => void;
  /** Returns captured stdout text. */
  readonly stdout: () => string;
  /** Returns captured stderr text. */
  readonly stderr: () => string;
  /** Returns whether stdout capture was truncated. */
  readonly stdoutTruncated: () => boolean;
  /** Returns whether stderr capture was truncated. */
  readonly stderrTruncated: () => boolean;
};

/** Creates a per-stream local-process output capture. */
function createLocalProcessOutputCapture(input: {
  /** Maximum stdout bytes to capture. */
  readonly stdoutMaxBytes: number;
  /** Maximum stderr bytes to capture. */
  readonly stderrMaxBytes: number;
}): LocalProcessOutputCapture {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;

  return {
    append: (stream, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const maxBytes = stream === "stdout" ? input.stdoutMaxBytes : input.stderrMaxBytes;
      const consumedBytes = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remainingBytes = Math.max(0, maxBytes - consumedBytes);
      if (buffer.length === 0) return;
      if (remainingBytes === 0) {
        if (stream === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
        return;
      }

      const captured = buffer.subarray(0, remainingBytes);
      if (captured.length < buffer.length) {
        if (stream === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
      }

      if (stream === "stdout") {
        stdout.push(captured);
        stdoutBytes += captured.length;
        return;
      }

      stderr.push(captured);
      stderrBytes += captured.length;
    },
    stderr: () => Buffer.concat(stderr).toString("utf8"),
    stderrTruncated: () => stderrTruncated,
    stdout: () => Buffer.concat(stdout).toString("utf8"),
    stdoutTruncated: () => stdoutTruncated,
  };
}

/** Converts local-process captured output to the sandbox output contract. */
function localProcessCapturedOutput(
  request: SandboxRunRequest,
  output: LocalProcessOutputCapture,
  stream: LocalProcessOutputStreamName,
): SandboxCapturedOutput {
  const policy =
    stream === "stdout"
      ? {
          capture: request.output.captureStdout,
          maxBytes: Math.min(request.output.maxStdoutBytes, request.limits.maxStdoutBytes),
          text: output.stdout(),
          truncated: output.stdoutTruncated(),
        }
      : {
          capture: request.output.captureStderr,
          maxBytes: Math.min(request.output.maxStderrBytes, request.limits.maxStderrBytes),
          text: output.stderr(),
          truncated: output.stderrTruncated(),
        };

  if (!policy.capture) {
    return emptyCapturedOutput();
  }

  const captured = createSandboxCapturedOutput({
    maxBytes: policy.maxBytes,
    normalizeAnsi: request.output.normalizeAnsi,
    redactSecrets: request.output.redactSecrets,
    redactionValues: redactionValuesForRequest(request),
    text: policy.text,
    truncateStrategy: request.output.truncateStrategy,
  });

  return {
    ...captured,
    truncated: captured.truncated || policy.truncated,
  };
}

/** Returns redaction values selected by request redacted environment keys. */
function redactionValuesForRequest(request: SandboxRunRequest): string[] {
  return request.environment.redactedEnvKeys
    .map((key) => request.environment.env[key])
    .filter(isNonEmptyString);
}

/** Returns local-process runner metadata for sandbox results. */
function localProcessRunnerInfo(): SandboxRunnerInfo {
  return {
    isolation: "none",
    kind: "local_process",
    name: "LocalProcessSandboxRunner",
    version: "sandbox.local_process.v1",
  };
}

/** Removes ANSI escapes and unsafe control characters from sandbox output. */
export function normalizeSandboxOutputText(value: string): string {
  let normalized = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    const codePoint = character.charCodeAt(0);
    if (codePoint === 27 && value[index + 1] === "[") {
      index += 2;
      while (index < value.length) {
        const ansiCodePoint = value.charCodeAt(index);
        if (ansiCodePoint >= 64 && ansiCodePoint <= 126) {
          break;
        }
        index += 1;
      }
      continue;
    }

    if (codePoint === 9 || codePoint === 10 || codePoint === 13) {
      normalized += character;
      continue;
    }

    if (codePoint >= 32 && codePoint <= 126) {
      normalized += character;
    }
  }

  return normalized;
}

/** Redacts secret-looking values from sandbox output. */
export function redactSandboxText(value: string, redactionValues: readonly string[] = []): string {
  return redactSandboxTextWithStatus(value, redactionValues).text;
}

/** Evaluates baseline request safety invariants before execution. */
export function evaluateSandboxRequestSafety(request: SandboxRunRequest): SandboxPolicyDecision[] {
  const decisions: SandboxPolicyDecision[] = [
    {
      code: "request_schema_accepted",
      message: "Sandbox request matches the v1 contract.",
      status: "allowed",
    },
  ];

  if (request.command.shell !== false) {
    decisions.push({
      code: "shell_execution_disabled",
      message: "Shell execution is disabled for sandbox requests.",
      status: "denied",
    });
  }

  if (request.environment.inheritHostEnv !== false) {
    decisions.push({
      code: "host_environment_inheritance_denied",
      message: "Sandbox requests must use an explicit environment allowlist.",
      status: "denied",
    });
  }

  if (request.image.allowedImageClass === "blocked") {
    decisions.push({
      code: "image_class_blocked",
      message: "The requested sandbox image class is blocked.",
      status: "denied",
    });
  }

  if (!request.network.blockMetadataEndpoints || !request.network.blockPrivateNetworks) {
    decisions.push({
      code: "network_guard_required",
      message: "Sandbox network policy must block metadata endpoints and private networks.",
      status: "denied",
    });
  }

  if (!request.security.dropAllCapabilities || request.security.allowedCapabilities.length > 0) {
    decisions.push({
      code: "linux_capabilities_denied",
      message: "Sandbox requests must drop all Linux capabilities.",
      status: "denied",
    });
  }

  if (!request.security.noNewPrivileges || !request.security.readOnlyRootFilesystem) {
    decisions.push({
      code: "hardened_runtime_required",
      message: "Sandbox requests must use no-new-privileges and a read-only root filesystem.",
      status: "denied",
    });
  }

  if (request.mounts.some((mount) => mount.source.includes("docker.sock"))) {
    decisions.push({
      code: "docker_socket_mount_denied",
      message: "Sandbox requests must not mount the Docker socket.",
      status: "denied",
    });
  }

  return decisions;
}

/** Evaluates a sandbox request against a tool-specific execution policy. */
export function evaluateToolSandboxPolicy(
  input: EvaluateToolSandboxPolicyInput,
): EvaluateToolSandboxPolicyResult {
  const request = parseSandboxRunRequest(input.request);
  const decisions = [
    ...evaluateSandboxRequestSafety(request),
    ...evaluateToolPolicyDecisions(request, input.toolPolicy),
  ];

  return {
    allowed: decisions.every((decision) => decision.status !== "denied"),
    decisions,
  };
}

/** Returns true when a sandbox result is terminal and successful. */
export function isSuccessfulSandboxResult(result: SandboxRunResult): boolean {
  return result.status === "succeeded" && result.exitCode !== null;
}

/** Evaluates tool-specific policy decisions for one request. */
function evaluateToolPolicyDecisions(
  request: SandboxRunRequest,
  policy: ToolSandboxPolicy,
): SandboxPolicyDecision[] {
  const decisions: SandboxPolicyDecision[] = [
    {
      code: "tool_policy_loaded",
      message: `Sandbox tool policy loaded for ${policy.toolName}.`,
      status: "allowed",
    },
  ];

  if (!policy.allowShell && request.command.shell !== false) {
    decisions.push({
      code: "tool_shell_denied",
      message: "Tool policy does not allow shell execution.",
      status: "denied",
    });
  }

  if (!commandMatchesAllowedPrefix(request.command.argv, policy.allowedCommands)) {
    decisions.push({
      code: "command_not_allowlisted",
      message: "Sandbox command is not allowlisted for this tool.",
      status: "denied",
    });
  }

  if (!policy.allowNetwork && request.network.mode !== "none") {
    decisions.push({
      code: "tool_network_denied",
      message: "Tool policy does not allow network access.",
      status: "denied",
    });
  }

  if (!imageAllowedByToolPolicy(request.image, policy.allowedImages)) {
    decisions.push({
      code: "tool_image_denied",
      message: "Sandbox image is not allowlisted for this tool.",
      status: "denied",
    });
  }

  if (resourceLimitKeys().some((key) => request.limits[key] > policy.maxLimits[key])) {
    decisions.push({
      code: "resource_limit_exceeds_policy",
      message: "Sandbox resource limits exceed the tool policy maximum.",
      status: "denied",
    });
  }

  if (
    request.workspace.allowedWritePaths.some(
      (path) => !sandboxPathAllowed(path, policy.allowedWritePaths),
    )
  ) {
    decisions.push({
      code: "workspace_write_path_denied",
      message: "Sandbox workspace write path is not allowed for this tool.",
      status: "denied",
    });
  }

  if (
    request.mounts.some(
      (mount) => !mount.readOnly && !sandboxPathAllowed(mount.target, policy.allowedWritePaths),
    )
  ) {
    decisions.push({
      code: "writable_mount_denied",
      message: "Sandbox writable mount is not allowed for this tool.",
      status: "denied",
    });
  }

  if (secretEnvironmentKeys(request.environment.env).length > 0) {
    decisions.push({
      code: "secret_environment_denied",
      message: "Secret-looking environment variables must not be passed to sandbox commands.",
      status: "denied",
    });
  }

  if (request.command.argv.some(hasUnsafeCommandArgument)) {
    decisions.push({
      code: "unsafe_command_argument",
      message: "Sandbox command includes an unsafe path or control argument.",
      status: "denied",
    });
  }

  if (!policy.allowDependencyInstall && commandLooksLikeDependencyInstall(request.command.argv)) {
    decisions.push({
      code: "dependency_install_denied",
      message: "Tool policy does not allow dependency installation.",
      status: "denied",
    });
  }

  return decisions;
}

/** Resource limit key checked by tool policy maximums. */
type ResourceLimitKey = keyof SandboxResourceLimits;

/** Returns resource limit keys that must stay within tool policy maximums. */
function resourceLimitKeys(): readonly ResourceLimitKey[] {
  return [
    "gracefulShutdownMs",
    "maxArtifactBytes",
    "maxCpuCount",
    "maxDiskBytes",
    "maxMemoryBytes",
    "maxPids",
    "maxStderrBytes",
    "maxStdoutBytes",
    "timeoutMs",
  ];
}

/** Returns true when argv starts with any allowed command prefix. */
function commandMatchesAllowedPrefix(
  argv: readonly string[],
  allowedCommands: readonly (readonly string[])[],
): boolean {
  return allowedCommands.some(
    (allowedCommand) =>
      allowedCommand.length > 0 &&
      allowedCommand.length <= argv.length &&
      allowedCommand.every((part, index) => argv[index] === part),
  );
}

/** Returns true when the requested image is allowlisted by name or digest. */
function imageAllowedByToolPolicy(
  image: SandboxImageSpec,
  allowedImages: readonly string[],
): boolean {
  const candidates = [
    image.image,
    image.digest,
    image.digest ? `${image.image}@${image.digest}` : undefined,
  ].filter(isNonEmptyString);

  return candidates.some((candidate) => allowedImages.includes(candidate));
}

/** Returns true when a sandbox path is inside an allowed sandbox path. */
function sandboxPathAllowed(path: string, allowedPaths: readonly string[]): boolean {
  const normalizedPath = posix.resolve("/", path);

  return allowedPaths.some((allowedPath) => {
    const normalizedAllowedPath = posix.resolve("/", allowedPath);

    return (
      normalizedPath === normalizedAllowedPath ||
      normalizedPath.startsWith(`${normalizedAllowedPath}/`)
    );
  });
}

/** Returns environment keys that look like secrets. */
function secretEnvironmentKeys(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env).filter((key) =>
    /token|secret|password|api[_-]?key|access[_-]?key|private[_-]?key/iu.test(key),
  );
}

/** Returns true when an argv item contains unsafe path or control syntax. */
function hasUnsafeCommandArgument(argument: string): boolean {
  const normalizedArgument = argument.replaceAll("\\", "/");
  if (normalizedArgument.includes("\0")) {
    return true;
  }

  if (normalizedArgument.split("/").includes("..")) {
    return true;
  }

  return (
    posix.isAbsolute(normalizedArgument) &&
    !sandboxPathAllowed(normalizedArgument, ["/workspace", "/tmp", "/out"])
  );
}

/** Returns true when an argv command appears to install dependencies. */
function commandLooksLikeDependencyInstall(argv: readonly string[]): boolean {
  const executable = (argv[0] ?? "").split("/").at(-1)?.toLowerCase() ?? "";
  const subcommands = argv.slice(1).map((argument) => argument.toLowerCase());

  if (
    executable === "npm" ||
    executable === "pnpm" ||
    executable === "yarn" ||
    executable === "bun"
  ) {
    return subcommands.some((argument) =>
      ["add", "ci", "install", "update", "upgrade"].includes(argument),
    );
  }

  if (executable === "pip" || executable === "pip3") {
    return subcommands.includes("install");
  }

  if (executable === "cargo") {
    return subcommands.some((argument) => ["fetch", "install", "update"].includes(argument));
  }

  if (executable === "go") {
    return subcommands.some((argument) => ["get", "install"].includes(argument));
  }

  return false;
}

/** Builds one deterministic fake sandbox run result. */
function fakeSandboxRun(
  request: SandboxRunRequest,
  fixtures: readonly FakeSandboxRunnerFixture[],
): SandboxRunResult {
  const fixture = findFakeSandboxFixture(request, fixtures);
  const policyDecisions = evaluateSandboxRequestSafety(request);
  const deniedDecision = policyDecisions.find((decision) => decision.status === "denied");
  const status: SandboxRunStatus = deniedDecision
    ? "policy_denied"
    : (fixture.status ?? ((fixture.exitCode ?? 0) === 0 ? "succeeded" : "failed"));
  const durationMs = fixture.durationMs ?? 1;
  const startedAt = request.createdAt;
  const finishedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();
  const redactionValues = request.environment.redactedEnvKeys
    .map((key) => request.environment.env[key])
    .filter(isNonEmptyString);
  const stdout = request.output.captureStdout
    ? createSandboxCapturedOutput({
        maxBytes: Math.min(request.output.maxStdoutBytes, request.limits.maxStdoutBytes),
        normalizeAnsi: request.output.normalizeAnsi,
        redactSecrets: request.output.redactSecrets,
        redactionValues,
        text: fixture.stdout ?? "",
        truncateStrategy: request.output.truncateStrategy,
      })
    : emptyCapturedOutput();
  const stderr = request.output.captureStderr
    ? createSandboxCapturedOutput({
        maxBytes: Math.min(request.output.maxStderrBytes, request.limits.maxStderrBytes),
        normalizeAnsi: request.output.normalizeAnsi,
        redactSecrets: request.output.redactSecrets,
        redactionValues,
        text: fixture.stderr ?? "",
        truncateStrategy: request.output.truncateStrategy,
      })
    : emptyCapturedOutput();

  return {
    artifacts: fixture.artifacts ? [...fixture.artifacts] : [],
    durationMs,
    exitCode: processExitCodeForStatus(status, fixture.exitCode),
    finishedAt,
    policyDecisions,
    requestId: request.requestId,
    runId: fixture.runId ?? stableSandboxId("srun", request.requestId),
    runner: {
      isolation: "none",
      kind: "fake",
      name: "FakeSandboxRunner",
      version: "sandbox.fake.v1",
    },
    schemaVersion: "sandbox_run_result.v1",
    startedAt,
    status,
    stderr,
    stdout,
    warnings: fixture.warnings ? [...fixture.warnings] : [],
    ...(deniedDecision
      ? {
          error: {
            code: deniedDecision.code,
            message: deniedDecision.message,
            retryable: false,
          },
        }
      : {}),
    ...(fixture.resourceUsage ? { resourceUsage: fixture.resourceUsage } : {}),
    ...(fixture.signal ? { signal: fixture.signal } : {}),
  };
}

/** Finds the best matching fake runner fixture for a request. */
function findFakeSandboxFixture(
  request: SandboxRunRequest,
  fixtures: readonly FakeSandboxRunnerFixture[],
): FakeSandboxRunnerFixture {
  const executable = request.command.argv[0] ?? "";

  return (
    fixtures.find((fixture) => fixture.requestId === request.requestId) ??
    fixtures.find(
      (fixture) => fixture.toolRunId !== undefined && fixture.toolRunId === request.toolRunId,
    ) ??
    fixtures.find((fixture) => fixture.executable === executable) ??
    {}
  );
}

/** Converts sandbox status and fixture exit code into a process exit code. */
function processExitCodeForStatus(
  status: SandboxRunStatus,
  fixtureExitCode: number | null | undefined,
): number | null {
  if (
    status === "killed" ||
    status === "policy_denied" ||
    status === "resource_exceeded" ||
    status === "runner_error" ||
    status === "timed_out"
  ) {
    return fixtureExitCode ?? null;
  }

  return fixtureExitCode ?? (status === "succeeded" ? 0 : 1);
}

/** Returns an empty captured output value. */
function emptyCapturedOutput(): SandboxCapturedOutput {
  return {
    bytes: 0,
    hash: sha256Hex(""),
    redacted: false,
    text: "",
    truncated: false,
  };
}

/** Redacts secret-looking output and reports whether text changed. */
function redactSandboxTextWithStatus(
  value: string,
  redactionValues: readonly string[],
): { readonly text: string; readonly redacted: boolean } {
  let redacted = value;
  for (const secret of redactionValues.filter(isNonEmptyString)) {
    redacted = redacted.split(secret).join("<redacted>");
  }

  redacted = redacted
    .replace(
      /\b(token|secret|password|key|api_key|access_key|private_key)=([^\s]+)/giu,
      "$1=<redacted>",
    )
    .replace(/(--(?:token|secret|password|key|api-key|access-key)\s+)([^\s]+)/giu, "$1<redacted>");

  return {
    redacted: redacted !== value,
    text: redacted,
  };
}

/** Truncates text using a byte budget and strategy. */
function truncateSandboxText(
  value: string,
  maxBytes: number,
  strategy: SandboxOutputPolicy["truncateStrategy"],
): { readonly text: string; readonly truncated: boolean } {
  if (byteLength(value) <= maxBytes) {
    return { text: value, truncated: false };
  }

  if (maxBytes <= 0) {
    return { text: "", truncated: true };
  }

  if (strategy === "tail") {
    return { text: takeTailBytes(value, maxBytes), truncated: true };
  }

  if (strategy === "head") {
    return { text: takeHeadBytes(value, maxBytes), truncated: true };
  }

  return {
    text: takeHeadAndTailBytes(value, maxBytes),
    truncated: true,
  };
}

/** Takes the first bytes from text. */
function takeHeadBytes(value: string, maxBytes: number): string {
  return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
}

/** Takes the last bytes from text. */
function takeTailBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8");
}

/** Takes text head and tail with a truncation marker. */
function takeHeadAndTailBytes(value: string, maxBytes: number): string {
  const marker = "\n[... sandbox output truncated ...]\n";
  const markerBytes = byteLength(marker);
  if (maxBytes <= markerBytes) {
    return takeHeadBytes(value, maxBytes);
  }

  const remaining = maxBytes - markerBytes;
  const headBytes = Math.ceil(remaining / 2);
  const tailBytes = Math.floor(remaining / 2);

  return `${takeHeadBytes(value, headBytes)}${marker}${takeTailBytes(value, tailBytes)}`;
}

/** Returns a stable sandbox identifier. */
function stableSandboxId(prefix: string, value: string): string {
  return `${prefix}_${sha256Hex(value).slice(0, 24)}`;
}

/** Returns a SHA-256 hex digest for text. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Returns the UTF-8 byte length for text. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Narrows non-empty string values. */
function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
