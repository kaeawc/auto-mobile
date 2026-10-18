import {
  TapTargetUnavailableError,
  findTapTargetNode,
  type TapFocusFailure,
} from "./tapTargetSupport";
import { describeFocusTarget } from "./tapFocusIdentity";
import type { AndroidTapVerification, TapVerificationOptions } from "./tapVerificationOptions";
import {
  TapExplicitDisplayPhase,
  completedDisplayFailure,
  didCompleteDisplayGesture,
  rethrowKeyboardOcclusion,
  unverifiableDisplayPostState,
} from "./tapExplicitDisplayPhase";
import {
  markFocusFailure,
  resolvedElementLayer,
  warningsField,
  withResolvedLayer,
  type TapOnFocusOutcome,
  type TapOnFocusResult,
} from "./tapResultMarkers";
import { TapElementFinder } from "./tapElementFinder";
import { TapPointPlanner } from "./tapPointPlanner";

import { type StableTapTargetResult } from "./androidStableTapTarget";
import { POST_TAP_EFFECT_POLL_MS, PostTapSettler } from "./tapPostTapSettler";
import { FocusVerifier } from "./tapFocusVerifier";

import { returnsRawHierarchyUnfiltered } from "./tapHierarchyRead";
import {
  assertLongPressWithinHardMax,
  containerSelectorError,
  failedTapResult,
  resolveSearchUntilDuration,
} from "./tapSharedHelpers";
import { isStrictlyScoped } from "../utility/ScopedSelection";
import {
  withObservationReadScope,
  wasHierarchyReadDuringCall,
} from "../observe/observationReadScope";
import { ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS, freshTapHierarchy } from "./freshTapHierarchy";
import { type TalkBackTargetContext } from "../talkback/resourceIdActionError";
import { DispatchedObservationError } from "../../models/DispatchedObservationError";

import { assertLongPressFitsRequestBudget } from "./gestureTransportTimeout";
import {
  type DisplayFence,
  type DisplayFenceOption,
  type DisplayFenceDependencies,
} from "./BaseVisualChange";
import { withStaleDisplay, StaleDisplayError } from "../observe/StaleDisplayError";
import { unsupportedPlatformError } from "../../models/ActionableError";
import { isFocusEditableElement, promoteClickableAncestor } from "../utility/ElementResolver";
import { SearchableHierarchy } from "../utility/SearchableNode";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import { DefaultHierarchyCapture, type HierarchyCapture } from "../observe/HierarchyCapture";
import { errorMessage } from "../../utils/describeUnknownError";
import { BaseVisualChange, ProgressCallback, type ObservedActionResult } from "./BaseVisualChange";
import {
  displayTransitions,
  type DisplayTransitionReader,
  type DisplayTransitionTracker,
} from "../observe/DisplayTransition";

import {
  ActionableError,
  BootedDevice,
  Element,
  isFalsy,
  ElementSelectionResult,
  ObserveResult,
  TapOnElementResult,
  TapOnSelectedElement,
  ViewHierarchyResult,
} from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import { DefaultElementParser } from "../utility/ElementParser";
import { isElementKeyboardFocused } from "../utility/FocusedInput";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";

import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";

import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { reportToolDispatched } from "../../utils/ToolDispatchContext";
import {
  DEFAULT_VISION_CONFIG,
  type VisionFallbackConfig,
  type VisionAnalyzer,
} from "../../vision/index";
import { buildElementSearchDebugContext } from "../utility/ElementSearchDebugContext";
import { throwIfAborted } from "../../utils/toolUtils";
import {
  SelectionStateTracker,
  SelectionCaptureState,
  TakeScreenshotCapturer,
  type ScreenshotCapturer,
} from "../navigation/SelectionStateTracker";
import { AccessibilityDetector } from "../accessibility/interfaces/AccessibilityDetector";
import { accessibilityDetector as defaultAccessibilityDetector } from "../accessibility/AccessibilityDetector";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import { type Timer } from "../../utils/SystemTimer";
import { hierarchyFingerprint } from "../../utils/hierarchyFingerprint";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { serverConfig } from "../../utils/ServerConfig";
import { boundsEqual } from "../../utils/bounds";
import { TapSearchPhase, type SearchUntilStats } from "./tapSearchPhase";
import { TapHierarchyRefreshPhase, staleSyntheticTarget } from "./tapHierarchyRefreshPhase";
import { TapSemanticLinkPhase } from "./tapSemanticLinkPhase";
import { TapAndroidLongPressPhase } from "./tapAndroidLongPressPhase";
import { TapIosDispatchPhase } from "./tapIosDispatchPhase";
import { TapEnsureCheckedPhase } from "./tapEnsureCheckedPhase";
import { TapPostTapEffectPhase } from "./tapPostTapEffectPhase";
import { TapRetryPhase } from "./tapRetryPhase";
import { TapAndroidDispatchPhase, type ResolvedAndroidTapOptions } from "./tapAndroidDispatchPhase";
import { isAndroidDocumentsUiRow } from "./androidCoordinateTapPolicy";
import { scopeHierarchyForSelector } from "../observe/hierarchyLayer";
import {
  getToggleContentDescription,
  hasAccessibilityAction,
  isTruthyFlag,
} from "../utility/elementProperties";
import {
  TalkBackTapStrategy,
  TALKBACK_ACTIVATION_WARNING,
  type ScreenReaderNavigationResult,
  type TalkBackTapResult,
} from "../talkback/TalkBackTapStrategy";
import {
  DefaultTalkBackNavigationDriverFactory,
  type TalkBackNavigationDriverFactory,
} from "../talkback/TalkBackNavigationDriver";
import type { IosVoiceOverDetector } from "../accessibility/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../accessibility/IosVoiceOverDetector";
import type { TapStrategy } from "../../utils/interfaces/TapStrategy";
import { FeatureFlagService, type FeatureFlagReader } from "../featureFlags/FeatureFlagService";
import { createTapStrategy } from "./strategies/createTapStrategy";
import { LongPressMetadataDetector, type LongPressMetadata } from "./LongPressMetadataDetector";
import { RealWaitForCondition } from "../observe/WaitForCondition";
import type { WaitForCondition } from "../observe/interfaces/WaitForCondition";

import { type RenderedObservationReader } from "./TargetDisplayAction";
import {
  DEFAULT_HIERARCHY_READ_TIMEOUT_MS,
  createDeviceHierarchyCapture,
} from "../observe/DeviceHierarchyCapture";

import { deadlineRequest, resolveTapOnCall, type TapOnCall } from "./ActionCall";
import { OBSERVED_INTERACTION_PROFILES, SETTLE_BUDGET_MS } from "./observedInteractionProfiles";

/**
 * Dependencies for TapOnElement that can be injected for testing.
 */
interface TapOnElementDependencies extends DisplayFenceDependencies {
  displayTransitions?: DisplayTransitionReader &
    Pick<DisplayTransitionTracker, "checkIdentity" | "record">;
  lastRenderedObservation?: RenderedObservationReader;
  hierarchyCapture?: HierarchyCapture;
  visionConfig?: VisionFallbackConfig;
  screenshotCapturer?: ScreenshotCapturer;
  visionAnalyzer?: VisionAnalyzer;
  selectionStateTracker?: Pick<SelectionStateTracker, "prepare" | "finalize">;
  accessibilityDetector?: AccessibilityDetector;
  timer?: Timer;
  elementSelector?: ElementSelector;
  talkBackStrategy?: TalkBackTapStrategy;
  talkBackDriverFactory?: TalkBackNavigationDriverFactory;
  iosVoiceOverDetector?: IosVoiceOverDetector;
  featureFlags?: FeatureFlagReader;
  waitForCondition?: WaitForCondition;
  /**
   * Override the platform-specific {@link TapStrategy}. Tests use this
   * to inject a fake; production code leaves it unset so the constructor
   * picks the right strategy based on `device.platform`.
   */
  tapStrategy?: TapStrategy;
}

/** How long an iOS focus tap re-reads the screen for the field to report focus (#10266). */
const IOS_FOCUS_SETTLE_TIMEOUT_MS = 1500;

export {
  ANDROID_PRE_TAP_REFIND_BUDGET_MS,
  ANDROID_PRE_TAP_REFIND_BUDGET_MS_WHEN_LOADING,
  ANDROID_PRE_TAP_REFIND_MIN_POLLS,
} from "./androidStableTapTarget";

