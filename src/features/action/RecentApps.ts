import { errorMessage } from "../../utils/describeUnknownError";
import { throwIfAborted, awaitWhileRequestIsLive } from "../../utils/toolUtils";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { ActionableError, BootedDevice, RecentAppsResult, ObserveResult } from "../../models";
import { PressButton } from "./PressButton";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";
import { isForegroundLauncher } from "../observe/androidLauncherPackages";
import { deviceIncarnationToken } from "../../utils/deviceIncarnation";
import { logger } from "../../utils/logger";

const POST_NAVIGATION_VERIFY_READS = 2;
const POST_NAVIGATION_VERIFY_DELAY_MS = 250;

/**
 * Opens the recent apps screen.
 *
 * Android always uses the accessibility global action, with KEYCODE_APP_SWITCH as the
 * fallback. Both work in every navigation mode (gesture, 2-button, 3-button), so no
 * navigation-style detection is needed and nothing in the foreground app's hierarchy
 * is ever tapped or swiped (#9979).
 */
export class RecentApps extends BaseVisualChange {
  private pressButton: PressButton;

  constructor(device: BootedDevice, adb: AdbExecutor | null = null, timer: Timer = defaultTimer) {
    super(device, adb, timer);
    this.pressButton = new PressButton(device, adb);
  }

  /**
   * Execute recent apps navigation
   * @param progress - Optional progress callback
   * @returns Result of the recent apps operation
   */
  async execute(progress?: ProgressCallback, signal?: AbortSignal): Promise<RecentAppsResult> {
    throwIfAborted(signal);
    const perf = createGlobalPerformanceTracker();
    perf.serial("recentApps");

    if (this.device.platform === "ios") {
      return this.observedInteraction(
        async () => {
          return perf.track("iOSRecentApps", () => this.executeIosRecentApps(signal));
        },
        {
          usesObservationForResolution: false,
          changeExpected: true,
          foregroundAppMayChange: true,
          timeoutMs: 5000,
          progress,
          signal,
          perf,
        },
      );
    }

    const options = {
      usesObservationForResolution: false,
      changeExpected: true,
      foregroundAppMayChange: true,
      timeoutMs: 3000,
      progress,
      signal,
      perf,
    };
    const result: RecentAppsResult = await this.observedInteraction(async () => {
      // A cached overview could describe a screen the user has since left.
      const current = await this.readFreshObservation(options.timeoutMs, signal);
      if (await this.isAndroidOverview(current, signal)) {
        options.changeExpected = false;
        return { success: true, method: "hardware" };
      }
      return perf.track("hardwareNavigation", () => this.executeHardwareNavigation(signal));
    }, options);
    // Keep indeterminate delivery failures intact; never retry a toggle to verify it.
    if (result.success && !(await this.confirmOverviewOpened(result.observation, signal))) {
      result.success = false;
      result.error = "Android recent apps overview could not be verified after navigation";
    }
    return result;
  }

  /**
   * `requireFreshExtraction` only forces a device capture when the read carries a
   * `minTimestamp` floor; without it the hierarchy source serves its cached tree
   * (`Cache hit ... fresh: false`), which this check would then treat as "not open"
   * and press Recents again, closing an open overview (#10349). Stamp each read
   * with the device clock so only a tree extracted after the call is accepted, and
   * re-read once when the first read is still reported stale.
   */
  private async readFreshObservation(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ObserveResult> {
    let observation: ObserveResult | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const minTimestamp = await awaitWhileRequestIsLive(
        this.adb.getDeviceTimestampMs(),
        signal,
      );
      observation = await awaitWhileRequestIsLive(
        this.observeScreen.execute({
          freshness: "fresh",
          requireFreshExtraction: true,
          minTimestamp,
          skipCache: true,
          skipScreenshot: true,
          skipAccessibilityAudit: true,
          skipPerformanceAudit: true,
          timeoutMs,
          signal,
        }),
        signal,
      );
      if (observation.freshness?.isFresh !== false) {
        break;
      }
    }
    return observation as ObserveResult;
  }

