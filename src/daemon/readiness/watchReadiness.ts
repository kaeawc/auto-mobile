import type { PlatformDeviceManager } from "../../devices/deviceUtils";
import { ActionableError, type BootedDevice } from "../../models";
import type { DeviceReadyOptions } from "./DeviceReadinessContracts";

/**
 * Readiness for a call that names `platform: "watchos"` (#14908). A watch has no automation
 * runner, so this never verifies, boots, prepares CtrlProxy or writes settings: it only resolves
 * a watch a fresh watchOS listing shows booted, by the call's deviceId, else the connection's
 * watch pin, else the only booted watch. Readiness for any other platform never reaches here.
 */
export async function resolveBootedWatchForCall(
  deviceUtils: Pick<PlatformDeviceManager, "getBootedDevicesDetailed">,
  providedDeviceId: string | undefined,
  pin: BootedDevice | undefined,
  options: DeviceReadyOptions = {},
): Promise<BootedDevice> {
  const watches = await listBootedWatches(deviceUtils, options.signal);
  const targetId = providedDeviceId ?? (pin?.platform === "watchos" ? pin.deviceId : undefined);
  const watch = targetId
    ? watches.find((candidate) => candidate.deviceId === targetId)
    : soleWatch(watches);
  if (!watch) {
    throw new ActionableError(watchNotResolvedMessage(targetId, watches));
  }
  if (options.intent === "read") {
    // The read path's late-ownership check runs here as it does before any other readiness.
    await options.beforeReadReadiness?.(watch);
  }
  return watch;
}

async function listBootedWatches(
  deviceUtils: Pick<PlatformDeviceManager, "getBootedDevicesDetailed">,
  signal: AbortSignal | undefined,
): Promise<BootedDevice[]> {
  signal?.throwIfAborted();
  const discovery = await deviceUtils.getBootedDevicesDetailed("watchos", { signal });
  signal?.throwIfAborted();
  if (!discovery.succeededPlatforms.has("watchos")) {
    const reason = discovery.discoveryErrors?.watchos?.message ?? "unknown error";
    throw new ActionableError(`watchOS simulator discovery failed: ${reason}. Retry the call.`);
  }
  return discovery.devices.filter((device) => device.platform === "watchos");
}

function soleWatch(watches: BootedDevice[]): BootedDevice | undefined {
  return watches.length === 1 ? watches[0] : undefined;
}

function watchNotResolvedMessage(targetId: string | undefined, watches: BootedDevice[]): string {
  if (targetId) {
    return `No booted Apple Watch simulator matches '${targetId}'. Boot it with startDevice { platform: "watchos", deviceId } first.`;
  }
  if (watches.length === 0) {
    return 'No Apple Watch simulator is booted. Boot one with startDevice { platform: "watchos" } first.';
  }
  return `${watches.length} Apple Watch simulators are booted (${watches
    .map((watch) => watch.deviceId)
    .join(", ")}). Pass deviceId or the watch's sessionUuid.`;
}
