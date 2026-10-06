import type { DisplayFence } from "../action/BaseVisualChange";
import type { Element } from "../../models/Element";
import type { ScreenSize } from "../../models/ScreenSize";
import {
  ActionableError,
  type BootedDevice,
  type CurrentFocusResult,
  type TraversalOrderResult,
} from "../../models";
import type { ElementSelector as FocusElementSelector } from "./ElementSelector";
import { DeviceDetection } from "../../utils/DeviceDetection";
import { isDeviceLostError } from "../../models/DeviceLostError";
import { combineWithAmbientAbort, getRequestContext } from "../../utils/AbortContext";
import { errorMessage } from "../../utils/describeUnknownError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient, type A11ySwipeResult } from "../observe/android";
import { FocusElementMatcher } from "./FocusElementMatcher";
import { FocusPathCalculator, type FocusNavigationPath } from "./FocusPathCalculator";

interface NavigationOptions {
  displayFence?: DisplayFence;
  maxSwipes?: number;
  verificationInterval?: number;
  swipeDelay?: number;
  onFocusObserved?: (element: Element | null) => void;
  /** Called immediately before a swipe request; even failed requests may move the screen. */
  onSwipeRequested?: () => void;
  /**
   * Request cancellation. The ambient request signal is always honoured too, so a caller
   * that runs inside a request context needs no explicit signal.
   */
  signal?: AbortSignal;
}

/**
 * A request ended focus navigation (cancelled, timed out, session released, or out of time
 * budget). Deliberately not an ActionableError: callers must never treat it as a navigation
 * failure with a coordinate fallback, because the request is over.
 */
export class FocusNavigationStoppedError extends Error {}

const BUDGET_EXHAUSTED_MESSAGE = "Request time budget exhausted during focus navigation.";

/**
 * Describe a stop that happened after `swipesSent` swipe requests. Swipes move the TalkBack
 * cursor, so the device is not where the request found it. Device-loss errors keep their typed
 * carrier, and a stop before any swipe changed nothing, so both pass through unchanged.
 */
export function stoppedFocusNavigationError(error: unknown, swipesSent: number): unknown {
  if (error instanceof FocusNavigationStoppedError || isDeviceLostError(error) || swipesSent <= 0) {
    return error;
  }
  const reason = errorMessage(error);
  return new FocusNavigationStoppedError(
    `${reason.endsWith(".") ? reason : `${reason}.`} Focus navigation partially applied: ${swipesSent} swipe` +
      `${swipesSent === 1 ? "" : "s"} already moved the TalkBack cursor and the target was not ` +
      "activated. Observe before retrying; do not retry automatically.",
    { cause: error },
  );
}

/**
 * Throw when the request was cancelled or its time budget is spent. Called before every swipe
 * and before the activation, so nothing further is dispatched for a request that is over.
 */
export function assertFocusNavigationLive(
  signal: AbortSignal | undefined,
  timer: Timer,
  swipesSent: number,
): void {
  try {
    throwIfAborted(signal);
  } catch (error) {
    throw stoppedFocusNavigationError(error, swipesSent);
  }
  const deadlineMs = getRequestContext()?.getDeadlineMs?.();
  if (deadlineMs !== undefined && timer.now() >= deadlineMs) {
    throw stoppedFocusNavigationError(new Error(BUDGET_EXHAUSTED_MESSAGE), swipesSent);
  }
}

export interface FocusNavigationDriver {
  requestTraversalOrder(): Promise<TraversalOrderResult>;
  requestCurrentFocus(): Promise<CurrentFocusResult>;
  requestSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<A11ySwipeResult>;
  getScreenSize(): Promise<ScreenSize>;
}

export interface FocusNavigationDriverFactory {
  createDriver(device: BootedDevice): FocusNavigationDriver;
}

interface NavigationVerification {
  orderedElements: Element[];
  currentFocus: Element | null;
  targetIndex: number | null;
  reachedTarget: boolean;
  truncationReasons?: string[];
}

interface FocusNavigationExecutorDependencies {
  matcher?: FocusElementMatcher;
  pathCalculator?: FocusPathCalculator;
  timer?: Timer;
  driverFactory?: FocusNavigationDriverFactory;
  deviceResolver?: (deviceId: string) => BootedDevice;
}

