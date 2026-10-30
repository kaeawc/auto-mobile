import { describeFocusTarget } from "./tapFocusIdentity";
import { markFocusFailure, resolvedElementLayer, withResolvedLayer } from "./tapFocusResult";
import { TapTargetUnavailableError } from "./tapTargetSupport";
import type { AndroidTapVerification, TapVerificationOptions } from "./tapVerificationOptions";
import { TapPointPlanner } from "./tapPointPlanner";
import { DispatchedObservationError } from "../../models/DispatchedObservationError";
import { unsupportedDisplayOptionMessage } from "../observe/SessionDisplayContext";
import { StaleDisplayError, withStaleDisplay } from "../observe/StaleDisplayError";
import { KeyboardOcclusionError } from "../../models/KeyboardOcclusionError";
import { requireAndroidOrIosPlatform } from "../../models/Platform";
import { isFocusEditableElement } from "../utility/ElementResolver";
import { errorMessage } from "../../utils/describeUnknownError";
import { type DisplayTransitionReader } from "../observe/DisplayTransition";
import { type HierarchyCapture } from "../observe/HierarchyCapture";
import { BaseVisualChange } from "./BaseVisualChange";
import {
  ActionableError,
  BootedDevice,
  ElementSelectionResult,
  ObserveResult,
  TapOnElementResult,
  ViewHierarchyResult,
} from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import { isElementKeyboardFocused } from "../utility/FocusedInput";
import { logger } from "../../utils/logger";
import { reportToolDispatched } from "../../utils/ToolDispatchContext";
import { type Timer } from "../../utils/SystemTimer";
import { type TalkBackNavigationDriverFactory } from "../talkback/TalkBackNavigationDriver";
import { talkBackDisplayRefusal } from "../talkback/talkBackDisplayRefusal";
import type { TapStrategy } from "../../utils/interfaces/TapStrategy";
import { androidDisplayTapDispatch } from "./coordinateTapDispatch";
import {
  prepareTargetDisplayAction,
  refreshTargetDisplayHierarchy,
  type RenderedObservationReader,
} from "./TargetDisplayAction";
import { OBSERVED_INTERACTION_PROFILES } from "./observedInteractionProfiles";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import type { TapOnCtrlProxy } from "./tapHierarchyRead";
import type { BaseActionResult } from "../../models/BaseActionResult";
import { TapSemanticLinks } from "./TapSemanticLinks";
import { TapTargetResolver } from "./TapTargetResolver";
import type { TapOnTalkBackStrategy } from "./TapGestureDispatcher";
import { TapGestureDispatcher } from "./TapGestureDispatcher";
import { warningsField, type TapOnFocusOutcome } from "./TapSemanticLinks";

type AndroidDisplayTalkBackState = { enabled: boolean; warnings: string[] };
type SearchUntilStats = NonNullable<TapOnElementResult["searchUntil"]>;

/** Capabilities used by this phase; dependency readers observe replacements made by tests. */
export interface TapDisplayRouterHost {
  routesAndroidDisplay(): boolean;
  readonly accessibilityService: () => TapOnCtrlProxy;
  readonly adb: () => AdbExecutor;
  applyEnsureCheckedResult: TapTargetResolver["applyEnsureCheckedResult"];
  buildSelectedElementMetadata: TapTargetResolver["buildSelectedElementMetadata"];
  checkPostActionDisplay: (
    result: Pick<BaseActionResult, "observation" | "staleDisplay">,
    assertCurrent: (() => void) | undefined,
    signal?: AbortSignal,
  ) => boolean;
  completedDisplayFailure: TapDisplayRouter["completedDisplayFailure"];
  createErrorResult: TapSemanticLinks["createErrorResult"];
  readonly device: () => BootedDevice;
  readonly displayTransitionReader: () => DisplayTransitionReader;
  ensureCheckedBeforeTap: TapTargetResolver["ensureCheckedBeforeTap"];
  findElementInHierarchy: TapTargetResolver["findElementInHierarchy"];
  readonly geometry: () => ElementGeometry;
  getSearchUntilDuration: TapTargetResolver["getSearchUntilDuration"];
  handleElementNotFound: TapTargetResolver["handleElementNotFound"];
  hashViewHierarchy: TapTargetResolver["hashViewHierarchy"];
  readonly hierarchyCapture: () => HierarchyCapture;
  readonly lastRenderedObservation: () => RenderedObservationReader | undefined;
  readonly observeScreen: () => ObserveScreen;
  observedInteraction: BaseVisualChange["observedInteraction"];
  refreshEnsureCheckedSelection: TapTargetResolver["refreshEnsureCheckedSelection"];
  replaceObservationHierarchy: TapTargetResolver["replaceObservationHierarchy"];
  resolveAndroidStableTapTargetAfterRefreshes: TapTargetResolver["resolveAndroidStableTapTargetAfterRefreshes"];
  resolveVisibleTapPoint: TapTargetResolver["resolveVisibleTapPoint"];
  rethrowKeyboardOcclusion: TapDisplayRouter["rethrowKeyboardOcclusion"];
  rethrowObservationAbort: (error: unknown, signal?: AbortSignal, enabled?: boolean) => void;
  retryTapIfNoChange: TapGestureDispatcher["retryTapIfNoChange"];
  searchForElement: TapTargetResolver["searchForElement"];
  staleDisplay: (observedGeneration: number) => StaleDisplayError;
  readonly strategy: () => TapStrategy;
  readonly talkBackDriverFactory: () => TalkBackNavigationDriverFactory;
  readonly talkBackStrategy: () => TapOnTalkBackStrategy;
  readonly tapPoints: () => TapPointPlanner;
  readonly timer: () => Timer;
  unverifiableDisplayPostState: TapDisplayRouter["unverifiableDisplayPostState"];
  validateOptions: TapSemanticLinks["validateOptions"];
  verifyFocusedInputTarget: TapTargetResolver["verifyFocusedInputTarget"];
  visibleTapBounds: TapTargetResolver["visibleTapBounds"];
  withObservationScreenSize: TapTargetResolver["withObservationScreenSize"];
}

