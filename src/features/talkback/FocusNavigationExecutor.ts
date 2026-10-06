import type { DisplayFence } from "../action/BaseVisualChange";
import type { Element } from "../../models/Element";
import {
  ActionableError,
  type BootedDevice,
  type CurrentFocusResult,
  type TraversalOrderResult,
  type ViewHierarchyResult,
} from "../../models";
import type { ElementSelector as FocusElementSelector } from "./ElementSelector";
import { DeviceDetection } from "../../utils/DeviceDetection";
import { isDeviceLostError } from "../../models/DeviceLostError";
import { combineWithAmbientAbort, getRequestContext } from "../../utils/AbortContext";
import { errorMessage } from "../../utils/describeUnknownError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";
import type { AccessibilityNodeSelector, A11yActionResult } from "../observe/android/types";
import { FocusElementMatcher } from "./FocusElementMatcher";
import {
  nodeActionTargetError,
  requiresNodeSelector,
  stableNodeSelectorForElement,
} from "./nodeActionTarget";

interface NavigationOptions {
  displayFence?: DisplayFence;
  /** How long to let TalkBack apply a focus request before reading the cursor back. */
  focusSettleMs?: number;
  /** The cursor and the traversal it was read from, after every read of the screen. */
  onFocusObserved?: (element: Element | null, traversal: readonly Element[]) => void;
  /** Called immediately before a focus request; even a failed request may move the cursor. */
  onFocusRequested?: () => void;
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

/**
 * Focus navigation could not start: nothing was dispatched, so the screen is exactly as it was
 * observed and a caller may still use a non-cursor activation. Every other navigation failure
 * happens after a focus request was sent and must never fall back to a coordinate tap.
 */
export class FocusNavigationUnavailableError extends ActionableError {}

const BUDGET_EXHAUSTED_MESSAGE = "Request time budget exhausted during focus navigation.";

/**
 * Describe a stop that happened after `focusRequests` focus requests were sent. A focus
 * request moves the TalkBack cursor, so the device is not where the request found it.
 * Device-loss errors keep their typed carrier, and a stop before any request changed nothing,
 * so both pass through unchanged.
 */
export function stoppedFocusNavigationError(error: unknown, focusRequests: number): unknown {
  if (
    error instanceof FocusNavigationStoppedError ||
    isDeviceLostError(error) ||
    focusRequests <= 0
  ) {
    return error;
  }
  const reason = errorMessage(error);
  return new FocusNavigationStoppedError(
    `${reason.endsWith(".") ? reason : `${reason}.`} Focus navigation partially applied: ` +
      `${focusRequests} accessibility-focus request${focusRequests === 1 ? "" : "s"} already ` +
      "moved the TalkBack cursor and the target was not activated. Observe before retrying; do " +
      "not retry automatically.",
    { cause: error },
  );
}

/**
 * Throw when the request was cancelled or its time budget is spent. Called before every focus
 * request and before the activation, so nothing further is dispatched for a request that is
 * over.
 */
export function assertFocusNavigationLive(
  signal: AbortSignal | undefined,
  timer: Timer,
  focusRequests: number,
): void {
  try {
    throwIfAborted(signal);
  } catch (error) {
    throw stoppedFocusNavigationError(error, focusRequests);
  }
  const deadlineMs = getRequestContext()?.getDeadlineMs?.();
  if (deadlineMs !== undefined && timer.now() >= deadlineMs) {
    throw stoppedFocusNavigationError(new Error(BUDGET_EXHAUSTED_MESSAGE), focusRequests);
  }
}

/**
 * The reads and accessibility actions focus navigation needs. The cursor is moved with
 * ACTION_ACCESSIBILITY_FOCUS: a gesture an accessibility service dispatches reaches the app as
 * ordinary touch input, so a cursor "swipe" scrolls the app's own pager instead (#10209).
 */
export interface FocusNavigationDriver {
  /** Full, unfiltered tree for global-ID safety. Drivers without this capability use coordinates. */
  getAccessibilityHierarchy?(): Promise<ViewHierarchyResult | null>;
  requestTraversalOrder(): Promise<TraversalOrderResult>;
  requestCurrentFocus(): Promise<CurrentFocusResult>;
  /**
   * Request an accessibility action on an element.
   * @param action - The action to perform (e.g., "click", "focus")
   * @param resourceId - Optional resource ID of the target element
   */
  requestAction(
    action: string,
    resourceId?: string,
    signal?: AbortSignal,
  ): Promise<A11yActionResult>;
  /** Request an accessibility action using stable fields observed from a node. */
  requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    signal?: AbortSignal,
  ): Promise<A11yActionResult>;
  /** Whether the connected runner can resolve stable node selectors. */
  supportsNodeActionSelectors(): Promise<boolean>;
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
  timer?: Timer;
  driverFactory?: FocusNavigationDriverFactory;
  deviceResolver?: (deviceId: string) => BootedDevice;
}

