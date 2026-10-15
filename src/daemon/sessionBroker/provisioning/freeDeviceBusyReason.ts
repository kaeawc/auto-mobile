import type { DevicePool } from "../../devicePool";
import type { DeviceInfo } from "../../../models";

export type FreeDeviceBusyPool = Pick<
  DevicePool,
  | "getAllDevices"
  | "isUnderShutdownReservation"
  | "isDeviceLeasedForAndroidStartup"
  | "restartReservationExclusions"
>;

/** Quiet means no pooled work, session, shutdown/startup lease or restart-recovery reservation.
 * Restart reservations are checked even when no runtime is currently pooled. */
export function freeDeviceBusyReason(
  pool: FreeDeviceBusyPool,
  device: Pick<DeviceInfo, "platform" | "name" | "deviceId">,
): string | undefined {
  const reserved = pool.restartReservationExclusions(device.platform, {});
  if (
    device.platform === "android"
      ? reserved.names.has(device.name)
      : reserved.ids.has(device.deviceId ?? "")
  ) {
    return "restart recovery reservation";
  }
  const runtime = pool
    .getAllDevices()
    .find(
      (pooled) =>
        pooled.platform === device.platform &&
        (device.platform === "android"
          ? (pooled.avdName ?? pooled.name) === device.name
          : pooled.id === device.deviceId),
    );
  if (!runtime) {
    return undefined;
  }
  if (runtime.status !== "idle") {
    return `pooled runtime is ${runtime.status}`;
  }
  if (runtime.sessionId !== null) {
    return "a session holds the runtime";
  }
  if (pool.isUnderShutdownReservation(runtime.id)) {
    return "shutdown reservation";
  }
  return pool.isDeviceLeasedForAndroidStartup(runtime.id) ? "android startup lease" : undefined;
}
