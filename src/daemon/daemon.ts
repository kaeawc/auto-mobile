import { registerPrototypeDaemonPort } from "../features/prototype/prototypeDaemonPorts";
import { daemonToolRegistry } from "./toolRegistryPort";
import {} from "./networkStateSessionCleanup";
import {} from "./recordingSessionCleanup";
import {} from "./observationRequestBatch";
import { installDefaultProvisionedDeviceTransportFence } from "../db/createDefaultProvisionedDeviceTransportFence";
import { ObserverSessionRegistry } from "./observerSessionRegistry";
import { NodeStreamableHTTPServerTransport as StreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createProductionCoreDeviceProbe } from "../utils/ios-cmdline-tools/CoreDeviceProbeHolder";
import { createIosDoctorDependencies } from "../doctor/checks/ios";
import { logger } from "../utils/logger";
import { type DaemonSocketServer, daemonSocketServerDouble } from "./daemonSocketServer";
import { SessionManager } from "./sessionManager";
import { type HealthFailureKind } from "./daemonHealthCheck";
import { PassiveWorkPolicy, parsePassiveWorkSettings } from "./PassiveWorkPolicy";
import { DevicePool } from "./devicePool";
import { createForeignCtrlProxyForwardEvidence } from "../features/observe/android/foreignCtrlProxyForwardEvidence";
import { type SqliteBindingRegistry } from "./sessionBroker/registry/sqliteBindingRegistry";
import { ENV, readEnvRaw } from "../config/env";
import { DeviceSessionRegistry } from "./deviceSessionRegistry";
import { DEFAULT_DAEMON_PORT } from "./wire/constants";
import { DaemonOptions } from "./types";
import {
  DaemonSelfExitRecorder,
  defaultDaemonExitRecordFileSystem,
  type DaemonExitRecordFileSystem,
} from "./daemonExitRecord";
import { daemonProcessOptions } from "./daemonOptionScopes";
import { resolve } from "node:path";
import { getCurrentBuildIdentity } from "./wire/buildIdentity";
import { IncumbentOwnerGuard } from "./incumbentOwnerGuard";
import {
  DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV,
  daemonLiveAcceptanceStartupSecret,
} from "./liveAcceptanceCapability";
import { executionTracker } from "./executionTracker";
import {
  createDeviceStateChangeNotifier,
  type DeviceStateChangeNotifier,
} from "./deviceStateChangeNotifier";
import {
  notifyBootedDeviceResourcesUpdated,
  resetBootedDevicesResourceCache,
} from "./deviceResourceInvalidation";
import { getDeviceDataStreamServer } from "./deviceDataStreamSocketServer";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import { NavigationGraphStreamBridge } from "./daemonStreamRouting";
import { InstalledAppsRepository, type InstalledAppsStore } from "../db/installedAppsRepository";
import { DeviceReadiness } from "./readiness/DeviceReadiness";
import { type AppearanceSyncTarget } from "./AppearanceSyncScheduler";
import { Timer } from "../utils/SystemTimer";
import { IdGenerator } from "../utils/IdGenerator";
import { DeviceLossState } from "./deviceLossState";
import { DaemonShutdownState } from "./daemonShutdownState";
import { DaemonRuntimeState } from "./daemonRuntimeState";
import { errorMessage } from "../utils/describeUnknownError";
import { type ObservationStreamHealth } from "./ObservationStreamHealth";
import {
  resolveDaemonDependencies,
  type DaemonDependencies,
  type DaemonDeviceSessionStore,
} from "./daemonDependencies";
import { DaemonHttpTokenLifecycle } from "./daemonCore/DaemonHttpTokenLifecycle";
import {
  createStartupCompletion,
  type DaemonDatabaseServices,
  type DaemonInjectedServices,
  type DaemonListenConfig,
  type DaemonProcessIdentity,
  type DaemonStartupCompletion,
} from "./daemonCore/daemonFieldGroups";
import type { DaemonStateWrites } from "./daemonContext";
import { DaemonBroker } from "./daemonCore/DaemonBroker";
import { DaemonSessions } from "./daemonCore/DaemonSessions";
import { DaemonStartup, applyDaemonToolOutputOptions } from "./daemonCore/DaemonStartup";
import { DaemonIdentity } from "./daemonCore/DaemonIdentity";
import { DaemonStreams, type DeviceSessionRoutingTargets } from "./daemonCore/DaemonStreams";
import { DaemonMaintenance } from "./daemonCore/DaemonMaintenance";
import { DaemonDisconnect } from "./daemonCore/DaemonDisconnect";
import { DaemonShutdown } from "./daemonCore/DaemonShutdown";
import type {
  DaemonCoreServices,
  DaemonIdentityState,
  DaemonLifecycleState,
} from "./daemonCore/DaemonCoreState";
import {
  createDatabaseHealthFailureRecovery,
  createObservationStreamHealth,
} from "./daemonCore/daemonHealthServices";
import {
  createDaemonObserverSessionRegistry,
  daemonDeviceRecoveryConfiguration,
} from "./daemonCore/daemonSessionServices";
import { DaemonMcpServices } from "./daemonCore/DaemonMcpServices";
import { defaultDaemonRecordingHost, type DaemonStartHost } from "./daemonStartHost";
export type { DaemonStartHost } from "./daemonStartHost";

export { findAvailableDaemonPort } from "./daemonPort";
import {
  captureDisconnectCleanup,
  isCapturedDisconnectTargetCurrent,
} from "./daemonCore/disconnectTargets";
export {
  getProcessWideAdbServerResetCohort,
  isProcessWideAdbServerReset,
} from "./daemonCore/disconnectTargets";
import { warmConfirmedManagedExecution } from "./daemonCore/managedExecutionWarmup";
import { persistedSessionReaders } from "./daemonCore/persistedSessionReaders";

export type { DaemonDependencies };

export class Daemon {
  private readonly httpToken: DaemonHttpTokenLifecycle;
  private stoppingRecordings: Set<string> = new Set();
  private readonly broker: DaemonBroker;
  private sessionsCore: DaemonSessions | undefined;
  private get sessions(): DaemonSessions {
    return (this.sessionsCore ??= this.createDaemonSessions(
      this.createDaemonCoreServices(),
      this.createDaemonIdentityState(),
      this.createDaemonLifecycleState(),
    ));
  }
  private readonly startup: DaemonStartup;
  private readonly identity: DaemonIdentity;
  private readonly streams: DaemonStreams;
  private readonly maintenance: DaemonMaintenance;
  private disconnectCore: DaemonDisconnect | undefined;
  private get disconnect(): DaemonDisconnect {
    return (this.disconnectCore ??= this.createDaemonDisconnect(
      this.createDaemonCoreServices(),
      this.createDaemonLifecycleState(),
    ));
  }
  private readonly shutdown: DaemonShutdown;

