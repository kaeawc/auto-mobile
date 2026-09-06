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
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import { DefaultElementSelector } from "../utility/DefaultElementSelector";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { throwIfAborted } from "../../utils/toolUtils";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import { MAX_SETTIMEOUT_DELAY_MS, type Timer } from "../../utils/SystemTimer";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import { DefaultElementFinder } from "../utility/ElementFinder";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { serverConfig } from "../../utils/ServerConfig";
import { attachRawViewHierarchy } from "../../utils/viewHierarchySearch";
import { refreshAndroidViewHierarchy } from "./refreshAndroidViewHierarchy";
import { NodeCryptoService } from "../../utils/crypto";
import type { IosVoiceOverDetector } from "../../utils/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../../utils/IosVoiceOverDetector";
import { FeatureFlagService } from "../featureFlags/FeatureFlagService";
import { IOS_HIERARCHY_REQUEST_TIMEOUT_MS } from "../observe/ios/CtrlProxyHierarchy";
import { IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS } from "../observe/ios/CtrlProxyVoiceOver";

interface TapAnyElementDependencies {
  timer?: Timer;
  elementSelector?: ElementSelector;
  iosVoiceOverDetector?: IosVoiceOverDetector;
  featureFlags?: FeatureFlagService;
}

/**
 * Headroom added to a long-press duration when sizing the CtrlProxy request
 * timeout: CtrlProxy blocks its reply until the on-device press completes, so
 * a timeout shorter than (or barely covering) the press duration times out
 * before the gesture even finishes. Matches Shake's `duration + 2000` pattern.
 * Exported so the daemon's outer MCP timeout budgeting
 * (`TAP_ANY_LONG_PRESS_MCP_TIMEOUT_HEADROOM_MS` in
 * `src/daemon/mcpRequestTimeout.ts`) shares this single value instead of
 * duplicating the literal and drifting out of sync (issue #6248 review, P2).
 */
export const LONG_PRESS_TIMEOUT_HEADROOM_MS = 2000;

/**
 * Build the INNER CtrlProxy request timeout for a long-press gesture,
 * clamped to `MAX_SETTIMEOUT_DELAY_MS`. `setTimeout` (Node/Bun) silently
 * normalizes any delay >= 2^31 to 1ms rather than honoring it, so an
 * unclamped `pressDuration + LONG_PRESS_TIMEOUT_HEADROOM_MS` computed from a
 * caller-supplied `duration` near/over that ceiling (e.g.
 * `tapAny({action:"longPress", duration:2147481648})`) would time the
 * CtrlProxy request out almost immediately instead of covering the intended
 * press (issue #6248 review, P2). The daemon's OUTER MCP deadline
 * (`resolveTapAnyLongPressBudgetMs` in `src/daemon/mcpRequestTimeout.ts`)
 * applies the same ceiling to the outer request -- both must be clamped.
 */
