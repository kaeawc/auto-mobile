import { toActionableError, unsupportedPlatformError } from "../../models/ActionableError";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { ActionableError, BootedDevice, HomeScreenResult } from "../../models";
import { createGlobalPerformanceTracker, PerformanceTracker } from "../../utils/PerformanceTracker";
import { IOSCtrlProxyClient } from "../observe/ios";
import { AndroidCtrlProxyClient } from "../observe/android";
import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { deriveIosScreenIdentity } from "../observe/ios/IosScreenIdentity";
import type { CtrlProxyHierarchy } from "../observe/ios/types";

/**
 * Navigates to the home screen using the accessibility service global action
 * (preferred) or hardware home button keyevent (fallback). Verifies the
 * foreground app actually became the launcher before reporting success
 * (issue #6147) rather than trusting either dispatch method's self-reported
 * result.
 */
export class HomeScreen extends BaseVisualChange {
  /**
   * Deadline for the ADB `KEYCODE_HOME` fallback keyevent. Without a bound a
   * wedged adb could hang the whole home navigation well past the enclosing
   * observedInteraction budget; the fallback is also cancellable via the ambient
   * request signal (issue #6289).
   */
  private static readonly HOME_KEYEVENT_TIMEOUT_MS = 3000;
  private static readonly IOS_HOME_VERIFICATION_TIMEOUT_MS = 4000;
  private static readonly IOS_HOME_HIERARCHY_READ_TIMEOUT_MS = 1000;
  private static readonly IOS_HOME_RETRY_DELAYS_MS: readonly number[] = [300, 600, 900];

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
            throw unsupportedPlatformError(this.device.platform, "return to the home screen");
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
    // Combine (never replace) with the ambient MCP request signal so a cancelled
    // request aborts the ADB keyevent fallback and the verification reads. Passing
    // only a private signal would drop the ambient one AdbClient would otherwise
    // pick up (issue #6289).
    const signal = combineWithAmbientAbort(undefined);

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
      if (await this.verifyAndroidHomeForeground({ signal })) {
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

    await this.adb.executeCommand(
      "shell input keyevent 3",
      HomeScreen.HOME_KEYEVENT_TIMEOUT_MS,
      undefined,
      true,
      signal,
    );

    if (!(await this.verifyAndroidHomeForeground({ signal }))) {
      throw new ActionableError(
        "Home press did not background the foreground app: neither the accessibility global action nor the ADB KEYCODE_HOME keyevent produced a launcher foreground window",
      );
    }
  }

  private async executeIosHomeNavigation(perf?: PerformanceTracker): Promise<void> {
    const client = IOSCtrlProxyClient.getInstance(this.device);
    const result = await client.requestPressHome(5000, perf);
    if (!result.success) {
      throw new ActionableError(result.error ?? "Failed to press iOS home button");
    }
    await this.verifyIosHomeForeground(client, perf);
  }

  private async verifyIosHomeForeground(
    client: IOSCtrlProxyClient,
    perf?: PerformanceTracker,
    retryDelaysMs: readonly number[] = HomeScreen.IOS_HOME_RETRY_DELAYS_MS,
  ): Promise<void> {
    const deadline = this.timer.now() + HomeScreen.IOS_HOME_VERIFICATION_TIMEOUT_MS;
    let lastHierarchy: CtrlProxyHierarchy | undefined;

    for (let attempt = 0; ; attempt++) {
      const remainingMs = deadline - this.timer.now();
      if (remainingMs <= 0) {
        break;
      }
      const hierarchy = await this.readIosHomeForeground(client, perf, remainingMs);
      if (hierarchy) {
        lastHierarchy = hierarchy;
      }
      if (hierarchy?.packageName === "com.apple.springboard" && this.timer.now() < deadline) {
        return;
      }

      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || this.timer.now() + delayMs >= deadline) {
        break;
      }
      await this.timer.sleep(delayMs);
    }

    this.throwIosHomeNotForeground(client, lastHierarchy);
  }

  private async readIosHomeForeground(
    client: IOSCtrlProxyClient,
    perf: PerformanceTracker | undefined,
    remainingMs: number,
  ): Promise<CtrlProxyHierarchy | undefined> {
    try {
      // Request a fresh foreground hierarchy after the press. A cached
      // pre-press hierarchy cannot establish the Home postcondition.
      const response = await client.requestHierarchySync(
        perf,
        true,
        undefined,
        Math.min(HomeScreen.IOS_HOME_HIERARCHY_READ_TIMEOUT_MS, remainingMs),
      );
      return response?.hierarchy;
    } catch (error) {
      throw toActionableError(error, "Failed to verify the iOS foreground app after pressing Home");
    }
  }

  private throwIosHomeNotForeground(
    client: IOSCtrlProxyClient,
    lastHierarchy: CtrlProxyHierarchy | undefined,
  ): never {
    const foregroundApp = lastHierarchy?.packageName ?? "unknown app";
    const modal = lastHierarchy
      ? deriveIosScreenIdentity(client.convertToViewHierarchyResult(lastHierarchy))?.components
      : undefined;
    const alert = modal?.modalClass
      ? `: a system alert (${modal.modalClass}${modal.modalTitle ? ` '${modal.modalTitle}'` : ""}) is blocking Home; dismiss it first`
      : "; the home screen did not become foreground";
    throw new ActionableError(`Home press did not background ${foregroundApp}${alert}`);
  }
}
