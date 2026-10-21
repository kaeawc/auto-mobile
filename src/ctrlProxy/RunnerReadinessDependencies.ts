import type { CtrlProxyIosSetupResult } from "./ios/IosCtrlProxyContracts";
import type { BootedDevice, DeviceLockState } from "../models";
import type { HostChildProcess } from "../utils/HostCommandExecutor";
import type { CtrlProxyHealthCheckResult } from "./ios/IosCtrlProxyHealthClient";
import type { ViewHierarchyResult } from "../models/ViewHierarchyResult";
import type { PerformanceTracker } from "../utils/PerformanceTracker";
import type { Timer } from "../utils/SystemTimer";
import type { AccessibilityHierarchyRequest } from "../utils/interfaces/DeviceService";
import type { ProxySetupResult } from "../utils/interfaces/ProxyManager";
import type { TapCoordinatesRequest } from "../utils/interfaces/TapCoordinatesRequest";
import type { AndroidCompatibilityResult } from "./RunnerReadinessAttemptContext";

export interface ReadinessAndroidManager {
  isInstalled(signal?: AbortSignal): Promise<boolean>;
  isEnabled(signal?: AbortSignal, options?: { bypassCache?: boolean }): Promise<boolean>;
  /** Returns whether an unhealthy CtrlProxy accessibility service was rebound. */
  rebindIfUnhealthy?(): Promise<boolean>;
  /**
   * Force-stop and re-enable CtrlProxy unconditionally, for a service whose
   * accessibility binding is already healthy but which still cannot produce a
   * hierarchy (issue #7533) — the Android counterpart of
   * {@link ReadinessIosManager.forceRestart}. Returns whether a restart was
   * attempted (false when the device is offline or missing).
   */
  forceRestartProcess?(): Promise<boolean>;
  isVersionCompatible(): Promise<boolean>;
  enable(): Promise<void>;
  ensureCompatibleVersion(
    options?: {
      allowDownloadWhenInstalled?: boolean;
      bypassVersionCheckCache?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<AndroidCompatibilityResult>;
  setup(
    force?: boolean,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<ProxySetupResult>;
  resetSetupState(): void;
  reopenSetupGate(): void;
}

export interface ReadinessIosManager {
  /** Fresh liveness evidence; a timeout alone does not prove the runner is dead. */
  checkRunningWithReason?(): Promise<CtrlProxyHealthCheckResult>;
  /** Only an observed child exit proves death; an absent tracked child is inconclusive. */
  runnerSnapshot?(): {
    xcTestProcess: Pick<HostChildProcess, "exitCode" | "signalCode"> | null;
  };
  isInstalled(): Promise<boolean>;
  resetSetupState(): void;
  forceRestart(options?: {
    signal?: AbortSignal;
    minimumHealthPollDurationMs?: number;
  }): Promise<void>;
  start(options?: { signal?: AbortSignal; minimumHealthPollDurationMs?: number }): Promise<void>;
  setup(
    force?: boolean,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    minimumHealthPollDurationMs?: number,
  ): Promise<CtrlProxyIosSetupResult>;
  getServicePort(): number;
}

export interface ReadinessClient {
  beginReadinessHold?(): () => void;
  isClosed?(): boolean;
  getForwardFailureCause?(): string | undefined;
  isConnected(): boolean;
  waitForConnection(maxAttempts?: number, delayMs?: number): Promise<boolean>;
  verifyServiceReady(maxAttempts?: number, delayMs?: number, timeoutMs?: number): Promise<boolean>;
  /**
   * The most recent connect-attempt failure message, when the client tracks
   * one (issue #6260) — e.g. "Another AutoMobile process (PID N) owns
   * CtrlProxy forwarding...". Used to replace a generic "runner did not
   * become responsive" failure with the real, actionable cause when one is
   * known, instead of leaving it stuck at WARN in the daemon log where the
   * caller never sees it.
   */
  getLastConnectionFailureMessage?(): string | undefined;
  /**
   * Whether {@link getLastConnectionFailureMessage}'s message describes the
   * CtrlProxy forwarding-lease conflict specifically (issue #6260 PRRT
   * ft82e) — another AutoMobile process (typically a stale/orphaned daemon)
   * already owns forwarding for this device. Every OTHER connect failure
   * (ECONNREFUSED, a timeout, ...) must fall through to the existing
   * device diagnostics below instead of this generic transport text, so a
   * runner unavailable because its user is locked or still booting keeps
   * surfacing `primaryUserStartState`/`deviceLock`, not raw transport text.
   */
  isLastConnectionFailureForwardingLeaseConflict?(): boolean;
  /** Whether that conflict is a time-based refusal worth retrying within budget (#10485). */
  isLastConnectionFailureTransientLeaseConflict?(): boolean;
  /**
   * Clear the client's connection-attempt budget and cooldown clock (issue
   * #7538). Called after {@link ReadinessAndroidManager.rebindIfUnhealthy}
   * actually rebound the accessibility service, so the next
   * `waitForConnection` dials immediately instead of waiting out a cooldown
   * recorded before the rebind. Optional so fakes that never exercise the
   * cooldown gate need not implement it.
   */
  resetConnectionBudget?(): void;
  getAccessibilityHierarchy?(
    queryOptions?: undefined,
    request?: Pick<
      AccessibilityHierarchyRequest,
      "skipWaitForFresh" | "minTimestamp" | "disableAllFiltering" | "signal" | "timeoutMs"
    >,
  ): Promise<ViewHierarchyResult | null>;
  requestTapCoordinates?(
    request: TapCoordinatesRequest,
  ): Promise<{ success: boolean; error?: string }>;
}

export interface ReadinessIosClient extends ReadinessClient {
  /** Connect once without invoking the client's automatic CtrlProxy setup path. */
  connectWithoutSetup(signal?: AbortSignal): Promise<boolean>;
}

export interface AndroidRunnerConnectDiagnostic {
  deviceLock: DeviceLockState | null;
  primaryUserStartState?: string;
}

export interface AndroidRunnerHealthDiagnostic {
  sysBootCompleted: string;
  adbDevices: string;
  emulatorQemuHealth: string;
}

export interface AndroidFrameworkReadinessResult {
  ready: boolean;
  unavailableResources?: string[];
  diagnostic?: string;
}

export interface RunnerReadinessDependencies {
  timer: Timer;
  /** Maximum iOS transient startup attempts, including the initial setup. */
  iosSetupMaxAttempts?: number;
  iosPostSetupRestartMinFailedProbes?: number;
  getAndroidFrameworkReadiness?(
    device: BootedDevice,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<AndroidFrameworkReadinessResult>;
  getAndroidManager(device: BootedDevice): ReadinessAndroidManager;
  getAndroidClient(device: BootedDevice): ReadinessClient;
  getIosManager(device: BootedDevice): ReadinessIosManager;
  getIosClient(device: BootedDevice, port: number): ReadinessIosClient;
  checkIosOverride(): Promise<{ present: boolean; usable: boolean; reason?: string }>;
  awaitIosStartupMaintenance(): Promise<void>;
  getAndroidRunnerConnectDiagnostic?(
    device: BootedDevice,
    signal: AbortSignal,
  ): Promise<AndroidRunnerConnectDiagnostic>;
  getAndroidRunnerHealthDiagnostic?(
    device: BootedDevice,
    signal: AbortSignal,
  ): Promise<AndroidRunnerHealthDiagnostic>;
}