  /** Replaceable seams resolved from `DaemonDependencies`; fixed at construction. */
  private readonly injected: DaemonInjectedServices;

  private readonly deviceReadiness: DeviceReadiness;

  // One probe lifetime shared by all MCP connections and daemon doctor calls.
  private readonly iosDoctorDependencies = createIosDoctorDependencies({
    coreDeviceProbe: createProductionCoreDeviceProbe(),
  });

  private exitRecordFileSystem: DaemonExitRecordFileSystem = defaultDaemonExitRecordFileSystem;

  private startHost!: DaemonStartHost;

  private readonly selfExitRecorder = new DaemonSelfExitRecorder({
    write: (record) => this.startHost.writeExitRecord(record),
    now: () => this.timer.now(),
    buildId: () => getCurrentBuildIdentity().buildId,
    options: () => ({ ...daemonProcessOptions(this.options), port: this.listen.port }),
    canRecord: () =>
      this.runtime.enteredDaemonProcess &&
      (this.runtime.socketBindCommitted || !this.incumbentOwnerGuard.hasLiveForeignOwner()),
  });

  private readonly startupCompletion: DaemonStartupCompletion = createStartupCompletion();

  private readonly mcpServices = new DaemonMcpServices({
    deviceReadiness: () => this.deviceReadiness,
    httpToken: () => this.httpToken,
    iosDoctorDependencies: this.iosDoctorDependencies,
    debug: () => this.listen.debug,
    acceptanceDiscoveryCapability: () => this.acceptanceDiscoveryCapability,
    httpServerFactory: () => this.injected.httpServerFactory(),
    timer: () => this.timer,
    idGenerator: () => this.idGenerator,
    address: () => ({ host: this.listen.host, port: this.listen.port }),
    strictPort: () => this.listen.strictPort,
    startupCompletion: () => this.startupCompletion.promise,
    sessionManager: () => this.sessionManager,
    observerSessionRegistry: () => this.observerSessionRegistry,
    isShutdownInProgress: () => this.shutdownState.inProgress,
  });

  private readonly httpIngress = this.mcpServices.httpIngress;
  private readonly mcpDispatcher = this.mcpServices.mcpDispatcher;

  private readonly listen: DaemonListenConfig;

  // Preserves a live incumbent daemon's PID record across our own early-owner
  // overwrite so the lock-less bind guard can (a) still see the live sibling on
  // an inconclusive probe and (b) restore its record if we refuse (issue #6232).
  private readonly incumbentOwnerGuard: IncumbentOwnerGuard;

  protected readonly deviceLoss = new DeviceLossState();

  private observerSessionRegistry: ObserverSessionRegistry;

  private sessionManager: SessionManager;

  private devicePool: DevicePool;

  private deviceSessionRegistry: DeviceSessionRegistry;

  private daemonSessionId: string;

  private installedAppsRepository: InstalledAppsStore;

  private deviceSessionRepository: DaemonDeviceSessionStore;

  private timer: Timer;

  private sessionBrokerConfigPath = readEnvRaw(ENV.SESSION_BROKER_CONFIG)
    ? resolve(readEnvRaw(ENV.SESSION_BROKER_CONFIG)!)
    : undefined;

  private readonly processIdentity: DaemonProcessIdentity;

  private readonly passiveWorkPolicy: PassiveWorkPolicy;

  private idGenerator: IdGenerator;

  private readonly database: DaemonDatabaseServices;

  private observationStreamHealth: ObservationStreamHealth;

  protected readonly navigationGraphBridge = new NavigationGraphStreamBridge({
    server: () => this.runtime.deviceDataStreamServer,
    sessionIds: () => this.sessionManager.getAllSessions().map((session) => session.sessionId),
    defaultManager: () => NavigationGraphManager.getInstance(),
    managerForSession: (sessionId) => NavigationGraphManager.getInstanceForSession(sessionId),
  });

  private readonly deviceStateChangeNotifier: DeviceStateChangeNotifier;

  private options: DaemonOptions;

  private readonly acceptanceDiscoveryCapability = readEnvRaw(ENV.ACCEPTANCE_DISCOVERY_CAPABILITY);

  private readonly shutdownState = new DaemonShutdownState();
  protected readonly runtime = new DaemonRuntimeState();

  private readonly daemonState: DaemonStateWrites;

