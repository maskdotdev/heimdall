import { type Static, Type } from "@sinclair/typebox";
import { ApiSuccessResponseSchema } from "./common";

/** JSON value schema used for structured evaluation summaries and artifacts. */
const JsonValueSchema = Type.Unknown();

/** Evaluation run summary returned by read-only history endpoints. */
export const EvaluationRunSummarySchema = Type.Object(
  {
    baselineVariantId: Type.Optional(Type.String()),
    branch: Type.Optional(Type.String()),
    caseCount: Type.Number(),
    completedAt: Type.Optional(Type.String()),
    environment: Type.String(),
    error: Type.Optional(JsonValueSchema),
    evalRunId: Type.String(),
    evalSuiteId: Type.String(),
    evalVariantId: Type.String(),
    gitCommitSha: Type.Optional(Type.String()),
    reportUri: Type.Optional(Type.String()),
    startedAt: Type.String(),
    status: Type.String(),
    summary: Type.Optional(JsonValueSchema),
    triggeredBy: Type.String(),
  },
  { additionalProperties: false },
);
export type EvaluationRunSummary = Static<typeof EvaluationRunSummarySchema>;

/** Active baseline pointer returned for an evaluation suite. */
export const EvaluationBaselineSummarySchema = Type.Object(
  {
    active: Type.Boolean(),
    baselineVariantId: Type.String(),
    createdAt: Type.String(),
    evalRunId: Type.Optional(Type.String()),
    evalSuiteId: Type.String(),
  },
  { additionalProperties: false },
);
export type EvaluationBaselineSummary = Static<typeof EvaluationBaselineSummarySchema>;

/** Evaluation suite summary returned by read-only history endpoints. */
export const EvaluationSuiteSummarySchema = Type.Object(
  {
    activeBaseline: Type.Optional(EvaluationBaselineSummarySchema),
    createdAt: Type.String(),
    defaultGraders: JsonValueSchema,
    defaultRunner: Type.String(),
    description: Type.String(),
    evalSuiteId: Type.String(),
    latestRun: Type.Optional(EvaluationRunSummarySchema),
    name: Type.String(),
    owner: Type.String(),
    tags: JsonValueSchema,
    thresholds: JsonValueSchema,
    updatedAt: Type.String(),
    version: Type.String(),
  },
  { additionalProperties: false },
);
export type EvaluationSuiteSummary = Static<typeof EvaluationSuiteSummarySchema>;

/** Per-case result summary returned for one persisted evaluation run. */
export const EvaluationCaseResultSummarySchema = Type.Object(
  {
    artifacts: JsonValueSchema,
    costs: JsonValueSchema,
    createdAt: Type.String(),
    error: Type.Optional(JsonValueSchema),
    evalCaseId: Type.String(),
    evalCaseResultId: Type.String(),
    evalRunId: Type.String(),
    matchedFindings: JsonValueSchema,
    scores: JsonValueSchema,
    status: Type.String(),
    timings: JsonValueSchema,
    unmatchedExpectedFindings: JsonValueSchema,
    unmatchedGeneratedFindings: JsonValueSchema,
  },
  { additionalProperties: false },
);
export type EvaluationCaseResultSummary = Static<typeof EvaluationCaseResultSummarySchema>;

/** Response body for listing evaluation suites. */
export const ListEvaluationSuitesResponseSchema = ApiSuccessResponseSchema(
  Type.Object(
    {
      suites: Type.Array(EvaluationSuiteSummarySchema),
    },
    { additionalProperties: false },
  ),
);
export type ListEvaluationSuitesResponse = Static<typeof ListEvaluationSuitesResponseSchema>;

/** Response body for listing evaluation runs for one suite. */
export const ListEvaluationRunsResponseSchema = ApiSuccessResponseSchema(
  Type.Object(
    {
      runs: Type.Array(EvaluationRunSummarySchema),
    },
    { additionalProperties: false },
  ),
);
export type ListEvaluationRunsResponse = Static<typeof ListEvaluationRunsResponseSchema>;

/** Response body for reading one evaluation run and its case results. */
export const GetEvaluationRunResponseSchema = ApiSuccessResponseSchema(
  Type.Object(
    {
      caseResults: Type.Array(EvaluationCaseResultSummarySchema),
      run: EvaluationRunSummarySchema,
    },
    { additionalProperties: false },
  ),
);
export type GetEvaluationRunResponse = Static<typeof GetEvaluationRunResponseSchema>;
