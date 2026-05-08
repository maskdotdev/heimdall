import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDefaultSandboxEnvironment,
  createDockerContainerSandboxRunner,
  DEFAULT_SANDBOX_ARTIFACT_POLICY,
  DEFAULT_SANDBOX_NETWORK_POLICY,
  DEFAULT_SANDBOX_OUTPUT_POLICY,
  DEFAULT_SANDBOX_RESOURCE_LIMITS,
  DEFAULT_SANDBOX_SECURITY_POLICY,
  parseSandboxRunResult,
  type SandboxRunArtifact,
  type SandboxRunRequest,
  type SandboxRunResult,
} from "@repo/sandbox";

/** Default local Docker image used for the sandbox smoke. */
const DEFAULT_SANDBOX_SMOKE_IMAGE = "alpine:3.19";

/** Product-safe proof emitted by the local Docker sandbox smoke. */
type LocalSandboxDockerSmokeProof = {
  /** Collected artifact proof. */
  readonly artifact: SandboxArtifactProof;
  /** Number of artifacts collected from the sandbox output directory. */
  readonly artifactCount: number;
  /** Container image requested for the smoke. */
  readonly image: string;
  /** Count of denied sandbox policy decisions. */
  readonly policyDeniedCount: number;
  /** Sandbox runner kind used by the smoke. */
  readonly runner: SandboxRunResult["runner"]["kind"];
  /** Captured stderr byte count. */
  readonly stderrBytes: number;
  /** Smoke status. */
  readonly status: "passed";
  /** Captured stdout byte count. */
  readonly stdoutBytes: number;
};

/** Product-safe artifact summary. */
type SandboxArtifactProof = {
  /** Artifact file name. */
  readonly name: string;
  /** Artifact SHA-256 hash. */
  readonly sha256: string;
  /** Artifact size in bytes. */
  readonly sizeBytes: number;
};

/** Runs a local Docker sandbox smoke and prints product-safe proof JSON. */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "heimdall-sandbox-docker-smoke-"));
  const workspacePath = join(root, "workspace");
  const artifactRoot = join(root, "artifacts");
  const temporaryRoot = join(root, "tmp");
  const image = process.env.HEIMDALL_SANDBOX_SMOKE_IMAGE ?? DEFAULT_SANDBOX_SMOKE_IMAGE;
  const proofContent = '{"ok":true,"source":"heimdall-sandbox-docker-smoke"}';

  try {
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, "proof.json"), proofContent, "utf8");

    const runner = createDockerContainerSandboxRunner({
      artifactRoot,
      temporaryRoot,
    });
    const result = parseSandboxRunResult(
      await runner.run(
        sandboxSmokeRequest({
          image,
          workspacePath,
        }),
      ),
    );
    if (result.status !== "succeeded") {
      throw new Error(
        `Docker sandbox smoke failed with status ${result.status}: ${
          result.error?.code ?? "unknown_error"
        }; ${compactSandboxOutput(result)}`,
      );
    }

    const artifact = requiredArtifact(result.artifacts);
    const artifactContent = await readFile(fileURLToPath(artifact.uri), "utf8");
    if (artifactContent !== proofContent) {
      throw new Error("Docker sandbox smoke artifact content did not match the fixture.");
    }

    const proof: LocalSandboxDockerSmokeProof = {
      artifact: {
        name: artifact.name,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
      },
      artifactCount: result.artifacts.length,
      image,
      policyDeniedCount: result.policyDecisions.filter((decision) => decision.status === "denied")
        .length,
      runner: result.runner.kind,
      status: "passed",
      stderrBytes: result.stderr.bytes,
      stdoutBytes: result.stdout.bytes,
    };
    console.log(JSON.stringify(proof, null, 2));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

/** Builds the sandbox request used by the local Docker smoke. */
function sandboxSmokeRequest(input: {
  /** Container image to execute. */
  readonly image: string;
  /** Host workspace path mounted read-only into the sandbox. */
  readonly workspacePath: string;
}): SandboxRunRequest {
  return {
    artifacts: {
      ...DEFAULT_SANDBOX_ARTIFACT_POLICY,
      collectFiles: [{ pattern: "proof.json", required: true }],
      maxFiles: 1,
    },
    category: "static_tool",
    command: {
      argv: ["cp", "/workspace/proof.json", "/out/proof.json"],
      expectedExitCodes: [0],
      shell: false,
      stdin: "none",
      workingDirectory: "/workspace",
    },
    createdAt: "2026-05-08T00:00:00.000Z",
    environment: createDefaultSandboxEnvironment(),
    image: {
      allowedImageClass: "first_party_static_tools",
      image: input.image,
      pullPolicy: "never",
    },
    limits: {
      ...DEFAULT_SANDBOX_RESOURCE_LIMITS,
      maxArtifactBytes: 64_000,
      maxDiskBytes: 64_000_000,
      maxStderrBytes: 4_096,
      maxStdoutBytes: 4_096,
      timeoutMs: 10_000,
    },
    mounts: [
      {
        purpose: "workspace",
        readOnly: true,
        source: input.workspacePath,
        target: "/workspace",
        type: "bind",
      },
    ],
    network: { ...DEFAULT_SANDBOX_NETWORK_POLICY },
    orgId: "org_sandbox_smoke",
    output: {
      ...DEFAULT_SANDBOX_OUTPUT_POLICY,
      maxStderrBytes: 4_096,
      maxStdoutBytes: 4_096,
      truncateStrategy: "head",
    },
    repoId: "repo_sandbox_smoke",
    requestId: "sandbox_smoke_request",
    schemaVersion: "sandbox_run_request.v1",
    security: {
      ...DEFAULT_SANDBOX_SECURITY_POLICY,
      allowedCapabilities: [...DEFAULT_SANDBOX_SECURITY_POLICY.allowedCapabilities],
    },
    trustLevel: "trusted_pr",
    workspace: {
      allowedWritePaths: ["/out", "/tmp"],
      commitSha: "sandbox_smoke_head",
      mode: "read_only",
      mountPath: "/workspace",
      workspaceId: "workspace_sandbox_smoke",
      workspacePath: input.workspacePath,
    },
  };
}

/** Returns the single required smoke artifact. */
function requiredArtifact(artifacts: readonly SandboxRunArtifact[]): SandboxRunArtifact {
  const artifact = artifacts.find((item) => item.name === "proof.json");
  if (!artifact) {
    throw new Error("Docker sandbox smoke did not collect proof.json.");
  }

  return artifact;
}

/** Returns bounded captured output for local smoke failures. */
function compactSandboxOutput(result: SandboxRunResult): string {
  const output = [result.stdout.text.trim(), result.stderr.text.trim()]
    .filter((stream) => stream.length > 0)
    .join("\n");
  if (output.length === 0) {
    return "no captured output";
  }

  return output.length > 1_000 ? `${output.slice(0, 1_000)}...` : output;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
