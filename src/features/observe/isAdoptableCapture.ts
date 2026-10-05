import type { ObserveResult } from "../../models/ObserveResult";
import { hierarchyUpdatedAtToMillis } from "./observeTimestamp";

function hasUsableHierarchy(observation: ObserveResult): boolean {
  const hierarchy = observation.viewHierarchy?.hierarchy;
  return !!hierarchy && typeof hierarchy === "object" && !("error" in hierarchy);
}

/**
 * Whether the settle loop's capture may REPLACE the one the action already
 * holds.
 *
 * A usable, trustworthy capture on the selected panel qualifies, even if the
 * screen never stopped moving: it is at-or-after the action's own
 * frame, so handing it back is closer to the truth than the half-inflated tree
 * #6866 is about. What must never qualify is the loop's LAST-RESORT fallback.
 * `pollObserveUntil` returns `newestTrustworthyObservation ?? observation` on
 * timeout, and when NO poll was admissible that second operand is whatever the
 * final read happened to be — a pre-action cache entry the freshness wait gave
 * up on, or a capture whose freshness `ObserveScreen` retracted (a wrong-window
 * tree, #5867). Adopting one of those would move the client's view BACKWARDS
 * off a capture that is known-good and known-post-action.
 *
 * Explicit selection or a session pin requires the action's resolved panel key;
 * default polling allows the panel identity to be resolved anew, as before.
 * Reject an explicitly-stale capture, and reject one that is not provably
 * at-or-after the action's own device-clock timestamp. When the action's capture
 * carries no device timestamp the loop had no floor to enforce either, so there
 * is nothing to compare and a usable hierarchy is accepted as before.
 */
export function isAdoptableCapture(
  actionObservation: ObserveResult,
  settledObservation: ObserveResult,
  strictDisplay: boolean,
): boolean {
  if (strictDisplay && settledObservation.display?.key !== actionObservation.display?.key) {
    return false;
  }
  if (!hasUsableHierarchy(settledObservation)) {
    return false;
  }
  const freshness = settledObservation.freshness;
  if (freshness?.isFresh === false || freshness?.verified === false) {
    return false;
  }
  const actionMs = hierarchyUpdatedAtToMillis(actionObservation.viewHierarchy);
  if (actionMs === undefined) {
    return true;
  }
  const settledMs = hierarchyUpdatedAtToMillis(settledObservation.viewHierarchy);
  return settledMs !== undefined && settledMs >= actionMs;
}
