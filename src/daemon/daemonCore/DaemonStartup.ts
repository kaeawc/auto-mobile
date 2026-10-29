import { isAndroidOrIosPlatform } from "../../models/Platform";
import type { SessionBrokerService } from "../sessionBroker/service";
import type { DaemonDeviceSessionStore } from "../daemonDependencies";
import type {
  DaemonCoreServices,
  DaemonIdentityState,
  DaemonLifecycleState,
} from "./DaemonCoreState";
import { sweepStaleAppearanceConfigs } from "../appearanceConfigStartupSweep";
import { createServer as createHttpServer } from "node:http";
import { logger } from "../../utils/logger";
import { setLogContextProvider } from "../../utils/logContext";
import { currentMcpTrace } from "../mcpTraceContext";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { UnixSocketServer } from "../socketServer";
import { type DaemonSocketServer } from "../daemonSocketServer";
import { bindingRegistryFileExists } from "../sessionBroker/registry/sqliteBindingRegistry";
import { SOCKET_PATH, MCP_STREAMABLE_PATH } from "../wire/constants";
import { DaemonOptions } from "../types";
import { writeDaemonExitRecord, type DaemonExitRecordFileSystem } from "../daemonExitRecord";
import { setCtrlProxyForwardLeaseOwnerSocketPath } from "../../features/observe/shared/ctrlProxyForwardLeaseOwnership";
import { PID_FILE_PATH } from "../wire/constants";
import { type LiveDaemonSessionIdProvider } from "../daemonFiles";
import { recordDeviceSettingDefaultsBeforeChange } from "../../features/utility/DeviceSettingDefaults";
import { HybridVideoCaptureBackend } from "../../features/video/HybridVideoCaptureBackend";
import { getDatabasePath } from "../../db";
import { DatabaseInitializer } from "../../db/DatabaseInitializer";
import { StartupFailureTracker } from "../DaemonStartupFailureTracker";
import { handleFatalDatabaseStartupFailure } from "../daemonStartupGuard";
import { runStartupPrologue } from "../startupPrologue";
import { startupBenchmark } from "../../utils/startupBenchmark";
import { startVideoRecordingSocketServer } from "../videoRecordingSocketServer";
import { startDeviceGestureRecordingSocketServer } from "../deviceGestureRecordingSocketServer";
import { startDeviceSnapshotSocketServer } from "../deviceSnapshotSocketServer";
import { startAppearanceSocketServer } from "../appearanceSocketServer";
import { startPerformanceStreamSocketServer } from "../performanceStreamSocketServer";
import { startPerformancePushSocketServer } from "../performancePushSocketServer";
import { startDeviceDataStreamSocketServer } from "../deviceDataStreamSocketServer";
import { startFailuresStreamSocketServer } from "../failuresStreamSocketServer";
import { startFailuresPushSocketServer } from "../failuresPushSocketServer";
import { startTelemetryPushSocketServer } from "../telemetryPushSocketServer";
import { startWebRtcStreamSocketServer } from "../webrtcStreamSocketServer";
import { startVideoStreamSocketServer } from "../videoStreamSocketServer";
import { getDaemonSocketPathsByName } from "../socketPaths";
import { prepareBindingRegistryForStartup } from "../sessionBroker/registry/legacySlotDeviceRetirement";
import { createDaemonTerminalReleaseJournal } from "../terminalReleaseJournal";
import { IosCtrlProxyBuilder } from "../../ctrlProxy/IosCtrlProxyBuilder";
import { initializeIosCtrlProxyAtStartup, selectIosStartupWarmupDevices } from "../iosStartupInit";
import { startAppearanceSyncScheduler } from "../AppearanceSyncScheduler";
import { startPerformanceMonitor } from "../../features/performance/PerformanceMonitor";
import { defaultTimer } from "../../utils/SystemTimer";
import { AndroidAvdProvenanceCache } from "../../utils/AndroidAvdProvenanceCache";
import type { AvdManager } from "../../utils/android-cmdline-tools/interfaces/AvdManager";
import { errorMessage } from "../../utils/describeUnknownError";
import { FeatureFlagService } from "../../features/featureFlags/FeatureFlagService";
import { serverConfig } from "../../utils/ServerConfig";
import { setDebugPerfEnabled } from "../../utils/PerformanceTracker";
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from "../../processLifecycle";
import {
  DAEMON_LAUNCH_CWD_ENV,
  safeProcessCwd,
  resolveStableDaemonWorkingDirectory,
  normalizeCoreSimulatorDeviceSetPathEnv,
} from "../../utils/workingDirectory";
import { type ToolSelectionProfileProvenanceLoader } from "../toolSelectionProfileRegistry";
import type { DaemonBroker } from "./DaemonBroker";
import type { DaemonSessions } from "./DaemonSessions";
import type { DaemonIdentity } from "./DaemonIdentity";
import type { DaemonStreams } from "./DaemonStreams";
import type { DaemonMaintenance } from "./DaemonMaintenance";
import type { DaemonDisconnect } from "./DaemonDisconnect";
import type { DaemonShutdown } from "./DaemonShutdown";
import type { DaemonRecordingHost, DaemonStartHost } from "../daemonStartHost";
import { findAvailableDaemonPort } from "../daemonPort";

export interface DaemonStartupHost extends Pick<
  DaemonRecordingHost,
  | "initializeRecordingTeardownRedriveState"
  | "redriveUnconfirmedCaptureTeardowns"
  | "setStartupOrphanCaptures"
  | "setVideoRecordingManagerDependencies"
