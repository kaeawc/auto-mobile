export type DeviceSnapshotType = "vm" | "adb" | "simctl" | "app_data";

/**
 * Outcome of an iOS app-container capture for a single requested bundle id:
 * `captured` — installed with a data container that was backed up;
 * `skipped-no-container` — installed but has no data container to capture;
 * `not-installed` — no such app is installed on the simulator;
 * `failed` — installed with a resolved container, but copying it errored
 * (issue #5712). `captured` → `backedUpPackages`, `skipped-no-container` →
 * `skippedPackages`, and both `not-installed` and `failed` → `failedPackages`.
 */
export type IosBundleCaptureStatusKind =
  | "captured"
  | "skipped-no-container"
  | "not-installed"
  | "failed";

export interface IosBundleCaptureStatus {
  bundleId: string;
  status: IosBundleCaptureStatusKind;
}

export interface DeviceSnapshotManifest {
  snapshotName: string;
  timestamp: string;
  deviceId: string;
  deviceName: string;
  platform: "android" | "ios";
  deviceType?: string;
  osVersion?: string;
  snapshotType: DeviceSnapshotType;
  includeAppData: boolean;
  includeSettings: boolean;
  packages?: string[];
  foregroundApp?: string;
  settings?: {
    global?: Record<string, string>;
    secure?: Record<string, string>;
    system?: Record<string, string>;
  };
  /**
   * iOS simulator settings captured via `defaults`/`simctl ui`. Distinct from the
   * Android `settings` triplet because iOS `(domain, key)` exports do not fit that
   * shape. Present only when an iOS snapshot was captured with `includeSettings`.
   */
  iosSettings?: {
    values: Record<string, string>;
    ui?: { appearance?: "light" | "dark"; contentSize?: string };
  };
  appDataBackup?: {
    backupFile?: string;
    backedUpPackages?: string[];
    skippedPackages?: string[];
    failedPackages?: string[];
    totalPackages?: number;
    backupTimedOut?: boolean;
    backupMethod?: "root_pull" | "none" | "simctl_copy";
    /**
     * iOS-only per-bundle outcome for each requested `appBundleIds` entry, so a
     * caller can tell an installed-and-captured app apart from one that was
     * never installed or has no data container — instead of every bundle
     * silently "succeeding" (issue #5712). Mirrors the
     * backedUp/skipped/failedPackages arrays: `captured` → backedUp,
     * `skipped-no-container` → skipped, `not-installed` → failed.
     */
    bundleStatuses?: IosBundleCaptureStatus[];
  };
}

export interface DeviceSnapshotConfig {
  includeAppData: boolean;
  includeSettings: boolean;
  useVmSnapshot: boolean;
  strictBackupMode: boolean;
  vmSnapshotTimeoutMs: number;
  maxArchiveSizeMb: number;
}

export interface DeviceSnapshotConfigInput {
  includeAppData?: boolean | string;
  includeSettings?: boolean | string;
  useVmSnapshot?: boolean | string;
  strictBackupMode?: boolean | string;
  vmSnapshotTimeoutMs?: number | string;
  maxArchiveSizeMb?: number | string;
}

export interface DeviceSnapshotMetadata {
  snapshotName: string;
  deviceId: string;
  deviceName: string;
  platform: "android" | "ios";
  snapshotType: DeviceSnapshotType;
  includeAppData: boolean;
  includeSettings: boolean;
  createdAt: string;
  lastAccessedAt: string;
  sizeBytes: number;
  manifest: DeviceSnapshotManifest;
}
