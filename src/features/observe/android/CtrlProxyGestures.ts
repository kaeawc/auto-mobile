/**
 * CtrlProxyGestures - Android gesture delegate.
 *
 * Extends SharedGestureDelegate with Android-specific config (coordinate rounding)
 * and the Android-only two-finger swipe operation for TalkBack mode.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import {
  SharedGestureDelegate,
  DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
} from "../shared/SharedGestureDelegate";
import { sendCommand } from "../DeviceServiceUtils";
import type { DelegateContext, A11ySwipeResult, A11yTapCoordinatesResult } from "./types";
import { normalizeCtrlProxyMilliseconds } from "./ctrlProxyProtocol";

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

  protected override gestureDisplayParams(displayId?: number): { displayId?: number } {
    // Preserve the requested target; sendCommand validates the current connection's capability.
    return displayId === undefined || displayId === 0 ? {} : { displayId };
  }

  /** Android schedules both strokes; reply latency cannot stretch the double-tap gap. */
  async requestDoubleTapCoordinates(
    x: number,
    y: number,
    onDispatch?: () => void,
  ): Promise<A11yTapCoordinatesResult> {
    return sendCommand<A11yTapCoordinatesResult>(this.context, {
      idPrefix: "double_tap",
      responseType: "tap_coordinates",
      messageType: "request_tap_coordinates",
      params: this.gestureParams("request_tap_coordinates", {
        x: this.coord(x),
        y: this.coord(y),
        duration: 50,
        doubleTap: true,
      }),
      requiredCapability: "tap_double_v1",
      timeoutMs: DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
      errorLabel: "Double tap",
      onDispatch,
    });
  }

  protected override gestureParams(
    type: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    return normalizeCtrlProxyMilliseconds(type, params);
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
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11ySwipeResult> {
    // Coordinates go through the shared `coord()` policy (roundCoordinates: true for Android) so
    // TalkBack two-finger swipes land on whole pixels, exactly like the sibling swipe/tap/drag/
    // pinch gestures (#3049). Intentional and not to be regressed — the runner accepts fractional
    // coordinates (#2927), but this path deliberately sends integers. See the constructor note.
    return sendCommand<A11ySwipeResult>(this.context, {
      idPrefix: "two_finger_swipe",
      responseType: "swipe",
      messageType: "request_two_finger_swipe",
      params: this.gestureParams("request_two_finger_swipe", {
        x1: this.coord(x1),
        y1: this.coord(y1),
        x2: this.coord(x2),
        y2: this.coord(y2),
        duration,
        offset,
        ...this.gestureDisplayParams(displayId),
      }),
      timeoutMs,
      perf,
      errorLabel: "Two-finger swipe",
      beforeSend,
      requiredCapability:
        displayId === undefined || displayId === 0 ? undefined : "gesture_display_id_v1",
    });
  }

  /**
   * Begin a streamed gesture (finger down) at ([x], [y]). Android-only: the runner chains the
   * start/move/end sharing [gestureId] into one continued AccessibilityService gesture so the device
   * tracks the pointer live (issue: streaming gesture input). Each frame is correlated by requestId
   * and answered with the shared `swipe_result` frame, like the sibling gestures. Deliberately no
   * `frameContext` — streamed gestures are frame-identity-free, like taps.
   * The display fence guards start only; a mid-stream transition does not cancel move/end.
   * The runner continues the accepted gesture on its original display.
   */
  // oxlint-disable-next-line max-params -- Append the dispatch fence to the existing positional Android API.
  async requestGestureStart(
    gestureId: string,
    x: number,
    y: number,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11ySwipeResult> {
    return sendCommand<A11ySwipeResult>(this.context, {
      idPrefix: "gesture_start",
      responseType: "swipe",
      messageType: "request_gesture_start",
      params: {
        gestureId,
        x: this.coord(x),
        y: this.coord(y),
        ...this.gestureDisplayParams(displayId),
      },
      timeoutMs,
      perf,
      errorLabel: "Gesture start",
      beforeSend,
      requiredCapability:
        displayId === undefined || displayId === 0 ? undefined : "gesture_display_id_v1",
    });
  }

  /** Feed an incremental move to the streamed gesture [gestureId]. See {@link requestGestureStart}. */
  async requestGestureMove(
    gestureId: string,
    x: number,
    y: number,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<A11ySwipeResult> {
    return sendCommand<A11ySwipeResult>(this.context, {
      idPrefix: "gesture_move",
      responseType: "swipe",
      messageType: "request_gesture_move",
      params: { gestureId, x: this.coord(x), y: this.coord(y) },
      timeoutMs,
      perf,
      errorLabel: "Gesture move",
    });
  }

  /**
   * End the streamed gesture [gestureId], lifting at ([x], [y]) — or, when [cancel] is true,
   * abandoning it and lifting in place. See {@link requestGestureStart}.
   */
  async requestGestureEnd(
    gestureId: string,
    x: number,
    y: number,
    cancel: boolean = false,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<A11ySwipeResult> {
    return sendCommand<A11ySwipeResult>(this.context, {
      idPrefix: "gesture_end",
      responseType: "swipe",
      messageType: "request_gesture_end",
      params: { gestureId, x: this.coord(x), y: this.coord(y), cancel },
      timeoutMs,
      perf,
      errorLabel: "Gesture end",
    });
  }
}
