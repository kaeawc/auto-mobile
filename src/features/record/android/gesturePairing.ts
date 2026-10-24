import { GESTURE_THRESHOLDS, type GestureEvent } from "./types";

/** Raw axes were unknown during the contact, so its screen coordinates cannot be trusted. */
export function hasUnknownAxes(gesture: GestureEvent): boolean {
  return Boolean(gesture.unknownAxes?.length);
}

/** A completed tap with a known position, made with the same tool as the double tap. */
function isPairableTap(prior: GestureEvent, gesture: GestureEvent): boolean {
  return (
    prior.type === "tap" &&
    // A stylus tap and a finger tap are different inputs, so they never form one double tap.
    prior.toolType === gesture.toolType &&
    !hasUnknownAxes(prior) &&
    prior.screenX !== undefined &&
    prior.screenY !== undefined
  );
}

/** Whether `gesture` (a doubleTap) is the second half of the earlier tap `prior`. */
export function formsDoubleTap(prior: GestureEvent, gesture: GestureEvent): boolean {
  if (!isPairableTap(prior, gesture)) {
    return false;
  }
  const elapsed = gesture.arrivedAt - prior.arrivedAt;
  const inWindow = elapsed >= 0 && elapsed <= GESTURE_THRESHOLDS.DOUBLE_TAP_MS;
  if (gesture.firstTapArrivedAt !== undefined) {
    return prior.arrivedAt === gesture.firstTapArrivedAt && inWindow;
  }
  // Direct emitter events lack the classifier's correlation time.
  const dx = (gesture.screenX ?? Infinity) - (prior.screenX ?? Infinity);
  const dy = (gesture.screenY ?? Infinity) - (prior.screenY ?? Infinity);
  return inWindow && Math.hypot(dx, dy) <= GESTURE_THRESHOLDS.DOUBLE_TAP_SLOP_DP;
}
