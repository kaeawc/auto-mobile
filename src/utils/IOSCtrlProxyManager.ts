import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import { BootedDevice } from "../models";
import { requireBootedDevice } from "./requireBootedDevice";
import {
  NoOpPerformanceTracker,
  createGlobalPerformanceTracker,
  type PerformanceTracker,
} from "./PerformanceTracker";
import { Timer, defaultTimer } from "./SystemTimer";
import { IOSCtrlProxyBuilder, type CtrlProxyIosBuildResult } from "./IOSCtrlProxyBuilder";
import { checkIosCtrlProxyOverride } from "./iosCtrlProxyOverride";
import { ActionableError } from "../models/ActionableError";
import { resolvePinnedVersion } from "../constants/release";
import { type ChildProcess } from "child_process";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "./PortManager";
import { DefaultHostCommandExecutor, type HostProcessExecutor } from "./HostCommandExecutor";
import { XcodeSigningManager } from "./ios-cmdline-tools/XcodeSigning";
import { XcodebuildClient, type Xcodebuild } from "./ios-cmdline-tools/XcodebuildClient";
import { DeviceAppManager } from "./ios-cmdline-tools/DeviceAppManager";
import { isIosSimulatorUdid } from "./ios-cmdline-tools/iosDeviceType";
import { exponentialBackoff } from "./Backoff";
import { DefaultProcessSupervisor, type ProcessSupervisor } from "./ProcessSupervisor";
import {
  TcpHostPortAvailabilityChecker,
  type HostPortAvailabilityChecker,
} from "./ios/IOSHostPortAvailabilityChecker";
import { IOSCtrlProxyHealthClient, isValidCtrlProxyPort } from "./ios/IOSCtrlProxyHealthClient";
import { IOSCtrlProxyProcessClient } from "./ios/IOSCtrlProxyProcessClient";
import type { ProxyManager, ProxySetupResult } from "./interfaces/ProxyManager";

export const MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES = 20;
export const DIRECT_RUNNER_DISCOVERY_DEADLINE_MS = 5_000;
export const STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS = 5_000;
// ProcessLifecycle and DaemonManager force-exit after ten seconds. This stage
// shares that budget with capture cleanup, so an unresponsive proxy must not
// consume it all before the remaining owners receive their stop attempt.
const SHUTDOWN_STOP_TIMEOUT_MS = 1_200;
const SHUTDOWN_FORCE_STOP_TIMEOUT_MS = 250;
const IPROXY_GRACEFUL_STOP_TIMEOUT_MS = 1_000;

/**
 * iOS-specific setup result; carries the build result alongside the
 * platform-agnostic fields.
 */
export interface CtrlProxyIosSetupResult extends ProxySetupResult {
  buildResult?: CtrlProxyIosBuildResult;
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
}

interface SharedCtrlProxyStart {
  controller: AbortController;
  completion: Promise<void>;
  healthPollDeadlineMs: number | null;
  defaultHealthPollDeadlineMs: number | null;
  callerHealthPollDeadlinesMs: Map<symbol, number>;
  teardownCommitted: boolean;
  waitingCallers: number;
  completed: boolean;
}

/**
 * iOS-specific runner process lifecycle, extending the platform-agnostic
 * {@link ProxyManager}.
 */
export interface CtrlProxyIosManager extends ProxyManager {
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
}

interface RemoteCtrlProxyIOSRunner {
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

interface ExternalCtrlProxyProcess {
  pid: number;
  port: number;
}

interface ListeningProcess {
  pid: number;
  port: number;
  command: string;
  environment?: string;
  ppid?: number;
}

type DaemonManagedRunnerTreeRoot =
  | { readonly kind: "root"; readonly pid: number }
  | { readonly kind: "not_daemon_managed" }
  | { readonly kind: "deadline_exhausted" };

interface DaemonManagedRunnerParentRoot {
  readonly rootPid: number | null;
  readonly terminal: boolean;
}

// Re-exported from the extracted collaborator (issue #3218) so existing
// consumers/tests keep importing it from this facade module.
export type { HostPortAvailabilityChecker };

class RemoteServicePortUnavailableError extends Error {
  constructor(host: string, port: number) {
    super(`Remote runner port ${port} is already in use on ${host}`);
    this.name = "RemoteServicePortUnavailableError";
  }
}

/** Marks a forced-restart failure caused by its initiating caller cancelling. */
class ForceRestartCancelledError extends Error {
  constructor(reason: unknown) {
    super(errorMessage(reason), { cause: reason });
    this.name = "ForceRestartCancelledError";
  }
}

/**
 * Capabilities of the iOS device for CtrlProxy
 */
interface CtrlProxyIosCapabilities {
  supportsXCTest: boolean;
  deviceType: "simulator" | "physical";
  iosVersion: string | null;
  reason?: string;
}

/**
 * iOS CtrlProxy Manager
 * Manages the lifecycle of CtrlProxy running on iOS simulator or device
 */
export class IOSCtrlProxyManager implements CtrlProxyIosManager {
  private readonly device: BootedDevice;
  private readonly timer: Timer;
  private servicePort: number;
  private readonly builder: IOSCtrlProxyBuilder;
  private readonly processExecutor: HostProcessExecutor;
  private readonly xcodebuild: Xcodebuild;
  private readonly processClient: IOSCtrlProxyProcessClient;
  private readonly signingManager: XcodeSigningManager;
  private readonly deviceAppManager: DeviceAppManager;
  private readonly remoteRunner: RemoteCtrlProxyIOSRunner;
  private readonly hostPortAvailabilityChecker: HostPortAvailabilityChecker;
  private readonly healthClient: IOSCtrlProxyHealthClient;
  private remoteRunnerAvailability: Promise<boolean> | null = null;

  // Singleton instances per device
  private static instances: Map<string, IOSCtrlProxyManager> = new Map();
  private static startupOrphanRunnerReap: Promise<void> | null = null;

