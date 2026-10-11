import type { BootedDevice } from "../models";
import { isAndroidTransportAddressSerial } from "../utils/androidSerial";

/**
 * The pool's Android transport fold, as a direct socket frame needs it. Every member is optional:
 * direct mode has no pool, and older socket-state fakes carry none of them.
 */
export interface FrameDeviceIdentityPool {
  mapAndroidDiscovery?(devices: readonly BootedDevice[]): BootedDevice[];
  resolveAndroidCanonicalId?(deviceId: string): string;
  normalizeAndroidDiscovery?(
    devices: readonly BootedDevice[],
    assignmentLockHeld?: boolean,
    isCurrent?: () => boolean,
    completeAndroidSnapshot?: boolean,
  ): Promise<BootedDevice[]>;
  getAllDevices?(): readonly { id: string }[];
}

/** A direct frame's discovery and device id, in the ids the pool and its sessions are keyed on. */
export interface CanonicalFrameDiscovery {
  devices: BootedDevice[];
  /** The frame's `deviceId` as the pool's canonical id; undefined when the frame named none. */
  deviceId: string | undefined;
}

/**
 * The pooled canonical id for a device id that arrived on a direct frame. One handset reachable
 * over USB and wireless debugging is ONE pooled device (#10201) held under one id; a frame may
 * name it by either. Identity for iOS, for an id the pool has not folded, and in direct mode.
 */
export function canonicalFrameDeviceId(
  pool: FrameDeviceIdentityPool | undefined,
  deviceId: string,
): string {
  return pool?.resolveAndroidCanonicalId?.(deviceId) ?? deviceId;
}

/**
 * Resolve a direct frame's raw discovery rows and `deviceId` to pooled canonical ids BEFORE any
 * holder, managed-slot or admission decision reads them (#11596): those decisions are keyed on the
 * canonical id, so a frame naming a held handset by its other transport id would otherwise find no
 * holder. Uses the pool's own fold (`mapAndroidDiscovery` / `resolveAndroidCanonicalId`), as
 * `resourceDeviceResolver.ts` does.
 *
 * A transport address the pool has never folded (a wireless id first seen on this frame) proves
 * nothing about which handset answers on it, so it is probed and folded additively first, exactly
 * as the disconnect monitor folds a new wireless row: an additive fold never prunes alias groups.
 */
export async function canonicalizeFrameDiscovery(
  pool: FrameDeviceIdentityPool | undefined,
  platform: "android" | "ios",
  rawDevices: readonly BootedDevice[],
  deviceId: string | undefined,
): Promise<CanonicalFrameDiscovery> {
  if (!pool || platform !== "android") {
    return { devices: [...rawDevices], deviceId };
  }
  let devices = pool.mapAndroidDiscovery?.(rawDevices) ?? [...rawDevices];
  if (pool.normalizeAndroidDiscovery && hasUnfoldedTransport(pool, devices)) {
    devices = await pool.normalizeAndroidDiscovery(rawDevices, false, () => true, false);
  }
  return {
    devices,
    deviceId: deviceId === undefined ? undefined : canonicalFrameDeviceId(pool, deviceId),
  };
}

/** A mapped row that is still a bare transport address the pool does not hold as a device. */
function hasUnfoldedTransport(
  pool: FrameDeviceIdentityPool,
  mapped: readonly BootedDevice[],
): boolean {
  const pooledIds = new Set((pool.getAllDevices?.() ?? []).map((device) => device.id));
  return mapped.some(
    (device) =>
      device.platform === "android" &&
      isAndroidTransportAddressSerial(device.deviceId) &&
      !pooledIds.has(device.deviceId),
  );
}
