/**
 * The truncation-reason vocabulary shared by the producer (`ViewHierarchy`) and
 * the consumers that judge a capture's fidelity (`PerformanceAuditor`).
 *
 * Two different things travel on `viewHierarchy.truncationReasons`:
 *
 * - CAPTURE-FIDELITY reasons (`max_nodes`, `max_depth`, `cancelled`): the device
 *   stopped emitting nodes mid-walk, so the tree itself is PARTIAL and anything
 *   derived from it may be missing a real element.
 * - HOST OUTPUT caps (`max_children[...]`, issue #6601): the device emitted
 *   everything and the uncapped tree is still attached as the raw carrier
 *   (`attachRawViewHierarchy`); only the RENDERED payload was trimmed.
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

/** Whether this reason describes host-side output trimming rather than a partial capture. */
export function isHostOutputTruncationReason(reason: string): boolean {
  return reason.startsWith(HOST_OUTPUT_CHILD_CAP_REASON_PREFIX);
}

/** The subset of `reasons` that means the underlying capture itself is incomplete. */
export function captureFidelityTruncationReasons(reasons: readonly string[] | undefined): string[] {
  return (reasons ?? []).filter((reason) => !isHostOutputTruncationReason(reason));
}
