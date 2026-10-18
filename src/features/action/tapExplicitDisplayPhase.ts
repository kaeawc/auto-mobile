import { TapTargetUnavailableError } from "./tapTargetSupport";
import type { AndroidTapVerification, TapVerificationOptions } from "./tapVerificationOptions";
import type { TapPointPlanner } from "./tapPointPlanner";
import {
  markFocusFailure,
  resolvedElementLayer,
  warningsField,
  withResolvedLayer,
  type TapOnFocusOutcome,
  type TapOnFocusResult,
} from "./tapResultMarkers";
import type { StableTapTargetResult } from "./androidStableTapTarget";
import { describeFocusTarget } from "./tapFocusIdentity";
import { DispatchedObservationError } from "../../models/DispatchedObservationError";
import { unsupportedDisplayOptionMessage } from "../observe/SessionDisplayContext";
import { withStaleDisplay, StaleDisplayError } from "../observe/StaleDisplayError";
import { KeyboardOcclusionError } from "../../models/KeyboardOcclusionError";
import { isFocusEditableElement } from "../utility/ElementResolver";
import type { HierarchyCapture } from "../observe/HierarchyCapture";
import type { DisplayTransitionReader } from "../observe/DisplayTransition";
import type { AndroidCtrlProxyClient } from "../observe/android";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import type { TapStrategy } from "../../utils/interfaces/TapStrategy";
import type { Timer } from "../../utils/SystemTimer";
import {
  ActionableError,
  BootedDevice,
  Element,
  ElementSelectionResult,
  ObserveResult,
  TapOnElementResult,
  TapOnSelectedElement,
  ViewHierarchyResult,
} from "../../models";
import type { TalkBackTapStrategy } from "../talkback/TalkBackTapStrategy";
import type { TalkBackNavigationDriverFactory } from "../talkback/TalkBackNavigationDriver";
import { talkBackDisplayRefusal } from "../talkback/talkBackDisplayRefusal";
import { isElementKeyboardFocused } from "../utility/FocusedInput";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { reportToolDispatched } from "../../utils/ToolDispatchContext";
import { androidDisplayTapDispatch } from "./coordinateTapDispatch";
import {
  refreshTargetDisplayHierarchy,
  prepareTargetDisplayAction,
  type RenderedObservationReader,
} from "./TargetDisplayAction";
import { OBSERVED_INTERACTION_PROFILES } from "./observedInteractionProfiles";
import type {
  ObservedChangeOptions,
  ObservedEnvelope,
  ObservedActionResult,
} from "./BaseVisualChange";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import type { DisplayFenceOption } from "./BaseVisualChange";

type SearchUntilStats = NonNullable<TapOnElementResult["searchUntil"]>;

/** TalkBack state resolved once for an explicit-display tap, with any unknown-state warnings. */
type AndroidDisplayTalkBackState = { enabled: boolean; warnings: string[] };

/** Positional arguments of the owner's retry-if-no-change step. */
type RetryTapIfNoChangeArgs = [
  preTapHash: string | null,
  tapPoint: { x: number; y: number },
  action: string,
  longPressDuration: number,
  tapElement: Element,
  options: TapVerificationOptions & DisplayFenceOption,
  isTalkBackEnabled: boolean,
  screenSize: ObserveResult["screenSize"],
  signal?: AbortSignal,
  selection?: ElementSelectionResult,
];

