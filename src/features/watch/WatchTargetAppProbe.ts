import type { BootedDevice } from "../../models";
import {
  findIosSimulatorAppProcess,
  type SimulatorCrashCommandRunner,
} from "../../utils/ios-cmdline-tools/IosCrashBackend";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

const LAUNCHCTL_LIST_TIMEOUT_MS = 5_000;

/** Whether the watch app a runner targets still has a process (#18052). */
export interface WatchTargetAppProbe {
  /** The target bundle ID when it is known and has no process; undefined otherwise. */
  notRunningTarget(device: BootedDevice, signal?: AbortSignal): Promise<string | undefined>;
}

export interface WatchTargetAppProbeDependencies {
  /** The launchApp target of the device's runner, when one is known. */
  targetBundleId(deviceId: string): string | undefined;
  simctl(device: BootedDevice): SimulatorCrashCommandRunner;
}

/** Lists the simulator's launchd services, as crashApp does, and looks for the target app. */
export class LaunchctlWatchTargetAppProbe implements WatchTargetAppProbe {
  constructor(private readonly dependencies: WatchTargetAppProbeDependencies) {}

  async notRunningTarget(device: BootedDevice, signal?: AbortSignal): Promise<string | undefined> {
    const bundleId = this.dependencies.targetBundleId(device.deviceId);
    if (!bundleId) {
      return undefined;
    }
    let stdout: string;
    try {
      const result = await this.dependencies
        .simctl(device)
        .executeCommandArgs(
          ["spawn", device.deviceId, "launchctl", "list"],
          LAUNCHCTL_LIST_TIMEOUT_MS,
          signal,
        );
      stdout = result.stdout;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // Best effort: observe keeps its foreground note when the process list cannot be read.
      logger.warn(
        `[WatchRunner] could not list processes on ${device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
    // An empty list is a failed read, not proof that the app exited.
    if (stdout.trim() === "") {
      return undefined;
    }
    return findIosSimulatorAppProcess(stdout, bundleId) ? undefined : bundleId;
  }
}
