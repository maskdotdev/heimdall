import {
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryAttributeValue,
  type TelemetryMetricRecorder,
  type TelemetrySpanRecorder,
} from "@repo/observability";
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

  it("records feedback and memory telemetry without comment text or paths", () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const command = parseFeedbackCommand("@bot never mention src/private/generated.ts", {
      orgId: "org_1",
      repoId: "repo_1",
    });
    if (!command) {
      throw new Error("Expected a parsed feedback command.");
    }

    const signals = classifyFeedbackEvent({
      command,
      event: feedbackEvent,
      metrics: createRecordingMetrics(metrics),
      redactedText: "thanks for fixing src/private/generated.ts",
      traces: createRecordingTraces(spans),
    });
    const candidates = createMemoryCandidatesFromCommand({
      command,
      createdAt: "2026-05-06T00:00:00.000Z",
      metrics: createRecordingMetrics(metrics),
      orgId: "org_1",
      repoId: "repo_1",
      traces: createRecordingTraces(spans),
    });
    const [candidate] = candidates;
    if (!candidate) {
      throw new Error("Expected a memory candidate.");
    }
    const memoryFact = activateMemoryCandidate({
      activatedAt: "2026-05-06T00:02:00.000Z",
      candidate,
      memoryFactId: "mem_private",
      metrics: createRecordingMetrics(metrics),
      traces: createRecordingTraces(spans),
    });
    const decision = evaluateSuppression({
      candidateFinding: {
        ...finding,
        location: { ...finding.location, path: "src/private/generated.ts" },
        title: "src/private/generated.ts should be ignored",
      },
      memoryFacts: [memoryFact],
      metrics: createRecordingMetrics(metrics),
      orgId: "org_1",
      repoId: "repo_1",
      traces: createRecordingTraces(spans),
    });

    expect(signals).toEqual([expect.objectContaining({ signalKind: "explicit_suppress_command" })]);
    expect(decision.suppressed).toBe(true);
    expect(metrics).toEqual(
      expect.arrayContaining([
        {
          kind: "counter",
          labels: { event_type: "issue_comment_created", provider: "github", source: "webhook" },
          name: OBSERVABILITY_METRIC_NAMES.feedbackEventsTotal,
          value: 1,
        },
        {
          kind: "counter",
          labels: { polarity: "suppression", signal_type: "explicit_suppress_command" },
          name: OBSERVABILITY_METRIC_NAMES.feedbackSignalsTotal,
          value: 1,
        },
        {
          kind: "counter",
          labels: {
            candidate_kind: "suppress_similar_finding",
            source: "command",
            status: "pending",
          },
          name: OBSERVABILITY_METRIC_NAMES.memoryCandidatesTotal,
          value: 1,
        },
        {
          kind: "counter",
          labels: { kind: "suppression", scope: "repo", status: "active" },
          name: OBSERVABILITY_METRIC_NAMES.memoryFactsTotal,
          value: 1,
        },
        {
          kind: "counter",
          labels: { match_type: "title_pattern", scope: "repo" },
          name: OBSERVABILITY_METRIC_NAMES.memorySuppressionMatchesTotal,
          value: 1,
        },
      ]),
    );
    expect(spans.map((span) => span.name)).toEqual(
      expect.arrayContaining([
        OBSERVABILITY_SPAN_NAMES.memoryProcessFeedback,
        OBSERVABILITY_SPAN_NAMES.memoryClassifySignal,
        OBSERVABILITY_SPAN_NAMES.memoryCreateCandidate,
        OBSERVABILITY_SPAN_NAMES.memoryActivateFact,
        OBSERVABILITY_SPAN_NAMES.memoryCorrelateFinding,
        OBSERVABILITY_SPAN_NAMES.memoryMatchSuppression,
      ]),
    );

    const serializedTelemetry = JSON.stringify({ metrics, spans });
    expect(serializedTelemetry).not.toContain("src/private/generated.ts");
    expect(serializedTelemetry).not.toContain("thanks for fixing");
    expect(serializedTelemetry).not.toContain("never mention");
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