> {
  enterDaemonProcess: DaemonStartup["enterDaemonProcess"];
  prepareHttpToken: () => void;
  publishHttpToken: () => void;
  startHttpIngress: DaemonStartup["startHttpIngress"];
  bindControlSocket: DaemonStartup["bindControlSocket"];
  startServicesAfterSocketBind: DaemonStartup["startServicesAfterSocketBind"];
  startMaintenanceMonitors: DaemonStartup["startMaintenanceMonitors"];
  readPersistedSession: DaemonDeviceSessionStore["getSession"];
  services: Pick<
    DaemonCoreServices,
    | "iosDeviceVerifier"
    | "httpIngress"
    | "mcpDispatcher"
    | "deviceReadiness"
    | "sessionManager"
    | "devicePool"
    | "deviceSessionRegistry"
    | "installedAppsRepository"
    | "deviceSessionRepository"
    | "timer"
    | "passiveWorkPolicy"
    | "idGenerator"
    | "options"
    | "daemonState"
  >;
  identity: Pick<
    DaemonIdentityState,
    | "port"
    | "setPort"
    | "completeIdentityPublished"
    | "setCompleteIdentityPublished"
    | "socketBindCommitted"
    | "setSocketBindCommitted"
    | "incumbentOwnerGuard"
    | "daemonSessionId"
    | "generationStartedAt"
    | "processStartedAt"
    | "processGenerationToken"
    | "liveAcceptanceStartupSecret"
    | "acceptanceDiscoveryCapability"
  >;
  lifecycle: Pick<
    DaemonLifecycleState,
    | "socketServer"
    | "setSocketServer"
    | "selfExitRecorder"
    | "startupCompletion"
    | "sessionBrokerConfigPath"
    | "managedExecutionReowner"
    | "shutdownInProgress"
    | "recorderDeviceIncarnationListener"
    | "setRecorderDeviceIncarnationListener"
  >;
  startHost: () => DaemonStartHost;
  setStartHost: (value: DaemonStartHost) => void;
  enteredDaemonProcess: () => boolean;
  setEnteredDaemonProcess: (value: boolean) => void;
  resolveStartupCompletion: () => () => void;
  rejectStartupCompletion: () => (reason: unknown) => void;
  exitRecordFileSystem: () => DaemonExitRecordFileSystem;
  strictPort: () => boolean;
  host: () => string;
  startupFailureTracker: () => StartupFailureTracker;
  avdManagerFactory: () => () => Pick<AvdManager, "listDeviceImages">;
  databaseInitializer: () => DatabaseInitializer;
  toolSelectionProfileProvenanceLoader: () => ToolSelectionProfileProvenanceLoader;
  liveDaemonSessionIdProvider: () => LiveDaemonSessionIdProvider;
  startOn: DaemonStartup["startOn"];
  startThroughSocketBind: DaemonStartup["startThroughSocketBind"];
  startAfterSocketBind: DaemonStartup["startAfterSocketBind"];
  stopAfterFailedStartup: DaemonStartup["stopAfterFailedStartup"];
  stop: DaemonShutdown["stop"];
  writeEarlyOwnerRecord: DaemonIdentity["writeEarlyOwnerRecord"];
  setupShutdownHandlers: DaemonShutdown["setupShutdownHandlers"];
  subscribeToolCallEndActivity: DaemonSessions["subscribeToolCallEndActivity"];
  initializeDatabase: DaemonStartup["initializeDatabase"];
  openBindingRegistry: DaemonBroker["openBindingRegistry"];
  startBackgroundRegistryUpgrade: DaemonBroker["startBackgroundRegistryUpgrade"];
  initializeDevicePoolWithTimeout: DaemonStartup["initializeDevicePoolWithTimeout"];
  reownRehydratedManagedExecutions: DaemonBroker["reownRehydratedManagedExecutions"];
  installSessionBroker: DaemonBroker["installSessionBroker"];
  initializeIosServices: DaemonStartup["initializeIosServices"];
  restoreIncumbentOwnerRecord: DaemonIdentity["restoreIncumbentOwnerRecord"];
  republishIdentity: DaemonIdentity["republishIdentity"];
  recordControlSocketIdentity: DaemonIdentity["recordControlSocketIdentity"];
  startAuxiliarySocket: DaemonIdentity["startAuxiliarySocket"];
  configureDeviceDataStreamServer: DaemonStreams["configureDeviceDataStreamServer"];
  setupDeviceSessionRouting: DaemonStreams["setupDeviceSessionRouting"];
  getAppearanceSyncTargets: DaemonSessions["getAppearanceSyncTargets"];
  startAdbMissingDeviceListener: DaemonDisconnect["startAdbMissingDeviceListener"];
  startDeviceDisconnectMonitor: DaemonDisconnect["startDeviceDisconnectMonitor"];
  writePidFile: DaemonIdentity["writePidFile"];
  startHealthCheckTimer: DaemonMaintenance["startHealthCheckTimer"];
  startNavigationRetentionMonitor: DaemonMaintenance["startNavigationRetentionMonitor"];
  startForwardLeaseIdleReleaser: DaemonMaintenance["startForwardLeaseIdleReleaser"];
  startPrivateDaemonOrphanWatchdog: DaemonMaintenance["startPrivateDaemonOrphanWatchdog"];
  startHeartbeatMonitor: DaemonMaintenance["startHeartbeatMonitor"];
  initializeDevicePool: DaemonStartup["initializeDevicePool"];
  start: DaemonStartup["start"];
}

/** Sequences startup over replaceable host steps and initializes devices and persistence. */
export class DaemonStartup {
  private sessionBrokerRecovery: Pick<SessionBrokerService, "start"> | undefined;
  /** Exposed through Daemon.testHooks: the in-flight or settled startup provenance warm. */
  androidAvdProvenanceWarmPromise: Promise<unknown> | undefined;
  /** Live peer daemon ids captured at startup, consulted by the appearance sweep (#11158). */
  private startupLiveDaemonSessionIds: ReadonlySet<string> = new Set();
  constructor(private readonly host: DaemonStartupHost) {}

