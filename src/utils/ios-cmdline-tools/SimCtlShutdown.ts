import {
  SIMCTL_COMMAND_TIMEOUT_MS,
  SHUTDOWN_SETTLE_MS,
  LAUNCHD_SIM_PROBE_TIMEOUT_MS,
  SHUTDOWN_SETTLE_BACKOFF,
  SimulatorBootLease,
} from "./SimCtlSupport";

import { errorMessage } from "../describeUnknownError";

import { logger } from "../logger";
import { ExecResult, ActionableError, BootedDevice } from "../../models";
import { Timer } from "../SystemTimer";
import { raceWithDeadline } from "../raceWithDeadline";

import {
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  SIMULATOR_SHUTDOWN_LEASE_WAIT_TIMEOUT_MS,
} from "../deviceTimeouts";

import { getAbortSignal } from "../AbortContext";

import { SimulatorStillShuttingDownError } from "./SimulatorStillShuttingDownError";

export interface SimCtlShutdownContext {
  executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
  invalidateDeviceListCache(): void;
  timer: Timer;
  acquireSimulatorBoot(
    udid: string,
    deadlineMs: number | undefined,
    signal: AbortSignal | undefined,
    operation?: "start" | "shut down" | "erase",
  ): Promise<SimulatorBootLease>;
  executeCommandArgv(
    args: string[],
    timeoutMs?: number,
    displayCommand?: string,
    explicitSignal?: AbortSignal,
    waitForTimedOutCommandSettlement?: boolean,
    env?: NodeJS.ProcessEnv,
  ): Promise<ExecResult>;
  readSimulatorState(udid: string, timeoutMs: number): Promise<string | undefined>;
  execAsync: (
    file: string,
    args: string[],
    maxBuffer?: number,
    signal?: AbortSignal,
    env?: NodeJS.ProcessEnv,
  ) => Promise<ExecResult>;
}
export class SimCtlShutdown {
  constructor(private readonly context: SimCtlShutdownContext) {}

  async shutdownAfterFailedStart(udid: string): Promise<void> {
    try {
      // Cleanup must not inherit the already-aborted request signal.
      const cleanupSignal = new AbortController().signal;
      await this.context.executeCommandArgs(["shutdown", udid], 10_000, cleanupSignal);
      this.context.invalidateDeviceListCache();
    } catch (error) {
      logger.warn(`[iOS] Failed to shut down simulator ${udid} after unsuccessful start: ${error}`);
    }
  }

  async shutdownSimulatorCoordinated(
    udid: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    expectedOwnerToken?: object,
  ): Promise<void> {
    // Waiting for an active boot must not consume the shutdown command's own
    // timeout, so the queue wait gets its own dedicated deadline instead of
    // `timeoutMs`. That deadline is still a hard ceiling, independent of
    // `signal`: callers with no ambient abort signal (CI boot recovery, a boot
    // handle's cleanup) must not queue forever behind a wedged boot (issue #6577).
    // Once the lease is acquired, simctl shutdown receives the complete timeoutMs budget.
    const leaseDeadlineMs = this.context.timer.now() + SIMULATOR_SHUTDOWN_LEASE_WAIT_TIMEOUT_MS;
    const lease = await this.context.acquireSimulatorBoot(
      udid,
      leaseDeadlineMs,
      signal,
      "shut down",
    );
    try {
      if (
        expectedOwnerToken !== undefined &&
        (!lease.state.lastBootSucceeded || lease.state.ownerToken !== expectedOwnerToken)
      ) {
        return;
      }
      await this.context.executeCommandArgv(
        ["shutdown", udid],
        timeoutMs,
        `shutdown ${udid}`,
        signal,
        true,
      );
      this.context.invalidateDeviceListCache();
      lease.state.lastBootSucceeded = false;
      lease.state.ownerToken = undefined;
    } finally {
      lease.release();
    }
  }

  async killSimulator(
    device: BootedDevice,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    logger.debug(`Killing iOS simulator ${device.deviceId}`);
    const signal = options.signal ?? getAbortSignal();
    await this.shutdownSimulatorCoordinated(device.deviceId, options.timeoutMs ?? 10_000, signal);
    await this.verifyShutdownSettled(device, signal);
  }

  async verifyShutdownSettled(device: BootedDevice, signal?: AbortSignal): Promise<void> {
    const startedMs = this.context.timer.now();
    const deadlineMs = startedMs + SHUTDOWN_SETTLE_MS;
    let observedShutdown = false;
    let state: string | undefined;
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      const remainingMs = deadlineMs - this.context.timer.now();
      if (remainingMs <= 0) {
        await this.assertShutdownSettled(device, state, observedShutdown, startedMs, signal);
        return;
      }
      try {
        state = await raceWithDeadline(
          () => this.context.readSimulatorState(device.deviceId, remainingMs),
          {
            timer: this.context.timer,
            signal,
            label: "iOS simulator shutdown state read",
          },
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (
          state !== "Shutdown" ||
          deadlineMs - this.context.timer.now() > SHUTDOWN_SETTLE_BACKOFF.delayForAttempt(attempt)
        ) {
          throw error;
        }
        // The final probe may exhaust its budget; the last successful read already confirmed Shutdown.
        logger.debug(
          `[iOS] Keeping confirmed Shutdown for ${device.deviceId} after late state read failed: ${errorMessage(error)}`,
        );
      }
      if (observedShutdown && state === "Booted") {
        throw await this.revivedSimulatorError(device, signal);
      }
      observedShutdown ||= state === "Shutdown";
      await raceWithDeadline(
        () =>
          this.context.timer.sleep(
            Math.min(
              SHUTDOWN_SETTLE_BACKOFF.delayForAttempt(attempt),
              Math.max(0, deadlineMs - this.context.timer.now()),
            ),
          ),
        { timer: this.context.timer, signal, label: "iOS simulator shutdown polling" },
      );
    }
  }

