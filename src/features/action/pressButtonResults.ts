import { ActionableError } from "../../models/ActionableError";
import type { PressButtonResult } from "../../models";
import { unsupportedButtonResult } from "./pressButtonOutcomes";

/** iOS hardware buttons that only some devices have, pressed via XCUIDevice.Button (#14100). */
export const IOS_OPTIONAL_HARDWARE_BUTTONS: ReadonlySet<string> = new Set(["action", "camera"]);

/** Wording GesturePerformer.GestureError.notSupported puts on the wire. */
const IOS_RUNNER_NOT_SUPPORTED_PREFIX = "Feature not supported";

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

/** Map a failed iOS runner press to a typed result: unsupported, indeterminate, or failed. */
export function iosPressFailureResult(
  button: string,
  normalizedButton: string,
  result: { error?: string; dispatched?: boolean; acknowledged?: boolean },
  hardwareButtons: ReadonlySet<string>,
): PressButtonResult {
  if (
    IOS_OPTIONAL_HARDWARE_BUTTONS.has(normalizedButton) &&
    result.error?.startsWith(IOS_RUNNER_NOT_SUPPORTED_PREFIX)
  ) {
    return unsupportedButtonResult(
      button,
      `${result.error}. The ${normalizedButton} button needs a device that has it (hasHardwareButton) and a CtrlProxy runner built with Xcode 16.3 or later.`,
    );
  }
  if (normalizedButton !== "home" && result.dispatched && result.acknowledged === false) {
    return {
      success: false,
      button,
      keyCode: -1,
      code: "indeterminate_outcome",
      retryable: false,
      error: `Button press outcome is indeterminate: the request was dispatched but no result was confirmed (${result.error ?? "unknown error"}). The press may have been applied. Do not retry automatically. Observe before retrying.`,
    };
  }
  return {
    success: false,
    button,
    keyCode: -1,
    code: "press_failed",
    retryable: false,
    // HOME stays a plain failure here, but callers that must not replay it (systemTray's
    // Notification Center close) need to tell a sent-but-unanswered press from a refusal (#14387).
    ...(normalizedButton === "home" && result.dispatched !== undefined
      ? { dispatched: result.dispatched, acknowledged: result.acknowledged }
      : {}),
    error:
      result.error ??
      (hardwareButtons.has(normalizedButton)
        ? `iOS hardware button "${button}" is not supported on this device`
        : `Failed to press iOS ${normalizedButton} button`),
  };
}
