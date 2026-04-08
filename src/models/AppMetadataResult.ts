/**
 * Normalized app metadata returned for both Android and iOS.
 */
export interface AppMetadataResult {
  appId: string;
  platform: "android" | "ios";
  versionName: string;
  buildNumber: string;
  installPath: string;
  firstInstallTime?: string; // ISO 8601
  lastUpdateTime?: string;   // ISO 8601
}
