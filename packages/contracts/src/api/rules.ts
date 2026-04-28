import { type Static, Type } from "@sinclair/typebox";
import { RepoRuleSchema } from "../memory/repo-rule";
import { ApiSuccessResponseSchema } from "./common";

export const ListRepoRulesResponseSchema = ApiSuccessResponseSchema(
  Type.Object(
    {
      rules: Type.Array(RepoRuleSchema),
    },
    { additionalProperties: false },
  ),
);
export type ListRepoRulesResponse = Static<typeof ListRepoRulesResponseSchema>;
