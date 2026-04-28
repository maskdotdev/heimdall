import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { IsoDateTimeSchema } from "../primitives/time";

export const JobEnvelopeSchema = <T extends TSchema>(payloadSchema: T) =>
  Type.Object(
    {
      jobId: Type.String({ pattern: "^job_[A-Za-z0-9_-]+$" }),
      jobType: Type.String(),
      schemaVersion: Type.String(),
      idempotencyKey: Type.String(),
      traceId: Type.Optional(Type.String()),
      createdAt: IsoDateTimeSchema,
      scheduledFor: Type.Optional(IsoDateTimeSchema),
      attempt: Type.Integer({ minimum: 0 }),
      maxAttempts: Type.Integer({ minimum: 1 }),
      payload: payloadSchema,
    },
    { additionalProperties: false },
  );

export type JobEnvelope<TPayload> = Static<ReturnType<typeof JobEnvelopeSchema<TSchema>>> & {
  payload: TPayload;
};
