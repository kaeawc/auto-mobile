/**
 * Automatic screenshots are intentionally opt-in for observations AutoMobile
 * performs on a caller's behalf. Explicit `observe` calls keep their existing
 * screenshot behavior.
 *
 * The flags use "skip" semantics so their default is backwards compatible:
 * absent (or any value other than `false`/`0`) means skip automatic capture.
 */
export const ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV =
  "AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT";
export const OBSERVE_WAIT_FOR_SKIP_SCREENSHOT_ENV = "AUTOMOBILE_OBSERVE_WAIT_FOR_SKIP_SCREENSHOT";

function isSkipEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== "false" && value?.trim() !== "0";
}

export function shouldSkipActionObservationScreenshot(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isSkipEnabled(env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV]);
}

export function shouldSkipObserveWaitForScreenshot(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSkipEnabled(env[OBSERVE_WAIT_FOR_SKIP_SCREENSHOT_ENV]);
}
