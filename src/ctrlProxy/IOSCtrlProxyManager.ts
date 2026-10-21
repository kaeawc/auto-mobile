import { MapDeviceClientRegistry } from "./deviceClientRegistry";
import { type IosTunnelClient } from "./ios/IosTunnelClient";
import type { IosCtrlProxyManagerDiagnostics } from "./ios/IosCtrlProxyManagerDiagnostics";
import type {
  IosCtrlProxyRunnerSnapshot,
  RunnerLaunchProvenance,
  SharedCtrlProxyStart,
} from "./ios/IosCtrlProxyLifecycleSteps";
import type { DoctorProbeOptions } from "../utils/doctorTypes";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { readEnvPositiveInteger } from "../utils/envNumbers";
import { BootedDevice } from "../models";
import { requireBootedDevice } from "../devices/requireBootedDevice";
import { NoOpPerformanceTracker, type PerformanceTracker } from "../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import type { IosCtrlProxyBuilderSurface } from "./IosCtrlProxyBuilderSurface";
import { ActionableError } from "../models/ActionableError";
import type { HostChildProcess as ChildProcess } from "../utils/HostCommandExecutor";
import { PortManager } from "../utils/PortManager";
import { type HostProcessExecutor } from "../utils/HostCommandExecutor";
import { XcodebuildClient } from "../utils/ios-cmdline-tools/XcodebuildClient";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import { ForcedRestartBudget } from "./ForcedRestartBudget";
import type { ExistingIosManager } from "./ios/ExistingIosManager";
import { type CtrlProxyHealthCheckResult } from "./ios/IosCtrlProxyHealthClient";
import { IosCtrlProxyProcessClient } from "./ios/IosCtrlProxyProcessClient";
import { AMBIENT_ENV, ENV, readEnvRaw } from "../config/env";
import {
  CtrlProxyIosSetupResult,
  CtrlProxyStartOptions,
  CtrlProxyIosManager,
  IproxyTunnelStartOptions,
  CtrlProxyIosCapabilities,
  NO_PHYSICAL_DEVICES,
  IosCtrlProxyManagerOptions,
  IosCtrlProxyManagerTestOptions,
  IOS_CTRL_PROXY_DEFAULT_HEALTH_POLL_MAX_ATTEMPTS,
  IOS_CTRL_PROXY_DEFAULT_PORT,
  IOS_CTRL_PROXY_BUNDLE_ID,
  IOS_CTRL_PROXY_APP_BUNDLE_ID,
} from "./ios/IosCtrlProxyContracts";
import { IosCtrlProxyRuntime } from "./ios/IosCtrlProxyRuntime";
import { IosCtrlProxyStartup } from "./ios/IosCtrlProxyStartup";
import { IosCtrlProxyTeardown } from "./ios/IosCtrlProxyTeardown";
import { IosCtrlProxySetup } from "./ios/IosCtrlProxySetup";
import { IosCtrlProxyPorts } from "./ios/IosCtrlProxyPorts";
import { IosCtrlProxyLaunch } from "./ios/IosCtrlProxyLaunch";
import { IosCtrlProxyRestart } from "./ios/IosCtrlProxyRestart";
import { IosCtrlProxyReadiness } from "./ios/IosCtrlProxyReadiness";
import { IosCtrlProxyDiscovery } from "./ios/IosCtrlProxyDiscovery";
import { IosCtrlProxyHealth } from "./ios/IosCtrlProxyHealth";
import { IosCtrlProxyTunnel } from "./ios/IosCtrlProxyTunnel";
import { IosCtrlProxyShutdown, type IosCtrlProxyShutdownHost } from "./ios/IosCtrlProxyShutdown";
import { IosCtrlProxyOrphanReaper } from "./ios/IosCtrlProxyOrphanReaper";
export {
  MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES,
  STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS,
} from "./ios/IosCtrlProxyContracts";
export type {
  CtrlProxyIosSetupResult,
  CtrlProxyStartOptions,
  CtrlProxyIosManager,
  RemoteCtrlProxyIOSRunner,
  IosCtrlProxyManagerTestOptions,
} from "./ios/IosCtrlProxyContracts";

