export const SENSITIVE_FIELD_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /authorization/i,
  /privateKey/i,
  /accessKey/i,
] as const;

export function redactUnknown(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => redactUnknown(item));
  }

  if (!input || typeof input !== "object") {
    return input;
  }

  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(key))
        ? "[REDACTED]"
        : redactUnknown(value),
    ]),
  );
}
