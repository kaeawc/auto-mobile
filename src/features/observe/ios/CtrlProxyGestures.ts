import type { TapCoordinatesRequest } from "../shared/SharedGestureDelegate";
import {
  sendIOSPressCommand,
  type IOSDispatchResult,
  type IosFrameDispatchOptions,
} from "./CtrlProxyDispatch";
/**
 * CtrlProxyGestures - iOS gesture delegate.
 *
 * Thin wrapper over SharedGestureDelegate with iOS-specific config
 * (no coordinate rounding).
 */

import {
  DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
  SharedGestureDelegate,
  type PinchRequest,
  type TapDiagnosticParameters,
} from "../shared/SharedGestureDelegate";
import type { CtrlProxyTapResult, DelegateContext } from "./types";
import type { GestureTimingResult } from "../shared/types";
import type { SendCommandOptions } from "../DeviceServiceUtils";
import type { MultiFingerSwipeRequest } from "../../../utils/interfaces/MultiFingerSwipeRequest";
import { logger, LogLevel } from "../../../utils/logger";
import {
  DefaultSystemDetection,
  type SystemDetection,
} from "../../../utils/system/SystemDetection";
import { ENV } from "../../../config/env";

export class CtrlProxyGestures extends SharedGestureDelegate {
  constructor(
    context: DelegateContext,
    private readonly environment: Pick<SystemDetection, "getEnvVar"> = new DefaultSystemDetection(),
    private readonly getDoubleTapFeatures?: (signal?: AbortSignal) => Promise<string[] | null>,
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
    const strategy = this.environment.getEnvVar(ENV.IOS_TAP_STRATEGY.name);
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
   * A tap written to the socket whose reply is late or lost may still have landed, so it is
   * reported as dispatched-but-unacknowledged (never as a plain failure) the way presses are.
   * A runner reply, including a refusal, stays acknowledged; a tap never sent stays a plain
   * failure. The iOS client has no display routing, so `displayId` and `beforeSend` are unused.
   */

  override async requestTapCoordinates(
    request: TapCoordinatesRequest,
  ): Promise<IOSDispatchResult<CtrlProxyTapResult>> {
    const {
      x,
      y,
      duration = 0,
      timeoutMs = DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
      perf,
      frameContext,
      signal,
      onDispatch,
    } = request;

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

  async requestDoubleTapCoordinates(
    x: number,
    y: number,
    timeoutMs: number = DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
    { frameContext, signal, onDispatch }: IosFrameDispatchOptions = {},
  ): Promise<IOSDispatchResult<CtrlProxyTapResult>> {
    return sendIOSPressCommand(
      this.getDoubleTapFeatures
        ? {
            ...this.context,
            ensureConnected: async (perf) => {
              const connected = await this.context.ensureConnected(perf);
              if (connected) {
                const features = await this.getDoubleTapFeatures?.(signal);
                if (features && !features.includes("double_tap_v1")) {
                  throw new Error(
                    "iOS CtrlProxy runner is too old for a double tap and must be updated; rebuild and redeploy the iOS CtrlProxy runner from this source checkout, or run the iOS hot-reload watcher with --manage-ios-runner.",
                  );
                }
              }
              return connected;
            },
          }
        : this.context,
      this.tapCommandOptions({
        x,
        y,
        duration: 50,
        timeoutMs,
        frameContext,
        signal,
        onDispatch,
        doubleTap: true,
      }),
    );
  }

  /**
   * Request a simultaneous multi-finger swipe gesture.
   *
   * @param request - Start and end coordinates, finger count and optional duration (default 300 ms),
   *   timeout (default 5000 ms), spacing, abort signal and dispatch/fence hooks
   * @returns Gesture timing result
   */
  async requestMultiFingerSwipe(
    request: MultiFingerSwipeRequest,
  ): Promise<IOSDispatchResult<GestureTimingResult>> {
    const { x1, y1, x2, y2, fingerCount, fingerSpacing, signal, perf, onDispatch, beforeSend } =
      request;
    const { duration = 300, timeoutMs = 5000 } = request;
    return sendIOSPressCommand(this.context, {
      idPrefix: "multi_finger_swipe",
      responseType: "multi_finger_swipe_result",
      messageType: "request_multi_finger_swipe",
      params: { x1, y1, x2, y2, fingerCount, duration, offset: fingerSpacing },
      timeoutMs,
      abortSignal: signal,
      perf,
      onDispatch,
      beforeSend,
      notConnectedMessage: "Not connected to CtrlProxy",
      errorLabel: "Multi-finger swipe",
    });
  }

  /**
   * Drag one finger through timed points (down at the first, up after the last). Needs a runner
   * advertising `path_gesture_v1`; an older runner would reject the unknown request after the
   * fact, so refuse before any input. A reply that never arrives after the send is reported
   * `dispatched` and not `acknowledged`: the stroke may already have run.
   */
  async requestPathGesture(
    points: ReadonlyArray<{ x: number; y: number; offsetMs: number }>,
    timeoutMs: number = DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<GestureTimingResult>> {
    const features = await this.getDoubleTapFeatures?.(signal);
    if (features && !features.includes("path_gesture_v1")) {
      return {
        success: false,
        totalTimeMs: 0,
        error:
          "iOS CtrlProxy runner is too old for dragPath and must be updated; rebuild and redeploy the iOS CtrlProxy runner from this source checkout, or run the iOS hot-reload watcher with --manage-ios-runner.",
        dispatched: false,
        acknowledged: false,
      };
    }
    return sendIOSPressCommand(this.context, {
      idPrefix: "path_gesture",
      responseType: "path_gesture_result",
      messageType: "request_path_gesture",
      params: {
        points: points.map(({ x, y, offsetMs }) => ({ x, y, offsetMs: Math.round(offsetMs) })),
        frameContext,
      },
      timeoutMs,
      abortSignal: signal,
      onDispatch,
      notConnectedMessage: "Not connected to CtrlProxy",
      errorLabel: "Path gesture",
    });
  }

  /**
   * Send a two-finger pinch. A request the runner never answered (socket close, timeout or
   * cancellation after the send) is reported `dispatched` and not `acknowledged`, and not retryable:
   * the pinch may already have zoomed the screen.
   */
  async requestPinchWithDispatch(
    request: PinchRequest,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<GestureTimingResult>> {
    return sendIOSPressCommand(this.context, {
      ...this.pinchCommandOptions(request),
      onDispatch,
    });
  }
}
