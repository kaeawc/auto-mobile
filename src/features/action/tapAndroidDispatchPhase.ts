import type {
  BootedDevice,
  Element,
  ElementSelectionResult,
  ViewHierarchyResult,
} from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import type { AndroidCtrlProxyClient } from "../observe/android";
import { StaleDisplayError } from "../observe/StaleDisplayError";
import { hasAccessibilityAction } from "../utility/elementProperties";
import {
  stableNodeSelectorForElement,
  type TalkBackTapResult,
  type TalkBackTapStrategy,
} from "../talkback/TalkBackTapStrategy";
import type { TalkBackNavigationDriverFactory } from "../talkback/TalkBackNavigationDriver";
import { dispatchAndroidDoubleTap } from "./androidDoubleTap";
import { isAndroidDocumentsUiRow } from "./androidCoordinateTapPolicy";
import type { DisplayFence, DisplayFenceOption } from "./BaseVisualChange";
import { dispatchAndroidCoordinateTap } from "./coordinateTapDispatch";
import { executeTouchscreenInput } from "./touchscreenInput";

/** Fence, pre-resolved hierarchy and non-fatal caution sink for an Android tap dispatch. */
export type ResolvedAndroidTapOptions = DisplayFenceOption & {
  resolvedHierarchy?: ViewHierarchyResult;
  /** Receives non-fatal cautions (for example a double tap whose taps started too far apart). */
  onActivationWarning?: (warning: string) => void;
  onResolvedElement?: (
    element: Element,
    selection?: ElementSelectionResult,
    hierarchy?: ViewHierarchyResult,
  ) => void;
};

/** Positional arguments of the coordinate tap dispatch; the last two are optional. */
export type AndroidTapWithCoordinatesArgs = [
  action: string,
  x: number,
  y: number,
  durationMs: number,
  element: Element,
  signal?: AbortSignal,
  skipSemanticAction?: boolean,
  fenceOptions?: ResolvedAndroidTapOptions,
];

/** What the Android coordinate-dispatch phase needs from the owning tap action. */
export interface AndroidDispatchHost {
  readonly device: BootedDevice;
  readonly timer: Timer;
  adb(): AdbExecutor;
  accessibilityService(): AndroidCtrlProxyClient;
  talkBackStrategy(): TalkBackTapStrategy;
  talkBackDriverFactory(): TalkBackNavigationDriverFactory;
  /** Routed through the owner so overriding/spying on it observes the scoped path too. */
  executeAndroidTapWithCoordinates(...args: AndroidTapWithCoordinatesArgs): Promise<void>;
  executeAndroidLongPress(
    x: number,
    y: number,
    durationMs: number,
    element: Element,
    signal: AbortSignal | undefined,
    skipSemanticAction: boolean,
    fenceOptions: ResolvedAndroidTapOptions,
  ): Promise<void>;
  reportTalkBackActivationWarning(
    result: TalkBackTapResult,
    context: { onActivationWarning?: (warning: string) => void } | undefined,
    action: string,
  ): void;
}

/**
 * Android coordinate dispatch for tapOn: the strictly-scoped tap path, the
 * CtrlProxy-gesture-then-ADB tap/double-tap dispatch and DocumentsUI row
 * activation / input recovery.
 */
export class TapAndroidDispatchPhase {
  constructor(private readonly host: AndroidDispatchHost) {}

  async executeScopedAndroidTap(context: {
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
      const driver = this.host.talkBackDriverFactory().createDriver(this.host.device);
      const talkBack = this.host.talkBackStrategy();
      const result =
        action === "tap"
          ? await talkBack.executePreciseTap(x, y, driver, fence)
          : await talkBack.executeCoordinateFallback(
              x,
              y,
              action as "doubleTap" | "longPress",
              durationMs,
              driver,
              { displayFence: fence },
            );
      if (result.success) {
        this.host.reportTalkBackActivationWarning(result, context, action);
        return;
      }
      await this.host.executeAndroidTapWithCoordinates(
        action,
        x,
        y,
        durationMs,
        element,
        signal,
        true,
        {
          displayFence: fence,
          onActivationWarning: context.onActivationWarning,
        },
      );
      this.host.reportTalkBackActivationWarning(result, context, action);
      return;
    }
    await this.host.executeAndroidTapWithCoordinates(
      action,
      x,
      y,
      durationMs,
      element,
      signal,
      true,
      {
        displayFence: fence,
        onActivationWarning: context.onActivationWarning,
      },
    );
  }

  /**
   * Execute tap using CtrlProxy's dispatchGesture API with ADB fallback.
   * dispatchGesture bypasses the ADB input pipeline, reducing ghost-tap rate.
   */
  async executeAndroidTapWithCoordinates(...args: AndroidTapWithCoordinatesArgs): Promise<void> {
    const [
      action,
      x,
      y,
      durationMs,
      element,
      signal,
      skipSemanticAction = false,
      fenceOptions = {},
    ] = args;
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
      await this.host.executeAndroidLongPress(
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
        client: isAndroidDocumentsUiRow(element) ? undefined : this.host.accessibilityService(),
        point: { x, y },
        timer: this.host.timer,
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
      const accessibilityService = this.host.accessibilityService();
      if (!(await accessibilityService.supportsNodeActionSelectors(undefined, signal))) {
        return false;
      }
      throwIfAborted(signal);
      const result = await accessibilityService.requestNodeAction(
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
  async dispatchCoordinateTapOrAdbFallback(
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
        this.host.accessibilityService(),
        this.host.adb(),
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
    await executeTouchscreenInput(this.host.adb(), `tap ${x} ${y}`, undefined, signal);
  }
}