  applyRuntimeOptions(options: DaemonOptions): void {
    // Apply CLI flags to serverConfig so daemon tools respect them
    if (options.networkMockable) {
      serverConfig.setNetworkMockableEnabled(true);
    }
    if (options.dismissKeyboardAfterInput) {
      serverConfig.setDismissKeyboardAfterInputEnabled(true);
    }
    if (options.eventAllMarkers && options.eventAllMarkers.length > 0) {
      serverConfig.setEventAllMarkers(options.eventAllMarkers);
    }
    if (options.debugPerf) {
      setDebugPerfEnabled(true);
    }
    if (options.noUiPerfMode) {
      serverConfig.setUiPerfMode(false);
    }
    if (options.noNavigationScreenshots) {
      serverConfig.setNavigationScreenshotsEnabled(false);
    }
    if (options.noWaitForPollingOverhead) {
      serverConfig.setWaitForPollingOverheadEnabled(false);
    }
    if (options.memPerfAudit) {
      serverConfig.setMemPerfAuditMode(true);
    }
    if (options.predictiveUi) {
      serverConfig.setPredictiveUiEnabled(true);
    }
  }

  applyAccessibilityOptions(options: DaemonOptions): void {
    if (options.rawElementSearch) {
      serverConfig.setRawElementSearchEnabled(true);
    }
    if (options.skipCtrlProxyDownload) {
      serverConfig.setSkipCtrlProxyDownload(true);
    }
    if (options.runnerReadinessTimeoutMs !== undefined) {
      serverConfig.setRunnerReadinessTimeoutMs(options.runnerReadinessTimeoutMs);
    }
    if (options.noA11yIncludeNotImportantViews) {
      serverConfig.setA11yIncludeNotImportantViews(false);
    }
    if (options.noA11yReportViewIds) {
      serverConfig.setA11yReportViewIds(false);
    }
    if (options.noA11yRetrieveInteractiveWindows) {
      serverConfig.setA11yRetrieveInteractiveWindows(false);
    }
    if (options.noOcclusion) {
      serverConfig.setOcclusionEnabled(false);
    }
  }

  /**
   * Start the daemon
   */
  async start(): Promise<void> {
    await this.host.startOn(this.processStartHost());
  }

  /**
   * `start()` with the steps that touch the machine supplied by `host` (#11441). The rest of the
   * start sequence runs here in its own order: the tool-call-end subscription, database bring-up,
   * journal adoption, device discovery, session rehydration and the heartbeat monitor. A test
   * harness passes in-memory steps, so its daemon is wired by this code and not by a copy of it.
   */
  async startOn(host: DaemonStartHost): Promise<void> {
    this.host.setStartHost(host);
    // A previous start attempt cannot authorize a failed process entry on this attempt.
    this.host.setEnteredDaemonProcess(false);
    try {
      await this.startUntilReady();
      this.host.resolveStartupCompletion()();
    } catch (error) {
      this.host.lifecycle.selfExitRecorder().record("startup-failure");
      this.host.rejectStartupCompletion()(error);
      throw error;
    }
  }

  async startUntilReady(): Promise<void> {
    await this.host.startThroughSocketBind();
    try {
      await this.host.startAfterSocketBind();
    } catch (error) {
      // Past the bind this process owns rehydrated sessions, forward leases and
      // children; exiting straight from main().catch would skip their release and
      // the daemon-shutdown broadcast (#11156). Tear down (bounded) first.
      logger.error(`Daemon startup failed after the socket bind; stopping: ${errorMessage(error)}`);
      // Release HTTP MCP requests held on startup before the stop awaits the HTTP
      // server close, which waits for those in-flight requests (#11189).
      this.host.rejectStartupCompletion()(error);
      await this.host.stopAfterFailedStartup();
      throw error;
    }
  }

  async stopAfterFailedStartup(): Promise<void> {
    if (this.host.lifecycle.shutdownInProgress()) {
      // A signal-driven stop already owns teardown.
      return;
    }
    const timedOut = Symbol("post-bind startup failure stop timeout");
    try {
      await raceWithDeadline(() => this.host.stop(), {
        timer: this.host.services.timer(),
        timeoutMs: PROCESS_SHUTDOWN_TIMEOUT_MS,
        label: "Post-bind startup failure stop",
        timeoutError: () => timedOut,
      });
    } catch (stopError) {
      // The startup failure is the actionable error the caller rethrows; a stop
      // failure or overrun here is diagnostic only.
      logger.warn(
        stopError === timedOut
          ? `Stopping after a failed startup exceeded ${PROCESS_SHUTDOWN_TIMEOUT_MS}ms`
          : `Stopping after a failed startup failed: ${errorMessage(stopError)}`,
        stopError,
      );
    }
  }