  // Cache for status checks
  private cachedAvailability: { isAvailable: boolean; timestamp: number } | null = null;
  private cachedInstalled: { isInstalled: boolean; timestamp: number } | null = null;
  private cachedRunning: { isRunning: boolean; timestamp: number } | null = null;
  private static readonly AVAILABILITY_CACHE_TTL = 60 * 60 * 1000; // 1 hour
  private static readonly STATUS_CACHE_TTL = 30 * 1000; // 30 seconds
  private static readonly IMPORTANT_OUTPUT_MARKERS = [
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

  // Setup state tracking
  private attemptedSetup: boolean = false;

  // XCUITest process state
  private xcTestProcessId: number | null = null;
  private xcTestProcess: ChildProcess | null = null;

  // Process supervision
  private readonly processSupervisor: ProcessSupervisor;
  private readonly iproxySupervisor: ProcessSupervisor;
  private isProcessSupervisorRestarting = false;
  private static readonly MAX_RESTART_ATTEMPTS = 5;
  private static readonly RESTART_BASE_DELAY_MS = 2000;
  private static readonly RESTART_MAX_DELAY_MS = 30000;
  private static readonly PORT_RELEASE_GRACE_MS = 250;
  private static readonly PORT_RELEASE_ATTEMPTS = 4;

  // iproxy tunnel state (physical devices)
  private iproxyProcessId: number | null = null;
  private iproxyProcess: ChildProcess | null = null;
  private iproxyDevicePort: number | null = null;
  private isStopping: boolean = false;

  // Shared process startup prevents concurrent callers from launching duplicate runners.
  private sharedStart: SharedCtrlProxyStart | null = null;
  // A forced restart must retain lifecycle ownership through its non-interruptible
  // stop phase, even when the readiness caller times out before it settles.
  private forceRestartInFlight: Promise<void> | null = null;
  // Lets ordinary starts detect that a newer forced restart began while they
  // yielded before claiming the shared-start slot.
  private forceRestartGeneration = 0;
  // Joining callers may need a longer health-poll budget than the restart owner.
  // Retain their request until the forced restart reaches shared startup.
  private readonly forceRestartHealthPollDurationsMs = new Map<symbol, number>();

  // Target app bundle ID for CtrlProxy to observe (instead of SpringBoard)
  private targetBundleId: string | null = null;

  public static readonly DEFAULT_PORT = 8765;
  /** Health-poll attempts (× 500ms) awaiting the runner. 60 = 30s; env-overridable. */
  private static readonly DEFAULT_HEALTH_POLL_MAX_ATTEMPTS = 60;
  public static readonly BUNDLE_ID = "dev.jasonpearson.automobile.ctrlproxy";
  public static readonly APP_BUNDLE_ID = "dev.jasonpearson.automobile.ctrlproxy";
  /** Bundle ID used before the rename to CtrlProxy — uninstalled opportunistically on device setup */
  private static readonly LEGACY_APP_BUNDLE_ID = "dev.jasonpearson.automobile.XCTestServiceApp";
  private static readonly IPROXY_MONITOR_INTERVAL_MS = 5000;
  private static readonly IPROXY_RESTART_BASE_DELAY_MS = 1000;
  private static readonly IPROXY_RESTART_MAX_DELAY_MS = 15000;
  private static readonly DEFAULT_IPROXY_START_TIMEOUT_MS = 5000;

  private constructor(
    device: BootedDevice,
    timer: Timer = defaultTimer,
    builder?: IOSCtrlProxyBuilder,
    processExecutor: HostProcessExecutor = new DefaultHostCommandExecutor(),
    signingManager: XcodeSigningManager = new XcodeSigningManager(),
    deviceAppManager: DeviceAppManager = new DeviceAppManager(),
    remoteRunner?: RemoteCtrlProxyIOSRunner,
    hostPortAvailabilityChecker: HostPortAvailabilityChecker = new TcpHostPortAvailabilityChecker(),
    xcodebuild: Xcodebuild = new XcodebuildClient(),
    processClient?: IOSCtrlProxyProcessClient,
  ) {
    this.device = device;
    this.timer = timer;
    this.servicePort = this.allocateServicePort();
    this.builder = builder || IOSCtrlProxyBuilder.getInstance();
    this.processExecutor = processExecutor;
    this.xcodebuild = xcodebuild;
    this.processClient = processClient ?? new IOSCtrlProxyProcessClient();
    this.signingManager = signingManager;
    this.deviceAppManager = deviceAppManager;
    this.hostPortAvailabilityChecker = hostPortAvailabilityChecker;
    this.remoteRunner = remoteRunner || {
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
    this.healthClient = new IOSCtrlProxyHealthClient(this.processExecutor, this.timer, {
      useRemoteRunner: () => this.useRemoteRunner(),
      getHost: () => this.remoteRunner.getHost(),
      deviceId: this.device.deviceId,
    });
    this.processSupervisor = new DefaultProcessSupervisor({
      name: "iOS CtrlProxy XCTest runner",
      timer: this.timer,
      monitorIntervalMs: 30000,
      maxRestartAttempts: IOSCtrlProxyManager.MAX_RESTART_ATTEMPTS,
      restartBackoff: exponentialBackoff({
        initialDelayMs: IOSCtrlProxyManager.RESTART_BASE_DELAY_MS,
        maxDelayMs: IOSCtrlProxyManager.RESTART_MAX_DELAY_MS,
      }),
      restart: async () => {
        this.isProcessSupervisorRestarting = true;
        try {
          await this.start();
        } finally {
          this.isProcessSupervisorRestarting = false;
        }
      },
      isAlive: () => this.isSupervisedCtrlProxyProcessAlive(),
      onExit: () => {
        this.xcTestProcessId = null;
        this.xcTestProcess = null;
        this.clearCaches();
      },
      onRestartSuccess: () => {
        logger.info("[IOSCtrlProxy] Auto-restart successful");
      },
      onRestartFailure: (error) => {
        logger.warn(`[IOSCtrlProxy] Auto-restart failed: ${errorMessage(error)}`);
      },
    });
    this.iproxySupervisor = new DefaultProcessSupervisor({
      name: "iOS iproxy tunnel",
      timer: this.timer,
      monitorIntervalMs: IOSCtrlProxyManager.IPROXY_MONITOR_INTERVAL_MS,
      restartBackoff: exponentialBackoff({
        initialDelayMs: IOSCtrlProxyManager.IPROXY_RESTART_BASE_DELAY_MS,
        maxDelayMs: IOSCtrlProxyManager.IPROXY_RESTART_MAX_DELAY_MS,
      }),
      restart: () => this.restartIproxyTunnel(),
      isAlive: () => this.isSupervisedIproxyTunnelAlive(),
      onExit: () => {
        this.iproxyProcessId = null;
        this.iproxyProcess = null;
      },
      onRestartFailure: (error) => {
        logger.warn(`[IOSCtrlProxy] Failed to restart iproxy: ${errorMessage(error)}`);
      },
    });
  }

  /**
   * Get singleton instance for a device
   */
  public static getInstance(device: BootedDevice, timer?: Timer): IOSCtrlProxyManager {
    requireBootedDevice(device, "IOSCtrlProxyManager.getInstance");
    if (!IOSCtrlProxyManager.instances.has(device.deviceId)) {
      IOSCtrlProxyManager.instances.set(device.deviceId, new IOSCtrlProxyManager(device, timer));
    }
    return IOSCtrlProxyManager.instances.get(device.deviceId)!;
  }

  /**
   * Create instance for testing with injected dependencies
   */
  public static createForTesting(
    device: BootedDevice,
    timer: Timer,
    builder?: IOSCtrlProxyBuilder,
  ): IOSCtrlProxyManager {
    return new IOSCtrlProxyManager(device, timer, builder);
  }

  /**
   * Create instance for testing with injected dependencies
   */
  public static createForTestingWithDeps(
    device: BootedDevice,
    timer: Timer,
    builder: IOSCtrlProxyBuilder | undefined,
    processExecutor: HostProcessExecutor,
    signingManager?: XcodeSigningManager,
    deviceAppManager?: DeviceAppManager,
    remoteRunner?: RemoteCtrlProxyIOSRunner,
    hostPortAvailabilityChecker?: HostPortAvailabilityChecker,
    xcodebuild?: Xcodebuild,
    processClient?: IOSCtrlProxyProcessClient,
  ): IOSCtrlProxyManager {
    return new IOSCtrlProxyManager(
      device,
      timer,
      builder,
      processExecutor,
      signingManager,
      deviceAppManager,
      remoteRunner,
      hostPortAvailabilityChecker,
      xcodebuild ??
        new XcodebuildClient(
          async (file, args) => processExecutor.executeCommand(file, args),
          timer,
          (command, args, options) => processExecutor.spawn(command, args, options),
        ),
      processClient ?? new IOSCtrlProxyProcessClient(processExecutor, timer),
    );
  }

  /**
   * Reset all instances (for testing)
   */
  public static resetInstances(): void {
    IOSCtrlProxyManager.instances.clear();
    IOSCtrlProxyManager.startupOrphanRunnerReap = null;
  }

  /**
   * Stop all active instances (for shutdown)
   */
  public static async shutdownAll(timer: Timer = defaultTimer): Promise<void> {
    const instances = Array.from(IOSCtrlProxyManager.instances.values());
    const results = await Promise.all(
      instances.map((instance) => IOSCtrlProxyManager.stopWithinShutdownDeadline(instance, timer)),
    );
    IOSCtrlProxyManager.instances.clear();
    for (const result of results) {
      if (result !== null) {
        logger.warn(`[IOSCtrlProxy] Failed to stop instance during shutdown: ${result}`);
      }
    }
  }

  private static async stopWithinShutdownDeadline(
    instance: IOSCtrlProxyManager,
    timer: Timer,
  ): Promise<unknown | null> {
    let timeout: NodeJS.Timeout | undefined;
    let forceStopStarted = false;
    const settled = instance.stop().then(
      () => null,
      (error) => error,
    );
    const timedOut = new Promise<Error>((resolve) => {
      timeout = timer.setTimeout(() => {
        // stop() may be blocked on a remote runner call. Reserve a bounded
        // window to await direct termination before clearing the registry.
        forceStopStarted = true;
        void IOSCtrlProxyManager.forceStopWithinShutdownDeadline(instance, timer).then(() =>
          resolve(new Error(`timed out after ${SHUTDOWN_STOP_TIMEOUT_MS}ms`)),
        );
      }, SHUTDOWN_STOP_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([settled, timedOut]);
      if (result !== null && !forceStopStarted) {
        await IOSCtrlProxyManager.forceStopWithinShutdownDeadline(instance, timer);
      }
      return result;
    } finally {
      if (timeout) {
        timer.clearTimeout(timeout);
      }
    }
  }

  private static async forceStopWithinShutdownDeadline(
    instance: IOSCtrlProxyManager,
    timer: Timer,
  ): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeout = timer.setTimeout(resolve, SHUTDOWN_FORCE_STOP_TIMEOUT_MS);
    });
    try {
      await Promise.race([instance.forceStopForShutdown(), deadline]);
    } finally {
      if (timeout) {
        timer.clearTimeout(timeout);
      }
    }
  }

  private async forceStopForShutdown(): Promise<void> {
    this.isStopping = true;
    this.processSupervisor.stop();
    this.iproxySupervisor.stop();

    const runnerPid = this.xcTestProcessId;
    const iproxyPid = this.iproxyProcessId;
    const iproxyProcess = this.iproxyProcess;
    this.xcTestProcessId = null;
    this.xcTestProcess = null;
    this.iproxyProcessId = null;
    this.iproxyProcess = null;
    this.iproxyDevicePort = null;
    this.clearCaches();
    PortManager.release(this.device.deviceId);

    if (this.useRemoteRunner()) {
      await Promise.allSettled([
        runnerPid
          ? this.remoteRunner.stop({ deviceId: this.device.deviceId, pid: runnerPid })
          : undefined,
        iproxyPid ? this.remoteRunner.stopIproxy({ pid: iproxyPid }) : undefined,
      ]);
      return;
    }

    try {
      if (iproxyProcess && typeof iproxyProcess.kill === "function") {
        iproxyProcess.kill("SIGKILL");
      } else if (iproxyPid) {
        process.kill(iproxyPid, "SIGKILL");
      }
    } catch (error) {
      // A child can exit between tracking and shutdown.
      logger.debug(`[IOSCtrlProxy] Forced iproxy termination was already complete: ${error}`);
    }
    if (runnerPid) {
      await this.processClient.terminateProcessTree(runnerPid).catch((error) => {
        logger.warn(`[IOSCtrlProxy] Forced CtrlProxy runner termination failed: ${error}`);
      });
    }
  }

  /**
   * Starts orphan reaping during daemon initialization while retaining the
   * promise so the first simulator request cannot adopt a runner being reaped.
   */
  public static startOrphanRunnerReapOnStartup(
    processClient: IOSCtrlProxyProcessClient = new IOSCtrlProxyProcessClient(),
    timer: Timer = defaultTimer,
  ): Promise<void> {
    const work = IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(processClient, timer);
    const completedWork = work.catch((error) => {
      logger.debug(`[IOSCtrlProxy] Startup orphan runner sweep failed: ${error}`);
    });
    IOSCtrlProxyManager.startupOrphanRunnerReap =
      IOSCtrlProxyManager.completeWithinStartupReapDeadline(completedWork, timer);
    return IOSCtrlProxyManager.startupOrphanRunnerReap;
  }

  /**
   * Best-effort startup sweep for orphaned CtrlProxy iOS runner processes left
   * behind by a previously crashed daemon.
   */
  public static async reapOrphanedRunnerProcessesOnStartup(
    processClient: IOSCtrlProxyProcessClient = new IOSCtrlProxyProcessClient(),
    timer: Timer = defaultTimer,
  ): Promise<void> {
    const deadline = timer.now() + STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS;
    let pids: number[] = [];
    try {
      pids = await processClient.findStartupCandidatePids(deadline);
    } catch (error) {
      logger.debug(
        `[IOSCtrlProxy] Failed to enumerate CtrlProxy iOS processes during startup sweep: ${error}`,
      );
      return;
    }

    const reapedRootPids = new Set<number>();
    for (const pid of pids) {
      if (timer.now() >= deadline) {
        IOSCtrlProxyManager.logStartupOrphanRunnerReapDeadline();
        return;
      }
      try {
        if (
          !(await IOSCtrlProxyManager.reapStartupOrphanRunnerCandidate(
            processClient,
            pid,
            deadline,
            timer,
            reapedRootPids,
          ))
        ) {
          return;
        }
      } catch (error) {
        logger.debug(
          `[IOSCtrlProxy] Failed to reap orphaned CtrlProxy iOS process ${pid}: ${error}`,
        );
        if (timer.now() >= deadline) {
          IOSCtrlProxyManager.logStartupOrphanRunnerReapDeadline();
          return;
        }
      }
    }
  }

  private static async reapStartupOrphanRunnerCandidate(
    processClient: IOSCtrlProxyProcessClient,
    pid: number,
    deadline: number,
    timer: Timer,
    reapedRootPids: Set<number>,
  ): Promise<boolean> {
    const root = await IOSCtrlProxyManager.findStartupOrphanRunnerRoot(
      processClient,
      pid,
      deadline,
      timer,
    );
    if (root.kind === "deadline_exhausted" || timer.now() >= deadline) {
      IOSCtrlProxyManager.logStartupOrphanRunnerReapDeadline();
      return false;
    }
    if (root.kind !== "root" || reapedRootPids.has(root.pid)) {
      return true;
    }
    if (reapedRootPids.size >= MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES) {
      logger.warn(
        `[IOSCtrlProxy] startup sweep skipped 1 startup CtrlProxy runner candidate after ` +
          `reaching the ${MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES}-candidate cap`,
      );
      return false;
    }
    reapedRootPids.add(root.pid);
    logger.info(`[IOSCtrlProxy] Reaping orphaned CtrlProxy iOS process tree rooted at ${root.pid}`);
    await processClient.terminateProcessTree(root.pid, deadline);
    if (timer.now() >= deadline) {
      IOSCtrlProxyManager.logStartupOrphanRunnerReapDeadline();
      return false;
    }
    return true;
  }

  private static async findStartupOrphanRunnerRoot(
    processClient: IOSCtrlProxyProcessClient,
    pid: number,
    deadline: number,
    timer: Timer,
  ): Promise<DaemonManagedRunnerTreeRoot> {
    const processInfo = await processClient.getProcessInfo(pid, deadline);
    if (!processInfo || !processClient.isCtrlProxyRunnerCommand(processInfo.command)) {
      return { kind: "not_daemon_managed" };
    }
    return IOSCtrlProxyManager.findDaemonManagedRunnerTreeRoot(
      processClient,
      {
        pid,
        port: IOSCtrlProxyManager.DEFAULT_PORT,
        command: processInfo.command,
        environment: processInfo.environment,
        ppid: processInfo.ppid,
      },
      {
        requireOrphanedRoot: true,
        shouldContinue: () => timer.now() < deadline,
        deadline,
      },
    );
  }

  /**
   * Get the port the service is running on
   */
  public getServicePort(): number {
    return this.servicePort;
  }

  /**
   * Set the target app bundle ID for CtrlProxy to observe.
   * Must be called before start() — CtrlProxy reads the bundle ID from
   * the CTRL_PROXY_IOS_BUNDLE_ID env var at XCUITest initialization time.
   * Falls back to process.env.CTRL_PROXY_IOS_BUNDLE_ID if not set explicitly.
   */
  public setTargetBundleId(bundleId: string): void {
    this.targetBundleId = bundleId;
    logger.info(`[IOSCtrlProxy] Target bundle ID set to ${bundleId}`);
  }

  /**
   * Resolve the currently-targeted app bundle ID (explicit
   * {@link setTargetBundleId} value > `CTRL_PROXY_IOS_BUNDLE_ID` env var >
   * undefined). Public read-only companion to {@link setTargetBundleId}; used by
   * OpenURL to route a custom-scheme deep link into the owning/target app on a
   * physical device. Does not mutate state.
   */
  public getTargetBundleId(): string | undefined {
    return this.resolveTargetBundleId();
  }

  /**
   * Read the target bundle ID for a device **without constructing** a manager
   * instance. Prefer this over `getInstance(device).getTargetBundleId()` for a
   * pure read: `getInstance` builds the whole per-device proxy stack and
   * {@link allocateServicePort reserves a global service port} as a side effect,
   * which is wrong for a caller (e.g. OpenURL's custom-scheme branch) that only
   * needs to know the currently-targeted app. Returns the explicit target from a
   * pre-existing instance (set by a prior `launchApp`) > `CTRL_PROXY_IOS_BUNDLE_ID`
   * env var > undefined.
   */
  public static getExistingTargetBundleId(device: BootedDevice): string | undefined {
    return (
      IOSCtrlProxyManager.instances.get(device.deviceId)?.getTargetBundleId() ??
      process.env.CTRL_PROXY_IOS_BUNDLE_ID ??
      undefined
    );
  }

  /**
   * Resolve the target bundle ID: explicit property > env var > undefined.
   */
  private resolveTargetBundleId(): string | undefined {
    return this.targetBundleId ?? process.env.CTRL_PROXY_IOS_BUNDLE_ID ?? undefined;
  }

  /**
   * Clear all caches
   */
  public clearCaches(): void {
    this.cachedAvailability = null;
    this.cachedInstalled = null;
    this.cachedRunning = null;
    logger.info("[IOSCtrlProxy] Cleared all caches");
  }

  /**
   * Reset setup state to allow fresh setup
   */
  public resetSetupState(): void {
    this.attemptedSetup = false;
    this.clearCaches();
    logger.info("[IOSCtrlProxy] Reset setup state");
  }

  // MARK: - Status Checks

  /**
   * Check if CtrlProxy is installed on the device
   * For simulators, this checks if the test bundle can be found
   */
  public async isInstalled(): Promise<boolean> {
    // Check cache first
    if (this.cachedInstalled) {
      const cacheAge = this.timer.now() - this.cachedInstalled.timestamp;
      if (cacheAge < IOSCtrlProxyManager.STATUS_CACHE_TTL) {
        return this.cachedInstalled.isInstalled;
      }
    }

    try {
      logger.debug("[IOSCtrlProxy] Checking if CtrlProxy is installed");

      // Check if we're on a simulator
      if (this.isSimulator()) {
        // For simulators, check if we can find the test bundle
        // The test bundle would be installed via xcodebuild test
        // For now, we assume it's available if we can communicate with it
        this.cachedInstalled = { isInstalled: true, timestamp: this.timer.now() };
        return true;
      } else {
        // For physical devices, check if the test app is installed
        if (this.useRemoteRunner()) {
          const result = await this.remoteRunner.runIdeviceInstaller([
            "-u",
            this.device.deviceId,
            "-l",
          ]);
          if (!result.success || !result.data) {
            this.cachedInstalled = { isInstalled: false, timestamp: this.timer.now() };
            return false;
          }
          const installed = result.data.stdout.includes(IOSCtrlProxyManager.BUNDLE_ID);
          this.cachedInstalled = { isInstalled: installed, timestamp: this.timer.now() };
          return installed;
        }

        const { stdout } = await this.processExecutor.executeCommand("ideviceinstaller", [
          "-u",
          this.device.deviceId,
          "-l",
        ]);
        const installed = stdout.includes(IOSCtrlProxyManager.BUNDLE_ID);
        this.cachedInstalled = { isInstalled: installed, timestamp: this.timer.now() };
        return installed;
      }
    } catch (error) {
      logger.warn(`[IOSCtrlProxy] Error checking installation: ${error}`);
      return false;
    }
  }

  /**
   * Check if CtrlProxy is currently running
   */
  public async isRunning(): Promise<boolean> {
    // Check cache first
    if (this.cachedRunning) {
      const cacheAge = this.timer.now() - this.cachedRunning.timestamp;
      if (cacheAge < IOSCtrlProxyManager.STATUS_CACHE_TTL) {
        return this.cachedRunning.isRunning;
      }
    }

    try {
      logger.info("[IOSCtrlProxy] Checking if CtrlProxy is running");

      // Check if the WebSocket server is responding
      const isRunning = await this.checkHealthEndpoint();

      // Cache the result
      this.cachedRunning = {
        isRunning,
        timestamp: this.timer.now(),
      };

      return isRunning;
    } catch (error) {
      logger.warn(`[IOSCtrlProxy] Error checking running status: ${error}`);
      return false;
    }
  }

  /**
   * Check if the service is available (installed and running)
   */
  public async isAvailable(): Promise<boolean> {
    // Check cache first
    if (this.cachedAvailability && this.cachedAvailability.isAvailable) {
      const cacheAge = this.timer.now() - this.cachedAvailability.timestamp;
      if (cacheAge < IOSCtrlProxyManager.AVAILABILITY_CACHE_TTL) {
        return this.cachedAvailability.isAvailable;
      }
    }

    const [installed, running] = await Promise.all([this.isInstalled(), this.isRunning()]);

    const available = installed && running;

    this.cachedAvailability = {
      isAvailable: available,
      timestamp: this.timer.now(),
    };

    return available;
  }

  // MARK: - Service Control

  /**
   * Start CtrlProxy
   */
  public async start(options: CtrlProxyStartOptions = {}): Promise<void> {
    for (;;) {
      await this.waitForForceRestart(options);
      const expectedForceRestartGeneration = this.forceRestartGeneration;
      if (this.forceRestartInFlight) {
        continue;
      }
      return this.startAfterForceRestart(options, expectedForceRestartGeneration);
    }
  }

  private async startAfterForceRestart(
    options: CtrlProxyStartOptions,
    expectedForceRestartGeneration?: number,
  ): Promise<void> {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("iOS CtrlProxy startup was aborted");
    }

    let sharedStart = await this.waitForNonJoinableStart(options.signal);
    if (expectedForceRestartGeneration !== undefined &&
      (this.forceRestartGeneration !== expectedForceRestartGeneration || this.forceRestartInFlight)) {
      return this.start(options);
    }
    if (sharedStart) {
      logger.info("[IOSCtrlProxy] Start already in progress, waiting for it to complete");
    } else {
      const controller = new AbortController();
      const createdStart: SharedCtrlProxyStart = {
        controller,
        completion: Promise.resolve(),
        healthPollDeadlineMs: null,
        defaultHealthPollDeadlineMs: null,
        callerHealthPollDeadlinesMs: new Map(),
        teardownCommitted: false,
        waitingCallers: 0,
        completed: false,
      };
      this.sharedStart = createdStart;
      createdStart.completion = this.startInternal(createdStart);
      void createdStart.completion
        .finally(() => {
          createdStart.completed = true;
          if (this.sharedStart === createdStart) {
            this.sharedStart = null;
          }
        })
        .catch(() => {});
      sharedStart = createdStart;
    }

    const callerId = Symbol("CtrlProxy startup caller");
    this.extendHealthPollDeadline(sharedStart, callerId, options.minimumHealthPollDurationMs);
    return this.waitForSharedStart(sharedStart, options.signal, callerId);
  }

