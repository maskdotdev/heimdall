import { createHash } from "node:crypto";
import {
  type CandidateFinding,
  type ChangedSymbol,
  type FindingCategory,
  FindingCategorySchema,
  FindingSeveritySchema,
} from "@repo/contracts";
import {
  classifyTelemetryError,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryAttributeValue,
  type TelemetryMetricRecorder,
  type TelemetrySpanHandle,
  type TelemetrySpanRecorder,
  type TelemetryTraceContextInput,
} from "@repo/observability";
import { type Static, Type } from "@sinclair/typebox";

/** Feedback event kinds accepted by the memory package. */
export const FeedbackEventKindSchema = Type.Union([
  Type.Literal("review_comment_created"),
  Type.Literal("review_comment_edited"),
  Type.Literal("review_comment_deleted"),
  Type.Literal("review_thread_resolved"),
  Type.Literal("review_thread_unresolved"),
  Type.Literal("issue_comment_created"),
  Type.Literal("issue_comment_edited"),
  Type.Literal("issue_comment_deleted"),
  Type.Literal("reaction_added"),
  Type.Literal("reaction_removed"),
  Type.Literal("dashboard_mark_useful"),
  Type.Literal("dashboard_mark_false_positive"),
  Type.Literal("dashboard_suppress_finding"),
  Type.Literal("followup_commit_analyzed"),
  Type.Literal("pull_request_merged"),
  Type.Literal("pull_request_closed"),
]);

/** Type for a feedback event kind. */
export type FeedbackEventKind = Static<typeof FeedbackEventKindSchema>;

/** Feedback signal kinds emitted by deterministic classification. */
export const FeedbackSignalKindSchema = Type.Union([
  Type.Literal("explicit_useful"),
  Type.Literal("explicit_false_positive"),
  Type.Literal("explicit_not_actionable"),
  Type.Literal("explicit_intentional"),
  Type.Literal("explicit_remember_command"),
  Type.Literal("explicit_suppress_command"),
  Type.Literal("thread_resolved"),
  Type.Literal("thread_unresolved"),
  Type.Literal("positive_reaction"),
  Type.Literal("negative_reaction"),
  Type.Literal("user_acknowledged"),
  Type.Literal("user_disagreed"),
  Type.Literal("followup_code_changed"),
  Type.Literal("finding_no_longer_applies"),
  Type.Literal("finding_still_applies"),
  Type.Literal("pr_merged"),
  Type.Literal("pr_closed_unmerged"),
]);

/** Type for a feedback signal kind. */
export type FeedbackSignalKind = Static<typeof FeedbackSignalKindSchema>;

/** Current outcome states for a published finding. */
export const FindingOutcomeKindSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("acknowledged"),
  Type.Literal("likely_useful"),
  Type.Literal("accepted"),
  Type.Literal("addressed"),
  Type.Literal("rejected_false_positive"),
  Type.Literal("rejected_not_actionable"),
  Type.Literal("rejected_preference"),
  Type.Literal("ignored"),
  Type.Literal("stale"),
  Type.Literal("suppressed"),
  Type.Literal("unknown"),
]);

/** Type for a current outcome state for a published finding. */
export type FindingOutcomeKind = Static<typeof FindingOutcomeKindSchema>;

/** Candidate memory kinds proposed from feedback. */
export const MemoryCandidateKindSchema = Type.Union([
  Type.Literal("suppress_exact_finding"),
  Type.Literal("suppress_similar_finding"),
  Type.Literal("suppress_category_in_scope"),
  Type.Literal("repo_fact"),
  Type.Literal("team_preference"),
  Type.Literal("severity_calibration"),
  Type.Literal("style_preference"),
  Type.Literal("architecture_convention"),
  Type.Literal("security_convention"),
  Type.Literal("testing_convention"),
]);

/** Type for a candidate memory kind proposed from feedback. */
export type MemoryCandidateKind = Static<typeof MemoryCandidateKindSchema>;

/** Durable memory kinds that can influence future reviews. */
export const MemoryFactKindSchema = Type.Union([
  Type.Literal("suppression"),
  Type.Literal("repo_fact"),
  Type.Literal("team_preference"),
  Type.Literal("style_preference"),
  Type.Literal("architecture_convention"),
  Type.Literal("security_convention"),
  Type.Literal("testing_convention"),
  Type.Literal("severity_calibration"),
  Type.Literal("domain_glossary"),
]);

/** Type for a durable memory kind that can influence future reviews. */
export type MemoryFactKind = Static<typeof MemoryFactKindSchema>;

/** Actor permission level from the provider or dashboard. */
export const FeedbackActorPermissionSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("read"),
  Type.Literal("triage"),
  Type.Literal("write"),
  Type.Literal("maintain"),
  Type.Literal("admin"),
]);

/** Type for actor permission level from the provider or dashboard. */
export type FeedbackActorPermission = Static<typeof FeedbackActorPermissionSchema>;

