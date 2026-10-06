import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  BootedDevice,
  Element,
  ElementBounds,
  KeyboardResult,
  ViewHierarchyResult,
} from "../../models";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import { DefaultElementParser } from "../utility/ElementParser";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import { DefaultElementFinder } from "../utility/ElementFinder";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { IOSCtrlProxyClient } from "../observe/ios";
import type { CtrlProxyKeyboardResult } from "../observe/ios/types";
import { AndroidCtrlProxyClient } from "../observe/android";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { DefaultObserveElementCollector } from "../observe/ObserveElementCollector";
import { getImeOccluder, getVisibleIosImeBounds } from "../observe/output/SkeletonProjection";
import type { A11yActionResult, AccessibilityNodeSelector } from "../observe/android/types";
import type { InsertTextState } from "../observe/android/ctrlProxyProtocol";
import { errorMessage } from "../../utils/describeUnknownError";
import { ActionableError } from "../../models/ActionableError";
import { stableNodeSelectorForElement } from "../talkback/TalkBackTapStrategy";
import { keyboardNodeClickTargetError } from "./keyboardNodeClickTarget";

type KeyboardAction = "open" | "close" | "detect";

/**
 * Per-read controls for a keyboard hierarchy sample.
 *
 * `timeoutMs` bounds the read itself: without it a single read can block on the
 * 10s `requestHierarchySync` default and blow the confirmation budget entirely.
 * `forceFresh` drops the cached hierarchy first, so a 100ms confirmation poll
 * cannot keep resampling the same ~1s-fresh cache entry and miss the IME change.
 */
export interface KeyboardHierarchyReadOptions {
  timeoutMs?: number;
  forceFresh?: boolean;
}

export interface KeyboardHierarchyProvider {
  getViewHierarchy(
    signal?: AbortSignal,
    options?: KeyboardHierarchyReadOptions,
  ): Promise<ViewHierarchyResult | null>;
}

/** Minimal seam for dropping the cached hierarchy before a forced-fresh read. */
export interface KeyboardHierarchyCache {
  invalidateCache(): void;
}

export function selectKeyboardHierarchyCache(
  platform: BootedDevice["platform"],
  iosCache: () => KeyboardHierarchyCache,
  androidCache: () => KeyboardHierarchyCache,
): KeyboardHierarchyCache {
  return platform === "ios" ? iosCache() : androidCache();
}

export class DefaultKeyboardHierarchyProvider implements KeyboardHierarchyProvider {
  private viewHierarchy: Pick<ViewHierarchy, "getViewHierarchy">;
  private cache: KeyboardHierarchyCache;

  constructor(
    viewHierarchy: Pick<ViewHierarchy, "getViewHierarchy">,
    cache: KeyboardHierarchyCache,
  ) {
    this.viewHierarchy = viewHierarchy;
    this.cache = cache;
  }

  async getViewHierarchy(
    signal?: AbortSignal,
    options?: KeyboardHierarchyReadOptions,
  ): Promise<ViewHierarchyResult | null> {
    if (options?.forceFresh) {
      this.cache.invalidateCache();
    }
    return this.viewHierarchy.getViewHierarchy(
      undefined,
      new NoOpPerformanceTracker(),
      false,
      0,
      signal,
      options?.timeoutMs,
    );
  }
}

type KeyboardDetection = {
  open: boolean;
  bounds?: ElementBounds[];
  error?: string;
  /** How `open` was decided: a real IME window vs. the content-desc fallback. */
  source?: "window" | "heuristic";
  /** True when the accessibility service reported window metadata for this sample. */
  windowInfoAvailable?: boolean;
  /** True when an IME window (type 2) is present, even without usable bounds. */
  imeWindowPresent?: boolean;
  /**
   * True when the IME window bounds reach past the screen edge, which the show animation does
   * while it slides in. Only set when the hierarchy reported the screen size.
   */
  boundsOffScreen?: boolean;
};

/**
 * The slice of the CtrlProxy client `open` needs to show the IME without a touch: a node
 * `click` by selector, or on the input-focused node when the field has no selector (the
 * framework shows the keyboard without a touch position, so the caret should stay put), plus
 * the caret read and `set_selection` restore that back the claim up.
 */
