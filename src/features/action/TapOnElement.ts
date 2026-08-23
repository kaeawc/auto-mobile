import { errorMessage } from "../../utils/describeUnknownError";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import {
  ActionableError,
  BootedDevice,
  Element,
  ElementSelectionResult,
  ObserveResult,
  TapOnElementResult,
  TapOnSelectedElement,
  ViewHierarchyResult
} from "../../models";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import type {
  RelativeTapPosition,
  TapOnElementOptions
} from "../../models/TapOnElementOptions";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import { DefaultElementParser } from "../utility/ElementParser";
import { DefaultElementFinder } from "../utility/ElementFinder";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import { DefaultElementSelector } from "../utility/DefaultElementSelector";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { DEFAULT_VISION_CONFIG, getVisionEnrichedError, type VisionFallbackConfig, type VisionAnalyzer } from "../../vision/index";
import { buildElementSearchDebugContext } from "../../utils/DebugContextBuilder";
import { throwIfAborted } from "../../utils/toolUtils";
import { SelectionStateTracker, SelectionCaptureState, TakeScreenshotCapturer, type ScreenshotCapturer } from "../navigation/SelectionStateTracker";
import { AccessibilityDetector } from "../../utils/interfaces/AccessibilityDetector";
import { accessibilityDetector as defaultAccessibilityDetector } from "../../utils/AccessibilityDetector";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import type { Timer } from "../../utils/SystemTimer";
import { NodeCryptoService } from "../../utils/crypto";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { serverConfig } from "../../utils/ServerConfig";
import { refreshAndroidViewHierarchy } from "./refreshAndroidViewHierarchy";
import { boundsEqual, boundsNearlyEqual } from "../../utils/bounds";
import { androidPreTapConsecutiveStableMatchesRequired } from "./androidPreTapStablePolicy";
import { androidViewHierarchyIndicatesLikelyBlockingLoading } from "../../utils/androidTransientLoading";
import { hasAccessibilityAction, isTruthyFlag } from "../../utils/elementProperties";
import {
  requiresNodeSelector,
  stableNodeSelectorForElement,
  TALKBACK_PRECISE_FOCUS_SETTLE_MS,
  TalkBackTapStrategy,
  type ScreenReaderNavigationResult,
  type TalkBackTapResult
} from "../talkback/TalkBackTapStrategy";
import {
  DefaultTalkBackNavigationDriverFactory,
  type TalkBackNavigationDriverFactory
} from "../talkback/TalkBackNavigationDriver";
import type { IosVoiceOverDetector } from "../../utils/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../../utils/IosVoiceOverDetector";
import type { TapStrategy } from "../../utils/interfaces/TapStrategy";
import { FeatureFlagService } from "../featureFlags/FeatureFlagService";
import { createTapStrategy } from "./strategies/createTapStrategy";
import { LongPressMetadataDetector, type LongPressMetadata } from "./LongPressMetadataDetector";

type SearchUntilStats = NonNullable<TapOnElementResult["searchUntil"]>;

/**
 * Dependencies for TapOnElement that can be injected for testing.
 */
interface TapOnElementDependencies {
  visionConfig?: VisionFallbackConfig;
  screenshotCapturer?: ScreenshotCapturer;
  visionAnalyzer?: VisionAnalyzer;
  selectionStateTracker?: SelectionStateTracker;
  accessibilityDetector?: AccessibilityDetector;
  timer?: Timer;
  elementSelector?: ElementSelector;
  talkBackStrategy?: TalkBackTapStrategy;
  talkBackDriverFactory?: TalkBackNavigationDriverFactory;
  iosVoiceOverDetector?: IosVoiceOverDetector;
  featureFlags?: FeatureFlagService;
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
const POST_TAP_SETTLE_MS = 300;
const POST_TAP_REFRESH_TIMEOUT_MS = 1500;

/** Brief debounce between the original tap and the retry tap when a ghost tap
 *  was detected. Just enough to let any inflight gesture queue drain. */
const PRE_RETRY_DELAY_MS = 100;

/**
 * Command to tap on UI element containing specified text
 */
export class TapOnElement extends BaseVisualChange {
  private finder: ElementFinder;
  private geometry: ElementGeometry;
  private elementParser: ElementParser;
  private accessibilityService: AndroidCtrlProxyClient;
  private visionConfig: VisionFallbackConfig;
  private screenshotCapturer: ScreenshotCapturer;
  private visionAnalyzer: VisionAnalyzer | undefined;
  private selectionStateTracker: SelectionStateTracker;
  private accessibilityDetector: AccessibilityDetector;
  private elementSelector: ElementSelector;
  private viewHierarchy: ViewHierarchy;
  private talkBackStrategy: TalkBackTapStrategy;
  private readonly featureFlags: FeatureFlagService;
  private talkBackDriverFactory: TalkBackNavigationDriverFactory;
  private iosVoiceOverDetector: IosVoiceOverDetector;
  private strategy: TapStrategy;
  private longPressMetadataDetector: LongPressMetadataDetector;
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
  private static readonly ANDROID_PRE_TAP_REFIND_BUDGET_MS = 2500;
  private static readonly ANDROID_PRE_TAP_REFIND_MIN_POLLS = 8;

  /**
   * Extended deadline + poll floor (hard ceilings) applied when the tree shows a
   * blocking loading overlay (progress/shimmer). List rows can stay absent for
   * several seconds while content loads; give the re-find loop more wall-clock time
   * and more guaranteed polls before aborting.
   */
  private static readonly ANDROID_PRE_TAP_REFIND_BUDGET_MS_WHEN_LOADING = 10000;
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
    adb: AdbClient | null = null,
    options: TapOnElementDependencies = {}
  ) {
    super(device, adb, options.timer);
    this.finder = new DefaultElementFinder();
    this.geometry = new DefaultElementGeometry();
    this.elementParser = new DefaultElementParser();
    this.accessibilityService = AndroidCtrlProxyClient.getInstance(device, this.adbFactory);
    this.visionConfig = options.visionConfig || DEFAULT_VISION_CONFIG;
    this.screenshotCapturer = options.screenshotCapturer ?? new TakeScreenshotCapturer(device, this.adbFactory);
    this.visionAnalyzer = options.visionAnalyzer;
    this.viewHierarchy = new ViewHierarchy(device, this.adbFactory);
    this.selectionStateTracker = options.selectionStateTracker ?? new SelectionStateTracker({
      screenshotCapturer: this.screenshotCapturer
    });
    this.accessibilityDetector = options.accessibilityDetector || defaultAccessibilityDetector;
    this.elementSelector = options.elementSelector ?? new DefaultElementSelector();
    this.talkBackDriverFactory = options.talkBackDriverFactory ?? new DefaultTalkBackNavigationDriverFactory(this.adbFactory);
    this.talkBackStrategy = options.talkBackStrategy ?? new TalkBackTapStrategy({
      timer: this.timer,
      driverFactory: this.talkBackDriverFactory,
    });
    this.iosVoiceOverDetector = options.iosVoiceOverDetector ?? defaultIosVoiceOverDetector;
    this.featureFlags = options.featureFlags ?? FeatureFlagService.getInstance();
    this.strategy = options.tapStrategy ?? createTapStrategy(
      device,
      this.adb,
      this.accessibilityDetector,
      this.iosVoiceOverDetector,
      this.featureFlags
    );
    this.longPressMetadataDetector = new LongPressMetadataDetector(this.elementParser);
  }