  /** The process's own {@link DaemonStartHost}: the steps `start()` has always run. */
  processStartHost(): DaemonStartHost {
    return {
      writeExitRecord: (record) =>
        writeDaemonExitRecord(SOCKET_PATH, record, this.host.exitRecordFileSystem()),
      enterProcess: () => this.host.enterDaemonProcess(),
      publishForwardLeaseOwner: () => {
        // Record our socket in every CtrlProxy forwarding lease we take, so another
        // AutoMobile process can ask whether we still use the device (#10497).
        setCtrlProxyForwardLeaseOwnerSocketPath(SOCKET_PATH);
      },
      writeEarlyOwnerRecord: () => this.host.writeEarlyOwnerRecord(),
      openTerminalReleaseJournal: (owner) => createDaemonTerminalReleaseJournal(owner),
      prepareHttpToken: () => this.host.prepareHttpToken(),
      publishHttpToken: () => this.host.publishHttpToken(),
      startHttpIngress: () => this.host.startHttpIngress(),
      sweepStaleAppearanceConfigs: async (rehydration) => {
        await sweepStaleAppearanceConfigs(rehydration, this.host.services.sessionManager(), {
          liveDaemonSessionIds: this.startupLiveDaemonSessionIds,
          ownDaemonSessionId: this.host.identity.daemonSessionId(),
          getPersistedSession: (sessionUuid) => this.host.readPersistedSession(sessionUuid),
        });
      },
      redriveRecorderTeardowns: async () => {
        try {
          const state = await this.host.initializeRecordingTeardownRedriveState();
          const backend = new HybridVideoCaptureBackend();
          return await this.host.redriveUnconfirmedCaptureTeardowns(
            this.host.services.sessionManager(),
            {
              recordingRepository: state.recordingRepository,
              liveDaemonSessionIds: new Set(
                [...state.liveDaemonSessionIds].filter(
                  (id) => id !== this.host.identity.daemonSessionId(),
                ),
              ),
              ownedCaptureIds: () => state.videoRecorderService.listActiveRecordingIds(),
              onStartupOrphans: this.host.setStartupOrphanCaptures,
              onDeviceProcessStarted: (listener) =>
                this.host.services.devicePool().setDeviceProcessStartedListener(listener),
              onDeviceIncarnationAssigned: (listener) => {
                this.host.lifecycle.setRecorderDeviceIncarnationListener(listener);
              },
              getDeviceIncarnation: (id) =>
                this.host.services.devicePool().getDeviceIncarnation(id),
              getDevice: (id) => {
                const device = this.host.services.devicePool().getDevice(id);
                return device
                  ? { deviceId: device.id, name: device.name, platform: device.platform }
                  : undefined;
              },
              forceStopOrphanedCapture: (device, descriptor, options) =>
                options
                  ? backend.forceStopOrphanedCapture(device, descriptor, options)
                  : backend.forceStopOrphanedCapture(device, descriptor),
              now: () => this.host.services.timer().now(),
              timer: this.host.services.timer(),
            },
          );
        } catch (error) {
          logger.warn(
            "[Daemon] Recorder teardown initialization failed; continuing startup",
            error,
          );
          return false;
        }
      },
      bindControlSocket: () => this.host.bindControlSocket(),
      startServicesAfterSocketBind: () => this.host.startServicesAfterSocketBind(),
      startMaintenanceMonitors: () => this.host.startMaintenanceMonitors(),
    };
  }

  enterDaemonProcess(): void {
    setLogContextProvider(currentMcpTrace);
    // Mirror structured daemon logs to stdout/stderr capture as well. The
    // primary stable log is `<configured log dir>/daemon.log` (defaulting to
    // `<auto-mobile data dir>/logs/daemon.log`); the daemon manager also
    // redirects stdout/stderr to a per-start capture file in that same dir.
    logger.enableStdoutLogging();
    const stableWorkingDirectory = resolveStableDaemonWorkingDirectory();
    process.env[DAEMON_LAUNCH_CWD_ENV] ??= safeProcessCwd(stableWorkingDirectory);
    // Keep simctl and direct TCC reads on the same device set after chdir (issue #6582).
    normalizeCoreSimulatorDeviceSetPathEnv();
    process.chdir(stableWorkingDirectory);

    logger.info("Starting AutoMobile daemon...");
    this.host.setupShutdownHandlers();
  }

