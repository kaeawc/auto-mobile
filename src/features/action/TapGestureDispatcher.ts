import { pointInTapBounds } from "./tapTargetSupport";
import { TapElementFinder } from "./tapElementFinder";
import { tapViaVoiceOver } from "./tapIosVoiceOver";
import { TapPointPlanner } from "./tapPointPlanner";
import type { TapVerificationOptions } from "./tapVerificationOptions";
import { isStrictlyScoped } from "../utility/ScopedSelection";
import { assertLongPressWithinHardMax, throwIfLongPressInterrupted } from "./tapSharedHelpers";
import {
  isSemanticActionRejected,
  type TalkBackTargetContext,
} from "../talkback/resourceIdActionError";
import { dispatchAndroidLongPress } from "./androidLongPress";
import { StaleDisplayError } from "../observe/StaleDisplayError";
import { type DisplayFence, type DisplayFenceOption } from "./BaseVisualChange";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import {
  ActionableError,
  BootedDevice,
  Element,
  ElementSelectionResult,
  ObserveResult,
  type Point,
  ViewHierarchyResult,
} from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import { logger } from "../../utils/logger";
import { IOSCtrlProxyClient } from "../observe/ios";
import { throwIfAborted } from "../../utils/toolUtils";
import { type Timer } from "../../utils/SystemTimer";
import { scopeHierarchyForSelector } from "../observe/hierarchyLayer";
import { type TalkBackNavigationDriverFactory } from "../talkback/TalkBackNavigationDriver";
import {
  nodeActionTargetError,
  requiresNodeSelector,
  stableNodeSelectorForElement,
  TALKBACK_ACTIVATION_WARNING,
  TalkBackTapStrategy,
  type ScreenReaderNavigationResult,
  type TalkBackTapResult,
} from "../talkback/TalkBackTapStrategy";
import { hasAccessibilityAction, isTruthyFlag } from "../utility/elementProperties";
import { isAndroidDocumentsUiRow } from "./androidCoordinateTapPolicy";
import type { TapStrategy } from "../../utils/interfaces/TapStrategy";
import { type FeatureFlagReader } from "../featureFlags/FeatureFlagService";
import { dispatchAndroidDoubleTap } from "./androidDoubleTap";
import {
  dispatchAndroidCoordinateTap,
  dispatchIosCoordinateTap,
  dispatchIosDoubleTap,
} from "./coordinateTapDispatch";
import { executeTouchscreenInput } from "./touchscreenInput";
import {
  checkAndroidTapHierarchyChange,
  POST_TAP_REFRESH_TIMEOUT_MS,
  PRE_RETRY_DELAY_MS,
} from "./androidGhostTapRetry";
import type { TapOnCtrlProxy } from "./tapHierarchyRead";
import { TapTargetResolver } from "./TapTargetResolver";

/** Internal action context; never part of the public tapOn schema. */
export type IosTapOptions = DisplayFenceOption & { signal?: AbortSignal };

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

/** The TalkBack strategy surface TapOnElement calls; fakes implement exactly this. */
export type TapOnTalkBackStrategy = Pick<
  TalkBackTapStrategy,
  | "executeTap"
  | "executeDirectActivation"
  | "executeCoordinateFallback"
  | "executePreciseTap"
  | "executeLongPress"
>;