export interface KeyboardOpenClient {
  supportsNodeActionSelectors(perf?: undefined, signal?: AbortSignal): Promise<boolean>;
  requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    timeoutMs?: number,
    perf?: undefined,
    signal?: AbortSignal,
  ): Promise<A11yActionResult>;
  /** `click` or `set_selection` on the input-focused editable node; needs no selector. */
  requestFocusedInputAction(
    action: "click" | "set_selection",
    selection?: { start: number; end: number },
    timeoutMs?: number,
    perf?: undefined,
    signal?: AbortSignal,
  ): Promise<A11yActionResult>;
  requestInsertTextState(): Promise<{ success: boolean; state?: InsertTextState }>;
}

/**
 * `unavailable`: nothing was sent, so the next route is safe. `refused`: the runner acknowledged
 * and rejected the click. `sent`: the runner accepted it. `unconfirmed`: dispatched but never
 * acknowledged, so a second activation would be unsafe.
 */
type NodeClickOutcome =
  | { kind: "unavailable" }
  | { kind: "refused" }
  | { kind: "sent" }
  | { kind: "unconfirmed"; error?: string };

/** How the keyboard was shown, for the caret note. */
type ShowRoute = "click" | "tap";

const KEYBOARD_BOUNDS_NOT_SETTLED =
  " (the keyboard's bounds were still past the screen edge while it animated in, so none are reported; run keyboard detect for them)";

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function sameSelection(a: InsertTextState, b: InsertTextState): boolean {
  return a.selectionStart === b.selectionStart && a.selectionEnd === b.selectionEnd;
}

function selectionRange(state: InsertTextState): string {
  return `${state.selectionStart}-${state.selectionEnd}`;
}

function keyboardOpenIndeterminateMessage(dispatched: string, reason?: string): string {
  return `Keyboard open outcome is indeterminate: the ${dispatched} was dispatched but no result was confirmed (${reason ?? "request cancelled"}). The keyboard may have opened. Do not retry automatically; observe before retrying.`;
}

/** A cancelled open whose click/tap was already sent: the device may have applied it. */
export class KeyboardOpenIndeterminateError extends ActionableError {
  constructor(dispatched: string, reason?: string) {
    super(keyboardOpenIndeterminateMessage(dispatched, reason));
    this.name = "KeyboardOpenIndeterminateError";
  }
}