function resolveLongPressCtrlProxyTimeoutMs(pressDurationMs: number): number {
  return Math.min(pressDurationMs + LONG_PRESS_TIMEOUT_HEADROOM_MS, MAX_SETTIMEOUT_DELAY_MS);
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
 * Extra headroom on top of the derived worst-case arithmetic above, so a
 * further phase added later (or a small amount of scheduling jitter) can't
 * blow the budget and force yet another review round (issue #6248 review,
 * P2).
 */
const TAP_ANY_LONG_PRESS_OVERHEAD_HEADROOM_MS = 10_000;

/**
 * Consolidated overhead for every non-press phase of a tapAny longPress: the
 * pre-gesture VoiceOver-detection probe, the post-gesture final observation's
 * realistic worst case (initial + retries + backoff, including the
 * accessibility-state-detection step each attempt also runs), plus a fixed
 * CtrlProxy request headroom and extra generosity headroom. Exported so the
 * daemon's outer MCP timeout budgeting (`resolveTapAnyLongPressBudgetMs` in
 * `src/daemon/mcpRequestTimeout.ts`) shares this single value instead of
 * duplicating the arithmetic (issue #6248 review, P2). Covers:
 *   - VoiceOver-detection probe (`TAP_ANY_LONG_PRESS_VOICEOVER_PROBE_TIMEOUT_MS`)
 *   - Final post-gesture observation retry loop's worst case, hierarchy +
 *     a11y-detection per attempt (`TAP_ANY_LONG_PRESS_FINAL_OBSERVE_WORST_CASE_MS`)
 *   - Existing fixed CtrlProxy request headroom (`LONG_PRESS_TIMEOUT_HEADROOM_MS`)
 *   - Extra generosity headroom for future phases
 *     (`TAP_ANY_LONG_PRESS_OVERHEAD_HEADROOM_MS`)
 *
 * Deliberately does NOT fold in the pre-gesture search window -- that varies
 * per-call (`searchUntil.duration` or its default) and stays budgeted
 * explicitly in `resolveTapAnyLongPressBudgetMs` alongside this constant.
 */
export const TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS =
  TAP_ANY_LONG_PRESS_VOICEOVER_PROBE_TIMEOUT_MS +
  TAP_ANY_LONG_PRESS_FINAL_OBSERVE_WORST_CASE_MS +
  LONG_PRESS_TIMEOUT_HEADROOM_MS +
  TAP_ANY_LONG_PRESS_OVERHEAD_HEADROOM_MS;

/**
 * Maximum `duration` (ms) a `tapAny` longPress may request. `setTimeout`
 * (Node/Bun) silently normalizes any delay >= `MAX_SETTIMEOUT_DELAY_MS`
 * (2^31 - 1) to 1ms rather than honoring it, so a large-enough `duration`
 * would otherwise push the derived request deadline (press + pre-gesture
 * search window + non-press overhead, computed by both the inner CtrlProxy
 * timeout here and the outer daemon deadline in `mcpRequestTimeout.ts`) past
 * that ceiling -- timing the request out almost immediately instead of
 * running for anywhere near the intended duration (issue #6248 review, P2,
 * fuZRt). Rather than merely clamping the derived timers (which leaves
 * CtrlProxy asked to run the gesture itself for far longer than the request
 * will wait -- a clamp-vs-duration mismatch), `getLongPressDuration` REJECTS
 * any duration above this bound outright, closing the whole absurd-duration
 * edge class at the source.
 *
 * maxDuration = MAX_SETTIMEOUT_DELAY_MS - (nonPressOverhead + maxSearchWindow)
 *   MAX_SETTIMEOUT_DELAY_MS       = 2147483647ms
 *   nonPressOverhead              = TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS
 *   maxSearchWindow               = TAP_ANY_SEARCH_UNTIL_MAX_MS = 12000ms
 *
 * A duration at or below this bound can never overflow `setTimeout` on either
 * timer once combined with the largest possible `searchUntil.duration` and
 * the full non-press overhead.
 */
export const TAP_ANY_LONG_PRESS_MAX_DURATION_MS =
  MAX_SETTIMEOUT_DELAY_MS -
  (TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS + TAP_ANY_SEARCH_UNTIL_MAX_MS);

export class TapAnyElement extends BaseVisualChange {
  private geometry: ElementGeometry;
  private elementSelector: ElementSelector;
  private finder: ElementFinder;
  private accessibilityService: AndroidCtrlProxyClient;
  private viewHierarchy: ViewHierarchy;
  private iosVoiceOverDetector: IosVoiceOverDetector;
  private featureFlags: FeatureFlagService;

  private static readonly SEARCH_UNTIL_DEFAULT_MS = TAP_ANY_SEARCH_UNTIL_DEFAULT_MS;
  private static readonly SEARCH_UNTIL_MIN_MS = 100;
  private static readonly SEARCH_UNTIL_MAX_MS = TAP_ANY_SEARCH_UNTIL_MAX_MS;
  private static readonly SEARCH_POLL_INTERVAL_MS = 100;

  constructor(
    device: BootedDevice,
    adb: AdbClient | null = null,
    options: TapAnyElementDependencies = {},
  ) {
    super(device, adb, options.timer);
    this.geometry = new DefaultElementGeometry();
    this.elementSelector = options.elementSelector ?? new DefaultElementSelector();
    this.finder = new DefaultElementFinder();
    this.accessibilityService = AndroidCtrlProxyClient.getInstance(device, this.adbFactory);
    this.viewHierarchy = new ViewHierarchy(device, this.adbFactory);
    this.iosVoiceOverDetector = options.iosVoiceOverDetector ?? defaultIosVoiceOverDetector;
    this.featureFlags = options.featureFlags ?? FeatureFlagService.getInstance();
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
    container?: { elementId?: string; text?: string },
  ): boolean {
    if (!container) {
      return true;
    }
    return this.finder.hasContainerElement(viewHierarchy, container);
  }

  private isElementCenterOffScreen(
    element: Element,
    screenSize?: ObserveResult["screenSize"],
  ): boolean {
    if (!screenSize?.width || !screenSize?.height || !element.bounds) {
      return false;
    }
    const centerX = (element.bounds.left + element.bounds.right) / 2;
    const centerY = (element.bounds.top + element.bounds.bottom) / 2;
    return centerX < 0 || centerX > screenSize.width || centerY < 0 || centerY > screenSize.height;
  }

  private findClickableElement(
    options: TapAnyElementOptions,
    viewHierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ): { element: Element | null; containerFound: boolean } {
    const containerFound = this.isContainerAvailable(viewHierarchy, options.container);
    const selection = this.elementSelector.selectClickable(viewHierarchy, {
      container: options.container,
      strategy: options.selectionStrategy,
      scrollableContainer: options.scrollableContainer,
    });
    if (selection.element && this.isElementCenterOffScreen(selection.element, screenSize)) {
      return { element: null, containerFound };
    }
    return { element: selection.element, containerFound };
  }

  private hashViewHierarchy(viewHierarchy: ViewHierarchyResult | null): string | null {
    if (!viewHierarchy) {
      return null;
    }
    try {
      return NodeCryptoService.generateCacheKey(JSON.stringify(viewHierarchy.hierarchy));
    } catch (error) {
      // Hashing is only used to key an optional cache lookup; if JSON.stringify or the
      // hash fails on a malformed hierarchy, skip the cache instead of failing the tap.
      logger.debug(`src/features/action/TapAnyElement.ts fallback failed: ${error}`, error);
      return null;
    }
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
    if (this.device.platform === "ios" && screenSize?.width && screenSize?.height) {
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
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
  ): Promise<ViewHierarchyResult | null> {
    const effectiveTimeoutMs = Math.max(0, timeoutMs);
    switch (this.device.platform) {
      case "android": {
        const rawHierarchy = await refreshAndroidViewHierarchy(
          this.accessibilityService,
          this.viewHierarchy,
          effectiveTimeoutMs,
          signal,
        );
        return rawHierarchy ? this.prepareViewHierarchyForResponse(rawHierarchy, screenSize) : null;
      }
      case "ios": {
        const xcTestClient = IOSCtrlProxyClient.getInstance(this.device);
        const rawHierarchy = await xcTestClient.getAccessibilityHierarchy();
        return rawHierarchy ? this.prepareViewHierarchyForResponse(rawHierarchy, screenSize) : null;
      }
      default:
        throw new ActionableError(`Unsupported platform: ${this.device.platform}`);
    }
  }

  private getLongPressDuration(options: TapAnyElementOptions): number {
    if (options.action !== "longPress") {
      return 0;
    }
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
      const normalized = Math.max(1, Math.round(options.duration));
      // REJECT (rather than clamp) a duration whose derived request deadline
      // would exceed `MAX_SETTIMEOUT_DELAY_MS` -- clamping only the timers
      // while forwarding the full absurd duration to XCTest asks the
      // on-device press to run far longer than the request will wait, a
      // clamp-vs-duration mismatch (issue #6248 review, P2, fuZRt). See
      // `TAP_ANY_LONG_PRESS_MAX_DURATION_MS`'s doc for the bound's
      // derivation.
      if (normalized > TAP_ANY_LONG_PRESS_MAX_DURATION_MS) {
        throw new ActionableError(
          `longPress duration too large; maximum is ${TAP_ANY_LONG_PRESS_MAX_DURATION_MS} ms`,
        );
      }
      return normalized;
    }
    return this.device.platform === "ios"
      ? TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_IOS
      : TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_ANDROID;
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
  private async executeIosTap(
    action: string,
    x: number,
    y: number,
    longPressDuration: number,
    element?: Element,
  ): Promise<void> {
    const xcTestClient = IOSCtrlProxyClient.getInstance(this.device);
    const isVoiceOverEnabled = await this.iosVoiceOverDetector.isVoiceOverEnabled(
      this.device.deviceId,
      xcTestClient,
      this.featureFlags,
    );

    if (isVoiceOverEnabled && element) {
      await this.executeIosTapWithVoiceOver(xcTestClient, action, element, x, y, longPressDuration);
      return;
    }

    await this.executeIosTapWithCoordinates(xcTestClient, action, x, y, longPressDuration);
  }

  /**
   * Execute iOS tap using coordinate-based input (standard mode).
   *
   * CtrlProxy blocks its reply until the on-device press actually completes, so a
   * long press must size the request timeout from the press duration —
   * `requestTapCoordinates`'s default 5s timeout would otherwise fire (and report
   * failure) before a longer on-device press finishes.
   */
  private async executeIosTapWithCoordinates(
    xcTestClient: IOSCtrlProxyClient,
    action: string,
    x: number,
    y: number,
    longPressDuration: number,
  ): Promise<void> {
    // Short duration (50ms) for tap/doubleTap, full duration for longPress.
    const tapDuration = action === "longPress" ? longPressDuration : 50;
    const timeoutMs =
      action === "longPress" ? resolveLongPressCtrlProxyTimeoutMs(tapDuration) : undefined;

    if (action === "doubleTap") {
      const firstResult = await xcTestClient.requestTapCoordinates(x, y, tapDuration, timeoutMs);
      if (!firstResult.success) {
        throw new ActionableError(`CtrlProxy iOS tap failed: ${firstResult.error}`);
      }
      await this.timer.sleep(200);
      const secondResult = await xcTestClient.requestTapCoordinates(x, y, tapDuration, timeoutMs);
      if (!secondResult.success) {
        throw new ActionableError(`CtrlProxy iOS second tap failed: ${secondResult.error}`);
      }
      return;
    }

    const result = await xcTestClient.requestTapCoordinates(x, y, tapDuration, timeoutMs);
    if (!result.success) {
      throw new ActionableError(`CtrlProxy iOS tap failed: ${result.error}`);
    }
  }

  /**
   * Execute iOS tap using VoiceOver accessibility actions.
   *
   * Prefers activating by `resource-id` (`requestAction`, mirroring how
   * `TapOnElement`/`TalkBackTapStrategy` activate Android elements by resourceId) —
   * on-device this resolves the element via `elementLocator.findElement(byResourceId:)`
   * and calls `found.tap()`/`found.press()` on the *specific* node the selector
   * matched. Only when no usable resource-id exists does this fall back to
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
  ): Promise<void> {
    const result = await xcTestClient.requestAction(
      voiceOverAction,
      resourceId,
      undefined,
      timeoutMs,
    );
    if (!result.success) {
      throw new ActionableError(
        `VoiceOver action failed for resource-id "${resourceId}": ${result.error ?? "unknown error"}`,
      );
    }
  }

  private async executeIosTapWithVoiceOver(
    xcTestClient: IOSCtrlProxyClient,
    action: string,
    element: Element,
    x: number,
    y: number,
    longPressDuration: number,
  ): Promise<void> {
    const label = this.resolveIosVoiceOverLabel(element);
    const resourceId = this.resolveIosResourceId(element);

    if (!label && !resourceId) {
      throw new ActionableError(
        "VoiceOver is enabled but the selected element has no accessibility label, " +
          "content-desc, text, or resource-id to activate; a coordinate press would " +
          "only focus it under VoiceOver, not activate it",
      );
    }

    const voiceOverAction: "activate" | "long_press" =
      action === "longPress" ? "long_press" : "activate";
    const timeoutMs =
      action === "longPress" ? resolveLongPressCtrlProxyTimeoutMs(longPressDuration) : undefined;

    if (resourceId) {
      await this.activateIosByResourceId(xcTestClient, resourceId, voiceOverAction, timeoutMs);
      return;
    }

    const result = await xcTestClient.requestVoiceOverActivate(
      label as string,
      voiceOverAction,
      timeoutMs,
    );

    if (!result.success) {
      throw new ActionableError(
        `VoiceOver action failed for label "${label}": ${result.error ?? "unknown error"}`,
      );
    }
  }

  async execute(
    options: TapAnyElementOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<TapOnElementResult> {
    if (!options.action) {
      return this.createErrorResult(options.action, "tap action is required");
    }

    const validationError = this.validateOptions(options);
    if (validationError) {
      return this.createErrorResult(options.action, validationError);
    }

    const perf = createGlobalPerformanceTracker();
    perf.serial("tapAnyElement");

    try {
      throwIfAborted(signal);

      const result = await this.observedInteraction(
        async (observeResult: ObserveResult) => {
          throwIfAborted(signal);

          const viewHierarchy = observeResult.viewHierarchy;
          if (!viewHierarchy) {
            perf.end();
            return { success: false, error: "Unable to get view hierarchy, cannot tap on element" };
          }

          const searchDurationMs = this.getSearchUntilDuration(options);
          const startTime = this.timer.now();
          let requestCount = 0;
          let changeCount = 0;
          let lastHash = this.hashViewHierarchy(viewHierarchy);

          let found = this.findClickableElement(options, viewHierarchy, observeResult.screenSize);
          let element = found.element;
          let containerFoundEver = found.containerFound;

          if (!element) {
            const deadline = startTime + searchDurationMs;
            while (this.timer.now() < deadline) {
              throwIfAborted(signal);
              await this.timer.sleep(TapAnyElement.SEARCH_POLL_INTERVAL_MS);
              const remainingTimeMs = Math.max(0, deadline - this.timer.now());
              if (remainingTimeMs <= 0) {
                break;
              }
              const refreshed = await this.refreshViewHierarchy(
                remainingTimeMs,
                observeResult.screenSize,
                signal,
              );
              requestCount += 1;
              if (!refreshed) {
                continue;
              }

              const hash = this.hashViewHierarchy(refreshed);
              if (hash && hash !== lastHash) {
                changeCount += 1;
                lastHash = hash;
              }

              found = this.findClickableElement(options, refreshed, observeResult.screenSize);
              element = found.element;
              containerFoundEver = containerFoundEver || found.containerFound;
              if (element) {
                break;
              }
            }
          }

          if (!element) {
            if (options.container && !containerFoundEver) {
              const containerLabel = options.container.elementId
                ? `elementId '${options.container.elementId}'`
                : `text '${options.container.text}'`;
              throw new ActionableError(
                `Container element not found with provided ${containerLabel}`,
              );
            }
            const containerHint = options.container
              ? ` within container ${options.container.elementId ? `elementId '${options.container.elementId}'` : `text '${options.container.text}'`}`
              : "";
            throw new ActionableError(`No clickable element found${containerHint}`);
          }

          const tapPoint = this.geometry.getElementCenter(element);
          const action = options.action;
          const longPressDuration = this.getLongPressDuration(options);

          logger.info(
            `[TapAnyElement] Tapping (${tapPoint.x}, ${tapPoint.y}) on clickable element: ` +
              `text=${JSON.stringify(element.text)}, ` +
              `bounds=${JSON.stringify(element.bounds)}`,
          );

          switch (this.device.platform) {
            case "android":
              if (action === "longPress") {
                await this.adb.executeCommand(
                  `shell input swipe ${tapPoint.x} ${tapPoint.y} ${tapPoint.x} ${tapPoint.y} ${longPressDuration}`,
                );
              } else if (action === "doubleTap") {
                await this.adb.executeCommand(`shell input tap ${tapPoint.x} ${tapPoint.y}`);
                await this.timer.sleep(50);
                await this.adb.executeCommand(`shell input tap ${tapPoint.x} ${tapPoint.y}`);
              } else {
                await this.adb.executeCommand(`shell input tap ${tapPoint.x} ${tapPoint.y}`);
              }
              break;
            case "ios":
              await this.executeIosTap(action, tapPoint.x, tapPoint.y, longPressDuration, element);
              break;
            default:
              throw new ActionableError(`Unsupported platform: ${this.device.platform}`);
          }

          perf.end();
          return {
            success: true,
            action,
            element,
            searchUntil: {
              durationMs: Math.max(0, Math.round(this.timer.now() - startTime)),
              requestCount,
              changeCount,
            },
          };
        },
        {
          changeExpected: false,
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

      return result;
    } catch (error) {
      perf.end();
      const errorMsg = errorMessage(error);
      return {
        success: false,
        action: options.action,
        error: `Failed to tap clickable element: ${errorMsg}`,
        element: {
          bounds: { left: 0, top: 0, right: 0, bottom: 0 },
        } as Element,
      };
    }
  }
}
