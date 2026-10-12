import type { BootedDevice, SomePlatform } from "../models";
import { ActionableError } from "../models/ActionableError";

/** Exact ids win over names; a name must identify one running device in scope. */
export function matchRunningReadTarget(
  devices: readonly BootedDevice[],
  deviceId: string,
  platform: SomePlatform = "either",
): BootedDevice | undefined {
  const candidates = devices.filter(
    (device) => platform === "either" || device.platform === platform,
  );
  const exact = candidates.find((device) => device.deviceId === deviceId);
  if (exact) {
    return exact;
  }
  const named = candidates.filter((device) => device.name === deviceId);
  if (named.length > 1) {
    throw new ActionableError(
      `Ambiguous running device name '${deviceId}'. Candidates: ${named
        .map((device) => device.deviceId)
        .sort()
        .join(", ")}. Provide a deviceId.`,
    );
  }
  return named[0];
}

export function providedReadTargetNotFound(
  deviceId: string,
  platform: SomePlatform,
  devices: BootedDevice[],
): ActionableError {
  return new ActionableError(
    `Device ${deviceId} not found on ${platform} platform. ` +
      `Available ${platform} devices: ${describeDevices(devices.filter((device) => platform === "either" || device.platform === platform))}`,
  );
}

/**
 * Render a device list for a "not found" error.
 *
 * These messages exist to tell the caller which identifier to use instead, so
 * they must print the identifiers rather than the objects: `BootedDevice[].join()`
 * stringifies each element to "[object Object]" and destroys the only actionable
 * part of the message (#4227).
 *
 * Both identifiers are shown because callers reason in either — a user reads
 * "Pixel_9_Pro" in a device picker but must pass the id. Android currently sets
 * `name === deviceId` (AdbClient.getBootedAndroidDevices), so the redundant
 * "x (x)" form is collapsed to a single value.
 */
export function describeDevices(devices: BootedDevice[]): string {
  return (
    devices
      .map((device) =>
        device.name && device.name !== device.deviceId
          ? `${device.name} (${device.deviceId})`
          : device.deviceId,
      )
      .join(", ") || "none"
  );
}
