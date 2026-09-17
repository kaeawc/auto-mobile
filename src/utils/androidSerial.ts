/**
 * adb reserves the `emulator-<port>` serial shape for locally-running Android
 * emulators; every other serial belongs to a physical handset. Several call
 * sites had grown their own copy of this predicate, so keep exactly one
 * spelling here (issue #6850 review).
 */
const ANDROID_EMULATOR_SERIAL_PATTERN = /^emulator-\d+$/;

/** ADB transport addresses are connection endpoints rather than durable ids. */
const ANDROID_TRANSPORT_ADDRESS_SERIAL_PATTERN =
  /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):\d+$|\._adb-tls-connect\._tcp|\._adb\._tcp/;

/** True when `deviceId` is an adb emulator serial (e.g. `emulator-5554`). */
export function isAndroidEmulatorSerial(deviceId: string): boolean {
  return ANDROID_EMULATOR_SERIAL_PATTERN.test(deviceId);
}

/** True when `deviceId` is an ADB TCP or mDNS transport address. */
export function isAndroidTransportAddressSerial(deviceId: string): boolean {
  return ANDROID_TRANSPORT_ADDRESS_SERIAL_PATTERN.test(deviceId);
}
