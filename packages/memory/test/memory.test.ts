import { describe, expect, it } from "vitest";
import {
  activateMemoryCandidate,
  actorCanRunCommand,
  applySignalsToOutcome,
  buildReviewerMarker,
  classifyFeedbackEvent,
  createFindingFingerprint,
  createMemoryCandidatesFromCommand,
  createPendingOutcome,
  evaluateSuppression,
  type FeedbackActor,
  type FeedbackEvent,
  formatMemoryFactForContext,
  type MemoryFact,
  parseFeedbackCommand,
  parseReviewerMarker,
  retrieveRelevantMemory,
  type SuppressionCandidateFinding,
} from "../src/index";

const maintainer = {
  providerLogin: "octocat",
  association: "member",
  permission: "maintain",
  isBot: false,
} satisfies FeedbackActor;

const feedbackEvent = {
  id: "fevt_1",
  orgId: "org_1",
  repoId: "repo_1",
  provider: "github",
  source: "webhook",
  eventKind: "issue_comment_created",
  actor: maintainer,
  publishedFindingId: "pfnd_1",
  payloadRedacted: {},
  receivedAt: "2026-05-06T00:00:00.000Z",
} satisfies FeedbackEvent;

const finding = {
  category: "test_coverage",
  severity: "medium",
  title: "Missing generated client test",
  body: "The generated client needs a test.",
  fingerprint: "ffp_generated_test",
  location: {
    path: "src/generated/client.ts",
    line: 12,
    side: "RIGHT",
    isInDiff: true,
  },
} satisfies SuppressionCandidateFinding;

