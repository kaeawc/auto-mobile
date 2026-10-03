import type {
  CaptureSnapshotArgs,
  CaptureSnapshotResult,
  RestoreSnapshotArgs,
  RestoreSnapshotResult,
} from "../../models/DeviceSnapshot";

/**
 * Captures a device-state snapshot. Implemented by `CaptureSnapshot`,
 * which dispatches on device platform (Android and iOS).
 *
 * Platform-specific fields on {@link CaptureSnapshotArgs} (`appBundleIds` and
 * `strictBackupMode` are iOS-only) are ignored on the platform that doesn't
 * understand them — see the concrete implementation.
 */
export interface SnapshotCaptureProvider {
  capture(args: CaptureSnapshotArgs): Promise<CaptureSnapshotResult>;
}

/**
 * Restores a previously captured snapshot. Implemented by
 * `RestoreSnapshot`, which dispatches on device platform (Android and
 * iOS); the manifest in {@link RestoreSnapshotArgs} routes restore to the
 * right platform-specific recovery path.
 */
export interface SnapshotRestoreProvider {
  restore(args: RestoreSnapshotArgs): Promise<RestoreSnapshotResult>;
}
