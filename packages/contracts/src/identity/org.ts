import { type Static, Type } from "@sinclair/typebox";
import { OrgIdSchema } from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";

export const OrgSchema = Type.Object(
  {
    orgId: OrgIdSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    slug: Type.String({ minLength: 1, maxLength: 200 }),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type Org = Static<typeof OrgSchema>;
