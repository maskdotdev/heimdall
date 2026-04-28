import { type Static, Type } from "@sinclair/typebox";
import { ContractErrorSchema } from "../api/errors";
import { ReviewRunStatusSchema, ReviewTriggerSchema } from "../enums/review";
import { PullRequestSnapshotIdSchema, RepoIdSchema, ReviewRunIdSchema } from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";
import { GitCommitShaSchema } from "../pull-request/pull-request";
import { ReviewArtifactRefSchema } from "./artifacts";

export const ReviewRunSchema = Type.Object(
  {
    reviewRunId: ReviewRunIdSchema,
    schemaVersion: Type.Literal("review_run.v1"),
    repoId: RepoIdSchema,
    pullRequestSnapshotId: PullRequestSnapshotIdSchema,
    pullRequestNumber: Type.Integer({ minimum: 1 }),
    baseSha: GitCommitShaSchema,
    headSha: GitCommitShaSchema,
    trigger: ReviewTriggerSchema,
    status: ReviewRunStatusSchema,
    startedAt: Type.Optional(IsoDateTimeSchema),
    completedAt: Type.Optional(IsoDateTimeSchema),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    summary: Type.Optional(Type.String()),
    artifactRefs: Type.Array(ReviewArtifactRefSchema),
    counts: Type.Object(
      {
        candidateFindings: Type.Integer({ minimum: 0 }),
        validatedFindings: Type.Integer({ minimum: 0 }),
        publishedFindings: Type.Integer({ minimum: 0 }),
        rejectedFindings: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    error: Type.Optional(ContractErrorSchema),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type ReviewRun = Static<typeof ReviewRunSchema>;
