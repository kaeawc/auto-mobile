import { isStrictlyScoped } from "../utility/ScopedSelection";
import {
  assertSelectedCapture,
  TapAnyAndroidTapper,
  type CapturedTapTarget,
  type RefreshViewHierarchy,
  type TapAnyAccessibilityService,
  type TapAnyTalkBackStrategy,
} from "./TapAnyAndroidTapper";
import { TapAnyIosTapper } from "./TapAnyIosTapper";
import { resolveTapAnyOrdinaryTapCtrlProxyTimeoutMs } from "./tapAnyCtrlProxyTimeout";
import { readFreshPlatformHierarchy, returnsRawHierarchyUnfiltered } from "./tapHierarchyRead";
import {
  assertLongPressWithinHardMax,
  containerSelectorError,
  failedTapResult,
  isContainerAvailable,
  resolveSearchUntilDuration,
} from "./tapSharedHelpers";
import {
  withObservationReadScope,
  wasHierarchyReadDuringCall,
} from "../observe/observationReadScope";
import { freshTapHierarchy } from "./freshTapHierarchy";
import {
  TALKBACK_STATE_UNKNOWN_WARNING,
  resolveTalkBackStateConfirmation,
} from "../accessibility/interfaces/AccessibilityDetector";
import { LONG_PRESS_HARD_MAX_MS } from "./tapAtGesture";
import {
  prepareTargetDisplayAction,
  refreshTargetDisplayHierarchy,
  sessionRenderedObservation,
  type RenderedObservationReader,
} from "./TargetDisplayAction";
import {
  DEFAULT_HIERARCHY_READ_TIMEOUT_MS,
  createDeviceHierarchyCapture,
} from "../observe/DeviceHierarchyCapture";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import { type DisplayFence, type DisplayFenceDependencies } from "./BaseVisualChange";
import {
  assertLongPressFitsRequestBudget,
  LONG_PRESS_TIMEOUT_HEADROOM_MS,
  ORDINARY_TAP_DURATION_MS,
} from "./gestureTransportTimeout";
export { LONG_PRESS_TIMEOUT_HEADROOM_MS } from "./gestureTransportTimeout";
import { withStaleDisplay, StaleDisplayError } from "../observe/StaleDisplayError";
import { unsupportedPlatformError } from "../../models/ActionableError";
import {
  DefaultHierarchyCapture,
  identifyObservedHierarchy,
  type HierarchyCapture,
  type HierarchySnapshot,
} from "../observe/HierarchyCapture";
import type { TapAnyElementResult } from "../../models/TapAnyElementResult";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  BaseVisualChange,
  ProgressCallback,
  FINAL_OBSERVATION_RETRY_BACKOFF_MS,
  FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS,
} from "./BaseVisualChange";
import {
  ActionableError,
  BootedDevice,
  Element,
  ObserveResult,
  TapAnyElementOptions,
  TapOnElementResult,
  ViewHierarchyResult,
} from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import {
  visibleTapBounds,
  DefaultElementGeometry,
  hasVisibleScreenPart,
  screenSizeForOffscreenCheck,
  type ScreenSizeForOffscreenCheckOptions,
} from "../utility/ElementGeometry";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";

