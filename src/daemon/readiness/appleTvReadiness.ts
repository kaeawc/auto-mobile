import type { PlatformDeviceManager } from "../../devices/deviceUtils";
import { ActionableError, type BootedDevice } from "../../models";
import type { DeviceReadyOptions } from "./DeviceReadinessContracts";

/** Resolve a booted TV only for an explicitly named tvOS call; no automation runner applies. */
export async function resolveBootedAppleTvForCall(
  devices: Pick<PlatformDeviceManager, "getBootedDevicesDetailed">,
  providedDeviceId: string | undefined,
  pin: BootedDevice | undefined,
  options: DeviceReadyOptions = {},
): Promise<BootedDevice> {
  options.signal?.throwIfAborted();
  const discovery = await devices.getBootedDevicesDetailed("tvos", { signal: options.signal });
  options.signal?.throwIfAborted();
  if (!discovery.succeededPlatforms.has("tvos")) {
    throw new ActionableError(
      `tvOS simulator discovery failed: ${discovery.discoveryErrors?.tvos?.message ?? "unknown error"}. Retry the call.`,
    );
  }
  const tv = selectBootedTv(discovery.devices, providedDeviceId, pin);
  if (!tv) {
    throw new ActionableError(
      "No booted Apple TV matches the request uniquely. Pass deviceId or boot it with startDevice and platform tvos.",
    );
  }
  if (options.intent === "read") {
    await options.beforeReadReadiness?.(tv);
  }
  return tv;
}

function selectBootedTv(
  devices: BootedDevice[],
  providedDeviceId: string | undefined,
  pin: BootedDevice | undefined,
): BootedDevice | undefined {
  const tvs = devices.filter((device) => device.platform === "tvos");
  const targetId = providedDeviceId ?? (pin?.platform === "tvos" ? pin.deviceId : undefined);
  return targetId
    ? tvs.find((device) => device.deviceId === targetId)
    : tvs.length === 1
      ? tvs[0]
      : undefined;
}
