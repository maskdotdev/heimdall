import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { IsoDateTimeSchema } from "../primitives/time";

/** Trace context carried by durable jobs across request and worker boundaries. */
export const JobTraceContextSchema = Type.Object(
  {
    /** Parent durable event ID used to link request-triggered work. */
    parentEventId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    /** Product-safe request ID used in logs, audits, and support flows. */
    requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    /** W3C traceparent value used by OpenTelemetry-compatible propagation. */
    traceparent: Type.Optional(
      Type.String({
        maxLength: 55,
        minLength: 55,
        pattern: "^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$",
      }),
    ),
    /** W3C tracestate value used by OpenTelemetry-compatible propagation. */
    tracestate: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);

/** Trace context carried by durable jobs across request and worker boundaries. */
export type JobTraceContext = Static<typeof JobTraceContextSchema>;

/** Creates a durable job envelope schema for a specific payload schema. */
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
      traceContext: Type.Optional(JobTraceContextSchema),
    },
    { additionalProperties: false },
  );

/** Durable job envelope persisted in the outbox and delivered to workers. */
export type JobEnvelope<TPayload> = Static<ReturnType<typeof JobEnvelopeSchema<TSchema>>> & {
  /** Typed job payload for the handler registered to the envelope job type. */
  payload: TPayload;
};