/** Routes explicit displays through scoped target resolution and verification. */
export class TapDisplayRouter {
  constructor(private readonly host: TapDisplayRouterHost) {}

  private async prepareAndroidDisplaySelection(
    options: TapVerificationOptions,
    context: {
      target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
      selection: ElementSelectionResult;
      signal?: AbortSignal;
    },
  ): Promise<
    | { selection: ElementSelectionResult; hierarchy: ViewHierarchyResult }
    | { result: TapOnElementResult }
  > {
    const { target, signal } = context;
    let selection = context.selection;
    let hierarchy = target.observation.viewHierarchy;
    if (!hierarchy) {
      throw new ActionableError("Selected display has no view hierarchy");
    }
    const liveSelection = await this.host.refreshEnsureCheckedSelection(
      options,
      target.observation,
      selection,
      signal,
    );
    selection = liveSelection.selection;
    hierarchy = liveSelection.viewHierarchy;
    const searchUntil = { durationMs: 0, requestCount: 0, changeCount: 0 };
    const checkedResult =
      selection.element &&
      this.host.ensureCheckedBeforeTap(
        options,
        selection.element,
        this.host.buildSelectedElementMetadata(selection),
        searchUntil,
      );
    if (checkedResult) {
      return { result: checkedResult };
    }
    if (this.host.strategy().shouldRunPreTapStability(options)) {
      const stable = await this.host.resolveAndroidStableTapTargetAfterRefreshes(
        options,
        target.observation,
        options.action,
        { requireResourceId: false, signal },
      );
      if (!stable.ok) {
        return { result: { success: false, error: stable.error } as TapOnElementResult };
      }
      this.host.replaceObservationHierarchy(target.observation, stable.viewHierarchy, true);
      hierarchy = stable.viewHierarchy;
      selection = { ...stable.selection, element: stable.tapElement };
      const stableCheckedResult = this.host.ensureCheckedBeforeTap(
        options,
        stable.selection.element ?? stable.tapElement,
        this.host.buildSelectedElementMetadata(selection),
        searchUntil,
      );
      if (stableCheckedResult) {
        return { result: stableCheckedResult };
      }
    }
    return { selection, hierarchy };
  }

