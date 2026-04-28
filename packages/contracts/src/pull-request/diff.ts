import { Type, type Static } from "@sinclair/typebox";
import { CodeLanguageSchema } from "../enums/language";
import { ContentHashSchema } from "../primitives/hashes";
import { RepoPathSchema } from "../primitives/paths";

export const DiffLineKindSchema = Type.Union([
  Type.Literal("context"),
  Type.Literal("addition"),
  Type.Literal("deletion")
]);
export type DiffLineKind = Static<typeof DiffLineKindSchema>;

export const DiffLineSchema = Type.Object({
  kind: DiffLineKindSchema,
  content: Type.String(),
  oldLine: Type.Optional(Type.Integer({ minimum: 1 })),
  newLine: Type.Optional(Type.Integer({ minimum: 1 }))
}, { additionalProperties: false });
export type DiffLine = Static<typeof DiffLineSchema>;

export const DiffHunkSchema = Type.Object({
  hunkId: Type.String(),
  header: Type.String(),
  oldStart: Type.Integer({ minimum: 0 }),
  oldLines: Type.Integer({ minimum: 0 }),
  newStart: Type.Integer({ minimum: 0 }),
  newLines: Type.Integer({ minimum: 0 }),
  lines: Type.Array(DiffLineSchema)
}, { additionalProperties: false });
export type DiffHunk = Static<typeof DiffHunkSchema>;

export const FileChangeStatusSchema = Type.Union([
  Type.Literal("added"),
  Type.Literal("modified"),
  Type.Literal("deleted"),
  Type.Literal("renamed"),
  Type.Literal("copied"),
  Type.Literal("type_changed"),
  Type.Literal("unchanged")
]);
export type FileChangeStatus = Static<typeof FileChangeStatusSchema>;

export const ChangedFileSchema = Type.Object({
  path: RepoPathSchema,
  oldPath: Type.Optional(RepoPathSchema),
  status: FileChangeStatusSchema,
  language: CodeLanguageSchema,
  additions: Type.Integer({ minimum: 0 }),
  deletions: Type.Integer({ minimum: 0 }),
  changes: Type.Integer({ minimum: 0 }),
  isBinary: Type.Boolean(),
  isGenerated: Type.Boolean(),
  isTest: Type.Boolean(),
  patch: Type.Optional(Type.String()),
  hunks: Type.Array(DiffHunkSchema),
  oldContentHash: Type.Optional(ContentHashSchema),
  newContentHash: Type.Optional(ContentHashSchema)
}, { additionalProperties: false });
export type ChangedFile = Static<typeof ChangedFileSchema>;
