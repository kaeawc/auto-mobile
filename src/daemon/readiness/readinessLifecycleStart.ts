import type { Timer } from "../../utils/SystemTimer";
import type { PlatformDeviceManager } from "../../devices/deviceUtils";
import { terminateOwnedEmulatorProcess } from "../../devices/coldBootProcessTermination";
import { type VirtualDeviceLifecycleLease } from "../../devices/virtualDeviceLifecycleCoordinator";
import { DeviceInfo } from "../../models";
import type { HostChildProcess as ChildProcess } from "../../utils/HostCommandExecutor";
import { isEmulatorLaunchCancelledError } from "../../utils/android-cmdline-tools/EmulatorLaunchCancelledError";
import { type DeviceReadyOptions } from "./DeviceReadinessContracts";
import { type LifecycleStartHold } from "./readinessLifecycleIdentity";
interface ReadinessLifecycleStartContext {
  deviceUtils: () => PlatformDeviceManager;
  runnerReadinessTimer: Timer;
}

/**
 * Starts the device, and when the launch is cancelled after the emulator was
 * spawned, takes the child from the cancellation error and terminates it with the
 * shared SIGTERM -> bounded wait -> SIGKILL escalation, holding the AVD lease until
 * its exit is confirmed. The launch rejects the moment the request aborts, so
 * without this the lease would be released while the child is still shutting down
 * and a following start of the same AVD could spawn a second emulator (#10075).
 */
export async function startDeviceOwningCancelledLaunch(
  context: Pick<ReadinessLifecycleStartContext, "deviceUtils" | "runnerReadinessTimer">,
  image: DeviceInfo,
  hold: LifecycleStartHold,
): Promise<ChildProcess | null> {
  try {
    return await context.deviceUtils().startDevice(image);
  } catch (error) {
    if (isEmulatorLaunchCancelledError(error) && error.process) {
      hold.holdLeaseUntil(
        terminateOwnedEmulatorProcess(error.process, image.name, context.runnerReadinessTimer, {
          markHeldByUnkillableProcess: (pid) => hold.lease.markHeldByUnkillableProcess?.(pid),
        }).then((outcome) => (outcome.state === "survived" ? outcome.gone : undefined)),
      );
    }
    throw error;
  }
}

export async function runWithLifecycleLease<T>(
  lifecycleLease: VirtualDeviceLifecycleLease,
  options: DeviceReadyOptions | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signals = [options?.signal, lifecycleLease.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return await operation(signals.length === 1 ? signals[0] : AbortSignal.any(signals));
}
