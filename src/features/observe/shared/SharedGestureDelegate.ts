/**
 * SharedGestureDelegate - Unified delegate for gesture operations.
 *
 * Handles swipe, tap, drag, and pinch gestures for both Android and iOS.
 * Platform differences are captured in SharedGestureConfig:
 * - logTag: log prefix ("ACCESSIBILITY_SERVICE" vs "XCTEST_SERVICE")
 * - roundCoordinates: Android rounds to integers, iOS passes exact values
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { DelegateContext, GestureTimingResult, BaseResult } from "./types";
import { sendCommand } from "../DeviceServiceUtils";

interface SharedGestureConfig {
  logTag: string;
  roundCoordinates: boolean;
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

  async requestTapCoordinates(
    x: number,
    y: number,
    duration: number = 0,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    frameContext?: string,
  ): Promise<BaseResult> {
    return sendCommand<BaseResult>(this.context, {
      idPrefix: "tap",
      responseType: "tap_coordinates",
      messageType: "request_tap_coordinates",
      params: { x: this.coord(x), y: this.coord(y), duration, frameContext },
      timeoutMs,
      perf,
      errorLabel: "Tap",
    });
  }

  async requestSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration: number = 300,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    frameContext?: string,
  ): Promise<GestureTimingResult> {
    return sendCommand<GestureTimingResult>(this.context, {
      idPrefix: "swipe",
      responseType: "swipe",
      messageType: "request_swipe",
      params: {
        x1: this.coord(x1),
        y1: this.coord(y1),
        x2: this.coord(x2),
        y2: this.coord(y2),
        duration,
        frameContext,
      },
      timeoutMs,
      perf,
      errorLabel: "Swipe",
    });
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
  ): Promise<GestureTimingResult> {
    return sendCommand<GestureTimingResult>(this.context, {
      idPrefix: "drag",
      responseType: "drag",
      messageType: "request_drag",
      params: {
        x1: this.coord(x1),
        y1: this.coord(y1),
        x2: this.coord(x2),
        y2: this.coord(y2),
        pressDurationMs,
        dragDurationMs,
        holdDurationMs,
        frameContext,
      },
      timeoutMs,
      errorLabel: "Drag",
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
  ): Promise<GestureTimingResult> {
    return sendCommand<GestureTimingResult>(this.context, {
      idPrefix: "pinch",
      responseType: "pinch",
      messageType: "request_pinch",
      params: {
        centerX: this.coord(centerX),
        centerY: this.coord(centerY),
        distanceStart: this.coord(distanceStart),
        distanceEnd: this.coord(distanceEnd),
        rotationDegrees,
        duration,
      },
      timeoutMs,
      perf,
      errorLabel: "Pinch",
    });
  }
}
