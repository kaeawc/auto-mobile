import { logger } from "../logger";

/**
 * Parse the major iOS version integer from a version string such as `"18.6"`,
 * `"17.5.1"`, or a bare `"18"`. Returns `null` when the input is missing or
 * carries no leading numeric component, so callers can treat the version as
 * "unknown" rather than guessing.
 */
export function parseIosMajorVersion(version: string | undefined | null): number | null {
  if (!version) {
    return null;
  }
  const match = version.trim().match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Resolve the major iOS version for a booted simulator `udid` from the JSON
 * emitted by `simctl list devices <udid> --json`. The payload groups devices by
 * runtime identifier (e.g. `com.apple.CoreSimulator.SimRuntime.iOS-18-6`), so we
 * find the runtime whose device list contains the udid and read the version from
 * that identifier. Returns `null` when the udid is absent, the runtime carries no
 * iOS version token, or the JSON is malformed.
 */
export function iosMajorVersionFromSimctlListDevices(json: string, udid: string): number | null {
  let parsed: { devices?: Record<string, Array<{ udid?: string }>> };
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    // Malformed/empty simctl output is a best-effort probe failure: the caller
    // treats an unresolved version as "unknown" and falls back accordingly.
    logger.debug(`iosMajorVersionFromSimctlListDevices: could not parse simctl JSON: ${error}`);
    return null;
  }

  const devices = parsed.devices ?? {};
  for (const [runtimeId, deviceList] of Object.entries(devices)) {
    if (Array.isArray(deviceList) && deviceList.some(device => device?.udid === udid)) {
      const match = runtimeId.match(/iOS[-_](\d+)/i);
      return match ? parseInt(match[1], 10) : null;
    }
  }
  return null;
}
