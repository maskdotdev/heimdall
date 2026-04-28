import { Type, type Static } from "@sinclair/typebox";
import { GitProviderSchema } from "../enums/provider";
import { InstallationIdSchema, OrgIdSchema } from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";

export const ProviderAccountTypeSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("organization"),
  Type.Literal("group"),
  Type.Literal("unknown")
]);
export type ProviderAccountType = Static<typeof ProviderAccountTypeSchema>;

export const ProviderInstallationSchema = Type.Object({
  installationId: InstallationIdSchema,
  orgId: OrgIdSchema,
  provider: GitProviderSchema,
  providerInstallationId: Type.String(),
  accountLogin: Type.String(),
  accountType: ProviderAccountTypeSchema,
  permissions: Type.Record(Type.String(), Type.Unknown()),
  installedAt: IsoDateTimeSchema,
  suspendedAt: Type.Optional(IsoDateTimeSchema),
  deletedAt: Type.Optional(IsoDateTimeSchema),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
}, { additionalProperties: false });
export type ProviderInstallation = Static<typeof ProviderInstallationSchema>;