/** Feedback actor normalized from GitHub, dashboard, or system sources. */
export const FeedbackActorSchema = Type.Object(
  {
    providerLogin: Type.String({ minLength: 1 }),
    providerUserId: Type.Optional(Type.String({ minLength: 1 })),
    association: Type.Optional(
      Type.Union([
        Type.Literal("owner"),
        Type.Literal("member"),
        Type.Literal("collaborator"),
        Type.Literal("contributor"),
        Type.Literal("first_time_contributor"),
        Type.Literal("unknown"),
      ]),
    ),
    permission: Type.Optional(FeedbackActorPermissionSchema),
    isBot: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Type for a normalized feedback actor. */
export type FeedbackActor = Static<typeof FeedbackActorSchema>;

/** Normalized feedback event consumed by the memory package. */
export const FeedbackEventSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    orgId: Type.String({ minLength: 1 }),
    repoId: Type.String({ minLength: 1 }),
    provider: Type.String({ minLength: 1 }),
    source: Type.Union([
      Type.Literal("webhook"),
      Type.Literal("reconciliation"),
      Type.Literal("dashboard"),
      Type.Literal("system"),
    ]),
    eventKind: FeedbackEventKindSchema,
    externalEventId: Type.Optional(Type.String({ minLength: 1 })),
    webhookEventId: Type.Optional(Type.String({ minLength: 1 })),
    actor: Type.Optional(FeedbackActorSchema),
    pullRequestNumber: Type.Optional(Type.Integer({ minimum: 1 })),
    reviewRunId: Type.Optional(Type.String({ minLength: 1 })),
    publishedFindingId: Type.Optional(Type.String({ minLength: 1 })),
    externalCommentId: Type.Optional(Type.String({ minLength: 1 })),
    externalThreadId: Type.Optional(Type.String({ minLength: 1 })),
    payloadRedacted: Type.Record(Type.String(), Type.Unknown()),
    receivedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Type for a normalized feedback event. */
export type FeedbackEvent = Static<typeof FeedbackEventSchema>;

/** Feedback signal produced from one normalized event. */
export const FeedbackSignalSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    feedbackEventId: Type.String({ minLength: 1 }),
    publishedFindingId: Type.Optional(Type.String({ minLength: 1 })),
    signalKind: FeedbackSignalKindSchema,
    polarity: Type.Union([
      Type.Literal("positive"),
      Type.Literal("negative"),
      Type.Literal("neutral"),
      Type.Literal("mixed"),
      Type.Literal("memory"),
      Type.Literal("suppression"),
    ]),
    strength: Type.Number({ minimum: 0, maximum: 1 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    reason: Type.String({ minLength: 1 }),
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Type for a feedback signal produced from one event. */
export type FeedbackSignal = Static<typeof FeedbackSignalSchema>;

/** Scope for a memory candidate or active memory fact. */
export const MemoryScopeSchema = Type.Object(
  {
    level: Type.Union([
      Type.Literal("org"),
      Type.Literal("repo"),
      Type.Literal("path"),
      Type.Literal("symbol"),
      Type.Literal("finding_fingerprint"),
    ]),
    orgId: Type.String({ minLength: 1 }),
    repoId: Type.Optional(Type.String({ minLength: 1 })),
    pathGlobs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    languages: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    symbolNames: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    findingFingerprints: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

/** Type for a memory scope. */
export type MemoryScope = Static<typeof MemoryScopeSchema>;

/** Finding dimensions that a memory fact applies to. */
export const MemoryAppliesToSchema = Type.Object(
  {
    categories: Type.Optional(Type.Array(FindingCategorySchema)),
    severities: Type.Optional(Type.Array(FindingSeveritySchema)),
    pathGlobs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    languages: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    findingFingerprints: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    titlePatterns: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    symbolNames: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

/** Type for finding dimensions that a memory fact applies to. */
export type MemoryAppliesTo = Static<typeof MemoryAppliesToSchema>;

/** Candidate generated from explicit or repeated feedback. */
export const MemoryCandidateSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    orgId: Type.String({ minLength: 1 }),
    repoId: Type.Optional(Type.String({ minLength: 1 })),
    sourceKind: Type.Union([
      Type.Literal("command"),
      Type.Literal("repeated_signal"),
      Type.Literal("dashboard"),
      Type.Literal("system"),
      Type.Literal("llm_classifier"),
    ]),
    candidateKind: MemoryCandidateKindSchema,
    proposedContent: Type.String({ minLength: 1 }),
    proposedScope: MemoryScopeSchema,
    proposedAppliesTo: MemoryAppliesToSchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    trustLevel: Type.Union([
      Type.Literal("untrusted"),
      Type.Literal("author"),
      Type.Literal("trusted_contributor"),
      Type.Literal("explicit_maintainer"),
      Type.Literal("admin"),
      Type.Literal("system"),
    ]),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("approved"),
      Type.Literal("rejected"),
      Type.Literal("auto_activated"),
      Type.Literal("expired"),
      Type.Literal("superseded"),
    ]),
    createdByLogin: Type.Optional(Type.String({ minLength: 1 })),
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Type for a candidate generated from explicit or repeated feedback. */
export type MemoryCandidate = Static<typeof MemoryCandidateSchema>;

/** Active or inactive durable memory fact. */
export const MemoryFactSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    orgId: Type.String({ minLength: 1 }),
    repoId: Type.Optional(Type.String({ minLength: 1 })),
    kind: MemoryFactKindSchema,
    content: Type.String({ minLength: 1 }),
    normalizedContent: Type.Optional(Type.String({ minLength: 1 })),
    scope: MemoryScopeSchema,
    appliesTo: MemoryAppliesToSchema,
    sourceKind: Type.Union([
      Type.Literal("command"),
      Type.Literal("dashboard"),
      Type.Literal("repeated_signal"),
      Type.Literal("system"),
    ]),
    trustLevel: Type.String({ minLength: 1 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    status: Type.Union([
      Type.Literal("active"),
      Type.Literal("disabled"),
      Type.Literal("expired"),
      Type.Literal("superseded"),
      Type.Literal("needs_review"),
    ]),
    priority: Type.Integer({ minimum: 0, maximum: 1000 }),
    expiresAt: Type.Optional(Type.String({ minLength: 1 })),
    createdByLogin: Type.Optional(Type.String({ minLength: 1 })),
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Type for an active or inactive durable memory fact. */
export type MemoryFact = Static<typeof MemoryFactSchema>;

/** Supported feedback command kinds. */
export const FeedbackCommandKindSchema = Type.Union([
  Type.Literal("mark_false_positive"),
  Type.Literal("mark_not_useful"),
  Type.Literal("suppress_exact"),
  Type.Literal("suppress_similar"),
  Type.Literal("remember_fact"),
  Type.Literal("disable_category_in_scope"),
  Type.Literal("set_review_preference"),
]);

/** Type for supported feedback command kinds. */
export type FeedbackCommandKind = Static<typeof FeedbackCommandKindSchema>;

/** Parsed command target dimensions. */
export type FeedbackCommandTarget = {
  /** Published finding ID when the command directly targets a finding. */
  readonly publishedFindingId?: string | undefined;
  /** External provider comment ID when known. */
  readonly externalCommentId?: string | undefined;
  /** Pull request number when the command targets a PR summary. */
  readonly pullRequestNumber?: number | undefined;
};

/** Parsed deterministic feedback command. */
export type FeedbackCommand = {
  /** Command kind. */
  readonly commandKind: FeedbackCommandKind;
  /** Original command text. */
  readonly rawText: string;
  /** Optional target parsed from context. */
  readonly target?: FeedbackCommandTarget | undefined;
  /** Free-form command content after the command verb. */
  readonly content?: string | undefined;
  /** Proposed scope when the command maps to memory. */
  readonly scope?: MemoryScope | undefined;
  /** Proposed finding dimensions when the command maps to memory. */
  readonly appliesTo?: MemoryAppliesTo | undefined;
  /** Deterministic parser confidence. */
  readonly confidence: number;
};

/** Mutable current finding outcome used by the state machine. */
export type MemoryFindingOutcome = {
  /** Stable outcome ID. */
  readonly id: string;
  /** Published finding ID. */
  readonly publishedFindingId: string;
  /** Review run ID. */
  readonly reviewRunId: string;
  /** Current outcome. */
  readonly outcome: FindingOutcomeKind;
  /** Current outcome confidence. */
  readonly confidence: number;
  /** Accumulated positive evidence score. */
  readonly positiveScore: number;
  /** Accumulated negative evidence score. */
  readonly negativeScore: number;
  /** Last signal that updated this outcome. */
  readonly lastSignalId?: string | undefined;
  /** Last update timestamp. */
  readonly updatedAt: string;
};

/** Reviewer hidden marker parsed from published bot comments. */
export type ReviewerMarker = {
  /** Marker kind. */
  readonly kind: "finding" | "summary";
  /** Review run ID embedded in the marker. */
  readonly reviewRunId: string;
  /** Published finding ID embedded for finding markers. */
  readonly findingId?: string | undefined;
  /** Repository ID embedded for summary markers. */
  readonly repoId?: string | undefined;
  /** Pull request number embedded for summary markers. */
  readonly pullRequestNumber?: number | undefined;
  /** Body hash associated with the original rendered comment. */
  readonly bodyHash?: string | undefined;
};

/** Optional telemetry dependencies used by feedback and memory operations. */
export type MemoryTelemetryOptions = {
  /** Optional metric recorder for aggregate feedback and memory counters. */
  readonly metrics?: TelemetryMetricRecorder | undefined;
  /** Optional trace context propagated from the parent job or review. */
  readonly traceContext?: TelemetryTraceContextInput | undefined;
  /** Optional span recorder for product-safe feedback and memory spans. */
  readonly traces?: TelemetrySpanRecorder | undefined;
};

/** Candidate finding subset required by suppression evaluation. */
export type SuppressionCandidateFinding = Pick<
  CandidateFinding,
  "category" | "severity" | "title" | "body" | "fingerprint" | "location"
>;

/** Suppression engine input. */
export type SuppressionInput = MemoryTelemetryOptions & {
  /** Organization ID for memory scoping. */
  readonly orgId: string;
  /** Repository ID for memory scoping. */
  readonly repoId: string;
  /** Candidate finding being considered by validation. */
  readonly candidateFinding: SuppressionCandidateFinding;
  /** Active and inactive memory facts available to this repository. */
  readonly memoryFacts: readonly MemoryFact[];
  /** Changed symbol names related to the finding when available. */
  readonly changedSymbolNames?: readonly string[] | undefined;
};

/** Suppression decision for one candidate finding. */
export type SuppressionDecision = {
  /** Whether memory suppresses the finding. */
  readonly suppressed: boolean;
  /** Confidence of the match. */
  readonly confidence: number;
  /** Human-readable safe reason for audit logs. */
  readonly reason?: string | undefined;
  /** Memory fact ID responsible for suppression. */
  readonly memoryFactId?: string | undefined;
  /** Match kind for audit and dashboard explanations. */
  readonly matchKind?:
    | "exact_fingerprint"
    | "similar_fingerprint"
    | "path_category"
    | "language_category"
    | "title_pattern"
    | "repo_preference"
    | "manual_rule"
    | undefined;
};

/** Input for deterministic finding fingerprint generation. */
export type FindingFingerprintInput = {
  /** Finding category. */
  readonly category: FindingCategory;
  /** Normalized or raw title for the finding. */
  readonly normalizedTitle: string;
  /** Normalized or raw root cause for the finding. */
  readonly normalizedRootCause: string;
  /** Repository path bucket for the finding. */
  readonly filePath: string;
  /** Optional symbol name for the finding. */
  readonly symbolName?: string | undefined;
  /** Evidence code hashes attached to the finding. */
  readonly evidenceCodeHashes?: readonly string[] | undefined;
};

/** Changed file dimensions used for relevant memory retrieval. */
export type MemoryRetrievalChangedFile = {
  /** Repository path for the changed file. */
  readonly path: string;
  /** Optional language identifier for the changed file. */
  readonly language?: string | undefined;
};

/** Relevant memory retrieval input for review context construction. */
export type RetrieveRelevantMemoryInput = MemoryTelemetryOptions & {
  /** Organization ID for memory scoping. */
  readonly orgId: string;
  /** Repository ID for memory scoping. */
  readonly repoId: string;
  /** Changed files in the pull request. */
  readonly changedFiles: readonly MemoryRetrievalChangedFile[];
  /** Changed symbols in the pull request when available. */
  readonly changedSymbols?: readonly ChangedSymbol[] | undefined;
  /** Finding categories expected for the review pass. */
  readonly findingCategories?: readonly FindingCategory[] | undefined;
  /** Maximum number of memory facts to include. */
  readonly maxFacts?: number | undefined;
  /** Maximum estimated prompt tokens for included memory facts. */
  readonly maxTokens?: number | undefined;
  /** Timestamp used for deterministic recency scoring. */
  readonly now?: string | undefined;
};

/** In-memory relevant memory retrieval input with available facts supplied by the caller. */
export type RankRelevantMemoryFactsInput = RetrieveRelevantMemoryInput & {
  /** Available memory facts to rank. */
  readonly memoryFacts: readonly MemoryFact[];
};

/** Product-safe trace row for one memory relevance decision. */
export type RelevantMemoryTraceEntry = {
  /** Memory fact ID considered by the retriever. */
  readonly memoryFactId: string;
  /** Product-safe reason for the score. */
  readonly reason: string;
  /** Final normalized relevance score. */
  readonly score: number;
  /** Matching dimensions that contributed to relevance. */
  readonly matchedDimensions: readonly string[];
  /** Estimated tokens for the formatted memory fact. */
  readonly tokenEstimate: number;
  /** Whether the fact was included after fact and token budgets. */
  readonly included: boolean;
};

/** Relevant memory facts plus an explainable ranking trace. */
export type RelevantMemoryResult = {
  /** Memory facts selected for review context. */
  readonly facts: readonly MemoryFact[];
  /** Relevance and budget trace for considered memory facts. */
  readonly trace: readonly RelevantMemoryTraceEntry[];
};

/** Retriever interface used by retrieval and orchestration layers. */
export interface RelevantMemoryRetriever {
  /** Retrieves relevant active memory facts for a review context. */
  retrieveRelevantMemory(input: RetrieveRelevantMemoryInput): Promise<RelevantMemoryResult>;
}

/** Parses the first hidden reviewer marker from comment Markdown. */
export function parseReviewerMarker(markdown: string): ReviewerMarker | undefined {
  const markerMatch = markdown.match(/<!--\s*ai-reviewer:(finding|summary)\s+([^>]*)-->/u);
  if (!markerMatch?.[1] || !markerMatch[2]) {
    return undefined;
  }

  const fields = parseMarkerFields(markerMatch[2]);
  const reviewRunId = fields.review_run_id;
  if (!reviewRunId) {
    return undefined;
  }

  return {
    kind: markerMatch[1] as "finding" | "summary",
    reviewRunId,
    ...(fields.finding_id ? { findingId: fields.finding_id } : {}),
    ...(fields.repo_id ? { repoId: fields.repo_id } : {}),
    ...(fields.pr && Number.isInteger(Number(fields.pr))
      ? { pullRequestNumber: Number(fields.pr) }
      : {}),
    ...(fields.body_hash ? { bodyHash: fields.body_hash } : {}),
  };
}

/** Builds a hidden reviewer marker for a finding or summary comment. */
export function buildReviewerMarker(marker: ReviewerMarker): string {
  const fields = [
    `review_run_id="${escapeMarkerValue(marker.reviewRunId)}"`,
    marker.findingId ? `finding_id="${escapeMarkerValue(marker.findingId)}"` : undefined,
    marker.repoId ? `repo_id="${escapeMarkerValue(marker.repoId)}"` : undefined,
    marker.pullRequestNumber ? `pr="${marker.pullRequestNumber}"` : undefined,
    marker.bodyHash ? `body_hash="${escapeMarkerValue(marker.bodyHash)}"` : undefined,
  ].filter((field): field is string => Boolean(field));

  return `<!-- ai-reviewer:${marker.kind} ${fields.join(" ")} -->`;
}

/** Parses a deterministic feedback command from trusted comment text. */
export function parseFeedbackCommand(
  text: string,
  context: {
    /** Organization ID for proposed memory scope. */
    readonly orgId: string;
    /** Repository ID for proposed memory scope. */
    readonly repoId?: string | undefined;
    /** Optional command target. */
    readonly target?: FeedbackCommandTarget | undefined;
  },
): FeedbackCommand | undefined {
  const commandText = stripBotMention(text);
  if (!commandText) {
    return undefined;
  }

  if (matchesAny(commandText, ["false positive", "wrong finding"])) {
    return baseCommand("mark_false_positive", text, context, 0.98);
  }

  if (matchesAny(commandText, ["not useful", "not actionable"])) {
    return baseCommand("mark_not_useful", text, context, 0.92);
  }

  if (matchesAny(commandText, ["ignore this", "suppress this"])) {
    return suppressionCommand(
      "suppress_exact",
      text,
      context,
      "Suppress this exact finding.",
      0.98,
    );
  }

  if (commandText.startsWith("suppress similar")) {
    const content = commandText.replace(/^suppress similar(?: findings? about)?/u, "").trim();
    return suppressionCommand(
      "suppress_similar",
      text,
      context,
      content || "Suppress similar findings.",
      0.9,
    );
  }

  if (commandText.startsWith("remember:")) {
    const content = commandText.slice("remember:".length).trim();
    if (!content) {
      return undefined;
    }
    return {
      ...baseCommand("remember_fact", text, context, 0.96),
      content,
      scope: repoScope(context),
      appliesTo: {},
    };
  }

  if (commandText.startsWith("never mention ")) {
    const content = commandText.slice("never mention ".length).trim();
    if (!content) {
      return undefined;
    }
    return {
      ...suppressionCommand("suppress_similar", text, context, content, 0.94),
      appliesTo: { titlePatterns: [content] },
    };
  }

  const disableMatch = commandText.match(/^disable\s+(.+?)\s+comments?\s+in\s+(.+)$/u);
  if (disableMatch?.[1] && disableMatch[2]) {
    return {
      ...suppressionCommand("disable_category_in_scope", text, context, commandText, 0.9),
      appliesTo: {
        categories: parseCategories(disableMatch[1]),
        pathGlobs: [disableMatch[2].trim()],
      },
    };
  }

  if (commandText.startsWith("only comment on ")) {
    const content = commandText.slice("only comment on ".length).trim();
    return {
      ...baseCommand("set_review_preference", text, context, 0.86),
      content,
      scope: repoScope(context),
      appliesTo: { categories: parseCategories(content) },
    };
  }

  return undefined;
}

/** Returns whether an actor is allowed to execute a parsed command. */
export function actorCanRunCommand(actor: FeedbackActor, command: FeedbackCommand): boolean {
  if (actor.isBot) {
    return false;
  }

  if (command.commandKind === "mark_false_positive" || command.commandKind === "mark_not_useful") {
    return (
      hasAssociation(actor, ["owner", "member", "collaborator"]) || hasPermission(actor, "write")
    );
  }

  if (command.commandKind === "suppress_exact") {
    return hasPermission(actor, "write");
  }

  if (
    command.commandKind === "suppress_similar" ||
    command.commandKind === "remember_fact" ||
    command.commandKind === "disable_category_in_scope" ||
    command.commandKind === "set_review_preference"
  ) {
    return hasPermission(actor, "maintain");
  }

  return hasPermission(actor, "admin");
}

/** Classifies a feedback event into deterministic feedback signals. */
export function classifyFeedbackEvent(
  input: MemoryTelemetryOptions & {
    /** Feedback event to classify. */
    readonly event: FeedbackEvent;
    /** Redacted body text associated with the event, if any. */
    readonly redactedText?: string | undefined;
    /** Parsed command from the body text, if already available. */
    readonly command?: FeedbackCommand | undefined;
  },
): readonly FeedbackSignal[] {
  const event = input.event;
  const processSpan = startMemorySpan(input, OBSERVABILITY_SPAN_NAMES.memoryProcessFeedback, {
    ...feedbackEventTelemetryAttributes(event),
    "feedback.has_command": input.command !== undefined,
    "feedback.has_published_finding": event.publishedFindingId !== undefined,
  });
  const classifySpan = startMemorySpan(input, OBSERVABILITY_SPAN_NAMES.memoryClassifySignal, {
    ...feedbackEventTelemetryAttributes(event),
    "feedback.has_command": input.command !== undefined,
  });
  const signal = (
    signalKind: FeedbackSignalKind,
    polarity: FeedbackSignal["polarity"],
    strength: number,
    confidence: number,
    reason: string,
  ): FeedbackSignal => ({
    id: stableId("fsig", [event.id, signalKind, reason]),
    feedbackEventId: event.id,
    ...(event.publishedFindingId ? { publishedFindingId: event.publishedFindingId } : {}),
    signalKind,
    polarity,
    strength,
    confidence,
    reason,
    createdAt: event.receivedAt,
  });

  input.metrics?.count(OBSERVABILITY_METRIC_NAMES.feedbackEventsTotal, {
    labels: {
      event_type: event.eventKind,
      provider: sanitizeMemoryTelemetryLabel(event.provider),
      source: event.source,
    },
  });

  const finish = (signals: readonly FeedbackSignal[]): readonly FeedbackSignal[] => {
    recordFeedbackSignalMetrics(input.metrics, signals);
    classifySpan?.end({
      attributes: {
        "feedback.signal_count": signals.length,
        "memory.status": "succeeded",
      },
    });
    processSpan?.end({
      attributes: {
        "feedback.signal_count": signals.length,
        "memory.status": "succeeded",
      },
    });

    return signals;
  };

  try {
    if (input.command) {
      return finish([signalForCommand(input.command, signal)]);
    }

    if (event.eventKind === "review_thread_resolved") {
      return finish([
        signal("thread_resolved", "positive", 0.35, 0.65, "Review thread was resolved."),
      ]);
    }

    if (event.eventKind === "review_thread_unresolved") {
      return finish([
        signal("thread_unresolved", "mixed", 0.25, 0.6, "Review thread was reopened."),
      ]);
    }

    if (event.eventKind === "pull_request_merged") {
      return finish([
        signal("pr_merged", "neutral", 0.1, 0.35, "Pull request merged without explicit feedback."),
      ]);
    }

    const body = normalizeText(input.redactedText ?? "");
    if (body.includes("fixed") || body.includes("thanks")) {
      return finish([
        signal("user_acknowledged", "positive", 0.55, 0.7, "User acknowledged the finding."),
      ]);
    }
    if (body.includes("wrong") || body.includes("nope")) {
      return finish([
        signal("user_disagreed", "negative", 0.6, 0.7, "User disagreed with the finding."),
      ]);
    }

    return finish([]);
  } catch (error) {
    const errorClass = classifyTelemetryError(error);
    classifySpan?.end({
      attributes: {
        "memory.error_class": errorClass,
        "memory.status": "failed",
      },
      error,
    });
    processSpan?.end({
      attributes: {
        "memory.error_class": errorClass,
        "memory.status": "failed",
      },
      error,
    });
    throw error;
  }
}

/** Applies signals to a finding outcome with deterministic MVP transition rules. */
export function applySignalsToOutcome(
  input: MemoryTelemetryOptions & {
    /** Existing outcome before new signals. */
    readonly outcome: MemoryFindingOutcome;
    /** Signals to apply in chronological order. */
    readonly signals: readonly FeedbackSignal[];
    /** Update timestamp. */
    readonly updatedAt: string;
  },
): MemoryFindingOutcome {
  const span = startMemorySpan(input, OBSERVABILITY_SPAN_NAMES.memoryUpdateOutcome, {
    "app.review_run_id": input.outcome.reviewRunId,
    "feedback.signal_count": input.signals.length,
    "memory.current_outcome": input.outcome.outcome,
  });
  const aggregate = input.signals.reduce(
    (current, signal) => ({
      positiveScore: current.positiveScore + (signal.polarity === "positive" ? signal.strength : 0),
      negativeScore: current.negativeScore + (signal.polarity === "negative" ? signal.strength : 0),
      lastSignalId: signal.id,
    }),
    {
      positiveScore: input.outcome.positiveScore,
      negativeScore: input.outcome.negativeScore,
      lastSignalId: input.outcome.lastSignalId,
    },
  );
  const explicitFalsePositive = input.signals.find(
    (signal) => signal.signalKind === "explicit_false_positive",
  );
  const explicitNotActionable = input.signals.find(
    (signal) => signal.signalKind === "explicit_not_actionable",
  );
  const suppressCommand = input.signals.find(
    (signal) => signal.signalKind === "explicit_suppress_command",
  );
  const addressed = input.signals.find(
    (signal) => signal.signalKind === "finding_no_longer_applies",
  );
  const finish = (outcome: MemoryFindingOutcome): MemoryFindingOutcome => {
    span?.end({
      attributes: {
        "memory.next_outcome": outcome.outcome,
        "memory.status": "succeeded",
        "memory.updated": outcome.outcome !== input.outcome.outcome,
      },
    });

    return outcome;
  };

  if (explicitFalsePositive) {
    return finish(
      updateOutcome(input.outcome, "rejected_false_positive", 0.98, aggregate, input.updatedAt),
    );
  }
  if (explicitNotActionable) {
    return finish(
      updateOutcome(input.outcome, "rejected_not_actionable", 0.92, aggregate, input.updatedAt),
    );
  }
  if (suppressCommand) {
    return finish(updateOutcome(input.outcome, "suppressed", 0.94, aggregate, input.updatedAt));
  }
  if (addressed) {
    return finish(updateOutcome(input.outcome, "addressed", 0.9, aggregate, input.updatedAt));
  }
  if (aggregate.positiveScore >= 1.2 && aggregate.negativeScore < 0.5) {
    return finish(updateOutcome(input.outcome, "likely_useful", 0.75, aggregate, input.updatedAt));
  }
  if (aggregate.negativeScore >= 1 && aggregate.positiveScore < 0.4) {
    return finish(
      updateOutcome(input.outcome, "rejected_not_actionable", 0.75, aggregate, input.updatedAt),
    );
  }
  if (aggregate.positiveScore > input.outcome.positiveScore) {
    return finish(updateOutcome(input.outcome, "acknowledged", 0.55, aggregate, input.updatedAt));
  }

  return finish(
    updateOutcome(
      input.outcome,
      input.outcome.outcome,
      input.outcome.confidence,
      aggregate,
      input.updatedAt,
    ),
  );
}

/** Creates memory candidates from a trusted parsed command. */
export function createMemoryCandidatesFromCommand(
  input: MemoryTelemetryOptions & {
    /** Parsed command. */
    readonly command: FeedbackCommand;
    /** Organization ID. */
    readonly orgId: string;
    /** Repository ID. */
    readonly repoId?: string | undefined;
    /** Published finding fingerprint related to exact suppression commands. */
    readonly findingFingerprint?: string | undefined;
    /** Login that issued the command. */
    readonly createdByLogin?: string | undefined;
    /** Creation timestamp. */
    readonly createdAt: string;
  },
): readonly MemoryCandidate[] {
  const span = startMemorySpan(input, OBSERVABILITY_SPAN_NAMES.memoryCreateCandidate, {
    "app.org_id": input.orgId,
    ...(input.repoId ? { "app.repo_id": input.repoId } : {}),
    "memory.command_kind": input.command.commandKind,
    "memory.source": "command",
  });
  const common = {
    orgId: input.orgId,
    ...(input.repoId ? { repoId: input.repoId } : {}),
    sourceKind: "command" as const,
    proposedScope: input.command.scope ?? repoScope({ orgId: input.orgId, repoId: input.repoId }),
    confidence: input.command.confidence,
    trustLevel: "explicit_maintainer" as const,
    status: "pending" as const,
    ...(input.createdByLogin ? { createdByLogin: input.createdByLogin } : {}),
    createdAt: input.createdAt,
  };
  const finish = (candidates: readonly MemoryCandidate[]): readonly MemoryCandidate[] => {
    recordMemoryCandidateMetrics(input.metrics, candidates);
    span?.end({
      attributes: {
        "memory.candidate_count": candidates.length,
        "memory.status": "succeeded",
      },
    });

    return candidates;
  };

  if (input.command.commandKind === "remember_fact" && input.command.content) {
    return finish([
      {
        ...common,
        id: stableId("memcand", [
          input.orgId,
          input.repoId ?? "",
          input.command.rawText,
          input.createdAt,
        ]),
        candidateKind: "repo_fact",
        proposedContent: input.command.content,
        proposedAppliesTo: input.command.appliesTo ?? {},
      },
    ]);
  }

  if (input.command.commandKind === "suppress_exact" && input.findingFingerprint) {
    return finish([
      {
        ...common,
        id: stableId("memcand", [input.orgId, input.findingFingerprint, input.createdAt]),
        candidateKind: "suppress_exact_finding",
        proposedContent: input.command.content ?? "Suppress this exact finding fingerprint.",
        proposedScope: {
          ...common.proposedScope,
          level: "finding_fingerprint",
          findingFingerprints: [input.findingFingerprint],
        },
        proposedAppliesTo: { findingFingerprints: [input.findingFingerprint] },
      },
    ]);
  }

  if (
    input.command.commandKind === "suppress_similar" ||
    input.command.commandKind === "disable_category_in_scope"
  ) {
    return finish([
      {
        ...common,
        id: stableId("memcand", [
          input.orgId,
          input.command.commandKind,
          input.command.rawText,
          input.createdAt,
        ]),
        candidateKind:
          input.command.commandKind === "disable_category_in_scope"
            ? "suppress_category_in_scope"
            : "suppress_similar_finding",
        proposedContent: input.command.content ?? "Suppress similar findings.",
        proposedAppliesTo: input.command.appliesTo ?? {},
      },
    ]);
  }

  return finish([]);
}

/** Converts an approved or auto-activated candidate into an active memory fact. */
export function activateMemoryCandidate(
  input: MemoryTelemetryOptions & {
    /** Candidate to activate. */
    readonly candidate: MemoryCandidate;
    /** New memory fact ID. */
    readonly memoryFactId: string;
    /** Activation timestamp. */
    readonly activatedAt: string;
    /** Optional expiration timestamp. */
    readonly expiresAt?: string | undefined;
  },
): MemoryFact {
  const kind = memoryKindForCandidate(input.candidate.candidateKind);
  const span = startMemorySpan(input, OBSERVABILITY_SPAN_NAMES.memoryActivateFact, {
    "app.org_id": input.candidate.orgId,
    ...(input.candidate.repoId ? { "app.repo_id": input.candidate.repoId } : {}),
    "memory.candidate_kind": input.candidate.candidateKind,
    "memory.fact_kind": kind,
    "memory.scope": input.candidate.proposedScope.level,
  });
  const fact: MemoryFact = {
    id: input.memoryFactId,
    orgId: input.candidate.orgId,
    ...(input.candidate.repoId ? { repoId: input.candidate.repoId } : {}),
    kind,
    content: input.candidate.proposedContent,
    normalizedContent: normalizeText(input.candidate.proposedContent),
    scope: input.candidate.proposedScope,
    appliesTo: input.candidate.proposedAppliesTo,
    sourceKind: input.candidate.sourceKind === "command" ? "command" : "system",
    trustLevel: input.candidate.trustLevel,
    confidence: input.candidate.confidence,
    status: "active",
    priority: kind === "suppression" ? 700 : 300,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.candidate.createdByLogin ? { createdByLogin: input.candidate.createdByLogin } : {}),
    createdAt: input.activatedAt,
    updatedAt: input.activatedAt,
  };
  recordMemoryFactMetrics(input.metrics, [fact]);
  span?.end({
    attributes: {
      "memory.fact_kind": fact.kind,
      "memory.scope": fact.scope.level,
      "memory.status": "succeeded",
    },
  });

  return fact;
}

/** Evaluates active memory facts for an explainable suppression decision. */
export function evaluateSuppression(input: SuppressionInput): SuppressionDecision {
  recordMemoryCorrelationSpan(input);
  const span = startMemorySpan(input, OBSERVABILITY_SPAN_NAMES.memoryMatchSuppression, {
    "app.org_id": input.orgId,
    "app.repo_id": input.repoId,
    "memory.candidate_category": input.candidateFinding.category,
    "memory.candidate_severity": input.candidateFinding.severity,
    "memory.fact_count": input.memoryFacts.length,
  });
  const activeFacts = input.memoryFacts
    .filter((fact) => fact.status === "active" && fact.kind === "suppression")
    .filter((fact) => memoryFactInScope(fact, input.orgId, input.repoId))
    .sort(compareMemoryPriority);

  const finish = (decision: SuppressionDecision): SuppressionDecision => {
    const matchedFact = decision.memoryFactId
      ? activeFacts.find((fact) => fact.id === decision.memoryFactId)
      : undefined;
    recordSuppressionMatchMetric(input.metrics, decision, matchedFact);
    span?.end({
      attributes: {
        ...(decision.matchKind ? { "memory.match_type": decision.matchKind } : {}),
        ...(matchedFact ? { "memory.scope": matchedFact.scope.level } : {}),
        "memory.active_fact_count": activeFacts.length,
        "memory.status": "succeeded",
        "memory.suppressed": decision.suppressed,
      },
    });

    return decision;
  };

  for (const fact of activeFacts) {
    const decision = evaluateMemoryFactSuppression(fact, input.candidateFinding);
    if (decision.suppressed) {
      return finish(decision);
    }
  }

  return finish({ suppressed: false, confidence: 0 });
}

/** Retrieves active memory facts with relevance scoring, trace data, and prompt budgets. */
export function retrieveRelevantMemory(input: RankRelevantMemoryFactsInput): RelevantMemoryResult {
  const maxFacts = input.maxFacts ?? 6;
  const maxTokens = input.maxTokens ?? 600;
  const now = input.now ? Date.parse(input.now) : Date.now();
  const ranked = input.memoryFacts
    .filter((fact) => fact.status === "active")
    .filter((fact) => memoryFactInScope(fact, input.orgId, input.repoId))
    .map((fact) => scoreRelevantMemoryFact(fact, input, now))
    .filter((entry) => entry.score > 0)
    .sort(compareRelevantMemoryScores);

  const facts: MemoryFact[] = [];
  const trace: RelevantMemoryTraceEntry[] = [];
  let usedTokens = 0;

  for (const entry of ranked) {
    const withinFactBudget = facts.length < maxFacts;
    const withinTokenBudget = usedTokens + entry.tokenEstimate <= maxTokens;
    const included = withinFactBudget && withinTokenBudget;

    if (included) {
      facts.push(entry.fact);
      usedTokens += entry.tokenEstimate;
    }

    trace.push({
      memoryFactId: entry.fact.id,
      reason: included ? entry.reason : budgetExclusionReason(withinFactBudget, withinTokenBudget),
      score: entry.score,
      matchedDimensions: entry.matchedDimensions,
      tokenEstimate: entry.tokenEstimate,
      included,
    });
  }

  return { facts, trace };
}

/** Creates an in-memory relevant memory retriever for tests and local orchestration. */
export function createStaticRelevantMemoryRetriever(
  memoryFacts: readonly MemoryFact[],
): RelevantMemoryRetriever {
  return {
    retrieveRelevantMemory: async (input) => retrieveRelevantMemory({ ...input, memoryFacts }),
  };
}

/** Returns active memory facts relevant to retrieval context for a repository. */
export function getRelevantMemoryFacts(input: {
  /** Organization ID. */
  readonly orgId: string;
  /** Repository ID. */
  readonly repoId: string;
  /** Optional changed file paths. */
  readonly paths?: readonly string[] | undefined;
  /** Available memory facts. */
  readonly memoryFacts: readonly MemoryFact[];
}): readonly MemoryFact[] {
  return retrieveRelevantMemory({
    orgId: input.orgId,
    repoId: input.repoId,
    changedFiles: (input.paths ?? []).map((path) => ({ path })),
    memoryFacts: input.memoryFacts,
    maxFacts: Number.MAX_SAFE_INTEGER,
    maxTokens: Number.MAX_SAFE_INTEGER,
  }).facts;
}

/** Formats one memory fact as a compact model-visible context line. */
export function formatMemoryFactForContext(fact: MemoryFact): string {
  return `- [${fact.kind}, ${confidenceLabel(fact.confidence)}, ${scopeLabel(
    fact.scope.level,
  )}] ${fact.content}`;
}

/** Creates a stable finding fingerprint that tolerates small line shifts. */
export function createFindingFingerprint(input: FindingFingerprintInput): string {
  return `ffp_${sha256(
    [
      input.category,
      normalizeText(input.normalizedTitle),
      normalizeText(input.normalizedRootCause),
      pathBucket(input.filePath),
      normalizeText(input.symbolName ?? ""),
      ...(input.evidenceCodeHashes ? [...input.evidenceCodeHashes].sort() : []),
    ].join("\0"),
  ).slice(0, 32)}`;
}

/** Builds an initial pending outcome for a published finding. */
export function createPendingOutcome(input: {
  /** Outcome ID. */
  readonly outcomeId: string;
  /** Published finding ID. */
  readonly publishedFindingId: string;
  /** Review run ID. */
  readonly reviewRunId: string;
  /** Creation timestamp. */
  readonly createdAt: string;
}): MemoryFindingOutcome {
  return {
    id: input.outcomeId,
    publishedFindingId: input.publishedFindingId,
    reviewRunId: input.reviewRunId,
    outcome: "pending",
    confidence: 0.5,
    positiveScore: 0,
    negativeScore: 0,
    updatedAt: input.createdAt,
  };
}

/** Starts a product-safe memory span when tracing is configured. */
function startMemorySpan(
  telemetry: MemoryTelemetryOptions,
  name: string,
  attributes: Readonly<Record<string, TelemetryAttributeValue | undefined>>,
): TelemetrySpanHandle | undefined {
  return telemetry.traces?.startSpan(name, {
    attributes,
    kind: "internal",
    traceContext: telemetry.traceContext,
  });
}

/** Builds product-safe feedback event span attributes. */
function feedbackEventTelemetryAttributes(
  event: FeedbackEvent,
): Readonly<Record<string, TelemetryAttributeValue | undefined>> {
  return {
    "app.org_id": event.orgId,
    "app.repo_id": event.repoId,
    ...(event.reviewRunId ? { "app.review_run_id": event.reviewRunId } : {}),
    "feedback.event_type": event.eventKind,
    "feedback.provider": sanitizeMemoryTelemetryLabel(event.provider),
    "feedback.source": event.source,
  };
}

/** Records feedback signals grouped by bounded signal metadata. */
function recordFeedbackSignalMetrics(
  metrics: TelemetryMetricRecorder | undefined,
  signals: readonly FeedbackSignal[],
): void {
  const signalCounts = new Map<string, { readonly signal: FeedbackSignal; count: number }>();
  for (const signal of signals) {
    const key = `${signal.signalKind}:${signal.polarity}`;
    const existing = signalCounts.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }

    signalCounts.set(key, { signal, count: 1 });
  }

  for (const { count, signal } of signalCounts.values()) {
    metrics?.count(OBSERVABILITY_METRIC_NAMES.feedbackSignalsTotal, {
      labels: {
        polarity: signal.polarity,
        signal_type: signal.signalKind,
      },
      value: count,
    });
  }
}

/** Records memory candidate counters grouped by status and source. */
function recordMemoryCandidateMetrics(
  metrics: TelemetryMetricRecorder | undefined,
  candidates: readonly MemoryCandidate[],
): void {
  const candidateCounts = new Map<string, { readonly candidate: MemoryCandidate; count: number }>();
  for (const candidate of candidates) {
    const key = `${candidate.status}:${candidate.sourceKind}:${candidate.candidateKind}`;
    const existing = candidateCounts.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }

    candidateCounts.set(key, { candidate, count: 1 });
  }

  for (const { candidate, count } of candidateCounts.values()) {
    metrics?.count(OBSERVABILITY_METRIC_NAMES.memoryCandidatesTotal, {
      labels: {
        candidate_kind: candidate.candidateKind,
        source: candidate.sourceKind,
        status: candidate.status,
      },
      value: count,
    });
  }
}

/** Records memory fact counters grouped by status and scope. */
function recordMemoryFactMetrics(
  metrics: TelemetryMetricRecorder | undefined,
  facts: readonly MemoryFact[],
): void {
  const factCounts = new Map<string, { readonly fact: MemoryFact; count: number }>();
  for (const fact of facts) {
    const key = `${fact.status}:${fact.scope.level}:${fact.kind}`;
    const existing = factCounts.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }

    factCounts.set(key, { fact, count: 1 });
  }

  for (const { fact, count } of factCounts.values()) {
    metrics?.count(OBSERVABILITY_METRIC_NAMES.memoryFactsTotal, {
      labels: {
        kind: fact.kind,
        scope: fact.scope.level,
        status: fact.status,
      },
      value: count,
    });
  }
}

/** Records memory suppression matches without candidate text or paths. */
function recordSuppressionMatchMetric(
  metrics: TelemetryMetricRecorder | undefined,
  decision: SuppressionDecision,
  matchedFact: MemoryFact | undefined,
): void {
  if (!decision.suppressed) {
    return;
  }

  metrics?.count(OBSERVABILITY_METRIC_NAMES.memorySuppressionMatchesTotal, {
    labels: {
      match_type: decision.matchKind ?? "unknown",
      scope: matchedFact?.scope.level ?? "unknown",
    },
  });
}

/** Records a short span for provider finding correlation during suppression matching. */
function recordMemoryCorrelationSpan(input: SuppressionInput): void {
  const span = startMemorySpan(input, OBSERVABILITY_SPAN_NAMES.memoryCorrelateFinding, {
    "app.org_id": input.orgId,
    "app.repo_id": input.repoId,
    "memory.candidate_category": input.candidateFinding.category,
    "memory.candidate_severity": input.candidateFinding.severity,
    "memory.changed_symbol_count": input.changedSymbolNames?.length ?? 0,
  });

  span?.end({
    attributes: { "memory.status": "completed" },
  });
}

/** Converts free-form provider names into bounded telemetry label values. */
function sanitizeMemoryTelemetryLabel(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/gu, "_")
    .slice(0, 80);

  return normalized.length > 0 ? normalized : "unknown";
}

/** Parses marker fields from a hidden HTML comment marker. */
function parseMarkerFields(rawFields: string): Record<string, string> {
  return Object.fromEntries(
    [...rawFields.matchAll(/([a-z_]+)="([^"]*)"/gu)].map((match) => [
      match[1] ?? "",
      match[2] ?? "",
    ]),
  );
}

/** Escapes hidden marker values without introducing HTML syntax. */
function escapeMarkerValue(value: string): string {
  return value.replaceAll('"', "").replaceAll("--", "");
}

/** Strips the bot mention from a raw command body. */
function stripBotMention(text: string): string | undefined {
  const match = text.trim().match(/^@(bot|heimdall)\b[:,]?\s*(.+)$/iu);
  return match?.[2] ? normalizeText(match[2]) : undefined;
}

/** Returns whether normalized command text contains one of the phrases. */
function matchesAny(commandText: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => commandText === phrase || commandText.includes(phrase));
}

