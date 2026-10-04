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
};

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

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    hierarchyProvider?: KeyboardHierarchyProvider,
    timer: Timer = defaultTimer,
    parser: ElementParser = new DefaultElementParser(),
    geometry: ElementGeometry = new DefaultElementGeometry(),
    finder: ElementFinder = new DefaultElementFinder(),
  ) {
    this.device = device;
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

    await this.tapOnElement(focusedInput, signal);

    const afterState = await this.waitForKeyboardState(true, signal);
    const success = afterState.open && !afterState.error;
    const message = success ? "Keyboard opened" : (afterState.error ?? "Failed to open keyboard");

    return {
      success,
      open: afterState.open,
      bounds: afterState.bounds,
      message,
      ...(afterState.error ? { error: afterState.error } : {}),
    };
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

    let lastState = await this.readKeyboardStateBefore(deadline, signal);
    while (lastState.error || lastState.open !== expectedOpen) {
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
    await awaitWhileRequestIsLive(
      this.adb.executeCommand(`shell input tap ${x} ${y}`, undefined, undefined, undefined, signal),
      signal,
    );
  }
}
