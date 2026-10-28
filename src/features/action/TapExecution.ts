import { deadlineRequest, type TapOnCall } from "./ActionCall";
import type { AndroidOrIosPlatform, ElementSelectionResult } from "../../models";
import { requireAndroidOrIosPlatform } from "../../models";
import type { DisplayFence, ObservedActionResult } from "./BaseVisualChange";
import { describeFocusTarget } from "./tapFocusIdentity";
import {
  markFocusFailure,
  resolvedElementLayer,
  withResolvedLayer,
  type TapOnFocusResult,
} from "./tapFocusResult";
import { TapPointPlanner } from "./tapPointPlanner";
import { wasHierarchyReadDuringCall } from "../observe/observationReadScope";
import { freshTapHierarchy } from "./freshTapHierarchy";
import { DispatchedObservationError } from "../../models/DispatchedObservationError";
import { assertLongPressFitsRequestBudget } from "./gestureTransportTimeout";
import { StaleDisplayError, withStaleDisplay } from "../observe/StaleDisplayError";
import { isFocusEditableElement } from "../utility/ElementResolver";
import { hasAccessibilityAction } from "../utility/elementProperties";
import { errorMessage } from "../../utils/describeUnknownError";
import { BaseVisualChange } from "./BaseVisualChange";
import {
  ActionableError,
  BootedDevice,
  Element,
  isFalsy,
  ObserveResult,
  TapOnElementResult,
  ViewHierarchyResult,
} from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import { isElementKeyboardFocused } from "../utility/FocusedInput";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { reportToolDispatched } from "../../utils/ToolDispatchContext";
import { throwIfAborted } from "../../utils/toolUtils";
import { SelectionCaptureState, SelectionStateTracker } from "../navigation/SelectionStateTracker";
import { tapFailureNeedsSearchDebugContext } from "./coordinateTapDispatch";
import { buildElementSearchDebugContext } from "../utility/ElementSearchDebugContext";
import { type Timer } from "../../utils/SystemTimer";
import { type ScreenReaderNavigationResult } from "../talkback/TalkBackTapStrategy";
import type { TapStrategy } from "../../utils/interfaces/TapStrategy";
import { LongPressMetadataDetector, type LongPressMetadata } from "./LongPressMetadataDetector";
import { DEFAULT_HIERARCHY_READ_TIMEOUT_MS } from "../observe/DeviceHierarchyCapture";
import { OBSERVED_INTERACTION_PROFILES, SETTLE_BUDGET_MS } from "./observedInteractionProfiles";
import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import { TapDisplayRouter } from "./TapDisplayRouter";
import { TapSemanticLinks } from "./TapSemanticLinks";
import { TapTargetResolver } from "./TapTargetResolver";
import { TapGestureDispatcher } from "./TapGestureDispatcher";
import { type TapOnFocusOutcome } from "./TapSemanticLinks";

function appendDisabledElementWarning(
  strategy: TapStrategy,
  element: Element,
  warnings: string[],
): void {
  if (strategy.warnsOnDisabledElement && isFalsy(element.enabled)) {
    warnings.push("The matched element is disabled; the tap may have no effect.");
  }
}

type SearchUntilStats = NonNullable<TapOnElementResult["searchUntil"]>;