  private async waitForNonJoinableStart(
    signal: AbortSignal | undefined,
  ): Promise<SharedCtrlProxyStart | null> {
    const sharedStart = this.sharedStart;
    if (
      !sharedStart ||
      (!sharedStart.controller.signal.aborted && !sharedStart.teardownCommitted)
    ) {
      return sharedStart;
    }
    logger.info("[IOSCtrlProxy] Waiting for a non-joinable startup to settle before retrying");
    try {
      await this.waitForSharedStart(sharedStart, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
    }
    if (this.sharedStart === sharedStart) {
      this.sharedStart = null;
    }
    return this.sharedStart;
  }

  /**
   * Internal start implementation (called within mutex)
   */
  private async startInternal(sharedStart: SharedCtrlProxyStart): Promise<void> {
    // Authoritative fail-closed gate (#4221): this is the single chokepoint every
    // launch path funnels through (startDevice, session-reuse in toolRegistry, and
    // discovery-pooled devices that never hit verifyIosDevice/ensureCtrlProxyReady).
    // If a local runner override is set but unusable, refuse to start rather than
    // silently launching the released runner and driving the device with it.
    const iosOverride = await checkIosCtrlProxyOverride();
    if (iosOverride.present && !iosOverride.usable) {
      throw new ActionableError(
        `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH / _IPA_PATH is set but unusable: ${iosOverride.reason}`,
      );
    }

    await this.awaitStartupOrphanRunnerReap();

    logger.info("[IOSCtrlProxy] Starting CtrlProxy");
    this.isStopping = false;
    const perf = createGlobalPerformanceTracker();

    // Prefer process liveness check over health endpoint: a busy-but-alive CtrlProxy
    // would fail the HTTP health check and incorrectly trigger a restart.
    perf.startOperation("processAliveCheck");
    const isAlive = await this.isCtrlProxyProcessAlive();
    perf.endOperation("processAliveCheck");
    let restartedAliveProcess = false;
    // True when we deferred to an already-starting own runner instead of respawning;
    // drives hung-runner recovery after the health wait below (#2834 review).
    let waitedForStartingRunner = false;
    if (isAlive) {
      logger.info("[IOSCtrlProxy] CtrlProxy process is alive, skipping start");
      // On physical devices the iproxy tunnel may have been stopped independently
      // (e.g. by a temporary disconnect) while the XCTest process kept running.
      // Re-establishing it here is a no-op when the tunnel is already up, and
      // self-heals the connection when it is not.
      if (!this.isSimulator()) {
        perf.startOperation("iproxyTunnel");
        try {
          await this.startIproxyTunnel({ allowServicePortReallocation: false });
        } catch (error) {
          perf.endOperation("iproxyTunnel");
          if (!(error instanceof RemoteServicePortUnavailableError)) {
            throw error;
          }
          logger.warn(
            "[IOSCtrlProxy] Existing CtrlProxy process uses a host port that is no longer available; restarting",
          );
          perf.startOperation("spawnRunner");
          await this.restartDeviceProcessAfterHostPortCollision();
          perf.endOperation("spawnRunner");
          restartedAliveProcess = true;
        }
        if (!restartedAliveProcess) {
          perf.endOperation("iproxyTunnel");
          await this.iproxySupervisor.start();
        }
      }
      if (!restartedAliveProcess) {
        await this.startProcessSupervision();
        return;
      }
    }

    if (!restartedAliveProcess) {
      perf.startOperation("runningCheck");
      const alreadyRunning = await this.isRunning();
      perf.endOperation("runningCheck");
      if (alreadyRunning) {
        logger.info("[IOSCtrlProxy] Service is already running");
        await this.startProcessSupervision();
        return;
      }

      // Check for externally-managed xcodebuild processes (e.g. hot-reload script)
      // before spawning our own to avoid conflicting xcodebuild instances.
      if (this.isSimulator()) {
        // Decide about OUR OWN tracked runner first. A runner WE already spawned may
        // still be mid-startup: on a loaded CI machine XCUITest can take well past the
        // health-poll budget to answer, so an earlier setup() gave up and this call is a
        // retry while the same runner is still coming up. Its PID is alive but its health
        // endpoint isn't yet. Reclaiming the port here would SIGTERM that starting runner
        // and restart the clock — a livelock under repeated setup calls (#2834). Wait for
        // it instead. Checking this BEFORE the external-process probe is important: that
        // probe discovers our own child xcodebuild (whose PID differs from the tracked
        // shell PID under shell:true) and would otherwise mis-classify it as "external"
        // (#2834 review). A runner that actually came up healthy on the default port
        // instead of our reallocated port (#2731) is handled by the health-wait recovery
        // below, which re-checks the default port and adopts it rather than terminating.
        if (await this.isOwnRunnerProcessAlive()) {
          logger.info(
            `[IOSCtrlProxy] Own CtrlProxy runner (PID ${this.xcTestProcessId}) is still starting; ` +
              `waiting for its health endpoint instead of respawning`,
          );
          waitedForStartingRunner = true;
        } else {
          perf.startOperation("externalProcessCheck");
          const externalProcess = await this.findExternalCtrlProxyProcess();
          const defaultPortIsHealthyForDevice =
            externalProcess === null &&
            !this.useRemoteRunner() &&
            this.servicePort !== IOSCtrlProxyManager.DEFAULT_PORT &&
            (await this.checkHealthEndpointOnPortForDevice(
              IOSCtrlProxyManager.DEFAULT_PORT,
              this.device.deviceId,
            ));
          perf.endOperation("externalProcessCheck");
          if (externalProcess || defaultPortIsHealthyForDevice) {
            const externalPort = externalProcess?.port ?? IOSCtrlProxyManager.DEFAULT_PORT;
            // Warn (not info): the daemon is about to serve calls through a runner
            // it did NOT launch (#5561). On a shared host this may be a stale or
            // foreign runner — surfacing it loudly stops results from being
            // misattributed to a local build that never ran.
            logger.warn(
              `[IOSCtrlProxy] Reusing an external CtrlProxy runner this daemon did not launch ` +
                `(port ${externalPort}); skipping spawn. Verify it is the runner you intend to test.`,
            );
            if (externalPort !== this.servicePort) {
              this.adoptServicePort(externalPort);
            }
            // Fall through to health polling below instead of spawning
          } else {
            await this.ensureServicePortReadyForLaunch();
            perf.startOperation("spawnRunner");
            await this.startOnSimulator();
            perf.endOperation("spawnRunner");
          }
        }
      } else {
        perf.startOperation("spawnRunner");
        await this.startOnDevice();
        perf.endOperation("spawnRunner");
      }
    }

    // Wait for HTTP health endpoint to be ready. XCUITest can take well over 15s to
    // fully initialize after xcodebuild starts on a loaded CI machine, so the budget
    // is env-configurable (AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS) and defaults
    // generous — too short a budget declares failure while the runner is still
    // coming up, which then triggers a kill+respawn livelock (#2834).
    const delayMs = 500;
    const defaultHealthPollDurationMs =
      IOSCtrlProxyManager.resolveHealthPollMaxAttempts() * delayMs;
    sharedStart.defaultHealthPollDeadlineMs = this.timer.now() + defaultHealthPollDurationMs;
    this.refreshHealthPollDeadline(sharedStart);
    const timeoutSeconds = Math.round(
      ((sharedStart.healthPollDeadlineMs ?? 0) - this.timer.now()) / 1000,
    );

    if (await this.waitForHealthEndpoint(sharedStart, perf, delayMs)) {
      await this.completeHealthStartup(sharedStart, perf);
      return;
    }

    if (waitedForStartingRunner && this.xcTestProcessId !== null) {
      // Before giving up, adopt the runner if it actually came up healthy on CtrlProxy's
      // default port (env-injection fallback #2731) rather than our reallocated port —
      // the health poll above only checks servicePort, so a runner that bound the default
      // port would look "hung" here. Adopt it instead of killing a healthy runner
      // (#2834 review).
      if (
        this.servicePort !== IOSCtrlProxyManager.DEFAULT_PORT &&
        (await this.checkHealthEndpointOnPortForDevice(
          IOSCtrlProxyManager.DEFAULT_PORT,
          this.device.deviceId,
        ))
      ) {
        logger.info(
          `[IOSCtrlProxy] Deferred-to runner is healthy on default port ${IOSCtrlProxyManager.DEFAULT_PORT}; ` +
            `adopting it instead of terminating`,
        );
        this.adoptServicePort(IOSCtrlProxyManager.DEFAULT_PORT);
        this.clearCaches();
        // Mirror the normal success path's WebSocket-init settle (#2834 review — MINOR-3).
        await this.sleepForHealthPoll(500, sharedStart.controller.signal);
        await this.startProcessSupervision();
        return;
      }
      if (await this.completeHealthStartupIfDeadlineExtended(sharedStart, perf, delayMs)) {
        return;
      }
      // Otherwise it is genuinely hung. Merely un-tracking it is NOT enough: the process
      // stays alive and its environment carries AUTOMOBILE_DEVICE_ID, so on the next
      // start() findExternalCtrlProxyProcess() would re-adopt it ("external CtrlProxy
      // detected, skipping spawn") and we would defer to the hung runner forever, never
      // respawning (#2834 review — restore stale-runner cleanup after the health wait).
      // Terminate it outright so the next start() spawns a fresh runner.
      //
      // Re-verify ownership right before the kill: the multi-minute health poll above is
      // a window in which our runner could exit and its PID be recycled to a foreign
      // process. Locally, isOwnRunnerProcessAlive re-runs getProcessInfo +
      // isOwnedCtrlProxyRunnerProcess on the tracked PID, so a recycled/foreign PID is
      // no longer identified as ours and we skip the kill, only un-tracking. Under host
      // control the re-verify is PID-strict via `status.data.pid === tracked` — the
      // remote daemon resolves status/stop by deviceId BEFORE pid, so without the
      // PID compare a NEWER runner for this device would alias as "ours" and the stop
      // below could kill it (#2834 review). Residual accepted risk: the status→stop
      // race (runner replaced between the two calls) — the daemon is the sole per-device
      // orchestrator, so within one daemon that window is effectively empty; daemon-side
      // pid-match enforcement is tracked as a follow-up.
      const hungPid = this.xcTestProcessId;
      const stillOurs = await this.isOwnRunnerProcessAlive();
      if (await this.completeHealthStartupIfDeadlineExtended(sharedStart, perf, delayMs)) {
        return;
      }
      sharedStart.teardownCommitted = true;
      // Suppress the exit-handler auto-restart across the kill + child-exit event only.
      this.isStopping = true;
      try {
        if (stillOurs) {
          logger.warn(
            `[IOSCtrlProxy] Deferred-to CtrlProxy runner (PID ${hungPid}) never became ` +
              `healthy within ${timeoutSeconds}s; terminating it so the next start spawns a fresh runner`,
          );
          if (this.useRemoteRunner()) {
            // The runner PID belongs to the macOS HOST, not this (Docker) container —
            // a local kill would miss it (or signal an unrelated same-PID container
            // process). Stop it through remote runner, matching stop() (#2834 review).
            try {
              await this.remoteRunner.stop({ deviceId: this.device.deviceId, pid: hungPid });
            } catch (error) {
              logger.warn(
                `[IOSCtrlProxy] Remote runner stop of hung runner ${hungPid} failed: ` +
                  `${errorMessage(error)}`,
              );
            }
          } else {
            // Tree kill, not single-PID: the tracked PID is the shell wrapper, and
            // signaling only it would orphan the xcodebuild child, which keeps the
            // hung in-sim runner alive to be re-adopted or contend the port on the
            // next start (#2834 review).
            await this.processClient.terminateProcessTree(hungPid);
          }
        } else {
          logger.warn(
            `[IOSCtrlProxy] Tracked runner PID ${hungPid} is no longer our CtrlProxy runner ` +
              `(exited/PID-reused); un-tracking without terminating`,
          );
        }
        this.xcTestProcessId = null;
        this.xcTestProcess = null;
        // Host-control mode has no local child-exit event to clear these as a side
        // effect (handleProcessExit), so clear explicitly for both modes — otherwise
        // cachedRunning/cachedAvailability can serve a stale positive to the next
        // setup() for up to STATUS_CACHE_TTL (#2834 review).
        this.clearCaches();
        this.processSupervisor.stop();
        await this.processSupervisor.start();
      } finally {
        // Do NOT leave isStopping latched across the throw below (#2834 review — MINOR-2):
        // a caller that does not retry start() would otherwise wedge the manager in
        // "stopping", disabling handleProcessExit()/scheduleAutoRestart() self-heal.
        // A late child-exit after this reset is ignored by the untracked-exit guard on
        // the spawn handlers (xcTestProcess was nulled above).
        this.isStopping = false;
      }
    }

    const heldProcesses = await this.findListeningProcessesOnPort(this.servicePort);
    if (await this.completeHealthStartupIfDeadlineExtended(sharedStart, perf, delayMs)) {
      return;
    }
    if (heldProcesses.length > 0) {
      throw new Error(
        `CtrlProxy failed to start within timeout (${timeoutSeconds}s); port ${this.servicePort} ` +
          `still held by ${this.formatListeningProcesses(heldProcesses)}`,
      );
    }

    throw new Error(`CtrlProxy failed to start within timeout (${timeoutSeconds}s)`);
  }

  /**
   * Stop CtrlProxy
   */
  public async stop(): Promise<void> {
    logger.info("[IOSCtrlProxy] Stopping CtrlProxy");
    this.isStopping = true;

    this.processSupervisor.stop();

    if (this.useRemoteRunner()) {
      try {
        if (this.xcTestProcessId) {
          await this.remoteRunner.stop({
            deviceId: this.device.deviceId,
            pid: this.xcTestProcessId,
          });
        }
      } catch (error) {
        logger.warn(`[IOSCtrlProxy] Remote runner stop failed: ${errorMessage(error)}`);
      }

      if (!this.isSimulator()) {
        await this.stopIproxyTunnel({ clearDevicePort: true });
      }

      this.xcTestProcessId = null;
      this.xcTestProcess = null;
      this.clearCaches();
      PortManager.release(this.device.deviceId);
      this.isStopping = false;
      logger.info("[IOSCtrlProxy] Service stopped");
      return;
    }

    // Stop iproxy tunnel if running
    await this.stopIproxyTunnel({ clearDevicePort: true });

    if (this.xcTestProcessId) {
      try {
        if (await this.isOwnRunnerProcessAlive()) {
          await this.processClient.terminateProcessTree(this.xcTestProcessId);
        } else {
          logger.debug(
            `[IOSCtrlProxy] Tracked runner PID ${this.xcTestProcessId} is not an owned CtrlProxy runner; ` +
              `clearing without terminating`,
          );
        }
      } catch (error) {
        logger.warn(
          `[IOSCtrlProxy] Failed to terminate tracked CtrlProxy runner ${this.xcTestProcessId}: ` +
            `${errorMessage(error)}`,
        );
      }
      this.xcTestProcessId = null;
      this.xcTestProcess = null;
    }

    this.clearCaches();
    PortManager.release(this.device.deviceId);
    this.isStopping = false;
    logger.info("[IOSCtrlProxy] Service stopped");
  }

  /**
   * Complete setup process for CtrlProxy
   * Includes automatic build detection and prefetch integration
   */
  /**
   * Uninstall the legacy CtrlProxy iOSApp if still present on the device.
   * This cleans up the old bundle ID left over from before the rename to CtrlProxy.
   */
  private async uninstallLegacyAppIfPresent(): Promise<void> {
    try {
      const simulator = this.isSimulator();
      const isInstalled = await this.deviceAppManager.getInstalledAppBundleHash(
        this.device.deviceId,
        IOSCtrlProxyManager.LEGACY_APP_BUNDLE_ID,
        simulator,
      );
      if (isInstalled === null) {
        return;
      }
      logger.info(
        `[IOSCtrlProxy] Found legacy app ${IOSCtrlProxyManager.LEGACY_APP_BUNDLE_ID}, uninstalling`,
      );
      await this.deviceAppManager.uninstallApp(
        this.device.deviceId,
        IOSCtrlProxyManager.LEGACY_APP_BUNDLE_ID,
        simulator,
      );
      logger.info(`[IOSCtrlProxy] Legacy app uninstalled`);
    } catch (error) {
      logger.warn(`[IOSCtrlProxy] Failed to check/uninstall legacy app: ${error}`);
    }
  }

  public async setup(
    force: boolean = false,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
    minimumHealthPollDurationMs?: number,
  ): Promise<CtrlProxyIosSetupResult> {
    perf.serial("xcTestServiceSetup");

    // Fail closed before any reuse/short-circuit (already-running, already-attempted)
    // can serve an unverifiable pinned runner (#2746).
    if (IOSCtrlProxyBuilder.isPinnedVersionUnverifiable()) {
      perf.end();
      return {
        success: false,
        message:
          `AUTOMOBILE_VERSION=${resolvePinnedVersion()} is not in the AutoMobile release ` +
          `checksum registry, so the CtrlProxy bundle cannot be integrity-verified. ` +
          `Pin a released version, or vendor a trusted bundle via AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH.`,
        perfTiming: perf.getTimings(),
      };
    }

    await this.uninstallLegacyAppIfPresent();

    if (this.attemptedSetup && !force) {
      const isAvail = await this.isAvailable();
      if (isAvail) {
        perf.end();
        return {
          success: true,
          message: "CtrlProxy was already running",
          perfTiming: perf.getTimings(),
        };
      }
      perf.end();
      return {
        success: false,
        message: "Setup already attempted",
        perfTiming: perf.getTimings(),
      };
    }

    try {
      this.attemptedSetup = true;

      // Check if already running
      const isRunning = await perf.track("checkRunning", () => this.isRunning());
      if (!force && isRunning) {
        perf.end();
        return {
          success: true,
          message: "CtrlProxy was already running",
          perfTiming: perf.getTimings(),
        };
      }

      // Check if build is needed
      const needsBuild = this.useRemoteRunner()
        ? false
        : await perf.track("checkBuild", () =>
            this.builder.needsRebuild(this.isSimulator() ? "simulator" : "device"),
          );

      let buildResult: CtrlProxyIosBuildResult | null = null;
      if (needsBuild) {
        // Check for prefetched result first
        const prefetchedResult = IOSCtrlProxyBuilder.getPrefetchedResult();
        if (prefetchedResult && prefetchedResult.success) {
          logger.info("[IOSCtrlProxy] Using prefetched build result");
          buildResult = prefetchedResult;
        } else {
          // Wait for prefetch if in progress
          const waitedResult = await perf.track("waitForPrefetch", () =>
            IOSCtrlProxyBuilder.waitForPrefetch(),
          );
          if (waitedResult && waitedResult.success) {
            logger.info("[IOSCtrlProxy] Using completed prefetch build result");
            buildResult = waitedResult;
          } else {
            // Build synchronously
            logger.info("[IOSCtrlProxy] Downloading CtrlProxy bundle");
            buildResult = await perf.track("build", () =>
              this.builder.build(this.isSimulator() ? "simulator" : "device", perf),
            );
            if (!buildResult.success) {
              this.attemptedSetup = false; // Allow retry on next call
              perf.end();
              return {
                success: false,
                message: buildResult.message,
                error: buildResult.error,
                buildResult,
                perfTiming: perf.getTimings(),
              };
            }
          }
        }
      }

      // Start the service
      await perf.track("startService", () => this.start({ minimumHealthPollDurationMs, signal }));

      perf.end();
      return {
        success: true,
        message: needsBuild
          ? "CtrlProxy downloaded and started successfully"
          : "CtrlProxy started successfully",
        buildResult: buildResult || undefined,
        perfTiming: perf.getTimings(),
      };
    } catch (error) {
      this.attemptedSetup = false; // Allow retry on next call
      const errorMsg = errorMessage(error);
      perf.end();
      return {
        success: false,
        message: "Failed to setup CtrlProxy",
        error: errorMsg,
        perfTiming: perf.getTimings(),
      };
    }
  }

  // MARK: - Private Helpers

  private isSimulator(): boolean {
    // Simulators have UUIDs like "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX";
    // physical devices have serial-style UDIDs.
    return isIosSimulatorUdid(this.device.deviceId);
  }

  private useRemoteRunner(): boolean {
    return this.remoteRunner.isEnabled() && this.remoteRunner.isRunningInDocker();
  }

  private allocateServicePort(additionalReservedPorts: Iterable<number> = []): number {
    return PortManager.allocate(this.device.deviceId, {
      reservedPorts: [...IOS_CTRL_PROXY_RESERVED_PORTS, ...additionalReservedPorts],
    });
  }

  private ensureLocalServicePortAllocatedAndAvailable(): void {
    const currentAllocation = PortManager.getPort(this.device.deviceId);
    const currentPortIsAvailable = PortManager.isPortAvailable(this.servicePort);
    if (currentAllocation === this.servicePort && currentPortIsAvailable) {
      return;
    }

    const additionalReservedPorts = currentPortIsAvailable ? [] : [this.servicePort];
    PortManager.release(this.device.deviceId);
    const nextPort = this.allocateServicePort(additionalReservedPorts);
    if (nextPort !== this.servicePort) {
      logger.info(
        `[IOSCtrlProxy] Reallocated service port from ${this.servicePort} to ${nextPort} before runner launch`,
      );
      this.servicePort = nextPort;
      this.clearCaches();
    }
  }

  private adoptServicePort(port: number): void {
    if (PortManager.getPort(this.device.deviceId) !== port) {
      PortManager.reserve(this.device.deviceId, port);
    }
    if (this.servicePort !== port) {
      this.servicePort = port;
      this.clearCaches();
    }
  }

  private async ensureRemoteServicePortAvailable(
    options: { allowReallocation?: boolean } = {},
  ): Promise<void> {
    const allowReallocation = options.allowReallocation ?? true;
    const host = this.remoteRunner.getHost();
    const unavailablePorts = new Set<number>();

    for (let attempt = 0; attempt < PortManager.getMaxDevices(); attempt++) {
      if (await this.hostPortAvailabilityChecker.isAvailable(host, this.servicePort)) {
        return;
      }

      const unavailablePort = this.servicePort;
      logger.warn(
        `[IOSCtrlProxy] Remote runner port ${unavailablePort} is already in use on ${host}; reallocating`,
      );
      if (!allowReallocation) {
        throw new RemoteServicePortUnavailableError(host, unavailablePort);
      }
      unavailablePorts.add(unavailablePort);
      PortManager.release(this.device.deviceId);
      this.servicePort = this.allocateServicePort(unavailablePorts);
    }

    throw new Error(
      `No remote iOS CtrlProxy ports are available for device ${this.device.deviceId}.`,
    );
  }

  private async isRemoteRunnerAvailable(): Promise<boolean> {
    if (!this.remoteRunnerAvailability) {
      this.remoteRunnerAvailability = this.remoteRunner.isAvailable();
    }
    return this.remoteRunnerAvailability;
  }

  private async restartDeviceProcessAfterHostPortCollision(): Promise<void> {
    await this.stop();
    this.isStopping = false;
    await this.startOnDevice();
  }

  private async startOnSimulator(): Promise<void> {
    logger.info("[IOSCtrlProxy] Starting CtrlProxy on simulator");

    if (this.useRemoteRunner()) {
      if (!(await this.isRemoteRunnerAvailable())) {
        throw new Error("Remote runner not available for CtrlProxy startup");
      }

      const existingProcess = await this.remoteRunner.status({ deviceId: this.device.deviceId });
      const existingServicePort = existingProcess.data?.port;
      if (
        existingProcess.success &&
        existingProcess.data?.running &&
        typeof existingServicePort === "number"
      ) {
        logger.info(
          `[IOSCtrlProxy] Reusing remote CtrlProxy process on service port ${existingServicePort}`,
        );
        this.adoptServicePort(existingServicePort);
        this.xcTestProcessId = existingProcess.data.pid ?? null;
        this.xcTestProcess = null;
        return;
      }

      await this.ensureRemoteServicePortAvailable();

      const xctestrunPath = await this.builder.getXctestrunPath("simulator");
      const bundleId = this.resolveTargetBundleId();
      const result = await this.remoteRunner.start({
        deviceId: this.device.deviceId,
        port: this.servicePort,
        xctestrunPath: xctestrunPath || undefined,
        bundleId,
      });

      if (!result.success || !result.data) {
        throw new Error(result.error || "Remote runner failed to start CtrlProxy");
      }

      if (typeof result.data.port === "number") {
        this.adoptServicePort(result.data.port);
      }
      this.xcTestProcessId = result.data.pid;
      this.xcTestProcess = null;
      return;
    }

    // Use xcodebuild test-without-building (same approach as physical devices).
    // simctl spawn is unreliable on Xcode 26.3+ (NSPOSIXErrorDomain code=2).
    const xctestrunPath = await this.builder.getXctestrunPath("simulator");
    if (!xctestrunPath) {
      throw new Error(
        "CtrlProxy xctestrun not found for simulator. Download the CtrlProxy bundle before starting.",
      );
    }

    // Re-verify the runner binary hash (and refuse a foreign-owned derived-data
    // tree) IMMEDIATELY before launch, closing the verify→execute TOCTOU window
    // left by post-extract verification alone (issue #4759).
    await this.builder.verifyRunnerBinaryBeforeLaunch("simulator");

    const timeout = process.env.CTRL_PROXY_IOS_TIMEOUT || "86400";
    const bundleId = this.resolveTargetBundleId();
    this.ensureLocalServicePortAllocatedAndAvailable();

    // The runner reads CTRL_PROXY_IOS_PORT from its OWN ProcessInfo.environment.
    // `xcodebuild test-without-building` does not forward the host process env
    // (or SIMCTL_CHILD_*) into the in-simulator runner — the only channel that
    // reaches it is the xctestrun's per-target EnvironmentVariables dict. Inject
    // there so the runner binds the allocated port instead of its hardcoded
    // default 8765 (issue #2731).
    const runnerEnv: Record<string, string> = {
      CTRL_PROXY_IOS_PORT: String(this.servicePort),
      CTRL_PROXY_IOS_TIMEOUT: timeout,
      AUTOMOBILE_DEVICE_ID: this.device.deviceId,
    };
    if (bundleId) {
      runnerEnv.CTRL_PROXY_IOS_BUNDLE_ID = bundleId;
      logger.info(
        `[IOSCtrlProxy] Passing CTRL_PROXY_IOS_BUNDLE_ID=${bundleId} to runner via xctestrun`,
      );
    }
    const runnerXctestrunPath = await this.builder.writeRunnerEnvironment(
      xctestrunPath,
      runnerEnv,
      this.device.deviceId,
    );

    const args = [
      "test-without-building",
      "-xctestrun",
      runnerXctestrunPath,
      "-destination",
      `platform=iOS Simulator,id=${this.device.deviceId}`,
      "-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
    ];

    logger.info(
      "[IOSCtrlProxy] Using xcodebuild test-without-building to start runner on simulator",
    );

    // The streaming client uses piped stdio rather than exec(), so verbose
    // hierarchy dumps cannot exhaust an output buffer.
    // runnerEnv is ALSO set on the host xcodebuild process env — not for the runner
    // (it can't see host env) but so the daemon can later discover, own, and recover
    // this process by reading its env via `ps eww` (see findExternalXcodebuildCtrlProxyProcess
    // / isDaemonManagedSimulatorXcodebuildProcess).
    // `xcodebuild` itself becomes the detached process-group leader. This keeps
    // terminateProcessTree's group cleanup effective without a shell wrapper.
    const child = await this.xcodebuild.startStreaming(args, {
      detached: true,
      env: { ...process.env, ...runnerEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.on("error", (error) => {
      // Ignore events from a process we no longer track (e.g. hung-recovery already
      // tore it down and cleared tracking) so a late error can't double-run cleanup
      // or schedule an auto-restart of a deliberately-removed runner (#2834 review).
      if (this.xcTestProcess !== child) {
        return;
      }
      logger.warn(`[IOSCtrlProxy] xcodebuild test error: ${error.message}`);
      this.handleProcessExit();
    });

    child.on("exit", (code, signal) => {
      if (code !== 0 || signal) {
        logger.warn(`[IOSCtrlProxy] xcodebuild test exited: code=${code}, signal=${signal}`);
      }
      // Same untracked-exit guard as the error handler: after hung-recovery (or stop())
      // has already cleaned up and untracked this child, its late exit event must not
      // re-enter handleProcessExit and race an auto-restart against the caller.
      if (this.xcTestProcess !== child) {
        return;
      }
      this.handleProcessExit();
    });

    if (child.pid) {
      this.xcTestProcessId = child.pid;
      this.xcTestProcess = child;
      logger.info(`[IOSCtrlProxy] Started xcodebuild test with PID ${child.pid}`);

      // Capture output for debugging
      this.captureProcessOutput(child);
    }
  }

  /**
   * Capture process output for debugging
   */
  private captureProcessOutput(child: ChildProcess): void {
    if (child.stdout) {
      child.stdout.on("data", (data: Buffer | string) => {
        const output = data.toString().trim();
        if (output && this.shouldPromoteCtrlProxyOutput(output)) {
          logger.info(`[CtrlProxy stdout] ${output.slice(0, 500)}`);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data: Buffer | string) => {
        const output = data.toString().trim();
        if (output && !output.includes("Build Succeeded")) {
          if (this.shouldPromoteCtrlProxyOutput(output)) {
            logger.warn(`[CtrlProxy stderr] ${output.slice(0, 500)}`);
          } else {
            logger.debug(`[CtrlProxy stderr] ${output.slice(0, 500)}`);
          }
        }
      });
    }
  }

  private shouldPromoteCtrlProxyOutput(output: string): boolean {
    if (process.env.AUTOMOBILE_CTRLPROXY_VERBOSE === "true") {
      return true;
    }

    const lower = output.toLowerCase();
    return IOSCtrlProxyManager.IMPORTANT_OUTPUT_MARKERS.some((marker) => lower.includes(marker));
  }

  /**
   * Handle process exit
   */
  private handleProcessExit(): void {
    this.processSupervisor.processExited();
  }

  private async startProcessSupervision(): Promise<void> {
    if (!this.isProcessSupervisorRestarting) {
      await this.processSupervisor.start();
    }
  }

  private async isSupervisedCtrlProxyProcessAlive(): Promise<boolean> {
    const isHealthy = await this.checkHealthEndpoint();
    if (isHealthy || !this.xcTestProcessId) {
      return true;
    }

    const processRunning = this.useRemoteRunner()
      ? await this.isOwnRunnerProcessAlive()
      : await this.isProcessRunning(this.xcTestProcessId);
    if (!processRunning) {
      logger.warn("[IOSCtrlProxy] XCTest process crashed, health endpoint not responding");
    }
    return processRunning;
  }

  /**
   * Enable or disable auto-restart
   */
  public setAutoRestart(enabled: boolean): void {
    this.processSupervisor.setAutoRestart(enabled);
    logger.info(`[IOSCtrlProxy] Auto-restart ${enabled ? "enabled" : "disabled"}`);
  }

  /**
   * Check if auto-restart is enabled
   */
  public isAutoRestartEnabled(): boolean {
    return this.processSupervisor.isAutoRestartEnabled();
  }

  /**
   * Force restart the service (useful when client detects issues)
   */
  public async forceRestart(options: CtrlProxyStartOptions = {}): Promise<void> {
    logger.info("[IOSCtrlProxy] Force restart requested");

    const existingRestart = this.forceRestartInFlight;
    if (existingRestart) {
      const restarted = await this.waitForForceRestart(options);
      if (restarted) {
        return;
      }
      return this.forceRestart(options);
    }

    // Stop cannot be interrupted safely. Keep subsequent start/restart callers
    // behind this barrier until teardown settles, even if the initiating
    // readiness phase has already timed out.
    this.forceRestartGeneration += 1;
    const restart = (async () => {
      try {
        await this.stop();
        if (options.signal?.aborted) {
          throw new ForceRestartCancelledError(
            options.signal.reason ?? new Error("iOS CtrlProxy restart was aborted"),
          );
        }
        if (await this.checkHealthEndpointOnPortForDevice(this.servicePort, this.device.deviceId)) {
          throw new Error(
            "iOS CtrlProxy is still running after forced teardown; refusing to reuse a potentially unresponsive runner",
          );
        }
        await this.startAfterForceRestart({
          ...options,
          minimumHealthPollDurationMs: this.maximumForceRestartHealthPollDurationMs(
            options.minimumHealthPollDurationMs,
          ),
        });
      } catch (error) {
        if (options.signal?.aborted && !(error instanceof ForceRestartCancelledError)) {
          throw new ForceRestartCancelledError(options.signal.reason ?? error);
        }
        throw error;
      }
    })();
    this.forceRestartInFlight = restart;
    void restart.finally(() => {
      if (this.forceRestartInFlight === restart) {
        this.forceRestartInFlight = null;
        this.forceRestartHealthPollDurationsMs.clear();
      }
    }).catch(() => {});
    await restart;
  }

  private async waitForForceRestart(options: CtrlProxyStartOptions): Promise<boolean> {
    const restart = this.forceRestartInFlight;
    if (!restart) {
      return true;
    }
    const healthPollCaller = this.registerForceRestartHealthPollDuration(
      options.minimumHealthPollDurationMs,
    );
    const waitForRestart = async (): Promise<boolean> => {
      try {
        await restart;
        return true;
      } catch (error) {
        if (error instanceof ForceRestartCancelledError) {
          // The earlier caller's deadline must not poison a later live caller.
          return false;
        }
        throw error;
      }
    };
    try {
      const { signal } = options;
      if (!signal) {
        return await waitForRestart();
      }
      if (signal.aborted) {
        throw signal.reason ?? new Error("iOS CtrlProxy startup was aborted");
      }
      return await new Promise<boolean>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("iOS CtrlProxy startup was aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        void waitForRestart().then(
          (restarted) => {
            signal.removeEventListener("abort", onAbort);
            resolve(restarted);
          },
          (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    } finally {
      this.removeForceRestartHealthPollDuration(healthPollCaller);
    }
  }

  private maximumForceRestartHealthPollDurationMs(ownerDurationMs: number | undefined): number | undefined {
    const joiningDurationMs = Math.max(0, ...this.forceRestartHealthPollDurationsMs.values());
    const maximumDurationMs = Math.max(ownerDurationMs ?? 0, joiningDurationMs);
    return maximumDurationMs > 0 ? maximumDurationMs : undefined;
  }

  private registerForceRestartHealthPollDuration(durationMs: number | undefined): symbol | undefined {
    if (!durationMs || durationMs <= 0) {
      return undefined;
    }
    const callerId = Symbol("CtrlProxy forced restart caller");
    this.forceRestartHealthPollDurationsMs.set(callerId, durationMs);
    if (this.sharedStart) {
      this.extendHealthPollDeadline(this.sharedStart, callerId, durationMs);
    }
    return callerId;
  }

  private removeForceRestartHealthPollDuration(callerId: symbol | undefined): void {
    if (!callerId) {
      return;
    }
    this.forceRestartHealthPollDurationsMs.delete(callerId);
    if (this.sharedStart) {
      this.removeHealthPollDeadline(this.sharedStart, callerId);
    }
  }

  /**
   * Check if a process is still running
   */
  private async isProcessRunning(pid: number): Promise<boolean> {
    return this.processClient.isRunning(pid);
  }

  /**
   * Whether the runner process WE spawned is alive at the OS level, regardless of
   * whether its health endpoint is up yet. Unlike {@link isCtrlProxyProcessAlive}
   * this does NOT require a health response, so a runner still initializing counts
   * as alive — used to avoid killing+respawning our own still-starting runner (#2834).
   */
  private async isOwnRunnerProcessAlive(): Promise<boolean> {
    if (!this.xcTestProcessId) {
      return false;
    }
    if (this.useRemoteRunner()) {
      try {
        const status = await this.remoteRunner.status({
          deviceId: this.device.deviceId,
          pid: this.xcTestProcessId,
        });
        // PID-strict: the remote daemon resolves status by deviceId BEFORE pid,
        // so running=true alone is not proof the TRACKED pid is alive — a newer runner
        // for the same device aliases it, and treating it as "ours" would make us wait
        // on (and eventually stop) that newer runner (#2834 review).
        return (
          status.success &&
          (status.data?.running ?? false) &&
          status.data?.pid === this.xcTestProcessId
        );
      } catch (error) {
        // A failed remote status call (network/daemon error) is treated the same as
        // "not our tracked runner": returning false here is safe because the caller
        // falls back to local isProcessRunning/re-adoption rather than crashing.
        logger.debug(`src/utils/IOSCtrlProxyManager.ts fallback failed: ${error}`, error);
        return false;
      }
    }
    if (!(await this.isProcessRunning(this.xcTestProcessId))) {
      return false;
    }
    // Guard against PID reuse (#2834 review): a bare `kill -0` only proves *some*
    // process holds this PID. Confirm it is genuinely our xcodebuild-launched runner
    // for THIS device before treating it as "still starting" — otherwise a recycled
    // PID (our runner exited, its PID reassigned to an unrelated process) would make
    // us defer to a health endpoint that never comes.
    const info = await this.processClient.getProcessInfo(this.xcTestProcessId);
    if (!info) {
      return false;
    }
    // Require CtrlProxy-specific identity, not merely any xcodebuild for this device
    // (#2834 review): a user's own `xcodebuild … -destination id=<deviceId>` on the same
    // simulator must NOT be mistaken for our runner, or we would wait on it and later
    // terminate it as "hung", killing an unrelated process. Our launch carries CtrlProxy
    // markers ("-only-testing:CtrlProxyUITests…", the automobile-runner xctestrun), so the
    // canonical isOwnedCtrlProxyRunnerProcess predicate (also used by the port-reclaim
    // path) distinguishes it.
    return this.isOwnedCtrlProxyRunnerProcess({
      pid: this.xcTestProcessId,
      port: this.servicePort,
      command: info.command,
      environment: info.environment,
    });
  }

  /**
   * Resolve the health-poll attempt budget. Env-overridable so CI (where XCUITest
   * cold-start routinely exceeds the default) can extend it without a code change.
   */
  private static resolveHealthPollMaxAttempts(): number {
    const raw =
      process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS ??
      process.env.AUTO_MOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    let configuredAttempts = IOSCtrlProxyManager.DEFAULT_HEALTH_POLL_MAX_ATTEMPTS;
    if (raw !== undefined) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        configuredAttempts = parsed;
      }
    }
    return configuredAttempts;
  }

  private extendHealthPollDeadline(
    sharedStart: SharedCtrlProxyStart,
    callerId: symbol,
    minimumHealthPollDurationMs: number | undefined,
  ): void {
    if (!minimumHealthPollDurationMs || minimumHealthPollDurationMs <= 0) {
      return;
    }
    sharedStart.callerHealthPollDeadlinesMs.set(
      callerId,
      this.timer.now() + minimumHealthPollDurationMs,
    );
    this.refreshHealthPollDeadline(sharedStart);
  }

  private removeHealthPollDeadline(
    sharedStart: SharedCtrlProxyStart,
    callerId: symbol | undefined,
  ): void {
    if (!callerId) {
      return;
    }
    sharedStart.callerHealthPollDeadlinesMs.delete(callerId);
    this.refreshHealthPollDeadline(sharedStart);
  }

  private refreshHealthPollDeadline(sharedStart: SharedCtrlProxyStart): void {
    sharedStart.healthPollDeadlineMs = Math.max(
      sharedStart.defaultHealthPollDeadlineMs ?? 0,
      ...sharedStart.callerHealthPollDeadlinesMs.values(),
    );
  }

  private async waitForHealthEndpoint(
    sharedStart: SharedCtrlProxyStart,
    perf: PerformanceTracker,
    delayMs: number,
  ): Promise<boolean> {
    perf.startOperation("healthPolling");
    let attempts = 0;
    for (;;) {
      if (sharedStart.controller.signal.aborted) {
        throw (
          sharedStart.controller.signal.reason ?? new Error("iOS CtrlProxy startup was aborted")
        );
      }
      attempts++;
      if (await this.checkHealthEndpoint()) {
        perf.endOperation("healthPolling");
        return true;
      }
      if (attempts > 1 && attempts % 10 === 0) {
        logger.info(
          `[IOSCtrlProxy] Still waiting for service... (attempt ${attempts}, ` +
            `${Math.max(0, (sharedStart.healthPollDeadlineMs ?? 0) - this.timer.now())}ms remaining)`,
        );
      }
      const remainingPollMs = (sharedStart.healthPollDeadlineMs ?? 0) - this.timer.now();
      if (remainingPollMs <= 0) {
        perf.endOperation("healthPolling");
        return false;
      }
      await this.sleepForHealthPoll(
        Math.min(delayMs, remainingPollMs),
        sharedStart.controller.signal,
      );
    }
  }

  private async completeHealthStartup(
    sharedStart: SharedCtrlProxyStart,
    perf: PerformanceTracker,
  ): Promise<void> {
    logger.info("[IOSCtrlProxy] HTTP health endpoint is ready");
    this.clearCaches();
    await this.startProcessSupervision();

    // The HTTP server can respond before the WebSocket server is initialized.
    logger.info("[IOSCtrlProxy] Waiting for WebSocket server initialization");
    perf.startOperation("websocketInit");
    await this.sleepForHealthPoll(500, sharedStart.controller.signal);
    perf.endOperation("websocketInit");

    if (!this.isSimulator()) {
      await this.iproxySupervisor.start();
    }
  }

  private async completeHealthStartupIfDeadlineExtended(
    sharedStart: SharedCtrlProxyStart,
    perf: PerformanceTracker,
    delayMs: number,
  ): Promise<boolean> {
    if ((sharedStart.healthPollDeadlineMs ?? 0) <= this.timer.now()) {
      return false;
    }
    if (!(await this.waitForHealthEndpoint(sharedStart, perf, delayMs))) {
      return false;
    }
    await this.completeHealthStartup(sharedStart, perf);
    return true;
  }

  private waitForSharedStart(
    sharedStart: SharedCtrlProxyStart,
    signal: AbortSignal | undefined,
    callerId?: symbol,
  ): Promise<void> {
    sharedStart.waitingCallers++;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        sharedStart.waitingCallers--;
        this.removeHealthPollDeadline(sharedStart, callerId);
        if (!sharedStart.completed && sharedStart.waitingCallers === 0) {
          sharedStart.controller.abort(
            signal?.reason ?? new Error("iOS CtrlProxy startup has no remaining callers"),
          );
        }
        callback();
      };
      const onAbort = () =>
        settle(() => {
          reject(signal?.reason ?? new Error("iOS CtrlProxy startup was aborted"));
        });

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      void sharedStart.completion.then(
        () => settle(resolve),
        (error) => settle(() => reject(error)),
      );
    });
  }

  private async sleepForHealthPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await this.timer.sleep(delayMs);
      return;
    }
    if (signal.aborted) {
      throw signal.reason ?? new Error("iOS CtrlProxy startup was aborted");
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () =>
        settle(() => {
          reject(signal.reason ?? new Error("iOS CtrlProxy startup was aborted"));
        });
      signal.addEventListener("abort", onAbort, { once: true });
      void this.timer.sleep(delayMs).then(
        () => settle(resolve),
        (error) => settle(() => reject(error)),
      );
    });
  }

