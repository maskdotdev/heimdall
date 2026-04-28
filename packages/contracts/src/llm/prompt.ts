import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTimeSchema } from "../primitives/time";
import { LLMOperationSchema } from "./llm-call";

export const PromptVersionSchema = Type.Object(
  {
    promptVersion: Type.String(),
    operation: LLMOperationSchema,
    description: Type.String(),
    createdAt: IsoDateTimeSchema,
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type PromptVersion = Static<typeof PromptVersionSchema>;