/** Capabilities used by this phase; dependency readers observe replacements made by tests. */
export interface TapExecutionHost {
  runPlatformTap(dispatch: {
    android: () => Promise<void>;
    ios: () => Promise<void>;
  }): Promise<void>;
  requiresFreshExtractionForCachedTarget(): boolean;
  canReuseAccessibilityState(): boolean;
  revalidatesCachedTargets(): boolean;
  refreshesAccessibilityHierarchyBeforeSearch(): boolean;
  detectsAccessibilityBeforeSearch(): boolean;
  activateAccessibilityLinkPhase: TapSemanticLinks["activateAccessibilityLinkPhase"];
  activateSubtextPhase: TapSemanticLinks["activateSubtextPhase"];
  applyEnsureCheckedResult: TapTargetResolver["applyEnsureCheckedResult"];
  assertLongPressWithinRequestBudget: TapExecution["assertLongPressWithinRequestBudget"];
  buildSelectedElementMetadata: TapTargetResolver["buildSelectedElementMetadata"];
  captureTerminalObservationScreenshot: (
    observation: ObserveResult | undefined,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ) => Promise<void>;
  completedDisplayFailure: TapDisplayRouter["completedDisplayFailure"];
  confirmFocusAfterTap: TapExecution["confirmFocusAfterTap"];
  createErrorResult: TapSemanticLinks["createErrorResult"];
  deriveTapEffectAfterPostTapObservation: TapTargetResolver["deriveTapEffectAfterPostTapObservation"];
  detectLongPressMetadata: TapExecution["detectLongPressMetadata"];
  readonly device: () => BootedDevice;
  didCompleteDisplayGesture: TapDisplayRouter["didCompleteDisplayGesture"];
  enforceFreshnessConsistencyWithEffect: TapTargetResolver["enforceFreshnessConsistencyWithEffect"];
  ensureCheckedBeforeTap: TapTargetResolver["ensureCheckedBeforeTap"];
  executeAndroidTap: TapGestureDispatcher["executeAndroidTap"];
  executeOnDisplay: TapDisplayRouter["executeOnDisplay"];
  executeiOSTap: TapGestureDispatcher["executeiOSTap"];
  readonly geometry: () => ElementGeometry;
  getLongPressDuration: TapGestureDispatcher["getLongPressDuration"];
  handleElementNotFound: TapTargetResolver["handleElementNotFound"];
  hashViewHierarchy: TapTargetResolver["hashViewHierarchy"];
  logClickableParentSelection: TapTargetResolver["logClickableParentSelection"];
  readonly longPressMetadataDetector: () => LongPressMetadataDetector;
  observedInteraction: BaseVisualChange["observedInteraction"];
  predictionToolArgs: TapExecution["predictionToolArgs"];
  prepareSelectionCapture: TapTargetResolver["prepareSelectionCapture"];
  readScopeFailureResult: TapExecution["readScopeFailureResult"];
  rebuildSelectedElementMetadataAfterStability: TapTargetResolver["rebuildSelectedElementMetadataAfterStability"];
  recordDeferredPredictionOutcome: (
    result: unknown,
    finalObservation: ObserveResult,
  ) => Promise<void>;
  refreshEnsureCheckedSelection: TapTargetResolver["refreshEnsureCheckedSelection"];
  refreshViewHierarchy: TapTargetResolver["refreshViewHierarchy"];
  replaceObservationHierarchy: TapTargetResolver["replaceObservationHierarchy"];
  resolveAndroidStableTapTargetAfterRefreshes: TapTargetResolver["resolveAndroidStableTapTargetAfterRefreshes"];
  resolveTapTargetElement: TapTargetResolver["resolveTapTargetElement"];
  rethrowKeyboardOcclusion: TapDisplayRouter["rethrowKeyboardOcclusion"];
  retryTapIfNoChange: TapGestureDispatcher["retryTapIfNoChange"];
  searchForElement: TapTargetResolver["searchForElement"];
  readonly selectionStateTracker: () => Pick<SelectionStateTracker, "prepare" | "finalize">;
  readonly strategy: () => TapStrategy;
  readonly tapPoints: () => TapPointPlanner;
  tapVerificationRefresh: TapTargetResolver["tapVerificationRefresh"];
  readonly timer: () => Timer;
  unverifiableDisplayPostState: TapDisplayRouter["unverifiableDisplayPostState"];
  validateOptions: TapSemanticLinks["validateOptions"];
  verifyFocusAfterTap: TapTargetResolver["verifyFocusAfterTap"];
  verifyFocusedInputTarget: TapTargetResolver["verifyFocusedInputTarget"];
  withObservationScreenSize: TapTargetResolver["withObservationScreenSize"];
}

interface TapExecutionState {
  options: TapOnElementOptions;
  requestedAction: TapOnElementOptions["action"];
  effectiveAction: TapOnElementOptions["action"];
  signal?: AbortSignal;
  request?: { requestDeadlineMs?: number };
  recovery?: { throwOnKeyboardOcclusion?: boolean };
  perf: PerformanceTracker;
  previousObserveResult: ObserveResult | null;
  preTapHierarchy?: ViewHierarchyResult;
  selectionCapture: SelectionCaptureState | null;
  searchUntilStats?: SearchUntilStats;
  focusTarget?: Element;
  focusLabelText?: string;
  ensureCheckedTapTimestamp?: number;
  completedDisplayGesture: boolean;
  settlePostTapEffect?: boolean;
}
interface TapHierarchyState {
  observeResult: ObserveResult;
  viewHierarchy: ViewHierarchyResult;
  activationWarnings: string[];
  isAccessibilityServiceEnabled: boolean | undefined;
}
interface TapTargetState extends TapHierarchyState {
  searchOutcome: Awaited<ReturnType<TapTargetResolver["searchForElement"]>>;
  element: Element;
  finalSelection: ElementSelectionResult;
  selectedElementMetadata: TapOnFocusResult["selectedElement"];
  action: TapOnElementOptions["action"];
  initialTapPoint: { x: number; y: number };
  longPressDuration: number;
  tapOptions: TapOnElementOptions;
  tapElement: Element;
  usedParent: boolean;
  screenReaderNavigation?: ScreenReaderNavigationResult;
}

