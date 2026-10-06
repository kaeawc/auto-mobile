import { indeterminateTapError } from "../action/coordinateTapDispatch";
import { ActionableError, type TraversalOrderResult } from "../../models";
import type { DisplayFence, DisplayFenceOption } from "../action/BaseVisualChange";
import { StaleDisplayError } from "../../models/StaleDisplayError";
import { errorMessage } from "../../utils/describeUnknownError";
import type { Element } from "../../models/Element";
import { logger } from "../../utils/logger";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { A11yTapCoordinatesResult } from "../observe/android/types";

export { nodeActionTargetError, requiresNodeSelector, stableNodeSelectorForElement };
import {
  isSemanticActionRejected,
  resolveTalkBackActionTarget,
  type TalkBackTargetContext,
} from "./resourceIdActionError";
import {
  nodeActionTargetError,
  nonEmptyString,
  requiresNodeSelector,
  stableNodeSelectorForElement,
} from "./nodeActionTarget";
import { FocusElementMatcher } from "./FocusElementMatcher";
import {
  assertFocusNavigationLive,
  FocusNavigationExecutor,
  FocusNavigationUnavailableError,
  type FocusNavigationDriverFactory,
} from "./FocusNavigationExecutor";
import type { ElementSelector } from "./ElementSelector";
import type { TalkBackNavigationDriver } from "./TalkBackNavigationDriver";

export interface TalkBackTapResult {
  success: boolean;
  /** Current target confirmed before dispatch, including coordinate fallbacks. */
  element?: Element;
  /**
   * - "focus-navigation": moved the cursor with ACTION_ACCESSIBILITY_FOCUS and activated with double-tap
   * - "accessibility-action": dispatched a direct accessibility action (ACTION_CLICK / ACTION_LONG_CLICK)
   * - "coordinate-fallback": fell back to coordinate-based gesture dispatch
   */
  method: "focus-navigation" | "accessibility-action" | "coordinate-fallback";
  error?: string;
  /** Required capability was not advertised; no activation gesture was dispatched. */
  unsupportedCapability?: A11yTapCoordinatesResult["unsupportedCapability"];
  /** Acknowledged coordinate gestures do not confirm semantic activation. */
  warnings?: string[];
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
  /** Whether the cursor reached the target through accessibility-focus navigation. */
  reachable: boolean;
  /** Focused nodes in the order the cursor visited them. */
  traversalOrder: Element[];
  /**
   * Whether the cursor was stuck or diverging. Cursor navigation is now one focus request, so a
   * failed move is a thrown error rather than evidence here; this stays false.
   */
  focusTrapDetected: boolean;
}

export type TalkBackFallbackAction = "tap" | "doubleTap" | "longPress";
export const TALKBACK_PRECISE_FOCUS_SETTLE_MS = 500;
export const TALKBACK_ACTIVATION_WARNING =
  "TalkBack activation is unconfirmed: the coordinate gesture completed, but the element may only have received accessibility focus. Observe the result before retrying.";

interface TalkBackTapStrategyDependencies {
  matcher?: FocusElementMatcher;
  executor?: FocusNavigationExecutor;
  driverFactory?: FocusNavigationDriverFactory;
  timer?: Timer;
}

function advertisesAction(element: Element, action: string): boolean {
  return Array.isArray(element.actions) && element.actions.includes(action);
}

/**
 * Orchestrates TalkBack focus navigation and element activation.
 *
 * This strategy handles:
 * 1. Focus navigation to the target element with ACTION_ACCESSIBILITY_FOCUS (never a swipe: a
 *    gesture dispatched by an accessibility service reaches the app as touch input, #10209)
 * 2. Element activation via double-tap or ACTION_CLICK fallback
 * 3. Coordinate-based fallback only when focus navigation could not start, before anything
 *    was dispatched
 */
export class TalkBackTapStrategy {
  private matcher: FocusElementMatcher;
  private executor: FocusNavigationExecutor;
  private timer: Timer;

