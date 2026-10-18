import type {
  BootedDevice,
  Element,
  ElementSelectionResult,
  ViewHierarchyResult,
} from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { scopeHierarchyForSelector } from "../observe/hierarchyLayer";
import type { TalkBackNavigationDriverFactory } from "../talkback/TalkBackNavigationDriver";
import type { TalkBackTargetContext } from "../talkback/resourceIdActionError";
import type {
  ScreenReaderNavigationResult,
  TalkBackTapResult,
  TalkBackTapStrategy,
} from "../talkback/TalkBackTapStrategy";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import { isAndroidDocumentsUiRow } from "./androidCoordinateTapPolicy";
import type {
  AndroidTapWithCoordinatesArgs,
  ResolvedAndroidTapOptions,
} from "./tapAndroidDispatchPhase";

/** Options accepted by the TalkBack tap path. */
export type TalkBackTapOptions = TapOnElementOptions &
  ResolvedAndroidTapOptions & { onActivationWarning?: (warning: string) => void };

/** Positional arguments of the TalkBack tap path; the last two are optional. */
export type TalkBackTapArgs = [
  action: string,
  x: number,
  y: number,
  element: Element,
  durationMs: number,
  options?: TalkBackTapOptions,
  signal?: AbortSignal,
];

/** What the TalkBack tap phase needs from the owning tap action. */
export interface TapTalkBackHost {
  readonly device: BootedDevice;
  talkBackStrategy(): TalkBackTapStrategy;
  talkBackDriverFactory(): TalkBackNavigationDriverFactory;
  getElementCenter(element: Element): { x: number; y: number };
  isScreenReaderNavigationEnabled(options?: TapOnElementOptions): boolean;
  selectElementInHierarchy(
    options: TapOnElementOptions,
    hierarchy: ViewHierarchyResult,
  ): { selection: ElementSelectionResult };
  resolveTapTargetElement(
    element: Element,
    hierarchy: ViewHierarchyResult | null,
    action: string,
    targetOptions: boolean | { requireResourceId: boolean; scoped: boolean },
  ): { element: Element; usedParent: boolean };
  /** Routed through the owner so overriding/spying on it observes the fallback too. */
  executeAndroidTapWithCoordinates(...args: AndroidTapWithCoordinatesArgs): Promise<void>;
  reportTalkBackActivationWarning(
    result: TalkBackTapResult,
    context: { onActivationWarning?: (warning: string) => void } | undefined,
    action: string,
  ): void;
}

/** TalkBack-mode Android tap: accessibility action, precise gesture, then ADB fallback. */
export class TapTalkBackPhase {
  constructor(private readonly host: TapTalkBackHost) {}

  private talkBackTargetContext(
    options: TalkBackTapOptions | undefined,
    action: string,
    onResolvedElement: NonNullable<ResolvedAndroidTapOptions["onResolvedElement"]>,
  ): TalkBackTargetContext {
    let resolvedSelection: ElementSelectionResult | undefined;
    let resolvedHierarchy: ViewHierarchyResult | undefined;
    const hasSelector =
      options && [options.text, options.textAny, options.elementId, options.testTag].some(Boolean);
    return {
      hierarchy: resolveViewHierarchyForSearch(options?.resolvedHierarchy),
      reResolve: hasSelector
        ? (hierarchy) => {
            const selection = this.host.selectElementInHierarchy(
              options,
              scopeHierarchyForSelector(hierarchy, options.layer),
            ).selection;
            resolvedSelection = selection;
            resolvedHierarchy = hierarchy;
            return selection.element
              ? this.host.resolveTapTargetElement(selection.element, hierarchy, action, {
                  requireResourceId: true,
                  scoped: options.container !== undefined,
                }).element
              : null;
          }
        : undefined,
      onResolvedElement: (element) =>
        onResolvedElement(element, resolvedSelection, resolvedHierarchy),
    };
  }

