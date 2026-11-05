import { ActionableError } from "../../models/ActionableError";
import type { PressButtonResult } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import {
  readAndroidDeviceApiLevel,
  type ApiLevelProbeExecutor,
} from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { ANDROID_KEY_HOLD_MIN_API_LEVEL, isHoldablePressButton } from "./pressButtonPolicy";
import { unsupportedButtonResult } from "./pressButtonOutcomes";

/** The hold duration a pressButton call carries, if any (#16734). */
export function holdDurationOf(call: unknown): number | undefined {
  return typeof call === "object" && call !== null
    ? (call as { durationMs?: number }).durationMs
    : undefined;
}

/** A hold is a long press of D-pad center on Android only; refuse it anywhere else before observing. */
export function rejectUnsupportedHold(
  platform: string,
  button: string,
  durationMs: number | undefined,
): void {
  if (durationMs === undefined) {
    return;
  }
  if (!isHoldablePressButton(button)) {
    throw new ActionableError(`durationMs applies to select (D-pad center) only, not ${button}.`);
  }
  if (platform !== "android") {
    throw new ActionableError(
      `durationMs (long press of select) is supported on Android only, not ${platform}.`,
    );
  }
}

/** What a hold check needs from the press: the device's API level and the remaining budget. */
export interface AndroidKeyHoldContext {
  adb: ApiLevelProbeExecutor;
  timer: Timer;
  /** Milliseconds left of the caller's deadline, or undefined when unbounded. */
  remainingMs: () => number | undefined;
  signal?: AbortSignal;
}

/**
 * The `input keyevent` argv for a press. A key hold needs `--duration` (API 33+) and a budget
 * that outlasts the hold; refuse before dispatch otherwise, since a plain tap would open no
 * context menu (#16734).
 */
export async function prepareAndroidKeyevent(
  button: string,
  keyCode: number,
  durationMs: number | undefined,
  context: AndroidKeyHoldContext,
): Promise<{ argv: string[] } | { refusal: PressButtonResult }> {
  if (durationMs === undefined) {
    return { argv: ["shell", "input", "keyevent", String(keyCode)] };
  }
  const refusal = await androidHoldRefusal(button, durationMs, context);
  return refusal
    ? { refusal }
    : { argv: ["shell", "input", "keyevent", "--duration", String(durationMs), String(keyCode)] };
}

async function androidHoldRefusal(
  button: string,
  durationMs: number,
  { adb, timer, remainingMs, signal }: AndroidKeyHoldContext,
): Promise<PressButtonResult | undefined> {
  if (!isHoldablePressButton(button)) {
    return unsupportedButtonResult(
      button,
      `durationMs applies to select (D-pad center) only, not ${button}.`,
    );
  }
  const apiLevel = await readAndroidDeviceApiLevel(adb, remainingMs(), timer, signal);
  throwIfAborted(signal);
  if (apiLevel === null || apiLevel < ANDROID_KEY_HOLD_MIN_API_LEVEL) {
    return unsupportedButtonResult(
      button,
      `A long press of select needs Android API ${ANDROID_KEY_HOLD_MIN_API_LEVEL} or newer (device reports ${apiLevel ?? "an unknown API level"}); omit durationMs for a plain press.`,
    );
  }
  const remaining = remainingMs();
  if (remaining !== undefined && remaining <= durationMs) {
    return {
      success: false,
      button,
      keyCode: -1,
      error: `Button press deadline (${remaining}ms left) is shorter than the ${durationMs}ms hold for ${button}`,
    };
  }
  return undefined;
}