/** Creates a basic parsed command with common fields. */
function baseCommand(
  commandKind: FeedbackCommandKind,
  rawText: string,
  context: {
    readonly orgId: string;
    readonly repoId?: string | undefined;
    readonly target?: FeedbackCommandTarget | undefined;
  },
  confidence: number,
): FeedbackCommand {
  return {
    commandKind,
    rawText,
    ...(context.target ? { target: context.target } : {}),
    scope: repoScope(context),
    confidence,
  };
}

/** Creates a suppression command with common suppression fields. */
function suppressionCommand(
  commandKind: "suppress_exact" | "suppress_similar" | "disable_category_in_scope",
  rawText: string,
  context: {
    readonly orgId: string;
    readonly repoId?: string | undefined;
    readonly target?: FeedbackCommandTarget | undefined;
  },
  content: string,
  confidence: number,
): FeedbackCommand {
  return {
    ...baseCommand(commandKind, rawText, context, confidence),
    content,
    appliesTo: {},
  };
}

/** Creates the default repository or organization scope for a command. */
function repoScope(context: {
  readonly orgId: string;
  readonly repoId?: string | undefined;
}): MemoryScope {
  return {
    level: context.repoId ? "repo" : "org",
    orgId: context.orgId,
    ...(context.repoId ? { repoId: context.repoId } : {}),
  };
}