/** Executes one selector action while keeping its observation and verification state local. */
export class TapExecution {
  constructor(private readonly host: TapExecutionHost) {}

  /** The bound device's platform; tapOn rejects a watch before any platform-specific step. */
  private platform(): AndroidOrIosPlatform {
    return requireAndroidOrIosPlatform(this.host.device().platform, "tapOn");
  }
  async executeWithReadScope(
    options: TapOnElementOptions,
    call: TapOnCall = {},
  ): Promise<TapOnFocusResult> {
    const { progress, signal, recovery, settlePostTapEffect } = call;
    const request = deadlineRequest(call.deadlineMs);
    // Validate before display resolution/observation can issue any device command.
    this.host.assertLongPressWithinRequestBudget(options, request);
    if (options.display !== undefined) {
      const result = await this.host.executeOnDisplay(options, signal, recovery);
      if (result) {
        return result;
      }
    }
    if (!options.action) {
      return this.host.createErrorResult(options.action, "tap on action is required");
    }

    const requestedAction = options.action;

    if (options.ensureTap) {
      options = { ...options, preTapStability: true, retryIfNoChange: true };
    }

    const validationError = this.host.validateOptions(options);
    if (validationError) {
      return this.host.createErrorResult(options.action, validationError);
    }

    const perf = createGlobalPerformanceTracker();
    perf.serial("tapOnElement");

    const state: TapExecutionState = {
      options,
      requestedAction,
      effectiveAction: requestedAction,
      signal,
      recovery,
      request,
      perf,
      previousObserveResult: null,
      selectionCapture: null,
      completedDisplayGesture: false,
      settlePostTapEffect,
    };
    try {
      throwIfAborted(signal);
      const result = await this.host.observedInteraction<TapOnFocusOutcome>(
        (observation, fence) => this.executeObservedTap(state, observation, fence),
        {
          queryOptions: {
            text: options.text ?? options.textAny?.[0],
            elementId: options.elementId,
            containerElementId: options.container?.elementId,
          },
          ...OBSERVED_INTERACTION_PROFILES.selectorResolvedGesture,
          display: options.display,
          timeoutMs: SETTLE_BUDGET_MS.gesture, // Reduce timeout for faster execution
          progress,
          perf,
          signal,
          deferPredictionOutcome: true,
          deferPostActionScreenshot: true,
          ...(options.ensureChecked !== undefined
            ? { observationHostTimestampProvider: () => state.ensureCheckedTapTimestamp }
            : {}),
          predictionContext: {
            toolName: "tapOn",
            toolArgs: this.host.predictionToolArgs(options),
          },
        },
      );
      return await this.finalizeResult(state, result);
    } catch (error) {
      return this.failureResult(state, error);
    }
  }

  private async finalizeResult(
    state: TapExecutionState,
    result: TapOnFocusOutcome,
  ): Promise<TapOnFocusResult> {
    const { options, requestedAction, signal, perf } = state;
    state.completedDisplayGesture = this.host.didCompleteDisplayGesture(result, options.display);
    if (options.display !== undefined && result.staleDisplay) {
      // Legacy/iOS display gestures must not finalize optional post-state
      // metadata or confirm focus/checked state from an invalidated capture.
      return this.host.unverifiableDisplayPostState(result, options);
    }

    if (result.success && result.observation && result.element) {
      const postTap = await this.host.deriveTapEffectAfterPostTapObservation(
        state.previousObserveResult,
        result.observation,
        signal,
        { settlePostTapEffect: state.settlePostTapEffect },
      );
      result.effect = postTap.effect;
      // The observation that established the effect must be returned and become
      // the caller's diff baseline, rather than the earlier source capture.
      result.observation = postTap.observation;
      await this.host.applyEnsureCheckedResult(result, options, signal);
      await this.host.captureTerminalObservationScreenshot(result.observation, perf, signal);
      await this.host.recordDeferredPredictionOutcome(result, result.observation);
      const selectedElements = await this.host.selectionStateTracker().finalize({
        action: state.effectiveAction,
        selectionState: state.selectionCapture,
        currentObservation: result.observation,
        previousObservation: state.previousObserveResult,
        element: result.element,
        effect: postTap.effect,
        signal,
      });
      if (selectedElements.length > 0) {
        result.observation.selectedElements = selectedElements;
      }
      this.host.enforceFreshnessConsistencyWithEffect(state.previousObserveResult, result);
    }

    await this.host.confirmFocusAfterTap({
      result,
      options,
      requestedAction,
      focusTarget: state.focusTarget,
      focusLabelText: state.focusLabelText,
      preTapHierarchy: state.preTapHierarchy,
      signal,
    });

    if (state.effectiveAction === "longPress") {
      const metadata = this.host.detectLongPressMetadata(
        state.previousObserveResult,
        result.observation,
      );
      return {
        ...result,
        ...metadata,
        ...this.longClickAdvertisement(result.element),
      };
    }
    return result;
  }