class DefaultFocusNavigationDriver implements FocusNavigationDriver {
  private accessibilityService: AndroidCtrlProxyClient;
  constructor(accessibilityService: AndroidCtrlProxyClient) {
    this.accessibilityService = accessibilityService;
  }

  async requestTraversalOrder(): Promise<TraversalOrderResult> {
    return this.accessibilityService.requestTraversalOrder();
  }

  async requestCurrentFocus(): Promise<CurrentFocusResult> {
    return this.accessibilityService.requestCurrentFocus();
  }

  async requestSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<A11ySwipeResult> {
    return this.accessibilityService.requestSwipe(
      x1,
      y1,
      x2,
      y2,
      durationMs,
      undefined,
      undefined,
      undefined,
      undefined,
      signal,
    );
  }

  async getScreenSize(): Promise<ScreenSize> {
    const hierarchy = await this.accessibilityService.getAccessibilityHierarchy(
      undefined,
      undefined,
      true,
    );
    if (!hierarchy?.screenWidth || !hierarchy.screenHeight) {
      throw new ActionableError(
        "CtrlProxy did not provide screen dimensions for TalkBack navigation",
      );
    }
    return { width: hierarchy.screenWidth, height: hierarchy.screenHeight };
  }
}

class DefaultFocusNavigationDriverFactory implements FocusNavigationDriverFactory {
  createDriver(device: BootedDevice): FocusNavigationDriver {
    return new DefaultFocusNavigationDriver(AndroidCtrlProxyClient.getInstance(device));
  }
}

export class FocusNavigationExecutor {
  private static readonly DEFAULT_MAX_SWIPES = 100;
  private static readonly DEFAULT_VERIFICATION_INTERVAL = 5;
  private static readonly DEFAULT_SWIPE_DELAY_MS = 100;
  private static readonly DEFAULT_SWIPE_DURATION_MS = 150;
  private static readonly DEFAULT_MAX_STUCK_CHECKS = 2;

  private matcher: FocusElementMatcher;
  private pathCalculator: FocusPathCalculator;
  private timer: Timer;
  private driverFactory: FocusNavigationDriverFactory;
  private deviceResolver: (deviceId: string) => BootedDevice;

  constructor(dependencies: FocusNavigationExecutorDependencies = {}) {
    this.matcher = dependencies.matcher ?? new FocusElementMatcher();
    this.pathCalculator = dependencies.pathCalculator ?? new FocusPathCalculator(this.matcher);
    this.timer = dependencies.timer ?? defaultTimer;
    this.driverFactory = dependencies.driverFactory ?? new DefaultFocusNavigationDriverFactory();
    this.deviceResolver = dependencies.deviceResolver ?? this.resolveDevice;
  }

  async navigateToElement(
    deviceId: string,
    targetSelector: FocusElementSelector,
    path: FocusNavigationPath,
    options: NavigationOptions = {},
  ): Promise<boolean> {
    const signal = combineWithAmbientAbort(options.signal);
    const progress = { swipesSent: 0 };
    try {
      return await this.runNavigation(
        deviceId,
        targetSelector,
        path,
        {
          ...options,
          signal,
          onSwipeRequested: () => {
            progress.swipesSent += 1;
            options.onSwipeRequested?.();
          },
        },
        progress,
      );
    } catch (error) {
      // A request that ended mid-navigation (even an in-flight read rejected by the abort)
      // must say the cursor already moved, whatever error the interrupted call raised.
      throw signal?.aborted ? stoppedFocusNavigationError(error, progress.swipesSent) : error;
    }
  }

