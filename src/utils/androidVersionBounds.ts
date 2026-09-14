/**
 * Lowest API level the release table knows. A bare integer at or above it can
 * only be an API level (no Android release is numbered that high yet), so both
 * matching and provisioning retain the `minOsVersion: "34"` compatibility
 * form. Anything below it, or dotted / lettered, is a release version.
 */
const LOWEST_KNOWN_API_LEVEL = 21;

/**
 * Minimum API level the AutoMobile CtrlProxy runner APK can install on. Keep
 * this in sync with `build-android-minSdk` in the Gradle version catalog.
 */
export const CTRL_PROXY_APK_MIN_SDK = 24;

/** Returns the API level when a version bound uses the retained API-level form. */
export function parseAndroidApiLevelBound(bound: string): number | undefined {
  const trimmed = bound.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const apiLevel = Number(trimmed);
  return apiLevel >= LOWEST_KNOWN_API_LEVEL ? apiLevel : undefined;
}