/** What the explicit-display tap phase needs from the owning tap action. */
export interface ExplicitDisplayHost {
  readonly device: BootedDevice;
  readonly timer: Timer;
  readonly tapPoints: TapPointPlanner;
  readonly adb: () => AdbExecutor;
  readonly accessibilityService: () => AndroidCtrlProxyClient;
  readonly geometry: () => ElementGeometry;
  readonly hierarchyCapture: () => HierarchyCapture;
  readonly lastRenderedObservation: () => RenderedObservationReader | undefined;
  readonly observeScreen: () => ObserveScreen;
  readonly displayTransitionReader: () => DisplayTransitionReader;
  readonly strategy: () => TapStrategy;
  readonly talkBackStrategy: () => TalkBackTapStrategy;
  readonly talkBackDriverFactory: () => TalkBackNavigationDriverFactory;
  readonly createErrorResult: (action: string, error: string, cause?: unknown) => TapOnFocusResult;
  readonly validateOptions: (options: TapOnElementOptions) => string | null;
  readonly getSearchUntilDuration: (options: TapOnElementOptions) => number;
  readonly hashViewHierarchy: (hierarchy: ViewHierarchyResult | null) => string | null;
  readonly buildSelectedElementMetadata: (
    selection: ElementSelectionResult,
  ) => TapOnSelectedElement | undefined;
  readonly findElementInHierarchy: (
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
  ) => { selection: ElementSelectionResult; containerFound: boolean };
  readonly withObservationScreenSize: (
    options: TapVerificationOptions,
    observation: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>,
  ) => TapVerificationOptions;
  readonly replaceObservationHierarchy: (
    observation: ObserveResult,
    hierarchy: ViewHierarchyResult,
    refreshedFromDevice: boolean,
  ) => void;
  readonly refreshEnsureCheckedSelection: (
    options: TapVerificationOptions,
    observation: ObserveResult,
    selection: ElementSelectionResult,
    signal?: AbortSignal,
  ) => Promise<{ selection: ElementSelectionResult; viewHierarchy: ViewHierarchyResult }>;
  readonly ensureCheckedBeforeTap: (
    options: TapOnElementOptions,
    element: Element,
    selectedElement: TapOnSelectedElement | undefined,
    searchUntil: SearchUntilStats,
  ) => TapOnElementResult | undefined;
  readonly applyEnsureCheckedResult: (
    result: TapOnElementResult,
    options: TapVerificationOptions,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly resolveAndroidStableTapTargetAfterRefreshes: (
    options: TapVerificationOptions,
    observation: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>,
    action: TapOnElementOptions["action"],
    requireResourceId: boolean,
    signal?: AbortSignal,
  ) => Promise<StableTapTargetResult>;
  readonly searchForElement: (
    options: TapVerificationOptions,
    observation: ObserveResult,
    signal?: AbortSignal,
  ) => Promise<{
    selection: ElementSelectionResult;
    viewHierarchy: ViewHierarchyResult;
    containerFound: boolean;
    stats: SearchUntilStats;
    refreshedFromDevice: boolean;
    visibilityError?: TapTargetUnavailableError;
  }>;
  readonly handleElementNotFound: (
    options: TapOnElementOptions,
    observation?: ObserveResult,
    containerFound?: boolean,
    signal?: AbortSignal,
    selection?: ElementSelectionResult,
  ) => Promise<never>;
  readonly visibleTapBounds: TapPointPlanner["visibleTapBounds"];
  readonly resolveVisibleTapPoint: TapPointPlanner["resolveVisibleTapPoint"];
  readonly retryTapIfNoChange: (...args: RetryTapIfNoChangeArgs) => Promise<void>;
  readonly verifyFocusedInputTarget: (
    options: TapOnElementOptions,
    target: Element,
    observation?: ObserveResult,
    labelText?: string,
    selectedIndex?: number,
    preTapHierarchy?: ViewHierarchyResult,
  ) => boolean;
  readonly observedInteraction: <R extends ObservedActionResult>(
    block: (observation: ObserveResult) => Promise<R | ObservedActionResult>,
    options: ObservedChangeOptions,
  ) => Promise<R & ObservedEnvelope>;
  readonly staleDisplay: (observedGeneration: number) => StaleDisplayError;
  readonly checkPostActionDisplay: (
    result: Pick<TapOnElementResult, "observation" | "staleDisplay">,
    assertCurrent: (() => void) | undefined,
    signal?: AbortSignal,
  ) => boolean;
  readonly rethrowObservationAbort: (
    error: unknown,
    signal?: AbortSignal,
    enabled?: boolean,
  ) => void;
}

/**
 * Explicit-display (`display:`) tap orchestration: option fencing, target-display
 * preparation, TalkBack refusal, selection, dispatch and post-state verification.
 * Android only; other platforms fall through to the default-display flow.
 */
export class TapExplicitDisplayPhase {
  constructor(private readonly host: ExplicitDisplayHost) {}