/** Capabilities used by this phase; dependency readers observe replacements made by tests. */
export interface TapGestureDispatcherHost {
  readonly accessibilityService: () => TapOnCtrlProxy;
  readonly adb: () => AdbExecutor;
  readonly device: () => BootedDevice;
  dispatchCoordinateTapOrAdbFallback: TapGestureDispatcher["dispatchCoordinateTapOrAdbFallback"];
  executeAndroidLongPress: TapGestureDispatcher["executeAndroidLongPress"];
  executeAndroidTap: TapGestureDispatcher["executeAndroidTap"];
  executeAndroidTapWithAccessibility: TapGestureDispatcher["executeAndroidTapWithAccessibility"];
  executeAndroidTapWithCoordinates: TapGestureDispatcher["executeAndroidTapWithCoordinates"];
  executeIOSTapWithVoiceOver: TapGestureDispatcher["executeIOSTapWithVoiceOver"];
  executeScopedAndroidTap: TapGestureDispatcher["executeScopedAndroidTap"];
  executeiOSTapWithCoordinates: TapGestureDispatcher["executeiOSTapWithCoordinates"];
  readonly featureFlags: () => FeatureFlagReader;
  findElementInHierarchy: TapTargetResolver["findElementInHierarchy"];
  readonly finder: () => TapElementFinder;
  readonly geometry: () => ElementGeometry;
  getScreenSizeFromHierarchy: TapPointPlanner["getScreenSizeFromHierarchy"];
  hashViewHierarchy: TapTargetResolver["hashViewHierarchy"];
  isScreenReaderNavigationEnabled: TapGestureDispatcher["isScreenReaderNavigationEnabled"];
  readOptionalDisplayFence: TapGestureDispatcher["readOptionalDisplayFence"];
  refreshedRetrySelection: TapGestureDispatcher["refreshedRetrySelection"];
  reportTalkBackActivationWarning: TapGestureDispatcher["reportTalkBackActivationWarning"];
  resolveEnsureCheckedRetryTarget: TapGestureDispatcher["resolveEnsureCheckedRetryTarget"];
  resolveRefreshedRetryTarget: TapGestureDispatcher["resolveRefreshedRetryTarget"];
  resolveTapTargetElement: TapTargetResolver["resolveTapTargetElement"];
  resolveVisibleTapPoint: TapTargetResolver["resolveVisibleTapPoint"];
  semanticAndroidLongPressTargetError: TapGestureDispatcher["semanticAndroidLongPressTargetError"];
  readonly strategy: () => TapStrategy;
  readonly talkBackDriverFactory: () => TalkBackNavigationDriverFactory;
  readonly talkBackStrategy: () => TapOnTalkBackStrategy;
  talkBackTargetContext: TapGestureDispatcher["talkBackTargetContext"];
  tapVerificationRefresh: TapTargetResolver["tapVerificationRefresh"];
  readonly timer: () => Timer;
  tryDocumentsUiRowActivation: TapGestureDispatcher["tryDocumentsUiRowActivation"];
  trySemanticAndroidLongPress: TapGestureDispatcher["trySemanticAndroidLongPress"];
  visibleTapBounds: TapTargetResolver["visibleTapBounds"];
  withRetryScreenSize: TapGestureDispatcher["withRetryScreenSize"];
}

/** Delivers platform gestures, accessibility fallbacks, and one ghost-tap retry. */
export class TapGestureDispatcher {
  constructor(private readonly host: TapGestureDispatcherHost) {}

  async executeAndroidTap(
    action: string,
    point: Point,
    durationMs: number,
    element: Element,
    {
      signal,
      options,
      isTalkBackEnabled,
    }: {
      signal?: AbortSignal;
      options?: TapOnElementOptions & ResolvedAndroidTapOptions;
      isTalkBackEnabled?: boolean;
    } = {},
  ): Promise<ScreenReaderNavigationResult | undefined> {
    const { x, y } = point;
    const { displayFence: fence, resolvedHierarchy, onActivationWarning } = options ?? {};
    // Check if TalkBack is enabled (not just any accessibility service)
    const talkBackEnabled =
      typeof isTalkBackEnabled === "boolean"
        ? isTalkBackEnabled
        : await this.host.strategy().isAccessibilityServiceEnabled(options?.onActivationWarning);

    // XML-only candidates have no CtrlProxy node identity, even if their resource
    // ID also exists in the incomplete native tree. Never retarget semantic actions.
    if (element["hierarchy-source"] === "uiautomator") {
      await this.host.executeAndroidTapWithCoordinates(
        action,
        x,
        y,
        durationMs,
        element,
        signal,
        true,
        {
          displayFence: fence,
          onActivationWarning,
        },
      );
      return undefined;
    }

    if (isStrictlyScoped(options)) {
      await this.host.executeScopedAndroidTap({
        action,
        x,
        y,
        durationMs,
        element,
        signal,
        talkBackEnabled,
        fence,
        onActivationWarning: options?.onActivationWarning,
      });
      return undefined;
    }

    if (talkBackEnabled) {
      // TalkBack mode: Use accessibility actions or precise coordinate
      // gestures through its CtrlProxy driver, with ADB as the last fallback.
      return this.host.executeAndroidTapWithAccessibility(
        action,
        x,
        y,
        element,
        durationMs,
        options,
        signal,
      );
    }

    await this.host.executeAndroidTapWithCoordinates(
      action,
      x,
      y,
      durationMs,
      element,
      signal,
      false,
      {
        displayFence: fence,
        resolvedHierarchy,
        onActivationWarning,
      },
    );
    return undefined;
  }