  private async failureResult(state: TapExecutionState, error: unknown): Promise<TapOnFocusResult> {
    const { options, requestedAction, recovery, perf } = state;
    perf.end();

    // Only opted-in Android form orchestration receives the typed recovery signal.
    this.host.rethrowKeyboardOcclusion(error, requestedAction, recovery);
    logger.warn(`Tap on element failed: ${errorMessage(error)}`, error);
    const failure = this.host.completedDisplayFailure(error, state.completedDisplayGesture);
    if (failure instanceof StaleDisplayError || failure instanceof DispatchedObservationError) {
      return withStaleDisplay(
        this.host.createErrorResult(state.effectiveAction, failure.message),
        failure,
      );
    }

    // Build debug context if debug mode is enabled
    const debugContext = tapFailureNeedsSearchDebugContext(error)
      ? await buildElementSearchDebugContext(this.host.device(), {
          text: options.text,
          resourceId: options.elementId,
          container: options.container,
        })
      : undefined;

    // Return error result with debug info instead of throwing
    return this.host.readScopeFailureResult(
      requestedAction,
      state.effectiveAction,
      error,
      state.searchUntilStats,
      debugContext,
    );
  }

  private async executeObservedTap(
    state: TapExecutionState,
    observeResult: ObserveResult,
    fence?: DisplayFence,
  ): Promise<TapOnFocusOutcome | ObservedActionResult> {
    const { options, signal, perf } = state;
    state.previousObserveResult = observeResult;
    state.preTapHierarchy = observeResult.viewHierarchy;
    throwIfAborted(signal);
    if (!observeResult.viewHierarchy) {
      perf.end();
      return { success: false, error: "Unable to get view hierarchy, cannot tap on element" };
    }
    const hierarchy: TapHierarchyState = {
      observeResult,
      viewHierarchy: observeResult.viewHierarchy,
      activationWarnings: [],
      isAccessibilityServiceEnabled: undefined,
    };
    await this.prepareHierarchy(state, hierarchy);
    if (options.accessibilityLink) {
      return this.host.activateAccessibilityLinkPhase(
        options,
        options.accessibilityLink,
        observeResult,
        hierarchy.viewHierarchy,
        hierarchy.activationWarnings,
        signal,
      );
    }
    const searchOutcome = await this.searchCurrentTarget(state, hierarchy);
    const prepared = await this.prepareSelection(state, hierarchy, searchOutcome);
    if ("result" in prepared) {
      return prepared.result;
    }
    const target = prepared.target;
    const stableResult = await this.stabilizeTarget(state, target);
    if (stableResult) {
      return stableResult;
    }
    return this.dispatchTarget(state, target, fence);
  }

  private async prepareHierarchy(
    state: TapExecutionState,
    hierarchy: TapHierarchyState,
  ): Promise<void> {
    const { signal } = state;
    const { observeResult } = hierarchy;
    // Resolve TalkBack selectors from a capture for this call, just as the
    // existing search/stability refreshes do. Cache age cannot detect an
    // external same-app BACK (#9785).

    hierarchy.isAccessibilityServiceEnabled = this.host.detectsAccessibilityBeforeSearch()
      ? await this.host
          .strategy()
          .isAccessibilityServiceEnabled((warning) => hierarchy.activationWarnings.push(warning))
      : undefined;
    if (
      this.host.refreshesAccessibilityHierarchyBeforeSearch() &&
      hierarchy.isAccessibilityServiceEnabled
    ) {
      const freshHierarchy = await freshTapHierarchy(
        this.host.tapVerificationRefresh({
          screenSize: observeResult.screenSize,
          signal,
        }),
        this.host.timer(),
        signal,
      );
      state.preTapHierarchy = freshHierarchy;
      this.host.replaceObservationHierarchy(observeResult, freshHierarchy, true);
      hierarchy.viewHierarchy = freshHierarchy;
    }
  }