  /**
   * Check if the tracked CtrlProxy process is alive AND still the real CtrlProxy.
   * Used by startInternal() to skip spawning when the process is merely slow.
   *
   * We require both a PID liveness check AND a health endpoint response so that
   * a stale xcTestProcessId that has been PID-reused by a different process does
   * not produce a false "alive" result and cause setup() to silently skip restart.
   */
  private async isCtrlProxyProcessAlive(): Promise<boolean> {
    if (!this.xcTestProcessId) {
      return false;
    }
    if (this.useRemoteRunner()) {
      try {
        const status = await this.remoteRunner.status({
          deviceId: this.device.deviceId,
          pid: this.xcTestProcessId,
        });
        // PID-strict for the same reason as isOwnRunnerProcessAlive: deviceId-first
        // resolution in the remote daemon means running=true may describe a
        // NEWER runner, not the tracked one. On mismatch we return false and the
        // remote start path re-adopts the device's current runner via
        // status({deviceId}) — the correct adoption point (#2834 review).
        return (
          status.success &&
          (status.data?.running ?? false) &&
          status.data?.pid === this.xcTestProcessId
        );
      } catch (error) {
        // Remote status call failed; report not-alive so the caller respawns rather
        // than trusting a stale in-memory pid across a daemon error.
        logger.debug(`src/utils/IOSCtrlProxyManager.ts fallback failed: ${error}`, error);
        return false;
      }
    }
    // First check PID liveness (fast, no network). If the PID is already gone
    // we can skip the health check entirely.
    if (!(await this.isProcessRunning(this.xcTestProcessId))) {
      return false;
    }
    // Also verify CtrlProxy identity via the health endpoint.  A different
    // process could have reused the same PID after CtrlProxy exited without
    // its exit being recorded (e.g. clean exit not caught by the exec callback).
    return this.checkHealthEndpoint();
  }

