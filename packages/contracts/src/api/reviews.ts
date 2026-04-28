import { Type, type Static } from "@sinclair/typebox";
import { PublishedFindingSchema } from "../review/finding";
import { ReviewRunSchema } from "../review/review-run";
import { ApiSuccessResponseSchema } from "./common";

export const GetReviewRunResponseSchema = ApiSuccessResponseSchema(
  Type.Object({
    reviewRun: ReviewRunSchema,
    findings: Type.Array(PublishedFindingSchema)
  }, { additionalProperties: false })
);
export type GetReviewRunResponse = Static<typeof GetReviewRunResponseSchema>;
