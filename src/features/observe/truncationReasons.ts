import type { ObserveResult } from "../../models/ObserveResult";
import { nodeAttributes, type ViewHierarchyWindowInfo } from "../../models/ViewHierarchyResult";

/**
 * The truncation-reason vocabulary shared by the producer (`ViewHierarchy`) and
 * the consumers that judge a capture's fidelity (`PerformanceAuditor`).
 *
 * Two different things travel on `viewHierarchy.truncationReasons`:
 *
 * - CAPTURE-FIDELITY reasons (`max_nodes`, `max_depth`, `max_children`, `cancelled`):
 *   the device dropped nodes during the walk, so the tree itself is PARTIAL and anything
 *   derived from it may be missing a real element.
 * - HOST OUTPUT caps (`max_children[...]`, issue #6601): only the RENDERED payload
 *   was trimmed; the tree before host trimming is still attached as the raw carrier
 *   (`attachRawViewHierarchy`). This reason alone does not imply device capture loss;
 *   a coexisting capture-fidelity reason can still mark that raw tree as PARTIAL.
 *
 * Both belong on the channel — an agent reading the rendered rows must know they
 * were cut either way — but only the first kind means the capture is unreliable.
 * Conflating them let a host output cap disable touch-latency measurement on a
 * complete capture (#6601 review). A caller asking "is this CAPTURE complete?"
 * goes through {@link captureFidelityTruncationReasons}; a caller asking "were
 * rows dropped from what I am reading?" keeps the full list.
 */

/**
 * Prefix of the per-node child cap `ViewHierarchy.filterViewHierarchy` stamps
 * when it trims a pathological container for the rendered payload.
 */
export const HOST_OUTPUT_CHILD_CAP_REASON_PREFIX = "max_children[";

/** Known device capture codes; newer APK codes remain valid on the wire. */
export const WINDOW_TRUNCATION_REASON_MEANINGS = {
  max_nodes: "This window's share of the node budget was exhausted.",
  max_depth: "The tree was deeper than the depth cap.",
  max_children: "A node had more children than the device's per-node child cap.",
  cancelled: "The capture was cancelled mid-walk.",
} as const;

/** Normalize capture reasons without hiding unknown codes or changing their order. */
export function normalizeWindowTruncationReasons(reasons: unknown): string[] {
  if (!Array.isArray(reasons)) {
    return [];
  }
  return [
    ...new Set(
      reasons.filter(
        (reason): reason is string =>
          typeof reason === "string" && reason.length > 0 && !isHostOutputTruncationReason(reason),
      ),
    ),
  ];
}

/** Attribute capture loss to explicit window IDs and authoritative window/root packages only. */
export function collectWindowTruncations(
  windows: readonly ViewHierarchyWindowInfo[] | null | undefined,
): ObserveResult["windowTruncations"] {
  const entries: NonNullable<ObserveResult["windowTruncations"]> = [];
  for (const window of windows ?? []) {
    const reasons = normalizeWindowTruncationReasons(window.truncationReasons);
    if (window.id === undefined || !Number.isInteger(window.id) || reasons.length === 0) {
      continue;
    }
    const root = window.hierarchy ? nodeAttributes(window.hierarchy) : undefined;
    const packageName = [window.packageName, root?.packageName, root?.package].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    entries.push({
      windowId: window.id,
      ...(packageName ? { package: packageName } : {}),
      reasons,
    });
  }
  return entries.length > 0 ? entries : undefined;
}

/** Whether this reason describes host-side output trimming rather than a partial capture. */
export function isHostOutputTruncationReason(reason: string): boolean {
  return reason.startsWith(HOST_OUTPUT_CHILD_CAP_REASON_PREFIX);
}

/** The subset of `reasons` that means the underlying capture itself is incomplete. */
export function captureFidelityTruncationReasons(reasons: readonly string[] | undefined): string[] {
  return (reasons ?? []).filter((reason) => !isHostOutputTruncationReason(reason));
}
