import { type Static, Type } from "@sinclair/typebox";

export const RepositoryVisibilitySchema = Type.Union([
  Type.Literal("public"),
  Type.Literal("private"),
  Type.Literal("internal"),
  Type.Literal("unknown"),
]);
export type RepositoryVisibility = Static<typeof RepositoryVisibilitySchema>;