  private async executeOnAndroidDisplay(
    options: TapVerificationOptions & { verification: AndroidTapVerification },
    context: {
      target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
      selection: ElementSelectionResult;
      signal?: AbortSignal;
      onDispatched: () => void;
      talkBack: AndroidDisplayTalkBackState;
    },
  ): Promise<TapOnFocusOutcome> {
    const { target, signal } = context;
    const prepared = await this.prepareAndroidDisplaySelection(options, context);
    if ("result" in prepared) {
      return prepared.result;
    }
    const { selection, hierarchy } = prepared;
    const element = selection.element;
    if (!element?.bounds) {
      throw new TapTargetUnavailableError("Element not found on selected display", "not-found");
    }
    const selectedElement = this.host.buildSelectedElementMetadata(selection);
    const resolvedLayer = resolvedElementLayer(
      hierarchy,
      element,
      requireAndroidOrIosPlatform(this.host.device().platform, "tapOn"),
    );
    if (options.action === "focus") {
      if (!isFocusEditableElement(element)) {
        return {
          success: false,
          action: options.action,
          element,
          selectedElement,
          error: `Cannot focus ${describeFocusTarget(element, options)} because it is not an editable input`,
        };
      }
      if (isElementKeyboardFocused(element)) {
        return withResolvedLayer(
          {
            success: true,
            action: options.action,
            element,
            selectedElement,
            wasAlreadyFocused: true,
            focusChanged: false,
            focusVerified: true,
            ...this.host.geometry().getElementCenter(element),
          },
          resolvedLayer,
        );
      }
    }
    const visibleBounds = this.host.visibleTapBounds(selection, hierarchy, {
      screenSize: target.observation.screenSize,
      options,
    });
    const point =
      visibleBounds &&
      this.host.resolveVisibleTapPoint(element, hierarchy, visibleBounds, {
        options,
        screenSize: target.observation.screenSize,
      });
    if (!point) {
      throw new TapTargetUnavailableError(
        "Matched element has no visible tap area on selected display",
        this.host
          .tapPoints()
          .visibilityFailureReason(selection, hierarchy, target.observation.screenSize),
      );
    }
    const preTapHash = options.retryIfNoChange ? this.host.hashViewHierarchy(hierarchy) : null;
    const displayWarnings: string[] = [...context.talkBack.warnings];
    const dispatchAction = await this.androidDisplayDispatch(options, {
      ...context,
      onWarning: (warning) => displayWarnings.push(warning),
    });
    // Everything that waits for the target is behind us. Report BEFORE the command goes out, the
    // earliest moment the gesture can take effect: reporting once it returns could put the
    // dispatch after the navigation event it caused (#10196).
    reportToolDispatched();
    await dispatchAction(point);
    if (preTapHash && this.host.strategy().retryTapIfNoChange) {
      await this.host.retryTapIfNoChange(preTapHash, point, options.action, {
        longPressDuration: this.host.strategy().longPressDurationMs,
        tapElement: element,
        options: {
          ...this.host.withObservationScreenSize(options, target.observation),
          verification: { refresh: options.verification.refresh, dispatch: dispatchAction },
        },
        isTalkBackEnabled: false,
        screenSize: target.observation.screenSize,
        signal,
        selection,
      });
    }
    return withResolvedLayer(
      {
        success: true,
        action: options.action,
        element,
        selectedElement,
        ...warningsField(displayWarnings),
      },
      resolvedLayer,
    );
  }

  private async resolveAndroidDisplayTalkBack(
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>,
  ): Promise<AndroidDisplayTalkBackState> {
    const warnings: string[] = [];
    const enabled = await this.host
      .strategy()
      .isAccessibilityServiceEnabled((warning) => warnings.push(warning));
    const refusal = enabled ? talkBackDisplayRefusal(target.displayId) : undefined;
    if (refusal) {
      throw refusal;
    }
    return { enabled, warnings };
  }

  private async androidDisplayDispatch(
    options: TapOnElementOptions,
    context: {
      target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
      signal?: AbortSignal;
      onDispatched: () => void;
      onWarning?: (warning: string) => void;
      talkBack: AndroidDisplayTalkBackState;
    },
  ): Promise<(point: { x: number; y: number }) => Promise<void>> {
    return androidDisplayTapDispatch(
      this.host.accessibilityService(),
      this.host.adb(),
      {
        action: options.action === "focus" ? "tap" : options.action,
        duration: options.duration,
      },
      {
        target: context.target,
        signal: context.signal,
        onDispatched: context.onDispatched,
        timer: this.host.timer(),
        onWarning: context.onWarning,
        talkBack: context.talkBack.enabled
          ? {
              strategy: this.host.talkBackStrategy(),
              driver: this.host.talkBackDriverFactory().createDriver(this.host.device()),
            }
          : undefined,
      },
    );
  }

  private selectElementOnDisplay(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
  ): ElementSelectionResult {
    if (options.action === "focus") {
      const selection = this.host.findElementInHierarchy(options, hierarchy).selection;
      if (selection.element) {
        return selection;
      }
      // Focus lookup filters out inert nodes. Reuse inspect lookup only to
      // report the editable-input error for a selector matching such a node.
      const inspected = this.host.findElementInHierarchy(
        { ...options, action: "tap" },
        hierarchy,
      ).selection;
      return inspected.element && !isFocusEditableElement(inspected.element)
        ? inspected
        : selection;
    }
    return this.host.findElementInHierarchy(options, hierarchy).selection;
  }

