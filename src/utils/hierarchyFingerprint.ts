import type { ViewHierarchyResult } from "../models";
import { NodeCryptoService } from "./crypto";
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
export const hierarchyFingerprint = (
  viewHierarchy: ViewHierarchyResult | null | undefined,
): string | null => {
  if (!viewHierarchy?.hierarchy) {
    return null;
  }
  try {
    return NodeCryptoService.generateCacheKey(JSON.stringify(viewHierarchy.hierarchy));
  } catch (error) {
    // Fingerprints feed best-effort change detection and cache keys; a malformed
    // hierarchy (e.g. a cycle) must not fail the action, so report "unknown".
    logger.debug(`[hierarchyFingerprint] Failed to fingerprint view hierarchy: ${error}`);
    return null;
  }
};

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
