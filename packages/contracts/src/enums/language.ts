import { Type, type Static } from "@sinclair/typebox";

export const CodeLanguageSchema = Type.Union([
  Type.Literal("typescript"),
  Type.Literal("javascript"),
  Type.Literal("tsx"),
  Type.Literal("jsx"),
  Type.Literal("python"),
  Type.Literal("go"),
  Type.Literal("rust"),
  Type.Literal("java"),
  Type.Literal("kotlin"),
  Type.Literal("csharp"),
  Type.Literal("cpp"),
  Type.Literal("c"),
  Type.Literal("ruby"),
  Type.Literal("php"),
  Type.Literal("swift"),
  Type.Literal("unknown")
]);
export type CodeLanguage = Static<typeof CodeLanguageSchema>;
