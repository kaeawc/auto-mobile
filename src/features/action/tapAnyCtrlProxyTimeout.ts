import { DEFAULT_GESTURE_REQUEST_TIMEOUT_MS } from "../observe/shared/SharedGestureDelegate";
import { resolveGestureCtrlProxyTimeoutMs as resolveTapAnyCtrlProxyTimeoutMs } from "./gestureTransportTimeout";

/**
 * Established per-request default timeout that `SharedGestureDelegate.requestTapCoordinates`,
 * `CtrlProxyVoiceOver.requestAction`, and `CtrlProxyVoiceOver.requestVoiceOverActivate` each
 * apply when no `timeoutMs` is passed. An ordinary tap/doubleTap relied on this default before
 * `resolveTapAnyCtrlProxyTimeoutMs` started sizing an explicit timeout from the (short, 50ms)
 * fixed press duration -- whose unfloored duration + headroom is ~2050ms, below this floor. Applying that
 * shorter value unguarded shrinks, rather than merely budgets, the window an ordinary tap
 * already had for a slow-but-otherwise-healthy CtrlProxy round trip: XCTest performs element
 * lookup and `tap()`/activation before replying, so a device that legitimately takes 2.05-5s
 * could now report failure -- and potentially still execute the tap after that reported failure
 * -- where the same request previously succeeded (issue #6306 review, P1).
 * `resolveTapAnyOrdinaryTapCtrlProxyTimeoutMs` below floors at this value so the tapAny-specific
 * budgeting stays additive/bounding on top of the established default, never below it.
 */
export const TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS = DEFAULT_GESTURE_REQUEST_TIMEOUT_MS;

/**
 * Build the INNER CtrlProxy request timeout for an ORDINARY (non-longPress) iOS tap/doubleTap
 * gesture. Same derivation as `resolveTapAnyCtrlProxyTimeoutMs` (press duration + headroom,
 * clamped to `MAX_SETTIMEOUT_DELAY_MS`), floored at
 * `TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS` so sizing an explicit timeout from the tap's
 * short fixed press duration never reduces the established default the underlying CtrlProxy
 * request methods already applied (issue #6306 review, P1). The shared formula also preserves
 * this default for short long presses (issue #6327).
 */
export function resolveTapAnyOrdinaryTapCtrlProxyTimeoutMs(pressDurationMs: number): number {
  return Math.max(
    resolveTapAnyCtrlProxyTimeoutMs(pressDurationMs),
    TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS,
  );
}