  private async runNavigation(
    deviceId: string,
    targetSelector: FocusElementSelector,
    path: FocusNavigationPath,
    options: NavigationOptions,
    progress: { swipesSent: number },
  ): Promise<boolean> {
    const { signal } = options;
    const maxSwipes = options.maxSwipes ?? FocusNavigationExecutor.DEFAULT_MAX_SWIPES;
    const verificationInterval = Math.max(
      1,
      options.verificationInterval ?? FocusNavigationExecutor.DEFAULT_VERIFICATION_INTERVAL,
    );
    const swipeDelay = Math.max(
      0,
      options.swipeDelay ?? FocusNavigationExecutor.DEFAULT_SWIPE_DELAY_MS,
    );

    if (path.swipeCount > maxSwipes) {
      throw new ActionableError(
        `Target requires ${path.swipeCount} swipes (max: ${maxSwipes}). ` +
          "Try scrolling the container first or narrow the selector.",
      );
    }

    const device = this.deviceResolver(deviceId);
    if (device.platform !== "android") {
      throw new ActionableError("TalkBack focus navigation is only supported on Android devices.");
    }

    const driver = this.driverFactory.createDriver(device);
    const screenSize = await driver.getScreenSize();
    this.validateScreenSize(screenSize);

    let currentPath = path;
    let remainingSwipes = currentPath.swipeCount;
    let totalSwipes = 0;
    const navigationProgress = {
      lastFocusSignature: null as string | null,
      noProgressChecks: 0,
      bestDistance: Number.POSITIVE_INFINITY,
    };

    if (remainingSwipes === 0) {
      assertFocusNavigationLive(signal, this.timer, progress.swipesSent);
      const initialVerification = await this.verifyNavigationState(driver, targetSelector, signal);
      if (initialVerification.reachedTarget) {
        options.onFocusObserved?.(initialVerification.currentFocus);
        return true;
      }
      options.onFocusObserved?.(initialVerification.currentFocus);
      const recalculated = this.recalculateVerifiedPath(
        initialVerification,
        targetSelector,
        "Target not found",
      );
      if (recalculated.swipeCount > maxSwipes) {
        throw new ActionableError(
          `Target requires ${recalculated.swipeCount} swipes (max: ${maxSwipes}). ` +
            "Try scrolling the container first or narrow the selector.",
        );
      }
      currentPath = recalculated;
      remainingSwipes = recalculated.swipeCount;
    }

    while (remainingSwipes > 0) {
      assertFocusNavigationLive(signal, this.timer, progress.swipesSent);
      await this.performFocusSwipe(driver, currentPath.direction, screenSize, options);
      totalSwipes += 1;
      remainingSwipes -= 1;

      if (totalSwipes > maxSwipes) {
        throw new ActionableError(
          `Focus navigation exceeded max swipes (${maxSwipes}). ` +
            "Try scrolling the container first or narrow the selector.",
        );
      }

      if (swipeDelay > 0) {
        await awaitWhileRequestIsLive(this.timer.sleep(swipeDelay), signal);
      }
      assertFocusNavigationLive(signal, this.timer, progress.swipesSent);

      const shouldVerify = remainingSwipes === 0 || totalSwipes % verificationInterval === 0;
      // Fidelity reporting observes each cursor step, but keeps path
      // recalculation and the non-convergence guard at their configured cadence.
      // A TalkBack focus event can lag several swipes; counting every sample as
      // a failed verification would turn that normal delay into a false trap.
      let verification: NavigationVerification | undefined;
      if (options.onFocusObserved) {
        verification = await this.verifyNavigationState(driver, targetSelector, signal);
        options.onFocusObserved(verification.currentFocus);
        if (verification.reachedTarget) {
          return true;
        }
      }
      if (!shouldVerify) {
        continue;
      }

      verification ??= await this.verifyNavigationState(driver, targetSelector, signal);
      options.onFocusObserved?.(verification.currentFocus);

      if (verification.reachedTarget) {
        return true;
      }

      const recalculated = this.recalculateVerifiedPath(
        verification,
        targetSelector,
        "Target element disappeared during navigation",
      );

      this.checkNavigationProgress(verification, recalculated, navigationProgress);

      if (this.shouldRecalculatePath(currentPath, recalculated)) {
        const remainingAllowed = maxSwipes - totalSwipes;
        if (recalculated.swipeCount > remainingAllowed) {
          throw new ActionableError(
            `Target requires ${recalculated.swipeCount} additional swipes (max remaining: ${remainingAllowed}). ` +
              "Try scrolling the container first or narrow the selector.",
          );
        }
        currentPath = recalculated;
        remainingSwipes = recalculated.swipeCount;
      }
    }

    assertFocusNavigationLive(signal, this.timer, progress.swipesSent);
    const finalVerification = await this.verifyNavigationState(driver, targetSelector, signal);
    options.onFocusObserved?.(finalVerification.currentFocus);
    return finalVerification.reachedTarget;
  }