  async startThroughSocketBind(): Promise<void> {
    this.host.startHost().enterProcess();
    this.host.setEnteredDaemonProcess(true);
    // Subscribe here, not in the constructor: only a started daemon is ever stopped, so a
    // constructed-but-never-started daemon must not leave a listener on the global tracker (#10712).
    this.host.subscribeToolCallEndActivity();
    this.host.startHost().publishForwardLeaseOwner();

    // Publish the owned DB path in the PID file BEFORE opening the DB so the
    // direct-mode DB-ownership guard can tell a same-file collision from an
    // isolated-path launch during our own multi-second startup window, instead
    // of failing closed on an unknown path. The ordering lives behind
    // runStartupPrologue() so it can be asserted with fakes (issue #2871).
    // The early-owner overwrite (issue #2871) inside runStartupPrologue() clobbers
    // any live incumbent's PID record BEFORE we own anything, and cannot be
    // deferred (the DB-ownership guard needs the owned path published first). So
    // every step from that overwrite until a committed socket bind runs under a
    // single restoration path: any failure in the interval — DB init, HTTP bind,
    // device discovery, iOS services, OR the socket bind itself — leaves the
    // shared PID file naming this about-to-exit contender, and because
    // `socketBindCommitted` stays false exit cleanup is (correctly) suppressed and
    // will not repair it. Restoring the captured live incumbent here keeps
    // status()/`--daemon stop` pointed at the real winner (issue #6232; the
    // socket-bind step was only one point in this interval).
    try {
      await startupBenchmark.runPhase("daemonDatabaseInitialization", () =>
        runStartupPrologue({
          writeEarlyOwnerRecord: () => this.host.startHost().writeEarlyOwnerRecord(),
          initializeDatabase: () => this.host.initializeDatabase(),
        }),
      );

      // Adopt terminal releases a crashed predecessor never persisted (#10959) before any
      // listener can admit a session; startup rehydration writes their rows.
      this.host.services.sessionManager().attachTerminalReleaseJournal(
        this.host.startHost().openTerminalReleaseJournal({
          daemonSessionId: this.host.identity.daemonSessionId(),
          liveDaemonSessionIds: this.startupLiveDaemonSessionIds,
        }),
      );

      // Broker recovery needs the upgraded schema before admitting any sessions.
      if (this.host.lifecycle.sessionBrokerConfigPath() !== undefined) {
        await prepareBindingRegistryForStartup({
          brokerConfigured: true,
          registryExists: bindingRegistryFileExists(),
          open: () => this.host.openBindingRegistry(),
        });
      } else if (bindingRegistryFileExists()) {
        void this.host.openBindingRegistry(undefined, { quiet: true }).catch((error: unknown) => {
          // Pending schemas retry after bind; claim files decide until the registry can be read.
          logger.warn(
            `[Daemon] Recovery registry open deferred; will retry after socket bind: ${errorMessage(error)}`,
            error,
          );
        });
      }

      this.host.services.sessionManager().assertDaemonCollaboratorsAttached();
      this.host.startHost().prepareHttpToken();
      await this.host.startHost().startHttpIngress();

      // Initialize the device pool BEFORE the socket server so connecting clients see it.
      // Wait up to 5 seconds - emulators should already be running
      logger.info("Initializing device pool...");
      startupBenchmark.startPhase("deviceDiscovery");
      await this.host.initializeDevicePoolWithTimeout(5000);
      startupBenchmark.endPhase("deviceDiscovery");

      try {
        const rehydration = await startupBenchmark.runPhase("sessionRehydration", () =>
          this.host.services
            .sessionManager()
            .rehydratePersistedSessions(this.host.services.devicePool()),
        );
        await this.host.reownRehydratedManagedExecutions(rehydration.rehydrated);
        await this.host.startHost().sweepStaleAppearanceConfigs(rehydration);
      } catch (error) {
        logger.warn(`[Daemon] Session rehydration failed; continuing startup: ${error}`);
      }

      // A session-only provider resolves prior ownership before exposing its socket or warming
      // runners for sessions that recovery will abandon.
      this.sessionBrokerRecovery = await this.host.installSessionBroker();

      // Rehydrated sessions are now owned here and can safely warm their runners.
      await startupBenchmark.runPhase("iosServices", () => this.host.initializeIosServices());

      await this.host.startHost().redriveRecorderTeardowns();

      // Start Unix socket server AFTER device pool is ready
      this.host.lifecycle.setSocketServer(await this.host.startHost().bindControlSocket());
      // We now hold the socket bind. Only past this point may this process's exit /
      // shutdown cleanup delete the shared socket/PID files: before it, the early
      // owner record (issue #2871) makes the `expectedPid` self-check pass even
      // though we do not own the socket, so a lock-less contender refused over a
      // live sibling (issue #6232) must NOT clean up on exit and brick the winner
      // (the #6140 failure mode via a bypassed launch). This authorizes cleanup
      // of the control socket and PID file; each aux bind is tracked separately.
      this.host.identity.setSocketBindCommitted(true);
      // Discovery publishes credentials only after authoritative control-socket ownership.
      this.host.startHost().publishHttpToken();
      startupBenchmark.endPhase("socketServerStart");
    } catch (error) {
      // Restore the live incumbent's record on any pre-bind failure in the
      // interval above (issue #6232). Guarded on the committed flag so a throw
      // after the bind is committed never rewrites the file this process now owns.
      if (!this.host.identity.socketBindCommitted()) {
        this.host.restoreIncumbentOwnerRecord();
      }
      throw error;
    }
    logger.info("Unix socket server started");
    if (!this.host.lifecycle.sessionBrokerConfigPath() && bindingRegistryFileExists()) {
      this.host.startBackgroundRegistryUpgrade();
    }
  }

  async startHttpIngress(): Promise<void> {
    this.warmAndroidAvdProvenanceCache();
    // iOS device-type profiles are memoized per SimCtlClient and populated inline
    // during its simulator inventory; there is no process-wide profile cache to warm.

    // Find an available port. In strict-port mode (issue #6260, restart's
    // atomic guard) we deliberately skip findAvailablePort()'s probe-then-
    // release preflight and its in-range port fallback: that preflight releases
    // its probe socket before this process actually binds, leaving a window
    // for a competitor to claim the canonical port and for the fallback to
    // paper over it with a "successful" restart on the wrong port. Leaving
    // `this.port` as the requested port makes the real `listen()` call below
    // (in DaemonHttpIngress.start) the single atomic bind-or-fail attempt.
    if (!this.host.strictPort()) {
      this.host.identity.setPort(await this.findAvailablePort(this.host.identity.port()));
    }

    // Start HTTP MCP server
    startupBenchmark.startPhase("httpServerStart");
    await this.host.services.httpIngress().start();
    startupBenchmark.endPhase("httpServerStart");
  }