/** Public iOS CtrlProxy facade; collaborators share explicit state and lifecycle capabilities. */
export class IOSCtrlProxyManager implements CtrlProxyIosManager {
  private readonly state: IosCtrlProxyRuntime;
  private readonly startup: IosCtrlProxyStartup;
  private readonly teardown: IosCtrlProxyTeardown;
  private readonly setupWorkflow: IosCtrlProxySetup;
  private readonly ports: IosCtrlProxyPorts;
  private readonly launch: IosCtrlProxyLaunch;
  private readonly restart: IosCtrlProxyRestart;
  private readonly readiness: IosCtrlProxyReadiness;
  private readonly discovery: IosCtrlProxyDiscovery;
  private readonly health: IosCtrlProxyHealth;
  private readonly tunnel: IosCtrlProxyTunnel;
  private constructor(options: IosCtrlProxyManagerOptions) {
    this.state = new IosCtrlProxyRuntime(options, {
      useRemoteRunner: () => this.useRemoteRunner(),
      isSimulator: () => this.isSimulator(),
      startInternal: (...args) => this.startInternal(...args),
      waitForNonJoinableStart: (...args) => this.startup.waitForNonJoinableStart(...args),
      retireRunnerAfterFinalSharedStartCancellation: (...args) =>
        this.startup.retireRunnerAfterFinalSharedStartCancellation(...args),
      startOnSimulator: () => this.startOnSimulator(),
      startOnDevice: () => this.launch.startOnDevice(),
      waitForHealthEndpoint: (...args) => this.readiness.waitForHealthEndpoint(...args),
      completeHealthStartup: (...args) => this.readiness.completeHealthStartup(...args),
      isOwnRunnerProcessAlive: (...args) => this.discovery.isOwnRunnerProcessAlive(...args),
      terminateHungRunnerProcess: (...args) => this.terminateHungRunnerProcess(...args),
      terminateTrackedRunner: (...args) => this.terminateTrackedRunner(...args),
      fenceLateRemoteStartAfterShutdown: (...args) =>
        this.launch.fenceLateRemoteStartAfterShutdown(...args),
      start: (...args) => this.start(...args),
      isSupervisedCtrlProxyProcessAlive: () => this.launch.isSupervisedCtrlProxyProcessAlive(),
      clearCaches: () => this.clearCaches(),
      isProcessRunning: (...args) => this.isProcessRunning(...args),
      restartIproxyTunnel: () => this.restartIproxyTunnel(),
      ensureRemoteServicePortAvailable: (...args) => this.ensureRemoteServicePortAvailable(...args),
    });
    this.startup = this.createStartup();
    this.teardown = new IosCtrlProxyTeardown(this.state, {
      clearCaches: () => this.clearCaches(),
      useRemoteRunner: () => this.useRemoteRunner(),
      isSimulator: () => this.isSimulator(),
      stopIproxyTunnel: (...args) => this.stopIproxyTunnel(...args),
    });
    this.setupWorkflow = new IosCtrlProxySetup(this.state, {
      isAvailable: () => this.isAvailable(),
      isRunning: () => this.isRunning(),
      useRemoteRunner: () => this.useRemoteRunner(),
      start: (...args) => this.start(...args),
      isSimulator: () => this.isSimulator(),
      checkHealthEndpoint: () => this.health.checkHealthEndpoint(),
      isInstalled: () => this.isInstalled(),
    });
    this.ports = new IosCtrlProxyPorts(this.state, {
      clearCaches: () => this.clearCaches(),
      useRemoteRunner: () => this.useRemoteRunner(),
      findListeningProcessesOnPort: (...args) =>
        this.discovery.findListeningProcessesOnPort(...args),
      isOwnedCtrlProxyRunnerProcess: (...args) =>
        this.discovery.isOwnedCtrlProxyRunnerProcess(...args),
      findDaemonManagedRunnerTreeRoot: (...args) =>
        this.discovery.findDaemonManagedRunnerTreeRoot(...args),
      formatListeningProcesses: (...args) => this.discovery.formatListeningProcesses(...args),
    });
    this.launch = new IosCtrlProxyLaunch(
      this.state,
      {
        useRemoteRunner: () => this.useRemoteRunner(),
        adoptServicePort: (...args) => this.ports.adoptServicePort(...args),
        ensureRemoteServicePortAvailable: (...args) =>
          this.ensureRemoteServicePortAvailable(...args),
        resolveTargetBundleId: () => this.resolveTargetBundleId(),
        assertDeviceNotRetired: () => this.assertDeviceNotRetired(),
        ensureLocalServicePortAllocatedAndAvailable: () =>
          this.ports.ensureLocalServicePortAllocatedAndAvailable(),
        trackStartedXcodebuild: (...args) => this.trackStartedXcodebuild(...args),
        startIproxyTunnel: (...args) => this.startIproxyTunnel(...args),
        stopIproxyTunnel: (...args) => this.stopIproxyTunnel(...args),
        retireTrackedDeviceRunnerBeforeSpawn: () => this.retireTrackedDeviceRunnerBeforeSpawn(),
        checkHealthEndpoint: () => this.health.checkHealthEndpoint(),
        isProcessRunning: (...args) => this.isProcessRunning(...args),
      },
      options.healthMissThreshold,
    );
    this.restart = new IosCtrlProxyRestart(this.state, {
      stop: (...args) => this.stop(...args),
      assertDeviceNotRetired: () => this.assertDeviceNotRetired(),
      assertDeviceNotSuspended: () => this.assertDeviceNotSuspended(),
      forceRestart: (...args) => this.forceRestart(...args),
      waitForReconnectStartup: (...args) => this.readiness.waitForReconnectStartup(...args),
      isRunnerStillHealthyAfterForcedTeardown: (...args) =>
        this.isRunnerStillHealthyAfterForcedTeardown(...args),
      allocateReplacementServicePort: (...args) =>
        this.ports.allocateReplacementServicePort(...args),
      startAfterForceRestart: (...args) => this.startAfterForceRestart(...args),
      checkHealthEndpointOnPortForDevice: (...args) =>
        this.health.checkHealthEndpointOnPortForDevice(...args),
      sleepForHealthPoll: (...args) => this.readiness.sleepForHealthPoll(...args),
      extendHealthPollDeadline: (...args) => this.readiness.extendHealthPollDeadline(...args),
      removeHealthPollDeadline: (...args) => this.readiness.removeHealthPollDeadline(...args),
    });
    this.readiness = new IosCtrlProxyReadiness(this.state, {
      isSimulator: () => this.isSimulator(),
      checkHealthEndpointOnPortForDevice: (...args) =>
        this.health.checkHealthEndpointOnPortForDevice(...args),
      adoptServicePort: (...args) => this.ports.adoptServicePort(...args),
      clearCaches: () => this.clearCaches(),
      startProcessSupervision: () => this.launch.startProcessSupervision(),
      assertDeviceNotRetired: () => this.assertDeviceNotRetired(),
      prepareSimulatorRunner: (...args) => this.startup.prepareSimulatorRunner(...args),
      prepareDeviceRunner: (...args) => this.startup.prepareDeviceRunner(...args),
      checkHealthEndpoint: () => this.health.checkHealthEndpoint(),
      resolveHealthPollMaxAttempts: (...args) =>
        IOSCtrlProxyManager.resolveHealthPollMaxAttempts(...args),
    });
    this.discovery = new IosCtrlProxyDiscovery(this.state, {
      useRemoteRunner: () => this.useRemoteRunner(),
      isProcessRunning: (...args) => this.isProcessRunning(...args),
      checkHealthEndpoint: () => this.health.checkHealthEndpoint(),
      checkHealthEndpointOnPortForDevice: (...args) =>
        this.health.checkHealthEndpointOnPortForDevice(...args),
    });
    this.health = new IosCtrlProxyHealth(this.state);
    this.tunnel = new IosCtrlProxyTunnel(this.state, {
      isSimulator: () => this.isSimulator(),
      useRemoteRunner: () => this.useRemoteRunner(),
      startIproxyTunnel: (...args) => this.startIproxyTunnel(...args),
      beginStop: () => this.teardown.beginStop(),
      stopTrackedService: (...args) => this.teardown.stopTrackedService(...args),
    });
  }
  private createStartup(): IosCtrlProxyStartup {
    return new IosCtrlProxyStartup(this.state, {
      assertDeviceNotRetired: () => this.assertDeviceNotRetired(),
      assertDeviceNotSuspended: () => this.assertDeviceNotSuspended(),
      waitForForceRestart: (...args) => this.restart.waitForForceRestart(...args),
      startAfterForceRestart: (...args) => this.startAfterForceRestart(...args),
      start: (...args) => this.start(...args),
      extendHealthPollDeadline: (...args) => this.readiness.extendHealthPollDeadline(...args),
      waitForSharedStart: (...args) => this.readiness.waitForSharedStart(...args),
      isCtrlProxyProcessAlive: () => this.discovery.isCtrlProxyProcessAlive(),
      isSimulator: () => this.isSimulator(),
      startProcessSupervision: () => this.launch.startProcessSupervision(),
      isRunning: () => this.isRunning(),
      resolveHealthPollMaxAttempts: (...args) =>
        IOSCtrlProxyManager.resolveHealthPollMaxAttempts(...args),
      refreshHealthPollDeadline: (...args) => this.readiness.refreshHealthPollDeadline(...args),
      waitForHealthRestartingUnresponsiveRunner: (...args) =>
        this.readiness.waitForHealthRestartingUnresponsiveRunner(...args),
      checkHealthEndpointOnPortForDevice: (...args) =>
        this.health.checkHealthEndpointOnPortForDevice(...args),
      adoptServicePort: (...args) => this.ports.adoptServicePort(...args),
      clearCaches: () => this.clearCaches(),
      sleepForHealthPoll: (...args) => this.readiness.sleepForHealthPoll(...args),
      completeHealthStartupIfDeadlineExtended: (...args) =>
        this.readiness.completeHealthStartupIfDeadlineExtended(...args),
      findListeningProcessesOnPort: (...args) =>
        this.discovery.findListeningProcessesOnPort(...args),
      formatListeningProcesses: (...args) => this.discovery.formatListeningProcesses(...args),
      startIproxyTunnel: (...args) => this.startIproxyTunnel(...args),
      restartDeviceProcessAfterHostPortCollision: () =>
        this.tunnel.restartDeviceProcessAfterHostPortCollision(),
      useRemoteRunner: () => this.useRemoteRunner(),
      findExternalCtrlProxyProcess: () => this.discovery.findExternalCtrlProxyProcess(),
      ensureServicePortReadyForLaunch: () => this.ensureServicePortReadyForLaunch(),
      forceStopCancelledStartup: () =>
        IosCtrlProxyShutdown.forceStopWithinShutdownDeadline(this.shutdownHost(), this.state.timer),
      awaitGlobalStartupOrphanRunnerReap: () => IOSCtrlProxyManager.awaitStartupOrphanRunnerReap(),
    });
  }

