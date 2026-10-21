import type { AppleDeviceType } from "./SimCtlSupport";

/**
 * Parses `xcrun simctl list devicetypes --json`; the one place its stdout is parsed.
 * Throws on malformed JSON or a missing `devicetypes` array so callers report the failure.
 */
export function parseSimctlDeviceTypes(stdout: string): AppleDeviceType[] {
  const data = JSON.parse(stdout) as { devicetypes?: unknown } | null;
  if (!Array.isArray(data?.devicetypes)) {
    throw new Error("simctl device types response does not contain a devicetypes array");
  }
  return data.devicetypes as AppleDeviceType[];
}
