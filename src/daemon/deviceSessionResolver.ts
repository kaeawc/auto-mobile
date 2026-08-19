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
};

/** Adapt a {@link DeviceSessionRegistry} to the narrow {@link DeviceSessionResolver} contract. */
export function createRegistryDeviceSessionResolver(
  registry: DeviceSessionRegistry,
): DeviceSessionResolver {
  return {
    resolveUuid: (deviceId: string) => registry.getByDeviceId(deviceId)?.deviceSessionUuid ?? null,
    resolveDeviceId: (deviceSessionUuid: string) =>
      registry.getByUuid(deviceSessionUuid)?.deviceId ?? null,
  };
}