  /**
   * Create an error result with consistent structure
   * @param action - The intended action
   * @param error - The error message
   * @returns TapOnTextResult with error state
   */
  private createErrorResult(action: string, error: string): TapOnElementResult {
    return {
      success: false,
      action: action,
      error,
      element: {
        bounds: { left: 0, top: 0, right: 0, bottom: 0 }
      } as Element
    };
  }

  private validateOptions(options: TapOnElementOptions): string | null {
    const selectorCount = [options.text, options.elementId, options.testTag, options.textAny].filter(Boolean).length;
    if (selectorCount !== 1) {
      return "tapOn requires exactly one of text, textAny, elementId, or testTag";
    }

    if (options.textAny && options.textAny.length === 0) {
      return "tapOn textAny selector must be non-empty";
    }

    if (options.container) {
      const containerSelectorCount = [options.container.elementId, options.container.text].filter(Boolean).length;
      if (containerSelectorCount !== 1) {
        return "tapOn container must specify exactly one of elementId or text";
      }
    }

    return this.validateRelativePosition(options);
  }

  private validateRelativePosition(options: TapOnElementOptions): string | null {
    if (!options.relativePosition) {
      return null;
    }
    if (this.device.platform !== "android") {
      return "tapOn relativePosition is only supported on Android";
    }
    if (options.action === "focus") {
      return "tapOn relativePosition cannot be used with the focus action";
    }

    const { x, y } = options.relativePosition;
    if (![x, y].every(Number.isFinite)) {
      return "tapOn relativePosition x and y must be finite numbers";
    }
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      return "tapOn relativePosition x and y must be between 0 and 1";
    }