  async executeScopedAndroidTap(context: {
    action: string;
    x: number;
    y: number;
    durationMs: number;
    element: Element;
    signal?: AbortSignal;
    talkBackEnabled: boolean;
    fence?: DisplayFence;
    onActivationWarning?: (warning: string) => void;
  }): Promise<void> {
    const { action, x, y, durationMs, element, signal, talkBackEnabled, fence } = context;
    // Native resource-ID activation is global. Bind new scoped/unique calls to
    // the resolver's selected point, including accessibility and long-press fallback.
    if (talkBackEnabled) {
      const driver = this.host.talkBackDriverFactory().createDriver(this.host.device());
      const result =
        action === "tap"
          ? await this.host.talkBackStrategy().executePreciseTap(x, y, driver, fence)
          : await this.host
              .talkBackStrategy()
              .executeCoordinateFallback(
                { x, y },
                action as "doubleTap" | "longPress",
                durationMs,
                driver,
                { displayFence: fence },
              );
      if (result.success) {
        this.host.reportTalkBackActivationWarning(result, context, action);
        return;
      }
      await this.host.executeAndroidTapWithCoordinates(
        action,
        x,
        y,
        durationMs,
        element,
        signal,
        true,
        {
          displayFence: fence,
          onActivationWarning: context.onActivationWarning,
        },
      );
      this.host.reportTalkBackActivationWarning(result, context, action);
      return;
    }
    await this.host.executeAndroidTapWithCoordinates(
      action,
      x,
      y,
      durationMs,
      element,
      signal,
      true,
      {
        displayFence: fence,
        onActivationWarning: context.onActivationWarning,
      },
    );
  }

  async executeAndroidTapWithCoordinates(
    ...[action, x, y, durationMs, element, signal, skipSemanticAction = false, fenceOptions = {}]: [
      action: string,
      x: number,
      y: number,
      durationMs: number,
      element: Element,
      signal?: AbortSignal,
      skipSemanticAction?: boolean,
      fenceOptions?: ResolvedAndroidTapOptions,
    ]
  ): Promise<void> {
    const fence = fenceOptions.displayFence;
    if (action === "tap") {
      if (
        !skipSemanticAction &&
        isAndroidDocumentsUiRow(element) &&
        (await this.host.tryDocumentsUiRowActivation(element, signal))
      ) {
        return;
      }
      await this.host.dispatchCoordinateTapOrAdbFallback(x, y, element, signal, {
        displayFence: fence,
      });
    } else if (action === "longPress") {
      await this.host.executeAndroidLongPress(x, y, durationMs, element, {
        signal,
        skipSemanticAction,
        ...fenceOptions,
      });
    } else if (action === "doubleTap") {
      await dispatchAndroidDoubleTap({
        // DocumentsUI rows use ADB input recovery, which has no single-gesture form.
        client: isAndroidDocumentsUiRow(element) ? undefined : this.host.accessibilityService(),
        point: { x, y },
        timer: this.host.timer(),
        signal,
        assertCurrent: () => fence?.assertCurrent(),
        onWarning: fenceOptions.onActivationWarning,
        tap: () =>
          this.host.dispatchCoordinateTapOrAdbFallback(x, y, element, signal, {
            displayFence: fence,
          }),
      });
    }
  }

