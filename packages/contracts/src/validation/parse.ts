import type { Static, TSchema } from "@sinclair/typebox";
import type { ErrorObject, ValidateFunction } from "ajv";
import { ajv } from "./ajv";
import type { ContractValidationError, ValidationIssue } from "../api/errors";

export function validationIssuesFromAjvErrors(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((err) => ({
    path: err.instancePath || "/",
    message: err.message ?? "Invalid value",
    keyword: err.keyword
  }));
}

export function contractValidationError(
  schemaName: string,
  errors: ErrorObject[] | null | undefined
): ContractValidationError {
  return {
    code: "contract.validation_failed",
    message: `Input failed schema validation: ${schemaName}`,
    schemaName,
    issues: validationIssuesFromAjvErrors(errors)
  };
}

export function compileSchema<T extends TSchema>(schema: T): ValidateFunction<Static<T>> {
  return ajv.compile(schema);
}

export function parseWithSchema<T extends TSchema>(
  schemaName: string,
  schema: T,
  input: unknown
): Static<T> {
  const validate = compileSchema(schema);
  if (!validate(input)) {
    throw contractValidationError(schemaName, validate.errors);
  }

  return input as Static<T>;
}

export function safeParseWithSchema<T extends TSchema>(
  schemaName: string,
  schema: T,
  input: unknown
): { ok: true; value: Static<T> } | { ok: false; error: ContractValidationError } {
  try {
    return { ok: true, value: parseWithSchema(schemaName, schema, input) };
  } catch (error) {
    return { ok: false, error: error as ContractValidationError };
  }
}
