import type { PlanStep } from "../../../models";
import type { GestureEvent } from "./types";

const ERASER_REPLAY_WARNING =
  "a pen gesture made with the eraser end was exported as an eraser step; replay injects an eraser only on a root adb shell with a uinput tool and refuses that step elsewhere";

const PEN_PATH_UNKNOWN_WARNING =
  "a pen gesture without a known position or path was not exported: replaying it as a finger would be wrong";

const HOVER_DROPPED_WARNING =
  "a pen hovered over the screen without touching it; hover is not recorded, so nothing was exported for it";

const STYLUS_DOUBLE_TAP_WARNING =
  "a stylus double tap was exported, but replay refuses stylus double taps, so that step will fail when run";

/**
 * The stop-result warning for a pen gesture the exported plan may not reproduce, or undefined when
 * it exports cleanly (or is not a pen gesture): one that produced no step (no known position or
 * path), a stylus double tap, which replay refuses, or an eraser step, which replays only where an
 * eraser can be injected.
 */
export function exportLossWarning(
  gesture: GestureEvent,
  step: PlanStep | null | undefined,
): string | undefined {
  if (gesture.toolType === undefined) {
    return undefined;
  }
  if (gesture.type === "hover") {
    return HOVER_DROPPED_WARNING;
  }
  if (!step) {
    return PEN_PATH_UNKNOWN_WARNING;
  }
  if (step.params.pointer !== undefined && step.params.action === "doubleTap") {
    return STYLUS_DOUBLE_TAP_WARNING;
  }
  return gesture.toolType === "eraser" ? ERASER_REPLAY_WARNING : undefined;
}

/** Adds the warning for a pen gesture the plan cannot reproduce, if there is one, to `warnings`. */
export function noteExportLoss(
  warnings: Set<string>,
  gesture: GestureEvent,
  step: PlanStep | null | undefined,
): void {
  const warning = exportLossWarning(gesture, step);
  if (warning) {
    warnings.add(warning);
  }
}