  /**
   * Check if an externally-managed CtrlProxy process (e.g. from hot-reload)
   * is already running CtrlProxy tests. xcodebuild runners expose the simulator
   * id in args; direct simctl-spawned runners are matched by listener port and
   * launchd_sim ancestry.
   */
  private async findExternalCtrlProxyProcess(): Promise<ExternalCtrlProxyProcess | null> {
    if (this.useRemoteRunner()) {
      return null; // Host-control environments don't have external local runners.
    }
    const externalXcodebuildProcess = await this.findExternalXcodebuildCtrlProxyProcess();
    if (externalXcodebuildProcess) {
      return externalXcodebuildProcess;
    }
    const healthyDirectProcess = await this.findHealthyExternalDirectCtrlProxyProcess();
    if (healthyDirectProcess) {
      return healthyDirectProcess;
    }
    return this.findExternalDirectCtrlProxyProcess();
  }

  private async findExternalXcodebuildCtrlProxyProcess(): Promise<ExternalCtrlProxyProcess | null> {
    for (const pid of await this.processClient.findXcodebuildPids()) {
      if (pid === this.xcTestProcessId) {
        continue;
      }
      const processInfo = await this.processClient.getProcessInfo(pid);
      const argsOut = processInfo?.command ?? "";
      if (
        !argsOut.includes("CtrlProxy") ||
        (await this.isDaemonManagedSimulatorXcodebuildProcess(argsOut, processInfo))
      ) {
        continue;
      }
      const identityText = `${argsOut} ${processInfo?.environment ?? ""}`;
      if (!IOSCtrlProxyManager.hasDeviceIdentity(identityText, this.device.deviceId)) {
        continue;
      }
      const port =
        this.parseCtrlProxyPortFromProcessArgs(argsOut) ??
        this.parseCtrlProxyPortFromProcessArgs(processInfo?.environment ?? "") ??
        IOSCtrlProxyManager.DEFAULT_PORT;
      logger.info(`[IOSCtrlProxy] Found external xcodebuild CtrlProxy process: ${pid}`);
      return { pid, port };
    }
    return null;
  }