  private async resolveAndroidDisplaySelection(
    options: TapVerificationOptions,
    observation: ObserveResult,
    signal?: AbortSignal,
  ): Promise<
    { selection: ElementSelectionResult; stats: SearchUntilStats } | { result: TapOnElementResult }
  > {
    if (!observation.viewHierarchy) {
      throw new ActionableError("Selected display has no view hierarchy");
    }
    // Preserve focus's inspect fallback for the editable-input error.
    if (options.action === "focus") {
      const selection = this.selectElementOnDisplay(
        this.host.withObservationScreenSize(options, observation),
        observation.viewHierarchy,
      );
      if (selection.element) {
        return { selection, stats: { durationMs: 0, requestCount: 0, changeCount: 0 } };
      }
    }
    const outcome = await this.host.searchForElement(options, observation, signal);
    this.host.replaceObservationHierarchy(
      observation,
      outcome.viewHierarchy,
      outcome.refreshedFromDevice,
    );
    if (!outcome.selection.element) {
      try {
        if (outcome.visibilityError) {
          throw outcome.visibilityError;
        }
        // Vision screenshots are not display-aware. Omit the observation to keep
        // the shared base error without invoking default-display vision fallback.
        await this.host.handleElementNotFound(options, {
          containerFound: outcome.containerFound,
          signal,
          selection: outcome.selection,
        });
      } catch (error) {
        logger.warn(`tapOn display resolution failed: ${errorMessage(error)}`, error);
        return {
          result: markFocusFailure(
            options.action,
            {
              ...this.host.createErrorResult(options.action, errorMessage(error)),
              searchUntil: outcome.stats,
            },
            error,
          ),
        };
      }
    }
    return outcome;
  }

  private async observedAndroidDisplayInteraction(
    options: TapOnElementOptions,
    context: {
      target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
      signal?: AbortSignal;
      onDispatchCompleted: () => void;
    },
  ): Promise<TapOnElementResult> {
    const { target, signal } = context;
    const talkBack = await this.resolveAndroidDisplayTalkBack(target);
    const refresh: AndroidTapVerification["refresh"] = (timeoutMs) =>
      refreshTargetDisplayHierarchy(target, this.host.hierarchyCapture(), timeoutMs, {
        stale: () =>
          this.host.staleDisplay(
            target.observation.display.generation ??
              this.host.displayTransitionReader().identityRevision(this.host.device().deviceId),
          ),
        signal,
      });
    const verificationOptions = { ...options, verification: { refresh } };
    const resolved = await this.resolveAndroidDisplaySelection(
      verificationOptions,
      target.observation,
      signal,
    );
    if ("result" in resolved) {
      return resolved.result;
    }
    const { selection, stats } = resolved;
    let tapTimestamp: number | undefined;
    const result: Awaited<ReturnType<TapDisplayRouter["executeOnAndroidDisplay"]>> =
      await this.host.observedInteraction(
        async () => {
          const dispatchedResult = await this.executeOnAndroidDisplay(verificationOptions, {
            target,
            selection,
            signal,
            talkBack,
            onDispatched: () => {
              tapTimestamp = this.host.timer().now();
            },
          });
          if (tapTimestamp !== undefined) {
            context.onDispatchCompleted();
          }
          return dispatchedResult;
        },
        {
          ...OBSERVED_INTERACTION_PROFILES.rawCoordinateGesture,
          display: target.observation.display.key,
          previousObservation: target.observation,
          signal,
          ...(options.ensureChecked !== undefined
            ? { observationHostTimestampProvider: () => tapTimestamp }
            : {}),
        },
      );
    result.searchUntil = stats;
    if (tapTimestamp === undefined) {
      target.assertCurrent();
    } else {
      this.host.checkPostActionDisplay(result, target.assertCurrent, signal);
      if (result.staleDisplay) {
        return this.host.unverifiableDisplayPostState(result, options);
      }
    }
    if (result.success && result.skipped !== "already-checked") {
      await this.host.applyEnsureCheckedResult(result, verificationOptions, signal);
    }
    return this.finalizeDisplayFocusResult(result, options, selection, target.observation);
  }

  unverifiableDisplayPostState(
    result: TapOnElementResult,
    options: Pick<TapOnElementOptions, "action" | "ensureChecked">,
  ): TapOnElementResult {
    if (
      !result.staleDisplay ||
      (options.action !== "focus" && options.ensureChecked === undefined)
    ) {
      return result;
    }
    return withStaleDisplay(
      { ...result, success: false, error: undefined },
      new DispatchedObservationError(new StaleDisplayError(result.staleDisplay)),
    );
  }