/** Test-only typed override surface for pre-tap stability tests; production callers must not depend on it. */
export interface TapPreTapStabilitySeam {
  refreshViewHierarchy: TapOnElement["refreshViewHierarchy"];
  findElementInHierarchy: TapOnElement["findElementInHierarchy"];
  resolveTapTargetElement: TapOnElement["resolveTapTargetElement"];
  resolveAndroidStableTapTargetAfterRefreshes: TapOnElement["resolveAndroidStableTapTargetAfterRefreshes"];
  staleSyntheticTarget: TapOnElement["staleSyntheticTarget"];
  buildSelectedElementMetadata: TapOnElement["buildSelectedElementMetadata"];
  rebuildSelectedElementMetadataAfterStability: TapOnElement["rebuildSelectedElementMetadataAfterStability"];
}

export { tapFocusFailure, tapResolvedLayer, type TapOnFocusResult } from "./tapResultMarkers";
export type { TapFocusFailure };

function appendDisabledElementWarning(
  platform: string,
  element: Element,
  warnings: string[],
): void {
  if (platform === "android" && isFalsy(element.enabled)) {
    warnings.push("The matched element is disabled; the tap may have no effect.");
  }
}

function withActivationWarning(warnings: string[], warning: string | undefined): string[] {
  return warning ? [...warnings, warning] : warnings;
}

