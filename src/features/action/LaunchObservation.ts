import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BootedDevice, DeviceLockState, LaunchAppResult, ObserveResult } from "../../models";
import { DeviceWindowCacheInvalidator } from "./TerminateApp";
import { logger } from "../../utils/logger";
import { resolveMissingForegroundWindow } from "../observe/ObserveScreen";
import { Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import {
  getLaunchObservationPackageNames,
  isLaunchPermissionDialogObservation,
} from "./launchObservationPackages";

const LAUNCH_OBSERVATION_TIMEOUT_MS = 5000;
const LAUNCH_OBSERVATION_POLL_INTERVAL_MS = 200;
const SHADE_COLLAPSE_RETRY_INTERVAL_MS = 1_000;
// One bounded lock re-read before a launch timeout names a SystemUI blocker (#10182).
const LAUNCH_BLOCKER_LOCK_REREAD_TIMEOUT_MS = 3_000;
interface LaunchObservationDependencies {
  device: BootedDevice;
  adb: Pick<AdbExecutor, "executeCommand" | "getDeviceLock">;
  timer: Timer;
  observeScreen: Pick<import("../observe/interfaces/ObserveScreen").ObserveScreen, "execute">;
  cacheInvalidator: DeviceWindowCacheInvalidator;
}
/** Reconciles a launch result against foreground, task and system-overlay evidence. */
export class LaunchObservation {
  constructor(private readonly deps: LaunchObservationDependencies) {}
  async ensureLaunchObservationMatchesPackage(
    result: LaunchAppResult,
    expectedPackageName: string,
    timeoutMs: number = LAUNCH_OBSERVATION_TIMEOUT_MS,
    pollIntervalMs: number = LAUNCH_OBSERVATION_POLL_INTERVAL_MS,
    signal: AbortSignal | undefined,
    options: { coldBoot?: boolean; expectedUserId?: number },
  ): Promise<LaunchAppResult> {
    const { coldBoot, expectedUserId } = options;
    signal?.throwIfAborted();
    result = await this.collapseNotificationShadeIfCovering(result, signal);
    if (
      !result.observation ||
      this.launchObservationMatchesPackage(result.observation, expectedPackageName)
    ) {
      return result;
    }

    if (!result.success) {
      return this.withoutStaleLaunchObservation(result, expectedPackageName, result.observation);
    }

    if (
      this.settleLaunchObservation(result, result.observation, expectedPackageName, expectedUserId)
    ) {
      return result;
    }

    const startTime = this.deps.timer.now();
    let latestObservation = result.observation;
    // Space collapse attempts by one second to avoid an ADB command on every poll.
    let nextShadeCollapseTime = startTime + SHADE_COLLAPSE_RETRY_INTERVAL_MS;

    while (this.deps.timer.now() - startTime < timeoutMs) {
      signal?.throwIfAborted();
      logger.info(
        `[LaunchApp] Launch observation still reports previous app; re-observing for ${expectedPackageName}`,
      );
      await this.deps.timer.sleep(pollIntervalMs);
      latestObservation = await this.deps.observeScreen.execute({
        freshness: "fresh",
        signal,
        skipScreenshot: true,
        skipAccessibilityAudit: true,
        // These are control-flow polls, not user-authored observations. Running
        // the opt-in performance audit here starts its multi-sample ADB loop on
        // every poll, so one 15-second package reconciliation can expand into
        // effectively unbounded sampling and prevent launch from returning.
        skipPerformanceAudit: true,
      });
      signal?.throwIfAborted();
      const collapseRetry = await this.retryNotificationShadeCollapseIfDue(
        result,
        latestObservation,
        expectedPackageName,
        nextShadeCollapseTime,
        signal,
      );
      latestObservation = collapseRetry.observation;
      nextShadeCollapseTime = collapseRetry.nextShadeCollapseTime;
      if (
        this.settleLaunchObservation(result, latestObservation, expectedPackageName, expectedUserId)
      ) {
        return result;
      }
    }

    return this.resolveLaunchObservationTimeout(
      result,
      latestObservation,
      expectedPackageName,
      timeoutMs,
      { coldBoot, expectedUserId, signal },
    );
  }

  private async retryNotificationShadeCollapseIfDue(
    result: LaunchAppResult,
    observation: ObserveResult,
    expectedPackageName: string,
    nextShadeCollapseTime: number,
    signal?: AbortSignal,
  ): Promise<{ observation: ObserveResult; nextShadeCollapseTime: number }> {
    const activeWindow = observation.activeWindow;
    if (
      this.deps.device.platform !== "android" ||
      activeWindow?.appId !== "com.android.systemui" ||
      activeWindow.systemOverlay !== true ||
      this.launchObservationMatchesPackage(observation, expectedPackageName) ||
      this.deps.timer.now() < nextShadeCollapseTime
    ) {
      return { observation, nextShadeCollapseTime };
    }

    const collapseResult = await this.collapseNotificationShadeIfCovering(
      { ...result, observation },
      signal,
    );
    return {
      observation: collapseResult.observation ?? observation,
      nextShadeCollapseTime: this.deps.timer.now() + SHADE_COLLAPSE_RETRY_INTERVAL_MS,
    };
  }

  private async collapseNotificationShadeIfCovering(
    result: LaunchAppResult,
    signal?: AbortSignal,
  ): Promise<LaunchAppResult> {
    const activeWindow = result.observation?.activeWindow;
    if (
      this.deps.device.platform !== "android" ||
      activeWindow?.appId !== "com.android.systemui" ||
      activeWindow.systemOverlay !== true
    ) {
      return result;
    }

    try {
      await this.deps.adb.executeCommand("shell cmd statusbar collapse", {
        signal: combineWithAmbientAbort(signal),
      });
    } catch (error) {
      logger.warn(
        `[LaunchApp] Failed to collapse notification shade: ${errorMessage(error)}`,
        error,
      );
      return result;
    }

    try {
      const observation = await this.deps.observeScreen.execute({
        freshness: "fresh",
        signal,
        skipScreenshot: true,
        skipAccessibilityAudit: true,
        skipPerformanceAudit: true,
      });
      return {
        ...result,
        observation: this.preserveLaunchObservationMetadata(
          observation,
          result.observation ?? observation,
        ),
      };
    } catch (error) {
      logger.warn(
        `[LaunchApp] Failed to re-observe after collapsing notification shade: ${errorMessage(error)}`,
        error,
      );
      return result;
    }
  }

  private async resolveLaunchObservationTimeout(
    result: LaunchAppResult,
    latestObservation: ObserveResult,
    expectedPackageName: string,
    timeoutMs: number,
    options: { coldBoot?: boolean; expectedUserId?: number; signal?: AbortSignal },
  ): Promise<LaunchAppResult> {
    const { coldBoot, expectedUserId, signal } = options;
    // Distinguish "genuinely launched but no foreground window could be read at
    // all" from "observed a different/stale app" (issue #6220 follow-up). The
    // latter is a real mismatch — reject and strip the stale observation, as
    // before. The former is checked via `isMissingForegroundWindow`, a
    // MACHINE-READABLE verdict reused verbatim from the observe freshness gate
    // rather than re-derived from package-name absence: a status-bar-only
    // capture can still carry STALE `packageName`/`foregroundActivity`
    // metadata left over from a previously-resumed app, so "has package
    // names" alone would wrongly classify it as a wrong-app mismatch (issue
    // #6239 review follow-up). Checking the verdict FIRST — before
    // package-count — means a status-bar-only/no-window capture is preserved
    // as a structured `verified: false` + `verifyFailureReason` no matter what
    // stale attribution it still carries; only a genuinely COMPLETE capture (a
    // real foreground window) naming a different app falls through to the
    // wrong-app reject path below.
    if (this.isMissingForegroundWindow(latestObservation)) {
      logger.warn(
        `[LaunchApp] Launch observation for ${expectedPackageName} reports no foreground window after ${timeoutMs}ms; preserving it for the response instead of rejecting it as a stale/wrong-app capture`,
      );
      result.observation = this.preserveLaunchObservationMetadata(
        latestObservation,
        result.observation ?? latestObservation,
      );
      return result;
    }

    if (
      this.verifyLaunchObservationFromTaskRoot(
        result,
        latestObservation,
        expectedPackageName,
        expectedUserId,
      )
    ) {
      return result;
    }

    const foregroundDescription = this.describeLaunchObservationPackages(latestObservation);
    const lock = await this.resolveLockForLaunchBlocker(latestObservation, signal);
    return this.withoutStaleLaunchObservation(
      {
        ...result,
        success: false,
        error: `Timed out waiting for launch observation to show ${expectedPackageName}; last observation reported ${foregroundDescription} in the foreground — ${this.describeLaunchObservationBlocker(latestObservation, lock, foregroundDescription, expectedPackageName, coldBoot)}`,
      },
      expectedPackageName,
      latestObservation,
    );
  }

  private isSystemUiOverlayObservation(observation: ObserveResult): boolean {
    const activeWindow = observation.activeWindow;
    return activeWindow?.appId === "com.android.systemui" && activeWindow.systemOverlay === true;
  }

  private async resolveLockForLaunchBlocker(
    observation: ObserveResult,
    signal?: AbortSignal,
  ): Promise<DeviceLockState | undefined> {
    if (
      this.deps.device.platform !== "android" ||
      !this.isSystemUiOverlayObservation(observation) ||
      observation.deviceLock?.locked === true ||
      signal?.aborted
    ) {
      return observation.deviceLock;
    }
    try {
      const fresh = await raceWithDeadline(() => this.deps.adb.getDeviceLock(signal), {
        timer: this.deps.timer,
        timeoutMs: LAUNCH_BLOCKER_LOCK_REREAD_TIMEOUT_MS,
        signal,
        label: "Launch blocker lock re-read",
        relabelDefaultAbort: false,
      });
      return fresh ?? observation.deviceLock;
    } catch (error) {
      logger.warn(
        `[LaunchApp] Lock re-read for the launch timeout message failed: ${errorMessage(error)}`,
        error,
      );
      return observation.deviceLock;
    }
  }

  private describeLaunchObservationBlocker(
    latestObservation: ObserveResult,
    lock: DeviceLockState | undefined,
    foregroundDescription: string,
    expectedPackageName: string,
    coldBoot?: boolean,
  ): string {
    // The hierarchy read itself can name the keyguard (`device_locked`) when the
    // lock sample is missing from the observation.
    if (
      lock?.locked === true ||
      latestObservation.viewHierarchy?.hierarchy?.unavailableReason === "device_locked"
    ) {
      return "the device is locked (the lock screen is covering the app); call `wakeAndUnlock` first.";
    }

    if (this.isSystemUiOverlayObservation(latestObservation)) {
      // Only a lock sample that says "not locked" makes the shade the evidence-backed
      // cause. Without one, a keyguard the lock read missed looks identical (#10182).
      return lock?.locked === false
        ? "the system UI (notification shade) is covering the app."
        : "the system UI is covering the app and the lock state could not be determined, so it may be the lock screen or the notification shade; call `wakeAndUnlock` to clear a lock screen, or collapse the shade, then retry.";
    }

    if (coldBoot) {
      return `\`${foregroundDescription}\` is in the foreground instead of \`${expectedPackageName}\`; terminate it or verify the launch target.`;
    }

    return "pass coldBoot: true to reset to the launcher activity, or call terminateApp first.";
  }

  private settleLaunchObservation(
    result: LaunchAppResult,
    observation: ObserveResult,
    expectedPackageName: string,
    expectedUserId?: number,
  ): boolean {
    if (this.launchObservationMatchesPackage(observation, expectedPackageName)) {
      result.observation = this.preserveLaunchObservationMetadata(
        observation,
        result.observation ?? observation,
      );
      return true;
    }

    return this.verifyLaunchObservationFromTaskRoot(
      result,
      observation,
      expectedPackageName,
      expectedUserId,
    );
  }

  private withoutStaleLaunchObservation(
    result: LaunchAppResult,
    expectedPackageName: string,
    staleObservation: ObserveResult,
  ): LaunchAppResult {
    this.deps.cacheInvalidator.invalidate(this.deps.device);
    const reportedPackages = this.describeLaunchObservationPackages(staleObservation);
    logger.warn(
      `[LaunchApp] Omitting stale launch observation for ${expectedPackageName}; ` +
        `last observation reported ${reportedPackages}`,
    );
    const resultWithoutObservation = { ...result };
    delete resultWithoutObservation.observation;
    // Explain the omission (issue #5872) so the payload shape is deterministic:
    // a launch either carries `observation` or carries `observationOmitted`
    // naming why, never a silently-vanishing observation.
    resultWithoutObservation.observationOmitted = {
      reason: "stale_launch_observation",
      expectedPackage: expectedPackageName,
      reportedPackages,
    };
    return resultWithoutObservation;
  }

  private preserveLaunchObservationMetadata(
    observation: ObserveResult,
    previousObservation: ObserveResult,
  ): ObserveResult {
    return {
      ...observation,
      gfxMetrics: observation.gfxMetrics ?? previousObservation.gfxMetrics,
      perfTiming: observation.perfTiming ?? previousObservation.perfTiming,
    };
  }

  launchObservationMatchesPackage(
    observation: ObserveResult,
    expectedPackageName: string,
  ): boolean {
    if (!this.isLaunchObservationFresh(observation)) {
      return false;
    }

    if (this.isLaunchPermissionDialogObservation(observation)) {
      return true;
    }

    const packageNames = this.getLaunchObservationPackageNames(observation);
    return (
      packageNames.length === 0 ||
      packageNames.every((packageName) => packageName === expectedPackageName)
    );
  }

  private isLaunchPermissionDialogObservation(observation: ObserveResult): boolean {
    return isLaunchPermissionDialogObservation(observation);
  }

  private describeLaunchObservationPackages(observation: ObserveResult): string {
    const packageNames = this.getLaunchObservationPackageNames(observation);
    return packageNames.length > 0 ? packageNames.join(", ") : "unknown app";
  }

  private getLaunchObservationPackageNames(observation: ObserveResult): string[] {
    return getLaunchObservationPackageNames(observation);
  }

  private isLaunchObservationFresh(observation: ObserveResult): boolean {
    return observation.freshness?.isFresh !== false && observation.freshness?.verified !== false;
  }

  private isForegroundTaskRootedAtPackage(
    observation: ObserveResult,
    expectedPackageName: string,
    expectedUserId?: number,
  ): boolean {
    const currentTaskId = observation.backStack?.currentTaskId;
    if (currentTaskId === undefined) {
      return false;
    }

    const currentTask = observation.backStack?.tasks.find((task) => task.id === currentTaskId);
    return (
      (expectedUserId === undefined ||
        currentTask?.userId === undefined ||
        currentTask.userId === expectedUserId) &&
      (currentTask?.packageName === expectedPackageName ||
        currentTask?.rootActivity?.split("/")[0] === expectedPackageName)
    );
  }

  private isForegroundTaskLaunchedByPackage(
    observation: ObserveResult,
    expectedPackageName: string,
    expectedUserId?: number,
  ): boolean {
    const currentTaskId = observation.backStack?.currentTaskId;
    if (currentTaskId === undefined) {
      return false;
    }

    const currentTask = observation.backStack?.tasks.find((task) => task.id === currentTaskId);
    return (
      (expectedUserId === undefined ||
        currentTask?.userId === undefined ||
        currentTask.userId === expectedUserId) &&
      currentTask?.launchedFromPackage === expectedPackageName
    );
  }

  private verifyLaunchObservationFromTaskRoot(
    result: LaunchAppResult,
    observation: ObserveResult,
    expectedPackageName: string,
    expectedUserId?: number,
  ): boolean {
    // Issue #7218 P1 follow-up: a SystemUI surface can cover the previously
    // foregrounded task, so its back stack must not verify the launch.
    if (
      !this.isLaunchObservationFresh(observation) ||
      observation.activeWindow?.systemOverlay === true
    ) {
      return false;
    }

    const foregroundActivityPackage = this.getLaunchObservationPackageNames(observation).find(
      (packageName) => packageName !== expectedPackageName,
    );
    if (!foregroundActivityPackage) {
      return false;
    }

    if (this.isForegroundTaskRootedAtPackage(observation, expectedPackageName, expectedUserId)) {
      result.observation = this.preserveLaunchObservationMetadata(
        observation,
        result.observation ?? observation,
      );
      result.foregroundActivityPackage = foregroundActivityPackage;
      result.verifiedBy = "task-root";
      return true;
    }

    // Provenance alone is intentional: a companion task started by the target
    // in an earlier session (or restored after the target crashes during launch)
    // can false-verify because no pre-launch task snapshot exists to age it out.
    if (!this.isForegroundTaskLaunchedByPackage(observation, expectedPackageName, expectedUserId)) {
      return false;
    }

    result.observation = this.preserveLaunchObservationMetadata(
      observation,
      result.observation ?? observation,
    );
    result.foregroundActivityPackage = foregroundActivityPackage;
    result.verifiedBy = "task-provenance";
    return true;
  }

  private isMissingForegroundWindow(observation: ObserveResult): boolean {
    return (
      resolveMissingForegroundWindow(observation) !== undefined ||
      this.getLaunchObservationPackageNames(observation).length === 0
    );
  }
}
