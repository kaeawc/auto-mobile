import { errorMessage } from "../../utils/describeUnknownError";
import type { Element } from "../../models/Element";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { AccessibilityNodeSelector } from "../observe/android/types";
import { FocusElementMatcher } from "./FocusElementMatcher";
import { FocusNavigationExecutor, type FocusNavigationDriverFactory } from "./FocusNavigationExecutor";
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
  /** A stable selector and advertised action rejected the semantic request. */
  semanticActionFailure?: boolean;
  /** Whether a precise coordinate focus tap completed before activation. */
  focusCompleted?: boolean;
  /** Number of taps completed before a coordinate double-tap failed. */
  completedTaps?: number;
  screenReaderNavigation?: ScreenReaderNavigationResult;
}

/** Evidence captured while the opt-in screen-reader cursor journey runs. */
export interface ScreenReaderNavigationResult {
  /** Whether the cursor reached the target through swipe navigation. */
  reachable: boolean;
  /** Focused nodes in the order the cursor visited them. */
  traversalOrder: Element[];
  /** Whether navigation stopped because the cursor was stuck or diverging. */
  focusTrapDetected: boolean;
}

export type TalkBackFallbackAction = "tap" | "doubleTap" | "longPress";
export const TALKBACK_PRECISE_FOCUS_SETTLE_MS = 500;

