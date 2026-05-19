import { BootedDevice } from "../models";

/**
 * Runtime shape guard for singleton factories keyed on `device.deviceId`.
 *
 * Bun skips type-checking and the codebase has pre-existing TS errors, so
 * passing a bare deviceId string (instead of a BootedDevice) silently keys
 * the singleton at `undefined` and surfaces later as cryptic errors from
 * background callbacks. This boundary check converts the silent corruption
 * into a loud, immediately-actionable stack trace at the caller.
 */
export function requireBootedDevice(device: unknown, fn: string): asserts device is BootedDevice {
  const d = device as Partial<BootedDevice> | null | undefined;
  if (
    !d ||
    typeof d !== "object" ||
    typeof d.deviceId !== "string" ||
    d.deviceId.length === 0 ||
    (d.platform !== "android" && d.platform !== "ios")
  ) {
    const description = typeof device === "string"
      ? `string "${device}"`
      : JSON.stringify(device);
    throw new Error(`${fn}: expected BootedDevice, got ${description}`);
  }
}
