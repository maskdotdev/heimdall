import { Type, type Static } from "@sinclair/typebox";

export const SymbolKindSchema = Type.Union([
  Type.Literal("module"),
  Type.Literal("namespace"),
  Type.Literal("class"),
  Type.Literal("interface"),
  Type.Literal("type"),
  Type.Literal("enum"),
  Type.Literal("function"),
  Type.Literal("method"),
  Type.Literal("constructor"),
  Type.Literal("property"),
  Type.Literal("variable"),
  Type.Literal("constant"),
  Type.Literal("route"),
  Type.Literal("component"),
  Type.Literal("hook"),
  Type.Literal("unknown")
]);
export type SymbolKind = Static<typeof SymbolKindSchema>;

export const CodeEdgeKindSchema = Type.Union([
  Type.Literal("imports"),
  Type.Literal("exports"),
  Type.Literal("calls"),
  Type.Literal("references"),
  Type.Literal("defines"),
  Type.Literal("extends"),
  Type.Literal("implements"),
  Type.Literal("tests"),
  Type.Literal("configures"),
  Type.Literal("routes_to"),
  Type.Literal("reads"),
  Type.Literal("writes"),
  Type.Literal("uses_type"),
  Type.Literal("unknown")
]);
export type CodeEdgeKind = Static<typeof CodeEdgeKindSchema>;

export const ChangeTypeSchema = Type.Union([
  Type.Literal("added"),
  Type.Literal("modified"),
  Type.Literal("deleted"),
  Type.Literal("renamed"),
  Type.Literal("copied"),
  Type.Literal("type_changed"),
  Type.Literal("unchanged")
]);
export type ChangeType = Static<typeof ChangeTypeSchema>;
