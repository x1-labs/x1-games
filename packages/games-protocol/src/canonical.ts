// Canonical JSON helpers for hash-stable replay storage.
//
// v0 implementation: sorted object keys + minimal whitespace + UTF-8.
// This is the "good-enough" subset; production replays should use a full
// RFC 8785 (JSON Canonicalization Scheme) impl to handle Unicode
// normalization and number-formatting corner cases. The function signature
// won't change when we upgrade.

import { createHash } from "node:crypto";

/** Sort object keys recursively; arrays preserve order. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) sorted[k] = sortKeysDeep(o[k]);
    return sorted;
  }
  return value;
}

/** Canonical JSON: sorted keys, no whitespace, UTF-8. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** Hex SHA-256 of the canonical JSON encoding of `value`, "0x"-prefixed. */
export function canonicalSha256(value: unknown): string {
  return "0x" + createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Hex SHA-256 of arbitrary bytes/string, "0x"-prefixed. */
export function sha256Hex(input: string | Uint8Array): string {
  const h = createHash("sha256");
  if (typeof input === "string") h.update(input, "utf8");
  else h.update(input);
  return "0x" + h.digest("hex");
}
