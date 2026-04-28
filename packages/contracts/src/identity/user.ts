import { type Static, Type } from "@sinclair/typebox";
import { UserIdSchema } from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";

export const UserSchema = Type.Object(
  {
    userId: UserIdSchema,
    primaryEmail: Type.Optional(Type.String({ format: "email" })),
    displayName: Type.Optional(Type.String({ maxLength: 200 })),
    avatarUrl: Type.Optional(Type.String({ format: "uri" })),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type User = Static<typeof UserSchema>;