/** Parses finding category mentions from command text. */
function parseCategories(text: string): FindingCategory[] {
  const normalized = normalizeText(text);
  const categories: FindingCategory[] = [];
  const categoryNames: readonly FindingCategory[] = [
    "correctness",
    "security",
    "performance",
    "test_coverage",
    "maintainability",
    "architecture",
    "dependency",
    "documentation",
    "style",
    "other",
  ];

  for (const category of categoryNames) {
    if (normalized.includes(category.replace("_", " ")) || normalized.includes(category)) {
      categories.push(category);
    }
  }

  return categories;
}

/** Returns whether an actor has one of the listed associations. */
function hasAssociation(
  actor: FeedbackActor,
  associations: readonly NonNullable<FeedbackActor["association"]>[],
): boolean {
  return actor.association ? associations.includes(actor.association) : false;
}

/** Returns whether an actor has at least the required provider permission. */
function hasPermission(actor: FeedbackActor, minimum: FeedbackActorPermission): boolean {
  const order: readonly FeedbackActorPermission[] = [
    "none",
    "read",
    "triage",
    "write",
    "maintain",
    "admin",
  ];
  return order.indexOf(actor.permission ?? "none") >= order.indexOf(minimum);
}

/** Maps a parsed command to a feedback signal. */
function signalForCommand(
  command: FeedbackCommand,
  signal: (
    signalKind: FeedbackSignalKind,
    polarity: FeedbackSignal["polarity"],
    strength: number,
    confidence: number,
    reason: string,
  ) => FeedbackSignal,
): FeedbackSignal {
  switch (command.commandKind) {
    case "mark_false_positive":
      return signal(
        "explicit_false_positive",
        "negative",
        1,
        command.confidence,
        "User marked finding false positive.",
      );
    case "mark_not_useful":
      return signal(
        "explicit_not_actionable",
        "negative",
        0.9,
        command.confidence,
        "User marked finding not useful.",
      );
    case "remember_fact":
      return signal(
        "explicit_remember_command",
        "memory",
        1,
        command.confidence,
        "User asked Heimdall to remember a fact.",
      );
    case "suppress_exact":
    case "suppress_similar":
    case "disable_category_in_scope":
      return signal(
        "explicit_suppress_command",
        "suppression",
        1,
        command.confidence,
        "User asked Heimdall to suppress findings.",
      );
    case "set_review_preference":
      return signal(
        "explicit_intentional",
        "mixed",
        0.8,
        command.confidence,
        "User set a review preference.",
      );
  }
}

