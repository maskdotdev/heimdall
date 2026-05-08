import { type Static, Type } from "@sinclair/typebox";
import {
  DataDeletionRequestIdSchema,
  OrgIdSchema,
  RepoIdSchema,
  UserIdSchema,
} from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";

/** Reasons a customer-data deletion workflow can be requested. */
export const DataDeletionReasonSchema = Type.Union([
  Type.Literal("customer_request"),
  Type.Literal("repo_disabled"),
  Type.Literal("app_uninstalled"),
  Type.Literal("retention_expired"),
  Type.Literal("privacy_request"),
  Type.Literal("incident_response"),
]);
export type DataDeletionReason = Static<typeof DataDeletionReasonSchema>;

/** Resource scopes supported by the data-deletion workflow. */
export const DataDeletionScopeSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("repository"),
  Type.Literal("organization"),
  Type.Literal("review_run"),
  Type.Literal("artifact_class"),
]);
export type DataDeletionScope = Static<typeof DataDeletionScopeSchema>;

/** Durable lifecycle states for a data-deletion request. */
export const DataDeletionStatusSchema = Type.Union([
  Type.Literal("requested"),
  Type.Literal("planned"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("verified"),
]);
export type DataDeletionStatus = Static<typeof DataDeletionStatusSchema>;

/** One database table estimate included in a deletion manifest. */
export const DataDeletionManifestTableSchema = Type.Object(
  {
    predicateDescription: Type.String({ minLength: 1 }),
    rowCountEstimate: Type.Integer({ minimum: 0 }),
    table: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type DataDeletionManifestTable = Static<typeof DataDeletionManifestTableSchema>;

/** One external provider action included in a deletion manifest. */
export const DataDeletionManifestExternalProviderSchema = Type.Object(
  {
    action: Type.String({ minLength: 1 }),
    provider: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type DataDeletionManifestExternalProvider = Static<
  typeof DataDeletionManifestExternalProviderSchema
>;

/** Product-safe manifest for a requested data-deletion workflow. */
export const DataDeletionManifestSchema = Type.Object(
  {
    dbTables: Type.Array(DataDeletionManifestTableSchema),
    externalProviders: Type.Array(DataDeletionManifestExternalProviderSchema),
    objectKeys: Type.Array(Type.String({ minLength: 1 })),
    queueKeys: Type.Array(Type.String({ minLength: 1 })),
    requestId: DataDeletionRequestIdSchema,
    vectorNamespaces: Type.Array(Type.String({ minLength: 1 })),
    orgId: Type.Optional(OrgIdSchema),
    repoId: Type.Optional(RepoIdSchema),
    userId: Type.Optional(UserIdSchema),
  },
  { additionalProperties: false },
);
export type DataDeletionManifest = Static<typeof DataDeletionManifestSchema>;

/** Durable request record for customer-data deletion workflows. */
export const DataDeletionRequestSchema = Type.Object(
  {
    dataDeletionRequestId: DataDeletionRequestIdSchema,
    reason: DataDeletionReasonSchema,
    requestedAt: IsoDateTimeSchema,
    requestedBy: Type.String({ minLength: 1 }),
    scope: DataDeletionScopeSchema,
    status: DataDeletionStatusSchema,
    completedAt: Type.Optional(IsoDateTimeSchema),
    manifest: Type.Optional(DataDeletionManifestSchema),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    orgId: Type.Optional(OrgIdSchema),
    repoId: Type.Optional(RepoIdSchema),
    userId: Type.Optional(UserIdSchema),
    verificationArtifactUri: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type DataDeletionRequest = Static<typeof DataDeletionRequestSchema>;
