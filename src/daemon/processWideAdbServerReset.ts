import type { Platform } from "../models";
import type { PooledDevice } from "./devicePool";

export function getProcessWideAdbServerResetCohort(
  bootedDeviceIds: ReadonlySet<string>,
  succeededPlatforms: ReadonlySet<Platform>,
  forceDisconnectedDeviceIds: ReadonlySet<string>,
  pooledDevices: readonly PooledDevice[],
): readonly PooledDevice[] {
  const ownedAndroidEmulators = pooledDevices.filter(
    (device) =>
      device.platform === "android" &&
      device.avdName !== undefined &&
      device.androidImage !== undefined &&
      device.id.startsWith("emulator-"),
  );
  if (
    !succeededPlatforms.has("android") ||
    ownedAndroidEmulators.length < 2 ||
    !ownedAndroidEmulators.every((device) => !bootedDeviceIds.has(device.id)) ||
    !ownedAndroidEmulators.some((device) => forceDisconnectedDeviceIds.has(device.id))
  ) {
    return [];
  }
  return ownedAndroidEmulators;
}

export function isProcessWideAdbServerReset(
  bootedDeviceIds: ReadonlySet<string>,
  succeededPlatforms: ReadonlySet<Platform>,
  forceDisconnectedDeviceIds: ReadonlySet<string>,
  pooledDevices: readonly PooledDevice[],
): boolean {
  return (
    getProcessWideAdbServerResetCohort(
      bootedDeviceIds,
      succeededPlatforms,
      forceDisconnectedDeviceIds,
      pooledDevices,
    ).length > 0
  );
}
