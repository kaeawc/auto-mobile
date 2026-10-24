import { IosRunnerLaunchFailures } from "./IosRunnerLaunchFailure";
import { getSharedIosRunnerLaunchGate, type IosRunnerLaunchGate } from "./IosRunnerLaunchGate";
import type { RunnerLaunchProgressProbe } from "./IosRunnerLaunchProgress";
import { CtrlProxyRunnerExitedDuringStartupError } from "./CtrlProxyRunnerExitedDuringStartupError";
import { PortManager, IOS_CTRL_PROXY_RESERVED_PORTS } from "../../utils/PortManager";
import { DefaultIosTunnelClient, type IosTunnelClient } from "./IosTunnelClient";
import { DefaultIosAppBundleGuard, type IosAppBundleGuard } from "./IosAppBundleGuard";
import { IosDeviceDetector } from "./IosDeviceDetector";
import type {
  IosCtrlProxyLifecycleSteps,
  IosCtrlProxyStepOverrides,
  RunnerLaunchProvenance,
  SharedCtrlProxyStart,
} from "./IosCtrlProxyLifecycleSteps";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { BootedDevice } from "../../models";
import { type PerformanceTracker } from "../../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { IosCtrlProxyBuilder } from "../IosCtrlProxyBuilder";
import type { IosCtrlProxyBuilderSurface } from "../IosCtrlProxyBuilderSurface";
import type { HostChildProcess as ChildProcess } from "../../utils/HostCommandExecutor";
import {
  DefaultHostCommandExecutor,
  type HostProcessExecutor,
} from "../../utils/HostCommandExecutor";
import { XcodeSigningManager } from "../../utils/ios-cmdline-tools/XcodeSigning";
import { XcodebuildClient, type Xcodebuild } from "../../utils/ios-cmdline-tools/XcodebuildClient";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { exponentialBackoff } from "../../utils/Backoff";
import { ForcedRestartBudget } from "../ForcedRestartBudget";
import {
  DefaultProcessSupervisor,
  type LivenessProbe,
  type ProcessSupervisor,
  type ProcessSupervisorOptions,
} from "../../utils/ProcessSupervisor";
import {
  TcpHostPortAvailabilityChecker,
  type HostPortAvailabilityChecker,
} from "./IOSHostPortAvailabilityChecker";
import { IosCtrlProxyHealthClient } from "./IosCtrlProxyHealthClient";
import { IosCtrlProxyProcessClient } from "./IosCtrlProxyProcessClient";
import { ENV, readEnvBool } from "../../config/env";
import {
  CtrlProxyStartOptions,
  RemoteCtrlProxyIOSRunner,
  DISABLED_REMOTE_RUNNER,
  IosCtrlProxyManagerOptions,
  IOS_CTRL_PROXY_MAX_RESTART_ATTEMPTS,
  IOS_CTRL_PROXY_RESTART_BASE_DELAY_MS,
  IOS_CTRL_PROXY_RESTART_MAX_DELAY_MS,
  IOS_CTRL_PROXY_APP_BUNDLE_ID,
  IOS_CTRL_PROXY_LEGACY_APP_BUNDLE_ID,
} from "./IosCtrlProxyContracts";

interface IosCtrlProxyRuntimeHost {
  useRemoteRunner(): boolean;
  isSimulator(): boolean;
  startInternal(sharedStart: SharedCtrlProxyStart): Promise<void>;
  waitForNonJoinableStart(signal: AbortSignal | undefined): Promise<SharedCtrlProxyStart | null>;
  retireRunnerAfterFinalSharedStartCancellation(sharedStart: SharedCtrlProxyStart): Promise<void>;
  startOnSimulator(): Promise<RunnerLaunchProvenance>;
  startOnDevice(): Promise<RunnerLaunchProvenance>;
  waitForHealthEndpoint(
    sharedStart: SharedCtrlProxyStart,
    perf: PerformanceTracker,
    delayMs: number,
    launchDeadlineMs?: number,
  ): Promise<boolean>;
  completeHealthStartup(sharedStart: SharedCtrlProxyStart, perf: PerformanceTracker): Promise<void>;
  isOwnRunnerProcessAlive(pid?: number | null): Promise<boolean>;
  terminateHungRunnerProcess(hungPid: number): Promise<void>;
  terminateTrackedRunner(
    retiringController: AbortController | null,
    deadline?: number,
  ): Promise<unknown>;
  fenceLateRemoteStartAfterShutdown(runnerPid: number): Promise<void>;
  start(options?: CtrlProxyStartOptions): Promise<void>;
  isSupervisedCtrlProxyProcessAlive(probe: LivenessProbe): Promise<boolean>;
  clearCaches(): void;
  isProcessRunning(pid: number): Promise<boolean>;
  restartIproxyTunnel(): Promise<void>;
  ensureRemoteServicePortAvailable(options?: { allowReallocation?: boolean }): Promise<void>;
}

