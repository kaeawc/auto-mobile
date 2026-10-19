import { isEmulatorStopDispatchedError } from "../utils/android-cmdline-tools/EmulatorProcessStop";
import { ctrlProxyClientLifecycle } from "../features/observe/ctrlProxyClientLifecycle";
import type { BootedDevice, SomePlatform } from "../models";
import type { DaemonStateLike } from "../daemon/daemonState";
import { isAdbMissingDeviceError } from "../utils/android-cmdline-tools/AdbDeviceHealth";
import { isIosSimulatorAlreadyStoppedError } from "../utils/ios-cmdline-tools/simulatorStateErrors";
import { isShutdownTimeoutError } from "../features/deviceLifecycle/deviceLifecycleCore";

export function isAlreadyStoppedDeviceError(
  platform: SomePlatform,
  deviceId: string,
  error: unknown,
): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (platform === "android") {
    return (
      (message.includes("not running") && message.includes("emulator")) ||
      isAdbMissingDeviceError(error, deviceId)
    );
  }
  if (platform === "ios") {
    return isIosSimulatorAlreadyStoppedError(error);
  }
  return false;
}

export async function resumeCtrlProxyAfterFailedKill(
  device: BootedDevice,
  daemonState: Pick<DaemonStateLike, "isInitialized" | "getDevicePool">,
): Promise<void> {
  if (
    daemonState.isInitialized() &&
    (await daemonState.getDevicePool().isShutdownReserved(device.deviceId))
  ) {
    return;
  }
  ctrlProxyClientLifecycle.resumeAfterDeviceStart(device.platform, device.deviceId);
}

export async function resumeCtrlProxyAfterUnconfirmedFailure(
  device: BootedDevice,
  error: unknown,
  requestAbortSignal: AbortSignal | undefined,
  daemonState: Pick<DaemonStateLike, "isInitialized" | "getDevicePool">,
  shutdownWasConfirmed = false,
): Promise<void> {
  if (
    !shutdownWasConfirmed &&
    !isAlreadyStoppedDeviceError(device.platform, device.deviceId, error) &&
    !shouldKeepIntentionalShutdownAfterCommandError(error, requestAbortSignal)
  ) {
    await resumeCtrlProxyAfterFailedKill(device, daemonState);
  }
}

export function resumeCtrlProxyWhenPreparationSettles(
  stop: Promise<void> | undefined,
  device: BootedDevice,
  daemonState: Pick<DaemonStateLike, "isInitialized" | "getDevicePool">,
): void {
  // The same in-flight teardown retains the pool reservation on timeout/abort.
  // A new shutdown or an unresolved shutdown marker keeps the client retired.
  void stop?.then(
    () => resumeCtrlProxyAfterFailedKill(device, daemonState),
    () => resumeCtrlProxyAfterFailedKill(device, daemonState),
  );
}

export function shouldKeepIntentionalShutdownAfterCommandError(
  error: unknown,
  requestAbortSignal: AbortSignal | undefined,
): boolean {
  return (
    requestAbortSignal?.aborted === true ||
    isShutdownTimeoutError(error) ||
    isEmulatorStopDispatchedError(error)
  );
}
