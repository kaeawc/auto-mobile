import {
  TapTargetUnavailableError,
  findTapTargetNode,
  pointInTapBounds,
  selectionHierarchyFor,
  type TapFocusFailure,
} from "./tapTargetSupport";
import type { HierarchyLayer } from "../../models/HierarchyLayer";
import { describeFocusTarget } from "./tapFocusIdentity";
import type { AndroidTapVerification, TapVerificationOptions } from "./tapVerificationOptions";
import { TapElementFinder } from "./tapElementFinder";
import { TapPointPlanner } from "./tapPointPlanner";
import { invalidateIosCacheOnSuccess, tapViaVoiceOver } from "./tapIosVoiceOver";
import {
  resolveAndroidStableTapTarget,
  type StableTapTargetResult,
} from "./androidStableTapTarget";
import { POST_TAP_EFFECT_POLL_MS, PostTapSettler } from "./tapPostTapSettler";
import { FocusVerifier } from "./tapFocusVerifier";
import { pollSearchUntil } from "./searchUntilPoller";
import { readFreshPlatformHierarchy, returnsRawHierarchyUnfiltered } from "./tapHierarchyRead";
import {
  assertLongPressWithinHardMax,
  containerSelectorError,
  failedTapResult,
  resolveSearchUntilDuration,
  throwIfLongPressInterrupted,
} from "./tapSharedHelpers";
import { isStrictlyScoped } from "../utility/ScopedSelection";
import {
  withObservationReadScope,
  wasHierarchyReadDuringCall,
} from "../observe/observationReadScope";
import { ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS, freshTapHierarchy } from "./freshTapHierarchy";
import {
  isSemanticActionRejected,
  type TalkBackTargetContext,
} from "../talkback/resourceIdActionError";
import { DispatchedObservationError } from "../../models/DispatchedObservationError";
import { dispatchAndroidLongPress } from "./androidLongPress";
import { unsupportedDisplayOptionMessage } from "../observe/SessionDisplayContext";
import { assertLongPressFitsRequestBudget } from "./gestureTransportTimeout";
import { resolveIosObserveRotation } from "../observe/iosObserveRotation";
import {
  type DisplayFence,
  type DisplayFenceOption,
  type DisplayFenceDependencies,
} from "./BaseVisualChange";
import { withStaleDisplay, StaleDisplayError } from "../observe/StaleDisplayError";
import { unsupportedPlatformError } from "../../models/ActionableError";
import { KeyboardOcclusionError } from "../../models/KeyboardOcclusionError";
import {
  ElementResolver,
  isFocusEditableElement,
  promoteClickableAncestor,
} from "../utility/ElementResolver";
import { SearchableHierarchy } from "../utility/SearchableNode";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import {
  DefaultHierarchyCapture,
  getHierarchySnapshot,
  type HierarchyCapture,
} from "../observe/HierarchyCapture";
import { errorMessage } from "../../utils/describeUnknownError";
import { BaseVisualChange, ProgressCallback, type ObservedActionResult } from "./BaseVisualChange";
import {
  displayTransitions,
  type DisplayTransitionReader,
  type DisplayTransitionTracker,
} from "../observe/DisplayTransition";
import { ObservedAndroidDisplayCache } from "../observe/ObservationDisplay";
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
import { DefaultElementGeometry, isUsableScreenSize } from "../utility/ElementGeometry";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";

import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient, type CtrlProxyActionResult } from "../observe/ios";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { reportToolDispatched } from "../../utils/ToolDispatchContext";
import {
  DEFAULT_VISION_CONFIG,
  getVisionEnrichedError,
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
import { isAndroidDocumentsUiRow } from "./androidCoordinateTapPolicy";
import {
  hasOwnPrototype,
  scopeHierarchyForSelector,
  scopeHierarchyToLayer,
} from "../observe/hierarchyLayer";
import {
  getToggleContentDescription,
  hasAccessibilityAction,
  isTruthyFlag,
} from "../utility/elementProperties";
import {
  nodeActionTargetError,
  requiresNodeSelector,
  stableNodeSelectorForElement,
  TalkBackTapStrategy,
  TALKBACK_ACTIVATION_WARNING,
  type ScreenReaderNavigationResult,
  type TalkBackTapResult,
} from "../talkback/TalkBackTapStrategy";
import {
  DefaultTalkBackNavigationDriverFactory,
  type TalkBackNavigationDriverFactory,
} from "../talkback/TalkBackNavigationDriver";
import { talkBackDisplayRefusal } from "../talkback/talkBackDisplayRefusal";
import type { IosVoiceOverDetector } from "../accessibility/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../accessibility/IosVoiceOverDetector";
import type { TapStrategy } from "../../utils/interfaces/TapStrategy";
import { FeatureFlagService } from "../featureFlags/FeatureFlagService";
import { createTapStrategy } from "./strategies/createTapStrategy";
import { LongPressMetadataDetector, type LongPressMetadata } from "./LongPressMetadataDetector";
import { RealWaitForCondition } from "../observe/WaitForCondition";
import type { WaitForCondition } from "../observe/interfaces/WaitForCondition";
import { hierarchyUpdatedAtToMillis } from "../observe/observeTimestamp";
import { sequenceBackoff } from "../../utils/Backoff";
import {
  androidDisplayTapDispatch,
  dispatchAndroidCoordinateTap,
  dispatchIosCoordinateTap,
  dispatchIosDoubleTap,
  indeterminateTapError,
} from "./coordinateTapDispatch";
import { dispatchAndroidDoubleTap } from "./androidDoubleTap";
import { executeTouchscreenInput } from "./touchscreenInput";
import {
  refreshTargetDisplayHierarchy,
  prepareTargetDisplayAction,
  type RenderedObservationReader,
} from "./TargetDisplayAction";
import {
  DEFAULT_HIERARCHY_READ_TIMEOUT_MS,
  createDeviceHierarchyCapture,
} from "../observe/DeviceHierarchyCapture";
import {
  checkAndroidTapHierarchyChange,
  POST_TAP_REFRESH_TIMEOUT_MS,
  PRE_RETRY_DELAY_MS,
} from "./androidGhostTapRetry";
import { getHierarchyNodeSource } from "../observe/output/elementProvenance";
import { isSdkInjectedNode } from "../observe/android/StableNodeIdentity";
import { deadlineRequest, resolveTapOnCall, type TapOnCall } from "./ActionCall";
import { OBSERVED_INTERACTION_PROFILES, SETTLE_BUDGET_MS } from "./observedInteractionProfiles";

/** Internal action context; never part of the public tapOn schema. */
type IosTapOptions = DisplayFenceOption & { signal?: AbortSignal };

type ResolvedAndroidTapOptions = DisplayFenceOption & {
  resolvedHierarchy?: ViewHierarchyResult;
  /** Receives non-fatal cautions (for example a double tap whose taps started too far apart). */
  onActivationWarning?: (warning: string) => void;
  onResolvedElement?: (
    element: Element,
    selection?: ElementSelectionResult,
    hierarchy?: ViewHierarchyResult,
  ) => void;
};

/** TalkBack state resolved once for an explicit-display tap, with any unknown-state warnings. */
type AndroidDisplayTalkBackState = { enabled: boolean; warnings: string[] };
type SearchUntilStats = NonNullable<TapOnElementResult["searchUntil"]>;

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
  featureFlags?: FeatureFlagService;
  waitForCondition?: WaitForCondition;
  /**
   * Override the platform-specific {@link TapStrategy}. Tests use this
   * to inject a fake; production code leaves it unset so the constructor
   * picks the right strategy based on `device.platform`.
   */
  tapStrategy?: TapStrategy;
}

const ENSURE_CHECKED_POLL_BACKOFF_MS = [50, 100, 200, 400] as const;
const ensureCheckedPollBackoff = sequenceBackoff(ENSURE_CHECKED_POLL_BACKOFF_MS);
const ENSURE_CHECKED_POLL_TIMEOUT_MS = ENSURE_CHECKED_POLL_BACKOFF_MS.reduce(
  (total, delayMs) => total + delayMs,
  0,
);
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

