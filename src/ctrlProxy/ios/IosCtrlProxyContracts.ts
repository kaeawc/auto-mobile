import type { IosRunnerLaunchGate } from "./IosRunnerLaunchGate";
import type { RunnerLaunchProgressProbe } from "./IosRunnerLaunchProgress";
import { type IosTunnelClient } from "./IosTunnelClient";
import type { IosPhysicalDeviceLister } from "../../utils/ios-cmdline-tools/DevicectlDeviceLister";
import { type IosAppBundleGuard } from "./IosAppBundleGuard";
import { IosDeviceDetector } from "./IosDeviceDetector";
import type { IosCtrlProxyStepOverrides } from "./IosCtrlProxyLifecycleSteps";
import { BootedDevice } from "../../models";
import { type PerformanceTracker } from "../../utils/PerformanceTracker";
import { Timer } from "../../utils/SystemTimer";
import { type CtrlProxyIosBuildResult } from "../IosCtrlProxyBuilder";
import type { IosCtrlProxyBuilderSurface } from "../IosCtrlProxyBuilderSurface";
import { type HostProcessExecutor } from "../../utils/HostCommandExecutor";
import { XcodeSigningManager } from "../../utils/ios-cmdline-tools/XcodeSigning";
import { type Xcodebuild } from "../../utils/ios-cmdline-tools/XcodebuildClient";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { ForcedRestartBudget } from "../ForcedRestartBudget";
import {
  type ProcessSupervisor,
  type ProcessSupervisorOptions,
} from "../../utils/ProcessSupervisor";
import { type HostPortAvailabilityChecker } from "./IOSHostPortAvailabilityChecker";
import { IosCtrlProxyProcessClient } from "./IosCtrlProxyProcessClient";
import type { ProxyManager, ProxySetupResult } from "../../utils/interfaces/ProxyManager";

export const MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES = 20;

export const DIRECT_RUNNER_DISCOVERY_DEADLINE_MS = 5_000;

export const STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS = 5_000;

export const IOS_CTRL_PROXY_HEALTH_POLL_INTERVAL_MS = 500;

// ProcessLifecycle and DaemonManager force-exit after ten seconds. This stage
// shares that budget with capture cleanup, so an unresponsive proxy must not
// consume it all before the remaining owners receive their stop attempt.
export const SHUTDOWN_STOP_TIMEOUT_MS = 1_200;

export const SHUTDOWN_FORCE_STOP_TIMEOUT_MS = 250;

// A fraction of SHUTDOWN_FORCE_STOP_TIMEOUT_MS: the ownership re-verify in
// forceStopForShutdown must not itself consume the budget the tree kill needs.
export const FORCE_STOP_OWNERSHIP_CHECK_TIMEOUT_MS = 100;

// Keep this budget exclusively for descendant-free SIGKILL commands after both
// ownership checks. Do not signal a tracked PID unless it could be inspected first.
export const FORCE_STOP_KILL_RESERVE_MS = 50;

// `stop()` tears the runner's process tree down, but its HTTP listener can keep
// answering /health for a moment while the process drains. A single probe fired
// the instant stop() returns races that drain and rejects a perfectly restartable
// runner ("still running after forced teardown"), so give the drain the same
// bounded grace the shutdown path already allows a forced stop before concluding
// the runner really is wedged.
export const FORCE_RESTART_DRAIN_GRACE_MS = SHUTDOWN_FORCE_STOP_TIMEOUT_MS;

export const FORCE_RESTART_DRAIN_POLL_INTERVAL_MS = 50;

/**
 * iOS-specific setup result; carries the build result alongside the
 * platform-agnostic fields.
 */
export interface CtrlProxyIosSetupResult extends ProxySetupResult {
  buildResult?: CtrlProxyIosBuildResult;
  /**
   * Only runner exit during startup or an exhausted launch window permits setup retry.
   * ensureIosReady passes the remaining setup budget as minimumHealthPollDurationMs;
   * refreshHealthPollDeadline takes max(default deadline, now + that duration).
   * Its launch timeout therefore occurs at/after the setup phase deadline, leaving
   * no budget for a launch-timeout retry on that path. Other callers may retry it.
   */
  retryableStartupFailure?: boolean;
  /** Startup was cancelled while another recovery path may still be active. */
  recoveryInterrupted?: boolean;
}

