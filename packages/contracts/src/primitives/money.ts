import { Type, type Static } from "@sinclair/typebox";

export const CostMicrosSchema = Type.Integer({ minimum: 0 });
export type CostMicros = Static<typeof CostMicrosSchema>;

export const MICROS_PER_DOLLAR = 1_000_000;