    return null;
  }

  private hasAddressablePixels(bounds: Element["bounds"]): boolean {
    const coordinates = [bounds.left, bounds.top, bounds.right, bounds.bottom];
    return coordinates.every(Number.isFinite)
      && bounds.right - bounds.left >= 1
      && bounds.bottom - bounds.top >= 1;
  }

  private hasValidScreenDimensions(screenSize: ObserveResult["screenSize"]): boolean {
    if (!screenSize) {
      return false;
    }
    return [screenSize.width, screenSize.height].every(
      dimension => Number.isFinite(dimension) && dimension >= 1
    );
  }

  private isPointInHalfOpenBounds(
    point: { x: number; y: number },
    bounds: Element["bounds"]
  ): boolean {
    return point.x >= bounds.left
      && point.x < bounds.right
      && point.y >= bounds.top
      && point.y < bounds.bottom;
  }

  private relativeTapPoint(
    bounds: Element["bounds"],
    relativePosition: RelativeTapPosition
  ): { x: number; y: number } {
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    return {
      x: Math.round(bounds.left + relativePosition.x * (width - 1)),
      y: Math.round(bounds.top + relativePosition.y * (height - 1))
    };
  }

  private resolveTapPoint(
    element: Element,
    screenSize: ObserveResult["screenSize"],
    relativePosition?: RelativeTapPosition
  ): { x: number; y: number } {
    if (!relativePosition) {
      return this.geometry.getElementCenter(element);
    }

    const bounds = element.bounds;
    if (!this.hasAddressablePixels(bounds)) {
      throw new ActionableError(
        `tapOn relativePosition requires valid element bounds, received ${JSON.stringify(bounds)}`
      );
    }

    if (!this.hasValidScreenDimensions(screenSize)) {
      throw new ActionableError(
        "tapOn relativePosition requires valid Android screen dimensions"
      );
    }

    // Android bounds are half-open. Scale across addressable pixels so 0 and 1
    // map to the first and last valid pixels rather than the exclusive edge.
    // Round here, before validation and reporting, to match Android dispatch.
    const point = this.relativeTapPoint(bounds, relativePosition);
    const { x, y } = point;
    if (!this.isPointInHalfOpenBounds(point, bounds)) {
      throw new ActionableError(
        `tapOn relativePosition resolved to (${x}, ${y}) outside element bounds `
        + `${JSON.stringify(bounds)}`
      );
    }

    const screenBounds = {
      left: 0,
      top: 0,
      right: screenSize.width,
      bottom: screenSize.height
    };
    if (!this.isPointInHalfOpenBounds(point, screenBounds)) {
      throw new ActionableError(
        `tapOn relativePosition resolved to (${x}, ${y}) outside screen bounds `
        + `[0, ${screenSize.width}) x [0, ${screenSize.height})`
      );
    }

    return point;
  }

  private getSearchUntilDuration(options: TapOnElementOptions): number {
    const duration = options.searchUntil?.duration ?? TapOnElement.SEARCH_UNTIL_DEFAULT_MS;

    if (!Number.isFinite(duration)) {
      throw new ActionableError("searchUntil.duration must be a number");
    }

    if (duration < TapOnElement.SEARCH_UNTIL_MIN_MS) {
      throw new ActionableError(
        `searchUntil.duration must be at least ${TapOnElement.SEARCH_UNTIL_MIN_MS}ms`
      );
    }

    if (duration > TapOnElement.SEARCH_UNTIL_MAX_MS) {
      throw new ActionableError(
        `searchUntil.duration must be at most ${TapOnElement.SEARCH_UNTIL_MAX_MS}ms`
      );
    }

    return Math.round(duration);
  }

  private hashViewHierarchy(viewHierarchy: ViewHierarchyResult | null): string | null {
    if (!viewHierarchy) {
      return null;
    }
    try {
      return NodeCryptoService.generateCacheKey(JSON.stringify(viewHierarchy.hierarchy));
    } catch (error) {
      logger.debug(`[TapOnElement] Failed to hash view hierarchy: ${error}`);
      return null;
    }
  }

  private isElementTapTargetOffScreen(
    element: Element,
    screenSize?: ObserveResult["screenSize"],
    relativePosition?: RelativeTapPosition
  ): boolean {
    if (!screenSize?.width || !screenSize?.height || !element.bounds) {
      return false;
    }
    if (relativePosition) {
      if (!this.hasAddressablePixels(element.bounds)) {
        return false;
      }
      const point = this.relativeTapPoint(element.bounds, relativePosition);
      if (!this.isPointInHalfOpenBounds(point, element.bounds)) {
        return false;
      }
      return !this.isPointInHalfOpenBounds(point, {
        left: 0,
        top: 0,
        right: screenSize.width,
        bottom: screenSize.height
      });
    }
    const centerX = (element.bounds.left + element.bounds.right) / 2;
    const centerY = (element.bounds.top + element.bounds.bottom) / 2;
    return centerX < 0 || centerX > screenSize.width ||
           centerY < 0 || centerY > screenSize.height;
  }

  private isSelectionTapTargetOffScreen(
    element: Element,
    viewHierarchy: ViewHierarchyResult,
    screenSize: ObserveResult["screenSize"] | undefined,
    options: TapOnElementOptions
  ): boolean {
    const target = options.relativePosition
      ? this.resolveTapTargetElement(element, viewHierarchy, options.action, false).element
      : element;
    return this.isElementTapTargetOffScreen(target, screenSize, options.relativePosition);
  }

  private getScreenSizeFromHierarchy(viewHierarchy: ViewHierarchyResult): ObserveResult["screenSize"] | undefined {
    if (!viewHierarchy.screenWidth || !viewHierarchy.screenHeight) {
      return undefined;
    }

    return {
      width: viewHierarchy.screenWidth,
      height: viewHierarchy.screenHeight
    };
  }

  private updateObservationHierarchy(
    observeResult: ObserveResult,
    viewHierarchy: ViewHierarchyResult
  ): void {
    observeResult.viewHierarchy = viewHierarchy;
    const screenSize = this.getScreenSizeFromHierarchy(viewHierarchy);
    if (screenSize) {
      observeResult.screenSize = screenSize;
    }
  }

  private logClickableParentSelection(usedParent: boolean): void {
    if (usedParent) {
      logger.info("[TapOnElement] Using clickable parent for non-clickable element");
    }
  }

  private requiresResourceIdForTapTarget(
    isAccessibilityServiceEnabled: boolean,
    options: TapOnElementOptions
  ): boolean {
    return isAccessibilityServiceEnabled && !options.relativePosition;
  }

  private async prepareSelectionCapture(
    options: TapOnElementOptions,
    action: string,
    observation: ObserveResult,
    element: Element,
    signal?: AbortSignal
  ): Promise<SelectionCaptureState | null> {
    if (options.relativePosition) {
      // Visual selection enrichment is best-effort; its screenshot await can
      // make a precise coordinate stale before dispatch.
      return null;
    }
    return this.selectionStateTracker.prepare({
      action,
      observation,
      element,
      signal
    });
  }

  private findElementInHierarchy(
    options: TapOnElementOptions,
    viewHierarchy: ViewHierarchyResult
  ): { selection: ElementSelectionResult; containerFound: boolean } {
    const containerFound = this.isContainerAvailable(viewHierarchy, options.container);

    if (options.text) {
      if (options.sibling) {
        return {
          selection: this.elementSelector.selectClickableSiblingOfText(viewHierarchy, options.text, {
            container: options.container,
            fuzzyMatch: true,
            caseSensitive: false,
            strategy: options.selectionStrategy,
            index: options.index
          }),
          containerFound
        };
      }

      return {
        selection: this.elementSelector.selectByText(viewHierarchy, options.text, {
          container: options.container,
          partialMatch: true,
          caseSensitive: false,
          strategy: options.selectionStrategy,
          index: options.index
        }),
        containerFound
      };
    }

    if (options.textAny) {
      let lastSelection: ElementSelectionResult | null = null;
      let offScreenSelection: ElementSelectionResult | null = null;
      const screenSize = this.getScreenSizeFromHierarchy(viewHierarchy);
      for (const text of options.textAny) {
        const selection = options.sibling
          ? this.elementSelector.selectClickableSiblingOfText(viewHierarchy, text, {
            container: options.container,
            fuzzyMatch: true,
            caseSensitive: false,
            strategy: options.selectionStrategy,
            index: options.index
          })
          : this.elementSelector.selectByText(viewHierarchy, text, {
            container: options.container,
            partialMatch: true,
            caseSensitive: false,
            strategy: options.selectionStrategy,
            index: options.index
          });
        lastSelection = selection;
        if (selection.element) {
          if (this.isSelectionTapTargetOffScreen(
            selection.element,
            viewHierarchy,
            screenSize,
            options
          )) {
            offScreenSelection = selection;
            continue;
          }
          return { selection, containerFound };
        }
      }

      if (offScreenSelection) {
        return {
          selection: { ...offScreenSelection, element: null },
          containerFound
        };
      }

      if (lastSelection) {
        return { selection: lastSelection, containerFound };
      }
    }

    if (options.elementId) {
      if (options.sibling) {
        return {
          selection: this.elementSelector.selectClickableSiblingOfResourceId(viewHierarchy, options.elementId, {
            container: options.container,
            partialMatch: false,
            strategy: options.selectionStrategy,
            index: options.index
          }),
          containerFound
        };
      }

      return {
        selection: this.elementSelector.selectByResourceId(viewHierarchy, options.elementId, {
          container: options.container,
          partialMatch: false,
          strategy: options.selectionStrategy,
          index: options.index
        }),
        containerFound
      };
    }

    return {
      selection: this.elementSelector.selectByTestTag(viewHierarchy, this.requireTestTag(options), {
        container: options.container,
        strategy: options.selectionStrategy,
        index: options.index
      }),
      containerFound
    };
  }

  private requireTestTag(options: TapOnElementOptions): string {
    if (!options.testTag) {
      throw new ActionableError("tapOn requires non-blank text, textAny, elementId, or testTag to interact with");
    }
    return options.testTag;
  }

  private prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"]
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
      screenSize
    );
    return filtered ?? rawHierarchy;
  }

  private async refreshViewHierarchy(
    timeoutMs: number,
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal
  ): Promise<ViewHierarchyResult | null> {
    const effectiveTimeoutMs = Math.max(0, timeoutMs);
    switch (this.device.platform) {
      case "android": {
        const rawHierarchy = await refreshAndroidViewHierarchy(
          this.accessibilityService,
          this.viewHierarchy,
          effectiveTimeoutMs,
          signal
        );

        return rawHierarchy
          ? this.prepareViewHierarchyForResponse(rawHierarchy, screenSize)
          : null;
      }
      case "ios":
      {
        const xcTestClient = IOSCtrlProxyClient.getInstance(this.device);
        const rawHierarchy = await xcTestClient.getAccessibilityHierarchy();
        return rawHierarchy
          ? this.prepareViewHierarchyForResponse(rawHierarchy, screenSize)
          : null;
      }
      default:
        throw new ActionableError(`Unsupported platform: ${this.device.platform}`);
    }
  }

  /**
   * Re-fetch the Android hierarchy and re-resolve the tap target until bounds match on enough
   * consecutive successful re-finds (±ε); the required count depends on selector type (see
   * {@link androidPreTapConsecutiveStableMatchesRequired}). Refuses to fall back to pre-refresh
   * coordinates when the refreshed tree does not contain a matching target.
   */
  private async resolveAndroidStableTapTargetAfterRefreshes(
    options: TapOnElementOptions,
    observeResult: ObserveResult,
    action: TapOnElementOptions["action"],
    requireResourceId: boolean,
    signal?: AbortSignal
  ): Promise<
    | { ok: true; viewHierarchy: ViewHierarchyResult; tapElement: Element; usedParent: boolean }
    | { ok: false; error: string }
  > {
    const stableMatchesRequired = androidPreTapConsecutiveStableMatchesRequired(options);
    let prevBounds: Element["bounds"] | null = null;
    let consecutiveStable = 0;
    let best: {
      viewHierarchy: ViewHierarchyResult;
      tapElement: Element;
      usedParent: boolean;
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
      const freshHierarchy = await this.refreshViewHierarchy(
        TapOnElement.ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS,
        observeResult.screenSize,
        signal
      );
      if (!freshHierarchy) {
        // The failed refresh itself burned wall-clock (up to the timeout); exclude
        // that from the deadline too, not just the recovery sleep, otherwise a slow
        // unresponsive proxy still eats the element's patience.
        noHierarchyTimeMs += this.timer.now() - refreshStart;
        consecutiveNoHierarchy++;
        logger.warn(
          `[TapOnElement] Android pre-tap refresh returned no hierarchy ` +
          `(consecutive: ${consecutiveNoHierarchy}/${TapOnElement.ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE}, ` +
          `refind attempt: ${refindAttempt})`
        );
        if (consecutiveNoHierarchy >= TapOnElement.ANDROID_PRE_TAP_NO_HIERARCHY_MAX_CONSECUTIVE) {
          return {
            ok: false,
            error:
              `Android tap aborted: accessibility service was unreachable for ${consecutiveNoHierarchy} consecutive attempts ` +
              `(ctrl-proxy WebSocket unresponsive). The device may be under heavy load or the accessibility service may need reconnection.`
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
          `extending refind budget to ${budgetMs}ms / ${minProductivePolls} polls`
        );
      }

      const refind = this.findElementInHierarchy(options, freshHierarchy);
      if (!refind.selection.element) {
        logger.warn(
          `[TapOnElement] Android pre-tap refresh attempt ${refindAttempt} did not re-find tap target`
        );
        consecutiveStable = 0;
        prevBounds = null;
        continue;
      }

      const refreshed = this.resolveTapTargetElement(
        refind.selection.element as Element,
        freshHierarchy,
        action,
        requireResourceId
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
      best = {
        viewHierarchy: freshHierarchy,
        tapElement: refreshed.element,
        usedParent: refreshed.usedParent
      };

      if (consecutiveStable >= stableMatchesRequired) {
        logger.info(
          `[TapOnElement] Android tap target stable after ${refindAttempt} refresh(es) (bounds matched on last ${stableMatchesRequired} consecutive re-find(s), ε=${TapOnElement.ANDROID_PRE_TAP_BOUNDS_EPSILON_PX}px)`
        );
        return { ok: true, ...best };
      }
    }

    return {
      ok: false,
      error:
        "Android tap aborted: could not re-find the target in the accessibility hierarchy with stable bounds after repeated refreshes (refusing tap using pre-observe coordinates). The UI may still be updating (list, keyboard, loading overlay, or animation)."
    };
  }

  private async searchForElement(
    options: TapOnElementOptions,
    observeResult: ObserveResult,
    signal?: AbortSignal
  ): Promise<{
    selection: ElementSelectionResult;
    viewHierarchy: ViewHierarchyResult;
    containerFound: boolean;
    stats: SearchUntilStats;
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
    let lastHash = this.hashViewHierarchy(viewHierarchy);

    let latestViewHierarchy = viewHierarchy;
    let latestScreenSize =
      this.getScreenSizeFromHierarchy(latestViewHierarchy) ?? observeResult.screenSize;
    const initialSearch = this.findElementInHierarchy(options, latestViewHierarchy);
    let selection = initialSearch.selection;
    let element = selection.element;
    let containerFoundEver = initialSearch.containerFound;

    if (
      !element ||
      this.isSelectionTapTargetOffScreen(
        element,
        latestViewHierarchy,
        latestScreenSize,
        options
      )
    ) {
      if (element) {
        logger.warn(
          `[TapOnElement] Element found but tap target is off-screen, will retry. ` +
          `bounds=${JSON.stringify(element.bounds)}, ` +
          `screen=${latestScreenSize?.width}x${latestScreenSize?.height}`
        );
        selection = { ...selection, element: null };
        element = null;
        offScreenRejections += 1;
      }
      const deadline = startTime + searchDurationMs;
      while (this.timer.now() < deadline) {
        throwIfAborted(signal);
        const remainingTimeMs = Math.max(0, deadline - this.timer.now());
        const refreshedHierarchy = await this.refreshViewHierarchy(
          remainingTimeMs,
          latestScreenSize,
          signal
        );
        requestCount += 1;

        if (!refreshedHierarchy) {
          continue;
        }

        latestViewHierarchy = refreshedHierarchy;
        latestScreenSize =
          this.getScreenSizeFromHierarchy(refreshedHierarchy) ?? latestScreenSize;
        const hash = this.hashViewHierarchy(refreshedHierarchy);
        if (hash && hash !== lastHash) {
          changeCount += 1;
          lastHash = hash;
        } else if (hash && !lastHash) {
          changeCount += 1;
          lastHash = hash;
        }

        const searchResult = this.findElementInHierarchy(options, refreshedHierarchy);
        selection = searchResult.selection;
        element = selection.element;
        containerFoundEver = containerFoundEver || searchResult.containerFound;
        if (
          element &&
          this.isSelectionTapTargetOffScreen(
            element,
            refreshedHierarchy,
            latestScreenSize,
            options
          )
        ) {
          logger.warn(
            `[TapOnElement] Element found but tap target is off-screen, retrying. ` +
            `bounds=${JSON.stringify(element.bounds)}`
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
      logger.error(
        `[TapOnElement] Element was found ${offScreenRejections} time(s) but always with off-screen bounds. ` +
        `The accessibility framework is reporting incorrect bounds for this element.`
      );
    }

    const stats: SearchUntilStats = {
      durationMs: Math.max(0, Math.round(this.timer.now() - startTime)),
      requestCount,
      changeCount
    };

    return {
      selection,
      viewHierarchy: latestViewHierarchy,
      containerFound: containerFoundEver,
      stats
    };
  }

  private buildSelectedElementMetadata(selection: ElementSelectionResult): TapOnSelectedElement | undefined {
    if (!selection.element) {
      return undefined;
    }

    const bounds = selection.element.bounds;
    const center = this.geometry.getElementCenter(selection.element);
    const text = typeof selection.element.text === "string" && selection.element.text.length > 0
      ? selection.element.text
      : (typeof selection.element["content-desc"] === "string"
        ? selection.element["content-desc"]
        : (typeof selection.element["ios-accessibility-label"] === "string"
          ? selection.element["ios-accessibility-label"]
          : ""));
    const resourceId = typeof selection.element["resource-id"] === "string"
      ? selection.element["resource-id"]
      : "";

    return {
      text,
      resourceId,
      bounds: {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        centerX: center.x,
        centerY: center.y
      },
      indexInMatches: selection.indexInMatches,
      totalMatches: selection.totalMatches,
      selectionStrategy: selection.strategy
    };
  }

  private async handleElementNotFound(
    options: TapOnElementOptions,
    observeResult?: ObserveResult,
    containerFound: boolean = true,
    signal?: AbortSignal
  ): Promise<never> {
    if (options.container && !containerFound) {
      const containerLabel = options.container.elementId
        ? `elementId '${options.container.elementId}'`
        : `text '${options.container.text}'`;
      throw new ActionableError(
        `Container element not found with provided ${containerLabel}`
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
        this.visionAnalyzer
      );
      throw new ActionableError(enrichedMsg);
    }

    throw new ActionableError(baseError);
  }

  private isContainerAvailable(
    viewHierarchy: ViewHierarchyResult,
    container?: { elementId?: string; text?: string }
  ): boolean {
    if (!container) {
      return true;
    }

    return this.finder.hasContainerElement(viewHierarchy, container);
  }

  private isClickableElement(element: Element): boolean {
    return isTruthyFlag(element.clickable) || hasAccessibilityAction(element.actions, "click");
  }

  private isLongClickableElement(element: Element): boolean {
    return isTruthyFlag(element["long-clickable"]) ||
      isTruthyFlag(element.longClickable) ||
      hasAccessibilityAction(element.actions, "long_click");
  }

  private isClickableProps(props: Record<string, unknown>): boolean {
    return isTruthyFlag(props.clickable) || hasAccessibilityAction(props.actions, "click");
  }

  private isLongClickableProps(props: Record<string, unknown>): boolean {
    return isTruthyFlag(props["long-clickable"]) ||
      isTruthyFlag(props.longClickable) ||
      hasAccessibilityAction(props.actions, "long_click");
  }

  private nodeMatchesElement(
    target: Element,
    props: Record<string, unknown>,
    parsed: Element
  ): boolean {
    if (!boundsEqual(parsed.bounds, target.bounds)) {
      return false;
    }

    if (target["resource-id"] && props["resource-id"] !== target["resource-id"]) {
      return false;
    }

    if (target.text && props.text !== target.text) {
      return false;
    }

    if (target["content-desc"] && props["content-desc"] !== target["content-desc"]) {
      return false;
    }

    const targetClass = target.class;
    if (targetClass) {
      const nodeClass = (props.class ?? props.className) as string | undefined;
      if (nodeClass !== targetClass) {
        return false;
      }
    }

    return true;
  }

  private findAncestorChain(viewHierarchy: ViewHierarchyResult, target: Element): any[] | null {
    const roots = [
      ...this.elementParser.extractRootNodes(viewHierarchy),
      ...this.elementParser.extractWindowRootNodes(viewHierarchy, "topmost-first")
    ];

    const stack: any[] = [];
    const search = (node: any): any[] | null => {
      stack.push(node);
      const props = this.elementParser.extractNodeProperties(node);
      const parsed = this.elementParser.parseNodeBounds(node);

      if (parsed && this.nodeMatchesElement(target, props, parsed)) {
        const chain = [...stack];
        stack.pop();
        return chain;
      }

      const children = node?.node ? (Array.isArray(node.node) ? node.node : [node.node]) : [];
      for (const child of children) {
        const found = search(child);
        if (found) {
          stack.pop();
          return found;
        }
      }

      stack.pop();
      return null;
    };

    for (const root of roots) {
      const found = search(root);
      if (found) {
        return found;
      }
    }

    return null;
  }

  private findAncestorByPredicate(
    chain: any[],
    predicate: (props: Record<string, unknown>) => boolean,
    requireResourceId: boolean
  ): Element | null {
    for (let i = chain.length - 2; i >= 0; i--) {
      const node = chain[i];
      const props = this.elementParser.extractNodeProperties(node);
      if (!predicate(props)) {
        continue;
      }
      if (requireResourceId && !props["resource-id"]) {
        continue;
      }
      const parsed = this.elementParser.parseNodeBounds(node);
      if (parsed) {
        return parsed;
      }
    }

    return null;
  }

  private selectAncestorForAction(
    chain: any[],
    action: string,
    requireResourceId: boolean
  ): Element | null {
    const primary = action === "longPress"
      ? (props: Record<string, unknown>) => this.isLongClickableProps(props)
      : (props: Record<string, unknown>) => this.isClickableProps(props);
    const secondary = action === "longPress"
      ? (props: Record<string, unknown>) => this.isClickableProps(props)
      : (props: Record<string, unknown>) => this.isLongClickableProps(props);

    return (
      this.findAncestorByPredicate(chain, primary, requireResourceId) ??
      this.findAncestorByPredicate(chain, secondary, requireResourceId)
    );
  }

  private resolveTapTargetElement(
    element: Element,
    viewHierarchy: ViewHierarchyResult | null,
    action: string,
    requireResourceId: boolean
  ): { element: Element; usedParent: boolean } {
    if (this.device.platform !== "android" || !viewHierarchy) {
      return { element, usedParent: false };
    }

    const isLongPress = action === "longPress";
    const isClickable = this.isClickableElement(element);
    const isLongClickable = this.isLongClickableElement(element);

    if (!isLongPress && isClickable) {
      return { element, usedParent: false };
    }

    if (isLongPress && isLongClickable) {
      return { element, usedParent: false };
    }

    const chain = this.findAncestorChain(viewHierarchy, element);
    if (!chain) {
      return { element, usedParent: false };
    }

    const ancestor = this.selectAncestorForAction(chain, action, requireResourceId);
    if (ancestor) {
      return { element: ancestor, usedParent: true };
    }

    if (!isLongPress && isLongClickable) {
      return { element, usedParent: false };
    }

    if (isLongPress && isClickable) {
      return { element, usedParent: false };
    }

    return { element, usedParent: false };
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
    signal?: AbortSignal
  ): Promise<TapOnElementResult> {
    if (!options.action) {
      return this.createErrorResult(options.action, "tap on action is required");
    }

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
    let selectionCapture: SelectionCaptureState | null = null;
    let searchUntilStats: SearchUntilStats | undefined;

    try {
      throwIfAborted(signal);
      // Tap on the calculated point using observedChange
      const result = await this.observedInteraction(
        async (observeResult: ObserveResult) => {
          previousObserveResult = observeResult;
          throwIfAborted(signal);

          let viewHierarchy = observeResult.viewHierarchy;
          if (!viewHierarchy) {
            perf.end();
            return { success: false, error: "Unable to get view hierarchy, cannot tap on element" };
          }

          const searchOutcome = await perf.track("findElement", () =>
            this.searchForElement(options, observeResult, signal)
          );
          searchUntilStats = searchOutcome.stats;
          this.updateObservationHierarchy(observeResult, searchOutcome.viewHierarchy);
          viewHierarchy = searchOutcome.viewHierarchy;
          if (!searchOutcome.selection.element) {
            await this.handleElementNotFound(options, observeResult, searchOutcome.containerFound, signal);
          }
          const selection = searchOutcome.selection;
          const element = selection.element as Element;
          const selectedElementMetadata = this.buildSelectedElementMetadata(selection);
          const initialTapPoint = this.geometry.getElementCenter(element);
          let action = options.action;
          const longPressDuration = this.getLongPressDuration(options);

          if (action === "focus") {
            // Check if element is already focused
            const isFocused = this.finder.isElementFocused(element);

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
                x: initialTapPoint.x,
                y: initialTapPoint.y
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
          const requireResourceId = this.requiresResourceIdForTapTarget(
            isAccessibilityServiceEnabled,
            options
          );
          let tapElement: Element;
          let usedParent: boolean;
          const initialTapTarget = this.resolveTapTargetElement(
            element,
            viewHierarchy,
            action,
            requireResourceId
          );
          tapElement = initialTapTarget.element;
          usedParent = initialTapTarget.usedParent;

          if (this.strategy.shouldRunPreTapStability(options)) {
            const stable = await this.resolveAndroidStableTapTargetAfterRefreshes(
              options,
              observeResult,
              action,
              requireResourceId,
              signal
            );
            if (!stable.ok) {
              perf.end();
              return { success: false, error: stable.error };
            }
            this.updateObservationHierarchy(observeResult, stable.viewHierarchy);
            viewHierarchy = stable.viewHierarchy;
            tapElement = stable.tapElement;
            usedParent = stable.usedParent;
          }

          this.logClickableParentSelection(usedParent);
          const tapPoint = this.resolveTapPoint(
            tapElement,
            observeResult.screenSize,
            options.relativePosition
          );
          const tapBounds = tapElement.bounds;
          logger.info(
            `[TapOnElement] Tapping (${tapPoint.x}, ${tapPoint.y}) on element: ` +
            `text=${JSON.stringify(tapElement.text ?? options.text)}, ` +
            `bounds=${JSON.stringify(tapBounds)}, ` +
            `clickable=${tapElement.clickable}, usedParent=${usedParent}`
          );

          selectionCapture = await this.prepareSelectionCapture(
            options,
            action,
            observeResult,
            tapElement,
            signal
          );

          const preTapHash = options.retryIfNoChange
            ? this.hashViewHierarchy(viewHierarchy)
            : null;
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
                  options,
                  isAccessibilityServiceEnabled
                );
                break;
              case "ios":
                await this.executeiOSTap(action, tapPoint.x, tapPoint.y, longPressDuration, tapElement, isAccessibilityServiceEnabled);
                break;
              default:
                throw new ActionableError(`Unsupported platform: ${this.device.platform}`);
            }
          });

          if (preTapHash && this.strategy.retryTapIfNoChange) {
            await this.retryTapIfNoChange(
              preTapHash,
              tapPoint,
              action,
              longPressDuration,
              tapElement,
              options,
              isAccessibilityServiceEnabled,
              observeResult.screenSize,
              signal,
            );
          }

          perf.end();
          return {
            success: true,
            action,
            element: tapElement,
            selectedElement: selectedElementMetadata,
            searchUntil: searchOutcome.stats,
            x: tapPoint.x,
            y: tapPoint.y,
            ...(screenReaderNavigation ? { screenReaderNavigation } : {}),
          };
        },
        {
          queryOptions: {
            text: options.text ?? options.textAny?.[0],
            elementId: options.elementId,
            containerElementId: options.container?.elementId
          },
          changeExpected: false,
          timeoutMs: 800, // Reduce timeout for faster execution
          progress,
          perf,
          signal,
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
              relativePosition: options.relativePosition,
              platform: this.device.platform
            }
          }
        }
      );

      if (result.success && result.observation && result.element) {
        const selectedElements = await this.selectionStateTracker.finalize({
          action: options.action,
          selectionState: selectionCapture,
          currentObservation: result.observation,
          previousObservation: previousObserveResult,
          element: result.element,
          signal
        });
        if (selectedElements.length > 0) {
          result.observation.selectedElements = selectedElements;
        }
      }

      if (options.action === "longPress") {
        const metadata = this.detectLongPressMetadata(previousObserveResult, result.observation);
        return {
          ...result,
          ...metadata
        };
      }
      return result;
    } catch (error) {
      perf.end();

      // Build debug context if debug mode is enabled
      const debugContext = await buildElementSearchDebugContext(
        this.device,
        {
          text: options.text,
          resourceId: options.elementId,
          container: options.container
        }
      );

      // Return error result with debug info instead of throwing
      const errorMsg = errorMessage(error);
      return {
        success: false,
        action: options.action,
        error: `Failed to perform tap on element: ${errorMsg}`,
        element: {
          bounds: { left: 0, top: 0, right: 0, bottom: 0 }
        } as Element,
        ...(searchUntilStats ? { searchUntil: searchUntilStats } : {}),
        ...(debugContext ? { debug: { elementSearch: debugContext } } : {})
      };
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
  private async executeAndroidTap(
    action: string,
    x: number,
    y: number,
    durationMs: number,
    element: Element,
    signal?: AbortSignal,
    options?: TapOnElementOptions,
    isTalkBackEnabled?: boolean
  ): Promise<ScreenReaderNavigationResult | undefined> {
    // Check if TalkBack is enabled (not just any accessibility service)
    const talkBackEnabled = typeof isTalkBackEnabled === "boolean"
      ? isTalkBackEnabled
      : (await this.accessibilityDetector.detectMethod(this.device.deviceId, this.adb)) === "talkback";

    if (talkBackEnabled) {
      // TalkBack mode: Use accessibility actions or precise coordinate
      // gestures through its CtrlProxy driver, with ADB as the last fallback.
      return this.executeAndroidTapWithAccessibility(action, x, y, element, durationMs, options, signal);
    }

    // Standard mode and precise targets use coordinates. Precise long presses
    // must not be replaced by node-level ACTION_LONG_CLICK because that cannot
    // distinguish targets within one element.
    if (options?.relativePosition) {
      await this.executeAndroidTapWithCoordinates(action, x, y, durationMs, element, signal, true);
    } else {
      await this.executeAndroidTapWithCoordinates(action, x, y, durationMs, element, signal);
    }
    return undefined;
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
    skipSemanticLongPress: boolean = false
  ): Promise<void> {
    if (action === "tap") {
      const result = await this.accessibilityService.requestTapCoordinates(x, y, 10);
      if (!result.success) {
        logger.warn(
          `[TapOnElement] dispatchGesture tap failed (${result.error}), falling back to ADB input`
        );
        await this.adb.executeCommand(`shell input touchscreen tap ${x} ${y}`, undefined, undefined, undefined, signal);
      }
    } else if (action === "longPress") {
      await this.executeAndroidLongPress(x, y, durationMs, element, signal, skipSemanticLongPress);
    } else if (action === "doubleTap") {
      const first = await this.accessibilityService.requestTapCoordinates(x, y, 10);
      if (!first.success) {
        logger.warn(`[TapOnElement] dispatchGesture first tap failed (${first.error}), falling back to ADB`);
        await this.adb.executeCommand(`shell input touchscreen tap ${x} ${y}`, undefined, undefined, undefined, signal);
      }
      await this.timer.sleep(200);
      const second = await this.accessibilityService.requestTapCoordinates(x, y, 10);
      if (!second.success) {
        logger.warn(`[TapOnElement] dispatchGesture second tap failed (${second.error}), falling back to ADB`);
        await this.adb.executeCommand(`shell input touchscreen tap ${x} ${y}`, undefined, undefined, undefined, signal);
      }
    }
  }

  /**
   * After a tap, check if the view hierarchy changed. If unchanged, retry the tap once.
   * Only called when retryIfNoChange is true.
   */
  private async retryTapIfNoChange(
    preTapHash: string,
    tapPoint: { x: number; y: number },
    action: string,
    longPressDuration: number,
    tapElement: Element,
    options: TapOnElementOptions,
    isTalkBackEnabled: boolean,
    screenSize: ObserveResult["screenSize"],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.timer.sleep(POST_TAP_SETTLE_MS);

    const postTapHierarchy = await this.refreshViewHierarchy(
      POST_TAP_REFRESH_TIMEOUT_MS,
      screenSize,
      signal
    );

    if (!postTapHierarchy) {
      // Refresh timed out — we can't tell whether the tap registered. A retry
      // here is more likely to land on a transitioning screen and bounce us
      // off-path than to recover a real ghost tap. Bail and let the next
      // step's waitFor/observe surface a real failure.
      logger.warn(
        `[TapOnElement][retryIfNoChange] Post-tap refresh returned no hierarchy ` +
        `within ${POST_TAP_REFRESH_TIMEOUT_MS}ms — skipping retry (likely activity transition in progress)`
      );
      return;
    }

    const postTapHash = this.hashViewHierarchy(postTapHierarchy);

    if (postTapHash && postTapHash !== preTapHash) {
      logger.info(
        `[TapOnElement][retryIfNoChange] Hierarchy changed after tap — tap registered`
      );
      return;
    }

    logger.warn(
      `[TapOnElement][retryIfNoChange] Hierarchy unchanged after tap at ` +
      `(${tapPoint.x}, ${tapPoint.y}) — ghost tap detected, retrying`
    );

    await this.timer.sleep(PRE_RETRY_DELAY_MS);

    await this.executeAndroidTap(
      action,
      tapPoint.x,
      tapPoint.y,
      longPressDuration,
      tapElement,
      signal,
      options,
      isTalkBackEnabled
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
    return Boolean(options?.screenReaderNavigation)
      || this.featureFlags.isEnabled("screen-reader-navigation");
  }

  private async executeRemainingPreciseTalkBackInput(
    action: string,
    x: number,
    y: number,
    durationMs: number,
    element: Element,
    preciseResult: TalkBackTapResult,
    signal?: AbortSignal
  ): Promise<void> {
    let remainingAction = action;
    if (action === "tap") {
      if (!preciseResult.focusCompleted) {
        await this.executeAndroidTapWithCoordinates(
          "tap",
          x,
          y,
          durationMs,
          element,
          signal,
          true
        );
        await this.timer.sleep(TALKBACK_PRECISE_FOCUS_SETTLE_MS);
      }
      remainingAction = preciseResult.completedTaps === 1 ? "tap" : "doubleTap";
    } else if (action === "doubleTap" && preciseResult.completedTaps === 1) {
      remainingAction = "tap";
    }
    await this.executeAndroidTapWithCoordinates(
      remainingAction,
      x,
      y,
      durationMs,
      element,
      signal,
      true
    );
  }

  private async executeAndroidTapWithAccessibility(
    action: string,
    x: number,
    y: number,
    element: Element,
    durationMs: number,
    options?: TapOnElementOptions,
    signal?: AbortSignal
  ): Promise<ScreenReaderNavigationResult | undefined> {
    const driver = this.talkBackDriverFactory.createDriver(this.device);
    let screenReaderNavigation: ScreenReaderNavigationResult | undefined;

    if (options?.relativePosition) {
      const preciseResult = action === "tap" || action === "doubleTap"
        ? await this.talkBackStrategy.executePreciseTap(x, y, driver)
        : await this.talkBackStrategy.executeCoordinateFallback(
          x,
          y,
          "longPress",
          durationMs,
          driver
        );
      if (!preciseResult.success) {
        logger.warn(
          `[TapOnElement] Precise TalkBack coordinate gesture failed (${preciseResult.error}), ` +
          `falling back to remaining input at (${x}, ${y})`
        );
        await this.executeRemainingPreciseTalkBackInput(
          action,
          x,
          y,
          durationMs,
          element,
          preciseResult,
          signal
        );
      }
      return undefined;
    }

    if (action === "longPress") {
      // Long press: try ACTION_LONG_CLICK first, then coordinate gesture fallback
      const longPressResult = await this.talkBackStrategy.executeLongPress(
        x,
        y,
        durationMs,
        element,
        driver
      );

      if (!longPressResult.success) {
        if (longPressResult.semanticActionFailure) {
          throw new Error(
            `Semantic long press failed for the selected element: ${longPressResult.error ?? "unknown error"}`
          );
        }
        logger.warn(
          `[TapOnElement] Long press accessibility methods failed (${longPressResult.error}), ` +
          `falling back to ADB tap at (${x}, ${y})`
        );
        await this.executeAndroidTapWithCoordinates(action, x, y, durationMs, element, signal);
      }
      return undefined;
    }

    if (action === "tap" || action === "doubleTap") {
      if (this.isScreenReaderNavigationEnabled(options)) {
        // Opt-in fidelity mode (#3937): drive the TalkBack cursor by swipe
        // navigation to the target, then activate.
        const result = await this.talkBackStrategy.executeTap(
          this.device.deviceId,
          element,
          driver
        );

        if (result.success) {
          return result.screenReaderNavigation;
        }

        logger.warn(
          `[TapOnElement] Focus navigation failed (${result.error}), ` +
          `falling back to coordinate-based tap at (${x}, ${y})`
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
          `falling back to coordinate-based tap at (${x}, ${y})`
        );
      }
    }

    // Fallback to coordinate-based taps via accessibility service dispatchGesture
    const fallbackAction = action as "tap" | "doubleTap" | "longPress";
    const fallbackResult = await this.talkBackStrategy.executeCoordinateFallback(
      x,
      y,
      fallbackAction,
      durationMs,
      driver
    );

    if (!fallbackResult.success) {
      logger.warn(
        `[TapOnElement] Accessibility coordinate tap failed (${fallbackResult.error}), ` +
        `falling back to ADB tap at (${x}, ${y})`
      );
      await this.executeAndroidTapWithCoordinates(action, x, y, durationMs, element, signal);
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
  private async executeiOSTap(
    action: string,
    x: number,
    y: number,
    durationMs: number,
    element?: Element,
    isVoiceOverEnabled?: boolean
  ): Promise<void> {
    if (isVoiceOverEnabled && element) {
      await this.executeIOSTapWithVoiceOver(action, element, x, y, durationMs);
      return;
    }

    await this.executeiOSTapWithCoordinates(action, x, y, durationMs);
  }

  /**
   * Execute iOS tap using coordinate-based input (standard mode)
   */
  private async executeiOSTapWithCoordinates(
    action: string,
    x: number,
    y: number,
    durationMs: number
  ): Promise<void> {
    // Use short duration (50ms) for tap/doubleTap, full duration for longPress
    const tapDuration = action === "longPress" ? durationMs : 50;

    const client = IOSCtrlProxyClient.getInstance(this.device);

    if (action === "doubleTap") {
      // Double tap - perform two taps
      const firstResult = await client.requestTapCoordinates(x, y, tapDuration);
      if (!firstResult.success) {
        throw new ActionableError(`CtrlProxy iOS tap failed: ${firstResult.error}`);
      }

      await this.timer.sleep(200);

      const secondResult = await client.requestTapCoordinates(x, y, tapDuration);
      if (!secondResult.success) {
        throw new ActionableError(`CtrlProxy iOS second tap failed: ${secondResult.error}`);
      }
    } else {
      // Single tap or long press
      const result = await client.requestTapCoordinates(x, y, tapDuration);
      if (!result.success) {
        throw new ActionableError(`CtrlProxy iOS tap failed: ${result.error}`);
      }
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
    durationMs: number
  ): Promise<void> {
    // Resolve accessibility label: ios-accessibility-label > content-desc > text > fallback
    const label = (element["ios-accessibility-label"] as string | undefined)
      ?? (typeof element["content-desc"] === "string" && element["content-desc"] ? element["content-desc"] : undefined)
      ?? (typeof element.text === "string" && element.text ? element.text : undefined);

    if (!label) {
      logger.info("[TapOnElement] VoiceOver: no label available, falling back to coordinate tap");
      await this.executeiOSTapWithCoordinates(action, x, y, durationMs);
      return;
    }

    // Map action to VoiceOver action
    const voiceOverAction: "activate" | "long_press" = action === "longPress" ? "long_press" : "activate";

    const client = IOSCtrlProxyClient.getInstance(this.device);
    const result = await client.requestVoiceOverActivate(label, voiceOverAction);

    if (!result.success) {
      logger.warn(
        `[TapOnElement] VoiceOver action failed for label "${label}": ${result.error ?? "unknown error"}, ` +
        `falling back to coordinate tap at (${x}, ${y})`
      );
      await this.executeiOSTapWithCoordinates(action, x, y, durationMs);
    }
  }

  private getLongPressDuration(options: TapOnElementOptions): number {
    if (typeof options.duration === "number" && options.duration > 0) {
      return options.duration;
    }
    return this.strategy.longPressDurationMs;
  }


  private async executeAndroidLongPress(
    x: number,
    y: number,
    durationMs: number,
    element: Element,
    signal?: AbortSignal,
    skipSemanticAction: boolean = false
  ): Promise<void> {
    throwIfAborted(signal);
    if (!skipSemanticAction) {
      const selector = stableNodeSelectorForElement(element);
      if (selector && await this.trySemanticAndroidLongPress(element, selector)) {
        return;
      }
    }

    try {
      await this.adb.executeCommand(`shell input touchscreen swipe ${x} ${y} ${x} ${y} ${durationMs}`, undefined, undefined, undefined, signal);
    } catch (error) {
      logger.warn(`[TapOnElement] touch input swipe failed, falling back to input swipe: ${error}`);
      await this.adb.executeCommand(`shell input swipe ${x} ${y} ${x} ${y} ${durationMs}`, undefined, undefined, undefined, signal);
    }
  }

  private async trySemanticAndroidLongPress(
    element: Element,
    selector: NonNullable<ReturnType<typeof stableNodeSelectorForElement>>
  ): Promise<boolean> {
    const needsNodeSelector = requiresNodeSelector(selector);
    if (needsNodeSelector && !(await this.accessibilityService.supportsNodeActionSelectors())) {
      logger.info(
        "[TapOnElement] Runner does not support stable node selectors; using coordinate long press"
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
          `Semantic long press failed for the selected element: ${result.error ?? "unknown error"}`
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
    currentObservation?: ObserveResult
  ): LongPressMetadata {
    return this.longPressMetadataDetector.detect(previousObservation, currentObservation);
  }
}