  /**
   * Finds a healthy direct runner even when `lsof` cannot expose its listener PID.
   *
   * Direct simulator runners inherit their CtrlProxy port, so their process
   * environment identifies a probe candidate. Health is the authority for
   * adoption: it must confirm the exact device before we reserve that port.
   * Daemon-managed trees are deliberately excluded so the regular port-cleanup
   * path still reaps a stale runner whose health endpoint is down.
   */
  private async findHealthyExternalDirectCtrlProxyProcess(): Promise<ExternalCtrlProxyProcess | null> {
    const deadline = this.timer.now() + DIRECT_RUNNER_DISCOVERY_DEADLINE_MS;
    const candidatePids = await this.processClient.findStartupCandidatePids(deadline);
    const eligibleCandidates: Array<{ pid: number; process: ListeningProcess }> = [];
    for (const pid of candidatePids) {
      if (this.timer.now() >= deadline) {
        break;
      }
      if (pid === this.xcTestProcessId) {
        continue;
      }
      const processInfo = await this.processClient.getProcessInfo(pid, deadline);
      if (
        !processInfo ||
        !IOSCtrlProxyManager.isDirectCtrlProxyRunnerCommand(processInfo.command)
      ) {
        continue;
      }
      const port =
        this.parseCtrlProxyPortFromProcessArgs(processInfo.command) ??
        this.parseCtrlProxyPortFromProcessArgs(processInfo.environment ?? "");
      if (port === null) {
        continue;
      }
      const process: ListeningProcess = { pid, port, ...processInfo };
      const daemonManagedRoot = await IOSCtrlProxyManager.findDaemonManagedRunnerTreeRoot(
        this.processClient,
        process,
      );
      if (daemonManagedRoot.kind === "root") {
        continue;
      }
      eligibleCandidates.push({ pid, process });
      if (eligibleCandidates.length >= MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES) {
        break;
      }
    }
    for (const { pid, process } of eligibleCandidates) {
      const remainingTimeoutMs = deadline - this.timer.now();
      if (remainingTimeoutMs <= 0) {
        break;
      }
      if (
        !(await this.checkHealthEndpointOnPortForDevice(
          process.port,
          this.device.deviceId,
          remainingTimeoutMs,
        ))
      ) {
        continue;
      }
      logger.info(`[IOSCtrlProxy] Found healthy external direct CtrlProxy runner: ${pid}`);
      return { pid, port: process.port };
    }
    return null;
  }

  private async findExternalDirectCtrlProxyProcess(): Promise<ExternalCtrlProxyProcess | null> {
    const candidatePorts = new Set([this.servicePort, IOSCtrlProxyManager.DEFAULT_PORT]);

    for (const port of candidatePorts) {
      const listeningProcesses = await this.findListeningProcessesOnPort(port);
      for (const process of listeningProcesses) {
        if (!IOSCtrlProxyManager.isDirectCtrlProxyRunnerCommand(process.command)) {
          continue;
        }
        // A direct in-simulator runner with a daemon-managed xcodebuild/shell ancestor is
        // stale daemon state, not an external hot-reload runner. Let port cleanup reap
        // the owning tree instead of adopting a runner whose health endpoint is down.
        const daemonManagedRoot = await IOSCtrlProxyManager.findDaemonManagedRunnerTreeRoot(
          this.processClient,
          process,
        );
        if (daemonManagedRoot.kind === "root" && daemonManagedRoot.pid !== process.pid) {
          continue;
        }
        if (!(await this.processAncestryContainsDeviceId(process))) {
          continue;
        }
        logger.info(`[IOSCtrlProxy] Found external direct CtrlProxy runner: ${process.pid}`);
        return { pid: process.pid, port };
      }
    }

    return null;
  }

  private parseCtrlProxyPortFromProcessArgs(args: string): number | null {
    const match = args.match(/(?:^|\s)(?:SIMCTL_CHILD_)?CTRL_PROXY_IOS_PORT=(\d+)(?:\s|$)/);
    if (!match) {
      return null;
    }

    const port = Number.parseInt(match[1], 10);
    return isValidCtrlProxyPort(port) ? port : null;
  }

  private async ensureServicePortReadyForLaunch(): Promise<void> {
    if (this.useRemoteRunner()) {
      return;
    }

    const unavailablePorts = new Set<number>();
    for (let attempt = 0; attempt < PortManager.getMaxDevices(); attempt++) {
      const listeningProcesses = await this.findListeningProcessesOnPort(this.servicePort);
      if (listeningProcesses.length === 0) {
        return;
      }

      const ownedProcesses = listeningProcesses.filter((process) =>
        this.isOwnedCtrlProxyRunnerProcess(process),
      );
      if (ownedProcesses.length > 0) {
        for (const process of ownedProcesses) {
          const rootPid = await this.findDaemonManagedRunnerTreeRoot(process);
          logger.warn(
            `[IOSCtrlProxy] Terminating stale CtrlProxy process tree rooted at ${rootPid} ` +
              `for listener ${process.pid} on port ${this.servicePort}`,
          );
          await this.processClient.terminateProcessTree(rootPid);
        }

        const remainingProcesses = await this.findListeningProcessesOnPort(this.servicePort);
        if (remainingProcesses.length === 0) {
          return;
        }
        const remainingOwnedProcesses = remainingProcesses.filter((process) =>
          this.isOwnedCtrlProxyRunnerProcess(process),
        );
        if (remainingOwnedProcesses.length > 0) {
          for (const process of remainingOwnedProcesses) {
            logger.warn(
              `[IOSCtrlProxy] CtrlProxy listener ${process.pid} still holds port ${this.servicePort}; ` +
                `force-terminating remaining owned process tree`,
            );
            await this.processClient.terminateProcessTree(process.pid);
          }
        }

        const afterForceCleanup = await this.findListeningProcessesOnPort(this.servicePort);
        if (afterForceCleanup.length === 0) {
          return;
        }
        if (afterForceCleanup.some((process) => this.isOwnedCtrlProxyRunnerProcess(process))) {
          throw new Error(
            `CtrlProxy recovery failed, port ${this.servicePort} still held by ` +
              this.formatListeningProcesses(afterForceCleanup),
          );
        }
      }

      unavailablePorts.add(this.servicePort);
      logger.warn(
        `[IOSCtrlProxy] Port ${this.servicePort} is held by a foreign process; reallocating CtrlProxy port`,
      );
      PortManager.release(this.device.deviceId);
      this.servicePort = this.allocateServicePort(unavailablePorts);
      this.clearCaches();
    }

    throw new Error(`No iOS CtrlProxy ports are available for device ${this.device.deviceId}.`);
  }

  private async findListeningProcessesOnPort(port: number): Promise<ListeningProcess[]> {
    const processes: ListeningProcess[] = [];
    for (const pid of await this.processClient.findListeningPids(port)) {
      const processInfo = await this.processClient.getProcessInfo(pid);
      if (processInfo) {
        processes.push({ pid, port, ...processInfo });
      }
    }
    return processes;
  }

  private isOwnedCtrlProxyRunnerProcess(process: ListeningProcess): boolean {
    if (!IOSCtrlProxyManager.isCtrlProxyRunnerCommand(process.command)) {
      return false;
    }
    return (
      IOSCtrlProxyManager.hasDeviceIdentity(process.command, this.device.deviceId) ||
      IOSCtrlProxyManager.hasDeviceIdentity(process.environment ?? "", this.device.deviceId)
    );
  }