  constructor(dependencies: TalkBackTapStrategyDependencies = {}) {
    this.matcher = dependencies.matcher ?? new FocusElementMatcher();
    this.executor =
      dependencies.executor ??
      new FocusNavigationExecutor({
        matcher: this.matcher,
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
   * 2. Moves the accessibility cursor onto it with one ACTION_ACCESSIBILITY_FOCUS request and
   *    confirms the cursor landed there
   * 3. Activates it with double-tap (with ACTION_CLICK fallback)
   *
   * TalkBack activation is always a double-tap-to-activate on the focused node,
   * so there is no single-vs-double distinction to honour here (#3920).
   *
   * A failure before anything was dispatched (no stable selector, unreadable traversal, target
   * not in the traversal) returns `success: false` and the caller may use a coordinate tap: the
   * screen is still the one the target was resolved on. Once a focus request was sent, every
   * failure throws, so a coordinate tap is never sent from a screen that may have changed.
   *
   * @param deviceId - The device ID
   * @param element - The target element (must have at least one of resource-id, text, or content-desc)
   * @param driver - The TalkBack navigation driver
   * @param fence - Display fence asserted before each dispatch
   * @param signal - Request cancellation; the ambient request signal is honoured too. A
   *   cancelled request stops before the focus request or the activation and reports how many
   *   focus requests already moved the cursor.
   * @returns Result indicating success/failure and method used
   */
  async executeTap(
    deviceId: string,
    element: Element,
    driver: TalkBackNavigationDriver,
    fence?: DisplayFence,
    signal?: AbortSignal,
  ): Promise<TalkBackTapResult> {
    const navigationResult: ScreenReaderNavigationResult = {
      reachable: false,
      traversalOrder: [],
      focusTrapDetected: false,
    };
    const resourceId = element?.["resource-id"] as string | undefined;
    const elementText = element.text as string | undefined;
    const elementContentDesc = element["content-desc"] as string | undefined;

    if (!resourceId && !elementText && !elementContentDesc) {
      return {
        success: false,
        method: "focus-navigation",
        error: "Element has no resource-id, text, or content-desc for navigation",
        screenReaderNavigation: navigationResult,
      };
    }

    const targetSelector = this.createFocusSelector({
      resourceId,
      elementText,
      elementContentDesc,
      bounds: element.bounds,
    });
    const effectiveSignal = combineWithAmbientAbort(signal);
    let focusRequests = 0;
    let confirmedTraversal: Element[] = [];

    try {
      const reached = await this.executor.navigateToElement(deviceId, targetSelector, {
        displayFence: fence,
        signal: effectiveSignal,
        onFocusObserved: (focus, traversal) => {
          confirmedTraversal = [...traversal];
          this.appendTraversalFocus(navigationResult, focus);
        },
        onFocusRequested: () => {
          focusRequests += 1;
        },
      });
      if (!reached) {
        throw new ActionableError("Focus navigation did not reach target element");
      }
    } catch (error) {
      if (error instanceof FocusNavigationUnavailableError) {
        logger.warn(`[TalkBackTapStrategy] Focus navigation unavailable: ${error.message}`, error);
        return {
          success: false,
          method: "focus-navigation",
          error: error.message,
          screenReaderNavigation: navigationResult,
        };
      }
      throw error;
    }
    navigationResult.reachable = true;

    logger.info(`[TalkBackTapStrategy] Focus navigation successful, activating element`);

    // Activate the focused element with double-tap gesture. The cursor has already moved, so a
    // request that ended during navigation must not reach the activation.
    const guard = () => assertFocusNavigationLive(effectiveSignal, this.timer, focusRequests);
    guard();
    const activationResult = await this.activateElement(
      element,
      driver,
      fence,
      confirmedTraversal,
      guard,
    );
    return { ...activationResult, screenReaderNavigation: navigationResult };
  }

  private createFocusSelector({
    resourceId,
    elementText,
    elementContentDesc,
    bounds,
  }: {
    resourceId?: string;
    elementText?: string;
    elementContentDesc?: string;
    bounds: Element["bounds"];
  }): ElementSelector {
    return {
      ...(resourceId ? { resourceId } : {}),
      ...(elementText ? { text: elementText } : {}),
      ...(elementContentDesc ? { contentDesc: elementContentDesc } : {}),
      bounds,
    };
  }

  private appendTraversalFocus(result: ScreenReaderNavigationResult, focus: Element | null): void {
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
      bounds ? `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}` : "",
    ].join("|");
  }

  /**
   * Directly activate the target element via ACTION_CLICK, without moving the
   * TalkBack cursor.
   *
   * This is the default screen-reader activation model (#3936): deterministic,
   * a single accessibility action, and immune to the cursor-navigation failure
   * modes of {@link executeTap}. It uses the strongest stable selector observed
   * for the target. Callers may fall back when it was not sent or was refused;
   * a sent request with no confirmed reply throws the existing indeterminate tap error.
   *
   * @param element - The target element (must have a stable accessibility selector)
   * @param driver - The TalkBack navigation driver
   * @returns Result indicating success/failure; method is "accessibility-action"
   */
  async executeDirectActivation(
    element: Element,
    driver: TalkBackNavigationDriver,
    context: TalkBackTargetContext = {},
  ): Promise<TalkBackTapResult> {
    const target = await resolveTalkBackActionTarget(
      element,
      () => driver.getAccessibilityHierarchy?.() ?? Promise.resolve(null),
      context,
    );
    const confirmedElement = target.element !== element ? { element: target.element } : {};
    element = target.element;
    const guardDriver = {
      supportsNodeActionSelectors: () => driver.supportsNodeActionSelectors(),
      getAccessibilityHierarchy: async () => target.hierarchy,
    };
    const selector = stableNodeSelectorForElement(element);
    if (!selector) {
      return {
        success: false,
        ...confirmedElement,
        method: "accessibility-action",
        error: "Element has no stable selector for direct accessibility activation",
      };
    }

    const targetError = await nodeActionTargetError(selector, guardDriver, element);
    if (targetError) {
      return {
        success: false,
        ...confirmedElement,
        method: "accessibility-action",
        error: targetError,
      };
    }

    const result = requiresNodeSelector(selector)
      ? await driver.requestNodeAction("click", selector)
      : await driver.requestAction("click", selector.resourceId);
    if (result.success) {
      logger.info(`[TalkBackTapStrategy] Direct activation via ACTION_CLICK succeeded`);
      return { success: true, ...confirmedElement, method: "accessibility-action" };
    }

    if (result.dispatched && result.acknowledged !== true) {
      throw indeterminateTapError(result.error);
    }
    return {
      success: false,
      ...confirmedElement,
      method: "accessibility-action",
      error: result.error ?? "ACTION_CLICK failed",
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
    driver: TalkBackNavigationDriver,
    fenceOptions: DisplayFenceOption = {},
  ): Promise<TalkBackTapResult> {
    const fence = fenceOptions.displayFence;
    const tapDuration = action === "longPress" ? durationMs : 50;

    if (action === "doubleTap") {
      fence?.assertCurrent();
      const result = await this.requestTapCoordinates(driver, x, y, tapDuration, true);
      if (!result.success) {
        return {
          success: false,
          method: "coordinate-fallback",
          error: `Double tap failed: ${result.error}`,
          unsupportedCapability: result.unsupportedCapability,
          completedTaps: 0,
        };
      }

      return {
        success: true,
        method: "coordinate-fallback",
        completedTaps: 2,
        warnings: [TALKBACK_ACTIVATION_WARNING],
      };
    }

    // A single touch only moves TalkBack's accessibility focus; it does not
    // activate the focused element. Let callers continue to their last resort.
    // Once beforeSend lands, also pass this as the dispatch's beforeSend.
    fence?.assertCurrent();
    const result = await this.requestTapCoordinates(driver, x, y, tapDuration);
    if (!result.success) {
      return {
        success: false,
        method: "coordinate-fallback",
        error: result.error,
      };
    }

    if (action === "tap") {
      return {
        success: false,
        method: "coordinate-fallback",
        error:
          "A single coordinate touch only moves TalkBack focus and does not activate the element",
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
    driver: TalkBackNavigationDriver,
    fence?: DisplayFence,
  ): Promise<TalkBackTapResult> {
    // Once beforeSend lands, also pass this as the dispatch's beforeSend.
    fence?.assertCurrent();
    const focusResult = await this.requestTapCoordinates(driver, x, y, 50);
    if (!focusResult.success) {
      return {
        success: false,
        method: "coordinate-fallback",
        error: `Focus tap failed: ${focusResult.error}`,
        focusCompleted: false,
        completedTaps: 0,
      };
    }

    // Keep the focus tap outside TalkBack's activation double-tap window.
    await this.timer.sleep(TALKBACK_PRECISE_FOCUS_SETTLE_MS);
    const activationResult = await this.executeCoordinateFallback(x, y, "doubleTap", 50, driver, {
      displayFence: fence,
    });
    return {
      ...activationResult,
      focusCompleted: true,
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
    driver: TalkBackNavigationDriver,
    fenceOptions: DisplayFenceOption & TalkBackTargetContext = {},
  ): Promise<TalkBackTapResult> {
    const fence = fenceOptions.displayFence;
    const target = await resolveTalkBackActionTarget(
      element,
      () => driver.getAccessibilityHierarchy?.() ?? Promise.resolve(null),
      fenceOptions,
    );
    if (target.element !== element) {
      const bounds = target.element.bounds;
      x = Math.round((bounds.left + bounds.right) / 2);
      y = Math.round((bounds.top + bounds.bottom) / 2);
    }
    const confirmedElement = target.element !== element ? { element: target.element } : {};
    element = target.element;
    const guardDriver = {
      supportsNodeActionSelectors: () => driver.supportsNodeActionSelectors(),
      getAccessibilityHierarchy: async () => target.hierarchy,
    };
    const selector = stableNodeSelectorForElement(element);

    if (selector) {
      const targetError = await nodeActionTargetError(selector, guardDriver, element);
      if (targetError) {
        logger.info(`[TalkBackTapStrategy] ${targetError}`);
        return {
          ...(await this.executeCoordinateFallback(x, y, "longPress", durationMs, driver, {
            displayFence: fence,
          })),
          ...confirmedElement,
        };
      }
      const longClickResult = requiresNodeSelector(selector)
        ? await driver.requestNodeAction("long_click", selector)
        : await driver.requestAction("long_click", selector.resourceId);
      if (longClickResult.success) {
        logger.info(`[TalkBackTapStrategy] Long press via ACTION_LONG_CLICK succeeded`);
        return { success: true, ...confirmedElement, method: "accessibility-action" };
      }
      if (longClickResult.dispatched && longClickResult.acknowledged !== true) {
        throw indeterminateTapError(longClickResult.error);
      }
      const rejected = await isSemanticActionRejected({
        advertised: advertisesAction(element, "long_click"),
        error: longClickResult.error,
        needsNodeSelector: requiresNodeSelector(selector),
        selected: element,
        // Fresh read, not the target's hierarchy: it may predate the lookup miss.
        readHierarchy: () => driver.getAccessibilityHierarchy?.() ?? Promise.resolve(null),
      });
      if (rejected) {
        return {
          success: false,
          ...confirmedElement,
          method: "accessibility-action",
          error: longClickResult.error ?? "ACTION_LONG_CLICK failed",
          semanticActionFailure: true,
        };
      }
      logger.warn(
        `[TalkBackTapStrategy] ACTION_LONG_CLICK failed (${longClickResult.error}), ` +
          `falling back to coordinate gesture`,
      );
    }

    return {
      ...(await this.executeCoordinateFallback(x, y, "longPress", durationMs, driver, {
        displayFence: fence,
      })),
      ...confirmedElement,
    };
  }

  /**
   * Activate the currently focused element using double-tap with ACTION_CLICK fallback.
   */
  private async activateElement(
    element: Element,
    driver: TalkBackNavigationDriver,
    fence: DisplayFence = { assertCurrent: () => {} },
    orderedElements: Element[],
    assertLive: () => void,
  ): Promise<TalkBackTapResult> {
    const resourceId = element["resource-id"] as string | undefined;
    // Activate against the node TalkBack actually focused (live bounds), not the
    // caller's possibly-stale element (#3918).
    const center = await this.resolveActivationCenter(element, driver, orderedElements);
    const tapDuration = 50;
    // The reads above can outlast the request; nothing is dispatched once it is over.
    assertLive();

    // No usable bounds on either the focused node or the caller's element: never
    // tap (0,0). Try ACTION_CLICK on the resource-id, otherwise fail explicitly
    // rather than reporting a top-left tap as success (#3918).
    if (!center) {
      if (resourceId) {
        logger.warn(
          "[TalkBackTapStrategy] Activation target has no bounds; using ACTION_CLICK fallback",
        );
        const clickResult = await this.executeDirectActivation(element, driver);
        if (clickResult.success) {
          return { success: true, method: "accessibility-action" };
        }
        return {
          success: false,
          method: "focus-navigation",
          error: `Activation failed: target has no bounds and ACTION_CLICK failed (${clickResult.error ?? "unknown"})`,
        };
      }
      return {
        success: false,
        method: "focus-navigation",
        error: "Activation failed: target has no bounds and no resource-id for ACTION_CLICK",
      };
    }

    // One device request schedules both strokes (#9569), so the gap between the taps cannot
    // grow with reply latency the way two separate requests did (#9562).
    // Once beforeSend lands, also pass this as the dispatch's beforeSend.
    fence.assertCurrent();
    const activation = await this.requestTapCoordinates(
      driver,
      center.x,
      center.y,
      tapDuration,
      true,
    );

    if (!activation.success) {
      assertLive();
      if (resourceId) {
        logger.warn(
          `[TalkBackTapStrategy] Double-tap activation failed, trying ACTION_CLICK fallback`,
        );
        const clickResult = await this.executeDirectActivation(element, driver);
        if (!clickResult.success) {
          return {
            success: false,
            method: "focus-navigation",
            error: `Activation failed: double-tap and ACTION_CLICK both failed`,
            unsupportedCapability: activation.unsupportedCapability,
          };
        }
        return { success: true, method: "accessibility-action" };
      }
      return {
        success: false,
        method: "focus-navigation",
        error: `Activation failed: double-tap failed`,
        unsupportedCapability: activation.unsupportedCapability,
      };
    }

    logger.info(`[TalkBackTapStrategy] Element activation gesture sent via focus navigation`);
    // An acknowledged gesture does not prove the element was activated.
    return { success: true, method: "focus-navigation", warnings: [TALKBACK_ACTIVATION_WARNING] };
  }

  private async requestTapCoordinates(
    driver: TalkBackNavigationDriver,
    x: number,
    y: number,
    durationMs: number,
    doubleTap = false,
  ): Promise<A11yTapCoordinatesResult> {
    let dispatched = false;
    let result: A11yTapCoordinatesResult;
    try {
      const onDispatch = () => {
        dispatched = true;
      };
      result = doubleTap
        ? await driver.requestDoubleTapCoordinates(x, y, onDispatch)
        : await driver.requestTapCoordinates(x, y, durationMs, onDispatch);
    } catch (error) {
      if (dispatched) {
        throw indeterminateTapError(errorMessage(error));
      }
      if (error instanceof StaleDisplayError || error instanceof ActionableError) {
        throw error;
      }
      logger.warn(
        `[TalkBackTapStrategy] Coordinate tap failed before dispatch: ${errorMessage(error)}`,
        error,
      );
      return { success: false, totalTimeMs: 0, error: errorMessage(error) };
    }
    if (!result.success && dispatched) {
      throw indeterminateTapError(result.error);
    }
    return result;
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
      y: Math.round((element.bounds.top + element.bounds.bottom) / 2),
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
    driver: TalkBackNavigationDriver,
    orderedElements: Element[],
  ): Promise<{ x: number; y: number } | null> {
    try {
      const focus = await driver.requestCurrentFocus();
      const focused = focus.focusedElement;
      if (focused?.bounds && !focus.error) {
        const selector = this.createFocusSelector({
          resourceId: nonEmptyString(element["resource-id"]),
          elementText: nonEmptyString(element.text),
          elementContentDesc: nonEmptyString(element["content-desc"]),
          bounds: element.bounds,
        });
        // Resolve repeated rows against their current bounds after navigation may scroll.
        const freshElements = await this.activationTraversal(driver, orderedElements, selector);
        if (this.matcher.matchesFocusedTarget(focused, freshElements, selector)) {
          return this.getElementCenter(focused);
        }
        throw new ActionableError(
          "TalkBack focus no longer matches the selected activation target.",
        );
      }
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      // Live-focus read is best-effort; fall back to the caller's element bounds.
      logger.debug(`[TalkBackTapStrategy] Could not read current focus for activation: ${error}`);
    }
    return this.getElementCenter(element);
  }

  private async activationTraversal(
    driver: TalkBackNavigationDriver,
    orderedElements: Element[],
    selector: ElementSelector,
  ): Promise<Element[]> {
    let traversal: TraversalOrderResult | undefined;
    try {
      traversal = await driver.requestTraversalOrder();
    } catch (error) {
      if (error instanceof StaleDisplayError) {
        throw error;
      }
      logger.warn(
        `[TalkBackTapStrategy] Could not refresh activation traversal: ${errorMessage(error)}`,
        error,
      );
    }
    if (!traversal?.error && traversal?.elements?.length) {
      return traversal.elements;
    }

    // An unavailable/empty fresh traversal cannot disambiguate repeated rows. A single match in
    // the traversal navigation last confirmed keeps the matcher's selector-only acceptance.
    const exactMatches = orderedElements.filter((node) =>
      this.matcher.matchesSelector(node, selector),
    );
    const matches = exactMatches.length
      ? exactMatches
      : orderedElements.filter((node) =>
          this.matcher.matchesSelector(node, selector, { partialMatch: true }),
        );
    if (matches.length === 1) {
      return orderedElements;
    }
    throw new ActionableError(
      "Cannot verify the selected TalkBack activation target: fresh traversal is unavailable or empty.",
    );
  }
}