  private async shouldRevalidateCachedTarget(
    state: TapExecutionState,
    hierarchy: TapHierarchyState,
    searchOutcome: Awaited<ReturnType<TapTargetResolver["searchForElement"]>>,
  ): Promise<boolean> {
    const { options } = state;
    return Boolean(
      this.host.revalidatesCachedTargets() &&
      !hierarchy.isAccessibilityServiceEnabled &&
      searchOutcome.selection.element &&
      !wasHierarchyReadDuringCall(hierarchy.viewHierarchy) &&
      searchOutcome.stats.requestCount === 0 &&
      options.ensureChecked === undefined &&
      !this.host.strategy().shouldRunPreTapStability(options) &&
      (this.host.canReuseAccessibilityState() ||
        !(hierarchy.isAccessibilityServiceEnabled ??= await this.host
          .strategy()
          .isAccessibilityServiceEnabled())),
    );
  }

  private async searchCurrentTarget(
    state: TapExecutionState,
    hierarchy: TapHierarchyState,
  ): Promise<Awaited<ReturnType<TapTargetResolver["searchForElement"]>>> {
    const { options, signal, perf, request } = state;
    const { observeResult } = hierarchy;
    let searchOutcome = await perf.track("findElement", () =>
      this.host.searchForElement(options, observeResult, signal),
    );
    // Search polling, ensureChecked, and opt-in stability already acquire a
    // current tree. Only a visible cache hit still needs revalidation.
    if (await this.shouldRevalidateCachedTarget(state, hierarchy, searchOutcome)) {
      const freshHierarchy = await freshTapHierarchy(
        this.host.requiresFreshExtractionForCachedTarget()
          ? (timeout) =>
              this.host.refreshViewHierarchy(timeout, observeResult.screenSize, signal, true)
          : this.host.tapVerificationRefresh({ screenSize: observeResult.screenSize, signal }),
        this.host.timer(),
        signal,
        {
          timeoutMs: Math.min(
            DEFAULT_HIERARCHY_READ_TIMEOUT_MS,
            request?.requestDeadlineMs === undefined
              ? DEFAULT_HIERARCHY_READ_TIMEOUT_MS
              : request.requestDeadlineMs - this.host.timer().now(),
          ),
          context: "while revalidating a cached observation",
          platform: this.platform(),
        },
      );
      this.host.replaceObservationHierarchy(observeResult, freshHierarchy, true);
      // Discard cached coordinates and use the ordinary search-until loop
      // when the current screen is still transitioning.
      searchOutcome = await this.host.searchForElement(options, observeResult, signal);
    }
    state.searchUntilStats = searchOutcome.stats;
    this.host.replaceObservationHierarchy(
      observeResult,
      searchOutcome.viewHierarchy,
      searchOutcome.refreshedFromDevice,
    );
    hierarchy.viewHierarchy = searchOutcome.viewHierarchy;
    if (!searchOutcome.selection.element) {
      if (searchOutcome.visibilityError) {
        throw searchOutcome.visibilityError;
      }
      await this.host.handleElementNotFound(
        options,
        observeResult,
        searchOutcome.containerFound,
        signal,
        searchOutcome.selection,
      );
    }

    return searchOutcome;
  }

  private async prepareSelection(
    state: TapExecutionState,
    hierarchy: TapHierarchyState,
    searchOutcome: Awaited<ReturnType<TapTargetResolver["searchForElement"]>>,
  ): Promise<{ target: TapTargetState } | { result: TapOnFocusOutcome | ObservedActionResult }> {
    const { options, signal, perf } = state;
    const { observeResult, activationWarnings } = hierarchy;
    const liveSelection = await this.host.refreshEnsureCheckedSelection(
      options,
      observeResult,
      searchOutcome.selection,
      signal,
    );
    hierarchy.viewHierarchy = liveSelection.viewHierarchy;
    state.preTapHierarchy = hierarchy.viewHierarchy;
    const selection = liveSelection.selection;

    const element = selection.element as Element;
    const selectedElementMetadata = this.host.buildSelectedElementMetadata(selection);
    const ensureCheckedResult = this.host.ensureCheckedBeforeTap(
      options,
      element,
      selectedElementMetadata,
      searchOutcome.stats,
    );
    if (ensureCheckedResult) {
      perf.end();
      return { result: ensureCheckedResult };
    }
    if (options.subtext) {
      return {
        result: await this.host.activateSubtextPhase({
          options,
          subtext: options.subtext,
          element,
          viewHierarchy: hierarchy.viewHierarchy,
          selectedElement: selectedElementMetadata,
          searchUntil: searchOutcome.stats,
          activationWarnings,
          signal,
        }),
      };
    }

    const action = options.action;
    const initialTapPoint = this.host.geometry().getElementCenter(element);
    const longPressDuration = this.host.getLongPressDuration(options);

    const target: TapTargetState = {
      ...hierarchy,
      searchOutcome,
      element,
      finalSelection: selection,
      selectedElementMetadata,
      action,
      initialTapPoint,
      longPressDuration,
      tapOptions: { ...options, action },
      tapElement: element,
      usedParent: false,
    };
    const focusResult = this.prepareFocusTarget(state, target);
    if (focusResult) {
      return { result: focusResult };
    }
    target.tapOptions = { ...options, action: target.action };
    return { target };
  }