  private async processAncestryContainsDeviceId(process: ListeningProcess): Promise<boolean> {
    let parentPid = process.ppid;
    const visitedPids = new Set<number>();

    while (parentPid !== undefined && parentPid > 1 && !visitedPids.has(parentPid)) {
      visitedPids.add(parentPid);
      const processInfo = await this.processClient.getProcessInfo(parentPid);
      if (!processInfo) {
        return false;
      }
      if (
        IOSCtrlProxyManager.hasDeviceIdentity(processInfo.command, this.device.deviceId) ||
        processInfo.command.includes(this.device.deviceId)
      ) {
        return true;
      }
      parentPid = processInfo.ppid;
    }

    return false;
  }

  private async findDaemonManagedRunnerTreeRoot(process: ListeningProcess): Promise<number> {
    const result = await IOSCtrlProxyManager.findDaemonManagedRunnerTreeRoot(
      this.processClient,
      process,
    );
    return result.kind === "root" ? result.pid : process.pid;
  }

  private static async findDaemonManagedRunnerTreeRoot(
    processClient: IOSCtrlProxyProcessClient,
    process: ListeningProcess,
    options: {
      requireOrphanedRoot?: boolean;
      shouldContinue?: () => boolean;
      deadline?: number;
    } = {},
  ): Promise<DaemonManagedRunnerTreeRoot> {
    if (!IOSCtrlProxyManager.isCtrlProxyRunnerCommand(process.command)) {
      return { kind: "not_daemon_managed" };
    }

    let rootPid = process.ppid === 1 ? process.pid : null;
    let parentPid = process.ppid;
    const visitedPids = new Set<number>([process.pid]);

    if (IOSCtrlProxyManager.isDaemonManagedSimulatorXcodebuildCommandShape(process.command)) {
      rootPid = IOSCtrlProxyManager.rootPidForDaemonManagedProcess(
        process.pid,
        process.ppid,
        options.requireOrphanedRoot,
      );
    }

    while (parentPid !== undefined && parentPid > 1 && !visitedPids.has(parentPid)) {
      if (!IOSCtrlProxyManager.shouldContinueStartupOrphanRunnerTraversal(options)) {
        return { kind: "deadline_exhausted" };
      }
      visitedPids.add(parentPid);
      const parentInfo = await processClient.getProcessInfo(parentPid, options.deadline);
      if (!parentInfo) {
        break;
      }

      const parentRoot = IOSCtrlProxyManager.daemonManagedParentRoot(
        parentInfo,
        parentPid,
        options.requireOrphanedRoot,
      );
      if (parentRoot) {
        if (parentRoot.terminal) {
          return IOSCtrlProxyManager.toDaemonManagedRunnerTreeRoot(parentRoot.rootPid);
        }
        rootPid = parentRoot.rootPid;
      }

      parentPid = parentInfo.ppid;
    }

    return IOSCtrlProxyManager.toDaemonManagedRunnerTreeRoot(rootPid);
  }

  private async awaitStartupOrphanRunnerReap(): Promise<void> {
    if (this.isSimulator()) {
      await IOSCtrlProxyManager.awaitStartupOrphanRunnerReap();
    }
  }

  public static async awaitStartupOrphanRunnerReap(): Promise<void> {
    await IOSCtrlProxyManager.startupOrphanRunnerReap;
  }

