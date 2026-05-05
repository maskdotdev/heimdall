# #24 Sandbox Execution Implementation Spec

## Status

Proposed implementation spec.

This document defines the sandbox execution layer for safely running static analysis tools, type checkers, linters, limited repository commands, and future test commands inside the code-review system.

It is designed to work with the previous sections:

```text
#0  Core contracts and shared types
#1  Monorepo and build system
#2  Database layer
#3  GitHub App integration
#4  Webhook ingestion
#5  API server
#6  Web dashboard
#7  Job queue and orchestration
#8  Repo sync and workspace manager
#9  Indexer boundary
#10 Index artifact schema
#11 TypeScript indexer implementation
#12 Index importer
#13 Embedding pipeline
#14 Retrieval engine
#15 PR snapshot and diff model
#16 Review orchestrator
#17 LLM gateway
#18 Review passes
#19 Finding validation, dedupe, and ranking
#20 Publisher
#21 Feedback and memory system
#22 Repo rules and configuration
#23 Static analysis integration
```

The sandbox exists primarily to support #23 Static Analysis Integration, but it should be designed as a reusable execution primitive for future workflows.

---

## 1. Goal

The sandbox execution layer should let the system run selected commands against a repository workspace while preventing the command from:

```text
- accessing host secrets
- accessing GitHub/App tokens
- accessing the Docker socket
- modifying host files
- reading other tenants' repos
- exfiltrating source code over the network
- exhausting CPU, memory, disk, PIDs, or time
- escaping the container or workspace
- hiding malicious output in logs/artifacts
- poisoning future jobs through persistent state
```

The clean mental model:

```text
Tool execution is untrusted.
The workspace is disposable.
The host must remain clean.
Every command has explicit inputs, limits, mounts, environment, and outputs.
```

---

## 2. Non-goals

This section does not implement:

```text
- full test execution for arbitrary repos
- dependency installation for every ecosystem
- arbitrary shell access
- remote development environments
- long-running interactive agents
- production Kubernetes cluster hardening for all services
- formal proof of isolation
- model-provider security
- prompt-injection handling
```

Those are related but separate workstreams.

For the MVP, sandbox execution should be good enough for:

```text
- eslint
- tsc --noEmit
- biome check
- ruff check
- pyright
- semgrep with local/bundled rules
- go vet where dependencies are already available
- cargo check where dependencies are already available
```

It should not initially try to support:

```text
- arbitrary npm install
- arbitrary postinstall scripts
- arbitrary repo-defined shell scripts
- integration tests
- browser tests
- database-backed tests
- network-dependent tests
```

---

## 3. Key design recommendation

Build a separate package and optional service:

```text
/packages/sandbox
/apps/sandbox-runner optional later
```

The runner should expose a small interface:

```ts
export interface SandboxRunner {
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
}
```

The rest of the system should never call `docker run`, `kubectl`, `firecracker`, `nsjail`, `bubblewrap`, or raw process execution directly.

Architecture:

```text
StaticAnalysisEngine
  -> SandboxRunner.run(request)
  -> SandboxRunResult
  -> ToolAdapter parses output
  -> StaticAnalysisReport
```

The sandbox layer owns:

```text
- execution isolation
- command timeouts
- resource limits
- mount policy
- network policy
- environment scrubbing
- artifact capture
- log bounding
- process cleanup
- execution telemetry
- runner-specific errors
```

The static-analysis layer owns:

```text
- which tools to run
- how to parse tool output
- how to map diagnostics to findings
```

The review engine owns:

```text
- how static evidence affects model reasoning
```

The publisher owns:

```text
- whether anything appears on GitHub
```

---

## 4. Recommended implementation path

### 4.1 MVP

Start with a hardened local container runner.

```text
SandboxRunner = DockerContainerSandboxRunner
Runtime = Docker or containerd on isolated worker nodes
Network = disabled by default
Workspace = temporary copy or disposable worktree mount
User = non-root UID/GID
Root filesystem = read-only
Capabilities = dropped
Privilege escalation = disabled
Seccomp = default or stricter profile
Memory/CPU/PID/disk/time = bounded
Output = bounded and redacted
```

### 4.2 Production hardening

Upgrade untrusted execution to gVisor where possible.

```text
SandboxRunner = ContainerSandboxRunner
OCI runtime = runsc / gVisor for untrusted commands
```

gVisor adds an application-kernel layer between the container and the host kernel. This improves isolation compared with plain `runc` containers, while preserving much of the container workflow.

### 4.3 High-isolation enterprise path

For high-risk or enterprise deployments, add a Firecracker-based runner.

```text
SandboxRunner = MicroVmSandboxRunner
Runtime = Firecracker microVM
Workspace = block device or copied archive
Network = none or policy-controlled
Isolation = VM boundary + jailer/cgroups/seccomp
```

Firecracker is more operationally involved but gives stronger tenant isolation for arbitrary code execution.

### 4.4 Long-term runner selection

Use policy-based runner selection:

```text
trusted private repo, no fork PR       -> hardened container
same-org PR                            -> hardened container or gVisor
fork PR / untrusted author             -> gVisor or microVM
enterprise high-security org           -> microVM
static metadata-only task              -> no sandbox required
```

---

## 5. Threat model

The sandbox runner should assume the repository may be malicious.

A malicious PR author may attempt to:

```text
- add a malicious ESLint config
- add a malicious TypeScript plugin
- add a malicious Python plugin
- add a malicious package.json script
- add a malicious postinstall script
- create symlinks escaping the workspace
- create huge files to exhaust disk/memory
- create output bombs to exhaust logs/storage
- create fork bombs
- read environment variables
- read mounted credentials
- reach metadata endpoints
- call external URLs to exfiltrate code
- access internal services on the VPC
- scan the network
- write to repo mirror cache
- mutate future job state
- detect the sandbox and alter behavior
- exploit tool/parser/runtime vulnerabilities
- exploit kernel/container runtime vulnerabilities
```

The system should also assume accidental failure:

```text
- a tool hangs forever
- a tool produces massive output
- a dependency cache corrupts
- a process ignores SIGTERM
- a tool leaves child processes running
- a workspace cleanup fails
- a runner node runs out of disk
```

The system should not assume:

```text
- package scripts are safe
- tool config files are safe
- dependency plugins are safe
- same-org PRs are always safe
- private repos are safe
- container root is harmless
- no network means no exfiltration through logs
```

---

## 6. Trust levels

Define a trust level for every execution request.

```ts
export type SandboxTrustLevel =
  | "metadata_only"
  | "trusted_repo"
  | "trusted_pr"
  | "untrusted_pr"
  | "external_fork"
  | "enterprise_strict";
```

Suggested interpretation:

| Trust level | Meaning | Default runner |
|---|---|---|
| `metadata_only` | No command execution. Only read already-indexed metadata. | None |
| `trusted_repo` | Command runs on trusted base branch code. | Hardened container |
| `trusted_pr` | PR from trusted org member. Still untrusted code. | Hardened container / gVisor |
| `untrusted_pr` | PR code from less-trusted author. | gVisor |
| `external_fork` | Fork PR or unknown author. | gVisor / microVM |
| `enterprise_strict` | High-security customer policy. | microVM |

The review policy snapshot from #22 should decide trust level using:

```text
- repo visibility
- PR author association
- fork status
- org membership
- labels
- enterprise settings
- whether the tool executes repo-defined code/config
- whether network/dependency installation is requested
```

