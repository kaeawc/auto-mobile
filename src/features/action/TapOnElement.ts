import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import { resolveVoiceOverActivateCtrlProxyTimeoutMs } from "./gestureTransportTimeout";
import { resolveIosObserveRotation } from "../observe/iosObserveRotation";
import {
  type DisplayFence,
  type DisplayFenceOption,
  type DisplayFenceDependencies,
} from "./BaseVisualChange";
import { withStaleDisplay, StaleDisplayError } from "../../models/StaleDisplayError";
import { unsupportedPlatformError } from "../../models/ActionableError";
import { KeyboardOcclusionError } from "../../models/KeyboardOcclusionError";
import {
  ElementResolver,
  isFocusEditableElement,
  promoteClickableAncestor,
} from "../utility/ElementResolver";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import {
  DefaultHierarchyCapture,
  getHierarchySnapshot,
  type HierarchyCapture,
} from "../observe/HierarchyCapture";
import { errorMessage } from "../../utils/describeUnknownError";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
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
  ElementBounds,
  ElementSelectionResult,
  ObserveResult,
  TapOnElementResult,
  TapOnSelectedElement,
  ViewHierarchyResult,
} from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { ElementFinder, TextSelectionIntent } from "../../utils/interfaces/ElementFinder";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import { DefaultElementParser } from "../utility/ElementParser";
import { DefaultElementFinder } from "../utility/ElementFinder";
import {
  DefaultElementGeometry,
  screenSizeForOffscreenCheck,
  isUsableScreenSize,
  type ScreenSizeForOffscreenCheckOptions,
} from "../utility/ElementGeometry";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
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
import { MAX_SETTIMEOUT_DELAY_MS, type Timer } from "../../utils/SystemTimer";
import { hierarchyFingerprint } from "../../utils/hierarchyFingerprint";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { serverConfig } from "../../utils/ServerConfig";
import { refreshAndroidViewHierarchy } from "./refreshAndroidViewHierarchy";
import {
  boundsArea,
  boundsEqual,
  boundsNearlyEqual,
  horizontalExtentNearlyEqual,
} from "../../utils/bounds";
import { androidPreTapConsecutiveStableMatchesRequired } from "./androidPreTapStablePolicy";
import { isAndroidDocumentsUiRow } from "./androidCoordinateTapPolicy";
import { androidViewHierarchyIndicatesLikelyBlockingLoading } from "../../utils/androidTransientLoading";
import {
  getToggleContentDescription,
  hasAccessibilityAction,
  isTruthyFlag,
} from "../utility/elementProperties";
import {
  requiresNodeSelector,
  stableNodeSelectorForElement,
  TalkBackTapStrategy,
  type ScreenReaderNavigationResult,
} from "../talkback/TalkBackTapStrategy";
import {
  DefaultTalkBackNavigationDriverFactory,
  type TalkBackNavigationDriverFactory,
} from "../talkback/TalkBackNavigationDriver";
import type { IosVoiceOverDetector } from "../accessibility/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../accessibility/IosVoiceOverDetector";
import type { TapStrategy } from "../../utils/interfaces/TapStrategy";
import { FeatureFlagService } from "../featureFlags/FeatureFlagService";
import { createTapStrategy } from "./strategies/createTapStrategy";
import { LongPressMetadataDetector, type LongPressMetadata } from "./LongPressMetadataDetector";
import { RealWaitForCondition } from "../observe/WaitForCondition";
import type {
  WaitForCondition,
  WaitForConditionResult,
} from "../observe/interfaces/WaitForCondition";
import { hierarchyUpdatedAtToMillis } from "../observe/observeTimestamp";
import { sequenceBackoff } from "../../utils/Backoff";
import {
  androidDisplayTapDispatch,
  dispatchAndroidCoordinateTap,
  dispatchIosCoordinateTap,
} from "./coordinateTapDispatch";
import { executeTouchscreenInput } from "./touchscreenInput";
import {
  refreshTargetDisplayHierarchy,
  prepareTargetDisplayAction,
  type RenderedObservationReader,
} from "./TargetDisplayAction";
import { createDeviceHierarchyCapture } from "../observe/DeviceHierarchyCapture";
import {
  checkAndroidTapHierarchyChange,
  POST_TAP_REFRESH_TIMEOUT_MS,
  PRE_RETRY_DELAY_MS,
} from "./androidGhostTapRetry";
import { DefaultObserveElementCollector } from "../observe/ObserveElementCollector";
import {
  getImeOccluderForElement,
  getIosImeOccluder,
  tapPointOutsideIme,
} from "../observe/output/SkeletonProjection";
import { getHierarchyNodeSource } from "../observe/output/elementProvenance";
import { getScreenBounds } from "../../utils/screenBounds";
import { compareSelectionRank } from "../utility/selectionRank";
import { clipIosChromeBounds, isIosTapPointCoveredByChrome } from "./swipeon/iosChromeInsets";

function intersectTapBounds(a: ElementBounds, b: ElementBounds): ElementBounds | null {
  const bounds = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return bounds.left < bounds.right && bounds.top < bounds.bottom ? bounds : null;
}

function pointInTapBounds(point: { x: number; y: number }, bounds: ElementBounds): boolean {
  return (
    point.x >= bounds.left &&
    point.x < bounds.right &&
    point.y >= bounds.top &&
    point.y < bounds.bottom
  );
}

function hasTapArea(bounds: ElementBounds | undefined): bounds is ElementBounds {
  return !!bounds && bounds.left < bounds.right && bounds.top < bounds.bottom;
}

const IOS_STATUS_BAR_CLASSES = new Set([
  "XCUIElementTypeStatusBar",
  "UIStatusBar",
  "UIStatusBarWindow",
]);

/** Internal I/O seam: decisions and timing remain shared with the default tap path. */
interface AndroidTapVerification {
  refresh: (timeoutMs: number) => Promise<ViewHierarchyResult | null>;
  dispatch?: (point: { x: number; y: number }) => Promise<void>;
}

type TapVerificationOptions = TapOnElementOptions & {
  verification?: AndroidTapVerification;
  screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
};

interface TapPointContext {
  chromeElements?: readonly Element[];
  options: TapOnElementOptions;
  screenSize?: ObserveResult["screenSize"];
}

type SearchUntilStats = NonNullable<TapOnElementResult["searchUntil"]>;
type FocusIdentifierKey = "resource-id" | "view-id" | "test-tag";

const TEXT_SELECTION_INTENT_BY_ACTION: Record<TapOnElementOptions["action"], TextSelectionIntent> =
  {
    tap: "tap",
    doubleTap: "tap",
    longPress: "tap",
    focus: "focus-input",
  };

/** Prefer the exact parsed node when geometry and public IDs collide across windows. */
function findTapTargetNode(
  nodes: readonly SearchableEntry[],
  element: Element,
): SearchableEntry | undefined {
  const source = getHierarchyNodeSource(element);
  return (
    (source && nodes.find((node) => node.source === source)) ??
    nodes.find(
      (node) =>
        node.element &&
        node.bounds &&
        boundsEqual(node.bounds, element.bounds) &&
        node.nativeId === element["resource-id"] &&
        node.nodeKey === element["view-id"],
    )
  );
}

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

/**
 * Post-tap observation budgets used by retryTapIfNoChange to decide whether
 * a tap registered.
 *
 * Activity transitions commonly take 1-2s on contended emulators (emulator.wtf),
 * and the CtrlProxy WebSocket push for the new hierarchy doesn't arrive until
 * after the destination renders. With tighter budgets the post-tap refresh
 * races the push and returns null/stale data during normal activity
 * transitions, which gets misread as a ghost tap and causes a stray retry on
 * the new screen.
 */
const POST_TAP_EFFECT_TIMEOUT_MS = 2500;
const ENSURE_CHECKED_POLL_BACKOFF_MS = [50, 100, 200, 400] as const;
const ensureCheckedPollBackoff = sequenceBackoff(ENSURE_CHECKED_POLL_BACKOFF_MS);
const ENSURE_CHECKED_POLL_TIMEOUT_MS = ENSURE_CHECKED_POLL_BACKOFF_MS.reduce(
  (total, delayMs) => total + delayMs,
  0,
);
const POST_TAP_EFFECT_POLL_MS = 150;

/**
 * Minimum wall-clock time a hierarchy-only post-tap frame must hold UNCHANGED
 * before it is accepted as the settled destination (issue #6284 P1). Activity
 * transitions commonly take 1–2 seconds, so a transient hierarchy must stay
 * quiet for a full second before it is terminal evidence. This prevents a
 * routine delayed destination from being pre-empted by an intermediate frame
 * that merely survives the first few 150ms polls.
 */
const POST_TAP_SETTLE_QUIET_PERIOD_MS = 1000;

export const ANDROID_PRE_TAP_REFIND_BUDGET_MS = 2500;
export const ANDROID_PRE_TAP_REFIND_MIN_POLLS = 8;
export const ANDROID_PRE_TAP_REFIND_BUDGET_MS_WHEN_LOADING = 10000;

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
export type TapFocusFailure = "not-found" | "no-visible-tap-area" | "navigation-bar";
export type TapOnFocusResult = TapOnElementResult & { [tapFocusFailure]?: TapFocusFailure };

class TapTargetUnavailableError extends ActionableError {
  constructor(
    message: string,
    readonly reason: TapFocusFailure,
  ) {
    super(message);
  }
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

/**
 * Command to tap on UI element containing specified text
 */
export class TapOnElement extends BaseVisualChange implements TapPreTapStabilitySeam {
  private readonly refreshedDisplayTransitions: Pick<
    DisplayTransitionTracker,
    "checkIdentity" | "record"
  >;
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private finder: ElementFinder;
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

  /**
   * Android: the pre-tap refresh + re-find + stability loop keeps polling until BOTH
   * a minimum number of productive polls AND a wall-clock deadline are exceeded
   * (`refindAttempt >= minPolls && productiveElapsed >= budgetMs`).
   *
   * Two bounds, because neither alone is sufficient:
   * - The **wall-clock deadline** adds patience when fetches are fast: a fixed
   *   "N attempts × poll delay" budget expires in ~1.2s and can miss a list that
   *   repopulates a few seconds later (#1949).
   * - The **minimum productive-poll floor** prevents a regression in the opposite
   *   regime: on a slow device where each hierarchy fetch costs 300–800ms, a pure
   *   wall-clock budget would allow only ~3–5 polls, fewer than the old fixed 8.
   *   The floor guarantees we never poll *fewer* times than the previous
   *   attempt-count implementation, so this change is never less patient.
   *
   * Only *productive* polls count toward the floor and only *productive* wall-clock
   * counts toward the deadline: time spent recovering from "no hierarchy" responses
   * is excluded (see {@link ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE}).
   */
  private static readonly ANDROID_PRE_TAP_REFIND_BUDGET_MS = ANDROID_PRE_TAP_REFIND_BUDGET_MS;
  private static readonly ANDROID_PRE_TAP_REFIND_MIN_POLLS = ANDROID_PRE_TAP_REFIND_MIN_POLLS;

  /**
   * Extended deadline + poll floor (hard ceilings) applied when the tree shows a
   * blocking loading overlay (progress/shimmer). List rows can stay absent for
   * several seconds while content loads; give the re-find loop more wall-clock time
   * and more guaranteed polls before aborting.
   */
  private static readonly ANDROID_PRE_TAP_REFIND_BUDGET_MS_WHEN_LOADING =
    ANDROID_PRE_TAP_REFIND_BUDGET_MS_WHEN_LOADING;
  private static readonly ANDROID_PRE_TAP_REFIND_MIN_POLLS_WHEN_LOADING = 32;

  /**
   * Defensive upper bound on total loop iterations (productive + no-hierarchy +
   * deadline-grace). Real scenarios terminate far sooner via the deadline/floor,
   * the {@link ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE} cap, or finding the
   * target; this only guards against a future refactor making the loop spin when
   * the injected timer stops advancing.
   */
  private static readonly ANDROID_PRE_TAP_MAX_ITERATIONS = 1000;