class DefaultFocusNavigationDriver implements FocusNavigationDriver {
  private accessibilityService: AndroidCtrlProxyClient;
  constructor(accessibilityService: AndroidCtrlProxyClient) {
    this.accessibilityService = accessibilityService;
  }

  async getAccessibilityHierarchy(): Promise<ViewHierarchyResult | null> {
    return this.accessibilityService.getAccessibilityHierarchy(
      undefined,
      undefined,
      false,
      undefined,
      true,
    );
  }

  async requestTraversalOrder(): Promise<TraversalOrderResult> {
    return this.accessibilityService.requestTraversalOrder();
  }

  async requestCurrentFocus(): Promise<CurrentFocusResult> {
    return this.accessibilityService.requestCurrentFocus();
  }

  async requestAction(
    action: string,
    resourceId?: string,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.accessibilityService.requestAction(
      action,
      resourceId,
      undefined,
      undefined,
      undefined,
      signal,
    );
  }

  async requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.accessibilityService.requestNodeAction(
      action,
      selector,
      undefined,
      undefined,
      signal,
    );
  }

  async supportsNodeActionSelectors(): Promise<boolean> {
    return this.accessibilityService.supportsNodeActionSelectors();
  }
}

class DefaultFocusNavigationDriverFactory implements FocusNavigationDriverFactory {
  createDriver(device: BootedDevice): FocusNavigationDriver {
    return new DefaultFocusNavigationDriver(AndroidCtrlProxyClient.getInstance(device));
  }
}

function elementIdentity(element: Element): string {
  const bounds = element.bounds;
  return [
    element["resource-id"] ?? "",
    element["content-desc"] ?? "",
    element.text ?? "",
    bounds ? `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}` : "",
  ].join("|");
}

/**
 * Order-insensitive identity of what the traversal shows: which nodes, with which labels, where.
 * Accessibility focus is deliberately not part of it, so only a changed screen (a pager that
 * moved, a navigation) changes the fingerprint, not the cursor.
 */
export function screenFingerprint(elements: readonly Element[]): string {
  return elements.map(elementIdentity).sort().join("\n");
}

export class FocusNavigationExecutor {
  private static readonly DEFAULT_FOCUS_SETTLE_MS = 100;

  private matcher: FocusElementMatcher;
  private timer: Timer;
  private driverFactory: FocusNavigationDriverFactory;
  private deviceResolver: (deviceId: string) => BootedDevice;

  constructor(dependencies: FocusNavigationExecutorDependencies = {}) {
    this.matcher = dependencies.matcher ?? new FocusElementMatcher();
    this.timer = dependencies.timer ?? defaultTimer;
    this.driverFactory = dependencies.driverFactory ?? new DefaultFocusNavigationDriverFactory();
    this.deviceResolver = dependencies.deviceResolver ?? this.resolveDevice;
  }

  /**
   * Move the TalkBack cursor onto the target with one ACTION_ACCESSIBILITY_FOCUS request and
   * confirm it landed. Resolves true once the cursor is on the target. Throws
   * {@link FocusNavigationUnavailableError} before dispatching anything when the cursor cannot
   * be moved this way, and a plain ActionableError once a request was sent and the cursor did not
   * reach the target (including when the screen changed meanwhile): the caller must not tap
   * coordinates it chose before that.
   */
  async navigateToElement(
    deviceId: string,
    targetSelector: FocusElementSelector,
    options: NavigationOptions = {},
  ): Promise<boolean> {
    const signal = combineWithAmbientAbort(options.signal);
    const progress = { focusRequests: 0 };
    try {
      return await this.runNavigation(
        deviceId,
        targetSelector,
        {
          ...options,
          signal,
          onFocusRequested: () => {
            progress.focusRequests += 1;
            options.onFocusRequested?.();
          },
        },
        progress,
      );
    } catch (error) {
      // A request that ended mid-navigation (even an in-flight read rejected by the abort)
      // must say the cursor already moved, whatever error the interrupted call raised.
      throw signal?.aborted ? stoppedFocusNavigationError(error, progress.focusRequests) : error;
    }
  }

