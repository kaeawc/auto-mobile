import { logger } from "./logger";
import { BootedDevice } from "../models";
import { requireBootedDevice } from "./requireBootedDevice";
import { NoOpPerformanceTracker, createGlobalPerformanceTracker, type PerformanceTracker } from "./PerformanceTracker";
import { Timer, defaultTimer } from "./SystemTimer";
import { IOSCtrlProxyBuilder, type CtrlProxyIosBuildResult } from "./IOSCtrlProxyBuilder";
import { type ChildProcess } from "child_process";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "./PortManager";
import { DefaultProcessExecutor, type ProcessExecutor } from "./ProcessExecutor";
import { XcodeSigningManager } from "./ios-cmdline-tools/XcodeSigning";
import { DeviceAppInspector } from "./ios-cmdline-tools/DeviceAppInspector";
import { isIosSimulatorUdid } from "./ios-cmdline-tools/iosDeviceType";
import { isRunningInDocker } from "./dockerEnv";
import { exponentialBackoff } from "./Backoff";
import { createConnection } from "node:net";
import {
  getHostControlHost,
  getCtrlProxyIOSStatus,
  isHostControlAvailable,
  getIproxyStatus,
  runIdeviceIdExec,
  runIdeviceInstallerExec,
  runSimctlExec,
  shouldUseHostControl,
  startIproxy,
  startCtrlProxyIOS,
  stopIproxy,
  stopCtrlProxyIOS
} from "./hostControlClient";
import type { ProxyManager, ProxySetupResult } from "./interfaces/ProxyManager";

/**
 * iOS-specific setup result; carries the build result alongside the
 * platform-agnostic fields.
 */
export interface CtrlProxyIosSetupResult extends ProxySetupResult {
  buildResult?: CtrlProxyIosBuildResult;
}

/**
 * iOS-specific runner process lifecycle, extending the platform-agnostic
 * {@link ProxyManager}.
 */
export interface CtrlProxyIosManager extends ProxyManager {
  setup(force?: boolean, perf?: PerformanceTracker): Promise<CtrlProxyIosSetupResult>;
  isRunning(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getServicePort(): number;
  getReportedRunnerPort(): Promise<number | null>;
  setAutoRestart(enabled: boolean): void;
  isAutoRestartEnabled(): boolean;
  forceRestart(): Promise<void>;
}

interface HostControlCtrlProxyIOSRunner {
  shouldUseHostControl(): boolean;
  isRunningInDocker(): boolean;
  isAvailable(): Promise<boolean>;
  getHost(): string;
  runIdeviceId(args: string[]): Promise<{ success: boolean; error?: string; data?: { stdout: string } }>;
  runIdeviceInstaller(args: string[]): Promise<{ success: boolean; error?: string; data?: { stdout: string } }>;
  runSimctl(args: string[]): Promise<{ success: boolean; error?: string; data?: { stdout: string } }>;
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
  }): Promise<{ success: boolean; error?: string; data?: { pid: number; message: string; port?: number } }>;
  stop(params: { deviceId?: string; pid?: number }): Promise<{ success: boolean; error?: string }>;
  status(params: {
    deviceId?: string;
    pid?: number;
    port?: number;
  }): Promise<{ success: boolean; error?: string; data?: { running: boolean; pid?: number; port?: number } }>;
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

export interface HostPortAvailabilityChecker {
  isAvailable(host: string, port: number): Promise<boolean>;
}

class TcpHostPortAvailabilityChecker implements HostPortAvailabilityChecker {
  private static readonly CONNECT_TIMEOUT_MS = 1000;

  public isAvailable(host: string, port: number): Promise<boolean> {
    return new Promise(resolve => {
      const socket = createConnection({ host, port });
      let settled = false;

      const finish = (available: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve(available);
      };

      socket.setTimeout(TcpHostPortAvailabilityChecker.CONNECT_TIMEOUT_MS);
      socket.once("connect", () => finish(false));
      socket.once("timeout", () => finish(false));
      socket.once("error", error => {
        const code = (error as NodeJS.ErrnoException).code;
        finish(code === "ECONNREFUSED");
      });
    });
  }
}

class HostControlServicePortUnavailableError extends Error {
  constructor(host: string, port: number) {
    super(`Host control port ${port} is already in use on ${host}`);
    this.name = "HostControlServicePortUnavailableError";
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
  private readonly processExecutor: ProcessExecutor;
  private readonly signingManager: XcodeSigningManager;
  private readonly appInspector: DeviceAppInspector;
  private readonly hostControl: HostControlCtrlProxyIOSRunner;
  private readonly hostPortAvailabilityChecker: HostPortAvailabilityChecker;
  private hostControlAvailability: Promise<boolean> | null = null;

  // Singleton instances per device
  private static instances: Map<string, IOSCtrlProxyManager> = new Map();

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

  // Process monitoring
  private processMonitorInterval: ReturnType<typeof setInterval> | null = null;

  // Auto-restart state
  private autoRestartEnabled: boolean = true;
  private restartAttempts: number = 0;
  private restartTimeout: ReturnType<Timer["setTimeout"]> | null = null;
  private static readonly MAX_RESTART_ATTEMPTS = 5;
  private static readonly RESTART_BASE_DELAY_MS = 2000;
  private static readonly RESTART_MAX_DELAY_MS = 30000;
  private static readonly PORT_RELEASE_GRACE_MS = 250;
  private static readonly PORT_RELEASE_ATTEMPTS = 4;

  // iproxy tunnel state (physical devices)
  private iproxyProcessId: number | null = null;
  private iproxyProcess: ChildProcess | null = null;
  private iproxyDevicePort: number | null = null;
  private iproxyMonitorInterval: ReturnType<typeof setInterval> | null = null;
  private iproxyRestartTimeout: ReturnType<Timer["setTimeout"]> | null = null;
  private iproxyRestartAttempts: number = 0;
  private isStopping: boolean = false;

  // Mutex to prevent concurrent start() calls from spawning multiple processes
  private startPromise: Promise<void> | null = null;

  // Target app bundle ID for CtrlProxy to observe (instead of SpringBoard)
  private targetBundleId: string | null = null;

  public static readonly DEFAULT_PORT = 8765;
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
    processExecutor: ProcessExecutor = new DefaultProcessExecutor(),
    signingManager: XcodeSigningManager = new XcodeSigningManager(),
    appInspector: DeviceAppInspector = new DeviceAppInspector(),
    hostControlRunner?: HostControlCtrlProxyIOSRunner,
    hostPortAvailabilityChecker: HostPortAvailabilityChecker = new TcpHostPortAvailabilityChecker()
  ) {
    this.device = device;
    this.timer = timer;
    this.servicePort = this.allocateServicePort();
    this.builder = builder || IOSCtrlProxyBuilder.getInstance();
    this.processExecutor = processExecutor;
    this.signingManager = signingManager;
    this.appInspector = appInspector;
    this.hostPortAvailabilityChecker = hostPortAvailabilityChecker;
    this.hostControl = hostControlRunner || {
      shouldUseHostControl,
      isRunningInDocker,
      isAvailable: () => isHostControlAvailable(),
      getHost: () => getHostControlHost(),
      runIdeviceId: async (args: string[]) => runIdeviceIdExec(args),
      runIdeviceInstaller: async (args: string[]) => runIdeviceInstallerExec(args),
      runSimctl: async (args: string[]) => runSimctlExec(args),
      startIproxy: params => startIproxy(params),
      stopIproxy: params => stopIproxy(params),
      getIproxyStatus: params => getIproxyStatus(params),
      start: params => startCtrlProxyIOS(params),
      stop: params => stopCtrlProxyIOS(params),
      status: params => getCtrlProxyIOSStatus(params)
    };
  }

