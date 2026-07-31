export type IosInstalledAppRecord = Record<string, unknown>;

const BUNDLE_ID_KEYS = [
  "bundleId",
  "bundleIdentifier",
  "bundleID",
  "CFBundleIdentifier"
] as const;

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
