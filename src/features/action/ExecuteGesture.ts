import { capLookForTravel } from "./swipeon/lookForScroll";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import type { Element } from "../../models";
import { executeAndroidSearchDrag, type AndroidSearchDragState } from "./swipeon/androidSearchDrag";
import { inputDurationArgument } from "./touchscreenInput";
import { StaleDisplayError } from "../../models/StaleDisplayError";
import { ActionableError, unsupportedPlatformError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BootedDevice, Point } from "../../models";
import { FingerPath } from "../../models";
import { GestureOptions } from "../../models";
import {
  BaseVisualChange,
  resolveDisplayFence,
  type DisplayFence,
  type DisplayFenceOption,
} from "./BaseVisualChange";
import { SwipeResult } from "../../models";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { isRunnerGestureOutcomeUnknown } from "../observe/ios/runnerErrorCodes";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { throwIfAborted } from "../../utils/toolUtils";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";

export interface FencedGestureOptions extends GestureOptions {
  /** Internal opt-in for the iOS lock-screen synthesized swipe. */
  lockScreen?: boolean;
  /** Search-only drag with an endpoint hold, or a slow ADB fallback. */
  searchScroll?: boolean;
  searchScrollBounds?: Element["bounds"];
  onSearchFallback?: () => void;
  searchDragState?: AndroidSearchDragState;
  displayFence?: DisplayFence;
}

/**
 * A failed iOS swipe whose effect is unknown: sent without a runner reply (only a reply, success or
 * refusal, is acknowledged), or answered with the runner's "completed after its deadline" or
 * "still executing past its bound" error.
 */
function swipeOutcomeUnknown(
  result: {
    dispatched?: boolean;
    acknowledged?: boolean;
    errorCode?: string;
    error?: string;
  },
  dispatchedByHost: boolean,
): boolean {
  const unacknowledged = (result.dispatched ?? dispatchedByHost) && result.acknowledged !== true;
  return unacknowledged || isRunnerGestureOutcomeUnknown(result);
}

/**
 * Executes gestures using platform-specific commands
 */
export class ExecuteGesture extends BaseVisualChange {
  constructor(device: BootedDevice, adb: AdbExecutor | null = null, timer: Timer = defaultTimer) {
    super(device, adb, timer);
    this.device = device;
  }

  /**
   * Execute a swipe gesture from one point to another
   * Note: This method executes the raw swipe command without observation.
   * Callers that need observation should use observedInteraction at a higher level.
   * @param x1 - Starting X coordinate
   * @param y1 - Starting Y coordinate
   * @param x2 - Ending X coordinate
   * @param y2 - Ending Y coordinate
   * @param options - Additional gesture options
   * @param perf - Optional performance tracker
   * @returns Result of the swipe operation
   */
  // Cancellation is appended to the existing positional API for compatibility.
  // oxlint-disable-next-line max-params -- Existing positional API keeps optional cancellation last.
  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    options: FencedGestureOptions = {},
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<SwipeResult> {
    throwIfAborted(signal);
    // Platform-specific swipe execution (no observedInteraction - caller handles observation)
    switch (this.device.platform) {
      case "android":
        return await this.executeAndroidSwipe(x1, y1, x2, y2, options, perf, signal);
      case "ios":
        return await this.executeiOSSwipe(x1, y1, x2, y2, options, perf, signal);
      default:
        throw unsupportedPlatformError(this.device.platform, "execute gesture");
    }
  }

  /**
   * Execute Android-specific swipe gesture
   * @param x1 - Starting X coordinate
   * @param y1 - Starting Y coordinate
   * @param x2 - Ending X coordinate
   * @param y2 - Ending Y coordinate
   * @param options - Additional gesture options
   * @param perf - Performance tracker for timing
   * @returns Result of the swipe operation
   */
  // oxlint-disable-next-line max-params -- Keep the signal adjacent to the dispatch arguments.
  private async executeAndroidSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    options: FencedGestureOptions = {},
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<SwipeResult> {
    const duration = options.duration ?? 300; // Default duration
    const scrollMode = options.scrollMode || "adb"; // Default to ADB mode

    if (options.searchScroll) {
      const coordinates = options.searchScrollBounds
        ? capLookForTravel(
            { startX: x1, startY: y1, endX: x2, endY: y2 },
            options.searchScrollBounds,
          )
        : { startX: x1, startY: y1, endX: x2, endY: y2 };
      const searchDuration = new DefaultElementGeometry().getSwipeDurationFromSpeed("slow");
      const fallback = () =>
        this.executeAndroidSwipe(
          coordinates.startX,
          coordinates.startY,
          coordinates.endX,
          coordinates.endY,
          { duration: searchDuration, scrollMode: "adb", displayFence: options.displayFence },
          perf,
          signal,
        );
      if (options.scrollMode === "adb") {
        return fallback();
      }
      return executeAndroidSearchDrag({
        client: AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory),
        x1: coordinates.startX,
        y1: coordinates.startY,
        x2: coordinates.endX,
        y2: coordinates.endY,
        duration: searchDuration,
        signal,
        searchDragState: options.searchDragState,
        onFallback: options.onSearchFallback,
        fallback,
        beforeSend: () => options.displayFence?.assertCurrent(),
      });
    }

