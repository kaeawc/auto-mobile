import { logger } from "../logger";

export type IosInstalledAppRecord = Record<string, unknown>;

const BUNDLE_ID_KEYS = ["bundleId", "bundleIdentifier", "bundleID", "CFBundleIdentifier"] as const;

/**
 * Returns the normalized bundle identifier from the simulator and devicectl
 * record formats used by installed-app callers.
 */
export function getIosInstalledAppBundleId(app: IosInstalledAppRecord): string | undefined {
  for (const key of BUNDLE_ID_KEYS) {
    const value = app[key];
    if (typeof value !== "string") {
      continue;
    }
    const bundleId = value.trim();
    if (bundleId) {
      return bundleId;
    }
  }
  return undefined;
}

/**
 * Path-carrying keys across the simulator (`simctl listapps`) and devicectl
 * (`devicectl device info apps`) record formats, most specific first: an
 * explicit bundle location beats a container. devicectl spells the bundle
 * location as a `file://` URL under `url`/`bundleURL`.
 */
const APP_PATH_KEYS = [
  "bundlePath",
  "bundleURL",
  "bundleURLString",
  "bundle_path",
  "bundle_url",
  "url",
  "path",
  "Path",
  "bundleContainer",
  "dataContainer",
] as const;

/**
 * Returns `rawPath` as a filesystem path, decoding the `file://` URL form
 * devicectl uses. A path that is not a URL is returned unchanged.
 */
export function normalizeIosDevicePath(rawPath: string): string {
  if (rawPath.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(rawPath).pathname);
    } catch (error) {
      // A malformed file:// value (bad percent-escape, unparseable URL) is still
      // more useful with the scheme stripped than not at all; this is a
      // display/metadata path, not an opened handle.
      logger.debug(`[iosInstalledApp] Could not parse device path URL ${rawPath}: ${error}`);
      return rawPath.replace("file://", "");
    }
  }
  return rawPath;
}

/**
 * Returns the normalized on-device path from the simulator and devicectl record
 * formats used by installed-app callers, or undefined when the record carries
 * no path.
 */
export function getIosInstalledAppPath(app: IosInstalledAppRecord): string | undefined {
  for (const key of APP_PATH_KEYS) {
    const value = app[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return normalizeIosDevicePath(trimmed);
    }
  }
  return undefined;
}