  private shutdownHost(): IosCtrlProxyShutdownHost {
    return {
      timer: this.state.timer,
      device: this.state.device,
      stop: (...args) => this.stop(...args),
      forceStopForShutdown: (...args) => this.forceStopForShutdown(...args),
    };
  }
  get removalGeneration(): number {
    return this.state.removalGeneration;
  }
  set removalGeneration(value: number) {
    this.state.removalGeneration = value;
  }

  // Singleton instances per device
  /** Per-device instance and retired-device lifecycle (#11847). */
  public static readonly registry = new MapDeviceClientRegistry<IOSCtrlProxyManager>();

  public static retireDevice(deviceId: string): void {
    IOSCtrlProxyManager.registry.retire(deviceId);
  }

  public static resumeDevice(deviceId: string): void {
    IOSCtrlProxyManager.registry.resume(deviceId);
    const instance = IOSCtrlProxyManager.registry.peek(deviceId);
    if (instance) {
      instance.state.rearmedRemovalGeneration = instance.state.removalGeneration;
      instance.state.forcedRestartBudget.rearm("explicit device start");
    }
  }

  public static isDeviceRetired(deviceId: string): boolean {
    return IOSCtrlProxyManager.registry.isRetired(deviceId);
  }

  public static resetRetiredDevicesForTesting(): void {
    IOSCtrlProxyManager.registry.clearRetired();
  }