  constructor(options: DaemonOptions = {}, dependencies: DaemonDependencies = {}) {
    const services = this.createDaemonCoreServices();
    const identity = this.createDaemonIdentityState();
    const lifecycle = this.createDaemonLifecycleState();
    this.broker = this.createDaemonBroker(services, identity, lifecycle);
    this.startup = this.createDaemonStartup(services, identity, lifecycle);
    this.identity = this.createDaemonIdentity(services, identity);
    this.streams = this.createDaemonStreams(services, lifecycle);
    this.maintenance = this.createDaemonMaintenance(services, identity, lifecycle);
    this.shutdown = this.createDaemonShutdown(services, lifecycle);

    const {
      timer,
      deviceSessionRepository,
      idGenerator,
      databaseInitializer,
      startupFailureTracker,
      databaseHealthProbe,
      recoveryPolicyEnvironment,
      managedAdbServerShutdown,
      toolSelectionProfileProvenanceLoader,
      processBirthTime,
      processGenerationToken,
      incumbentOwnerGuard,
      installedAppsRepository,
      recoverFromDatabaseHealthFailure,
      ...retained
    } = resolveDaemonDependencies(dependencies);
    this.deviceReadiness = retained.deviceReadiness;
    this.daemonState = retained.daemonState;
    this.httpToken = new DaemonHttpTokenLifecycle(
      retained.httpTokenStore,
      dependencies.idGenerator,
      retained.httpToken,
    );
    this.injected = {
      httpServerFactory: retained.httpServerFactory,
      liveDaemonSessionIdProvider: retained.liveDaemonSessionIdProvider,
      avdManagerFactory: retained.avdManagerFactory,
      iosDeviceVerifier: retained.iosDeviceVerifier,
      bindingExclusionFactory: retained.bindingExclusionFactory,
      foreignCtrlProxyForwardEvidence: retained.foreignCtrlProxyForwardEvidence,
      stopManagedAdbServer: managedAdbServerShutdown,
      hostIoStalled: retained.hostIoStalled,
    };
    installDefaultProvisionedDeviceTransportFence();
    // Startup can fail before the socket server exists or any request awaits it.
    void this.startupCompletion.promise.then(
      () => {
        this.httpIngress.markStartupCompleted();
      },
      (error: unknown) => {
        logger.debug(`Daemon startup completion rejected: ${errorMessage(error)}`);
      },
    );
    this.options = { ...options };
    // Prefer IPv4 loopback: Bun's fetch and Node's listen can disagree on "localhost" (::1 vs 127.0.0.1),
    // which surfaces as ConnectionRefused on the Unix-socket → Streamable HTTP MCP hop (common in Linux CI).
    this.listen = {
      port: options.port || DEFAULT_DAEMON_PORT,
      host: options.host || "127.0.0.1",
      strictPort: options.strictPort ?? false,
      debug: options.debug || false,
    };
    registerPrototypeDaemonPort(this.listen.port);
    this.idGenerator = idGenerator;
    this.daemonSessionId = this.idGenerator.next();
    this.timer = timer;
    this.deviceStateChangeNotifier = createDeviceStateChangeNotifier({
      timer,
      invalidate: resetBootedDevicesResourceCache,
      notify: notifyBootedDeviceResourcesUpdated,
    });
    this.processIdentity = {
      generationStartedAt: this.timer.now(),
      processStartedAt: processBirthTime(),
      processGenerationToken: processGenerationToken(),
      liveAcceptanceStartupSecret: daemonLiveAcceptanceStartupSecret(),
    };
    this.incumbentOwnerGuard = incumbentOwnerGuard;
    // Even a malformed acceptance secret must not cause unsolicited simulator
    // launches. Capability validation remains strict in liveAcceptanceCapability.
    this.passiveWorkPolicy = new PassiveWorkPolicy(
      parsePassiveWorkSettings(process.env, DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV),
      (deviceId) =>
        this.sessionManager.getAllSessions().some((session) => session.assignedDevice === deviceId),
    );
    this.database = {
      databaseInitializer,
      toolSelectionProfileProvenanceLoader,
      databaseHealthProbe,
      startupFailureTracker,
      recoverFromDatabaseHealthFailure:
        recoverFromDatabaseHealthFailure ??
        createDatabaseHealthFailureRecovery({
          timer: () => this.timer,
          selfExitRecorder: () => this.selfExitRecorder,
          getDaemonFileCleanupOptions: () => this.identity.getDaemonFileCleanupOptions(),
        }),
    };
    this.observationStreamHealth = createObservationStreamHealth({
      timer: () => this.timer,
      startAuxiliarySocket: (...args) => this.identity.startAuxiliarySocket(...args),
      configureDeviceDataStreamServer: () => this.streams.configureDeviceDataStreamServer(),
    });
    this.deviceSessionRepository = deviceSessionRepository;
    this.sessionManager = new SessionManager(this.timer, this.deviceSessionRepository);
    this.sessionManager.attachDaemonSessionId(this.daemonSessionId);
    // Read when a recovery claims its row, so a peer that started after this daemon is seen. A
    // restart incumbent whose pid file this daemon replaced is not listed, so it is added while
    // it is still live: its rows and its terminal-release journal are not a dead daemon's (#11355).
    this.sessionManager.attachLiveDaemonSessionIds(() =>
      this.incumbentOwnerGuard.withLiveIncumbent(
        this.injected.liveDaemonSessionIdProvider.collectLiveDaemonSessionIds(),
      ),
    );
    this.observerSessionRegistry = createDaemonObserverSessionRegistry(this.timer);
    this.sessions.configureSessionLifecycleCallbacks();
    this.installedAppsRepository = installedAppsRepository ?? new InstalledAppsRepository();
    const recoveryConfiguration = daemonDeviceRecoveryConfiguration(recoveryPolicyEnvironment);
    this.deviceSessionRegistry = new DeviceSessionRegistry(this.timer, this.idGenerator);
    this.devicePool = this.sessions.createDevicePool(
      recoveryConfiguration.policy,
      recoveryPolicyEnvironment,
    );
    executionTracker.setAutolockSessionResolver({
      autolockSessionForMcpSession: (mcpSessionId) =>
        this.devicePool.captureAutolockSessionForMcpSession(mcpSessionId),
    });
    this.daemonState.initialize(
      this.sessionManager,
      this.devicePool,
      this.deviceSessionRegistry,
      this.observerSessionRegistry,
    );
    this.daemonState.setSessionBrokerMode(this.sessionBrokerConfigPath !== undefined);
    this.broker.installManagedExecutionRelease();
    this.broker.installBrokerDeviceAcquisition();

    this.startup.applyRuntimeOptions(options);
    this.startup.applyAccessibilityOptions(options);
    this.applyToolOutputOptions(options);
  }