/** Owns per-device state and constructs the injected clients and lifecycle steps. */
export class IosCtrlProxyRuntime {
  readonly device: BootedDevice;
  readonly timer: Timer;
  readonly forcedRestartBudget: ForcedRestartBudget;
  servicePort: number;
  readonly builder: IosCtrlProxyBuilderSurface;
  readonly processExecutor: HostProcessExecutor;
  readonly xcodebuild: Xcodebuild;
  readonly processClient: IosCtrlProxyProcessClient;
  readonly runnerLaunchGate: IosRunnerLaunchGate;
  readonly runnerLaunchFailures = new IosRunnerLaunchFailures();
  readonly runnerLaunchProgressProbe: RunnerLaunchProgressProbe;
  readonly signingManager: XcodeSigningManager;
  readonly deviceAppManager: DeviceAppManager;
  readonly remoteRunner: RemoteCtrlProxyIOSRunner;
  readonly hostPortAvailabilityChecker: HostPortAvailabilityChecker;
  readonly healthClient: IosCtrlProxyHealthClient;
  remoteRunnerAvailability: Promise<boolean> | null = null;
  // Cache for status checks
  cachedInstalled: { isInstalled: boolean; timestamp: number } | null = null;
  cachedRunning: { isRunning: boolean; timestamp: number } | null = null;
  // Setup state tracking
  attemptedSetup: boolean = false;
  // XCUITest process state
  xcTestProcessId: number | null = null;
  xcTestProcess: ChildProcess | null = null;
  // Owns the resident runner's process-lifecycle abort signal (issue #6410).
  // Deliberately NOT the ambient per-request signal: this runner is shared
  // across every session targeting the device and must outlive whichever
  // request happened to start it. Only stop()/forceRestart() may abort it, so
  // SharedCtrlProxyStart's teardown accounting stays the single authority
  // deciding when the runner actually goes away.
  runnerAbortController: AbortController | null = null;
  // Process supervision
  readonly processSupervisor: ProcessSupervisor;
  readonly tunnelClient: IosTunnelClient;
  readonly deviceDetector: IosDeviceDetector;
  readonly appBundleGuard: IosAppBundleGuard;
  readonly steps: IosCtrlProxyLifecycleSteps;
  isProcessSupervisorRestarting = false;
  isStopping: boolean = false;
  // Set when the runner supervisor finds the tracked runner process alive but
  // unhealthy, so its onExit keeps the tracking: clearing it would hide a live
  // xcodebuild from the next start, which would then spawn a second one (#10234).
  retainRunnerTrackingOnSupervisorExit = false;
  // Runner PIDs terminated on purpose so an in-flight start can relaunch them
  // (#10653). Their child exit/error events arrive while the kill is in flight,
  // before untracking, and must not reach the supervisor: its onExit would abort
  // the shared start and schedule a restart racing the relaunch.
  readonly retiredRunnerPids = new Set<number>();
  readonly runnerGenerationTokens = new Map<number, string>();
  // Service ports a forced restart retired because this daemon judged the runner
  // on them unhealthy (#11205). Killing the daemon's xcodebuild does not kill the
  // in-simulator runner it hosted (launchd_sim owns it), so a stalled runner can
  // keep listening on the retired port and look like an "external" runner to the
  // next start. A direct runner on one of these ports is adopted only when it
  // passes a health probe; otherwise it is terminated and a fresh one spawned.
  readonly unhealthyRetiredPorts = new Set<number>();
  // Shared process startup prevents concurrent callers from launching duplicate runners.
  sharedStart: SharedCtrlProxyStart | null = null;
  // A forced restart must retain lifecycle ownership through its non-interruptible
  // stop phase, even when the readiness caller times out before it settles.
  forceRestartInFlight: Promise<void> | null = null;
  removalCleanup: Promise<void> | null = null;
  removalGeneration = 0;
  rearmedRemovalGeneration = 0;
  // Lets ordinary starts detect that a newer forced restart began while they
  // yielded before claiming the shared-start slot.
  forceRestartGeneration = 0;
  // A successful forced restart changes the daemon-owned runner incarnation
  // even when the host service port is reused. This is deliberately separate
  // from `forceRestartGeneration`, which advances before teardown and can
  // therefore represent a failed restart attempt.
  runnerGeneration = 0;
  // Joining callers may need a longer health-poll budget than the restart owner.
  // Retain their request until the forced restart reaches shared startup.
  readonly forceRestartHealthPollDurationsMs = new Map<symbol, number>();
  // Target app bundle ID for CtrlProxy to observe (instead of SpringBoard)
  targetBundleId: string | null = null;
  constructor(
    options: IosCtrlProxyManagerOptions,
    private readonly host: IosCtrlProxyRuntimeHost,
  ) {
    const {
      device,
      timer = defaultTimer,
      builder,
      processExecutor = new DefaultHostCommandExecutor(),
      signingManager = new XcodeSigningManager(),
      deviceAppManager = new DeviceAppManager(),
      remoteRunner,
      hostPortAvailabilityChecker = new TcpHostPortAvailabilityChecker(),
      xcodebuild = new XcodebuildClient(),
      processClient,
    } = options;
    this.device = device;
    this.timer = timer;
    // iOS automatic runner recovery has a five-minute episode limit in addition
    // to the shared budget's three-attempt cap; Android keeps its own policy.
    this.forcedRestartBudget = new ForcedRestartBudget(timer, 3, undefined, 300_000);
    this.servicePort = PortManager.allocate(this.device.deviceId, {
      reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS,
    });
    this.builder = builder || IosCtrlProxyBuilder.getInstance();
    this.processExecutor = processExecutor;
    this.xcodebuild = xcodebuild;
    this.processClient = processClient ?? new IosCtrlProxyProcessClient();
    this.runnerLaunchGate = this.resolveLaunchGate(options);
    this.runnerLaunchProgressProbe = this.resolveLaunchProgressProbe(options);
    this.signingManager = signingManager;
    this.deviceAppManager = deviceAppManager;
    this.hostPortAvailabilityChecker = hostPortAvailabilityChecker;
    this.remoteRunner = remoteRunner || DISABLED_REMOTE_RUNNER;
    this.deviceDetector = this.resolveDeviceDetector(options);
    this.appBundleGuard = this.resolveAppBundleGuard(options);
    this.steps = this.resolveSteps(options.steps);
    this.healthClient = new IosCtrlProxyHealthClient(this.processExecutor, this.timer, {
      useRemoteRunner: () => this.host.useRemoteRunner(),
      getHost: () => this.remoteRunner.getHost(),
      deviceId: this.device.deviceId,
    });
    this.processSupervisor = this.createProcessSupervisor(options.processSupervisorFactory);
    this.tunnelClient =
      options.tunnelClient ??
      new DefaultIosTunnelClient({
        processExecutor: this.processExecutor,
        timer: this.timer,
        remoteRunner: this.remoteRunner,
        useRemoteRunner: () => this.host.useRemoteRunner(),
        isRunning: (pid) => this.host.isProcessRunning(pid),
        getServicePort: () => this.servicePort,
        getDeviceId: () => this.device.deviceId,
        isStopping: () => this.isStopping,
        isSimulator: () => this.host.isSimulator(),
        isConnected: () => this.deviceDetector.isDeviceDetected(),
        restart: () => this.host.restartIproxyTunnel(),
        prepareRemoteStart: (start) =>
          this.host.ensureRemoteServicePortAvailable({
            allowReallocation: start.allowServicePortReallocation ?? true,
          }),
      });
  }

