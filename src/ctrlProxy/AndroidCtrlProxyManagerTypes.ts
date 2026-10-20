import type { SavedPrototypeRestoreReport } from "../models/SavedPrototypeRestoreReport";
export interface AccessibilityVersionCheckResult {
  savedPrototypeRestore?: SavedPrototypeRestoreReport;
  status:
    | "skipped"
    | "not_installed"
    | "compatible"
    | "upgraded"
    | "installed"
    | "reinstalled"
    | "failed";
  expectedSha256?: string;
  installedSha256?: string | null;
  installedShaSource?: "device" | "host" | "none";
  installedApkPath?: string | null;
  attemptedDownload?: boolean;
  attemptedInstall?: boolean;
  attemptedReinstall?: boolean;
  downloadUnavailable?: boolean;
  acceptedPreinstalled?: boolean;
  error?: string;
  upgradeError?: string;
  reinstallError?: string;
  cause?: unknown;
}

export interface AccessibilityVersionCheckOptions {
  allowDownloadWhenInstalled?: boolean;
  bypassVersionCheckCache?: boolean;
}

export interface ToggleCapabilities {
  supportsSettingsToggle: boolean;
  deviceType: "emulator" | "physical";
  apiLevel: number | null;
  reason?: string;
}

export type InstalledApkSha256Result = {
  sha256: string | null;
  source: "device" | "host" | "none";
  apkPath?: string;
  error?: string;
};