/** Returns an updated outcome with aggregate scores and last signal. */
function updateOutcome(
  outcome: MemoryFindingOutcome,
  nextOutcome: FindingOutcomeKind,
  confidence: number,
  aggregate: {
    readonly positiveScore: number;
    readonly negativeScore: number;
    readonly lastSignalId?: string | undefined;
  },
  updatedAt: string,
): MemoryFindingOutcome {
  return {
    ...outcome,
    outcome: nextOutcome,
    confidence,
    positiveScore: aggregate.positiveScore,
    negativeScore: aggregate.negativeScore,
    ...(aggregate.lastSignalId ? { lastSignalId: aggregate.lastSignalId } : {}),
    updatedAt,
  };
}

/** Maps a memory candidate kind to a durable memory fact kind. */
function memoryKindForCandidate(candidateKind: MemoryCandidateKind): MemoryFactKind {
  if (
    candidateKind === "suppress_exact_finding" ||
    candidateKind === "suppress_similar_finding" ||
    candidateKind === "suppress_category_in_scope"
  ) {
    return "suppression";
  }
  if (candidateKind === "repo_fact") {
    return "repo_fact";
  }
  if (candidateKind === "style_preference") {
    return "style_preference";
  }
  if (candidateKind === "architecture_convention") {
    return "architecture_convention";
  }
  if (candidateKind === "security_convention") {
    return "security_convention";
  }
  if (candidateKind === "testing_convention") {
    return "testing_convention";
  }
  if (candidateKind === "severity_calibration") {
    return "severity_calibration";
  }

  return "team_preference";
}