describe("memory package", () => {
  it("round-trips and parses hidden reviewer markers", () => {
    const marker = buildReviewerMarker({
      bodyHash: "sha256:abc",
      findingId: "pfnd_1",
      kind: "finding",
      reviewRunId: "rrn_1",
    });

    expect(parseReviewerMarker(`body\n${marker}`)).toEqual({
      bodyHash: "sha256:abc",
      findingId: "pfnd_1",
      kind: "finding",
      reviewRunId: "rrn_1",
    });
  });

  it("parses trusted commands and creates suppression memory candidates", () => {
    const command = parseFeedbackCommand(
      "@bot disable test coverage comments in src/generated/**",
      {
        orgId: "org_1",
        repoId: "repo_1",
      },
    );

    expect(command?.commandKind).toBe("disable_category_in_scope");
    expect(command && actorCanRunCommand(maintainer, command)).toBe(true);

    const candidates = command
      ? createMemoryCandidatesFromCommand({
          command,
          createdAt: "2026-05-06T00:00:00.000Z",
          createdByLogin: "octocat",
          orgId: "org_1",
          repoId: "repo_1",
        })
      : [];

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.candidateKind).toBe("suppress_category_in_scope");
    expect(candidates[0]?.proposedAppliesTo.pathGlobs).toEqual(["src/generated/**"]);
  });

  it("classifies feedback and applies the outcome state machine", () => {
    const command = parseFeedbackCommand("@bot false positive", {
      orgId: "org_1",
      repoId: "repo_1",
    });
    const signals = classifyFeedbackEvent({ command, event: feedbackEvent });
    const outcome = applySignalsToOutcome({
      outcome: createPendingOutcome({
        createdAt: "2026-05-06T00:00:00.000Z",
        outcomeId: "out_1",
        publishedFindingId: "pfnd_1",
        reviewRunId: "rrn_1",
      }),
      signals,
      updatedAt: "2026-05-06T00:01:00.000Z",
    });

    expect(signals[0]?.signalKind).toBe("explicit_false_positive");
    expect(outcome.outcome).toBe("rejected_false_positive");
    expect(outcome.negativeScore).toBe(1);
  });

  it("activates approved suppression memory and explains suppression decisions", () => {
    const command = parseFeedbackCommand(
      "@bot disable test coverage comments in src/generated/**",
      {
        orgId: "org_1",
        repoId: "repo_1",
      },
    );
    const [candidate] = command
      ? createMemoryCandidatesFromCommand({
          command,
          createdAt: "2026-05-06T00:00:00.000Z",
          orgId: "org_1",
          repoId: "repo_1",
        })
      : [];
    if (!candidate) {
      throw new Error("Expected a memory candidate.");
    }
    const memoryFact = activateMemoryCandidate({
      activatedAt: "2026-05-06T00:02:00.000Z",
      candidate,
      memoryFactId: "mem_1",
    });
    const decision = evaluateSuppression({
      candidateFinding: finding,
      memoryFacts: [memoryFact],
      orgId: "org_1",
      repoId: "repo_1",
    });

    expect(decision).toMatchObject({
      matchKind: "path_category",
      memoryFactId: "mem_1",
      suppressed: true,
    });
  });

  it("creates stable fingerprints without exact line numbers", () => {
    const first = createFindingFingerprint({
      category: "correctness",
      evidenceCodeHashes: ["hash_a"],
      filePath: "src/server/auth.ts",
      normalizedRootCause: "auth middleware bypassed",
      normalizedTitle: "Auth check bypass",
      symbolName: "requireAuth",
    });
    const second = createFindingFingerprint({
      category: "correctness",
      evidenceCodeHashes: ["hash_a"],
      filePath: "src/server/auth.ts",
      normalizedRootCause: "auth middleware bypassed",
      normalizedTitle: "Auth check bypass",
      symbolName: "requireAuth",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^ffp_/u);
  });

  it("ranks relevant memory facts with a product-safe trace", () => {
    const pathSuppression = memoryFactFixture({
      id: "mem_path",
      kind: "suppression",
      content: "Generated client files under src/generated do not require direct unit tests.",
      scope: {
        level: "path",
        orgId: "org_1",
        repoId: "repo_1",
        pathGlobs: ["src/generated/**"],
      },
      appliesTo: {
        categories: ["test_coverage"],
        pathGlobs: ["src/generated/**"],
      },
      priority: 700,
    });
    const repoFact = memoryFactFixture({
      id: "mem_repo",
      content: "Authentication is centralized in src/server/auth-middleware.ts.",
      appliesTo: { languages: ["typescript"] },
      priority: 300,
    });
    const broadOrgFact = memoryFactFixture({
      id: "mem_org",
      scope: { level: "org", orgId: "org_1" },
      content: "Prefer actionable review comments with concrete code evidence.",
      priority: 200,
    });
    const disabledFact = memoryFactFixture({
      id: "mem_disabled",
      status: "disabled",
    });

    const result = retrieveRelevantMemory({
      orgId: "org_1",
      repoId: "repo_1",
      changedFiles: [{ path: "src/generated/client.ts", language: "typescript" }],
      findingCategories: ["test_coverage"],
      memoryFacts: [broadOrgFact, repoFact, disabledFact, pathSuppression],
      maxFacts: 2,
      maxTokens: 120,
      now: "2026-05-06T00:00:00.000Z",
    });

    expect(result.facts.map((fact) => fact.id)).toEqual(["mem_path", "mem_repo"]);
    expect(result.trace).toEqual([
      expect.objectContaining({
        included: true,
        matchedDimensions: expect.arrayContaining(["path", "category"]),
        memoryFactId: "mem_path",
      }),
      expect.objectContaining({
        included: true,
        matchedDimensions: expect.arrayContaining(["language", "scope"]),
        memoryFactId: "mem_repo",
      }),
      expect.objectContaining({
        included: false,
        memoryFactId: "mem_org",
        reason: "Excluded by memory fact count budget.",
      }),
    ]);
    expect(formatMemoryFactForContext(pathSuppression)).toContain(
      "[suppression, high confidence, path]",
    );
    expect(result.trace.some((entry) => entry.memoryFactId === "mem_disabled")).toBe(false);
  });
});

function memoryFactFixture(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "mem_1",
    orgId: "org_1",
    repoId: "repo_1",
    kind: "repo_fact",
    content: "Use repository conventions when reviewing.",
    normalizedContent: "use repository conventions when reviewing.",
    scope: { level: "repo", orgId: "org_1", repoId: "repo_1" },
    appliesTo: {},
    sourceKind: "command",
    trustLevel: "explicit_maintainer",
    confidence: 0.92,
    status: "active",
    priority: 300,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-05T00:00:00.000Z",
    ...overrides,
  };
}