  private prepareFocusTarget(
    state: TapExecutionState,
    target: TapTargetState,
  ): TapOnFocusOutcome | undefined {
    const { options, perf } = state;
    const { searchOutcome } = target;
    const { initialTapPoint } = target;
    if (target.action === "focus") {
      if (!isFocusEditableElement(target.element)) {
        perf.end();
        return {
          success: false,
          action: target.action,
          element: target.element,
          selectedElement: target.selectedElementMetadata,
          searchUntil: searchOutcome.stats,
          error: `Cannot focus ${describeFocusTarget(target.element, options)} because it is not an editable input`,
        };
      }

      state.focusTarget = target.element;
      const matchedLabel = searchOutcome.selection.matchedElement;
      if (matchedLabel && matchedLabel !== target.element) {
        state.focusLabelText = matchedLabel.text;
      }

      // Check if element is already focused
      const isFocused = isElementKeyboardFocused(target.element);

      if (isFocused) {
        logger.info(`Element is already focused, no action needed`);
        perf.end();
        return withResolvedLayer(
          {
            success: true,
            action: target.action,
            element: target.element,
            selectedElement: target.selectedElementMetadata,
            searchUntil: searchOutcome.stats,
            wasAlreadyFocused: true,
            focusChanged: false,
            focusVerified: true,
            x: initialTapPoint.x,
            y: initialTapPoint.y,
          },
          resolvedElementLayer(target.viewHierarchy, target.element, this.platform()),
        );
      }

      target.action = "tap";
      state.effectiveAction = "tap";
    }

    return undefined;
  }

  private async stabilizeTarget(
    state: TapExecutionState,
    target: TapTargetState,
  ): Promise<TapOnFocusOutcome | ObservedActionResult | undefined> {
    const { options, signal, perf, requestedAction } = state;
    const { observeResult, activationWarnings, searchOutcome } = target;
    // Preserve iOS detection at the original activation boundary.
    target.isAccessibilityServiceEnabled ??= await this.host
      .strategy()
      .isAccessibilityServiceEnabled((warning) => activationWarnings.push(warning));
    const requireResourceId = target.isAccessibilityServiceEnabled;

    const initialTapTarget = this.host.resolveTapTargetElement(
      target.element,
      target.viewHierarchy,
      target.action,
      {
        requireResourceId,
        scoped: options.container !== undefined,
      },
    );
    target.tapElement = initialTapTarget.element;
    target.usedParent = initialTapTarget.usedParent;

    if (this.host.strategy().shouldRunPreTapStability(options)) {
      const stable = await this.host.resolveAndroidStableTapTargetAfterRefreshes(
        options,
        observeResult,
        target.action,
        requireResourceId,
        signal,
      );
      if (!stable.ok) {
        perf.end();
        return { success: false, error: stable.error };
      }
      // The pre-tap stability resolver always returns a hierarchy it just
      // re-captured live from the device, so its freshness is realigned.
      this.host.replaceObservationHierarchy(observeResult, stable.viewHierarchy, true);
      // This observation now describes the refreshed capture used for the
      // tap, rather than the earlier hierarchy used to start resolution.
      if (stable.selection.captureId) {
        observeResult.observationId = stable.selection.captureId;
      }
      target.viewHierarchy = stable.viewHierarchy;
      state.preTapHierarchy = target.viewHierarchy;
      target.tapElement = stable.tapElement;
      target.finalSelection = stable.selection;
      target.usedParent = stable.usedParent;
      // Rebuild from the refreshed selection so the reported selectedElement
      // (bounds/indexInMatches/totalMatches) describes the node actually
      // tapped after re-resolution, not the stale pre-refresh match (#5888).
      // The decision lives in a pure seam so it can be unit-tested (#5897).
      target.selectedElementMetadata = this.host.rebuildSelectedElementMetadataAfterStability(
        target.selectedElementMetadata,
        stable.selection,
      );
      const stableElement = stable.selection.element;
      if (!stableElement) {
        perf.end();
        return {
          success: false,
          error: "Android tap aborted: refreshed stable target selection was empty",
        };
      }
      if (requestedAction === "focus") {
        state.focusTarget = stableElement;
        state.focusLabelText =
          stable.selection.matchedElement !== stableElement
            ? stable.selection.matchedElement?.text
            : undefined;
      }
      const ensureCheckedResult = this.host.ensureCheckedBeforeTap(
        options,
        stableElement,
        target.selectedElementMetadata,
        searchOutcome.stats,
      );
      if (ensureCheckedResult) {
        perf.end();
        return ensureCheckedResult;
      }
    }

    return undefined;
  }

