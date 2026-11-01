import { androidCtrlProxyClientForPlatform } from "../observe/android/androidCtrlProxyClientFor";
import { unsupportedPlatformError } from "../../models/ActionableError";
import { TapDisplayRouter } from "./TapDisplayRouter";
import { TapExecution } from "./TapExecution";
import { tapFocusFailure, tapResolvedLayer, type TapOnFocusResult } from "./tapFocusResult";
import type { TapOnTalkBackStrategy } from "./TapGestureDispatcher";
import { TapGestureDispatcher } from "./TapGestureDispatcher";
import { TapSemanticLinks } from "./TapSemanticLinks";
import { TapTargetResolver } from "./TapTargetResolver";
import { type TapFocusFailure } from "./tapTargetSupport";
import { TapElementFinder } from "./tapElementFinder";
import { TapPointPlanner, type PrototypeTapAgentConnections } from "./tapPointPlanner";
import { prototypeAgentRegistry } from "../prototype/ios/prototypeAgentInjection";
import { prototypeViewerConnections } from "../prototype/ios/prototypeViewerAttach";
import { FocusVerifier } from "./tapFocusVerifier";
import { PostTapSettler } from "./tapPostTapSettler";
import { withObservationReadScope } from "../observe/observationReadScope";
import { ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS } from "./freshTapHierarchy";
import { type DisplayFenceDependencies } from "./BaseVisualChange";
import { DefaultHierarchyCapture, type HierarchyCapture } from "../observe/HierarchyCapture";
import {
  displayTransitions,
  type DisplayTransitionReader,
  type DisplayTransitionTracker,
} from "../observe/DisplayTransition";
import { BaseVisualChange } from "./BaseVisualChange";
import {
  ActionableError,
  BootedDevice,
  ObserveResult,
  requireAndroidOrIosPlatform,
} from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { DefaultElementParser } from "../utility/ElementParser";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import {
  DEFAULT_VISION_CONFIG,
  type VisionAnalyzer,
  type VisionFallbackConfig,
} from "../../vision/index";
import { AccessibilityDetector } from "../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import { type Timer } from "../../utils/SystemTimer";
import {
  SelectionStateTracker,
  TakeScreenshotCapturer,
  type ScreenshotCapturer,
} from "../navigation/SelectionStateTracker";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { TapEnsureCheckedPhase } from "./tapEnsureCheckedPhase";
import { TapPostTapEffectPhase } from "./tapPostTapEffectPhase";
import type { TalkBackNavigationDriverFactory } from "../talkback/TalkBackNavigationDriver";
import type { TapStrategy } from "../../utils/interfaces/TapStrategy";
import type { IosVoiceOverDetector } from "../accessibility/interfaces/IosVoiceOverDetector";
import type { FeatureFlagReader } from "../featureFlags/FeatureFlagService";
import type { WaitForCondition } from "../observe/interfaces/WaitForCondition";
import { RealWaitForCondition } from "../observe/WaitForCondition";
import { LongPressMetadataDetector } from "./LongPressMetadataDetector";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";
import { accessibilityDetector as defaultAccessibilityDetector } from "../../ctrlProxy/accessibility/AccessibilityDetector";
import { resolveTapAccessibilityDependencies } from "./tapAccessibilityDependencies";
import { createDeviceHierarchyCapture } from "../observe/DeviceHierarchyCapture";
import { type RenderedObservationReader } from "./TargetDisplayAction";
import type { TapOnCall } from "./ActionCall";
import { tapPlatformTraits, type TapPlatformTraits } from "./strategies/tapPlatformTraits";

/**
 * Dependencies for TapOnElement that can be injected for testing.
 */