  async tryDocumentsUiRowActivation(element: Element, signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    const selector = stableNodeSelectorForElement(element);
    // item_root is repeated. Never fall back to the runner's first resource-id match.
    if (
      !hasAccessibilityAction(element.actions, "click") ||
      !selector ||
      (selector.uniqueId === undefined &&
        (selector.collectionRow === undefined || selector.collectionColumn === undefined))
    ) {
      return false;
    }
    try {
      if (
        !(await this.host.accessibilityService().supportsNodeActionSelectors(undefined, signal))
      ) {
        return false;
      }
      throwIfAborted(signal);
      const result = await this.host
        .accessibilityService()
        .requestNodeAction("click", selector, undefined, undefined, signal);
      throwIfAborted(signal);
      return result.success;
    } catch (error) {
      if (error instanceof StaleDisplayError) {
        throw error;
      }
      throwIfAborted(signal);
      logger.warn(`[TapOnElement] DocumentsUI row activation failed: ${error}`);
      return false;
    }
  }

  async dispatchCoordinateTapOrAdbFallback(
    x: number,
    y: number,
    element: Element,
    signal?: AbortSignal,
    fenceOptions: DisplayFenceOption = {},
  ): Promise<void> {
    const fence = fenceOptions.displayFence;
    throwIfAborted(signal);
    const requiresAdbInput = isAndroidDocumentsUiRow(element);
    if (!requiresAdbInput) {
      // Once beforeSend lands, also pass this as the dispatch's beforeSend.
      fence?.assertCurrent();
      await dispatchAndroidCoordinateTap(
        this.host.accessibilityService(),
        this.host.adb(),
        { x, y },
        10,
        { signal },
      );
      return;
    }
    logger.info(`[TapOnElement] Using ADB input recovery for DocumentsUI row at (${x}, ${y})`);
    // Once beforeSend lands, also pass this as the dispatch's beforeSend.
    fence?.assertCurrent();
    await executeTouchscreenInput(this.host.adb(), `tap ${x} ${y}`, undefined, signal);
  }

  resolveEnsureCheckedRetryTarget(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
    action: string,
    requireResourceId: boolean,
  ): Element | null {
    const refound = this.host.findElementInHierarchy(options, hierarchy).selection.element;
    if (!refound || !isTruthyFlag(refound.checkable)) {
      logger.warn(
        "[TapOnElement][retryIfNoChange] Toggle not found in fresh hierarchy; skipping retry",
      );
      return null;
    }
    if (isTruthyFlag(refound.checked) === options.ensureChecked) {
      logger.info("[TapOnElement][retryIfNoChange] Toggle reached requested checked state");
      return null;
    }
    return this.host.resolveTapTargetElement(refound, hierarchy, action, {
      requireResourceId,
      scoped: options.container !== undefined,
    }).element;
  }

  withRetryScreenSize(
    options: TapVerificationOptions,
    screenSize: ObserveResult["screenSize"],
  ): TapVerificationOptions {
    return {
      ...options,
      screenSizeOptions: options.screenSizeOptions ?? { observationScreenSize: screenSize },
    };
  }

  refreshedRetrySelection(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
    tapElement: Element,
    previous?: ElementSelectionResult,
  ): ElementSelectionResult {
    if (options.text || options.textAny?.length || options.elementId || options.testTag) {
      return this.host.findElementInHierarchy(options, hierarchy).selection;
    }
    return (
      previous ?? { element: tapElement, indexInMatches: -1, totalMatches: 1, strategy: "first" }
    );
  }

  resolveRefreshedRetryTarget(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
    action: string,
    retry: {
      isTalkBackEnabled: boolean;
      selection: ElementSelectionResult;
      previousTarget: Element;
    },
  ): Element | null {
    const { isTalkBackEnabled, selection, previousTarget } = retry;
    if (options.ensureChecked !== undefined) {
      return this.host.resolveEnsureCheckedRetryTarget(
        options,
        hierarchy,
        action,
        isTalkBackEnabled,
      );
    }
    if (selection.element) {
      return this.host.resolveTapTargetElement(selection.element, hierarchy, action, {
        requireResourceId: isTalkBackEnabled,
        scoped: options.container !== undefined,
      }).element;
    }
    if (options.text || options.textAny?.length || options.elementId || options.testTag) {
      logger.warn(
        "[TapOnElement][retryIfNoChange] Target not found in refreshed hierarchy; skipping retry",
      );
      return null;
    }
    return previousTarget;
  }

