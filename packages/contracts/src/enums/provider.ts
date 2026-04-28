import { Type, type Static } from "@sinclair/typebox";

export const GIT_PROVIDERS = {
  GitHub: "github",
  GitLab: "gitlab",
  Bitbucket: "bitbucket"
} as const;

export const GitProviderSchema = Type.Union([
  Type.Literal(GIT_PROVIDERS.GitHub),
  Type.Literal(GIT_PROVIDERS.GitLab),
  Type.Literal(GIT_PROVIDERS.Bitbucket)
]);
export type GitProvider = Static<typeof GitProviderSchema>;