  /**
   * Get singleton instance for a device
   */
  public static getInstance(device: BootedDevice, timer?: Timer): IOSCtrlProxyManager {
    requireBootedDevice(device, "IOSCtrlProxyManager.getInstance");
    if (!IOSCtrlProxyManager.instances.has(device.deviceId)) {
      IOSCtrlProxyManager.instances.set(
        device.deviceId,
        new IOSCtrlProxyManager(device, timer)
      );
    }
    return IOSCtrlProxyManager.instances.get(device.deviceId)!;
  }

  /**
   * Create instance for testing with injected dependencies
   */
  public static createForTesting(device: BootedDevice, timer: Timer, builder?: IOSCtrlProxyBuilder): IOSCtrlProxyManager {
    return new IOSCtrlProxyManager(device, timer, builder);
  }

  /**
   * Create instance for testing with injected dependencies
   */
  public static createForTestingWithDeps(
    device: BootedDevice,
    timer: Timer,
    builder: IOSCtrlProxyBuilder | undefined,
    processExecutor: ProcessExecutor,
    signingManager?: XcodeSigningManager,
    appInspector?: DeviceAppInspector,
    hostControlRunner?: HostControlCtrlProxyIOSRunner,
    hostPortAvailabilityChecker?: HostPortAvailabilityChecker
  ): IOSCtrlProxyManager {
    return new IOSCtrlProxyManager(
      device,
      timer,
      builder,
      processExecutor,
      signingManager,
      appInspector,
      hostControlRunner,
      hostPortAvailabilityChecker
    );
  }

  /**
   * Reset all instances (for testing)
   */
  public static resetInstances(): void {
    IOSCtrlProxyManager.instances.clear();
  }

  /**
   * Stop all active instances (for shutdown)
   */
  public static async shutdownAll(): Promise<void> {
    const instances = Array.from(IOSCtrlProxyManager.instances.values());
    await Promise.all(instances.map(instance => instance.stop()));
    IOSCtrlProxyManager.instances.clear();
  }

  /**
   * Best-effort startup sweep for orphaned CtrlProxy iOS runner processes left
   * behind by a previously crashed daemon.
   */
  public static async reapOrphanedRunnerProcessesOnStartup(
    processExecutor: ProcessExecutor = new DefaultProcessExecutor(),
    timer: Timer = defaultTimer
  ): Promise<void> {
    let pids: number[] = [];
    try {
      pids = await IOSCtrlProxyManager.findStartupCtrlProxyCandidatePids(processExecutor);
    } catch (error) {
      logger.debug(`[IOSCtrlProxy] Failed to enumerate CtrlProxy iOS processes during startup sweep: ${error}`);
      return;
    }

    for (const pid of pids) {
      try {
        const processInfo = await IOSCtrlProxyManager.getProcessInfo(processExecutor, pid);
        if (!processInfo || processInfo.ppid !== 1 || !IOSCtrlProxyManager.isCtrlProxyRunnerCommand(processInfo.command)) {
          continue;
        }
        logger.info(`[IOSCtrlProxy] Reaping orphaned CtrlProxy iOS process ${pid}`);
        await IOSCtrlProxyManager.terminateProcess(processExecutor, timer, pid);
      } catch (error) {
        logger.debug(`[IOSCtrlProxy] Failed to reap orphaned CtrlProxy iOS process ${pid}: ${error}`);
      }
    }
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
        if (this.useHostControl()) {
          const result = await this.hostControl.runIdeviceInstaller(["-u", this.device.deviceId, "-l"]);
          if (!result.success || !result.data) {
            this.cachedInstalled = { isInstalled: false, timestamp: this.timer.now() };
            return false;
          }
          const installed = result.data.stdout.includes(IOSCtrlProxyManager.BUNDLE_ID);
          this.cachedInstalled = { isInstalled: installed, timestamp: this.timer.now() };
          return installed;
        }

        const { stdout } = await this.processExecutor.exec(
          `ideviceinstaller -u ${this.device.deviceId} -l 2>/dev/null | grep ${IOSCtrlProxyManager.BUNDLE_ID}`
        );
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
        timestamp: this.timer.now()
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

    const [installed, running] = await Promise.all([
      this.isInstalled(),
      this.isRunning()
    ]);

    const available = installed && running;

    this.cachedAvailability = {
      isAvailable: available,
      timestamp: this.timer.now()
    };

    return available;
  }

  // MARK: - Service Control

