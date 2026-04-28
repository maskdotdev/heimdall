import type { ContractError } from "../api/errors";

export type Result<T, E = ContractError> = { ok: true; value: T } | { ok: false; error: E };
