import type { ViewHierarchyResult } from "../models";
import { NodeCryptoService } from "./crypto";
import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";

/**
 * The single definition of "did the screen change?" (issues #6435, #6477).
 *
 * Fingerprints only the structural tree (`viewHierarchy.hierarchy`). Per-capture
 * metadata on `ViewHierarchyResult` — `updatedAt`, `receivedAt`, `frameContext`,
 * `fresh`, and the rest — is stamped on every capture, so including it would make
 * two captures of a static screen look different.
 *
 * Returns `null` when there is no tree to fingerprint, or when serialization fails
 * on a malformed hierarchy.
 */
export function createHierarchyFingerprinter(
  hash: (serializedHierarchy: string) => string,
): (viewHierarchy: ViewHierarchyResult | null | undefined) => string | null {
  const fingerprints = new WeakMap<ViewHierarchyResult, string | null>();
  return (viewHierarchy) => {
    if (!viewHierarchy?.hierarchy) {
      return null;
    }
    const cached = fingerprints.get(viewHierarchy);
    if (cached !== undefined) {
      return cached;
    }
    let fingerprint: string | null = null;
    try {
      fingerprint = hash(JSON.stringify(viewHierarchy.hierarchy));
    } catch (error) {
      // Change detection is best-effort: malformed captures report "unknown".
      // Cache that verdict too, after logging the failure once for this object.
      logger.warn(
        `[hierarchyFingerprint] Failed to fingerprint view hierarchy: ${errorMessage(error)}`,
      );
    }
    fingerprints.set(viewHierarchy, fingerprint);
    return fingerprint;
  };
}

// Captures are immutable after publication: structural transforms must return a
// new ViewHierarchyResult. Metadata alone does not participate in the hash.
export const hierarchyFingerprint = createHierarchyFingerprinter((serialized) =>
  NodeCryptoService.generateCacheKey(serialized),
);

/**
 * Whether two captures show a different screen. Returns `null` when either side
 * has no fingerprint, so callers can distinguish "unchanged" from "unknown".
 */
export const hierarchyChanged = (
  before: ViewHierarchyResult | null | undefined,
  after: ViewHierarchyResult | null | undefined,
): boolean | null => {
  const beforeFingerprint = hierarchyFingerprint(before);
  const afterFingerprint = hierarchyFingerprint(after);
  if (beforeFingerprint === null || afterFingerprint === null) {
    return null;
  }
  return beforeFingerprint !== afterFingerprint;
};