  /**
   * Separate budget for consecutive "ctrl-proxy returned no hierarchy" results.
   * When the accessibility service WebSocket is temporarily unresponsive, these
   * shouldn't consume the normal refind attempts (the element is likely still there).
   */
  private static readonly ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE = 12;

  /**
   * Longer backoff when ctrl-proxy returns no hierarchy — gives the WebSocket
   * time to recover rather than hammering it every 150ms.
   */
  private static readonly ANDROID_PRE_TAP_NO_HIERARCHY_DELAY_MS = 500;

  private static readonly ANDROID_PRE_TAP_REFIND_DELAY_MS = 150;

  private static readonly ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS = 800;

  private static readonly ANDROID_PRE_TAP_BOUNDS_EPSILON_PX = 3;

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
    this.finder = new DefaultElementFinder();
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
              undefined,
              true,
              request.minTimestamp,
              request.signal,
              request.timeoutMs,
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
              request.timeoutMs ?? TapOnElement.ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS,
              undefined,
              request.signal,
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
    return markFocusFailure(
      action,
      {
        success: false,
        action: action,
        error,
        element: {
          bounds: { left: 0, top: 0, right: 0, bottom: 0 },
        } as Element,
      },
      cause,
    );
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

    if (options.container) {
      const containerSelectorCount = [options.container.elementId, options.container.text].filter(
        Boolean,
      ).length;
      if (containerSelectorCount !== 1) {
        return "tapOn container must specify exactly one of elementId or text";
      }
    }

    return this.validateSemanticLinkOptions(options);
  }

  private validateSemanticLinkOptions(options: TapOnElementOptions): string | null {
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

  private resolveTapPoint(element: Element): { x: number; y: number } {
    return this.geometry.getElementCenter(element);
  }

  private getImeOccluderForTap(
    element: Element,
    hierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ) {
    const platform = this.device.platform;
    if (platform !== "android" && platform !== "ios") {
      return undefined;
    }
    const elements = new DefaultObserveElementCollector().collect(hierarchy, platform);
    const ime = elements && getImeOccluderForElement(elements, element);
    return ime && platform === "ios" ? getIosImeOccluder(ime, screenSize) : ime;
  }

  private resolveImeSafeTapPoint(
    element: Element,
    hierarchy: ViewHierarchyResult,
    { options, screenSize }: TapPointContext,
  ): { x: number; y: number } {
    const ime = this.getImeOccluderForTap(element, hierarchy, screenSize);
    if (!ime) {
      return this.resolveTapPoint(element);
    }
    const { left, top, right, bottom } = element.bounds;
    const point = tapPointOutsideIme([left, top, right, bottom], ime.bounds);
    if (point) {
      return point;
    }
    const elementLabel = element.text ?? element["content-desc"] ?? element["resource-id"];
    const focusTarget = this.describeFocusTarget(element, options);
    const selectorLabel =
      focusTarget !== "the matched element"
        ? focusTarget
        : JSON.stringify(
            options.elementId ?? options.testTag ?? options.accessibilityLink ?? "element",
          );
    const label = JSON.stringify(elementLabel) ?? selectorLabel;
    throw new KeyboardOcclusionError(
      `Target ${label} is covered by the soft keyboard; dismiss the keyboard first.`,
    );
  }

  private async activateSemanticLink(
    text: string,
    occurrence: number,
    owner?: Element,
    viewHierarchy?: ViewHierarchyResult,
  ): Promise<{ success: boolean; error?: string }> {
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
      );
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
      ).requestActivateAccessibilityLink(text, occurrence, ownerResourceId as string | undefined);
      this.invalidateIosCacheOnSuccess(result);
      return { success: result.success, error: result.error };
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
    // The owner is resolved (ElementFinder) and natively activated across every
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
        elements.filter((element) => element["resource-id"] === ownerResourceId).length === 1
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
    const duration = options.searchUntil?.duration ?? TapOnElement.SEARCH_UNTIL_DEFAULT_MS;

    if (!Number.isFinite(duration)) {
      throw new ActionableError("searchUntil.duration must be a number");
    }

    if (duration < TapOnElement.SEARCH_UNTIL_MIN_MS) {
      throw new ActionableError(
        `searchUntil.duration must be at least ${TapOnElement.SEARCH_UNTIL_MIN_MS}ms`,
      );
    }

    if (duration > TapOnElement.SEARCH_UNTIL_MAX_MS) {
      throw new ActionableError(
        `searchUntil.duration must be at most ${TapOnElement.SEARCH_UNTIL_MAX_MS}ms`,
      );
    }

