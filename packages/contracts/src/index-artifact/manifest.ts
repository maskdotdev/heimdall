import { Type, type Static } from "@sinclair/typebox";
import { CodeLanguageSchema } from "../enums/language";
import { Sha256Schema } from "../primitives/hashes";
import { ArtifactIdSchema, IndexVersionIdSchema, RepoIdSchema } from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";
import { GitCommitShaSchema } from "../pull-request/pull-request";

export const IndexManifestSchema = Type.Object({
  schemaVersion: Type.Literal("index_manifest.v1"),
  artifactId: ArtifactIdSchema,
  repoId: RepoIdSchema,
  commitSha: GitCommitShaSchema,
  indexerName: Type.String(),
  indexerVersion: Type.String(),
  chunkerVersion: Type.String(),
  generatedAt: IsoDateTimeSchema,
  languages: Type.Array(CodeLanguageSchema),
  recordCount: Type.Integer({ minimum: 0 }),
  fileCount: Type.Integer({ minimum: 0 }),
  symbolCount: Type.Integer({ minimum: 0 }),
  edgeCount: Type.Integer({ minimum: 0 }),
  chunkCount: Type.Integer({ minimum: 0 }),
  parserVersions: Type.Record(Type.String(), Type.String()),
  previousIndexId: Type.Optional(IndexVersionIdSchema),
  artifactHash: Type.Optional(Sha256Schema),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
}, { additionalProperties: false });
export type IndexManifest = Static<typeof IndexManifestSchema>;

export function isSupportedIndexManifestVersion(version: string): boolean {
  return version === "index_manifest.v1";
}
