/**
 * Automatic screenshots are intentionally opt-in for observations AutoMobile
 * performs on a caller's behalf. Explicit `observe` calls keep their existing
 * screenshot behavior unless settled mode is selected.
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
import { FeatureFlagService } from "../featureFlags/FeatureFlagService";

export type ScreenshotMode = "settled" | "async" | "none";
export const OBSERVE_SETTLED_SCREENSHOT_ENV = "AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT";

/**
 * Resolve capture mode in this order: an explicit `observe.screenshot` argument,
 * then AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT, then the persisted
 * `observe-settled-screenshot` flag, then today's `async` default. The new env
 * var accepts case-insensitive `true`/`1` (settled) and `false`/`0` (async),
 * with surrounding whitespace ignored; any other set value is treated as false.
 * In settled mode the legacy action/waitFor skip vars are ignored and a fresh
 * capture is always awaited. In async/none mode those skip vars retain their
 * existing semantics for automatic captures; explicit observe without an
 * argument retains its fire-and-forget capture.
 */
export function resolveScreenshotMode(
  screenshot?: ScreenshotMode,
  env: NodeJS.ProcessEnv = process.env,
  flags: Pick<FeatureFlagService, "isEnabled"> = FeatureFlagService.getInstance(),
): ScreenshotMode {
  if (screenshot !== undefined) {
    return screenshot;
  }
  const configured = env[OBSERVE_SETTLED_SCREENSHOT_ENV];
  if (configured !== undefined) {
    return ["true", "1"].includes(configured.trim().toLowerCase()) ? "settled" : "async";
  }
  return flags.isEnabled("observe-settled-screenshot") ? "settled" : "async";
}