  private validateScreenSize(screenSize: ScreenSize): void {
    if (
      !screenSize ||
      !Number.isFinite(screenSize.width) ||
      !Number.isFinite(screenSize.height) ||
      screenSize.width <= 0 ||
      screenSize.height <= 0
    ) {
      throw new ActionableError("Unable to determine screen size for focus navigation.");
    }
  }

  private recalculateVerifiedPath(
    verification: NavigationVerification,
    targetSelector: FocusElementSelector,
    missingTargetPrefix: string,
  ): FocusNavigationPath {
    if (verification.targetIndex === null) {
      throw new ActionableError(
        `${missingTargetPrefix} (${this.describeSelector(targetSelector)}). ` +
          "Use observe to inspect elements and the diagnostics returned by tapOn/waitFor failures." +
          this.describeTraversalTruncation(verification),
      );
    }

    const recalculated = this.pathCalculator.calculatePath(
      verification.currentFocus,
      targetSelector,
      verification.orderedElements,
    );
    if (!recalculated) {
      throw new ActionableError(
        `${missingTargetPrefix} (${this.describeSelector(targetSelector)}). ` +
          "Use observe to inspect elements and the diagnostics returned by tapOn/waitFor failures." +
          this.describeTraversalTruncation(verification),
      );
    }
    return recalculated;
  }

  private checkNavigationProgress(
    verification: NavigationVerification,
    recalculated: FocusNavigationPath,
    progress: { lastFocusSignature: string | null; bestDistance: number; noProgressChecks: number },
  ): void {
    // Progress guard (#3917): the distance to the target is the recalculated
    // swipe count when the cursor is resolved, and unknown when the cursor
    // can't be located in the traversal order. If we fail to get closer for
    // several consecutive checks, bail instead of swiping in a (possibly wrong)
    // direction until maxSwipes — this catches a cursor moving the wrong way or
    // one we can't track. When the cursor is resolvable, an initially wrong
    // direction is still corrected below via shouldRecalculatePath.
    const focusSignature = this.buildFocusSignature(verification.currentFocus);
    const focusMoved = focusSignature === null || focusSignature !== progress.lastFocusSignature;
    progress.lastFocusSignature = focusSignature;

    const distanceToTarget =
      recalculated.currentFocusIndex === null ? null : recalculated.swipeCount;
    if (distanceToTarget !== null && distanceToTarget < progress.bestDistance) {
      progress.bestDistance = distanceToTarget;
      progress.noProgressChecks = 0;
    } else {
      progress.noProgressChecks += 1;
      if (progress.noProgressChecks >= FocusNavigationExecutor.DEFAULT_MAX_STUCK_CHECKS) {
        if (!focusMoved) {
          throw new ActionableError(
            "Focus did not move after multiple swipes. " +
              "Try scrolling the container or ensure the element is focusable.",
          );
        }
        throw new ActionableError(
          distanceToTarget === null
            ? "Focus navigation could not track the TalkBack cursor position. " +
                "Try scrolling the container first or narrow the selector."
            : "Focus navigation is not converging on the target. " +
                "Try scrolling the container first or narrow the selector.",
        );
      }
    }
  }

  private resolveDevice(deviceId: string): BootedDevice {
    const platform = DeviceDetection.detectPlatform(deviceId);
    return {
      name: deviceId,
      deviceId,
      platform,
    };
  }

  private async performFocusSwipe(
    driver: FocusNavigationDriver,
    direction: "forward" | "backward",
    screenSize: ScreenSize,
    options: NavigationOptions,
  ): Promise<void> {
    const { x1, y1, x2, y2 } = this.getSwipeCoordinates(direction, screenSize);
    // Once beforeSend lands, also pass this as the dispatch's beforeSend.
    options.displayFence?.assertCurrent();
    options.onSwipeRequested?.();
    const result = await awaitWhileRequestIsLive(
      driver.requestSwipe(
        x1,
        y1,
        x2,
        y2,
        FocusNavigationExecutor.DEFAULT_SWIPE_DURATION_MS,
        options.signal,
      ),
      options.signal,
    );
    if (!result.success) {
      throw new ActionableError(result.error || "Failed to perform focus swipe.");
    }
  }