  /**
   * The settle observation can be a cached or mid-transition tree, so a miss is
   * re-checked with bounded genuinely fresh reads before reporting a failure.
   */
  private async confirmOverviewOpened(
    observation: ObserveResult | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (await this.isAndroidOverview(observation, signal)) {
      return true;
    }
    for (let attempt = 0; attempt < POST_NAVIGATION_VERIFY_READS; attempt++) {
      await this.timer.sleep(POST_NAVIGATION_VERIFY_DELAY_MS);
      const fresh = await this.readFreshObservation(3000, signal);
      if (await this.isAndroidOverview(fresh, signal)) {
        return true;
      }
    }
    return false;
  }

  private async isAndroidOverview(
    observation: ObserveResult | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { viewHierarchy: hierarchy, freshness } = observation ?? {};
    if (!hierarchy || hierarchy.hierarchy.error || hierarchy.ctrlProxyIncomplete) {
      return false;
    }
    if (freshness && (!freshness.isFresh || freshness.verified === false)) {
      return false;
    }
    const packageName = hierarchy.packageName;
    if (!packageName) {
      return false;
    }
    // Reuse the launcher surface vocabulary used by HomeScreen. Home and all-apps
    // share the launcher window, so its package alone is insufficient evidence.
    const overview = new ResolverElementSelector().resolveContainerMatch(hierarchy, {
      elementId: `${packageName}:id/overview_panel`,
    });
    if (overview?.visibleToUser !== true) {
      return false;
    }
    return isForegroundLauncher(
      packageName,
      this.adb,
      this.device.deviceId,
      this.timer,
      deviceIncarnationToken(this.device.deviceId),
      signal,
      3000,
    );
  }

  /**
   * Open Recents with the accessibility global action, falling back to
   * KEYCODE_APP_SWITCH when the action was provably not delivered.
   * @returns Recent apps result
   */
  private async executeHardwareNavigation(signal?: AbortSignal): Promise<RecentAppsResult> {
    let dispatched = false;
    const indeterminateResult = (reason: string | undefined): RecentAppsResult => ({
      success: false,
      method: "hardware",
      error: `Recent apps press outcome is indeterminate: the request was dispatched but no result was confirmed (${reason ?? "unknown error"}). The press may have been applied. Do not retry automatically. Observe before retrying.`,
    });
    // Try accessibility service global action first
    try {
      const client = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
      throwIfAborted(signal);
      const result = await awaitWhileRequestIsLive(
        client.requestGlobalAction("recent", 3000, undefined, undefined, signal, () => {
          dispatched = true;
        }),
        signal,
      );
      if (result.success) {
        logger.debug("[RECENT_APPS] Used accessibility service global action");
        return { success: true, method: "hardware" };
      }
      if (dispatched && !result.acknowledged) {
        return indeterminateResult(result.error);
      }
      logger.debug(`[RECENT_APPS] Global action failed (${result.error}), falling back to ADB`);
    } catch (error) {
      throwIfAborted(signal);
      logger.warn("[RECENT_APPS] Global action unavailable", error);
      if (dispatched) {
        return indeterminateResult(errorMessage(error));
      }
    }

    throwIfAborted(signal);
    await awaitWhileRequestIsLive(this.adb.executeCommand("shell input keyevent 187"), signal);
    return { success: true, method: "hardware" };
  }

  private async executeIosRecentApps(signal?: AbortSignal): Promise<RecentAppsResult> {
    const client = IOSCtrlProxyClient.getInstance(this.device);
    throwIfAborted(signal);
    const result = await client.requestRecentApps(undefined, undefined, undefined, signal);
    if (!result.success && result.dispatched && result.acknowledged === false) {
      // Preserve the uncertain dispatch before post-action reads can replace it with cancellation.
      throw new ActionableError(
        `Recent apps press outcome is indeterminate: the request was dispatched but no result was confirmed (${result.error ?? "unknown error"}). The press may have been applied. Do not retry automatically. Observe before retrying.`,
      );
    }
    return {
      success: result.success,
      method: "ios_swipe",
      error: result.success ? undefined : (result.error ?? "Failed to open iOS recent apps"),
    };
  }
}
