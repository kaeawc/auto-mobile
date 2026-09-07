import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { ActionableError, BootedDevice, HomeScreenResult } from "../../models";
import { createGlobalPerformanceTracker, PerformanceTracker } from "../../utils/PerformanceTracker";
import { IOSCtrlProxyClient } from "../observe/ios";
import { AndroidCtrlProxyClient } from "../observe/android";
import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";

/**
 * Navigates to the home screen using the accessibility service global action
 * (preferred) or hardware home button keyevent (fallback). Verifies the
 * foreground app actually became the launcher before reporting success
 * (issue #6147) rather than trusting either dispatch method's self-reported
 * result.
 */
export class HomeScreen extends BaseVisualChange {
  constructor(device: BootedDevice, adb: AdbClient | null = null, timer: Timer = defaultTimer) {
    super(device, adb, timer);
    this.device = device;
  }

  async execute(progress?: ProgressCallback): Promise<HomeScreenResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("homeScreen");

    return await this.observedInteraction(
      async () => {
        switch (this.device.platform) {
          case "android":
            await perf.track("homeNavigation", () => this.executeAndroidHome());
            break;
          case "ios":
            await perf.track("iOSHomeNavigation", () => this.executeIosHomeNavigation(perf));
            break;
          default:
            throw new Error(`Unsupported platform: ${this.device.platform}`);
        }

        return {
          success: true,
          navigationMethod: "hardware",
        };
      },
      {
        changeExpected: true,
        timeoutMs: 5000,
        progress,
        perf,
      },
    );
  }

  private async executeAndroidHome(): Promise<void> {
    let globalActionSucceeded = false;
    try {
      const client = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
      const result = await client.requestGlobalAction("home", 3000);
      globalActionSucceeded = result.success;
      if (!globalActionSucceeded) {
        logger.debug(`[HOME] Global action failed (${result.error}), falling back to ADB keyevent`);
      }
    } catch {
      // Fall through to ADB
    }

    if (globalActionSucceeded) {
      if (await this.verifyAndroidHomeForeground()) {
        logger.debug("[HOME] Used accessibility service global action");
        return;
      }
      // The global action self-reported success but the foreground app never
      // became the launcher (issue #6147 -- observed on API 28). Do not trust
      // the report; fall back to the ADB keyevent path known to work.
      logger.debug(
        "[HOME] Global action reported success but foreground app did not change to the launcher; falling back to ADB keyevent",
      );
    }

    await this.adb.executeCommand("shell input keyevent 3");

    if (!(await this.verifyAndroidHomeForeground())) {
      throw new ActionableError(
        "Home press did not background the foreground app: neither the accessibility global action nor the ADB KEYCODE_HOME keyevent produced a launcher foreground window",
      );
    }
  }

  private async executeIosHomeNavigation(perf?: PerformanceTracker): Promise<void> {
    const client = IOSCtrlProxyClient.getInstance(this.device);
    const result = await client.requestPressHome(5000, perf);
    if (!result.success) {
      throw new Error(result.error ?? "Failed to press iOS home button");
    }
  }
}
