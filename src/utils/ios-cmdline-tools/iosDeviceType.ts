/**
 * iOS simulator UDIDs are standard 8-4-4-4-12 hex UUIDs, whereas physical
 * device UDIDs are 40-char hex or the newer `00008XXX-XXXXXXXXXXXXXXXX` form.
 * This pattern is the runtime signal used across the iOS tooling to choose
 * between `simctl` (simulator) and `devicectl` (physical device).
 */
export const IOS_SIMULATOR_UUID_PATTERN =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/**
 * Physical iOS devices with an A12 or newer SoC (iOS 12+) report a UDID of
 * 8 hex digits, a hyphen, then 16 hex digits — e.g. `00008030-001C2D3E1234567A`.
 */
const IOS_PHYSICAL_UDID_MODERN_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{16}$/i;

/**
 * Pre-A12 physical iOS devices report a bare 40-character hex UDID with no
 * separators. Deliberately anchored and length-exact: Android serials are
 * shorter and/or contain characters outside the hex alphabet, so this stays
 * disjoint from them.
 */
const IOS_PHYSICAL_UDID_LEGACY_PATTERN = /^[0-9A-F]{40}$/i;

/** True when the deviceId looks like an iOS simulator UDID (not a physical device). */
export function isIosSimulatorUdid(deviceId: string): boolean {
  return IOS_SIMULATOR_UUID_PATTERN.test(deviceId);
}

/** True when the deviceId looks like a physical iOS device UDID (either generation). */
export function isIosPhysicalUdid(deviceId: string): boolean {
  return (
    IOS_PHYSICAL_UDID_MODERN_PATTERN.test(deviceId) || IOS_PHYSICAL_UDID_LEGACY_PATTERN.test(deviceId)
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