---

## 7. Execution categories

Every command should have a category.

```ts
export type SandboxExecutionCategory =
  | "static_tool"
  | "type_check"
  | "lint"
  | "security_scan"
  | "dependency_scan"
  | "test"
  | "custom_command"
  | "indexer_auxiliary";
```

Suggested support:

| Category | MVP support | Notes |
|---|---:|---|
| `static_tool` | Yes | Semgrep, pattern scanners. |
| `type_check` | Yes | `tsc --noEmit`, Pyright. |
| `lint` | Yes | ESLint, Biome, Ruff. |
| `security_scan` | Partial | Semgrep local rules first. |
| `dependency_scan` | Later | Often needs manifests and DBs. |
| `test` | Later | Much harder; may need services/network. |
| `custom_command` | Later | High-risk. Require strict allowlist. |
| `indexer_auxiliary` | Partial | Only trusted, bounded commands. |

---

## 8. Package structure

```text
/packages/sandbox
  package.json
  tsconfig.json
  src/
    index.ts
    contracts.ts
    config.ts
    runner.ts
    registry.ts
    errors.ts
    limits.ts
    policy.ts
    environment.ts
    mounts.ts
    output.ts
    redaction.ts
    artifacts.ts
    docker/
      docker-runner.ts
      docker-command-builder.ts
      docker-image-policy.ts
      docker-security-options.ts
      docker-output-collector.ts
    gvisor/
      gvisor-runner.ts
      runtime-class-policy.ts
    microvm/
      microvm-runner.ts
      firecracker-runner.ts
    local/
      local-process-runner.ts
    fake/
      fake-sandbox-runner.ts
    testing/
      fixtures.ts
      assertions.ts
    __tests__/
      policy.test.ts
      limits.test.ts
      mounts.test.ts
      env.test.ts
      output.test.ts
      docker-command-builder.test.ts
```

Optional service later:

```text
/apps/sandbox-runner
  src/
    index.ts
    server.ts
    auth.ts
    run.ts
    health.ts
```

MVP can keep the runner in-process inside `/apps/worker`, but it should use the `/packages/sandbox` interface.

---

## 9. Core contracts

These should live in `/packages/contracts` or `/packages/sandbox`, depending on how widely they are shared.

### 9.1 SandboxRunRequest

```ts
export type SandboxRunRequest = {
  schemaVersion: "sandbox_run_request.v1";

  requestId: string;
  orgId: string;
  repoId: string;
  reviewRunId?: string;
  staticAnalysisRunId?: string;
  toolRunId?: string;

  trustLevel: SandboxTrustLevel;
  category: SandboxExecutionCategory;

  workspace: SandboxWorkspaceSpec;
  command: SandboxCommandSpec;
  image: SandboxImageSpec;
  environment: SandboxEnvironmentSpec;
  mounts: SandboxMountSpec[];
  network: SandboxNetworkPolicy;
  limits: SandboxResourceLimits;
  output: SandboxOutputPolicy;
  artifacts: SandboxArtifactPolicy;
  security: SandboxSecurityPolicy;

  createdAt: string;
  expiresAt?: string;
};
```

### 9.2 SandboxWorkspaceSpec

```ts
export type SandboxWorkspaceSpec = {
  workspaceId: string;
  workspacePath: string;
  commitSha: string;
  baseSha?: string;
  headSha?: string;
  mode: "read_only" | "copy_on_write" | "writable_disposable";
  mountPath: string; // usually /workspace
  allowedWritePaths: string[]; // usually /tmp, /work, /cache if enabled
};
```

Recommended defaults:

```text
workspacePath: host path from #8 Repo Sync lease
mountPath: /workspace
mode: read_only for tools that only inspect
mode: copy_on_write for tools that write caches
mode: writable_disposable only when required
```

Never mount:

```text
- repo mirror cache directly writable
- worker source tree
- host /var/run/docker.sock
- host home directory
- host SSH directory
- host cloud credentials
- system directories
```

### 9.3 SandboxCommandSpec

```ts
export type SandboxCommandSpec = {
  argv: string[];
  workingDirectory: string; // inside sandbox, usually /workspace
  shell: false;             // default and strongly preferred
  stdin?: "none" | "empty" | "provided";
  stdinText?: string;
  expectedExitCodes: number[];
};
```

MVP should reject shell execution:

```ts
if (request.command.shell !== false) {
  throw new SandboxPolicyError("shell execution is disabled");
}
```

If shell execution is ever enabled, it should require:

```text
- explicit policy opt-in
- trusted repo only
- no secrets
- no network by default
- short timeout
- high audit logging
```

### 9.4 SandboxImageSpec

```ts
export type SandboxImageSpec = {
  image: string;
  digest?: string;
  pullPolicy: "never" | "if_not_present" | "always";
  allowedImageClass:
    | "first_party_static_tools"
    | "first_party_language_tools"
    | "customer_provided"
    | "blocked";
};
```

Recommended MVP:

```text
Use first-party prebuilt tool images pinned by digest.
Do not pull arbitrary customer images.
Do not build Docker images from the repo.
```

Example images:

```text
reviewer-tools-node:<version>@sha256:<digest>
reviewer-tools-python:<version>@sha256:<digest>
reviewer-tools-semgrep:<version>@sha256:<digest>
reviewer-tools-go:<version>@sha256:<digest>
reviewer-tools-rust:<version>@sha256:<digest>
```

### 9.5 SandboxEnvironmentSpec

```ts
export type SandboxEnvironmentSpec = {
  env: Record<string, string>;
  inheritHostEnv: false;
  redactedEnvKeys: string[];
};
```

Default environment:

```text
CI=true
NO_COLOR=1
TERM=dumb
HOME=/tmp/home
TMPDIR=/tmp
XDG_CACHE_HOME=/tmp/cache
npm_config_cache=/tmp/cache/npm
PIP_CACHE_DIR=/tmp/cache/pip
GOMODCACHE=/tmp/cache/go-mod
GOCACHE=/tmp/cache/go-build
CARGO_HOME=/tmp/cache/cargo
RUSTUP_HOME=/tmp/cache/rustup
```

Never pass:

```text
GITHUB_TOKEN
GITHUB_APP_PRIVATE_KEY
DATABASE_URL
REDIS_URL
OPENAI_API_KEY
ANTHROPIC_API_KEY
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
GOOGLE_APPLICATION_CREDENTIALS
KUBECONFIG
SSH_AUTH_SOCK
HOME from host
any env var not explicitly allowlisted
```

### 9.6 SandboxMountSpec

```ts
export type SandboxMountSpec = {
  source: string;
  target: string;
  type: "bind" | "tmpfs" | "volume";
  readOnly: boolean;
  sizeBytes?: number;
  purpose:
    | "workspace"
    | "tmp"
    | "cache"
    | "output"
    | "tooling"
    | "none";
};
```

Recommended mounts:

```text
/workspace    read-only bind mount or copied disposable workspace
/tmp          tmpfs, writable, size-limited
/tmp/cache    tmpfs or isolated cache, writable, size-limited
/out          writable, isolated output dir, size-limited
```

Avoid shared writable caches for untrusted PRs.

If shared caches are used, they must be:

```text
- keyed by org/repo/tool/image digest
- never executable if possible
- scanned or treated as untrusted
- disposable
- not shared between tenants by default
```

