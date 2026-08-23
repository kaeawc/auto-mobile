/**
 * Normalized app metadata returned for both Android and iOS.
 */
export interface AppMetadataResult {
  appId: string;
  platform: "android" | "ios";
  versionName: string;
  buildNumber: string;
  installPath: string;
  firstInstallTime?: string; // device-local time (Android: from dumpsys, no timezone offset)
  lastUpdateTime?: string; // device-local time (Android: from dumpsys, no timezone offset)
}