/** Internal focus evidence; symbol keys never enter JSON tool output. */
export const tapFocusFailure: unique symbol = Symbol("tapFocusFailure");
export const tapResolvedLayer: unique symbol = Symbol("tapResolvedLayer");
export type { TapFocusFailure };
/** Classify the already resolved node in the captured window scopes, without another read. */
function resolvedElementLayer(
  hierarchy: ViewHierarchyResult,
  element: Element,
  platform: "android" | "ios",
): HierarchyLayer | undefined {
  if (!hasOwnPrototype(hierarchy)) {
    return undefined;
  }
  hierarchy = selectionHierarchyFor(element, hierarchy, platform);
  const source = getHierarchyNodeSource(element);
  if (!source) {
    return undefined;
  }
  const parser = new DefaultElementParser();
  for (const layer of ["prototype", "app"] as const) {
    const entries = parser.flattenViewHierarchy(scopeHierarchyToLayer(hierarchy, layer), {
      includeWindows: true,
    });
    if (entries.some((entry) => getHierarchyNodeSource(entry.element) === source)) {
      return layer;
    }
  }
  return undefined;
}

export type TapOnFocusResult = TapOnElementResult & {
  [tapFocusFailure]?: TapFocusFailure;
  [tapResolvedLayer]?: HierarchyLayer;
};
type TapOnFocusOutcome = TapOnFocusResult & { wasAlreadyFocused?: boolean; focusChanged?: boolean };

