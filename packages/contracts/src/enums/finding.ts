import { Type, type Static } from "@sinclair/typebox";

export const FindingSeveritySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical")
]);
export type FindingSeverity = Static<typeof FindingSeveritySchema>;

export const FindingCategorySchema = Type.Union([
  Type.Literal("correctness"),
  Type.Literal("security"),
  Type.Literal("performance"),
  Type.Literal("test_coverage"),
  Type.Literal("maintainability"),
  Type.Literal("architecture"),
  Type.Literal("style"),
  Type.Literal("dependency"),
  Type.Literal("documentation"),
  Type.Literal("other")
]);
export type FindingCategory = Static<typeof FindingCategorySchema>;

export const FindingSourceSchema = Type.Union([
  Type.Literal("llm"),
  Type.Literal("static_analysis"),
  Type.Literal("rule"),
  Type.Literal("memory"),
  Type.Literal("hybrid")
]);
export type FindingSource = Static<typeof FindingSourceSchema>;
