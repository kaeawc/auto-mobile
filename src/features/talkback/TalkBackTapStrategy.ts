import type { Element } from "../../models/Element";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { FocusElementMatcher } from "./FocusElementMatcher";
import { FocusNavigationExecutor } from "./FocusNavigationExecutor";
import { FocusPathCalculator } from "./FocusPathCalculator";
import type { TalkBackNavigationDriver } from "./TalkBackNavigationDriver";

export interface TalkBackTapResult {
  success: boolean;
  /**
   * - "focus-navigation": navigated via swipe gestures and activated with double-tap
   * - "accessibility-action": dispatched a direct accessibility action (ACTION_CLICK / ACTION_LONG_CLICK)
   * - "coordinate-fallback": fell back to coordinate-based gesture dispatch
   */
  method: "focus-navigation" | "accessibility-action" | "coordinate-fallback";
  error?: string;
}

export type TalkBackTapAction = "tap" | "doubleTap";
export type TalkBackFallbackAction = "tap" | "doubleTap" | "longPress";

interface TalkBackTapStrategyDependencies {
  matcher?: FocusElementMatcher;
  pathCalculator?: FocusPathCalculator;
  executor?: FocusNavigationExecutor;
  timer?: Timer;
}

/**
 * Orchestrates TalkBack focus navigation and element activation.
 *
 * This strategy handles:
 * 1. Focus navigation to target element using swipe gestures
 * 2. Element activation via double-tap or ACTION_CLICK fallback
 * 3. Coordinate-based fallback when focus navigation fails
 */
export class TalkBackTapStrategy {
  private matcher: FocusElementMatcher;
  private pathCalculator: FocusPathCalculator;
  private executor: FocusNavigationExecutor;
  private timer: Timer;

  constructor(dependencies: TalkBackTapStrategyDependencies = {}) {
    this.matcher = dependencies.matcher ?? new FocusElementMatcher();
    this.pathCalculator = dependencies.pathCalculator ?? new FocusPathCalculator(this.matcher);
    this.executor = dependencies.executor ?? new FocusNavigationExecutor({
      matcher: this.matcher,
      pathCalculator: this.pathCalculator,
      timer: dependencies.timer
    });
    this.timer = dependencies.timer ?? defaultTimer;
  }

