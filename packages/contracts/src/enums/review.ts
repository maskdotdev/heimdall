import { type Static, Type } from "@sinclair/typebox";

export const ReviewRunStatusSchema = Type.Union([
  Type.Literal("created"),
  Type.Literal("snapshotting"),
  Type.Literal("waiting_for_index"),
  Type.Literal("waiting_for_embeddings"),
  Type.Literal("retrieving_context"),
  Type.Literal("reviewing"),
  Type.Literal("validating_findings"),
  Type.Literal("publish_queued"),
  Type.Literal("completed"),
  Type.Literal("skipped"),
  Type.Literal("superseded"),
  Type.Literal("canceled"),
  Type.Literal("failed"),
]);
export type ReviewRunStatus = Static<typeof ReviewRunStatusSchema>;

export const ReviewSizeClassSchema = Type.Union([
  Type.Literal("small"),
  Type.Literal("medium"),
  Type.Literal("large"),
  Type.Literal("huge"),
]);
export type ReviewSizeClass = Static<typeof ReviewSizeClassSchema>;

export const ReviewTriggerSchema = Type.Union([
  Type.Literal("webhook"),
  Type.Literal("manual"),
  Type.Literal("rerun"),
  Type.Literal("scheduled"),
]);
export type ReviewTrigger = Static<typeof ReviewTriggerSchema>;

export const REVIEW_RUN_TERMINAL_STATUSES = [
  "completed",
  "skipped",
  "superseded",
  "canceled",
  "failed",
] as const;
