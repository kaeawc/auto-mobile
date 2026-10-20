import type { Platform } from "../../models";
import type { PooledDevice } from "../devicePool";
import type { Session } from "../sessionManager";
import { holderOf } from "../deviceBinding";
import type { DaemonCoreServices } from "./DaemonCoreState";

interface DisconnectTargetHost {
  services: Pick<DaemonCoreServices, "sessionManager" | "devicePool">;
  forceDisconnectedDeviceGenerations: () => Map<string, number>;
}

export interface CapturedDisconnectCleanup {
  pooledDeviceAtDisconnect: PooledDevice | null;
  assignmentCountAtDisconnect: number | undefined;
  sessionIdAtDisconnect: string | null;
  sessionAtDisconnect: Session | null;
  forceGenerationAtDisconnect: number | undefined;
  adbServerResetTarget: PooledDevice | undefined;
}

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

export function captureDisconnectCleanup(
  host: Pick<DisconnectTargetHost, "services" | "forceDisconnectedDeviceGenerations">,
  deviceId: string,
  adbServerResetCohortByDeviceId: Map<string, PooledDevice>,
): CapturedDisconnectCleanup {
  const pooledDeviceAtDisconnect = host.services.devicePool().getDevice(deviceId);
  const assignmentCountAtDisconnect = pooledDeviceAtDisconnect?.assignmentCount;
  const sessionIdAtDisconnect =
    holderOf(pooledDeviceAtDisconnect) ??
    host.services.sessionManager().getSessionForDevice(deviceId);
  const sessionAtDisconnect = sessionIdAtDisconnect
    ? host.services.sessionManager().getSession(sessionIdAtDisconnect)
    : null;
  const forceGenerationAtDisconnect = host.forceDisconnectedDeviceGenerations().get(deviceId);
  const adbServerResetTarget = adbServerResetCohortByDeviceId.get(deviceId);
  return {
    pooledDeviceAtDisconnect,
    assignmentCountAtDisconnect,
    sessionIdAtDisconnect,
    sessionAtDisconnect,
    forceGenerationAtDisconnect,
    adbServerResetTarget,
  };
}

export function isCapturedDisconnectTargetCurrent(
  host: Pick<DisconnectTargetHost, "services">,
  deviceId: string,
  pooledDeviceAtDisconnect: PooledDevice | null,
  assignmentCountAtDisconnect: number | undefined,
  sessionIdAtDisconnect?: string | null,
  sessionAtDisconnect?: Session | null,
): boolean {
  if (pooledDeviceAtDisconnect) {
    if (
      host.services.devicePool().getDevice(deviceId) !== pooledDeviceAtDisconnect ||
      pooledDeviceAtDisconnect.assignmentCount !== assignmentCountAtDisconnect
    ) {
      return false;
    }
  } else if (host.services.devicePool().getDevice(deviceId)) {
    return false;
  }

  if (!sessionIdAtDisconnect) {
    return host.services.sessionManager().getSessionForDevice(deviceId) === null;
  }
  return (
    host.services.sessionManager().getSessionForDevice(deviceId) === sessionIdAtDisconnect &&
    host.services.sessionManager().getSession(sessionIdAtDisconnect) === sessionAtDisconnect
  );
}