  private assertDeviceNotRetired(): void {
    if (IOSCtrlProxyManager.isDeviceRetired(this.state.device.deviceId)) {
      throw new ActionableError(`iOS device ${this.state.device.deviceId} is being shut down`);
    }
  }

  private assertDeviceNotSuspended(): void {
    if (this.state.forcedRestartBudget.snapshot().state === "suspended") {
      throw new ActionableError(
        `iOS device ${this.state.device.deviceId} is absent from discovery`,
      );
    }
  }

  private static startupOrphanRunnerReap: Promise<void> | null = null;

  /** The runner process id this manager currently owns, or null when none is recorded. */
  getXcTestProcessId(): number | null {
    return this.state.xcTestProcessId;
  }

  /** A read-only view of the runner bookkeeping, for leak and ownership assertions. */
  runnerSnapshot(): IosCtrlProxyRunnerSnapshot {
    return {
      xcTestProcessId: this.state.xcTestProcessId,
      xcTestProcess: this.state.xcTestProcess,
      hasRunnerAbortController: this.state.runnerAbortController !== null,
      isStopping: this.state.isStopping,
      servicePort: this.state.servicePort,
      sharedStartExternalWaitingCallers: this.state.sharedStart?.externalWaitingCallers ?? null,
    };
  }

  public static readonly DEFAULT_PORT = IOS_CTRL_PROXY_DEFAULT_PORT;

  public static readonly BUNDLE_ID = IOS_CTRL_PROXY_BUNDLE_ID;

  public static readonly APP_BUNDLE_ID = IOS_CTRL_PROXY_APP_BUNDLE_ID;

  /** Get singleton instance for a device */
  public static getInstance(device: BootedDevice, timer?: Timer): IOSCtrlProxyManager {
    requireBootedDevice(device, "IOSCtrlProxyManager.getInstance");
    return IOSCtrlProxyManager.registry.get(
      device.deviceId,
      () => new IOSCtrlProxyManager({ device, timer }),
    );
  }

  public static getExistingInstance(deviceId: string): ExistingIosManager | undefined {
    return IOSCtrlProxyManager.registry.peek(deviceId);
  }

  public getForcedRestartBudget(): ForcedRestartBudget {
    return this.state.forcedRestartBudget;
  }
  /** Suspend recovery immediately, then retire any runner owned by this device. */
  public suspendForDeviceRemoval(): Promise<void> {
    return this.restart.suspendForDeviceRemoval();
  }
  supersededSinceRemoval(removalGeneration: number): boolean {
    return this.restart.supersededSinceRemoval(removalGeneration);
  }
  /** Rearms after removal cleanup only once per removal generation, when suspended or exhausted. */
  public rearmAfterDeviceReappearance(): Promise<void> {
    return this.restart.rearmAfterDeviceReappearance();
  }

  /**
   * Create instance for testing with injected dependencies
   */
  public static createForTesting(
    device: BootedDevice,
    timer: Timer,
    builder?: IosCtrlProxyBuilderSurface,
    tunnelClient?: IosTunnelClient,
    processExecutor?: HostProcessExecutor,
  ): IOSCtrlProxyManager {
    return new IOSCtrlProxyManager({
      device,
      timer,
      builder,
      tunnelClient,
      processExecutor,
      physicalDeviceLister: NO_PHYSICAL_DEVICES,
    });
  }

  /**
   * Create instance for testing with injected dependencies
   */
  public static createForTestingWithDeps(
    options: IosCtrlProxyManagerTestOptions,
  ): IOSCtrlProxyManager {
    return IOSCtrlProxyManager.createForTestingWithOptions(options);
  }

