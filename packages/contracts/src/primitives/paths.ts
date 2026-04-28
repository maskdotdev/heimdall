import { type Static, Type } from "@sinclair/typebox";

export const RepoPathSchema = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: "^(?!/)(?!.*\\.\\./)(?!.*\\\\).+$",
});
export type RepoPath = Static<typeof RepoPathSchema>;
