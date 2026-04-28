import { Type, type Static } from "@sinclair/typebox";

export const UsageEventTypeSchema = Type.Union([
  Type.Literal("review.run"),
  Type.Literal("index.file"),
  Type.Literal("index.chunk"),
  Type.Literal("embedding.token"),
  Type.Literal("llm.token"),
  Type.Literal("github.api_call"),
  Type.Literal("storage.artifact_written"),
  Type.Literal("worker.job")
]);
export type UsageEventType = Static<typeof UsageEventTypeSchema>;
