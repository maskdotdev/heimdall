import { type Static, Type } from "@sinclair/typebox";
import {
  FindingIdSchema,
  OutcomeIdSchema,
  RepoIdSchema,
  ReviewRunIdSchema,
} from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";

export const FindingOutcomeTypeSchema = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("rejected"),
  Type.Literal("ignored"),
  Type.Literal("resolved"),
  Type.Literal("dismissed"),
  Type.Literal("commented"),
  Type.Literal("positive_reaction"),
  Type.Literal("negative_reaction"),
  Type.Literal("unknown"),
]);
export type FindingOutcomeType = Static<typeof FindingOutcomeTypeSchema>;

export const FindingOutcomeSignalSourceSchema = Type.Union([
  Type.Literal("provider_webhook"),
  Type.Literal("user_action"),
  Type.Literal("commit_analysis"),
  Type.Literal("manual_label"),
  Type.Literal("system_inference"),
]);
export type FindingOutcomeSignalSource = Static<typeof FindingOutcomeSignalSourceSchema>;

export const FindingOutcomeSchema = Type.Object(
  {
    outcomeId: OutcomeIdSchema,
    findingId: FindingIdSchema,
    reviewRunId: ReviewRunIdSchema,
    repoId: RepoIdSchema,
    outcomeType: FindingOutcomeTypeSchema,
    signalSource: FindingOutcomeSignalSourceSchema,
    actorLogin: Type.Optional(Type.String()),
    occurredAt: IsoDateTimeSchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    notes: Type.Optional(Type.String()),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type FindingOutcome = Static<typeof FindingOutcomeSchema>;
