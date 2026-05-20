import type {
  CaptureSnapshotArgs,
  CaptureSnapshotResult,
} from "../../features/action/CaptureSnapshot";
import type {
  RestoreSnapshotArgs,
  RestoreSnapshotResult,
} from "../../features/action/RestoreSnapshot";

/**
 * Captures a device-state snapshot. Implemented by `CaptureSnapshot`
 * (Android) and `CaptureSnapshotIos` (iOS).
 *
 * Platform-specific fields on {@link CaptureSnapshotArgs} (`appBundleIds`
 * iOS-only, `userApps` Android-only) are ignored on the platform that
 * doesn't understand them — see the concrete implementations.
 */
export interface SnapshotCaptureProvider {
  capture(args: CaptureSnapshotArgs): Promise<CaptureSnapshotResult>;
}

/**
 * Restores a previously captured snapshot. Implemented by
 * `RestoreSnapshot` (Android) and `RestoreSnapshotIos` (iOS); the
 * manifest in {@link RestoreSnapshotArgs} routes restore to the right
 * platform-specific recovery path.
 */
export interface SnapshotRestoreProvider {
  restore(args: RestoreSnapshotArgs): Promise<RestoreSnapshotResult>;
}