  private openBindingRegistry(...args: Parameters<DaemonBroker["openBindingRegistry"]>) {
    return this.broker.openBindingRegistry(...args);
  }
  protected stopSessionTimers(...args: Parameters<DaemonSessions["stopSessionTimers"]>) {
    return this.sessions.stopSessionTimers(...args);
  }
  protected subscribeToolCallEndActivity(
    ...args: Parameters<DaemonSessions["subscribeToolCallEndActivity"]>
  ) {
    return this.sessions.subscribeToolCallEndActivity(...args);
  }
  start(...args: Parameters<DaemonStartup["start"]>) {
    return this.startup.start(...args);
  }
  startOn(...args: Parameters<DaemonStartup["startOn"]>) {
    return this.startup.startOn(...args);
  }
  private stopAfterFailedStartup(...args: Parameters<DaemonStartup["stopAfterFailedStartup"]>) {
    return this.startup.stopAfterFailedStartup(...args);
  }
  private startThroughSocketBind(...args: Parameters<DaemonStartup["startThroughSocketBind"]>) {
    return this.startup.startThroughSocketBind(...args);
  }
  private startAfterSocketBind(...args: Parameters<DaemonStartup["startAfterSocketBind"]>) {
    return this.startup.startAfterSocketBind(...args);
  }
  private getDeviceSessionRoutingTargets(
    ...args: Parameters<DaemonStreams["getDeviceSessionRoutingTargets"]>
  ) {
    return this.streams.getDeviceSessionRoutingTargets(...args);
  }
  protected setupDeviceDataStreamCallback(
    ...args: Parameters<DaemonStreams["setupDeviceDataStreamCallback"]>
  ) {
    return this.streams.setupDeviceDataStreamCallback(...args);
  }
  private setupNavigationGraphStreamListener(
    ...args: Parameters<DaemonStreams["setupNavigationGraphStreamListener"]>
  ) {
    return this.streams.setupNavigationGraphStreamListener(...args);
  }
  protected startHeartbeatMonitor(...args: Parameters<DaemonMaintenance["startHeartbeatMonitor"]>) {
    return this.maintenance.startHeartbeatMonitor(...args);
  }
  protected recordAndTryRecoverCapturedDisconnect(
    ...args: Parameters<DaemonDisconnect["recordAndTryRecoverCapturedDisconnect"]>
  ) {
    return this.disconnect.recordAndTryRecoverCapturedDisconnect(...args);
  }
  protected startDeviceDisconnectMonitor(
    ...args: Parameters<DaemonDisconnect["startDeviceDisconnectMonitor"]>
  ) {
    return this.disconnect.startDeviceDisconnectMonitor(...args);
  }
  trackDeferredSessionRecoverySweep(
    ...args: Parameters<DaemonDisconnect["trackDeferredSessionRecoverySweep"]>
  ) {
    return this.disconnect.trackDeferredSessionRecoverySweep(...args);
  }
  protected stopRecordingAfterDeviceDisconnect(
    ...args: Parameters<DaemonDisconnect["stopRecordingAfterDeviceDisconnect"]>
  ) {
    return this.disconnect.stopRecordingAfterDeviceDisconnect(...args);
  }
  protected shouldSkipStaleDisconnectCleanup(
    ...args: Parameters<DaemonDisconnect["shouldSkipStaleDisconnectCleanup"]>
  ) {
    return this.disconnect.shouldSkipStaleDisconnectCleanup(...args);
  }
  protected isCapturedDisconnectTargetCurrent(
    ...args: Parameters<DaemonDisconnect["isCapturedDisconnectTargetCurrent"]>
  ) {
    return isCapturedDisconnectTargetCurrent(
      { services: this.createDaemonCoreServices() },
      ...args,
    );
  }
  protected startAdbMissingDeviceListener(
    ...args: Parameters<DaemonDisconnect["startAdbMissingDeviceListener"]>
  ) {
    return this.disconnect.startAdbMissingDeviceListener(...args);
  }
  cancelAndReleaseSession(...args: Parameters<DaemonSessions["cancelAndReleaseSession"]>) {
    return this.sessions.cancelAndReleaseSession(...args);
  }
  private attemptRecovery(...args: Parameters<DaemonMaintenance["attemptRecovery"]>) {
    return this.maintenance.attemptRecovery(...args);
  }
  initializeDevicePoolWithTimeout(
    ...args: Parameters<DaemonStartup["initializeDevicePoolWithTimeout"]>
  ) {
    return this.startup.initializeDevicePoolWithTimeout(...args);
  }
  initializeDevicePool(...args: Parameters<DaemonStartup["initializeDevicePool"]>) {
    return this.startup.initializeDevicePool(...args);
  }
  initializeIosServices(...args: Parameters<DaemonStartup["initializeIosServices"]>) {
    return this.startup.initializeIosServices(...args);
  }
  initializeDatabase(...args: Parameters<DaemonStartup["initializeDatabase"]>) {
    return this.startup.initializeDatabase(...args);
  }
  private setupShutdownHandlers(...args: Parameters<DaemonShutdown["setupShutdownHandlers"]>) {
    return this.shutdown.setupShutdownHandlers(...args);
  }