/** Keep routing metadata available to internal callers without exposing it in MCP payloads. */
function withResolvedLayer<T extends TapOnFocusResult>(
  result: T,
  layer: HierarchyLayer | undefined,
): T {
  if (layer !== undefined) {
    Object.defineProperty(result, tapResolvedLayer, {
      value: layer,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function markFocusFailure(
  action: string,
  result: TapOnElementResult,
  error: unknown,
): TapOnFocusResult {
  if (action === "focus" && error instanceof TapTargetUnavailableError) {
    Object.defineProperty(result, tapFocusFailure, { value: error.reason });
  }
  return result;
}

function appendDisabledElementWarning(
  platform: string,
  element: Element,
  warnings: string[],
): void {
  if (platform === "android" && isFalsy(element.enabled)) {
    warnings.push("The matched element is disabled; the tap may have no effect.");
  }
}

/**
 * Command to tap on UI element containing specified text
 */
function warningsField(warnings: string[]): { warnings?: string[] } {
  return warnings.length ? { warnings } : {};
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
  private readonly featureFlags: FeatureFlagService;
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

    return this.validateSemanticLinkOptions(options);
  }

  private validateSemanticLinkOptions(options: TapOnElementOptions): string | null {
    if (options.layer !== undefined && this.hasSemanticLinkTarget(options)) {
      // Semantic links are activated on the device across every window, so the
      // host cannot keep the activation inside the app or the prototype (#9305).
      return "tapOn layer cannot be used with accessibilityLink or subtext";
    }
    if (options.selectionStrategy === "unique" && (options.sibling || options.accessibilityLink)) {
      return "tapOn unique selection cannot use sibling or direct accessibilityLink; select a unique owner with subtext instead";
    }
    if ((options as { relativePosition?: unknown }).relativePosition !== undefined) {
      return "tapOn relativePosition is no longer supported; use accessibilityLink or subtext";
    }
    if (!this.hasSemanticLinkTarget(options)) {
      return null;
    }
    return this.semanticLinkValidationErrors(options).find(({ invalid }) => invalid)?.error ?? null;
  }

  private hasSemanticLinkTarget(options: TapOnElementOptions): boolean {
    return [options.accessibilityLink, options.subtext].some((value) => value !== undefined);
  }

  private semanticLinkValidationErrors(options: TapOnElementOptions) {
    return [
      {
        invalid: [options.accessibilityLink, options.subtext].every((value) => value !== undefined),
        error: "tapOn accessibilityLink and subtext cannot be used together",
      },
      {
        invalid: options.action !== "tap",
        error: "tapOn semantic link activation supports only the tap action",
      },
      { invalid: options.sibling, error: "tapOn semantic link activation cannot use sibling" },
      {
        invalid: Boolean(options.retryIfNoChange ?? options.ensureTap),
        error: "tapOn semantic link activation cannot retry an acknowledged link activation",
      },
      {
        invalid: options.ensureChecked !== undefined,
        error: "tapOn semantic link activation cannot ensure checked state",
      },
      {
        invalid: options.searchUntil,
        error: "tapOn semantic link activation cannot use searchUntil",
      },
      {
        invalid: this.semanticLinkTextIsBlank(options),
        error: "tapOn semantic link text must be non-empty",
      },
      {
        invalid: this.semanticLinkOccurrenceIsInvalid(options),
        error: "tapOn semantic link occurrence must be a non-negative integer",
      },
      {
        invalid: options.subtext ? options.index !== undefined : false,
        error:
          "tapOn owner-scoped semantic link activation cannot use index; use a unique owner selector",
      },
      {
        invalid: options.subtext ? options.selectionStrategy === "random" : false,
        error:
          "tapOn owner-scoped semantic link activation cannot use random selection; use a unique owner selector",
      },
    ];
  }

  private semanticLinkTextIsBlank(options: TapOnElementOptions): boolean {
    return (options.subtext?.text ?? options.accessibilityLink)?.trim().length === 0;
  }

  private semanticLinkOccurrenceIsInvalid(options: TapOnElementOptions): boolean {
    const occurrence = options.subtext?.occurrence ?? options.index ?? 0;
    return ![Number.isInteger(occurrence), occurrence >= 0].every(Boolean);
  }

  private async activateSemanticLink(
    text: string,
    occurrence: number,
    owner?: Element,
    viewHierarchy?: ViewHierarchyResult,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string; warning?: string }> {
    const confirmActivation = (result: CtrlProxyActionResult, invalidate: () => void): void => {
      if (result.dispatched && result.acknowledged !== true) {
        // A lost reply may mean the screen navigated; discard the pre-activation tree.
        invalidate();
        throw indeterminateTapError(result.error);
      }
    };
    if (owner && !this.hasUniqueSemanticLinkOwner(owner, viewHierarchy)) {
      return {
        success: false,
        error:
          "Container-scoped semantic link activation requires a unique resource-id owner identity",
      };
    }
    if (this.device.platform === "android") {
      const selector = owner ? stableNodeSelectorForElement(owner) : undefined;
      if (owner && !selector) {
        return {
          success: false,
          error:
            "Container-scoped semantic link activation requires a stable native owner identity",
        };
      }
      const result = await this.accessibilityService.requestActivateAccessibilityLink(
        text,
        occurrence,
        selector,
        undefined,
        undefined,
        signal,
      );
      confirmActivation(result, () => {
        AndroidCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache();
      });
      return { success: result.success, error: result.error };
    }
    if (this.device.platform === "ios") {
      const ownerResourceId = owner?.["resource-id"];
      if (owner && (typeof ownerResourceId !== "string" || ownerResourceId.length === 0)) {
        return {
          success: false,
          error:
            "Container-scoped semantic link activation requires a stable native owner identity",
        };
      }
      const result = await IOSCtrlProxyClient.getInstance(
        this.device,
      ).requestActivateAccessibilityLink(
        text,
        occurrence,
        ownerResourceId as string | undefined,
        undefined,
        undefined,
        signal,
      );
      confirmActivation(result, () => invalidateIosCacheOnSuccess(this.device, { success: true }));
      invalidateIosCacheOnSuccess(this.device, result);
      // The runner's "first of N candidate owners" note must reach the caller (#10082).
      return {
        success: result.success,
        error: result.error,
        warning: result.warning,
      };
    }
    return {
      success: false,
      error: unsupportedPlatformError(this.device.platform, "tap on elements").message,
    };
  }

  private hasUniqueSemanticLinkOwner(
    owner: Element,
    viewHierarchy: ViewHierarchyResult | undefined,
  ): boolean {
    if (!viewHierarchy) {
      return false;
    }
    // The owner is resolved (ElementResolver) and natively activated across every
    // window subtree, so the uniqueness count must span the same node set. Flatten
    // with includeWindows to match — otherwise an owner in a dialog/popup/overlay is
    // miscounted: an ambiguous owner reads as unique, a valid one as absent. See #5618.
    const elements = this.elementParser
      .flattenViewHierarchy(viewHierarchy, { includeWindows: true })
      .map(({ element }) => element);
    if (this.device.platform === "ios") {
      const ownerResourceId = owner["resource-id"];
      return (
        typeof ownerResourceId === "string" &&
        ownerResourceId.length > 0 &&
        preferCapturedOwners(
          elements.filter((element) => element["resource-id"] === ownerResourceId),
        ).length === 1
      );
    }
    const selector = stableNodeSelectorForElement(owner);
    return (
      selector !== undefined &&
      elements.filter((element) => this.matchesNativeOwnerSelector(element, selector)).length === 1
    );
  }

  private matchesNativeOwnerSelector(
    element: Element,
    selector: NonNullable<ReturnType<typeof stableNodeSelectorForElement>>,
  ): boolean {
    const resourceId = element["resource-id"];
    if (
      selector.resourceId !== undefined &&
      (typeof resourceId !== "string" ||
        (resourceId !== selector.resourceId && !resourceId.endsWith(`:id/${selector.resourceId}`)))
    ) {
      return false;
    }
    return (
      (selector.testTag === undefined || element["test-tag"] === selector.testTag) &&
      (selector.uniqueId === undefined || element["unique-id"] === selector.uniqueId) &&
      (selector.collectionRow === undefined ||
        element["collection-row-index"] === selector.collectionRow) &&
      (selector.collectionColumn === undefined ||
        element["collection-column-index"] === selector.collectionColumn)
    );
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
    const immediateEffect = this.deriveTapEffect(previousObservation, currentObservation);
    if (this.device.platform !== "android" || !previousObservation) {
      return { effect: immediateEffect, observation: currentObservation };
    }

    if (immediateEffect?.screenChanged !== true) {
      // A stable source tree can arrive before Android begins the activity
      // transition. Keep the full detection window before concluding no change;
      // a quiet source screen is not proof that the tap had no effect.
      return this.settler.waitForPostTapChange(previousObservation, currentObservation, signal);
    }

    if (immediateEffect.basis !== "viewHierarchy changed") {
      // A `screenIdentity`/`activeWindow` change is authoritative on its own —
      // it names a real destination window, so trust it immediately.
      return { effect: immediateEffect, observation: currentObservation };
    }

    // Issue #6284: a hierarchy-ONLY change (activeWindow unchanged) is not, by
    // itself, proof of the DESTINATION screen. The first post-tap observation
    // uses `changeExpected: false`, so a transient intermediate mutation (a
    // focused/selected/checked flip, or a partial hierarchy update before a
    // delayed dialog/navigation) can look identical to a real change on the
    // very first frame. Settle it across a real stability interval before
    // trusting it as terminal, so a transient A isn't returned in place of the
    // actual destination B (`baseline → A → A → B` must reach B).
    return this.settler.settleHierarchyOnlyChange(previousObservation, currentObservation, signal);
  }

  /**
   * Guard against a self-contradicting response (issue #6219): `effect` says the
   * screen already changed (`screenChanged: true`), but the observation attached
   * to the SAME payload predates that transition and still stamps
   * `freshness.verified/isFresh: true` — a client sees a stale, pre-tap tree
   * asserted as trustworthy in the very response that also reports the window
   * changed. Re-derives the comparison against `result.observation` as it
   * stands right before it is returned (after any downstream mutation, e.g.
   * `selectionStateTracker.finalize`), rather than trusting whichever
   * intermediate observation `effect` was originally computed from, so a later
   * mutation cannot leave the two fields disagreeing in the response.
   *
   * Only ever retracts freshness — never invents a `screenChanged: true` an
   * observation didn't earn — and only when `effect` itself claims a change.
   */
  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  enforceFreshnessConsistencyWithEffect(
    previousObservation: ObserveResult | null,
    result: { effect?: TapOnElementResult["effect"]; observation?: ObserveResult },
  ): void {
    if (!previousObservation || !result.observation || result.effect?.screenChanged !== true) {
      return;
    }
    if (result.observation.wakefulness === "Asleep") {
      // Issue #6284: a definitive screen-off terminal legitimately carries no
      // viewHierarchy, so a re-derivation against it cannot reproduce the
      // `screenChanged: true` (there is nothing to diff). This is NOT a stale
      // pre-tap tree the client should re-observe past — it is the real
      // post-tap state (the screen went off). Retracting freshness here would
      // stamp the wrong warning ("predates the detected transition") over a
      // faithful terminal capture, so leave it intact.
      return;
    }
    const reDerived = this.deriveTapEffect(previousObservation, result.observation);
    if (reDerived?.screenChanged === true) {
      // The observation being returned is itself consistent with the detected
      // transition — nothing to correct.
      return;
    }
    const existing = result.observation.freshness;
    result.observation.freshness = {
      ...(existing ?? { isFresh: true }),
      verified: false,
      isFresh: false,
      category: "effect_inconsistent",
      warning:
        "effect.screenChanged is true, but this observation's own capture still matches the " +
        "pre-action screen — it predates the detected transition. Call observe again for the " +
        "current, post-action state.",
    };
  }

  /**
   * The ONLY sanctioned way to swap an observation's `viewHierarchy` for one
   * captured later in `execute` (issue #6284). Folding "replace hierarchy" and
   * "refresh freshness" into one helper means no call site can do the first
   * without the second: replacing a cached observation's hierarchy with a
   * freshly-captured one while leaving its OLD `freshness` (e.g. `isFresh:
   * false` from the pre-tap cache) stamped on the new, just-verified tree would
   * surface fresh data labelled stale in the response.
   *
   * Pass `refreshedFromDevice: true` only when `viewHierarchy` was just captured
   * from the device on this call (a genuine live re-capture) — that is the case
   * whose freshness must be realigned. A replacement with data already in hand
   * (the caller's own hierarchy returned unchanged) leaves freshness untouched.
   */
  private replaceObservationHierarchy(
    observeResult: ObserveResult,
    viewHierarchy: ViewHierarchyResult,
    refreshedFromDevice: boolean,
  ): void {
    const screenSize = this.getScreenSizeFromHierarchy(viewHierarchy, {
      observationScreenSize: observeResult.screenSize,
      display: observeResult.viewHierarchy,
    });
    observeResult.viewHierarchy = viewHierarchy;
    // The replacement is device-authored; keep the enclosing observation in
    // that same clock domain so later freshness floors never compare it with
    // the host time from the cached observation it replaced.
    const updatedAt = hierarchyUpdatedAtToMillis(viewHierarchy);
    if (updatedAt !== undefined) {
      observeResult.updatedAt = updatedAt;
    }
    if (screenSize) {
      observeResult.screenSize = screenSize;
    } else if (observeResult.screenSize) {
      observeResult.screenSize = { width: 0, height: 0 };
    }
    if (this.device.platform === "ios") {
      observeResult.rotation = resolveIosObserveRotation(
        viewHierarchy.rotation,
        observeResult.screenSize,
      );
    }
    if (refreshedFromDevice) {
      this.markObservationFreshAfterSyncRefresh(observeResult);
    }
  }

  /**
   * Realign a cached observation's freshness verdict to the live re-capture that
   * just replaced its hierarchy (issue #6284). The refresh verified the tree
   * against the device on THIS call, so a lingering pre-refresh `isFresh: false`
   * verdict no longer describes the attached data.
   *
   * Promote ONLY a `cache_age` failure — a stale/unverified/over-budget cache
   * entry, which is exactly what swapping in a freshly-captured hierarchy
   * resolves. A `window_identity` failure (wrong-window, status-bar-only,
   * activity-attribution mismatch, incomplete capture, missing foreground
   * window — issue #6284 P1) describes WHICH window/app the tree belongs to; the
   * refresh replaced only `viewHierarchy` and did not recollect or reconcile
   * `activeWindow`/attribution, and the re-capture may itself be from the wrong
   * window, so clearing that warning would make an internally-inconsistent
   * result look trustworthy. A verdict that was already fresh (or absent), or
   * failed for any other reason, is left untouched. Called exclusively from
   * {@link replaceObservationHierarchy}.
   */
  private markObservationFreshAfterSyncRefresh(observeResult: ObserveResult): void {
    const freshness = observeResult.freshness;
    const hierarchy = observeResult.viewHierarchy;
    const actualTimestamp = hierarchyUpdatedAtToMillis(hierarchy);
    const hasCompleteLiveHierarchy =
      hierarchy !== undefined &&
      typeof hierarchy.hierarchy === "object" &&
      hierarchy.hierarchy !== null &&
      !("error" in hierarchy.hierarchy) &&
      hierarchy.ctrlProxyIncomplete !== true &&
      hierarchy.fresh !== false &&
      actualTimestamp !== undefined;
    if (
      hasCompleteLiveHierarchy &&
      freshness?.isFresh === false &&
      freshness.category === "cache_age"
    ) {
      observeResult.freshness = {
        ...freshness,
        isFresh: true,
        verified: true,
        actualTimestamp,
        ageMs: 0,
        staleDurationMs: undefined,
        warning: undefined,
        category: undefined,
      };
    }
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
  async refreshViewHierarchy(
    timeoutMs: number,
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
    forceCapture: boolean = false,
  ): Promise<ViewHierarchyResult | null> {
    throwIfAborted(signal);
    if (timeoutMs <= 0) {
      return null;
    }
    const observedGeneration =
      this.renderedDisplayGeneration(this.device.deviceId) ??
      this.displayTransitionReader.identityRevision(this.device.deviceId);
    let captured: ViewHierarchyResult;
    try {
      captured = (
        await this.hierarchyCapture.capture({
          freshness: "fresh",
          ...(forceCapture ? { requireFreshExtraction: true } : {}),
          searchRaw: serverConfig.isRawElementSearchEnabled(),
          timeoutMs,
          signal,
        })
      ).hierarchy;
    } catch (error) {
      if (error instanceof StaleDisplayError) {
        throw error;
      }
      throwIfAborted(signal);
      logger.warn(`[TapOnElement] Fresh capture failed: ${errorMessage(error)}`);
      return null;
    }
    if (isUsableScreenSize(screenSize) && this.device.platform === "android") {
      await this.checkRefreshedDisplay(captured, screenSize, observedGeneration, signal);
    }
    return captured;
  }

  private tapVerificationRefresh(context: {
    refresh?: AndroidTapVerification["refresh"];
    screenSize?: ObserveResult["screenSize"];
    signal?: AbortSignal;
  }): AndroidTapVerification["refresh"] {
    return (
      context.refresh ??
      ((timeoutMs) => this.refreshViewHierarchy(timeoutMs, context.screenSize, context.signal))
    );
  }

  private async checkRefreshedDisplay(
    captured: ViewHierarchyResult,
    screenSize: ObserveResult["screenSize"],
    observedGeneration: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const freshSize = this.getScreenSizeFromHierarchy(captured);
    if (
      !freshSize ||
      (freshSize.width === screenSize.width &&
        freshSize.height === screenSize.height &&
        (this.device.displays?.panels.length ?? 0) < 2)
    ) {
      return;
    }
    const display = await this.refreshedDisplay(captured, signal);
    const identityChanged = this.refreshedDisplayTransitions.checkIdentity(
      this.device.deviceId,
      display,
    );
    const geometryTransition = this.refreshedDisplayTransitions.record(this.device.deviceId, {
      display,
      screenSize: freshSize,
    });
    if (identityChanged || geometryTransition) {
      throw this.staleDisplay(observedGeneration);
    }
  }

  private async refreshedDisplay(
    captured: ViewHierarchyResult,
    signal?: AbortSignal,
  ): Promise<ObserveResult["display"]> {
    const displayCache = new ObservedAndroidDisplayCache(this.timer);
    const focusedPanel = await displayCache.panelForLogicalId(
      this.device,
      this.adb,
      captured.displayId,
      signal,
      { panelUniqueId: captured.panelUniqueId, panelFingerprint: captured.panelFingerprint },
      false,
    );
    const resolved = await displayCache.resolve(this.device, this.adb, signal);
    const panel =
      focusedPanel ??
      this.device.displays?.panels.find((candidate) => candidate.key === resolved.display.key);
    return {
      ...resolved.display,
      key: panel?.key ?? resolved.display.key,
      role: panel?.role ?? resolved.display.role,
      posture: await displayCache.posture(this.device, this.adb, signal),
    };
  }

  private async readFreshHierarchy(
    timeoutMs: number,
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
    forceCapture: boolean = false,
  ): Promise<ViewHierarchyResult | null> {
    throwIfAborted(signal);
    const effectiveTimeoutMs = Math.max(0, timeoutMs);
    if (effectiveTimeoutMs === 0) {
      return null;
    }
    return readFreshPlatformHierarchy(
      {
        device: this.device,
        adb: this.adb,
        timer: this.timer,
        androidService: this.accessibilityService,
        viewHierarchy: this.viewHierarchy,
        prepareForResponse: (raw, size) => this.prepareViewHierarchyForResponse(raw, size),
        actionLabel: "tap on elements",
      },
      { timeoutMs: effectiveTimeoutMs, screenSize, signal, forceCapture },
    );
  }

  /**
   * Re-fetch the Android hierarchy and re-resolve the tap target until bounds match on enough
   * consecutive re-finds; see {@link resolveAndroidStableTapTarget}.
   */
  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  resolveAndroidStableTapTargetAfterRefreshes(
    options: TapVerificationOptions,
    observeResult: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>,
    action: TapOnElementOptions["action"],
    requireResourceId: boolean,
    signal?: AbortSignal,
  ): Promise<StableTapTargetResult> {
    return resolveAndroidStableTapTarget(
      {
        timer: this.timer,
        elementParser: this.elementParser,
        findElementInHierarchy: (opts, hierarchy) => this.findElementInHierarchy(opts, hierarchy),
        resolveTapTargetElement: (element, hierarchy, tapAction, tapOptions) =>
          this.resolveTapTargetElement(element, hierarchy, tapAction, tapOptions),
        staleSyntheticTarget: (original, previous, current) =>
          this.staleSyntheticTarget(original, previous, current),
        tapVerificationRefresh: (context) => this.tapVerificationRefresh(context),
        withObservationScreenSize: (opts, observation) =>
          this.withObservationScreenSize(opts, observation),
      },
      { options, observeResult, action, requireResourceId, signal },
    );
  }

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  staleSyntheticTarget(
    original: Element | null,
    previous: ViewHierarchyResult | undefined,
    current: ViewHierarchyResult,
  ): string | undefined {
    if (!original || original["resource-id"] || !original["view-id"] || !previous) {
      return undefined;
    }
    const projection = new SearchableHierarchy();
    const nodeKey = original["view-id"];
    const oldNode = projection.project(previous).find((node) => node.nodeKey === nodeKey);
    if (!oldNode) {
      return "Stale tap target: the observed reference is no longer identifiable.";
    }
    const oldId = getHierarchySnapshot(previous)?.captureId ?? "before-refresh";
    const newId =
      getHierarchySnapshot(current)?.captureId ?? (previous === current ? oldId : "after-refresh");
    const result = new ElementResolver().resolve(
      { id: newId, nodes: projection.project(current) },
      { elementId: nodeKey },
      {
        action: "inspect",
        ref: {
          snapshotId: oldId,
          nodeKey,
          bounds: oldNode.bounds,
          label: oldNode.label,
          nativeId: oldNode.nativeId,
        },
      },
    );
    return result.error;
  }

  private isPrototypeWindowPending(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
  ): boolean {
    return (
      options.layer === "prototype" &&
      hierarchy.prototypeSuspended !== true &&
      !hasOwnPrototype(hierarchy)
    );
  }

  private findElementForSearch(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
  ): ReturnType<TapOnElement["findElementInHierarchy"]> {
    if (this.isPrototypeWindowPending(options, hierarchy)) {
      // A successful show can precede the window's first accessibility capture.
      return {
        selection: { element: null, indexInMatches: -1, totalMatches: 0, strategy: "first" },
        containerFound: false,
      };
    }
    return this.findElementInHierarchy(options, hierarchy);
  }

  private async searchForElement(
    options: TapVerificationOptions,
    observeResult: ObserveResult,
    signal?: AbortSignal,
  ): Promise<{
    selection: ElementSelectionResult;
    viewHierarchy: ViewHierarchyResult;
    containerFound: boolean;
    stats: SearchUntilStats;
    /**
     * True when `viewHierarchy` is a genuine live device re-capture taken during
     * this search (the caller's initial hierarchy did not already contain the
     * target), distinct from the common case where the element was found in the
     * hierarchy the caller already had with no device round-trip. Drives
     * whether {@link replaceObservationHierarchy} also realigns freshness
     * (issue #6284).
     */
    refreshedFromDevice: boolean;
    visibilityError?: TapTargetUnavailableError;
  }> {
    const viewHierarchy = observeResult.viewHierarchy;
    if (!viewHierarchy) {
      throw new ActionableError("Unable to get view hierarchy, cannot tap on element");
    }

    const searchDurationMs = this.getSearchUntilDuration(options);
    const startTime = this.timer.now();
    let requestCount = 0;
    let changeCount = 0;
    let offScreenRejections = 0;
    let visibilityError: TapTargetUnavailableError | undefined;
    let lastHash = this.hashViewHierarchy(viewHierarchy);

    let latestViewHierarchy = viewHierarchy;
    let latestScreenSize = this.getScreenSizeFromHierarchy(latestViewHierarchy, {
      observationScreenSize: observeResult.screenSize,
      display: observeResult.viewHierarchy,
    });
    const initialSearch = this.findElementForSearch(
      this.withObservationScreenSize(options, observeResult),
      latestViewHierarchy,
    );
    let selection = initialSearch.selection;
    const invisibleError = () =>
      this.invisibleMatchFailure(selection, options, latestViewHierarchy, latestScreenSize);
    let element = selection.element;
    let containerFoundEver = initialSearch.containerFound;
    if (!element && selection.matchedElement) {
      visibilityError = invisibleError();
    }

    if (
      !element ||
      this.isElementTapTargetOffScreen(selection, latestViewHierarchy, latestScreenSize, options)
    ) {
      if (element) {
        visibilityError = invisibleError();
        logger.warn(
          `[TapOnElement] Element found but tap target is off-screen, will retry. ` +
            `bounds=${JSON.stringify(element.bounds)}, ` +
            `screen=${latestScreenSize?.width}x${latestScreenSize?.height}`,
        );
        selection = { ...selection, element: null };
        element = null;
        offScreenRejections += 1;
      }
      // Fast cached iOS responses must yield just like device round-trips.
      // Keep an independent request ceiling even if the wall clock moves backward.
      const polled = await pollSearchUntil({
        timer: this.timer,
        startTime,
        durationMs: searchDurationMs,
        intervalMs: TapOnElement.SEARCH_POLL_INTERVAL_MS,
        pacing: "cadence",
        maxRequests: Math.ceil(searchDurationMs / TapOnElement.SEARCH_POLL_INTERVAL_MS),
        discardLateResult: false,
        signal,
        fetch: (remainingTimeMs) =>
          this.tapVerificationRefresh({
            refresh: options.verification?.refresh,
            screenSize: latestScreenSize,
            signal,
          })(remainingTimeMs),
        accept: (refreshedHierarchy) => {
          latestScreenSize = this.getScreenSizeFromHierarchy(refreshedHierarchy, {
            observationScreenSize: latestScreenSize,
            display: latestViewHierarchy,
          });
          latestViewHierarchy = refreshedHierarchy;
          const hash = this.hashViewHierarchy(refreshedHierarchy);
          if (hash && hash !== lastHash) {
            changeCount += 1;
            lastHash = hash;
          } else if (hash && !lastHash) {
            changeCount += 1;
            lastHash = hash;
          }

          const searchResult = this.findElementForSearch(
            {
              ...options,
              screenSizeOptions: {
                observationScreenSize: latestScreenSize,
                display: latestViewHierarchy,
              },
            },
            refreshedHierarchy,
          );
          selection = searchResult.selection;
          element = selection.element;
          containerFoundEver = containerFoundEver || searchResult.containerFound;
          if (!element && selection.matchedElement) {
            visibilityError = invisibleError();
          }
          if (
            element &&
            this.isElementTapTargetOffScreen(
              selection,
              refreshedHierarchy,
              latestScreenSize,
              options,
            )
          ) {
            visibilityError = invisibleError();
            logger.warn(
              `[TapOnElement] Element found but tap target is off-screen, retrying. ` +
                `bounds=${JSON.stringify(element.bounds)}`,
            );
            selection = { ...selection, element: null };
            element = null;
            offScreenRejections += 1;
            return false;
          }
          return element !== null;
        },
      });
      requestCount = polled.requestCount;
    }

    if (this.isPrototypeWindowPending(options, latestViewHierarchy)) {
      scopeHierarchyForSelector(latestViewHierarchy, options.layer);
    }

    if (offScreenRejections > 0 && !element) {
      logger.warn(
        `[TapOnElement] Element was found ${offScreenRejections} time(s) but had no visible tap area. ` +
          "Scroll it into view before retrying.",
      );
    }

    const stats: SearchUntilStats = {
      durationMs: Math.max(0, Math.round(this.timer.now() - startTime)),
      requestCount,
      changeCount,
    };

    return {
      selection,
      viewHierarchy: latestViewHierarchy,
      containerFound: containerFoundEver,
      stats,
      // `latestViewHierarchy` only diverges from the caller's `viewHierarchy`
      // when a refresh-loop iteration replaced it with a live device re-capture;
      // the target being present in the initial hierarchy returns it unchanged.
      refreshedFromDevice: latestViewHierarchy !== viewHierarchy,
      ...(visibilityError && !element ? { visibilityError } : {}),
    };
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

  private async handleElementNotFound(
    options: TapOnElementOptions,
    observeResult?: ObserveResult,
    containerFound: boolean = true,
    signal?: AbortSignal,
    selection?: ElementSelectionResult,
  ): Promise<never> {
    if (options.container && !containerFound) {
      const containerLabel = options.container.elementId
        ? `elementId '${options.container.elementId}'`
        : `text '${options.container.text}'`;
      throw new ActionableError(
        options.container.elementId?.startsWith("s2-")
          ? `Container element id '${options.container.elementId}' is stale; re-observe and use the id from the new observation.`
          : `Container element not found with provided ${containerLabel}`,
      );
    }

    const containerHint = options.container
      ? ` within container ${options.container.elementId ? `elementId '${options.container.elementId}'` : `text '${options.container.text}'`}`
      : "";

    let baseError: string;
    if (options.sibling && options.text) {
      baseError = `No clickable sibling found next to element with text '${options.text}'${containerHint}`;
    } else if (options.sibling && options.elementId) {
      baseError = `No clickable sibling found next to element with elementId '${options.elementId}'${containerHint}`;
    } else if (options.text) {
      baseError = `Element not found with provided text '${options.text}'${containerHint}`;
    } else if (options.textAny) {
      baseError = `Element not found with any provided text '${options.textAny.join("', '")}'${containerHint}`;
    } else if (options.testTag) {
      baseError = `Element not found with provided testTag '${options.testTag}'${containerHint}`;
    } else if (options.accessibilityLink) {
      baseError = `Element not found with provided accessibilityLink '${options.accessibilityLink}'${containerHint}`;
    } else {
      baseError = options.elementId?.startsWith("s2-")
        ? `Element id '${options.elementId}' is stale; re-observe and use the id from the new observation.${containerHint}`
        : `Element not found with provided elementId '${options.elementId}'${containerHint}`;
    }

    if (selection?.onlyKeyboardKeyMatch) {
      throw new TapTargetUnavailableError(
        `${baseError}. The only match is a soft-keyboard key, which observe does not list; ` +
          "use sendKeys or pressButton to drive the keyboard, or dismiss the keyboard first.",
        "not-found",
      );
    }

    if (this.visionConfig.enabled && observeResult) {
      logger.info("🔍 Element not found after polling, trying vision fallback...");
      const enrichedMsg = await getVisionEnrichedError(
        this.screenshotCapturer,
        observeResult.viewHierarchy,
        {
          text: options.text ?? options.textAny?.join(" | "),
          resourceId: options.elementId,
          description: `Interactive element for tapping (action: ${options.action})`,
        },
        this.visionConfig,
        baseError,
        signal,
        this.visionAnalyzer,
      );
      throw new TapTargetUnavailableError(enrichedMsg, "not-found");
    }

    throw new TapTargetUnavailableError(baseError, "not-found");
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
    if (options.ensureChecked === undefined) {
      return undefined;
    }
    if (!isTruthyFlag(element.checkable)) {
      const affordances = this.elementAffordances(element);
      throw new ActionableError(
        `tapOn ensureChecked requires a toggle element; ${this.elementIdentity(element)} has affordances: ${affordances.join(", ") || "none"}`,
      );
    }
    if (isTruthyFlag(element.checked) !== options.ensureChecked) {
      return undefined;
    }
    return {
      success: true,
      action: options.action,
      element,
      selectedElement,
      searchUntil,
      skipped: "already-checked",
    };
  }

  private async refreshEnsureCheckedSelection(
    options: TapVerificationOptions,
    observation: ObserveResult,
    selection: ElementSelectionResult,
    signal?: AbortSignal,
  ): Promise<{ selection: ElementSelectionResult; viewHierarchy: ViewHierarchyResult }> {
    if (options.ensureChecked === undefined) {
      return { selection, viewHierarchy: observation.viewHierarchy as ViewHierarchyResult };
    }
    const freshHierarchy = await this.tapVerificationRefresh({
      refresh: options.verification?.refresh,
      screenSize: observation.screenSize,
      signal,
    })(POST_TAP_REFRESH_TIMEOUT_MS);
    if (!freshHierarchy) {
      throw new ActionableError("tapOn ensureChecked: unable to refresh toggle before tapping");
    }
    const refound = this.findElementInHierarchy(
      this.withObservationScreenSize(options, observation),
      freshHierarchy,
    ).selection;
    if (!refound.element) {
      throw new ActionableError("tapOn ensureChecked: toggle not found in fresh hierarchy");
    }
    this.replaceObservationHierarchy(observation, freshHierarchy, true);
    return { selection: refound, viewHierarchy: freshHierarchy };
  }

  private async ensureCheckedAfterTap(
    options: TapVerificationOptions,
    observation: ObserveResult,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (options.ensureChecked === undefined) {
      return undefined;
    }
    const readChecked = (): boolean | "not found" => {
      const refound = observation.viewHierarchy
        ? this.findElementInHierarchy(
            this.withObservationScreenSize(options, observation),
            observation.viewHierarchy,
          ).selection.element
        : undefined;
      return refound ? isTruthyFlag(refound.checked) : "not found";
    };
    let observed: boolean | "not found" = readChecked();
    if (observed !== options.ensureChecked) {
      observed = await this.pollEnsureCheckedAfterTap(
        readChecked,
        options.ensureChecked,
        observation,
        { signal, refresh: options.verification?.refresh },
      );
    }
    return observed === options.ensureChecked
      ? undefined
      : `tapOn ensureChecked: tapped element but checked is now ${observed} (expected ${options.ensureChecked})`;
  }

  private async applyEnsureCheckedResult(
    result: TapOnElementResult,
    options: TapVerificationOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    if (options.ensureChecked === undefined) {
      return;
    }
    const observation = result.observation;
    if (observation === undefined) {
      return;
    }
    const ensureCheckedError = await this.ensureCheckedAfterTap(options, observation, signal);
    if (ensureCheckedError !== undefined) {
      result.success = false;
      result.error = ensureCheckedError;
    }
  }

  private async pollEnsureCheckedAfterTap(
    readChecked: () => boolean | "not found",
    expected: boolean,
    observation: ObserveResult,
    context: { signal?: AbortSignal; refresh?: AndroidTapVerification["refresh"] } = {},
  ): Promise<boolean | "not found"> {
    const { signal } = context;
    const deadline = this.timer.now() + ENSURE_CHECKED_POLL_TIMEOUT_MS;
    let observed = readChecked();
    for (let attempt = 1; this.timer.now() < deadline; attempt++) {
      throwIfAborted(signal);
      const delayMs = Math.min(
        ensureCheckedPollBackoff.delayForAttempt(attempt),
        deadline - this.timer.now(),
      );
      await this.timer.sleep(delayMs);
      const remainingMs = deadline - this.timer.now();
      if (remainingMs <= 0) {
        break;
      }
      const freshHierarchy = await this.tapVerificationRefresh({
        refresh: context.refresh,
        screenSize: observation.screenSize,
        signal,
      })(Math.min(POST_TAP_REFRESH_TIMEOUT_MS, remainingMs));
      if (!freshHierarchy) {
        continue;
      }
      this.replaceObservationHierarchy(observation, freshHierarchy, true);
      observed = readChecked();
      if (observed === expected) {
        return observed;
      }
    }
    return observed;
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
    const liveSelection = await this.refreshEnsureCheckedSelection(
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
      this.ensureCheckedBeforeTap(
        options,
        selection.element,
        this.buildSelectedElementMetadata(selection),
        searchUntil,
      );
    if (checkedResult) {
      return { result: checkedResult };
    }
    if (this.strategy.shouldRunPreTapStability(options)) {
      const stable = await this.resolveAndroidStableTapTargetAfterRefreshes(
        options,
        target.observation,
        options.action,
        false,
        signal,
      );
      if (!stable.ok) {
        return { result: { success: false, error: stable.error } as TapOnElementResult };
      }
      this.replaceObservationHierarchy(target.observation, stable.viewHierarchy, true);
      hierarchy = stable.viewHierarchy;
      selection = { ...stable.selection, element: stable.tapElement };
      const stableCheckedResult = this.ensureCheckedBeforeTap(
        options,
        stable.selection.element ?? stable.tapElement,
        this.buildSelectedElementMetadata(selection),
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
    const selectedElement = this.buildSelectedElementMetadata(selection);
    const resolvedLayer = resolvedElementLayer(hierarchy, element, this.device.platform);
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
            ...this.geometry.getElementCenter(element),
          },
          resolvedLayer,
        );
      }
    }
    const visibleBounds = this.visibleTapBounds(
      selection,
      hierarchy,
      target.observation.screenSize,
      options,
    );
    const point =
      visibleBounds &&
      this.resolveVisibleTapPoint(element, hierarchy, visibleBounds, {
        options,
        screenSize: target.observation.screenSize,
      });
    if (!point) {
      throw new TapTargetUnavailableError(
        "Matched element has no visible tap area on selected display",
        this.tapPoints.visibilityFailureReason(selection, hierarchy, target.observation.screenSize),
      );
    }
    const preTapHash = options.retryIfNoChange ? this.hashViewHierarchy(hierarchy) : null;
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
    if (preTapHash && this.strategy.retryTapIfNoChange) {
      await this.retryTapIfNoChange(
        preTapHash,
        point,
        options.action,
        this.strategy.longPressDurationMs,
        element,
        {
          ...this.withObservationScreenSize(options, target.observation),
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
  private async resolveAndroidDisplayTalkBack(
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>,
  ): Promise<AndroidDisplayTalkBackState> {
    const warnings: string[] = [];
    const enabled = await this.strategy.isAccessibilityServiceEnabled((warning) =>
      warnings.push(warning),
    );
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
      this.accessibilityService,
      this.adb,
      {
        action: options.action === "focus" ? "tap" : options.action,
        duration: options.duration,
      },
      {
        target: context.target,
        signal: context.signal,
        onDispatched: context.onDispatched,
        timer: this.timer,
        onWarning: context.onWarning,
        talkBack: context.talkBack.enabled
          ? {
              strategy: this.talkBackStrategy,
              driver: this.talkBackDriverFactory.createDriver(this.device),
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
      const selection = this.findElementInHierarchy(options, hierarchy).selection;
      if (selection.element) {
        return selection;
      }
      // Focus lookup filters out inert nodes. Reuse inspect lookup only to
      // report the editable-input error for a selector matching such a node.
      const inspected = this.findElementInHierarchy(
        { ...options, action: "tap" },
        hierarchy,
      ).selection;
      return inspected.element && !isFocusEditableElement(inspected.element)
        ? inspected
        : selection;
    }
    return this.findElementInHierarchy(options, hierarchy).selection;
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
        this.withObservationScreenSize(options, observation),
        observation.viewHierarchy,
      );
      if (selection.element) {
        return { selection, stats: { durationMs: 0, requestCount: 0, changeCount: 0 } };
      }
    }
    const outcome = await this.searchForElement(options, observation, signal);
    this.replaceObservationHierarchy(
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
        await this.handleElementNotFound(
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
              ...this.createErrorResult(options.action, errorMessage(error)),
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
      refreshTargetDisplayHierarchy(
        target,
        this.hierarchyCapture,
        timeoutMs,
        () =>
          this.staleDisplay(
            target.observation.display.generation ??
              this.displayTransitionReader.identityRevision(this.device.deviceId),
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
    const result: Awaited<ReturnType<TapOnElement["executeOnAndroidDisplay"]>> =
      await this.observedInteraction(
        async () => {
          const dispatchedResult = await this.executeOnAndroidDisplay(verificationOptions, {
            target,
            selection,
            signal,
            talkBack,
            onDispatched: () => {
              tapTimestamp = this.timer.now();
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
      this.checkPostActionDisplay(result, target.assertCurrent, signal);
      if (result.staleDisplay) {
        return this.unverifiableDisplayPostState(result, options);
      }
    }
    if (result.success && result.skipped !== "already-checked") {
      await this.applyEnsureCheckedResult(result, verificationOptions, signal);
    }
    return this.finalizeDisplayFocusResult(result, options, selection, target.observation);
  }

  private unverifiableDisplayPostState(
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
    result.focusVerified = this.verifyFocusedInputTarget(
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

  private async executeOnDisplay(
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
        const validationError = needsValidation ? this.validateOptions(options) : null;
        if (validationError) {
          return this.createErrorResult(options.action, validationError);
        }
        if (options.searchUntil !== undefined) {
          this.getSearchUntilDuration(options);
        }
        const target = await prepareTargetDisplayAction(
          this.device,
          display,
          this.observeScreen,
          this.adb,
          this.lastRenderedObservation,
          signal,
          this.displayTransitionReader,
        );
        if (this.device.platform === "android") {
          return await this.observedAndroidDisplayInteraction(options, {
            target,
            signal,
            onDispatchCompleted: () => {
              dispatchCompleted = true;
            },
          });
        }
      } catch (error) {
        this.rethrowObservationAbort(error, signal, dispatchCompleted);
        this.rethrowKeyboardOcclusion(error, options.action, recovery);
        logger.warn(`tapOn display routing failed: ${errorMessage(error)}`, error);
        const failure = this.completedDisplayFailure(error, dispatchCompleted);
        return withStaleDisplay(
          this.createErrorResult(options.action, errorMessage(failure), failure),
          failure,
        );
      }
    }
    return undefined;
  }

  private didCompleteDisplayGesture(
    result: TapOnElementResult & { wasAlreadyFocused?: boolean },
    display?: string,
  ): boolean {
    return display !== undefined && result.success && !result.skipped && !result.wasAlreadyFocused;
  }

  private completedDisplayFailure(error: unknown, dispatchCompleted: boolean): unknown {
    // Verification runs after the complete gesture block; in-block refusals and
    // partial multi-stroke failures keep their existing dispatch semantics.
    return dispatchCompleted && error instanceof StaleDisplayError
      ? new DispatchedObservationError(error)
      : error;
  }

  private rethrowKeyboardOcclusion(
    error: unknown,
    action: TapOnElementOptions["action"],
    recovery?: { throwOnKeyboardOcclusion?: boolean },
  ): void {
    if (
      recovery?.throwOnKeyboardOcclusion &&
      this.device.platform === "android" &&
      action === "focus" &&
      error instanceof KeyboardOcclusionError
    ) {
      logger.debug(`Tap on element awaits IME recovery: ${errorMessage(error)}`, error);
      throw error;
    }
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

      completedDisplayGesture = this.didCompleteDisplayGesture(result, options.display);
      if (options.display !== undefined && result.staleDisplay) {
        // Legacy/iOS display gestures must not finalize optional post-state
        // metadata or confirm focus/checked state from an invalidated capture.
        return this.unverifiableDisplayPostState(result, options);
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
      this.rethrowKeyboardOcclusion(error, requestedAction, recovery);
      logger.warn(`Tap on element failed: ${errorMessage(error)}`, error);
      const failure = this.completedDisplayFailure(error, completedDisplayGesture);
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
    const activation = await this.activateSemanticLink(
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
    const activation = await this.activateSemanticLink(
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
      await this.executeScopedAndroidTap({
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

  private async executeScopedAndroidTap(context: {
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
      const driver = this.talkBackDriverFactory.createDriver(this.device);
      const result =
        action === "tap"
          ? await this.talkBackStrategy.executePreciseTap(x, y, driver, fence)
          : await this.talkBackStrategy.executeCoordinateFallback(
              x,
              y,
              action as "doubleTap" | "longPress",
              durationMs,
              driver,
              { displayFence: fence },
            );
      if (result.success) {
        this.reportTalkBackActivationWarning(result, context, action);
        return;
      }
      await this.executeAndroidTapWithCoordinates(action, x, y, durationMs, element, signal, true, {
        displayFence: fence,
        onActivationWarning: context.onActivationWarning,
      });
      this.reportTalkBackActivationWarning(result, context, action);
      return;
    }
    await this.executeAndroidTapWithCoordinates(action, x, y, durationMs, element, signal, true, {
      displayFence: fence,
      onActivationWarning: context.onActivationWarning,
    });
  }

  /**
   * Execute tap using CtrlProxy's dispatchGesture API with ADB fallback.
   * dispatchGesture bypasses the ADB input pipeline, reducing ghost-tap rate.
   */
  private async executeAndroidTapWithCoordinates(
    action: string,
    x: number,
    y: number,
    durationMs: number,
    element: Element,
    signal?: AbortSignal,
    skipSemanticAction: boolean = false,
    fenceOptions: ResolvedAndroidTapOptions = {},
  ): Promise<void> {
    const fence = fenceOptions.displayFence;
    if (action === "tap") {
      if (
        !skipSemanticAction &&
        isAndroidDocumentsUiRow(element) &&
        (await this.tryDocumentsUiRowActivation(element, signal))
      ) {
        return;
      }
      await this.dispatchCoordinateTapOrAdbFallback(x, y, element, signal, { displayFence: fence });
    } else if (action === "longPress") {
      await this.executeAndroidLongPress(
        x,
        y,
        durationMs,
        element,
        signal,
        skipSemanticAction,
        fenceOptions,
      );
    } else if (action === "doubleTap") {
      await dispatchAndroidDoubleTap({
        // DocumentsUI rows use ADB input recovery, which has no single-gesture form.
        client: isAndroidDocumentsUiRow(element) ? undefined : this.accessibilityService,
        point: { x, y },
        timer: this.timer,
        signal,
        assertCurrent: () => fence?.assertCurrent(),
        onWarning: fenceOptions.onActivationWarning,
        tap: () =>
          this.dispatchCoordinateTapOrAdbFallback(x, y, element, signal, { displayFence: fence }),
      });
    }
  }

  /** Activate a DocumentsUI item through its advertised accessibility delegate (#6335). */
  private async tryDocumentsUiRowActivation(
    element: Element,
    signal?: AbortSignal,
  ): Promise<boolean> {
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
      if (!(await this.accessibilityService.supportsNodeActionSelectors(undefined, signal))) {
        return false;
      }
      throwIfAborted(signal);
      const result = await this.accessibilityService.requestNodeAction(
        "click",
        selector,
        undefined,
        undefined,
        signal,
      );
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

  /** Use input recovery for DocumentsUI rows when semantic activation is unavailable. */
  private async dispatchCoordinateTapOrAdbFallback(
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
        this.accessibilityService,
        this.adb,
        x,
        y,
        10,
        undefined,
        signal,
      );
      return;
    }
    logger.info(`[TapOnElement] Using ADB input recovery for DocumentsUI row at (${x}, ${y})`);
    // Once beforeSend lands, also pass this as the dispatch's beforeSend.
    fence?.assertCurrent();
    await executeTouchscreenInput(this.adb, `tap ${x} ${y}`, undefined, signal);
  }

  /**
   * After a tap, check if the view hierarchy changed. If unchanged, retry the tap once.
   * Only called when retryIfNoChange is true.
   */
  private resolveEnsureCheckedRetryTarget(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
    action: string,
    requireResourceId: boolean,
  ): Element | null {
    const refound = this.findElementInHierarchy(options, hierarchy).selection.element;
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
    return this.resolveTapTargetElement(refound, hierarchy, action, {
      requireResourceId,
      scoped: options.container !== undefined,
    }).element;
  }

  private withRetryScreenSize(
    options: TapVerificationOptions,
    screenSize: ObserveResult["screenSize"],
  ): TapVerificationOptions {
    return {
      ...options,
      screenSizeOptions: options.screenSizeOptions ?? { observationScreenSize: screenSize },
    };
  }

  private refreshedRetrySelection(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
    tapElement: Element,
    previous?: ElementSelectionResult,
  ): ElementSelectionResult {
    if (options.text || options.textAny?.length || options.elementId || options.testTag) {
      return this.findElementInHierarchy(options, hierarchy).selection;
    }
    return (
      previous ?? { element: tapElement, indexInMatches: -1, totalMatches: 1, strategy: "first" }
    );
  }

  private resolveRefreshedRetryTarget(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
    action: string,
    isTalkBackEnabled: boolean,
    selection: ElementSelectionResult,
    previousTarget: Element,
  ): Element | null {
    if (options.ensureChecked !== undefined) {
      return this.resolveEnsureCheckedRetryTarget(options, hierarchy, action, isTalkBackEnabled);
    }
    if (selection.element) {
      return this.resolveTapTargetElement(selection.element, hierarchy, action, {
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

  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  // oxlint-disable-next-line max-params -- Preserve positional callers by appending the optional display fence.
  async retryTapIfNoChange(
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
  ): Promise<void> {
    const probe = await checkAndroidTapHierarchyChange(
      this.timer,
      this.tapVerificationRefresh({ refresh: options.verification?.refresh, screenSize, signal }),
      (hierarchy) => this.hashViewHierarchy(hierarchy),
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

    const retryOptions = this.withRetryScreenSize(options, screenSize);
    const refreshedSelection = this.refreshedRetrySelection(
      retryOptions,
      probe.hierarchy,
      tapElement,
      selection,
    );
    const retryTarget = this.resolveRefreshedRetryTarget(
      retryOptions,
      probe.hierarchy,
      action,
      isTalkBackEnabled,
      refreshedSelection,
      tapElement,
    );
    if (!retryTarget) {
      return;
    }
    const retryScreenSize = this.getScreenSizeFromHierarchy(
      probe.hierarchy,
      retryOptions.screenSizeOptions,
    );
    const retryBounds = this.visibleTapBounds(
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
      : this.resolveVisibleTapPoint(retryTarget, probe.hierarchy, retryBounds, {
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

    await this.timer.sleep(PRE_RETRY_DELAY_MS);

    if (options.verification?.dispatch) {
      await options.verification.dispatch(retryPoint);
      return;
    }
    await this.executeAndroidTap(
      action,
      retryPoint.x,
      retryPoint.y,
      longPressDuration,
      retryTarget,
      signal,
      { ...options, resolvedHierarchy: probe.hierarchy },
      isTalkBackEnabled,
    );
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

  /**
   * Execute iOS-specific tap operations using CtrlProxy iOS
   * @param action - The tap action to perform
   * @param x - X coordinate
   * @param y - Y coordinate
   * @param durationMs - Long press duration in milliseconds
   * @param element - The target element (for VoiceOver label resolution)
   * @param isVoiceOverEnabled - Whether VoiceOver is active
   */
  // oxlint-disable-next-line max-params -- Preserve positional callers by appending the optional display fence.
  private async executeiOSTap(
    action: string,
    x: number,
    y: number,
    durationMs: number,
    element?: Element,
    isVoiceOverEnabled?: boolean,
    fenceOptions: IosTapOptions = {},
  ): Promise<void> {
    if (isVoiceOverEnabled && element) {
      await this.executeIOSTapWithVoiceOver(action, element, x, y, durationMs, fenceOptions);
      return;
    }

    await this.executeiOSTapWithCoordinates(action, x, y, durationMs, fenceOptions);
  }

  /**
   * Execute iOS tap using coordinate-based input (standard mode)
   */
  private async executeiOSTapWithCoordinates(
    action: string,
    x: number,
    y: number,
    durationMs: number,
    fenceOptions: IosTapOptions = {},
  ): Promise<void> {
    const { displayFence: fence, signal } = fenceOptions;
    // Use short duration (50ms) for tap/doubleTap, full duration for longPress
    const tapDuration = action === "longPress" ? durationMs : 50;

    const client = IOSCtrlProxyClient.getInstance(this.device);

    if (action === "doubleTap") {
      fence?.assertCurrent();
      await dispatchIosDoubleTap(client, x, y, tapDuration, undefined, { signal });
      IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache();
    } else {
      // Single tap or long press
      // Once beforeSend lands, also pass this as the dispatch's beforeSend.
      fence?.assertCurrent();
      await dispatchIosCoordinateTap(client, x, y, tapDuration, undefined, { signal });
      IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache();
    }
  }

  /** VoiceOver activation with a coordinate-tap fallback; see {@link tapViaVoiceOver}. */
  private executeIOSTapWithVoiceOver(
    action: string,
    element: Element,
    x: number,
    y: number,
    durationMs: number,
    fenceOptions?: IosTapOptions,
  ): Promise<void> {
    return tapViaVoiceOver({
      device: this.device,
      action,
      element,
      point: { x, y },
      durationMs,
      fenceOptions: fenceOptions ?? {},
      coordinateTap: (opts) => this.executeiOSTapWithCoordinates(action, x, y, durationMs, opts),
    });
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

  // oxlint-disable-next-line max-params -- Preserve positional callers by appending the optional display fence.
  private async executeAndroidLongPress(
    x: number,
    y: number,
    durationMs: number,
    element: Element,
    signal?: AbortSignal,
    skipSemanticAction: boolean = false,
    fenceOptions: ResolvedAndroidTapOptions = {},
  ): Promise<void> {
    const fence = fenceOptions.displayFence;
    throwIfAborted(signal);
    if (!skipSemanticAction) {
      const selector = stableNodeSelectorForElement(element);
      if (
        selector &&
        (await this.trySemanticAndroidLongPress(element, selector, signal, fenceOptions))
      ) {
        return;
      }
    }

    await dispatchAndroidLongPress({
      adb: this.adb,
      x,
      y,
      durationMs,
      signal,
      assertCurrent: fence ? () => fence.assertCurrent() : undefined,
      logTag: "TapOnElement",
    });
  }

  private throwIfLongPressInterrupted(
    error: unknown,
    durationMs: number,
    signal?: AbortSignal,
  ): void {
    throwIfLongPressInterrupted(error, durationMs, signal);
  }

  private semanticAndroidLongPressTargetError(
    selector: NonNullable<ReturnType<typeof stableNodeSelectorForElement>>,
    signal?: AbortSignal,
    options: ResolvedAndroidTapOptions = {},
  ): Promise<string | undefined> {
    // Raw search resolves against a filtered projection that may omit duplicate IDs.
    // Default extraction matches the cached tree already accepted by this guard.
    const resolvedHierarchy = resolveViewHierarchyForSearch(options.resolvedHierarchy);
    return nodeActionTargetError(selector, {
      supportsNodeActionSelectors: () => this.accessibilityService.supportsNodeActionSelectors(),
      getAccessibilityHierarchy: () =>
        resolvedHierarchy
          ? Promise.resolve(resolvedHierarchy)
          : this.accessibilityService.getAccessibilityHierarchy(
              undefined,
              undefined,
              true,
              undefined,
              true,
              signal,
            ),
    });
  }

  private async trySemanticAndroidLongPress(
    element: Element,
    selector: NonNullable<ReturnType<typeof stableNodeSelectorForElement>>,
    signal?: AbortSignal,
    options: ResolvedAndroidTapOptions = {},
  ): Promise<boolean> {
    const needsNodeSelector = requiresNodeSelector(selector);
    const targetError = await this.semanticAndroidLongPressTargetError(selector, signal, options);
    // The hierarchy reader turns cancellation into null; never degrade it to a press.
    throwIfAborted(signal);
    if (targetError) {
      logger.info(`[TapOnElement] ${targetError}; using coordinate long press`);
      return false;
    }

    try {
      const result = needsNodeSelector
        ? await this.accessibilityService.requestNodeAction("long_click", selector)
        : await this.accessibilityService.requestAction("long_click", selector.resourceId);
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
          this.accessibilityService.getAccessibilityHierarchy(
            undefined,
            undefined,
            true,
            undefined,
            true,
            signal,
          ),
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

  private detectLongPressMetadata(
    previousObservation: ObserveResult | null,
    currentObservation?: ObserveResult,
  ): LongPressMetadata {
    return this.longPressMetadataDetector.detect(previousObservation, currentObservation);
  }
}

/**
 * An iOS capture merges the in-app SDK snapshot into the XCUITest tree, and SDK views
 * no XCUITest node matched are injected beside it (`sdk.source=sdkWalker`). After an
 * interaction that snapshot can carry the owner's view again (the UITextView behind a
 * UILink owner), so the resource-id shows up on SDK copies too (#10843). The runner
 * resolves the owner among XCUITest elements, so when XCUITest captured the identifier,
 * the SDK copies are duplicates of it and must not make the owner ambiguous. With no
 * captured node, keep every candidate so an SDK-only identifier is still counted.
 */
function preferCapturedOwners(candidates: Element[]): Element[] {
  const captured = candidates.filter((element) => {
    const source = getHierarchyNodeSource(element);
    return !source || !isSdkInjectedNode(source);
  });
  return captured.length > 0 ? captured : candidates;
}
