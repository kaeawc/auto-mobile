import { logger } from "../utils/logger";
import type { DeviceSessionRegistry } from "./deviceSessionRegistry";

/**
 * Bidirectional resolver between a device's mutable serial/UDID (`deviceId`) and
 * its daemon-minted `deviceSessionUuid` (the epic #5256 routing key).
 *
 * The push socket servers depend on this narrow contract rather than the whole
 * {@link DeviceSessionRegistry}: at push time they hold a `deviceId` and need the
 * live uuid to stamp the envelope; at subscribe time they hold a `deviceSessionUuid`
 * filter and need the current serial for the serial-scoped machinery (cadence
 * polling, telemetry backfill queries). A retired epoch resolves to `null` in both
 * directions, so a stale uuid can never re-attach to a reincarnated serial.
 */
export interface DeviceSessionResolver {
  /** Live `deviceSessionUuid` for a serial/UDID, or `null` when no epoch is live. */
  resolveUuid(deviceId: string): string | null;
  /** Live serial/UDID for a `deviceSessionUuid`, or `null` when the epoch is retired/unknown. */
  resolveDeviceId(deviceSessionUuid: string): string | null;
  /**
   * Whether this serial currently has NO routing identity because the pool's
   * entry for it is quarantined (`PooledDevice.identityUnresolved`): the serial
   * answers, but which runtime answers on it is unknown, so the epoch is
   * preserved and simply withheld.
   *
   * Distinguishes "quarantined" from "no live epoch", which `resolveUuid`
   * returning `null` cannot: a device-attributed frame for a serial with no
   * epoch is still broadcast to all-device subscribers, whereas a frame for a
   * quarantined serial is DROPPED — attributing it to the serial is the only
   * thing the daemon could do with it, and that attribution is exactly what is
   * in doubt (#6863 review).
   */
  isRoutingSuspended(deviceId: string): boolean;
}

/**
 * Null resolver — every lookup misses. The default in each push server before the
 * daemon wires the real registry, and a safe stand-in for unit tests that do not
 * exercise device-session routing: frames stamp `deviceSessionUuid: null` and only
 * all-device (`null`-filter) subscribers match.
 */
export const nullDeviceSessionResolver: DeviceSessionResolver = {
  resolveUuid: () => null,
  resolveDeviceId: () => null,
  isRoutingSuspended: () => false,
};

/**
 * Adapt a {@link DeviceSessionRegistry} to the narrow {@link DeviceSessionResolver}
 * contract.
 *
 * `isIdentityQuarantined` is the pool's `identityUnresolved` state
 * (`DevicePool.isPooledIdentityUnresolved`). While it holds for a serial, BOTH
 * directions withhold the routing identity — the registry record is untouched, so
 * a lifted quarantine resumes the same epoch — and every device-attributed frame
 * for that serial is dropped by its push server. Omitted (direct mode, tests) means
 * nothing is ever quarantined.
 */
export function createRegistryDeviceSessionResolver(
  registry: DeviceSessionRegistry,
  isIdentityQuarantined: (deviceId: string) => boolean = () => false,
): DeviceSessionResolver {
  const resolveUuid = (deviceId: string): string | null =>
    isIdentityQuarantined(deviceId)
      ? null
      : (registry.getByDeviceId(deviceId)?.deviceSessionUuid ?? null);
  return {
    resolveUuid,
    resolveDeviceId: (deviceSessionUuid: string) => {
      const deviceId = registry.getByUuid(deviceSessionUuid)?.deviceId;
      if (deviceId === undefined || isIdentityQuarantined(deviceId)) {
        return null;
      }
      return deviceId;
    },
    isRoutingSuspended: (deviceId: string) => isIdentityQuarantined(deviceId),
  };
}

/**
 * Per-server memo that keeps a suspended serial's drop notice to ONCE per
 * quarantine instead of once per dropped frame — passive streams push
 * continuously, so the per-frame form would bury the log it belongs in.
 */
export class SuspendedDeviceRoutingLog {
  private readonly announced = new Set<string>();

  /**
   * Whether frames attributed to `deviceId` must be dropped. Logs the first drop
   * of a quarantine and re-arms as soon as routing resumes, so a later
   * re-quarantine of the same serial is announced again.
   */
  shouldDropFrame(resolver: DeviceSessionResolver, deviceId: string, serverLabel: string): boolean {
    if (!resolver.isRoutingSuspended(deviceId)) {
      this.announced.delete(deviceId);
      return false;
    }
    if (!this.announced.has(deviceId)) {
      this.announced.add(deviceId);
      logger.debug(
        `[${serverLabel}] Dropping frames for ${deviceId}: its pooled AVD identity is ` +
          "unresolved, so there is no routing identity to attribute them to",
      );
    }
    return true;
  }
}