  /**
   * Create instance for testing from a dependency bag. Anything omitted gets the
   * defaults of {@link createForTestingWithDeps}: executor-backed xcodebuild and
   * process clients, and an empty physical-device inventory.
   */
  public static createForTestingWithOptions(
    options: IosCtrlProxyManagerTestOptions,
  ): IOSCtrlProxyManager {
    const { timer, processExecutor } = options;
    return new IOSCtrlProxyManager({
      ...options,
      xcodebuild:
        options.xcodebuild ??
        new XcodebuildClient(
          async (file, args) => processExecutor.executeCommand(file, args),
          timer,
          processExecutor.spawn.bind(processExecutor),
        ),
      processClient: options.processClient ?? new IosCtrlProxyProcessClient(processExecutor, timer),
      physicalDeviceLister: options.physicalDeviceLister ?? NO_PHYSICAL_DEVICES,
    });
  }

  /** Typed read access to the wired collaborators and live lifecycle state (tests, doctor). */
  public get diagnostics(): IosCtrlProxyManagerDiagnostics {
    const self = this;
    return {
      device: self.state.device,
      timer: self.state.timer,
      builder: self.state.builder,
      processExecutor: self.state.processExecutor,
      xcodebuild: self.state.xcodebuild,
      processClient: self.state.processClient,
      signingManager: self.state.signingManager,
      deviceAppManager: self.state.deviceAppManager,
      remoteRunner: self.state.remoteRunner,
      hostPortAvailabilityChecker: self.state.hostPortAvailabilityChecker,
      tunnelClient: self.state.tunnelClient,
      processSupervisor: self.state.processSupervisor,
      deviceDetector: self.state.deviceDetector,
      get servicePort() {
        return self.state.servicePort;
      },
      get xcTestProcessId() {
        return self.state.xcTestProcessId;
      },
      get isStopping() {
        return self.state.isStopping;
      },
      get attemptedSetup() {
        return self.state.attemptedSetup;
      },
      hasRunnerGenerationToken: (...args) => self.state.runnerGenerationTokens.has(...args),
    };
  }

  /**
   * @internal Typed view of the test seams over private lifecycle state; not part of the public API.
   * `trackRunner` records the runner a launch step would have published without spawning one;
   * `register` makes this injected-dependency manager the one `getInstance`/`shutdownAll` see;
   * `setState` seeds state a test would otherwise reach only through a long start sequence.
   */
  get testHooks() {
    const shutdownOwnership: Pick<
      IosCtrlProxyTeardown,
      "isRunnerStillOwnedWithinShutdownDeadline"
    > = this.teardown;
    return {
      shutdownOwnership,
      processSupervisor: this.state.processSupervisor,
      trackRunner: (runner: {
        pid: number | null;
        process?: ChildProcess | null;
        abortController?: AbortController | null;
      }): void => {
        this.state.xcTestProcessId = runner.pid;
        this.state.xcTestProcess = runner.process ?? null;
        this.state.runnerAbortController = runner.abortController ?? null;
      },
      register: (): this => {
        IOSCtrlProxyManager.registry.invalidate(this.state.device.deviceId);
        IOSCtrlProxyManager.registry.get(this.state.device.deviceId, () => this);
        return this;
      },
      setState: (state: {
        servicePort?: number;
        xcTestProcessId?: number | null;
        isStopping?: boolean;
      }): void => {
        this.state.servicePort = state.servicePort ?? this.state.servicePort;
        if (state.xcTestProcessId !== undefined) {
          this.state.xcTestProcessId = state.xcTestProcessId;
        }
        this.state.isStopping = state.isStopping ?? this.state.isStopping;
      },
    };
  }

  /**
   * Reset all instances (for testing)
   */
  public static resetInstances(): void {
    IOSCtrlProxyManager.registry.closeAll();
    IOSCtrlProxyManager.registry.clearRetired();
    IOSCtrlProxyManager.startupOrphanRunnerReap = null;
  }

  /**
   * Evict a single device's manager instance and its `PortManager` reservation.
   * Call this from device teardown/destroy so a deleted-or-evicted device does
   * not permanently retain a manager (and its two process supervisors) or a
   * port reservation for the remainder of the daemon's lifetime (issue #6580).
   * Safe to call for a device that was never constructed via `getInstance` —
   * `PortManager.release` is a no-op when nothing is allocated for the id.
   */
  public static async evictSimulatorByName(
    name: string,
    timer: Timer = defaultTimer,
    deadlineMs?: number,
  ): Promise<void> {
    const matching = IOSCtrlProxyManager.registry
      .entries()
      .filter(([, instance]) => instance.state.device.name === name && instance.isSimulator());
    await Promise.all(
      matching.map(([deviceId, instance]) => {
        if (IOSCtrlProxyManager.registry.peek(deviceId) === instance) {
          return IOSCtrlProxyManager.evict(deviceId, timer, deadlineMs);
        }
        return Promise.resolve();
      }),
    );
  }