  /** Create the control socket server over this daemon's state and bind it. */
  async bindControlSocket(): Promise<DaemonSocketServer> {
    logger.info(`Daemon host: "${this.host.host()}", port: ${this.host.identity.port()}`);
    logger.info(`MCP_STREAMABLE_PATH: "${MCP_STREAMABLE_PATH}"`);
    logger.info(`Creating UnixSocketServer at "${SOCKET_PATH}"`);
    this.host.lifecycle.setSocketServer(
      new UnixSocketServer(
        SOCKET_PATH,
        undefined,
        undefined,
        FeatureFlagService.getInstance(),
        {
          identityStartedAt: this.host.identity.generationStartedAt(),
          processGenerationToken: this.host.identity.processGenerationToken(),
          startupOptions: this.host.services.options(),
          onRepublishIdentity: () => this.host.republishIdentity(),
          startupCompletion: this.host.lifecycle.startupCompletion(),
          pidFilePath: PID_FILE_PATH,
          sockets: getDaemonSocketPathsByName(),
          dbPath: getDatabasePath(),
          processStartedAt: this.host.identity.processStartedAt(),
          onRestartAccepted: () => {
            setImmediate(() => process.kill(process.pid, "SIGTERM"));
          },
          liveAcceptanceStartupSecret: this.host.identity.liveAcceptanceStartupSecret(),
          acceptanceDiscoveryCapability: this.host.identity.acceptanceDiscoveryCapability(),
          mcpDispatcher: this.host.services.mcpDispatcher(),
          clearConnectionDevicePin: (id) =>
            this.host.services.deviceReadiness().clearConnectionDevicePin(id),
        },
        this.host.services.idGenerator(),
        // A hand-launched daemon (no startup lock) must refuse to unlink a live
        // sibling's socket; only a manager-launched, lock-protected daemon may
        // reclaim it (issue #6232). The owner-liveness check reads the CAPTURED
        // incumbent snapshot, not the PID file we already overwrote above, so an
        // inconclusive probe still sees the live sibling.
        {
          ownerLiveness: this.host.identity.incumbentOwnerGuard().asSocketOwnerLiveness(),
        },
      ),
    );
    logger.info("Starting Unix socket server...");
    startupBenchmark.startPhase("socketServerStart");
    await this.host.lifecycle.socketServer()!.start();
    this.host.recordControlSocketIdentity();
    return this.host.lifecycle.socketServer()!;
  }

  async startServicesAfterSocketBind(): Promise<void> {
    startupBenchmark.startPhase("auxiliarySocketServerStart");
    await this.host.startAuxiliarySocket("video-recording", startVideoRecordingSocketServer);
    await this.host.startAuxiliarySocket("device-gesture-recording", () =>
      startDeviceGestureRecordingSocketServer(this.host.services.deviceReadiness()),
    );
    await this.host.startAuxiliarySocket("device-snapshot", startDeviceSnapshotSocketServer);
    await this.host.startAuxiliarySocket("appearance", startAppearanceSocketServer);
    await this.host.startAuxiliarySocket("performance-stream", startPerformanceStreamSocketServer);
    await this.host.startAuxiliarySocket("observation-stream", () =>
      startDeviceDataStreamSocketServer(this.host.services.timer()),
    );
    this.host.configureDeviceDataStreamServer();
    await this.host.startAuxiliarySocket("performance-push", startPerformancePushSocketServer);
    this.host.setupDeviceSessionRouting();
    await this.host.startAuxiliarySocket("failures-stream", startFailuresStreamSocketServer);
    await this.host.startAuxiliarySocket("failures-push", startFailuresPushSocketServer);
    this.host.setupDeviceSessionRouting();
    await this.host.startAuxiliarySocket("telemetry-push", startTelemetryPushSocketServer);
    this.host.setupDeviceSessionRouting();
    await this.host.startAuxiliarySocket("webrtc-stream", startWebRtcStreamSocketServer);
    await this.host.startAuxiliarySocket("video-stream", () =>
      startVideoStreamSocketServer(this.host.services.deviceReadiness()),
    );
    startupBenchmark.endPhase("auxiliarySocketServerStart");

    startAppearanceSyncScheduler({
      getTargets: () => this.host.getAppearanceSyncTargets(),
      isEnabled: () => this.host.services.passiveWorkPolicy().isAppearanceSyncEnabled(),
      // A sync-driven night-mode change is reset for the next owner like a tool's (#11145).
      beforeApply: (device) => recordDeviceSettingDefaultsBeforeChange(device, ["nightMode"]),
    });
    startPerformanceMonitor();
    this.host.startAdbMissingDeviceListener();
    this.host.startDeviceDisconnectMonitor();

    // Write PID file
    await this.host.writePidFile();
    this.host.identity.setCompleteIdentityPublished(true);

    // Verify DaemonState is initialized
    logger.info(
      `DaemonState initialized: ${this.host.services.daemonState().isInitialized()}, device count: ${this.host.services.devicePool().getTotalDeviceCount()}`,
    );

    // Start health check timer (every 30 seconds)
    this.host.startHealthCheckTimer();
  }

  startMaintenanceMonitors(): void {
    this.host.startNavigationRetentionMonitor();
    this.host.startForwardLeaseIdleReleaser();
    this.host.startPrivateDaemonOrphanWatchdog();
  }

  async startAfterSocketBind(): Promise<void> {
    // Native broker cleanup must never hold up the control socket becoming reachable.
    this.sessionBrokerRecovery?.start();
    await this.host.startHost().startServicesAfterSocketBind();
    this.host.startHeartbeatMonitor();
    this.host.startHost().startMaintenanceMonitors();

    startupBenchmark.emit("daemon", {
      host: this.host.host(),
      port: this.host.identity.port(),
      socketPath: SOCKET_PATH,
      deviceCount: this.host.services.devicePool().getTotalDeviceCount(),
      mcpHttpListenerBound: this.host.services.httpIngress().server?.listening ?? false,
      daemonSocketListenerBound: this.host.lifecycle.socketServer()?.isListening() ?? false,
    });

    logger.info(
      `Daemon started: PID ${process.pid}, socket ${SOCKET_PATH}, HTTP port ${this.host.identity.port()}`,
    );

    // Startup fully succeeded — DB brought up AND every startup DB-backed step
    // completed. Only now clear the crash-loop circuit breaker, so a permanent
    // failure in any later startup step (recorded before its fatal exit) isn't
    // erased by a preflight that merely got past migrations (issue #2784).
    this.host.startupFailureTracker().reset();
  }

