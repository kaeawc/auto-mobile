import { sendIOSPressCommand, type IOSDispatchResult } from "./CtrlProxyDispatch";
/**
 * CtrlProxyGestures - iOS gesture delegate.
 *
 * Thin wrapper over SharedGestureDelegate with iOS-specific config
 * (no coordinate rounding).
 */

import {
  DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
  SharedGestureDelegate,
  type TapDiagnosticParameters,
} from "../shared/SharedGestureDelegate";
import type { CtrlProxyTapResult, DelegateContext } from "./types";
import type { GestureTimingResult } from "../shared/types";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { logger, LogLevel } from "../../../utils/logger";
import {
  DefaultSystemDetection,
  type SystemDetection,
} from "../../../utils/system/SystemDetection";

export class CtrlProxyGestures extends SharedGestureDelegate {
  constructor(
    context: DelegateContext,
    private readonly environment: Pick<SystemDetection, "getEnvVar"> = new DefaultSystemDetection(),
  ) {
    super(context, {
      logTag: "CTRL_PROXY",
      roundCoordinates: false,
      includeSwipeTimeoutMs: true,
    });
  }

  /** Read the daemon's exported logger at request construction, with no signature changes. */
  protected override tapDiagnosticParams(): TapDiagnosticParameters {
    if (logger.getLogLevel() !== LogLevel.DEBUG) {
      return {};
    }
    const strategy = this.environment.getEnvVar("AUTOMOBILE_IOS_TAP_STRATEGY");
    return strategy === "legacy" ||
      strategy === "appRelative" ||
      strategy === "appRelativeObserved" ||
      strategy === "displayTargeted" ||
      strategy === "displayTargetedObserved"
      ? { diagnostics: true, tapStrategy: strategy }
      : { diagnostics: true };
  }

  /**
   * A tap written to the socket whose reply is late or lost may still have landed, so it is
   * reported as dispatched-but-unacknowledged (never as a plain failure) the way presses are.
   * A runner reply, including a refusal, stays acknowledged; a tap never sent stays a plain
   * failure. The iOS client has no display routing, so `displayId` and `beforeSend` are unused.
   */
  // oxlint-disable-next-line max-params -- Keeps the shared delegate's positional tap signature.
  override async requestTapCoordinates(
    x: number,
    y: number,
    duration: number = 0,
    timeoutMs: number = DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyTapResult>> {
    return sendIOSPressCommand(
      this.context,
      this.tapCommandOptions({
        x,
        y,
        duration,
        timeoutMs,
        perf,
        frameContext,
        signal,
        onDispatch,
      }),
    );
  }

  /**
   * Request a simultaneous multi-finger swipe gesture.
   *
   * @param x1 - Start X coordinate
   * @param y1 - Start Y coordinate
   * @param x2 - End X coordinate
   * @param y2 - End Y coordinate
   * @param fingerCount - Number of fingers
   * @param duration - Gesture duration in milliseconds (default: 300)
   * @param timeoutMs - Request timeout in milliseconds (default: 5000)
   * @param perf - Optional performance tracker
   * @returns Gesture timing result
   */
  async requestMultiFingerSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    fingerCount: number,
    duration: number = 300,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    fingerSpacing?: number,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<GestureTimingResult>> {
    return sendIOSPressCommand(this.context, {
      idPrefix: "multi_finger_swipe",
      responseType: "multi_finger_swipe_result",
      messageType: "request_multi_finger_swipe",
      params: { x1, y1, x2, y2, fingerCount, duration, offset: fingerSpacing },
      timeoutMs,
      abortSignal: signal,
      perf,
      onDispatch,
      notConnectedMessage: "Not connected to CtrlProxy",
      errorLabel: "Multi-finger swipe",
    });
  }
}
