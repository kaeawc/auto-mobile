import type {
  SwipeGestureRequest,
  BoomerangGestureRequest,
  GestureExecutor,
  VoiceOverSwipeRunner,
} from "./types";
import { getReturnDuration, validateSwipeTimingOptions } from "./swipeTiming";
import { ActionableError } from "../../../models/ActionableError";
import { runBoomerangReturnLeg } from "./boomerangReturnLeg";
import type { FencedGestureOptions, SwipeLine } from "../ExecuteGesture";
import { BootedDevice } from "../../../models";
import { NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { SwipeResult } from "../../../models/SwipeResult";
import {
  VOICEOVER_STATE_UNKNOWN_WARNING,
  type IosVoiceOverDetector,
} from "../../accessibility/interfaces/IosVoiceOverDetector";
import { withEpilogueWarning } from "../../../utils/bestEffortEpilogue";
import type { IosCtrlProxy } from "../../observe/ios";
import { Timer } from "../../../utils/interfaces/Timer";
import type { FeatureFlagReader } from "../../featureFlags/FeatureFlagService";
import { throwIfAborted } from "../../../utils/toolUtils";

export type VoiceOverSwipeExecutorDependencies = {
  device: BootedDevice;
  executeGesture: GestureExecutor;
  iosClient: IosCtrlProxy;
  iosVoiceOverDetector: IosVoiceOverDetector;
  timer: Timer;
  featureFlags?: FeatureFlagReader;
};

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
  private readonly device: BootedDevice;
  private readonly executeGesture: GestureExecutor;
  private readonly iosClient: IosCtrlProxy;
  private readonly iosVoiceOverDetector: IosVoiceOverDetector;
  private readonly timer: Timer;
  private readonly featureFlags?: FeatureFlagReader;

  constructor({
    device,
    executeGesture,
    iosClient,
    iosVoiceOverDetector,
    timer,
    featureFlags,
  }: VoiceOverSwipeExecutorDependencies) {
    this.device = device;
    this.executeGesture = executeGesture;
    this.iosClient = iosClient;
    this.iosVoiceOverDetector = iosVoiceOverDetector;
    this.timer = timer;
    this.featureFlags = featureFlags;
  }

  /**
   * Execute a swipe gesture with VoiceOver awareness.
   *
   * If VoiceOver is enabled and the platform is iOS:
   *   - Returns an actionable unsupported result for scroll and boomerang gestures
   *
   * When boomerang is provided, performs a forward swipe, optional apex pause,
   * then a return swipe. Boomerang gestures are not supported while VoiceOver is active.
   *
   * @param request - Swipe coordinates, container, direction, and optional gesture controls
   */
  async executeSwipeGesture({
    x1,
    y1,
    x2,
    y2,
    gestureOptions,
    perf = new NoOpPerformanceTracker(),
    boomerang,
    signal,
  }: SwipeGestureRequest): Promise<SwipeResult> {
    throwIfAborted(signal);
    if (this.device.platform !== "ios") {
      if (boomerang) {
        return this.executeBoomerangGesture({
          x1,
          y1,
          x2,
          y2,
          gestureOptions,
          boomerang,
          perf,
          signal,
        });
      }
      return this.executeGesture.swipe({ x1, y1, x2, y2 }, gestureOptions, { perf, signal });
    }

    // Pass featureFlags so `force-accessibility-mode` / `accessibility-auto-detect`
    // apply to swipe detection uniformly with the observe path (#3925).
    // Tri-state, like the Android TalkBack swipe: an unreadable probe takes the
    // standard swipe but is reported as a warning, never as a confirmed "off".
    const voiceOverState = await this.iosVoiceOverDetector.resolveState(
      this.device.deviceId,
      this.iosClient,
      this.featureFlags,
    );
    throwIfAborted(signal);

    if (voiceOverState !== true) {
      const warning = voiceOverState === null ? VOICEOVER_STATE_UNKNOWN_WARNING : undefined;
      const result = boomerang
        ? await this.executeBoomerangGesture({
            x1,
            y1,
            x2,
            y2,
            gestureOptions,
            boomerang,
            perf,
            signal,
          })
        : await this.executeGesture.swipe({ x1, y1, x2, y2 }, gestureOptions, { perf, signal });
      return withEpilogueWarning(result, warning);
    }

    // VoiceOver is enabled
    if (boomerang) {
      return this.voiceOverScrollFailure(
        { x1, y1, x2, y2 },
        gestureOptions?.duration ?? 300,
        "VoiceOver boomerang gestures are not supported because they require XCTest-synthesized touches, which do not reach VoiceOver",
      );
    }

    return this.voiceOverScrollFailure(
      { x1, y1, x2, y2 },
      gestureOptions?.duration ?? 300,
      "VoiceOver scrolling is not supported: CtrlProxy only provides XCTest-synthesized touches, which do not reach VoiceOver",
    );
  }

  /**
   * Execute a boomerang gesture using standard swipes (VoiceOver disabled or non-iOS).
   * Performs a forward swipe, optional apex pause, then a return swipe.
   */
  async executeBoomerangGesture({
    x1,
    y1,
    x2,
    y2,
    gestureOptions,
    boomerang,
    perf = new NoOpPerformanceTracker(),
    signal,
  }: BoomerangGestureRequest): Promise<SwipeResult> {
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

    const forwardResult = await this.executeGesture.swipe({ x1, y1, x2, y2 }, forwardOptions, {
      perf,
      signal,
    });
    if (!forwardResult.success) {
      throwIfAborted(signal);
      return forwardResult;
    }

    // The forward swipe landed: a pause cancel, a throw or a failed return must say so (#9973).
    const returnResult = await runBoomerangReturnLeg({
      timer: this.timer,
      apexPauseMs: boomerang.apexPauseMs,
      signal,
      returnSwipe: () =>
        this.executeGesture.swipe({ x1: x2, y1: y2, x2: x1, y2: y1 }, returnOptions, {
          perf,
          signal,
        }),
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

  private voiceOverScrollFailure(line: SwipeLine, duration: number, error: string): SwipeResult {
    const { x1, y1, x2, y2 } = line;
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
