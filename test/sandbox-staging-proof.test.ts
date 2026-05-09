import { describe, expect, it } from "vitest";
import {
  buildSandboxStagingProofRecord,
  sandboxStagingProofIssues,
} from "../scripts/sandbox-staging-proof";

type SandboxProofInput = Parameters<typeof buildSandboxStagingProofRecord>[0];
type SandboxRunInput = SandboxProofInput["sandboxRuns"][number];
type SandboxArtifactInput = SandboxRunInput["artifacts"][number];

describe("sandbox staging proof evidence", () => {
  it("accepts deployed sandbox run evidence with artifact and policy proof", () => {
    const record = buildSandboxStagingProofRecord(sandboxProofInput());

    expect(sandboxStagingProofIssues(record)).toEqual([]);
    expect(record.status).toBe("sandbox staging proof passed");
    expect(record.scope).toEqual({
      orgId: "org_staging",
      repoId: "repo_staging",
      reviewRunId: "review_run_staging",
    });
    expect(record.sandboxRuns[0]).toMatchObject({
      artifacts: [
        {
          name: "ruff.json",
          sha256: "0".repeat(64),
          sizeBytes: 512,
          truncated: false,
        },
      ],
      policyDecisionCounts: {
        allowed: 6,
        denied: 0,
        warning: 0,
      },
      runnerKind: "docker",
      status: "succeeded",
      stderrTruncated: false,
      stdoutTruncated: false,
    });
  });

  it("rejects local proof targets", () => {
    expect(() =>
      buildSandboxStagingProofRecord(
        sandboxProofInput({
          apiUrl: "http://localhost:3000",
        }),
      ),
    ).toThrow(/apiUrl must be deployed https/);
  });

  it("rejects missing sandbox run evidence", () => {
    expect(() =>
      buildSandboxStagingProofRecord(
        sandboxProofInput({
          sandboxRuns: [],
        }),
      ),
    ).toThrow(/at least one sandbox run is required/);
  });

  it("rejects unsafe runner, denied policy, and truncated outputs", () => {
    const invalidRun = sandboxRun({
      artifacts: [
        sandboxArtifact({
          truncated: true,
        }),
      ],
      policyDecisionCounts: {
        allowed: 2,
        denied: 1,
        warning: 0,
      },
      runnerKind: "local_process",
      stderrTruncated: true,
      stdoutTruncated: true,
    });

    expect(() =>
      buildSandboxStagingProofRecord(
        sandboxProofInput({
          sandboxRuns: [invalidRun],
        }),
      ),
    ).toThrow(/must not use local_process runner/);
    expect(() =>
      buildSandboxStagingProofRecord(
        sandboxProofInput({
          sandboxRuns: [invalidRun],
        }),
      ),
    ).toThrow(/has denied policy decisions/);
    expect(() =>
      buildSandboxStagingProofRecord(
        sandboxProofInput({
          sandboxRuns: [invalidRun],
        }),
      ),
    ).toThrow(/stdout must not be truncated/);
    expect(() =>
      buildSandboxStagingProofRecord(
        sandboxProofInput({
          sandboxRuns: [invalidRun],
        }),
      ),
    ).toThrow(/artifact ruff\.json must not be truncated/);
  });

  it("rejects sandbox runs outside the requested proof scope", () => {
    expect(() =>
      buildSandboxStagingProofRecord(
        sandboxProofInput({
          sandboxRuns: [
            sandboxRun({
              orgId: "org_other",
              repoId: "repo_other",
              reviewRunId: "review_run_other",
            }),
          ],
        }),
      ),
    ).toThrow(/orgId must match org_staging/);
    expect(() =>
      buildSandboxStagingProofRecord(
        sandboxProofInput({
          sandboxRuns: [
            sandboxRun({
              orgId: "org_other",
              repoId: "repo_other",
              reviewRunId: "review_run_other",
            }),
          ],
        }),
      ),
    ).toThrow(/repoId must match repo_staging/);
    expect(() =>
      buildSandboxStagingProofRecord(
        sandboxProofInput({
          sandboxRuns: [
            sandboxRun({
              orgId: "org_other",
              repoId: "repo_other",
              reviewRunId: "review_run_other",
            }),
          ],
        }),
      ),
    ).toThrow(/reviewRunId must match review_run_staging/);
  });

  it("rejects incomplete artifact proof", () => {
    expect(() =>
      buildSandboxStagingProofRecord(
        sandboxProofInput({
          sandboxRuns: [
            sandboxRun({
              artifacts: [
                sandboxArtifact({
                  sha256: "abc123",
                  sizeBytes: 0,
                }),
              ],
            }),
          ],
        }),
      ),
    ).toThrow(/sha256 is invalid/);
    expect(() =>
      buildSandboxStagingProofRecord(
        sandboxProofInput({
          sandboxRuns: [
            sandboxRun({
              artifacts: [],
            }),
          ],
        }),
      ),
    ).toThrow(/must include at least one artifact/);
  });
});

/** Creates sandbox staging proof input for tests. */
function sandboxProofInput(overrides: Partial<SandboxProofInput> = {}): SandboxProofInput {
  return {
    actor: {
      subject: "github_org:12345",
    },
    apiUrl: "https://api.staging.example.com",
    expectedStatus: "succeeded",
    gatewayUrl: "https://idp-gateway.staging.example.com",
    limit: 10,
    orgId: "org_staging",
    repoId: "repo_staging",
    reviewRunId: "review_run_staging",
    sandboxRuns: [sandboxRun()],
    ...overrides,
  };
}

/** Creates one sandbox run fixture for proof tests. */
function sandboxRun(overrides: Partial<SandboxRunInput> = {}): SandboxRunInput {
  return {
    artifacts: [sandboxArtifact()],
    category: "static_analysis",
    createdAt: "2026-05-08T21:00:00.000Z",
    exitCode: 0,
    finishedAt: "2026-05-08T21:00:02.000Z",
    image: "ghcr.io/heimdall/reviewer-tools-python:2026-05-08",
    orgId: "org_staging",
    policyDecisionCounts: {
      allowed: 6,
      denied: 0,
      warning: 0,
    },
    repoId: "repo_staging",
    requestId: "sandbox_request_staging",
    reviewRunId: "review_run_staging",
    runnerKind: "docker",
    sandboxRunId: "sandbox_run_staging",
    startedAt: "2026-05-08T21:00:01.000Z",
    status: "succeeded",
    stderrTruncated: false,
    stdoutTruncated: false,
    trustLevel: "untrusted",
    ...overrides,
  };
}

/** Creates one sandbox artifact fixture for proof tests. */
function sandboxArtifact(overrides: Partial<SandboxArtifactInput> = {}): SandboxArtifactInput {
  return {
    createdAt: "2026-05-08T21:00:02.000Z",
    name: "ruff.json",
    sandboxArtifactId: "sandbox_artifact_staging",
    sha256: "0".repeat(64),
    sizeBytes: 512,
    truncated: false,
    uri: "file:///var/lib/heimdall/sandbox/sandbox_run_staging/ruff.json",
    ...overrides,
  };
}
