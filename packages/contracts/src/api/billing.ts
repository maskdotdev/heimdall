import { type Static, Type } from "@sinclair/typebox";
import { OrgIdSchema } from "../primitives/ids";

/** Request body used to create a billing checkout session. */
export const CreateBillingCheckoutSessionRequestSchema = Type.Object(
  {
    orgId: Type.Optional(OrgIdSchema),
    planKey: Type.String({ minLength: 1 }),
    successUrl: Type.String({ minLength: 1 }),
    cancelUrl: Type.String({ minLength: 1 }),
    quantity: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
export type CreateBillingCheckoutSessionRequest = Static<
  typeof CreateBillingCheckoutSessionRequestSchema
>;

/** Request body used to create a billing customer portal session. */
export const CreateBillingPortalSessionRequestSchema = Type.Object(
  {
    orgId: Type.Optional(OrgIdSchema),
    returnUrl: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type CreateBillingPortalSessionRequest = Static<
  typeof CreateBillingPortalSessionRequestSchema
>;