  async retryTapIfNoChange(
    preTapHash: string | null,
    tapPoint: { x: number; y: number },
    action: string,
    longPressDuration: number,
    {
      tapElement,
      options,
      isTalkBackEnabled,
      screenSize,
      signal,
      selection,
    }: {
      tapElement: Element;
      options: TapVerificationOptions & DisplayFenceOption;
      isTalkBackEnabled: boolean;
      screenSize: ObserveResult["screenSize"];
      signal?: AbortSignal;
      selection?: ElementSelectionResult;
    },
  ): Promise<void> {
    const probe = await checkAndroidTapHierarchyChange(
      this.host.timer(),
      this.host.tapVerificationRefresh({
        refresh: options.verification?.refresh,
        screenSize,
        signal,
      }),
      (hierarchy) => this.host.hashViewHierarchy(hierarchy),
      preTapHash,
      signal,
    );

    if (probe.status === "unavailable") {
      // Hierarchy unreadable — we can't tell whether the tap registered. A retry
      // here is more likely to land on a transitioning screen and bounce us
      // off-path than to recover a real ghost tap. Bail and let the next
      // step's waitFor/observe surface a real failure.
      logger.warn(
        `[TapOnElement][retryIfNoChange] Tap hierarchy unreadable or could not be fingerprinted ` +
          `(post-tap refresh budget ${POST_TAP_REFRESH_TIMEOUT_MS}ms) — skipping retry`,
      );
      return;
    }

    if (probe.status === "changed") {
      logger.info(`[TapOnElement][retryIfNoChange] Hierarchy changed after tap — tap registered`);
      return;
    }

    const retryOptions = this.host.withRetryScreenSize(options, screenSize);
    const refreshedSelection = this.host.refreshedRetrySelection(
      retryOptions,
      probe.hierarchy,
      tapElement,
      selection,
    );
    const retryTarget = this.host.resolveRefreshedRetryTarget(
      retryOptions,
      probe.hierarchy,
      action,
      { isTalkBackEnabled, selection: refreshedSelection, previousTarget: tapElement },
    );
    if (!retryTarget) {
      return;
    }
    const retryScreenSize = this.host.getScreenSizeFromHierarchy(
      probe.hierarchy,
      retryOptions.screenSizeOptions,
    );
    const retryBounds = this.host.visibleTapBounds(
      refreshedSelection.element
        ? refreshedSelection
        : (selection ?? { ...refreshedSelection, element: retryTarget }),
      probe.hierarchy,
      retryScreenSize,
      retryOptions,
      retryTarget,
    );
    if (!retryBounds) {
      logger.warn(
        "[TapOnElement][retryIfNoChange] Refreshed target has no visible tap area; skipping retry",
      );
      return;
    }
    const retryPoint = pointInTapBounds(tapPoint, retryBounds)
      ? tapPoint
      : this.host.resolveVisibleTapPoint(retryTarget, probe.hierarchy, retryBounds, {
          options,
          screenSize: retryScreenSize,
        });
    if (!retryPoint) {
      logger.warn(
        "[TapOnElement][retryIfNoChange] Refreshed target has no unobstructed tap point; skipping retry",
      );
      return;
    }
    logger.warn(
      `[TapOnElement][retryIfNoChange] Hierarchy unchanged after tap at ` +
        `(${retryPoint.x}, ${retryPoint.y}) — ghost tap detected, retrying`,
    );

    await this.host.timer().sleep(PRE_RETRY_DELAY_MS);

    if (options.verification?.dispatch) {
      await options.verification.dispatch(retryPoint);
      return;
    }
    await this.host.executeAndroidTap(action, retryPoint, longPressDuration, retryTarget, {
      signal,
      options: { ...options, resolvedHierarchy: probe.hierarchy },
      isTalkBackEnabled,
    });
  }

  isScreenReaderNavigationEnabled(options?: TapOnElementOptions): boolean {
    return (
      Boolean(options?.screenReaderNavigation) ||
      this.host.featureFlags().isEnabled("screen-reader-navigation")
    );
  }

