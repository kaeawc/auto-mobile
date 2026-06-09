/**
 * iOS simulator UDIDs are standard 8-4-4-4-12 hex UUIDs, whereas physical
 * device UDIDs are 40-char hex or the newer `00008XXX-XXXXXXXXXXXXXXXX` form.
 * This pattern is the runtime signal used across the iOS tooling to choose
 * between `simctl` (simulator) and `devicectl` (physical device).
 */
export const IOS_SIMULATOR_UUID_PATTERN =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/** True when the deviceId looks like an iOS simulator UDID (not a physical device). */
export function isIosSimulatorUdid(deviceId: string): boolean {
  return IOS_SIMULATOR_UUID_PATTERN.test(deviceId);
}