/** Returns whether a memory fact applies to the current org and repo. */
function memoryFactInScope(fact: MemoryFact, orgId: string, repoId: string): boolean {
  return fact.orgId === orgId && (!fact.repoId || fact.repoId === repoId);
}

/** Sorts memory by priority, confidence, and specificity. */
function compareMemoryPriority(left: MemoryFact, right: MemoryFact): number {
  return (
    right.priority - left.priority ||
    right.confidence - left.confidence ||
    scopeWeight(right.scope.level) - scopeWeight(left.scope.level)
  );
}

/** Scored memory fact with private sort-only fields. */
type ScoredRelevantMemoryFact = {
  /** Memory fact being scored. */
  readonly fact: MemoryFact;
  /** Final normalized score. */
  readonly score: number;
  /** Product-safe score explanation. */
  readonly reason: string;
  /** Matching dimensions that contributed to relevance. */
  readonly matchedDimensions: readonly string[];
  /** Estimated context tokens. */
  readonly tokenEstimate: number;
};

/** Returns a numeric weight for scope specificity. */
function scopeWeight(level: MemoryScope["level"]): number {
  switch (level) {
    case "finding_fingerprint":
      return 5;
    case "symbol":
      return 4;
    case "path":
      return 3;
    case "repo":
      return 2;
    case "org":
      return 1;
  }

  return 0;
}

