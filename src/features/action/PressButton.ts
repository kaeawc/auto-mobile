import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { BootedDevice, PressButtonResult } from "../../models";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { IOSCtrlProxyClient } from "../observe/ios";
import { AndroidCtrlProxyClient } from "../observe/android";
import { logger } from "../../utils/logger";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";

export class PressButton extends BaseVisualChange {
  constructor(device: BootedDevice, adb: AdbClient | null = null) {
    super(device, adb);
    this.device = device;
  }

  // Buttons that typically cause UI/navigation changes (dismiss keyboard, go home, lock screen, etc.)
  // These should wait for hierarchy changes to ensure fresh observation data
  private static readonly NAVIGATION_BUTTONS = new Set(["back", "home", "recent", "power"]);

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
    const isNavigationButton = PressButton.NAVIGATION_BUTTONS.has(button.toLowerCase());

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

  async press(button: string): Promise<PressButtonResult> {
    try {
      switch (this.device.platform) {
        case "android":
          return await this.executeAndroidButtonPress(button);
        case "ios":
          return await this.executeiOSButtonPress(button);
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
  private async executeAndroidButtonPress(button: string): Promise<PressButtonResult> {
    const keyCodeMap: Record<string, number> = {
      "home": 3,
      "back": 4,
      "menu": 82,
      "power": 26,
      "volume_up": 24,
      "volume_down": 25,
      "recent": 187,
    };

    const normalized = button.toLowerCase();
    const keyCode = keyCodeMap[normalized];
    if (!keyCode) {
      return {
        success: false,
        button,
        keyCode: -1,
        error: `Unsupported button: ${button}`
      };
    }

    // Try accessibility service global action for supported buttons
    if (PressButton.GLOBAL_ACTION_BUTTONS.has(normalized)) {
      try {
        const client = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
        const result = await client.requestGlobalAction(normalized, 3000);
        if (result.success) {
          logger.debug(`[PRESS_BUTTON] Used accessibility service for ${button}`);
          return { success: true, button, keyCode };
        }
        logger.debug(`[PRESS_BUTTON] Global action failed (${result.error}), falling back to ADB`);
      } catch {
        // Fall through to ADB
      }
    }

    await this.adb.executeCommand(`shell input keyevent ${keyCode}`);
    return { success: true, button, keyCode };
  }

  /**
   * Execute iOS-specific button press
   * @param button - Button name to press
   * @returns Result of the button press operation
   */
  private async executeiOSButtonPress(button: string): Promise<PressButtonResult> {
    const normalizedButton = button.toLowerCase();
    if (PressButton.IOS_NAVIGATION_BUTTONS.has(normalizedButton)) {
      const client = IOSCtrlProxyClient.getInstance(this.device);
      const result = await this.executeiOSNavigationButton(client, normalizedButton);

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
      const result = await client.requestPressButton(normalizedButton);

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
    button: string
  ): Promise<{ success: boolean; error?: string }> {
    switch (button) {
      case "home":
        return client.requestPressHome();
      case "back":
        return client.requestPressBack();
      case "recent":
        return client.requestRecentApps();
      default:
        return { success: false, error: `Unsupported iOS button: ${button}` };
    }
  }
}
