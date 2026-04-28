import { type Static, type TSchema, Type } from "@sinclair/typebox";

export const PageRequestSchema = Type.Object(
  {
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
export type PageRequest = Static<typeof PageRequestSchema>;

export const PageInfoSchema = Type.Object(
  {
    nextCursor: Type.Optional(Type.String()),
    hasNextPage: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type PageInfo = Static<typeof PageInfoSchema>;

export const PaginatedResponseSchema = <T extends TSchema>(itemSchema: T) =>
  Type.Object(
    {
      items: Type.Array(itemSchema),
      pageInfo: PageInfoSchema,
    },
    { additionalProperties: false },
  );