export interface CtrlProxyStartOptions {
  /**
   * Minimum health-poll duration after the runner has launched. startDevice
   * supplies its remaining readiness duration so a fixed manager default cannot
   * fail a still-starting runner early. A concurrent caller can extend an
   * in-progress shared startup poll.
   */
  minimumHealthPollDurationMs?: number;
  /** Cancels only this caller's wait for shared startup. */
  signal?: AbortSignal;
  /** Reconnect recovery joins an existing startup before considering a replacement. */
  joinInFlightStart?: boolean;
}

/**
 * iOS-specific runner process lifecycle, extending the platform-agnostic
 * {@link ProxyManager}.
 */
export interface CtrlProxyIosManager extends ProxyManager {
  getForcedRestartBudget(): ForcedRestartBudget;
  setup(
    force?: boolean,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    minimumHealthPollDurationMs?: number,
  ): Promise<CtrlProxyIosSetupResult>;
  isRunning(): Promise<boolean>;
  start(options?: CtrlProxyStartOptions): Promise<void>;
  stop(): Promise<void>;
  getServicePort(): number;
  getReportedRunnerPort(): Promise<number | null>;
  setAutoRestart(enabled: boolean): void;
  isAutoRestartEnabled(): boolean;
  forceRestart(options?: CtrlProxyStartOptions): Promise<void>;
  isRecoveryInFlight?(): boolean;
}

export interface RemoteCtrlProxyIOSRunner {
  isEnabled(): boolean;
  isRunningInDocker(): boolean;
  isAvailable(): Promise<boolean>;
  getHost(): string;
  runIdeviceId(
    args: string[],
  ): Promise<{ success: boolean; error?: string; data?: { stdout: string } }>;
  runIdeviceInstaller(
    args: string[],
  ): Promise<{ success: boolean; error?: string; data?: { stdout: string } }>;
  runSimctl(
    args: string[],
  ): Promise<{ success: boolean; error?: string; data?: { stdout: string } }>;
  startIproxy(params: {
    deviceId: string;
    localPort: number;
    devicePort?: number;
  }): Promise<{ success: boolean; error?: string; data?: { pid: number } }>;
  stopIproxy(params: {
    pid?: number;
    deviceId?: string;
    localPort?: number;
    devicePort?: number;
  }): Promise<{ success: boolean; error?: string }>;
  getIproxyStatus(params: {
    pid?: number;
    deviceId?: string;
    localPort?: number;
    devicePort?: number;
  }): Promise<{ success: boolean; error?: string; data?: { running: boolean; pid?: number } }>;
  start(params: {
    deviceId: string;
    port: number;
    xctestrunPath?: string;
    bundleId?: string;
    timeoutSeconds?: number;
  }): Promise<{
    success: boolean;
    error?: string;
    data?: { pid: number; message: string; port?: number };
  }>;
  stop(params: { deviceId?: string; pid?: number }): Promise<{ success: boolean; error?: string }>;
  status(params: { deviceId?: string; pid?: number; port?: number }): Promise<{
    success: boolean;
    error?: string;
    data?: { running: boolean; pid?: number; port?: number };
  }>;
}

export interface IproxyTunnelStartOptions {
  allowServicePortReallocation?: boolean;
  devicePort?: number;
  supervise?: boolean;
}

export interface ExternalCtrlProxyProcess {
  pid: number;
  port: number;
}

export interface ListeningProcess {
  pid: number;
  port: number;
  command: string;
  environment?: string;
  ppid?: number;
}

export type DaemonManagedRunnerTreeRoot =
  | { readonly kind: "root"; readonly pid: number }
  | { readonly kind: "not_daemon_managed" }
  | { readonly kind: "deadline_exhausted" };

export interface DaemonManagedRunnerParentRoot {
  readonly rootPid: number | null;
  readonly terminal: boolean;
}

export type { HostPortAvailabilityChecker };

/**
 * Capabilities of the iOS device for CtrlProxy
 */
export interface CtrlProxyIosCapabilities {
  supportsXCTest: boolean;
  deviceType: "simulator" | "physical";
  iosVersion: string | null;
  reason?: string;
}

/** Host-control runner used when none is configured: every call reports it is disabled. */
export const DISABLED_REMOTE_RUNNER: RemoteCtrlProxyIOSRunner = {
  isEnabled: () => false,
  isRunningInDocker: () => false,
  isAvailable: async () => false,
  getHost: () => "localhost",
  runIdeviceId: async () => ({ success: false, error: "Remote runner is disabled" }),
  runIdeviceInstaller: async () => ({ success: false, error: "Remote runner is disabled" }),
  runSimctl: async () => ({ success: false, error: "Remote runner is disabled" }),
  startIproxy: async () => ({ success: false, error: "Remote runner is disabled" }),
  stopIproxy: async () => ({ success: false, error: "Remote runner is disabled" }),
  getIproxyStatus: async () => ({ success: false, error: "Remote runner is disabled" }),
  start: async () => ({ success: false, error: "Remote runner is disabled" }),
  stop: async () => ({ success: false, error: "Remote runner is disabled" }),
  status: async () => ({ success: false, error: "Remote runner is disabled" }),
};