  /**
   * A device left discovery: stop its runner, and for a simulator also drop the
   * manager and its `PortManager` reservation. A deleted or erased simulator never
   * returns under the same UDID, so keeping its manager only burns one of the
   * shared 100 ports per UDID until "No available ports" (#11122). Physical
   * devices keep their manager so a reconnect resumes the same runner budget.
   */
  public static async evictAfterDeviceRemoval(
    deviceId: string,
    timer: Timer = defaultTimer,
  ): Promise<void> {
    const manager = IOSCtrlProxyManager.getExistingInstance(deviceId);
    if (!manager) {
      return;
    }
    const removal = manager.suspendForDeviceRemoval();
    // suspendForDeviceRemoval bumps the generation synchronously, so this is ours.
    const removalGeneration = manager.removalGeneration;
    await removal;
    // A simulator that came back (same UDID after erase or shutdown to boot) re-arms
    // this manager, and a newer removal owns its own eviction; evicting here would
    // force-stop the live runner and release its port (#11141).
    if (
      resolveIosDeviceKind({ deviceId }) === "simulator" &&
      IOSCtrlProxyManager.getExistingInstance(deviceId) === manager &&
      !manager.supersededSinceRemoval(removalGeneration)
    ) {
      await IOSCtrlProxyManager.evict(deviceId, timer);
    }
  }

  public static async evict(
    deviceId: string,
    timer: Timer = defaultTimer,
    deadlineMs?: number,
  ): Promise<void> {
    const instance = IOSCtrlProxyManager.registry.peek(deviceId);
    if (instance) {
      IOSCtrlProxyManager.registry.invalidate(deviceId);
      try {
        // Bound the force-stop the same way shutdownAll() does: a hung
        // runner cleanup must not block the port release / map deletion
        // below, which the caller's deleteDevice verification depends on
        // (issue #6580).
        await IosCtrlProxyShutdown.forceStopWithinEvictionDeadline(
          instance.shutdownHost(),
          timer,
          deadlineMs,
        );
      } catch (error) {
        logger.warn(
          `[IOSCtrlProxy] Failed to stop instance ${deviceId} during eviction: ${errorMessage(error)}`,
        );
      }
    }
    if (IOSCtrlProxyManager.registry.peek(deviceId) === undefined) {
      PortManager.release(deviceId);
    }
  }

  /**
   * Stop all active instances (for shutdown)
   */
  public static async shutdownAll(timer: Timer = defaultTimer): Promise<void> {
    const instances = IOSCtrlProxyManager.registry.entries().map(([, instance]) => instance);
    const results = await Promise.all(
      instances.map((instance) =>
        IosCtrlProxyShutdown.stopWithinShutdownDeadline(instance.shutdownHost(), timer),
      ),
    );
    IOSCtrlProxyManager.registry.closeAll();
    for (const result of results) {
      if (result !== null) {
        logger.warn(`[IOSCtrlProxy] Failed to stop instance during shutdown: ${result}`);
      }
    }
  }
  /** Force-stop the runner within a shutdown deadline. Public so tests can drive shutdown teardown directly. */
  forceStopForShutdown(deadline: number): Promise<void> {
    return this.teardown.forceStopForShutdown(deadline);
  }

  /**
   * Starts orphan reaping during daemon initialization while retaining the
   * promise so the first simulator request cannot adopt a runner being reaped.
   */
  public static startOrphanRunnerReapOnStartup(
    processClient: IosCtrlProxyProcessClient = new IosCtrlProxyProcessClient(),
    timer: Timer = defaultTimer,
  ): Promise<void> {
    const work = IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(processClient, timer);
    const completedWork = work.catch((error) => {
      logger.debug(`[IOSCtrlProxy] Startup orphan runner sweep failed: ${error}`);
    });
    IOSCtrlProxyManager.startupOrphanRunnerReap =
      IosCtrlProxyOrphanReaper.completeWithinStartupReapDeadline(completedWork, timer);
    return IOSCtrlProxyManager.startupOrphanRunnerReap;
  }
  /**
   * Best-effort startup sweep for orphaned CtrlProxy iOS runner processes left
   * behind by a previously crashed daemon.
   */
  public static reapOrphanedRunnerProcessesOnStartup(
    processClient: IosCtrlProxyProcessClient = new IosCtrlProxyProcessClient(),
    timer: Timer = defaultTimer,
  ): Promise<void> {
    return IosCtrlProxyOrphanReaper.reapOrphanedRunnerProcessesOnStartup(processClient, timer);
  }

  /**
   * Get the port the service is running on
   */
  public getServicePort(): number {
    return this.state.servicePort;
  }

  /**
   * Monotonic identity for successful forced runner restarts in this manager.
   * It stays stable while the same runner generation serves requests, including
   * when the allocated host service port is reused.
   */
  public getRunnerGeneration(): number {
    return this.state.runnerGeneration;
  }