  /**
   * Warm the process-wide Android AVD provenance cache at daemon startup so it
   * is populated, or at least in flight, before a client's first acquisition.
   * The acquisition response path remains a synchronous cache-only read and
   * never waits on or fails because of this best-effort scan.
   */
  warmAndroidAvdProvenanceCache(): void {
    this.androidAvdProvenanceWarmPromise = Promise.resolve()
      .then(() =>
        AndroidAvdProvenanceCache.getInstance().getByName(
          this.host.avdManagerFactory()(),
          this.host.services.timer(),
        ),
      )
      .catch((error: unknown) => {
        // Best-effort enrichment is optional, so SDK/factory failures are safe to swallow.
        logger.debug(`Android AVD provenance startup warm failed: ${errorMessage(error)}`);
      });
  }

  /**
   * Find an available port in the configured range
   */
  private async findAvailablePort(preferredPort: number): Promise<number> {
    return findAvailableDaemonPort(preferredPort, (port) => this.isPortAvailable(port));
  }

  /**
   * Check if a port is available
   */
  async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const testServer = createHttpServer();
      let resolved = false;

      // Timeout safety - prevent hanging forever
      const timeout = defaultTimer.setTimeout(() => {
        if (!resolved) {
          resolved = true;
          testServer.close(() => {
            // Ignore error in close
          });
          resolve(false); // Assume port is unavailable if timeout
        }
      }, 1000); // 1s timeout per port check