export class Keyboard {
  private static readonly INPUT_METHOD_WINDOW_TYPE = 2;
  // The IME show/hide animation runs ~200-400ms on typical devices, so a single
  // fixed post-action sleep always sampled the stale state (#4238). Poll instead:
  // return as soon as the observed state matches, bounded by the timeout below.
  private static readonly STATE_CONFIRMATION_TIMEOUT_MS = 2_000;
  private static readonly IOS_KEYBOARD_VISIBILITY_TIMEOUT_MS = 2_000;
  private static readonly STATE_CONFIRMATION_POLL_INTERVAL_MS = 100;
  private device: BootedDevice;
  private adb: AdbExecutor;
  private hierarchyProvider: KeyboardHierarchyProvider;
  private parser: ElementParser;
  private geometry: ElementGeometry;
  private finder: ElementFinder;
  private timer: Timer;
  private adbFactory: AdbClientFactory;
  private openClient: KeyboardOpenClient | undefined;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    hierarchyProvider?: KeyboardHierarchyProvider,
    timer: Timer = defaultTimer,
    parser: ElementParser = new DefaultElementParser(),
    geometry: ElementGeometry = new DefaultElementGeometry(),
    finder: ElementFinder = new DefaultElementFinder(),
    openClient?: KeyboardOpenClient,
  ) {
    this.device = device;
    this.adbFactory = adbFactory;
    this.openClient = openClient;
    this.adb = adbFactory.create(device);
    this.parser = parser;
    this.geometry = geometry;
    this.finder = finder;
    this.timer = timer;

    if (hierarchyProvider) {
      this.hierarchyProvider = hierarchyProvider;
    } else {
      this.hierarchyProvider = new DefaultKeyboardHierarchyProvider(
        new ViewHierarchy(device, adbFactory),
        selectKeyboardHierarchyCache(
          device.platform,
          () => IOSCtrlProxyClient.getInstance(device),
          () => AndroidCtrlProxyClient.getInstance(device, adbFactory),
        ),
      );
    }
  }

  async execute(action: KeyboardAction, signal?: AbortSignal): Promise<KeyboardResult> {
    throwIfAborted(signal);
    if (this.device.platform === "ios") {
      return this.executeIOS(action, signal);
    }

    switch (action) {
      case "detect": {
        return this.detect(signal);
      }
      case "open": {
        return this.open(signal);
      }
      case "close": {
        return this.close(signal);
      }
      default:
        return {
          success: false,
          open: false,
          message: `Unsupported keyboard action: ${action}`,
          error: `Unsupported keyboard action: ${action}`,
        };
    }
  }

  private async executeIOS(action: KeyboardAction, signal?: AbortSignal): Promise<KeyboardResult> {
    const client = IOSCtrlProxyClient.getInstance(this.device);
    throwIfAborted(signal);
    const result = await awaitWhileRequestIsLive(
      client.requestKeyboard(action, undefined, undefined, signal),
      signal,
    );
    throwIfAborted(signal);
    if (!result.success) {
      return this.iosFailure(action, result, client, signal);
    }

    if (
      action !== "close" &&
      result.open === true &&
      (await this.isIOSKeyboardOnScreen(signal)) === false
    ) {
      const message =
        action === "detect"
          ? "Keyboard is closed (no visible on-screen software keyboard)"
          : "Keyboard did not open: no visible on-screen software keyboard. It may be minimized off screen because the simulator uses a hardware keyboard and cannot be shown on request.";
      return {
        success: action === "detect",
        open: false,
        message,
        ...(action === "open" ? { error: message } : {}),
      };
    }

    return this.iosKeyboardResult(action, result);
  }

  private iosKeyboardResult(
    action: KeyboardAction,
    result: CtrlProxyKeyboardResult,
  ): KeyboardResult {
    const success =
      action === "detect" ||
      (action === "open" && result.open) ||
      (action === "close" && !result.open);
    const message = this.keyboardMessage(action, result.open, result.method);
    return {
      success,
      open: result.open,
      message,
      ...(action === "close" && result.method ? { method: result.method } : {}),
      ...(success ? {} : { error: message }),
    };
  }

  private async isIOSKeyboardOnScreen(signal?: AbortSignal): Promise<boolean | undefined> {
    try {
      const timeoutMs = Keyboard.IOS_KEYBOARD_VISIBILITY_TIMEOUT_MS;
      const hierarchy = await raceWithDeadline(
        () => this.hierarchyProvider.getViewHierarchy(signal, { timeoutMs, forceFresh: true }),
        { timer: this.timer, timeoutMs, signal, label: "iOS keyboard visibility hierarchy" },
      );
      throwIfAborted(signal);
      if (hierarchy?.fresh === false) {
        logger.warn("iOS keyboard visibility hierarchy is stale; using runner state");
        return undefined;
      }
      const width = hierarchy?.screenWidth;
      const height = hierarchy?.screenHeight;
      if (
        !hierarchy ||
        hierarchy.hierarchy?.error ||
        ![width, height].every(
          (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
        )
      ) {
        return undefined;
      }
      const elements = new DefaultObserveElementCollector(this.parser).collect(hierarchy, "ios");
      const ime = elements && getImeOccluder(elements);
      return !!ime && getVisibleIosImeBounds(ime, { width: width!, height: height! }) !== undefined;
    } catch (error) {
      throwIfAborted(signal);
      logger.warn("iOS keyboard visibility hierarchy read failed; using runner state", error);
      return undefined;
    }
  }

  private async iosFailure(
    action: KeyboardAction,
    result: CtrlProxyKeyboardResult,
    client: IOSCtrlProxyClient,
    signal?: AbortSignal,
  ): Promise<KeyboardResult> {
    if (
      action === "close" &&
      /^Keyboard timed out after \d+ms$/.test(result.error ?? "") &&
      (await this.confirmIOSCloseAfterTimeout(client, signal))
    ) {
      return {
        success: true,
        open: false,
        message:
          "Keyboard closed after the close request timed out; dismissal method unknown (Return may have submitted the field)",
      };
    }
    const message = result.error ?? `Failed to ${action} iOS keyboard`;
    return {
      success: false,
      open: result.open,
      message,
      error: message,
    };
  }

  private async confirmIOSCloseAfterTimeout(
    client: IOSCtrlProxyClient,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      throwIfAborted(signal);
      const detected = await awaitWhileRequestIsLive(
        raceWithDeadline(client.requestKeyboard("detect", 2000, undefined, signal), {
          timer: this.timer,
          timeoutMs: 2000,
          label: "Keyboard close follow-up detect",
        }),
        signal,
      );
      return detected.success && !detected.open;
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`Keyboard close timeout follow-up detect failed: ${String(error)}`, error);
      return false;
    }
  }

  private keyboardMessage(
    action: KeyboardAction,
    open: boolean,
    method?: "escape" | "dismissKey" | "returnKey",
  ): string {
    if (action === "detect") {
      return open ? "Keyboard is open" : "Keyboard is closed";
    }
    if (action === "open") {
      return open ? "Keyboard opened" : "Keyboard did not open";
    }
    if (!open && method === "returnKey") {
      return "Keyboard closed with Return; the field may have submitted or committed autocorrect";
    }
    return open ? "Keyboard did not close" : "Keyboard closed";
  }

  private async detect(signal?: AbortSignal): Promise<KeyboardResult> {
    const { state } = await this.getHierarchyWithState(signal);
    if (state.error) {
      return {
        success: false,
        open: state.open,
        bounds: state.bounds,
        message: state.error,
        error: state.error,
      };
    }

    return {
      success: true,
      open: state.open,
      bounds: state.bounds,
      message: state.open ? "Keyboard is open" : "Keyboard is closed",
    };
  }

  private async open(signal?: AbortSignal): Promise<KeyboardResult> {
    const { hierarchy, state } = await this.getHierarchyWithState(signal);
    if (state.error) {
      return {
        success: false,
        open: state.open,
        bounds: state.bounds,
        message: state.error,
        error: state.error,
      };
    }

    if (state.open) {
      return {
        success: true,
        open: true,
        bounds: state.bounds,
        message: "Keyboard already open",
      };
    }

    const focusedInput = hierarchy ? this.findFocusedTextInput(hierarchy) : null;
    if (!focusedInput) {
      return {
        success: false,
        open: false,
        message: "No focused text input to open keyboard",
        error: "No focused text input to open keyboard",
      };
    }

    // The caret is recorded first so any route that moves it can be detected and undone.
    const caretBefore = await this.readCaret(signal);

    // Show the IME without a touch first: a coordinate tap lands inside the field
    // and moves the caret into existing text (#9942, #10152).
    const click = await this.showWithoutTouch(focusedInput, hierarchy, signal);
    // Once a click reached the device the field may already be activated (a read-only
    // picker would toggle twice), so a tap is only a fallback when no click was sent.
    if (click.kind === "unconfirmed") {
      const message = keyboardOpenIndeterminateMessage("node click", click.error);
      return { success: false, open: false, message, error: message };
    }
    if (click.kind === "sent") {
      return this.finishOpen(caretBefore, "click", signal);
    }

    const offScreen = this.offScreenTapError(focusedInput, hierarchy);
    if (offScreen) {
      return { success: false, open: false, message: offScreen, error: offScreen };
    }
    await this.tapOnElement(focusedInput, signal);
    return this.finishOpen(caretBefore, "tap", signal);
  }

  /**
   * Confirm the IME is up, then check the caret. Showing the keyboard must not move it; when it
   * did, it is put back and the read-back decides what the result says.
   */
  private async finishOpen(
    caretBefore: InsertTextState | undefined,
    route: ShowRoute,
    signal?: AbortSignal,
  ): Promise<KeyboardResult> {
    const afterState = await this.waitForKeyboardState(true, signal);
    const caretNote = afterState.open ? await this.reconcileCaret(caretBefore, route, signal) : "";
    return this.openResult(afterState, "Keyboard opened", caretNote);
  }

  private openResult(
    afterState: KeyboardDetection,
    openedMessage: string,
    caretNote: string = "",
  ): KeyboardResult {
    const success = afterState.open && !afterState.error;
    // Bounds still past the screen edge after the settle window are mid-animation values, not
    // where the keyboard ends up, so they are withheld rather than reported.
    const boundsNote = success && afterState.boundsOffScreen ? KEYBOARD_BOUNDS_NOT_SETTLED : "";
    const message = success
      ? `${openedMessage}${caretNote}${boundsNote}`
      : (afterState.error ?? "Failed to open keyboard");

    return {
      success,
      open: afterState.open,
      ...(afterState.boundsOffScreen ? {} : { bounds: afterState.bounds }),
      message,
      ...(afterState.error ? { error: afterState.error } : {}),
    };
  }

  /**
   * A tap lands at the field's centre, so a centre outside the display would hit another window
   * or nothing. Fail instead of sending it; scrolling the field into view is the caller's call.
   */
  private offScreenTapError(
    element: Element,
    hierarchy: ViewHierarchyResult | null,
  ): string | undefined {
    const width = hierarchy?.screenWidth;
    const height = hierarchy?.screenHeight;
    if (!isPositiveNumber(width) || !isPositiveNumber(height)) {
      return undefined;
    }
    const center = this.geometry.getElementCenter(element);
    if (center.x >= 0 && center.y >= 0 && center.x < width && center.y < height) {
      return undefined;
    }
    const b = element.bounds;
    return `The focused text input is off screen (bounds [${b.left},${b.top}][${b.right},${b.bottom}] on a ${width}x${height} screen), so no tap was sent and the keyboard was not opened. Scroll the field into view (swipeOn) and call keyboard open again.`;
  }

  private getOpenClient(): KeyboardOpenClient {
    this.openClient ??= AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
    return this.openClient;
  }

  /**
   * Show the IME without a touch position. A field with a stable selector is clicked through
   * it; any field, including a Compose text field that has no selector, can instead be clicked
   * as the input-focused node. `unavailable` means no click was sent and the tap fallback is
   * allowed; `refused` means the runner declined a selector click (the tap is still allowed);
   * `sent` means the runner accepted it; `unconfirmed` means it was dispatched but never
   * acknowledged, so a second activation would be unsafe.
   *
   * Android offers an accessibility service no call that shows the IME on demand
   * (`SoftKeyboardController` only sets the show mode, and `ACTION_FOCUS` does nothing to a
   * field that already has focus), so a click is the least intrusive route on API 29-36.
   */
  private async showWithoutTouch(
    element: Element,
    hierarchy: ViewHierarchyResult | null,
    signal?: AbortSignal,
  ): Promise<NodeClickOutcome> {
    const bySelector = await this.clickBySelector(element, hierarchy, signal);
    return bySelector.kind === "unavailable" ? this.clickFocusedInput(signal) : bySelector;
  }

  private async clickBySelector(
    element: Element,
    hierarchy: ViewHierarchyResult | null,
    signal?: AbortSignal,
  ): Promise<NodeClickOutcome> {
    const selector = stableNodeSelectorForElement(element);
    if (!selector) {
      return { kind: "unavailable" };
    }
    let client: KeyboardOpenClient;
    try {
      client = this.getOpenClient();
      // The runner clicks the first depth-first match of the whole selector, so it must
      // name exactly one node in this hierarchy and that node must be the focused field.
      const targetError = await keyboardNodeClickTargetError(selector, hierarchy, element, () =>
        awaitWhileRequestIsLive(client.supportsNodeActionSelectors(undefined, signal), signal),
      );
      if (targetError) {
        logger.warn(`Keyboard open: node click unavailable (${targetError})`);
        return { kind: "unavailable" };
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`Keyboard open: node click errored: ${errorMessage(error)}`, error);
      return { kind: "unavailable" };
    }
    return this.dispatchNodeClick(
      () => client.requestNodeAction("click", selector, undefined, undefined, signal),
      signal,
    );
  }

  /** Click the input-focused node; the runner finds it, so no selector is needed. */
  private async clickFocusedInput(signal?: AbortSignal): Promise<NodeClickOutcome> {
    let client: KeyboardOpenClient;
    try {
      client = this.getOpenClient();
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`Keyboard open: focused input click errored: ${errorMessage(error)}`, error);
      return { kind: "unavailable" };
    }
    const outcome = await this.dispatchNodeClick(
      () => client.requestFocusedInputAction("click", undefined, undefined, undefined, signal),
      signal,
    );
    // A refused focused-input click changed nothing, exactly like one that was never sent.
    return outcome.kind === "refused" ? { kind: "unavailable" } : outcome;
  }

  private async dispatchNodeClick(
    send: () => Promise<A11yActionResult>,
    signal?: AbortSignal,
  ): Promise<NodeClickOutcome> {
    throwIfAborted(signal);
    let result: A11yActionResult;
    try {
      result = await send();
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`Keyboard open: node click errored: ${errorMessage(error)}`, error);
      return { kind: "unavailable" };
    }
    const unacknowledged = result.dispatched === true && result.acknowledged !== true;
    // The runner reports an aborted-after-send click as dispatched but unacknowledged.
    if (signal?.aborted && unacknowledged) {
      throw new KeyboardOpenIndeterminateError("node click", result.error);
    }
    throwIfAborted(signal);
    if (result.success) {
      return { kind: "sent" };
    }
    logger.warn(`Keyboard open: node click failed (${result.error ?? "unknown error"})`);
    return unacknowledged ? { kind: "unconfirmed", error: result.error } : { kind: "refused" };
  }

  /** Best-effort caret read; undefined when the runner cannot report it. */
  private async readCaret(signal?: AbortSignal): Promise<InsertTextState | undefined> {
    try {
      const result = await awaitWhileRequestIsLive(
        this.getOpenClient().requestInsertTextState(),
        signal,
      );
      throwIfAborted(signal);
      return result.success ? result.state : undefined;
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`Keyboard open: caret read failed: ${errorMessage(error)}`, error);
      return undefined;
    }
  }

  /**
   * Empty when the caret is where it was (or either read is unavailable, so nothing can be
   * said). When it moved, restore it with `set_selection` and report from a read-back, never
   * from the restore's own success: a restored caret is confirmed, anything else says it moved.
   */
  private async reconcileCaret(
    before: InsertTextState | undefined,
    route: ShowRoute,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!before) {
      return "";
    }
    const after = await this.readCaret(signal);
    if (!after || sameSelection(before, after)) {
      return "";
    }
    const moved = `the ${route} used to show it moved the caret from ${selectionRange(before)} to ${selectionRange(after)}`;
    const failure = await this.restoreSelection(before, signal);
    if (failure) {
      return ` (${moved}; restoring it failed: ${failure})`;
    }
    const verified = await this.readCaret(signal);
    if (!verified) {
      return ` (${moved}; restore was sent but the caret could not be read back to confirm it)`;
    }
    return sameSelection(before, verified)
      ? ` (${moved}; restored to ${selectionRange(before)})`
      : ` (${moved}; restoring it did not hold, the caret is at ${selectionRange(verified)})`;
  }

  /** Why the selection could not be restored, or undefined once the runner accepted it. */
  private async restoreSelection(
    before: InsertTextState,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    throwIfAborted(signal);
    try {
      const result = await awaitWhileRequestIsLive(
        this.getOpenClient().requestFocusedInputAction(
          "set_selection",
          { start: before.selectionStart, end: before.selectionEnd },
          undefined,
          undefined,
          signal,
        ),
        signal,
      );
      throwIfAborted(signal);
      return result.success ? undefined : (result.error ?? "the runner refused set_selection");
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`Keyboard open: caret restore errored: ${errorMessage(error)}`, error);
      return errorMessage(error);
    }
  }

  private async close(signal?: AbortSignal): Promise<KeyboardResult> {
    // Decide whether to send Back from a FORCED-FRESH read, never the cache. An
    // IME action (Done/Go/Search/Send) or the app itself may hide the keyboard or
    // navigate immediately before this runs; a stale ~1s-cached "IME open" sample
    // would then send a second KEYCODE_BACK on the destination screen, navigating
    // away or discarding a form (#5887 / #5899). Bounded by the confirmation
    // window so an unbounded read cannot fall back to the 10s hierarchy sync.
    const { state } = await this.getHierarchyWithState(signal, {
      timeoutMs: Keyboard.STATE_CONFIRMATION_TIMEOUT_MS,
      forceFresh: true,
    });
    if (state.error) {
      return {
        success: false,
        open: state.open,
        bounds: state.bounds,
        message: state.error,
        error: state.error,
      };
    }

    if (!state.open) {
      return {
        success: true,
        open: false,
        message: "Keyboard already closed",
      };
    }

    throwIfAborted(signal);
    await awaitWhileRequestIsLive(
      this.adb.executeCommand(
        "shell input keyevent KEYCODE_BACK",
        undefined,
        undefined,
        undefined,
        signal,
      ),
      signal,
    );

    const afterState = await this.waitForKeyboardState(false, signal);
    const success = !afterState.open && !afterState.error;
    const message = success ? "Keyboard closed" : (afterState.error ?? "Failed to close keyboard");

    return {
      success,
      open: afterState.open,
      bounds: afterState.bounds,
      message,
      ...(afterState.error ? { error: afterState.error } : {}),
    };
  }

  /**
   * Re-read the keyboard state until it matches `expectedOpen` or the bounded
   * confirmation window expires. A fixed post-action sleep raced the IME
   * show/hide animation and always reported the pre-action state (#4238); this
   * mirrors the confirmation poll VoiceOverToggle uses for the same defect class
   * (#4045). Time comes from the injected Timer so tests stay deterministic.
   *
   * Each read is bounded by whatever is left of the confirmation budget — an
   * unbounded read falls back to `requestHierarchySync`, whose 10s default would
   * overrun the 2s window on its own — and forces past the hierarchy cache, which
   * otherwise serves the same ~1s-fresh pre-action sample to every poll and makes
   * a slow IME transition look like a failure.
   */
  private async waitForKeyboardState(
    expectedOpen: boolean,
    signal?: AbortSignal,
  ): Promise<KeyboardDetection> {
    const deadline = this.timer.now() + Keyboard.STATE_CONFIRMATION_TIMEOUT_MS;

    // An open IME whose window still reaches past the screen is mid slide-in (#10152): its
    // bounds are not where it ends up, so keep sampling until they settle or time runs out.
    const unsettled = (state: KeyboardDetection) =>
      state.error || state.open !== expectedOpen || (expectedOpen && state.boundsOffScreen);
    let lastState = await this.readKeyboardStateBefore(deadline, signal);
    while (unsettled(lastState)) {
      const remainingMs = deadline - this.timer.now();
      throwIfAborted(signal);
      if (remainingMs <= 0) {
        break;
      }

      await awaitWhileRequestIsLive(
        this.timer.sleep(Math.min(Keyboard.STATE_CONFIRMATION_POLL_INTERVAL_MS, remainingMs)),
        signal,
      );
      throwIfAborted(signal);
      if (this.timer.now() >= deadline) {
        break;
      }

      lastState = await this.readKeyboardStateBefore(deadline, signal);
    }

    return lastState;
  }

  /**
   * One confirmation sample, bounded by what is left before `deadline` and forced
   * past the hierarchy cache. Only called while the remaining budget is positive,
   * so the read always gets a usable (non-zero) timeout.
   */
  private async readKeyboardStateBefore(
    deadline: number,
    signal?: AbortSignal,
  ): Promise<KeyboardDetection> {
    const { state } = await this.getHierarchyWithState(signal, {
      timeoutMs: Math.max(0, deadline - this.timer.now()),
      forceFresh: true,
    });
    return state;
  }

  private async getHierarchyWithState(
    signal?: AbortSignal,
    options?: KeyboardHierarchyReadOptions,
  ): Promise<{ hierarchy: ViewHierarchyResult | null; state: KeyboardDetection }> {
    throwIfAborted(signal);
    const hierarchy = await awaitWhileRequestIsLive(
      this.hierarchyProvider.getViewHierarchy(signal, options),
      signal,
    );
    throwIfAborted(signal);
    return { hierarchy, state: this.resolveKeyboardState(hierarchy) };
  }

  private resolveKeyboardState(viewHierarchy: ViewHierarchyResult | null): KeyboardDetection {
    if (!viewHierarchy) {
      return { open: false, error: "No view hierarchy available" };
    }

    const windows = viewHierarchy.windows ?? [];
    const windowInfoAvailable = windows.length > 0;
    const imeWindowPresent = windows.some(
      (windowInfo) => windowInfo.type === Keyboard.INPUT_METHOD_WINDOW_TYPE,
    );

    const windowBounds = this.findKeyboardWindowBounds(viewHierarchy);
    if (windowBounds) {
      return {
        open: true,
        bounds: [windowBounds],
        source: "window",
        windowInfoAvailable,
        imeWindowPresent: true,
        boundsOffScreen: this.reachesPastScreen(windowBounds, viewHierarchy),
      };
    }

    // App labels can match the heuristic while the IME is closed (#5899 / #9384).
    // Trust it only with an IME window (even without bounds), or as a deliberate
    // fallback when window metadata is unavailable, so detect/open/close agree.
    if (
      (imeWindowPresent || !windowInfoAvailable) &&
      this.detectKeyboardInHierarchy(viewHierarchy)
    ) {
      return { open: true, source: "heuristic", windowInfoAvailable, imeWindowPresent };
    }

    const hierarchyError = viewHierarchy.hierarchy?.error;
    if (hierarchyError) {
      return { open: false, error: hierarchyError };
    }

    return { open: false };
  }

  private findKeyboardWindowBounds(viewHierarchy: ViewHierarchyResult): ElementBounds | null {
    const windows = viewHierarchy.windows ?? [];
    for (const windowInfo of windows) {
      if (windowInfo.type !== Keyboard.INPUT_METHOD_WINDOW_TYPE) {
        continue;
      }
      if (windowInfo.bounds && this.isValidBounds(windowInfo.bounds)) {
        return windowInfo.bounds;
      }
    }
    return null;
  }

  /** False when the screen size is unknown: nothing can then be said about the bounds. */
  private reachesPastScreen(bounds: ElementBounds, viewHierarchy: ViewHierarchyResult): boolean {
    const { screenWidth, screenHeight } = viewHierarchy;
    if (!isPositiveNumber(screenWidth) || !isPositiveNumber(screenHeight)) {
      return false;
    }
    return (
      bounds.left < 0 ||
      bounds.top < 0 ||
      bounds.right > screenWidth ||
      bounds.bottom > screenHeight
    );
  }

  private isValidBounds(bounds: ElementBounds): boolean {
    return bounds.right > bounds.left && bounds.bottom > bounds.top;
  }

  private detectKeyboardInHierarchy(viewHierarchy: ViewHierarchyResult): boolean {
    const rootNodes = this.parser.extractRootNodes(viewHierarchy);
    const indicators = ["delete", "enter", "keyboard", "emoji", "shift"];
    for (const rootNode of rootNodes) {
      let found = false;
      this.parser.traverseNode(rootNode, (node: any) => {
        if (found) {
          return;
        }
        const props = this.parser.extractNodeProperties(node);
        const resourceId = this.getStringProp(props, "resource-id", "resourceId");
        const contentDesc = this.getStringProp(props, "content-desc", "contentDesc");
        const resourceValue = resourceId?.toLowerCase();
        const contentValue = contentDesc?.toLowerCase();

        if (
          resourceValue &&
          (resourceValue.includes("keyboard") || resourceValue.includes("inputmethod"))
        ) {
          found = true;
          return;
        }
        if (contentValue && indicators.some((indicator) => contentValue.includes(indicator))) {
          found = true;
        }
      });
      if (found) {
        return true;
      }
    }

    return false;
  }

  private getStringProp(
    props: Record<string, unknown>,
    primary: string,
    fallback: string,
  ): string | undefined {
    const primaryValue = props[primary];
    if (typeof primaryValue === "string") {
      return primaryValue;
    }
    const fallbackValue = props[fallback];
    if (typeof fallbackValue === "string") {
      return fallbackValue;
    }
    return undefined;
  }

  private findFocusedTextInput(viewHierarchy: ViewHierarchyResult): Element | null {
    const focusedElement = this.finder.findFocusedTextInput(viewHierarchy);
    if (!focusedElement || !focusedElement.bounds) {
      return null;
    }
    return focusedElement as Element;
  }

  private async tapOnElement(element: Element, signal?: AbortSignal): Promise<void> {
    const center = this.geometry.getElementCenter(element);
    const x = Math.round(center.x);
    const y = Math.round(center.y);
    throwIfAborted(signal);
    try {
      // Do not stop waiting on abort: the adb process is terminated and awaited (bounded by
      // the adb client's grace period) so a started tap has settled before callers restore state.
      await this.adb.executeCommand(
        `shell input tap ${x} ${y}`,
        undefined,
        undefined,
        undefined,
        signal,
        true,
      );
    } catch (error) {
      // The tap command had started, so it may have reached the device.
      if (signal?.aborted) {
        throw new KeyboardOpenIndeterminateError("tap", errorMessage(error));
      }
      throw error;
    }
  }
}