    // Use accessibility service swipe if requested
    if (scrollMode === "a11y") {
      return await this.executeA11ySwipe(x1, y1, x2, y2, duration, perf, signal, {
        displayFence: options.displayFence,
      });
    }

    // Default ADB mode
    try {
      await perf.track("adbInputSwipe", async () => {
        throwIfAborted(signal);
        // Once beforeSend lands, also pass this as the dispatch's beforeSend.
        options.displayFence?.assertCurrent();
        await this.adb.executeCommand(
          `shell input swipe ${x1} ${y1} ${x2} ${y2} ${inputDurationArgument(duration)}`,
          undefined,
          undefined,
          undefined,
          signal,
        );
      });
      throwIfAborted(signal);
    } catch (error) {
      if (error instanceof StaleDisplayError) {
        throw error;
      }
      throwIfAborted(signal);
      logger.warn(`[SWIPE] ADB swipe failed: ${errorMessage(error)}`);
      return { success: false, x1, y1, x2, y2, duration, error: errorMessage(error) };
    }

    return {
      success: true,
      x1,
      y1,
      x2,
      y2,
      duration,
    };
  }

  /**
   * Execute swipe using accessibility service's dispatchGesture API.
   * This is significantly faster than ADB's input swipe command.
   * @param x1 - Starting X coordinate
   * @param y1 - Starting Y coordinate
   * @param x2 - Ending X coordinate
   * @param y2 - Ending Y coordinate
   * @param duration - Swipe duration in milliseconds
   * @param perf - Performance tracker for timing
   * @returns Result of the swipe operation
   */
  // oxlint-disable-next-line max-params -- Keep the signal adjacent to the dispatch arguments.
  private async executeA11ySwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration: number,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
    fenceOptions: DisplayFenceOption = {},
  ): Promise<SwipeResult> {
    const fence = resolveDisplayFence(fenceOptions);
    let dispatched = false;
    const indeterminateResult = (reason: string): SwipeResult => ({
      success: false,
      outcomeIndeterminate: true,
      x1,
      y1,
      x2,
      y2,
      duration,
      error: `Swipe outcome is indeterminate: the request was dispatched but no result was confirmed (${reason}). Do not retry automatically.`,
    });
    let fallbackReason: string | undefined;
    let fallbackSource = "failure";
    try {
      throwIfAborted(signal);
      const client = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
      const result = await perf.track("a11ySwipe", async () => {
        throwIfAborted(signal);
        // Once beforeSend lands, also pass this as the dispatch's beforeSend.
        fence.assertCurrent();
        return await client.requestSwipe(x1, y1, x2, y2, duration, 5000, perf, undefined, () => {
          dispatched = true;
        });
      });
      throwIfAborted(signal);
      if (result.success) {
        logger.info(
          `[SWIPE] A11y swipe successful: deviceTotal=${result.totalTimeMs}ms, gesture=${result.gestureTimeMs}ms`,
        );
        return {
          success: true,
          x1,
          y1,
          x2,
          y2,
          duration,
          a11yTotalTimeMs: result.totalTimeMs,
          a11yGestureTimeMs: result.gestureTimeMs,
        };
      }
      if (dispatched) {
        logger.warn(`[SWIPE] A11y swipe outcome indeterminate: ${result.error}`);
        return indeterminateResult(result.error ?? "unknown error");
      }
      logger.warn(`[SWIPE] A11y swipe failed: ${result.error}, falling back to ADB`);
      fallbackReason = result.error;
    } catch (error) {
      if (error instanceof StaleDisplayError) {
        throw error;
      }
      throwIfAborted(signal);
      if (dispatched) {
        logger.warn(`[SWIPE] A11y swipe outcome indeterminate: ${error}`);
        return indeterminateResult(`${error}`);
      }
      logger.warn(`[SWIPE] A11y swipe exception: ${error}, falling back to ADB`);
      fallbackReason = errorMessage(error);
      fallbackSource = "exception";
    }

    // Both pre-dispatch rejection paths share the same fenced ADB fallback.
    try {
      await perf.track("adbInputSwipeFallback", async () => {
        throwIfAborted(signal);
        // Once beforeSend lands, also pass this as the dispatch's beforeSend.
        fence.assertCurrent();
        await this.adb.executeCommand(
          `shell input swipe ${x1} ${y1} ${x2} ${y2} ${inputDurationArgument(duration)}`,
          undefined,
          undefined,
          undefined,
          signal,
        );
      });
      throwIfAborted(signal);
    } catch (error) {
      if (error instanceof StaleDisplayError) {
        throw error;
      }
      throwIfAborted(signal);
      logger.warn(
        `[SWIPE] ADB fallback failed after a11y ${fallbackSource}: ${errorMessage(error)}`,
      );
      return {
        success: false,
        x1,
        y1,
        x2,
        y2,
        duration,
        fallbackReason,
        error: `Accessibility swipe failed: ${fallbackReason ?? "unknown error"}; ADB fallback failed: ${errorMessage(error)}`,
      };
    }
    return { success: true, x1, y1, x2, y2, duration, fallbackReason };
  }

  /**
   * Execute iOS-specific swipe gesture
   * @param x1 - Starting X coordinate
   * @param y1 - Starting Y coordinate
   * @param x2 - Ending X coordinate
   * @param y2 - Ending Y coordinate
   * @param options - Additional gesture options
   * @param perf - Performance tracker for timing
   * @returns Result of the swipe operation
   */
  // oxlint-disable-next-line max-params -- Keep the signal adjacent to the dispatch arguments.
  private async executeiOSSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    options: FencedGestureOptions = {},
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<SwipeResult> {
    const duration = options.duration || 300;
    return await this.executeXCTestSwipe(x1, y1, x2, y2, duration, perf, signal, options);
  }

  /**
   * Execute swipe using CtrlProxy iOS's gesture API.
   * This uses the WebSocket-based CtrlProxy iOS for faster, more reliable gestures.
   * @param x1 - Starting X coordinate
   * @param y1 - Starting Y coordinate
   * @param x2 - Ending X coordinate
   * @param y2 - Ending Y coordinate
   * @param duration - Swipe duration in milliseconds
   * @param perf - Performance tracker for timing
   * @returns Result of the swipe operation
   */
  // oxlint-disable-next-line max-params -- Keep the signal adjacent to the dispatch arguments.
  private async executeXCTestSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration: number,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
    options: FencedGestureOptions = {},
  ): Promise<SwipeResult> {
    const fence = options.displayFence;
    throwIfAborted(signal);
    const client = IOSCtrlProxyClient.getInstance(this.device);
    let dispatched = false;
    const indeterminateResult = (reason: string): SwipeResult => ({
      success: false,
      outcomeIndeterminate: true,
      x1,
      y1,
      x2,
      y2,
      duration,
      error: `Swipe outcome is indeterminate: the request was dispatched but no result was confirmed (${reason}). The swipe may have been applied. Do not retry automatically.`,
    });

    let result: Awaited<ReturnType<IOSCtrlProxyClient["requestSwipe"]>>;
    try {
      result = await perf.track("xctestSwipe", async () => {
        throwIfAborted(signal);
        // Once beforeSend lands, also pass this as the dispatch's beforeSend.
        fence?.assertCurrent();
        return await client.requestSwipe(
          x1,
          y1,
          x2,
          y2,
          duration,
          Math.min(5_000, options.timeoutMs ?? 5_000),
          perf,
          options.lockScreen === true ? { lockScreen: true } : undefined,
          signal,
          () => {
            dispatched = true;
          },
        );
      });
    } catch (error) {
      // An ActionableError (runner refusal, stale display) is a definite answer, not a lost reply.
      if (!dispatched || error instanceof ActionableError) {
        throw error;
      }
      logger.warn(`[SWIPE] CtrlProxy iOS swipe outcome indeterminate: ${errorMessage(error)}`);
      return indeterminateResult(errorMessage(error));
    }
    // Only a runner reply (success or refusal) is acknowledged; a sent swipe without one may have run.
    // A reply saying the gesture finished after its deadline, or is still executing past the
    // runner's bound, is acknowledged but equally unknown.
    if (!result.success && swipeOutcomeUnknown(result, dispatched)) {
      logger.warn(`[SWIPE] CtrlProxy iOS swipe outcome indeterminate: ${result.error}`);
      return indeterminateResult(result.error ?? "unknown error");
    }
    throwIfAborted(signal);

    if (result.success) {
      logger.info(
        `[SWIPE] CtrlProxy iOS swipe successful: deviceTotal=${result.totalTimeMs}ms, gesture=${result.gestureTimeMs}ms`,
      );
      return {
        success: true,
        x1,
        y1,
        x2,
        y2,
        duration,
        a11yTotalTimeMs: result.totalTimeMs,
        a11yGestureTimeMs: result.gestureTimeMs,
      };
    } else {
      logger.error(`[SWIPE] CtrlProxy iOS swipe failed: ${result.error}`);
      return {
        success: false,
        x1,
        y1,
        x2,
        y2,
        duration,
        error: result.error,
      };
    }
  }

  /**
   * Execute a gesture by sending a series of touch events
   * Note: This method executes the raw gesture command without observation.
   * Callers that need observation should use observedInteraction at a higher level.
   * @param path - Points to follow during the gesture
   * @param duration - Duration in milliseconds
   * @returns Result of the executed gesture
   */
  async execute(
    path: Point[] | FingerPath[],
    duration: number = 300,
    signal?: AbortSignal,
    fenceOptions: DisplayFenceOption = {},
  ): Promise<any> {
    const fence = fenceOptions.displayFence;
    throwIfAborted(signal);
    // Platform-specific gesture execution (no observedInteraction - caller handles observation)
    switch (this.device.platform) {
      case "android":
        return await this.executeAndroidGesture(path, duration, signal, { displayFence: fence });
      case "ios":
        return await this.executeiOSGesture(path, duration, signal, { displayFence: fence });
      default:
        throw unsupportedPlatformError(this.device.platform, "execute gesture");
    }
  }

  /**
   * Execute Android-specific gesture
   */
  private async executeAndroidGesture(
    path: Point[] | FingerPath[],
    duration: number,
    signal?: AbortSignal,
    fenceOptions: DisplayFenceOption = {},
  ): Promise<any> {
    const fence = fenceOptions.displayFence;
    // Generate and execute adb touch events
    if (Array.isArray(path) && path.length > 0) {
      if ("finger" in path[0]) {
        // Multi-finger gestures are not supported without sendevent
        throw new Error("Multi-finger gestures not supported - use simple swipe instead");
      } else {
        // Single finger path - convert to simple swipe
        const points = path as Point[];
        if (points.length >= 2) {
          const start = points[0];
          const end = points[points.length - 1];

          throwIfAborted(signal);
          // Once beforeSend lands, also pass this as the dispatch's beforeSend.
          fence?.assertCurrent();
          await this.adb.executeCommand(
            `shell input swipe ${start.x} ${start.y} ${end.x} ${end.y} ${inputDurationArgument(duration)}`,
            undefined,
            undefined,
            undefined,
            signal,
          );
          throwIfAborted(signal);
        }
      }
    }

    return {
      pathLength: path.length,
      duration,
      platform: "android",
    };
  }

  /**
   * Execute iOS-specific gesture
   */
  private async executeiOSGesture(
    path: Point[] | FingerPath[],
    duration: number,
    signal?: AbortSignal,
    fenceOptions: DisplayFenceOption = {},
  ): Promise<any> {
    const fence = fenceOptions.displayFence;
    if (Array.isArray(path) && path.length > 0) {
      if ("finger" in path[0]) {
        const fingers = path as FingerPath[];
        const swipe = this.resolveIOSMultiFingerSwipe(fingers);
        if (swipe) {
          await this.executeIOSMultiFingerSwipe(swipe, duration, signal, fence);
        }
      } else {
        // Single finger path - convert to simple swipe using CtrlProxy iOS
        const points = path as Point[];
        if (points.length >= 2) {
          await this.executeIOSSingleFingerSwipe(
            points[0],
            points[points.length - 1],
            duration,
            signal,
            fence,
          );
        }
      }
    }

    return {
      pathLength: path.length,
      duration,
      platform: "ios",
    };
  }

  private async executeIOSSingleFingerSwipe(
    start: Point,
    end: Point,
    duration: number,
    signal?: AbortSignal,
    fence?: DisplayFence,
  ): Promise<void> {
    throwIfAborted(signal);
    const client = IOSCtrlProxyClient.getInstance(this.device);
    // Once beforeSend lands, also pass this as the dispatch's beforeSend.
    fence?.assertCurrent();
    const result = await client.requestSwipe(
      start.x,
      start.y,
      end.x,
      end.y,
      duration,
      undefined,
      undefined,
      undefined,
      signal,
    );
    this.throwIfIosGestureUnconfirmed(result);
    throwIfAborted(signal);
    if (!result.success) {
      throw new ActionableError(`iOS gesture failed: ${result.error ?? "unknown error"}`);
    }
  }

  private async executeIOSMultiFingerSwipe(
    swipe: NonNullable<ReturnType<ExecuteGesture["resolveIOSMultiFingerSwipe"]>>,
    duration: number,
    signal?: AbortSignal,
    fence?: DisplayFence,
  ): Promise<void> {
    throwIfAborted(signal);
    const client = IOSCtrlProxyClient.getInstance(this.device);
    // Once beforeSend lands, also pass this as the dispatch's beforeSend.
    fence?.assertCurrent();
    const result = await client.requestMultiFingerSwipe(
      swipe.start.x,
      swipe.start.y,
      swipe.end.x,
      swipe.end.y,
      swipe.fingerCount,
      duration,
      undefined,
      undefined,
      swipe.fingerSpacing,
      signal,
    );
    this.throwIfIosGestureUnconfirmed(result);
    throwIfAborted(signal);
    if (!result.success) {
      throw new ActionableError(
        `iOS multi-finger gesture failed: ${result.error ?? "unknown error"}`,
      );
    }
  }

  /**
   * A gesture written to the runner whose reply never arrived, or whose reply says it is still
   * executing, may already have run, so it is indeterminate rather than a plain failure. A runner
   * refusal is acknowledged and stays one.
   */
  private throwIfIosGestureUnconfirmed(result: {
    success: boolean;
    error?: string;
    errorCode?: string;
    dispatched?: boolean;
    acknowledged?: boolean;
  }): void {
    if (
      !result.success &&
      result.dispatched &&
      (result.acknowledged === false || isRunnerGestureOutcomeUnknown(result))
    ) {
      throw new ActionableError(
        `Gesture outcome is indeterminate: the request was dispatched but no result was confirmed (${result.error ?? "unknown error"}). The gesture may have been applied. Do not retry automatically. Observe before retrying.`,
      );
    }
  }

  private resolveIOSMultiFingerSwipe(fingers: FingerPath[]): {
    start: Point;
    end: Point;
    fingerCount: number;
    fingerSpacing: number;
  } | null {
    if (fingers.length === 0) {
      return null;
    }

    for (let index = 0; index < fingers.length; index++) {
      const points = fingers[index].points;
      if (points.length < 2) {
        throw new Error("iOS multi-finger gestures require at least two points per finger");
      }
      if (points.length !== 2) {
        throw new Error("iOS multi-finger gestures only support two-point swipes");
      }
    }

    const firstFingerPoints = fingers[0].points;
    const firstStart = firstFingerPoints[0];
    const firstEnd = firstFingerPoints[1];
    const fingerSpacing = fingers.length > 1 ? fingers[1].points[0].x - firstStart.x : 0;

    for (let index = 0; index < fingers.length; index++) {
      const points = fingers[index].points;

      const start = points[0];
      const end = points[1];
      const expectedOffset = index * fingerSpacing;
      if (
        !this.sameCoordinate(start.y, firstStart.y) ||
        !this.sameCoordinate(end.y, firstEnd.y) ||
        !this.sameCoordinate(start.x - firstStart.x, expectedOffset) ||
        !this.sameCoordinate(end.x - firstEnd.x, expectedOffset)
      ) {
        throw new Error(
          "iOS multi-finger gestures only support horizontally spaced parallel swipes",
        );
      }
    }

    return {
      start: firstStart,
      end: firstEnd,
      fingerCount: fingers.length,
      fingerSpacing,
    };
  }

  private sameCoordinate(a: number, b: number): boolean {
    return Math.abs(a - b) < 0.001;
  }
}
