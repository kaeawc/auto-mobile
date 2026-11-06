import type { ObserveResult, PressButtonResult } from "../../models";

/** A typed, non-retryable refusal for a button (or button option) the device cannot press. */
export function unsupportedButtonResult(button: string, error: string): PressButtonResult {
  return {
    success: false,
    button,
    keyCode: -1,
    code: "unsupported_button",
    retryable: false,
    error,
  };
}

/** True when an iOS Home press starts from a verified SpringBoard, so "no visual change" is fine. */
export function isIosHomePressOnSpringboard(
  platform: string,
  button: string,
  observation: ObserveResult | undefined,
): boolean {
  const hierarchy = observation?.viewHierarchy;
  return (
    platform === "ios" &&
    button.toLowerCase() === "home" &&
    hierarchy?.packageName === "com.apple.springboard" &&
    hierarchy.fallbackToSpringboard !== true &&
    !hierarchy.hierarchy?.error
  );
}

/**
 * True when the pre-press tree was SpringBoard reached through the runner's foreground fallback.
 * On the real home screen the runner always reports `fallbackToSpringboard: true` (#14954), so
 * the flag cannot veto a Home press; the post-press SpringBoard check decides instead.
 */
export function isIosSpringboardFallbackPress(
  platform: string,
  button: string,
  observation: ObserveResult | undefined,
): boolean {
  const hierarchy = observation?.viewHierarchy;
  return (
    platform === "ios" &&
    button.toLowerCase() === "home" &&
    hierarchy?.packageName === "com.apple.springboard" &&
    hierarchy.fallbackToSpringboard === true &&
    !hierarchy.hierarchy?.error
  );
}

/**
 * A Home press that began on a fallback SpringBoard and still ends on a healthy SpringBoard
 * without a visual change was already home: report success instead of "No visual change".
 */
export function acceptIosHomeAlreadyOnSpringboard(
  result: { success: boolean; error?: string; observation?: ObserveResult },
  startedOnFallbackSpringboard: boolean,
): void {
  const after = result.observation?.viewHierarchy;
  if (
    startedOnFallbackSpringboard &&
    !result.success &&
    result.error === "No visual change observed" &&
    after?.packageName === "com.apple.springboard" &&
    !after.hierarchy?.error
  ) {
    result.success = true;
    delete result.error;
  }
}

/** A successful Android Home dispatch already verified the launcher foreground (#15028). */
export function acceptAndroidHomeAlreadyOnLauncher(
  result: { success: boolean; error?: string },
  context: { platform: string; button: string; pressSucceeded: boolean },
): void {
  if (
    context.platform === "android" &&
    context.button.toLowerCase() === "home" &&
    context.pressSucceeded &&
    !result.success &&
    result.error === "No visual change observed"
  ) {
    result.success = true;
    delete result.error;
  }
}

/** The runner verified the App Switcher is already open, so the press is a no-op success. */
export function isVerifiedAlreadyOpenSwitcher(reply: {
  success: boolean;
  recentAppsRoute?: string;
}): boolean {
  return reply.success && reply.recentAppsRoute === "already-open";
}

/** A verified already-open switcher needs no visual change: turn "No visual change" into success. */
export function acceptVerifiedAlreadyOpenSwitcher(
  result: { success: boolean; error?: string },
  verifiedAlreadyOpen: boolean,
): void {
  if (verifiedAlreadyOpen && result.error === "No visual change observed") {
    result.success = true;
    delete result.error;
  }
}
