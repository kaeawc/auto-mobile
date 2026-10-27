import { getHostEmulatorProcessStopper } from "../../devices/hostEmulatorProcessStopper";
import type { HostChildProcess as ChildProcess } from "../../utils/HostCommandExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { ActionableError, BootedDevice, DeviceInfo } from "../../models";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { getAbortSignal, runWithAbortSignal } from "../../utils/AbortContext";
import { UnconfirmedRecoveryShutdownError } from "../UnconfirmedRecoveryShutdownError";
import type { PooledDevice } from "../devicePoolTypes";
import { ANDROID_OFFLINE_PROBE_TIMEOUT_MS, StopDiscoveredEmulatorOptions } from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface EmulatorLifecycleOperations {
  stopDiscoveredEmulatorByAvdName(
    options: StopDiscoveredEmulatorOptions,
  ): Promise<"stopped" | "same-avd">;
  stopRecoveryTargetMissingFromOnlineList(options: {
    avdName: string;
    deviceId: string;
    adoptOnly: boolean;
    discover: () => Promise<BootedDevice[]>;
    signal: AbortSignal;
    deadlineMs: number;
  }): Promise<"stopped">;
  confirmRecoveryStop(
    avdName: string,
    deviceId: string,
    discover: () => Promise<BootedDevice[]>,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<"stopped">;
  isAndroidSerialHeldOffline(
    avdName: string,
    deviceId: string,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<boolean>;
  stopEmulatorProcess(
    childProcess: ChildProcess | null | undefined,
    retainLeaseUntil?: (settlement: Promise<unknown>) => void,
  ): Promise<void>;
  trackStartedDeviceProcess(
    device: BootedDevice,
    childProcess: ChildProcess | null | undefined,
  ): Promise<void>;
  hasStartedDeviceProcess(deviceId: string, childProcess: ChildProcess | null | undefined): boolean;
  getCompletedProcessExit(childProcess: ChildProcess):
    | {
        code: number | null;
        signal: NodeJS.Signals | null;
      }
    | undefined;
  evictStartedDeviceAfterProcessExit(
    deviceId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void>;
  suppressAutoStartForDevice(device: PooledDevice): void;
  clearAutoStartSuppressionForBootedDevice(device: BootedDevice, sourceImage?: DeviceInfo): void;
}
type EmulatorLifecycleState = Pick<
  DevicePoolState,
  | "timer"
  | "deviceManager"
  | "recoveryCoordinator"
  | "emulatorProcessLifecycle"
  | "onDeviceProcessStarted"
  | "deviceAutoStart"
>;
export type EmulatorLifecycleCallbacks = Pick<
  DevicePoolOperations,
  "isPooledEntryCurrent" | "detachSessionForAndroidRecovery" | "removeDevice" | "addDevice"
>;

/** Emulator Lifecycle responsibilities of DevicePool. */
export class DevicePoolEmulatorLifecycle {
  constructor(
    private readonly state: EmulatorLifecycleState,
    private readonly callbacks: EmulatorLifecycleCallbacks,
  ) {}
  async stopDiscoveredEmulatorByAvdName(
    options: StopDiscoveredEmulatorOptions,
  ): Promise<"stopped" | "same-avd"> {
    const {
      disconnectedDevice,
      avdName,
      retainLeaseUntil,
      adoptOnly,
      handoffOwner,
      preservedSessionId,
      preservedSession,
    } = options;
    const timeoutMs = 30000;
    const deadlineMs = this.state.timer.now() + timeoutMs;
    const deadlineController = new AbortController();
    const callerSignal = getAbortSignal();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadlineController.signal])
      : deadlineController.signal;
    const timeoutError = new ActionableError(
      `Android emulator '${avdName}' shutdown was not confirmed within ${timeoutMs}ms; recovery will not relaunch it`,
    );
    let shutdown: Promise<"stopped" | "same-avd"> | undefined;
    const startShutdown = () =>
      (shutdown = runWithAbortSignal(signal, async (): Promise<"stopped" | "same-avd"> => {
        const discover = async () => {
          signal.throwIfAborted();
          const discovery = await this.state.deviceManager.getBootedDevicesDetailed("android", {
            bypassAndroidDeviceListCache: true,
          });
          signal.throwIfAborted();
          if (!discovery.succeededPlatforms.has("android")) {
            throw new ActionableError(
              `Android discovery failed while confirming '${avdName}' shutdown; recovery will not relaunch it`,
            );
          }
          if (discovery.devices.some((device) => device.name.startsWith("Unknown ("))) {
            throw new ActionableError(
              `Android discovery contains an unresolved emulator identity while stopping '${avdName}'; recovery will not relaunch it`,
            );
          }
          return discovery.devices;
        };
        const booted = await discover();
        const matchingAvds = booted.filter(
          (device) => device.platform === "android" && device.name === avdName,
        );
        if (matchingAvds.length > 1) {
          throw new ActionableError(
            `Multiple running emulators identify as '${avdName}'; recovery will not relaunch it`,
          );
        }
        const matchingAvd = matchingAvds[0];
        if (!matchingAvd) {
          return await this.stopRecoveryTargetMissingFromOnlineList({
            avdName,
            deviceId: disconnectedDevice.id,
            adoptOnly,
            discover,
            signal,
            deadlineMs,
          });
        }
        if (matchingAvd.deviceId !== disconnectedDevice.id || adoptOnly) {
          if (matchingAvd.deviceId === disconnectedDevice.id) {
            if (
              !this.callbacks.isPooledEntryCurrent(disconnectedDevice) ||
              !this.callbacks.detachSessionForAndroidRecovery(
                disconnectedDevice,
                preservedSessionId,
                preservedSession,
              )
            ) {
              throw new ActionableError(
                `Android emulator '${avdName}' changed ownership during recovery; recovery will not relaunch it`,
              );
            }
            this.state.recoveryCoordinator.setAndroidRecoveryHandoffOwner(
              matchingAvd.deviceId,
              handoffOwner,
            );
            await this.callbacks.removeDevice(disconnectedDevice.id, true, disconnectedDevice);
          } else {
            this.state.recoveryCoordinator.setAndroidRecoveryHandoffOwner(
              matchingAvd.deviceId,
              handoffOwner,
            );
          }
          await this.callbacks.addDevice(matchingAvd, disconnectedDevice.androidImage);
          signal.throwIfAborted();
          return "same-avd";
        }
        await this.state.deviceManager.killDevice(matchingAvd, {
          processStop: {
            stopper: getHostEmulatorProcessStopper(this.state.timer),
            expectedAvdName: avdName,
          },
          timeoutMs: Math.max(1, deadlineMs - this.state.timer.now()),
          signal,
        });
        signal.throwIfAborted();
        return await this.confirmRecoveryStop(
          avdName,
          matchingAvd.deviceId,
          discover,
          signal,
          deadlineMs,
        );
      }));
    try {
      return await raceWithDeadline(startShutdown, {
        timer: this.state.timer,
        timeoutMs,
        signal: callerSignal,
        label: "Android emulator shutdown confirmation",
        timeoutError: () => {
          deadlineController.abort(timeoutError);
          return timeoutError;
        },
      });
    } catch (error) {
      // A late command must settle before another lifecycle owner may mutate
      // this AVD. Failure propagates before pool/session detachment or relaunch.
      if (shutdown) {
        retainLeaseUntil(shutdown);
      }
      throw new UnconfirmedRecoveryShutdownError(avdName, error);
    }
  }

  /**
   * The AVD is absent from the online-only list before any kill. That is not proof
   * its emulator stopped: a transport that dropped to adb `offline` leaves the
   * process running and holding the AVD (#10074, #10100). When the recovery's own
   * serial is still listed `offline`, send the console kill through the client's
   * offline handling (`force` is what makes it dispatch to a serial that is attached
   * but not online; the serial was just probed, so the only residual is a replacement
   * taking it inside that window), then confirm the exit like any other kill. An
   * adopt-only recovery never kills: its tracked process already exited. A serial
   * absent from adb, or an unavailable probe, keeps the earlier answer.
   */
  async stopRecoveryTargetMissingFromOnlineList(options: {
    avdName: string;
    deviceId: string;
    adoptOnly: boolean;
    discover: () => Promise<BootedDevice[]>;
    signal: AbortSignal;
    deadlineMs: number;
  }): Promise<"stopped"> {
    const { avdName, deviceId, adoptOnly, discover, signal, deadlineMs } = options;
    if (
      adoptOnly ||
      !(await this.isAndroidSerialHeldOffline(avdName, deviceId, signal, deadlineMs))
    ) {
      return "stopped";
    }
    await this.state.deviceManager.killDevice(
      { deviceId, name: avdName, platform: "android" },
      {
        timeoutMs: Math.max(1, deadlineMs - this.state.timer.now()),
        signal,
        force: true,
        processStop: {
          stopper: getHostEmulatorProcessStopper(this.state.timer),
          expectedAvdName: avdName,
        },
      },
    );
    signal.throwIfAborted();
    return await this.confirmRecoveryStop(avdName, deviceId, discover, signal, deadlineMs);
  }

  async confirmRecoveryStop(
    avdName: string,
    deviceId: string,
    discover: () => Promise<BootedDevice[]>,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<"stopped"> {
    for (;;) {
      const devices = await discover();
      // A same-AVD replacement still holds the image's locks; a different
      // AVD reusing the old serial must be preserved without another kill.
      const stillPresent = devices.some((device) => device.name === avdName);
      // The online-only list also lacks an emulator that dropped to adb `offline`
      // mid-kill while its process still runs (#10100).
      if (
        !stillPresent &&
        !(await this.isAndroidSerialHeldOffline(avdName, deviceId, signal, deadlineMs))
      ) {
        logger.info(
          `[DevicePool] Confirmed untracked Android emulator ${avdName} stopped before recovery`,
        );
        return "stopped";
      }
      await this.state.timer.sleep(
        Math.min(1000, Math.max(0, deadlineMs - this.state.timer.now())),
      );
      signal.throwIfAborted();
    }
  }

  /**
   * Whether adb still lists the killed emulator's serial as `offline` (or its
   * state could not be read), so its absence from the online-only discovery does
   * not yet confirm the AVD stopped. The same "offline or probe failed means
   * unconfirmed" rule as the recovery-reservation lift (#10076).
   */
  async isAndroidSerialHeldOffline(
    avdName: string,
    deviceId: string,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<boolean> {
    const probe = this.state.deviceManager.getAndroidOfflineDeviceIds?.bind(
      this.state.deviceManager,
    );
    if (!probe) {
      return false;
    }
    try {
      const offline = await probe([deviceId], {
        signal,
        timeoutMs: Math.max(
          1,
          Math.min(ANDROID_OFFLINE_PROBE_TIMEOUT_MS, deadlineMs - this.state.timer.now()),
        ),
      });
      signal.throwIfAborted();
      if (offline.has(deviceId)) {
        logger.info(
          `[DevicePool] Android AVD '${avdName}' is absent from the booted list but adb still lists ${deviceId} as offline; shutdown not yet confirmed`,
        );
      }
      return offline.has(deviceId);
    } catch (error) {
      signal.throwIfAborted();
      // An unreadable state list cannot prove the serial left `adb devices`.
      logger.warn(
        `[DevicePool] adb device-state probe failed while confirming '${avdName}' stopped: ${errorMessage(error)}`,
        error,
      );
      return true;
    }
  }

  async stopEmulatorProcess(
    childProcess: ChildProcess | null | undefined,
    retainLeaseUntil?: (settlement: Promise<unknown>) => void,
  ): Promise<void> {
    return this.state.emulatorProcessLifecycle.stopEmulatorProcess(childProcess, retainLeaseUntil);
  }

  async trackStartedDeviceProcess(
    device: BootedDevice,
    childProcess: ChildProcess | null | undefined,
  ): Promise<void> {
    const alreadyTracked = this.state.emulatorProcessLifecycle.hasStartedDeviceProcess(
      device.deviceId,
      childProcess,
    );
    await this.state.emulatorProcessLifecycle.trackStartedDeviceProcess(device, childProcess);
    if (
      !alreadyTracked &&
      this.state.emulatorProcessLifecycle.hasStartedDeviceProcess(device.deviceId, childProcess)
    ) {
      try {
        await this.state.onDeviceProcessStarted?.(device.deviceId);
      } catch (error) {
        logger.warn(
          `[DevicePool] Device process-start listener failed for ${device.deviceId}`,
          error,
        );
      }
    }
  }

  hasStartedDeviceProcess(
    deviceId: string,
    childProcess: ChildProcess | null | undefined,
  ): boolean {
    return this.state.emulatorProcessLifecycle.hasStartedDeviceProcess(deviceId, childProcess);
  }

  getCompletedProcessExit(childProcess: ChildProcess):
    | {
        code: number | null;
        signal: NodeJS.Signals | null;
      }
    | undefined {
    return this.state.emulatorProcessLifecycle.getCompletedProcessExit(childProcess);
  }

  async evictStartedDeviceAfterProcessExit(
    deviceId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    return this.state.emulatorProcessLifecycle.evictStartedDeviceAfterProcessExit(
      deviceId,
      code,
      signal,
    );
  }

  suppressAutoStartForDevice(device: PooledDevice): void {
    return this.state.deviceAutoStart.suppressAutoStartForDevice(device);
  }

  clearAutoStartSuppressionForBootedDevice(device: BootedDevice, sourceImage?: DeviceInfo): void {
    return this.state.deviceAutoStart.clearAutoStartSuppressionForBootedDevice(device, sourceImage);
  }
}

export function connectEmulatorLifecycle(
  part: () => DevicePoolEmulatorLifecycle,
  seams: Pick<DevicePoolOperations, "trackStartedDeviceProcess" | "hasStartedDeviceProcess">,
): EmulatorLifecycleOperations {
  return {
    stopDiscoveredEmulatorByAvdName: (...args) => part().stopDiscoveredEmulatorByAvdName(...args),
    stopRecoveryTargetMissingFromOnlineList: (...args) =>
      part().stopRecoveryTargetMissingFromOnlineList(...args),
    confirmRecoveryStop: (...args) => part().confirmRecoveryStop(...args),
    isAndroidSerialHeldOffline: (...args) => part().isAndroidSerialHeldOffline(...args),
    stopEmulatorProcess: (...args) => part().stopEmulatorProcess(...args),
    trackStartedDeviceProcess: (...args) => seams.trackStartedDeviceProcess(...args),
    hasStartedDeviceProcess: (...args) => seams.hasStartedDeviceProcess(...args),
    getCompletedProcessExit: (...args) => part().getCompletedProcessExit(...args),
    evictStartedDeviceAfterProcessExit: (...args) =>
      part().evictStartedDeviceAfterProcessExit(...args),
    suppressAutoStartForDevice: (...args) => part().suppressAutoStartForDevice(...args),
    clearAutoStartSuppressionForBootedDevice: (...args) =>
      part().clearAutoStartSuppressionForBootedDevice(...args),
  };
}
