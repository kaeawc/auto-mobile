import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import {
  ActionableError,
  BootedDevice,
  Element,
  ElementSelectionResult,
  ObserveResult,
  CurrentFocusResult,
  TapOnElementResult,
  TapOnInjectionAttempt,
  TapOnSelectedElement,
  TapOnTapDebug,
  TapOnTapDiagnostics,
  TapOnFocusDebug,
  TapOnHitTestDebug,
  ViewHierarchyResult
} from "../../models";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import { DefaultElementParser } from "../utility/ElementParser";
import { DefaultElementFinder } from "../utility/ElementFinder";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import { DefaultElementSelector } from "../utility/DefaultElementSelector";
import { logger } from "../../utils/logger";
import { CtrlProxyClient as AndroidCtrlProxyClient } from "../observe/android";
import type { AndroidHitTestResult } from "../observe/android/types";
import { CtrlProxyClient as IOSCtrlProxyClient } from "../observe/ios";
import { createGlobalPerformanceTracker, NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
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
import { attachRawViewHierarchy } from "../../utils/viewHierarchySearch";
import { refreshAndroidViewHierarchy } from "./refreshAndroidViewHierarchy";
import { androidPreTapConsecutiveStableMatchesRequired } from "./androidPreTapStablePolicy";
import { boundsEqual, boundsNearlyEqual } from "../../utils/bounds";
import { androidViewHierarchyIndicatesLikelyBlockingLoading } from "../../utils/androidTransientLoading";
import type { Point } from "../../models/Point";
import { isTruthyFlag } from "../../utils/elementProperties";
import { TalkBackTapStrategy } from "../talkback/TalkBackTapStrategy";
import {
  DefaultTalkBackNavigationDriverFactory,
  type TalkBackNavigationDriverFactory
} from "../talkback/TalkBackNavigationDriver";
import type { IosVoiceOverDetector } from "../../utils/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../../utils/IosVoiceOverDetector";

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
}

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
  private talkBackDriverFactory: TalkBackNavigationDriverFactory;
  private iosVoiceOverDetector: IosVoiceOverDetector;
  private static readonly SEARCH_UNTIL_DEFAULT_MS = 500;
  private static readonly SEARCH_UNTIL_MIN_MS = 100;
  private static readonly SEARCH_UNTIL_MAX_MS = 12000;

  /** Duration passed to AccessibilityService.dispatchGesture for a normal tap (matches TalkBack fallback). */
  private static readonly CTRL_PROXY_TAP_DURATION_MS = 50;

  private static readonly CTRL_PROXY_TAP_TIMEOUT_MS = 5000;

  /** CtrlProxy focus + hit-test queries around each tap (keep small to avoid slowing plans). */
  private static readonly TAP_DIAGNOSTICS_TIMEOUT_MS = 1200;

  /** Android: refresh + re-find attempts before tap (includes stability requirement). */
  private static readonly ANDROID_PRE_TAP_REFIND_MAX_ATTEMPTS = 8;

  /**
   * When the tree shows a loading overlay (progress/shimmer), list rows may be absent for longer than
   * {@link ANDROID_PRE_TAP_REFIND_MAX_ATTEMPTS} polling cycles; allow extra refreshes before aborting.
   */
  private static readonly ANDROID_PRE_TAP_REFIND_MAX_ATTEMPTS_WHEN_LOADING = 32;

  private static readonly ANDROID_PRE_TAP_REFIND_DELAY_MS = 150;

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
    this.talkBackStrategy = options.talkBackStrategy ?? new TalkBackTapStrategy({ timer: this.timer });
    this.talkBackDriverFactory = options.talkBackDriverFactory ?? new DefaultTalkBackNavigationDriverFactory(this.adbFactory);
    this.iosVoiceOverDetector = options.iosVoiceOverDetector ?? defaultIosVoiceOverDetector;
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
    const selectorCount = [
      options.text,
      options.elementId,
      options.clickable,
      options.siblingOfText
    ].filter(Boolean).length;
    if (selectorCount !== 1) {
      return "tapOn requires exactly one of text, elementId, clickable, or siblingOfText";
    }

    if (options.container) {
      const containerSelectorCount = [options.container.elementId, options.container.text].filter(Boolean).length;
      if (containerSelectorCount !== 1) {
        return "tapOn container must specify exactly one of elementId or text";
      }
    }

    return null;
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

  private findElementInHierarchy(
    options: TapOnElementOptions,
    viewHierarchy: ViewHierarchyResult
  ): { selection: ElementSelectionResult; containerFound: boolean } {
    const containerFound = this.isContainerAvailable(viewHierarchy, options.container);

    const textFuzzy = options.exactText !== true;

    if (options.siblingOfText) {
      return {
        selection: this.elementSelector.selectClickableSiblingOfText(viewHierarchy, options.siblingOfText, {
          container: options.container,
          fuzzyMatch: textFuzzy,
          caseSensitive: false,
          strategy: options.selectionStrategy
        }),
        containerFound
      };
    }

    if (options.text) {
      // If tapClickableParent is true, find the clickable parent containing the text
      if (options.tapClickableParent) {
        return {
          selection: this.elementSelector.selectClickableParentByText(viewHierarchy, options.text, {
            container: options.container,
            fuzzyMatch: textFuzzy,
            caseSensitive: false,
            strategy: options.selectionStrategy
          }),
          containerFound
        };
      }

      // Standard text selection
      return {
        selection: this.elementSelector.selectByText(viewHierarchy, options.text, {
          container: options.container,
          partialMatch: textFuzzy,
          caseSensitive: false,
          strategy: options.selectionStrategy
        }),
        containerFound
      };
    }

    if (options.elementId) {
      return {
        selection: this.elementSelector.selectByResourceId(viewHierarchy, options.elementId, {
          container: options.container,
          partialMatch: false,
          strategy: options.selectionStrategy
        }),
        containerFound
      };
    }

    if (options.clickable) {
      return {
        selection: this.elementSelector.selectClickable(viewHierarchy, {
          container: options.container,
          strategy: options.selectionStrategy,
          scrollableContainer: options.scrollableContainer
        }),
        containerFound
      };
    }

    throw new ActionableError("tapOn requires non-blank text, elementId, clickable, or siblingOfText to interact with");
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

    if (this.device.platform === "android") {
      const filtered = this.viewHierarchy.filterViewHierarchy(rawHierarchy);
      attachRawViewHierarchy(filtered, rawHierarchy);
      return filtered;
    }

    if (this.device.platform === "ios" && screenSize?.width && screenSize?.height) {
      const filtered = this.viewHierarchy.filterOffscreenNodes(
        rawHierarchy,
        screenSize.width,
        screenSize.height
      );
      attachRawViewHierarchy(filtered, rawHierarchy);
      return filtered;
    }

    return rawHierarchy;
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
    isTalkBackEnabled: boolean,
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

    let maxAttempts = TapOnElement.ANDROID_PRE_TAP_REFIND_MAX_ATTEMPTS;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      throwIfAborted(signal);
      if (attempt > 0) {
        await this.timer.sleep(TapOnElement.ANDROID_PRE_TAP_REFIND_DELAY_MS);
      }

      const freshHierarchy = await this.refreshViewHierarchy(
        800,
        observeResult.screenSize,
        signal
      );
      if (!freshHierarchy) {
        logger.warn(
          `[TapOnElement] Android pre-tap refresh attempt ${attempt + 1}/${maxAttempts} returned no hierarchy`
        );
        consecutiveStable = 0;
        prevBounds = null;
        continue;
      }

      if (
        androidViewHierarchyIndicatesLikelyBlockingLoading(freshHierarchy, this.elementParser) &&
        maxAttempts < TapOnElement.ANDROID_PRE_TAP_REFIND_MAX_ATTEMPTS_WHEN_LOADING
      ) {
        maxAttempts = TapOnElement.ANDROID_PRE_TAP_REFIND_MAX_ATTEMPTS_WHEN_LOADING;
        logger.info(
          `[TapOnElement] Android pre-tap: loading/progress indicators present; extending refind attempts to ${maxAttempts}`
        );
      }

      const refind = this.findElementInHierarchy(options, freshHierarchy);
      if (!refind.selection.element) {
        logger.warn(
          `[TapOnElement] Android pre-tap refresh attempt ${attempt + 1}/${maxAttempts} did not re-find tap target`
        );
        consecutiveStable = 0;
        prevBounds = null;
        continue;
      }

      const refreshed = this.resolveTapTargetElement(
        refind.selection.element as Element,
        freshHierarchy,
        action,
        isTalkBackEnabled
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
          `[TapOnElement] Android tap target stable after ${attempt + 1} refresh(es) (bounds matched on last ${stableMatchesRequired} consecutive re-find(s), ε=${TapOnElement.ANDROID_PRE_TAP_BOUNDS_EPSILON_PX}px)`
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
    let lastHash = this.hashViewHierarchy(viewHierarchy);

    let latestViewHierarchy = viewHierarchy;
    const initialSearch = this.findElementInHierarchy(options, latestViewHierarchy);
    let selection = initialSearch.selection;
    let element = selection.element;
    let containerFoundEver = initialSearch.containerFound;

    if (!element) {
      const deadline = startTime + searchDurationMs;
      while (this.timer.now() < deadline) {
        throwIfAborted(signal);
        const remainingTimeMs = Math.max(0, deadline - this.timer.now());
        const refreshedHierarchy = await this.refreshViewHierarchy(
          remainingTimeMs,
          observeResult.screenSize,
          signal
        );
        requestCount += 1;

        if (!refreshedHierarchy) {
          continue;
        }

        latestViewHierarchy = refreshedHierarchy;
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
        if (element) {
          break;
        }
      }
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

  private buildTapOnTapDebug(params: {
    platform: "android";
    action: string;
    tapPoint: { x: number; y: number };
    tapElement: Element;
    usedClickableParent: boolean;
    injectionAttempts: TapOnInjectionAttempt[];
    observation?: ObserveResult;
    diagnostics?: TapOnTapDiagnostics;
    androidTapGeometry?: TapOnTapDebug["androidTapGeometry"];
    androidTimingMs?: TapOnTapDebug["androidTimingMs"];
    androidSemanticResolution?: TapOnTapDebug["androidSemanticResolution"];
  }): TapOnTapDebug {
    const b = params.tapElement.bounds;
    return {
      platform: params.platform,
      action: params.action,
      tapPoint: params.tapPoint,
      tapTargetBounds: {
        left: b.left,
        top: b.top,
        right: b.right,
        bottom: b.bottom
      },
      tapTargetResourceId:
        typeof params.tapElement["resource-id"] === "string"
          ? params.tapElement["resource-id"]
          : undefined,
      tapTargetClass:
        typeof params.tapElement.class === "string" ? params.tapElement.class : undefined,
      usedClickableParent: params.usedClickableParent,
      injectionAttempts: params.injectionAttempts,
      observationAfter: params.observation
        ? {
          updatedAt: params.observation.updatedAt,
          freshnessWarning: params.observation.freshness?.warning
        }
        : undefined,
      diagnostics: params.diagnostics,
      androidTapGeometry: params.androidTapGeometry,
      androidTimingMs: params.androidTimingMs,
      androidSemanticResolution: params.androidSemanticResolution
    };
  }

  private focusResultToDebug(result: CurrentFocusResult): TapOnFocusDebug | null {
    if (result.error) {
      return { error: result.error };
    }
    const el = result.focusedElement;
    if (!el) {
      return null;
    }
    return {
      resourceId: typeof el["resource-id"] === "string" ? el["resource-id"] : undefined,
      className: typeof el.class === "string" ? el.class : undefined,
      text: typeof el.text === "string" ? el.text : undefined,
      focused: this.finder.isElementFocused(el)
    };
  }

  private hitTestLayerToDebug(layer: NonNullable<AndroidHitTestResult["layers"]>[number]): TapOnHitTestLayerDebug {
    const d = layer.deepest;
    return {
      windowIndex: layer.windowIndex,
      windowType: layer.windowType,
      windowLayer: layer.windowLayer,
      active: layer.active,
      focused: layer.focused,
      rootBounds: layer.rootBounds,
      deepest: {
        resourceId: d.resourceId,
        className: d.className,
        text: d.text,
        clickable: d.clickable,
        focused: d.focused,
        bounds: d.bounds
      }
    };
  }

  private hitTestResultToDebug(hit: AndroidHitTestResult): TapOnHitTestDebug {
    const d = hit.deepest;
    return {
      x: hit.x,
      y: hit.y,
      success: hit.success,
      error: hit.error,
      totalTimeMs: hit.totalTimeMs,
      deepest: d
        ? {
          resourceId: d.resourceId,
          className: d.className,
          text: d.text,
          clickable: d.clickable,
          focused: d.focused,
          bounds: d.bounds
        }
        : undefined,
      layers: hit.layers?.map(layer => this.hitTestLayerToDebug(layer)),
      chosenWindowZIndex: hit.chosenWindowZIndex,
      activeWindowZIndex: hit.activeWindowZIndex,
      windowCount: hit.windowCount,
      hitTestSource: hit.hitTestSource
    };
  }

  private async fillAndroidTapDiagnosticsAround(
    x: number,
    y: number,
    phase: "before" | "after",
    out: TapOnTapDiagnostics,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    try {
      const [focus, hit] = await Promise.all([
        this.accessibilityService.requestCurrentFocus(TapOnElement.TAP_DIAGNOSTICS_TIMEOUT_MS, new NoOpPerformanceTracker()),
        this.accessibilityService.requestHitTest(x, y, TapOnElement.TAP_DIAGNOSTICS_TIMEOUT_MS, new NoOpPerformanceTracker())
      ]);
      if (phase === "before") {
        out.focusBeforeTap = this.focusResultToDebug(focus);
        out.hitTestBeforeTap = this.hitTestResultToDebug(hit);
      } else {
        out.focusAfterTap = this.focusResultToDebug(focus);
        out.hitTestAfterTap = this.hitTestResultToDebug(hit);
      }
    } catch (error) {
      logger.debug(`[TapOnElement] ${phase} tap diagnostics failed: ${error}`);
    }
  }

  /**
   * Prefer ACTION_CLICK with bounds disambiguation (CtrlProxy) before coordinate gestures.
   * Helps list rows / search UIs where dispatchGesture succeeds but the app ignores the tap.
   */
  private async tryAndroidSemanticClick(
    element: Element,
    signal?: AbortSignal,
    disambiguationBoundsOverride?: { left: number; top: number; right: number; bottom: number },
    semanticClickOptions?: { omitFrameworkResourceId?: boolean }
  ): Promise<{
    success: boolean;
    error?: string;
    resolution?: TapOnTapDebug["androidSemanticResolution"];
  }> {
    const resourceIdRaw = typeof element["resource-id"] === "string" ? element["resource-id"].trim() : "";
    const frameworkResourceId =
      resourceIdRaw.startsWith("android:id/") && resourceIdRaw.length > 0;
    const resourceIdForRequest =
      semanticClickOptions?.omitFrameworkResourceId === true && frameworkResourceId
        ? undefined
        : resourceIdRaw.length > 0
          ? resourceIdRaw
          : undefined;
    const b = disambiguationBoundsOverride ?? element.bounds;
    if (
      !b
      || !Number.isFinite(b.left)
      || !Number.isFinite(b.top)
      || !Number.isFinite(b.right)
      || !Number.isFinite(b.bottom)
    ) {
      return { success: false, error: "tap target has no bounds for semantic click disambiguation" };
    }
    throwIfAborted(signal);
    const disambiguationBounds = {
      left: Math.round(b.left),
      top: Math.round(b.top),
      right: Math.round(b.right),
      bottom: Math.round(b.bottom)
    };
    const boundsSource = disambiguationBoundsOverride ? "label∩row" : "element";
    const resourceIdLog =
      semanticClickOptions?.omitFrameworkResourceId === true && frameworkResourceId
        ? `(bounds-only; omitted ${resourceIdRaw})`
        : (resourceIdForRequest ?? "(bounds-only)");
    logger.info(
      `[TapOnElement] Android semantic click (CtrlProxy performAction): device=${this.device.deviceId} ` +
        `resourceId=${resourceIdLog} bounds=${JSON.stringify(disambiguationBounds)} ` +
        `(disambiguation=${boundsSource}). ` +
        `CtrlProxy may exclude IME windows when an APPLICATION window intersects these bounds (list row + keyboard).`
    );
    const result = await this.accessibilityService.requestAction(
      "click",
      resourceIdForRequest,
      TapOnElement.CTRL_PROXY_TAP_TIMEOUT_MS,
      new NoOpPerformanceTracker(),
      disambiguationBounds
    );
    if (!result.success) {
      logger.warn(
        `[TapOnElement] Semantic click failed device=${this.device.deviceId}: ${result.error ?? "unknown"}. ` +
          `Next: dispatchGesture / adb tap; hitTest uses topmost z-order window (not only rootInActiveWindow).`
      );
    } else {
      logger.info(`[TapOnElement] Semantic click succeeded device=${this.device.deviceId}`);
    }
    return {
      success: result.success,
      error: result.error,
      resolution: result.resolution
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
    if (options.siblingOfText) {
      baseError = `No clickable sibling found next to element with text '${options.siblingOfText}'${containerHint}`;
    } else if (options.text) {
      baseError = `Element not found with provided text '${options.text}'${containerHint}`;
    } else if (options.clickable) {
      baseError = `No clickable element found${containerHint}`;
    } else {
      baseError = `Element not found with provided elementId '${options.elementId}'${containerHint}`;
    }

    if (this.visionConfig.enabled && observeResult) {
      logger.info("🔍 Element not found after polling, trying vision fallback...");
      const enrichedMsg = await getVisionEnrichedError(
        this.screenshotCapturer,
        observeResult.viewHierarchy,
        {
          text: options.text,
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
    return isTruthyFlag(element.clickable);
  }

  private isLongClickableElement(element: Element): boolean {
    return isTruthyFlag(element["long-clickable"]) || isTruthyFlag(element.longClickable);
  }

  private isClickableProps(props: Record<string, unknown>): boolean {
    return isTruthyFlag(props.clickable);
  }

  private isLongClickableProps(props: Record<string, unknown>): boolean {
    return isTruthyFlag(props["long-clickable"]) || isTruthyFlag(props.longClickable);
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
   * Prefer an exact text match when resolving label bounds for {@link TapOnElementOptions.tapClickableParent}
   * so a partial match does not bind the wrong row (flaky list / search UIs).
   */
  private findLabelTextElementForTapClickableParent(
    options: TapOnElementOptions,
    viewHierarchy: ViewHierarchyResult
  ): Element | null {
    if (!options.text) {
      return null;
    }
    const container = options.container ?? null;
    const exact = this.finder.findElementByText(viewHierarchy, options.text, container, false, false);
    if (exact) {
      return exact;
    }
    if (options.exactText) {
      return null;
    }
    return this.finder.findElementByText(viewHierarchy, options.text, container, true, false);
  }

  /**
   * Clamp a point to the interior of a screen rect (Android bounds are left/top inclusive, right/bottom exclusive).
   */
  private clampPointToRectInterior(
    point: Point,
    rect: { left: number; top: number; right: number; bottom: number },
    inset: number
  ): Point {
    const left = rect.left + inset;
    const top = rect.top + inset;
    const right = rect.right - inset;
    const bottom = rect.bottom - inset;
    if (left >= right || top >= bottom) {
      return {
        x: Math.floor((rect.left + rect.right) / 2),
        y: Math.floor((rect.top + rect.bottom) / 2)
      };
    }
    return {
      x: Math.floor(Math.min(Math.max(point.x, left), right - 1)),
      y: Math.floor(Math.min(Math.max(point.y, top), bottom - 1))
    };
  }

  /**
   * Intersection of the clickable row bounds and the visible text node for {@link options.text}.
   * Used to tighten coordinate taps so sampling stays on the label instead of row padding or
   * IME-adjacent dead zones. Semantic CtrlProxy clicks use full row bounds when
   * {@link TapOnElementOptions.tapClickableParent} is set (see {@link TapOnElement.execute}).
   */
  private resolveAndroidLabelRowOverlapBoundsForClickableParent(
    options: TapOnElementOptions,
    tapElement: Element,
    viewHierarchy: ViewHierarchyResult
  ): { left: number; top: number; right: number; bottom: number } | null {
    const rowBounds = tapElement.bounds;
    if (!rowBounds || !options.text) {
      return null;
    }
    const textEl = this.findLabelTextElementForTapClickableParent(options, viewHierarchy);
    if (!textEl?.bounds) {
      return null;
    }
    const tb = textEl.bounds;
    const left = Math.max(rowBounds.left, tb.left);
    const top = Math.max(rowBounds.top, tb.top);
    const right = Math.min(rowBounds.right, tb.right);
    const bottom = Math.min(rowBounds.bottom, tb.bottom);
    if (left >= right || top >= bottom) {
      logger.debug(
        "[TapOnElement] tapClickableParent: text bounds do not overlap row bounds; no label overlap rect"
      );
      return null;
    }
    return { left, top, right, bottom };
  }

  /**
   * When tapping a clickable list/search row by contained text, the row's geometric center can sit
   * on padding, dividers, or a window overlay while the label is offset (e.g. left-aligned name).
   * Gesture injection targets screen coordinates. Prefer the label node's center (clamped inside the
   * row) when it lies in the label∩row overlap — hit-testing often reports a non-clickable
   * {@code FrameLayout} at the overlap centroid when the real {@code TextView} is smaller.
   */
  private resolveAndroidCoordinateTapPointForClickableParent(
    options: TapOnElementOptions,
    tapElement: Element,
    viewHierarchy: ViewHierarchyResult
  ): Point {
    const rowCenter = this.geometry.getElementCenter(tapElement);
    const rowBounds = tapElement.bounds;
    if (!options.text || !rowBounds) {
      return rowCenter;
    }
    const textEl = this.findLabelTextElementForTapClickableParent(options, viewHierarchy);
    const textCenter =
      textEl !== undefined &&
      textEl !== null &&
      textEl.bounds !== undefined &&
      textEl.bounds !== null
        ? this.geometry.getElementCenter(textEl as Element)
        : null;
    const clampedTextCenter =
      textCenter !== null ? this.clampPointToRectInterior(textCenter, rowBounds, 2) : null;

    const overlap = this.resolveAndroidLabelRowOverlapBoundsForClickableParent(
      options,
      tapElement,
      viewHierarchy
    );

    const pointInOverlap = (p: Point, o: { left: number; top: number; right: number; bottom: number }) =>
      p.x >= o.left && p.x < o.right && p.y >= o.top && p.y < o.bottom;

    if (clampedTextCenter && overlap && pointInOverlap(clampedTextCenter, overlap)) {
      const oc = {
        x: Math.floor((overlap.left + overlap.right) / 2),
        y: Math.floor((overlap.top + overlap.bottom) / 2)
      };
      if (clampedTextCenter.x !== oc.x || clampedTextCenter.y !== oc.y) {
        logger.info(
          `[TapOnElement] tapClickableParent: coordinate tap at text-bbox center clamped to row ` +
            `(${clampedTextCenter.x},${clampedTextCenter.y}) instead of overlap center (${oc.x},${oc.y})`
        );
      }
      return clampedTextCenter;
    }

    if (overlap) {
      const p: Point = {
        x: Math.floor((overlap.left + overlap.right) / 2),
        y: Math.floor((overlap.top + overlap.bottom) / 2)
      };
      if (clampedTextCenter && !pointInOverlap(clampedTextCenter, overlap)) {
        logger.info(
          `[TapOnElement] tapClickableParent: text center outside label∩row overlap; ` +
            `using overlap center (${p.x},${p.y})`
        );
      } else if (p.x !== rowCenter.x || p.y !== rowCenter.y) {
        logger.info(
          `[TapOnElement] tapClickableParent: coordinate tap at label overlap (${p.x},${p.y}) ` +
            `instead of row center (${rowCenter.x},${rowCenter.y})`
        );
      }
      return p;
    }

    if (clampedTextCenter) {
      logger.info(
        `[TapOnElement] tapClickableParent: no label∩row overlap; tap at text center clamped to row ` +
          `(${clampedTextCenter.x},${clampedTextCenter.y})`
      );
      return clampedTextCenter;
    }

    return rowCenter;
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

    const validationError = this.validateOptions(options);
    if (validationError) {
      return this.createErrorResult(options.action, validationError);
    }

    const perf = createGlobalPerformanceTracker();
    perf.serial("tapOnElement");
    let previousObserveResult: ObserveResult | null = null;
    let selectionCapture: SelectionCaptureState | null = null;
    let searchUntilStats: SearchUntilStats | undefined;
    let tapDebugParts: {
      action: string;
      tapPoint: { x: number; y: number };
      tapElement: Element;
      usedClickableParent: boolean;
      injectionAttempts: TapOnInjectionAttempt[];
      diagnostics?: TapOnTapDiagnostics;
      androidTapGeometry?: TapOnTapDebug["androidTapGeometry"];
      androidTimingMs?: TapOnTapDebug["androidTimingMs"];
      androidSemanticResolution?: TapOnTapDebug["androidSemanticResolution"];
    } | null = null;

    try {
      throwIfAborted(signal);
      // Tap on the calculated point using observedChange
      const result = await this.observedInteraction(
        async (observeResult: ObserveResult) => {
          previousObserveResult = observeResult;
          throwIfAborted(signal);
          const observeCallbackEnteredAtMs = Date.now();
          const semanticResolutionBox: { v?: TapOnTapDebug["androidSemanticResolution"] } = {};

          let viewHierarchy = observeResult.viewHierarchy;
          if (!viewHierarchy) {
            perf.end();
            return { success: false, error: "Unable to get view hierarchy, cannot tap on element" };
          }

          const searchOutcome = await perf.track("findElement", () =>
            this.searchForElement(options, observeResult, signal)
          );
          searchUntilStats = searchOutcome.stats;
          observeResult.viewHierarchy = searchOutcome.viewHierarchy;
          viewHierarchy = searchOutcome.viewHierarchy;
          if (!searchOutcome.selection.element) {
            await this.handleElementNotFound(options, observeResult, searchOutcome.containerFound, signal);
          }
          const selection = searchOutcome.selection;
          const element = selection.element as Element;
          const selectedElementMetadata = this.buildSelectedElementMetadata(selection);
          const initialTapPoint = this.geometry.getElementCenter(element);
          let action = options.action;
          const longPressDuration = this.getLongPressDuration(options, this.device.platform);

          if (action === "focus") {
            // Check if element is already focused
            const isFocused = this.finder.isElementFocused(element);

            if (isFocused) {
              logger.info(`Element is already focused, no action needed`);
              perf.end();
              if (this.device.platform === "android") {
                tapDebugParts = {
                  action,
                  tapPoint: { x: initialTapPoint.x, y: initialTapPoint.y },
                  tapElement: element,
                  usedClickableParent: false,
                  injectionAttempts: [
                    {
                      method: "no-gesture",
                      success: true,
                      error: "Element already focused; tap not performed"
                    }
                  ]
                };
              }
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

          const isTalkBackEnabled = this.device.platform === "android"
            ? (await this.accessibilityDetector.detectMethod(this.device.deviceId, this.adb)) === "talkback"
            : false;
          const isVoiceOverEnabled = this.device.platform === "ios"
            ? await this.iosVoiceOverDetector.isVoiceOverEnabled(
              this.device.deviceId,
              IOSCtrlProxyClient.getInstance(this.device)
            )
            : false;
          let tapElement: Element;
          let usedParent: boolean;
          const initialTapTarget = this.resolveTapTargetElement(
            element,
            viewHierarchy,
            action,
            isTalkBackEnabled
          );
          tapElement = initialTapTarget.element;
          usedParent = initialTapTarget.usedParent;

          if (this.device.platform === "android") {
            const stable = await this.resolveAndroidStableTapTargetAfterRefreshes(
              options,
              observeResult,
              action,
              isTalkBackEnabled,
              signal
            );
            if (!stable.ok) {
              perf.end();
              return { success: false, error: stable.error };
            }
            observeResult.viewHierarchy = stable.viewHierarchy;
            tapElement = stable.tapElement;
            usedParent = stable.usedParent;
            viewHierarchy = stable.viewHierarchy;
          }
          const afterHierarchyRefreshMs = Date.now() - observeCallbackEnteredAtMs;

          if (usedParent) {
            logger.info("[TapOnElement] Using clickable parent for non-clickable element");
          }
          const androidLabelOverlapBounds =
            this.device.platform === "android" &&
            options.tapClickableParent === true &&
            options.text
              ? this.resolveAndroidLabelRowOverlapBoundsForClickableParent(options, tapElement, viewHierarchy)
              : undefined;
          // Semantic click searches the live a11y tree for nodes intersecting this rect. The label∩row
          // overlap tightens coordinate taps; it can be a strict subset of the row and miss nodes after
          // refresh/scroll, yielding "No clickable node within disambiguation bounds" while the row
          // rect still intersects the real list item.
          const androidSemanticDisambiguationBounds =
            this.device.platform === "android" &&
            options.tapClickableParent === true &&
            tapElement.bounds
              ? tapElement.bounds
              : androidLabelOverlapBounds ?? undefined;
          const tapPoint =
            this.device.platform === "android" &&
            options.tapClickableParent === true &&
            options.text
              ? this.resolveAndroidCoordinateTapPointForClickableParent(options, tapElement, viewHierarchy)
              : this.geometry.getElementCenter(tapElement);

          selectionCapture = await this.selectionStateTracker.prepare({
            action,
            observation: observeResult,
            element: tapElement,
            signal
          });

          const injectionAttempts: TapOnInjectionAttempt[] = [];
          const tapDiagnostics: TapOnTapDiagnostics = {};
          const beforeExecuteTapMs = Date.now() - observeCallbackEnteredAtMs;

          // Platform-specific tap execution
          await perf.track("executeTap", async () => {
            switch (this.device.platform) {
              case "android":
                await this.executeAndroidTap(
                  action,
                  tapPoint.x,
                  tapPoint.y,
                  longPressDuration,
                  tapElement,
                  signal,
                  options,
                  isTalkBackEnabled,
                  injectionAttempts,
                  tapDiagnostics,
                  androidSemanticDisambiguationBounds,
                  semanticResolutionBox
                );
                break;
              case "ios":
                await this.executeiOSTap(
                  action,
                  tapPoint.x,
                  tapPoint.y,
                  longPressDuration,
                  tapElement,
                  isVoiceOverEnabled
                );
                break;
              default:
                throw new ActionableError(`Unsupported platform: ${this.device.platform}`);
            }
          });

          if (this.device.platform === "android") {
            const rowB = tapElement.bounds;
            tapDebugParts = {
              action,
              tapPoint: { x: tapPoint.x, y: tapPoint.y },
              tapElement,
              // `usedParent` is only true when resolveTapTargetElement walked up from a non-clickable
              // match; tapClickableParent already selects a clickable ancestor, so keep the flag true
              // when that mode was requested.
              usedClickableParent: usedParent || options.tapClickableParent === true,
              injectionAttempts,
              diagnostics: tapDiagnostics,
              androidTapGeometry:
                rowB !== undefined && rowB !== null
                  ? {
                    rowBounds: {
                      left: rowB.left,
                      top: rowB.top,
                      right: rowB.right,
                      bottom: rowB.bottom
                    },
                    labelRowOverlapBounds: androidLabelOverlapBounds,
                    semanticDisambiguationBounds:
                        androidSemanticDisambiguationBounds ?? {
                          left: rowB.left,
                          top: rowB.top,
                          right: rowB.right,
                          bottom: rowB.bottom
                        },
                    coordinateTapPoint: { x: tapPoint.x, y: tapPoint.y }
                  }
                  : undefined,
              androidTimingMs: {
                tapPathStartedAtMs: observeCallbackEnteredAtMs,
                elapsedMsAfterAndroidHierarchyRefresh: afterHierarchyRefreshMs,
                elapsedMsBeforeExecuteTap: beforeExecuteTapMs
              },
              androidSemanticResolution: semanticResolutionBox.v
            };
          }

          perf.end();
          return {
            success: true,
            action,
            element: tapElement,
            selectedElement: selectedElementMetadata,
            searchUntil: searchOutcome.stats,
          };
        },
        {
          queryOptions: {
            text: options.text,
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
              id: options.elementId,
              action: options.action,
              duration: options.duration,
              container: options.container,
              searchUntil: options.searchUntil,
              selectionStrategy: options.selectionStrategy,
              platform: this.device.platform
            }
          }
        }
      );

      if (result.success && tapDebugParts) {
        result.tapDebug = this.buildTapOnTapDebug({
          platform: "android",
          action: tapDebugParts.action,
          tapPoint: tapDebugParts.tapPoint,
          tapElement: tapDebugParts.tapElement,
          usedClickableParent: tapDebugParts.usedClickableParent,
          injectionAttempts: tapDebugParts.injectionAttempts,
          observation: result.observation,
          diagnostics: tapDebugParts.diagnostics,
          androidTapGeometry: tapDebugParts.androidTapGeometry,
          androidTimingMs: tapDebugParts.androidTimingMs,
          androidSemanticResolution: tapDebugParts.androidSemanticResolution
        });
      }

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
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        action: options.action,
        error: `Failed to perform tap on element: ${errorMessage}`,
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
    signal: AbortSignal | undefined,
    options: TapOnElementOptions | undefined,
    isTalkBackEnabled: boolean | undefined,
    injectionAttempts: TapOnInjectionAttempt[],
    tapDiagnostics?: TapOnTapDiagnostics,
    semanticDisambiguationBoundsOverride?: { left: number; top: number; right: number; bottom: number },
    semanticResolutionSink?: { v?: TapOnTapDebug["androidSemanticResolution"] }
  ): Promise<void> {
    // Check if TalkBack is enabled (not just any accessibility service)
    const talkBackEnabled = typeof isTalkBackEnabled === "boolean"
      ? isTalkBackEnabled
      : (await this.accessibilityDetector.detectMethod(this.device.deviceId, this.adb)) === "talkback";

    const xRounded = Math.round(x);
    const yRounded = Math.round(y);
    if (tapDiagnostics && this.accessibilityService.isConnected()) {
      await this.fillAndroidTapDiagnosticsAround(xRounded, yRounded, "before", tapDiagnostics, signal);
    }

    logger.info(
      `[TapOnElement] Android tap device=${this.device.deviceId} action=${action} point=(${xRounded},${yRounded}) ` +
        `talkBackMode=${talkBackEnabled} ctrlProxyConnected=${this.accessibilityService.isConnected()}`
    );

    if (talkBackEnabled) {
      // TalkBack mode: Use accessibility actions with coordinate fallback
      await this.executeAndroidTapWithAccessibility(
        action,
        x,
        y,
        element,
        durationMs,
        options,
        signal,
        injectionAttempts,
        semanticResolutionSink
      );
    } else {
      // Standard mode: Use coordinate-based taps
      await this.executeAndroidTapWithCoordinates(
        action,
        x,
        y,
        durationMs,
        element,
        signal,
        injectionAttempts,
        options,
        semanticDisambiguationBoundsOverride,
        semanticResolutionSink
      );
    }

    if (tapDiagnostics && this.accessibilityService.isConnected()) {
      await this.fillAndroidTapDiagnosticsAround(xRounded, yRounded, "after", tapDiagnostics, signal);
    }
  }

  /**
   * Try a coordinate tap via the Android accessibility service (dispatchGesture).
   * Default tap order uses this before {@code adb shell input tap}. For {@link TapOnElementOptions.tapClickableParent},
   * {@link executeAndroidTapWithCoordinates} issues ADB first then this call (both may run).
   */
  private async tryAndroidCtrlProxyCoordinateTap(
    x: number,
    y: number,
    signal?: AbortSignal
  ): Promise<{ success: boolean; error?: string }> {
    throwIfAborted(signal);
    try {
      const result = await this.accessibilityService.requestTapCoordinates(
        x,
        y,
        TapOnElement.CTRL_PROXY_TAP_DURATION_MS,
        TapOnElement.CTRL_PROXY_TAP_TIMEOUT_MS,
        new NoOpPerformanceTracker()
      );
      if (!result.success) {
        const err = result.error ?? "unknown";
        logger.warn(`[TapOnElement] CtrlProxy coordinate tap failed at (${x}, ${y}): ${err}`);
        return { success: false, error: err };
      }
      return { success: true };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.warn(`[TapOnElement] CtrlProxy coordinate tap threw: ${err}`);
      return { success: false, error: err };
    }
  }

  /**
   * Framework list rows (e.g. AlertDialog items) use `android:id/text1`. ACTION_CLICK on that node
   * can return true without invoking the ListView item listener, so the UI looks "tapped" in logs
   * but selection (e.g. API server) never applies. Prefer real gestures for those ids.
   */
  private isAndroidFrameworkResourceId(element: Element): boolean {
    const rid = element["resource-id"];
    return typeof rid === "string" && rid.startsWith("android:id/");
  }

  /**
   * Execute tap in standard (non-TalkBack) mode: prefer CtrlProxy semantic click, then coordinate
   * injection. For {@link TapOnElementOptions.tapClickableParent}, issue {@code adb shell input tap}
   * before {@code dispatchGesture} when semantic click fails: gesture injection follows the topmost
   * compositor window, which can miss application list rows (e.g. search + IME) while ADB often
   * still delivers the touch to the intended surface. ADB's command always exits successfully even
   * when no view handles the touch, so we still run {@code dispatchGesture} afterward as a second
   * delivery path (not a success signal).
   */
  private async executeAndroidTapWithCoordinates(
    action: string,
    x: number,
    y: number,
    durationMs: number,
    element: Element,
    signal: AbortSignal | undefined,
    injectionAttempts: TapOnInjectionAttempt[],
    options?: TapOnElementOptions,
    semanticDisambiguationBoundsOverride?: { left: number; top: number; right: number; bottom: number },
    semanticResolutionSink?: { v?: TapOnTapDebug["androidSemanticResolution"] }
  ): Promise<void> {
    if (action === "tap") {
      // Framework `android:id/*` rows (e.g. text1) skip semantic click by default: ACTION_CLICK can
      // return true without invoking the list listener (e.g. API server picker). For tapClickableParent
      // search/list rows, coordinate taps often miss real a11y targets (hit-test shows only a root
      // FrameLayout); bounds-only resolution + brute-force in CtrlProxy is the reliable path first.
      const gestureFirstForFrameworkId =
        this.isAndroidFrameworkResourceId(element) && options?.tapClickableParent !== true;
      if (!gestureFirstForFrameworkId) {
        const semantic = await this.tryAndroidSemanticClick(
          element,
          signal,
          semanticDisambiguationBoundsOverride,
          {
            omitFrameworkResourceId:
              options?.tapClickableParent === true && this.isAndroidFrameworkResourceId(element)
          }
        );
        if (semanticResolutionSink !== undefined && semantic.resolution !== undefined) {
          semanticResolutionSink.v = semantic.resolution;
        }
        injectionAttempts.push({
          method: "android-ctrl-proxy-action-click-bounds",
          success: semantic.success,
          error: semantic.error
        });
        if (semantic.success) {
          return;
        }
      }

      const tryAdbTapBeforeGesture = options?.tapClickableParent === true;
      const xTap = Math.round(x);
      const yTap = Math.round(y);
      let adbShellTapIssued = false;

      if (tryAdbTapBeforeGesture) {
        logger.info(
          `[TapOnElement] tapClickableParent: trying ADB input tap before dispatchGesture at (${xTap},${yTap})`
        );
        try {
          await this.adb.executeCommand(
            `shell input tap ${xTap} ${yTap}`,
            undefined,
            undefined,
            undefined,
            signal
          );
          injectionAttempts.push({ method: "android-adb-shell-input-tap", success: true });
          adbShellTapIssued = true;
          logger.info(
            `[TapOnElement] tapClickableParent: ADB tap command completed; still trying dispatchGesture ` +
              `(shell input tap does not indicate whether a view consumed the event)`
          );
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          injectionAttempts.push({ method: "android-adb-shell-input-tap", success: false, error: err });
          logger.warn(
            `[TapOnElement] ADB tap before dispatchGesture failed (${err}); continuing with CtrlProxy gesture`
          );
        }
      }

      const proxy = await this.tryAndroidCtrlProxyCoordinateTap(x, y, signal);
      injectionAttempts.push({
        method: "android-ctrl-proxy-dispatch-gesture",
        success: proxy.success,
        error: proxy.error
      });
      if (proxy.success) {
        return;
      }
      if (!tryAdbTapBeforeGesture) {
        logger.info(`[TapOnElement] Falling back to ADB input tap at (${xTap}, ${yTap})`);
        try {
          await this.adb.executeCommand(`shell input tap ${xTap} ${yTap}`, undefined, undefined, undefined, signal);
          injectionAttempts.push({ method: "android-adb-shell-input-tap", success: true });
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          injectionAttempts.push({ method: "android-adb-shell-input-tap", success: false, error: err });
          throw error;
        }
        return;
      }
      if (adbShellTapIssued) {
        logger.warn(
          `[TapOnElement] tapClickableParent: dispatchGesture failed after ADB tap at (${xTap},${yTap}); ` +
            `continuing (${proxy.error ?? "unknown"}) — ADB may still have delivered the touch`
        );
        return;
      }
      throw new ActionableError(
        `Android tap failed (tapClickableParent): ADB tap errored before gesture or was skipped, ` +
          `and CtrlProxy dispatchGesture failed (${proxy.error ?? "unknown"})`
      );
    }

    if (action === "longPress") {
      await this.executeAndroidLongPress(x, y, durationMs, element?.["resource-id"], signal, injectionAttempts);
      return;
    }

    if (action === "doubleTap") {
      const first = await this.tryAndroidCtrlProxyCoordinateTap(x, y, signal);
      injectionAttempts.push({
        method: "android-ctrl-proxy-dispatch-gesture(1/2)",
        success: first.success,
        error: first.error
      });
      if (first.success) {
        await this.timer.sleep(200);
        throwIfAborted(signal);
        const second = await this.tryAndroidCtrlProxyCoordinateTap(x, y, signal);
        injectionAttempts.push({
          method: "android-ctrl-proxy-dispatch-gesture(2/2)",
          success: second.success,
          error: second.error
        });
        if (second.success) {
          return;
        }
      }
      logger.info(`[TapOnElement] Falling back to ADB double tap at (${x}, ${y})`);
      try {
        await this.adb.executeCommand(`shell input tap ${x} ${y}`, undefined, undefined, undefined, signal);
        await this.timer.sleep(200);
        await this.adb.executeCommand(`shell input tap ${x} ${y}`, undefined, undefined, undefined, signal);
        injectionAttempts.push({ method: "android-adb-shell-input-tap-double", success: true });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        injectionAttempts.push({ method: "android-adb-shell-input-tap-double", success: false, error: err });
        throw error;
      }
    }
  }

  /**
   * Execute tap using CtrlProxy actions (TalkBack mode)
   * Uses focus navigation when TalkBack is enabled, falls back to coordinate-based tapping if navigation fails.
   * For longPress, tries ACTION_LONG_CLICK first, then coordinate gesture, then ADB.
   */
  private async executeAndroidTapWithAccessibility(
    action: string,
    x: number,
    y: number,
    element: Element,
    durationMs: number,
    _options: TapOnElementOptions | undefined,
    signal: AbortSignal | undefined,
    injectionAttempts: TapOnInjectionAttempt[],
    semanticResolutionSink?: { v?: TapOnTapDebug["androidSemanticResolution"] }
  ): Promise<void> {
    const driver = this.talkBackDriverFactory.createDriver(this.device);

    if (action === "longPress") {
      // Long press: try ACTION_LONG_CLICK first, then coordinate gesture fallback
      const longPressResult = await this.talkBackStrategy.executeLongPress(
        x,
        y,
        durationMs,
        element,
        driver
      );
      injectionAttempts.push({
        method: `android-talkback-longpress-${longPressResult.method}`,
        success: longPressResult.success,
        error: longPressResult.error
      });

      if (!longPressResult.success) {
        logger.warn(
          `[TapOnElement] Long press accessibility methods failed (${longPressResult.error}), ` +
          `falling back to ADB tap at (${x}, ${y})`
        );
        await this.executeAndroidTapWithCoordinates(
          action,
          x,
          y,
          durationMs,
          element,
          signal,
          injectionAttempts,
          undefined,
          undefined,
          semanticResolutionSink
        );
      }
      return;
    }

    // Try focus navigation for tap and doubleTap actions
    if (action === "tap" || action === "doubleTap") {
      const result = await this.talkBackStrategy.executeTap(
        this.device.deviceId,
        element,
        action as "tap" | "doubleTap",
        driver
      );
      injectionAttempts.push({
        method: `android-talkback-${result.method}`,
        success: result.success,
        error: result.error
      });

      if (result.success) {
        return;
      }

      logger.warn(
        `[TapOnElement] Focus navigation failed (${result.error}), ` +
        `falling back to coordinate-based tap at (${x}, ${y})`
      );
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
    injectionAttempts.push({
      method: `android-talkback-coordinate-fallback-${fallbackResult.method}`,
      success: fallbackResult.success,
      error: fallbackResult.error
    });

    if (!fallbackResult.success) {
      logger.warn(
        `[TapOnElement] Accessibility coordinate tap failed (${fallbackResult.error}), ` +
        `falling back to ADB tap at (${x}, ${y})`
      );
      await this.executeAndroidTapWithCoordinates(
        action,
        x,
        y,
        durationMs,
        element,
        signal,
        injectionAttempts,
        undefined,
        undefined,
        semanticResolutionSink
      );
    }
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
    element: Element | undefined,
    isVoiceOverEnabled: boolean | undefined
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
    // Resolve accessibility label: ios-accessibility-label > text > fallback
    const label = (element["ios-accessibility-label"] as string | undefined)
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

  private getLongPressDuration(options: TapOnElementOptions, platform: "android" | "ios"): number {
    if (typeof options.duration === "number" && options.duration > 0) {
      return options.duration;
    }
    return platform === "android" ? 500 : 1000;
  }


  private async executeAndroidLongPress(
    x: number,
    y: number,
    durationMs: number,
    resourceId: string | undefined,
    signal: AbortSignal | undefined,
    injectionAttempts: TapOnInjectionAttempt[]
  ): Promise<void> {
    throwIfAborted(signal);
    if (resourceId) {
      try {
        const result = await this.accessibilityService.requestAction("long_click", resourceId);
        injectionAttempts.push({
          method: "android-accessibility-long-click-action",
          success: result.success,
          error: result.success ? undefined : result.error
        });
        if (result.success) {
          return;
        }
        logger.warn(`[TapOnElement] Accessibility long click failed: ${result.error}`);
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        injectionAttempts.push({
          method: "android-accessibility-long-click-action",
          success: false,
          error: err
        });
        logger.warn(`[TapOnElement] Accessibility long click error: ${error}`);
      }
    }

    try {
      await this.adb.executeCommand(
        `shell input touchscreen swipe ${x} ${y} ${x} ${y} ${durationMs}`,
        undefined,
        undefined,
        undefined,
        signal
      );
      injectionAttempts.push({ method: "android-adb-touchscreen-swipe-longpress", success: true });
    } catch (error) {
      logger.warn(`[TapOnElement] touch input swipe failed, falling back to input swipe: ${error}`);
      try {
        await this.adb.executeCommand(
          `shell input swipe ${x} ${y} ${x} ${y} ${durationMs}`,
          undefined,
          undefined,
          undefined,
          signal
        );
        injectionAttempts.push({ method: "android-adb-swipe-longpress-fallback", success: true });
      } catch (err2) {
        const msg = err2 instanceof Error ? err2.message : String(err2);
        injectionAttempts.push({ method: "android-adb-swipe-longpress-fallback", success: false, error: msg });
        throw err2;
      }
    }
  }


  private detectLongPressMetadata(
    previousObservation: ObserveResult | null,
    currentObservation?: ObserveResult
  ): {
    pressRecognized: boolean;
    contextMenuOpened: boolean;
    selectionStarted: boolean;
  } {
    const previousHierarchy = previousObservation?.viewHierarchy;
    const currentHierarchy = currentObservation?.viewHierarchy;
    const contextMenuOpened = this.detectContextMenuOpened(previousHierarchy, currentHierarchy);
    const selectionStarted = this.detectSelectionStarted(currentHierarchy);
    const windowChange = this.detectNewWindow(previousHierarchy, currentHierarchy);

    return {
      pressRecognized: contextMenuOpened || selectionStarted || windowChange,
      contextMenuOpened,
      selectionStarted
    };
  }

  private detectContextMenuOpened(
    previousHierarchy?: ViewHierarchyResult,
    currentHierarchy?: ViewHierarchyResult
  ): boolean {
    if (!currentHierarchy) {
      return false;
    }
    const previousRoots = this.getRootSignatures(previousHierarchy);
    const currentRoots = this.elementParser.extractRootNodes(currentHierarchy);

    for (const root of currentRoots) {
      const signature = this.getRootSignature(root);
      if (previousRoots.has(signature)) {
        continue;
      }
      if (this.containsMenuIndicators(root)) {
        return true;
      }
    }

    return false;
  }

  private detectNewWindow(
    previousHierarchy?: ViewHierarchyResult,
    currentHierarchy?: ViewHierarchyResult
  ): boolean {
    if (!currentHierarchy) {
      return false;
    }
    const previousRoots = this.getRootSignatures(previousHierarchy);
    const currentRoots = this.elementParser.extractRootNodes(currentHierarchy);
    if (currentRoots.length === 0) {
      return false;
    }

    return currentRoots.some(root => !previousRoots.has(this.getRootSignature(root)));
  }

  private detectSelectionStarted(currentHierarchy?: ViewHierarchyResult): boolean {
    if (!currentHierarchy) {
      return false;
    }

    const roots = this.elementParser.extractRootNodes(currentHierarchy);
    let selectionFound = false;
    const selectionKeyPairs: Array<[string, string]> = [
      ["textSelectionStart", "textSelectionEnd"],
      ["selectionStart", "selectionEnd"]
    ];

    for (const root of roots) {
      this.elementParser.traverseNode(root, (node: any) => {
        if (selectionFound) {
          return;
        }
        const props = this.elementParser.extractNodeProperties(node);
        for (const [startKey, endKey] of selectionKeyPairs) {
          const startValue = props?.[startKey] ?? props?.[startKey.toLowerCase()];
          const endValue = props?.[endKey] ?? props?.[endKey.toLowerCase()];
          if (startValue === undefined || endValue === undefined) {
            continue;
          }
          const startNumeric = typeof startValue === "string" ? parseInt(startValue, 10) : Number(startValue);
          const endNumeric = typeof endValue === "string" ? parseInt(endValue, 10) : Number(endValue);
          if (!Number.isNaN(startNumeric) && !Number.isNaN(endNumeric) && endNumeric > startNumeric) {
            selectionFound = true;
            return;
          }
        }
      });
      if (selectionFound) {
        break;
      }
    }

    return selectionFound;
  }

  private getRootSignatures(viewHierarchy?: ViewHierarchyResult): Set<string> {
    if (!viewHierarchy) {
      return new Set();
    }
    const roots = this.elementParser.extractRootNodes(viewHierarchy);
    return new Set(roots.map(root => this.getRootSignature(root)));
  }

  private getRootSignature(root: any): string {
    const props = this.elementParser.extractNodeProperties(root);
    const resourceId = props["resource-id"] ?? props.resourceId ?? "";
    const className = props.class ?? props.className ?? "";
    const bounds = props.bounds ?? "";
    const text = props.text ?? props["content-desc"] ?? "";
    return `${resourceId}|${className}|${bounds}|${text}`;
  }

  private containsMenuIndicators(root: any): boolean {
    let found = false;
    this.elementParser.traverseNode(root, (node: any) => {
      if (found) {
        return;
      }
      const props = this.elementParser.extractNodeProperties(node);
      const resourceId = (props["resource-id"] ?? props.resourceId ?? "").toLowerCase();
      const className = (props.class ?? props.className ?? "").toLowerCase();
      const text = (props.text ?? props["content-desc"] ?? "").toLowerCase();
      if (
        resourceId.includes("menu") ||
        resourceId.includes("popup") ||
        className.includes("menu") ||
        className.includes("popup") ||
        text.includes("menu") ||
        text.includes("popup")
      ) {
        found = true;
      }
    });
    return found;
  }
}
