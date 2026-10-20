import {
  ActionableError,
  type Element,
  type ElementSelectionResult,
  type ViewHierarchyResult,
} from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import type { DisplayFenceOption } from "./BaseVisualChange";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { AtomicDoubleTapClient } from "./androidDoubleTap";
import { dispatchAndroidDoubleTap } from "./androidDoubleTap";
import { isAndroidDocumentsUiRow } from "./androidCoordinateTapPolicy";
import { logger } from "../../utils/logger";
import {
  TALKBACK_ACTIVATION_WARNING,
  type ScreenReaderNavigationResult,
  type TalkBackTapResult,
} from "../talkback/TalkBackTapStrategy";
import type { TalkBackNavigationDriver } from "../talkback/TalkBackNavigationDriver";
import type { TalkBackTargetContext } from "../talkback/resourceIdActionError";
import type { TapOnTalkBackStrategy } from "./tapOnElementDependencies";

export type ResolvedAndroidTapOptions = DisplayFenceOption & {
  resolvedHierarchy?: ViewHierarchyResult;
  /** Receives non-fatal cautions (for example a double tap whose taps started too far apart). */
  onActivationWarning?: (warning: string) => void;
  onResolvedElement?: (
    element: Element,
    selection?: ElementSelectionResult,
    hierarchy?: ViewHierarchyResult,
  ) => void;
};

/** Per-call state for Android coordinate dispatch, including explicit-display fences. */
export interface AndroidCoordinateTapRequest {
  action: string;
  x: number;
  y: number;
  durationMs: number;
  element: Element;
  signal?: AbortSignal;
  skipSemanticAction?: boolean;
  fenceOptions?: ResolvedAndroidTapOptions;
}

/** Positional compatibility surface used by TapOnElement's public test seam. */
export type AndroidCoordinateTap = (
  ...args: [
    action: string,
    x: number,
    y: number,
    durationMs: number,
    element: Element,
    signal?: AbortSignal,
    skipSemanticAction?: boolean,
    fenceOptions?: ResolvedAndroidTapOptions,
  ]
) => Promise<void>;

interface AndroidCoordinateTapDependencies {
  client: AtomicDoubleTapClient;
  timer: Pick<Timer, "sleep" | "now">;
  tryDocumentsUiRowActivation: (element: Element, signal?: AbortSignal) => Promise<boolean>;
  coordinateTap: (
    x: number,
    y: number,
    element: Element,
    signal?: AbortSignal,
    options?: DisplayFenceOption,
  ) => Promise<void>;
  longPress: (
    x: number,
    y: number,
    durationMs: number,
    element: Element,
    options: ResolvedAndroidTapOptions & { signal?: AbortSignal; skipSemanticAction?: boolean },
  ) => Promise<void>;
}

export interface AndroidAccessibilityTapRequest {
  action: string;
  x: number;
  y: number;
  element: Element;
  durationMs: number;
  options?: TapOnElementOptions & ResolvedAndroidTapOptions;
  signal?: AbortSignal;
}

interface AndroidAccessibilityTapDependencies {
  driver: TalkBackNavigationDriver;
  deviceId: string;
  geometry: Pick<ElementGeometry, "getElementCenter">;
  strategy: TapOnTalkBackStrategy;
  targetContext: (
    options: AndroidAccessibilityTapRequest["options"],
    action: string,
    onResolvedElement: NonNullable<ResolvedAndroidTapOptions["onResolvedElement"]>,
  ) => TalkBackTargetContext;
  coordinateTap: AndroidCoordinateTap;
  isScreenReaderNavigationEnabled: (options?: TapOnElementOptions) => boolean;
}

/** Report acknowledgement or a completed fallback without claiming semantic activation. */
export function reportTalkBackActivationWarning(
  result: TalkBackTapResult,
  context?: { onActivationWarning?: (warning: string) => void },
  action = "tap",
): void {
  if (action === "longPress" || result.method === "accessibility-action") {
    return;
  }
  const warnings = result.success
    ? (result.warnings ?? [TALKBACK_ACTIVATION_WARNING])
    : [
        result.unsupportedCapability === "tap_double_v1"
          ? "TalkBack activation is unconfirmed: the connected device service does not support the single-gesture double tap (tap_double_v1). Update CtrlProxy. The plain coordinate tap path was used instead. Observe the result before retrying."
          : "TalkBack activation is unconfirmed: the TalkBack gesture failed, so the plain coordinate tap path was used instead. Observe the result before retrying.",
      ];
  for (const warning of warnings) {
    context?.onActivationWarning?.(warning);
  }
}

