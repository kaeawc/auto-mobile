import type { PlanStep } from "../../../models";
import type { GestureEvent } from "./types";

const ERASER_SKIPPED_WARNING =
  "a pen gesture made with the eraser end was not exported: replay can inject a stylus but not an eraser, and replaying it as a finger or stylus would be wrong";

const PEN_PATH_UNKNOWN_WARNING =
  "a pen gesture without a known position or path was not exported: replaying it as a finger would be wrong";

const STYLUS_DOUBLE_TAP_WARNING =
  "a stylus double tap was exported, but replay refuses stylus double taps, so that step will fail when run";

/**
 * The stop-result warning for a pen gesture the exported plan cannot reproduce, or undefined when
 * it exports cleanly (or is not a pen gesture): one that produced no step (an eraser, or no known
 * position or path), or a stylus double tap, which replay refuses.
 */
export function exportLossWarning(
  gesture: GestureEvent,
  step: PlanStep | null | undefined,
): string | undefined {
  if (gesture.toolType === undefined) {
    return undefined;
  }
  if (!step) {
    return gesture.toolType === "eraser" ? ERASER_SKIPPED_WARNING : PEN_PATH_UNKNOWN_WARNING;
  }
  return step.params.pointer !== undefined && step.params.action === "doubleTap"
    ? STYLUS_DOUBLE_TAP_WARNING
    : undefined;
}
