import type { BootedDevice } from "../models";
import type { PooledDevice } from "../daemon/devicePool";
import type { DeviceHealthMarker } from "../daemon/deviceHealthMarkers";
import {
  configuredImageForBootedDevice,
  type StableConfiguredDeviceImage,
} from "../utils/configuredDeviceInventory";
import type { Session } from "../daemon/sessionManager";
import { describeDevice, type DeviceDescriptionInput } from "./deviceDescription";

type BootedInput = Extract<DeviceDescriptionInput, { kind: "booted" }>;

/** A held device `adb devices` lists in a non-`device` state (#11118, #11455). */
export interface AdbOfflineHold {
  adbState: string;
  /** The pooled AVD name, the key its configured image is stored under. */
  avdName: string;
}

export interface InventoryDeviceInput {
  device: BootedDevice;
  pooled?: PooledDevice;
  unhealthy?: DeviceHealthMarker;
  /**
   * Session detail by session id. The holder is never looked up by a session's own
   * `assignedDevice`: it is the pool's assignment (`pooled.sessionId`), so every surface names the
   * same session for a device (#11535). Absent detail still names the assigned session id.
   */
  sessionsById?: ReadonlyMap<string, Session>;
  deviceSessionUuid?: string;
  hold?: Pick<BootedInput, "heldBy" | "reserved">;
  /** `DevicePool.poolBucket(deviceId)`: the pool's one status answer, the same `getStats()` counts. */
  poolStatus?: BootedInput["poolStatus"];
  configuredImages: ReadonlyMap<string, StableConfiguredDeviceImage>;
  adbOffline?: AdbOfflineHold;
  /** The AVD name the Android transport-alias fold resolved for this serial, when it did. */
  transportAvdName?: string;
}

/**
 * The one description every inventory surface (listDevices tool, booted-device resources) builds a
 * booted device from, so the same device yields the same fields on each (#11455). Pool, session
 * and ownership context arrives already resolved by the caller; the configured-image lookup key
 * (the pooled AVD name for an adb-offline held device) and the transport-alias identity override
 * are derived here and nowhere else.
 */
export function describeInventoryDevice(input: InventoryDeviceInput) {
  const holderId = input.pooled?.sessionId;
  const session: BootedInput["session"] = holderId
    ? (input.sessionsById?.get(holderId) ?? { sessionId: holderId })
    : undefined;
  const description = describeDevice({
    kind: "booted",
    adbOfflineState: input.adbOffline?.adbState,
    device: input.device,
    pooled: input.pooled,
    unhealthy: input.unhealthy,
    configured: configuredImageForBootedDevice(
      input.device,
      input.configuredImages,
      input.adbOffline?.avdName,
    ),
    session,
    deviceSessionUuid: input.deviceSessionUuid,
    ...input.hold,
    poolStatus: input.poolStatus,
  });
  return input.device.platform === "android" && input.transportAvdName
    ? {
        ...description,
        isVirtual: true,
        identity: { stableId: input.transportAvdName },
      }
    : description;
}
