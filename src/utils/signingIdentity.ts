/** A SHA-256 certificate digest as 64 hex characters, optionally colon-separated. */
export const SIGNING_SHA256_PATTERN = /^(?:[0-9a-fA-F]{2}:?){31}[0-9a-fA-F]{2}$/;

/** Canonical form of one digest: 64 lowercase hex characters. */
export function normalizeSigningSha256(digest: string): string {
  return digest.replaceAll(":", "").toLowerCase();
}

/** Canonical form of a signer set: normalized, de-duplicated and sorted. */
export function normalizeSignerSet(digests: readonly string[]): string[] {
  return [...new Set(digests.map(normalizeSigningSha256))].sort();
}

/**
 * Whether two signer sets are the same identity. A package signed by several signers is only
 * matched by the complete set; one shared signer is not enough.
 */
export function signerSetsEqual(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizeSignerSet(left);
  const b = normalizeSignerSet(right);
  return a.length === b.length && a.every((digest, index) => digest === b[index]);
}
