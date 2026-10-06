/** Shared tapAt gesture duration contract, in milliseconds. */
export const LONG_PRESS_MIN_MS = 500;
export const LONG_PRESS_MAX_MS = 10000;
export const LONG_PRESS_HARD_MAX_MS = 60_000;
export const LONG_PRESS_DEFAULT_MS = 1000;
export const DOUBLE_TAP_GAP_MS = 200;

/** A CtrlProxy reply proving the supplied frame context no longer matches, so nothing was tapped. */
export function isStaleFrameContextRejection(error: string | undefined): boolean {
  return typeof error === "string" && error.toLowerCase().includes("stale frame context");
}
