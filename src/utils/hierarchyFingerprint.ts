import type { ViewHierarchyResult } from "../models";
import { NodeCryptoService } from "./crypto";
import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import { STATUS_BAR_ROOT_IDS } from "./androidStatusBar";

/**
 * Node attribute naming the iOS SDK bridge capture a node came from (#5159). It changes with every
 * capture of an unchanged screen, so change detection and settling ignore it.
 */
export const SDK_CAPTURE_IDENTITY_ATTRIBUTE = "sdk-capture-identity";

/**
 * `JSON.stringify` replacer that omits status-bar subtrees and the per-capture SDK bridge identity;
 * other nodes serialize unchanged.
 */
function omitStatusBar(key: string, value: unknown): unknown {
  if (key === SDK_CAPTURE_IDENTITY_ATTRIBUTE) {
    return undefined;
  }
  // The root itself is never dropped: a replacer result of undefined there is no serialization.
  if (key !== "" && typeof value === "object" && value !== null && "resource-id" in value) {
    const resourceId = value["resource-id"];
    if (typeof resourceId === "string" && STATUS_BAR_ROOT_IDS.has(resourceId)) {
      return undefined;
    }
  }
  return value;
}

/**
 * The single definition of "did the screen change?" (issues #6435, #6477).
 *
 * Fingerprints only the structural tree (`viewHierarchy.hierarchy`), without the status bar. Per-capture
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
      fingerprint = hash(JSON.stringify(viewHierarchy.hierarchy, omitStatusBar));
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