  async assertShutdownSettled(
    device: BootedDevice,
    state: string | undefined,
    observedShutdown: boolean,
    startedMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (state === "Shutdown") {
      return;
    }
    if (!observedShutdown && state !== undefined) {
      const waitedMs = this.context.timer.now() - startedMs;
      const pid = await this.probeLaunchdSimPid(device.deviceId, signal);
      throw new SimulatorStillShuttingDownError(device.deviceId, device.name, state, waitedMs, pid);
    }
    throw new ActionableError(
      `iOS simulator '${device.name}' did not remain Shutdown after shutdown (state: ${state ?? "unknown"}).`,
    );
  }

  async probeLaunchdSimPid(udid: string, signal?: AbortSignal): Promise<number | undefined> {
    const timeoutError = new Error("launchd_sim process probe timed out");
    try {
      const result = await raceWithDeadline(
        () =>
          this.context.execAsync(
            "pgrep",
            [
              "-f",
              `launchd_sim .*CoreSimulator/Devices/${udid}/data/var/run/launchd_bootstrap[.]plist`,
            ],
            undefined,
            signal,
          ),
        {
          timer: this.context.timer,
          timeoutMs: LAUNCHD_SIM_PROBE_TIMEOUT_MS,
          signal,
          label: "launchd_sim process probe",
          timeoutError: () => timeoutError,
        },
      );
      const pid = Number(result.stdout.trim().match(/^\d+$/m)?.[0]);
      if (Number.isSafeInteger(pid) && pid > 0) {
        return pid;
      }
      logger.debug(`[iOS] launchd_sim process probe found no PID for ${udid}`);
      return undefined;
    } catch (error) {
      signal?.throwIfAborted();
      // pgrep exits 1 with no match; PID enrichment is optional and never authorizes signalling.
      if (error === timeoutError) {
        logger.warn(`[iOS] launchd_sim process probe timed out for ${udid}`);
      } else {
        logger.debug(`[iOS] launchd_sim process probe found no process: ${errorMessage(error)}`);
      }
      return undefined;
    }
  }

  async revivedSimulatorError(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<ActionableError> {
    let deviceHubRunning = false;
    try {
      // DeviceHub.app runs DevicesTrampoline, so match the app path instead of its executable name.
      const result = await this.context.execAsync(
        "pgrep",
        ["-f", "/DeviceHub.app/Contents/"],
        undefined,
        signal,
      );
      deviceHubRunning = /^\d+$/m.test(result.stdout.trim());
    } catch (error) {
      // pgrep exits 1 when Device Hub is not running.
      logger.debug(`[iOS] Device Hub process probe found no process: ${errorMessage(error)}`);
    }
    return new ActionableError(
      `iOS simulator '${device.name}' was revived after shutdown.` +
        (deviceHubRunning
          ? " Device Hub is running; close Device Hub or stop displaying this device, then try again."
          : " Close the application displaying this device, then try again."),
    );
  }

  async eraseSimulator(udid: string): Promise<void> {
    logger.debug(`Erasing iOS simulator ${udid}`);
    const signal = getAbortSignal();
    // Erase mutates the same device a boot or shutdown is working on, so it queues
    // behind them under the same lease (bounded, even with no abort signal) and
    // leaves a cold simulator whose cached "booted" listing is stale (#11122).
    const lease = await this.context.acquireSimulatorBoot(
      udid,
      this.context.timer.now() + SIMULATOR_SHUTDOWN_LEASE_WAIT_TIMEOUT_MS,
      signal,
      "erase",
    );
    try {
      await this.context.executeCommandArgv(
        ["erase", udid],
        SIMCTL_COMMAND_TIMEOUT_MS,
        `erase ${udid}`,
        signal,
        true,
      );
      lease.state.lastBootSucceeded = false;
      lease.state.ownerToken = undefined;
    } finally {
      this.context.invalidateDeviceListCache();
      lease.release();
    }
  }

  /**
   * Delete a simulator by UDID
   * @param udid - Device UDID to delete
   * @returns Promise that resolves when deletion is complete
   */
  async deleteSimulator(
    udid: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    logger.debug(`Deleting iOS simulator ${udid}`);
    const lease = await this.context.acquireSimulatorBoot(
      udid,
      this.context.timer.now() + (options.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS),
      options.signal,
    );
    try {
      await this.context.executeCommandArgv(
        ["delete", udid],
        options.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS,
        `delete ${udid}`,
        options.signal,
        true,
      );
      lease.state.lastBootSucceeded = false;
      lease.state.ownerToken = undefined;
      this.context.invalidateDeviceListCache();
    } finally {
      lease.release();
    }
  }
}