  private static async completeWithinStartupReapDeadline(
    work: Promise<void>,
    timer: Timer,
  ): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timeout = timer.setTimeout(() => {
            IOSCtrlProxyManager.logStartupOrphanRunnerReapDeadline();
            resolve();
          }, STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS);
          (timeout as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timeout) {
        timer.clearTimeout(timeout);
      }
    }
  }

  private static logStartupOrphanRunnerReapDeadline(): void {
    logger.warn(
      `[IOSCtrlProxy] startup CtrlProxy runner sweep timed out after ${STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS}ms`,
    );
  }

  private static shouldContinueStartupOrphanRunnerTraversal(options: {
    shouldContinue?: () => boolean;
  }): boolean {
    return options.shouldContinue?.() ?? true;
  }

  private static daemonManagedParentRoot(
    process: { command: string; ppid?: number },
    pid: number,
    requireOrphanedRoot: boolean | undefined,
  ): DaemonManagedRunnerParentRoot | null {
    if (!IOSCtrlProxyManager.isDaemonManagedSimulatorXcodebuildCommandShape(process.command)) {
      return null;
    }
    return {
      rootPid: IOSCtrlProxyManager.rootPidForDaemonManagedProcess(
        pid,
        process.ppid,
        requireOrphanedRoot,
      ),
      terminal: IOSCtrlProxyManager.isShellCommand(process.command),
    };
  }

  private static rootPidForDaemonManagedProcess(
    pid: number,
    ppid: number | undefined,
    requireOrphanedRoot: boolean | undefined,
  ): number | null {
    return requireOrphanedRoot && ppid !== 1 ? null : pid;
  }

  private static toDaemonManagedRunnerTreeRoot(
    rootPid: number | null,
  ): DaemonManagedRunnerTreeRoot {
    return rootPid === null ? { kind: "not_daemon_managed" } : { kind: "root", pid: rootPid };
  }

  private formatListeningProcesses(processes: ListeningProcess[]): string {
    return processes.map((process) => `PID ${process.pid} (cmd: ${process.command})`).join(", ");
  }

  private static hasDeviceIdentity(text: string, deviceId: string): boolean {
    return (
      text.includes(`id=${deviceId}`) ||
      text.includes(`AUTOMOBILE_DEVICE_ID=${deviceId}`) ||
      text.includes(`SIMCTL_CHILD_AUTOMOBILE_DEVICE_ID=${deviceId}`)
    );
  }

  private async isDaemonManagedSimulatorXcodebuildProcess(
    command: string,
    processInfo?: { ppid?: number; environment?: string } | null,
  ): Promise<boolean> {
    const environment = processInfo?.environment ?? "";
    if (!IOSCtrlProxyManager.isDaemonManagedSimulatorXcodebuildCommandShape(command)) {
      return false;
    }
    if (processInfo?.ppid === 1) {
      return true;
    }
    if (await this.hasOrphanedDaemonManagedShellParent(processInfo?.ppid)) {
      return true;
    }
    return !IOSCtrlProxyManager.hasExternalXcodebuildIdentity(environment);
  }

  private async hasOrphanedDaemonManagedShellParent(
    parentPid: number | undefined,
  ): Promise<boolean> {
    if (parentPid === undefined || parentPid <= 1) {
      return false;
    }
    const parentInfo = await this.processClient.getProcessInfo(parentPid);
    if (!parentInfo || parentInfo.ppid !== 1) {
      return false;
    }
    return (
      IOSCtrlProxyManager.isShellCommand(parentInfo.command) &&
      IOSCtrlProxyManager.isDaemonManagedSimulatorXcodebuildCommandShape(parentInfo.command)
    );
  }

  private static isDaemonManagedSimulatorXcodebuildCommandShape(command: string): boolean {
    return (
      command.includes("xcodebuild") &&
      command.includes("test-without-building") &&
      command.includes("-xctestrun") &&
      command.includes("platform=iOS Simulator") &&
      command.includes("-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService") &&
      !command.includes("CTRL_PROXY_IOS_PORT=") &&
      !command.includes("AUTOMOBILE_DEVICE_ID=")
    );
  }

  private static isShellCommand(command: string): boolean {
    return /(?:^|\/)(?:ba|z|c|t?c|k)?sh(?:\s|$)/.test(command);
  }

  private static hasExternalXcodebuildIdentity(environment: string): boolean {
    return (
      environment.includes("CTRL_PROXY_IOS_PORT=") ||
      environment.includes("AUTOMOBILE_DEVICE_ID=") ||
      environment.includes("SIMCTL_CHILD_AUTOMOBILE_DEVICE_ID=")
    );
  }

  private static isCtrlProxyRunnerCommand(command: string): boolean {
    return (
      command.includes("CtrlProxy") &&
      (command.includes("xcodebuild") ||
        command.includes("CtrlProxyUITests") ||
        command.includes("CtrlProxyUITests-Runner") ||
        command.includes(".xctestrun"))
    );
  }

  private static isDirectCtrlProxyRunnerCommand(command: string): boolean {
    return command.includes("CtrlProxyUITests-Runner");
  }

  /**
   * Check if the tracked iproxy process is alive.
   * Used by the iproxy supervisor so it only restarts the tunnel when the
   * process actually died, not when CtrlProxy is temporarily slow.
   */
  private async isIproxyProcessAlive(): Promise<boolean> {
    if (!this.iproxyProcessId) {
      return false;
    }
    if (this.useRemoteRunner()) {
      try {
        const status = await this.remoteRunner.getIproxyStatus({ pid: this.iproxyProcessId });
        return status.success && (status.data?.running ?? false);
      } catch (error) {
        // Remote status call failed; the supervisor should treat iproxy as down
        // and attempt a restart rather than assume the tunnel is still healthy.
        logger.debug(`src/utils/IOSCtrlProxyManager.ts fallback failed: ${error}`, error);
        return false;
      }
    }
    return this.isProcessRunning(this.iproxyProcessId);
  }

  private async startOnDevice(): Promise<void> {
    logger.info("[IOSCtrlProxy] Starting CtrlProxy on physical device");

    if (this.useRemoteRunner()) {
      if (!(await this.isRemoteRunnerAvailable())) {
        throw new Error("Remote runner not available for CtrlProxy startup");
      }

      const existingProcess = await this.remoteRunner.status({ deviceId: this.device.deviceId });
      const existingDevicePort = existingProcess.data?.port;
      if (
        existingProcess.success &&
        existingProcess.data?.running &&
        typeof existingDevicePort === "number"
      ) {
        logger.info(
          `[IOSCtrlProxy] Reusing remote CtrlProxy process on device port ${existingDevicePort}`,
        );
        this.xcTestProcessId = existingProcess.data.pid ?? null;
        this.xcTestProcess = null;
        await this.startIproxyTunnel({ devicePort: existingDevicePort });
        return;
      }

      const xctestrunPath = await this.builder.getXctestrunPath("device");
      await this.startIproxyTunnel();
      await this.verifyInstalledAppBundle();

      const bundleId = this.resolveTargetBundleId();
      const result = await this.remoteRunner.start({
        deviceId: this.device.deviceId,
        port: this.servicePort,
        xctestrunPath: xctestrunPath || undefined,
        bundleId,
      });

      if (!result.success || !result.data) {
        throw new Error(result.error || "Remote runner failed to start CtrlProxy");
      }

      const resultDevicePort = result.data.port;
      if (typeof resultDevicePort === "number" && resultDevicePort !== this.servicePort) {
        logger.info(
          `[IOSCtrlProxy] Host-control CtrlProxy process is listening on device port ${resultDevicePort}; restarting tunnel`,
        );
        await this.stopIproxyTunnel();
        await this.startIproxyTunnel({ devicePort: resultDevicePort });
      }
      this.xcTestProcessId = result.data.pid;
      this.xcTestProcess = null;
      return;
    }

    // For physical devices, we need to use iproxy for port forwarding
    // and run the XCUITest via xcodebuild with device destination
    const xctestrunPath = await this.builder.getXctestrunPath("device");
    if (!xctestrunPath) {
      throw new Error(
        "CtrlProxy xctestrun not found for device. Download the CtrlProxy bundle before starting.",
      );
    }

    this.ensureLocalServicePortAllocatedAndAvailable();
    await this.startIproxyTunnel();
    await this.verifyInstalledAppBundle();

    const signing = await this.signingManager.resolveSigningForDevice(this.device.deviceId);
    signing.warnings.forEach((warning) => logger.warn(`[IOSCtrlProxy] ${warning}`));

    const signingArgs = [...signing.buildSettings];
    if (signing.allowProvisioningUpdates) {
      signingArgs.unshift("-allowProvisioningUpdates");
    }

    const bundleId = this.resolveTargetBundleId();

    // Deliver the allocated port to the on-device runner via the xctestrun's
    // EnvironmentVariables. A bare `CTRL_PROXY_IOS_PORT=...` xcodebuild token is
    // a BUILD SETTING, not a runner env var, so it never reaches the runner —
    // which then falls back to its default 8765 (issue #2731).
    const runnerEnv: Record<string, string> = {
      CTRL_PROXY_IOS_PORT: String(this.servicePort),
      CTRL_PROXY_IOS_TIMEOUT: process.env.CTRL_PROXY_IOS_TIMEOUT || "86400",
      AUTOMOBILE_DEVICE_ID: this.device.deviceId,
    };
    if (bundleId) {
      runnerEnv.CTRL_PROXY_IOS_BUNDLE_ID = bundleId;
      logger.info(
        `[IOSCtrlProxy] Passing CTRL_PROXY_IOS_BUNDLE_ID=${bundleId} to runner via xctestrun`,
      );
    }
    const runnerXctestrunPath = await this.builder.writeRunnerEnvironment(
      xctestrunPath,
      runnerEnv,
      this.device.deviceId,
    );

    const args = [
      "test-without-building",
      "-xctestrun",
      runnerXctestrunPath,
      "-destination",
      `id=${this.device.deviceId}`,
      "-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
      ...signingArgs,
    ];

    // Use the streaming client so verbose hierarchy dumps are drained without a
    // shell or an output-buffer ceiling.
    // The runner env is ALSO set on the host xcodebuild process env so the daemon
    // can later discover/own/recover this process by reading its env via `ps eww`.
    // xcodebuild itself is the detached process-group leader, so the manager's
    // existing terminateProcessTree() ownership semantics remain intact.
    const child = await this.xcodebuild.startStreaming(args, {
      detached: true,
      env: { ...process.env, ...runnerEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.on("error", (error) => {
      logger.warn(`[IOSCtrlProxy] xcodebuild test error: ${error.message}`);
      this.handleProcessExit();
    });

    child.on("exit", (code, signal) => {
      if (code !== 0 || signal) {
        logger.warn(`[IOSCtrlProxy] xcodebuild test exited: code=${code}, signal=${signal}`);
      }
      this.handleProcessExit();
    });

    if (child.pid) {
      this.xcTestProcessId = child.pid;
      this.xcTestProcess = child;
      logger.info(`[IOSCtrlProxy] Started xcodebuild test with PID ${child.pid}`);

      // Capture output for debugging
      this.captureProcessOutput(child);
    }
  }

  private async verifyInstalledAppBundle(): Promise<void> {
    if (
      process.env.AUTOMOBILE_IOS_SKIP_CTRL_PROXY_APP_HASH === "true" ||
      process.env.AUTOMOBILE_IOS_SKIP_CTRL_PROXY_APP_HASH === "1"
    ) {
      return;
    }

    const simulator = this.isSimulator();
    const expectedHash = this.builder.getExpectedAppHash(simulator ? "simulator" : "device");
    if (!expectedHash) {
      logger.warn(
        "[IOSCtrlProxy] CtrlProxy app hash verification skipped (no expected hash configured)",
      );
      return;
    }

    const deviceHash = await this.deviceAppManager.getInstalledAppBundleHash(
      this.device.deviceId,
      IOSCtrlProxyManager.APP_BUNDLE_ID,
      simulator,
    );
    if (!deviceHash) {
      logger.warn("[IOSCtrlProxy] Unable to read installed CtrlProxy app hash from device");
      return;
    }

    if (deviceHash.toLowerCase() !== expectedHash.toLowerCase()) {
      logger.warn("[IOSCtrlProxy] Installed CtrlProxy app hash mismatch", {
        deviceHash,
        expectedHash,
      });
      try {
        await this.deviceAppManager.uninstallApp(
          this.device.deviceId,
          IOSCtrlProxyManager.APP_BUNDLE_ID,
          simulator,
        );
        logger.info("[IOSCtrlProxy] Uninstalled CtrlProxy app to force reinstall");
      } catch (error) {
        logger.warn(`[IOSCtrlProxy] Failed to uninstall CtrlProxy app: ${errorMessage(error)}`);
      }
      return;
    }

    logger.info("[IOSCtrlProxy] Installed CtrlProxy app hash matches expected bundle");
  }

  private async checkHealthEndpoint(): Promise<boolean> {
    return this.healthClient.checkHealthEndpointOnPort(this.servicePort);
  }

  /**
   * Ask the runner what port it is *actually* bound to, by reading the `port`
   * field the runner self-reports in its `/health` payload. Probes the same
   * candidate ports as runner discovery (the allocated service port plus the
   * hardcoded default the runner falls back to).
   *
   * A reported port is only accepted when the runner's `/health` identifies this
   * exact device. This matters because the daemon may probe a port that is
   * answered by a *different* runner — a sibling iOS simulator's runner that fell
   * back to the shared default port (the same #2731 env-propagation failure can
   * also drop the runner's device-id env var), or, on the default port, the
   * Android CtrlProxy reached through its `adb forward`. The Android runner is
   * additionally excluded structurally: its `/health` returns the plain text
   * `OK`, so `JSON.parse` / the strict `status === "ok"` object check rejects it
   * before the device-id guard is even consulted.
   *
   * Returns null when no matching runner answers or when the runner is too old
   * to report a port. Used by `doctor` to compare the runner's real bound port
   * against the client port — a comparison that is meaningless if both are
   * derived from `getServicePort()` (issue #2735).
   */
  public async getReportedRunnerPort(): Promise<number | null> {
    const candidatePorts = new Set([this.servicePort, IOSCtrlProxyManager.DEFAULT_PORT]);
    for (const port of candidatePorts) {
      const reportedPort = await this.healthClient.readReportedPortFromHealth(port);
      if (reportedPort !== null) {
        return reportedPort;
      }
    }
    return null;
  }

  private async checkHealthEndpointOnPortForDevice(
    port: number,
    deviceId: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    return this.healthClient.checkHealthEndpointOnPortForDevice(port, deviceId, timeoutMs);
  }

  private getIproxyStartTimeoutMs(): number {
    const envValue =
      process.env.AUTOMOBILE_IPROXY_START_TIMEOUT_MS ??
      process.env.AUTO_MOBILE_IPROXY_START_TIMEOUT_MS;
    if (!envValue) {
      return IOSCtrlProxyManager.DEFAULT_IPROXY_START_TIMEOUT_MS;
    }
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      logger.warn(
        `[IOSCtrlProxy] Invalid iproxy timeout '${envValue}', using default ${IOSCtrlProxyManager.DEFAULT_IPROXY_START_TIMEOUT_MS}ms`,
      );
      return IOSCtrlProxyManager.DEFAULT_IPROXY_START_TIMEOUT_MS;
    }
    return parsed;
  }

  private async startIproxyTunnel(
    options: {
      allowServicePortReallocation?: boolean;
      devicePort?: number;
      supervise?: boolean;
    } = {},
  ): Promise<void> {
    if (this.isSimulator()) {
      return;
    }

    if (this.useRemoteRunner()) {
      if (this.iproxyProcessId) {
        const status = await this.remoteRunner.getIproxyStatus({ pid: this.iproxyProcessId });
        if (status.success && status.data?.running) {
          if (options.supervise !== false) {
            await this.iproxySupervisor.start();
          }
          return;
        }
      }

      const fixedDevicePort = options.devicePort ?? this.iproxyDevicePort;
      await this.stopIproxyTunnel({ stopSupervisor: options.supervise !== false });
      await this.ensureRemoteServicePortAvailable({
        allowReallocation: options.allowServicePortReallocation ?? true,
      });
      const devicePort = fixedDevicePort ?? this.servicePort;

      const result = await this.remoteRunner.startIproxy({
        deviceId: this.device.deviceId,
        localPort: this.servicePort,
        devicePort,
      });
      if (!result.success || !result.data) {
        throw new Error(result.error || "Failed to start iproxy tunnel via remote runner");
      }

      this.iproxyProcessId = result.data.pid;
      this.iproxyProcess = null;
      this.iproxyDevicePort = devicePort;
      await this.waitForIproxyStartup();
      if (options.supervise !== false) {
        await this.iproxySupervisor.start();
      }
      return;
    }

    if (this.iproxyProcessId && (await this.isProcessRunning(this.iproxyProcessId))) {
      if (options.supervise !== false) {
        await this.iproxySupervisor.start();
      }
      return;
    }

    await this.stopIproxyTunnel({ stopSupervisor: options.supervise !== false });

    logger.info(
      `[IOSCtrlProxy] Starting iproxy tunnel (localhost:${this.servicePort} -> device:${this.servicePort})`,
    );
    const child = this.processExecutor.spawn(
      "iproxy",
      [String(this.servicePort), String(this.servicePort), this.device.deviceId],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    if (!child.pid) {
      throw new Error("Failed to start iproxy tunnel (no PID)");
    }

    this.iproxyProcessId = child.pid;
    this.iproxyProcess = child;
    this.captureIproxyOutput(child);

    child.on("exit", () => {
      if (this.iproxyProcess !== child) {
        return;
      }
      if (!this.isStopping) {
        logger.warn("[IOSCtrlProxy] iproxy exited unexpectedly");
        this.iproxySupervisor.processExited();
      }
    });

    child.on("error", (error) => {
      if (this.iproxyProcess !== child) {
        return;
      }
      if (!this.isStopping) {
        logger.warn(`[IOSCtrlProxy] iproxy error: ${error.message}`);
        this.iproxySupervisor.processExited();
      }
    });

    await this.waitForIproxyStartup();
    if (options.supervise !== false) {
      await this.iproxySupervisor.start();
    }
  }

  private async stopIproxyTunnel(
    options: { clearDevicePort?: boolean; stopSupervisor?: boolean } = {},
  ): Promise<void> {
    if (options.stopSupervisor !== false) {
      this.iproxySupervisor.stop();
    }

    if (this.useRemoteRunner()) {
      if (this.iproxyProcessId) {
        const result = await this.remoteRunner.stopIproxy({ pid: this.iproxyProcessId });
        if (!result.success) {
          logger.warn(
            `[IOSCtrlProxy] Failed to stop host iproxy: ${result.error || "Unknown error"}`,
          );
        }
      }
    } else if (this.iproxyProcess && typeof this.iproxyProcess.kill === "function") {
      await this.stopLocalIproxyProcess(this.iproxyProcess);
    } else if (this.iproxyProcessId) {
      try {
        process.kill(this.iproxyProcessId);
      } catch {
        // Ignore errors if already exited
      }
    }

    this.iproxyProcessId = null;
    this.iproxyProcess = null;
    if (options.clearDevicePort) {
      this.iproxyDevicePort = null;
    }
  }

  /**
   * Do not discard a local iproxy handle until its child has exited. A SIGTERM
   * request only means Node delivered the signal; it does not mean an iproxy
   * child stopped. Escalate before the owning shutdown path accepts the stop.
   */
  private async stopLocalIproxyProcess(iproxyProcess: ChildProcess): Promise<void> {
    if (iproxyProcess.exitCode !== null) {
      return;
    }
    try {
      iproxyProcess.kill();
    } catch (error) {
      logger.debug(`[IOSCtrlProxy] Local iproxy exited before graceful shutdown: ${error}`);
      return;
    }

    if (await this.waitForLocalIproxyExit(iproxyProcess)) {
      return;
    }

    try {
      iproxyProcess.kill("SIGKILL");
    } catch (error) {
      // Ignore errors if the process exited while escalating.
      logger.debug(`[IOSCtrlProxy] Local iproxy exited before forced shutdown: ${error}`);
    }
    await this.waitForLocalIproxyExit(iproxyProcess);
  }

  private async waitForLocalIproxyExit(iproxyProcess: ChildProcess): Promise<boolean> {
    if (iproxyProcess.exitCode !== null) {
      return true;
    }
    let timeout: NodeJS.Timeout | undefined;
    const exited = new Promise<boolean>((resolve) => {
      const complete = () => resolve(true);
      iproxyProcess.once("exit", complete);
      iproxyProcess.once("error", complete);
      timeout = this.timer.setTimeout(() => resolve(false), IPROXY_GRACEFUL_STOP_TIMEOUT_MS);
    });
    try {
      return await exited;
    } finally {
      if (timeout) {
        this.timer.clearTimeout(timeout);
      }
    }
  }

  private async waitForIproxyStartup(): Promise<void> {
    const timeoutMs = this.getIproxyStartTimeoutMs();
    const deadline = this.timer.now() + timeoutMs;

    while (this.timer.now() < deadline) {
      if (this.iproxyProcessId) {
        if (this.useRemoteRunner()) {
          const status = await this.remoteRunner.getIproxyStatus({ pid: this.iproxyProcessId });
          if (status.success && status.data?.running) {
            return;
          }
        } else if (await this.isProcessRunning(this.iproxyProcessId)) {
          return;
        }
      }
      await this.timer.sleep(100);
    }

    throw new Error(`iproxy failed to stay running within ${timeoutMs}ms`);
  }

  private async restartIproxyTunnel(): Promise<void> {
    try {
      await this.startIproxyTunnel({
        allowServicePortReallocation: false,
        devicePort: this.iproxyDevicePort ?? undefined,
        supervise: false,
      });
    } catch (error) {
      if (!(error instanceof RemoteServicePortUnavailableError)) {
        throw error;
      }
      logger.warn(
        "[IOSCtrlProxy] Existing CtrlProxy process uses a host port that is no longer available during iproxy restart; restarting",
      );
      await this.restartDeviceProcessAfterHostPortCollision();
      await this.processSupervisor.start();
    }
  }

  private async isSupervisedIproxyTunnelAlive(): Promise<boolean> {
    if (this.isSimulator()) {
      return true;
    }

    const isConnected = await this.isDeviceDetected();
    if (!isConnected) {
      logger.warn(
        `[IOSCtrlProxy] Device ${this.device.deviceId} not detected, stopping iproxy monitoring`,
      );
      await this.stopIproxyTunnel({ clearDevicePort: true });
      return true;
    }

    // Check iproxy process liveness — not CtrlProxy health. A temporarily slow
    // CtrlProxy would fail a health check even though the tunnel is fine; restarting
    // the tunnel in that case is harmful. CtrlProxy's own health is covered by the
    // separate process supervisor.
    const iproxyAlive = await this.isIproxyProcessAlive();
    if (!iproxyAlive) {
      logger.warn("[IOSCtrlProxy] iproxy process is no longer running, scheduling restart");
      await this.stopIproxyTunnel({ stopSupervisor: false });
    }
    return iproxyAlive;
  }

  private async isDeviceDetected(): Promise<boolean> {
    if (this.isSimulator()) {
      try {
        if (this.useRemoteRunner()) {
          const result = await this.remoteRunner.runSimctl(["list", "devices"]);
          if (!result.success || !result.data) {
            return false;
          }
          return result.data.stdout.includes(this.device.deviceId);
        }

        const { stdout } = await this.processExecutor.executeCommand("xcrun", [
          "simctl",
          "list",
          "devices",
        ]);
        return stdout.includes(this.device.deviceId);
      } catch (error) {
        // `xcrun simctl list devices` failing (Xcode tooling missing/misconfigured)
        // means we can't confirm the simulator is present; treat it as undetected.
        logger.debug(`src/utils/IOSCtrlProxyManager.ts fallback failed: ${error}`, error);
        return false;
      }
    }

    try {
      if (this.useRemoteRunner()) {
        const result = await this.remoteRunner.runIdeviceId(["-l"]);
        if (!result.success || !result.data) {
          return false;
        }
        return result.data.stdout.split("\n").some((line) => line.trim() === this.device.deviceId);
      }

      const { stdout } = await this.processExecutor.executeCommand("idevice_id", ["-l"]);
      return stdout.split("\n").some((line) => line.trim() === this.device.deviceId);
    } catch (error) {
      // `idevice_id -l` failing (libimobiledevice missing, or no physical device
      // attached) means we can't enumerate physical devices; report undetected.
      logger.debug(`src/utils/IOSCtrlProxyManager.ts fallback failed: ${error}`, error);
      return false;
    }
  }

  private captureIproxyOutput(child: ChildProcess): void {
    if (child.stdout) {
      child.stdout.on("data", (data: Buffer | string) => {
        const output = data.toString().trim();
        if (output) {
          logger.info(`[iproxy stdout] ${output.slice(0, 500)}`);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data: Buffer | string) => {
        const output = data.toString().trim();
        if (output) {
          logger.warn(`[iproxy stderr] ${output.slice(0, 500)}`);
        }
      });
    }
  }

  /**
   * Get device capabilities for CtrlProxy
   */
  public async getCapabilities(): Promise<CtrlProxyIosCapabilities> {
    const isSimulator = this.isSimulator();

    return {
      supportsXCTest: true, // XCUITest is available on all iOS devices
      deviceType: isSimulator ? "simulator" : "physical",
      iosVersion: null, // TODO: Get from device info
    };
  }
}
