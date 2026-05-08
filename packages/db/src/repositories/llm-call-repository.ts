import { asc, eq } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { llmCallArtifacts, llmCalls } from "../schema";

/** Database surface required by the LLM call repository. */
type LlmCallRepositoryDatabase = Pick<HeimdallDatabase, "insert" | "select">;

/** Durable LLM call row inserted through the database boundary. */
export type LlmCallInsert = {
  /** Stable LLM call ID. */
  readonly llmCallId: string;
  /** Organization that owns the call. */
  readonly orgId: string;
  /** Repository that owns the call, when scoped. */
  readonly repoId?: string | null | undefined;
  /** Review run that produced the call, when scoped. */
  readonly reviewRunId?: string | null | undefined;
  /** LLM provider name. */
  readonly provider: string;
  /** LLM model name. */
  readonly model: string;
  /** Product task or purpose for the call. */
  readonly purpose: string;
  /** Durable call status. */
  readonly status: string;
  /** Hash of the redacted prompt payload. */
  readonly promptHash: string;
  /** Hash of the structured response payload, when available. */
  readonly responseHash?: string | null | undefined;
  /** Estimated input token count. */
  readonly inputTokens: number;
  /** Estimated output token count. */
  readonly outputTokens: number;
  /** Estimated provider cost in micros of USD. */
  readonly costMicros: number;
  /** Call start timestamp. */
  readonly startedAt: Date | string;
  /** Call completion timestamp. */
  readonly completedAt?: Date | string | null | undefined;
  /** Product-safe error payload when the call failed. */
  readonly error?: Readonly<Record<string, unknown>> | null | undefined;
  /** Product-safe metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | null | undefined;
};

/** Link from one LLM call to a persisted prompt or response artifact. */
export type LlmCallArtifactLinkInsert = {
  /** Stable LLM call ID. */
  readonly llmCallId: string;
  /** Review artifact ID referenced by the call. */
  readonly reviewArtifactId: string;
  /** Artifact role, such as prompt or response. */
  readonly artifactRole: string;
};

/** Durable LLM call row returned for review debug inspection. */
export type LlmCallRecord = typeof llmCalls.$inferSelect;

/** Input used to insert one LLM call and its artifact links idempotently. */
export type InsertLlmCallInput = {
  /** Durable LLM call row. */
  readonly call: LlmCallInsert;
  /** Artifact links attached to the call. */
  readonly artifactLinks?: readonly LlmCallArtifactLinkInsert[] | undefined;
};

/** Query helper for durable LLM call records and artifact links. */
export class LlmCallRepository {
  /** Creates an LLM call query helper. */
  public constructor(private readonly db: LlmCallRepositoryDatabase) {}

  /** Lists LLM call rows for one review run in call start order. */
  public async listLlmCallsForReviewRun(reviewRunId: string): Promise<readonly LlmCallRecord[]> {
    return this.db
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.reviewRunId, reviewRunId))
      .orderBy(asc(llmCalls.startedAt), asc(llmCalls.llmCallId));
  }

  /** Inserts one LLM call and its artifact links without duplicating stable IDs. */
  public async insertLlmCall(input: InsertLlmCallInput): Promise<void> {
    await this.db
      .insert(llmCalls)
      .values({
        completedAt: input.call.completedAt ? new Date(input.call.completedAt) : null,
        costMicros: input.call.costMicros,
        error: input.call.error ?? null,
        inputTokens: input.call.inputTokens,
        llmCallId: input.call.llmCallId,
        metadata: input.call.metadata ?? null,
        model: input.call.model,
        orgId: input.call.orgId,
        outputTokens: input.call.outputTokens,
        promptHash: input.call.promptHash,
        provider: input.call.provider,
        purpose: input.call.purpose,
        repoId: input.call.repoId ?? null,
        responseHash: input.call.responseHash ?? null,
        reviewRunId: input.call.reviewRunId ?? null,
        startedAt: new Date(input.call.startedAt),
        status: input.call.status,
      })
      .onConflictDoNothing();

    if (!input.artifactLinks || input.artifactLinks.length === 0) {
      return;
    }

    await this.db
      .insert(llmCallArtifacts)
      .values(input.artifactLinks.map((link) => ({ ...link })))
      .onConflictDoNothing();
  }
}
