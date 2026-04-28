import { type Static, Type } from "@sinclair/typebox";
import { UsageEventTypeSchema } from "../enums/usage";
import {
  OrgIdSchema,
  RepoIdSchema,
  ReviewRunIdSchema,
  UsageEventIdSchema,
} from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";

export const UsageEventSchema = Type.Object(
  {
    usageEventId: UsageEventIdSchema,
    orgId: OrgIdSchema,
    repoId: Type.Optional(RepoIdSchema),
    reviewRunId: Type.Optional(ReviewRunIdSchema),
    eventType: UsageEventTypeSchema,
    quantity: Type.Number({ minimum: 0 }),
    unit: Type.String(),
    costMicros: Type.Optional(Type.Integer({ minimum: 0 })),
    occurredAt: IsoDateTimeSchema,
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type UsageEvent = Static<typeof UsageEventSchema>;
