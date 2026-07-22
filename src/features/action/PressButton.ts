import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { BootedDevice, PressButtonResult } from "../../models";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { IOSCtrlProxyClient } from "../observe/ios";
import { AndroidCtrlProxyClient } from "../observe/android";
import { logger } from "../../utils/logger";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { isNavigationPressButton, resolveAndroidKeyCode } from "./pressButtonPolicy";

export class PressButton extends BaseVisualChange {
  constructor(device: BootedDevice, adb: AdbClient | null = null) {
    super(device, adb);
    this.device = device;
  }

  async execute(
    button: string,
    progress?: ProgressCallback
  ): Promise<PressButtonResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("pressButton");

    // Navigation buttons (back, home, recent, power) typically cause UI changes like
    // dismissing keyboard, navigating screens, or showing lock screen. We set
    // changeExpected=true so the observation waits for the hierarchy to actually change.
    // Hardware buttons (volume, menu) don't change the hierarchy.
    const isNavigationButton = isNavigationPressButton(button);

    return this.observedInteraction(
      async () => {
        return await perf.track("buttonPress", () => this.press(button));
      },
      {
        changeExpected: isNavigationButton,
        timeoutMs: 2000,
        progress,
        perf
      }
    );
  }

  /**
   * Press a hardware/navigation button.
   *
   * @param button - Button name to press
   * @param timeoutMs - Optional deadline budget (e.g. the socket request's
   *   remaining time). When provided it is threaded into every underlying
   *   runner/ADB call so the caller's timeout is honored instead of the
   *   per-transport hard-coded defaults. When omitted, the existing defaults
   *   apply.
   */
  async press(button: string, timeoutMs?: number): Promise<PressButtonResult> {
    try {
      switch (this.device.platform) {
        case "android":
          return await this.executeAndroidButtonPress(button, timeoutMs);
        case "ios":
          return await this.executeiOSButtonPress(button, timeoutMs);
        default:
          throw new Error(`Unsupported platform: ${this.device.platform}`);
      }
    } catch (error) {
      return {
        success: false,
        button,
        keyCode: -1,
        error: `Failed to press button: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  // Buttons that can be handled via accessibility service global actions
  private static readonly GLOBAL_ACTION_BUTTONS = new Set(["back", "home", "recent"]);
  private static readonly IOS_NAVIGATION_BUTTONS = new Set(["home", "back", "recent"]);
  private static readonly IOS_HARDWARE_BUTTONS = new Set(["volume_up", "volume_down", "power"]);

  /**
   * Execute Android-specific button press.
   * Uses accessibility service global actions for back/home/recent (faster),
   * falls back to ADB keyevent for all buttons.
   */
  // Default fast-fail budget for the accessibility-service global-action path
  // before we fall back to ADB keyevent.
  private static readonly GLOBAL_ACTION_TIMEOUT_MS = 3000;

  private async executeAndroidButtonPress(button: string, timeoutMs?: number): Promise<PressButtonResult> {
    const normalized = button.toLowerCase();
    const keyCode = resolveAndroidKeyCode(normalized);
    if (keyCode === undefined) {
      return {
        success: false,
        button,
        keyCode: -1,
        error: `Unsupported button: ${button}`
      };
    }

    // When a budget is supplied, honor it as an absolute deadline shared across
    // the (optional) global-action attempt and the ADB fallback so the caller's
    // timeout is not exceeded by the sum of the two per-transport defaults.
    const deadlineMs = timeoutMs !== undefined ? this.timer.now() + timeoutMs : undefined;
    const remainingMs = (): number | undefined =>
      deadlineMs !== undefined ? deadlineMs - this.timer.now() : undefined;

    // Try accessibility service global action for supported buttons
    if (PressButton.GLOBAL_ACTION_BUTTONS.has(normalized)) {
      const budget = remainingMs();
      // Skip straight to ADB if the deadline is already exhausted.
      if (budget === undefined || budget > 0) {
        const globalActionTimeout = budget === undefined
          ? PressButton.GLOBAL_ACTION_TIMEOUT_MS
          : Math.min(PressButton.GLOBAL_ACTION_TIMEOUT_MS, budget);
        try {
          const client = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
          const result = await client.requestGlobalAction(normalized, globalActionTimeout);
          if (result.success) {
            logger.debug(`[PRESS_BUTTON] Used accessibility service for ${button}`);
            return { success: true, button, keyCode };
          }
          logger.debug(`[PRESS_BUTTON] Global action failed (${result.error}), falling back to ADB`);
        } catch {
          // Fall through to ADB
        }
      }
    }

    // Fail fast if the (optional) deadline was fully consumed by the global-action
    // attempt above. Passing 0 to executeCommand would arm NO timeout (the
    // `if (timeoutMs)` check treats 0 as falsy), leaving the ADB keyevent
    // unbounded — the exact overrun this budget threading exists to prevent.
    const adbBudget = remainingMs();
    if (adbBudget !== undefined && adbBudget <= 0) {
      return {
        success: false,
        button,
        keyCode: -1,
        error: `Button press deadline exhausted before ADB keyevent for ${button}`
      };
    }

    await this.adb.executeCommand(`shell input keyevent ${keyCode}`, adbBudget);
    return { success: true, button, keyCode };
  }

  /**
   * Execute iOS-specific button press
   * @param button - Button name to press
   * @returns Result of the button press operation
   */
  private async executeiOSButtonPress(button: string, timeoutMs?: number): Promise<PressButtonResult> {
    const normalizedButton = button.toLowerCase();
    if (PressButton.IOS_NAVIGATION_BUTTONS.has(normalizedButton)) {
      const client = IOSCtrlProxyClient.getInstance(this.device);
      const result = await this.executeiOSNavigationButton(client, normalizedButton, timeoutMs);

      if (!result.success) {
        return {
          success: false,
          button,
          keyCode: -1,
          error: result.error ?? `Failed to press iOS ${normalizedButton} button`
        };
      }

      return {
        success: true,
        button,
        keyCode: -1
      };
    }

    if (PressButton.IOS_HARDWARE_BUTTONS.has(normalizedButton)) {
      if (isIosSimulatorUdid(this.device.deviceId)) {
        return {
          success: false,
          button,
          keyCode: -1,
          error: `iOS button "${button}" is unavailable on the iOS simulator (physical device only)`
        };
      }

      const client = IOSCtrlProxyClient.getInstance(this.device);
      const result = await client.requestPressButton(normalizedButton, timeoutMs);

      if (!result.success) {
        return {
          success: false,
          button,
          keyCode: -1,
          error: result.error ?? `iOS hardware button "${button}" is not supported on this device`
        };
      }

      return { success: true, button, keyCode: -1 };
    }

    if (normalizedButton === "menu") {
      return {
        success: false,
        button,
        keyCode: -1,
        error: "iOS has no menu hardware button"
      };
    }

    return {
      success: false,
      button,
      keyCode: -1,
      error: `Unsupported iOS button: ${button}`
    };
  }

  private async executeiOSNavigationButton(
    client: IOSCtrlProxyClient,
    button: string,
    timeoutMs?: number
  ): Promise<{ success: boolean; error?: string }> {
    switch (button) {
      case "home":
        return client.requestPressHome(timeoutMs);
      case "back":
        return client.requestPressBack(timeoutMs);
      case "recent":
        return client.requestRecentApps(timeoutMs);
      default:
        return { success: false, error: `Unsupported iOS button: ${button}` };
    }
  }
}
