/**
 * adb reserves the `emulator-<port>` serial shape for locally-running Android
 * emulators; every other serial belongs to a physical handset. Several call
 * sites had grown their own copy of this predicate, so keep exactly one
 * spelling here (issue #6850 review).
 */
const ANDROID_EMULATOR_SERIAL_PATTERN = /^emulator-\d+$/;

/** True when `deviceId` is an adb emulator serial (e.g. `emulator-5554`). */
export function isAndroidEmulatorSerial(deviceId: string): boolean {
  return ANDROID_EMULATOR_SERIAL_PATTERN.test(deviceId);
}
