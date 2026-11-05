import type { PlatformDeviceManager } from "../../devices/deviceUtils";
import { ActionableError, type BootedDevice } from "../../models";
import type { DeviceReadyOptions } from "./DeviceReadinessContracts";

/** Resolve a booted headset only for an explicitly named visionOS call; no automation runner applies. */
export async function resolveBootedAppleVisionForCall(
  devices: Pick<PlatformDeviceManager, "getBootedDevicesDetailed">,
  providedDeviceId: string | undefined,
  pin: BootedDevice | undefined,
  options: DeviceReadyOptions = {},
): Promise<BootedDevice> {
  options.signal?.throwIfAborted();
  const discovery = await devices.getBootedDevicesDetailed("visionos", { signal: options.signal });
  options.signal?.throwIfAborted();
  if (!discovery.succeededPlatforms.has("visionos")) {
    throw new ActionableError(
      `visionOS simulator discovery failed: ${discovery.discoveryErrors?.visionos?.message ?? "unknown error"}. Retry the call.`,
    );
  }
  const headset = selectBootedVision(discovery.devices, providedDeviceId, pin);
  if (!headset) {
    throw new ActionableError(
      "No booted Apple Vision Pro matches the request uniquely. Pass deviceId or boot it with startDevice and platform visionos.",
    );
  }
  if (options.intent === "read") {
    await options.beforeReadReadiness?.(headset);
  }
  return headset;
}

function selectBootedVision(
  devices: BootedDevice[],
  providedDeviceId: string | undefined,
  pin: BootedDevice | undefined,
): BootedDevice | undefined {
  const headsets = devices.filter((device) => device.platform === "visionos");
  const targetId = providedDeviceId ?? (pin?.platform === "visionos" ? pin.deviceId : undefined);
  return targetId
    ? headsets.find((device) => device.deviceId === targetId)
    : headsets.length === 1
      ? headsets[0]
      : undefined;
}