### 9.7 SandboxNetworkPolicy

```ts
export type SandboxNetworkPolicy = {
  mode: "none" | "loopback_only" | "allowlist" | "full_blocked_by_default";
  allowedHosts?: string[];
  allowedPorts?: number[];
  blockMetadataEndpoints: boolean;
  blockPrivateNetworks: boolean;
};
```

MVP default:

```text
mode: none
blockMetadataEndpoints: true
blockPrivateNetworks: true
```

Never allow by default:

```text
169.254.169.254
metadata.google.internal
AWS/GCP/Azure metadata endpoints
internal VPC IP ranges
worker service ports
Postgres
Redis
Kubernetes API
Docker daemon
model-provider endpoints
GitHub token endpoints
```

If network is required later, use explicit allowlists:

```text
registry.npmjs.org for dependency fetching
pypi.org / files.pythonhosted.org for dependency fetching
proxy.golang.org for Go modules
crates.io / static.crates.io for Rust crates
```

But dependency fetching from untrusted PRs should remain a separate, high-risk policy.

### 9.8 SandboxResourceLimits

```ts
export type SandboxResourceLimits = {
  timeoutMs: number;
  gracefulShutdownMs: number;
  maxCpuCount: number;
  maxMemoryBytes: number;
  maxPids: number;
  maxDiskBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxArtifactBytes: number;
};
```

Suggested defaults:

| Profile | Timeout | CPU | Memory | PIDs | Disk/tmp | stdout/stderr |
|---|---:|---:|---:|---:|---:|---:|
| small static tool | 30s | 1 | 512 MiB | 128 | 512 MiB | 1 MiB each |
| medium lint/typecheck | 120s | 2 | 2 GiB | 256 | 2 GiB | 5 MiB each |
| large typecheck | 300s | 4 | 6 GiB | 512 | 5 GiB | 10 MiB each |
| enterprise strict | policy | policy | policy | policy | policy | policy |

### 9.9 SandboxSecurityPolicy

```ts
export type SandboxSecurityPolicy = {
  runAsUser: number;
  runAsGroup: number;
  readOnlyRootFilesystem: boolean;
  noNewPrivileges: boolean;
  dropAllCapabilities: boolean;
  allowedCapabilities: string[];
  seccompProfile: "runtime_default" | "strict" | "custom";
  appArmorProfile?: string;
  selinuxType?: string;
  privileged: false;
  allowDockerSocket: false;
  allowHostPid: false;
  allowHostNetwork: false;
  allowHostIpc: false;
  allowDeviceMounts: false;
};
```

MVP defaults:

```text
runAsUser: 65532 or 1000
runAsGroup: 65532 or 1000
readOnlyRootFilesystem: true
noNewPrivileges: true
dropAllCapabilities: true
allowedCapabilities: []
seccompProfile: runtime_default
privileged: false
allowDockerSocket: false
allowHostPid: false
allowHostNetwork: false
allowHostIpc: false
allowDeviceMounts: false
```

### 9.10 SandboxOutputPolicy

```ts
export type SandboxOutputPolicy = {
  captureStdout: boolean;
  captureStderr: boolean;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  truncateStrategy: "head" | "tail" | "head_and_tail";
  redactSecrets: boolean;
  normalizeAnsi: boolean;
  storeRawOutput: boolean;
};
```

Default:

```text
capture stdout/stderr
strip ANSI/control sequences
redact known secrets
truncate head+tail
store bounded raw output only if policy allows
```

### 9.11 SandboxArtifactPolicy

```ts
export type SandboxArtifactPolicy = {
  outputDirectory: string; // inside sandbox, usually /out
  collectFiles: SandboxArtifactGlob[];
  maxFiles: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
};

export type SandboxArtifactGlob = {
  pattern: string;
  required: boolean;
};
```

MVP artifacts:

```text
/out/report.json
/out/tool-output.json
/out/sarif.json
```

Do not collect arbitrary globs by default.

---

## 10. Result contracts

### 10.1 SandboxRunResult

```ts
export type SandboxRunResult = {
  schemaVersion: "sandbox_run_result.v1";

  requestId: string;
  runId: string;
  status:
    | "succeeded"
    | "failed"
    | "timed_out"
    | "killed"
    | "policy_denied"
    | "resource_exceeded"
    | "runner_error";

  exitCode: number | null;
  signal?: string;

  startedAt: string;
  finishedAt: string;
  durationMs: number;

  stdout: SandboxCapturedOutput;
  stderr: SandboxCapturedOutput;
  artifacts: SandboxRunArtifact[];

  resourceUsage?: SandboxResourceUsage;
  runner: SandboxRunnerInfo;

  policyDecisions: SandboxPolicyDecision[];
  warnings: SandboxRunWarning[];
  error?: SandboxRunError;
};
```

### 10.2 Captured output

```ts
export type SandboxCapturedOutput = {
  text: string;
  bytes: number;
  truncated: boolean;
  redacted: boolean;
  hash: string;
};
```

### 10.3 Resource usage

```ts
export type SandboxResourceUsage = {
  peakMemoryBytes?: number;
  cpuTimeMs?: number;
  pidsPeak?: number;
  diskWrittenBytes?: number;
  networkTxBytes?: number;
  networkRxBytes?: number;
};
```

### 10.4 Artifact

```ts
export type SandboxRunArtifact = {
  name: string;
  uri: string;
  sha256: string;
  sizeBytes: number;
  contentType?: string;
  truncated: boolean;
};
```

---

## 11. Runner implementations

### 11.1 FakeSandboxRunner

Used in tests.

```ts
export class FakeSandboxRunner implements SandboxRunner {
  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    return this.resultFor(request);
  }
}
```

Should support:

```text
- success result
- specific exit code
- timeout
- resource exceeded
- policy denied
- malformed artifact
- huge output
```

### 11.2 LocalProcessRunner

Use only for local development and trusted internal fixtures.

```text
Not allowed in production.
Not allowed for customer repos.
```

Purpose:

```text
- fast local tests
- fixture repos
- simple debugging
```

Must still enforce:

```text
- timeout
- output limits
- env allowlist
- working directory validation
```

But it should be clearly marked unsafe.

### 11.3 DockerContainerSandboxRunner

MVP production runner.

Responsibilities:

```text
- validate request against policy
- build Docker/container runtime command
- create isolated output directory
- create tmp/cache directories
- run container with hardened options
- collect bounded stdout/stderr
- collect artifacts
- kill on timeout
- remove container
- cleanup temporary dirs
```

Example Docker flags conceptually:

```bash
docker run --rm \
  --network none \
  --user 65532:65532 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --security-opt seccomp=default \
  --pids-limit 256 \
  --memory 2g \
  --cpus 2 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m \
  --mount type=bind,src=/host/workspace,dst=/workspace,readonly \
  --mount type=bind,src=/host/out,dst=/out \
  --workdir /workspace \
  reviewer-tools-node@sha256:<digest> \
  tsc --noEmit --pretty false
```

Notes:

```text
- Exact flags vary by runtime and deployment platform.
- The command builder should be tested as data, not hand-built inline.
- Do not use shell string concatenation.
- Use argv arrays.
```

### 11.4 GVisorSandboxRunner

Production hardening path.

If Docker is configured with gVisor/runsc:

```bash
docker run --runtime=runsc ...
```

If Kubernetes is used:

```yaml
runtimeClassName: gvisor
```