  private resolveLaunchGate(options: IosCtrlProxyManagerOptions): IosRunnerLaunchGate {
    return options.runnerLaunchGate ?? getSharedIosRunnerLaunchGate();
  }

  private resolveLaunchProgressProbe(
    options: IosCtrlProxyManagerOptions,
  ): RunnerLaunchProgressProbe {
    return options.runnerLaunchProgressProbe ?? this.processClient;
  }

  private resolveDeviceDetector(options: IosCtrlProxyManagerOptions): IosDeviceDetector {
    return (
      options.deviceDetector ??
      new IosDeviceDetector({
        deviceId: this.device.deviceId,
        processExecutor: this.processExecutor,
        timer: this.timer,
        remoteRunner: this.remoteRunner,
        useRemoteRunner: () => this.host.useRemoteRunner(),
        isSimulator: () => this.host.isSimulator(),
        physicalDeviceLister: options.physicalDeviceLister,
      })
    );
  }

  private resolveAppBundleGuard(options: IosCtrlProxyManagerOptions): IosAppBundleGuard {
    return (
      options.appBundleGuard ??
      new DefaultIosAppBundleGuard({
        device: this.device,
        deviceAppManager: this.deviceAppManager,
        processExecutor: this.processExecutor,
        timer: this.timer,
        appBundleId: IOS_CTRL_PROXY_APP_BUNDLE_ID,
        legacyAppBundleId: IOS_CTRL_PROXY_LEGACY_APP_BUNDLE_ID,
        isSimulator: () => this.host.isSimulator(),
        isHashVerificationSkipped: () => readEnvBool(ENV.IOS_SKIP_CTRL_PROXY_APP_HASH),
        getExpectedAppHash: (platform) => this.builder.getExpectedAppHash(platform),
      })
    );
  }

