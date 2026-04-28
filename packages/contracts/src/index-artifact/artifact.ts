import { Type, type Static } from "@sinclair/typebox";
import { ContractErrorSchema } from "../api/errors";
import { Sha256Schema } from "../primitives/hashes";
import { IndexVersionIdSchema, RepoIdSchema } from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";
import { GitCommitShaSchema } from "../pull-request/pull-request";

export const CodeIndexVersionStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("importing"),
  Type.Literal("embedding"),
  Type.Literal("ready"),
  Type.Literal("failed")
]);
export type CodeIndexVersionStatus = Static<typeof CodeIndexVersionStatusSchema>;

export const CodeIndexVersionSchema = Type.Object({
  indexVersionId: IndexVersionIdSchema,
  repoId: RepoIdSchema,
  commitSha: GitCommitShaSchema,
  status: CodeIndexVersionStatusSchema,
  artifactUri: Type.String(),
  artifactHash: Type.Optional(Sha256Schema),
  indexerName: Type.String(),
  indexerVersion: Type.String(),
  chunkerVersion: Type.String(),
  fileCount: Type.Integer({ minimum: 0 }),
  symbolCount: Type.Integer({ minimum: 0 }),
  edgeCount: Type.Integer({ minimum: 0 }),
  chunkCount: Type.Integer({ minimum: 0 }),
  embeddedChunkCount: Type.Integer({ minimum: 0 }),
  createdAt: IsoDateTimeSchema,
  completedAt: Type.Optional(IsoDateTimeSchema),
  error: Type.Optional(ContractErrorSchema)
}, { additionalProperties: false });
export type CodeIndexVersion = Static<typeof CodeIndexVersionSchema>;