import { logger } from "../../utils/logger";
import { type AndroidCtrlProxy, AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import {
  createGlobalPerformanceTracker,
  type PerformanceTracker,
} from "../../utils/PerformanceTracker";
import { throwIfAborted } from "../../utils/toolUtils";
import { pollSearchUntil } from "./searchUntilPoller";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import { type Timer } from "../../utils/SystemTimer";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { serverConfig } from "../../utils/ServerConfig";
import { attachRawViewHierarchy } from "../utility/viewHierarchySearch";
import { hierarchyFingerprint } from "../../utils/hierarchyFingerprint";
import type { IosVoiceOverDetector } from "../accessibility/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../accessibility/IosVoiceOverDetector";
import { FeatureFlagService, type FeatureFlagReader } from "../featureFlags/FeatureFlagService";
import { IOS_HIERARCHY_REQUEST_TIMEOUT_MS } from "../observe/ios/CtrlProxyHierarchy";
import { IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS } from "../observe/ios/CtrlProxyVoiceOver";
import type { AccessibilityDetector } from "../accessibility/interfaces/AccessibilityDetector";
import { accessibilityDetector as defaultAccessibilityDetector } from "../accessibility/AccessibilityDetector";
import { androidDisplayTapDispatch } from "./coordinateTapDispatch";
import { TalkBackTapStrategy } from "../talkback/TalkBackTapStrategy";
import {
  assertAppGestureNotUnderPrototype,
  scopeHierarchyForSelector,
} from "../observe/hierarchyLayer";
import { ownPrototypeSafeGesturePoint } from "../observe/ApplicationWindowCover";
import {
  DefaultTalkBackNavigationDriverFactory,
  type TalkBackNavigationDriverFactory,
} from "../talkback/TalkBackNavigationDriver";
import { deadlineRequest, resolveDeadlineActionCall, type ActionCall } from "./ActionCall";
import { OBSERVED_INTERACTION_PROFILES, SETTLE_BUDGET_MS } from "./observedInteractionProfiles";

interface TapAnyElementDependencies extends DisplayFenceDependencies {
  lastRenderedObservation?: RenderedObservationReader;
  hierarchyCapture?: HierarchyCapture;
  timer?: Timer;
  elementSelector?: ElementSelector;
  iosVoiceOverDetector?: IosVoiceOverDetector;
  featureFlags?: FeatureFlagReader;
  accessibilityDetector?: AccessibilityDetector;
  talkBackStrategy?: TapAnyTalkBackStrategy;
  talkBackDriverFactory?: TalkBackNavigationDriverFactory;
  accessibilityService?: TapAnyAccessibilityService;
}

export { TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS } from "./tapAnyCtrlProxyTimeout";

/**
 * Default `searchUntil.duration` (ms) applied when a `tapAny` call omits it
 * (`getSearchUntilDuration` below). Exported so the daemon's outer MCP
 * timeout budgeting (`resolveTapAnyLongPressBudgetMs` in
 * `src/daemon/mcpRequestTimeout.ts`) can share the same value instead of
 * assuming an omitted `searchUntil` costs zero search time (issue #6248
 * review, P2) -- a call like `tapAny({action:"longPress", duration:60000})`
 * still spends this long polling for the element before the press even
 * starts.
 */
export const TAP_ANY_SEARCH_UNTIL_DEFAULT_MS = 1500;

/**
 * Default longPress `duration` (ms) `getLongPressDuration` substitutes on iOS
 * when a `tapAny` longPress call omits `duration` (or passes a non-positive
 * value). Exported so the daemon's outer MCP timeout budgeting
 * (`resolveTapAnyLongPressBudgetMs` in `src/daemon/mcpRequestTimeout.ts`)
 * shares the same value instead of assuming an omitted `duration` costs zero
 * press time (issue #6248 review, P2) -- `tapAny({action:"longPress"})` with
 * no `duration` still performs a real on-device press of this length.
 */
export const TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_IOS = 1500;

/**
 * Android counterpart of `TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_IOS`.
 * Exported for the same reason; the daemon's outer budgeting uses the larger
 * of the two defaults since it does not know the target platform.
 */
export const TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_ANDROID = 1000;

/**
 * Upper bound on `searchUntil.duration` (`getSearchUntilDuration` rejects
 * anything larger). Exported so the max-acceptable-longPress-duration
 * arithmetic below can budget the worst-case pre-gesture search window
 * without duplicating the literal (issue #6248 review P2, fuZRt).
 */
export const TAP_ANY_SEARCH_UNTIL_MAX_MS = 12000;

/**
 * Fixed on-device press duration `executeIosTapWithCoordinates` sends for an
 * ordinary `tap`/`doubleTap` (as opposed to `longPress`, whose duration is
 * caller-supplied). Exported so the daemon's outer MCP timeout budgeting
 * (`resolveTapAnyOrdinaryTapBudgetMs` in `src/daemon/mcpRequestTimeout.ts`)
 * shares this single value instead of duplicating the literal (issue #6276).
 */
export const TAP_ANY_ORDINARY_TAP_DURATION_MS = ORDINARY_TAP_DURATION_MS;

/**
 * The actual per-request CtrlProxy timeout `executeIosTapWithCoordinates`/
 * `executeIosTapWithVoiceOver` apply to an ordinary tap/doubleTap gesture.
 * `TAP_ANY_ORDINARY_TAP_DURATION_MS` is fixed, so
 * `resolveTapAnyOrdinaryTapCtrlProxyTimeoutMs` always resolves to this same value. Exported so
 * the daemon's outer MCP timeout budgeting derives the ordinary-tap gesture term from the REAL
 * per-request deadline instead of only the on-device press time (issue #6306 review, P2).
 */
export const TAP_ANY_ORDINARY_TAP_CTRL_PROXY_TIMEOUT_MS =
  resolveTapAnyOrdinaryTapCtrlProxyTimeoutMs(TAP_ANY_ORDINARY_TAP_DURATION_MS);

/** Android's sequential double-tap gap; iOS no longer waits between host requests. */
export const TAP_ANY_DOUBLE_TAP_GAP_MS = 200;

/**
 * Worst-case WALL-CLOCK time for an ordinary `tap`/`doubleTap` gesture: Android's sequential
 * fallback issues two CtrlProxy requests separated by `TAP_ANY_DOUBLE_TAP_GAP_MS`, and EACH
 * request can independently consume the full `TAP_ANY_ORDINARY_TAP_CTRL_PROXY_TIMEOUT_MS`
 * before CtrlProxy replies (or the request times out) -- not just the on-device press duration
 * (`TAP_ANY_ORDINARY_TAP_DURATION_MS`), which is what an earlier round of this arithmetic
 * charged (issue #6306 review, P2): with near-deadline observations that undersizing let the
 * outer floor expire mid-gesture even though the CtrlProxy requests themselves were still
 * within their own established timeout. Exported so the daemon's outer MCP timeout budgeting
 * (`resolveTapAnyOrdinaryTapBudgetMs` in `src/daemon/mcpRequestTimeout.ts`) shares this single
 * derived value instead of duplicating the arithmetic -- using the doubleTap worst case for
 * both `tap` and `doubleTap` only ever over-budgets a plain `tap`, never under-budgets it.
 * iOS now uses one runner request within this conservative shared budget.
 */
export const TAP_ANY_ORDINARY_TAP_GESTURE_WORST_CASE_MS =
  2 * TAP_ANY_ORDINARY_TAP_CTRL_PROXY_TIMEOUT_MS + TAP_ANY_DOUBLE_TAP_GAP_MS;

/**
 * Timeout `CtrlProxyVoiceOver.requestVoiceOverState`'s own default applies to
 * the VoiceOver-detection probe this class runs before every iOS longPress
 * gesture (`executeIosTap` -> `iosVoiceOverDetector.isVoiceOverEnabled`). Read
 * from `CtrlProxyVoiceOver` (the real constant, `IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS`)
 * rather than duplicated as a literal.
 */
const TAP_ANY_LONG_PRESS_VOICEOVER_PROBE_TIMEOUT_MS = IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS;

/**
 * Realistic WORST CASE of the post-action final-observation phase
 * `BaseVisualChange.takeObservation` runs once a tapAny longPress gesture
 * completes: an initial observation attempt plus up to
 * `FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS` retries (5 attempts total), each an
 * independent `ObserveScreen.execute` call. Per attempt that call can spend up
 * to `IOS_HIERARCHY_REQUEST_TIMEOUT_MS` (~15s) collecting the iOS hierarchy
 * AND another `IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS` (~5s) in the
 * unconditional accessibility-state-detection step
 * (`AccessibilityStateDetector.run` -> `iosVoiceOverDetector.isVoiceOverEnabled`
 * -> `CtrlProxyVoiceOver.requestVoiceOverState`) -- both run serially inside
 * the same `ObserveScreen.execute`, so both must be budgeted per attempt, not
 * just the hierarchy request (issue #6248 review, P2, fuZRo). An earlier round
 * of this arithmetic budgeted only the hierarchy request per attempt, which
 * undersized the overhead against the real per-attempt pipeline cost.
 *
 * Worst case = attempts * (per-attempt hierarchy timeout + per-attempt a11y
 * detection timeout) + total backoff
 *   attempts                  = 1 + FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS = 5
 *   per-attempt hierarchy     = IOS_HIERARCHY_REQUEST_TIMEOUT_MS = 15000ms
 *   per-attempt a11y detect   = IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS = 5000ms
 *   total backoff             = sum(FINAL_OBSERVATION_RETRY_BACKOFF_MS) = 750ms
 *   => 5 * (15000 + 5000) + 750 = 100750ms
 */
const TAP_ANY_LONG_PRESS_FINAL_OBSERVE_ATTEMPTS = 1 + FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS;
const TAP_ANY_LONG_PRESS_FINAL_OBSERVE_TOTAL_BACKOFF_MS = FINAL_OBSERVATION_RETRY_BACKOFF_MS.reduce(
  (sum, delayMs) => sum + delayMs,
  0,
);
const TAP_ANY_LONG_PRESS_FINAL_OBSERVE_PER_ATTEMPT_MS =
  IOS_HIERARCHY_REQUEST_TIMEOUT_MS + IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS;
const TAP_ANY_LONG_PRESS_FINAL_OBSERVE_WORST_CASE_MS =
  TAP_ANY_LONG_PRESS_FINAL_OBSERVE_ATTEMPTS * TAP_ANY_LONG_PRESS_FINAL_OBSERVE_PER_ATTEMPT_MS +
  TAP_ANY_LONG_PRESS_FINAL_OBSERVE_TOTAL_BACKOFF_MS;

/**
 * Worst-case cost of the SEPARATE pre-action `ObserveScreen.execute` call
 * `BaseVisualChange.observedInteraction` performs BEFORE running the tapAny
 * gesture itself (`getPreviousObserve` / its `getPreviousObserveFallback`
 * catch path), when no usable cached observation exists. An earlier round of
 * this budget accounted only for the POST-gesture final-observation retry
 * loop (`TAP_ANY_LONG_PRESS_FINAL_OBSERVE_WORST_CASE_MS` above); it was blind
 * to this separate pre-gesture call, which runs the identical
 * `ObserveScreen.execute` pipeline (hierarchy request AND the unconditional
 * accessibility-state-detection step) and so can cost the same per-attempt
 * amount (issue #6276, follow-up to #6248 review thread funav). Reuses the
 * per-attempt worst case computed above since it is the SAME underlying call.
 */
export const TAP_ANY_LONG_PRESS_PRE_ACTION_OBSERVE_MS =
  TAP_ANY_LONG_PRESS_FINAL_OBSERVE_PER_ATTEMPT_MS;

/**
 * Extra headroom on top of the derived worst-case arithmetic above, so a
 * further phase added later (or a small amount of scheduling jitter) can't
 * blow the budget and force yet another review round (issue #6248 review,
 * P2).
 */
// The terminal screenshot is queued behind an observation's fire-and-forget
// capture. Each CtrlProxy screenshot has a ten-second request budget, so the
// terminal evidence can spend two full requests (the already pending one plus
// its own fresh capture). Budget both instead of treating the first as free.
export const TAP_ANY_TERMINAL_SCREENSHOT_WORST_CASE_MS = 20_000;
const TAP_ANY_LONG_PRESS_OVERHEAD_HEADROOM_MS = TAP_ANY_TERMINAL_SCREENSHOT_WORST_CASE_MS;

/**
 * Consolidated overhead for every non-press phase of a tapAny action (both
 * `longPress` and, since issue #6276, ordinary `tap`/`doubleTap` -- every
 * tapAny action runs the same `BaseVisualChange.observedInteraction`
 * pipeline, so this overhead is action-agnostic): the pre-GESTURE
 * VoiceOver-detection probe, the pre-ACTION `ObserveScreen.execute` call
 * `observedInteraction` performs before running the gesture at all, the
 * post-gesture final observation's realistic worst case (initial + retries +
 * backoff, including the accessibility-state-detection step each attempt
 * also runs), plus a fixed CtrlProxy request headroom and extra generosity
 * headroom. Exported so the daemon's outer MCP timeout budgeting
 * (`resolveTapAnyLongPressBudgetMs`/`resolveTapAnyOrdinaryTapBudgetMs` in
 * `src/daemon/mcpRequestTimeout.ts`) shares this single value instead of
 * duplicating the arithmetic (issue #6248 review, P2; issue #6276). Covers:
 *   - VoiceOver-detection probe (`TAP_ANY_LONG_PRESS_VOICEOVER_PROBE_TIMEOUT_MS`)
 *   - Pre-action `ObserveScreen.execute` call, run once before the gesture
 *     (`TAP_ANY_LONG_PRESS_PRE_ACTION_OBSERVE_MS`)
 *   - Final post-gesture observation retry loop's worst case, hierarchy +
 *     a11y-detection per attempt (`TAP_ANY_LONG_PRESS_FINAL_OBSERVE_WORST_CASE_MS`)
 *   - Existing fixed CtrlProxy request headroom (`LONG_PRESS_TIMEOUT_HEADROOM_MS`)
 *   - Extra generosity headroom for future phases
 *     (`TAP_ANY_LONG_PRESS_OVERHEAD_HEADROOM_MS`)
 *
 * Deliberately does NOT fold in the pre-gesture search window -- that varies
 * per-call (`searchUntil.duration` or its default) and stays budgeted
 * explicitly in `resolveTapAnyLongPressBudgetMs`/`resolveTapAnyOrdinaryTapBudgetMs`
 * alongside this constant.
 */
export const TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS =
  TAP_ANY_LONG_PRESS_VOICEOVER_PROBE_TIMEOUT_MS +
  TAP_ANY_LONG_PRESS_PRE_ACTION_OBSERVE_MS +
  TAP_ANY_LONG_PRESS_FINAL_OBSERVE_WORST_CASE_MS +
  LONG_PRESS_TIMEOUT_HEADROOM_MS +
  TAP_ANY_LONG_PRESS_OVERHEAD_HEADROOM_MS;

/** Public long-press ceiling shared with tapOn; tapAt retains its own 10 s limit. */
export const TAP_ANY_LONG_PRESS_MAX_DURATION_MS = LONG_PRESS_HARD_MAX_MS;

export class TapAnyElement extends BaseVisualChange {
  private readonly iosMultiPanel =
    this.device.platform === "ios" && (this.device.displays?.panels.length ?? 0) > 1;
  private readonly lastRenderedObservation: RenderedObservationReader;
  private geometry: ElementGeometry;
  private elementSelector: ElementSelector;
  private accessibilityService: TapAnyAccessibilityService;
  private hierarchyAccessibilityService: AndroidCtrlProxy;
  private viewHierarchy: ViewHierarchy;
  private hierarchyCapture: HierarchyCapture;
  private iosVoiceOverDetector: IosVoiceOverDetector;
  private featureFlags: FeatureFlagReader;
  private accessibilityDetector: AccessibilityDetector;
  private talkBackStrategy: TapAnyTalkBackStrategy;
  private androidTapper: TapAnyAndroidTapper;
  private iosTapper: TapAnyIosTapper;
  private talkBackDriverFactory: TalkBackNavigationDriverFactory;
  private refreshViewHierarchyOverrideForTesting?: (
    refresh: RefreshViewHierarchy,
    timeoutMs: number,
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
  ) => Promise<ViewHierarchyResult | null>;
  private beforeAndroidTapForTesting?: () => void;

  private static readonly SEARCH_UNTIL_DEFAULT_MS = TAP_ANY_SEARCH_UNTIL_DEFAULT_MS;
  private static readonly SEARCH_UNTIL_MIN_MS = 100;
  private static readonly SEARCH_UNTIL_MAX_MS = TAP_ANY_SEARCH_UNTIL_MAX_MS;
  private static readonly SEARCH_POLL_INTERVAL_MS = 100;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    options: TapAnyElementDependencies = {},
  ) {
    super(device, adb, options.timer, options.renderedDisplayRevision, options);
    this.lastRenderedObservation = options.lastRenderedObservation ?? sessionRenderedObservation;
    this.geometry = new DefaultElementGeometry();
    this.elementSelector =
      options.elementSelector ??
      new ResolverElementSelector(undefined, undefined, {
        platform: device.platform,
        iosMultiPanel: this.iosMultiPanel,
      });
    this.accessibilityService =
      options.accessibilityService ?? AndroidCtrlProxyClient.getInstance(device, this.adbFactory);
    this.hierarchyAccessibilityService = AndroidCtrlProxyClient.getInstance(
      device,
      this.adbFactory,
    );
    this.viewHierarchy = new ViewHierarchy(device, this.adbFactory);
    this.hierarchyCapture =
      options.hierarchyCapture ??
      new DefaultHierarchyCapture(
        device.platform,
        {
          readCached: (request) =>
            this.viewHierarchy.getViewHierarchy(
              {},
              {
                skipWaitForFresh: true,
                minTimestamp: request.minTimestamp ?? 0,
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
            const hierarchy = await this.readFreshHierarchy(
              request.timeoutMs ?? TAP_ANY_SEARCH_UNTIL_DEFAULT_MS,
              undefined,
              request.signal,
              request.requireFreshExtraction,
            );
            if (!hierarchy) {
              throw new ActionableError("Unable to retrieve a fresh tapAny hierarchy");
            }
            return hierarchy;
          },
          projectVisible: (hierarchy) => this.viewHierarchy.projectActionableHierarchy(hierarchy),
        },
        this.timer,
      );
    this.iosVoiceOverDetector = options.iosVoiceOverDetector ?? defaultIosVoiceOverDetector;
    this.featureFlags = options.featureFlags ?? FeatureFlagService.getInstance();
    this.accessibilityDetector = options.accessibilityDetector ?? defaultAccessibilityDetector;
    this.talkBackDriverFactory =
      options.talkBackDriverFactory ?? new DefaultTalkBackNavigationDriverFactory(this.adbFactory);
    this.talkBackStrategy =
      options.talkBackStrategy ??
      new TalkBackTapStrategy({ timer: this.timer, driverFactory: this.talkBackDriverFactory });
    this.androidTapper = new TapAnyAndroidTapper({
      device,
      timer: this.timer,
      accessibilityService: this.accessibilityService,
      accessibilityDetector: this.accessibilityDetector,
      featureFlags: this.featureFlags,
      talkBackStrategy: this.talkBackStrategy,
      talkBackDriverFactory: this.talkBackDriverFactory,
      host: {
        beforeTap: () => this.beforeAndroidTapForTesting?.(),
        getAdb: () => this.adb,
        refreshViewHierarchy: (timeoutMs, screenSize, signal, forceCapture) =>
          this.refreshViewHierarchy(timeoutMs, screenSize, signal, forceCapture),
        findClickableElement: (options, hierarchy, sizeOptions) =>
          this.findClickableElement(options, hierarchy, sizeOptions),
        resolveTapPoint: (target, sizeOptions) => this.resolveTapPoint(target, sizeOptions),
      },
    });
    this.iosTapper = new TapAnyIosTapper({
      device,
      iosVoiceOverDetector: this.iosVoiceOverDetector,
      featureFlags: this.featureFlags,
    });
  }

  /** Test-only seam for supplying the post-gesture hierarchy probe result. */
  setRefreshViewHierarchyForTesting(
    refresh: (
      defaultRefresh: RefreshViewHierarchy,
      timeoutMs: number,
      screenSize?: ObserveResult["screenSize"],
      signal?: AbortSignal,
    ) => Promise<ViewHierarchyResult | null>,
  ): void {
    this.refreshViewHierarchyOverrideForTesting = refresh;
  }

  private executeAndroidTap(...args: Parameters<TapAnyAndroidTapper["executeAndroidTap"]>) {
    return this.androidTapper.executeAndroidTap(...args);
  }

  private retryAndroidTapIfNoChange(
    ...args: Parameters<TapAnyAndroidTapper["retryAndroidTapIfNoChange"]>
  ) {
    return this.androidTapper.retryAndroidTapIfNoChange(...args);
  }

  private executeIosTap(...args: Parameters<TapAnyIosTapper["executeIosTap"]>) {
    return this.iosTapper.executeIosTap(...args);
  }

  /** Test-only seam for observing when Android gesture dispatch begins. */
  setBeforeAndroidTapForTesting(callback: () => void): void {
    this.beforeAndroidTapForTesting = callback;
  }

  private createErrorResult(action: string, error: string): TapOnElementResult {
    return failedTapResult(action, error);
  }

  private validateOptions(options: TapAnyElementOptions): string | null {
    return containerSelectorError(options.container, "tapAny");
  }

  private getSearchUntilDuration(options: TapAnyElementOptions): number {
    return resolveSearchUntilDuration(options.searchUntil?.duration, {
      defaultMs: TapAnyElement.SEARCH_UNTIL_DEFAULT_MS,
      minMs: TapAnyElement.SEARCH_UNTIL_MIN_MS,
      maxMs: TapAnyElement.SEARCH_UNTIL_MAX_MS,
    });
  }

  private isContainerAvailable(
    viewHierarchy: ViewHierarchyResult,
    container?: ElementContainerSelector,
  ): boolean {
    return isContainerAvailable(this.elementSelector, viewHierarchy, container);
  }

  private findClickableElement(
    options: TapAnyElementOptions,
    viewHierarchy: ViewHierarchyResult,
    sizeOptions: ScreenSizeForOffscreenCheckOptions = {},
  ): { element: Element | null; containerFound: boolean } {
    viewHierarchy = scopeHierarchyForSelector(viewHierarchy, options.layer);
    const containerFound = this.isContainerAvailable(viewHierarchy, options.container);
    const screenSizeOptions = {
      ...sizeOptions,
      platform: this.device.platform,
      iosMultiPanel: this.iosMultiPanel,
    };
    const effectiveScreenSize = screenSizeForOffscreenCheck(viewHierarchy, screenSizeOptions);
    const selection = this.elementSelector.select(
      viewHierarchy,
      {},
      {
        screenSizeOptions,
        container: options.container,
        strategy: options.selectionStrategy,
        intentAction: options.action === "longPress" ? "long-press" : "tap",
        scrollableContainer: options.scrollableContainer,
      },
    );
    if (selection.element && !hasVisibleScreenPart(selection.element.bounds, effectiveScreenSize)) {
      return { element: null, containerFound };
    }
    return { element: selection.element, containerFound };
  }

  private capturedTapTarget(
    options: TapAnyElementOptions,
    observeResult: ObserveResult,
    picked: Pick<CapturedTapTarget, "element" | "capture" | "talkBackState">,
  ): CapturedTapTarget {
    return {
      ...picked,
      observationDisplay: observeResult.viewHierarchy,
      observationScreenSize: observeResult.screenSize,
      scoped: isStrictlyScoped(options),
      layer: options.layer,
    };
  }

  private resolveTapPoint(
    target: CapturedTapTarget,
    sizeOptions: ScreenSizeForOffscreenCheckOptions = {},
  ): { x: number; y: number } {
    const screenSize = screenSizeForOffscreenCheck(target.capture.hierarchy, {
      observationScreenSize: target.observationScreenSize,
      display: target.observationDisplay,
      ...sizeOptions,
      platform: this.device.platform,
      iosMultiPanel: this.iosMultiPanel,
    });
    const bounds = visibleTapBounds(target.element.bounds, screenSize);
    if (!bounds) {
      throw new ActionableError(
        "Matched element has no visible tap area; scroll it into view, then retry tapAny.",
      );
    }
    const center = this.geometry.getElementCenter({ bounds });
    if (target.layer !== undefined || this.device.platform === "ios") {
      return center;
    }
    // Default-layer selectors also resolve app rows kept under AutoMobile's own prototype (#10691),
    // so avoid the prototype as tapOn does; layer "app" refuses later with its own error.
    const safe = ownPrototypeSafeGesturePoint(
      target.capture.hierarchy,
      target.element,
      bounds,
      center,
    );
    if (!safe) {
      throw new ActionableError(
        "Target is covered by an AutoMobile prototype window; hide or move the prototype, then retry tapAny.",
      );
    }
    return safe;
  }

  private prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ): ViewHierarchyResult {
    if (returnsRawHierarchyUnfiltered(serverConfig.isRawElementSearchEnabled(), rawHierarchy)) {
      return rawHierarchy;
    }
    if (this.device.platform === "android") {
      const filtered = this.viewHierarchy.filterViewHierarchy(rawHierarchy);
      attachRawViewHierarchy(filtered, rawHierarchy);
      return filtered;
    }
    if (this.device.platform === "ios") {
      return this.prepareIosViewHierarchyForResponse(rawHierarchy, screenSize);
    }
    return rawHierarchy;
  }

  private prepareIosViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ): ViewHierarchyResult {
    if (screenSize?.width && screenSize?.height) {
      const filtered = this.viewHierarchy.filterOffscreenNodes(
        rawHierarchy,
        screenSize.width,
        screenSize.height,
      );
      attachRawViewHierarchy(filtered, rawHierarchy);
      return filtered;
    }
    return rawHierarchy;
  }

  private async refreshViewHierarchy(
    timeoutMs: number,
    _screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
    forceCapture: boolean = false,
  ): Promise<ViewHierarchyResult | null> {
    if (this.refreshViewHierarchyOverrideForTesting) {
      return this.refreshViewHierarchyOverrideForTesting(
        (defaultTimeoutMs, screenSize, defaultSignal) =>
          this.refreshViewHierarchyDefault(
            defaultTimeoutMs,
            screenSize,
            defaultSignal,
            forceCapture,
          ),
        timeoutMs,
        _screenSize,
        signal,
      );
    }
    return this.refreshViewHierarchyDefault(timeoutMs, _screenSize, signal, forceCapture);
  }

  private async refreshViewHierarchyDefault(
    timeoutMs: number,
    _screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
    forceCapture: boolean = false,
  ): Promise<ViewHierarchyResult | null> {
    throwIfAborted(signal);
    if (timeoutMs <= 0) {
      return null;
    }
    try {
      const snapshot = await this.hierarchyCapture.capture({
        freshness: "fresh",
        ...(forceCapture ? { requireFreshExtraction: true } : {}),
        searchRaw: serverConfig.isRawElementSearchEnabled(),
        timeoutMs,
        signal,
      });
      identifyObservedHierarchy(
        this.device.platform,
        snapshot.hierarchy,
        "fresh",
        this.timer,
        undefined,
        { captureId: snapshot.captureId, iosMultiPanel: this.iosMultiPanel },
      );
      return snapshot.hierarchy;
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`[TapAnyElement] Fresh capture failed: ${errorMessage(error)}`);
      return null;
    }
  }

  private async readFreshHierarchy(
    timeoutMs: number,
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
    forceCapture: boolean = false,
  ): Promise<ViewHierarchyResult | null> {
    return readFreshPlatformHierarchy(
      {
        device: this.device,
        adb: this.adb,
        timer: this.timer,
        androidService: this.hierarchyAccessibilityService,
        viewHierarchy: this.viewHierarchy,
        prepareForResponse: (raw, size) => this.prepareViewHierarchyForResponse(raw, size),
        actionLabel: "tap any element",
      },
      { timeoutMs, screenSize, signal, forceCapture },
    );
  }

  private getLongPressDuration(
    options: TapAnyElementOptions,
    request?: { requestDeadlineMs?: number },
  ): number {
    if (options.action !== "longPress") {
      return 0;
    }
    assertLongPressWithinHardMax(options.duration);
    let durationMs =
      this.device.platform === "ios"
        ? TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_IOS
        : TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_ANDROID;
    if (options.duration && options.duration > 0) {
      // Normalize to an integer: the public schema accepts a fractional
      // duration, but CtrlProxy's `RequestTapCoordinates.duration` (iOS
      // Models.swift) is `Int?`, so a fractional value fails to decode on
      // the runner rather than performing a shorter/longer press (issue
      // #6248 review). Round rather than truncate so a value like 999.6
      // still reads as "about a second" instead of quietly losing time.
      // A sub-1ms-rounded positive duration (e.g. 0.4) must never normalize
      // to 0 -- CtrlProxy's `GesturePerformer` treats a non-positive duration
      // as a plain tap, silently downgrading a requested long press into a
      // tap that reports success (issue #6248 review, P2). Floor at 1ms so
      // any positive `duration` stays a genuine long press.
      durationMs = Math.max(1, Math.round(options.duration));
    }
    assertLongPressFitsRequestBudget(
      durationMs,
      request?.requestDeadlineMs === undefined
        ? undefined
        : request.requestDeadlineMs - this.timer.now(),
    );
    return durationMs;
  }

  private throwMissingClickableElement(
    options: TapAnyElementOptions,
    containerFoundEver: boolean,
  ): never {
    if (options.container && !containerFoundEver) {
      const containerLabel = options.container.elementId
        ? `elementId '${options.container.elementId}'`
        : `text '${options.container.text}'`;
      throw new ActionableError(`Container element not found with provided ${containerLabel}`);
    }
    const containerHint = options.container
      ? ` within container ${options.container.elementId ? `elementId '${options.container.elementId}'` : `text '${options.container.text}'`}`
      : "";
    throw new ActionableError(`No clickable element found${containerHint}`);
  }

  private async pollClickableTarget({
    options,
    observeResult,
    refresh,
    signal,
    selectedCapture,
    searchDurationMs,
    startTime,
    lastHash,
    containerFoundEver,
  }: {
    options: TapAnyElementOptions;
    observeResult: ObserveResult;
    refresh: RefreshViewHierarchy;
    signal?: AbortSignal;
    selectedCapture: HierarchySnapshot;
    searchDurationMs: number;
    startTime: number;
    lastHash: string | null;
    containerFoundEver: boolean;
  }) {
    let requestCount = 0;
    let changeCount = 0;
    let element: Element | null = null;
    const polled = await pollSearchUntil({
      timer: this.timer,
      startTime,
      durationMs: searchDurationMs,
      intervalMs: TapAnyElement.SEARCH_POLL_INTERVAL_MS,
      pacing: "sleepFirst",
      // A hierarchy request can consume the last millisecond of the search window. Do not
      // select from its result after the deadline: CtrlProxy may have served a stale fallback
      // when its synchronous refresh timed out, and a late candidate must not turn a bounded
      // search into an unbounded tap.
      discardLateResult: true,
      signal,
      fetch: (remainingTimeMs) => refresh(remainingTimeMs, observeResult.screenSize, signal),
      accept: (refreshed) => {
        const hash = hierarchyFingerprint(refreshed);
        if (hash && hash !== lastHash) {
          changeCount += 1;
          lastHash = hash;
        }

        selectedCapture = identifyObservedHierarchy(
          this.device.platform,
          refreshed,
          "fresh",
          this.timer,
          undefined,
          { iosMultiPanel: this.iosMultiPanel },
        );
        const found = this.findClickableElement(options, selectedCapture.hierarchy, {
          observationScreenSize: observeResult.screenSize,
          display: observeResult.viewHierarchy,
        });
        element = found.element;
        containerFoundEver = containerFoundEver || found.containerFound;
        return element !== null;
      },
    });
    requestCount = polled.requestCount;

    if (!element) {
      this.throwMissingClickableElement(options, containerFoundEver);
    }

    return { element, selectedCapture, startTime, requestCount, changeCount };
  }

  private async tapObservedElement({
    options,
    observeResult,
    fence,
    targetDisplay,
    refresh,
    onActivationWarnings,
    onDispatched,
    perf,
    signal,
    requestDeadlineMs,
  }: {
    options: TapAnyElementOptions;
    observeResult: ObserveResult;
    fence?: DisplayFence;
    targetDisplay: Awaited<ReturnType<typeof prepareTargetDisplayAction>> | undefined;
    refresh: RefreshViewHierarchy;
    onActivationWarnings: (messages?: string[]) => void;
    onDispatched: () => void;
    perf: PerformanceTracker;
    signal?: AbortSignal;
    requestDeadlineMs?: number;
  }) {
    throwIfAborted(signal);

    let viewHierarchy = observeResult.viewHierarchy;
    if (!viewHierarchy) {
      perf.end();
      return { success: false, error: "Unable to get view hierarchy, cannot tap on element" };
    }

    let talkBackState: boolean | null | undefined;
    if (this.device.platform === "android") {
      const confirmation = await resolveTalkBackStateConfirmation(
        this.accessibilityDetector,
        this.device.deviceId,
        this.adb,
        this.featureFlags,
      );
      talkBackState = confirmation.talkBack;
      if (confirmation.unconfirmed) {
        onActivationWarnings([TALKBACK_STATE_UNKNOWN_WARNING]);
      }
      if (talkBackState) {
        viewHierarchy = await freshTapHierarchy(
          (timeout) => refresh(timeout, observeResult.screenSize, signal),
          this.timer,
          signal,
        );
        observeResult.viewHierarchy = viewHierarchy;
      }
    }
    let selectedCapture = identifyObservedHierarchy(
      this.device.platform,
      viewHierarchy,
      "cached-ok",
      this.timer,
      undefined,
      { captureId: observeResult.observationId, iosMultiPanel: this.iosMultiPanel },
    );
    const searchDurationMs = this.getSearchUntilDuration(options);
    let startTime = this.timer.now();
    let requestCount = 0;
    let changeCount = 0;
    const lastHash = hierarchyFingerprint(viewHierarchy);

    const found = this.findClickableElement(options, selectedCapture.hierarchy, {
      observationScreenSize: observeResult.screenSize,
      display: observeResult.viewHierarchy,
    });
    let element = found.element;
    const containerFoundEver = found.containerFound;

    if (!element) {
      ({ element, selectedCapture, requestCount, changeCount } = await this.pollClickableTarget({
        options,
        observeResult,
        refresh,
        signal,
        selectedCapture,
        searchDurationMs,
        startTime,
        lastHash,
        containerFoundEver,
      }));
    }
    const cachedRefresh = await this.refreshCachedHierarchy(
      viewHierarchy,
      talkBackState,
      requestCount,
      {
        refresh,
        screenSize: observeResult.screenSize,
        signal,
        requestDeadlineMs,
      },
    );
    talkBackState = cachedRefresh.accessibilityEnabled;
    if (cachedRefresh.hierarchy) {
      viewHierarchy = cachedRefresh.hierarchy;
      observeResult.viewHierarchy = viewHierarchy;
      startTime = this.timer.now();
      selectedCapture = identifyObservedHierarchy(
        this.device.platform,
        viewHierarchy,
        "fresh",
        this.timer,
      );
      const current = this.findClickableElement(options, selectedCapture.hierarchy, {
        observationScreenSize: observeResult.screenSize,
        display: viewHierarchy,
      });
      element = current.element;
      if (!element) {
        // Start the same search window as a cache miss, from the fresh tree.
        ({ element, selectedCapture, requestCount, changeCount } = await this.pollClickableTarget({
          options,
          observeResult,
          refresh,
          signal,
          selectedCapture,
          searchDurationMs,
          startTime,
          lastHash: hierarchyFingerprint(viewHierarchy),
          containerFoundEver: current.containerFound,
        }));
      }
    }
    const target = this.capturedTapTarget(options, observeResult, {
      element,
      capture: selectedCapture,
      talkBackState,
    });
    const tapPoint = this.resolveTapPoint(target);
    // The element resolved in the scoped tree; the touch lands on whatever is on top (#9305).
    assertAppGestureNotUnderPrototype(target.capture.hierarchy, options.layer, tapPoint, "tap");
    const action = options.action;
    await this.dispatchTapTarget({
      options,
      observeResult,
      fence,
      targetDisplay,
      refresh,
      onActivationWarnings,
      onDispatched,
      signal,
      tapPoint,
      target,
      action,
    });
    perf.end();
    return this.createSuccessResult(action, target, startTime, requestCount, changeCount);
  }

  private async refreshCachedHierarchy(
    hierarchy: ViewHierarchyResult,
    accessibilityEnabled: boolean | null | undefined,
    requestCount: number,
    context: {
      refresh: RefreshViewHierarchy;
      screenSize: ObserveResult["screenSize"];
      signal?: AbortSignal;
      requestDeadlineMs?: number;
    },
  ): Promise<{
    hierarchy?: ViewHierarchyResult;
    accessibilityEnabled: boolean | null | undefined;
  }> {
    if (
      (this.device.platform !== "android" && this.device.platform !== "ios") ||
      accessibilityEnabled ||
      requestCount !== 0 ||
      wasHierarchyReadDuringCall(hierarchy)
    ) {
      return { accessibilityEnabled };
    }
    if (this.device.platform === "ios") {
      accessibilityEnabled = await this.iosVoiceOverDetector.isVoiceOverActiveOrUnknown(
        this.device.deviceId,
        IOSCtrlProxyClient.getInstance(this.device),
        this.featureFlags,
        undefined,
        context.signal,
      );
      if (accessibilityEnabled) {
        return { accessibilityEnabled };
      }
    }
    const refreshed = await freshTapHierarchy(
      (timeout) =>
        this.device.platform === "ios"
          ? context.refresh(timeout, context.screenSize, context.signal, true)
          : context.refresh(timeout, context.screenSize, context.signal),
      this.timer,
      context.signal,
      {
        timeoutMs: Math.min(
          DEFAULT_HIERARCHY_READ_TIMEOUT_MS,
          context.requestDeadlineMs === undefined
            ? DEFAULT_HIERARCHY_READ_TIMEOUT_MS
            : context.requestDeadlineMs - this.timer.now(),
        ),
        context: "while revalidating a cached observation",
        platform: this.device.platform,
      },
    );
    return { hierarchy: refreshed, accessibilityEnabled };
  }

  private async dispatchTapTarget({
    options,
    observeResult,
    fence,
    targetDisplay,
    refresh,
    onActivationWarnings,
    onDispatched,
    signal,
    tapPoint,
    target,
    action,
  }: {
    options: TapAnyElementOptions;
    observeResult: ObserveResult;
    fence?: DisplayFence;
    targetDisplay: Awaited<ReturnType<typeof prepareTargetDisplayAction>> | undefined;
    refresh: RefreshViewHierarchy;
    onActivationWarnings: (messages?: string[]) => void;
    onDispatched: () => void;
    signal?: AbortSignal;
    tapPoint: { x: number; y: number };
    target: CapturedTapTarget;
    action: TapAnyElementOptions["action"];
  }): Promise<void> {
    const { element, capture: selectedCapture } = target;
    const longPressDuration = this.getLongPressDuration(options);
    const tapContext = { signal, displayFence: fence, onActivationWarnings };

    logger.info(
      `[TapAnyElement] Tapping (${tapPoint.x}, ${tapPoint.y}) on clickable element: ` +
        `text=${JSON.stringify(element.text)}, ` +
        `bounds=${JSON.stringify(element.bounds)}`,
    );

    switch (this.device.platform) {
      case "android": {
        const preTapHash = hierarchyFingerprint(selectedCapture.hierarchy);
        const dispatch = targetDisplay
          ? await androidDisplayTapDispatch(
              this.accessibilityService,
              this.adb,
              { action, duration: longPressDuration },
              {
                target: targetDisplay,
                signal,
                onDispatched,
                timer: this.timer,
                onWarning: (warning) => onActivationWarnings([warning]),
                // Same TalkBack state the default route uses; unknown/off keeps the raw gesture.
                talkBack:
                  target.talkBackState === true
                    ? {
                        strategy: this.talkBackStrategy,
                        driver: this.talkBackDriverFactory.createDriver(this.device),
                      }
                    : undefined,
              },
            )
          : undefined;
        if (dispatch) {
          assertSelectedCapture(selectedCapture);
          await dispatch(tapPoint);
        } else {
          await this.executeAndroidTap(
            action,
            tapPoint.x,
            tapPoint.y,
            longPressDuration,
            target,
            tapContext,
          );
        }
        await this.retryAndroidTapIfNoChange(
          preTapHash,
          target,
          action,
          longPressDuration,
          observeResult.screenSize,
          { ...tapContext, selectionOptions: options, refresh, dispatch },
        );
        break;
      }
      case "ios":
        targetDisplay?.assertCurrent();
        assertSelectedCapture(selectedCapture);
        await this.executeIosTap(action, tapPoint.x, tapPoint.y, longPressDuration, element, {
          signal,
          displayFence: fence,
          scoped: target.scoped,
          voiceOverEnabled: target.talkBackState ?? undefined,
        });
        break;
      default:
        throw unsupportedPlatformError(this.device.platform, "tap any element");
    }
  }

  async execute(options: TapAnyElementOptions, call?: ActionCall): Promise<TapAnyElementResult>;
  /** @deprecated Pass an {@link ActionCall} instead of positional arguments. */
  async execute(
    options: TapAnyElementOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    request?: { requestDeadlineMs?: number },
  ): Promise<TapAnyElementResult>;
  async execute(
    options: TapAnyElementOptions,
    progressOrCall?: ProgressCallback | ActionCall,
    signalArg?: AbortSignal,
    requestArg?: { requestDeadlineMs?: number },
  ): Promise<TapAnyElementResult> {
    const { progress, signal, deadlineMs } = resolveDeadlineActionCall(
      progressOrCall,
      signalArg,
      requestArg,
    );
    const request = deadlineRequest(deadlineMs);
    return withObservationReadScope(() =>
      this.executeWithReadScope(options, progress, signal, request),
    );
  }

  private async executeWithReadScope(
    options: TapAnyElementOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    // Internal transport context; never part of public options or tool schemas.
    request?: { requestDeadlineMs?: number },
  ): Promise<TapAnyElementResult> {
    if (!options.action) {
      return this.createErrorResult(options.action, "tap action is required");
    }

    const validationError = this.validateOptions(options);
    if (validationError) {
      return this.createErrorResult(options.action, validationError);
    }

    const perf = createGlobalPerformanceTracker();
    perf.serial("tapAnyElement");

    let tapsDelivered = 0;
    let rethrowAbort = options.display !== undefined;
    try {
      // Reject before display resolution/observation can issue device commands.
      this.getLongPressDuration(options, request);
      throwIfAborted(signal);

      const targetDisplay =
        options.display === undefined
          ? undefined
          : await prepareTargetDisplayAction(
              this.device,
              options.display,
              this.observeScreen,
              this.adb,
              this.lastRenderedObservation,
              signal,
              this.displayTransitionReader,
            );
      const refresh: RefreshViewHierarchy =
        targetDisplay && this.device.platform === "android"
          ? (timeoutMs, _screenSize, refreshSignal) =>
              refreshTargetDisplayHierarchy(
                targetDisplay,
                this.hierarchyCapture,
                timeoutMs,
                () =>
                  this.staleDisplay(
                    targetDisplay.observation.display.generation ??
                      this.displayTransitionReader.identityRevision(this.device.deviceId),
                  ),
                refreshSignal,
              )
          : this.refreshViewHierarchy.bind(this);
      const warnings = new Set<string>();
      const onActivationWarnings = (messages: string[] = []) => {
        for (const warning of messages) {
          warnings.add(warning);
        }
      };
      const result = await this.observedInteraction<TapAnyElementResult>(
        (observeResult, fence) =>
          this.tapObservedElement({
            options,
            observeResult,
            fence,
            targetDisplay,
            refresh,
            onActivationWarnings,
            onDispatched: () => {
              tapsDelivered++;
              rethrowAbort = options.action !== "doubleTap" || tapsDelivered !== 1;
            },
            perf,
            signal,
            requestDeadlineMs: request?.requestDeadlineMs,
          }),
        {
          ...OBSERVED_INTERACTION_PROFILES.selectorResolvedGesture,
          display: targetDisplay?.observation.display.key,
          previousObservation: targetDisplay?.observation,
          timeoutMs: SETTLE_BUDGET_MS.gesture,
          progress,
          perf,
          signal,
          predictionContext: {
            toolName: "tapAny",
            toolArgs: {
              action: options.action,
              duration: options.duration,
              container: options.container,
              selectionStrategy: options.selectionStrategy,
              scrollableContainer: options.scrollableContainer,
              platform: this.device.platform,
            },
          },
        },
      );

      this.checkTapDeliveryDisplay(result, targetDisplay?.assertCurrent, signal);
      return { ...result, ...(warnings.size > 0 ? { warnings: [...warnings] } : {}) };
    } catch (error) {
      perf.end();
      this.rethrowObservationAbort(error, signal, rethrowAbort);
      const errorMsg = errorMessage(error);
      logger.warn(`[TapAnyElement] Tap failed: ${errorMsg}`, error);
      if (error instanceof StaleDisplayError) {
        return withStaleDisplay(this.createErrorResult(options.action, error.message), error);
      }
      return withStaleDisplay(
        {
          success: false,
          action: options.action,
          error: `Failed to tap clickable element: ${errorMsg}`,
          element: {
            bounds: { left: 0, top: 0, right: 0, bottom: 0 },
          } as Element,
        },
        error,
      );
    }
  }

  private checkTapDeliveryDisplay(
    result: TapAnyElementResult,
    assertCurrent?: () => void,
    signal?: AbortSignal,
  ): void {
    // A successful block returns only after the selected tap was delivered.
    if (result.success) {
      this.checkPostActionDisplay(result, assertCurrent, signal);
    } else {
      assertCurrent?.();
    }
  }

  private createSuccessResult(
    action: TapAnyElementOptions["action"],
    target: CapturedTapTarget,
    startTime: number,
    requestCount: number,
    changeCount: number,
  ): TapAnyElementResult {
    return {
      success: true,
      action,
      element: target.element,
      captureId: target.capture.captureId,
      searchUntil: {
        durationMs: Math.max(0, Math.round(this.timer.now() - startTime)),
        requestCount,
        changeCount,
      },
    };
  }
}