  private async dispatchTarget(
    state: TapExecutionState,
    target: TapTargetState,
    fence?: DisplayFence,
  ): Promise<TapOnFocusOutcome> {
    const { options, requestedAction, signal, perf } = state;
    const { observeResult } = target;
    appendDisabledElementWarning(
      this.host.strategy(),
      target.tapElement,
      target.activationWarnings,
    );
    this.host.logClickableParentSelection(target.usedParent);
    const { tapPoint, warning: tapPointWarning } = this.host.tapPoints().planVisibleTapPoint({
      options: target.tapOptions,
      requestedAction,
      observeResult,
      viewHierarchy: target.viewHierarchy,
      finalSelection: target.finalSelection,
      tapElement: target.tapElement,
    });
    if (tapPointWarning) {
      target.activationWarnings.push(tapPointWarning);
    }
    const tapBounds = target.tapElement.bounds;
    logger.info(
      `[TapOnElement] Tapping (${tapPoint.x}, ${tapPoint.y}) on element: ` +
        `text=${JSON.stringify(target.tapElement.text ?? options.text)}, ` +
        `bounds=${JSON.stringify(tapBounds)}, ` +
        `clickable=${target.tapElement.clickable}, usedParent=${target.usedParent}`,
    );

    state.selectionCapture = await this.host.prepareSelectionCapture(
      target.action,
      observeResult,
      target.tapElement,
      signal,
    );

    const preTapHash = options.retryIfNoChange
      ? this.host.hashViewHierarchy(target.viewHierarchy)
      : null;

    // Platform-specific tap execution. Everything that waits for the target (search,
    // pre-tap refresh) is behind us: the navigation graph measures from here (#10196).
    await perf.track("executeTap", () => this.dispatchPlatform(state, target, tapPoint, fence));
    if (options.ensureChecked !== undefined) {
      state.ensureCheckedTapTimestamp = this.host.timer().now();
    }

    if (preTapHash && this.host.strategy().retryTapIfNoChange) {
      await this.host.retryTapIfNoChange(
        preTapHash,
        tapPoint,
        target.action,
        target.longPressDuration,
        target.tapElement,
        {
          options: {
            ...this.host.withObservationScreenSize(target.tapOptions, observeResult),
            displayFence: fence,
          },
          isTalkBackEnabled: target.isAccessibilityServiceEnabled!,
          screenSize: observeResult.screenSize,
          signal,
          selection: target.finalSelection,
        },
      );
    }

    perf.end();
    return withResolvedLayer(
      {
        success: true,
        action: target.action,
        element: target.tapElement,
        selectedElement: target.selectedElementMetadata,
        searchUntil: target.searchOutcome.stats,
        ...(target.screenReaderNavigation
          ? { screenReaderNavigation: target.screenReaderNavigation }
          : {}),
        ...(target.activationWarnings.length ? { warnings: target.activationWarnings } : {}),
      },
      resolvedElementLayer(
        target.viewHierarchy,
        state.focusTarget ?? target.tapElement,
        this.platform(),
      ),
    );
  }

  private async dispatchPlatform(
    state: TapExecutionState,
    target: TapTargetState,
    tapPoint: { x: number; y: number },
    fence?: DisplayFence,
  ): Promise<void> {
    const { signal } = state;
    const { observeResult } = target;

    reportToolDispatched();
    await this.host.runPlatformTap({
      android: async () => {
        target.screenReaderNavigation = await this.host.executeAndroidTap(
          target.action,
          tapPoint.x,
          tapPoint.y,
          target.longPressDuration,
          target.tapElement,
          {
            signal,
            options: {
              ...target.tapOptions,
              displayFence: fence,
              resolvedHierarchy: target.viewHierarchy,
              onResolvedElement: (current, selection, hierarchy) => {
                target.tapElement = current;
                target.finalSelection = selection ?? {
                  ...target.finalSelection,
                  element: current,
                  matchedElement: current,
                };
                if (hierarchy) {
                  target.viewHierarchy = hierarchy;
                  state.preTapHierarchy = hierarchy;
                  this.host.replaceObservationHierarchy(observeResult, hierarchy, true);
                }
                target.selectedElementMetadata = this.host.buildSelectedElementMetadata(
                  target.finalSelection,
                );
                Object.assign(tapPoint, this.host.geometry().getElementCenter(current));
              },
              onActivationWarning: (warning) => target.activationWarnings.push(warning),
            },
            isTalkBackEnabled: target.isAccessibilityServiceEnabled,
          },
        );
      },
      ios: async () => {
        await this.host.executeiOSTap(
          target.action,
          tapPoint.x,
          tapPoint.y,
          target.longPressDuration,
          target.tapElement,
          {
            isVoiceOverEnabled: target.isAccessibilityServiceEnabled,
            displayFence: fence,
            signal,
          },
        );
      },
    });
  }