  /**
   * Start CtrlProxy
   */
  public async start(): Promise<void> {
    // Use mutex to prevent concurrent start() calls from spawning multiple processes
    if (this.startPromise) {
      logger.info("[IOSCtrlProxy] Start already in progress, waiting for it to complete");
      return this.startPromise;
    }

    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /**
   * Internal start implementation (called within mutex)
   */
  private async startInternal(): Promise<void> {
    logger.info("[IOSCtrlProxy] Starting CtrlProxy");
    this.isStopping = false;
    const perf = createGlobalPerformanceTracker();

    // Prefer process liveness check over health endpoint: a busy-but-alive CtrlProxy
    // would fail the HTTP health check and incorrectly trigger a restart.
    perf.startOperation("processAliveCheck");
    const isAlive = await this.isCtrlProxyProcessAlive();
    perf.endOperation("processAliveCheck");
    let restartedAliveProcess = false;
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
          if (!(error instanceof HostControlServicePortUnavailableError)) {
            throw error;
          }
          logger.warn(
            "[IOSCtrlProxy] Existing CtrlProxy process uses a host port that is no longer available; restarting"
          );
          perf.startOperation("spawnRunner");
          await this.restartDeviceProcessAfterHostPortCollision();
          perf.endOperation("spawnRunner");
          restartedAliveProcess = true;
        }
        if (!restartedAliveProcess) {
          perf.endOperation("iproxyTunnel");
          this.startIproxyMonitoring();
        }
      }
      if (!restartedAliveProcess) {
        return;
      }
    }

    if (!restartedAliveProcess) {
      perf.startOperation("runningCheck");
      const alreadyRunning = await this.isRunning();
      perf.endOperation("runningCheck");
      if (alreadyRunning) {
        logger.info("[IOSCtrlProxy] Service is already running");
        return;
      }

      // Check for externally-managed xcodebuild processes (e.g. hot-reload script)
      // before spawning our own to avoid conflicting xcodebuild instances.
      if (this.isSimulator()) {
        perf.startOperation("externalProcessCheck");
        const externalProcess = await this.findExternalCtrlProxyProcess();
        const defaultPortIsHealthyForDevice = externalProcess === null &&
          !this.useHostControl() &&
          this.servicePort !== IOSCtrlProxyManager.DEFAULT_PORT &&
          await this.checkHealthEndpointOnPortForDevice(
            IOSCtrlProxyManager.DEFAULT_PORT,
            this.device.deviceId
          );
        perf.endOperation("externalProcessCheck");
        if (externalProcess || defaultPortIsHealthyForDevice) {
          const externalPort = externalProcess?.port ?? IOSCtrlProxyManager.DEFAULT_PORT;
          logger.info(
            `[IOSCtrlProxy] External CtrlProxy process detected on port ${externalPort}, skipping spawn`
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
      } else {
        perf.startOperation("spawnRunner");
        await this.startOnDevice();
        perf.endOperation("spawnRunner");
      }
    }

    // Wait for HTTP health endpoint to be ready
    // XCUITest can take 10+ seconds to fully initialize after xcodebuild starts
    const maxAttempts = 30;
    const delayMs = 500;

    perf.startOperation("healthPolling");
    for (let i = 0; i < maxAttempts; i++) {
      if (await this.checkHealthEndpoint()) {
        perf.endOperation("healthPolling");
        logger.info("[IOSCtrlProxy] HTTP health endpoint is ready");
        this.clearCaches();

        // Wait additional time for WebSocket server to be ready
        // The HTTP server can respond before WebSocket is fully initialized
        logger.info("[IOSCtrlProxy] Waiting for WebSocket server initialization");
        perf.startOperation("websocketInit");
        await this.timer.sleep(500);
        perf.endOperation("websocketInit");

        if (!this.isSimulator()) {
          this.startIproxyMonitoring();
        }
        return;
      }
      if (i > 0 && i % 10 === 0) {
        logger.info(`[IOSCtrlProxy] Still waiting for service... (attempt ${i}/${maxAttempts})`);
      }
      await this.timer.sleep(delayMs);
    }
    perf.endOperation("healthPolling");

    const heldProcesses = await this.findListeningProcessesOnPort(this.servicePort);
    if (heldProcesses.length > 0) {
      throw new Error(
        `CtrlProxy failed to start within timeout (15s); port ${this.servicePort} ` +
        `still held by ${this.formatListeningProcesses(heldProcesses)}`
      );
    }

    throw new Error("CtrlProxy failed to start within timeout (15s)");
  }

  /**
   * Stop CtrlProxy
   */
  public async stop(): Promise<void> {
    logger.info("[IOSCtrlProxy] Stopping CtrlProxy");
    this.isStopping = true;

    // Cancel any pending restart
    if (this.restartTimeout) {
      this.timer.clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
    this.restartAttempts = 0;

    if (this.useHostControl()) {
      try {
        if (this.xcTestProcessId) {
          await this.hostControl.stop({ deviceId: this.device.deviceId, pid: this.xcTestProcessId });
        }
      } catch (error) {
        logger.warn(`[IOSCtrlProxy] Host control stop failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (!this.isSimulator()) {
        await this.stopIproxyTunnel({ clearDevicePort: true });
      }

      this.xcTestProcessId = null;
      this.xcTestProcess = null;
      this.stopProcessMonitoring();
      this.clearCaches();
      PortManager.release(this.device.deviceId);
      this.isStopping = false;
      logger.info("[IOSCtrlProxy] Service stopped");
      return;
    }

    // Stop process monitoring first
    this.stopProcessMonitoring();

    // Stop iproxy tunnel if running
    await this.stopIproxyTunnel({ clearDevicePort: true });

    if (this.xcTestProcessId) {
      try {
        process.kill(this.xcTestProcessId);
      } catch {
        // Process may have already exited
      }
      this.xcTestProcessId = null;
      this.xcTestProcess = null;
    }

    // Kill any lingering simulator runner processes (legacy simctl spawn path)
    try {
      await this.processExecutor.exec("pkill -f 'CtrlProxyUITests-Runner'");
    } catch {
      // Ignore errors if no process found
    }

    // Kill any lingering xcodebuild test processes (simulator and physical device)
    try {
      await this.processExecutor.exec("pkill -f 'xcodebuild.*CtrlProxyUITests'");
    } catch {
      // Ignore errors if no process found
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
      const isInstalled = await this.appInspector.getInstalledAppBundleHash(
        this.device.deviceId,
        IOSCtrlProxyManager.LEGACY_APP_BUNDLE_ID,
        simulator
      );
      if (isInstalled === null) {
        return;
      }
      logger.info(`[IOSCtrlProxy] Found legacy app ${IOSCtrlProxyManager.LEGACY_APP_BUNDLE_ID}, uninstalling`);
      await this.appInspector.uninstallApp(
        this.device.deviceId,
        IOSCtrlProxyManager.LEGACY_APP_BUNDLE_ID,
        simulator
      );
      logger.info(`[IOSCtrlProxy] Legacy app uninstalled`);
    } catch (error) {
      logger.warn(`[IOSCtrlProxy] Failed to check/uninstall legacy app: ${error}`);
    }
  }

  public async setup(
    force: boolean = false,
    perf: PerformanceTracker = new NoOpPerformanceTracker()
  ): Promise<CtrlProxyIosSetupResult> {
    perf.serial("xcTestServiceSetup");

    await this.uninstallLegacyAppIfPresent();

    if (this.attemptedSetup && !force) {
      const isAvail = await this.isAvailable();
      if (isAvail) {
        perf.end();
        return {
          success: true,
          message: "CtrlProxy was already running",
          perfTiming: perf.getTimings()
        };
      }
      perf.end();
      return {
        success: false,
        message: "Setup already attempted",
        perfTiming: perf.getTimings()
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
          perfTiming: perf.getTimings()
        };
      }

      // Check if build is needed
      const needsBuild = this.useHostControl()
        ? false
        : await perf.track("checkBuild", () => this.builder.needsRebuild(this.isSimulator() ? "simulator" : "device"));

      let buildResult: CtrlProxyIosBuildResult | null = null;
      if (needsBuild) {
        // Check for prefetched result first
        const prefetchedResult = IOSCtrlProxyBuilder.getPrefetchedResult();
        if (prefetchedResult && prefetchedResult.success) {
          logger.info("[IOSCtrlProxy] Using prefetched build result");
          buildResult = prefetchedResult;
        } else {
          // Wait for prefetch if in progress
          const waitedResult = await perf.track("waitForPrefetch", () => IOSCtrlProxyBuilder.waitForPrefetch());
          if (waitedResult && waitedResult.success) {
            logger.info("[IOSCtrlProxy] Using completed prefetch build result");
            buildResult = waitedResult;
          } else {
            // Build synchronously
            logger.info("[IOSCtrlProxy] Downloading CtrlProxy bundle");
            buildResult = await perf.track("build", () => this.builder.build(this.isSimulator() ? "simulator" : "device", perf));
            if (!buildResult.success) {
              this.attemptedSetup = false; // Allow retry on next call
              perf.end();
              return {
                success: false,
                message: buildResult.message,
                error: buildResult.error,
                buildResult,
                perfTiming: perf.getTimings()
              };
            }
          }
        }
      }

      // Start the service
      await perf.track("startService", () => this.start());

      perf.end();
      return {
        success: true,
        message: needsBuild ? "CtrlProxy downloaded and started successfully" : "CtrlProxy started successfully",
        buildResult: buildResult || undefined,
        perfTiming: perf.getTimings()
      };
    } catch (error) {
      this.attemptedSetup = false; // Allow retry on next call
      const errorMsg = error instanceof Error ? error.message : String(error);
      perf.end();
      return {
        success: false,
        message: "Failed to setup CtrlProxy",
        error: errorMsg,
        perfTiming: perf.getTimings()
      };
    }
  }

  // MARK: - Private Helpers

  private isSimulator(): boolean {
    // Simulators have UUIDs like "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX";
    // physical devices have serial-style UDIDs.
    return isIosSimulatorUdid(this.device.deviceId);
  }

  private useHostControl(): boolean {
    return this.hostControl.shouldUseHostControl() && this.hostControl.isRunningInDocker();
  }

  private allocateServicePort(additionalReservedPorts: Iterable<number> = []): number {
    return PortManager.allocate(this.device.deviceId, {
      reservedPorts: [
        ...IOS_CTRL_PROXY_RESERVED_PORTS,
        ...additionalReservedPorts,
      ],
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
        `[IOSCtrlProxy] Reallocated service port from ${this.servicePort} to ${nextPort} before runner launch`
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

  private async ensureHostControlServicePortAvailable(options: { allowReallocation?: boolean } = {}): Promise<void> {
    const allowReallocation = options.allowReallocation ?? true;
    const host = this.hostControl.getHost();
    const unavailablePorts = new Set<number>();

    for (let attempt = 0; attempt < PortManager.getMaxDevices(); attempt++) {
      if (await this.hostPortAvailabilityChecker.isAvailable(host, this.servicePort)) {
        return;
      }

      const unavailablePort = this.servicePort;
      logger.warn(
        `[IOSCtrlProxy] Host control port ${unavailablePort} is already in use on ${host}; reallocating`
      );
      if (!allowReallocation) {
        throw new HostControlServicePortUnavailableError(host, unavailablePort);
      }
      unavailablePorts.add(unavailablePort);
      PortManager.release(this.device.deviceId);
      this.servicePort = this.allocateServicePort(unavailablePorts);
    }

    throw new Error(
      `No host-control iOS CtrlProxy ports are available for device ${this.device.deviceId}.`
    );
  }

  private async isHostControlAvailable(): Promise<boolean> {
    if (!this.hostControlAvailability) {
      this.hostControlAvailability = this.hostControl.isAvailable();
    }
    return this.hostControlAvailability;
  }

  private async restartDeviceProcessAfterHostPortCollision(): Promise<void> {
    await this.stop();
    this.isStopping = false;
    await this.startOnDevice();
  }

  private async startOnSimulator(): Promise<void> {
    logger.info("[IOSCtrlProxy] Starting CtrlProxy on simulator");

    if (this.useHostControl()) {
      if (!await this.isHostControlAvailable()) {
        throw new Error("Host control daemon not available for CtrlProxy startup");
      }

      const existingProcess = await this.hostControl.status({ deviceId: this.device.deviceId });
      const existingServicePort = existingProcess.data?.port;
      if (existingProcess.success && existingProcess.data?.running && typeof existingServicePort === "number") {
        logger.info(
          `[IOSCtrlProxy] Reusing host-control CtrlProxy process on service port ${existingServicePort}`
        );
        this.adoptServicePort(existingServicePort);
        this.xcTestProcessId = existingProcess.data.pid ?? null;
        this.xcTestProcess = null;
        return;
      }

      await this.ensureHostControlServicePortAvailable();

      const xctestrunPath = await this.builder.getXctestrunPath("simulator");
      const bundleId = this.resolveTargetBundleId();
      const result = await this.hostControl.start({
        deviceId: this.device.deviceId,
        port: this.servicePort,
        xctestrunPath: xctestrunPath || undefined,
        bundleId
      });

      if (!result.success || !result.data) {
        throw new Error(result.error || "Host control failed to start CtrlProxy");
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
      throw new Error("CtrlProxy xctestrun not found for simulator. Download the CtrlProxy bundle before starting.");
    }

    const timeout = process.env.CTRL_PROXY_IOS_TIMEOUT || "86400";
    const bundleId = this.resolveTargetBundleId();
    this.ensureLocalServicePortAllocatedAndAvailable();

    // Pass env vars via exec env option to avoid shell interpolation of user-controlled values.
    // SIMCTL_CHILD_* prefixed vars are forwarded by simctl (which xcodebuild uses internally
    // on simulators) to the XCUITest runner process after stripping the prefix.
    // Keep unprefixed vars for potential physical device support.
    const childEnv: Record<string, string> = {
      CTRL_PROXY_IOS_PORT: String(this.servicePort),
      CTRL_PROXY_IOS_TIMEOUT: timeout,
      AUTOMOBILE_DEVICE_ID: this.device.deviceId,
      SIMCTL_CHILD_CTRL_PROXY_IOS_PORT: String(this.servicePort),
      SIMCTL_CHILD_CTRL_PROXY_IOS_TIMEOUT: timeout,
      SIMCTL_CHILD_AUTOMOBILE_DEVICE_ID: this.device.deviceId,
    };
    if (bundleId) {
      childEnv.CTRL_PROXY_IOS_BUNDLE_ID = bundleId;
      childEnv.SIMCTL_CHILD_CTRL_PROXY_IOS_BUNDLE_ID = bundleId;
      logger.info(`[IOSCtrlProxy] Passing CTRL_PROXY_IOS_BUNDLE_ID=${bundleId} to xcodebuild`);
    }
    const command = [
      "xcodebuild",
      "test-without-building",
      `-xctestrun "${xctestrunPath}"`,
      `-destination "platform=iOS Simulator,id=${this.device.deviceId}"`,
      "-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
      "2>&1"
    ].join(" ");

    logger.info("[IOSCtrlProxy] Using xcodebuild test-without-building to start runner on simulator");

    // Start in background with env vars passed via spawn options (not interpolated into the command).
    // Uses spawn with shell:true instead of exec() to avoid the default 1MB maxBuffer limit.
    // xcodebuild outputs verbose hierarchy dumps that easily exceed 1MB, causing
    // "stdout maxBuffer length exceeded" crashes when using exec().
    // Routed through the injected processExecutor so tests can observe/control the process.
    const child = this.processExecutor.spawn(command, [], { shell: true, env: { ...process.env, ...childEnv }, stdio: ["ignore", "pipe", "pipe"] });

    child.on("error", error => {
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

      // Start process monitoring
      this.startProcessMonitoring();

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
    return IOSCtrlProxyManager.IMPORTANT_OUTPUT_MARKERS.some(marker => lower.includes(marker));
  }

  /**
   * Start process health monitoring
   */
  private startProcessMonitoring(): void {
    // Clear any existing monitor
    this.stopProcessMonitoring();

    // Check every 30 seconds
    this.processMonitorInterval = this.timer.setInterval(async () => {
      try {
        const isHealthy = await this.checkHealthEndpoint();

        if (!isHealthy && this.xcTestProcessId) {
          // Check if process is still running
          const processRunning = await this.isProcessRunning(this.xcTestProcessId);
          if (!processRunning) {
            logger.warn("[IOSCtrlProxy] XCTest process crashed, health endpoint not responding");
            // Don't auto-restart here - let the next setup() call handle it
            this.handleProcessExit();
          }
        }
      } catch {
        // Ignore monitoring errors
      }
    }, 30000);
  }

  /**
   * Stop process monitoring
   */
  private stopProcessMonitoring(): void {
    if (this.processMonitorInterval) {
      this.timer.clearInterval(this.processMonitorInterval);
      this.processMonitorInterval = null;
    }
  }

  /**
   * Handle process exit
   */
  private handleProcessExit(): void {
    this.xcTestProcessId = null;
    this.xcTestProcess = null;
    this.stopProcessMonitoring();
    this.clearCaches();

    // Schedule auto-restart if enabled and not stopping intentionally
    if (this.autoRestartEnabled && !this.isStopping) {
      this.scheduleAutoRestart();
    }
  }

  /**
   * Schedule automatic restart with exponential backoff
   */
  private scheduleAutoRestart(): void {
    if (this.restartTimeout || this.isStopping) {
      return;
    }

    if (this.restartAttempts >= IOSCtrlProxyManager.MAX_RESTART_ATTEMPTS) {
      logger.warn(`[IOSCtrlProxy] Max restart attempts (${IOSCtrlProxyManager.MAX_RESTART_ATTEMPTS}) reached, giving up`);
      this.restartAttempts = 0;
      return;
    }

    this.restartAttempts++;
    const delay = exponentialBackoff({
      initialDelayMs: IOSCtrlProxyManager.RESTART_BASE_DELAY_MS,
      maxDelayMs: IOSCtrlProxyManager.RESTART_MAX_DELAY_MS
    }).delayForAttempt(this.restartAttempts);

    logger.info(`[IOSCtrlProxy] Scheduling auto-restart in ${delay}ms (attempt ${this.restartAttempts}/${IOSCtrlProxyManager.MAX_RESTART_ATTEMPTS})`);

    this.restartTimeout = this.timer.setTimeout(() => {
      this.restartTimeout = null;

      // Don't restart if we're stopping
      if (this.isStopping) {
        return;
      }

      logger.info("[IOSCtrlProxy] Attempting automatic restart...");
      void this.start().then(() => {
        logger.info("[IOSCtrlProxy] Auto-restart successful");
        this.restartAttempts = 0; // Reset on success
      }).catch(error => {
        logger.warn(`[IOSCtrlProxy] Auto-restart failed: ${error instanceof Error ? error.message : String(error)}`);
        // handleProcessExit will be called again, triggering another restart attempt
      });
    }, delay);
  }

  /**
   * Enable or disable auto-restart
   */
  public setAutoRestart(enabled: boolean): void {
    this.autoRestartEnabled = enabled;
    if (!enabled && this.restartTimeout) {
      this.timer.clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
    logger.info(`[IOSCtrlProxy] Auto-restart ${enabled ? "enabled" : "disabled"}`);
  }

  /**
   * Check if auto-restart is enabled
   */
  public isAutoRestartEnabled(): boolean {
    return this.autoRestartEnabled;
  }

  /**
   * Force restart the service (useful when client detects issues)
   */
  public async forceRestart(): Promise<void> {
    logger.info("[IOSCtrlProxy] Force restart requested");

    // Clear any pending restart
    if (this.restartTimeout) {
      this.timer.clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    // Stop and restart
    await this.stop();
    this.restartAttempts = 0; // Reset attempts for forced restart
    await this.start();
  }

  /**
   * Check if a process is still running
   */
  private async isProcessRunning(pid: number): Promise<boolean> {
    try {
      // On macOS/Linux, kill -0 checks if process exists without actually killing it
      await this.processExecutor.exec(`kill -0 ${pid} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
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
    if (this.useHostControl()) {
      try {
        const status = await this.hostControl.status({
          deviceId: this.device.deviceId,
          pid: this.xcTestProcessId
        });
        return status.success && (status.data?.running ?? false);
      } catch {
        return false;
      }
    }
    // First check PID liveness (fast, no network). If the PID is already gone
    // we can skip the health check entirely.
    if (!await this.isProcessRunning(this.xcTestProcessId)) {
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
    if (this.useHostControl()) {
      return null; // Host-control environments don't have external local runners.
    }
    const externalXcodebuildProcess = await this.findExternalXcodebuildCtrlProxyProcess();
    if (externalXcodebuildProcess) {
      return externalXcodebuildProcess;
    }
    return this.findExternalDirectCtrlProxyProcess();
  }

  private async findExternalXcodebuildCtrlProxyProcess(): Promise<ExternalCtrlProxyProcess | null> {
    try {
      // pgrep -x matches only processes whose binary name is exactly "xcodebuild"
      const { stdout: pgrepOut } = await this.processExecutor.exec(
        "pgrep -x xcodebuild 2>/dev/null"
      );
      const pids = pgrepOut.trim().split("\n").filter(line => line.length > 0);
      if (pids.length === 0) {
        return null;
      }

      // Filter to PIDs whose args contain CtrlProxy, excluding our tracked PID
      for (const pidStr of pids) {
        const pid = parseInt(pidStr, 10);
        if (this.xcTestProcessId && pid === this.xcTestProcessId) {
          continue;
        }
        try {
          const processInfo = await IOSCtrlProxyManager.getProcessInfo(this.processExecutor, pid);
          const argsOut = processInfo?.command ?? "";
          if (argsOut.includes("CtrlProxy")) {
            if (await this.isDaemonManagedSimulatorXcodebuildProcess(argsOut, processInfo)) {
              continue;
            }
            const identityText = `${argsOut} ${processInfo?.environment ?? ""}`;
            if (!IOSCtrlProxyManager.hasDeviceIdentity(identityText, this.device.deviceId)) {
              continue;
            }
            const port = this.parseCtrlProxyPortFromProcessArgs(argsOut) ??
              this.parseCtrlProxyPortFromProcessArgs(processInfo?.environment ?? "") ??
              IOSCtrlProxyManager.DEFAULT_PORT;
            logger.info(`[IOSCtrlProxy] Found external xcodebuild CtrlProxy process: ${pid}`);
            return { pid, port };
          }
        } catch {
          // Process may have exited between pgrep and ps
        }
      }
      return null;
    } catch {
      // pgrep exits 1 when no process matches
      return null;
    }
  }

  private async findExternalDirectCtrlProxyProcess(): Promise<ExternalCtrlProxyProcess | null> {
    const candidatePorts = new Set([
      this.servicePort,
      IOSCtrlProxyManager.DEFAULT_PORT,
    ]);

    for (const port of candidatePorts) {
      const listeningProcesses = await this.findListeningProcessesOnPort(port);
      for (const process of listeningProcesses) {
        if (!IOSCtrlProxyManager.isDirectCtrlProxyRunnerCommand(process.command)) {
          continue;
        }
        if (!await this.processAncestryContainsDeviceId(process)) {
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
    return Number.isNaN(port) || port <= 0 || port > 65535 ? null : port;
  }

  private async ensureServicePortReadyForLaunch(): Promise<void> {
    if (this.useHostControl()) {
      return;
    }

    const unavailablePorts = new Set<number>();
    for (let attempt = 0; attempt < PortManager.getMaxDevices(); attempt++) {
      const listeningProcesses = await this.findListeningProcessesOnPort(this.servicePort);
      if (listeningProcesses.length === 0) {
        return;
      }

      const ownedProcesses = listeningProcesses.filter(process =>
        this.isOwnedCtrlProxyRunnerProcess(process)
      );
      if (ownedProcesses.length > 0) {
        for (const process of ownedProcesses) {
          logger.warn(
            `[IOSCtrlProxy] Terminating stale CtrlProxy process ${process.pid} on port ${this.servicePort}`
          );
          await IOSCtrlProxyManager.terminateProcess(this.processExecutor, this.timer, process.pid);
        }

        const remainingProcesses = await this.findListeningProcessesOnPort(this.servicePort);
        if (remainingProcesses.length === 0) {
          return;
        }
        if (remainingProcesses.some(process => this.isOwnedCtrlProxyRunnerProcess(process))) {
          throw new Error(
            `CtrlProxy recovery failed, port ${this.servicePort} still held by ` +
            this.formatListeningProcesses(remainingProcesses)
          );
        }
      }

      unavailablePorts.add(this.servicePort);
      logger.warn(
        `[IOSCtrlProxy] Port ${this.servicePort} is held by a foreign process; reallocating CtrlProxy port`
      );
      PortManager.release(this.device.deviceId);
      this.servicePort = this.allocateServicePort(unavailablePorts);
      this.clearCaches();
    }

    throw new Error(
      `No iOS CtrlProxy ports are available for device ${this.device.deviceId}.`
    );
  }

  private async findListeningProcessesOnPort(port: number): Promise<ListeningProcess[]> {
    try {
      const { stdout } = await this.processExecutor.exec(
        `lsof -nP -iTCP:${port} -sTCP:LISTEN -Fp 2>/dev/null`
      );
      const pids = IOSCtrlProxyManager.parseLsofPids(stdout);
      const processes: ListeningProcess[] = [];
      for (const pid of pids) {
        const processInfo = await IOSCtrlProxyManager.getProcessInfo(this.processExecutor, pid);
        if (processInfo) {
          processes.push({ pid, port, ...processInfo });
        }
      }
      return processes;
    } catch {
      return [];
    }
  }

  private isOwnedCtrlProxyRunnerProcess(process: ListeningProcess): boolean {
    if (!IOSCtrlProxyManager.isCtrlProxyRunnerCommand(process.command)) {
      return false;
    }
    return IOSCtrlProxyManager.hasDeviceIdentity(process.command, this.device.deviceId) ||
      IOSCtrlProxyManager.hasDeviceIdentity(process.environment ?? "", this.device.deviceId);
  }

  private async processAncestryContainsDeviceId(process: ListeningProcess): Promise<boolean> {
    let parentPid = process.ppid;
    const visitedPids = new Set<number>();

    while (parentPid !== undefined && parentPid > 1 && !visitedPids.has(parentPid)) {
      visitedPids.add(parentPid);
      const processInfo = await IOSCtrlProxyManager.getProcessInfo(this.processExecutor, parentPid);
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

  private formatListeningProcesses(processes: ListeningProcess[]): string {
    return processes
      .map(process => `PID ${process.pid} (cmd: ${process.command})`)
      .join(", ");
  }

  private static async findStartupCtrlProxyCandidatePids(processExecutor: ProcessExecutor): Promise<number[]> {
    const pids = new Set<number>();
    for (const command of [
      "pgrep -x xcodebuild 2>/dev/null",
      "pgrep -f 'CtrlProxyUITests-Runner' 2>/dev/null",
    ]) {
      try {
        const { stdout } = await processExecutor.exec(command);
        for (const line of stdout.trim().split("\n")) {
          const pid = Number.parseInt(line, 10);
          if (!Number.isNaN(pid)) {
            pids.add(pid);
          }
        }
      } catch {
        // pgrep exits non-zero when no process matches.
      }
    }
    return [...pids];
  }

  private static parseLsofPids(stdout: string): number[] {
    const pids = new Set<number>();
    for (const line of stdout.split("\n")) {
      const match = line.match(/^p(\d+)$/);
      if (!match) {
        continue;
      }
      const pid = Number.parseInt(match[1], 10);
      if (!Number.isNaN(pid)) {
        pids.add(pid);
      }
    }
    return [...pids];
  }

  private static async getProcessInfo(
    processExecutor: ProcessExecutor,
    pid: number
  ): Promise<{ ppid?: number; command: string; environment?: string } | null> {
    try {
      const { stdout } = await processExecutor.exec(`ps -p ${pid} -o ppid= -o args= 2>/dev/null`);
      const output = stdout.trim();
      if (!output) {
        return null;
      }
      const match = output.match(/^(\d+)\s+([\s\S]+)$/);
      const environment = await IOSCtrlProxyManager.getProcessEnvironment(processExecutor, pid);
      if (!match) {
        return { command: output, environment };
      }
      return {
        ppid: Number.parseInt(match[1], 10),
        command: match[2],
        environment,
      };
    } catch {
      return null;
    }
  }

  private static async getProcessEnvironment(
    processExecutor: ProcessExecutor,
    pid: number
  ): Promise<string | undefined> {
    try {
      const { stdout } = await processExecutor.exec(`ps eww -p ${pid} -o command= 2>/dev/null`);
      const output = stdout.trim();
      return output.length > 0 ? output : undefined;
    } catch {
      return undefined;
    }
  }

  private static hasDeviceIdentity(text: string, deviceId: string): boolean {
    return text.includes(`id=${deviceId}`) ||
      text.includes(`AUTOMOBILE_DEVICE_ID=${deviceId}`) ||
      text.includes(`SIMCTL_CHILD_AUTOMOBILE_DEVICE_ID=${deviceId}`);
  }

  private async isDaemonManagedSimulatorXcodebuildProcess(
    command: string,
    processInfo?: { ppid?: number; environment?: string } | null
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

  private async hasOrphanedDaemonManagedShellParent(parentPid: number | undefined): Promise<boolean> {
    if (parentPid === undefined || parentPid <= 1) {
      return false;
    }
    const parentInfo = await IOSCtrlProxyManager.getProcessInfo(this.processExecutor, parentPid);
    if (!parentInfo || parentInfo.ppid !== 1) {
      return false;
    }
    return IOSCtrlProxyManager.isShellCommand(parentInfo.command) &&
      IOSCtrlProxyManager.isDaemonManagedSimulatorXcodebuildCommandShape(parentInfo.command);
  }

  private static isDaemonManagedSimulatorXcodebuildCommandShape(command: string): boolean {
    return command.includes("xcodebuild") &&
      command.includes("test-without-building") &&
      command.includes("-xctestrun") &&
      command.includes("platform=iOS Simulator") &&
      command.includes("-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService") &&
      !command.includes("CTRL_PROXY_IOS_PORT=") &&
      !command.includes("AUTOMOBILE_DEVICE_ID=");
  }

  private static isShellCommand(command: string): boolean {
    return /(?:^|\/)(?:ba|z|c|t?c|k)?sh(?:\s|$)/.test(command);
  }

  private static hasExternalXcodebuildIdentity(environment: string): boolean {
    return environment.includes("CTRL_PROXY_IOS_PORT=") ||
      environment.includes("AUTOMOBILE_DEVICE_ID=") ||
      environment.includes("SIMCTL_CHILD_AUTOMOBILE_DEVICE_ID=");
  }

  private static isCtrlProxyRunnerCommand(command: string): boolean {
    return command.includes("CtrlProxy") &&
      (
        command.includes("xcodebuild") ||
        command.includes("CtrlProxyUITests") ||
        command.includes("CtrlProxyUITests-Runner") ||
        command.includes(".xctestrun")
      );
  }

  private static isDirectCtrlProxyRunnerCommand(command: string): boolean {
    return command.includes("CtrlProxyUITests-Runner");
  }

  private static async terminateProcess(
    processExecutor: ProcessExecutor,
    timer: Timer,
    pid: number
  ): Promise<void> {
    try {
      await processExecutor.exec(`kill -TERM ${pid} 2>/dev/null`);
    } catch {
      // Process may have already exited.
    }

    if (!await IOSCtrlProxyManager.waitForProcessExit(processExecutor, timer, pid)) {
      try {
        await processExecutor.exec(`kill -KILL ${pid} 2>/dev/null`);
      } catch {
        // Process may have exited between liveness check and kill.
      }
      await IOSCtrlProxyManager.waitForProcessExit(processExecutor, timer, pid);
    }
  }

  private static async waitForProcessExit(
    processExecutor: ProcessExecutor,
    timer: Timer,
    pid: number
  ): Promise<boolean> {
    for (let attempt = 0; attempt < IOSCtrlProxyManager.PORT_RELEASE_ATTEMPTS; attempt++) {
      if (!await IOSCtrlProxyManager.isProcessRunningWithExecutor(processExecutor, pid)) {
        return true;
      }
      await timer.sleep(IOSCtrlProxyManager.PORT_RELEASE_GRACE_MS);
    }
    return !await IOSCtrlProxyManager.isProcessRunningWithExecutor(processExecutor, pid);
  }

  private static async isProcessRunningWithExecutor(
    processExecutor: ProcessExecutor,
    pid: number
  ): Promise<boolean> {
    try {
      await processExecutor.exec(`kill -0 ${pid} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if the tracked iproxy process is alive.
   * Used by startIproxyMonitoring() so it only restarts the tunnel when the
   * process actually died, not when CtrlProxy is temporarily slow.
   */
  private async isIproxyProcessAlive(): Promise<boolean> {
    if (!this.iproxyProcessId) {
      return false;
    }
    if (this.useHostControl()) {
      try {
        const status = await this.hostControl.getIproxyStatus({ pid: this.iproxyProcessId });
        return status.success && (status.data?.running ?? false);
      } catch {
        return false;
      }
    }
    return this.isProcessRunning(this.iproxyProcessId);
  }

  private async startOnDevice(): Promise<void> {
    logger.info("[IOSCtrlProxy] Starting CtrlProxy on physical device");

    if (this.useHostControl()) {
      if (!await this.isHostControlAvailable()) {
        throw new Error("Host control daemon not available for CtrlProxy startup");
      }

      const existingProcess = await this.hostControl.status({ deviceId: this.device.deviceId });
      const existingDevicePort = existingProcess.data?.port;
      if (existingProcess.success && existingProcess.data?.running && typeof existingDevicePort === "number") {
        logger.info(
          `[IOSCtrlProxy] Reusing host-control CtrlProxy process on device port ${existingDevicePort}`
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
      const result = await this.hostControl.start({
        deviceId: this.device.deviceId,
        port: this.servicePort,
        xctestrunPath: xctestrunPath || undefined,
        bundleId
      });

      if (!result.success || !result.data) {
        throw new Error(result.error || "Host control failed to start CtrlProxy");
      }

      const resultDevicePort = result.data.port;
      if (typeof resultDevicePort === "number" && resultDevicePort !== this.servicePort) {
        logger.info(
          `[IOSCtrlProxy] Host-control CtrlProxy process is listening on device port ${resultDevicePort}; restarting tunnel`
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
      throw new Error("CtrlProxy xctestrun not found for device. Download the CtrlProxy bundle before starting.");
    }

    this.ensureLocalServicePortAllocatedAndAvailable();
    await this.startIproxyTunnel();
    await this.verifyInstalledAppBundle();

    const signing = await this.signingManager.resolveSigningForDevice(this.device.deviceId);
    signing.warnings.forEach(warning => logger.warn(`[IOSCtrlProxy] ${warning}`));

    const signingArgs = [...signing.buildSettings];
    if (signing.allowProvisioningUpdates) {
      signingArgs.unshift("-allowProvisioningUpdates");
    }

    const bundleId = this.resolveTargetBundleId();
    const envSettings = [
      `CTRL_PROXY_IOS_PORT=${this.servicePort}`,
    ];
    if (bundleId) {
      envSettings.push(`CTRL_PROXY_IOS_BUNDLE_ID=${bundleId}`);
      logger.info(`[IOSCtrlProxy] Passing CTRL_PROXY_IOS_BUNDLE_ID=${bundleId} to xcodebuild`);
    }
    const command = [
      "xcodebuild",
      "test-without-building",
      `-xctestrun "${xctestrunPath}"`,
      "-destination", `id=${this.device.deviceId}`,
      "-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
      ...envSettings,
      ...signingArgs,
      "2>&1"
    ].join(" ");

    // Start in background using spawn with shell:true to avoid the default 1MB maxBuffer limit.
    // xcodebuild outputs verbose hierarchy dumps that easily exceed 1MB.
    // Routed through the injected processExecutor so tests can observe/control the process.
    const child = this.processExecutor.spawn(command, [], { shell: true, stdio: ["ignore", "pipe", "pipe"] });

    child.on("error", error => {
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

      // Start process monitoring
      this.startProcessMonitoring();

      // Capture output for debugging
      this.captureProcessOutput(child);
    }
  }

  private async verifyInstalledAppBundle(): Promise<void> {
    if (process.env.AUTOMOBILE_IOS_SKIP_CTRL_PROXY_APP_HASH === "true" ||
        process.env.AUTOMOBILE_IOS_SKIP_CTRL_PROXY_APP_HASH === "1") {
      return;
    }

    const simulator = this.isSimulator();
    const expectedHash = this.builder.getExpectedAppHash(simulator ? "simulator" : "device");
    if (!expectedHash) {
      logger.warn("[IOSCtrlProxy] CtrlProxy app hash verification skipped (no expected hash configured)");
      return;
    }

    const deviceHash = await this.appInspector.getInstalledAppBundleHash(
      this.device.deviceId,
      IOSCtrlProxyManager.APP_BUNDLE_ID,
      simulator
    );
    if (!deviceHash) {
      logger.warn("[IOSCtrlProxy] Unable to read installed CtrlProxy app hash from device");
      return;
    }

    if (deviceHash.toLowerCase() !== expectedHash.toLowerCase()) {
      logger.warn("[IOSCtrlProxy] Installed CtrlProxy app hash mismatch", {
        deviceHash,
        expectedHash
      });
      try {
        await this.appInspector.uninstallApp(this.device.deviceId, IOSCtrlProxyManager.APP_BUNDLE_ID, simulator);
        logger.info("[IOSCtrlProxy] Uninstalled CtrlProxy app to force reinstall");
      } catch (error) {
        logger.warn(`[IOSCtrlProxy] Failed to uninstall CtrlProxy app: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    logger.info("[IOSCtrlProxy] Installed CtrlProxy app hash matches expected bundle");
  }

  private async checkHealthEndpoint(): Promise<boolean> {
    return this.checkHealthEndpointOnPort(this.servicePort);
  }

  private async checkHealthEndpointOnPort(port: number): Promise<boolean> {
    const body = await this.readHealthEndpointBodyOnPort(port);
    return body !== null && (body.includes("ok") || body.includes("healthy"));
  }

  /**
   * Ask the runner what port it is *actually* bound to, by reading the `port`
   * field the runner self-reports in its `/health` payload. Probes the same
   * candidate ports as runner discovery (the allocated service port plus the
   * hardcoded default the runner falls back to), filtered to this device so a
   * sibling runner sharing the default port is never mistaken for ours.
   *
   * Returns null when no matching runner answers or when the runner is too old
   * to report a port. Used by `doctor` to compare the runner's real bound port
   * against the client port — a comparison that is meaningless if both are
   * derived from `getServicePort()` (issue #2735).
   */
  public async getReportedRunnerPort(): Promise<number | null> {
    const candidatePorts = new Set([this.servicePort, IOSCtrlProxyManager.DEFAULT_PORT]);
    for (const port of candidatePorts) {
      const reportedPort = await this.readReportedPortFromHealth(port);
      if (reportedPort !== null) {
        return reportedPort;
      }
    }
    return null;
  }

  private async readReportedPortFromHealth(port: number): Promise<number | null> {
    const body = await this.readHealthEndpointBodyOnPort(port);
    if (body === null) {
      return null;
    }
    try {
      const health = JSON.parse(body) as { status?: unknown; deviceId?: unknown; port?: unknown };
      if (health.status !== "ok") {
        return null;
      }
      // A runner that reports a deviceId must match ours; one that omits it
      // (older runner) is accepted on the ports we already scope to this device.
      if (health.deviceId !== undefined && health.deviceId !== this.device.deviceId) {
        return null;
      }
      return typeof health.port === "number" ? health.port : null;
    } catch {
      return null;
    }
  }

  private async checkHealthEndpointOnPortForDevice(port: number, deviceId: string): Promise<boolean> {
    const body = await this.readHealthEndpointBodyOnPort(port);
    if (body === null) {
      return false;
    }

    try {
      const health = JSON.parse(body) as { status?: unknown; deviceId?: unknown };
      return health.status === "ok" && health.deviceId === deviceId;
    } catch {
      return false;
    }
  }

  private async readHealthEndpointBodyOnPort(port: number): Promise<string | null> {
    try {
      const host = this.useHostControl() ? this.hostControl.getHost() : "localhost";
      if (this.useHostControl()) {
        const controller = new AbortController();
        const timeoutId = this.timer.setTimeout(() => controller.abort(), 2000);
        try {
          const response = await fetch(`http://${host}:${port}/health`, {
            signal: controller.signal
          });
          return await response.text();
        } finally {
          this.timer.clearTimeout(timeoutId);
        }
      }

      // Use curl to check the health endpoint locally
      const { stdout } = await this.processExecutor.exec(
        `curl -s --max-time 2 http://${host}:${port}/health`
      );
      return stdout;
    } catch {
      return null;
    }
  }

  private getIproxyStartTimeoutMs(): number {
    const envValue = process.env.AUTOMOBILE_IPROXY_START_TIMEOUT_MS ??
      process.env.AUTO_MOBILE_IPROXY_START_TIMEOUT_MS;
    if (!envValue) {
      return IOSCtrlProxyManager.DEFAULT_IPROXY_START_TIMEOUT_MS;
    }
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      logger.warn(`[IOSCtrlProxy] Invalid iproxy timeout '${envValue}', using default ${IOSCtrlProxyManager.DEFAULT_IPROXY_START_TIMEOUT_MS}ms`);
      return IOSCtrlProxyManager.DEFAULT_IPROXY_START_TIMEOUT_MS;
    }
    return parsed;
  }

  private async startIproxyTunnel(options: {
    allowServicePortReallocation?: boolean;
    devicePort?: number;
  } = {}): Promise<void> {
    if (this.isSimulator()) {
      return;
    }

    if (this.useHostControl()) {
      if (this.iproxyProcessId) {
        const status = await this.hostControl.getIproxyStatus({ pid: this.iproxyProcessId });
        if (status.success && status.data?.running) {
          return;
        }
      }

      const fixedDevicePort = options.devicePort ?? this.iproxyDevicePort;
      await this.stopIproxyTunnel();
      await this.ensureHostControlServicePortAvailable({
        allowReallocation: options.allowServicePortReallocation ?? true,
      });
      const devicePort = fixedDevicePort ?? this.servicePort;

      const result = await this.hostControl.startIproxy({
        deviceId: this.device.deviceId,
        localPort: this.servicePort,
        devicePort
      });
      if (!result.success || !result.data) {
        throw new Error(result.error || "Failed to start iproxy tunnel via host control");
      }

      this.iproxyProcessId = result.data.pid;
      this.iproxyProcess = null;
      this.iproxyDevicePort = devicePort;
      await this.waitForIproxyStartup();
      return;
    }

    if (this.iproxyProcessId && await this.isProcessRunning(this.iproxyProcessId)) {
      return;
    }

    await this.stopIproxyTunnel();

    logger.info(`[IOSCtrlProxy] Starting iproxy tunnel (localhost:${this.servicePort} -> device:${this.servicePort})`);
    const child = this.processExecutor.spawn(
      "iproxy",
      [String(this.servicePort), String(this.servicePort), this.device.deviceId],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    if (!child.pid) {
      throw new Error("Failed to start iproxy tunnel (no PID)");
    }

    this.iproxyProcessId = child.pid;
    this.iproxyProcess = child;
    this.captureIproxyOutput(child);

    child.on("exit", () => {
      if (!this.isStopping) {
        logger.warn("[IOSCtrlProxy] iproxy exited unexpectedly");
        this.iproxyProcessId = null;
        this.iproxyProcess = null;
        this.scheduleIproxyRestart();
      }
    });

    child.on("error", error => {
      if (!this.isStopping) {
        logger.warn(`[IOSCtrlProxy] iproxy error: ${error.message}`);
        this.iproxyProcessId = null;
        this.iproxyProcess = null;
        this.scheduleIproxyRestart();
      }
    });

    await this.waitForIproxyStartup();
  }

  private async stopIproxyTunnel(options: { clearDevicePort?: boolean } = {}): Promise<void> {
    this.stopIproxyMonitoring();

    if (this.iproxyRestartTimeout) {
      this.timer.clearTimeout(this.iproxyRestartTimeout);
      this.iproxyRestartTimeout = null;
    }

    if (this.useHostControl()) {
      if (this.iproxyProcessId) {
        const result = await this.hostControl.stopIproxy({ pid: this.iproxyProcessId });
        if (!result.success) {
          logger.warn(`[IOSCtrlProxy] Failed to stop host iproxy: ${result.error || "Unknown error"}`);
        }
      }
    } else if (this.iproxyProcess && typeof this.iproxyProcess.kill === "function") {
      try {
        this.iproxyProcess.kill();
      } catch {
        // Ignore errors if already exited
      }
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
    this.iproxyRestartAttempts = 0;
  }

  private async waitForIproxyStartup(): Promise<void> {
    const timeoutMs = this.getIproxyStartTimeoutMs();
    const deadline = this.timer.now() + timeoutMs;

    while (this.timer.now() < deadline) {
      if (this.iproxyProcessId) {
        if (this.useHostControl()) {
          const status = await this.hostControl.getIproxyStatus({ pid: this.iproxyProcessId });
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

  private scheduleIproxyRestart(): void {
    if (this.iproxyRestartTimeout || this.isStopping) {
      return;
    }

    this.iproxyRestartAttempts++;
    const delay = exponentialBackoff({
      initialDelayMs: IOSCtrlProxyManager.IPROXY_RESTART_BASE_DELAY_MS,
      maxDelayMs: IOSCtrlProxyManager.IPROXY_RESTART_MAX_DELAY_MS
    }).delayForAttempt(this.iproxyRestartAttempts);

    this.iproxyRestartTimeout = this.timer.setTimeout(() => {
      this.iproxyRestartTimeout = null;
      void this.startIproxyTunnel({
        allowServicePortReallocation: false,
        devicePort: this.iproxyDevicePort ?? undefined,
      }).then(() => {
        this.startIproxyMonitoring();
      }).catch(error => {
        if (error instanceof HostControlServicePortUnavailableError) {
          logger.warn(
            "[IOSCtrlProxy] Existing CtrlProxy process uses a host port that is no longer available during iproxy restart; restarting"
          );
          void this.restartDeviceProcessAfterHostPortCollision().then(() => {
            this.startIproxyMonitoring();
          }).catch(restartError => {
            logger.warn(`[IOSCtrlProxy] Failed to restart CtrlProxy after iproxy port collision: ${restartError instanceof Error ? restartError.message : String(restartError)}`);
          });
          return;
        }
        logger.warn(`[IOSCtrlProxy] Failed to restart iproxy: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, delay);
  }

  private startIproxyMonitoring(): void {
    if (this.iproxyMonitorInterval || this.isSimulator()) {
      return;
    }

    this.iproxyMonitorInterval = this.timer.setInterval(async () => {
      try {
        const isConnected = await this.isDeviceDetected();
        if (!isConnected) {
          logger.warn(`[IOSCtrlProxy] Device ${this.device.deviceId} not detected, stopping iproxy monitoring`);
          await this.stopIproxyTunnel({ clearDevicePort: true });
          return;
        }

        // Check iproxy process liveness — not CtrlProxy health. A temporarily slow
        // CtrlProxy would fail a health check even though the tunnel is fine; restarting
        // the tunnel in that case is harmful. CtrlProxy's own health is covered by the
        // separate 30 s process monitor.
        const iproxyAlive = await this.isIproxyProcessAlive();
        if (!iproxyAlive) {
          logger.warn("[IOSCtrlProxy] iproxy process is no longer running, scheduling restart");
          await this.stopIproxyTunnel();
          this.scheduleIproxyRestart();
        }
      } catch (error) {
        logger.warn(`[IOSCtrlProxy] iproxy monitor error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, IOSCtrlProxyManager.IPROXY_MONITOR_INTERVAL_MS);
  }

  private stopIproxyMonitoring(): void {
    if (this.iproxyMonitorInterval) {
      this.timer.clearInterval(this.iproxyMonitorInterval);
      this.iproxyMonitorInterval = null;
    }
  }

  private async isDeviceDetected(): Promise<boolean> {
    if (this.isSimulator()) {
      try {
        if (this.useHostControl()) {
          const result = await this.hostControl.runSimctl(["list", "devices"]);
          if (!result.success || !result.data) {
            return false;
          }
          return result.data.stdout.includes(this.device.deviceId);
        }

        const { stdout } = await this.processExecutor.exec("xcrun simctl list devices");
        return stdout.includes(this.device.deviceId);
      } catch {
        return false;
      }
    }

    try {
      if (this.useHostControl()) {
        const result = await this.hostControl.runIdeviceId(["-l"]);
        if (!result.success || !result.data) {
          return false;
        }
        return result.data.stdout.split("\n").some(line => line.trim() === this.device.deviceId);
      }

      const { stdout } = await this.processExecutor.exec("idevice_id -l");
      return stdout.split("\n").some(line => line.trim() === this.device.deviceId);
    } catch {
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
      iosVersion: null // TODO: Get from device info
    };
  }
}