  /** @internal Typed view of private state for unit tests; not part of the public API. */
  get testHooks() {
    return {
      ...this.startup.testHooks,
      ...this.broker.testHooks,
      ...this.streams.testHooks,
      ...this.maintenance.testHooks,
      ...this.shutdown.testHooks,
      sessionManager: this.sessionManager,
      devicePool: this.devicePool,
      deviceSessionRegistry: this.deviceSessionRegistry,
      navigationGraphBridge: this.navigationGraphBridge,

      httpIngress: this.httpIngress.testHooks,
      prepareHttpToken: () => this.httpToken.prepare(),
      publishHttpToken: () => this.httpToken.publish(),

      /** Installs (or clears) a socket server double whose members the shutdown path calls. */
      setSocketServer: (server: Partial<DaemonSocketServer> | null): void => {
        this.runtime.socketServer = server && daemonSocketServerDouble(server);
      },
      /** Registers an in-flight HTTP request double that shutdown must close. */
      registerTransport: (
        requestScopeId: string,
        transport: Pick<StreamableHTTPServerTransport, "close">,
      ): void => this.httpIngress.trackTransportForTesting(requestScopeId, () => transport.close()),
      /** Behaves as if shutdown had already started, without running it. */

      overrideRoutingTargets: (targets: () => DeviceSessionRoutingTargets): void => {
        this.getDeviceSessionRoutingTargets = targets;
      },

      overrideNavigationGraphListener: (
        listen: (server: ReturnType<typeof getDeviceDataStreamServer>) => void,
      ): void => {
        this.setupNavigationGraphStreamListener = listen;
      },

      attemptRecovery: (failureKind?: HealthFailureKind): Promise<void> =>
        this.attemptRecovery(failureKind),
      overrideAttemptRecovery: (
        recover: (failureKind?: HealthFailureKind) => Promise<void>,
      ): void => {
        this.attemptRecovery = recover;
      },
      replaceSessionManager: (manager: SessionManager): void => {
        this.sessionManager = manager;
      },
      replaceDevicePool: (pool: DevicePool): void => {
        this.devicePool = pool;
      },
      recordAndTryRecoverCapturedDisconnect: this.recordAndTryRecoverCapturedDisconnect.bind(this),
      deviceLoss: this.deviceLoss,
      stoppingRecordings: this.stoppingRecordings,
      stopRecordingAfterDeviceDisconnect: this.stopRecordingAfterDeviceDisconnect.bind(this),
      runtime: this.runtime,
      startDeviceDisconnectMonitor: this.startDeviceDisconnectMonitor.bind(this),
      createPlanDeviceLossCheck: this.createPlanDeviceLossCheck.bind(this),
      /** Replaces the staleness and retirement checks the captured-disconnect recovery consults. */
      overrideCapturedDisconnectChecks: (checks: {
        shouldSkipStaleDisconnectCleanup: DaemonDisconnect["shouldSkipStaleDisconnectCleanup"];
        isCapturedDisconnectTargetCurrent: DaemonDisconnect["isCapturedDisconnectTargetCurrent"];
        retireAdbServerResetDisconnectState: DaemonDisconnect["retireAdbServerResetDisconnectState"];
      }): void => {
        Object.assign(this, checks);
      },
      overrideCleanupDisconnectedDevice: (
        cleanup: DaemonDisconnect["cleanupDisconnectedDevice"],
      ) => {
        this.cleanupDisconnectedDevice = cleanup;
      },
      deferredSessionRecoverySweeps: this.runtime.deferredSessionRecoverySweeps,
      replaceObserverSessionRegistry: (registry: ObserverSessionRegistry): void => {
        this.observerSessionRegistry = registry;
      },

      /** Replaces the startup stages the post-bind failure path runs, keeping the others. */
      overrideStartupStages: (stages: {
        startThroughSocketBind?: () => Promise<void>;
        startAfterSocketBind?: () => Promise<void>;
        stopAfterFailedStartup?: () => Promise<void>;
      }): void => {
        this.startThroughSocketBind = stages.startThroughSocketBind ?? this.startThroughSocketBind;
        this.startAfterSocketBind = stages.startAfterSocketBind ?? this.startAfterSocketBind;
        this.stopAfterFailedStartup = stages.stopAfterFailedStartup ?? this.stopAfterFailedStartup;
      },

      setSessionBrokerConfigPath: (path: string | undefined): void => {
        this.sessionBrokerConfigPath = path;
      },
      setExitRecordFileSystem: (fileSystem: DaemonExitRecordFileSystem): void => {
        this.exitRecordFileSystem = fileSystem;
      },
      setupShutdownHandlers: (): void => this.setupShutdownHandlers(),

      setSocketBindCommitted: (committed: boolean): void => {
        this.runtime.socketBindCommitted = committed;
      },

      stopSessionTimers: (): void => this.stopSessionTimers(),
      getAppearanceSyncTargets: (): AppearanceSyncTarget[] =>
        this.sessions.getAppearanceSyncTargets(),

      /** Installs a host-lifetime binding registry the way an earlier open of this process would. */

      /** Replaces start-sequence steps with doubles on this instance. */
      overrideStartSteps: (steps: {
        startThroughSocketBind?: () => Promise<void>;
        openBindingRegistry?: (signal?: AbortSignal) => Promise<SqliteBindingRegistry>;
        setupShutdownHandlers?: () => void;
      }): void => {
        this.startThroughSocketBind = steps.startThroughSocketBind ?? this.startThroughSocketBind;
        this.openBindingRegistry = steps.openBindingRegistry ?? this.openBindingRegistry;
        this.setupShutdownHandlers = steps.setupShutdownHandlers ?? this.setupShutdownHandlers;
      },
    } as const;
  }
  stop(...args: Parameters<DaemonShutdown["stop"]>) {
    return this.shutdown.stop(...args);
  }