  private async runNavigation(
    deviceId: string,
    targetSelector: FocusElementSelector,
    options: NavigationOptions,
    progress: { focusRequests: number },
  ): Promise<boolean> {
    const { signal } = options;
    const device = this.deviceResolver(deviceId);
    if (device.platform !== "android") {
      throw new ActionableError("TalkBack focus navigation is only supported on Android devices.");
    }

    const driver = this.driverFactory.createDriver(device);
    assertFocusNavigationLive(signal, this.timer, progress.focusRequests);
    const before = await this.verifyNavigationState(driver, targetSelector, false, signal);
    options.onFocusObserved?.(before.currentFocus, before.orderedElements);
    if (before.reachedTarget) {
      return true;
    }

    const target =
      before.targetIndex === null ? undefined : before.orderedElements[before.targetIndex];
    if (!target) {
      throw new FocusNavigationUnavailableError(
        `Target not found in the accessibility traversal (${this.describeSelector(targetSelector)}). ` +
          "Use observe to inspect elements and the diagnostics returned by tapOn/waitFor failures." +
          this.describeTraversalTruncation(before),
      );
    }

    await this.requestFocus(driver, target, options, progress);
    const settleMs = Math.max(
      0,
      options.focusSettleMs ?? FocusNavigationExecutor.DEFAULT_FOCUS_SETTLE_MS,
    );
    if (settleMs > 0) {
      await awaitWhileRequestIsLive(this.timer.sleep(settleMs), signal);
    }
    assertFocusNavigationLive(signal, this.timer, progress.focusRequests);

    const after = await this.verifyNavigationState(driver, targetSelector, true, signal);
    options.onFocusObserved?.(after.currentFocus, after.orderedElements);
    if (after.reachedTarget) {
      return true;
    }
    throw this.unreachedTargetError(before, after, targetSelector);
  }

  /**
   * Send ACTION_ACCESSIBILITY_FOCUS for the target node. A target the runner cannot address
   * with a stable selector raises {@link FocusNavigationUnavailableError} before any dispatch.
   */
  private async requestFocus(
    driver: FocusNavigationDriver,
    target: Element,
    options: NavigationOptions,
    progress: { focusRequests: number },
  ): Promise<void> {
    const { signal } = options;
    const selector = stableNodeSelectorForElement(target);
    if (!selector) {
      throw new FocusNavigationUnavailableError(
        "The target has no resource-id, test tag or unique id, so the TalkBack cursor cannot be " +
          "moved onto it without a touch gesture.",
      );
    }
    const targetError = await nodeActionTargetError(selector, driver, target);
    if (targetError) {
      throw new FocusNavigationUnavailableError(
        `The TalkBack cursor cannot be moved onto the target: ${targetError}.`,
      );
    }

    assertFocusNavigationLive(signal, this.timer, progress.focusRequests);
    options.displayFence?.assertCurrent();
    options.onFocusRequested?.();
    const result = await awaitWhileRequestIsLive(
      requiresNodeSelector(selector)
        ? driver.requestNodeAction("focus", selector, signal)
        : driver.requestAction("focus", selector.resourceId, signal),
      signal,
    );
    if (!result.success) {
      throw new ActionableError(
        `Could not move the TalkBack cursor onto the target: ${
          result.error ?? "ACTION_ACCESSIBILITY_FOCUS failed"
        }. No tap was sent.`,
      );
    }
  }

  private unreachedTargetError(
    before: NavigationVerification,
    after: NavigationVerification,
    targetSelector: FocusElementSelector,
  ): ActionableError {
    const target = this.describeSelector(targetSelector);
    if (screenFingerprint(before.orderedElements) !== screenFingerprint(after.orderedElements)) {
      return new ActionableError(
        `The screen changed while moving the TalkBack cursor onto the target (${target}), and the ` +
          "cursor is not on it. No tap was sent. Observe the new screen and resolve the target again.",
      );
    }
    const focus = after.currentFocus
      ? this.describeFocus(after.currentFocus)
      : "no element has accessibility focus";
    return new ActionableError(
      `The TalkBack cursor did not move onto the target (${target}) after the focus request; ` +
        `${focus}. No tap was sent. Observe before retrying.`,
    );
  }

  private resolveDevice(deviceId: string): BootedDevice {
    const platform = DeviceDetection.detectPlatform(deviceId);
    return {
      name: deviceId,
      deviceId,
      platform,
    };
  }

  private async verifyNavigationState(
    driver: FocusNavigationDriver,
    targetSelector: FocusElementSelector,
    dispatched: boolean,
    signal?: AbortSignal,
  ): Promise<NavigationVerification> {
    const traversal = await awaitWhileRequestIsLive(driver.requestTraversalOrder(), signal);
    if (traversal.error) {
      // Once a focus request was sent an unreadable screen is a failure, never a fallback.
      const message = `Failed to get traversal order: ${traversal.error}`;
      throw dispatched
        ? new ActionableError(
            `${message}. The focus request may have moved the cursor; no tap was sent.`,
          )
        : new FocusNavigationUnavailableError(message);
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
        // A failed reply is not evidence of where the cursor is, even if it carries an element.
        logger.warn(`[FocusNavigation] Failed to get current focus: ${focusResult.error}`);
      } else {
        currentFocus = focusResult.focusedElement ?? null;
      }
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

  private describeFocus(element: Element): string {
    const label = element.text || element["content-desc"] || element["resource-id"];
    return label ? `focus is on "${label}"` : "focus is on another element";
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