The interface remains identical:

```ts
class GVisorSandboxRunner implements SandboxRunner {
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
}
```

Use this for:

```text
- fork PRs
- untrusted authors
- enterprise strict repos when microVM is not available
```

### 11.5 MicroVmSandboxRunner

Future high-isolation runner.

Potential implementation:

```text
- Firecracker microVM per command or per short-lived batch
- rootfs image with toolchain
- workspace mounted as block device or transferred archive
- output collected through vsock, serial, or mounted output device
- strict network policy
- cgroup limits on VMM
- jailer enabled
```

The important part is preserving the same contract:

```text
SandboxRunRequest -> SandboxRunResult
```

---

## 12. Runner registry

```ts
export type SandboxRunnerKind =
  | "fake"
  | "local_process"
  | "docker"
  | "gvisor"
  | "microvm"
  | "remote";

export interface SandboxRunnerRegistry {
  getRunner(kind: SandboxRunnerKind): SandboxRunner;
  chooseRunner(input: SandboxRunnerSelectionInput): SandboxRunner;
}
```

Selection input:

```ts
export type SandboxRunnerSelectionInput = {
  trustLevel: SandboxTrustLevel;
  category: SandboxExecutionCategory;
  orgPolicy: OrgSandboxPolicy;
  repoPolicy: RepoSandboxPolicy;
  toolPolicy: ToolSandboxPolicy;
};
```

Default selection:

```ts
function chooseRunner(input: SandboxRunnerSelectionInput): SandboxRunnerKind {
  if (input.trustLevel === "metadata_only") return "fake";
  if (input.trustLevel === "external_fork") return "gvisor";
  if (input.trustLevel === "enterprise_strict") return "microvm";
  return "docker";
}
```

If a stricter runner is unavailable, prefer policy denial over silent downgrade.

---

## 13. Policy compiler

The sandbox policy should be compiled from:

```text
- org settings
- repo settings
- ReviewPolicySnapshot from #22
- PR trust level
- tool registry entry from #23
- command category
- deployment capabilities
```

### 13.1 Tool policy

```ts
export type ToolSandboxPolicy = {
  toolName: string;
  allowedImages: string[];
  defaultImage: string;
  allowedCommands: string[][];
  allowShell: boolean;
  allowNetwork: boolean;
  allowRepoConfigExecution: boolean;
  allowDependencyInstall: boolean;
  allowedWritePaths: string[];
  defaultLimits: SandboxResourceLimits;
  maxLimits: SandboxResourceLimits;
};
```

Example for Ruff:

```ts
const ruffPolicy: ToolSandboxPolicy = {
  toolName: "ruff",
  allowedImages: ["reviewer-tools-python@sha256:..."],
  defaultImage: "reviewer-tools-python@sha256:...",
  allowedCommands: [["ruff", "check"]],
  allowShell: false,
  allowNetwork: false,
  allowRepoConfigExecution: true,
  allowDependencyInstall: false,
  allowedWritePaths: ["/tmp", "/out"],
  defaultLimits: mediumLimits,
  maxLimits: largeLimits,
};
```

Example for ESLint:

```ts
const eslintPolicy: ToolSandboxPolicy = {
  toolName: "eslint",
  allowedImages: ["reviewer-tools-node@sha256:..."],
  defaultImage: "reviewer-tools-node@sha256:...",
  allowedCommands: [["eslint"]],
  allowShell: false,
  allowNetwork: false,
  allowRepoConfigExecution: true, // JS configs/plugins may execute code
  allowDependencyInstall: false,
  allowedWritePaths: ["/tmp", "/out"],
  defaultLimits: mediumLimits,
  maxLimits: largeLimits,
};
```

If repo config execution is true, raise the required isolation level.

```text
ESLint config/plugin execution should be treated as untrusted code execution.
```

### 13.2 Policy output

```ts
export type CompiledSandboxPolicy = {
  runnerKind: SandboxRunnerKind;
  trustLevel: SandboxTrustLevel;
  image: SandboxImageSpec;
  command: SandboxCommandSpec;
  environment: SandboxEnvironmentSpec;
  mounts: SandboxMountSpec[];
  network: SandboxNetworkPolicy;
  limits: SandboxResourceLimits;
  output: SandboxOutputPolicy;
  artifacts: SandboxArtifactPolicy;
  security: SandboxSecurityPolicy;
  decisions: SandboxPolicyDecision[];
};
```

---

## 14. Command safety

### 14.1 No shell by default

Always execute with argv arrays.

Good:

```ts
argv: ["ruff", "check", "--output-format", "json", "."]
```

Bad:

```ts
argv: ["sh", "-c", "ruff check . && cat report.json"]
```

### 14.2 Tool command allowlist

Each tool adapter from #23 should define allowed command shapes.

Example:

```ts
const allowedCommand = command.argv[0] === "ruff"
  && command.argv.includes("check")
  && !command.argv.some(arg => arg.startsWith("--config") && pointsOutsideWorkspace(arg));
```

Reject:

```text
- absolute host paths
- parent traversal paths
- shell metacharacter commands
- process substitution
- unrecognized binaries
- arbitrary repo scripts
```

### 14.3 Working directory

Working directory must be inside the sandbox mount.

```ts
assertInsideSandboxPath(command.workingDirectory, ["/workspace"]);
```

### 14.4 Path arguments

Normalize path arguments and reject:

```text
- ../../etc/passwd
- /host/path
- symlink-resolved path outside workspace
- paths pointing to mounted output/cache unless allowed
```

---

## 15. Workspace policy

### 15.1 Read-only workspace by default

Most tools can inspect without writing source files.

Use:

```text
/workspace -> read-only
/tmp       -> writable tmpfs
/out       -> writable output dir
```

Some tools write caches or generated metadata. Redirect caches into `/tmp/cache`.

### 15.2 Copy-on-write workspace

For tools that require writing inside the project directory:

```text
- copy only changed/relevant files into a disposable directory
- mount that disposable copy writable
- never write into the repo-sync worktree directly
```

### 15.3 Symlink handling

Before execution:

```text
- scan workspace for symlinks in relevant paths
- record symlink count
- reject or neutralize symlinks pointing outside workspace
- avoid following symlinks during artifact collection
```

During artifact collection:

```text
- lstat first
- reject symlink artifacts
- resolve realpath and verify inside output dir
```

### 15.4 File limits

The sandbox runner should enforce or pre-check:

```text
- max files considered
- max file size
- max total workspace bytes
- max output files
- max artifact bytes
```

Large repos should degrade gracefully:

```text
- skip heavy tools
- run changed-files-only mode
- emit static analysis skipped reason
```

---

## 16. Network policy

### 16.1 Default: no network

For static analysis MVP:

```text
network.mode = none
```

This blocks:

```text
- dependency download
- telemetry
- source-code exfiltration
- internal network probing
- metadata endpoint access
```

### 16.2 Later: controlled egress

If dependency downloads are enabled later, use:

```text
- isolated network namespace
- egress proxy
- explicit domain allowlist
- private IP range block
- metadata endpoint block
- connection logging
- bandwidth limits
- no direct VPC access
```

### 16.3 Never expose internal services

The sandbox should not be able to reach:

```text
- Postgres
- Redis
- API server
- worker service
- object storage credentials
- model-provider credentials
- Kubernetes API
- Docker socket
- cloud metadata endpoints
```

