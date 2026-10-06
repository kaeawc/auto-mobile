/**
 * SharedGestureDelegate - Unified delegate for gesture operations.
 *
 * Handles swipe, tap, drag, and pinch gestures for both Android and iOS.
 * Platform differences are captured in SharedGestureConfig:
 * - logTag: log prefix ("ACCESSIBILITY_SERVICE" vs "XCTEST_SERVICE")
 * - roundCoordinates: Android rounds to integers, iOS passes exact values
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type {
  DelegateContext,
  GestureTimingResult,
  BaseResult,
  SwipeRequestOptions,
} from "./types";
import { sendCommand, type SendCommandOptions } from "../DeviceServiceUtils";

/** Default transport budget for coordinate taps and VoiceOver activation. */
export const DEFAULT_GESTURE_REQUEST_TIMEOUT_MS = 5000;

interface SharedGestureConfig {
  logTag: string;
  roundCoordinates: boolean;
  includeSwipeTimeoutMs?: boolean;
}

export interface TapDiagnosticParameters {
  diagnostics?: true;
  tapStrategy?:
    | "legacy"
    | "appRelative"
    | "appRelativeObserved"
    | "displayTargeted"
    | "displayTargetedObserved";
}

export class SharedGestureDelegate {
  protected readonly context: DelegateContext;
  private readonly config: SharedGestureConfig;

  constructor(context: DelegateContext, config: SharedGestureConfig) {
    this.context = context;
    this.config = config;
  }

  /**
   * Applies the platform coordinate policy (Android rounds to integers, iOS passes exact values).
   *
   * `protected` so platform-specific gesture overrides (e.g. the Android-only two-finger swipe)
   * reuse this single rounding source instead of re-inlining `Math.round`, making it structurally
   * impossible for a platform override to diverge from the sibling gestures' policy (#3049).
   */
  protected coord(v: number): number {
    return this.config.roundCoordinates ? Math.round(v) : v;
  }

  /** Android overrides this optional-field seam; other platforms keep their existing wire. */
  protected gestureDisplayParams(_displayId?: number): { displayId?: number } {
    return {};
  }

  /** Platform-owned wire normalization before the shared transport serializes the request. */
  protected gestureParams(_type: string, params: Record<string, unknown>): Record<string, unknown> {
    return params;
  }

  /** iOS overrides this opt-in seam; Android keeps its existing wire. */
  protected tapDiagnosticParams(): TapDiagnosticParameters {
    return {};
  }

