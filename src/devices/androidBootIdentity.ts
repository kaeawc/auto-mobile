import type { BootedDevice, DeviceInfo } from "../models";
import { ActionableError } from "../models";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";
import { AndroidAvdIdentityUnresolvedError } from "./AndroidAvdIdentityUnresolvedError";

export function assertAndroidAvdIdentityResolved(
  devices: readonly BootedDevice[],
  avdName: string,
): void {
  const unresolved = devices
    .filter(
      (device) =>
        !device.foreignOwned &&
        device.platform === "android" &&
        isAndroidEmulatorSerial(device.deviceId) &&
        device.name === `Unknown (${device.deviceId})`,
    )
    .map((device) => device.deviceId);
  if (unresolved.length > 0) {
    throw new AndroidAvdIdentityUnresolvedError(avdName, [...new Set(unresolved)].toSorted());
  }
}

export function assertExactAndroidImageDiscovery(
  image: DeviceInfo,
  booted: readonly BootedDevice[],
  exactTarget: boolean,
  freshProvision: boolean,
): void {
  if (!exactTarget || image.platform !== "android") {
    return;
  }
  // A newly created, never-launched AVD cannot be the unresolved sibling (#13609).
  if (!freshProvision) {
    assertAndroidAvdIdentityResolved(booted, image.name);
  }
  const occupiedSerial =
    image.deviceId && isAndroidEmulatorSerial(image.deviceId)
      ? booted.find(
          (device) =>
            !device.foreignOwned &&
            device.deviceId === image.deviceId &&
            device.name !== image.name,
        )
      : undefined;
  if (occupiedSerial) {
    throw new ActionableError(
      `target_identity_mismatch: Configured Android AVD '${image.name}' lists serial ` +
        `'${image.deviceId}', but that serial is running '${occupiedSerial.name}'. ` +
        "Refresh device inventory and retry.",
    );
  }
}