export interface TapOnElementDependencies extends DisplayFenceDependencies {
  prototypeAgents?: PrototypeTapAgentConnections;
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
  talkBackStrategy?: TapOnTalkBackStrategy;
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

export { tapFocusFailure, tapResolvedLayer, type TapFocusFailure, type TapOnFocusResult };

export class TapOnElement extends BaseVisualChange implements TapPreTapStabilitySeam {
  private readonly semanticLinks = new TapSemanticLinks({
    usesAndroidLinkActivation: () => this.platformTraits.androidLinkActivation,
    usesIosLinkActivation: () => this.platformTraits.iosLinkActivation,
    usesCapturedOwnerIdentity: () => this.platformTraits.capturedOwnerIdentity,
    accessibilityService: () => this.accessibilityService,
    activateSemanticLink: (...args) => this.activateSemanticLink(...args),
    device: () => this.device,
    elementParser: () => this.elementParser,
    hasUniqueSemanticLinkOwner: (...args) => this.hasUniqueSemanticLinkOwner(...args),
    resolveContainerElement: (...args) => this.resolveContainerElement(...args),
    withObservationScreenSize: (...args) => this.withObservationScreenSize(...args),
  });
  private readonly targets = new TapTargetResolver({
    accessibilityService: () => this.accessibilityService,
    adb: () => this.adb,
    buildSelectedElementMetadata: (...args) => this.buildSelectedElementMetadata(...args),
    deriveInteractionEffect: (...args) => this.deriveInteractionEffect(...args),
    device: () => this.device,
    displayTransitionReader: () => this.displayTransitionReader,
    elementParser: () => this.elementParser,
    ensureChecked: () => this.ensureChecked,
    findElementInHierarchy: (...args) => this.findElementInHierarchy(...args),
    finder: () => this.finder,
    focusVerifier: () => this.focusVerifier,
    geometry: () => this.geometry,
    getScreenSizeFromHierarchy: (...args) => this.getScreenSizeFromHierarchy(...args),
    getSearchUntilDuration: (...args) => this.getSearchUntilDuration(...args),
    hashViewHierarchy: (...args) => this.hashViewHierarchy(...args),
    hierarchyCapture: () => this.hierarchyCapture,
    invisibleMatchFailure: (...args) => this.invisibleMatchFailure(...args),
    isClickableElement: (...args) => this.isClickableElement(...args),
    isElementTapTargetOffScreen: (...args) => this.isElementTapTargetOffScreen(...args),
    isLongClickableElement: (...args) => this.isLongClickableElement(...args),
    postTapEffect: () => this.postTapEffect,
    refreshViewHierarchy: (...args) => this.refreshViewHierarchy(...args),
    refreshedDisplayTransitions: () => this.refreshedDisplayTransitions,
    renderedDisplayGeneration: () => this.renderedDisplayGeneration,
    replaceObservationHierarchy: (...args) => this.replaceObservationHierarchy(...args),
    resolveTapTargetElement: (...args) => this.resolveTapTargetElement(...args),
    screenshotCapturer: () => this.screenshotCapturer,
    selectionStateTracker: () => this.selectionStateTracker,
    staleDisplay: (...args) => this.staleDisplay(...args),
    staleSyntheticTarget: (...args) => this.staleSyntheticTarget(...args),
    strategy: () => this.strategy,
    tapPoints: () => this.tapPoints,
    tapVerificationRefresh: (...args) => this.tapVerificationRefresh(...args),
    timer: () => this.timer,
    viewHierarchy: () => this.viewHierarchy,
    visionAnalyzer: () => this.visionAnalyzer,
    visionConfig: () => this.visionConfig,
    withObservationScreenSize: (...args) => this.withObservationScreenSize(...args),
  });
  private readonly displayRouter = new TapDisplayRouter({
    routesAndroidDisplay: () => this.platformTraits.routesAndroidDisplay,
    accessibilityService: () => this.accessibilityService,
    adb: () => this.adb,
    applyEnsureCheckedResult: (...args) => this.applyEnsureCheckedResult(...args),
    buildSelectedElementMetadata: (...args) => this.buildSelectedElementMetadata(...args),
    checkPostActionDisplay: (...args) => this.checkPostActionDisplay(...args),
    completedDisplayFailure: (...args) => this.completedDisplayFailure(...args),
    createErrorResult: (...args) => this.createErrorResult(...args),
    device: () => this.device,
    displayTransitionReader: () => this.displayTransitionReader,
    ensureCheckedBeforeTap: (...args) => this.ensureCheckedBeforeTap(...args),
    findElementInHierarchy: (...args) => this.findElementInHierarchy(...args),
    geometry: () => this.geometry,
    getSearchUntilDuration: (...args) => this.getSearchUntilDuration(...args),
    handleElementNotFound: (...args) => this.handleElementNotFound(...args),
    hashViewHierarchy: (...args) => this.hashViewHierarchy(...args),
    hierarchyCapture: () => this.hierarchyCapture,
    lastRenderedObservation: () => this.lastRenderedObservation,
    observeScreen: () => this.observeScreen,
    observedInteraction: (...args) => this.observedInteraction(...args),
    refreshEnsureCheckedSelection: (...args) => this.refreshEnsureCheckedSelection(...args),
    replaceObservationHierarchy: (...args) => this.replaceObservationHierarchy(...args),
    resolveAndroidStableTapTargetAfterRefreshes: (...args) =>
      this.resolveAndroidStableTapTargetAfterRefreshes(...args),
    resolveVisibleTapPoint: (...args) => this.resolveVisibleTapPoint(...args),
    rethrowKeyboardOcclusion: (...args) => this.rethrowKeyboardOcclusion(...args),
    rethrowObservationAbort: (...args) => this.rethrowObservationAbort(...args),
    retryTapIfNoChange: (...args) => this.retryTapIfNoChange(...args),
    searchForElement: (...args) => this.searchForElement(...args),
    staleDisplay: (...args) => this.staleDisplay(...args),
    strategy: () => this.strategy,
    talkBackDriverFactory: () => this.talkBackDriverFactory,
    talkBackStrategy: () => this.talkBackStrategy,
    tapPoints: () => this.tapPoints,
    timer: () => this.timer,
    unverifiableDisplayPostState: (...args) => this.unverifiableDisplayPostState(...args),
    validateOptions: (...args) => this.validateOptions(...args),
    verifyFocusedInputTarget: (...args) => this.verifyFocusedInputTarget(...args),
    visibleTapBounds: (...args) => this.visibleTapBounds(...args),
    withObservationScreenSize: (...args) => this.withObservationScreenSize(...args),
  });
  private readonly execution = new TapExecution({
    runPlatformTap: async (dispatch) => {
      const ladder = this.platformTraits.tapDispatch;
      if (ladder === undefined) {
        throw unsupportedPlatformError(this.device.platform, "tap on elements");
      }
      return dispatch[ladder]();
    },
    detectsAccessibilityBeforeSearch: () => this.platformTraits.detectsAccessibilityBeforeSearch,
    refreshesAccessibilityHierarchyBeforeSearch: () =>
      this.platformTraits.refreshesAccessibilityHierarchyBeforeSearch,
    revalidatesCachedTargets: () => this.platformTraits.revalidatesCachedTargets,
    canReuseAccessibilityState: () => this.platformTraits.canReuseAccessibilityState,
    requiresFreshExtractionForCachedTarget: () =>
      this.platformTraits.requiresFreshExtractionForCachedTarget,
    activateAccessibilityLinkPhase: (...args) => this.activateAccessibilityLinkPhase(...args),
    activateSubtextPhase: (...args) => this.activateSubtextPhase(...args),
    applyEnsureCheckedResult: (...args) => this.applyEnsureCheckedResult(...args),
    assertLongPressWithinRequestBudget: (...args) =>
      this.assertLongPressWithinRequestBudget(...args),
    buildSelectedElementMetadata: (...args) => this.buildSelectedElementMetadata(...args),
    captureTerminalObservationScreenshot: (...args) =>
      this.captureTerminalObservationScreenshot(...args),
    completedDisplayFailure: (...args) => this.completedDisplayFailure(...args),
    confirmFocusAfterTap: (...args) => this.confirmFocusAfterTap(...args),
    createErrorResult: (...args) => this.createErrorResult(...args),
    deriveTapEffectAfterPostTapObservation: (...args) =>
      this.deriveTapEffectAfterPostTapObservation(...args),
    detectLongPressMetadata: (...args) => this.detectLongPressMetadata(...args),
    device: () => this.device,
    didCompleteDisplayGesture: (...args) => this.didCompleteDisplayGesture(...args),
    enforceFreshnessConsistencyWithEffect: (...args) =>
      this.enforceFreshnessConsistencyWithEffect(...args),
    ensureCheckedBeforeTap: (...args) => this.ensureCheckedBeforeTap(...args),
    executeAndroidTap: (...args) => this.executeAndroidTap(...args),
    executeOnDisplay: (...args) => this.executeOnDisplay(...args),
    executeiOSTap: (...args) => this.executeiOSTap(...args),
    geometry: () => this.geometry,
    getLongPressDuration: (...args) => this.getLongPressDuration(...args),
    handleElementNotFound: (...args) => this.handleElementNotFound(...args),
    hashViewHierarchy: (...args) => this.hashViewHierarchy(...args),
    logClickableParentSelection: (...args) => this.logClickableParentSelection(...args),
    longPressMetadataDetector: () => this.longPressMetadataDetector,
    observedInteraction: (...args) => this.observedInteraction(...args),
    predictionToolArgs: (...args) => this.predictionToolArgs(...args),
    prepareSelectionCapture: (...args) => this.prepareSelectionCapture(...args),
    readScopeFailureResult: (...args) => this.readScopeFailureResult(...args),
    rebuildSelectedElementMetadataAfterStability: (...args) =>
      this.rebuildSelectedElementMetadataAfterStability(...args),
    recordDeferredPredictionOutcome: (...args) => this.recordDeferredPredictionOutcome(...args),
    refreshEnsureCheckedSelection: (...args) => this.refreshEnsureCheckedSelection(...args),
    refreshViewHierarchy: (...args) => this.refreshViewHierarchy(...args),
    replaceObservationHierarchy: (...args) => this.replaceObservationHierarchy(...args),
    resolveAndroidStableTapTargetAfterRefreshes: (...args) =>
      this.resolveAndroidStableTapTargetAfterRefreshes(...args),
    resolveTapTargetElement: (...args) => this.resolveTapTargetElement(...args),
    rethrowKeyboardOcclusion: (...args) => this.rethrowKeyboardOcclusion(...args),
    retryTapIfNoChange: (...args) => this.retryTapIfNoChange(...args),
    searchForElement: (...args) => this.searchForElement(...args),
    selectionStateTracker: () => this.selectionStateTracker,
    strategy: () => this.strategy,
    tapPoints: () => this.tapPoints,
    tapVerificationRefresh: (...args) => this.tapVerificationRefresh(...args),
    timer: () => this.timer,
    unverifiableDisplayPostState: (...args) => this.unverifiableDisplayPostState(...args),
    validateOptions: (...args) => this.validateOptions(...args),
    verifyFocusAfterTap: (...args) => this.verifyFocusAfterTap(...args),
    verifyFocusedInputTarget: (...args) => this.verifyFocusedInputTarget(...args),
    withObservationScreenSize: (...args) => this.withObservationScreenSize(...args),
  });
  private readonly gestureDispatcher = new TapGestureDispatcher({
    accessibilityService: () => this.accessibilityService,
    adb: () => this.adb,
    device: () => this.device,
    dispatchCoordinateTapOrAdbFallback: (...args) =>
      this.dispatchCoordinateTapOrAdbFallback(...args),
    executeAndroidLongPress: (...args) => this.executeAndroidLongPress(...args),
    executeAndroidTap: (...args) => this.executeAndroidTap(...args),
    executeAndroidTapWithAccessibility: (...args) =>
      this.executeAndroidTapWithAccessibility(...args),
    executeAndroidTapWithCoordinates: (...args) => this.executeAndroidTapWithCoordinates(...args),
    executeIOSTapWithVoiceOver: (...args) => this.executeIOSTapWithVoiceOver(...args),
    executeScopedAndroidTap: (...args) => this.executeScopedAndroidTap(...args),
    executeiOSTapWithCoordinates: (...args) => this.executeiOSTapWithCoordinates(...args),
    featureFlags: () => this.featureFlags,
    findElementInHierarchy: (...args) => this.findElementInHierarchy(...args),
    finder: () => this.finder,
    geometry: () => this.geometry,
    getScreenSizeFromHierarchy: (...args) => this.getScreenSizeFromHierarchy(...args),
    hashViewHierarchy: (...args) => this.hashViewHierarchy(...args),
    isScreenReaderNavigationEnabled: (...args) => this.isScreenReaderNavigationEnabled(...args),
    readOptionalDisplayFence: (...args) => this.readOptionalDisplayFence(...args),
    refreshedRetrySelection: (...args) => this.refreshedRetrySelection(...args),
    reportTalkBackActivationWarning: (...args) => this.reportTalkBackActivationWarning(...args),
    resolveEnsureCheckedRetryTarget: (...args) => this.resolveEnsureCheckedRetryTarget(...args),
    resolveRefreshedRetryTarget: (...args) => this.resolveRefreshedRetryTarget(...args),
    resolveTapTargetElement: (...args) => this.resolveTapTargetElement(...args),
    resolveVisibleTapPoint: (...args) => this.resolveVisibleTapPoint(...args),
    semanticAndroidLongPressTargetError: (...args) =>
      this.semanticAndroidLongPressTargetError(...args),
    strategy: () => this.strategy,
    talkBackDriverFactory: () => this.talkBackDriverFactory,
    talkBackStrategy: () => this.talkBackStrategy,
    talkBackTargetContext: (...args) => this.talkBackTargetContext(...args),
    tapVerificationRefresh: (...args) => this.tapVerificationRefresh(...args),
    timer: () => this.timer,
    tryDocumentsUiRowActivation: (...args) => this.tryDocumentsUiRowActivation(...args),
    trySemanticAndroidLongPress: (...args) => this.trySemanticAndroidLongPress(...args),
    visibleTapBounds: (...args) => this.visibleTapBounds(...args),
    withRetryScreenSize: (...args) => this.withRetryScreenSize(...args),
  });
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
    prototypeAgents: { get: (deviceId, bundleId) => this.prototypeAgents.get(deviceId, bundleId) },
  });
  private readonly prototypeAgents: PrototypeTapAgentConnections;
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
    applyRefreshedObservationRotation: (observation, rotation) =>
      this.strategy.applyRefreshedObservationRotation(observation, rotation),
    settlesPostTapChange: () => this.strategy.settlesPostTapChange,
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
  private geometry: ElementGeometry;
  private elementParser: ElementParser;
  private accessibilityService: import("./tapHierarchyRead").TapOnCtrlProxy;
  private visionConfig: VisionFallbackConfig;
  private screenshotCapturer: ScreenshotCapturer;
  private visionAnalyzer: VisionAnalyzer | undefined;
  private selectionStateTracker: Pick<SelectionStateTracker, "prepare" | "finalize">;
  private accessibilityDetector: AccessibilityDetector;
  private elementSelector: ElementSelector;
  private viewHierarchy: ViewHierarchy;
  private hierarchyCapture: HierarchyCapture;
  private talkBackStrategy: TapOnTalkBackStrategy;
  private readonly featureFlags: FeatureFlagReader;
  private talkBackDriverFactory: TalkBackNavigationDriverFactory;
  private iosVoiceOverDetector: IosVoiceOverDetector;
  private strategy: TapStrategy;
  private longPressMetadataDetector: LongPressMetadataDetector;
  private readonly waitForCondition: WaitForCondition;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    options: TapOnElementDependencies = {},
  ) {
    super(device, {
      adb,
      timer: options.timer,
      displayFence: options,
    });
    this.refreshedDisplayTransitions = options.displayTransitions ?? displayTransitions;
    this.lastRenderedObservation = options.lastRenderedObservation;
    this.prototypeAgents = options.prototypeAgents ?? {
      get: (deviceId, bundleId) =>
        prototypeViewerConnections.get(deviceId, bundleId) ??
        prototypeAgentRegistry.getRecord(deviceId, bundleId)?.client,
    };
    this.waitForCondition =
      options.waitForCondition ?? new RealWaitForCondition(this.observeScreen, this.timer);
    this.geometry = new DefaultElementGeometry();
    this.elementParser = new DefaultElementParser();
    this.accessibilityService = androidCtrlProxyClientForPlatform(device, this.adbFactory);
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
    this.elementSelector = this.createElementSelector(options);
    const accessibility = resolveTapAccessibilityDependencies(options, {
      device,
      adbFactory: this.adbFactory,
      adb: this.adb,
      timer: this.timer,
      accessibilityDetector: this.accessibilityDetector,
    });
    this.talkBackDriverFactory = accessibility.talkBackDriverFactory;
    this.talkBackStrategy = accessibility.talkBackStrategy;
    this.iosVoiceOverDetector = accessibility.iosVoiceOverDetector;
    this.featureFlags = accessibility.featureFlags;
    this.strategy = accessibility.strategy;
    this.longPressMetadataDetector = new LongPressMetadataDetector(this.elementParser);
  }

  /** Platform facts for the bound device; read per call because `device` can be rebound. */
  private get platformTraits(): TapPlatformTraits {
    return tapPlatformTraits(this.device.platform);
  }

  private createElementSelector(options: TapOnElementDependencies): ElementSelector {
    return (
      options.elementSelector ??
      new ResolverElementSelector(undefined, undefined, {
        platform: requireAndroidOrIosPlatform(this.device.platform, "tapOn"),
        iosMultiPanel:
          this.platformTraits.panelAwareSelection && (this.device.displays?.panels.length ?? 0) > 1,
      })
    );
  }

  /** @internal Typed view of private seams for unit tests; not part of the public API. */
  get testHooks() {
    return {
      validateOptions: this.validateOptions.bind(this),
      hasUniqueSemanticLinkOwner: this.hasUniqueSemanticLinkOwner.bind(this),
      hashViewHierarchy: this.hashViewHierarchy.bind(this),
      replaceObservationHierarchy: this.replaceObservationHierarchy.bind(this),
      verifyFocusedInputTarget: this.verifyFocusedInputTarget.bind(this),
      handleElementNotFound: this.handleElementNotFound.bind(this),
      executeAndroidLongPress: this.executeAndroidLongPress.bind(this),
      executeiOSTap: this.executeiOSTap.bind(this),
      executeiOSTapWithCoordinates: this.executeiOSTapWithCoordinates.bind(this),
      executeIOSTapWithVoiceOver: this.executeIOSTapWithVoiceOver.bind(this),
      /** Replaces option validation, e.g. to capture the normalized options and abort. */
      setValidateOptions: (validate: (options: TapOnElementOptions) => string | null): void => {
        this.validateOptions = validate;
      },
      /** Replaces the iOS coordinate-tap transport so the VoiceOver fallback is observable. */
      setIosCoordinateTap: (tap: TapGestureDispatcher["executeiOSTapWithCoordinates"]): void => {
        this.executeiOSTapWithCoordinates = tap;
      },
      /** Replaces the terminal-screenshot capture performed after effect polling. */
      setTerminalScreenshotCapture: (
        capture: (observation: ObserveResult | undefined) => Promise<void>,
      ): void => {
        this.captureTerminalObservationScreenshot = capture;
      },
      /** Replaces the deferred prediction-outcome recorder. */
      setDeferredPredictionRecorder: (
        record: (result: unknown, finalObservation: ObserveResult) => Promise<void>,
      ): void => {
        this.recordDeferredPredictionOutcome = record;
      },
    };
  }

  /**
   * Create an error result with consistent structure
   * @param action - The intended action
   * @param error - The error message
   * @returns TapOnTextResult with error state
   */
  private createErrorResult(
    ...args: Parameters<TapSemanticLinks["createErrorResult"]>
  ): ReturnType<TapSemanticLinks["createErrorResult"]> {
    return this.semanticLinks.createErrorResult(...args);
  }

  private validateOptions(
    ...args: Parameters<TapSemanticLinks["validateOptions"]>
  ): ReturnType<TapSemanticLinks["validateOptions"]> {
    return this.semanticLinks.validateOptions(...args);
  }

  private activateSemanticLink(
    ...args: Parameters<TapSemanticLinks["activateSemanticLink"]>
  ): ReturnType<TapSemanticLinks["activateSemanticLink"]> {
    return this.semanticLinks.activateSemanticLink(...args);
  }

  private hasUniqueSemanticLinkOwner(
    ...args: Parameters<TapSemanticLinks["hasUniqueSemanticLinkOwner"]>
  ): ReturnType<TapSemanticLinks["hasUniqueSemanticLinkOwner"]> {
    return this.semanticLinks.hasUniqueSemanticLinkOwner(...args);
  }

  private getSearchUntilDuration(
    ...args: Parameters<TapTargetResolver["getSearchUntilDuration"]>
  ): ReturnType<TapTargetResolver["getSearchUntilDuration"]> {
    return this.targets.getSearchUntilDuration(...args);
  }

  private hashViewHierarchy(
    ...args: Parameters<TapTargetResolver["hashViewHierarchy"]>
  ): ReturnType<TapTargetResolver["hashViewHierarchy"]> {
    return this.targets.hashViewHierarchy(...args);
  }

  deriveTapEffect(
    ...args: Parameters<TapTargetResolver["deriveTapEffect"]>
  ): ReturnType<TapTargetResolver["deriveTapEffect"]> {
    return this.targets.deriveTapEffect(...args);
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  deriveTapEffectAfterPostTapObservation(
    ...args: Parameters<TapTargetResolver["deriveTapEffectAfterPostTapObservation"]>
  ): ReturnType<TapTargetResolver["deriveTapEffectAfterPostTapObservation"]> {
    return this.targets.deriveTapEffectAfterPostTapObservation(...args);
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  enforceFreshnessConsistencyWithEffect(
    ...args: Parameters<TapTargetResolver["enforceFreshnessConsistencyWithEffect"]>
  ): ReturnType<TapTargetResolver["enforceFreshnessConsistencyWithEffect"]> {
    return this.targets.enforceFreshnessConsistencyWithEffect(...args);
  }

  private replaceObservationHierarchy(
    ...args: Parameters<TapTargetResolver["replaceObservationHierarchy"]>
  ): ReturnType<TapTargetResolver["replaceObservationHierarchy"]> {
    return this.targets.replaceObservationHierarchy(...args);
  }

  private logClickableParentSelection(
    ...args: Parameters<TapTargetResolver["logClickableParentSelection"]>
  ): ReturnType<TapTargetResolver["logClickableParentSelection"]> {
    return this.targets.logClickableParentSelection(...args);
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  prepareSelectionCapture(
    ...args: Parameters<TapTargetResolver["prepareSelectionCapture"]>
  ): ReturnType<TapTargetResolver["prepareSelectionCapture"]> {
    return this.targets.prepareSelectionCapture(...args);
  }

  private withObservationScreenSize(
    ...args: Parameters<TapTargetResolver["withObservationScreenSize"]>
  ): ReturnType<TapTargetResolver["withObservationScreenSize"]> {
    return this.targets.withObservationScreenSize(...args);
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  findElementInHierarchy(
    ...args: Parameters<TapTargetResolver["findElementInHierarchy"]>
  ): ReturnType<TapTargetResolver["findElementInHierarchy"]> {
    return this.targets.findElementInHierarchy(...args);
  }

  /**
   * Confirm a focus tap against the post-tap observation. On iOS that first capture
   * can predate the field taking focus (#10266): the field is focused moments later,
   * but the first read shows no focused field that matches the target. Re-read fresh
   * captures for a bounded window before reporting the focus unconfirmed, and return
   * the capture that confirmed it as the result's observation.
   */
  private verifyFocusedInputTarget(
    ...args: Parameters<TapTargetResolver["verifyFocusedInputTarget"]>
  ): ReturnType<TapTargetResolver["verifyFocusedInputTarget"]> {
    return this.targets.verifyFocusedInputTarget(...args);
  }

  private invisibleMatchFailure(
    ...args: Parameters<TapTargetResolver["invisibleMatchFailure"]>
  ): ReturnType<TapTargetResolver["invisibleMatchFailure"]> {
    return this.targets.invisibleMatchFailure(...args);
  }

  resolveTapPoint(
    ...args: Parameters<TapTargetResolver["resolveTapPoint"]>
  ): ReturnType<TapTargetResolver["resolveTapPoint"]> {
    return this.targets.resolveTapPoint(...args);
  }

  private resolveContainerElement(
    ...args: Parameters<TapTargetResolver["resolveContainerElement"]>
  ): ReturnType<TapTargetResolver["resolveContainerElement"]> {
    return this.targets.resolveContainerElement(...args);
  }

  private readonly isElementTapTargetOffScreen: TapPointPlanner["isElementTapTargetOffScreen"] = (
    ...args
  ) => this.tapPoints.isElementTapTargetOffScreen(...args);

  private visibleTapBounds(
    ...args: Parameters<TapTargetResolver["visibleTapBounds"]>
  ): ReturnType<TapTargetResolver["visibleTapBounds"]> {
    return this.targets.visibleTapBounds(...args);
  }

  private resolveVisibleTapPoint(
    ...args: Parameters<TapTargetResolver["resolveVisibleTapPoint"]>
  ): ReturnType<TapTargetResolver["resolveVisibleTapPoint"]> {
    return this.targets.resolveVisibleTapPoint(...args);
  }

  private readonly getScreenSizeFromHierarchy: TapPointPlanner["getScreenSizeFromHierarchy"] = (
    ...args
  ) => this.tapPoints.getScreenSizeFromHierarchy(...args);

  private verifyFocusAfterTap(
    ...args: Parameters<TapTargetResolver["verifyFocusAfterTap"]>
  ): ReturnType<TapTargetResolver["verifyFocusAfterTap"]> {
    return this.targets.verifyFocusAfterTap(...args);
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  refreshViewHierarchy(
    ...args: Parameters<TapTargetResolver["refreshViewHierarchy"]>
  ): ReturnType<TapTargetResolver["refreshViewHierarchy"]> {
    return this.targets.refreshViewHierarchy(...args);
  }

  private tapVerificationRefresh(
    ...args: Parameters<TapTargetResolver["tapVerificationRefresh"]>
  ): ReturnType<TapTargetResolver["tapVerificationRefresh"]> {
    return this.targets.tapVerificationRefresh(...args);
  }

  readFreshHierarchy(
    ...args: Parameters<TapTargetResolver["readFreshHierarchy"]>
  ): ReturnType<TapTargetResolver["readFreshHierarchy"]> {
    return this.targets.readFreshHierarchy(...args);
  }

  /**
   * Re-fetch the Android hierarchy and re-resolve the tap target until bounds match on enough
   * consecutive re-finds; see {@link resolveAndroidStableTapTarget}.
   */
  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  resolveAndroidStableTapTargetAfterRefreshes(
    ...args: Parameters<TapTargetResolver["resolveAndroidStableTapTargetAfterRefreshes"]>
  ): ReturnType<TapTargetResolver["resolveAndroidStableTapTargetAfterRefreshes"]> {
    return this.targets.resolveAndroidStableTapTargetAfterRefreshes(...args);
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  staleSyntheticTarget(
    ...args: Parameters<TapTargetResolver["staleSyntheticTarget"]>
  ): ReturnType<TapTargetResolver["staleSyntheticTarget"]> {
    return this.targets.staleSyntheticTarget(...args);
  }

  searchForElement(
    ...args: Parameters<TapTargetResolver["searchForElement"]>
  ): ReturnType<TapTargetResolver["searchForElement"]> {
    return this.targets.searchForElement(...args);
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  buildSelectedElementMetadata(
    ...args: Parameters<TapTargetResolver["buildSelectedElementMetadata"]>
  ): ReturnType<TapTargetResolver["buildSelectedElementMetadata"]> {
    return this.targets.buildSelectedElementMetadata(...args);
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
    ...args: Parameters<TapTargetResolver["rebuildSelectedElementMetadataAfterStability"]>
  ): ReturnType<TapTargetResolver["rebuildSelectedElementMetadataAfterStability"]> {
    return this.targets.rebuildSelectedElementMetadataAfterStability(...args);
  }

  private handleElementNotFound(
    ...args: Parameters<TapTargetResolver["handleElementNotFound"]>
  ): ReturnType<TapTargetResolver["handleElementNotFound"]> {
    return this.targets.handleElementNotFound(...args);
  }

  private isClickableElement(
    ...args: Parameters<TapTargetResolver["isClickableElement"]>
  ): ReturnType<TapTargetResolver["isClickableElement"]> {
    return this.targets.isClickableElement(...args);
  }

  private isLongClickableElement(
    ...args: Parameters<TapTargetResolver["isLongClickableElement"]>
  ): ReturnType<TapTargetResolver["isLongClickableElement"]> {
    return this.targets.isLongClickableElement(...args);
  }

  private elementAffordances(
    ...args: Parameters<TapTargetResolver["elementAffordances"]>
  ): ReturnType<TapTargetResolver["elementAffordances"]> {
    return this.targets.elementAffordances(...args);
  }

  private elementIdentity(
    ...args: Parameters<TapTargetResolver["elementIdentity"]>
  ): ReturnType<TapTargetResolver["elementIdentity"]> {
    return this.targets.elementIdentity(...args);
  }

  private ensureCheckedBeforeTap(
    ...args: Parameters<TapTargetResolver["ensureCheckedBeforeTap"]>
  ): ReturnType<TapTargetResolver["ensureCheckedBeforeTap"]> {
    return this.targets.ensureCheckedBeforeTap(...args);
  }

  private refreshEnsureCheckedSelection(
    ...args: Parameters<TapTargetResolver["refreshEnsureCheckedSelection"]>
  ): ReturnType<TapTargetResolver["refreshEnsureCheckedSelection"]> {
    return this.targets.refreshEnsureCheckedSelection(...args);
  }

  private applyEnsureCheckedResult(
    ...args: Parameters<TapTargetResolver["applyEnsureCheckedResult"]>
  ): ReturnType<TapTargetResolver["applyEnsureCheckedResult"]> {
    return this.targets.applyEnsureCheckedResult(...args);
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  resolveTapTargetElement(
    ...args: Parameters<TapTargetResolver["resolveTapTargetElement"]>
  ): ReturnType<TapTargetResolver["resolveTapTargetElement"]> {
    return this.targets.resolveTapTargetElement(...args);
  }

  private unverifiableDisplayPostState(
    ...args: Parameters<TapDisplayRouter["unverifiableDisplayPostState"]>
  ): ReturnType<TapDisplayRouter["unverifiableDisplayPostState"]> {
    return this.displayRouter.unverifiableDisplayPostState(...args);
  }

  private executeOnDisplay(
    ...args: Parameters<TapDisplayRouter["executeOnDisplay"]>
  ): ReturnType<TapDisplayRouter["executeOnDisplay"]> {
    return this.displayRouter.executeOnDisplay(...args);
  }

  private didCompleteDisplayGesture(
    ...args: Parameters<TapDisplayRouter["didCompleteDisplayGesture"]>
  ): ReturnType<TapDisplayRouter["didCompleteDisplayGesture"]> {
    return this.displayRouter.didCompleteDisplayGesture(...args);
  }

  private completedDisplayFailure(
    ...args: Parameters<TapDisplayRouter["completedDisplayFailure"]>
  ): ReturnType<TapDisplayRouter["completedDisplayFailure"]> {
    return this.displayRouter.completedDisplayFailure(...args);
  }

  private rethrowKeyboardOcclusion(
    ...args: Parameters<TapDisplayRouter["rethrowKeyboardOcclusion"]>
  ): ReturnType<TapDisplayRouter["rethrowKeyboardOcclusion"]> {
    return this.displayRouter.rethrowKeyboardOcclusion(...args);
  }

  /**
   * Execute a tap on text
   * @param options - Command options
   * @param call - Optional progress callback, cancellation, recovery policy and deadline
   * @returns Result of the command
   */
  async execute(options: TapOnElementOptions, call: TapOnCall = {}): Promise<TapOnFocusResult> {
    return withObservationReadScope(() => this.executeWithReadScope(options, call));
  }

  private executeWithReadScope(
    ...args: Parameters<TapExecution["executeWithReadScope"]>
  ): ReturnType<TapExecution["executeWithReadScope"]> {
    return this.execution.executeWithReadScope(...args);
  }

  private activateAccessibilityLinkPhase(
    ...args: Parameters<TapSemanticLinks["activateAccessibilityLinkPhase"]>
  ): ReturnType<TapSemanticLinks["activateAccessibilityLinkPhase"]> {
    return this.semanticLinks.activateAccessibilityLinkPhase(...args);
  }

  private activateSubtextPhase(
    ...args: Parameters<TapSemanticLinks["activateSubtextPhase"]>
  ): ReturnType<TapSemanticLinks["activateSubtextPhase"]> {
    return this.semanticLinks.activateSubtextPhase(...args);
  }

  /** Mark a focus-requested tap as failed unless the focused field matches the target (mutates `result`). */
  private confirmFocusAfterTap(
    ...args: Parameters<TapExecution["confirmFocusAfterTap"]>
  ): ReturnType<TapExecution["confirmFocusAfterTap"]> {
    return this.execution.confirmFocusAfterTap(...args);
  }

  private assertLongPressWithinRequestBudget(
    ...args: Parameters<TapExecution["assertLongPressWithinRequestBudget"]>
  ): ReturnType<TapExecution["assertLongPressWithinRequestBudget"]> {
    return this.execution.assertLongPressWithinRequestBudget(...args);
  }

  private predictionToolArgs(
    ...args: Parameters<TapExecution["predictionToolArgs"]>
  ): ReturnType<TapExecution["predictionToolArgs"]> {
    return this.execution.predictionToolArgs(...args);
  }

  private readScopeFailureResult(
    ...args: Parameters<TapExecution["readScopeFailureResult"]>
  ): ReturnType<TapExecution["readScopeFailureResult"]> {
    return this.execution.readScopeFailureResult(...args);
  }

  /** Dispatch an Android tap using the supplied abort signal, tap options, and TalkBack state. */
  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  executeAndroidTap(
    ...args: Parameters<TapGestureDispatcher["executeAndroidTap"]>
  ): ReturnType<TapGestureDispatcher["executeAndroidTap"]> {
    return this.gestureDispatcher.executeAndroidTap(...args);
  }

  private executeScopedAndroidTap(
    ...args: Parameters<TapGestureDispatcher["executeScopedAndroidTap"]>
  ): ReturnType<TapGestureDispatcher["executeScopedAndroidTap"]> {
    return this.gestureDispatcher.executeScopedAndroidTap(...args);
  }

  /**
   * Execute tap using CtrlProxy's dispatchGesture API with ADB fallback.
   * dispatchGesture bypasses the ADB input pipeline, reducing ghost-tap rate. (@internal unit-test seam)
   */
  executeAndroidTapWithCoordinates(
    ...args: Parameters<TapGestureDispatcher["executeAndroidTapWithCoordinates"]>
  ): ReturnType<TapGestureDispatcher["executeAndroidTapWithCoordinates"]> {
    return this.gestureDispatcher.executeAndroidTapWithCoordinates(...args);
  }

  /** Activate a DocumentsUI item through its advertised accessibility delegate (#6335). */
  private tryDocumentsUiRowActivation(
    ...args: Parameters<TapGestureDispatcher["tryDocumentsUiRowActivation"]>
  ): ReturnType<TapGestureDispatcher["tryDocumentsUiRowActivation"]> {
    return this.gestureDispatcher.tryDocumentsUiRowActivation(...args);
  }

  /** Use input recovery for DocumentsUI rows when semantic activation is unavailable. */
  private dispatchCoordinateTapOrAdbFallback(
    ...args: Parameters<TapGestureDispatcher["dispatchCoordinateTapOrAdbFallback"]>
  ): ReturnType<TapGestureDispatcher["dispatchCoordinateTapOrAdbFallback"]> {
    return this.gestureDispatcher.dispatchCoordinateTapOrAdbFallback(...args);
  }

  /**
   * After a tap, check if the view hierarchy changed. If unchanged, retry the tap once.
   * Only called when retryIfNoChange is true.
   */
  private resolveEnsureCheckedRetryTarget(
    ...args: Parameters<TapGestureDispatcher["resolveEnsureCheckedRetryTarget"]>
  ): ReturnType<TapGestureDispatcher["resolveEnsureCheckedRetryTarget"]> {
    return this.gestureDispatcher.resolveEnsureCheckedRetryTarget(...args);
  }

  private withRetryScreenSize(
    ...args: Parameters<TapGestureDispatcher["withRetryScreenSize"]>
  ): ReturnType<TapGestureDispatcher["withRetryScreenSize"]> {
    return this.gestureDispatcher.withRetryScreenSize(...args);
  }

  private refreshedRetrySelection(
    ...args: Parameters<TapGestureDispatcher["refreshedRetrySelection"]>
  ): ReturnType<TapGestureDispatcher["refreshedRetrySelection"]> {
    return this.gestureDispatcher.refreshedRetrySelection(...args);
  }

  private resolveRefreshedRetryTarget(
    ...args: Parameters<TapGestureDispatcher["resolveRefreshedRetryTarget"]>
  ): ReturnType<TapGestureDispatcher["resolveRefreshedRetryTarget"]> {
    return this.gestureDispatcher.resolveRefreshedRetryTarget(...args);
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  retryTapIfNoChange(
    ...args: Parameters<TapGestureDispatcher["retryTapIfNoChange"]>
  ): ReturnType<TapGestureDispatcher["retryTapIfNoChange"]> {
    return this.gestureDispatcher.retryTapIfNoChange(...args);
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
  private isScreenReaderNavigationEnabled(
    ...args: Parameters<TapGestureDispatcher["isScreenReaderNavigationEnabled"]>
  ): ReturnType<TapGestureDispatcher["isScreenReaderNavigationEnabled"]> {
    return this.gestureDispatcher.isScreenReaderNavigationEnabled(...args);
  }

  /** Report acknowledgement or a completed fallback without claiming semantic activation. */
  private reportTalkBackActivationWarning(
    ...args: Parameters<TapGestureDispatcher["reportTalkBackActivationWarning"]>
  ): ReturnType<TapGestureDispatcher["reportTalkBackActivationWarning"]> {
    return this.gestureDispatcher.reportTalkBackActivationWarning(...args);
  }

  private talkBackTargetContext(
    ...args: Parameters<TapGestureDispatcher["talkBackTargetContext"]>
  ): ReturnType<TapGestureDispatcher["talkBackTargetContext"]> {
    return this.gestureDispatcher.talkBackTargetContext(...args);
  }

  private executeAndroidTapWithAccessibility(
    ...args: Parameters<TapGestureDispatcher["executeAndroidTapWithAccessibility"]>
  ): ReturnType<TapGestureDispatcher["executeAndroidTapWithAccessibility"]> {
    return this.gestureDispatcher.executeAndroidTapWithAccessibility(...args);
  }

  /** Dispatch an iOS tap, using the element for VoiceOver label resolution when active. */
  private executeiOSTap(
    ...args: Parameters<TapGestureDispatcher["executeiOSTap"]>
  ): ReturnType<TapGestureDispatcher["executeiOSTap"]> {
    return this.gestureDispatcher.executeiOSTap(...args);
  }

  /**
   * Execute iOS tap using coordinate-based input (standard mode)
   */
  private executeiOSTapWithCoordinates(
    ...args: Parameters<TapGestureDispatcher["executeiOSTapWithCoordinates"]>
  ): ReturnType<TapGestureDispatcher["executeiOSTapWithCoordinates"]> {
    return this.gestureDispatcher.executeiOSTapWithCoordinates(...args);
  }

  /** VoiceOver activation with a coordinate-tap fallback; see {@link tapViaVoiceOver}. */
  private executeIOSTapWithVoiceOver(
    ...args: Parameters<TapGestureDispatcher["executeIOSTapWithVoiceOver"]>
  ): ReturnType<TapGestureDispatcher["executeIOSTapWithVoiceOver"]> {
    return this.gestureDispatcher.executeIOSTapWithVoiceOver(...args);
  }

  private readOptionalDisplayFence(
    ...args: Parameters<TapGestureDispatcher["readOptionalDisplayFence"]>
  ): ReturnType<TapGestureDispatcher["readOptionalDisplayFence"]> {
    return this.gestureDispatcher.readOptionalDisplayFence(...args);
  }

  private getLongPressDuration(
    ...args: Parameters<TapGestureDispatcher["getLongPressDuration"]>
  ): ReturnType<TapGestureDispatcher["getLongPressDuration"]> {
    return this.gestureDispatcher.getLongPressDuration(...args);
  }

  private executeAndroidLongPress(
    ...args: Parameters<TapGestureDispatcher["executeAndroidLongPress"]>
  ): ReturnType<TapGestureDispatcher["executeAndroidLongPress"]> {
    return this.gestureDispatcher.executeAndroidLongPress(...args);
  }

  private throwIfLongPressInterrupted(
    ...args: Parameters<TapGestureDispatcher["throwIfLongPressInterrupted"]>
  ): ReturnType<TapGestureDispatcher["throwIfLongPressInterrupted"]> {
    return this.gestureDispatcher.throwIfLongPressInterrupted(...args);
  }

  private semanticAndroidLongPressTargetError(
    ...args: Parameters<TapGestureDispatcher["semanticAndroidLongPressTargetError"]>
  ): ReturnType<TapGestureDispatcher["semanticAndroidLongPressTargetError"]> {
    return this.gestureDispatcher.semanticAndroidLongPressTargetError(...args);
  }

  private trySemanticAndroidLongPress(
    ...args: Parameters<TapGestureDispatcher["trySemanticAndroidLongPress"]>
  ): ReturnType<TapGestureDispatcher["trySemanticAndroidLongPress"]> {
    return this.gestureDispatcher.trySemanticAndroidLongPress(...args);
  }

  private detectLongPressMetadata(
    ...args: Parameters<TapExecution["detectLongPressMetadata"]>
  ): ReturnType<TapExecution["detectLongPressMetadata"]> {
    return this.execution.detectLongPressMetadata(...args);
  }
}
