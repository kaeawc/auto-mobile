import type { SavedPrototypeRestoreReport } from "../models/SavedPrototypeRestoreReport";
import type { ProxyManager, ProxySetupResult } from "../utils/interfaces/ProxyManager";
import { type PerformanceTracker } from "../utils/PerformanceTracker";
import type {
  AccessibilityVersionCheckOptions,
  AccessibilityVersionCheckResult,
} from "./AndroidCtrlProxyManagerTypes";

export interface CtrlProxySetupResult extends ProxySetupResult {
  savedPrototypeRestore?: SavedPrototypeRestoreReport;
}
export type ApkOverrideChecksumEntry = {
  mtimeMs: number;
  size: number;
  checksumPromise: Promise<string>;
};

/**
 * Android-specific accessibility-service lifecycle, extending the
 * platform-agnostic {@link ProxyManager}.
 */
export interface CtrlProxyManager extends ProxyManager {
  assertNotDrivenByOtherDaemon?(signal?: AbortSignal): Promise<void>;
  /** Reopen automated setup without invalidating availability or version caches. */
  reopenSetupGate(): void;
  setup(force?: boolean, perf?: PerformanceTracker): Promise<CtrlProxySetupResult>;
  isEnabled(): Promise<boolean>;
  /**
   * Re-toggle CtrlProxy's accessibility-service entry when dumpsys shows it is
   * crashed or unbound. Returns whether a rebind was attempted.
   */
  rebindIfUnhealthy(): Promise<boolean>;
  /**
   * Force-stop and re-add CtrlProxy's accessibility-service entry
   * unconditionally, even when {@link isAccessibilityServiceHealthy} already
   * reports it bound. This is the Android counterpart of iOS's
   * `forceRestart`: a service whose binding is healthy but which still cannot
   * produce a hierarchy never trips {@link rebindIfUnhealthy}'s health gate
   * (issue #7533). Returns whether a restart was attempted — false when the
   * device is offline or missing (mirroring `AndroidCtrlProxyClient`'s
   * pre-recovery device-presence check, issue #7532), so a caller cannot spin
   * this into a restart loop against a device that has disappeared.
   */
  forceRestartProcess(): Promise<boolean>;
  isEnabledForUser(userId: number): Promise<boolean>;
  getInstalledApkSha256(): Promise<string | null>;
  readSnapshotIdentity?(signal: AbortSignal): Promise<string>;
  isVersionCompatible(): Promise<boolean>;
  ensureCompatibleVersion(
    options?: AccessibilityVersionCheckOptions,
  ): Promise<AccessibilityVersionCheckResult>;
  downloadApk(): Promise<string>;
  install(apkPath: string): Promise<void>;
  enable(): Promise<void>;
  enableForUser(userId: number): Promise<void>;
  cleanupApk(apkPath: string): Promise<void>;
}

export interface CtrlProxyCompatibilityInspection {
  status: "not_installed" | "compatible" | "mismatch" | "unverifiable" | "skipped";
  expectedSha256: string;
  installedSha256: string | null;
  installedShaSource: "device" | "host" | "none";
  /** A known explicit release pin cannot be verified against this installed APK. */
  knownPinMismatch: boolean;
}

export { CtrlProxyApkInstallError } from "./CtrlProxyApkInstallError";

export { CtrlProxyInspectionError } from "./CtrlProxyInspectionError";

export {
  REBIND_BIND_WAIT_BUDGET_MS,
  REBIND_MUTATION_COMMAND_TIMEOUT_MS,
  REBIND_MUTATION_COMMAND_TIMEOUT_MAX_MS,
} from "./AndroidCtrlProxyRebind";

export {
  MAX_STALE_PREFETCH_DIRS_PER_STARTUP,
  STALE_PREFETCH_SWEEP_DEADLINE_MS,
} from "./CtrlProxyApkPrefetcher";
