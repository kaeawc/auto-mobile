import { getReturnDuration, validateSwipeTimingOptions } from "./swipeTiming";
import { ActionableError } from "../../../models/ActionableError";
import { runBoomerangReturnLeg } from "./boomerangReturnLeg";
import type { FencedGestureOptions } from "../ExecuteGesture";
import { BootedDevice, Element, SwipeDirection } from "../../../models";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { SwipeResult } from "../../../models/SwipeResult";
import { BoomerangConfig, GestureExecutor, VoiceOverSwipeRunner } from "./types";
import type { IosVoiceOverDetector } from "../../accessibility/interfaces/IosVoiceOverDetector";
import type { IOSCtrlProxy } from "../../observe/ios";
import { Timer } from "../../../utils/interfaces/Timer";
import type { FeatureFlagService } from "../../featureFlags/FeatureFlagService";
import { throwIfAborted } from "../../../utils/toolUtils";

/**
 * VoiceOverSwipeExecutor handles iOS swipes while VoiceOver is enabled.
 *
 * When VoiceOver is active on iOS, single-finger swipes navigate accessibility
 * focus rather than scrolling content. AutoMobile has no VoiceOver-aware scroll
 * mechanism, so it returns an actionable failure rather than reporting coordinate
 * touch synthesis as a successful VoiceOver scroll.
 *
 * XCTest-synthesized touches are delivered below VoiceOver's gesture layer, so
 * neither multi-finger nor single-finger coordinate synthesis can substitute for
 * a VoiceOver scroll gesture; see issue #4013.
 *
 * Parallel to TalkBackSwipeExecutor for Android TalkBack.
 */
export class VoiceOverSwipeExecutor implements VoiceOverSwipeRunner {
  constructor(
    private readonly device: BootedDevice,
    private readonly executeGesture: GestureExecutor,
    private readonly iosClient: IOSCtrlProxy,
    private readonly iosVoiceOverDetector: IosVoiceOverDetector,
    private readonly timer: Timer,
    private readonly featureFlags?: FeatureFlagService,
  ) {}

  /**
   * Execute a swipe gesture with VoiceOver awareness.
   *
   * If VoiceOver is enabled and the platform is iOS:
   *   - Returns an actionable unsupported result for scroll and boomerang gestures
   *
   * When boomerang is provided, performs a forward swipe, optional apex pause,
   * then a return swipe. Boomerang gestures are not supported while VoiceOver is active.
   *
   * @param x1 - Start X coordinate
   * @param y1 - Start Y coordinate
   * @param x2 - End X coordinate
   * @param y2 - End Y coordinate
   * @param direction - Swipe direction
   * @param containerElement - The scrollable container element, or null for screen swipe
   * @param gestureOptions - Optional gesture options (duration, scrollMode)
   * @param perf - Optional performance tracker
   * @param boomerang - Optional boomerang configuration
   */
  async executeSwipeGesture(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    _direction: SwipeDirection,
    _containerElement: Element | null,
    gestureOptions?: FencedGestureOptions,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    boomerang?: BoomerangConfig,
    signal?: AbortSignal,
  ): Promise<SwipeResult> {
    throwIfAborted(signal);
    if (this.device.platform !== "ios") {
      if (boomerang) {
        return this.executeBoomerangGesture(
          x1,
          y1,
          x2,
          y2,
          gestureOptions,
          boomerang,
          perf,
          signal,
        );
      }
      return this.executeGesture.swipe(x1, y1, x2, y2, gestureOptions, perf, signal);
    }

    // Pass featureFlags so `force-accessibility-mode` / `accessibility-auto-detect`
    // apply to swipe detection uniformly with the observe path (#3925).
    const isVoiceOverEnabled = await this.iosVoiceOverDetector.isVoiceOverEnabled(
      this.device.deviceId,
      this.iosClient,
      this.featureFlags,
    );
    throwIfAborted(signal);

    if (!isVoiceOverEnabled) {
      if (boomerang) {
        return this.executeBoomerangGesture(
          x1,
          y1,
          x2,
          y2,
          gestureOptions,
          boomerang,
          perf,
          signal,
        );
      }
      return this.executeGesture.swipe(x1, y1, x2, y2, gestureOptions, perf, signal);
    }

    // VoiceOver is enabled
    if (boomerang) {
      return this.voiceOverScrollFailure(
        x1,
        y1,
        x2,
        y2,
        gestureOptions?.duration ?? 300,
        "VoiceOver boomerang gestures are not supported because they require XCTest-synthesized touches, which do not reach VoiceOver",
      );
    }

    return this.voiceOverScrollFailure(
      x1,
      y1,
      x2,
      y2,
      gestureOptions?.duration ?? 300,
      "VoiceOver scrolling is not supported: CtrlProxy only provides XCTest-synthesized touches, which do not reach VoiceOver",
    );
  }

  /**
   * Execute a boomerang gesture using standard swipes (VoiceOver disabled or non-iOS).
   * Performs a forward swipe, optional apex pause, then a return swipe.
   */
  async executeBoomerangGesture(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    gestureOptions: FencedGestureOptions | undefined,
    boomerang: BoomerangConfig,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<SwipeResult> {
    const forwardDuration = gestureOptions?.duration ?? 300;
    const timingError = validateSwipeTimingOptions(
      {
        boomerang: true,
        apexPause: boomerang.apexPauseMs,
        returnSpeed: boomerang.returnSpeed,
      },
      forwardDuration,
    );
    if (timingError) {
      throw new ActionableError(timingError);
    }
    const returnDuration = getReturnDuration({
      forwardDuration,
      returnSpeed: boomerang.returnSpeed,
    });
    const totalDuration = forwardDuration + boomerang.apexPauseMs + returnDuration;

    const forwardOptions = this.buildGestureOptions(gestureOptions, forwardDuration);
    const returnOptions = this.buildGestureOptions(gestureOptions, returnDuration);

    const forwardResult = await this.executeGesture.swipe(
      x1,
      y1,
      x2,
      y2,
      forwardOptions,
      perf,
      signal,
    );
    if (!forwardResult.success) {
      throwIfAborted(signal);
      return forwardResult;
    }

    // The forward swipe landed: a pause cancel, a throw or a failed return must say so (#9973).
    const returnResult = await runBoomerangReturnLeg({
      timer: this.timer,
      apexPauseMs: boomerang.apexPauseMs,
      signal,
      returnSwipe: () => this.executeGesture.swipe(x2, y2, x1, y1, returnOptions, perf, signal),
    });
    if (!returnResult.success) {
      return {
        ...returnResult,
        x1,
        y1,
        x2,
        y2,
        duration: totalDuration,
      };
    }

    return {
      ...forwardResult,
      x1,
      y1,
      x2,
      y2,
      duration: totalDuration,
    };
  }

  private voiceOverScrollFailure(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration: number,
    error: string,
  ): SwipeResult {
    return {
      success: false,
      error,
      x1,
      y1,
      x2,
      y2,
      duration,
      fallbackReason:
        "XCTest-synthesized touches do not reach VoiceOver; no gesture fallback is available",
    };
  }

  private buildGestureOptions(
    base: FencedGestureOptions | undefined,
    duration: number,
  ): FencedGestureOptions {
    return {
      ...(base ?? {}),
      duration,
    };
  }
}