  /**
   * Execute a tap on an element using TalkBack focus navigation.
   *
   * This method:
   * 1. Builds a selector from the element
   * 2. Gets the current traversal order and focus
   * 3. Calculates a navigation path to the target
   * 4. Navigates to the element
   * 5. Activates it with double-tap (with ACTION_CLICK fallback)
   *
   * @param deviceId - The device ID
   * @param element - The target element (must have at least one of resource-id, text, or content-desc)
   * @param action - The action to perform ("tap" or "doubleTap")
   * @param driver - The TalkBack navigation driver
   * @returns Result indicating success/failure and method used
   */
  async executeTap(
    deviceId: string,
    element: Element,
    action: TalkBackTapAction,
    driver: TalkBackNavigationDriver
  ): Promise<TalkBackTapResult> {
    const resourceId = element?.["resource-id"] as string | undefined;
    const elementText = element.text as string | undefined;
    const elementContentDesc = element["content-desc"] as string | undefined;

    if (!resourceId && !elementText && !elementContentDesc) {
      return {
        success: false,
        method: "focus-navigation",
        error: "Element has no resource-id, text, or content-desc for navigation"
      };
    }

    try {
      logger.debug(`[TalkBackTapStrategy] Attempting focus navigation to element (resourceId: ${resourceId}, text: ${elementText})`);

      // Build selector from available fields (include bounds for disambiguation in list views)
      const targetSelector = {
        ...(resourceId ? { resourceId } : {}),
        ...(elementText ? { text: elementText } : {}),
        ...(elementContentDesc ? { contentDesc: elementContentDesc } : {}),
        bounds: element.bounds
      };

      // Get traversal order and current focus
      const traversalResult = await driver.requestTraversalOrder();
      if (traversalResult.error || !traversalResult.elements) {
        return {
          success: false,
          method: "focus-navigation",
          error: `Failed to get traversal order: ${traversalResult.error}`
        };
      }

      const orderedElements = traversalResult.elements;
      let currentFocus: Element | null = null;

      // Try to get current focus from traversal result first
      if (traversalResult.focusedIndex !== null && traversalResult.focusedIndex !== undefined) {
        currentFocus = orderedElements[traversalResult.focusedIndex] ?? null;
      }

      // If not available, request current focus separately
      if (!currentFocus) {
        const focusResult = await driver.requestCurrentFocus();
        if (!focusResult.error && focusResult.focusedElement) {
          currentFocus = focusResult.focusedElement;
        }
      }

      // Calculate navigation path
      const navigationPath = this.pathCalculator.calculatePath(
        currentFocus,
        targetSelector,
        orderedElements,
        5 // verification interval
      );

      if (!navigationPath) {
        return {
          success: false,
          method: "focus-navigation",
          error: "Could not calculate navigation path to target element"
        };
      }

      logger.debug(
        `[TalkBackTapStrategy] Calculated path: ${navigationPath.swipeCount} swipes ${navigationPath.direction}`
      );

      // Navigate to element
      const navigationSuccess = await this.executor.navigateToElement(
        deviceId,
        targetSelector,
        navigationPath,
        {
          maxSwipes: 100,
          verificationInterval: 5,
          swipeDelay: 100
        }
      );

      if (!navigationSuccess) {
        return {
          success: false,
          method: "focus-navigation",
          error: "Focus navigation did not reach target element"
        };
      }

      logger.info(`[TalkBackTapStrategy] Focus navigation successful, activating element`);

      // Activate the focused element with double-tap gesture
      const activationResult = await this.activateElement(element, driver);
      return activationResult;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[TalkBackTapStrategy] Focus navigation failed: ${errorMessage}`);
      return {
        success: false,
        method: "focus-navigation",
        error: errorMessage
      };
    }
  }

  /**
   * Directly activate the target element via ACTION_CLICK, without moving the
   * TalkBack cursor.
   *
   * This is the default screen-reader activation model (#3936): deterministic,
   * a single accessibility action, and immune to the cursor-navigation failure
   * modes of {@link executeTap}. It requires a resource-id to resolve the node;
   * callers fall back to a coordinate gesture when this returns unsuccessful
   * (e.g. no resource-id, or the node rejects the action).
   *
   * @param element - The target element (must have a resource-id to activate directly)
   * @param driver - The TalkBack navigation driver
   * @returns Result indicating success/failure; method is "accessibility-action"
   */
  async executeDirectActivation(
    element: Element,
    driver: TalkBackNavigationDriver
  ): Promise<TalkBackTapResult> {
    const resourceId = element["resource-id"] as string | undefined;
    if (!resourceId) {
      return {
        success: false,
        method: "accessibility-action",
        error: "Element has no resource-id for direct accessibility activation"
      };
    }

    const result = await driver.requestAction("click", resourceId);
    if (result.success) {
      logger.info(`[TalkBackTapStrategy] Direct activation via ACTION_CLICK succeeded`);
      return { success: true, method: "accessibility-action" };
    }

    return {
      success: false,
      method: "accessibility-action",
      error: result.error ?? "ACTION_CLICK failed"
    };
  }

  /**
   * Execute a coordinate-based tap as a fallback when focus navigation fails or isn't applicable.
   *
   * @param x - X coordinate
   * @param y - Y coordinate
   * @param action - The action to perform
   * @param durationMs - Duration for the tap (used for longPress)
   * @param driver - The TalkBack navigation driver
   * @returns Result indicating success/failure
   */
  async executeCoordinateFallback(
    x: number,
    y: number,
    action: TalkBackFallbackAction,
    durationMs: number,
    driver: TalkBackNavigationDriver
  ): Promise<TalkBackTapResult> {
    const tapDuration = action === "longPress" ? durationMs : 50;

    if (action === "doubleTap") {
      // First tap
      const firstResult = await driver.requestTapCoordinates(x, y, tapDuration);
      if (!firstResult.success) {
        return {
          success: false,
          method: "coordinate-fallback",
          error: `First tap failed: ${firstResult.error}`
        };
      }

      // Wait between taps (standard double-tap interval)
      await this.timer.sleep(200);

      // Second tap
      const secondResult = await driver.requestTapCoordinates(x, y, tapDuration);
      if (!secondResult.success) {
        return {
          success: false,
          method: "coordinate-fallback",
          error: `Second tap failed: ${secondResult.error}`
        };
      }

      return { success: true, method: "coordinate-fallback" };
    }

    // Single tap or long press
    const result = await driver.requestTapCoordinates(x, y, tapDuration);
    if (!result.success) {
      return {
        success: false,
        method: "coordinate-fallback",
        error: result.error
      };
    }

    return { success: true, method: "coordinate-fallback" };
  }

  /**
   * Execute a long press on an element using ACTION_LONG_CLICK with coordinate gesture fallback.
   *
   * Tries ACTION_LONG_CLICK first (requires resource-id), then falls back to
   * a coordinate-based long press gesture via the accessibility service.
   *
   * @param x - X coordinate (for coordinate fallback)
   * @param y - Y coordinate (for coordinate fallback)
   * @param durationMs - Long press duration in milliseconds
   * @param element - The target element
   * @param driver - The TalkBack navigation driver
   * @returns Result indicating success/failure and method used
   */
  async executeLongPress(
    x: number,
    y: number,
    durationMs: number,
    element: Element,
    driver: TalkBackNavigationDriver
  ): Promise<TalkBackTapResult> {
    const resourceId = element["resource-id"] as string | undefined;

    if (resourceId) {
      const longClickResult = await driver.requestAction("long_click", resourceId);
      if (longClickResult.success) {
        logger.info(`[TalkBackTapStrategy] Long press via ACTION_LONG_CLICK succeeded`);
        return { success: true, method: "accessibility-action" };
      }
      logger.warn(
        `[TalkBackTapStrategy] ACTION_LONG_CLICK failed (${longClickResult.error}), ` +
        `falling back to coordinate gesture`
      );
    }

    return this.executeCoordinateFallback(x, y, "longPress", durationMs, driver);
  }

  /**
   * Activate the currently focused element using double-tap with ACTION_CLICK fallback.
   */
  private async activateElement(
    element: Element,
    driver: TalkBackNavigationDriver
  ): Promise<TalkBackTapResult> {
    const resourceId = element["resource-id"] as string | undefined;
    // Activate against the node TalkBack actually focused (live bounds), not the
    // caller's possibly-stale element (#3918).
    const center = await this.resolveActivationCenter(element, driver);
    const tapDuration = 50;

    // No usable bounds on either the focused node or the caller's element: never
    // tap (0,0). Try ACTION_CLICK on the resource-id, otherwise fail explicitly
    // rather than reporting a top-left tap as success (#3918).
    if (!center) {
      if (resourceId) {
        logger.warn(
          "[TalkBackTapStrategy] Activation target has no bounds; using ACTION_CLICK fallback"
        );
        const clickResult = await driver.requestAction("click", resourceId);
        if (clickResult.success) {
          return { success: true, method: "accessibility-action" };
        }
        return {
          success: false,
          method: "focus-navigation",
          error: `Activation failed: target has no bounds and ACTION_CLICK failed (${clickResult.error ?? "unknown"})`
        };
      }
      return {
        success: false,
        method: "focus-navigation",
        error: "Activation failed: target has no bounds and no resource-id for ACTION_CLICK"
      };
    }

    // First tap of double-tap activation
    const firstTap = await driver.requestTapCoordinates(center.x, center.y, tapDuration);

    if (!firstTap.success) {
      if (resourceId) {
        // If double-tap fails, try ACTION_CLICK on the resource-id
        logger.warn(`[TalkBackTapStrategy] Double-tap activation failed, trying ACTION_CLICK fallback`);
        const clickResult = await driver.requestAction("click", resourceId);
        if (!clickResult.success) {
          return {
            success: false,
            method: "focus-navigation",
            error: `Activation failed: double-tap and ACTION_CLICK both failed`
          };
        }
        return { success: true, method: "accessibility-action" };
      }
      return {
        success: false,
        method: "focus-navigation",
        error: `Activation failed: double-tap failed`
      };
    }

    await this.timer.sleep(200);

    // Second tap
    const secondTap = await driver.requestTapCoordinates(center.x, center.y, tapDuration);

    if (!secondTap.success) {
      if (resourceId) {
        // If second tap fails, try ACTION_CLICK as fallback
        logger.warn(`[TalkBackTapStrategy] Second tap failed, trying ACTION_CLICK fallback`);
        const clickResult = await driver.requestAction("click", resourceId);
        if (!clickResult.success) {
          return {
            success: false,
            method: "focus-navigation",
            error: `Activation failed: second tap and ACTION_CLICK both failed`
          };
        }
        return { success: true, method: "accessibility-action" };
      }
      return {
        success: false,
        method: "focus-navigation",
        error: `Activation failed: second tap failed`
      };
    }

    logger.info(`[TalkBackTapStrategy] Element activated successfully via focus navigation`);
    return { success: true, method: "focus-navigation" };
  }

  /**
   * Compute the center of an element's bounds, or `null` when the element has no
   * bounds. Returning null (rather than the old `(0,0)`) forces callers to treat
   * a bounds-less target as an explicit failure/fallback instead of silently
   * tapping the top-left corner and reporting success (#3918).
   */
  private getElementCenter(element: Element): { x: number; y: number } | null {
    if (!element.bounds) {
      return null;
    }
    return {
      x: Math.round((element.bounds.left + element.bounds.right) / 2),
      y: Math.round((element.bounds.top + element.bounds.bottom) / 2)
    };
  }

  /**
   * Resolve the coordinates to activate against. Prefer the node TalkBack
   * actually focused — read live via {@link TalkBackNavigationDriver.requestCurrentFocus}
   * — over the caller-supplied `element`, whose stored bounds may be stale and
   * land the double-tap on the wrong screen location (#3918). Falls back to the
   * passed element when the live focus cannot be read or carries no bounds.
   */
  private async resolveActivationCenter(
    element: Element,
    driver: TalkBackNavigationDriver
  ): Promise<{ x: number; y: number } | null> {
    try {
      const focus = await driver.requestCurrentFocus();
      const focused = focus.focusedElement;
      if (focused?.bounds) {
        return this.getElementCenter(focused);
      }
    } catch (error) {
      // Live-focus read is best-effort; fall back to the caller's element bounds.
      logger.debug(`[TalkBackTapStrategy] Could not read current focus for activation: ${error}`);
    }
    return this.getElementCenter(element);
  }
}