  /**
   * Set the target app bundle ID for CtrlProxy to observe.
   * Must be called before start() — CtrlProxy reads the bundle ID from
   * the CTRL_PROXY_IOS_BUNDLE_ID env var at XCUITest initialization time.
   * Falls back to process.env.CTRL_PROXY_IOS_BUNDLE_ID if not set explicitly.
   */
  public setTargetBundleId(bundleId: string): void {
    this.state.targetBundleId = bundleId;
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
      IOSCtrlProxyManager.registry.peek(device.deviceId)?.getTargetBundleId() ??
      readEnvRaw(AMBIENT_ENV.CTRL_PROXY_IOS_BUNDLE_ID) ??
      undefined
    );
  }

  /**
   * Resolve the target bundle ID: explicit property > env var > undefined.
   */
  private resolveTargetBundleId(): string | undefined {
    return (
      this.state.targetBundleId ?? readEnvRaw(AMBIENT_ENV.CTRL_PROXY_IOS_BUNDLE_ID) ?? undefined
    );
  }

  /**
   * Clear all caches
   */
  public clearCaches(): void {
    this.state.cachedInstalled = null;
    this.state.cachedRunning = null;
    logger.info("[IOSCtrlProxy] Cleared all caches");
  }

  /**
   * Reset setup state to allow fresh setup
   */
  public resetSetupState(): void {
    this.state.attemptedSetup = false;
    this.clearCaches();
    logger.info("[IOSCtrlProxy] Reset setup state");
  }

  // MARK: - Status Checks

  /** Returns the persisted release identity of the currently extracted runner bundle. */
  public getInstalledVersionIdentity(): Promise<string | null> {
    return this.state.builder.getInstalledBundleVersion();
  }
  /**
   * Check if CtrlProxy is installed on the device
   * For simulators, this checks if the test bundle can be found
   */
  public isInstalled(): Promise<boolean> {
    return this.setupWorkflow.isInstalled();
  }
  /**
   * Check if CtrlProxy is currently running
   */
  public isRunning(): Promise<boolean> {
    return this.setupWorkflow.isRunning();
  }
  /** Fresh, device-aware health for status callers that must distinguish transport failure. */
  public checkRunningWithReason(): Promise<CtrlProxyHealthCheckResult> {
    return this.health.checkRunningWithReason();
  }
  /**
   * Check if the service is available (installed and running).
   *
   * Delegates directly to isInstalled()/isRunning() rather than layering its
   * own cache on top: isRunning() already carries the 30s STATUS_CACHE_TTL,
   * which is the only freshness the setup() gate's comment above assumes. A
   * separate hour-long positive cache here let a runner that died without a
   * local child-exit event (killed externally, simulator erased, wedged but
   * still answering /health) report "already running" for up to an hour
   * (#6416).
   */
  public isAvailable(): Promise<boolean> {
    return this.setupWorkflow.isAvailable();
  }
  // MARK: - Service Control

  /**
   * Start CtrlProxy
   */
  public start(options: CtrlProxyStartOptions = {}): Promise<void> {
    return this.startup.start(options);
  }
  /** Start the runner after a forced restart. Public so tests can stub the restart launch. */
  startAfterForceRestart(
    options: CtrlProxyStartOptions,
    expectedForceRestartGeneration?: number,
  ): Promise<void> {
    return this.startup.startAfterForceRestart(options, expectedForceRestartGeneration);
  }
  /**
   * Internal start implementation (called within mutex)
   */
  startInternal(sharedStart: SharedCtrlProxyStart): Promise<void> {
    return this.startup.startInternal(sharedStart);
  }
  terminateHungRunnerProcess(hungPid: number): Promise<void> {
    return this.teardown.terminateHungRunnerProcess(hungPid);
  }
  /**
   * Stop CtrlProxy
   */
  public stop(deadline?: number): Promise<void> {
    return this.teardown.stop(deadline);
  }
  /**
   * Terminate the local runner tracked at the time {@link stop} began, using a
   * single runner identity captured in `retiringController`. Returns the
   * termination error (or `undefined` on success) so the caller decides whether
   * to surface it. The tracking fields are cleared only when they still point at
   * the same runner we set out to retire — an overlapping forceRestart() may have
   * swapped in a newer runner in the meantime, which we must not clobber.
   */
  terminateTrackedRunner(
    retiringController: AbortController | null,
    deadline?: number,
  ): Promise<unknown> {
    return this.teardown.terminateTrackedRunner(retiringController, deadline);
  }
  /**
   * Complete setup process for CtrlProxy
   * Includes automatic build detection and prefetch integration
   */
  public setup(
    force: boolean = false,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
    minimumHealthPollDurationMs?: number,
  ): Promise<CtrlProxyIosSetupResult> {
    return this.setupWorkflow.setup(force, perf, signal, minimumHealthPollDurationMs);
  }
  trackStartedXcodebuild(child: ChildProcess): void {
    return this.launch.trackStartedXcodebuild(child);
  }

  // MARK: - Private Helpers

  private isSimulator(): boolean {
    // Simulators have UUIDs like "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX";
    // physical devices have serial-style UDIDs.
    return resolveIosDeviceKind({ deviceId: this.state.device.deviceId }) === "simulator";
  }

  private useRemoteRunner(): boolean {
    return this.state.remoteRunner.isEnabled() && this.state.remoteRunner.isRunningInDocker();
  }
  ensureRemoteServicePortAvailable(options: { allowReallocation?: boolean } = {}): Promise<void> {
    return this.ports.ensureRemoteServicePortAvailable(options);
  }
  startOnSimulator(): Promise<RunnerLaunchProvenance> {
    return this.launch.startOnSimulator();
  }

  /**
   * Enable or disable auto-restart
   */
  public setAutoRestart(enabled: boolean): void {
    this.state.processSupervisor.setAutoRestart(enabled);
    logger.info(`[IOSCtrlProxy] Auto-restart ${enabled ? "enabled" : "disabled"}`);
  }

  /**
   * Check if auto-restart is enabled
   */
  public isAutoRestartEnabled(): boolean {
    return this.state.processSupervisor.isAutoRestartEnabled();
  }
  public isRecoveryInFlight(): boolean {
    return this.restart.isRecoveryInFlight();
  }
  /**
   * Force restart the service (useful when client detects issues)
   */
  public forceRestart(options: CtrlProxyStartOptions = {}): Promise<void> {
    return this.restart.forceRestart(options);
  }
  /**
   * Poll the health endpoint for a bounded grace after a forced teardown. Returns
   * true only when the old runner is STILL answering at the end of the grace — a
   * listener that merely lags the process teardown stops answering well inside it,
   * and the restart may proceed. Honours the caller's abort signal while polling.
   *
   * Strict: a responder that omits deviceId must NOT be mistaken for the runner we
   * just tried to stop. The primary liveness gate is strict by default too; this
   * explicit option keeps the ownership requirement visible at the forced-teardown
   * call site. An ambiguous responder must not block a legitimate restart (#6415 follow-up).
   *
   * Public so tests can stub the probe.
   */
  isRunnerStillHealthyAfterForcedTeardown(signal?: AbortSignal): Promise<boolean> {
    return this.restart.isRunnerStillHealthyAfterForcedTeardown(signal);
  }
  /**
   * Check if a process is still running
   */
  isProcessRunning(pid: number): Promise<boolean> {
    return this.discovery.isProcessRunning(pid);
  }

  /**
   * Resolve the health-poll attempt budget. Env-overridable so CI (where XCUITest
   * cold-start routinely exceeds the default) can extend it without a code change.
   */
  static resolveHealthPollMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
    return readEnvPositiveInteger(
      ENV.CTRL_PROXY_HEALTH_MAX_ATTEMPTS.name,
      ENV.CTRL_PROXY_HEALTH_MAX_ATTEMPTS.legacyName,
      { fallback: IOS_CTRL_PROXY_DEFAULT_HEALTH_POLL_MAX_ATTEMPTS },
      env,
    );
  }
  ensureServicePortReadyForLaunch(): Promise<void> {
    return this.ports.ensureServicePortReadyForLaunch();
  }

  public static async awaitStartupOrphanRunnerReap(): Promise<void> {
    await IOSCtrlProxyManager.startupOrphanRunnerReap;
  }
  /**
   * A physical-device start must never overwrite the handles to a runner that may
   * still be alive: the first `xcodebuild` is `detached`, so once the tracked child
   * and abort controller are replaced nothing, not `stop()` and not shutdown, can
   * terminate it (#10234). Terminate and await any live tracked runner first, and
   * abort its controller. When termination fails the tracking is restored and the
   * start fails, so no second runner is spawned and `stop()` can retry.
   */
  retireTrackedDeviceRunnerBeforeSpawn(): Promise<void> {
    return this.teardown.retireTrackedDeviceRunnerBeforeSpawn();
  }
  /**
   * Read-only doctor discovery. Return the answering host port, never the
   * advertised on-device port, without changing daemon allocation or state.
   */
  public discoverRunnerPort(options: DoctorProbeOptions = {}): Promise<number | null> {
    return this.health.discoverRunnerPort(options);
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
   * to report a port. This is runner-advertised metadata; doctor uses
   * `discoverRunnerPort()` to find the answering host port instead (#5636).
   */
  public getReportedRunnerPort(): Promise<number | null> {
    return this.health.getReportedRunnerPort();
  }
  /** Start the iproxy tunnel to the runner. Public so tests can stub the tunnel launch. */
  startIproxyTunnel(options: IproxyTunnelStartOptions = {}): Promise<void> {
    return this.tunnel.startIproxyTunnel(options);
  }
  stopIproxyTunnel(
    options: { clearDevicePort?: boolean; stopSupervisor?: boolean } = {},
  ): Promise<void> {
    return this.tunnel.stopIproxyTunnel(options);
  }
  restartIproxyTunnel(): Promise<void> {
    return this.tunnel.restartIproxyTunnel();
  }
  /**
   * Get device capabilities for CtrlProxy
   */
  public getCapabilities(): Promise<CtrlProxyIosCapabilities> {
    return this.setupWorkflow.getCapabilities();
  }
}
