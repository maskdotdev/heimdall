import { asc, desc, eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { feedbackEvents, feedbackSignals } from "../schema";

/** Input used to insert one durable feedback event if absent. */
export type CreateFeedbackEventInput = {
  /** Stable feedback event ID. */
  readonly feedbackEventId: string;
  /** Organization that owns the feedback event. */
  readonly orgId: string;
  /** Repository that owns the feedback event. */
  readonly repoId: string;
  /** Provider that emitted the feedback. */
  readonly provider: string;
  /** Feedback source such as webhook or reconciliation. */
  readonly source: string;
  /** Normalized feedback event kind. */
  readonly eventKind: string;
  /** Provider event ID when present. */
  readonly externalEventId?: string | null | undefined;
  /** Durable webhook event ID when present. */
  readonly webhookEventId?: string | null | undefined;
  /** Provider actor login when present. */
  readonly actorLogin?: string | null | undefined;
  /** Provider actor user ID when present. */
  readonly actorProviderUserId?: string | null | undefined;
  /** Provider actor association when present. */
  readonly actorAssociation?: string | null | undefined;
  /** Provider actor permission when present. */
  readonly actorPermission?: string | null | undefined;
  /** Whether the provider actor is a bot. */
  readonly actorIsBot?: boolean | undefined;
  /** Pull request number when present. */
  readonly pullRequestNumber?: number | null | undefined;
  /** Review run associated with the feedback when present. */
  readonly reviewRunId?: string | null | undefined;
  /** Published finding targeted by the feedback when present. */
  readonly publishedFindingId?: string | null | undefined;
  /** Provider comment ID when present. */
  readonly externalCommentId?: string | null | undefined;
  /** Provider thread ID when present. */
  readonly externalThreadId?: string | null | undefined;
  /** Redacted provider payload. */
  readonly payloadRedacted: unknown;
  /** Feedback receipt timestamp. */
  readonly receivedAt: Date;
};

/** Input used to insert one classified feedback signal if absent. */
export type CreateFeedbackSignalInput = {
  /** Stable feedback signal ID. */
  readonly feedbackSignalId: string;
  /** Feedback event that produced the signal. */
  readonly feedbackEventId: string;
  /** Published finding targeted by the signal when present. */
  readonly publishedFindingId?: string | null | undefined;
  /** Normalized feedback signal kind. */
  readonly signalKind: string;
  /** Signal polarity. */
  readonly polarity: string;
  /** Signal strength. */
  readonly strength: number;
  /** Classifier confidence. */
  readonly confidence: number;
  /** Product-safe reason for the signal. */
  readonly reason: string;
  /** Signal creation timestamp. */
  readonly createdAt: Date;
};

/** Joined feedback event and optional signal row used by finding feedback timelines. */
export type FeedbackTimelineRecord = {
  /** Actor login when available. */
  readonly actorLogin: string | null;
  /** Feedback event kind. */
  readonly eventKind: string;
  /** External provider comment ID when available. */
  readonly externalCommentId: string | null;
  /** External provider event ID when available. */
  readonly externalEventId: string | null;
  /** Feedback event row ID. */
  readonly feedbackEventId: string;
  /** Feedback signal row ID when present. */
  readonly feedbackSignalId: string | null;
  /** Redacted provider payload. */
  readonly payloadRedacted: unknown;
  /** Signal polarity when present. */
  readonly polarity: string | null;
  /** Provider name. */
  readonly provider: string;
  /** Pull request number when available. */
  readonly pullRequestNumber: number | null;
  /** Signal reason when present. */
  readonly reason: string | null;
  /** Feedback receipt timestamp. */
  readonly receivedAt: Date;
  /** Signal confidence when present. */
  readonly signalConfidence: number | null;
  /** Signal creation timestamp when present. */
  readonly signalCreatedAt: Date | null;
  /** Signal kind when present. */
  readonly signalKind: string | null;
  /** Feedback source. */
  readonly source: string;
  /** Signal strength when present. */
  readonly strength: number | null;
};

/** Query helper for durable feedback events and classified signals. */
export class FeedbackRepository {
  /** Creates a feedback query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Inserts one durable feedback event and preserves existing idempotent rows. */
  public async createFeedbackEventIfAbsent(input: CreateFeedbackEventInput): Promise<void> {
    await this.db
      .insert(feedbackEvents)
      .values({
        ...(input.actorAssociation ? { actorAssociation: input.actorAssociation } : {}),
        actorIsBot: input.actorIsBot ?? false,
        ...(input.actorLogin ? { actorLogin: input.actorLogin } : {}),
        ...(input.actorPermission ? { actorPermission: input.actorPermission } : {}),
        ...(input.actorProviderUserId ? { actorProviderUserId: input.actorProviderUserId } : {}),
        eventKind: input.eventKind,
        ...(input.externalCommentId ? { externalCommentId: input.externalCommentId } : {}),
        ...(input.externalEventId ? { externalEventId: input.externalEventId } : {}),
        ...(input.externalThreadId ? { externalThreadId: input.externalThreadId } : {}),
        feedbackEventId: input.feedbackEventId,
        orgId: input.orgId,
        payloadRedacted: input.payloadRedacted,
        provider: input.provider,
        ...(input.publishedFindingId ? { publishedFindingId: input.publishedFindingId } : {}),
        ...(input.pullRequestNumber ? { pullRequestNumber: input.pullRequestNumber } : {}),
        receivedAt: input.receivedAt,
        repoId: input.repoId,
        ...(input.reviewRunId ? { reviewRunId: input.reviewRunId } : {}),
        source: input.source,
        ...(input.webhookEventId ? { webhookEventId: input.webhookEventId } : {}),
      })
      .onConflictDoNothing();
  }

  /** Inserts one classified feedback signal and preserves existing idempotent rows. */
  public async createFeedbackSignalIfAbsent(input: CreateFeedbackSignalInput): Promise<void> {
    await this.db
      .insert(feedbackSignals)
      .values({
        confidence: input.confidence,
        createdAt: input.createdAt,
        feedbackEventId: input.feedbackEventId,
        feedbackSignalId: input.feedbackSignalId,
        polarity: input.polarity,
        ...(input.publishedFindingId ? { publishedFindingId: input.publishedFindingId } : {}),
        reason: input.reason,
        signalKind: input.signalKind,
        strength: input.strength,
      })
      .onConflictDoNothing();
  }

  /** Lists feedback timeline rows for one published finding. */
  public async listFeedbackTimelineForPublishedFinding(
    publishedFindingId: string,
  ): Promise<readonly FeedbackTimelineRecord[]> {
    return this.db
      .select({
        actorLogin: feedbackEvents.actorLogin,
        eventKind: feedbackEvents.eventKind,
        externalCommentId: feedbackEvents.externalCommentId,
        externalEventId: feedbackEvents.externalEventId,
        feedbackEventId: feedbackEvents.feedbackEventId,
        feedbackSignalId: feedbackSignals.feedbackSignalId,
        payloadRedacted: feedbackEvents.payloadRedacted,
        polarity: feedbackSignals.polarity,
        provider: feedbackEvents.provider,
        pullRequestNumber: feedbackEvents.pullRequestNumber,
        reason: feedbackSignals.reason,
        receivedAt: feedbackEvents.receivedAt,
        signalConfidence: feedbackSignals.confidence,
        signalCreatedAt: feedbackSignals.createdAt,
        signalKind: feedbackSignals.signalKind,
        source: feedbackEvents.source,
        strength: feedbackSignals.strength,
      })
      .from(feedbackEvents)
      .leftJoin(
        feedbackSignals,
        eq(feedbackSignals.feedbackEventId, feedbackEvents.feedbackEventId),
      )
      .where(eq(feedbackEvents.publishedFindingId, publishedFindingId))
      .orderBy(desc(feedbackEvents.receivedAt), asc(feedbackSignals.createdAt));
  }
}