  private finalizeDisplayFocusResult(
    result: TapOnElementResult & { wasAlreadyFocused?: boolean },
    options: TapOnElementOptions,
    selection: ElementSelectionResult,
    previousObservation: ObserveResult,
  ): TapOnElementResult {
    if (options.action !== "focus" || !result.success || result.wasAlreadyFocused) {
      return result;
    }
    const labelText =
      selection.matchedElement !== result.element ? selection.matchedElement?.text : undefined;
    result.focusVerified = this.host.verifyFocusedInputTarget(
      options,
      result.element,
      result.observation,
      {
        labelText,
        selectedIndex: result.selectedElement?.indexInMatches,
        preTapHierarchy: previousObservation.viewHierarchy,
      },
    );
    if (!result.focusVerified) {
      result.success = false;
      result.error = `Failed to confirm focus on editable input ${describeFocusTarget(result.element, options)}: the focused field could not be matched to the target`;
    }
    return result;
  }

  async executeOnDisplay(
    options: TapOnElementOptions,
    signal?: AbortSignal,
    recovery?: { throwOnKeyboardOcclusion?: boolean },
  ): Promise<TapOnElementResult | undefined> {
    const display = options.display;
    let dispatchCompleted = false;
    if (display !== undefined) {
      try {
        const unsupported = (
          ["subtext", "accessibilityLink", "focusFirst", "screenReaderNavigation"] as const
        ).find((key) => options[key] !== undefined);
        if (unsupported) {
          throw new ActionableError(unsupportedDisplayOptionMessage(unsupported));
        }
        if (options.ensureTap) {
          options = { ...options, preTapStability: true, retryIfNoChange: true };
        }
        // Preserve unsupported-option precedence while sharing selector validation.
        const needsValidation =
          options.ensureChecked !== undefined ||
          options.sibling !== undefined ||
          options.textAny !== undefined ||
          options.searchUntil !== undefined;
        const validationError = needsValidation ? this.host.validateOptions(options) : null;
        if (validationError) {
          return this.host.createErrorResult(options.action, validationError);
        }
        if (options.searchUntil !== undefined) {
          this.host.getSearchUntilDuration(options);
        }
        const target = await prepareTargetDisplayAction(
          this.host.device(),
          display,
          this.host.observeScreen(),
          this.host.adb(),
          {
            lastRenderedObservation: this.host.lastRenderedObservation(),
            signal,
            transitions: this.host.displayTransitionReader(),
          },
        );
        if (this.host.routesAndroidDisplay()) {
          return await this.observedAndroidDisplayInteraction(options, {
            target,
            signal,
            onDispatchCompleted: () => {
              dispatchCompleted = true;
            },
          });
        }
      } catch (error) {
        this.host.rethrowObservationAbort(error, signal, dispatchCompleted);
        this.host.rethrowKeyboardOcclusion(error, options.action, recovery);
        logger.warn(`tapOn display routing failed: ${errorMessage(error)}`, error);
        const failure = this.host.completedDisplayFailure(error, dispatchCompleted);
        return withStaleDisplay(
          this.host.createErrorResult(options.action, errorMessage(failure), failure),
          failure,
        );
      }
    }
    return undefined;
  }

  didCompleteDisplayGesture(
    result: TapOnElementResult & { wasAlreadyFocused?: boolean },
    display?: string,
  ): boolean {
    return display !== undefined && result.success && !result.skipped && !result.wasAlreadyFocused;
  }

  completedDisplayFailure(error: unknown, dispatchCompleted: boolean): unknown {
    // Verification runs after the complete gesture block; in-block refusals and
    // partial multi-stroke failures keep their existing dispatch semantics.
    return dispatchCompleted && error instanceof StaleDisplayError
      ? new DispatchedObservationError(error)
      : error;
  }

  rethrowKeyboardOcclusion(
    error: unknown,
    action: TapOnElementOptions["action"],
    recovery?: { throwOnKeyboardOcclusion?: boolean },
  ): void {
    if (
      recovery?.throwOnKeyboardOcclusion &&
      this.host.strategy().rethrowsKeyboardOcclusion &&
      action === "focus" &&
      error instanceof KeyboardOcclusionError
    ) {
      logger.debug(`Tap on element awaits IME recovery: ${errorMessage(error)}`, error);
      throw error;
    }
  }
}
