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
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    // Malformed/empty simctl output is a best-effort probe failure: the caller
    // treats an unresolved version as "unknown" and falls back accordingly.
    logger.debug(`iosMajorVersionFromSimctlListDevices: could not parse simctl JSON: ${error}`);
    return null;
  }

  // `JSON.parse` accepts scalars ("null", "42", '"x"') that are not usable device
  // maps; guard the shape before indexing so a valid-but-wrong payload yields the
  // documented "unknown" (null) rather than a TypeError.
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const devices = (parsed as { devices?: Record<string, Array<{ udid?: string }>> }).devices ?? {};
  for (const [runtimeId, deviceList] of Object.entries(devices)) {
    if (Array.isArray(deviceList) && deviceList.some((device) => device?.udid === udid)) {
      const match = runtimeId.match(/iOS[-_](\d+)/i);
      // Keep scanning: a udid should appear under exactly one runtime, but if an
      // earlier-iterated runtime id carries no iOS version token, later runtimes
      // may still resolve it rather than short-circuiting to null.
      if (match) {
        return parseInt(match[1], 10);
      }
    }
  }
  return null;
}

/**
 * Resolve the major iOS version for a physical device from the JSON emitted by
 * `devicectl device info details --json-output`. Apple does not formally document
 * the envelope, so we deep-walk it and accept the several field spellings
 * observed across Xcode builds: `osVersionNumber` (the plain "18.6" string) is
 * preferred, then `osVersion`/`productVersion`/`operatingSystemVersion`. Returns
 * `null` when nothing parses, so callers treat the version as "unknown" (and must
 * NOT block on an unresolved version) rather than guessing.
 */
export function iosMajorVersionFromDevicectlDetails(json: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    // Malformed/empty devicectl output is a best-effort probe failure: the caller
    // treats an unresolved version as "unknown" and proceeds without a version gate.
    logger.debug(`iosMajorVersionFromDevicectlDetails: could not parse devicectl JSON: ${error}`);
    return null;
  }

  const versionFields = [
    "osVersionNumber",
    "osVersion",
    "productVersion",
    "operatingSystemVersion",
  ];

  const walk = (node: unknown): number | null => {
    if (!node || typeof node !== "object") {
      return null;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }
    const record = node as Record<string, unknown>;
    for (const field of versionFields) {
      const value = record[field];
      if (typeof value === "string") {
        const major = parseIosMajorVersion(value);
        if (major !== null) {
          return major;
        }
      }
    }
    for (const value of Object.values(record)) {
      const found = walk(value);
      if (found !== null) {
        return found;
      }
    }
    return null;
  };

  return walk(parsed);
}