---

## 17. Environment and secrets

### 17.1 Empty inherited environment

Do not inherit host environment.

```ts
inheritHostEnv: false
```

Build env explicitly.

### 17.2 Secret scrubbing

Before launching:

```text
- no GitHub token
- no database URL
- no model API keys
- no cloud credentials
- no SSH agent
- no kubeconfig
```

After execution:

```text
- redact known secret patterns from output
- redact known token values from output if any existed
- redact installation IDs/tokens from logs
- bound output size before storing
```

### 17.3 Token never enters sandbox

The repo should already be checked out by #8 Repo Sync.

Static-analysis commands should not need GitHub credentials.

---

## 18. Resource enforcement

### 18.1 Timeouts

Every execution must have:

```text
- hard timeout
- graceful shutdown period
- forced kill
```

Flow:

```text
start command
  -> wait until timeoutMs
  -> send SIGTERM / stop container
  -> wait gracefulShutdownMs
  -> kill container/process
  -> mark timed_out/killed
  -> cleanup
```

### 18.2 CPU

Use runtime-specific CPU limits:

```text
Docker: --cpus
Kubernetes: resources.limits.cpu
Firecracker: vCPU count and cgroup limits
```

### 18.3 Memory

Use memory limits and treat OOM as `resource_exceeded`.

```text
Docker: --memory
Kubernetes: resources.limits.memory
Firecracker: guest memory + cgroup
```

### 18.4 PID limit

Set bounded process counts.

```text
Docker: --pids-limit
Kubernetes: pod PID limits where available / runtime config
Firecracker: guest-level and cgroup controls
```

### 18.5 Disk and output

Limit:

```text
- tmpfs size
- output directory size
- artifact count
- artifact bytes
- stdout/stderr bytes
```

A malicious tool can print gigabytes of output. The output collector must stop reading after the configured limit and continue draining/terminating safely.

---

## 19. Container hardening baseline

For container-based execution, require:

```text
- non-root user
- read-only root filesystem
- no privileged containers
- no Docker socket
- no host PID namespace
- no host network namespace
- no host IPC namespace
- no device mounts
- drop all Linux capabilities
- no-new-privileges
- seccomp enabled
- AppArmor/SELinux where available
- explicit tmpfs/write mounts only
- network disabled by default
- memory/CPU/PID limits
```

Kubernetes pod security equivalent:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 65532
  runAsGroup: 65532
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  seccompProfile:
    type: RuntimeDefault
  capabilities:
    drop:
      - ALL
```

Container:

```yaml
resources:
  limits:
    cpu: "2"
    memory: "2Gi"
  requests:
    cpu: "250m"
    memory: "512Mi"
```

Volume strategy:

```yaml
volumes:
  - name: tmp
    emptyDir:
      medium: Memory
      sizeLimit: 512Mi
  - name: out
    emptyDir:
      sizeLimit: 256Mi
```

---

## 20. Kubernetes execution model

If this runs on Kubernetes, there are two viable models.

### 20.1 Worker launches Docker/container runtime locally

Simpler for early deployments but riskier operationally.

```text
worker pod/node
  -> local container runtime
  -> sandbox container
```

Avoid mounting the Docker socket into worker pods. If a worker has Docker socket access, compromise of the worker often means compromise of the node.

### 20.2 Worker creates sandbox pods/jobs

More cloud-native.

```text
worker
  -> Kubernetes API create Job/Pod
  -> sandbox pod runs tool
  -> output collected from logs/artifacts
  -> pod deleted
```

Benefits:

```text
- Kubernetes-native resource limits
- RuntimeClass support for gVisor
- namespace-level policies
- easier node isolation
- easier autoscaling
```

Costs:

```text
- more latency
- more operational complexity
- service account/RBAC design required
- artifact transfer required
```

Recommended production model:

```text
Worker creates short-lived sandbox jobs in a dedicated namespace.
Sandbox namespace enforces restricted pod security.
Untrusted jobs use gVisor RuntimeClass where available.
```

Dedicated namespace:

```text
reviewer-sandboxes
```

Namespace policy:

```text
- restricted Pod Security Admission
- no default service account token automount
- network policies deny all egress by default
- resource quotas
- limit ranges
- short TTL for finished jobs
```

---

## 21. Remote sandbox service

Longer term, isolate sandbox execution into its own service or cluster.

```text
review-worker
  -> Sandbox API
  -> sandbox runner cluster
  -> result/artifacts
