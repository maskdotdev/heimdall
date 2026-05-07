import { type Static, Type } from "@sinclair/typebox";
import { RepoIdSchema } from "../primitives/ids";
import { RepoPathSchema } from "../primitives/paths";
import { LineRangeSchema } from "../primitives/ranges";
import { IsoDateTimeSchema } from "../primitives/time";
import { FileChangeStatusSchema } from "./diff";
import { GitCommitShaSchema } from "./pull-request";

/** Side of a pull request diff represented by a changed range. */
export const ChangeSetSideSchema = Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]);
export type ChangeSetSide = Static<typeof ChangeSetSideSchema>;

/** Kind of contiguous changed range extracted from a parsed diff hunk. */
export const ChangedRangeKindSchema = Type.Union([Type.Literal("added"), Type.Literal("deleted")]);
export type ChangedRangeKind = Static<typeof ChangedRangeKindSchema>;

/** Contiguous same-side range of added or deleted lines in a single diff hunk. */
export const ChangedRangeSchema = Type.Object(
  {
    hunkId: Type.String(),
    side: ChangeSetSideSchema,
    startLine: Type.Integer({ minimum: 1 }),
    endLine: Type.Integer({ minimum: 1 }),
    kind: ChangedRangeKindSchema,
  },
  { additionalProperties: false },
);
export type ChangedRange = Static<typeof ChangedRangeSchema>;

/** Added and deleted line group that represents a replacement inside one hunk. */
export const ModifiedBlockSchema = Type.Object(
  {
    hunkId: Type.String(),
    oldRange: Type.Optional(LineRangeSchema),
    newRange: Type.Optional(LineRangeSchema),
    deletedLines: Type.Array(Type.String()),
    addedLines: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type ModifiedBlock = Static<typeof ModifiedBlockSchema>;

/** Per-file changed ranges and metadata derived from parsed pull request diffs. */
export const ChangedFileChangeSetSchema = Type.Object(
  {
    path: RepoPathSchema,
    oldPath: Type.Optional(RepoPathSchema),
    status: FileChangeStatusSchema,
    hunkIds: Type.Array(Type.String()),
    changedRanges: Type.Array(ChangedRangeSchema),
    addedRanges: Type.Array(ChangedRangeSchema),
    deletedRanges: Type.Array(ChangedRangeSchema),
    modifiedBlocks: Type.Array(ModifiedBlockSchema),
    hasInlineCommentableLines: Type.Boolean(),
    hasOnlyMetadataChanges: Type.Boolean(),
    isBinary: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ChangedFileChangeSet = Static<typeof ChangedFileChangeSetSchema>;

/** Old and new path pair for a renamed file in a pull request change set. */
export const RenamedPathPairSchema = Type.Object(
  {
    oldPath: RepoPathSchema,
    newPath: RepoPathSchema,
  },
  { additionalProperties: false },
);
export type RenamedPathPair = Static<typeof RenamedPathPairSchema>;

/** Deterministic summary of changed files, ranges, and rename metadata for retrieval. */
export const ChangeSetSchema = Type.Object(
  {
    schemaVersion: Type.Literal("change_set.v1"),
    repoId: Type.Optional(RepoIdSchema),
    pullRequestNumber: Type.Optional(Type.Integer({ minimum: 1 })),
    baseSha: Type.Optional(GitCommitShaSchema),
    headSha: Type.Optional(GitCommitShaSchema),
    mergeBaseSha: Type.Optional(GitCommitShaSchema),
    files: Type.Array(ChangedFileChangeSetSchema),
    totalAddedLines: Type.Integer({ minimum: 0 }),
    totalDeletedLines: Type.Integer({ minimum: 0 }),
    totalContextLines: Type.Integer({ minimum: 0 }),
    changedPathSet: Type.Array(RepoPathSchema),
    deletedPathSet: Type.Array(RepoPathSchema),
    addedPathSet: Type.Array(RepoPathSchema),
    renamedPathPairs: Type.Array(RenamedPathPairSchema),
    createdAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type ChangeSet = Static<typeof ChangeSetSchema>;