  async prepareAndroidDisplaySelection(
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
        false,
        signal,
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

  async executeOnAndroidDisplay(
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
    const resolvedLayer = resolvedElementLayer(hierarchy, element, this.host.device.platform);
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
    const visibleBounds = this.host.visibleTapBounds(
      selection,
      hierarchy,
      target.observation.screenSize,
      options,
    );
    const point =
      visibleBounds &&
      this.host.resolveVisibleTapPoint(element, hierarchy, visibleBounds, {
        options,
        screenSize: target.observation.screenSize,
      });
    if (!point) {
      throw new TapTargetUnavailableError(
        "Matched element has no visible tap area on selected display",
        this.host.tapPoints.visibilityFailureReason(
          selection,
          hierarchy,
          target.observation.screenSize,
        ),
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
      await this.host.retryTapIfNoChange(
        preTapHash,
        point,
        options.action,
        this.host.strategy().longPressDurationMs,
        element,
        {
          ...this.host.withObservationScreenSize(options, target.observation),
          verification: { refresh: options.verification.refresh, dispatch: dispatchAction },
        },
        false,
        target.observation.screenSize,
        signal,
        selection,
      );
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

  /**
   * Detect TalkBack once, before any element search, so a refusal (a non-default display)
   * is not masked by a "not found" result or an already-satisfied ensureChecked. Unknown
   * state keeps the raw gesture and carries the default route's warning.
   */
  async resolveAndroidDisplayTalkBack(
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

  async androidDisplayDispatch(
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
        timer: this.host.timer,
        onWarning: context.onWarning,
        talkBack: context.talkBack.enabled
          ? {
              strategy: this.host.talkBackStrategy(),
              driver: this.host.talkBackDriverFactory().createDriver(this.host.device),
            }
          : undefined,
      },
    );
  }

  selectElementOnDisplay(
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

  async resolveAndroidDisplaySelection(
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
        await this.host.handleElementNotFound(
          options,
          undefined,
          outcome.containerFound,
          signal,
          outcome.selection,
        );
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

  async observedAndroidDisplayInteraction(
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
      refreshTargetDisplayHierarchy(
        target,
        this.host.hierarchyCapture(),
        timeoutMs,
        () =>
          this.host.staleDisplay(
            target.observation.display.generation ??
              this.host.displayTransitionReader().identityRevision(this.host.device.deviceId),
          ),
        signal,
      );
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
    const result: TapOnFocusOutcome = await this.host.observedInteraction(
      async () => {
        const dispatchedResult = await this.executeOnAndroidDisplay(verificationOptions, {
          target,
          selection,
          signal,
          talkBack,
          onDispatched: () => {
            tapTimestamp = this.host.timer.now();
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
        return unverifiableDisplayPostState(result, options);
      }
    }
    if (result.success && result.skipped !== "already-checked") {
      await this.host.applyEnsureCheckedResult(result, verificationOptions, signal);
    }
    return this.finalizeDisplayFocusResult(result, options, selection, target.observation);
  }

  finalizeDisplayFocusResult(
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
      labelText,
      result.selectedElement?.indexInMatches,
      previousObservation.viewHierarchy,
    );
    if (!result.focusVerified) {
      result.success = false;
      result.error = `Failed to confirm focus on editable input ${describeFocusTarget(result.element, options)}: the focused field could not be matched to the target`;
    }
    return result;
  }

  async execute(
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
          this.host.device,
          display,
          this.host.observeScreen(),
          this.host.adb(),
          this.host.lastRenderedObservation(),
          signal,
          this.host.displayTransitionReader(),
        );
        if (this.host.device.platform === "android") {
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
        rethrowKeyboardOcclusion(this.host.strategy(), error, options.action, recovery);
        logger.warn(`tapOn display routing failed: ${errorMessage(error)}`, error);
        const failure = completedDisplayFailure(error, dispatchCompleted);
        return withStaleDisplay(
          this.host.createErrorResult(options.action, errorMessage(failure), failure),
          failure,
        );
      }
    }
    return undefined;
  }
}

export function unverifiableDisplayPostState(
  result: TapOnElementResult,
  options: Pick<TapOnElementOptions, "action" | "ensureChecked">,
): TapOnElementResult {
  if (!result.staleDisplay || (options.action !== "focus" && options.ensureChecked === undefined)) {
    return result;
  }
  return withStaleDisplay(
    { ...result, success: false, error: undefined },
    new DispatchedObservationError(new StaleDisplayError(result.staleDisplay)),
  );
}

export function didCompleteDisplayGesture(
  result: TapOnElementResult & { wasAlreadyFocused?: boolean },
  display?: string,
): boolean {
  return display !== undefined && result.success && !result.skipped && !result.wasAlreadyFocused;
}

export function completedDisplayFailure(error: unknown, dispatchCompleted: boolean): unknown {
  // Verification runs after the complete gesture block; in-block refusals and
  // partial multi-stroke failures keep their existing dispatch semantics.
  return dispatchCompleted && error instanceof StaleDisplayError
    ? new DispatchedObservationError(error)
    : error;
}

export function rethrowKeyboardOcclusion(
  strategy: Pick<TapStrategy, "rethrowsKeyboardOcclusion">,
  error: unknown,
  action: TapOnElementOptions["action"],
  recovery?: { throwOnKeyboardOcclusion?: boolean },
): void {
  if (
    recovery?.throwOnKeyboardOcclusion &&
    strategy.rethrowsKeyboardOcclusion &&
    action === "focus" &&
    error instanceof KeyboardOcclusionError
  ) {
    logger.debug(`Tap on element awaits IME recovery: ${errorMessage(error)}`, error);
    throw error;
  }
}