  /** The manager's own lifecycle steps, with any test replacements applied on top. */
  private resolveSteps(
    overrides: IosCtrlProxyStepOverrides | undefined,
  ): IosCtrlProxyLifecycleSteps {
    const ownSteps: IosCtrlProxyLifecycleSteps = {
      startInternal: (sharedStart) => this.host.startInternal(sharedStart),
      waitForNonJoinableStart: (signal) => this.host.waitForNonJoinableStart(signal),
      retireRunnerAfterFinalSharedStartCancellation: (sharedStart) =>
        this.host.retireRunnerAfterFinalSharedStartCancellation(sharedStart),
      startOnSimulator: () => this.host.startOnSimulator(),
      startOnDevice: () => this.host.startOnDevice(),
      waitForHealthEndpoint: (sharedStart, perf, delayMs, launchDeadlineMs) =>
        this.host.waitForHealthEndpoint(sharedStart, perf, delayMs, launchDeadlineMs),
      completeHealthStartup: (sharedStart, perf) =>
        this.host.completeHealthStartup(sharedStart, perf),
      isOwnRunnerProcessAlive: (pid) => this.host.isOwnRunnerProcessAlive(pid),
      terminateHungRunnerProcess: (pid) => this.host.terminateHungRunnerProcess(pid),
      terminateTrackedRunner: (controller, deadline) =>
        this.host.terminateTrackedRunner(controller, deadline),
      uninstallLegacyAppIfPresent: () => this.appBundleGuard.uninstallLegacyAppIfPresent(),
      fenceLateRemoteStartAfterShutdown: (pid) => this.host.fenceLateRemoteStartAfterShutdown(pid),
    };
    const requested = typeof overrides === "function" ? overrides(ownSteps) : overrides;
    // An explicitly undefined entry means "keep the manager's own step".
    const defined = Object.entries(requested ?? {}).filter(([, step]) => step !== undefined);
    return { ...ownSteps, ...Object.fromEntries(defined) };
  }

  private createProcessSupervisor(
    factory: ((options: ProcessSupervisorOptions) => ProcessSupervisor) | undefined,
  ): ProcessSupervisor {
    const create = factory ?? ((options) => new DefaultProcessSupervisor(options));
    return create({
      name: "iOS CtrlProxy XCTest runner",
      timer: this.timer,
      monitorIntervalMs: 30000,
      maxRestartAttempts: IOS_CTRL_PROXY_MAX_RESTART_ATTEMPTS,
      restartBackoff: exponentialBackoff({
        initialDelayMs: IOS_CTRL_PROXY_RESTART_BASE_DELAY_MS,
        maxDelayMs: IOS_CTRL_PROXY_RESTART_MAX_DELAY_MS,
      }),
      restart: async () => {
        this.isProcessSupervisorRestarting = true;
        try {
          await this.host.start();
        } finally {
          this.isProcessSupervisorRestarting = false;
        }
      },
      isAlive: (probe) => this.host.isSupervisedCtrlProxyProcessAlive(probe),
      onExit: () => {
        const sharedStart = this.sharedStart;
        if (
          sharedStart &&
          !sharedStart.completed &&
          !sharedStart.teardownCommitted &&
          !sharedStart.controller.signal.aborted
        ) {
          sharedStart.controller.abort(new CtrlProxyRunnerExitedDuringStartupError());
        }
        const retainRunner = this.retainRunnerTrackingOnSupervisorExit;
        this.retainRunnerTrackingOnSupervisorExit = false;
        if (!retainRunner) {
          if (this.xcTestProcessId !== null) {
            this.runnerGenerationTokens.delete(this.xcTestProcessId);
            this.runnerLaunchFailures.clear(this.xcTestProcessId);
          }
          this.xcTestProcessId = null;
          this.xcTestProcess = null;
        }
        this.host.clearCaches();
      },
      onRestartSuccess: () => {
        logger.info("[IOSCtrlProxy] Auto-restart successful");
      },
      onRestartFailure: (error) => {
        logger.warn(`[IOSCtrlProxy] Auto-restart failed: ${errorMessage(error)}`);
      },
    });
  }
}
