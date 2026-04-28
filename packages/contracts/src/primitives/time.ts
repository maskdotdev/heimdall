import { type Static, Type } from "@sinclair/typebox";

export const IsoDateTimeSchema = Type.String({ format: "date-time" });
export type IsoDateTime = Static<typeof IsoDateTimeSchema>;
