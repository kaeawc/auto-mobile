import { errorMessage } from "../../utils/describeUnknownError";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import {
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

    return this.observedInteraction(
      async (observeResult: ObserveResult) => {
        try {
          // Platform-specific IME action execution
          switch (this.device.platform) {
            case "android":
              return await perf.track("androidImeAction", () =>
                this.executeAndroidImeAction(action, observeResult),
              );
            case "ios":
              return await perf.track("iOSImeAction", () =>
                this.executeiOSImeAction(action, observeResult),
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
      },
      {
        changeExpected: true,
        tolerancePercent: 0.0,
        timeoutMs: 3000, // IME actions should be quick
        progress,
        perf,
        skipUiStability: true, // Skip UI stability wait - a11y service already waits for quiescence
      },
    );
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
  ): Promise<ImeActionResult> {
    const timeoutMs = ImeAction.IOS_IME_ACTION_TIMEOUT_MS;
    try {
      const client = IOSCtrlProxyClient.getInstance(this.device);
      const request = client.requestImeAction(action, timeoutMs);
      const result = await this.raceIosImeActionDeadline(request, timeoutMs, action);

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
   * its own — its eventual result is irrelevant once we've timed out, so it
   * is only logged (never thrown) to avoid an unhandled rejection; letting it
   * run to completion in the background is also what allows the client's own
   * reconnect/health-check state to recover normally for the *next* call
   * instead of being aborted mid-flight.
   */
  private async raceIosImeActionDeadline(
    request: Promise<CtrlProxyImeActionResult>,
    timeoutMs: number,
    action: ImeActionType,
  ): Promise<CtrlProxyImeActionResult | null> {
    let timeoutHandle: ReturnType<Timer["setTimeout"]> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timeoutHandle = this.imeTimer.setTimeout(() => resolve(null), timeoutMs);
    });

    try {
      const outcome = await Promise.race([request, deadline]);
      if (outcome === null) {
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
