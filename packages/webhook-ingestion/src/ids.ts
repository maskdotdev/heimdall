import { createHash, randomUUID } from "node:crypto";

/** Computes a contract-compatible SHA-256 content hash. */
export function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** Creates a stable prefixed ID from provider-owned identity parts. */
export function stableId(prefix: string, parts: readonly unknown[]): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26);

  return `${prefix}_${hash}`;
}

/** Creates a non-deterministic prefixed ID. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
