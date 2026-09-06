import { errorMessage } from "../../utils/describeUnknownError";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import {
  ActionableError,
  BootedDevice,
  ImeAction as ImeActionType,
  ImeActionResult,
  ObserveResult,
} from "../../models";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { AndroidCtrlProxy, AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import type { CtrlProxyImeActionResult } from "../observe/ios/types";
import { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";

export class ImeAction extends BaseVisualChange {
  private a11yService: AndroidCtrlProxy | null = null;
  private imeTimer: Timer;

  /**
   * Local deadline for the iOS CtrlProxy IME-action request (#6249). Matches
   * the wire-level default in `SharedTextDelegate.requestImeAction`/`sendCommand`
   * so a healthy runner behaves identically; the difference only shows up when
   * the connection layer is unhealthy — see `executeiOSImeAction`.
   */
  private static readonly IOS_IME_ACTION_TIMEOUT_MS = 5000;

  constructor(
    device: BootedDevice,
    adb: AdbClient | null = null,
    a11yService: AndroidCtrlProxy | null = null,
    timer: Timer = defaultTimer,
  ) {
    super(device, adb, timer);
    this.a11yService = a11yService;
    this.imeTimer = timer;
  }

  async execute(action: ImeActionType, progress?: ProgressCallback): Promise<ImeActionResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("imeAction");

    // Validate action input
    if (!action) {
      perf.end();
      return {
        success: false,
        action: "",
        error: "No IME action provided",
      };
    }

    // iOS gets its own abort signal + outer deadline (#6249 follow-up): the
    // pre-action observation performed by `observedInteraction` below runs
    // through the same unbounded `ensureConnected()` path as the IME request
    // itself, so it must be covered by the deadline too — not just the
    // request. See `boundIosInteractionToDeadline`.
    const isIos = this.device.platform === "ios";
    const iosAbortController = isIos ? new AbortController() : undefined;

    const block = async (observeResult: ObserveResult): Promise<ImeActionResult> => {
      try {
        // Platform-specific IME action execution
        switch (this.device.platform) {
          case "android":
            return await perf.track("androidImeAction", () =>
              this.executeAndroidImeAction(action, observeResult),
            );
          case "ios":
            return await perf.track("iOSImeAction", () =>
              this.executeiOSImeAction(action, observeResult, iosAbortController?.signal),
            );
          default:
            perf.end();
            throw new Error(`Unsupported platform: ${this.device.platform}`);
        }
      } catch (error) {
        perf.end();
        const errorMsg = errorMessage(error);
        return {
          success: false,
          action,
          error: `Failed to execute IME action: ${errorMsg}`,
        };
      }
    };

    const options: Parameters<BaseVisualChange["observedInteraction"]>[1] = {
      changeExpected: true,
      tolerancePercent: 0.0,
      timeoutMs: 3000, // IME actions should be quick
      progress,
      perf,
      skipUiStability: true, // Skip UI stability wait - a11y service already waits for quiescence
      signal: iosAbortController?.signal,
    };

    if (!iosAbortController) {
      return this.observedInteraction(block, options);
    }

    return this.boundIosInteractionToDeadline(block, options, action, iosAbortController);
  }

  /**
   * Bound the ENTIRE iOS `observedInteraction` call — pre-action observation
   * AND the IME request itself — to `IOS_IME_ACTION_TIMEOUT_MS` (#6249
   * follow-up).
   *
   * The pre-action observation fetched by `observedInteraction` (a cache miss
   * falls through to `observeScreen.execute()`) goes through the same
   * unbounded iOS `ensureConnected()` path as the IME request. Racing only
   * the request (as `raceIosImeActionDeadline` does) leaves this earlier step
   * free to hang indefinitely when there is no usable cached hierarchy and
   * the runner is unhealthy. Wrapping the whole call here means `execute()`
   * always returns within the deadline regardless of which stage stalls.
   *
   * As with the request-level race, the abandoned `observedInteraction`
   * promise is left to settle in the background (logged, never thrown) so
   * the underlying client's own reconnect/health-check state can recover
   * normally for the next call instead of being torn down mid-flight.
   */
  private async boundIosInteractionToDeadline(
    block: (observeResult: ObserveResult) => Promise<ImeActionResult>,
    options: Parameters<BaseVisualChange["observedInteraction"]>[1],
    action: ImeActionType,
    controller: AbortController,
  ): Promise<ImeActionResult> {
    const timeoutMs = ImeAction.IOS_IME_ACTION_TIMEOUT_MS;
    let deadlineHandle: ReturnType<Timer["setTimeout"]> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      deadlineHandle = this.imeTimer.setTimeout(() => resolve("deadline"), timeoutMs);
    });

    const interaction = this.observedInteraction(block, options);

    try {
      const outcome = await Promise.race([interaction, deadline]);
      if (outcome === "deadline") {
        controller.abort();
        void interaction.catch((error) => {
          // The interaction's own outcome no longer matters to this call —
          // only trace it so a slow/failing runner is still diagnosable.
          logger.debug(
            `[ImeAction] iOS execute() pipeline for action '${action}' settled after the local ${timeoutMs}ms deadline: ${errorMessage(error)}`,
          );
        });
        logger.warn(
          `[ImeAction] iOS IME action '${action}' exceeded its ${timeoutMs}ms deadline before the pre-action observation or request settled; failing without waiting further`,
        );
        throw new ActionableError(
          `IME action '${action}' timed out after ${timeoutMs}ms waiting on the iOS device connection`,
        );
      }
      return outcome as ImeActionResult;
    } finally {
      if (deadlineHandle !== undefined) {
        this.imeTimer.clearTimeout(deadlineHandle);
      }
    }
  }

  /**
   * Execute Android-specific IME action using accessibility service.
   * Falls back to ADB key events if a11y service is unavailable.
   */
  private async executeAndroidImeAction(
    action: ImeActionType,
    _observeResult: ObserveResult,
  ): Promise<ImeActionResult> {
    // Use provided a11y service or get default instance
    const a11yClient =
      this.a11yService || AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
    const a11yResult = await a11yClient.requestImeAction(action);

    if (a11yResult.success) {
      logger.info(
        `[ImeAction] IME action '${action}' completed via accessibility service: ${a11yResult.totalTimeMs}ms`,
      );
      return { success: true, action };
    }

    // Fall back to ADB key events
    logger.warn(
      `[ImeAction] Accessibility service IME action failed: ${a11yResult.error}, falling back to ADB`,
    );
    return this.executeAdbImeAction(action);
  }

  /**
   * [LEGACY] Execute IME action using ADB key events.
   * Kept as fallback if accessibility service is unavailable.
   * NOTE: This approach has known issues - KEYCODE_TAB inserts tab characters
   * instead of moving focus between fields.
   */
  private async executeAdbImeAction(action: ImeActionType): Promise<ImeActionResult> {
    logger.info("Executing IME action via ADB", { action });

    // Map IME actions to Android key codes
    // NOTE: KEYCODE_TAB doesn't work correctly for "next" - it inserts a tab character
    // This fallback is only used if accessibility service is unavailable
    const imeKeyCodeMap: { [key: string]: string } = {
      done: "KEYCODE_ENTER",
      next: "KEYCODE_TAB", // WARNING: May insert tab character instead of moving focus
      search: "KEYCODE_SEARCH",
      send: "KEYCODE_ENTER",
      go: "KEYCODE_ENTER",
      previous: "KEYCODE_SHIFT_LEFT KEYCODE_TAB", // WARNING: May not work correctly
    };

    const keyCode = imeKeyCodeMap[action];
    if (!keyCode) {
      return {
        success: false,
        action,
        error: `Unsupported IME action: ${action}`,
      };
    }

    try {
      // Small delay to ensure any preceding text input is processed
      await this.imeTimer.sleep(100);

      // Execute the key event(s)
      if (keyCode.includes(" ")) {
        // Handle multiple key combinations like Shift+Tab
        const keys = keyCode.split(" ");
        for (const key of keys) {
          await this.adb.executeCommand(`shell input keyevent ${key}`);
        }
      } else {
        await this.adb.executeCommand(`shell input keyevent ${keyCode}`);
      }

      return { success: true, action };
    } catch (error) {
      const errorMsg = errorMessage(error);
      return {
        success: false,
        action,
        error: `ADB key event failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Execute iOS-specific IME action using CtrlProxy iOS.
   */
  private async executeiOSImeAction(
    action: ImeActionType,
    _observeResult: ObserveResult,
    outerSignal?: AbortSignal,
  ): Promise<ImeActionResult> {
    const timeoutMs = ImeAction.IOS_IME_ACTION_TIMEOUT_MS;
    // Own the abort signal actually threaded into the wire request so a
    // request that outlives the deadline is cancelled rather than dispatched
    // (#6249 follow-up). Also honor an outer deadline (e.g.
    // `boundIosInteractionToDeadline`) that may fire first.
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (outerSignal?.aborted) {
      controller.abort();
    } else {
      outerSignal?.addEventListener("abort", onOuterAbort);
    }

    try {
      const client = IOSCtrlProxyClient.getInstance(this.device);
      const request = client.requestImeAction(action, timeoutMs, undefined, controller.signal);
      const result = await this.raceIosImeActionDeadline(request, timeoutMs, action, controller);

      if (result === null) {
        return {
          success: false,
          action,
          error: `IME action timed out after ${timeoutMs}ms`,
        };
      }

      if (result.success) {
        logger.info(`[ImeAction] IME action '${action}' completed via CtrlProxy iOS`);
        return { success: true, action };
      }

      logger.warn(`[ImeAction] CtrlProxy iOS IME action failed: ${result.error}`);
      return { success: false, action, error: result.error };
    } catch (error) {
      logger.error(`[ImeAction] CtrlProxy iOS exception: ${error}`);
      return { success: false, action, error: String(error) };
    } finally {
      outerSignal?.removeEventListener("abort", onOuterAbort);
    }
  }

  /**
   * Bound an in-flight iOS CtrlProxy IME-action request with a deadline that
   * starts immediately and runs independently of the request itself (#6249).
   *
   * `IOSCtrlProxyClient.requestImeAction`'s own `timeoutMs` only bounds the
   * wait for a wire response AFTER `ensureConnected()` resolves — and
   * `ensureConnected()` (WebSocket reconnect, iOS auto-setup, a runner mid
   * restart) runs first and is NOT itself bounded by that timeout. A real
   * repro of #6249 returned ~35s late against a configured 5000ms timeout,
   * while the daemon's own reconnect-failure counter tore down the iOS
   * CtrlProxy test-runner process in the background during that wait.
   *
   * Racing an independently-scheduled deadline here means this call always
   * returns to the caller within `timeoutMs`, regardless of what the
   * connection layer is doing. The underlying request is left to settle on
   * its own in the background — but before that, firing the deadline also
   * aborts `controller`, which is wired all the way into `sendCommand`
   * (`DeviceServiceUtils.ts`): if `ensureConnected()` was still resolving
   * when the deadline hit, `sendCommand` sees the abort right after
   * `ensureConnected()` returns and skips registering/sending
   * `request_ime_action` entirely — no phantom dispatch after the caller has
   * already given up (#6249 follow-up). The request's eventual settlement is
   * only logged (never thrown) to avoid an unhandled rejection; letting the
   * client's own connection state settle normally (rather than being torn
   * down mid-flight) is what keeps the *next* call unaffected.
   */
  private async raceIosImeActionDeadline(
    request: Promise<CtrlProxyImeActionResult>,
    timeoutMs: number,
    action: ImeActionType,
    controller: AbortController,
  ): Promise<CtrlProxyImeActionResult | null> {
    let timeoutHandle: ReturnType<Timer["setTimeout"]> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timeoutHandle = this.imeTimer.setTimeout(() => resolve(null), timeoutMs);
    });

    try {
      const outcome = await Promise.race([request, deadline]);
      if (outcome === null) {
        controller.abort();
        void request.catch((error) => {
          // The request's own outcome no longer matters to this call — only
          // trace it so a slow/failing runner is still diagnosable.
          logger.debug(
            `[ImeAction] iOS CtrlProxy request for action '${action}' settled after the local ${timeoutMs}ms deadline: ${errorMessage(error)}`,
          );
        });
        logger.warn(
          `[ImeAction] iOS IME action '${action}' exceeded its ${timeoutMs}ms local deadline before the connection/request settled; returning failure without waiting further`,
        );
      }
      return outcome;
    } finally {
      if (timeoutHandle !== undefined) {
        this.imeTimer.clearTimeout(timeoutHandle);
      }
    }
  }
}
