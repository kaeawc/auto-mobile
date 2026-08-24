/**
 * iOS simulator UDIDs are standard 8-4-4-4-12 hex UUIDs, whereas physical
 * device UDIDs are 40-char hex or the newer 8-hex + `-` + 16-hex form.
 * This pattern is the runtime signal used across the iOS tooling to choose
 * between `simctl` (simulator) and `devicectl` (physical device).
 */
export const IOS_SIMULATOR_UUID_PATTERN =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/**
 * Physical iOS devices with an A12 or newer SoC (iOS 12+) report a UDID of
 * 8 hex digits, a hyphen, then 16 hex digits — e.g. `00008030-001C2D3E1234567A`.
 *
 * The leading group is the zero-padded chip id, so shipped devices all start
 * `00008` today (8020 = A12, 8030 = A13, 8101 = A14, 8110 = A15, 8120 = A16,
 * 8130 = A17 Pro, …). The pattern deliberately does NOT hardcode that prefix:
 * every new SoC introduces a new chip id, and pinning `00008` would silently
 * reclassify the next generation of iPhones as Android — which is exactly the
 * bug this module exists to fix (#4165), just deferred to the next chip.
 *
 * Matching structure instead of vendor prefix is safe because the shape cannot
 * collide with an Android device id:
 *   - Android's CDD (3.2.2 Build Parameters) requires `Build.SERIAL` /
 *     `ro.serialno` to match `^([a-zA-Z0-9]{0,20})$` — alphanumeric only, so a
 *     serial can contain neither the hyphen this pattern requires nor the 25
 *     characters it is long.
 *   - The other adb device-id shapes (`emulator-NNNN`, `host:port`,
 *     `adb-<serial>-XXXXXX._adb-tls-connect._tcp`) all carry characters outside
 *     the hex alphabet in the positions this pattern constrains.
 * `iosDeviceType.test.ts` pins that disjointness over the whole CDD serial
 * grammar plus real-world serials, so a regression here fails loudly.
 */
const IOS_PHYSICAL_UDID_MODERN_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{16}$/i;

/**
 * Pre-A12 physical iOS devices report a bare 40-character hex UDID with no
 * separators. Deliberately anchored and length-exact, which keeps it disjoint
 * from Android serials for the same reason as above: 40 characters is twice the
 * 20-character ceiling the CDD puts on `Build.SERIAL`.
 */
const IOS_PHYSICAL_UDID_LEGACY_PATTERN = /^[0-9A-F]{40}$/i;

/** True when the deviceId looks like an iOS simulator UDID (not a physical device). */
export function isIosSimulatorUdid(deviceId: string): boolean {
  return IOS_SIMULATOR_UUID_PATTERN.test(deviceId);
}

/** True when the deviceId looks like a physical iOS device UDID (either generation). */
export function isIosPhysicalUdid(deviceId: string): boolean {
  return (
    IOS_PHYSICAL_UDID_MODERN_PATTERN.test(deviceId) ||
    IOS_PHYSICAL_UDID_LEGACY_PATTERN.test(deviceId)
  );
}

/**
 * True when the deviceId looks like any iOS UDID — simulator or physical.
 * Callers that need to know *which* transport to use should keep branching on
 * {@link isIosSimulatorUdid}; this predicate only answers "is this iOS at all".
 */
export function isIosUdid(deviceId: string): boolean {
  return isIosSimulatorUdid(deviceId) || isIosPhysicalUdid(deviceId);
}