/** Scores one memory fact for relevant context selection. */
function scoreRelevantMemoryFact(
  fact: MemoryFact,
  input: RetrieveRelevantMemoryInput,
  now: number,
): ScoredRelevantMemoryFact {
  const dimensions = matchingMemoryDimensions(fact, input);
  const specificity = scopeWeight(fact.scope.level) / 5;
  const trust = trustLevelWeight(fact.trustLevel);
  const categoryPathMatch =
    dimensions.length > 0 ? Math.min(1, 0.35 + dimensions.length * 0.18) : 0;
  const recency = recencyWeight(fact.updatedAt, now);
  const score = roundScore(
    specificity * 0.35 +
      trust * 0.25 +
      categoryPathMatch * 0.2 +
      fact.confidence * 0.15 +
      recency * 0.05,
  );

  return {
    fact,
    score,
    reason:
      dimensions.length > 0
        ? `Matched ${dimensions.join(", ")} with ${scopeLabel(fact.scope.level)} scope.`
        : `Included broad ${scopeLabel(fact.scope.level)} memory in scope.`,
    matchedDimensions: dimensions,
    tokenEstimate: estimateTokens(formatMemoryFactForContext(fact)),
  };
}

/** Compares scored memory rows by score, priority, specificity, and ID. */
function compareRelevantMemoryScores(
  left: ScoredRelevantMemoryFact,
  right: ScoredRelevantMemoryFact,
): number {
  return (
    right.score - left.score ||
    compareMemoryPriority(left.fact, right.fact) ||
    left.fact.id.localeCompare(right.fact.id)
  );
}

