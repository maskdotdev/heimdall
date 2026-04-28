import { Type, type Static } from "@sinclair/typebox";
import { GitProviderSchema } from "../enums/provider";
import { Sha256Schema } from "../primitives/hashes";
import {
  InstallationIdSchema,
  PullRequestSnapshotIdSchema,
  RepoIdSchema
} from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";
import { ChangedFileSchema } from "./diff";

export const PullRequestStateSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("closed"),
  Type.Literal("merged"),
  Type.Literal("unknown")
]);
export type PullRequestState = Static<typeof PullRequestStateSchema>;

export const GitCommitShaSchema = Type.String({ minLength: 7, maxLength: 64 });
export type GitCommitSha = Static<typeof GitCommitShaSchema>;

export const PullRequestSnapshotSchema = Type.Object({
  snapshotId: PullRequestSnapshotIdSchema,
  schemaVersion: Type.Literal("pull_request_snapshot.v1"),
  provider: GitProviderSchema,
  repoId: RepoIdSchema,
  installationId: InstallationIdSchema,
  providerRepoId: Type.String(),
  providerPullRequestId: Type.String(),
  pullRequestNumber: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  body: Type.Optional(Type.String()),
  authorLogin: Type.String(),
  authorAssociation: Type.Optional(Type.String()),
  state: PullRequestStateSchema,
  isDraft: Type.Boolean(),
  labels: Type.Array(Type.String()),
  baseRef: Type.String(),
  baseSha: GitCommitShaSchema,
  headRef: Type.String(),
  headSha: GitCommitShaSchema,
  mergeBaseSha: Type.Optional(GitCommitShaSchema),
  changedFiles: Type.Array(ChangedFileSchema),
  diffHash: Sha256Schema,
  additions: Type.Integer({ minimum: 0 }),
  deletions: Type.Integer({ minimum: 0 }),
  changedFileCount: Type.Integer({ minimum: 0 }),
  fetchedAt: IsoDateTimeSchema,
  providerMetadata: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
}, { additionalProperties: false });
export type PullRequestSnapshot = Static<typeof PullRequestSnapshotSchema>;
