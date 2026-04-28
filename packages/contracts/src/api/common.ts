import { Type, type Static, type TSchema } from "@sinclair/typebox";

export const ApiSuccessResponseSchema = <T extends TSchema>(dataSchema: T) =>
  Type.Object({
    data: dataSchema
  }, { additionalProperties: false });

export type ApiSuccessResponse<T> = { data: T };

export const EmptyResponseDataSchema = Type.Object({}, { additionalProperties: false });
export type EmptyResponseData = Static<typeof EmptyResponseDataSchema>;
