import { type Static, Type } from "@sinclair/typebox";
import {
  OrgFindingPolicySchema,
  OrgMemoryPolicySchema,
  OrgPublishingPolicySchema,
  OrgReviewTriggerPolicySchema,
  OrgSettingsSchema,
} from "../repository/settings";
import { ApiSuccessResponseSchema } from "./common";

/** Request body for updating organization-wide policy defaults and guardrails. */
export const UpdateOrgSettingsRequestSchema = Type.Partial(
  Type.Object(
    {
      defaultReviewPolicy: OrgSettingsSchema.properties.defaultReviewPolicy,
      defaultTriggerPolicy: Type.Partial(OrgReviewTriggerPolicySchema, {
        additionalProperties: false,
      }),
      defaultFindingPolicy: Type.Partial(OrgFindingPolicySchema, {
        additionalProperties: false,
      }),
      defaultPublishingPolicy: Type.Partial(OrgPublishingPolicySchema, {
        additionalProperties: false,
      }),
      defaultMemoryPolicy: Type.Partial(OrgMemoryPolicySchema, {
        additionalProperties: false,
      }),
      allowedModelProfiles: Type.Array(Type.String({ minLength: 1 })),
      allowRepoLocalConfig: OrgSettingsSchema.properties.allowRepoLocalConfig,
      allowMemorySuppression: OrgSettingsSchema.properties.allowMemorySuppression,
      allowUserDefinedRules: OrgSettingsSchema.properties.allowUserDefinedRules,
    },
    { additionalProperties: false },
  ),
  { additionalProperties: false },
);
/** Request body for updating organization-wide policy defaults and guardrails. */
export type UpdateOrgSettingsRequest = Static<typeof UpdateOrgSettingsRequestSchema>;

/** Response body for organization-wide policy defaults and guardrails. */
export const OrgSettingsResponseSchema = ApiSuccessResponseSchema(
  Type.Object(
    {
      settings: OrgSettingsSchema,
    },
    { additionalProperties: false },
  ),
);
/** Response body for organization-wide policy defaults and guardrails. */
export type OrgSettingsResponse = Static<typeof OrgSettingsResponseSchema>;
