import { type Static, Type } from "@sinclair/typebox";
import { OrgIdSchema, QuotaCounterIdSchema, QuotaReservationIdSchema } from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";

/** Durable quota reservation lifecycle states. */
export const QuotaReservationStatusSchema = Type.Union([
  Type.Literal("reserved"),
  Type.Literal("consumed"),
  Type.Literal("released"),
  Type.Literal("expired"),
  Type.Literal("cancelled"),
]);
export type QuotaReservationStatus = Static<typeof QuotaReservationStatusSchema>;

/** Fast counter state for one org, quota key, and billing period. */
export const QuotaCounterSchema = Type.Object(
  {
    quotaCounterId: QuotaCounterIdSchema,
    orgId: OrgIdSchema,
    quotaKey: Type.String({ minLength: 1 }),
    periodKey: Type.String({ minLength: 1 }),
    periodStart: IsoDateTimeSchema,
    periodEnd: IsoDateTimeSchema,
    usedQuantity: Type.Integer({ minimum: 0 }),
    reservedQuantity: Type.Integer({ minimum: 0 }),
    limitQuantity: Type.Optional(Type.Integer({ minimum: 0 })),
    source: Type.String({ minLength: 1 }),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type QuotaCounter = Static<typeof QuotaCounterSchema>;

/** Durable reservation preventing concurrent workers from exceeding one quota counter. */
export const QuotaReservationSchema = Type.Object(
  {
    quotaReservationId: QuotaReservationIdSchema,
    orgId: OrgIdSchema,
    quotaCounterId: QuotaCounterIdSchema,
    sourceType: Type.String({ minLength: 1 }),
    sourceId: Type.String({ minLength: 1 }),
    quantity: Type.Integer({ minimum: 1 }),
    status: QuotaReservationStatusSchema,
    expiresAt: IsoDateTimeSchema,
    consumedAt: Type.Optional(IsoDateTimeSchema),
    releasedAt: Type.Optional(IsoDateTimeSchema),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type QuotaReservation = Static<typeof QuotaReservationSchema>;