  async requestTapCoordinates(
    x: number,
    y: number,
    duration: number = 0,
    timeoutMs: number = DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<BaseResult> {
    return sendCommand<BaseResult>(
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
        displayId,
        beforeSend,
      }),
    );
  }

  /** The tap wire request, shared so a platform can wrap its dispatch contract around it. */
  protected tapCommandOptions(tap: {
    x: number;
    y: number;
    duration: number;
    timeoutMs: number;
    perf?: PerformanceTracker;
    frameContext?: string;
    signal?: AbortSignal;
    onDispatch?: () => void;
    displayId?: number;
    beforeSend?: () => void;
  }): SendCommandOptions<BaseResult> {
    const displayParams = this.gestureDisplayParams(tap.displayId);
    return {
      idPrefix: "tap",
      responseType: "tap_coordinates",
      messageType: "request_tap_coordinates",
      params: this.gestureParams("request_tap_coordinates", {
        x: this.coord(tap.x),
        y: this.coord(tap.y),
        duration: tap.duration,
        frameContext: tap.frameContext,
        ...displayParams,
        ...this.tapDiagnosticParams(),
      }),
      requiredCapability:
        displayParams.displayId === undefined ? undefined : "gesture_display_id_v1",
      timeoutMs: tap.timeoutMs,
      perf: tap.perf,
      errorLabel: "Tap",
      // The caller's own outer deadline may already have fired while
      // `ensureConnected()` was resolving a reconnect/auto-setup (which is
      // not itself cancellable) -- `sendCommand` checks this right after that
      // await and before dispatch, so an already-abandoned tap is never sent
      // to the device after the caller has given up (issue #6306 review).
      abortSignal: tap.signal,
      beforeSend: tap.beforeSend,
      onDispatch: tap.onDispatch,
    };
  }

  /** Normalize the existing string slot and keep the lock-screen opt-in iOS-only. */
  private swipeContextParams(contextOptions?: string | SwipeRequestOptions): {
    frameContext?: string;
    lockScreen?: true;
  } {
    const options =
      typeof contextOptions === "string" ? { frameContext: contextOptions } : contextOptions;
    return {
      frameContext: options?.frameContext,
      ...(this.config.includeSwipeTimeoutMs && options?.lockScreen === true
        ? { lockScreen: true }
        : {}),
    };
  }

  async requestSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration: number = 300,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    contextOptions?: string | SwipeRequestOptions,
    onDispatch?: () => void,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<GestureTimingResult> {
    const displayParams = this.gestureDisplayParams(displayId);
    const result = await sendCommand<GestureTimingResult>(this.context, {
      idPrefix: "swipe",
      responseType: "swipe",
      messageType: "request_swipe",
      params: this.gestureParams("request_swipe", {
        x1: this.coord(x1),
        y1: this.coord(y1),
        x2: this.coord(x2),
        y2: this.coord(y2),
        duration,
        ...this.swipeContextParams(contextOptions),
        ...(this.config.includeSwipeTimeoutMs ? { timeoutMs } : {}),
        ...displayParams,
      }),
      requiredCapability:
        displayParams.displayId === undefined ? undefined : "gesture_display_id_v1",
      timeoutMs,
      perf,
      errorLabel: "Swipe",
      abortSignal: signal,
      beforeSend,
      onDispatch,
    });
    if (this.config.includeSwipeTimeoutMs && result.perfTiming) {
      perf?.addExternalTiming("iosPerf", result.perfTiming);
    }
    return result;
  }

  async requestDrag(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    pressDurationMs: number,
    dragDurationMs: number,
    holdDurationMs: number,
    timeoutMs: number,
    frameContext?: string,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
    onDispatch?: () => void,
  ): Promise<GestureTimingResult> {
    const displayParams = this.gestureDisplayParams(displayId);
    return sendCommand<GestureTimingResult>(this.context, {
      idPrefix: "drag",
      responseType: "drag",
      messageType: "request_drag",
      params: this.gestureParams("request_drag", {
        x1: this.coord(x1),
        y1: this.coord(y1),
        x2: this.coord(x2),
        y2: this.coord(y2),
        pressDurationMs,
        dragDurationMs,
        holdDurationMs,
        frameContext,
        ...displayParams,
      }),
      requiredCapability:
        displayParams.displayId === undefined ? undefined : "gesture_display_id_v1",
      timeoutMs,
      errorLabel: "Drag",
      abortSignal: signal,
      beforeSend,
      onDispatch,
    });
  }

  /**
   * Sends a two-finger pinch to the runner. `rotationDegrees` rotates the finger axis *during* the
   * pinch (start horizontal, end rotated) — a combined pinch+rotate, not a pinch along a fixed
   * rotated axis. `0` is a plain zoom. Same convention on Android and iOS. See issue #2911.
   */
  async requestPinch(
    centerX: number,
    centerY: number,
    distanceStart: number,
    distanceEnd: number,
    rotationDegrees: number,
    duration: number = 300,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<GestureTimingResult> {
    const displayParams = this.gestureDisplayParams(displayId);
    return sendCommand<GestureTimingResult>(this.context, {
      idPrefix: "pinch",
      responseType: "pinch",
      messageType: "request_pinch",
      params: this.gestureParams("request_pinch", {
        centerX: this.coord(centerX),
        centerY: this.coord(centerY),
        distanceStart: this.coord(distanceStart),
        distanceEnd: this.coord(distanceEnd),
        rotationDegrees,
        duration,
        ...displayParams,
      }),
      requiredCapability:
        displayParams.displayId === undefined ? undefined : "gesture_display_id_v1",
      timeoutMs,
      perf,
      errorLabel: "Pinch",
      abortSignal: signal,
      beforeSend,
    });
  }
}
