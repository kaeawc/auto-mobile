import { sendIOSPressCommand, type IOSDispatchResult } from "./CtrlProxyDispatch";
/**
 * CtrlProxyGestures - iOS gesture delegate.
 *
 * Thin wrapper over SharedGestureDelegate with iOS-specific config
 * (no coordinate rounding).
 */

import {
  SharedGestureDelegate,
  type TapDiagnosticParameters,
} from "../shared/SharedGestureDelegate";
import type { DelegateContext } from "./types";
import type { GestureTimingResult } from "../shared/types";
import type { SendCommandOptions } from "../DeviceServiceUtils";
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
   * A swipe written to the runner whose reply is late or lost has very likely scrolled the
   * screen, so it reports `dispatched`/`acknowledged` like the other iOS dispatch commands. A
   * runner reply, including a refusal, is acknowledged; a timeout or socket close is not.
   */
  protected override sendSwipeCommand(
    options: SendCommandOptions<GestureTimingResult>,
  ): Promise<IOSDispatchResult<GestureTimingResult>> {
    return sendIOSPressCommand(this.context, options);
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
