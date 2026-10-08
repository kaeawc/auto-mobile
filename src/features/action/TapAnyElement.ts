import { isStrictlyScoped } from "../utility/ScopedSelection";
import { iosHierarchyAcquisition } from "../observe/ios/types";
import {
  withObservationReadScope,
  wasHierarchyReadDuringCall,
} from "../observe/observationReadScope";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import { freshTapHierarchy } from "./freshTapHierarchy";
import {
  isSemanticActionRejected,
  type TalkBackTargetContext,
} from "../talkback/resourceIdActionError";
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
import {
  resolveDisplayFence,
  type DisplayFenceOption,
  type DisplayFence,
  type DisplayFenceDependencies,
} from "./BaseVisualChange";
import { DEFAULT_GESTURE_REQUEST_TIMEOUT_MS } from "../observe/shared/SharedGestureDelegate";
import {
  assertLongPressFitsRequestBudget,
  LONG_PRESS_TIMEOUT_HEADROOM_MS,
  ORDINARY_TAP_DURATION_MS,
  resolveGestureCtrlProxyTimeoutMs as resolveTapAnyCtrlProxyTimeoutMs,
} from "./gestureTransportTimeout";
export { LONG_PRESS_TIMEOUT_HEADROOM_MS } from "./gestureTransportTimeout";
import { withStaleDisplay, StaleDisplayError } from "../../models/StaleDisplayError";
import { toActionableError, unsupportedPlatformError } from "../../models/ActionableError";
import {
  DefaultHierarchyCapture,
  getHierarchySnapshot,
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
import { AdbClient, AdbCommandTimeoutError } from "../../utils/android-cmdline-tools/AdbClient";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import {
  visibleTapBounds,
  DefaultElementGeometry,
  hasVisibleScreenPart,
  screenSizeForOffscreenCheck,
  type ScreenSizeForOffscreenCheckOptions,
} from "../utility/ElementGeometry";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";

// Fallback for injected selectors that predate `hasContainer`; resolver semantics, no finder.
const defaultContainerSelector = new ResolverElementSelector();
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import {
  createGlobalPerformanceTracker,
  type PerformanceTracker,
} from "../../utils/PerformanceTracker";
import { throwIfAborted } from "../../utils/toolUtils";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import { type Timer } from "../../utils/SystemTimer";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { serverConfig } from "../../utils/ServerConfig";
import { attachRawViewHierarchy } from "../utility/viewHierarchySearch";
import { refreshAndroidViewHierarchy } from "./refreshAndroidViewHierarchy";
import { hierarchyFingerprint } from "../../utils/hierarchyFingerprint";
import type { IosVoiceOverDetector } from "../accessibility/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../accessibility/IosVoiceOverDetector";
import { FeatureFlagService } from "../featureFlags/FeatureFlagService";
import { IOS_HIERARCHY_REQUEST_TIMEOUT_MS } from "../observe/ios/CtrlProxyHierarchy";
import { IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS } from "../observe/ios/CtrlProxyVoiceOver";
import type { AccessibilityDetector } from "../accessibility/interfaces/AccessibilityDetector";
import { accessibilityDetector as defaultAccessibilityDetector } from "../accessibility/AccessibilityDetector";
import {
  androidDisplayTapDispatch,
  dispatchAndroidCoordinateTap,
  dispatchIosCoordinateTap,
  dispatchIosSecondTap,
  indeterminateTapError,
} from "./coordinateTapDispatch";
import { dispatchAndroidDoubleTap } from "./androidDoubleTap";
import { assertTouchscreenInputSucceeded } from "./touchscreenInput";
import {
  requiresNodeSelector,
  stableNodeSelectorForElement,
  TalkBackTapStrategy,
} from "../talkback/TalkBackTapStrategy";
import { hasAccessibilityAction } from "../utility/elementProperties";
import { checkAndroidTapHierarchyChange, PRE_RETRY_DELAY_MS } from "./androidGhostTapRetry";
import {
  assertAppGestureNotUnderOverlay,
  scopeHierarchyForSelector,
} from "../observe/hierarchyLayer";
import {
  DefaultTalkBackNavigationDriverFactory,
  type TalkBackNavigationDriverFactory,
} from "../talkback/TalkBackNavigationDriver";

type TapAnyAccessibilityService = Pick<
  AndroidCtrlProxyClient,
  "requestTapCoordinates" | "requestAction" | "requestNodeAction" | "supportsNodeActionSelectors"
> &
  Partial<Pick<AndroidCtrlProxyClient, "supportsCommand">>;

interface TapAnyElementDependencies extends DisplayFenceDependencies {
  lastRenderedObservation?: RenderedObservationReader;
  hierarchyCapture?: HierarchyCapture;
  timer?: Timer;
  elementSelector?: ElementSelector;
  iosVoiceOverDetector?: IosVoiceOverDetector;
  featureFlags?: FeatureFlagService;
  accessibilityDetector?: AccessibilityDetector;
  talkBackStrategy?: Pick<
    TalkBackTapStrategy,
    | "executeDirectActivation"
    | "executeCoordinateFallback"
    | "executeLongPress"
    | "executePreciseTap"
  >;
  talkBackDriverFactory?: TalkBackNavigationDriverFactory;
  accessibilityService?: TapAnyAccessibilityService;
}

type RefreshViewHierarchy = (
  timeoutMs: number,
  screenSize?: ObserveResult["screenSize"],
  signal?: AbortSignal,
  forceCapture?: boolean,
) => Promise<ViewHierarchyResult | null>;

interface CapturedTapTarget {
  observationScreenSize?: ObserveResult["screenSize"];
  observationDisplay?: ScreenSizeForOffscreenCheckOptions["display"];
  scoped?: boolean;
  talkBackState?: boolean | null;
  element: Element;
  capture: HierarchySnapshot;
}

/**
 * Established per-request default timeout that `SharedGestureDelegate.requestTapCoordinates`,
 * `CtrlProxyVoiceOver.requestAction`, and `CtrlProxyVoiceOver.requestVoiceOverActivate` each
 * apply when no `timeoutMs` is passed. An ordinary tap/doubleTap relied on this default before
 * `resolveTapAnyCtrlProxyTimeoutMs` started sizing an explicit timeout from the (short, 50ms)
 * fixed press duration -- whose unfloored duration + headroom is ~2050ms, below this floor. Applying that
 * shorter value unguarded shrinks, rather than merely budgets, the window an ordinary tap
 * already had for a slow-but-otherwise-healthy CtrlProxy round trip: XCTest performs element
 * lookup and `tap()`/activation before replying, so a device that legitimately takes 2.05-5s
 * could now report failure -- and potentially still execute the tap after that reported failure
 * -- where the same request previously succeeded (issue #6306 review, P1).
 * `resolveTapAnyOrdinaryTapCtrlProxyTimeoutMs` below floors at this value so the tapAny-specific
 * budgeting stays additive/bounding on top of the established default, never below it.
 */
export const TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS = DEFAULT_GESTURE_REQUEST_TIMEOUT_MS;

/**
 * Build the INNER CtrlProxy request timeout for an ORDINARY (non-longPress) iOS tap/doubleTap
 * gesture. Same derivation as `resolveTapAnyCtrlProxyTimeoutMs` (press duration + headroom,
 * clamped to `MAX_SETTIMEOUT_DELAY_MS`), floored at
 * `TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS` so sizing an explicit timeout from the tap's
 * short fixed press duration never reduces the established default the underlying CtrlProxy
 * request methods already applied (issue #6306 review, P1). The shared formula also preserves
 * this default for short long presses (issue #6327).
 */
function resolveTapAnyOrdinaryTapCtrlProxyTimeoutMs(pressDurationMs: number): number {
  return Math.max(
    resolveTapAnyCtrlProxyTimeoutMs(pressDurationMs),
    TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS,
  );
}

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
 * Fixed delay `executeIosTapWithCoordinates` sleeps between the two presses
 * of a `doubleTap`. Exported for the same reason as
 * `TAP_ANY_ORDINARY_TAP_DURATION_MS` above (issue #6276).
 */
export const TAP_ANY_DOUBLE_TAP_GAP_MS = 200;

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

/**
 * Worst-case WALL-CLOCK time for an ordinary `tap`/`doubleTap` gesture: `doubleTap` issues two
 * sequential CtrlProxy requests separated by `TAP_ANY_DOUBLE_TAP_GAP_MS`, and EACH request can
 * independently consume the full `TAP_ANY_ORDINARY_TAP_CTRL_PROXY_TIMEOUT_MS` before CtrlProxy
 * replies (or the request times out) -- not just the on-device press duration
 * (`TAP_ANY_ORDINARY_TAP_DURATION_MS`), which is what an earlier round of this arithmetic
 * charged (issue #6306 review, P2): with near-deadline observations that undersizing let the
 * outer floor expire mid-gesture even though the CtrlProxy requests themselves were still
 * within their own established timeout. Exported so the daemon's outer MCP timeout budgeting
 * (`resolveTapAnyOrdinaryTapBudgetMs` in `src/daemon/mcpRequestTimeout.ts`) shares this single
 * derived value instead of duplicating the arithmetic -- using the doubleTap worst case for
 * both `tap` and `doubleTap` only ever over-budgets a plain `tap`, never under-budgets it.
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
  private hierarchyAccessibilityService: AndroidCtrlProxyClient;
  private viewHierarchy: ViewHierarchy;
  private hierarchyCapture: HierarchyCapture;
  private iosVoiceOverDetector: IosVoiceOverDetector;
  private featureFlags: FeatureFlagService;
  private accessibilityDetector: AccessibilityDetector;
  private talkBackStrategy: Pick<
    TalkBackTapStrategy,
    | "executeDirectActivation"
    | "executeCoordinateFallback"
    | "executeLongPress"
    | "executePreciseTap"
  >;
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
    adb: AdbClient | null = null,
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
              undefined,
              true,
              request.minTimestamp ?? 0,
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

  /** Test-only seam for observing when Android gesture dispatch begins. */
  setBeforeAndroidTapForTesting(callback: () => void): void {
    this.beforeAndroidTapForTesting = callback;
  }

  // oxlint-disable-next-line max-params -- Preserve positional callers by appending the optional display fence.
  private async executeAndroidTap(
    action: TapAnyElementOptions["action"],
    x: number,
    y: number,
    durationMs: number,
    target: CapturedTapTarget,
    signal?: AbortSignal,
    fenceOptions: DisplayFenceOption & {
      onActivationWarnings?: (warnings?: string[]) => void;
    } = {},
  ): Promise<void> {
    const fence = resolveDisplayFence(fenceOptions);
    const { element, capture } = target;
    this.beforeAndroidTapForTesting?.();
    this.assertSelectedCapture(capture);
    // UiAutomator captures keep their existing coordinate route, but unavailable
    // TalkBack evidence must still be retried and reported to the caller.
    const { talkBack: talkBackState, unconfirmed } =
      target.talkBackState === undefined
        ? await resolveTalkBackStateConfirmation(
            this.accessibilityDetector,
            this.device.deviceId,
            this.adb,
            this.featureFlags,
          )
        : { talkBack: target.talkBackState, unconfirmed: false };
    if (unconfirmed) {
      fenceOptions.onActivationWarnings?.([TALKBACK_STATE_UNKNOWN_WARNING]);
    }
    const talkBackEnabled = element["hierarchy-source"] !== "uiautomator" && talkBackState === true;
    if (
      talkBackEnabled &&
      (await this.executeAndroidTalkBackTap(action, x, y, durationMs, element, {
        displayFence: fence,
        scoped: target.scoped,
        hierarchy: resolveViewHierarchyForSearch(capture.hierarchy),
        onActivationWarnings: fenceOptions.onActivationWarnings,
      }))
    ) {
      return;
    }

    if (action === "longPress") {
      if (await this.trySemanticAndroidLongPress(element, { signal, scoped: target.scoped })) {
        return;
      }
      await this.executeAndroidLongPress(x, y, durationMs, signal, { displayFence: fence });
      return;
    }

    await this.executeAndroidCoordinateTap(
      action,
      { x, y },
      {
        signal,
        fence,
        onActivationWarnings: fenceOptions.onActivationWarnings,
      },
    );
  }

  /** One tap, or a doubleTap whose touches are timed on the device when CtrlProxy supports it. */
  private async executeAndroidCoordinateTap(
    action: TapAnyElementOptions["action"],
    point: { x: number; y: number },
    context: {
      signal?: AbortSignal;
      fence: { assertCurrent(): void };
      onActivationWarnings?: (warnings?: string[]) => void;
    },
  ): Promise<void> {
    const { signal, fence } = context;
    const tapOnce = async () => {
      // Once beforeSend lands, also pass this as the dispatch's beforeSend.
      fence.assertCurrent();
      await dispatchAndroidCoordinateTap(
        this.accessibilityService,
        this.adb,
        point.x,
        point.y,
        10,
        undefined,
        signal,
      );
    };
    if (action !== "doubleTap") {
      await tapOnce();
      return;
    }
    await dispatchAndroidDoubleTap({
      client: this.accessibilityService,
      point,
      timer: this.timer,
      signal,
      assertCurrent: () => fence.assertCurrent(),
      onWarning: (warning) => context.onActivationWarnings?.([warning]),
      tap: tapOnce,
    });
  }

  private async executeAndroidLongPress(
    x: number,
    y: number,
    durationMs: number,
    signal?: AbortSignal,
    fenceOptions: DisplayFenceOption = {},
  ): Promise<void> {
    const fence = resolveDisplayFence(fenceOptions);
    throwIfAborted(signal);
    try {
      // Match tapOn's touchscreen source and retain the generic input fallback.
      try {
        // Once beforeSend lands, also pass this as the dispatch's beforeSend.
        fence.assertCurrent();
        const command = `shell input touchscreen swipe ${x} ${y} ${x} ${y} ${durationMs}`;
        const result = await this.adb.executeCommand(
          command,
          resolveTapAnyCtrlProxyTimeoutMs(durationMs),
          undefined,
          undefined,
          signal,
        );
        assertTouchscreenInputSucceeded(command, result);
        return;
      } catch (error) {
        logger.warn(`[TapAnyElement] touch input swipe failed: ${errorMessage(error)}`, error);
        this.throwIfLongPressInterrupted(error, durationMs, signal);
        if (error instanceof StaleDisplayError) {
          throw error;
        }
        throwIfAborted(signal);
      }
      // Only a non-cancellation failure may use the legacy input source.
      fence.assertCurrent();
      const command = `shell input swipe ${x} ${y} ${x} ${y} ${durationMs}`;
      const result = await this.adb.executeCommand(
        command,
        resolveTapAnyCtrlProxyTimeoutMs(durationMs),
        undefined,
        undefined,
        signal,
      );
      assertTouchscreenInputSucceeded(command, result);
      return;
    } catch (error) {
      logger.warn(`[TapAnyElement] Android long press failed: ${errorMessage(error)}`, error);
      this.throwIfLongPressInterrupted(error, durationMs, signal);
      if (error instanceof StaleDisplayError) {
        throw error;
      }
      throw toActionableError(error, "Android long press failed");
    }
  }

  private throwIfLongPressInterrupted(
    error: unknown,
    durationMs: number,
    signal?: AbortSignal,
  ): void {
    if (
      signal?.aborted ||
      error instanceof AdbCommandTimeoutError ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      // Killing host adb cannot cancel input's system_server injection.
      throw new ActionableError(
        `Android long press interrupted; press may still be held on the device for up to ${durationMs} ms. Wait ${durationMs} ms before retrying touch input.`,
        { cause: error },
      );
    }
  }

  private async trySemanticAndroidLongPress(
    element: Element,
    context: { signal?: AbortSignal; scoped?: boolean },
  ): Promise<boolean> {
    const { signal, scoped } = context;
    const selector = stableNodeSelectorForElement(element);
    if (!selector || scoped || element["hierarchy-source"] === "uiautomator") {
      return false;
    }
    const needsNodeSelector = requiresNodeSelector(selector);
    if (needsNodeSelector && !(await this.accessibilityService.supportsNodeActionSelectors())) {
      return false;
    }
    try {
      throwIfAborted(signal);
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
        // A forced fresh capture: the tree the element came from may predate the lookup miss.
        readHierarchy: () =>
          this.refreshViewHierarchy(DEFAULT_HIERARCHY_READ_TIMEOUT_MS, undefined, signal, true),
      });
      throwIfAborted(signal);
      if (rejected) {
        throw new ActionableError(
          `Semantic long press failed for the selected element: ${result.error ?? "unknown error"}`,
        );
      }
      logger.warn(`[TapAnyElement] Accessibility long click failed: ${result.error}`);
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof ActionableError) {
        throw error;
      }
      logger.warn(`[TapAnyElement] Accessibility long click error: ${error}`);
    }
    return false;
  }

  private async executeAndroidTalkBackTap(
    action: TapAnyElementOptions["action"],
    x: number,
    y: number,
    durationMs: number,
    element: Element,
    fenceOptions: DisplayFenceOption &
      TalkBackTargetContext & {
        scoped?: boolean;
        onActivationWarnings?: (warnings?: string[]) => void;
      } = {},
  ): Promise<boolean> {
    const fence = fenceOptions.displayFence;
    const driver = this.talkBackDriverFactory.createDriver(this.device);
    if (action === "longPress" && !fenceOptions.scoped) {
      const result = await this.talkBackStrategy.executeLongPress(
        x,
        y,
        durationMs,
        element,
        driver,
        { ...fenceOptions, displayFence: fence },
      );
      if (!result.success && result.semanticActionFailure) {
        throw new ActionableError(
          `Semantic long press failed for the selected element: ${result.error ?? "unknown error"}`,
        );
      }
      return result.success;
    }
    if (action === "tap" && !fenceOptions.scoped) {
      const direct = await this.talkBackStrategy.executeDirectActivation(
        element,
        driver,
        fenceOptions,
      );
      if (direct.success) {
        return true;
      }
      logger.warn(
        `[TapAnyElement] Direct accessibility activation failed (${direct.error}); trying coordinate fallback`,
      );
    }
    const fallback =
      action === "tap"
        ? await this.talkBackStrategy.executePreciseTap(x, y, driver, fence)
        : await this.talkBackStrategy.executeCoordinateFallback(x, y, action, durationMs, driver, {
            displayFence: fence,
          });
    fenceOptions.onActivationWarnings?.(fallback.warnings);
    return fallback.success;
  }

  // oxlint-disable-next-line max-params -- Preserve positional callers by appending the optional display fence.
  private async retryAndroidTapIfNoChange(
    preTapHash: string | null,
    target: CapturedTapTarget,
    action: TapAnyElementOptions["action"],
    durationMs: number,
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
    fenceOptions: DisplayFenceOption & {
      selectionOptions?: TapAnyElementOptions;
      refresh?: RefreshViewHierarchy;
      dispatch?: (point: { x: number; y: number }) => Promise<void>;
      onActivationWarnings?: (warnings?: string[]) => void;
    } = {},
  ): Promise<void> {
    const fence = fenceOptions.displayFence;
    const reportedTarget = target;
    if (action !== "tap" || !preTapHash) {
      return;
    }
    const probe = await checkAndroidTapHierarchyChange(
      this.timer,
      (timeoutMs) =>
        (fenceOptions.refresh ?? this.refreshViewHierarchy.bind(this))(
          timeoutMs,
          screenSize,
          signal,
        ),
      (postTapHierarchy) => this.hashViewHierarchy(postTapHierarchy),
      preTapHash,
      signal,
    );
    if (probe.status === "unavailable") {
      logger.warn(
        "[TapAnyElement] Tap hierarchy unreadable or could not be fingerprinted; skipping retry",
      );
      return;
    }
    if (probe.status === "changed") {
      return;
    }
    const options = fenceOptions.selectionOptions;
    if (options && isStrictlyScoped(options, "any-container")) {
      const capture = identifyObservedHierarchy(
        this.device.platform,
        probe.hierarchy,
        "cached-ok",
        this.timer,
      );
      const refound = this.findClickableElement(options, capture.hierarchy, {
        observationScreenSize: screenSize,
      });
      if (!refound.element) {
        return;
      }
      target = { ...target, element: refound.element, capture };
    }
    // The first tap was unobserved. Retry the captured or re-resolved target once after debounce.
    let retryPoint = this.resolveTapPoint(target, { observationScreenSize: screenSize });
    logger.warn(
      `[TapAnyElement] Hierarchy unchanged after tap at (${retryPoint.x}, ${retryPoint.y}); retrying`,
    );
    await this.timer.sleep(PRE_RETRY_DELAY_MS);
    await this.refreshTalkBackRetryTarget(
      target,
      options,
      fenceOptions.refresh,
      screenSize,
      signal,
    );
    if (target.talkBackState) {
      Object.assign(reportedTarget, target);
    }
    retryPoint = this.resolveTapPoint(target, { observationScreenSize: screenSize });
    if (fenceOptions.dispatch) {
      this.assertSelectedCapture(target.capture);
      await fenceOptions.dispatch(retryPoint);
      return;
    }
    await this.executeAndroidTap(action, retryPoint.x, retryPoint.y, durationMs, target, signal, {
      displayFence: fence,
      onActivationWarnings: fenceOptions.onActivationWarnings,
    });
  }

  private async refreshTalkBackRetryTarget(
    target: CapturedTapTarget,
    options: TapAnyElementOptions | undefined,
    refresh: RefreshViewHierarchy | undefined,
    screenSize: ObserveResult["screenSize"] | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!target.talkBackState || !options) {
      return;
    }
    // The debounce wait follows the post-tap probe. Capture after that wait,
    // then use tapAny's existing selector rather than the earlier coordinates.
    const hierarchy = await freshTapHierarchy(
      (timeout) => (refresh ?? this.refreshViewHierarchy.bind(this))(timeout, screenSize, signal),
      this.timer,
      signal,
    );
    const capture = identifyObservedHierarchy(this.device.platform, hierarchy, "fresh", this.timer);
    const found = this.findClickableElement(options, capture.hierarchy, {
      observationScreenSize: screenSize,
    });
    if (!found.element) {
      throw new ActionableError(
        "Selected element moved or is gone and no clickable target remains. Observe again before tapping.",
      );
    }
    Object.assign(target, { element: found.element, capture });
  }

  private assertSelectedCapture(selectedCapture: HierarchySnapshot): void {
    const dispatchCapture = getHierarchySnapshot(selectedCapture.hierarchy);
    if (
      dispatchCapture?.captureId !== selectedCapture.captureId ||
      dispatchCapture.hierarchy !== selectedCapture.hierarchy
    ) {
      throw new ActionableError("Selected hierarchy capture changed before tap dispatch");
    }
  }

  private createErrorResult(action: string, error: string): TapOnElementResult {
    return {
      success: false,
      action,
      error,
      element: {
        bounds: { left: 0, top: 0, right: 0, bottom: 0 },
      } as Element,
    };
  }

  private validateOptions(options: TapAnyElementOptions): string | null {
    if (options.container) {
      const containerSelectorCount = [options.container.elementId, options.container.text].filter(
        Boolean,
      ).length;
      if (containerSelectorCount !== 1) {
        return "tapAny container must specify exactly one of elementId or text";
      }
    }
    return null;
  }

  private getSearchUntilDuration(options: TapAnyElementOptions): number {
    const duration = options.searchUntil?.duration ?? TapAnyElement.SEARCH_UNTIL_DEFAULT_MS;
    if (!Number.isFinite(duration)) {
      throw new ActionableError("searchUntil.duration must be a number");
    }
    if (duration < TapAnyElement.SEARCH_UNTIL_MIN_MS) {
      throw new ActionableError(
        `searchUntil.duration must be at least ${TapAnyElement.SEARCH_UNTIL_MIN_MS}ms`,
      );
    }
    if (duration > TapAnyElement.SEARCH_UNTIL_MAX_MS) {
      throw new ActionableError(
        `searchUntil.duration must be at most ${TapAnyElement.SEARCH_UNTIL_MAX_MS}ms`,
      );
    }
    return Math.round(duration);
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
      defaultContainerSelector.hasContainer(viewHierarchy, container)
    );
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
    const selection = this.elementSelector.selectClickable(viewHierarchy, {
      screenSizeOptions,
      container: options.container,
      strategy: options.selectionStrategy,
      intentAction: options.action === "longPress" ? "long-press" : "tap",
      scrollableContainer: options.scrollableContainer,
    });
    if (selection.element && !hasVisibleScreenPart(selection.element.bounds, effectiveScreenSize)) {
      return { element: null, containerFound };
    }
    return { element: selection.element, containerFound };
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
    return this.geometry.getElementCenter({ bounds });
  }

  private hashViewHierarchy(viewHierarchy: ViewHierarchyResult | null): string | null {
    return hierarchyFingerprint(viewHierarchy);
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
    const effectiveTimeoutMs = Math.max(0, timeoutMs);
    switch (this.device.platform) {
      case "android": {
        const rawHierarchy = await refreshAndroidViewHierarchy(
          this.hierarchyAccessibilityService,
          effectiveTimeoutMs,
          signal,
          { adb: this.adb, timer: this.timer },
        );
        return rawHierarchy ? this.prepareViewHierarchyForResponse(rawHierarchy, screenSize) : null;
      }
      case "ios": {
        // Direct sync bypasses the client TTL while retaining the search deadline.
        const client = IOSCtrlProxyClient.getInstance(this.device);
        const synced = forceCapture
          ? await client.requestHierarchySyncForTapRevalidation(
              undefined,
              false,
              signal,
              effectiveTimeoutMs,
            )
          : await client.requestHierarchySync(undefined, false, signal, effectiveTimeoutMs);
        if (!synced?.hierarchy) {
          return null;
        }
        const hierarchy = this.viewHierarchy.normalizeIosHierarchy(
          IOSCtrlProxyClient.getInstance(this.device).convertToViewHierarchyResult(
            synced.hierarchy,
          ),
        );
        const acquisition = synced[iosHierarchyAcquisition];
        if (acquisition === "device" || acquisition === "client-cache") {
          Object.assign(hierarchy, { [iosHierarchyAcquisition]: acquisition });
        }
        return this.prepareViewHierarchyForResponse(hierarchy, screenSize);
      }
      default:
        throw unsupportedPlatformError(this.device.platform, "tap any element");
    }
  }

  private getLongPressDuration(
    options: TapAnyElementOptions,
    request?: { requestDeadlineMs?: number },
  ): number {
    if (options.action !== "longPress") {
      return 0;
    }
    if (options.duration !== undefined && options.duration > LONG_PRESS_HARD_MAX_MS) {
      throw new ActionableError(
        `longPress duration too large; maximum is ${LONG_PRESS_HARD_MAX_MS} ms; requested ${options.duration} ms`,
      );
    }
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

  /**
   * Execute a tap/doubleTap/longPress action on iOS via the CtrlProxy gesture API.
   *
   * `IOSCtrlProxyClient` has no `tap`/`doubleTap`/`longPress` methods; the real
   * gesture API is `requestTapCoordinates`, which `TapOnElement.executeiOSTapWithCoordinates`
   * also uses. When VoiceOver is enabled, mirror `TapOnElement.executeiOSTap`: a bare
   * coordinate press only *focuses* an element under VoiceOver rather than activating
   * it, so route through `requestVoiceOverActivate` instead (same detector/seam as
   * `TapOnElement`), falling back to the coordinate path if no label is resolvable or
   * the VoiceOver action itself fails.
   */
  // oxlint-disable-next-line max-params -- Preserve positional callers by appending the optional display fence.
  private async executeIosTap(
    action: string,
    x: number,
    y: number,
    longPressDuration: number,
    element?: Element,
    signal?: AbortSignal,
    fenceOptions: DisplayFenceOption & { scoped?: boolean; voiceOverEnabled?: boolean } = {},
  ): Promise<void> {
    const fence = fenceOptions.displayFence;
    const xcTestClient = IOSCtrlProxyClient.getInstance(this.device);
    // Fail-safe tap-bias variant (#6267): an indeterminate probe must route
    // through the VoiceOver activation gesture rather than a plain
    // coordinate touch that would get reported as a successful activation.
    // `signal` is threaded through so a caller deadline that already expired
    // while `ensureConnected()`/auto-setup was resolving aborts this probe
    // before dispatch, rather than after the caller has given up (issue
    // #6306 review).
    const isVoiceOverEnabled =
      fenceOptions.voiceOverEnabled ??
      (await this.iosVoiceOverDetector.isVoiceOverActiveOrUnknown(
        this.device.deviceId,
        xcTestClient,
        this.featureFlags,
        undefined,
        signal,
      ));

    if (isVoiceOverEnabled && element) {
      await this.executeIosTapWithVoiceOver(xcTestClient, action, element, x, y, {
        durationMs: longPressDuration,
        scoped: fenceOptions.scoped,
        signal,
      });
      return;
    }

    await this.executeIosTapWithCoordinates(xcTestClient, action, x, y, longPressDuration, signal, {
      displayFence: fence,
    });
  }

  /**
   * Execute iOS tap using coordinate-based input (standard mode).
   *
   * CtrlProxy blocks its reply until the on-device press actually completes, so
   * every action sizes the request timeout from its press duration —
   * `requestTapCoordinates`'s own generic default timeout would otherwise apply
   * to an ordinary tap/doubleTap, leaving it with no tapAny-specific floor/ceiling
   * tailored to a quick gesture (issue #6276). An ordinary tap/doubleTap floors
   * that explicit timeout at `TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS` --
   * the established default `requestTapCoordinates` already applied -- so sizing
   * it from the short fixed press duration never SHRINKS the window a slow-but-
   * healthy CtrlProxy round trip already had (issue #6306 review, P1).
   */
  // oxlint-disable-next-line max-params -- Preserve positional callers by appending the optional display fence.
  private async executeIosTapWithCoordinates(
    xcTestClient: IOSCtrlProxyClient,
    action: string,
    x: number,
    y: number,
    longPressDuration: number,
    signal?: AbortSignal,
    fenceOptions: DisplayFenceOption = {},
  ): Promise<void> {
    const fence = resolveDisplayFence(fenceOptions);
    // Short fixed duration for tap/doubleTap, caller-supplied duration for longPress.
    const tapDuration =
      action === "longPress" ? longPressDuration : TAP_ANY_ORDINARY_TAP_DURATION_MS;
    const timeoutMs =
      action === "longPress"
        ? resolveTapAnyCtrlProxyTimeoutMs(tapDuration)
        : resolveTapAnyOrdinaryTapCtrlProxyTimeoutMs(tapDuration);

    // `signal` reaches `sendCommand` as `abortSignal`: a caller deadline that
    // already fired while `ensureConnected()` was resolving a reconnect/
    // auto-setup (not itself cancellable) is checked right after that await
    // and before dispatch, so the gesture is never sent to the device after
    // the caller has already given up and returned a timeout (issue #6306
    // review, P1/P2).
    if (action === "doubleTap") {
      // Once beforeSend lands, also pass this as the dispatch's beforeSend.
      fence.assertCurrent();
      await dispatchIosCoordinateTap(xcTestClient, x, y, tapDuration, undefined, {
        signal,
        timeoutMs,
      });
      await this.timer.sleep(TAP_ANY_DOUBLE_TAP_GAP_MS);
      // Once beforeSend lands, also pass this as the dispatch's beforeSend.
      fence.assertCurrent();
      await dispatchIosSecondTap(xcTestClient, { x, y }, tapDuration, { signal, timeoutMs });
      return;
    }

    // Once beforeSend lands, also pass this as the dispatch's beforeSend.
    fence.assertCurrent();
    throwIfAborted(signal);
    try {
      await dispatchIosCoordinateTap(xcTestClient, x, y, tapDuration, undefined, {
        signal,
        timeoutMs,
      });
    } catch (error) {
      logger.warn(`[TapAnyElement] CtrlProxy iOS tap failed: ${errorMessage(error)}`, error);
      if (action === "longPress") {
        // The client cannot confirm native cancellation or whether dispatch occurred.
        throw new ActionableError(
          `iOS long press failed: ${errorMessage(error)}; press may still be held on the device for up to ${tapDuration} ms. Wait ${tapDuration} ms before retrying touch input.`,
          { cause: error },
        );
      }
      throw toActionableError(error, "CtrlProxy iOS tap failed");
    }
  }

  /**
   * Execute iOS tap using VoiceOver accessibility actions.
   *
   * Prefers activating by `resource-id` (`requestAction`, mirroring how
   * `TapOnElement`/`TalkBackTapStrategy` activate Android elements by resourceId) —
   * on-device this resolves the element via `elementLocator.findElement(byResourceId:)`
   * and calls `found.tap()`/`found.press()` on the *specific* node the selector
   * matched. Nested/unique calls instead use the selected bounds with the label,
   * because resource-ID activation can reselect a peer outside the scope.
   * For legacy calls, only when no usable resource-id exists does this fall back to
   * activating by accessibility label (`requestVoiceOverActivate`): CtrlProxy
   * resolves a label via `.firstMatch`, a global (not container-scoped) query, so
   * an element whose label is shared by multiple controls could activate a
   * *different*, same-labeled control than the one tapAny selected (issue #6248
   * review, funaa). Only when NEITHER a resource-id nor a label exists — nothing to
   * activate semantically — does this throw instead of falling back to a coordinate
   * press: under VoiceOver a bare coordinate press only *focuses* an element rather
   * than activating it, so reporting success after that fallback (or after a real
   * activation attempt fails) would mask a real activation failure (issue #6248
   * review). This mirrors the non-fallback-on-failure behavior `TapOnElement` should
   * also have for the same reason.
   */
  private resolveIosVoiceOverLabel(element: Element): string | undefined {
    // ios-accessibility-label > content-desc > text > fallback
    return (
      (element["ios-accessibility-label"] as string | undefined) ??
      (typeof element["content-desc"] === "string" && element["content-desc"]
        ? element["content-desc"]
        : undefined) ??
      (typeof element.text === "string" && element.text ? element.text : undefined)
    );
  }

  private resolveIosResourceId(element: Element): string | undefined {
    return typeof element["resource-id"] === "string" && element["resource-id"]
      ? element["resource-id"]
      : undefined;
  }

  /**
   * Activate a resource-id-only target (no resolvable label) through the
   * identifier-based node-action path rather than a coordinate press.
   */
  private async activateIosByResourceId(
    xcTestClient: IOSCtrlProxyClient,
    resourceId: string,
    voiceOverAction: "activate" | "long_press",
    timeoutMs: number | undefined,
    duration?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    let dispatched = false;
    let result: Awaited<ReturnType<IOSCtrlProxyClient["requestAction"]>>;
    try {
      result = await xcTestClient.requestAction(
        voiceOverAction,
        resourceId,
        undefined,
        timeoutMs,
        undefined,
        {
          ...(duration === undefined ? {} : { duration }),
          abortSignal: signal,
          onDispatch: () => {
            dispatched = true;
          },
        },
      );
    } catch (error) {
      // A socket failure after the write is unconfirmed; a refusal or the caller's abort is not.
      if (dispatched && !(error instanceof ActionableError) && error !== signal?.reason) {
        throw indeterminateTapError(errorMessage(error));
      }
      throw error;
    }
    this.confirmIosVoiceOverDispatch(result);
    if (!result.success) {
      throw new ActionableError(
        `VoiceOver action failed for resource-id "${resourceId}": ${result.error ?? "unknown error"}`,
      );
    }
  }

  /** A VoiceOver activation that was written but never answered may have landed. */
  private confirmIosVoiceOverDispatch(result: {
    error?: string;
    dispatched?: boolean;
    acknowledged?: boolean;
  }): void {
    if (result.dispatched && result.acknowledged !== true) {
      throw indeterminateTapError(result.error);
    }
  }

  private async executeIosTapWithVoiceOver(
    xcTestClient: IOSCtrlProxyClient,
    action: string,
    element: Element,
    x: number,
    y: number,
    pressOptions: { durationMs: number; scoped?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    const longPressDuration = pressOptions.durationMs;
    const label = this.resolveIosVoiceOverLabel(element);
    const resourceId = pressOptions.scoped ? undefined : this.resolveIosResourceId(element);

    if (!label && !resourceId) {
      throw new ActionableError(
        pressOptions.scoped
          ? "Scoped VoiceOver activation requires a label and selected bounds; global resource-ID activation cannot preserve the scope"
          : "VoiceOver is enabled but the selected element has no accessibility label, " +
              "content-desc, text, or resource-id to activate; a coordinate press would " +
              "only focus it under VoiceOver, not activate it",
      );
    }

    const voiceOverAction: "activate" | "long_press" =
      action === "longPress" ? "long_press" : "activate";
    // Ordinary tap/doubleTap floors at the established default (P1 fix, issue #6306
    // review) the same way `executeIosTapWithCoordinates` does -- longPress keeps
    // tracking its caller-supplied duration exactly, with no floor.
    const timeoutMs =
      action === "longPress"
        ? resolveTapAnyCtrlProxyTimeoutMs(longPressDuration)
        : resolveTapAnyOrdinaryTapCtrlProxyTimeoutMs(TAP_ANY_ORDINARY_TAP_DURATION_MS);

    if (resourceId) {
      await this.activateIosByResourceId(
        xcTestClient,
        resourceId,
        voiceOverAction,
        timeoutMs,
        action === "longPress" ? longPressDuration : undefined,
        pressOptions.signal,
      );
      return;
    }

    const result = await xcTestClient.requestVoiceOverActivate(
      label as string,
      voiceOverAction,
      timeoutMs,
      undefined,
      {
        bounds: element.bounds,
        duration: action === "longPress" ? longPressDuration : undefined,
      },
    );

    this.confirmIosVoiceOverDispatch(result);
    if (!result.success) {
      throw new ActionableError(
        `VoiceOver action failed for label "${label}": ${result.error ?? "unknown error"}`,
      );
    }
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
    const deadline = startTime + searchDurationMs;
    while (this.timer.now() < deadline) {
      throwIfAborted(signal);
      await this.timer.sleep(TapAnyElement.SEARCH_POLL_INTERVAL_MS);
      const remainingTimeMs = Math.max(0, deadline - this.timer.now());
      if (remainingTimeMs <= 0) {
        break;
      }
      const refreshed = await refresh(remainingTimeMs, observeResult.screenSize, signal);
      requestCount += 1;
      if (!refreshed) {
        continue;
      }

      // A hierarchy request can consume the last millisecond of the
      // search window. Do not select from its result after the
      // deadline: CtrlProxy may have served a stale fallback when its
      // synchronous refresh timed out, and a late candidate must not
      // turn a bounded search into an unbounded tap.
      if (this.timer.now() >= deadline) {
        break;
      }

      const hash = this.hashViewHierarchy(refreshed);
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
      if (element) {
        break;
      }
    }

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
    const lastHash = this.hashViewHierarchy(viewHierarchy);

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
          lastHash: this.hashViewHierarchy(viewHierarchy),
          containerFoundEver: current.containerFound,
        }));
      }
    }
    const target = {
      element,
      capture: selectedCapture,
      observationDisplay: observeResult.viewHierarchy,
      observationScreenSize: observeResult.screenSize,
      scoped: isStrictlyScoped(options),
      talkBackState,
    };
    const tapPoint = this.resolveTapPoint(target);
    // The element resolved in the scoped tree; the touch lands on whatever is on top (#9305).
    assertAppGestureNotUnderOverlay(target.capture.hierarchy, options.layer, tapPoint, "tap");
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
    const tapContext = { displayFence: fence, onActivationWarnings };

    logger.info(
      `[TapAnyElement] Tapping (${tapPoint.x}, ${tapPoint.y}) on clickable element: ` +
        `text=${JSON.stringify(element.text)}, ` +
        `bounds=${JSON.stringify(element.bounds)}`,
    );

    switch (this.device.platform) {
      case "android": {
        const preTapHash = this.hashViewHierarchy(selectedCapture.hierarchy);
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
          this.assertSelectedCapture(selectedCapture);
          await dispatch(tapPoint);
        } else {
          await this.executeAndroidTap(
            action,
            tapPoint.x,
            tapPoint.y,
            longPressDuration,
            target,
            signal,
            tapContext,
          );
        }
        await this.retryAndroidTapIfNoChange(
          preTapHash,
          target,
          action,
          longPressDuration,
          observeResult.screenSize,
          signal,
          { ...tapContext, selectionOptions: options, refresh, dispatch },
        );
        break;
      }
      case "ios":
        targetDisplay?.assertCurrent();
        this.assertSelectedCapture(selectedCapture);
        await this.executeIosTap(
          action,
          tapPoint.x,
          tapPoint.y,
          longPressDuration,
          element,
          signal,
          {
            displayFence: fence,
            scoped: target.scoped,
            voiceOverEnabled: target.talkBackState ?? undefined,
          },
        );
        break;
      default:
        throw unsupportedPlatformError(this.device.platform, "tap any element");
    }
  }

  async execute(
    options: TapAnyElementOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    request?: { requestDeadlineMs?: number },
  ): Promise<TapAnyElementResult> {
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
      const result = await this.observedInteraction(
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
          changeExpected: false,
          display: targetDisplay?.observation.display.key,
          previousObservation: targetDisplay?.observation,
          resolvesTargetFromRead: true,
          timeoutMs: 800,
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