    return Math.round(duration);
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
      // transition. Wait for an actual post-tap difference instead of treating
      // that transient stability as proof that the tap had no effect.
      return this.waitForPostTapChange(previousObservation, currentObservation, signal);
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
    return this.settleHierarchyOnlyChange(previousObservation, currentObservation, signal);
  }

  /**
   * The first post-tap observation showed no change against the baseline yet.
   * Poll (via the injected waiter/FakeTimer seam) for an actual post-tap
   * difference, then route a hierarchy-only result through the same settle step
   * a first-frame hierarchy change takes (issue #6284) rather than trusting the
   * first differing poll as terminal.
   */
  private async waitForPostTapChange(
    previousObservation: ObserveResult,
    currentObservation: ObserveResult,
    signal?: AbortSignal,
  ): Promise<{ effect: TapOnElementResult["effect"]; observation: ObserveResult }> {
    const effectObservation = await this.waitForCondition.execute(
      (observation) => ({
        matched: this.deriveTapEffect(previousObservation, observation)?.screenChanged === true,
      }),
      {
        // The predicate reads activeWindow, which needs per-poll back-stack reconciliation.
        readBackStackEachPoll: true,
        timeoutMs: POST_TAP_EFFECT_TIMEOUT_MS,
        pollMs: POST_TAP_EFFECT_POLL_MS,
        signal,
        // One clock domain end-to-end (issue #6284): seed the poll floor from
        // the device-authored `updatedAt` of the capture we already hold, not
        // the host clock, so a device whose clock trails the daemon still
        // clears the floor with a genuinely fresh repeat capture.
        initialMinTimestampMs: hierarchyUpdatedAtToMillis(currentObservation.viewHierarchy),
      },
    );
    const effect = this.deriveTapEffect(previousObservation, effectObservation.observation);
    if (!effectObservation.matched && effect?.screenChanged !== true) {
      return { effect, observation: currentObservation };
    }
    if (effect?.basis === "viewHierarchy changed") {
      return this.settleHierarchyOnlyChange(
        previousObservation,
        effectObservation.observation,
        signal,
      );
    }
    return {
      effect,
      observation: {
        ...effectObservation.observation,
        gfxMetrics: effectObservation.observation.gfxMetrics ?? currentObservation.gfxMetrics,
        perfTiming: effectObservation.observation.perfTiming ?? currentObservation.perfTiming,
      },
    };
  }

  /**
   * Confirm a hierarchy-only tap effect is the settled DESTINATION rather than a
   * transient intermediate mutation before trusting it as terminal (issue
   * #6284). Polls (via the injected waiter/FakeTimer seam) until either:
   *  - `activeWindow` changes vs the baseline — authoritative, stop at once; or
   *  - the hierarchy hash holds UNCHANGED for a real quiet period of wall-clock
   *    time (`POST_TAP_SETTLE_QUIET_PERIOD_MS`) — the transition has settled.
   *
   * Settlement is a wall-clock quiet-period DEADLINE, not a count of equal
   * comparisons, and that is what makes `baseline → A → A → B` reach B. A
   * comparison count treats the very first poll — taken immediately, with no
   * `pollMs` sleep yet elapsed — as if it proved stability, so a transient A
   * that persists just one interval before a delayed B would settle on A. The
   * deadline instead starts a clock when a hash first appears and accepts it
   * only once it has genuinely held for the quiet period; a B that arrives after
   * that interval resets the clock and is reached. A hierarchy-less (null-hash)
   * poll cannot start or extend a quiet period — it resets the run — so a run of
   * rootless captures never masquerades as a stable screen.
   *
   * Staleness robustness lives in the poll floor, NOT in this predicate and NOT
   * in `compareViewHierarchy`: the entering reference (seeded here from the
   * entering capture's `updatedAt`) forces every poll strictly past that
   * capture, so an unchanged hash across the quiet period is a genuinely-held
   * fresh screen — never a stale snapshot re-served masking a later fresh
   * destination. That keeps `compareViewHierarchy` a pure hash diff, so a stale
   * baseline can never block a legitimate same-window dialog diff (the
   * entanglement root of the earlier incremental attempt).
   */
  private async settleHierarchyOnlyChange(
    previousObservation: ObserveResult,
    currentObservation: ObserveResult,
    signal?: AbortSignal,
  ): Promise<{ effect: TapOnElementResult["effect"]; observation: ObserveResult }> {
    // Hash whose quiet period is currently being timed, and when that run began.
    let quietHash: string | null = null;
    let quietSinceMs = 0;
    const settled = await this.waitForCondition.execute(
      (observation) => {
        const activeWindowChanged =
          this.compareActiveWindow(previousObservation, observation)?.screenChanged === true;
        if (activeWindowChanged) {
          return { matched: true };
        }
        const currentHash = this.hashViewHierarchy(observation.viewHierarchy ?? null);
        const now = this.timer.now();
        if (currentHash === null) {
          // A hierarchy-less poll proves nothing about stability; reset the run.
          quietHash = null;
          return { matched: false };
        }
        if (currentHash !== quietHash) {
          // A new (or first) hash: start its quiet-period clock now. Never
          // settles on this frame — a real interval must elapse first.
          quietHash = currentHash;
          quietSinceMs = now;
          return { matched: false };
        }
        // Same hash as the run's start: accept only once it has genuinely held
        // for the full quiet period of wall-clock time.
        return { matched: now - quietSinceMs >= POST_TAP_SETTLE_QUIET_PERIOD_MS };
      },
      {
        // The predicate reads activeWindow, which needs per-poll back-stack reconciliation.
        readBackStackEachPoll: true,
        timeoutMs: POST_TAP_EFFECT_TIMEOUT_MS,
        pollMs: POST_TAP_EFFECT_POLL_MS,
        signal,
        // Device-clock-domain floor seed (issue #6284). See method doc.
        initialMinTimestampMs: hierarchyUpdatedAtToMillis(currentObservation.viewHierarchy),
      },
    );

    const effectObservation = this.resolveSettleTimeoutObservation(
      previousObservation,
      currentObservation,
      settled,
    );

    // Issue #6284: preserve the already-established `screenChanged: true` when
    // the settle poll's final observation is a DEFINITIVE screen-off terminal
    // (the device went to sleep mid-settle). That capture legitimately carries
    // no viewHierarchy, so re-deriving from scratch would find only an unchanged
    // `activeWindow` and flip the effect back to `screenChanged: false`,
    // erasing the transition that already entered this settle.
    const isDefinitiveScreenOffTerminal = settled.screenOff === true;
    const effect: TapOnElementResult["effect"] = isDefinitiveScreenOffTerminal
      ? { screenChanged: true, basis: "viewHierarchy changed" }
      : this.deriveTapEffect(previousObservation, effectObservation);
    return {
      effect,
      observation: {
        ...effectObservation,
        gfxMetrics: effectObservation.gfxMetrics ?? currentObservation.gfxMetrics,
        perfTiming: effectObservation.perfTiming ?? currentObservation.perfTiming,
      },
    };
  }

  /**
   * Which observation `settleHierarchyOnlyChange` should trust when its poll
   * timed out. A clean stop (or a screen-off terminal) always yields the poll's
   * final observation. On timeout, prefer the trusted entering change over a
   * final poll that is untrustworthy (explicitly stale, or carrying no
   * hierarchy) so a temporarily-unresponsive proxy doesn't erase a real,
   * already-observed change; otherwise the final poll is the freshest evidence.
   */
  private resolveSettleTimeoutObservation(
    previousObservation: ObserveResult,
    currentObservation: ObserveResult,
    settled: WaitForConditionResult,
  ): ObserveResult {
    const effectObservation = settled.observation;
    const finalPollIsDefinitiveScreenOff = settled.screenOff === true;
    if (!settled.timedOut || finalPollIsDefinitiveScreenOff) {
      return effectObservation;
    }
    const currentObservationIsTrustedChange =
      currentObservation.freshness?.isFresh !== false &&
      this.deriveTapEffect(previousObservation, currentObservation)?.screenChanged === true;
    const finalPollIsUntrustworthy =
      effectObservation.freshness?.isFresh === false ||
      this.hashViewHierarchy(effectObservation.viewHierarchy ?? null) === null;
    return currentObservationIsTrustedChange && finalPollIsUntrustworthy
      ? currentObservation
      : effectObservation;
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

  private isElementTapTargetOffScreen(
    selection: ElementSelectionResult,
    viewHierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
    options?: TapOnElementOptions,
  ): boolean {
    if (!isUsableScreenSize(screenSize)) {
      return false;
    }
    return !this.visibleTapBounds(selection, viewHierarchy, screenSize, options);
  }

  private invisibleMatchError(
    selection: ElementSelectionResult,
    options: TapOnElementOptions,
    hierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ): string {
    const matched = selection.matchedElement ?? selection.element;
    if (this.isCoveredByNavigationBar(selection, hierarchy, screenSize)) {
      return `Target ${JSON.stringify(matched?.text ?? options.text ?? options.elementId ?? "target")} is covered by the navigation bar; scroll it into view with swipeOn, then retry tapOn.`;
    }
    return (
      `Matched element ${JSON.stringify(matched?.text ?? options.text ?? options.elementId ?? "target")} ` +
      `has no visible tap area (bounds ${JSON.stringify(matched?.bounds)}). ` +
      "Scroll it into view with swipeOn, then retry tapOn."
    );
  }

  private visibilityFailureReason(
    selection: ElementSelectionResult,
    hierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ): TapFocusFailure {
    return this.isCoveredByNavigationBar(selection, hierarchy, screenSize)
      ? "navigation-bar"
      : "no-visible-tap-area";
  }

  private invisibleMatchFailure(
    selection: ElementSelectionResult,
    options: TapOnElementOptions,
    hierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
    fallback?: string,
  ): TapTargetUnavailableError {
    const reason = this.visibilityFailureReason(selection, hierarchy, screenSize);
    return new TapTargetUnavailableError(
      reason === "navigation-bar" || !fallback
        ? this.invisibleMatchError(selection, options, hierarchy, screenSize)
        : fallback,
      reason,
    );
  }

  private navigationTapBounds(
    bounds: ElementBounds,
    hierarchy: ViewHierarchyResult,
    screenSize: ObserveResult["screenSize"] | undefined,
    elements: readonly Element[],
  ): ReturnType<typeof clipIosChromeBounds> {
    if (this.device.platform !== "ios" || !isUsableScreenSize(screenSize)) {
      return { bounds };
    }
    return clipIosChromeBounds({
      bounds,
      hierarchy,
      screen: screenSize,
      elements,
      regions: ["navigation bar"],
      forTapTarget: true,
    });
  }

  private isCoveredByNavigationBar(
    selection: ElementSelectionResult,
    hierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ): boolean {
    const target = selection.element ?? selection.matchedElement;
    if (!target) {
      return false;
    }
    const matched = selection.matchedElement ?? target;
    const overlap = intersectTapBounds(target.bounds, matched.bounds);
    return (
      !!overlap &&
      !!this.navigationTapBounds(overlap, hierarchy, screenSize, [matched, target]).coveredBy
    );
  }

  private visibleTapBounds(
    selection: ElementSelectionResult,
    hierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
    options?: TapOnElementOptions,
    tapTarget?: Element,
  ): ElementBounds | null {
    const target = tapTarget ?? selection.element;
    if (!target?.bounds) {
      return null;
    }
    const matched = this.matchedTapElement(selection, target, options);
    const matchedBounds = matched.bounds;
    const matchForTap = hasTapArea(matchedBounds) ? matched : target;
    let visible = intersectTapBounds(target.bounds, matchForTap.bounds);
    // Legacy captures without dimensions still constrain the matched/actionable overlap.
    if (!visible || !isUsableScreenSize(screenSize)) {
      return visible;
    }
    visible = intersectTapBounds(visible, getScreenBounds(screenSize, undefined, true));
    if (!visible || this.device.platform !== "ios") {
      return visible;
    }
    const belowChrome = clipIosChromeBounds({
      bounds: visible,
      hierarchy,
      screen: screenSize,
      elements: [matchForTap, target],
      forTapTarget: true,
    }).bounds;
    const belowStatusBar =
      belowChrome &&
      this.clipBelowStatusBar(belowChrome, matchForTap, target, hierarchy, screenSize);
    return belowStatusBar
      ? this.clipBelowTabBars(belowStatusBar, matchForTap, target, hierarchy, screenSize)
      : null;
  }

  private matchedTapElement(
    selection: ElementSelectionResult,
    target: Element,
    options?: TapOnElementOptions,
  ): Element {
    // Sibling selectors act on a different node from their anchor; focus
    // selectors may similarly promote a label to its editable field.
    return options?.sibling || options?.action === "focus"
      ? target
      : (selection.matchedElement ?? target);
  }

  private resolveVisibleTapPoint(
    target: Element,
    hierarchy: ViewHierarchyResult,
    visibleBounds: ElementBounds,
    context: TapPointContext,
  ): { x: number; y: number } | null {
    const point = this.resolveImeSafeTapPoint(target, hierarchy, context);
    if (this.device.platform !== "ios" && pointInTapBounds(point, visibleBounds)) {
      return point;
    }
    const { left, top, right, bottom } = visibleBounds;
    const ime = this.getImeOccluderForTap(target, hierarchy, context.screenSize);
    const exposedImePoint = ime ? tapPointOutsideIme([left, top, right, bottom], ime.bounds) : null;
    if (this.device.platform !== "ios") {
      return ime ? exposedImePoint : this.geometry.getElementCenter({ bounds: visibleBounds });
    }
    const exposedCenter = this.geometry.getElementCenter({ bounds: visibleBounds });
    const chromeElements = context.chromeElements ?? [target];
    const navClipped = this.navigationTapBounds(
      target.bounds,
      hierarchy,
      context.screenSize,
      chromeElements,
    ).bounds;
    if (!navClipped) {
      return null;
    }
    const candidates = boundsEqual(navClipped, target.bounds)
      ? [point, exposedImePoint, exposedCenter]
      : [exposedImePoint, exposedCenter, point];
    const imeBounds = ime && {
      left: ime.bounds[0],
      top: ime.bounds[1],
      right: ime.bounds[2],
      bottom: ime.bounds[3],
    };
    return (
      candidates.find(
        (candidate) =>
          candidate !== null &&
          Number.isInteger(candidate.x) &&
          Number.isInteger(candidate.y) &&
          pointInTapBounds(candidate, visibleBounds) &&
          pointInTapBounds(candidate, target.bounds) &&
          (!imeBounds || !pointInTapBounds(candidate, imeBounds)) &&
          (!isUsableScreenSize(context.screenSize) ||
            !isIosTapPointCoveredByChrome({
              point: candidate,
              hierarchy,
              screen: context.screenSize,
              elements: chromeElements,
            })),
      ) ?? null
    );
  }

  private clipBelowStatusBar(
    visible: ElementBounds,
    matched: Element,
    target: Element,
    hierarchy: ViewHierarchyResult,
    screenSize: NonNullable<ObserveResult["screenSize"]>,
  ): ElementBounds | null {
    const nodes = new SearchableHierarchy().project(hierarchy);
    const isStatusBar = (node: SearchableEntry): boolean =>
      IOS_STATUS_BAR_CLASSES.has(node.className ?? "");
    const matchedNode = findTapTargetNode(nodes, matched);
    const targetNode = matchedNode ?? findTapTargetNode(nodes, target);
    // A status-bar control is itself a valid target even though app content
    // beneath the bar must not receive a coordinate tap there.
    if (
      (targetNode &&
        nodes.some(
          (bar) => isStatusBar(bar) && this.isInsideHierarchyNode(targetNode, bar, nodes),
        )) ||
      [matched.class, target.class].some((className) => IOS_STATUS_BAR_CLASSES.has(className ?? ""))
    ) {
      return visible;
    }
    const top =
      hierarchy.systemInsets?.top ??
      nodes.find(
        (node) =>
          isStatusBar(node) &&
          node.bounds &&
          node.bounds.bottom > 0 &&
          node.bounds.bottom < screenSize.height,
      )?.bounds?.bottom ??
      0;
    return intersectTapBounds(visible, {
      left: 0,
      top: Math.max(0, top),
      right: screenSize.width,
      bottom: screenSize.height,
    });
  }

  private clipBelowTabBars(
    visible: ElementBounds,
    matched: Element,
    target: Element,
    hierarchy: ViewHierarchyResult,
    screenSize: NonNullable<ObserveResult["screenSize"]>,
  ): ElementBounds | null {
    // A tab bar is app chrome, so it need not appear in systemInsets.
    const nodes = new SearchableHierarchy().project(hierarchy);
    const matchedNode = findTapTargetNode(nodes, matched);
    const targetNode = matchedNode ?? findTapTargetNode(nodes, target);
    if (!targetNode) {
      return visible;
    }
    let clipped: ElementBounds | null = visible;
    for (const bar of nodes) {
      if (!clipped) {
        return null;
      }
      if (!this.isTabBarCovering(bar, clipped)) {
        continue;
      }
      if (!this.isTabBarAboveMatch(bar, targetNode)) {
        continue;
      }
      if (!this.isMatchedInsideTabBar(matchedNode, matched, bar, nodes)) {
        clipped = intersectTapBounds(clipped, {
          left: 0,
          top: 0,
          right: screenSize.width,
          bottom: bar.bounds?.top ?? 0,
        });
      }
    }
    return clipped;
  }

  private isTabBarAboveMatch(bar: SearchableEntry, matchedNode: SearchableEntry): boolean {
    return bar.rootGroup === matchedNode.rootGroup && bar.windowRank <= matchedNode.windowRank;
  }

  private isMatchedInsideTabBar(
    matchedNode: SearchableEntry | undefined,
    matched: Element,
    bar: SearchableEntry,
    nodes: readonly SearchableEntry[],
  ): boolean {
    if (matchedNode) {
      return this.isInsideHierarchyNode(matchedNode, bar, nodes);
    }
    const bounds = matched.bounds;
    const barBounds = bar.bounds;
    return (
      !!bounds &&
      !!barBounds &&
      bounds.left >= barBounds.left &&
      bounds.top >= barBounds.top &&
      bounds.right <= barBounds.right &&
      bounds.bottom <= barBounds.bottom
    );
  }

  private isTabBarCovering(bar: SearchableEntry, visible: ElementBounds): boolean {
    const bounds = bar.bounds;
    return (
      (bar.className === "UITabBar" || bar.className === "XCUIElementTypeTabBar") &&
      !!bounds &&
      bounds.left < visible.right &&
      bounds.right > visible.left &&
      bounds.top < visible.bottom &&
      bounds.bottom > visible.top
    );
  }

  private isInsideHierarchyNode(
    node: SearchableEntry | undefined,
    ancestor: SearchableEntry,
    nodes: readonly SearchableEntry[],
  ): boolean {
    let current = node;
    while (current) {
      if (current === ancestor) {
        return true;
      }
      current = current.parentIndex === undefined ? undefined : nodes[current.parentIndex];
    }
    return false;
  }

  private getScreenSizeFromHierarchy(
    viewHierarchy: ViewHierarchyResult,
    options: ScreenSizeForOffscreenCheckOptions = {},
  ): ObserveResult["screenSize"] | undefined {
    return screenSizeForOffscreenCheck(viewHierarchy, {
      ...options,
      platform: this.device.platform,
      iosMultiPanel:
        this.device.platform === "ios" && (this.device.displays?.panels.length ?? 0) > 1,
    });
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

  private selectVariantOrSiblingOrMiss(
    options: TapVerificationOptions,
    select: () => ElementSelectionResult,
  ): ElementSelectionResult {
    try {
      return select();
    } catch (error) {
      if (!(error instanceof ActionableError)) {
        throw error;
      }
      const expectedMissing =
        (options.verification !== undefined && error.message === "Sibling row not found") ||
        (options.textAny !== undefined &&
          options.selectionStrategy === "unique" &&
          error.message.startsWith("Target not found"));
      if (!expectedMissing) {
        throw error;
      }
      // Missing ordered text variants and polling display siblings are expected;
      // keep all lookups scoped and propagate container errors and ambiguity.
      logger.debug("[TapOnElement] Text variant or display sibling not found yet", error);
      return {
        element: null,
        totalMatches: 0,
        indexInMatches: -1,
        strategy: options.selectionStrategy ?? "first",
      };
    }
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
    try {
      return this.selectElementInHierarchy(options, viewHierarchy);
    } catch (error) {
      if (
        options.action !== "focus" ||
        !(error instanceof ActionableError) ||
        error instanceof TapTargetUnavailableError ||
        (options.selectionStrategy !== "unique" &&
          options.index === undefined &&
          !options.container?.container) ||
        !this.isContainerAvailable(viewHierarchy, options.container)
      ) {
        throw error;
      }
      return this.classifyFocusSelectionFailure(options, viewHierarchy, error);
    }
  }

  private classifyFocusSelectionFailure(
    options: TapVerificationOptions,
    viewHierarchy: ViewHierarchyResult,
    error: ActionableError,
  ): never {
    // Strict selection may throw before handleElementNotFound. Inspect the same
    // hierarchy with first-match selection to distinguish absence from ambiguity
    // using selection evidence, while preserving the original diagnostic.
    const inspected = this.selectElementInHierarchy(
      { ...options, selectionStrategy: "first", index: undefined },
      viewHierarchy,
    ).selection;
    if (inspected.totalMatches === 0 && !inspected.matchedElement) {
      throw new TapTargetUnavailableError(error.message, "not-found");
    }
    const target = inspected.element ?? inspected.matchedElement;
    if (
      inspected.totalMatches === 1 &&
      target &&
      isFocusEditableElement(target) &&
      this.isElementTapTargetOffScreen(
        inspected,
        viewHierarchy,
        this.getScreenSizeFromHierarchy(viewHierarchy, options.screenSizeOptions),
        options,
      )
    ) {
      throw new TapTargetUnavailableError(
        error.message,
        this.isCoveredByNavigationBar(
          inspected,
          viewHierarchy,
          this.getScreenSizeFromHierarchy(viewHierarchy, options.screenSizeOptions),
        )
          ? "navigation-bar"
          : "no-visible-tap-area",
      );
    }
    throw error;
  }

  private selectElementInHierarchy(
    options: TapVerificationOptions,
    viewHierarchy: ViewHierarchyResult,
  ): { selection: ElementSelectionResult; containerFound: boolean } {
    const containerFound = this.isContainerAvailable(viewHierarchy, options.container);
    const intentAction =
      options.action === "longPress"
        ? "long-press"
        : options.action === "focus"
          ? "focus-input"
          : "tap";
    const lookupAction = options.subtext
      ? "inspect"
      : options.selectionStrategy === "unique" || options.container?.container
        ? intentAction
        : options.action === "focus"
          ? "focus-input"
          : "inspect";
    const selectionIntent = this.selectionIntentFor(options);

    const text = options.text;
    if (text) {
      if (options.sibling) {
        return {
          selection: this.selectVariantOrSiblingOrMiss(options, () =>
            this.elementSelector.selectClickableSiblingOfText(viewHierarchy, text, {
              container: options.container,
              screenSizeOptions: options.screenSizeOptions,
              fuzzyMatch: true,
              caseSensitive: false,
              strategy: options.selectionStrategy,
              intentAction,
              selectionIntent,
              index: options.index,
            }),
          ),
          containerFound,
        };
      }

      return {
        selection: this.elementSelector.selectByText(viewHierarchy, text, {
          container: options.container,
          screenSizeOptions: options.screenSizeOptions,
          partialMatch: true,
          caseSensitive: false,
          strategy: options.selectionStrategy,
          intentAction: lookupAction,
          allowHintFallback: options.action === "tap" || options.action === "focus",
          index: options.index,
          selectionIntent,
        }),
        containerFound,
      };
    }

    if (options.textAny) {
      let lastSelection: ElementSelectionResult | null = null;
      let offScreenSelection: ElementSelectionResult | null = null;
      const screenSize = this.getScreenSizeFromHierarchy(viewHierarchy, options.screenSizeOptions);
      for (const text of options.textAny) {
        const selection = options.sibling
          ? this.selectVariantOrSiblingOrMiss(options, () =>
              this.elementSelector.selectClickableSiblingOfText(viewHierarchy, text, {
                container: options.container,
                screenSizeOptions: options.screenSizeOptions,
                fuzzyMatch: true,
                caseSensitive: false,
                strategy: options.selectionStrategy,
                intentAction,
                selectionIntent,
                index: options.index,
              }),
            )
          : this.selectVariantOrSiblingOrMiss(options, () =>
              this.elementSelector.selectByText(viewHierarchy, text, {
                container: options.container,
                screenSizeOptions: options.screenSizeOptions,
                partialMatch: true,
                caseSensitive: false,
                strategy: options.selectionStrategy,
                intentAction: lookupAction,
                allowHintFallback: options.action === "tap" || options.action === "focus",
                index: options.index,
                selectionIntent,
              }),
            );
        lastSelection = selection;
        if (selection.element) {
          if (this.isElementTapTargetOffScreen(selection, viewHierarchy, screenSize, options)) {
            offScreenSelection = selection;
            continue;
          }
          return { selection, containerFound };
        }
      }

      if (offScreenSelection) {
        return {
          selection: { ...offScreenSelection, element: null },
          containerFound,
        };
      }

      if (lastSelection) {
        if (options.selectionStrategy === "unique") {
          throw new TapTargetUnavailableError(
            `Target not found${options.container ? " within container" : ""}: no textAny variant matched`,
            "not-found",
          );
        }
        return { selection: lastSelection, containerFound };
      }
    }

    const elementId = options.elementId;
    if (elementId) {
      if (options.sibling) {
        return {
          selection: this.selectVariantOrSiblingOrMiss(options, () =>
            this.elementSelector.selectClickableSiblingOfResourceId(viewHierarchy, elementId, {
              container: options.container,
              screenSizeOptions: options.screenSizeOptions,
              partialMatch: false,
              strategy: options.selectionStrategy,
              intentAction,
              index: options.index,
            }),
          ),
          containerFound,
        };
      }

      return {
        selection: this.elementSelector.selectByResourceId(viewHierarchy, elementId, {
          container: options.container,
          screenSizeOptions: options.screenSizeOptions,
          partialMatch: false,
          strategy: options.selectionStrategy,
          intentAction: lookupAction,
          index: options.index,
        }),
        containerFound,
      };
    }

    return {
      selection: this.elementSelector.selectByTestTag(viewHierarchy, this.requireTestTag(options), {
        container: options.container,
        screenSizeOptions: options.screenSizeOptions,
        strategy: options.selectionStrategy,
        intentAction: lookupAction,
        selectionIntent,
        index: options.index,
      }),
      containerFound,
    };
  }

  private selectionIntentFor(options: TapOnElementOptions): TextSelectionIntent {
    return options.ensureChecked !== undefined && options.index === undefined && !options.elementId
      ? "toggle"
      : TEXT_SELECTION_INTENT_BY_ACTION[options.action];
  }

  private isSameFocusTarget(
    target: Element,
    candidate: Element,
    nodes?: readonly SearchableEntry[],
    selectedNode?: SearchableEntry,
  ): boolean {
    const candidateSource = getHierarchyNodeSource(candidate);
    if (selectedNode && candidateSource === selectedNode.source) {
      return true;
    }
    if (!selectedNode && this.hasDirectFocusIdentity(target, candidate)) {
      return true;
    }
    if (!nodes || !candidateSource) {
      return false;
    }
    const targets = selectedNode
      ? [selectedNode]
      : nodes.filter((node) => node.element && this.hasDirectFocusIdentity(target, node.element));
    // Focus can be serialized on the search bar while its inner text field is
    // selected (or vice versa). Only the nearest editable node on the same
    // ancestry chain represents the same field.
    return nodes.some((focusedNode) => {
      if (focusedNode.source !== candidateSource || !focusedNode.element) {
        return false;
      }
      return targets.some((matchedNode) => {
        for (const [start, end] of [
          [focusedNode, matchedNode],
          [matchedNode, focusedNode],
        ] as const) {
          let parent = start.parentIndex;
          while (parent !== undefined) {
            const ancestor = nodes[parent];
            if (ancestor === end) {
              return true;
            }
            if (isFocusEditableElement(ancestor.properties)) {
              break;
            }
            parent = ancestor.parentIndex;
          }
        }
        return false;
      });
    });
  }

  private hasDirectFocusIdentity(target: Element, candidate: Element): boolean {
    for (const key of ["resource-id", "view-id", "test-tag"] as const) {
      const targetValue = target[key];
      const candidateValue = candidate[key];
      if (
        key === "view-id" &&
        targetValue !== candidateValue &&
        [targetValue, candidateValue].some((value) => String(value).startsWith("s2-"))
      ) {
        continue;
      }
      if (
        typeof targetValue === "string" &&
        targetValue.length > 0 &&
        typeof candidateValue === "string" &&
        candidateValue.length > 0
      ) {
        return targetValue === candidateValue;
      }
    }
    return (
      boundsNearlyEqual(
        target.bounds,
        candidate.bounds,
        TapOnElement.ANDROID_PRE_TAP_BOUNDS_EPSILON_PX,
      ) && this.hasStableFocusIdentity(target, candidate)
    );
  }

  private describeFocusTarget(element: Element, options: TapOnElementOptions): string {
    const text =
      element.text ??
      element["content-desc"] ??
      element["ios-accessibility-label"] ??
      options.text ??
      options.textAny?.[0];
    return typeof text === "string" && text.length > 0
      ? JSON.stringify(text)
      : "the matched element";
  }

  private hasStableFocusIdentity(target: Element, candidate: Element, labelText?: string): boolean {
    if (target.class !== candidate.class) {
      return false;
    }
    const stableKeys = (["resource-id", "test-tag"] as const).filter((key) => {
      const value = target[key];
      return typeof value === "string" && value.length > 0;
    });
    if (stableKeys.length > 0) {
      return stableKeys.every((key) => target[key] === candidate[key]);
    }
    const targetText = target.text ?? target["content-desc"] ?? target["ios-accessibility-label"];
    const candidateText =
      candidate.text ?? candidate["content-desc"] ?? candidate["ios-accessibility-label"];
    const identityText =
      typeof targetText === "string" && targetText.length > 0 ? targetText : labelText;
    return (
      typeof identityText === "string" && identityText.length > 0 && identityText === candidateText
    );
  }

  private distinctFocusFields(nodes: readonly SearchableEntry[]): SearchableEntry[] {
    const groups: SearchableEntry[][] = [];
    for (const node of nodes) {
      // A capture can deserialize the same field under both hierarchy and windows.
      // Keep one occurrence per root in each group, so same-tree peers stay ambiguous.
      const copies = groups.find((group) =>
        group.every(
          (copy) => copy.rootGroup !== node.rootGroup && this.isDuplicateFocusField(copy, node),
        ),
      );
      if (copies) {
        copies.push(node);
      } else {
        groups.push([node]);
      }
    }
    return groups.map((group) => group[0]);
  }

  private isDuplicateFocusField(a: SearchableEntry, b: SearchableEntry): boolean {
    return Boolean(
      a.element &&
      b.element &&
      a.className === b.className &&
      boundsNearlyEqual(
        a.element.bounds,
        b.element.bounds,
        TapOnElement.ANDROID_PRE_TAP_BOUNDS_EPSILON_PX,
      ) &&
      this.finder.isElementKeyboardFocused(a.element) ===
        this.finder.isElementKeyboardFocused(b.element) &&
      (
        [
          "resource-id",
          "test-tag",
          "view-id",
          "text",
          "content-desc",
          "ios-accessibility-label",
        ] as const
      ).every((key) => a.element![key] === b.element![key]),
    );
  }

  private findSoleFocusedFieldByStableIdentity(
    target: Element,
    nodes: readonly SearchableEntry[],
    labelText?: string,
    preTapHierarchy?: ViewHierarchyResult,
  ): Element | undefined {
    const focusedFields = nodes.filter(
      (node) =>
        node.element &&
        isFocusEditableElement(node.properties) &&
        this.finder.isElementKeyboardFocused(node.element),
    );
    const distinctFocusedFields = this.distinctFocusFields(focusedFields);
    if (distinctFocusedFields.length !== 1) {
      return undefined;
    }
    const candidate = distinctFocusedFields[0].element;
    return candidate &&
      (this.device.platform === "android" && !candidate.text
        ? this.hasEmptyTextFocusIdentity(target, candidate, nodes, labelText, preTapHierarchy)
        : this.hasStableFocusIdentity(target, candidate, labelText)) &&
      horizontalExtentNearlyEqual(
        target.bounds,
        candidate.bounds,
        TapOnElement.ANDROID_PRE_TAP_BOUNDS_EPSILON_PX,
      )
      ? candidate
      : undefined;
  }

  private focusFieldSizeMatches(target: Element, candidate: Element): boolean {
    const epsilon = TapOnElement.ANDROID_PRE_TAP_BOUNDS_EPSILON_PX;
    return (
      horizontalExtentNearlyEqual(target.bounds, candidate.bounds, epsilon) &&
      Math.abs(
        target.bounds.right - target.bounds.left - (candidate.bounds.right - candidate.bounds.left),
      ) <= epsilon &&
      Math.abs(
        target.bounds.bottom - target.bounds.top - (candidate.bounds.bottom - candidate.bounds.top),
      ) <= epsilon
    );
  }

  private focusScrollDelta(
    before: readonly SearchableEntry[],
    after: readonly SearchableEntry[],
  ): number | undefined {
    if (!before.length || before.length !== after.length) {
      return undefined;
    }
    const delta = after[0].element!.bounds.top - before[0].element!.bounds.top;
    const consistent = before.every((field, ordinal) => {
      const target = field.element!;
      const candidate = after[ordinal].element!;
      return (
        target.class === candidate.class &&
        this.focusFieldSizeMatches(target, candidate) &&
        boundsNearlyEqual(
          {
            ...target.bounds,
            top: target.bounds.top + delta,
            bottom: target.bounds.bottom + delta,
          },
          candidate.bounds,
          TapOnElement.ANDROID_PRE_TAP_BOUNDS_EPSILON_PX,
        )
      );
    });
    return consistent ? delta : undefined;
  }

  private attachedFocusLabel(element: Element): string | undefined {
    const source = getHierarchyNodeSource(element);
    if (!source) {
      return undefined;
    }
    const labels = new SearchableHierarchy()
      .project({ hierarchy: { node: source } })
      .filter((node) => node.parentIndex === 0 && !isFocusEditableElement(node.properties))
      .map((node) => node.textSources.text)
      .filter((text) => typeof text === "string" && text.trim().length > 0);
    return labels.length ? labels.join("\n") : undefined;
  }

  private focusIdentitySignals(target: Element, candidate: Element, labelText?: string) {
    if (
      !isFocusEditableElement(target) ||
      target.class !== candidate.class ||
      !this.focusFieldSizeMatches(target, candidate) ||
      (["resource-id", "test-tag", "view-id"] as const).some(
        (key) =>
          [target[key], candidate[key]].some(
            (value) => value && !(key === "view-id" && value.startsWith("s2-")),
          ) && target[key] !== candidate[key],
      )
    ) {
      return { conflict: true, matched: false };
    }
    const pairs = [
      ...(["hint-text", "hint", "placeholder", "content-desc", "test-tag"] as const).map((key) => [
        target[key],
        candidate[key],
      ]),
      [
        this.attachedFocusLabel(target) ?? labelText ?? target.text,
        this.attachedFocusLabel(candidate),
      ],
    ].filter((pair) => pair.every((value) => typeof value === "string" && value.trim().length > 0));
    return {
      conflict: pairs.some(([before, after]) => before !== after),
      matched: pairs.some(([before, after]) => before === after),
    };
  }

  private hasEmptyTextFocusIdentity(
    target: Element,
    candidate: Element,
    nodes: readonly SearchableEntry[],
    labelText?: string,
    preTapHierarchy?: ViewHierarchyResult,
  ): boolean {
    // Empty Compose fields can lose labels/s2 IDs on focus. Require matching size and
    // no label/hint or ordinal conflict, plus a label match, sole empty field at
    // adjusted bounds, or matching ordinal with a uniform pre/post scroll (including 0).
    const signals = this.focusIdentitySignals(target, candidate, labelText);
    if (signals.conflict) {
      return false;
    }
    const fields = this.distinctFocusFields(
      nodes.filter((node) => node.element && isFocusEditableElement(node.properties)),
    );
    const sameBoundsFields = fields.filter((node) =>
      boundsNearlyEqual(
        node.element!.bounds,
        candidate.bounds,
        TapOnElement.ANDROID_PRE_TAP_BOUNDS_EPSILON_PX,
      ),
    );
    if (sameBoundsFields.length !== 1) {
      return false;
    }
    const preNodes = preTapHierarchy
      ? new SearchableHierarchy().project(resolveViewHierarchyForSearch(preTapHierarchy)!)
      : [];
    const preFields = this.distinctFocusFields(
      preNodes.filter((node) => node.element && isFocusEditableElement(node.properties)),
    );
    const targetFields = preFields.filter(
      (node) =>
        node.source === getHierarchyNodeSource(target) ||
        (node.className === target.class &&
          boundsNearlyEqual(
            node.element!.bounds,
            target.bounds,
            TapOnElement.ANDROID_PRE_TAP_BOUNDS_EPSILON_PX,
          )),
    );
    const targetOrdinal = targetFields.length === 1 ? preFields.indexOf(targetFields[0]) : -1;
    const candidateOrdinal = fields.findIndex((node) => node.element === candidate);
    if (targetOrdinal >= 0 && targetOrdinal !== candidateOrdinal) {
      return false;
    }
    const delta = this.focusScrollDelta(preFields, fields);
    const scrollDelta = delta ?? 0;
    const adjustedBounds = {
      ...target.bounds,
      top: target.bounds.top + scrollDelta,
      bottom: target.bounds.bottom + scrollDelta,
    };
    const atTargetBounds = boundsNearlyEqual(
      adjustedBounds,
      candidate.bounds,
      TapOnElement.ANDROID_PRE_TAP_BOUNDS_EPSILON_PX,
    );
    const emptyFields = fields.filter(
      (node) => node.className === target.class && !node.element!.text,
    );
    return (
      signals.matched ||
      (atTargetBounds && (emptyFields.length === 1 || (targetOrdinal >= 0 && delta !== undefined)))
    );
  }

  private findFocusIdentifier(
    target: Element,
    nodes: readonly SearchableEntry[],
  ): { key: FocusIdentifierKey; value: string; shared: boolean } | undefined {
    let shared: { key: FocusIdentifierKey; value: string; shared: boolean } | undefined;
    for (const key of ["resource-id", "test-tag", "view-id"] as const) {
      const value = target[key];
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      const fields = this.distinctFocusFields(
        nodes.filter(
          (node) =>
            node.element && isFocusEditableElement(node.properties) && node.element[key] === value,
        ),
      );
      if (fields.length === 1) {
        return { key, value, shared: false };
      }
      if (fields.length > 1) {
        shared ??= { key, value, shared: true };
      }
    }
    return shared;
  }

  private verifyIndexedFocusTarget(
    options: TapOnElementOptions,
    target: Element,
    hierarchy: ViewHierarchyResult,
    identifier: { key: FocusIdentifierKey; value: string },
    selectedIndex?: number,
  ): boolean {
    const nodes = new SearchableHierarchy().project(hierarchy);
    const selected = this.findIndexedFocusSelection(
      options,
      hierarchy,
      nodes,
      identifier,
      selectedIndex,
    );
    const selectedSource = selected && getHierarchyNodeSource(selected);
    const selectedNode = nodes.find((node) => node.source === selectedSource);
    return Boolean(
      selected &&
      isFocusEditableElement(selected) &&
      selectedNode &&
      nodes.some(
        (node) =>
          node.element &&
          isFocusEditableElement(node.properties) &&
          this.finder.isElementKeyboardFocused(node.element) &&
          this.isSameFocusTarget(selected, node.element, nodes, selectedNode),
      ) &&
      selected[identifier.key] === identifier.value &&
      target.class === selected.class &&
      horizontalExtentNearlyEqual(
        target.bounds,
        selected.bounds,
        TapOnElement.ANDROID_PRE_TAP_BOUNDS_EPSILON_PX,
      ),
    );
  }

  private findIndexedFocusSelection(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
    nodes: readonly SearchableEntry[],
    identifier: { key: FocusIdentifierKey; value: string },
    selectedIndex?: number,
  ): Element | null {
    // A known focus target may carry a view-id shared by several id-less fields.
    // Public ID lookup rejects that ambiguous selector, so verify its selected
    // occurrence within the capture without re-entering the public lookup.
    const duplicateViewId =
      identifier.key === "view-id" &&
      options.elementId === identifier.value &&
      nodes.filter((node) => node.nodeKey === identifier.value && !node.nativeId).length > 1;
    const focusRank = (node: SearchableEntry) => ({
      windowRank: node.windowRank,
      area: node.bounds ? boundsArea(node.bounds) : Infinity,
      order: node.index,
      interactive: true,
    });
    if (duplicateViewId) {
      return (
        nodes
          .filter(
            (node) =>
              node.nodeKey === identifier.value &&
              !node.nativeId &&
              node.element &&
              isFocusEditableElement(node.properties),
          )
          .sort((a, b) => compareSelectionRank(focusRank(a), focusRank(b)))[
          options.index ?? selectedIndex ?? 0
        ]?.element ?? null
      );
    }
    return this.findElementInHierarchy(
      {
        ...options,
        index:
          options.index ?? (options.selectionStrategy === "unique" ? undefined : selectedIndex),
      },
      hierarchy,
    ).selection.element;
  }

  private isFocusedMatchingNode(
    target: Element,
    node: SearchableEntry,
    nodes: readonly SearchableEntry[],
  ): boolean {
    return Boolean(
      node.element &&
      isFocusEditableElement(node.properties) &&
      this.finder.isElementKeyboardFocused(node.element) &&
      this.isSameFocusTarget(target, node.element, nodes),
    );
  }

  private isRefoundFocusTarget(
    options: TapOnElementOptions,
    target: Element,
    hierarchy: ViewHierarchyResult,
  ): boolean {
    const candidate = this.findElementInHierarchy(options, hierarchy).selection.element;
    return Boolean(
      candidate &&
      isFocusEditableElement(candidate) &&
      this.finder.isElementKeyboardFocused(candidate) &&
      this.isSameFocusTarget(target, candidate, new SearchableHierarchy().project(hierarchy)),
    );
  }

  private verifyFocusedInputTarget(
    options: TapOnElementOptions,
    target: Element,
    observation?: ObserveResult,
    labelText?: string,
    selectedIndex?: number,
    preTapHierarchy?: ViewHierarchyResult,
  ): boolean {
    if (!observation?.viewHierarchy) {
      return false;
    }
    const searchHierarchy =
      resolveViewHierarchyForSearch(observation.viewHierarchy) ?? observation.viewHierarchy;
    const nodes = new SearchableHierarchy().project(searchHierarchy);
    const identifier = this.findFocusIdentifier(target, nodes);
    if (identifier?.shared) {
      return this.verifyIndexedFocusTarget(
        this.withObservationScreenSize(options, observation),
        target,
        observation.viewHierarchy,
        identifier,
        selectedIndex,
      );
    }
    if (identifier) {
      return nodes.some(
        (node) =>
          node.element &&
          isFocusEditableElement(node.properties) &&
          this.finder.isElementKeyboardFocused(node.element) &&
          node.element[identifier.key] === identifier.value &&
          this.isSameFocusTarget(target, node.element, nodes),
      );
    }
    const focused = nodes.find((node) => this.isFocusedMatchingNode(target, node, nodes));
    if (focused) {
      return true;
    }
    if (this.findSoleFocusedFieldByStableIdentity(target, nodes, labelText, preTapHierarchy)) {
      return true;
    }
    if (!options.testTag && !(options.elementId && target["resource-id"])) {
      return false;
    }
    return this.isRefoundFocusTarget(
      this.withObservationScreenSize(options, observation),
      target,
      observation.viewHierarchy,
    );
  }

  private requireTestTag(options: TapOnElementOptions): string {
    if (!options.testTag) {
      throw new ActionableError(
        "tapOn requires non-blank text, textAny, elementId, or testTag to interact with",
      );
    }
    return options.testTag;
  }

  private prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ): ViewHierarchyResult {
    if (!serverConfig.isRawElementSearchEnabled()) {
      return rawHierarchy;
    }

    if (
      rawHierarchy?.hierarchy &&
      typeof rawHierarchy.hierarchy === "object" &&
      "error" in rawHierarchy.hierarchy &&
      rawHierarchy.hierarchy.error
    ) {
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
      captured.panelUniqueId,
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
  ): Promise<ViewHierarchyResult | null> {
    throwIfAborted(signal);
    const effectiveTimeoutMs = Math.max(0, timeoutMs);
    if (effectiveTimeoutMs === 0) {
      return null;
    }
    switch (this.device.platform) {
      case "android": {
        const rawHierarchy = await refreshAndroidViewHierarchy(
          this.accessibilityService,
          effectiveTimeoutMs,
          signal,
          { adb: this.adb, timer: this.timer },
        );

        return rawHierarchy ? this.prepareViewHierarchyForResponse(rawHierarchy, screenSize) : null;
      }
      case "ios": {
        // Match the observe projection exactly. Going through CtrlProxy's
        // alternate conversion here lets a selector observed from one tree be
        // resolved against a differently-pruned tree on refresh.
        const synced = await IOSCtrlProxyClient.getInstance(this.device).requestHierarchySync(
          undefined,
          false,
          signal,
          effectiveTimeoutMs,
        );
        if (!synced?.hierarchy) {
          return null;
        }
        const rawHierarchy = this.viewHierarchy.normalizeIosHierarchy(
          IOSCtrlProxyClient.getInstance(this.device).convertToViewHierarchyResult(
            synced.hierarchy,
          ),
        );
        return this.prepareViewHierarchyForResponse(rawHierarchy, screenSize);
      }
      default:
        throw unsupportedPlatformError(this.device.platform, "tap on elements");
    }
  }

  /**
   * Re-fetch the Android hierarchy and re-resolve the tap target until bounds match on enough
   * consecutive successful re-finds (±ε); the required count depends on selector type (see
   * {@link androidPreTapConsecutiveStableMatchesRequired}). Refuses to fall back to pre-refresh
   * coordinates when the refreshed tree does not contain a matching target.
   */
  /** @internal Test seam for pre-tap stability tests (#7992); not part of the public API. */
  async resolveAndroidStableTapTargetAfterRefreshes(
    options: TapVerificationOptions,
    observeResult: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>,
    action: TapOnElementOptions["action"],
    requireResourceId: boolean,
    signal?: AbortSignal,
  ): Promise<
    | {
        ok: true;
        viewHierarchy: ViewHierarchyResult;
        tapElement: Element;
        usedParent: boolean;
        selection: ElementSelectionResult;
      }
    | { ok: false; error: string }
  > {
    options = this.withObservationScreenSize(options, observeResult);
    const stableMatchesRequired = androidPreTapConsecutiveStableMatchesRequired(options);
    const originalSelection = observeResult.viewHierarchy
      ? this.findElementInHierarchy(options, observeResult.viewHierarchy).selection
      : null;
    const original = originalSelection?.matchedElement ?? originalSelection?.element ?? null;

    let prevBounds: Element["bounds"] | null = null;
    let consecutiveStable = 0;
    let best: {
      viewHierarchy: ViewHierarchyResult;
      tapElement: Element;
      usedParent: boolean;
      selection: ElementSelectionResult;
    } | null = null;

    const startTime = this.timer.now();
    // Wall-clock time NOT attributable to productive polling — the "no hierarchy"
    // recovery sleeps AND the wall-clock the failed refreshes themselves consumed.
    // Excluded from the deadline so a temporarily-unresponsive ctrl-proxy WebSocket
    // doesn't consume the element's patience (that streak is bounded separately by
    // ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE).
    let noHierarchyTimeMs = 0;
    let budgetMs = TapOnElement.ANDROID_PRE_TAP_REFIND_BUDGET_MS;
    let minProductivePolls = TapOnElement.ANDROID_PRE_TAP_REFIND_MIN_POLLS;
    let consecutiveNoHierarchy = 0;
    let refindAttempt = 0;
    let firstIteration = true;
    let iterations = 0;
    // Extra polls allowed past the deadline to finish confirming an already-stable
    // candidate, so a sibling selector isn't failed at the boundary (e.g. a null
    // streak resets stability progress right as the deadline passes). Bounded by
    // stableMatchesRequired so a perpetually-shifting target can't extend forever.
    let deadlineGracePolls = stableMatchesRequired;

    while (true) {
      throwIfAborted(signal);
      if (++iterations > TapOnElement.ANDROID_PRE_TAP_MAX_ITERATIONS) {
        break;
      }

      // Keep polling until BOTH the productive-poll floor and the wall-clock
      // deadline are exceeded; the floor guarantees we never poll fewer times than
      // the old fixed attempt count on a slow device.
      const productiveElapsedMs = this.timer.now() - startTime - noHierarchyTimeMs;
      const budgetExhausted =
        refindAttempt >= minProductivePolls && productiveElapsedMs >= budgetMs;
      const midStabilityRun =
        best !== null && consecutiveStable > 0 && consecutiveStable < stableMatchesRequired;
      if (!firstIteration && consecutiveNoHierarchy === 0 && budgetExhausted) {
        if (midStabilityRun && deadlineGracePolls > 0) {
          deadlineGracePolls--;
        } else {
          break;
        }
      }

      if (!firstIteration) {
        const inNoHierarchyRecovery = consecutiveNoHierarchy > 0;
        const delayMs = inNoHierarchyRecovery
          ? TapOnElement.ANDROID_PRE_TAP_NO_HIERARCHY_DELAY_MS
          : TapOnElement.ANDROID_PRE_TAP_REFIND_DELAY_MS;
        await this.timer.sleep(delayMs);
        if (inNoHierarchyRecovery) {
          noHierarchyTimeMs += delayMs;
        }
      }
      firstIteration = false;

      const refreshStart = this.timer.now();
      const freshHierarchy = await this.tapVerificationRefresh({
        refresh: options.verification?.refresh,
        screenSize: observeResult.screenSize,
        signal,
      })(TapOnElement.ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS);
      if (!freshHierarchy) {
        // The failed refresh itself burned wall-clock (up to the timeout); exclude
        // that from the deadline too, not just the recovery sleep, otherwise a slow
        // unresponsive proxy still eats the element's patience.
        noHierarchyTimeMs += this.timer.now() - refreshStart;
        consecutiveNoHierarchy++;
        logger.warn(
          `[TapOnElement] Android pre-tap refresh returned no hierarchy ` +
            `(consecutive: ${consecutiveNoHierarchy}/${TapOnElement.ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE}, ` +
            `refind attempt: ${refindAttempt})`,
        );
        if (consecutiveNoHierarchy >= TapOnElement.ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE) {
          return {
            ok: false,
            error:
              `Android tap aborted: accessibility service was unreachable for ${consecutiveNoHierarchy} consecutive attempts ` +
              `(ctrl-proxy WebSocket unresponsive). The device may be under heavy load or the accessibility service may need reconnection.`,
          };
        }
        consecutiveStable = 0;
        prevBounds = null;
        continue;
      }

      consecutiveNoHierarchy = 0;
      refindAttempt++;

      if (
        androidViewHierarchyIndicatesLikelyBlockingLoading(freshHierarchy, this.elementParser) &&
        budgetMs < TapOnElement.ANDROID_PRE_TAP_REFIND_BUDGET_MS_WHEN_LOADING
      ) {
        budgetMs = TapOnElement.ANDROID_PRE_TAP_REFIND_BUDGET_MS_WHEN_LOADING;
        minProductivePolls = TapOnElement.ANDROID_PRE_TAP_REFIND_MIN_POLLS_WHEN_LOADING;
        logger.info(
          `[TapOnElement] Android pre-tap: loading/progress indicators present; ` +
            `extending refind budget to ${budgetMs}ms / ${minProductivePolls} polls`,
        );
      }

      const refind = this.findElementInHierarchy(options, freshHierarchy);
      if (!refind.selection.element) {
        logger.warn(
          `[TapOnElement] Android pre-tap refresh attempt ${refindAttempt} did not re-find tap target`,
        );
        consecutiveStable = 0;
        prevBounds = null;
        continue;
      }

      if (
        original?.["resource-id"] &&
        original["resource-id"] !==
          (refind.selection.matchedElement ?? refind.selection.element)["resource-id"]
      ) {
        return {
          ok: false,
          error:
            "Stale tap target: the fresh capture matched a different native ID. Observe again before acting.",
        };
      }

      const staleSynthetic =
        options.elementId !== undefined && options.elementId === original?.["view-id"]
          ? this.staleSyntheticTarget(original, observeResult.viewHierarchy, freshHierarchy)
          : undefined;
      if (staleSynthetic) {
        return { ok: false, error: staleSynthetic };
      }

      const refreshed = this.resolveTapTargetElement(
        refind.selection.element as Element,
        freshHierarchy,
        action,
        { requireResourceId, scoped: options.container !== undefined },
      );
      const b = refreshed.element.bounds;
      if (b === undefined || b === null) {
        consecutiveStable = 0;
        prevBounds = null;
        continue;
      }

      if (
        prevBounds !== null &&
        boundsNearlyEqual(prevBounds, b, TapOnElement.ANDROID_PRE_TAP_BOUNDS_EPSILON_PX)
      ) {
        consecutiveStable++;
      } else {
        consecutiveStable = 1;
      }
      prevBounds = b;
      const refreshedCaptureId = getHierarchySnapshot(freshHierarchy)?.captureId;
      best = {
        viewHierarchy: freshHierarchy,
        tapElement: refreshed.element,
        usedParent: refreshed.usedParent,
        // Carry the refreshed selection so the caller can rebuild selectedElement
        // metadata (bounds/indexInMatches/totalMatches) from the node actually
        // tapped, not the stale pre-refresh selection (#5888).
        selection: refreshedCaptureId
          ? { ...refind.selection, captureId: refreshedCaptureId }
          : refind.selection,
      };

      if (consecutiveStable >= stableMatchesRequired) {
        logger.info(
          `[TapOnElement] Android tap target stable after ${refindAttempt} refresh(es) (bounds matched on last ${stableMatchesRequired} consecutive re-find(s), ε=${TapOnElement.ANDROID_PRE_TAP_BOUNDS_EPSILON_PX}px)`,
        );
        return { ok: true, ...best };
      }
    }

    return {
      ok: false,
      error:
        "Android tap aborted: could not re-find the target in the accessibility hierarchy with stable bounds after repeated refreshes (refusing tap using pre-observe coordinates). The UI may still be updating (list, keyboard, loading overlay, or animation).",
    };
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
    const initialSearch = this.findElementInHierarchy(
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
      const deadline = startTime + searchDurationMs;
      // Fast cached iOS responses must yield just like device round-trips.
      // Keep an independent request ceiling even if the wall clock moves backward.
      const maxRequests = Math.ceil(searchDurationMs / TapOnElement.SEARCH_POLL_INTERVAL_MS);
      let nextPollAt = startTime;
      while (this.timer.now() < deadline && requestCount < maxRequests) {
        throwIfAborted(signal);
        const delayMs = Math.min(nextPollAt, deadline) - this.timer.now();
        if (delayMs > 0) {
          await this.timer.sleep(delayMs);
          throwIfAborted(signal);
        }
        if (this.timer.now() >= deadline) {
          break;
        }
        nextPollAt = this.timer.now() + TapOnElement.SEARCH_POLL_INTERVAL_MS;
        const remainingTimeMs = Math.max(0, deadline - this.timer.now());
        const refreshedHierarchy = await this.tapVerificationRefresh({
          refresh: options.verification?.refresh,
          screenSize: latestScreenSize,
          signal,
        })(remainingTimeMs);
        requestCount += 1;

        if (!refreshedHierarchy) {
          continue;
        }

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

        const searchResult = this.findElementInHierarchy(
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
          this.isElementTapTargetOffScreen(selection, refreshedHierarchy, latestScreenSize, options)
        ) {
          visibilityError = invisibleError();
          logger.warn(
            `[TapOnElement] Element found but tap target is off-screen, retrying. ` +
              `bounds=${JSON.stringify(element.bounds)}`,
          );
          selection = { ...selection, element: null };
          element = null;
          offScreenRejections += 1;
          continue;
        }
        if (element) {
          break;
        }
      }
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
  ): Promise<never> {
    if (options.container && !containerFound) {
      const containerLabel = options.container.elementId
        ? `elementId '${options.container.elementId}'`
        : `text '${options.container.text}'`;
      throw new ActionableError(`Container element not found with provided ${containerLabel}`);
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
      baseError = `Element not found with provided elementId '${options.elementId}'${containerHint}`;
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

  private isContainerAvailable(
    viewHierarchy: ViewHierarchyResult,
    container?: ElementContainerSelector,
  ): boolean {
    if (!container) {
      return true;
    }

    return (
      this.elementSelector.hasContainer?.(viewHierarchy, container) ??
      this.finder.hasContainerElement(viewHierarchy, container)
    );
  }

  private resolveContainerElement(
    viewHierarchy: ViewHierarchyResult,
    options: TapVerificationOptions,
  ): Element | undefined {
    const container = options.container;
    if (!container) {
      return undefined;
    }
    if (this.elementSelector.resolveContainer) {
      return this.elementSelector.resolveContainer(
        viewHierarchy,
        container,
        options.selectionStrategy,
      );
    }
    const scopedOptions = {
      container: container.container,
      index: container.index,
      strategy:
        options.selectionStrategy === "unique" ? ("unique" as const) : container.selectionStrategy,
    };
    if (container.elementId) {
      return this.elementSelector.selectByResourceId(viewHierarchy, container.elementId, {
        ...scopedOptions,
        intentAction: "inspect",
        screenSizeOptions: options.screenSizeOptions,
      }).element as Element | undefined;
    }
    if (container.text) {
      return this.elementSelector.selectByText(viewHierarchy, container.text, {
        ...scopedOptions,
        intentAction: "inspect",
        screenSizeOptions: options.screenSizeOptions,
        caseSensitive: false,
      }).element as Element | undefined;
    }
    return undefined;
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
    },
  ): Promise<TapOnElementResult & { wasAlreadyFocused?: boolean; focusChanged?: boolean }> {
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
    if (options.action === "focus") {
      if (!isFocusEditableElement(element)) {
        return {
          success: false,
          action: options.action,
          element,
          selectedElement,
          error: `Cannot focus ${this.describeFocusTarget(element, options)} because it is not an editable input`,
        };
      }
      if (this.finder.isElementKeyboardFocused(element)) {
        return {
          success: true,
          action: options.action,
          element,
          selectedElement,
          wasAlreadyFocused: true,
          focusChanged: false,
          focusVerified: true,
          ...this.geometry.getElementCenter(element),
        };
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
        this.visibilityFailureReason(selection, hierarchy, target.observation.screenSize),
      );
    }
    const preTapHash = options.retryIfNoChange ? this.hashViewHierarchy(hierarchy) : null;
    const dispatchAction = await this.androidDisplayDispatch(options, context);
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
    return {
      success: true,
      action: options.action,
      element,
      selectedElement,
    };
  }

  private async androidDisplayDispatch(
    options: TapOnElementOptions,
    context: {
      target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
      signal?: AbortSignal;
      onDispatched: () => void;
    },
  ): Promise<(point: { x: number; y: number }) => Promise<void>> {
    return androidDisplayTapDispatch(
      this.accessibilityService,
      this.adb,
      {
        action: options.action === "focus" ? "tap" : options.action,
        duration: options.duration,
      },
      context,
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
        await this.handleElementNotFound(options, undefined, outcome.containerFound, signal);
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
    },
  ): Promise<TapOnElementResult> {
    const { target, signal } = context;
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
        () =>
          this.executeOnAndroidDisplay(verificationOptions, {
            target,
            selection,
            signal,
            onDispatched: () => {
              tapTimestamp = this.timer.now();
            },
          }),
        {
          changeExpected: false,
          display: target.observation.display.key,
          previousObservation: target.observation,
          signal,
          ...(options.ensureChecked !== undefined
            ? { observationTimestampProvider: () => tapTimestamp }
            : {}),
        },
      );
    result.searchUntil = stats;
    target.assertCurrent();
    if (result.success && result.skipped !== "already-checked") {
      await this.applyEnsureCheckedResult(result, verificationOptions, signal);
    }
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
      target.observation.viewHierarchy,
    );
    if (!result.focusVerified) {
      result.success = false;
      result.error = `Failed to confirm focus on editable input ${this.describeFocusTarget(result.element, options)}: the focused field could not be matched to the target`;
    }
    return result;
  }

  private async executeOnDisplay(
    options: TapOnElementOptions,
    signal?: AbortSignal,
    recovery?: { throwOnKeyboardOcclusion?: boolean },
  ): Promise<TapOnElementResult | undefined> {
    const display = options.display;
    if (display !== undefined) {
      try {
        const unsupported = (
          ["subtext", "accessibilityLink", "focusFirst", "screenReaderNavigation"] as const
        ).find((key) => options[key] !== undefined);
        if (unsupported) {
          throw new ActionableError(`${unsupported} is not supported with \`display\` yet`);
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
          return await this.observedAndroidDisplayInteraction(options, { target, signal });
        }
      } catch (error) {
        this.rethrowKeyboardOcclusion(error, options.action, recovery);
        logger.warn(`tapOn display routing failed: ${errorMessage(error)}`, error);
        return withStaleDisplay(
          this.createErrorResult(options.action, errorMessage(error), error),
          error,
        );
      }
    }
    return undefined;
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
  async execute(
    options: TapOnElementOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    // Internal orchestration policy; never part of TapOnElementOptions or tool schemas.
    recovery?: { throwOnKeyboardOcclusion?: boolean },
  ): Promise<TapOnFocusResult> {
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

    try {
      throwIfAborted(signal);
      // Tap on the calculated point using observedChange
      const result = await this.observedInteraction(
        async (observeResult: ObserveResult, fence) => {
          previousObserveResult = observeResult;
          preTapHierarchy = observeResult.viewHierarchy;
          throwIfAborted(signal);

          let viewHierarchy = observeResult.viewHierarchy;
          if (!viewHierarchy) {
            perf.end();
            return { success: false, error: "Unable to get view hierarchy, cannot tap on element" };
          }

          if (options.accessibilityLink) {
            const occurrence = options.index ?? 0;
            const owner = this.resolveContainerElement(
              viewHierarchy,
              this.withObservationScreenSize(options, observeResult),
            );
            if (options.container && !owner) {
              return { success: false, error: "Semantic link container is no longer present" };
            }
            const activation = await this.activateSemanticLink(
              options.accessibilityLink,
              occurrence,
              owner,
              viewHierarchy,
            );
            if (!activation.success) {
              return { success: false, error: activation.error };
            }
            return {
              success: true,
              action: options.action,
              element: {
                text: options.accessibilityLink,
                bounds: { left: 0, top: 0, right: 0, bottom: 0 },
              } as Element,
              activatedSubtext: { text: options.accessibilityLink, occurrence },
            };
          }

          const searchOutcome = await perf.track("findElement", () =>
            this.searchForElement(options, observeResult, signal),
          );
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
            );
          }
          const liveSelection = await this.refreshEnsureCheckedSelection(
            options,
            observeResult,
            searchOutcome.selection,
            signal,
          );
          viewHierarchy = liveSelection.viewHierarchy;
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
            const occurrence = options.subtext.occurrence ?? 0;
            const activation = await this.activateSemanticLink(
              options.subtext.text,
              occurrence,
              element,
              viewHierarchy,
            );
            if (!activation.success) {
              return { success: false, error: activation.error };
            }
            return {
              success: true,
              action: options.action,
              element,
              selectedElement: selectedElementMetadata,
              searchUntil: searchOutcome.stats,
              activatedSubtext: { text: options.subtext.text, occurrence },
            };
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
                error: `Cannot focus ${this.describeFocusTarget(element, options)} because it is not an editable input`,
              };
            }

            focusTarget = element;
            const matchedLabel = searchOutcome.selection.matchedElement;
            if (matchedLabel && matchedLabel !== element) {
              focusLabelText = matchedLabel.text;
            }

            // Check if element is already focused
            const isFocused = this.finder.isElementKeyboardFocused(element);

            if (isFocused) {
              logger.info(`Element is already focused, no action needed`);
              perf.end();
              return {
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
              };
            }

            // if not, change action to tap
            action = "tap";
            options.action = "tap";
          }

          // Strategy returns the platform-relevant boolean: TalkBack on
          // Android, VoiceOver on iOS. Downstream call paths are split by
          // the platform switch below, so a single flag suffices.
          const isAccessibilityServiceEnabled = await this.strategy.isAccessibilityServiceEnabled();
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
              requestedAction === "focus" ? { ...options, action: "focus" as const } : options,
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

          this.logClickableParentSelection(usedParent);
          const screenSize = this.getScreenSizeFromHierarchy(viewHierarchy, {
            observationScreenSize: observeResult.screenSize,
            display: observeResult.viewHierarchy,
          });
          const visibleBounds = this.visibleTapBounds(
            finalSelection,
            viewHierarchy,
            screenSize,
            requestedAction === "focus" ? { ...options, action: "focus" } : options,
            tapElement,
          );
          if (!visibleBounds) {
            throw this.invisibleMatchFailure(
              finalSelection,
              options,
              viewHierarchy,
              screenSize,
              "Matched element has no visible tap area on this screen. " +
                "Scroll it into view with swipeOn, then retry tapOn.",
            );
          }
          const tapPoint = this.resolveVisibleTapPoint(tapElement, viewHierarchy, visibleBounds, {
            options,
            screenSize,
            chromeElements: [
              this.matchedTapElement(
                finalSelection,
                tapElement,
                requestedAction === "focus" ? { ...options, action: "focus" } : options,
              ),
              tapElement,
            ],
          });
          if (!tapPoint) {
            throw this.invisibleMatchFailure(
              finalSelection,
              options,
              viewHierarchy,
              screenSize,
              "Matched element has no unobstructed visible tap area. " +
                "Dismiss the keyboard or scroll it into view, then retry tapOn.",
            );
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

          // Platform-specific tap execution
          await perf.track("executeTap", async () => {
            switch (this.device.platform) {
              case "android":
                screenReaderNavigation = await this.executeAndroidTap(
                  action,
                  tapPoint.x,
                  tapPoint.y,
                  longPressDuration,
                  tapElement,
                  signal,
                  { ...options, displayFence: fence },
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
                  { displayFence: fence },
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
              { ...this.withObservationScreenSize(options, observeResult), displayFence: fence },
              isAccessibilityServiceEnabled,
              observeResult.screenSize,
              signal,
              finalSelection,
            );
          }

          perf.end();
          return {
            success: true,
            action,
            element: tapElement,
            selectedElement: selectedElementMetadata,
            searchUntil: searchOutcome.stats,
            ...(screenReaderNavigation ? { screenReaderNavigation } : {}),
          };
        },
        {
          queryOptions: {
            text: options.text ?? options.textAny?.[0],
            elementId: options.elementId,
            containerElementId: options.container?.elementId,
          },
          changeExpected: false,
          display: options.display,
          timeoutMs: 800, // Reduce timeout for faster execution
          progress,
          perf,
          signal,
          deferPredictionOutcome: true,
          deferPostActionScreenshot: true,
          ...(options.ensureChecked !== undefined
            ? { observationTimestampProvider: () => ensureCheckedTapTimestamp }
            : {}),
          predictionContext: {
            toolName: "tapOn",
            toolArgs: {
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
            },
          },
        },
      );

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
          action: options.action,
          selectionState: selectionCapture,
          currentObservation: result.observation,
          previousObservation: previousObserveResult,
          element: result.element,
          signal,
        });
        if (selectedElements.length > 0) {
          result.observation.selectedElements = selectedElements;
        }
        this.enforceFreshnessConsistencyWithEffect(previousObserveResult, result);
      }

      if (requestedAction === "focus" && result.success && !result.wasAlreadyFocused) {
        const target = focusTarget ?? result.element;
        result.focusVerified = this.verifyFocusedInputTarget(
          { ...options, action: "focus" },
          target,
          result.observation,
          focusLabelText,
          result.selectedElement?.indexInMatches,
          preTapHierarchy,
        );
        if (!result.focusVerified) {
          result.success = false;
          result.error = `Failed to confirm focus on editable input ${this.describeFocusTarget(target, options)}: the focused field could not be matched to the target`;
        }
      }

      if (options.action === "longPress") {
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
      if (error instanceof StaleDisplayError) {
        return withStaleDisplay(this.createErrorResult(options.action, error.message), error);
      }

      // Build debug context if debug mode is enabled
      const debugContext = await buildElementSearchDebugContext(this.device, {
        text: options.text,
        resourceId: options.elementId,
        container: options.container,
      });

      // Return error result with debug info instead of throwing
      const errorMsg = errorMessage(error);
      return markFocusFailure(
        requestedAction,
        {
          success: false,
          action: options.action,
          error: `Failed to perform tap on element: ${errorMsg}`,
          element: {
            bounds: { left: 0, top: 0, right: 0, bottom: 0 },
          } as Element,
          ...(searchUntilStats ? { searchUntil: searchUntilStats } : {}),
          ...(debugContext ? { debug: { elementSearch: debugContext } } : {}),
        },
        error,
      );
    }
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
    options?: TapOnElementOptions & DisplayFenceOption,
    isTalkBackEnabled?: boolean,
  ): Promise<ScreenReaderNavigationResult | undefined> {
    const fence = options?.displayFence;
    // XML-only candidates have no CtrlProxy node identity, even if their resource
    // ID also exists in the incomplete native tree. Never retarget semantic actions.
    if (element["hierarchy-source"] === "uiautomator") {
      await this.executeAndroidTapWithCoordinates(action, x, y, durationMs, element, signal, true, {
        displayFence: fence,
      });
      return undefined;
    }

    // Check if TalkBack is enabled (not just any accessibility service)
    const talkBackEnabled =
      typeof isTalkBackEnabled === "boolean"
        ? isTalkBackEnabled
        : (await this.accessibilityDetector.detectMethod(this.device.deviceId, this.adb)) ===
          "talkback";

    if (options?.container?.container || options?.selectionStrategy === "unique") {
      await this.executeScopedAndroidTap({
        action,
        x,
        y,
        durationMs,
        element,
        signal,
        talkBackEnabled,
        fence,
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
        return;
      }
    }
    await this.executeAndroidTapWithCoordinates(action, x, y, durationMs, element, signal, true, {
      displayFence: fence,
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
    fenceOptions: DisplayFenceOption = {},
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
      await this.executeAndroidLongPress(x, y, durationMs, element, signal, skipSemanticAction, {
        displayFence: fence,
      });
    } else if (action === "doubleTap") {
      await this.dispatchCoordinateTapOrAdbFallback(x, y, element, signal, { displayFence: fence });
      await this.timer.sleep(200);
      await this.dispatchCoordinateTapOrAdbFallback(x, y, element, signal, { displayFence: fence });
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
      options,
      isTalkBackEnabled,
    );
  }

  /**
   * Execute tap using CtrlProxy actions (TalkBack mode).
   *
   * Default (#3936): directly activate the target via ACTION_CLICK — deterministic,
   * no cursor stepping — then fall back to a coordinate gesture, then ADB.
   * When `options.screenReaderNavigation` is set (opt-in fidelity mode, #3937),
   * drive the TalkBack cursor by swipe navigation to the target before activating.
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

  private async executeAndroidTapWithAccessibility(
    action: string,
    x: number,
    y: number,
    element: Element,
    durationMs: number,
    options?: TapOnElementOptions & DisplayFenceOption,
    signal?: AbortSignal,
  ): Promise<ScreenReaderNavigationResult | undefined> {
    const fence = this.readOptionalDisplayFence(options);
    const driver = this.talkBackDriverFactory.createDriver(this.device);
    let screenReaderNavigation: ScreenReaderNavigationResult | undefined;

    if (action === "longPress") {
      // Long press: try ACTION_LONG_CLICK first, then coordinate gesture fallback
      const longPressResult = await this.talkBackStrategy.executeLongPress(
        x,
        y,
        durationMs,
        element,
        driver,
        { displayFence: fence },
      );

      if (!longPressResult.success) {
        if (longPressResult.semanticActionFailure) {
          throw new Error(
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
          false,
          { displayFence: fence },
        );
      }
      return undefined;
    }

    // Long press returned above; the remaining actions are tap and doubleTap.
    if (this.isScreenReaderNavigationEnabled(options)) {
      // Opt-in fidelity mode (#3937): drive the TalkBack cursor by swipe
      // navigation to the target, then activate.
      const result = await this.talkBackStrategy.executeTap(
        this.device.deviceId,
        element,
        driver,
        fence,
      );

      if (result.success) {
        return result.screenReaderNavigation;
      }

      logger.warn(
        `[TapOnElement] Focus navigation failed (${result.error}), ` +
          `falling back to coordinate-based tap at (${x}, ${y})`,
      );
      screenReaderNavigation = result.screenReaderNavigation;
    } else if (action === "tap") {
      // Default (#3936): directly activate the target node via ACTION_CLICK,
      // without moving the cursor. doubleTap has no single accessibility action,
      // so it drops straight to the coordinate fallback below.
      const result = await this.talkBackStrategy.executeDirectActivation(element, driver);

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
    fenceOptions: DisplayFenceOption = {},
  ): Promise<void> {
    const fence = fenceOptions.displayFence;
    if (isVoiceOverEnabled && element) {
      await this.executeIOSTapWithVoiceOver(action, element, x, y, durationMs, {
        displayFence: fence,
      });
      return;
    }

    await this.executeiOSTapWithCoordinates(action, x, y, durationMs, { displayFence: fence });
  }

  /**
   * Execute iOS tap using coordinate-based input (standard mode)
   */
  private async executeiOSTapWithCoordinates(
    action: string,
    x: number,
    y: number,
    durationMs: number,
    fenceOptions: DisplayFenceOption = {},
  ): Promise<void> {
    const fence = fenceOptions.displayFence;
    // Use short duration (50ms) for tap/doubleTap, full duration for longPress
    const tapDuration = action === "longPress" ? durationMs : 50;

    const client = IOSCtrlProxyClient.getInstance(this.device);

    if (action === "doubleTap") {
      // Double tap - perform two taps
      // Once beforeSend lands, also pass this as the dispatch's beforeSend.
      fence?.assertCurrent();
      await dispatchIosCoordinateTap(client, x, y, tapDuration);
      IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache();

      await this.timer.sleep(200);

      // Once beforeSend lands, also pass this as the dispatch's beforeSend.
      fence?.assertCurrent();
      await dispatchIosCoordinateTap(client, x, y, tapDuration, undefined, "second tap");
      IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache();
    } else {
      // Single tap or long press
      // Once beforeSend lands, also pass this as the dispatch's beforeSend.
      fence?.assertCurrent();
      await dispatchIosCoordinateTap(client, x, y, tapDuration);
      IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache();
    }
  }

  private invalidateIosCacheOnSuccess(result: { success: boolean }): void {
    if (result.success) {
      IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache();
    }
  }

  /**
   * Execute iOS tap using VoiceOver accessibility actions.
   * Falls back to coordinate-based tap if no label is resolvable or if the action fails.
   *
   * @param action - The tap action to perform
   * @param element - The target element
   * @param x - Fallback X coordinate
   * @param y - Fallback Y coordinate
   * @param durationMs - Long press duration in milliseconds
   */
  private async executeIOSTapWithVoiceOver(
    action: string,
    element: Element,
    x: number,
    y: number,
    durationMs: number,
    fenceOptions?: DisplayFenceOption,
  ): Promise<void> {
    const fence = this.readOptionalDisplayFence(fenceOptions);
    // Resolve accessibility label: ios-accessibility-label > content-desc > text > fallback
    const label =
      (element["ios-accessibility-label"] as string | undefined) ??
      (typeof element["content-desc"] === "string" && element["content-desc"]
        ? element["content-desc"]
        : undefined) ??
      (typeof element.text === "string" && element.text ? element.text : undefined);

    if (!label) {
      logger.info("[TapOnElement] VoiceOver: no label available, falling back to coordinate tap");
      await this.executeiOSTapWithCoordinates(action, x, y, durationMs, { displayFence: fence });
      return;
    }

    // Map action to VoiceOver action
    const voiceOverAction: "activate" | "long_press" =
      action === "longPress" ? "long_press" : "activate";

    const client = IOSCtrlProxyClient.getInstance(this.device);
    const result = await client.requestVoiceOverActivate(
      label,
      voiceOverAction,
      resolveVoiceOverActivateCtrlProxyTimeoutMs(voiceOverAction, durationMs),
      undefined,
      {
        bounds: element.bounds,
        duration: action === "longPress" ? durationMs : undefined,
      },
    );

    this.invalidateIosCacheOnSuccess(result);

    if (!result.success) {
      logger.warn(
        `[TapOnElement] VoiceOver action failed for label "${label}": ${result.error ?? "unknown error"}, ` +
          `falling back to coordinate tap at (${x}, ${y})`,
      );
      await this.executeiOSTapWithCoordinates(action, x, y, durationMs, { displayFence: fence });
    }
  }

  private readOptionalDisplayFence(options?: DisplayFenceOption): DisplayFence | undefined {
    return options?.displayFence;
  }

  private getLongPressDuration(options: TapOnElementOptions): number {
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
    fenceOptions: DisplayFenceOption = {},
  ): Promise<void> {
    const fence = fenceOptions.displayFence;
    throwIfAborted(signal);
    if (!skipSemanticAction) {
      const selector = stableNodeSelectorForElement(element);
      if (selector && (await this.trySemanticAndroidLongPress(element, selector))) {
        return;
      }
    }

    const longPressTimeoutMs = Math.min(durationMs + 2_000, MAX_SETTIMEOUT_DELAY_MS);
    try {
      // Once beforeSend lands, also pass this as the dispatch's beforeSend.
      fence?.assertCurrent();
      await this.adb.executeCommand(
        `shell input touchscreen swipe ${x} ${y} ${x} ${y} ${durationMs}`,
        longPressTimeoutMs,
        undefined,
        undefined,
        signal,
      );
    } catch (error) {
      if (error instanceof StaleDisplayError) {
        throw error;
      }
      logger.warn(`[TapOnElement] touch input swipe failed, falling back to input swipe: ${error}`);
      // Once beforeSend lands, also pass this as the dispatch's beforeSend.
      fence?.assertCurrent();
      await this.adb.executeCommand(
        `shell input swipe ${x} ${y} ${x} ${y} ${durationMs}`,
        longPressTimeoutMs,
        undefined,
        undefined,
        signal,
      );
    }
  }

  private async trySemanticAndroidLongPress(
    element: Element,
    selector: NonNullable<ReturnType<typeof stableNodeSelectorForElement>>,
  ): Promise<boolean> {
    const needsNodeSelector = requiresNodeSelector(selector);
    if (needsNodeSelector && !(await this.accessibilityService.supportsNodeActionSelectors())) {
      logger.info(
        "[TapOnElement] Runner does not support stable node selectors; using coordinate long press",
      );
      return false;
    }

    try {
      const result = needsNodeSelector
        ? await this.accessibilityService.requestNodeAction("long_click", selector)
        : await this.accessibilityService.requestAction("long_click", selector.resourceId);
      if (result.success) {
        return true;
      }
      if (hasAccessibilityAction(element.actions, "long_click")) {
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