/** Finds matching dimensions for one fact against the review context. */
function matchingMemoryDimensions(
  fact: MemoryFact,
  input: RetrieveRelevantMemoryInput,
): readonly string[] {
  const dimensions: string[] = [];
  const paths = input.changedFiles.map((file) => file.path);
  const languages = new Set(
    [
      ...input.changedFiles.map((file) => file.language),
      ...(input.changedSymbols ?? []).map((symbol) => symbol.language),
    ].filter((language): language is string => Boolean(language)),
  );
  const symbolNames = new Set(
    (input.changedSymbols ?? [])
      .flatMap((symbol) => [symbol.name, symbol.qualifiedName])
      .filter((name): name is string => Boolean(name)),
  );

  if (
    matchesPathGlobs(paths, fact.scope.pathGlobs) ||
    matchesPathGlobs(paths, fact.appliesTo.pathGlobs)
  ) {
    dimensions.push("path");
  }
  if (
    matchesAnyValue(languages, fact.scope.languages) ||
    matchesAnyValue(languages, fact.appliesTo.languages)
  ) {
    dimensions.push("language");
  }
  if (input.findingCategories?.some((category) => fact.appliesTo.categories?.includes(category))) {
    dimensions.push("category");
  }
  if (
    matchesAnyValue(symbolNames, fact.scope.symbolNames) ||
    matchesAnyValue(symbolNames, fact.appliesTo.symbolNames)
  ) {
    dimensions.push("symbol");
  }
  if (fact.appliesTo.titlePatterns?.length) {
    dimensions.push("title_pattern");
  }
  if (fact.scope.level === "repo" || fact.scope.level === "org") {
    dimensions.push("scope");
  }

  return [...new Set(dimensions)];
}

/** Returns whether any repository path matches any glob. */
function matchesPathGlobs(paths: readonly string[], globs: readonly string[] | undefined): boolean {
  if (!globs?.length) {
    return false;
  }

  return paths.some((path) => globs.some((glob) => globMatches(glob, path)));
}

/** Returns whether a set includes any requested value. */
function matchesAnyValue(
  values: ReadonlySet<string>,
  requested: readonly string[] | undefined,
): boolean {
  return Boolean(requested?.some((value) => values.has(value)));
}

/** Converts a memory trust label into a normalized ranking weight. */
function trustLevelWeight(trustLevel: string): number {
  switch (trustLevel) {
    case "admin":
    case "system":
      return 1;
    case "explicit_maintainer":
      return 0.95;
    case "trusted_contributor":
      return 0.75;
    case "author":
      return 0.55;
    case "untrusted":
      return 0.2;
    default:
      return 0.5;
  }
}

/** Returns recency weight for updated memory. */
function recencyWeight(updatedAt: string, now: number): number {
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated) || !Number.isFinite(now)) {
    return 0.5;
  }
  const ageDays = Math.max(0, (now - updated) / 86_400_000);
  if (ageDays <= 30) return 1;
  if (ageDays <= 90) return 0.8;
  if (ageDays <= 365) return 0.5;
  return 0.2;
}

/** Rounds scores so traces remain stable and readable. */
function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

/** Returns a compact confidence label for prompt context. */
function confidenceLabel(confidence: number): string {
  if (confidence >= 0.85) return "high confidence";
  if (confidence >= 0.65) return "medium confidence";
  return "low confidence";
}

/** Returns a human-readable memory scope label. */
function scopeLabel(level: MemoryScope["level"]): string {
  return level.replaceAll("_", " ");
}

/** Returns why a ranked memory fact was excluded by budgets. */
function budgetExclusionReason(withinFactBudget: boolean, withinTokenBudget: boolean): string {
  if (!withinFactBudget) return "Excluded by memory fact count budget.";
  if (!withinTokenBudget) return "Excluded by memory token budget.";
  return "Excluded by memory budget.";
}

/** Evaluates one memory fact against one candidate finding. */
function evaluateMemoryFactSuppression(
  fact: MemoryFact,
  finding: SuppressionCandidateFinding,
): SuppressionDecision {
  if (fact.appliesTo.findingFingerprints?.includes(finding.fingerprint)) {
    return suppressionDecision(
      fact,
      "exact_fingerprint",
      0.99,
      "Maintainer suppressed this exact finding fingerprint.",
    );
  }

  if (fact.appliesTo.pathGlobs?.some((glob) => globMatches(glob, finding.location.path))) {
    if (
      !fact.appliesTo.categories?.length ||
      fact.appliesTo.categories.includes(finding.category)
    ) {
      return suppressionDecision(
        fact,
        "path_category",
        Math.min(0.95, fact.confidence),
        "Repo memory suppresses this category under the matched path.",
      );
    }
  }

  if (
    fact.appliesTo.titlePatterns?.some((pattern) =>
      normalizeText(finding.title).includes(normalizeText(pattern)),
    )
  ) {
    return suppressionDecision(
      fact,
      "title_pattern",
      Math.min(0.9, fact.confidence),
      "Repo memory suppresses findings with this title pattern.",
    );
  }

  if (
    !Object.keys(fact.appliesTo).length &&
    normalizeText(fact.content).includes("do not comment")
  ) {
    return suppressionDecision(
      fact,
      "repo_preference",
      Math.min(0.75, fact.confidence),
      "Repo memory contains a broad suppression preference.",
    );
  }

  return { suppressed: false, confidence: 0 };
}

/** Creates a positive suppression decision for an active memory fact. */
function suppressionDecision(
  fact: MemoryFact,
  matchKind: NonNullable<SuppressionDecision["matchKind"]>,
  confidence: number,
  reason: string,
): SuppressionDecision {
  return {
    suppressed: true,
    confidence,
    reason,
    memoryFactId: fact.id,
    matchKind,
  };
}

/** Returns whether a glob-like pattern matches a repository path. */
function globMatches(glob: string, path: string): boolean {
  const pattern = glob
    .split("**")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", "[^/]*"))
    .join(".*");
  return new RegExp(`^${pattern}$`, "u").test(path);
}

/** Reduces a path to a stable bucket for fingerprinting. */
function pathBucket(filePath: string): string {
  const segments = filePath.split("/");
  return segments.length <= 2 ? filePath : `${segments.slice(0, -1).join("/")}/_`;
}

/** Creates a stable ID from deterministic parts. */
function stableId(prefix: string, parts: readonly string[]): string {
  return `${prefix}_${sha256(parts.join("\0")).slice(0, 24)}`;
}

/** Estimates prompt token usage from text. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Creates a SHA-256 digest. */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Normalizes free-form command and memory text. */
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