export class TapOnElement extends BaseVisualChange implements TapPreTapStabilitySeam {
  private readonly refreshedDisplayTransitions: Pick<
    DisplayTransitionTracker,
    "checkIdentity" | "record"
  >;
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private readonly focusVerifier = new FocusVerifier({
    device: this.device,
    findElementInHierarchy: (options, hierarchy) => this.findElementInHierarchy(options, hierarchy),
    withObservationScreenSize: (options, observation) =>
      this.withObservationScreenSize(options, observation),
  });
  private readonly tapPoints = new TapPointPlanner({
    device: this.device,
    geometry: () => this.geometry,
    strategy: () => this.strategy,
  });
  private readonly finder = new TapElementFinder({
    device: this.device,
    elementSelector: () => this.elementSelector,
    tapPoints: this.tapPoints,
  });
  private readonly settler = new PostTapSettler({
    timer: this.timer,
    waitForCondition: () => this.waitForCondition,
    hashViewHierarchy: (hierarchy) => this.hashViewHierarchy(hierarchy),
    deriveTapEffect: (previous, current) => this.deriveTapEffect(previous, current),
    compareActiveWindow: (previous, current) => this.compareActiveWindow(previous, current),
  });
  private readonly postTapEffect = new TapPostTapEffectPhase({
    platform: this.device.platform,
    settler: () => this.settler,
    deriveTapEffect: (previous, current) => this.deriveTapEffect(previous, current),
    getScreenSizeFromHierarchy: (hierarchy, options) =>
      this.getScreenSizeFromHierarchy(hierarchy, options),
  });
  private readonly ensureChecked = new TapEnsureCheckedPhase({
    timer: this.timer,
    tapVerificationRefresh: (context) => this.tapVerificationRefresh(context),
    findElementInHierarchy: (options, hierarchy) => this.findElementInHierarchy(options, hierarchy),
    withObservationScreenSize: (options, observation) =>
      this.withObservationScreenSize(options, observation),
    replaceObservationHierarchy: (observation, hierarchy, refreshed) =>
      this.replaceObservationHierarchy(observation, hierarchy, refreshed),
    elementAffordances: (element) => this.elementAffordances(element),
    elementIdentity: (element) => this.elementIdentity(element),
  });
  private readonly retry = new TapRetryPhase({
    timer: this.timer,
    tapVerificationRefresh: (context) => this.tapVerificationRefresh(context),
    hashViewHierarchy: (hierarchy) => this.hashViewHierarchy(hierarchy),
    findElementInHierarchy: (options, hierarchy) => this.findElementInHierarchy(options, hierarchy),
    resolveTapTargetElement: (element, hierarchy, action, targetOptions) =>
      this.resolveTapTargetElement(element, hierarchy, action, targetOptions),
    getScreenSizeFromHierarchy: (hierarchy, options) =>
      this.getScreenSizeFromHierarchy(hierarchy, options),
    visibleTapBounds: (...args) => this.visibleTapBounds(...args),
    resolveVisibleTapPoint: (...args) => this.resolveVisibleTapPoint(...args),
    executeAndroidTap: (...args) => this.executeAndroidTap(...args),
  });
  private readonly androidDispatch = new TapAndroidDispatchPhase({
    device: this.device,
    timer: this.timer,
    adb: () => this.adb,
    accessibilityService: () => this.accessibilityService,
    talkBackStrategy: () => this.talkBackStrategy,
    talkBackDriverFactory: () => this.talkBackDriverFactory,
    executeAndroidLongPress: (...args) => this.executeAndroidLongPress(...args),
    executeAndroidTapWithCoordinates: (...args) => this.executeAndroidTapWithCoordinates(...args),
    reportTalkBackActivationWarning: (result, context, action) =>
      this.reportTalkBackActivationWarning(result, context, action),
  });
  private readonly explicitDisplay = new TapExplicitDisplayPhase({
    device: this.device,
    timer: this.timer,
    tapPoints: this.tapPoints,
    adb: () => this.adb,
    accessibilityService: () => this.accessibilityService,
    geometry: () => this.geometry,
    hierarchyCapture: () => this.hierarchyCapture,
    lastRenderedObservation: () => this.lastRenderedObservation,
    observeScreen: () => this.observeScreen,
    displayTransitionReader: () => this.displayTransitionReader,
    strategy: () => this.strategy,
    talkBackStrategy: () => this.talkBackStrategy,
    talkBackDriverFactory: () => this.talkBackDriverFactory,
    createErrorResult: (action, error, cause) => this.createErrorResult(action, error, cause),
    validateOptions: (options) => this.validateOptions(options),
    getSearchUntilDuration: (options) => this.getSearchUntilDuration(options),
    hashViewHierarchy: (hierarchy) => this.hashViewHierarchy(hierarchy),
    buildSelectedElementMetadata: (selection) => this.buildSelectedElementMetadata(selection),
    findElementInHierarchy: (options, hierarchy) => this.findElementInHierarchy(options, hierarchy),
    withObservationScreenSize: (options, observation) =>
      this.withObservationScreenSize(options, observation),
    replaceObservationHierarchy: (observation, hierarchy, refreshed) =>
      this.replaceObservationHierarchy(observation, hierarchy, refreshed),
    refreshEnsureCheckedSelection: (options, observation, selection, signal) =>
      this.refreshEnsureCheckedSelection(options, observation, selection, signal),
    ensureCheckedBeforeTap: (options, element, selected, searchUntil) =>
      this.ensureCheckedBeforeTap(options, element, selected, searchUntil),
    applyEnsureCheckedResult: (result, options, signal) =>
      this.applyEnsureCheckedResult(result, options, signal),
    resolveAndroidStableTapTargetAfterRefreshes: (
      options,
      observation,
      action,
      requireId,
      signal,
    ) =>
      this.resolveAndroidStableTapTargetAfterRefreshes(
        options,
        observation,
        action,
        requireId,
        signal,
      ),
    searchForElement: (options, observation, signal) =>
      this.searchForElement(options, observation, signal),
    handleElementNotFound: (options, observation, containerFound, signal, selection) =>
      this.handleElementNotFound(options, observation, containerFound, signal, selection),
    visibleTapBounds: (...args) => this.visibleTapBounds(...args),
    resolveVisibleTapPoint: (...args) => this.resolveVisibleTapPoint(...args),
    retryTapIfNoChange: (...args) => this.retryTapIfNoChange(...args),
    verifyFocusedInputTarget: (...args) => this.verifyFocusedInputTarget(...args),
    observedInteraction: (block, options) => this.observedInteraction(block, options),
    staleDisplay: (generation) => this.staleDisplay(generation),
    checkPostActionDisplay: (result, assertCurrent, signal) =>
      this.checkPostActionDisplay(result, assertCurrent, signal),
    rethrowObservationAbort: (error, signal, enabled) =>
      this.rethrowObservationAbort(error, signal, enabled),
  });
  private readonly search = new TapSearchPhase({
    timer: this.timer,
    visionConfig: () => this.visionConfig,
    screenshotCapturer: () => this.screenshotCapturer,
    visionAnalyzer: () => this.visionAnalyzer,
    getSearchUntilDuration: (options) => this.getSearchUntilDuration(options),
    hashViewHierarchy: (hierarchy) => this.hashViewHierarchy(hierarchy),
    getScreenSizeFromHierarchy: (...args) => this.getScreenSizeFromHierarchy(...args),
    invisibleMatchFailure: (...args) => this.invisibleMatchFailure(...args),
    isElementTapTargetOffScreen: (...args) => this.isElementTapTargetOffScreen(...args),
    findElementInHierarchy: (options, hierarchy) => this.findElementInHierarchy(options, hierarchy),
    withObservationScreenSize: (options, observation) =>
      this.withObservationScreenSize(options, observation),
    tapVerificationRefresh: (context) => this.tapVerificationRefresh(context),
  });
  private readonly hierarchyRefresh = new TapHierarchyRefreshPhase({
    device: this.device,
    timer: this.timer,
    adb: () => this.adb,
    accessibilityService: () => this.accessibilityService,
    viewHierarchy: () => this.viewHierarchy,
    hierarchyCapture: () => this.hierarchyCapture,
    elementParser: () => this.elementParser,
    refreshedDisplayTransitions: () => this.refreshedDisplayTransitions,
    displayTransitionIdentityRevision: (deviceId) =>
      this.displayTransitionReader.identityRevision(deviceId),
    renderedDisplayGeneration: (deviceId) => this.renderedDisplayGeneration(deviceId),
    staleDisplay: (generation) => this.staleDisplay(generation),
    getScreenSizeFromHierarchy: (...args) => this.getScreenSizeFromHierarchy(...args),
    prepareViewHierarchyForResponse: (raw, size) => this.prepareViewHierarchyForResponse(raw, size),
    refreshViewHierarchy: (...args) => this.refreshViewHierarchy(...args),
    staleSyntheticTarget: (...args) => this.staleSyntheticTarget(...args),
    findElementInHierarchy: (options, hierarchy) => this.findElementInHierarchy(options, hierarchy),
    resolveTapTargetElement: (element, hierarchy, action, targetOptions) =>
      this.resolveTapTargetElement(element, hierarchy, action, targetOptions),
    withObservationScreenSize: (options, observation) =>
      this.withObservationScreenSize(options, observation),
  });
  private readonly semanticLink = new TapSemanticLinkPhase({
    device: this.device,
    accessibilityService: () => this.accessibilityService,
    elementParser: () => this.elementParser,
  });
  private readonly androidLongPress = new TapAndroidLongPressPhase({
    adb: () => this.adb,
    accessibilityService: () => this.accessibilityService,
  });
  private readonly iosDispatch = new TapIosDispatchPhase({
    device: this.device,
    executeiOSTapWithCoordinates: (...args) => this.executeiOSTapWithCoordinates(...args),
    executeIOSTapWithVoiceOver: (...args) => this.executeIOSTapWithVoiceOver(...args),
  });
  private geometry: ElementGeometry;
  private elementParser: ElementParser;
  private accessibilityService: AndroidCtrlProxyClient;
  private visionConfig: VisionFallbackConfig;
  private screenshotCapturer: ScreenshotCapturer;
  private visionAnalyzer: VisionAnalyzer | undefined;
  private selectionStateTracker: Pick<SelectionStateTracker, "prepare" | "finalize">;
  private accessibilityDetector: AccessibilityDetector;
  private elementSelector: ElementSelector;
  private viewHierarchy: ViewHierarchy;
  private hierarchyCapture: HierarchyCapture;
  private talkBackStrategy: TalkBackTapStrategy;
  private readonly featureFlags: FeatureFlagReader;
  private talkBackDriverFactory: TalkBackNavigationDriverFactory;
  private iosVoiceOverDetector: IosVoiceOverDetector;
  private strategy: TapStrategy;
  private longPressMetadataDetector: LongPressMetadataDetector;
  private readonly waitForCondition: WaitForCondition;
  private static readonly SEARCH_POLL_INTERVAL_MS = 50;
  private static readonly SEARCH_UNTIL_DEFAULT_MS = 1500;
  private static readonly SEARCH_UNTIL_MIN_MS = 100;
  private static readonly SEARCH_UNTIL_MAX_MS = 12000;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    options: TapOnElementDependencies = {},
  ) {
    super(device, adb, options.timer, options.renderedDisplayRevision, options);
    this.refreshedDisplayTransitions = options.displayTransitions ?? displayTransitions;
    this.lastRenderedObservation = options.lastRenderedObservation;
    this.waitForCondition =
      options.waitForCondition ?? new RealWaitForCondition(this.observeScreen, this.timer);
    this.geometry = new DefaultElementGeometry();
    this.elementParser = new DefaultElementParser();
    this.accessibilityService = AndroidCtrlProxyClient.getInstance(device, this.adbFactory);
    this.visionConfig = options.visionConfig || DEFAULT_VISION_CONFIG;
    this.screenshotCapturer =
      options.screenshotCapturer ?? new TakeScreenshotCapturer(device, this.adbFactory);
    this.visionAnalyzer = options.visionAnalyzer;
    this.viewHierarchy = new ViewHierarchy(device, this.adbFactory);
    this.hierarchyCapture =
      options.hierarchyCapture ??
      new DefaultHierarchyCapture(
        device.platform as "android" | "ios",
        {
          readCached: (request) =>
            this.viewHierarchy.getViewHierarchy(
              {},
              {
                skipWaitForFresh: true,
                minTimestamp: request.minTimestamp,
                signal: request.signal,
                timeoutMs: request.timeoutMs,
              },
            ),
          readFresh: async (request) => {
            if (request.displayId !== undefined) {
              return (
                await createDeviceHierarchyCapture(device, {
                  adbFactory: this.adbFactory,
                  timer: this.timer,
                }).capture(request)
              ).hierarchy;
            }
            const result = await this.readFreshHierarchy(
              request.timeoutMs ?? ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS,
              undefined,
              request.signal,
              request.requireFreshExtraction,
            );
            if (!result) {
              throw new ActionableError("Unable to retrieve a fresh tap hierarchy");
            }
            return result;
          },
          projectVisible: (hierarchy) => this.viewHierarchy.projectActionableHierarchy(hierarchy),
        },
        this.timer,
      );
    this.selectionStateTracker =
      options.selectionStateTracker ??
      new SelectionStateTracker({
        screenshotCapturer: this.screenshotCapturer,
      });
    this.accessibilityDetector = options.accessibilityDetector || defaultAccessibilityDetector;
    this.elementSelector =
      options.elementSelector ??
      new ResolverElementSelector(undefined, undefined, {
        platform: device.platform,
        iosMultiPanel: device.platform === "ios" && (device.displays?.panels.length ?? 0) > 1,
      });
    this.talkBackDriverFactory =
      options.talkBackDriverFactory ?? new DefaultTalkBackNavigationDriverFactory(this.adbFactory);
    this.talkBackStrategy =
      options.talkBackStrategy ??
      new TalkBackTapStrategy({
        timer: this.timer,
        driverFactory: this.talkBackDriverFactory,
      });
    this.iosVoiceOverDetector = options.iosVoiceOverDetector ?? defaultIosVoiceOverDetector;
    this.featureFlags = options.featureFlags ?? FeatureFlagService.getInstance();
    this.strategy =
      options.tapStrategy ??
      createTapStrategy(
        device,
        this.adb,
        this.accessibilityDetector,
        this.iosVoiceOverDetector,
        this.featureFlags,
      );
    this.longPressMetadataDetector = new LongPressMetadataDetector(this.elementParser);
  }

  /**
   * Create an error result with consistent structure
   * @param action - The intended action
   * @param error - The error message
   * @returns TapOnTextResult with error state
   */
  private createErrorResult(action: string, error: string, cause?: unknown): TapOnFocusResult {
    return markFocusFailure(action, failedTapResult(action, error), cause);
  }

  private validateOptions(options: TapOnElementOptions): string | null {
    if (options.ensureChecked !== undefined && options.action !== "tap") {
      return 'tapOn ensureChecked requires action "tap"';
    }
    if (options.ensureChecked !== undefined && options.selectionStrategy === "random") {
      return "tapOn ensureChecked cannot use random selection; use a unique selector or index";
    }
    const selectorCount = [
      options.text,
      options.elementId,
      options.testTag,
      options.textAny,
      options.accessibilityLink,
    ].filter(Boolean).length;
    if (selectorCount !== 1) {
      return "tapOn requires exactly one of text, textAny, elementId, testTag, or accessibilityLink";
    }

    if (options.textAny && options.textAny.length === 0) {
      return "tapOn textAny selector must be non-empty";
    }

    const containerError = containerSelectorError(options.container, "tapOn");
    if (containerError) {
      return containerError;
    }

    return this.semanticLink.validateSemanticLinkOptions(options);
  }

  private hasUniqueSemanticLinkOwner(
    ...args: Parameters<TapSemanticLinkPhase["hasUniqueSemanticLinkOwner"]>
  ): boolean {
    return this.semanticLink.hasUniqueSemanticLinkOwner(...args);
  }

  private getSearchUntilDuration(options: TapOnElementOptions): number {
    return resolveSearchUntilDuration(options.searchUntil?.duration, {
      defaultMs: TapOnElement.SEARCH_UNTIL_DEFAULT_MS,
      minMs: TapOnElement.SEARCH_UNTIL_MIN_MS,
      maxMs: TapOnElement.SEARCH_UNTIL_MAX_MS,
    });
  }

  private hashViewHierarchy(viewHierarchy: ViewHierarchyResult | null): string | null {
    return hierarchyFingerprint(viewHierarchy);
  }

  private deriveTapEffect(
    previousObservation: ObserveResult | null,
    currentObservation: ObserveResult | undefined,
  ): TapOnElementResult["effect"] | undefined {
    return this.deriveInteractionEffect(previousObservation, currentObservation);
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  async deriveTapEffectAfterPostTapObservation(
    previousObservation: ObserveResult | null,
    currentObservation: ObserveResult,
    signal?: AbortSignal,
  ): Promise<{ effect: TapOnElementResult["effect"]; observation: ObserveResult }> {
    return this.postTapEffect.deriveEffectAfterPostTapObservation(
      previousObservation,
      currentObservation,
      signal,
    );
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  enforceFreshnessConsistencyWithEffect(
    previousObservation: ObserveResult | null,
    result: { effect?: TapOnElementResult["effect"]; observation?: ObserveResult },
  ): void {
    this.postTapEffect.enforceFreshnessConsistency(previousObservation, result);
  }

  private replaceObservationHierarchy(
    observeResult: ObserveResult,
    viewHierarchy: ViewHierarchyResult,
    refreshedFromDevice: boolean,
  ): void {
    this.postTapEffect.replaceObservationHierarchy(
      observeResult,
      viewHierarchy,
      refreshedFromDevice,
    );
  }

  private logClickableParentSelection(usedParent: boolean): void {
    if (usedParent) {
      logger.info("[TapOnElement] Using clickable parent for non-clickable element");
    }
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  async prepareSelectionCapture(
    action: string,
    observation: ObserveResult,
    element: Element,
    signal?: AbortSignal,
  ): Promise<SelectionCaptureState | null> {
    return this.selectionStateTracker.prepare({
      action,
      observation,
      element,
      signal,
    });
  }

  private withObservationScreenSize(
    options: TapVerificationOptions,
    observation: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>,
  ): TapVerificationOptions {
    return {
      ...options,
      screenSizeOptions: {
        observationScreenSize: observation.screenSize,
        display: observation.viewHierarchy,
      },
    };
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  findElementInHierarchy(
    options: TapVerificationOptions,
    viewHierarchy: ViewHierarchyResult,
  ): { selection: ElementSelectionResult; containerFound: boolean } {
    viewHierarchy = scopeHierarchyForSelector(viewHierarchy, options.layer);
    try {
      return this.finder.selectElementInHierarchy(options, viewHierarchy);
    } catch (error) {
      if (
        options.action !== "focus" ||
        !(error instanceof ActionableError) ||
        error instanceof TapTargetUnavailableError ||
        (!isStrictlyScoped(options) && options.index === undefined) ||
        !this.finder.isContainerAvailable(viewHierarchy, options.container)
      ) {
        throw error;
      }
      return this.finder.classifyFocusSelectionFailure(options, viewHierarchy, error);
    }
  }

  /**
   * Confirm a focus tap against the post-tap observation. On iOS that first capture
   * can predate the field taking focus (#10266): the field is focused moments later,
   * but the first read shows no focused field that matches the target. Re-read fresh
   * captures for a bounded window before reporting the focus unconfirmed, and return
   * the capture that confirmed it as the result's observation.
   */
  private verifyFocusedInputTarget(
    options: TapOnElementOptions,
    target: Element,
    observation?: ObserveResult,
    labelText?: string,
    selectedIndex?: number,
    preTapHierarchy?: ViewHierarchyResult,
  ): boolean {
    return this.focusVerifier.verify(
      options,
      target,
      observation,
      labelText,
      selectedIndex,
      preTapHierarchy,
    );
  }

  private invisibleMatchFailure(...args: Parameters<TapPointPlanner["invisibleMatchFailure"]>) {
    return this.tapPoints.invisibleMatchFailure(...args);
  }

  private resolveTapPoint(...args: Parameters<TapPointPlanner["resolveTapPoint"]>) {
    return this.tapPoints.resolveTapPoint(...args);
  }

  private resolveContainerElement(
    ...args: Parameters<TapElementFinder["resolveContainerElement"]>
  ) {
    return this.finder.resolveContainerElement(...args);
  }

  private readonly isElementTapTargetOffScreen: TapPointPlanner["isElementTapTargetOffScreen"] = (
    ...args
  ) => this.tapPoints.isElementTapTargetOffScreen(...args);

  private visibleTapBounds(...args: Parameters<TapPointPlanner["visibleTapBounds"]>) {
    return this.tapPoints.visibleTapBounds(...args);
  }

  private resolveVisibleTapPoint(...args: Parameters<TapPointPlanner["resolveVisibleTapPoint"]>) {
    return this.tapPoints.resolveVisibleTapPoint(...args);
  }

  private readonly getScreenSizeFromHierarchy: TapPointPlanner["getScreenSizeFromHierarchy"] = (
    ...args
  ) => this.tapPoints.getScreenSizeFromHierarchy(...args);

  private async verifyFocusAfterTap(
    result: TapOnElementResult,
    verify: (observation: ObserveResult | undefined) => boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (verify(result.observation)) {
      return true;
    }
    const initial = result.observation;
    if (this.device.platform !== "ios" || !initial) {
      return false;
    }
    const deadline = this.timer.now() + IOS_FOCUS_SETTLE_TIMEOUT_MS;
    while (this.timer.now() < deadline) {
      await this.timer.sleep(POST_TAP_EFFECT_POLL_MS);
      throwIfAborted(signal);
      const hierarchy = await this.refreshViewHierarchy(
        deadline - this.timer.now(),
        initial.screenSize,
        signal,
        true,
      );
      if (!hierarchy) {
        continue;
      }
      const observation: ObserveResult = { ...initial };
      this.replaceObservationHierarchy(observation, hierarchy, true);
      if (verify(observation)) {
        result.observation = observation;
        return true;
      }
    }
    return false;
  }

  private prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ): ViewHierarchyResult {
    if (returnsRawHierarchyUnfiltered(serverConfig.isRawElementSearchEnabled(), rawHierarchy)) {
      return rawHierarchy;
    }

    const filtered = this.strategy.prepareViewHierarchyForResponse(
      rawHierarchy,
      this.viewHierarchy,
      screenSize,
    );
    return filtered ?? rawHierarchy;
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  refreshViewHierarchy(
    ...args: Parameters<TapHierarchyRefreshPhase["refreshViewHierarchy"]>
  ): ReturnType<TapHierarchyRefreshPhase["refreshViewHierarchy"]> {
    return this.hierarchyRefresh.refreshViewHierarchy(...args);
  }

  private tapVerificationRefresh(
    ...args: Parameters<TapHierarchyRefreshPhase["tapVerificationRefresh"]>
  ): AndroidTapVerification["refresh"] {
    return this.hierarchyRefresh.tapVerificationRefresh(...args);
  }

  private readFreshHierarchy(
    ...args: Parameters<TapHierarchyRefreshPhase["readFreshHierarchy"]>
  ): ReturnType<TapHierarchyRefreshPhase["readFreshHierarchy"]> {
    return this.hierarchyRefresh.readFreshHierarchy(...args);
  }

  /**
   * Re-fetch the Android hierarchy and re-resolve the tap target until bounds match on enough
   * consecutive re-finds; see {@link resolveAndroidStableTapTarget}.
   */
  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  resolveAndroidStableTapTargetAfterRefreshes(
    ...args: Parameters<TapHierarchyRefreshPhase["resolveAndroidStableTapTargetAfterRefreshes"]>
  ): Promise<StableTapTargetResult> {
    return this.hierarchyRefresh.resolveAndroidStableTapTargetAfterRefreshes(...args);
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  staleSyntheticTarget(...args: Parameters<typeof staleSyntheticTarget>): string | undefined {
    return staleSyntheticTarget(...args);
  }

  private searchForElement(
    ...args: Parameters<TapSearchPhase["searchForElement"]>
  ): ReturnType<TapSearchPhase["searchForElement"]> {
    return this.search.searchForElement(...args);
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  buildSelectedElementMetadata(
    selection: ElementSelectionResult,
  ): TapOnSelectedElement | undefined {
    if (!selection.element) {
      return undefined;
    }

    const bounds = selection.element.bounds;
    const center = this.geometry.getElementCenter(selection.element);
    const text =
      getToggleContentDescription(selection.element) ??
      (typeof selection.element.text === "string" && selection.element.text.length > 0
        ? selection.element.text
        : typeof selection.element["content-desc"] === "string"
          ? selection.element["content-desc"]
          : typeof selection.element["ios-accessibility-label"] === "string"
            ? selection.element["ios-accessibility-label"]
            : "");
    const resourceId =
      typeof selection.element["resource-id"] === "string" ? selection.element["resource-id"] : "";
    const testTag =
      typeof selection.element["test-tag"] === "string" ? selection.element["test-tag"] : undefined;

    return {
      ...(selection.matchedElement ? { matchedElement: selection.matchedElement } : {}),
      ...(selection.captureId ? { captureId: selection.captureId } : {}),
      text,
      resourceId,
      ...(testTag ? { testTag } : {}),
      bounds: {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        centerX: center.x,
        centerY: center.y,
      },
      indexInMatches: selection.indexInMatches,
      totalMatches: selection.totalMatches,
      selectionStrategy: selection.strategy,
    };
  }

  /**
   * Rebuild `selectedElement` metadata after the Android pre-tap-stability path
   * re-resolved the tap target against a refreshed hierarchy (#5888). Returns the
   * metadata rebuilt from the refreshed `selection`; when the refreshed selection
   * carries no element (nothing new to describe), falls back to the pre-refresh
   * `previous` metadata so the reported node still matches something real.
   *
   * This is the seam #5897 pins directly: the decision lived inline in `execute`
   * as a single line that no test exercised, so a refactor could silently drop it.
   */
  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  rebuildSelectedElementMetadataAfterStability(
    previous: TapOnSelectedElement | undefined,
    selection: ElementSelectionResult,
  ): TapOnSelectedElement | undefined {
    return this.buildSelectedElementMetadata(selection) ?? previous;
  }

  private handleElementNotFound(
    ...args: Parameters<TapSearchPhase["handleElementNotFound"]>
  ): Promise<never> {
    return this.search.handleElementNotFound(...args);
  }

  private isClickableElement(element: Element): boolean {
    return isTruthyFlag(element.clickable) || hasAccessibilityAction(element.actions, "click");
  }

  private isLongClickableElement(element: Element): boolean {
    return (
      isTruthyFlag(element["long-clickable"]) ||
      isTruthyFlag(element.longClickable) ||
      hasAccessibilityAction(element.actions, "long_click")
    );
  }

  private elementAffordances(element: Element): string[] {
    const affordances: string[] = [];
    if (this.isClickableElement(element)) {
      affordances.push("tap");
    }
    if (this.isLongClickableElement(element)) {
      affordances.push("long-press");
    }
    const className = typeof element.class === "string" ? element.class : "";
    if (
      isTruthyFlag(element.focusable) &&
      (className.includes("EditText") ||
        (typeof element["input-type"] === "string" && element["input-type"].trim() !== ""))
    ) {
      affordances.push("input");
    }
    if (isTruthyFlag(element.scrollable)) {
      affordances.push("scroll");
    }
    if (isTruthyFlag(element.checkable)) {
      affordances.push("toggle");
    }
    return affordances;
  }

  private elementIdentity(element: Element): string {
    return (
      element.text ??
      element["resource-id"] ??
      element["testTag"] ??
      element["test-tag"] ??
      element["content-desc"] ??
      "unidentified element"
    );
  }

  private ensureCheckedBeforeTap(
    options: TapOnElementOptions,
    element: Element,
    selectedElement: TapOnSelectedElement | undefined,
    searchUntil: SearchUntilStats,
  ): TapOnElementResult | undefined {
    return this.ensureChecked.beforeTap(options, element, selectedElement, searchUntil);
  }

  private refreshEnsureCheckedSelection(
    options: TapVerificationOptions,
    observation: ObserveResult,
    selection: ElementSelectionResult,
    signal?: AbortSignal,
  ): Promise<{ selection: ElementSelectionResult; viewHierarchy: ViewHierarchyResult }> {
    return this.ensureChecked.refreshSelection(options, observation, selection, signal);
  }

  private applyEnsureCheckedResult(
    result: TapOnElementResult,
    options: TapVerificationOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.ensureChecked.applyResult(result, options, signal);
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  resolveTapTargetElement(
    element: Element,
    viewHierarchy: ViewHierarchyResult | null,
    action: string,
    targetOptions: boolean | { requireResourceId: boolean; scoped: boolean },
  ): { element: Element; usedParent: boolean } {
    // Scoped lookups already select within the resolver boundary. Do not promote
    // their result to a container or an ancestor outside the requested subtree.
    if (typeof targetOptions !== "boolean" && targetOptions.scoped) {
      return { element, usedParent: false };
    }
    const requireResourceId =
      typeof targetOptions === "boolean" ? targetOptions : targetOptions.requireResourceId;
    if (!viewHierarchy || this.device.platform !== "android") {
      return { element, usedParent: false };
    }
    const nodes = new SearchableHierarchy().project(viewHierarchy);
    const matched = findTapTargetNode(nodes, element);
    const target = matched
      ? promoteClickableAncestor(matched, nodes, {
          action: action === "longPress" ? "long-press" : "tap",
          requireResourceId,
        })
      : null;
    if (target?.element) {
      return {
        element: target.element,
        usedParent: !boundsEqual(target.element.bounds, element.bounds),
      };
    }
    return { element, usedParent: false };
  }

  private executeOnDisplay(
    options: TapOnElementOptions,
    signal?: AbortSignal,
    recovery?: { throwOnKeyboardOcclusion?: boolean },
  ): Promise<TapOnElementResult | undefined> {
    return this.explicitDisplay.execute(options, signal, recovery);
  }

  /**
   * Execute a tap on text
   * @param options - Command options
   * @param progress - Optional progress callback
   * @returns Result of the command
   */
  async execute(options: TapOnElementOptions, call?: TapOnCall): Promise<TapOnFocusResult>;
  /** @deprecated Pass an {@link ActionCall} instead of positional arguments. */
  async execute(
    options: TapOnElementOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    recovery?: { throwOnKeyboardOcclusion?: boolean },
    request?: { requestDeadlineMs?: number },
  ): Promise<TapOnFocusResult>;
  async execute(
    options: TapOnElementOptions,
    progressOrCall?: ProgressCallback | TapOnCall,
    signalArg?: AbortSignal,
    recoveryArg?: { throwOnKeyboardOcclusion?: boolean },
    requestArg?: { requestDeadlineMs?: number },
  ): Promise<TapOnFocusResult> {
    const { progress, signal, recovery, deadlineMs } = resolveTapOnCall(
      progressOrCall,
      signalArg,
      recoveryArg,
      requestArg,
    );
    const request = deadlineRequest(deadlineMs);
    return withObservationReadScope(() =>
      this.executeWithReadScope(options, progress, signal, recovery, request),
    );
  }

  private async executeWithReadScope(
    options: TapOnElementOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    // Internal orchestration policy; never part of TapOnElementOptions or tool schemas.
    recovery?: { throwOnKeyboardOcclusion?: boolean },
    request?: { requestDeadlineMs?: number },
  ): Promise<TapOnFocusResult> {
    // Validate before display resolution/observation can issue any device command.
    this.assertLongPressWithinRequestBudget(options, request);
    if (options.display !== undefined) {
      const result = await this.executeOnDisplay(options, signal, recovery);
      if (result) {
        return result;
      }
    }
    if (!options.action) {
      return this.createErrorResult(options.action, "tap on action is required");
    }

    const requestedAction = options.action;

    if (options.ensureTap) {
      options = { ...options, preTapStability: true, retryIfNoChange: true };
    }

    const validationError = this.validateOptions(options);
    if (validationError) {
      return this.createErrorResult(options.action, validationError);
    }

    const perf = createGlobalPerformanceTracker();
    perf.serial("tapOnElement");
    let previousObserveResult: ObserveResult | null = null;
    let preTapHierarchy: ViewHierarchyResult | undefined;
    let selectionCapture: SelectionCaptureState | null = null;
    let searchUntilStats: SearchUntilStats | undefined;
    let focusTarget: Element | undefined;
    let focusLabelText: string | undefined;
    let ensureCheckedTapTimestamp: number | undefined;
    let completedDisplayGesture = false;
    let effectiveAction = requestedAction;

    try {
      throwIfAborted(signal);
      const result = await this.observedInteraction<TapOnFocusOutcome>(
        async (observeResult: ObserveResult, fence) => {
          previousObserveResult = observeResult;
          preTapHierarchy = observeResult.viewHierarchy;
          throwIfAborted(signal);

          let viewHierarchy = observeResult.viewHierarchy;
          if (!viewHierarchy) {
            perf.end();
            return { success: false, error: "Unable to get view hierarchy, cannot tap on element" };
          }

          // Resolve TalkBack selectors from a capture for this call, just as the
          // existing search/stability refreshes do. Cache age cannot detect an
          // external same-app BACK (#9785).
          const activationWarnings: string[] = [];
          let isAccessibilityServiceEnabled =
            this.device.platform === "android"
              ? await this.strategy.isAccessibilityServiceEnabled((warning) =>
                  activationWarnings.push(warning),
                )
              : undefined;
          if (this.device.platform === "android" && isAccessibilityServiceEnabled) {
            const freshHierarchy = await freshTapHierarchy(
              this.tapVerificationRefresh({
                screenSize: observeResult.screenSize,
                signal,
              }),
              this.timer,
              signal,
            );
            preTapHierarchy = freshHierarchy;
            this.replaceObservationHierarchy(observeResult, freshHierarchy, true);
            viewHierarchy = freshHierarchy;
          }

          if (options.accessibilityLink) {
            return this.activateAccessibilityLinkPhase(
              options,
              options.accessibilityLink,
              observeResult,
              viewHierarchy,
              activationWarnings,
              signal,
            );
          }

          let searchOutcome = await perf.track("findElement", () =>
            this.searchForElement(options, observeResult, signal),
          );
          // Search polling, ensureChecked, and opt-in stability already acquire a
          // current tree. Only a visible cache hit still needs revalidation.
          if (
            (this.device.platform === "android" || this.device.platform === "ios") &&
            !isAccessibilityServiceEnabled &&
            searchOutcome.selection.element &&
            !wasHierarchyReadDuringCall(viewHierarchy) &&
            searchOutcome.stats.requestCount === 0 &&
            options.ensureChecked === undefined &&
            !this.strategy.shouldRunPreTapStability(options) &&
            (this.device.platform !== "ios" ||
              !(isAccessibilityServiceEnabled ??=
                await this.strategy.isAccessibilityServiceEnabled()))
          ) {
            const freshHierarchy = await freshTapHierarchy(
              this.device.platform === "ios"
                ? (timeout) =>
                    this.refreshViewHierarchy(timeout, observeResult.screenSize, signal, true)
                : this.tapVerificationRefresh({ screenSize: observeResult.screenSize, signal }),
              this.timer,
              signal,
              {
                timeoutMs: Math.min(
                  DEFAULT_HIERARCHY_READ_TIMEOUT_MS,
                  request?.requestDeadlineMs === undefined
                    ? DEFAULT_HIERARCHY_READ_TIMEOUT_MS
                    : request.requestDeadlineMs - this.timer.now(),
                ),
                context: "while revalidating a cached observation",
                platform: this.device.platform,
              },
            );
            this.replaceObservationHierarchy(observeResult, freshHierarchy, true);
            // Discard cached coordinates and use the ordinary search-until loop
            // when the current screen is still transitioning.
            searchOutcome = await this.searchForElement(options, observeResult, signal);
          }
          searchUntilStats = searchOutcome.stats;
          this.replaceObservationHierarchy(
            observeResult,
            searchOutcome.viewHierarchy,
            searchOutcome.refreshedFromDevice,
          );
          viewHierarchy = searchOutcome.viewHierarchy;
          if (!searchOutcome.selection.element) {
            if (searchOutcome.visibilityError) {
              throw searchOutcome.visibilityError;
            }
            await this.handleElementNotFound(
              options,
              observeResult,
              searchOutcome.containerFound,
              signal,
              searchOutcome.selection,
            );
          }
          const liveSelection = await this.refreshEnsureCheckedSelection(
            options,
            observeResult,
            searchOutcome.selection,
            signal,
          );
          viewHierarchy = liveSelection.viewHierarchy;
          preTapHierarchy = viewHierarchy;
          const selection = liveSelection.selection;
          let finalSelection = selection;
          const element = selection.element as Element;
          let selectedElementMetadata = this.buildSelectedElementMetadata(selection);
          const ensureCheckedResult = this.ensureCheckedBeforeTap(
            options,
            element,
            selectedElementMetadata,
            searchOutcome.stats,
          );
          if (ensureCheckedResult) {
            perf.end();
            return ensureCheckedResult;
          }
          if (options.subtext) {
            return this.activateSubtextPhase({
              options,
              subtext: options.subtext,
              element,
              viewHierarchy,
              selectedElement: selectedElementMetadata,
              searchUntil: searchOutcome.stats,
              activationWarnings,
              signal,
            });
          }
          const initialTapPoint = this.geometry.getElementCenter(element);
          let action = options.action;
          const longPressDuration = this.getLongPressDuration(options);

          if (action === "focus") {
            if (!isFocusEditableElement(element)) {
              perf.end();
              return {
                success: false,
                action,
                element,
                selectedElement: selectedElementMetadata,
                searchUntil: searchOutcome.stats,
                error: `Cannot focus ${describeFocusTarget(element, options)} because it is not an editable input`,
              };
            }

            focusTarget = element;
            const matchedLabel = searchOutcome.selection.matchedElement;
            if (matchedLabel && matchedLabel !== element) {
              focusLabelText = matchedLabel.text;
            }

            // Check if element is already focused
            const isFocused = isElementKeyboardFocused(element);

            if (isFocused) {
              logger.info(`Element is already focused, no action needed`);
              perf.end();
              return withResolvedLayer(
                {
                  success: true,
                  action,
                  element: element,
                  selectedElement: selectedElementMetadata,
                  searchUntil: searchOutcome.stats,
                  wasAlreadyFocused: true,
                  focusChanged: false,
                  focusVerified: true,
                  x: initialTapPoint.x,
                  y: initialTapPoint.y,
                },
                resolvedElementLayer(viewHierarchy, element, this.device.platform),
              );
            }

            action = "tap";
            effectiveAction = "tap";
          }
          const tapOptions: TapOnElementOptions = { ...options, action }; // dispatch sees the performed action

          // Preserve iOS detection at the original activation boundary.
          isAccessibilityServiceEnabled ??= await this.strategy.isAccessibilityServiceEnabled(
            (warning) => activationWarnings.push(warning),
          );
          const requireResourceId = isAccessibilityServiceEnabled;
          let tapElement: Element;
          let usedParent: boolean;
          const initialTapTarget = this.resolveTapTargetElement(element, viewHierarchy, action, {
            requireResourceId,
            scoped: options.container !== undefined,
          });
          tapElement = initialTapTarget.element;
          usedParent = initialTapTarget.usedParent;

          if (this.strategy.shouldRunPreTapStability(options)) {
            const stable = await this.resolveAndroidStableTapTargetAfterRefreshes(
              options,
              observeResult,
              action,
              requireResourceId,
              signal,
            );
            if (!stable.ok) {
              perf.end();
              return { success: false, error: stable.error };
            }
            // The pre-tap stability resolver always returns a hierarchy it just
            // re-captured live from the device, so its freshness is realigned.
            this.replaceObservationHierarchy(observeResult, stable.viewHierarchy, true);
            // This observation now describes the refreshed capture used for the
            // tap, rather than the earlier hierarchy used to start resolution.
            if (stable.selection.captureId) {
              observeResult.observationId = stable.selection.captureId;
            }
            viewHierarchy = stable.viewHierarchy;
            preTapHierarchy = viewHierarchy;
            tapElement = stable.tapElement;
            finalSelection = stable.selection;
            usedParent = stable.usedParent;
            // Rebuild from the refreshed selection so the reported selectedElement
            // (bounds/indexInMatches/totalMatches) describes the node actually
            // tapped after re-resolution, not the stale pre-refresh match (#5888).
            // The decision lives in a pure seam so it can be unit-tested (#5897).
            selectedElementMetadata = this.rebuildSelectedElementMetadataAfterStability(
              selectedElementMetadata,
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
              focusTarget = stableElement;
              focusLabelText =
                stable.selection.matchedElement !== stableElement
                  ? stable.selection.matchedElement?.text
                  : undefined;
            }
            const ensureCheckedResult = this.ensureCheckedBeforeTap(
              options,
              stableElement,
              selectedElementMetadata,
              searchOutcome.stats,
            );
            if (ensureCheckedResult) {
              perf.end();
              return ensureCheckedResult;
            }
          }
          appendDisabledElementWarning(this.device.platform, tapElement, activationWarnings);
          this.logClickableParentSelection(usedParent);
          const { tapPoint, warning: tapPointWarning } = this.tapPoints.planVisibleTapPoint({
            options: tapOptions,
            requestedAction,
            observeResult,
            viewHierarchy,
            finalSelection,
            tapElement,
          });
          if (tapPointWarning) {
            activationWarnings.push(tapPointWarning);
          }
          const tapBounds = tapElement.bounds;
          logger.info(
            `[TapOnElement] Tapping (${tapPoint.x}, ${tapPoint.y}) on element: ` +
              `text=${JSON.stringify(tapElement.text ?? options.text)}, ` +
              `bounds=${JSON.stringify(tapBounds)}, ` +
              `clickable=${tapElement.clickable}, usedParent=${usedParent}`,
          );

          selectionCapture = await this.prepareSelectionCapture(
            action,
            observeResult,
            tapElement,
            signal,
          );

          const preTapHash = options.retryIfNoChange ? this.hashViewHierarchy(viewHierarchy) : null;
          let screenReaderNavigation: ScreenReaderNavigationResult | undefined;

          // Platform-specific tap execution. Everything that waits for the target (search,
          // pre-tap refresh) is behind us: the navigation graph measures from here (#10196).
          await perf.track("executeTap", async () => {
            reportToolDispatched();
            switch (this.device.platform) {
              case "android":
                screenReaderNavigation = await this.executeAndroidTap(
                  action,
                  tapPoint.x,
                  tapPoint.y,
                  longPressDuration,
                  tapElement,
                  signal,
                  {
                    ...tapOptions,
                    displayFence: fence,
                    resolvedHierarchy: viewHierarchy,
                    onResolvedElement: (current, selection, hierarchy) => {
                      tapElement = current;
                      finalSelection = selection ?? {
                        ...finalSelection,
                        element: current,
                        matchedElement: current,
                      };
                      if (hierarchy) {
                        viewHierarchy = hierarchy;
                        preTapHierarchy = hierarchy;
                        this.replaceObservationHierarchy(observeResult, hierarchy, true);
                      }
                      selectedElementMetadata = this.buildSelectedElementMetadata(finalSelection);
                      Object.assign(tapPoint, this.geometry.getElementCenter(current));
                    },
                    onActivationWarning: (warning) => activationWarnings.push(warning),
                  },
                  isAccessibilityServiceEnabled,
                );
                break;
              case "ios":
                await this.executeiOSTap(
                  action,
                  tapPoint.x,
                  tapPoint.y,
                  longPressDuration,
                  tapElement,
                  isAccessibilityServiceEnabled,
                  { displayFence: fence, signal },
                );
                break;
              default:
                throw unsupportedPlatformError(this.device.platform, "tap on elements");
            }
          });
          if (options.ensureChecked !== undefined) {
            ensureCheckedTapTimestamp = this.timer.now();
          }

          if (preTapHash && this.strategy.retryTapIfNoChange) {
            await this.retryTapIfNoChange(
              preTapHash,
              tapPoint,
              action,
              longPressDuration,
              tapElement,
              { ...this.withObservationScreenSize(tapOptions, observeResult), displayFence: fence },
              isAccessibilityServiceEnabled,
              observeResult.screenSize,
              signal,
              finalSelection,
            );
          }

          perf.end();
          return withResolvedLayer(
            {
              success: true,
              action,
              element: tapElement,
              selectedElement: selectedElementMetadata,
              searchUntil: searchOutcome.stats,
              ...(screenReaderNavigation ? { screenReaderNavigation } : {}),
              ...(activationWarnings.length ? { warnings: activationWarnings } : {}),
            },
            resolvedElementLayer(viewHierarchy, focusTarget ?? tapElement, this.device.platform),
          );
        },
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
            ? { observationHostTimestampProvider: () => ensureCheckedTapTimestamp }
            : {}),
          predictionContext: {
            toolName: "tapOn",
            toolArgs: this.predictionToolArgs(options),
          },
        },
      );

      completedDisplayGesture = didCompleteDisplayGesture(result, options.display);
      if (options.display !== undefined && result.staleDisplay) {
        // Legacy/iOS display gestures must not finalize optional post-state
        // metadata or confirm focus/checked state from an invalidated capture.
        return unverifiableDisplayPostState(result, options);
      }

      if (result.success && result.observation && result.element) {
        const postTap = await this.deriveTapEffectAfterPostTapObservation(
          previousObserveResult,
          result.observation,
          signal,
        );
        result.effect = postTap.effect;
        // The observation that established the effect must be returned and become
        // the caller's diff baseline, rather than the earlier source capture.
        result.observation = postTap.observation;
        await this.applyEnsureCheckedResult(result, options, signal);
        await this.captureTerminalObservationScreenshot(result.observation, perf, signal);
        await this.recordDeferredPredictionOutcome(result, result.observation);
        const selectedElements = await this.selectionStateTracker.finalize({
          action: effectiveAction,
          selectionState: selectionCapture,
          currentObservation: result.observation,
          previousObservation: previousObserveResult,
          element: result.element,
          effect: postTap.effect,
          signal,
        });
        if (selectedElements.length > 0) {
          result.observation.selectedElements = selectedElements;
        }
        this.enforceFreshnessConsistencyWithEffect(previousObserveResult, result);
      }

      await this.confirmFocusAfterTap({
        result,
        options,
        requestedAction,
        focusTarget,
        focusLabelText,
        preTapHierarchy,
        signal,
      });

      if (effectiveAction === "longPress") {
        const metadata = this.detectLongPressMetadata(previousObserveResult, result.observation);
        return {
          ...result,
          ...metadata,
        };
      }
      return result;
    } catch (error) {
      perf.end();

      // Only opted-in Android form orchestration receives the typed recovery signal.
      rethrowKeyboardOcclusion(this.device.platform, error, requestedAction, recovery);
      logger.warn(`Tap on element failed: ${errorMessage(error)}`, error);
      const failure = completedDisplayFailure(error, completedDisplayGesture);
      if (failure instanceof StaleDisplayError || failure instanceof DispatchedObservationError) {
        return withStaleDisplay(this.createErrorResult(effectiveAction, failure.message), failure);
      }

      // Build debug context if debug mode is enabled
      const debugContext = await buildElementSearchDebugContext(this.device, {
        text: options.text,
        resourceId: options.elementId,
        container: options.container,
      });

      // Return error result with debug info instead of throwing
      return this.readScopeFailureResult(
        requestedAction,
        effectiveAction,
        error,
        searchUntilStats,
        debugContext,
      );
    }
  }

  private async activateAccessibilityLinkPhase(
    options: TapOnElementOptions,
    linkText: string,
    observeResult: ObserveResult,
    viewHierarchy: ViewHierarchyResult,
    activationWarnings: string[],
    signal?: AbortSignal,
  ): Promise<TapOnFocusOutcome | ObservedActionResult> {
    const occurrence = options.index ?? 0;
    const owner = this.resolveContainerElement(
      viewHierarchy,
      this.withObservationScreenSize(options, observeResult),
    );
    if (options.container && !owner) {
      return { success: false, error: "Semantic link container is no longer present" };
    }
    const activation = await this.semanticLink.activateSemanticLink(
      linkText,
      occurrence,
      owner,
      viewHierarchy,
      signal,
    );
    if (!activation.success) {
      return { success: false, error: activation.error };
    }
    return {
      success: true,
      action: options.action,
      element: {
        text: linkText,
        bounds: { left: 0, top: 0, right: 0, bottom: 0 },
      } as Element,
      activatedSubtext: { text: linkText, occurrence },
      ...warningsField(withActivationWarning(activationWarnings, activation.warning)),
    };
  }

  private async activateSubtextPhase({
    options,
    subtext,
    element,
    viewHierarchy,
    selectedElement,
    searchUntil,
    activationWarnings,
    signal,
  }: {
    options: TapOnElementOptions;
    subtext: NonNullable<TapOnElementOptions["subtext"]>;
    element: Element;
    viewHierarchy: ViewHierarchyResult;
    selectedElement: TapOnFocusResult["selectedElement"];
    searchUntil: SearchUntilStats;
    activationWarnings: string[];
    signal?: AbortSignal;
  }): Promise<TapOnFocusOutcome | ObservedActionResult> {
    const occurrence = subtext.occurrence ?? 0;
    const activation = await this.semanticLink.activateSemanticLink(
      subtext.text,
      occurrence,
      element,
      viewHierarchy,
      signal,
    );
    if (!activation.success) {
      return { success: false, error: activation.error };
    }
    return {
      success: true,
      action: options.action,
      element,
      selectedElement,
      searchUntil,
      activatedSubtext: { text: subtext.text, occurrence },
      ...warningsField(withActivationWarning(activationWarnings, activation.warning)),
    };
  }

  /** Mark a focus-requested tap as failed unless the focused field matches the target (mutates `result`). */
  private async confirmFocusAfterTap({
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
    result.focusVerified = await this.verifyFocusAfterTap(
      result,
      (observation) =>
        this.verifyFocusedInputTarget(
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

  private assertLongPressWithinRequestBudget(
    options: TapOnElementOptions,
    request?: { requestDeadlineMs?: number },
  ): void {
    if (options.action === "longPress") {
      assertLongPressFitsRequestBudget(
        this.getLongPressDuration(options),
        request?.requestDeadlineMs === undefined
          ? undefined
          : request.requestDeadlineMs - this.timer.now(),
      );
    }
  }

  private predictionToolArgs(options: TapOnElementOptions) {
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
      platform: this.device.platform,
    };
  }

  private readScopeFailureResult(
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
   * Execute Android-specific tap operations
   * @param action - The tap action to perform
   * @param x - X coordinate
   * @param y - Y coordinate
   * @param durationMs - Long press duration in milliseconds
   * @param element - Target element
   * @param signal - Abort signal
   * @param options - Tap options (for focusFirst parameter)
   */
  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  // oxlint-disable-next-line max-params -- Preserve positional callers by appending the optional display fence.
  async executeAndroidTap(
    action: string,
    x: number,
    y: number,
    durationMs: number,
    element: Element,
    signal?: AbortSignal,
    options?: TapOnElementOptions &
      ResolvedAndroidTapOptions & { onActivationWarning?: (warning: string) => void },
    isTalkBackEnabled?: boolean,
  ): Promise<ScreenReaderNavigationResult | undefined> {
    const { displayFence: fence, resolvedHierarchy, onActivationWarning } = options ?? {};
    // Check if TalkBack is enabled (not just any accessibility service)
    const talkBackEnabled =
      typeof isTalkBackEnabled === "boolean"
        ? isTalkBackEnabled
        : await this.strategy.isAccessibilityServiceEnabled(options?.onActivationWarning);

    // XML-only candidates have no CtrlProxy node identity, even if their resource
    // ID also exists in the incomplete native tree. Never retarget semantic actions.
    if (element["hierarchy-source"] === "uiautomator") {
      await this.executeAndroidTapWithCoordinates(action, x, y, durationMs, element, signal, true, {
        displayFence: fence,
        onActivationWarning,
      });
      return undefined;
    }

    if (isStrictlyScoped(options)) {
      await this.androidDispatch.executeScopedAndroidTap({
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
      return this.executeAndroidTapWithAccessibility(
        action,
        x,
        y,
        element,
        durationMs,
        options,
        signal,
      );
    }

    await this.executeAndroidTapWithCoordinates(action, x, y, durationMs, element, signal, false, {
      displayFence: fence,
      resolvedHierarchy,
      onActivationWarning,
    });
    return undefined;
  }

  private executeAndroidTapWithCoordinates(
    ...args: Parameters<TapAndroidDispatchPhase["executeAndroidTapWithCoordinates"]>
  ): Promise<void> {
    return this.androidDispatch.executeAndroidTapWithCoordinates(...args);
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  retryTapIfNoChange(...args: Parameters<TapRetryPhase["retryTapIfNoChange"]>): Promise<void> {
    return this.retry.retryTapIfNoChange(...args);
  }

  /**
   * Execute tap using CtrlProxy actions (TalkBack mode).
   *
   * Default (#3936): directly activate the target via ACTION_CLICK — deterministic,
   * no cursor stepping — then fall back to a coordinate gesture, then ADB.
   * When `options.screenReaderNavigation` is set (opt-in fidelity mode, #3937),
   * move the TalkBack cursor onto the target with ACTION_ACCESSIBILITY_FOCUS (never a swipe, #10209)
   * before activating.
   * For longPress, tries ACTION_LONG_CLICK first, then coordinate gesture, then ADB.
   */
  /**
   * Whether opt-in screen-reader navigation (cursor-traversal fidelity mode,
   * #3937) is requested. Enabled by the `screen-reader-navigation` feature flag
   * (the global opt-in) OR the per-call `screenReaderNavigation` option. Default
   * stays direct-activation (#3936).
   */
  private isScreenReaderNavigationEnabled(options?: TapOnElementOptions): boolean {
    return (
      Boolean(options?.screenReaderNavigation) ||
      this.featureFlags.isEnabled("screen-reader-navigation")
    );
  }

  /** Report acknowledgement or a completed fallback without claiming semantic activation. */
  private reportTalkBackActivationWarning(
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

  private talkBackTargetContext(
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
            const selection = this.finder.selectElementInHierarchy(
              options,
              scopeHierarchyForSelector(hierarchy, options.layer),
            ).selection;
            resolvedSelection = selection;
            resolvedHierarchy = hierarchy;
            return selection.element
              ? this.resolveTapTargetElement(selection.element, hierarchy, action, {
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

  private async executeAndroidTapWithAccessibility(
    action: string,
    x: number,
    y: number,
    element: Element,
    durationMs: number,
    options?: TapOnElementOptions &
      ResolvedAndroidTapOptions & { onActivationWarning?: (warning: string) => void },
    signal?: AbortSignal,
  ): Promise<ScreenReaderNavigationResult | undefined> {
    const fence = this.readOptionalDisplayFence(options);
    const driver = this.talkBackDriverFactory.createDriver(this.device);
    let screenReaderNavigation: ScreenReaderNavigationResult | undefined;
    const targetContext = this.talkBackTargetContext(
      options,
      action,
      (current, selection, hierarchy) => {
        element = current;
        const center = this.geometry.getElementCenter(current);
        x = center.x;
        y = center.y;
        options?.onResolvedElement?.(current, selection, hierarchy);
      },
    );

    if (action === "longPress") {
      // Long press: try ACTION_LONG_CLICK first, then coordinate gesture fallback
      const longPressResult = await this.talkBackStrategy.executeLongPress(
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
        await this.executeAndroidTapWithCoordinates(
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
    if (this.isScreenReaderNavigationEnabled(options)) {
      // Opt-in fidelity mode (#3937): move the TalkBack cursor onto the target with
      // ACTION_ACCESSIBILITY_FOCUS, then activate. A failure after the focus request was sent
      // throws; only a failure before anything was dispatched returns here and may fall back.
      const result = await this.talkBackStrategy.executeTap(
        this.device.deviceId,
        element,
        driver,
        fence,
        signal,
      );

      if (result.success) {
        // A focus-navigation gesture is acknowledged, not confirmed as an activation.
        this.reportTalkBackActivationWarning(result, options, action);
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
      const result = await this.talkBackStrategy.executeDirectActivation(
        element,
        driver,
        targetContext,
      );

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
      await this.executeAndroidTapWithCoordinates(
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
        ? await this.talkBackStrategy.executePreciseTap(x, y, driver, fence)
        : await this.talkBackStrategy.executeCoordinateFallback(
            x,
            y,
            fallbackAction,
            durationMs,
            driver,
            { displayFence: fence },
          );

    if (!fallbackResult.success) {
      logger.warn(
        `[TapOnElement] Accessibility coordinate tap failed (${fallbackResult.error}), ` +
          `falling back to ADB tap at (${x}, ${y})`,
      );
      await this.executeAndroidTapWithCoordinates(
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
    this.reportTalkBackActivationWarning(fallbackResult, options, action);
    return screenReaderNavigation;
  }

  private executeiOSTap(...args: Parameters<TapIosDispatchPhase["executeiOSTap"]>): Promise<void> {
    return this.iosDispatch.executeiOSTap(...args);
  }

  private executeiOSTapWithCoordinates(
    ...args: Parameters<TapIosDispatchPhase["executeiOSTapWithCoordinates"]>
  ): Promise<void> {
    return this.iosDispatch.executeiOSTapWithCoordinates(...args);
  }

  private executeIOSTapWithVoiceOver(
    ...args: Parameters<TapIosDispatchPhase["executeIOSTapWithVoiceOver"]>
  ): Promise<void> {
    return this.iosDispatch.executeIOSTapWithVoiceOver(...args);
  }

  private readOptionalDisplayFence(options?: DisplayFenceOption): DisplayFence | undefined {
    return options?.displayFence;
  }

  private getLongPressDuration(options: TapOnElementOptions): number {
    assertLongPressWithinHardMax(options.duration);
    if (typeof options.duration === "number" && options.duration > 0) {
      return options.duration;
    }
    return this.strategy.longPressDurationMs;
  }

  executeAndroidLongPress(
    ...args: Parameters<TapAndroidLongPressPhase["executeAndroidLongPress"]>
  ): Promise<void> {
    return this.androidLongPress.executeAndroidLongPress(...args);
  }

  private detectLongPressMetadata(
    previousObservation: ObserveResult | null,
    currentObservation?: ObserveResult,
  ): LongPressMetadata {
    return this.longPressMetadataDetector.detect(previousObservation, currentObservation);
  }
}
