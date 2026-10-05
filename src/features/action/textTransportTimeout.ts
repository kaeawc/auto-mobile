/** Keep short iOS text requests at the existing transport timeout. */
export const DEFAULT_TEXT_REQUEST_TIMEOUT_MS = 5000;
export const MAX_TEXT_REQUEST_TIMEOUT_MS = 120_000;
const TEXT_REPLY_HEADROOM_MS = 2000;

// ios/control-proxy/Sources/CtrlProxyRewrite/GesturePerformer.swift:1347-1360
// calls XCUIApplication.typeText with no
// per-key cadence or overall typing budget. This conservative allowance needs
// one simulator measurement; it is not a measured XCUITest rate.
export const CONSERVATIVE_IOS_TEXT_PER_CODE_POINT_MS = 100;

/** Deadline clamping takes precedence over the compatibility floor. */
export function resolveTextCtrlProxyTimeoutMs(
  text: string,
  remainingRequestBudgetMs?: number,
): number {
  const timeoutMs = Math.min(
    MAX_TEXT_REQUEST_TIMEOUT_MS,
    Math.max(
      DEFAULT_TEXT_REQUEST_TIMEOUT_MS,
      Array.from(text).length * CONSERVATIVE_IOS_TEXT_PER_CODE_POINT_MS + TEXT_REPLY_HEADROOM_MS,
    ),
  );
  return remainingRequestBudgetMs === undefined
    ? timeoutMs
    : Math.max(0, Math.min(timeoutMs, remainingRequestBudgetMs));
}