  async confirmFocusAfterTap({
    result,
    options,
    requestedAction,
    focusTarget,
    focusLabelText,
    preTapHierarchy,
    signal,
  }: {
    result: TapOnFocusOutcome;
    options: TapOnElementOptions;
    requestedAction: NonNullable<TapOnElementOptions["action"]>;
    focusTarget: Element | undefined;
    focusLabelText: string | undefined;
    preTapHierarchy: ViewHierarchyResult | undefined;
    signal?: AbortSignal;
  }): Promise<void> {
    if (requestedAction !== "focus" || !result.success || result.wasAlreadyFocused) {
      return;
    }
    const target = focusTarget ?? result.element;
    result.focusVerified = await this.host.verifyFocusAfterTap(
      result,
      (observation) =>
        this.host.verifyFocusedInputTarget(
          options,
          target,
          observation,
          focusLabelText,
          result.selectedElement?.indexInMatches,
          preTapHierarchy,
        ),
      signal,
    );
    if (!result.focusVerified) {
      result.success = false;
      result.error = `Failed to confirm focus on editable input ${describeFocusTarget(target, options)}: the focused field could not be matched to the target`;
    }
  }

  assertLongPressWithinRequestBudget(
    options: TapOnElementOptions,
    request?: { requestDeadlineMs?: number },
  ): void {
    if (options.action === "longPress") {
      assertLongPressFitsRequestBudget(
        this.host.getLongPressDuration(options),
        request?.requestDeadlineMs === undefined
          ? undefined
          : request.requestDeadlineMs - this.host.timer().now(),
      );
    }
  }

  predictionToolArgs(
    options: TapOnElementOptions,
  ): Pick<
    TapOnElementOptions,
    | "text"
    | "textAny"
    | "action"
    | "duration"
    | "container"
    | "searchUntil"
    | "selectionStrategy"
    | "accessibilityLink"
    | "subtext"
  > & { id: TapOnElementOptions["elementId"]; platform: BootedDevice["platform"] } {
    return {
      text: options.text,
      textAny: options.textAny,
      id: options.elementId,
      action: options.action,
      duration: options.duration,
      container: options.container,
      searchUntil: options.searchUntil,
      selectionStrategy: options.selectionStrategy,
      accessibilityLink: options.accessibilityLink,
      subtext: options.subtext,
      platform: this.host.device().platform,
    };
  }

  readScopeFailureResult(
    requestedAction: NonNullable<TapOnElementOptions["action"]>,
    action: TapOnElementOptions["action"],
    error: unknown,
    searchUntilStats: SearchUntilStats | undefined,
    debugContext: Awaited<ReturnType<typeof buildElementSearchDebugContext>>,
  ): TapOnFocusResult {
    const errorMsg = errorMessage(error);
    return markFocusFailure(
      requestedAction,
      {
        success: false,
        action,
        error: `Failed to perform tap on element: ${errorMsg}`,
        element: {
          bounds: { left: 0, top: 0, right: 0, bottom: 0 },
        } as Element,
        ...(searchUntilStats ? { searchUntil: searchUntilStats } : {}),
        ...(error instanceof ActionableError && error.containerFailure
          ? { containerFailure: error.containerFailure }
          : {}),
        ...(debugContext ? { debug: { elementSearch: debugContext } } : {}),
      },
      error,
    );
  }

  /**
   * Whether the pressed Android node advertises a long-click accessibility action. A node without
   * one has no View/semantics long-click handler, so the app treats the hold like a tap on release.
   * Handlers built on raw touch input (for example drag-to-reorder) are not visible here.
   */
  private longClickAdvertisement(element: Element | undefined): { longClickAdvertised?: boolean } {
    if (this.host.device().platform !== "android" || !Array.isArray(element?.actions)) {
      return {};
    }
    return { longClickAdvertised: hasAccessibilityAction(element.actions, "long_click") };
  }

  detectLongPressMetadata(
    previousObservation: ObserveResult | null,
    currentObservation?: ObserveResult,
  ): LongPressMetadata {
    return this.host.longPressMetadataDetector().detect(previousObservation, currentObservation);
  }
}
