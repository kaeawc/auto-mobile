import { resolveTapAnyOrdinaryTapCtrlProxyTimeoutMs } from "./tapAnyCtrlProxyTimeout";
import { LONG_PRESS_HARD_MAX_MS } from "./tapAtGesture";
import {
  LONG_PRESS_TIMEOUT_HEADROOM_MS,
  ORDINARY_TAP_DURATION_MS,
} from "./gestureTransportTimeout";
import {
  FINAL_OBSERVATION_RETRY_BACKOFF_MS,
  FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS,
} from "./BaseVisualChange";
import { IOS_HIERARCHY_REQUEST_TIMEOUT_MS } from "../observe/ios/CtrlProxyHierarchy";
import { IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS } from "../observe/ios/CtrlProxyVoiceOver";

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