  /**
   * Get the SessionManager instance
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getDeviceReadiness(): DeviceReadiness {
    return this.deviceReadiness;
  }

  /**
   * Get the DevicePool instance
   */
  getDevicePool(): DevicePool {
    return this.devicePool;
  }
  private createDaemonBroker(
    services: DaemonCoreServices,
    identity: DaemonIdentityState,
    lifecycle: DaemonLifecycleState,
  ): DaemonBroker {
    const daemon = this;
    return new DaemonBroker({
      readPersistedSession: persistedSessionReaders(() => this.deviceSessionRepository).getSession,
      warmConfirmedManagedExecution: (sessionUuid) =>
        warmConfirmedManagedExecution({ services, lifecycle }, sessionUuid),
      services,
      identity,
      lifecycle,
      bindingRegistry: () => daemon.runtime.bindingRegistry,
      setBindingRegistry: (value) => {
        daemon.runtime.bindingRegistry = value;
      },
      brokerDeviceAcquisition: () => daemon.runtime.brokerDeviceAcquisition,
      setBrokerDeviceAcquisition: (value) => (daemon.runtime.brokerDeviceAcquisition = value),
      openBindingRegistry: (...args) => this.openBindingRegistry(...args),
      cancelAndReleaseSession: (...args) => this.cancelAndReleaseSession(...args),
    });
  }
  private createDaemonSessions(
    services: DaemonCoreServices,
    identity: DaemonIdentityState,
    lifecycle: DaemonLifecycleState,
  ): DaemonSessions {
    const daemon = this;
    return new DaemonSessions({
      services,
      identity,
      lifecycle,
      bindingExclusionFactory: () => daemon.injected.bindingExclusionFactory,
      foreignCtrlProxyForwardEvidence: () => daemon.injected.foreignCtrlProxyForwardEvidence,
      deviceStateChangeNotifier: () => daemon.deviceStateChangeNotifier,
      observerSessionRegistry: () => daemon.observerSessionRegistry,
      cancelAndReleaseSession: (...args) => this.cancelAndReleaseSession(...args),
      onDeviceReadyForSessionRegistry: (...args) =>
        this.streams.onDeviceReadyForSessionRegistry(...args),
      reownRehydratedManagedExecutions: (...args) =>
        this.broker.reownRehydratedManagedExecutions(...args),
    });
  }
  private createDaemonStartup(
    services: DaemonCoreServices,
    identity: DaemonIdentityState,
    lifecycle: DaemonLifecycleState,
  ): DaemonStartup {
    const daemon = this;
    const startup = new DaemonStartup({
      initializeRecordingTeardownRedriveState: () =>
        defaultDaemonRecordingHost.initializeRecordingTeardownRedriveState(),
      redriveUnconfirmedCaptureTeardowns: (...args) =>
        defaultDaemonRecordingHost.redriveUnconfirmedCaptureTeardowns(...args),
      setStartupOrphanCaptures: (...args) =>
        defaultDaemonRecordingHost.setStartupOrphanCaptures(...args),
      setVideoRecordingManagerDependencies: (...args) =>
        defaultDaemonRecordingHost.setVideoRecordingManagerDependencies(...args),
      enterDaemonProcess: (...args) => this.enterDaemonProcess(...args),
      prepareHttpToken: () => this.httpToken.prepare(),
      publishHttpToken: () => this.httpToken.publish(),
      startHttpIngress: () => this.startup.startHttpIngress(),
      bindControlSocket: (...args) => this.bindControlSocket(...args),
      startServicesAfterSocketBind: (...args) => this.startServicesAfterSocketBind(...args),
      startMaintenanceMonitors: (...args) => this.startMaintenanceMonitors(...args),
      readPersistedSession: persistedSessionReaders(() => this.deviceSessionRepository)
        .getPersistedSession,
      start: (...args) => this.start(...args),
      services,
      identity,
      lifecycle,
      startHost: () => daemon.startHost,
      setStartHost: (value) => (daemon.startHost = value),
      enteredDaemonProcess: () => daemon.runtime.enteredDaemonProcess,
      setEnteredDaemonProcess: (value) => (daemon.runtime.enteredDaemonProcess = value),
      resolveStartupCompletion: () => daemon.startupCompletion.resolve,
      rejectStartupCompletion: () => daemon.startupCompletion.reject,
      exitRecordFileSystem: () => daemon.exitRecordFileSystem,
      strictPort: () => daemon.listen.strictPort,
      host: () => daemon.listen.host,
      startupFailureTracker: () => daemon.database.startupFailureTracker,
      avdManagerFactory: () => daemon.injected.avdManagerFactory,
      databaseInitializer: () => daemon.database.databaseInitializer,
      toolSelectionProfileProvenanceLoader: () =>
        daemon.database.toolSelectionProfileProvenanceLoader,
      liveDaemonSessionIdProvider: () => daemon.injected.liveDaemonSessionIdProvider,
      startOn: (...args) => this.startOn(...args),
      startThroughSocketBind: (...args) => this.startThroughSocketBind(...args),
      startAfterSocketBind: (...args) => this.startAfterSocketBind(...args),
      stopAfterFailedStartup: (...args) => this.stopAfterFailedStartup(...args),
      stop: (...args) => this.stop(...args),
      writeEarlyOwnerRecord: (...args) => this.writeEarlyOwnerRecord(...args),
      setupShutdownHandlers: (...args) => this.setupShutdownHandlers(...args),
      subscribeToolCallEndActivity: (...args) => this.subscribeToolCallEndActivity(...args),
      initializeDatabase: (...args) => this.initializeDatabase(...args),
      openBindingRegistry: (...args) => this.openBindingRegistry(...args),
      initializeDevicePoolWithTimeout: (...args) => this.initializeDevicePoolWithTimeout(...args),
      reownRehydratedManagedExecutions: (...args) =>
        this.broker.reownRehydratedManagedExecutions(...args),
      installSessionBroker: (...args) => this.broker.installSessionBroker(...args),
      initializeIosServices: (...args) => this.initializeIosServices(...args),
      restoreIncumbentOwnerRecord: (...args) => this.identity.restoreIncumbentOwnerRecord(...args),
      republishIdentity: (...args) => this.identity.republishIdentity(...args),
      recordControlSocketIdentity: () => this.identity.recordControlSocketIdentity(),
      startAuxiliarySocket: (...args) => this.startAuxiliarySocket(...args),
      configureDeviceDataStreamServer: (...args) =>
        this.streams.configureDeviceDataStreamServer(...args),
      setupDeviceSessionRouting: (...args) => this.streams.setupDeviceSessionRouting(...args),
      getAppearanceSyncTargets: (...args) => this.sessions.getAppearanceSyncTargets(...args),
      startAdbMissingDeviceListener: (...args) => this.startAdbMissingDeviceListener(...args),
      startDeviceDisconnectMonitor: (...args) => this.startDeviceDisconnectMonitor(...args),
      writePidFile: (...args) => this.writePidFile(...args),
      startHealthCheckTimer: (...args) => this.maintenance.startHealthCheckTimer(...args),
      startNavigationRetentionMonitor: (...args) =>
        this.maintenance.startNavigationRetentionMonitor(...args),
      startForwardLeaseIdleReleaser: (...args) =>
        this.maintenance.startForwardLeaseIdleReleaser(...args),
      startPrivateDaemonOrphanWatchdog: (...args) =>
        this.maintenance.startPrivateDaemonOrphanWatchdog(...args),
      startHeartbeatMonitor: (...args) => this.startHeartbeatMonitor(...args),
      initializeDevicePool: (...args) => this.initializeDevicePool(...args),
    });
    this.startHost = startup.processStartHost();
    return startup;
  }
  private createDaemonIdentity(
    services: DaemonCoreServices,
    identity: DaemonIdentityState,
  ): DaemonIdentity {
    return new DaemonIdentity({
      pidFileWritten: () => this.runtime.pidFileWritten,
      setPidFileWritten: (value) => (this.runtime.pidFileWritten = value),
      persistPidFileData: (...args) => this.persistPidFileData(...args),
      writeEarlyOwnerRecord: (...args) => this.writeEarlyOwnerRecord(...args),
      cleanupDaemonFilesForShutdown: (...args) => this.cleanupDaemonFilesForShutdown(...args),
      services,
      identity,
    });
  }
  private createDaemonStreams(
    services: DaemonCoreServices,
    lifecycle: DaemonLifecycleState,
  ): DaemonStreams {
    return new DaemonStreams({
      services,
      lifecycle,

      setupDeviceDataStreamCallback: (...args) => this.setupDeviceDataStreamCallback(...args),
      getDeviceSessionRoutingTargets: (...args) => this.getDeviceSessionRoutingTargets(...args),
      setupNavigationGraphStreamListener: (...args) =>
        this.setupNavigationGraphStreamListener(...args),
    });
  }
  private createDaemonMaintenance(
    services: DaemonCoreServices,
    identity: DaemonIdentityState,
    lifecycle: DaemonLifecycleState,
  ): DaemonMaintenance {
    return new DaemonMaintenance({
      services,
      identityState: identity,
      identity: this.identity,
      lifecycle,
      healthCheck: () => this.runtime.healthCheck,
      setHealthCheck: (value) => (this.runtime.healthCheck = value),
      observationStreamHealth: () => this.observationStreamHealth,
      setObservationStreamHealth: (health) => (this.observationStreamHealth = health),
      lastDatabaseHealthFailure: () => this.runtime.lastDatabaseHealthFailure,
      setLastDatabaseHealthFailure: (value) => (this.runtime.lastDatabaseHealthFailure = value),
      recoverFromDatabaseHealthFailure: () => this.database.recoverFromDatabaseHealthFailure,
      hostIoStalled: () => this.injected.hostIoStalled,
      attemptRecovery: (...args) => this.attemptRecovery(...args),
      sessionExecutionProbe: (...args) => this.sessions.sessionExecutionProbe(...args),
      cancelAndReleaseSession: (...args) => this.cancelAndReleaseSession(...args),
      republishIdentity: (...args) => this.identity.republishIdentity(...args),
      configureDeviceDataStreamServer: (...args) =>
        this.streams.configureDeviceDataStreamServer(...args),
    });
  }
  private createDaemonDisconnect(
    services: DaemonCoreServices,
    lifecycle: DaemonLifecycleState,
  ): DaemonDisconnect {
    const daemon = this;
    return new DaemonDisconnect({
      listActiveVideoRecordings: (...args) =>
        defaultDaemonRecordingHost.listActiveVideoRecordings(...args),
      captureDisconnectCleanup: (deviceId, cohort) =>
        captureDisconnectCleanup(
          {
            services,
            forceDisconnectedDeviceGenerations: () =>
              daemon.deviceLoss.forceDisconnectedGenerations,
          },
          deviceId,
          cohort,
        ),
      stoppingRecordings: () => this.stoppingRecordings,

      retireAdbServerResetDisconnectState: (...args) =>
        this.retireAdbServerResetDisconnectState(...args),
      cleanupDisconnectedDevice: (...args) => this.cleanupDisconnectedDevice(...args),
      services,
      lifecycle,
      forceDisconnectedDeviceIds: () => daemon.deviceLoss.forceDisconnectedIds,
      confirmedDisconnectedDeviceIds: () => daemon.deviceLoss.confirmedDisconnectedIds,
      deviceDisconnectMissIncarnations: () => daemon.deviceLoss.missIncarnations,
      offlineEpisodes: () => daemon.deviceLoss.offlineEpisodes,
      offlineRecoveryAttemptedDeviceIds: () => daemon.deviceLoss.offlineRecoveryAttemptedIds,
      setOfflineRecoveryAttemptedDeviceIds: (value) =>
        (daemon.deviceLoss.offlineRecoveryAttemptedIds = value),
      offlineRecoveryAttemptedIncarnations: () =>
        daemon.deviceLoss.offlineRecoveryAttemptedIncarnations,
      setOfflineRecoveryAttemptedIncarnations: (value) =>
        (daemon.deviceLoss.offlineRecoveryAttemptedIncarnations = value),
      forceDisconnectedDeviceGenerations: () => daemon.deviceLoss.forceDisconnectedGenerations,
      shouldSkipStaleDisconnectCleanup: (...args) => this.shouldSkipStaleDisconnectCleanup(...args),
      isCapturedDisconnectTargetCurrent: (...args) =>
        this.isCapturedDisconnectTargetCurrent(...args),
      trackDeferredSessionRecoverySweep: (...args) =>
        this.trackDeferredSessionRecoverySweep(...args),
      stopRecordingAfterDeviceDisconnect: (...args) =>
        this.stopRecordingAfterDeviceDisconnect(...args),
      recordAndTryRecoverCapturedDisconnect: (...args) =>
        this.recordAndTryRecoverCapturedDisconnect(...args),
      cancelAndReleaseSession: (...args) => this.cancelAndReleaseSession(...args),
    });
  }
  private createDaemonShutdown(
    services: DaemonCoreServices,
    lifecycle: DaemonLifecycleState,
  ): DaemonShutdown {
    const daemon = this;
    return new DaemonShutdown({
      services,
      lifecycle,
      stopManagedAdbServer: () => daemon.injected.stopManagedAdbServer,
      removeHttpToken: () => this.httpToken.remove(),
      stop: (...args) => this.stop(...args),
      getDaemonFileCleanupOptions: (...args) => this.identity.getDaemonFileCleanupOptions(...args),
      closeManagedExecutionRelease: (...args) => this.broker.closeManagedExecutionRelease(...args),
      stopHealthCheckTimer: (...args) => this.maintenance.stopHealthCheckTimer(...args),
      stopSessionTimers: (...args) => this.stopSessionTimers(...args),
      cleanupDaemonFilesForShutdown: (...args) => this.cleanupDaemonFilesForShutdown(...args),
      cancelAndReleaseSession: (...args) => this.cancelAndReleaseSession(...args),
    });
  }
  private createDaemonCoreServices(): DaemonCoreServices {
    const daemon = this;
    return {
      deviceReadiness: () => daemon.deviceReadiness,
      iosDeviceVerifier: () => daemon.injected.iosDeviceVerifier,
      httpIngress: () => daemon.httpIngress,
      mcpDispatcher: () => daemon.mcpDispatcher,
      sessionManager: () => daemon.sessionManager,
      devicePool: () => daemon.devicePool,
      deviceSessionRegistry: () => daemon.deviceSessionRegistry,
      installedAppsRepository: () => daemon.installedAppsRepository,
      deviceSessionRepository: () => daemon.deviceSessionRepository,
      timer: () => daemon.timer,
      passiveWorkPolicy: () => daemon.passiveWorkPolicy,
      idGenerator: () => daemon.idGenerator,
      databaseHealthProbe: () => daemon.database.databaseHealthProbe,
      options: () => daemon.options,
      daemonState: () => daemon.daemonState,
    };
  }
  private createDaemonIdentityState(): DaemonIdentityState {
    const daemon = this;
    return {
      port: () => daemon.listen.port,
      setPort: (value) => (daemon.listen.port = value),
      completeIdentityPublished: () => daemon.runtime.completeIdentityPublished,
      setCompleteIdentityPublished: (value) => (daemon.runtime.completeIdentityPublished = value),
      socketBindCommitted: () => daemon.runtime.socketBindCommitted,
      setSocketBindCommitted: (value) => (daemon.runtime.socketBindCommitted = value),
      incumbentOwnerGuard: () => daemon.incumbentOwnerGuard,
      daemonSessionId: () => daemon.daemonSessionId,
      generationStartedAt: () => daemon.processIdentity.generationStartedAt,
      processStartedAt: () => daemon.processIdentity.processStartedAt,
      processGenerationToken: () => daemon.processIdentity.processGenerationToken,
      liveAcceptanceStartupSecret: () => daemon.processIdentity.liveAcceptanceStartupSecret,
      acceptanceDiscoveryCapability: () => daemon.acceptanceDiscoveryCapability,
    };
  }
  private createDaemonLifecycleState(): DaemonLifecycleState {
    const daemon = this;
    return {
      socketServer: () => daemon.runtime.socketServer,
      setSocketServer: (value) => (daemon.runtime.socketServer = value),
      selfExitRecorder: () => daemon.selfExitRecorder,
      startupCompletion: () => daemon.startupCompletion.promise,
      heartbeatMonitor: () => daemon.runtime.heartbeatMonitor,
      setHeartbeatMonitor: (value) => (daemon.runtime.heartbeatMonitor = value),
      navigationRetentionMonitor: () => daemon.runtime.navigationRetentionMonitor,
      setNavigationRetentionMonitor: (value) => (daemon.runtime.navigationRetentionMonitor = value),
      forwardLeaseIdleReleaser: () => daemon.runtime.forwardLeaseIdleReleaser,
      setForwardLeaseIdleReleaser: (value) => (daemon.runtime.forwardLeaseIdleReleaser = value),
      orphanWatchdog: () => daemon.runtime.orphanWatchdog,
      setOrphanWatchdog: (value) => (daemon.runtime.orphanWatchdog = value),
      deviceDisconnectMonitor: () => daemon.runtime.deviceDisconnectMonitor,
      setDeviceDisconnectMonitor: (value) => (daemon.runtime.deviceDisconnectMonitor = value),
      deferredSessionRecoverySweeps: () => daemon.runtime.deferredSessionRecoverySweeps,
      deviceDisconnectMisses: () => daemon.deviceLoss.misses,
      sessionBrokerConfigPath: () => daemon.sessionBrokerConfigPath,
      managedExecutionReowner: () => daemon.runtime.managedExecutionReowner,
      setManagedExecutionReowner: (value) => (daemon.runtime.managedExecutionReowner = value),
      deviceDataStreamServer: () => daemon.runtime.deviceDataStreamServer,
      setDeviceDataStreamServer: (value) => (daemon.runtime.deviceDataStreamServer = value),
      navigationGraphBridge: () => daemon.navigationGraphBridge,
      unsubscribeAdbMissingDevice: () => daemon.runtime.unsubscribeAdbMissingDevice,
      setUnsubscribeAdbMissingDevice: (value) =>
        (daemon.runtime.unsubscribeAdbMissingDevice = value),
      shutdownInProgress: () => daemon.shutdownState.inProgress,
      setShutdownInProgress: (value) => (daemon.shutdownState.inProgress = value),
      recorderDeviceIncarnationListener: () => daemon.runtime.recorderDeviceIncarnationListener,
      setRecorderDeviceIncarnationListener: (value) =>
        (daemon.runtime.recorderDeviceIncarnationListener = value),
      shutdownReleaseNotifications: () => daemon.shutdownState.releaseNotifications,
      setShutdownReleaseNotifications: (value) =>
        (daemon.shutdownState.releaseNotifications = value),
      shutdownFallbackReleaseNotifications: () => daemon.shutdownState.fallbackReleaseNotifications,
      setShutdownFallbackReleaseNotifications: (value) =>
        (daemon.shutdownState.fallbackReleaseNotifications = value),
      backgroundRegistryUpgrade: () => daemon.runtime.backgroundRegistryUpgrade,
      setBackgroundRegistryUpgrade: (value) => (daemon.runtime.backgroundRegistryUpgrade = value),
    };
  }
  private enterDaemonProcess(...args: Parameters<DaemonStartup["enterDaemonProcess"]>) {
    return this.startup.enterDaemonProcess(...args);
  }
  private writeEarlyOwnerRecord(...args: Parameters<DaemonIdentity["writeEarlyOwnerRecord"]>) {
    return this.identity.writeEarlyOwnerRecord(...args);
  }
  private writePidFile(...args: Parameters<DaemonIdentity["writePidFile"]>) {
    return this.identity.writePidFile(...args);
  }
  private persistPidFileData(...args: Parameters<DaemonIdentity["persistPidFileData"]>) {
    return this.identity.persistPidFileData(...args);
  }
  private bindControlSocket(...args: Parameters<DaemonStartup["bindControlSocket"]>) {
    return this.startup.bindControlSocket(...args);
  }
  private startServicesAfterSocketBind(
    ...args: Parameters<DaemonStartup["startServicesAfterSocketBind"]>
  ) {
    return this.startup.startServicesAfterSocketBind(...args);
  }

