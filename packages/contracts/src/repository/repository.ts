import { type Static, Type } from "@sinclair/typebox";
import { GitProviderSchema } from "../enums/provider";
import { RepositoryVisibilitySchema } from "../enums/repository";
import { InstallationIdSchema, OrgIdSchema, RepoIdSchema } from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";

export const RepositorySchema = Type.Object(
  {
    repoId: RepoIdSchema,
    orgId: OrgIdSchema,
    installationId: InstallationIdSchema,
    provider: GitProviderSchema,
    providerRepoId: Type.String(),
    owner: Type.String(),
    name: Type.String(),
    fullName: Type.String(),
    defaultBranch: Type.Optional(Type.String()),
    cloneUrl: Type.Optional(Type.String({ format: "uri" })),
    visibility: RepositoryVisibilitySchema,
    isArchived: Type.Boolean(),
    isFork: Type.Boolean(),
    enabled: Type.Boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type Repository = Static<typeof RepositorySchema>;