      testServer.once("error", () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(false);
        }
      });

      testServer.listen(port, this.host.host(), () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          testServer.close(() => {
            resolve(true);
          });
        }
      });
    });
  }

  /**
   * Initialize device pool with timeout
   * Waits for device discovery with configurable timeout
   *
   * Public so tests can exercise startup discovery directly.
   */
  async initializeDevicePoolWithTimeout(timeoutMs: number): Promise<void> {
    const timedOut = Symbol("device pool initialization timeout");
    try {
      await raceWithDeadline(() => this.host.initializeDevicePool(), {
        timer: this.host.services.timer(),
        timeoutMs,
        unref: true,
        label: "Device pool initialization",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      logger.warn(`Device pool initialization timed out after ${timeoutMs}ms`);
    }

    // Log final device pool status
    const deviceCount = this.host.services.devicePool().getTotalDeviceCount();
    if (deviceCount === 0) {
      logger.warn("Device pool is empty after initialization.");
      logger.warn("Tests will fail until devices are available.");
      logger.warn("Start an emulator or connect a physical device, then restart the daemon.");
    } else {
      logger.info(`Device pool ready with ${deviceCount} device(s)`);
    }
  }

  /**
   * Initialize device pool with discovered devices
   *
   * Public so tests can exercise startup discovery directly.
   */
  async initializeDevicePool(): Promise<void> {
    try {
      // Use the pool's refresh path instead of replacing entries directly. The
      // startup timeout does not cancel discovery, so this may run after a
      // session has claimed a device; refresh preserves that owner and its
      // incarnation when rediscovering the same device.
      const outcome = await this.host.services.devicePool().refreshDevicesWithOutcome();
      const bootedDevices = this.host.services.devicePool().getAllDevices();

      if (bootedDevices.length > 0) {
        // Mint a device-session epoch for every startup-booted device so
        // daemon/listDeviceSessions enumerates idle devices immediately, without
        // waiting for a first assignment/refresh. The refresh callback may have
        // minted these already; this is idempotent because the incarnation is
        // unchanged (epic #5256).
        // The device-session wire is Android and iOS; watches get no epoch yet (#14908).
        const sessionDevices = this.host.services
          .devicePool()
          .getAllDevices()
          .filter((pooled) => isAndroidOrIosPlatform(pooled.platform));
        for (const pooled of sessionDevices) {
          this.host.services.deviceSessionRegistry().onDeviceConnected({
            deviceId: pooled.id,
            platform: pooled.platform,
            incarnation: pooled.incarnation,
          });
        }
        logger.info(
          `Device pool initialized with ${bootedDevices.length} devices: ${bootedDevices.map((device) => device.id).join(", ")}`,
        );
      } else if (outcome.failure === undefined) {
        // Failed refreshes already log their reason at warn in DevicePoolRefresh.
        logger.warn("No devices detected during daemon startup. Device pool is empty.");
        logger.warn("Start an emulator or connect a physical device before creating sessions.");
      }
    } catch (error) {
      logger.error(`Failed to initialize device pool: ${error}`);
      // Continue daemon startup even if device discovery fails
      // Tools will handle "no devices" errors when sessions are created
    }
  }

  /**
   * Initialize iOS CtrlProxy iOS connections for discovered iOS devices
   * This establishes WebSocket connections early so first observe calls are fast
   *
   * Public so tests can exercise startup directly.
   */
  async initializeIosServices(): Promise<void> {
    // A live-acceptance daemon discovers a controlled target before it performs
    // any device mutation. Warming every already-booted simulator here would
    // launch CtrlProxy on unrelated devices before that authenticated selection.
    // The later, explicit acquisition path still initializes its chosen target.
    if (!this.host.services.passiveWorkPolicy().isIosPassiveWorkEnabled()) {
      logger.info("[Daemon] Skipping iOS CtrlProxy warm-up for live acceptance");
      return;
    }
    const iosDevices = selectIosStartupWarmupDevices(
      this.host.services.devicePool().getAllDevices(),
      this.host.services.passiveWorkPolicy(),
      (deviceId) => {
        const holder = this.host.services.sessionManager().getSessionForDevice(deviceId);
        return (
          holder !== null &&
          this.host.lifecycle.managedExecutionReowner()?.ownershipState(holder) !== undefined
        );
      },
    );
    if (iosDevices.length === 0) {
      logger.debug("[Daemon] No iOS devices to initialize CtrlProxy iOS for");
      return;
    }

    logger.info(`[Daemon] Initializing CtrlProxy iOS for ${iosDevices.length} iOS device(s)...`);
    const deviceReadiness = this.host.services.iosDeviceVerifier()();

    await initializeIosCtrlProxyAtStartup(
      iosDevices.map((device) => device.id),
      {
        timer: this.host.services.timer(),
        // Per-device timeout to prevent hanging on unresponsive devices
        perDeviceTimeoutMs: 5000,
        pendingPrefetch: () => IosCtrlProxyBuilder.pendingPrefetch(),
        isShuttingDown: () => this.host.lifecycle.shutdownInProgress(),
        verifyIosDevice: (deviceId, options) => deviceReadiness.verifyIosDevice(deviceId, options),
      },
    );
  }

  /**
   * Bring the database to a query-ready state. Startup DB/migration failure is
   * FATAL (issue #2784): this method rethrows so `start()` rejects → `main().catch`
   * → `process.exit(1)`, letting the process manager restart a clean daemon
   * instead of leaving a query-dead daemon that reports healthy.
   *
   * To avoid a restart hot-loop when a *permanent* failure keeps reproducing
   * (corrupt DB, deterministic migration throw), repeated permanent failures are
   * throttled with an exponential backoff before the fatal rethrow. Transient
   * failures (locked file, temporary disk-full) exit fast so the next launch can
   * retry immediately.
   */
  async initializeDatabase(): Promise<void> {
    try {
      // getDatabase() + await ensureMigrations(): a failed startup migration
      // rejects here (rather than swallowing on a detached promise).
      await this.host.databaseInitializer().initialize();
      // Reload durable tool-selection-profile provenance (issue #6225) so a
      // profile minted before this restart/upgrade is still recognized when a
      // client reaffirms it — without this, `setToolEnabled` would force it
      // through a re-mint. Never fatal: the loader already logs and swallows
      // its own failures (see PersistentToolSelectionProfileRegistry), leaving
      // the registry empty (the pre-#6225 behavior) rather than blocking the
      // FATAL database bring-up this method guards.
      await this.host.toolSelectionProfileProvenanceLoader().load();
      // A discovery failure is intentionally startup-fatal through this method's
      // catch: treating it as an empty live set would let this daemon steal a
      // live peer's sessions, which is less safe than refusing startup.
      const liveDaemonSessionIds = new Set(
        this.host.identity
          .incumbentOwnerGuard()
          .withLiveIncumbent(this.host.liveDaemonSessionIdProvider().collectLiveDaemonSessionIds()),
      );
      this.startupLiveDaemonSessionIds = liveDaemonSessionIds;
      // Clear installed apps cache from previous daemon sessions, keeping a live
      // peer's rows (issue #11158) — hence after the live set is computed.
      await this.host.services
        .installedAppsRepository()
        .clearOldDaemonSessions(this.host.identity.daemonSessionId(), liveDaemonSessionIds);
      await this.host.services.deviceSessionRepository().markStaleActiveSessionsExpired(
        this.host.identity.daemonSessionId(),
        // Persisted stamps are wall epoch ms, shared by every process (#11162).
        this.host.services.timer().now(),
        "daemon-restart",
        liveDaemonSessionIds,
      );
      await this.host.setVideoRecordingManagerDependencies({
        liveDaemonSessionIds,
        daemonSessionId: this.host.identity.daemonSessionId(),
      });
      logger.info(
        `[Daemon] Cleared old daemon session caches, current session: ${this.host.identity.daemonSessionId()}`,
      );
    } catch (error) {
      // Delegate to the shared startup guard so this path and the earlier
      // feature-flag DB touch (guarded in main() before start()) funnel through
      // the identical classify/record/backoff/rethrow circuit breaker.
      await handleFatalDatabaseStartupFailure(
        error,
        this.host.startupFailureTracker(),
        this.host.services.timer(),
      );
    }
  }

  get testHooks() {
    return {
      resolveStartupCompletion: (): void => this.host.resolveStartupCompletion()(),
      rejectStartupCompletion: (reason: unknown): void =>
        this.host.rejectStartupCompletion()(reason),
      startUntilReady: (): Promise<void> => this.startUntilReady(),
      daemonSessionId: (): string => this.host.identity.daemonSessionId(),
      options: (): DaemonOptions => this.host.services.options(),
      port: (): number => this.host.identity.port(),
      processStartHost: (): DaemonStartHost => this.processStartHost(),
      setStartHost: (host: DaemonStartHost): void => {
        this.host.setStartHost(host);
      },
      warmAndroidAvdProvenanceCache: (): void => this.warmAndroidAvdProvenanceCache(),
      androidAvdProvenanceWarmPromise: (): Promise<unknown> | undefined =>
        this.androidAvdProvenanceWarmPromise,
      startThroughSocketBind: (): Promise<void> => this.host.startThroughSocketBind(),
    } as const;
  }
}

export function applyDaemonToolOutputOptions(
  options: DaemonOptions,
  runtimeOptions: DaemonOptions,
): void {
  if (options.observeResultIncludeElements) {
    serverConfig.setObserveResultIncludeElementsEnabled(true);
  }
  if (options.toolResultsNoStructuredContent) {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
  }
  if (options.actionsDiffObserve) {
    serverConfig.setActionsDiffObserveEnabled(true);
  }
  if (options.actionsCompactMetadata !== undefined) {
    serverConfig.setActionsCompactMetadataEnabled(options.actionsCompactMetadata);
  }
  // Status/PID records must describe effective behavior, including persisted opt-outs.
  runtimeOptions.actionsCompactMetadata = serverConfig.isActionsCompactMetadataEnabled();
  if (options.actionsNoObserve) {
    serverConfig.setActionsNoObserveEnabled(true);
  }
  if (options.toolOutputsDir) {
    serverConfig.setToolOutputsDir(options.toolOutputsDir);
  }
}
