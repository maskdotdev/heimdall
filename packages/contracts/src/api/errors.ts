import { Type, type Static } from "@sinclair/typebox";

export const ContractErrorSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  retryable: Type.Optional(Type.Boolean()),
  details: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
export type ContractError = Static<typeof ContractErrorSchema>;

export const ValidationIssueSchema = Type.Object({
  path: Type.String(),
  message: Type.String(),
  keyword: Type.Optional(Type.String()),
  value: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
export type ValidationIssue = Static<typeof ValidationIssueSchema>;

export const ContractValidationErrorSchema = Type.Object({
  code: Type.Literal("contract.validation_failed"),
  message: Type.String(),
  schemaName: Type.String(),
  issues: Type.Array(ValidationIssueSchema)
}, { additionalProperties: false });
export type ContractValidationError = Static<typeof ContractValidationErrorSchema>;

export const ApiErrorResponseSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    details: Type.Optional(Type.Unknown()),
    requestId: Type.Optional(Type.String())
  }, { additionalProperties: false })
}, { additionalProperties: false });
export type ApiErrorResponse = Static<typeof ApiErrorResponseSchema>;