/** Unit-test default: an authoritative empty inventory, so tests never spawn devicectl. */
export const NO_PHYSICAL_DEVICES: IosPhysicalDeviceLister = {
  listConnectedDevices: async () => ({ devices: [], complete: true }),
};

export interface IosCtrlProxyManagerOptions {
  device: BootedDevice;
  runnerLaunchGate?: IosRunnerLaunchGate;
  runnerLaunchProgressProbe?: RunnerLaunchProgressProbe;
  timer?: Timer;
  builder?: IosCtrlProxyBuilderSurface;
  processExecutor?: HostProcessExecutor;
  signingManager?: XcodeSigningManager;
  deviceAppManager?: DeviceAppManager;
  remoteRunner?: RemoteCtrlProxyIOSRunner;
  hostPortAvailabilityChecker?: HostPortAvailabilityChecker;
  xcodebuild?: Xcodebuild;
  processClient?: IosCtrlProxyProcessClient;
  tunnelClient?: IosTunnelClient;
  /** Authoritative physical-device inventory (devicectl); defaults to the shared lister. */
  physicalDeviceLister?: IosPhysicalDeviceLister;
  /**
   * Replaces individual runner-lifecycle steps; each omitted step keeps the manager's own.
   * A function receives the manager's own steps so a test can decorate one and call through.
   */
  steps?: IosCtrlProxyStepOverrides;
  deviceDetector?: IosDeviceDetector;
  appBundleGuard?: IosAppBundleGuard;
  /** Consecutive missed health probes tolerated while the runner process stays alive. */
  healthMissThreshold?: number;
  /** Builds the runner supervisor; a test wraps the default to drive it directly. */
  processSupervisorFactory?: (options: ProcessSupervisorOptions) => ProcessSupervisor;
}

/** The dependencies a unit test may supply; omitted ones get the same defaults as `getInstance`. */
export type IosCtrlProxyManagerTestOptions = Omit<
  IosCtrlProxyManagerOptions,
  "timer" | "processExecutor"
> & { timer: Timer; processExecutor: HostProcessExecutor };
/**
 * What a start()-time check proved about the tracked runner: `healthy` means its
 * PID is alive and its health endpoint answered for this device; `alive` means
 * only liveness was established (remote PID-strict status); `dead` means neither.
 */
export type CtrlProxyProcessLiveness = "healthy" | "alive" | "dead";

export const IOS_CTRL_PROXY_STATUS_CACHE_TTL = 30 * 1000;
export const IOS_CTRL_PROXY_IMPORTANT_OUTPUT_MARKERS = [
  "error",
  "failed",
  "failure",
  "fatal",
  "exception",
  "crash",
  "panic",
  "timed out",
  "timeout",
  "denied",
  "unable",
  "not found",
  "xctestconfiguration",
];
export const IOS_CTRL_PROXY_MAX_RESTART_ATTEMPTS = 5;
export const IOS_CTRL_PROXY_RESTART_BASE_DELAY_MS = 2000;
export const IOS_CTRL_PROXY_RESTART_MAX_DELAY_MS = 30000;
export const IOS_CTRL_PROXY_DEFAULT_PORT = 8765;
export const IOS_CTRL_PROXY_DEFAULT_HEALTH_POLL_MAX_ATTEMPTS = 60;
export const IOS_CTRL_PROXY_FIRST_LAUNCH_HEALTH_WINDOW_MULTIPLIER = 2;
export const IOS_CTRL_PROXY_MAX_UNRESPONSIVE_RUNNER_RELAUNCHES = 2;
export const IOS_CTRL_PROXY_BUNDLE_ID = "dev.jasonpearson.automobile.ctrlproxy";
export const IOS_CTRL_PROXY_APP_BUNDLE_ID = "dev.jasonpearson.automobile.ctrlproxy";
export const IOS_CTRL_PROXY_LEGACY_APP_BUNDLE_ID = "dev.jasonpearson.automobile.XCTestServiceApp";

export const IOS_CTRL_PROXY_LAUNCH_PROGRESS_THRESHOLD_MS = 100;
export const IOS_CTRL_PROXY_MAX_PROGRESS_LAUNCH_MS = 300_000;
