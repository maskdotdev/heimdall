import { Type, type Static } from "@sinclair/typebox";
import { ContractErrorSchema } from "../api/errors";
import { GitProviderSchema } from "../enums/provider";
import { Sha256Schema } from "../primitives/hashes";
import { InstallationIdSchema, RepoIdSchema, WebhookEventIdSchema } from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";

export const WebhookEventStatusSchema = Type.Union([
  Type.Literal("received"),
  Type.Literal("processing"),
  Type.Literal("processed"),
  Type.Literal("ignored"),
  Type.Literal("failed")
]);
export type WebhookEventStatus = Static<typeof WebhookEventStatusSchema>;

export const WebhookEventSchema = Type.Object({
  webhookEventId: WebhookEventIdSchema,
  provider: GitProviderSchema,
  deliveryId: Type.String(),
  eventName: Type.String(),
  action: Type.Optional(Type.String()),
  installationId: Type.Optional(InstallationIdSchema),
  repoId: Type.Optional(RepoIdSchema),
  payloadHash: Sha256Schema,
  payloadUri: Type.Optional(Type.String()),
  status: WebhookEventStatusSchema,
  receivedAt: IsoDateTimeSchema,
  processedAt: Type.Optional(IsoDateTimeSchema),
  error: Type.Optional(ContractErrorSchema),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
}, { additionalProperties: false });
export type WebhookEvent = Static<typeof WebhookEventSchema>;