export async function dispatchAndroidTapWithCoordinates(
  deps: AndroidCoordinateTapDependencies,
  {
    action,
    x,
    y,
    durationMs,
    element,
    signal,
    skipSemanticAction = false,
    fenceOptions = {},
  }: AndroidCoordinateTapRequest,
): Promise<void> {
  const fence = fenceOptions.displayFence;
  if (action === "tap") {
    if (
      !skipSemanticAction &&
      isAndroidDocumentsUiRow(element) &&
      (await deps.tryDocumentsUiRowActivation(element, signal))
    ) {
      return;
    }
    await deps.coordinateTap(x, y, element, signal, { displayFence: fence });
  } else if (action === "longPress") {
    await deps.longPress(x, y, durationMs, element, {
      signal,
      skipSemanticAction,
      ...fenceOptions,
    });
  } else if (action === "doubleTap") {
    await dispatchAndroidDoubleTap({
      // DocumentsUI rows use ADB input recovery, which has no single-gesture form.
      client: isAndroidDocumentsUiRow(element) ? undefined : deps.client,
      point: { x, y },
      timer: deps.timer,
      signal,
      assertCurrent: () => fence?.assertCurrent(),
      onWarning: fenceOptions.onActivationWarning,
      tap: () => deps.coordinateTap(x, y, element, signal, { displayFence: fence }),
    });
  }
}

export async function dispatchAndroidAccessibilityTap(
  deps: AndroidAccessibilityTapDependencies,
  { action, x, y, element, durationMs, options, signal }: AndroidAccessibilityTapRequest,
): Promise<ScreenReaderNavigationResult | undefined> {
  const fence = options?.displayFence;
  const driver = deps.driver;
  let screenReaderNavigation: ScreenReaderNavigationResult | undefined;
  const targetContext = deps.targetContext(options, action, (current, selection, hierarchy) => {
    element = current;
    const center = deps.geometry.getElementCenter(current);
    x = center.x;
    y = center.y;
    options?.onResolvedElement?.(current, selection, hierarchy);
  });

  if (action === "longPress") {
    // Long press: try ACTION_LONG_CLICK first, then coordinate gesture fallback
    const longPressResult = await deps.strategy.executeLongPress(
      x,
      y,
      durationMs,
      element,
      driver,
      { displayFence: fence, ...targetContext },
    );

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
      await deps.coordinateTap(
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
  if (deps.isScreenReaderNavigationEnabled(options)) {
    // Opt-in fidelity mode (#3937): move the TalkBack cursor onto the target with
    // ACTION_ACCESSIBILITY_FOCUS, then activate. A failure after the focus request was sent
    // throws; only a failure before anything was dispatched returns here and may fall back.
    const result = await deps.strategy.executeTap(deps.deviceId, element, driver, fence, signal);

    if (result.success) {
      // A focus-navigation gesture is acknowledged, not confirmed as an activation.
      reportTalkBackActivationWarning(result, options, action);
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
    const result = await deps.strategy.executeDirectActivation(element, driver, targetContext);

    if (result.success) {
      return undefined;
    }

    logger.warn(
      `[TapOnElement] Direct accessibility activation failed (${result.error}), ` +
        `falling back to coordinate-based tap at (${x}, ${y})`,
    );
  }

  await dispatchAccessibilityCoordinateFallback(deps, {
    action,
    x,
    y,
    element,
    durationMs,
    options,
    signal,
  });
  return screenReaderNavigation;
}

/** Recover a failed semantic activation using the currently resolved coordinates. */
async function dispatchAccessibilityCoordinateFallback(
  deps: AndroidAccessibilityTapDependencies,
  { action, x, y, element, durationMs, options, signal }: AndroidAccessibilityTapRequest,
): Promise<void> {
  const fence = options?.displayFence;
  // DocumentsUI item gestures can be acknowledged without activation, including
  // this TalkBack fallback path. Use the same row activation/input recovery.
  if (isAndroidDocumentsUiRow(element)) {
    await deps.coordinateTap(action, x, y, durationMs, element, signal, false, {
      displayFence: fence,
    });
    return;
  }

  // Fallback to coordinate-based taps via accessibility service dispatchGesture
  const fallbackAction = action as "tap" | "doubleTap" | "longPress";
  const fallbackResult =
    fallbackAction === "tap"
      ? await deps.strategy.executePreciseTap(x, y, deps.driver, fence)
      : await deps.strategy.executeCoordinateFallback(
          x,
          y,
          fallbackAction,
          durationMs,
          deps.driver,
          {
            displayFence: fence,
          },
        );

  if (!fallbackResult.success) {
    logger.warn(
      `[TapOnElement] Accessibility coordinate tap failed (${fallbackResult.error}), ` +
        `falling back to ADB tap at (${x}, ${y})`,
    );
    await deps.coordinateTap(action, x, y, durationMs, element, signal, false, {
      displayFence: fence,
    });
  }
  reportTalkBackActivationWarning(fallbackResult, options, action);
}