  private startAuxiliarySocket(...args: Parameters<DaemonIdentity["startAuxiliarySocket"]>) {
    return this.identity.startAuxiliarySocket(...args);
  }
  private startMaintenanceMonitors(...args: Parameters<DaemonStartup["startMaintenanceMonitors"]>) {
    return this.startup.startMaintenanceMonitors(...args);
  }
  private cleanupDaemonFilesForShutdown(
    ...args: Parameters<DaemonIdentity["cleanupDaemonFilesForShutdown"]>
  ) {
    return this.identity.cleanupDaemonFilesForShutdown(...args);
  }
  private bindingJournalOwner(...args: Parameters<DaemonBroker["bindingJournalOwner"]>) {
    return this.broker.bindingJournalOwner(...args);
  }
  private cleanupDisconnectedDevice(
    ...args: Parameters<DaemonDisconnect["cleanupDisconnectedDevice"]>
  ) {
    return this.disconnect.cleanupDisconnectedDevice(...args);
  }
  private createPlanDeviceLossCheck(
    ...args: Parameters<DaemonDisconnect["createPlanDeviceLossCheck"]>
  ) {
    return this.disconnect.createPlanDeviceLossCheck(...args);
  }
  private getDaemonFileCleanupOptions(
    ...args: Parameters<DaemonIdentity["getDaemonFileCleanupOptions"]>
  ) {
    return this.identity.getDaemonFileCleanupOptions(...args);
  }
  private retireAdbServerResetDisconnectState(
    ...args: Parameters<DaemonDisconnect["retireAdbServerResetDisconnectState"]>
  ) {
    return this.disconnect.retireAdbServerResetDisconnectState(...args);
  }
  private applyToolOutputOptions(options: DaemonOptions): void {
    applyDaemonToolOutputOptions(options, this.options);
  }
}

/**
 * Start the daemon process
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<void> {
  const daemon = new Daemon(options, {
    foreignCtrlProxyForwardEvidence: createForeignCtrlProxyForwardEvidence(),
  });
  daemonToolRegistry().setDeviceReadiness(daemon.getDeviceReadiness());
  await daemon.start();
}