```

Advantages:

```text
- isolates risky execution from review/index workers
- separate autoscaling
- separate node pool
- separate IAM permissions
- easy gVisor/Firecracker specialization
- clear audit boundary
```

Remote API:

```http
POST /v1/runs
GET  /v1/runs/:id
GET  /v1/runs/:id/artifacts/:name
```

Request body:

```json
{
  "schemaVersion": "sandbox_run_request.v1",
  "requestId": "sbox_req_...",
  "trustLevel": "untrusted_pr",
  "workspace": { "workspaceId": "ws_..." },
  "command": { "argv": ["ruff", "check", "--output-format", "json", "."] }
}
```

Authentication:

```text
- mTLS or internal service token
- request signed by worker
- short expiration
- org/repo IDs included for audit
```

Do not expose remote sandbox API publicly.

---

## 22. Tool images

### 22.1 First-party tool images

Build and publish controlled images:

```text
reviewer-tools-node
reviewer-tools-python
reviewer-tools-go
reviewer-tools-rust
reviewer-tools-semgrep
```

Each image should:

```text
- be pinned by digest in policy
- have minimal base image
- include only required tools
- run as non-root by default
- not include cloud credentials
- not include package manager credentials
- not include SSH clients unless needed
- not include Docker CLI unless explicitly needed, usually not
- expose no services
```

### 22.2 Image versioning

```text
image name: reviewer-tools-node
image tag: 2026.04.0
image digest: sha256:...
tool versions: recorded in image metadata
```

The tool registry should record:

```ts
export type ToolImage = {
  image: string;
  digest: string;
  tools: Array<{ name: string; version: string }>;
  builtAt: string;
  sbomUri?: string;
};
```

### 22.3 Image supply-chain checks

MVP:

```text
- pin digests
- use first-party images
- no arbitrary image pull
```

Later:

```text
- SBOMs
- vulnerability scans
- image signing
- admission policy requiring signed images
```

---

## 23. Dependency installation policy

Dependency installation is dangerous because it often executes arbitrary scripts.

Default MVP:

```text
allowDependencyInstall: false
```

Prefer:

```text
- run tools that do not need dependency installation
- use prebuilt tool images
- analyze changed files only
- use manifest-aware but install-free checks
```

If dependency installation is added later:

```text
- only in high-isolation runner
- no host credentials
- network egress allowlist through proxy
- package script restrictions where possible
- cache isolated by tenant/repo/toolchain
- lockfile required
- time/memory/disk limits
- output and artifact limits
```

Ecosystem considerations:

```text
npm/pnpm/yarn: install scripts can execute code
Python: setup.py/PEP build backends can execute code
Go: module fetching uses network and can execute toolchain steps
Rust: build.rs can execute code during builds
Java/Maven/Gradle: plugins can execute code and fetch dependencies
```

Rule of thumb:

```text
If the command can install dependencies or run build scripts, treat it as arbitrary code execution.
```

---

## 24. Tool-specific policies

### 24.1 ESLint

Risks:

```text
- JS config files execute code
- plugins execute code
- parser packages execute code
- dependency installation may execute scripts
```

MVP policy:

```text
- only run if node_modules/dependencies are already available in workspace or image
- no npm install
- no network
- gVisor for untrusted PRs
- changed-files-only by default
- output JSON
```

Command:

```text
eslint --format json <changed files>
```

### 24.2 TypeScript `tsc`

Risks:

```text
- project references may traverse large repos
- plugins can execute code
- memory can spike
```

MVP policy:

```text
- no emit
- no pretty output
- timeout and memory cap
- trusted/private only unless gVisor available
```

Command:

```text
tsc --noEmit --pretty false
```

### 24.3 Biome

Risks:

```text
- lower arbitrary execution risk than ESLint
- still can scan huge repos and produce large output
```

MVP policy:

```text
- no network
- changed-files-only where possible
- JSON output
```

### 24.4 Ruff

Risks:

```text
- lower arbitrary execution risk than Python test execution
- config is data-oriented
- output/resource exhaustion still possible
```

MVP policy:

```text
- safe default static tool
- no network
- changed-files-only
- JSON output
```

Command:

```text
ruff check --output-format json <changed files>
```

### 24.5 Pyright

Risks:

```text
- may scan large environment
- type checking can be memory-heavy
- Python environment/dependencies may be missing
```

MVP policy:

```text
- no dependency install
- JSON output
- time/memory limit
- skip if project config requires unavailable venv
```

Command:

```text
pyright --outputjson
```

### 24.6 Semgrep

Risks:

```text
- rule execution can be expensive
- remote rule fetching needs network
- excessive findings/output
```

MVP policy:

```text
- local/bundled rules only
- no network
- JSON or SARIF output
- limit ruleset size
- limit output
```

### 24.7 Go vet / staticcheck

Risks:

```text
- module fetching may require network
- build constraints may be expensive
```

MVP policy:

```text
- no network
- run only if dependencies available or module cache policy is configured
- time/memory limits
```

### 24.8 Cargo check / clippy

Risks:

```text
- build.rs executes arbitrary code
- dependency fetching requires network
- compile can be expensive
```

MVP policy:

```text
- skip for untrusted PRs unless gVisor/microVM and dependency policy is explicit
- no network by default
- strict timeout
```

### 24.9 Custom commands

Default:

```text
custom commands disabled
```

If enabled later:

```text
- trusted repo only by default
- explicit allowlist
- no shell if possible
- no network unless allowlisted
- strict time/memory limits
- audited policy decision
```

---

## 25. Database tables

The DB layer from #2 may need these tables.

### 25.1 sandbox_runs

```sql
create table sandbox_runs (
  id text primary key,
  org_id text not null references orgs(id),
  repo_id text not null references repositories(id),
  review_run_id text references review_runs(id),
  static_analysis_run_id text,
  tool_run_id text,

  request_id text not null unique,
  runner_kind text not null,
  trust_level text not null,
  category text not null,

  image text not null,
  image_digest text,
  command_json jsonb not null,
  policy_json jsonb not null,
  limits_json jsonb not null,

  status text not null,
  exit_code integer,
  signal text,

  stdout_hash text,
  stderr_hash text,
  stdout_truncated boolean not null default false,
  stderr_truncated boolean not null default false,

  resource_usage_json jsonb,
  error_json jsonb,
  warnings_json jsonb not null default '[]'::jsonb,

  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sandbox_runs_review_run_idx on sandbox_runs(review_run_id);
create index sandbox_runs_repo_created_idx on sandbox_runs(repo_id, created_at desc);
create index sandbox_runs_status_idx on sandbox_runs(status);
```

### 25.2 sandbox_artifacts

```sql
create table sandbox_artifacts (
  id text primary key,
  sandbox_run_id text not null references sandbox_runs(id) on delete cascade,
  name text not null,
  uri text not null,
  sha256 text not null,
  size_bytes bigint not null,
  content_type text,
  truncated boolean not null default false,
  created_at timestamptz not null default now(),
  unique(sandbox_run_id, name)
);
```

### 25.3 sandbox_policy_decisions

```sql
create table sandbox_policy_decisions (
  id text primary key,
  sandbox_run_id text not null references sandbox_runs(id) on delete cascade,
  decision text not null,
  reason text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

### 25.4 sandbox_node_health optional

```sql
create table sandbox_node_health (
  id text primary key,
  runner_kind text not null,
  hostname text not null,
  status text not null,
  disk_free_bytes bigint,
  active_runs integer,
  last_heartbeat_at timestamptz not null,
  details jsonb not null default '{}'::jsonb
);
```

---

## 26. Object storage artifacts

Store bounded outputs and artifacts in object storage when needed.

Suggested layout:

```text
s3://reviewer-artifacts/orgs/{orgId}/repos/{repoId}/reviews/{reviewRunId}/sandbox/{sandboxRunId}/stdout.txt
s3://reviewer-artifacts/orgs/{orgId}/repos/{repoId}/reviews/{reviewRunId}/sandbox/{sandboxRunId}/stderr.txt
s3://reviewer-artifacts/orgs/{orgId}/repos/{repoId}/reviews/{reviewRunId}/sandbox/{sandboxRunId}/report.json
```

Artifacts should include:

```text
- sha256
- byte size
- content type
- redaction status
- truncation status
- retention class
```

Never store:

```text
- unbounded raw logs
- tokens
- full environment dumps
- full filesystem archives
- dependency caches
```

---

## 27. Integration with #23 Static Analysis

#23 should call the sandbox via tool adapters.

```ts
export interface StaticToolAdapter {
  plan(input: ToolPlanInput): Promise<ToolRunPlan>;
  parse(result: SandboxRunResult): Promise<NormalizedToolDiagnostic[]>;
}
```

ToolRunPlan includes sandbox request pieces:

```ts
export type ToolRunPlan = {
  toolName: string;
  sandbox: SandboxRunRequest;
  parser: ToolOutputParserKind;
};
```

Flow:

```text
StaticAnalysisPlanner
  -> ToolRunPlan[]
  -> SandboxRunner.run()
  -> SandboxRunResult
  -> ToolAdapter.parse()
  -> NormalizedToolDiagnostic[]
  -> StaticAnalysisReport
```

Static analysis should treat sandbox failures explicitly:

```text
- tool skipped by policy
- tool timed out
- tool failed due to missing deps
- tool failed due to resource limit
- tool failed due to runner error
```

Do not hide these failures as “no findings.”

---

## 28. Integration with #16 Review Orchestrator

The orchestrator should not run commands directly.

It should:

```text
1. obtain WorkspaceLease from #8
2. obtain ReviewPolicySnapshot from #22
3. ask #23 StaticAnalysisEngine to run enabled tools
4. #23 calls #24 SandboxRunner
5. store StaticAnalysisReport artifact
6. pass report into #18 Review Passes and #19 Validation
```

Orchestrator stage example:

```text
stage: static_analysis
status: running | skipped | completed | failed_non_blocking | failed_blocking
```

Recommended default:

```text
Static analysis failures are non-blocking for PR review.
```

Except:

```text
- policy requires static tool result
- enterprise setting requires check-run failure on tool failure
- sandbox runner itself is unhealthy and org has strict policy
```

---

## 29. Integration with #22 Rules and Configuration

#22 should decide:

```text
- whether tool execution is enabled
- which tools are enabled
- whether untrusted fork PRs can run tools
- runner minimum level
- network policy
- dependency install policy
- max time/memory/cost
- custom command policy
```

Example settings:

```ts
export type SandboxSettings = {
  enabled: boolean;
  defaultRunner: "docker" | "gvisor" | "microvm";
  minimumRunnerForForks: "gvisor" | "microvm" | "disabled";
  allowNetwork: boolean;
  allowDependencyInstall: boolean;
  allowCustomCommands: boolean;
  maxTimeoutMs: number;
  maxMemoryBytes: number;
  maxCpuCount: number;
  maxOutputBytes: number;
};
```

The compiled ReviewPolicySnapshot should include the resolved sandbox policy.

---

## 30. Output redaction

Redaction should happen before logs/artifacts are persisted.

Redact:

```text
- known secret values from config
- GitHub token patterns
- OpenAI/Anthropic API key patterns
- AWS/GCP/Azure credential patterns
- private key PEM blocks
- database URLs
- Redis URLs
- webhook secrets
- internal service URLs if configured
```

But redaction should be careful not to destroy diagnostic usefulness.

Store metadata:

```text
redacted: true/false
redaction_count
redaction_patterns_applied
```

Never include unredacted sandbox output in:

```text
- logs
- traces
- LLM prompts
- dashboard views
- GitHub comments
```

Unless explicitly approved by policy and access controls.

---

## 31. Logging and observability

### 31.1 Logs

Every sandbox run should log:

```text
- request id
- sandbox run id
- org id
- repo id
- review run id
- tool name/category
- runner kind
- trust level
- image digest
- status
- duration
- exit code
- timeout/resource errors
```

Do not log:

```text
- command output by default
- environment variables
- host paths containing secrets
- tokens
- raw repo content
```

### 31.2 Metrics

Recommended metrics:

```text
sandbox_runs_total{runner, status, category}
sandbox_run_duration_ms{runner, category}
sandbox_timeouts_total{runner, category}
sandbox_resource_exceeded_total{kind}
sandbox_policy_denied_total{reason}
sandbox_output_truncated_total{stream}
sandbox_artifact_bytes_total{category}
sandbox_active_runs{runner}
sandbox_runner_errors_total{runner}
```

### 31.3 Tracing

Span:

```text
sandbox.run
```

Attributes:

```text
runner.kind
tool.name
trust.level
repo.id
review.run.id
sandbox.status
sandbox.exit_code
sandbox.duration_ms
sandbox.timeout_ms
sandbox.memory_limit_bytes
```

Do not attach raw stdout/stderr to traces.

---

## 32. Error model

```ts
export type SandboxErrorCode =
  | "policy_denied"
  | "invalid_request"
  | "image_not_allowed"
  | "image_pull_failed"
  | "workspace_invalid"
  | "mount_invalid"
  | "command_not_allowed"
  | "timeout"
  | "oom"
  | "pid_limit_exceeded"
  | "disk_limit_exceeded"
  | "output_limit_exceeded"
  | "artifact_collection_failed"
  | "runner_unavailable"
  | "runtime_error"
  | "cleanup_failed";

export type SandboxRunError = {
  code: SandboxErrorCode;
  message: string;
  details?: Record<string, unknown>;
};
```

Failure handling:

| Error | Static-analysis behavior | Review behavior |
|---|---|---|
| `policy_denied` | mark tool skipped | continue review |
| `timeout` | mark tool timed out | continue unless strict policy |
| `oom` | mark resource exceeded | continue unless strict policy |
| `image_pull_failed` | runner error | continue / alert |
| `workspace_invalid` | stage failed | maybe retry from repo sync |
| `cleanup_failed` | alert | quarantine runner if severe |

---

## 33. Idempotency

Sandbox runs should be idempotent at the planning layer.

Compute a run fingerprint:

```text
fingerprint = hash(
  repoId,
  commitSha,
  toolName,
  toolVersion,
  imageDigest,
  command argv,
  relevant file hashes,
  policy version,
  limits profile
)
```

If the same tool run has already succeeded for the same fingerprint, it can be reused if policy allows.

Do not reuse:

```text
- failed runs by default
- runs with different policy
- runs from different trust boundary
- runs with different image digest
- runs with different relevant file hashes
```

---

## 34. Cleanup and quarantine

### 34.1 Cleanup

Every runner must cleanup:

```text
- containers/pods/VMs
- tmp dirs
- output dirs after artifact upload
- copied workspaces
- stale locks
```

Use finalizers:

```ts
try {
  return await execute();
} finally {
  await cleanupBestEffort();
}
```

### 34.2 Quarantine

If cleanup fails or runner health is suspicious:

```text
- mark sandbox node unhealthy
- stop scheduling new runs to it
- emit alert
- require maintenance job or restart
```

Quarantine triggers:

```text
- repeated cleanup failures
- orphaned containers above threshold
- disk below threshold
- runner runtime errors above threshold
- unexpected network activity if monitored
```

---

## 35. Security review checklist

Before production use, verify:

```text
[ ] No Docker socket is mounted into sandbox containers.
[ ] Sandbox containers run as non-root.
[ ] Privileged mode is disabled.
[ ] Host namespaces are disabled.
[ ] Capabilities are dropped.
[ ] no-new-privileges is enabled.
[ ] Seccomp is enabled.
[ ] Root filesystem is read-only.
[ ] Workspace mount is read-only by default.
[ ] Writable mounts are tmpfs/disposable and size-limited.
[ ] Network is disabled by default.
[ ] Metadata endpoints are blocked when network exists.
[ ] Env vars are allowlisted.
[ ] No GitHub/model/db/cloud tokens enter the sandbox.
[ ] stdout/stderr are bounded.
[ ] Artifacts are bounded.
[ ] Timeouts are enforced.
[ ] Memory/CPU/PID limits are enforced.
[ ] Symlinks are handled safely.
[ ] Artifact collection refuses path traversal.
[ ] Cleanup is best-effort and monitored.
[ ] Runner nodes can be quarantined.
[ ] Dashboard output is redacted.
[ ] LLM prompts do not include raw unredacted tool output.
```

---

## 36. Testing strategy

### 36.1 Unit tests

Test:

```text
- policy compilation
- runner selection
- image allowlist validation
- command allowlist validation
- env scrubber
- mount generation
- path normalization
- symlink rejection
- output truncation
- redaction
- artifact validation
- error mapping
```

### 36.2 Integration tests

Use fixture repos with commands that:

```text
- exit 0
- exit nonzero
- time out
- print huge stdout
- print huge stderr
- create too many files
- create oversized artifact
- attempt to read env vars
- attempt to write outside workspace
- attempt to access network
- attempt fork bomb
- create symlink to outside output dir
```

Expected results:

```text
- runner contains damage
- output is bounded
- artifacts are bounded
- policy denies unsafe requests
- cleanup succeeds
```

### 36.3 Security regression fixtures

Create fixture commands:

```text
fixtures/sandbox/attempt-read-env
fixtures/sandbox/attempt-read-host-path
fixtures/sandbox/attempt-network
fixtures/sandbox/fork-bomb
fixtures/sandbox/output-bomb
fixtures/sandbox/artifact-path-traversal
fixtures/sandbox/symlink-escape
fixtures/sandbox/write-workspace
fixtures/sandbox/read-docker-socket
```

### 36.4 Smoke tests

In staging:

```text
- run ruff against a Python fixture
- run eslint against a JS fixture
- run tsc against a TS fixture
- verify no network
- verify no secrets
- verify output/artifacts collected
```

---

## 37. Dashboard and API surfaces

### 37.1 Dashboard

Add to review run detail:

```text
Static analysis tab
  - tool runs
  - sandbox status
  - duration
  - exit code
  - resource usage
  - skipped/failed reason
  - bounded stdout/stderr viewer
  - artifacts
  - policy decisions
```

Admin/debug page:

```text
Sandbox runs
  - filter by org/repo/status/runner/tool
  - runner health
  - failure rate
  - quarantined nodes
```

### 37.2 API

Read-only endpoints:

```text
GET /orgs/:orgId/repos/:repoId/reviews/:reviewRunId/sandbox-runs
GET /orgs/:orgId/repos/:repoId/reviews/:reviewRunId/sandbox-runs/:sandboxRunId
GET /orgs/:orgId/repos/:repoId/reviews/:reviewRunId/sandbox-runs/:sandboxRunId/artifacts/:artifactId
```

Admin endpoints:

```text
POST /admin/sandbox-runs/:sandboxRunId/retry
POST /admin/sandbox-nodes/:nodeId/quarantine
POST /admin/sandbox-nodes/:nodeId/unquarantine
```

Retry should be restricted and audited.

---

## 38. Local development

Local dev modes:

```text
SANDBOX_RUNNER=fake
SANDBOX_RUNNER=local_process
SANDBOX_RUNNER=docker
```

Recommended local default:

```text
SANDBOX_RUNNER=fake
```

For integration testing:

```text
SANDBOX_RUNNER=docker
```

Never allow `local_process` in production:

```ts
if (env.NODE_ENV === "production" && runnerKind === "local_process") {
  throw new Error("local_process sandbox runner is forbidden in production");
}
```

---

## 39. Implementation sequence

### PR 1: Package skeleton and contracts

```text
- create /packages/sandbox
- define SandboxRunRequest
- define SandboxRunResult
- define policy/limits/security contracts
- define error model
- add fake runner
- add tests for contracts
```

### PR 2: Policy compiler

```text
- compile sandbox policy from tool/repo/org settings
- runner selection
- command allowlist validation
- env allowlist validation
- mount policy validation
- limits validation
- tests
```

### PR 3: Output and artifact handling

```text
- stdout/stderr bounded collector
- ANSI/control char normalization
- redaction
- artifact collection
- path traversal/symlink checks
- object storage writer interface
- tests
```

### PR 4: Docker runner MVP

```text
- Docker command builder
- hardened run options
- timeout/kill behavior
- output capture
- artifact capture
- cleanup
- integration tests using fixture commands
```

### PR 5: Static-analysis integration

```text
- wire #23 ToolRunner to SandboxRunner
- run Ruff fixture
- run ESLint fixture
- run tsc fixture
- persist sandbox_runs
- dashboard read-only view
```

### PR 6: Production hardening

```text
- runner node health checks
- cleanup reconciliation
- quarantine support
- metrics/traces
- alerts
- resource limit tuning
```

### PR 7: gVisor support

```text
- gVisor runner kind
- runtime selection
- policy requiring gVisor for untrusted PRs
- integration smoke test
```

### PR 8: Remote sandbox service optional

```text
- /apps/sandbox-runner
- internal authenticated API
- job/pod execution model
- artifact transfer
- worker integration
```

### PR 9: MicroVM support optional

```text
- Firecracker runner prototype
- image/rootfs management
- workspace transfer
- output collection
- enterprise strict policy
```

---

## 40. MVP cut

For MVP, implement:

```text
- /packages/sandbox package
- contracts
- FakeSandboxRunner
- LocalProcessRunner only for local dev
- DockerContainerSandboxRunner
- policy compiler
- no shell execution
- no network execution
- non-root user
- read-only root filesystem
- dropped capabilities
- no-new-privileges
- seccomp runtime default
- no Docker socket
- workspace read-only by default
- tmp/output writable mounts
- time/memory/CPU/PID/output/artifact limits
- env allowlist
- secret redaction
- bounded output collection
- artifact collection
- sandbox_runs DB persistence
- integration with #23 static analysis
- dashboard read-only sandbox run view
- staging smoke tests
```

Do not implement in MVP:

```text
- dependency installation
- custom commands
- network allowlists
- full test execution
- arbitrary customer images
- Firecracker runner
- remote sandbox service
- shared dependency caches for untrusted PRs
```

---

## 41. Definition of done

This section is done when:

```text
[ ] Static analysis tools run only through SandboxRunner.
[ ] No production code uses raw process execution for repo commands outside the sandbox package.
[ ] Unsafe runner modes are blocked in production.
[ ] Sandbox requests are policy-validated before execution.
[ ] Tool commands are allowlisted.
[ ] Host environment is not inherited.
[ ] Secrets are not passed into sandbox commands.
[ ] Network is disabled by default.
[ ] Workspace is read-only by default.
[ ] Writable paths are disposable and size-limited.
[ ] CPU, memory, PID, timeout, output, and artifact limits are enforced.
[ ] stdout/stderr are captured, bounded, normalized, and redacted.
[ ] Artifacts are path-safe, bounded, hashed, and stored.
[ ] Sandbox runs are persisted and inspectable.
[ ] Static-analysis reports distinguish skipped, timed-out, failed, and successful tool runs.
[ ] Dashboard can show sandbox run details safely.
[ ] Malicious fixture tests are contained.
[ ] Cleanup/reconciliation jobs exist.
```

---

## 42. Open questions

These should be resolved before broader production rollout:

```text
1. Will production run sandbox jobs inside the same worker node, separate node pool, or separate sandbox cluster?
2. Is gVisor available in the deployment environment?
3. Are customer repos ever allowed to define custom commands?
4. Are dependency installs allowed, and under what trust level?
5. Should fork PRs run static tools at all, or only metadata/index-based review?
6. What is the default maximum review cost/time budget per org/repo?
7. What artifacts are visible to customers versus internal admins only?
8. What retention policy applies to sandbox outputs?
9. What is the escalation policy for suspected sandbox escape attempts?
10. Will enterprise customers require BYO sandbox runtime or self-hosted runner?
```

---

## 43. References

These references informed the hardening model and future runtime options:

- Docker Rootless Mode: https://docs.docker.com/engine/security/rootless/
- Docker Seccomp Security Profiles: https://docs.docker.com/engine/security/seccomp/
- Docker Resource Constraints: https://docs.docker.com/engine/containers/resource_constraints/
- Docker Engine Security: https://docs.docker.com/engine/security/
- Kubernetes Pod Security Standards: https://kubernetes.io/docs/concepts/security/pod-security-standards/
- Kubernetes Security Context: https://kubernetes.io/docs/tasks/configure-pod-container/security-context/
- OCI Runtime Spec Linux Configuration: https://github.com/opencontainers/runtime-spec/blob/master/config-linux.md
- OWASP Docker Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html
- gVisor Documentation: https://gvisor.dev/docs/
- gVisor runsc Runtime: https://github.com/google/gvisor
- Firecracker Jailer: https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md
- Firecracker Seccomp: https://github.com/firecracker-microvm/firecracker/blob/main/docs/seccomp.md
- Firecracker Overview: https://firecracker-microvm.github.io/