  private getSwipeCoordinates(
    direction: "forward" | "backward",
    screenSize: ScreenSize,
  ): { x1: number; y1: number; x2: number; y2: number } {
    const midY = Math.round(screenSize.height * 0.5);
    const padding = Math.round(screenSize.width * 0.2);
    const startX = direction === "forward" ? padding : screenSize.width - padding;
    const endX = direction === "forward" ? screenSize.width - padding : padding;
    return { x1: startX, y1: midY, x2: endX, y2: midY };
  }

  private async verifyNavigationState(
    driver: FocusNavigationDriver,
    targetSelector: FocusElementSelector,
    signal?: AbortSignal,
  ): Promise<NavigationVerification> {
    const traversal = await awaitWhileRequestIsLive(driver.requestTraversalOrder(), signal);
    if (traversal.error) {
      throw new ActionableError(`Failed to get traversal order: ${traversal.error}`);
    }

    const orderedElements = traversal.elements ?? [];
    const targetIndex = this.matcher.findTargetIndex(orderedElements, targetSelector);

    let currentFocus: Element | null = null;
    if (traversal.focusedIndex !== null && traversal.focusedIndex !== undefined) {
      currentFocus = orderedElements[traversal.focusedIndex] ?? null;
    }
    if (!currentFocus) {
      const focusResult = await awaitWhileRequestIsLive(driver.requestCurrentFocus(), signal);
      if (focusResult.error) {
        logger.warn(`[FocusNavigation] Failed to get current focus: ${focusResult.error}`);
      }
      currentFocus = focusResult.focusedElement ?? null;
    }

    const reachedTarget = currentFocus
      ? this.matcher.matchesFocusedTarget(currentFocus, orderedElements, targetSelector)
      : false;

    return {
      orderedElements,
      currentFocus,
      targetIndex,
      reachedTarget,
      truncationReasons: traversal.truncationReasons,
    };
  }

  private describeTraversalTruncation(verification: NavigationVerification): string {
    return verification.truncationReasons?.includes("max_children")
      ? " the accessibility traversal was truncated (max_children); the target may be beyond the cap."
      : "";
  }

  private buildFocusSignature(element: Element | null): string | null {
    if (!element) {
      return null;
    }
    const resourceId =
      element["resource-id"] ?? (element as { resourceId?: string }).resourceId ?? "";
    const contentDesc =
      element["content-desc"] ?? (element as { contentDesc?: string }).contentDesc ?? "";
    const testTag = element["test-tag"] ?? (element as { testTag?: string }).testTag ?? "";
    const text = element.text ?? "";
    const bounds = element.bounds
      ? `${element.bounds.left},${element.bounds.top},${element.bounds.right},${element.bounds.bottom}`
      : "no-bounds";
    return `${resourceId}|${contentDesc}|${testTag}|${text}|${bounds}`;
  }

  private shouldRecalculatePath(
    currentPath: FocusNavigationPath,
    recalculated: FocusNavigationPath,
  ): boolean {
    return (
      currentPath.targetFocusIndex !== recalculated.targetFocusIndex ||
      currentPath.direction !== recalculated.direction ||
      currentPath.swipeCount !== recalculated.swipeCount ||
      (currentPath.currentFocusIndex ?? 0) !== (recalculated.currentFocusIndex ?? 0)
    );
  }

  private describeSelector(selector: FocusElementSelector): string {
    const parts: string[] = [];
    if (selector.resourceId) {
      parts.push(`resourceId="${selector.resourceId}"`);
    }
    if (selector.text) {
      parts.push(`text="${selector.text}"`);
    }
    if (selector.contentDesc) {
      parts.push(`contentDesc="${selector.contentDesc}"`);
    }
    if (selector.testTag) {
      parts.push(`testTag="${selector.testTag}"`);
    }
    return parts.length > 0 ? parts.join(", ") : "unknown selector";
  }
}
