import { type Static, Type } from "@sinclair/typebox";

export const LineRangeSchema = Type.Object(
  {
    startLine: Type.Integer({ minimum: 1 }),
    endLine: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type LineRange = Static<typeof LineRangeSchema>;
