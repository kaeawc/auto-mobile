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
import { IOS_SIMULATOR_HOME_RUNNER_TIMEOUT_MS } from "../observe/ios/CtrlProxyNavigation";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { sequenceBackoff } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";

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
  private static readonly IOS_SIMULATOR_VERIFY_TIMEOUT_MS = 1200;
  private static readonly IOS_SIMULATOR_READ_TIMEOUT_MS = 600;
  private static readonly IOS_SIMCTL_LAUNCH_TIMEOUT_MS = 1000;

  constructor(
    device: BootedDevice,
    adb: AdbClient | null = null,
    timer: Timer = defaultTimer,
    private readonly simctl: Pick<SimCtl, "executeCommandArgs"> = new SimCtlClient(device),
  ) {
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

  async executeIosHomeNavigation(
    perf?: PerformanceTracker,
    frameContext?: string,
    timeoutMs?: number,
  ): Promise<void> {
    const client = IOSCtrlProxyClient.getInstance(this.device);
    const simulator = isIosSimulatorUdid(this.device.deviceId);
    const deadline = simulator ? this.timer.now() + (timeoutMs ?? 5000) : undefined;
    const runnerTimeoutMs = simulator
      ? Math.min(IOS_SIMULATOR_HOME_RUNNER_TIMEOUT_MS, Math.max(1, (timeoutMs ?? 5000) - 2000))
      : 5000;
    let pressError = await this.tryIosRunnerHome(
      client,
      runnerTimeoutMs,
      perf,
      frameContext,
      simulator,
    );

    if (!simulator) {
      if (pressError) {
        throw new ActionableError(pressError);
      }
      await this.verifyIosHomeForeground(client, perf);
      return;
    }

    if (!pressError) {
      pressError = await this.checkIosRunnerForeground(client, perf, deadline);
      if (!pressError) {
        return;
      }
    }

    logger.debug(`[HOME] ${pressError}; launching SpringBoard with simctl`);
    try {
      await this.simctl.executeCommandArgs(
        ["launch", this.device.deviceId, "com.apple.springboard"],
        Math.min(HomeScreen.IOS_SIMCTL_LAUNCH_TIMEOUT_MS, this.iosHomeRemainingMs(deadline)),
      );
    } catch (error) {
      throw toActionableError(error, `Failed to return to SpringBoard after ${pressError}`);
    }

    try {
      await this.verifyIosHomeForeground(
        client,
        perf,
        [100, 200],
        Math.min(HomeScreen.IOS_SIMULATOR_VERIFY_TIMEOUT_MS, this.iosHomeRemainingMs(deadline)),
        HomeScreen.IOS_SIMULATOR_READ_TIMEOUT_MS,
      );
    } catch (error) {
      throw new ActionableError(
        `simctl launched SpringBoard after ${pressError}, but foreground verification failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async tryIosRunnerHome(
    client: IOSCtrlProxyClient,
    timeoutMs: number,
    perf: PerformanceTracker | undefined,
    frameContext: string | undefined,
    simulator: boolean,
  ): Promise<string | undefined> {
    try {
      const result = await client.requestPressHome(timeoutMs, perf, frameContext);
      if (frameContext && result.error?.includes("Stale frame context")) {
        throw new ActionableError(result.error);
      }
      return result.success ? undefined : (result.error ?? "Runner failed to press Home");
    } catch (error) {
      if (errorMessage(error).includes("Stale frame context")) {
        throw toActionableError(error, "Home press rejected a stale frame context");
      }
      if (!simulator) {
        throw toActionableError(error, "Failed to press iOS home button");
      }
      return errorMessage(error);
    }
  }

  private async checkIosRunnerForeground(
    client: IOSCtrlProxyClient,
    perf: PerformanceTracker | undefined,
    deadline: number | undefined,
  ): Promise<string | undefined> {
    try {
      const hierarchy = await this.readIosHomeForeground(
        client,
        perf,
        Math.min(HomeScreen.IOS_SIMULATOR_READ_TIMEOUT_MS, this.iosHomeRemainingMs(deadline)),
      );
      return hierarchy?.packageName === "com.apple.springboard"
        ? undefined
        : `runner reported success but ${hierarchy?.packageName ?? "unknown app"} remains foreground`;
    } catch (error) {
      logger.warn(`Could not verify runner Home press: ${errorMessage(error)}`, error);
      return `runner foreground check failed: ${errorMessage(error)}`;
    }
  }

  private iosHomeRemainingMs(deadline: number | undefined): number {
    const remaining = deadline === undefined ? 5000 : deadline - this.timer.now();
    if (remaining <= 0) {
      throw new ActionableError("iOS Home deadline exhausted before SpringBoard could be verified");
    }
    return remaining;
  }

  private async verifyIosHomeForeground(
    client: IOSCtrlProxyClient,
    perf?: PerformanceTracker,
    retryDelaysMs: readonly number[] = HomeScreen.IOS_HOME_RETRY_DELAYS_MS,
    timeoutMs: number = HomeScreen.IOS_HOME_VERIFICATION_TIMEOUT_MS,
    readTimeoutMs: number = HomeScreen.IOS_HOME_HIERARCHY_READ_TIMEOUT_MS,
  ): Promise<void> {
    const deadline = this.timer.now() + timeoutMs;
    const backoff = sequenceBackoff(retryDelaysMs);
    let lastHierarchy: CtrlProxyHierarchy | undefined;

    for (let attempt = 0; ; attempt++) {
      const remainingMs = deadline - this.timer.now();
      if (remainingMs <= 0) {
        break;
      }
      const hierarchy = await this.readIosHomeForeground(
        client,
        perf,
        Math.min(remainingMs, readTimeoutMs),
      );
      if (hierarchy) {
        lastHierarchy = hierarchy;
      }
      if (hierarchy?.packageName === "com.apple.springboard" && this.timer.now() < deadline) {
        return;
      }

      if (attempt >= retryDelaysMs.length) {
        break;
      }
      const delayMs = backoff.delayForAttempt(attempt + 1);
      if (this.timer.now() + delayMs >= deadline) {
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
