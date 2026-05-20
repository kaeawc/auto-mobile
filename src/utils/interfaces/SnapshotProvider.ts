import type {
  CaptureSnapshotArgs,
  CaptureSnapshotResult,
} from "../../features/action/CaptureSnapshot";
import type {
  RestoreSnapshotArgs,
  RestoreSnapshotResult,
} from "../../features/action/RestoreSnapshot";

/**
 * Captures a device-state snapshot for the underlying platform.
 *
 * Implemented by `CaptureSnapshot` (Android) and `CaptureSnapshotIos`
 * (iOS). Both already share the {@link CaptureSnapshotArgs} input and
 * {@link CaptureSnapshotResult} output, so the contract is the true
 * semantic overlap — no platform-specific fields leak into the interface.
 *
 * Platform-specific fields on the args (e.g. `appBundleIds` for iOS,
 * `userApps` for Android) are still on the shared args type and are
 * simply ignored on platforms that do not understand them — see the
 * concrete implementations for the per-platform semantics.
 */
export interface SnapshotCaptureProvider {
  capture(args: CaptureSnapshotArgs): Promise<CaptureSnapshotResult>;
}

/**
 * Restores a previously captured device-state snapshot.
 *
 * Implemented by `RestoreSnapshot` (Android) and `RestoreSnapshotIos`
 * (iOS). The manifest carried in {@link RestoreSnapshotArgs} is what
 * lets the restore implementation route back to platform-specific
 * recovery (VM snapshot, adb backup, simctl container copy, …).
 */
export interface SnapshotRestoreProvider {
  restore(args: RestoreSnapshotArgs): Promise<RestoreSnapshotResult>;
}

/**
 * Aggregate platform-agnostic snapshot interface — implementations that
 * expose both capture and restore in one object can satisfy this. The
 * `deviceSnapshotManager` factory currently returns two distinct
 * provider objects (one capture, one restore) per call; new call sites
 * that want a unified handle should depend on this type.
 *
 * Methods are deliberately limited to the shared lifecycle — capture
 * and restore — so the interface does not leak Android-specific (VM
 * snapshot, adb backup) or iOS-specific (simctl container copy)
 * concepts.
 */
export interface SnapshotProvider extends SnapshotCaptureProvider, SnapshotRestoreProvider {}
