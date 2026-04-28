import { Type, type Static } from "@sinclair/typebox";
import { ChangeTypeSchema, SymbolKindSchema } from "../enums/index";
import { CodeLanguageSchema } from "../enums/language";
import { FileIdSchema, SymbolIdSchema } from "../primitives/ids";
import { RepoPathSchema } from "../primitives/paths";
import { LineRangeSchema } from "../primitives/ranges";

export const ChangedSymbolSchema = Type.Object({
  symbolId: Type.Optional(SymbolIdSchema),
  fileId: Type.Optional(FileIdSchema),
  path: RepoPathSchema,
  name: Type.Optional(Type.String()),
  qualifiedName: Type.Optional(Type.String()),
  kind: Type.Optional(SymbolKindSchema),
  language: CodeLanguageSchema,
  changeType: ChangeTypeSchema,
  oldRange: Type.Optional(LineRangeSchema),
  newRange: Type.Optional(LineRangeSchema),
  diffHunkIds: Type.Array(Type.String()),
  patch: Type.Optional(Type.String()),
  confidence: Type.Number({ minimum: 0, maximum: 1 })
}, { additionalProperties: false });
export type ChangedSymbol = Static<typeof ChangedSymbolSchema>;
