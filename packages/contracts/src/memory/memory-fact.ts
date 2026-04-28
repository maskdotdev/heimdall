import { type Static, Type } from "@sinclair/typebox";
import { FindingIdSchema, MemoryFactIdSchema, OrgIdSchema, RepoIdSchema } from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";

export const MemoryFactKindSchema = Type.Union([
  Type.Literal("repo_convention"),
  Type.Literal("suppression"),
  Type.Literal("architecture_note"),
  Type.Literal("review_preference"),
  Type.Literal("domain_context"),
  Type.Literal("tooling_note"),
  Type.Literal("other"),
]);
export type MemoryFactKind = Static<typeof MemoryFactKindSchema>;

export const MemoryFactSourceSchema = Type.Union([
  Type.Literal("explicit_rule"),
  Type.Literal("feedback"),
  Type.Literal("comment_thread"),
  Type.Literal("manual"),
  Type.Literal("system"),
]);
export type MemoryFactSource = Static<typeof MemoryFactSourceSchema>;

export const MemoryFactStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("disabled"),
  Type.Literal("expired"),
]);
export type MemoryFactStatus = Static<typeof MemoryFactStatusSchema>;

export const MemoryFactSchema = Type.Object(
  {
    memoryFactId: MemoryFactIdSchema,
    orgId: OrgIdSchema,
    repoId: Type.Optional(RepoIdSchema),
    kind: MemoryFactKindSchema,
    subject: Type.String({ minLength: 1, maxLength: 300 }),
    body: Type.String({ minLength: 1, maxLength: 4000 }),
    source: MemoryFactSourceSchema,
    sourceFindingId: Type.Optional(FindingIdSchema),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    status: MemoryFactStatusSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    expiresAt: Type.Optional(IsoDateTimeSchema),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type MemoryFact = Static<typeof MemoryFactSchema>;
