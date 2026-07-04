/**
 * CtrlProxyGestures - Android gesture delegate.
 *
 * Extends SharedGestureDelegate with Android-specific config (coordinate rounding)
 * and the Android-only two-finger swipe operation for TalkBack mode.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { SharedGestureDelegate } from "../shared/SharedGestureDelegate";
import { sendCommand } from "../DeviceServiceUtils";
import type { DelegateContext, A11ySwipeResult } from "./types";

export class CtrlProxyGestures extends SharedGestureDelegate {
  constructor(context: DelegateContext) {
    // `roundCoordinates: true` centralizes coordinate rounding for Android at the delegate layer
    // (SharedGestureDelegate.coord()), so integer coordinates reach the runner wire. This is
    // intentional and must not be regressed to `false`: the Android runner's protocol accepts
    // fractional coordinates as of #2927 (WebSocketRequest.kt fields are `Double`), but this
    // rounding is what keeps the current shipped behavior pixel-aligned. The Double protocol is a
    // robustness backstop for any client, not a signal that rounding here can be dropped.
    super(context, { logTag: "ACCESSIBILITY_SERVICE", roundCoordinates: true });
  }

  /**
   * Request a two-finger swipe gesture for TalkBack mode. Android-only.
   *
   * Routed through `sendCommand`/`RequestManager` like every other gesture (#2988): the runner's
   * `swipe_result` frame is correlated by requestId and resolves this promise as soon as it
   * arrives, instead of the promise only ever settling via its timeout. The requestId keeps the
   * `two_finger_swipe_` prefix so callers/loggers that key on it are unaffected.
   */
  async requestTwoFingerSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration: number = 300,
    offset: number = 100,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker()
  ): Promise<A11ySwipeResult> {
    // The two-finger path hard-rounds coordinates here (matching the delegate's roundCoordinates
    // rounding) so TalkBack two-finger swipes land on whole pixels. Intentional and not to be
    // regressed — the runner accepts fractional coordinates (#2927), but this path deliberately
    // sends integers. See the constructor note.
    return sendCommand<A11ySwipeResult>(this.context, {
      idPrefix: "two_finger_swipe",
      responseType: "swipe",
      messageType: "request_two_finger_swipe",
      params: {
        x1: Math.round(x1),
        y1: Math.round(y1),
        x2: Math.round(x2),
        y2: Math.round(y2),
        duration,
        offset,
      },
      timeoutMs,
      perf,
      errorLabel: "Two-finger swipe",
    });
  }
}
