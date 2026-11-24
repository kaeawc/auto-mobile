import { ActionableError } from "../../models/ActionableError";
import type { PressButtonResult } from "../../models";

/** `steps` only counts rotary detents; passing it with another button is a mistake worth refusing. */
export function rejectStepsOnPlainButton(button: string, call: unknown): undefined {
  const steps =
    typeof call === "object" && call !== null ? (call as { steps?: number }).steps : undefined;
  if (steps !== undefined) {
    throw new ActionableError(
      `steps applies to rotary_rotate_cw and rotary_rotate_ccw only, not ${button}.`,
    );
  }
  return undefined;
}

/** A dispatched press whose outcome was never confirmed: replaying it could apply it twice. */
export function indeterminatePressResult(
  button: string,
  keyCode: number,
  reason: string | undefined,
): PressButtonResult {
  return {
    success: false,
    button,
    keyCode,
    code: "indeterminate_outcome",
    retryable: false,
    error: `Button press outcome is indeterminate: the request was dispatched but no result was confirmed (${reason ?? "unknown error"}). The press may have been applied. Do not retry automatically. Observe before retrying.`,
  };
}