  async executeAndroidTapWithAccessibility(
    ...args: TalkBackTapArgs
  ): Promise<ScreenReaderNavigationResult | undefined> {
    let [, x, y, element] = args;
    const action = args[0];
    const [, , , , durationMs, options, signal] = args;
    const fence = options?.displayFence;
    const driver = this.host.talkBackDriverFactory().createDriver(this.host.device);
    let screenReaderNavigation: ScreenReaderNavigationResult | undefined;
    const targetContext = this.talkBackTargetContext(
      options,
      action,
      (current, selection, hierarchy) => {
        element = current;
        const center = this.host.getElementCenter(current);
        x = center.x;
        y = center.y;
        options?.onResolvedElement?.(current, selection, hierarchy);
      },
    );

    if (action === "longPress") {
      // Long press: try ACTION_LONG_CLICK first, then coordinate gesture fallback
      const longPressResult = await this.host
        .talkBackStrategy()
        .executeLongPress(x, y, durationMs, element, driver, {
          displayFence: fence,
          ...targetContext,
        });

      if (!longPressResult.success) {
        if (longPressResult.semanticActionFailure) {
          throw new ActionableError(
            `Semantic long press failed for the selected element: ${longPressResult.error ?? "unknown error"}`,
          );
        }
        logger.warn(
          `[TapOnElement] Long press accessibility methods failed (${longPressResult.error}), ` +
            `falling back to ADB tap at (${x}, ${y})`,
        );
        await this.host.executeAndroidTapWithCoordinates(
          action,
          x,
          y,
          durationMs,
          element,
          signal,
          // TalkBackTapStrategy.executeLongPress already ran the uniqueness guard
          // and attempted long_click for this selector; continue with coordinates.
          true,
          { displayFence: fence },
        );
      }
      return undefined;
    }

    // Long press returned above; the remaining actions are tap and doubleTap.
    if (this.host.isScreenReaderNavigationEnabled(options)) {
      // Opt-in fidelity mode (#3937): move the TalkBack cursor onto the target with
      // ACTION_ACCESSIBILITY_FOCUS, then activate. A failure after the focus request was sent
      // throws; only a failure before anything was dispatched returns here and may fall back.
      const result = await this.host
        .talkBackStrategy()
        .executeTap(this.host.device.deviceId, element, driver, fence, signal);

      if (result.success) {
        // A focus-navigation gesture is acknowledged, not confirmed as an activation.
        this.host.reportTalkBackActivationWarning(result, options, action);
        return result.screenReaderNavigation;
      }

      logger.warn(
        `[TapOnElement] Focus navigation unavailable (${result.error}); nothing was dispatched, ` +
          `falling back to coordinate-based tap at (${x}, ${y})`,
      );
      screenReaderNavigation = result.screenReaderNavigation;
    } else if (action === "tap") {
      // Default (#3936): directly activate the target node via ACTION_CLICK,
      // without moving the cursor. doubleTap has no single accessibility action,
      // so it drops straight to the coordinate fallback below.
      const result = await this.host
        .talkBackStrategy()
        .executeDirectActivation(element, driver, targetContext);

      if (result.success) {
        return undefined;
      }

      logger.warn(
        `[TapOnElement] Direct accessibility activation failed (${result.error}), ` +
          `falling back to coordinate-based tap at (${x}, ${y})`,
      );
    }

    // DocumentsUI item gestures can be acknowledged without activation, including
    // this TalkBack fallback path. Use the same row activation/input recovery.
    if (isAndroidDocumentsUiRow(element)) {
      await this.host.executeAndroidTapWithCoordinates(
        action,
        x,
        y,
        durationMs,
        element,
        signal,
        false,
        { displayFence: fence },
      );
      return screenReaderNavigation;
    }

    // Fallback to coordinate-based taps via accessibility service dispatchGesture
    const fallbackAction = action as "tap" | "doubleTap" | "longPress";
    const fallbackResult =
      fallbackAction === "tap"
        ? await this.host.talkBackStrategy().executePreciseTap(x, y, driver, fence)
        : await this.host
            .talkBackStrategy()
            .executeCoordinateFallback(x, y, fallbackAction, durationMs, driver, {
              displayFence: fence,
            });

    if (!fallbackResult.success) {
      logger.warn(
        `[TapOnElement] Accessibility coordinate tap failed (${fallbackResult.error}), ` +
          `falling back to ADB tap at (${x}, ${y})`,
      );
      await this.host.executeAndroidTapWithCoordinates(
        action,
        x,
        y,
        durationMs,
        element,
        signal,
        false,
        { displayFence: fence },
      );
    }
    this.host.reportTalkBackActivationWarning(fallbackResult, options, action);
    return screenReaderNavigation;
  }
}