interface TalkBackTapStrategyDependencies {
  matcher?: FocusElementMatcher;
  pathCalculator?: FocusPathCalculator;
  executor?: FocusNavigationExecutor;
  driverFactory?: FocusNavigationDriverFactory;
  timer?: Timer;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function stableNodeSelectorForElement(element: Element): AccessibilityNodeSelector | undefined {
  const selector: AccessibilityNodeSelector = {
    resourceId: nonEmptyString(element["resource-id"]),
    testTag: nonEmptyString(element["test-tag"]),
    uniqueId: nonEmptyString(element["unique-id"]),
  };
  const collectionRow = numberValue(element["collection-row-index"]);
  const collectionColumn = numberValue(element["collection-column-index"]);
  const hasStableIdentity = selector.resourceId !== undefined ||
    selector.testTag !== undefined ||
    selector.uniqueId !== undefined;
  if (hasStableIdentity && collectionRow !== undefined && collectionColumn !== undefined) {
    selector.collectionRow = collectionRow;
    selector.collectionColumn = collectionColumn;
  }

  return hasStableIdentity ? selector : undefined;
}

export function requiresNodeSelector(selector: AccessibilityNodeSelector): boolean {
  return selector.testTag !== undefined ||
    selector.uniqueId !== undefined ||
    selector.collectionRow !== undefined ||
    selector.collectionColumn !== undefined;
}

function advertisesAction(element: Element, action: string): boolean {
  return Array.isArray(element.actions) && element.actions.includes(action);
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
      timer: dependencies.timer,
      driverFactory: dependencies.driverFactory,
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
   * TalkBack activation is always a double-tap-to-activate on the focused node,
   * so there is no single-vs-double distinction to honour here (#3920).
   *
   * @param deviceId - The device ID
   * @param element - The target element (must have at least one of resource-id, text, or content-desc)
   * @param driver - The TalkBack navigation driver
   * @returns Result indicating success/failure and method used
   */
  async executeTap(
    deviceId: string,
    element: Element,
    driver: TalkBackNavigationDriver
  ): Promise<TalkBackTapResult> {
    let screenReaderNavigation: ScreenReaderNavigationResult | undefined;
    const resourceId = element?.["resource-id"] as string | undefined;
    const elementText = element.text as string | undefined;
    const elementContentDesc = element["content-desc"] as string | undefined;

    if (!resourceId && !elementText && !elementContentDesc) {
      return {
        success: false,
        method: "focus-navigation",
        error: "Element has no resource-id, text, or content-desc for navigation",
        screenReaderNavigation: {
          reachable: false,
          traversalOrder: [],
          focusTrapDetected: false
        }
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
          error: `Failed to get traversal order: ${traversalResult.error}`,
          screenReaderNavigation: {
            reachable: false,
            traversalOrder: [],
            focusTrapDetected: false
          }
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

      const navigationResult: ScreenReaderNavigationResult = {
        reachable: false,
        traversalOrder: currentFocus ? [currentFocus] : [],
        focusTrapDetected: false
      };
      screenReaderNavigation = navigationResult;

      // Calculate navigation path
      const navigationPath = this.pathCalculator.calculatePath(
        currentFocus,
        targetSelector,
        orderedElements
      );

      if (!navigationPath) {
        return {
          success: false,
          method: "focus-navigation",
          error: "Could not calculate navigation path to target element",
          screenReaderNavigation: navigationResult
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
          // Fidelity assertions need every focused node, not periodic samples.
          verificationInterval: 1,
          swipeDelay: 100,
          onFocusObserved: focus => this.appendTraversalFocus(navigationResult, focus)
        }
      );

      if (!navigationSuccess) {
        return {
          success: false,
          method: "focus-navigation",
          error: "Focus navigation did not reach target element",
          screenReaderNavigation: navigationResult
        };
      }

      navigationResult.reachable = true;

      logger.info(`[TalkBackTapStrategy] Focus navigation successful, activating element`);

      // Activate the focused element with double-tap gesture
      const activationResult = await this.activateElement(element, driver);
      return { ...activationResult, screenReaderNavigation: navigationResult };

    } catch (error) {
      const errorMsg = errorMessage(error);
      logger.warn(`[TalkBackTapStrategy] Focus navigation failed: ${errorMsg}`);
      return {
        success: false,
        method: "focus-navigation",
        error: errorMsg,
        screenReaderNavigation: screenReaderNavigation
          ? { ...screenReaderNavigation, focusTrapDetected: this.isFocusTrapError(errorMsg) }
          : { reachable: false, traversalOrder: [], focusTrapDetected: this.isFocusTrapError(errorMsg) }
      };
    }
  }

  private appendTraversalFocus(
    result: ScreenReaderNavigationResult,
    focus: Element | null
  ): void {
    if (!focus) {
      return;
    }
    const last = result.traversalOrder.at(-1);
    if (!last || this.focusSignature(last) !== this.focusSignature(focus)) {
      result.traversalOrder.push(focus);
    }
  }

  private focusSignature(element: Element): string {
    const bounds = element.bounds;
    return [
      element["resource-id"] ?? "",
      element["content-desc"] ?? "",
      element.text ?? "",
      bounds ? `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}` : ""
    ].join("|");
  }

  private isFocusTrapError(error: string): boolean {
    return error.includes("Focus did not move")
      || error.includes("could not track the TalkBack cursor")
      || error.includes("not converging on the target");
  }

  /**
   * Directly activate the target element via ACTION_CLICK, without moving the
   * TalkBack cursor.
   *
   * This is the default screen-reader activation model (#3936): deterministic,
   * a single accessibility action, and immune to the cursor-navigation failure
   * modes of {@link executeTap}. It uses the strongest stable selector observed
   * for the target and callers fall back to a coordinate gesture when it fails.
   *
   * @param element - The target element (must have a stable accessibility selector)
   * @param driver - The TalkBack navigation driver
   * @returns Result indicating success/failure; method is "accessibility-action"
   */
  async executeDirectActivation(
    element: Element,
    driver: TalkBackNavigationDriver
  ): Promise<TalkBackTapResult> {
    const selector = stableNodeSelectorForElement(element);
    if (!selector) {
      return {
        success: false,
        method: "accessibility-action",
        error: "Element has no stable selector for direct accessibility activation"
      };
    }

    if (requiresNodeSelector(selector) && !(await driver.supportsNodeActionSelectors())) {
      return {
        success: false,
        method: "accessibility-action",
        error: "Runner does not support stable node selectors"
      };
    }

    const result = requiresNodeSelector(selector)
      ? await driver.requestNodeAction("click", selector)
      : await driver.requestAction("click", selector.resourceId);
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
          error: `First tap failed: ${firstResult.error}`,
          completedTaps: 0
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
          error: `Second tap failed: ${secondResult.error}`,
          completedTaps: 1
        };
      }

      return { success: true, method: "coordinate-fallback", completedTaps: 2 };
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
   * Focus a coordinate through TalkBack touch exploration, then activate the
   * resulting focused target with TalkBack's double-tap gesture.
   */
  async executePreciseTap(
    x: number,
    y: number,
    driver: TalkBackNavigationDriver
  ): Promise<TalkBackTapResult> {
    const focusResult = await driver.requestTapCoordinates(x, y, 50);
    if (!focusResult.success) {
      return {
        success: false,
        method: "coordinate-fallback",
        error: `Focus tap failed: ${focusResult.error}`,
        focusCompleted: false,
        completedTaps: 0
      };
    }

    // Keep the focus tap outside TalkBack's activation double-tap window.
    await this.timer.sleep(TALKBACK_PRECISE_FOCUS_SETTLE_MS);
    const activationResult = await this.executeCoordinateFallback(
      x,
      y,
      "doubleTap",
      50,
      driver
    );
    return {
      ...activationResult,
      focusCompleted: true
    };
  }

  /**
   * Execute a long press on an element using ACTION_LONG_CLICK with coordinate gesture fallback.
   *
   * An observed `long_click` action plus a stable selector is authoritative:
   * a rejected action is returned to the caller instead of risking a gesture
   * against a different row. Nodes without an advertised semantic action retain
   * the coordinate fallback.
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
    const selector = stableNodeSelectorForElement(element);

    if (selector) {
      if (requiresNodeSelector(selector) && !(await driver.supportsNodeActionSelectors())) {
        logger.info(
          "[TalkBackTapStrategy] Runner does not support stable node selectors; using coordinate long press"
        );
        return this.executeCoordinateFallback(x, y, "longPress", durationMs, driver);
      }
      const longClickResult = requiresNodeSelector(selector)
        ? await driver.requestNodeAction("long_click", selector)
        : await driver.requestAction("long_click", selector.resourceId);
      if (longClickResult.success) {
        logger.info(`[TalkBackTapStrategy] Long press via ACTION_LONG_CLICK succeeded`);
        return { success: true, method: "accessibility-action" };
      }
      if (advertisesAction(element, "long_click")) {
        return {
          success: false,
          method: "accessibility-action",
          error: longClickResult.error ?? "ACTION_LONG_CLICK failed",
          semanticActionFailure: true,
        };
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