  reportTalkBackActivationWarning(
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

  talkBackTargetContext(
    options: (TapOnElementOptions & ResolvedAndroidTapOptions) | undefined,
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
            const selection = this.host
              .finder()
              .selectElementInHierarchy(
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
    ...[action, x, y, element, durationMs, options, signal]: [
      action: string,
      x: number,
      y: number,
      element: Element,
      durationMs: number,
      options?: TapOnElementOptions &
        ResolvedAndroidTapOptions & { onActivationWarning?: (warning: string) => void },
      signal?: AbortSignal,
    ]
  ): Promise<ScreenReaderNavigationResult | undefined> {
    const fence = this.host.readOptionalDisplayFence(options);
    const driver = this.host.talkBackDriverFactory().createDriver(this.host.device());
    let screenReaderNavigation: ScreenReaderNavigationResult | undefined;
    const targetContext = this.host.talkBackTargetContext(
      options,
      action,
      (current, selection, hierarchy) => {
        element = current;
        const center = this.host.geometry().getElementCenter(current);
        x = center.x;
        y = center.y;
        options?.onResolvedElement?.(current, selection, hierarchy);
      },
    );

    if (action === "longPress") {
      // Long press: try ACTION_LONG_CLICK first, then coordinate gesture fallback
      const longPressResult = await this.host
        .talkBackStrategy()
        .executeLongPress({ x, y }, durationMs, element, driver, {
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
        .executeTap(this.host.device().deviceId, element, driver, fence, signal);

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
            .executeCoordinateFallback({ x, y }, fallbackAction, durationMs, driver, {
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

  async executeiOSTap(
    action: string,
    point: Point,
    durationMs: number,
    element?: Element,
    { isVoiceOverEnabled, ...fenceOptions }: IosTapOptions & { isVoiceOverEnabled?: boolean } = {},
  ): Promise<void> {
    const { x, y } = point;
    if (isVoiceOverEnabled && element) {
      await this.host.executeIOSTapWithVoiceOver(
        action,
        element,
        { x, y },
        durationMs,
        fenceOptions,
      );
      return;
    }

    await this.host.executeiOSTapWithCoordinates(action, x, y, durationMs, fenceOptions);
  }

  async executeiOSTapWithCoordinates(
    action: string,
    x: number,
    y: number,
    durationMs: number,
    fenceOptions: IosTapOptions = {},
  ): Promise<void> {
    const { displayFence: fence, signal } = fenceOptions;
    // Use short duration (50ms) for tap/doubleTap, full duration for longPress
    const tapDuration = action === "longPress" ? durationMs : 50;

    const client = IOSCtrlProxyClient.getInstance(this.host.device());

    if (action === "doubleTap") {
      fence?.assertCurrent();
      await dispatchIosDoubleTap(client, { x, y }, tapDuration, undefined, { signal });
      IOSCtrlProxyClient.getExistingInstance(this.host.device().deviceId)?.invalidateCache();
    } else {
      // Single tap or long press
      // Once beforeSend lands, also pass this as the dispatch's beforeSend.
      fence?.assertCurrent();
      await dispatchIosCoordinateTap(client, { x, y }, tapDuration, undefined, { signal });
      IOSCtrlProxyClient.getExistingInstance(this.host.device().deviceId)?.invalidateCache();
    }
  }

  executeIOSTapWithVoiceOver(
    action: string,
    element: Element,
    point: Point,
    durationMs: number,
    fenceOptions?: IosTapOptions,
  ): Promise<void> {
    const { x, y } = point;
    return tapViaVoiceOver({
      device: this.host.device(),
      action,
      element,
      point: { x, y },
      durationMs,
      fenceOptions: fenceOptions ?? {},
      coordinateTap: (opts) =>
        this.host.executeiOSTapWithCoordinates(action, x, y, durationMs, opts),
    });
  }

  readOptionalDisplayFence(options?: DisplayFenceOption): DisplayFence | undefined {
    return options?.displayFence;
  }

  getLongPressDuration(options: TapOnElementOptions): number {
    assertLongPressWithinHardMax(options.duration);
    if (typeof options.duration === "number" && options.duration > 0) {
      return options.duration;
    }
    return this.host.strategy().longPressDurationMs;
  }

  async executeAndroidLongPress(
    x: number,
    y: number,
    durationMs: number,
    element: Element,
    {
      signal,
      skipSemanticAction = false,
      ...fenceOptions
    }: ResolvedAndroidTapOptions & { signal?: AbortSignal; skipSemanticAction?: boolean } = {},
  ): Promise<void> {
    const fence = fenceOptions.displayFence;
    throwIfAborted(signal);
    if (!skipSemanticAction) {
      const selector = stableNodeSelectorForElement(element);
      if (
        selector &&
        (await this.host.trySemanticAndroidLongPress(element, selector, signal, fenceOptions))
      ) {
        return;
      }
    }

    await dispatchAndroidLongPress({
      adb: this.host.adb(),
      x,
      y,
      durationMs,
      signal,
      assertCurrent: fence ? () => fence.assertCurrent() : undefined,
      logTag: "TapOnElement",
    });
  }

  throwIfLongPressInterrupted(error: unknown, durationMs: number, signal?: AbortSignal): void {
    throwIfLongPressInterrupted(error, durationMs, signal);
  }

  semanticAndroidLongPressTargetError(
    selector: NonNullable<ReturnType<typeof stableNodeSelectorForElement>>,
    signal?: AbortSignal,
    options: ResolvedAndroidTapOptions = {},
  ): Promise<string | undefined> {
    // Raw search resolves against a filtered projection that may omit duplicate IDs.
    // Default extraction matches the cached tree already accepted by this guard.
    const resolvedHierarchy = resolveViewHierarchyForSearch(options.resolvedHierarchy);
    return nodeActionTargetError(selector, {
      supportsNodeActionSelectors: () =>
        this.host.accessibilityService().supportsNodeActionSelectors(),
      getAccessibilityHierarchy: () =>
        resolvedHierarchy
          ? Promise.resolve(resolvedHierarchy)
          : this.host.accessibilityService().getAccessibilityHierarchy(undefined, {
              skipWaitForFresh: true,
              disableAllFiltering: true,
              signal,
            }),
    });
  }

  async trySemanticAndroidLongPress(
    element: Element,
    selector: NonNullable<ReturnType<typeof stableNodeSelectorForElement>>,
    signal?: AbortSignal,
    options: ResolvedAndroidTapOptions = {},
  ): Promise<boolean> {
    const needsNodeSelector = requiresNodeSelector(selector);
    const targetError = await this.host.semanticAndroidLongPressTargetError(
      selector,
      signal,
      options,
    );
    // The hierarchy reader turns cancellation into null; never degrade it to a press.
    throwIfAborted(signal);
    if (targetError) {
      logger.info(`[TapOnElement] ${targetError}; using coordinate long press`);
      return false;
    }

    try {
      const result = needsNodeSelector
        ? await this.host.accessibilityService().requestNodeAction("long_click", selector)
        : await this.host.accessibilityService().requestAction("long_click", selector.resourceId);
      if (result.success) {
        return true;
      }
      const rejected = await isSemanticActionRejected({
        advertised: hasAccessibilityAction(element.actions, "long_click"),
        error: result.error,
        needsNodeSelector,
        selected: element,
        // Fresh and unfiltered, like the target guard: the cached tree may predate the miss.
        readHierarchy: () =>
          this.host.accessibilityService().getAccessibilityHierarchy(undefined, {
            skipWaitForFresh: true,
            disableAllFiltering: true,
            signal,
          }),
      });
      // The hierarchy reader turns cancellation into null; never degrade it to a press.
      throwIfAborted(signal);
      if (rejected) {
        throw new ActionableError(
          `Semantic long press failed for the selected element: ${result.error ?? "unknown error"}`,
        );
      }
      logger.warn(`[TapOnElement] Accessibility long click failed: ${result.error}`);
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      logger.warn(`[TapOnElement] Accessibility long click error: ${error}`);
    }
    return false;
  }
}
