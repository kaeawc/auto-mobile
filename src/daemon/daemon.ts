import {} from "./networkStateSessionCleanup";
import {} from "../server/recordingSessionCleanup";
import { redriveUnconfirmedCaptureTeardowns } from "../server/recordingTeardownRedrive";
import {
  initializeRecordingTeardownRedriveState,
  listActiveVideoRecordings,
  setStartupOrphanCaptures,
  setVideoRecordingManagerDependencies,
} from "../server/videoRecordingManager";
import {} from "./observationRequestBatch";
import { IosCtrlProxyBuilder } from "../ctrlProxy/IosCtrlProxyBuilder";
import { initializeIosCtrlProxyAtStartup, selectIosStartupWarmupDevices } from "./iosStartupInit";
import { holderOf } from "./deviceBinding";
import { type BindingExclusion } from "./sessionBroker/provisioning/exclusion";
import { installDefaultProvisionedDeviceTransportFence } from "../db/createDefaultProvisionedDeviceTransportFence";
import { ObserverSessionRegistry } from "./observerSessionRegistry";
import { ObserverReleaseBroadcaster } from "./observerReleaseBroadcast";
import { NodeStreamableHTTPServerTransport as StreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { DaemonHttpIngress, type HttpListener } from "./daemonHttpIngress";
import type { McpHttpRequestLike, StatelessMcpRequestScope } from "./statelessMcpHttpEndpoint";
import { createDaemonMcpDispatcher, MCP_FORWARD_CLOSED_REASON } from "./inProcessMcpDispatcher";
import {
  buildMcpRequestContext,
  createStatelessMcpServer,
  type StatelessMcpServerBase,
} from "./statelessMcpServerFactory";
import { createProductionCoreDeviceProbe } from "../utils/ios-cmdline-tools/CoreDeviceProbeHolder";
import { createIosDoctorDependencies } from "../doctor/checks/ios";
import { logger } from "../utils/logger";
import { type DaemonSocketServer, daemonSocketServerDouble } from "./daemonSocketServer";
import { SessionManager, type Session, type RehydrationSummary } from "./sessionManager";
import { type HealthFailureKind } from "./daemonHealthCheck";
import { SessionHeartbeatMonitor } from "./SessionHeartbeatMonitor";
import { PassiveWorkPolicy, parsePassiveWorkSettings } from "./PassiveWorkPolicy";
import { SingleFlightInterval } from "./SingleFlightInterval";
import { DevicePool, type PooledDevice } from "./devicePool";
import {
  createForeignCtrlProxyForwardEvidence,
  type ForeignCtrlProxyForwardEvidence,
} from "../features/observe/android/foreignCtrlProxyForwardEvidence";
import { parseDeviceRecoveryPolicy } from "./poolConfig";
import { type SqliteBindingRegistry } from "./sessionBroker/registry/sqliteBindingRegistry";
import { SESSION_BROKER_HOST_CONFIG_ENV } from "./sessionBroker/hostConfig";
import { ManagedExecutionReowner } from "./sessionBroker/provisioning/executionReowner";
import { type DaemonBrokerDeviceAcquisitionHandle } from "./sessionBroker/provisioning/daemonDeviceAcquisition";
import { DeviceSessionRegistry } from "./deviceSessionRegistry";
import {
  DEFAULT_DAEMON_PORT,
  DAEMON_PORT_RANGE_START,
  DAEMON_PORT_RANGE_END,
  ACCEPTANCE_DISCOVERY_CAPABILITY_ENV,
} from "./constants";
import { DaemonOptions } from "./types";
import { DeviceForwardLeaseIdleReleaser } from "./deviceForwardLeaseIdleReleaser";
import {
  DaemonSelfExitRecorder,
  defaultDaemonExitRecordFileSystem,
  type DaemonExitRecord,
  type DaemonExitRecordFileSystem,
} from "./daemonExitRecord";
import { daemonProcessOptions } from "./daemonOptionScopes";
import { PrivateDaemonOrphanWatchdog } from "./privateDaemonOrphanWatchdog";
import { resolve } from "node:path";
import { getCurrentBuildIdentity } from "./buildIdentity";
import { cleanupDaemonFilesSync, type LiveDaemonSessionIdProvider } from "./daemonFiles";
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
import {
  DAEMON_HANDOFF_INTERRUPTED_MESSAGE,
  DaemonHandoffInterruptionError,
} from "./daemonHandoffInterruption";
import { clearSessionAppearanceConfig } from "./appearanceManager";
import { NavigationRetentionMonitor } from "./NavigationRetentionMonitor";
import { DatabaseInitializer } from "../db/DatabaseInitializer";
import { DatabaseHealthProbe } from "../db/DatabaseHealthProbe";
import { StartupFailureTracker } from "./DaemonStartupFailureTracker";
import {
  startDeviceDataStreamSocketServer,
  stopDeviceDataStreamSocketServer,
  getDeviceDataStreamServer,
} from "./deviceDataStreamSocketServer";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import { NavigationGraphStreamBridge } from "./daemonStreamRouting";
import { InstalledAppsRepository, type InstalledAppsStore } from "../db/installedAppsRepository";
import { BackgroundBindingRegistryUpgrade } from "./sessionBroker/registry/BackgroundBindingRegistryUpgrade";
import {
  type DaemonTerminalReleaseJournalOptions,
  type TerminalReleaseJournal,
} from "./terminalReleaseJournal";
import { DeviceReadiness } from "./readiness/DeviceReadiness";
import { type AppearanceSyncTarget } from "./AppearanceSyncScheduler";
import { Timer } from "../utils/SystemTimer";
import { IdGenerator } from "../utils/IdGenerator";
import type { AvdManager } from "../utils/android-cmdline-tools/interfaces/AvdManager";
import { type OfflineEpisode, type DisconnectCandidateIncarnation } from "./disconnectMonitor";
import { errorMessage } from "../utils/describeUnknownError";
import { writeEmergencyLog } from "../utils/loggingConfig";
import { exitAfterDatabaseHealthFailure } from "./databaseHealthExit";
import type { Platform } from "../models";
import {
  DefaultObservationStreamHealth,
  type ObservationStreamHealth,
} from "./ObservationStreamHealth";
import { type ToolSelectionProfileProvenanceLoader } from "./toolSelectionProfileRegistry";
import {
  resolveDaemonDependencies,
  type DaemonDependencies,
  type DaemonDeviceSessionStore,
  type DatabaseHealthFailureRecovery,
  type ManagedAdbServerShutdown,
  type DaemonProcessBirthTimeProvider,
  type DaemonProcessGenerationTokenProvider,
} from "./daemonDependencies";
import type { DaemonStateWrites } from "./daemonContext";
import { DaemonBroker, type DaemonBrokerHost } from "./daemonCore/DaemonBroker";
import { DaemonSessions } from "./daemonCore/DaemonSessions";
import { DaemonStartup, applyDaemonToolOutputOptions } from "./daemonCore/DaemonStartup";
import { DaemonIdentity } from "./daemonCore/DaemonIdentity";
import { DaemonStreams } from "./daemonCore/DaemonStreams";
import { DaemonMaintenance } from "./daemonCore/DaemonMaintenance";
import {
  DaemonDisconnect,
  type DaemonDisconnectHost,
  type CapturedDisconnectCleanup,
} from "./daemonCore/DaemonDisconnect";
import { DaemonShutdown } from "./daemonCore/DaemonShutdown";
import type {
  DaemonCoreServices,
  DaemonIdentityState,
  DaemonLifecycleState,
} from "./daemonCore/DaemonCoreState";
import type { DeviceSessionRoutingTargets } from "./daemonCore/DaemonStreams";

export type {
  DaemonDependencies,
  DaemonProcessBirthTimeProvider,
  DaemonProcessGenerationTokenProvider,
};

/** Server recording operations supplied by the daemon composition root. */
export interface DaemonRecordingHost {
  initializeRecordingTeardownRedriveState: typeof initializeRecordingTeardownRedriveState;
  listActiveVideoRecordings: typeof listActiveVideoRecordings;
  redriveUnconfirmedCaptureTeardowns: typeof redriveUnconfirmedCaptureTeardowns;
  setStartupOrphanCaptures: typeof setStartupOrphanCaptures;
  setVideoRecordingManagerDependencies: typeof setVideoRecordingManagerDependencies;
}

export function getProcessWideAdbServerResetCohort(
  bootedDeviceIds: ReadonlySet<string>,
  succeededPlatforms: ReadonlySet<Platform>,
  forceDisconnectedDeviceIds: ReadonlySet<string>,
  pooledDevices: readonly PooledDevice[],
): readonly PooledDevice[] {
  const ownedAndroidEmulators = pooledDevices.filter(
    (device) =>
      device.platform === "android" &&
      device.avdName !== undefined &&
      device.androidImage !== undefined &&
      device.id.startsWith("emulator-"),
  );
  if (
    !succeededPlatforms.has("android") ||
    ownedAndroidEmulators.length < 2 ||
    !ownedAndroidEmulators.every((device) => !bootedDeviceIds.has(device.id)) ||
    !ownedAndroidEmulators.some((device) => forceDisconnectedDeviceIds.has(device.id))
  ) {
    return [];
  }
  return ownedAndroidEmulators;
}

export function isProcessWideAdbServerReset(
  bootedDeviceIds: ReadonlySet<string>,
  succeededPlatforms: ReadonlySet<Platform>,
  forceDisconnectedDeviceIds: ReadonlySet<string>,
  pooledDevices: readonly PooledDevice[],
): boolean {
  return (
    getProcessWideAdbServerResetCohort(
      bootedDeviceIds,
      succeededPlatforms,
      forceDisconnectedDeviceIds,
      pooledDevices,
    ).length > 0
  );
}

/**
 * The steps of `Daemon.start()` that touch the machine: the process's working directory and
 * signal handlers, the PID file, the data directory, listening sockets, and the monitors that
 * probe devices. `start()` runs the process's own; `Daemon.startOn()` runs a caller's, so a test
 * harness starts a daemon through the same sequence with nothing reaching the host (#11441).
 * Each step sits where `start()` has always run it.
 */
export interface DaemonStartHost {
  /** Synchronous self-exit policy record; fake hosts keep it in memory. */
  writeExitRecord(record: DaemonExitRecord): void;
  /** Logging, the stable working directory and the shutdown handlers. */
  enterProcess(): void;
  /** Name this daemon's control socket in the CtrlProxy forwarding leases it takes (#10497). */
  publishForwardLeaseOwner(): void;
  /** Publish the owned database path in the PID file before the database opens (#2871). */
  writeEarlyOwnerRecord(): Promise<void>;
  /** This daemon's terminal-release journal, with dead daemons' intents adopted (#10959). */
  openTerminalReleaseJournal(
    owner: Pick<DaemonTerminalReleaseJournalOptions, "daemonSessionId" | "liveDaemonSessionIds">,
  ): TerminalReleaseJournal;
  /** The AVD provenance warm-up, port selection and the HTTP MCP listener. */
  startHttpIngress(): Promise<void>;
  /** Drop per-session appearance rows no rehydrated or recoverable session owns (#10976). */
  sweepStaleAppearanceConfigs(rehydration: RehydrationSummary): Promise<void>;
  /** Mark unconfirmed recorders before sessions can bind; never await background recovery. */
  redriveRecorderTeardowns(): Promise<boolean>;
  /** Create the control socket server over this daemon's state and start accepting clients. */
  bindControlSocket(): Promise<DaemonSocketServer>;
  /** Auxiliary sockets, device monitors, the PID file and the health check. */
  startServicesAfterSocketBind(): Promise<void>;
  /** Navigation retention, forwarding-lease idle release, the orphan watchdog and broker reclaim. */
  startMaintenanceMonitors(): void;
}

/**
 * Pick the daemon's HTTP port: the preferred port first, then each higher port up to
 * `DAEMON_PORT_RANGE_END`. The scan never goes below the preferred port, so a daemon started
 * on a non-default port can never take `DEFAULT_DAEMON_PORT`, the port the shared daemon's
 * restart insists on (`strictPort`). A preferred port outside the
 * `DAEMON_PORT_RANGE_START`-`DAEMON_PORT_RANGE_END` range has no fallback.
 */
export async function findAvailableDaemonPort(
  preferredPort: number,
  isPortAvailable: (port: number) => Promise<boolean>,
): Promise<number> {
  if (await isPortAvailable(preferredPort)) {
    return preferredPort;
  }
  const inRange =
    preferredPort >= DAEMON_PORT_RANGE_START && preferredPort <= DAEMON_PORT_RANGE_END;
  const fallbacks = inRange
    ? Array.from(
        { length: DAEMON_PORT_RANGE_END - preferredPort },
        (_, index) => preferredPort + 1 + index,
      )
    : [];
  for (const port of fallbacks) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  if (!inRange) {
    throw new Error(
      `Port ${preferredPort} is not available (outside the fallback range ${DAEMON_PORT_RANGE_START}-${DAEMON_PORT_RANGE_END})`,
    );
  }
  throw new Error(
    fallbacks.length === 0
      ? `Port ${preferredPort} is not available (no higher port in the fallback range ${DAEMON_PORT_RANGE_START}-${DAEMON_PORT_RANGE_END})`
      : `No available ports in range ${preferredPort}-${DAEMON_PORT_RANGE_END}`,
  );
}

// These expiry-sensitive readers retain their original function owners for the getSession inventory.
// Callers inject live ports so instance replacements and lazy expiry remain observable.
async function warmConfirmedManagedExecution(
  host: Pick<DaemonBrokerHost, "services" | "lifecycle">,
  sessionUuid: string,
): Promise<void> {
  const session = host.services.sessionManager().getSession(sessionUuid);
  if (
    host.lifecycle.shutdownInProgress() ||
    !session ||
    !host.services.sessionManager().isLiveManagedExecutionSession(sessionUuid)
  ) {
    return;
  }
  const deviceId = session.assignedDevice;
  const devices = selectIosStartupWarmupDevices(
    [{ id: deviceId, platform: session.platform }],
    host.services.passiveWorkPolicy(),
  );
  if (
    devices.length === 0 ||
    host.services.sessionManager().getSessionForDevice(deviceId) !== sessionUuid
  ) {
    return;
  }
  await initializeIosCtrlProxyAtStartup([deviceId], {
    timer: host.services.timer(),
    perDeviceTimeoutMs: 5000,
    pendingPrefetch: () => IosCtrlProxyBuilder.pendingPrefetch(),
    isShuttingDown: () => host.lifecycle.shutdownInProgress(),
    verifyIosDevice: async (id, options) => {
      if (
        !host.lifecycle.shutdownInProgress() &&
        host.services.sessionManager().isLiveManagedExecutionSession(sessionUuid) &&
        host.services.sessionManager().getSession(sessionUuid)?.assignedDevice === id &&
        host.services.sessionManager().getSessionForDevice(id) === sessionUuid &&
        host.lifecycle.managedExecutionReowner()?.ownershipState(sessionUuid) === undefined
      ) {
        await host.services.iosDeviceVerifier()().verifyIosDevice(id, options);
      }
    },
  });
}

function captureDisconnectCleanup(
  host: Pick<DaemonDisconnectHost, "services" | "forceDisconnectedDeviceGenerations">,
  deviceId: string,
  adbServerResetCohortByDeviceId: Map<string, PooledDevice>,
): CapturedDisconnectCleanup {
  const pooledDeviceAtDisconnect = host.services.devicePool().getDevice(deviceId);
  const assignmentCountAtDisconnect = pooledDeviceAtDisconnect?.assignmentCount;
  const sessionIdAtDisconnect =
    holderOf(pooledDeviceAtDisconnect) ??
    host.services.sessionManager().getSessionForDevice(deviceId);
  const sessionAtDisconnect = sessionIdAtDisconnect
    ? host.services.sessionManager().getSession(sessionIdAtDisconnect)
    : null;
  const forceGenerationAtDisconnect = host.forceDisconnectedDeviceGenerations().get(deviceId);
  const adbServerResetTarget = adbServerResetCohortByDeviceId.get(deviceId);
  return {
    pooledDeviceAtDisconnect,
    assignmentCountAtDisconnect,
    sessionIdAtDisconnect,
    sessionAtDisconnect,
    forceGenerationAtDisconnect,
    adbServerResetTarget,
  };
}

function isCapturedDisconnectTargetCurrent(
  host: Pick<DaemonDisconnectHost, "services">,
  deviceId: string,
  pooledDeviceAtDisconnect: PooledDevice | null,
  assignmentCountAtDisconnect: number | undefined,
  sessionIdAtDisconnect?: string | null,
  sessionAtDisconnect?: Session | null,
): boolean {
  if (pooledDeviceAtDisconnect) {
    if (
      host.services.devicePool().getDevice(deviceId) !== pooledDeviceAtDisconnect ||
      pooledDeviceAtDisconnect.assignmentCount !== assignmentCountAtDisconnect
    ) {
      return false;
    }
  } else if (host.services.devicePool().getDevice(deviceId)) {
    return false;
  }

  if (!sessionIdAtDisconnect) {
    return host.services.sessionManager().getSessionForDevice(deviceId) === null;
  }
  return (
    host.services.sessionManager().getSessionForDevice(deviceId) === sessionIdAtDisconnect &&
    host.services.sessionManager().getSession(sessionIdAtDisconnect) === sessionAtDisconnect
  );
}

function persistedSessionReaders(repository: () => DaemonDeviceSessionStore) {
  return {
    getSession: (uuid: string) => repository().getSession(uuid),
    getPersistedSession: (uuid: string) => repository().getSession(uuid),
  };
}

/**
 * Main daemon process
 *
 * Combines:
 * - MCP server in Streamable HTTP mode
 * - Unix socket server for CLI communication
 * - PID file management
 * - Graceful shutdown handling
 */
export class Daemon {
  private pidFileWritten: boolean = false;
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

  private readonly httpServerFactory: () => HttpListener;

  private readonly liveDaemonSessionIdProvider: LiveDaemonSessionIdProvider;

  private readonly avdManagerFactory: () => Pick<AvdManager, "listDeviceImages">;

  private readonly iosDeviceVerifier: () => Pick<DeviceReadiness, "verifyIosDevice">;

  private readonly bindingExclusionFactory: (timer: Timer) => BindingExclusion;

  private readonly foreignCtrlProxyForwardEvidence?: ForeignCtrlProxyForwardEvidence;

  // One probe lifetime shared by all MCP connections and daemon doctor calls.
  private readonly iosDoctorDependencies = createIosDoctorDependencies({
    coreDeviceProbe: createProductionCoreDeviceProbe(),
  });

  private socketServer: DaemonSocketServer | null = null;

  private exitRecordFileSystem: DaemonExitRecordFileSystem = defaultDaemonExitRecordFileSystem;

  private enteredDaemonProcess = false;
  private startHost!: DaemonStartHost;

  private readonly selfExitRecorder = new DaemonSelfExitRecorder({
    write: (record) => this.startHost.writeExitRecord(record),
    now: () => this.timer.now(),
    buildId: () => getCurrentBuildIdentity().buildId,
    options: () => ({ ...daemonProcessOptions(this.options), port: this.port }),
    canRecord: () =>
      this.enteredDaemonProcess &&
      (this.socketBindCommitted || !this.incumbentOwnerGuard.hasLiveForeignOwner()),
  });

  private readonly startupCompletion: Promise<void>;

  private resolveStartupCompletion!: () => void;

  private rejectStartupCompletion!: (reason: unknown) => void;

  private readonly httpIngress = new DaemonHttpIngress({
    httpServerFactory: () => this.httpServerFactory(),
    timer: () => this.timer,
    idGenerator: () => this.idGenerator,
    address: () => ({ host: this.host, port: this.port }),
    strictPort: () => this.strictPort,
    startupCompletion: () => this.startupCompletion,
    sessionManager: () => this.sessionManager,
    observerSessionRegistry: () => this.observerSessionRegistry,
    createRequestMcpServer: (req, scope) => this.createRequestMcpServer(req, scope),
    isShutdownInProgress: () => this.shutdownInProgress,
  });

  /** Runs control-socket forwards in process, one client and server each (#11820). */
  private readonly mcpDispatcher = createDaemonMcpDispatcher({
    base: () => this.statelessMcpServerBase(),
    idGenerator: { next: () => this.idGenerator.next() },
    closeReason: () =>
      this.shutdownInProgress
        ? new DaemonHandoffInterruptionError(DAEMON_HANDOFF_INTERRUPTED_MESSAGE)
        : MCP_FORWARD_CLOSED_REASON,
  });

  private port: number;

  private host: string;

  private readonly strictPort: boolean;

  private debug: boolean;

  private healthCheck: SingleFlightInterval | null = null;

  protected heartbeatMonitor: SessionHeartbeatMonitor | null = null;

  private navigationRetentionMonitor: NavigationRetentionMonitor | null = null;

  private forwardLeaseIdleReleaser: DeviceForwardLeaseIdleReleaser | null = null;

  private orphanWatchdog: PrivateDaemonOrphanWatchdog | null = null;

  protected deviceDisconnectMonitor: SingleFlightInterval | null = null;

  private deferredSessionRecoverySweeps: Set<Promise<void>> = new Set();

  private completeIdentityPublished = false;

  private socketBindCommitted = false;

  // Preserves a live incumbent daemon's PID record across our own early-owner
  // overwrite so the lock-less bind guard can (a) still see the live sibling on
  // an inconclusive probe and (b) restore its record if we refuse (issue #6232).
  private readonly incumbentOwnerGuard: IncumbentOwnerGuard;

  protected deviceDisconnectMisses: Map<string, number> = new Map();

  protected deviceDisconnectMissIncarnations = new Map<string, DisconnectCandidateIncarnation>();

  protected confirmedDisconnectedDeviceIds: Set<string> = new Set();

  protected forceDisconnectedDeviceIds: Set<string> = new Set();

  protected forceDisconnectedDeviceGenerations: Map<string, number> = new Map();

  // Serials that already had one bounded 'adb -s <serial> reconnect' this offline
  // episode (#7536). Pruned each sweep by pruneStaleOfflineRecoveryAttempts so
  // a later episode for the same serial gets a fresh attempt.
  protected offlineRecoveryAttemptedDeviceIds: Set<string> = new Set();

  protected offlineRecoveryAttemptedIncarnations = new Map<string, number | string>();

  // Start of each candidate's current transitional-state episode (#11090, #11592):
  // adb offline/unauthorized and simctl Booting/Shutting Down sweeps run against
  // OFFLINE_DEVICE_DISCONNECT_BUDGET_MS, not the miss count.
  protected offlineEpisodes = new Map<string, OfflineEpisode>();

  private observerSessionRegistry: ObserverSessionRegistry;

  private sessionManager: SessionManager;

  private devicePool: DevicePool;

  private deviceSessionRegistry: DeviceSessionRegistry;

  private daemonSessionId: string;

  private installedAppsRepository: InstalledAppsStore;

  private deviceSessionRepository: DaemonDeviceSessionStore;

  private timer: Timer;

  private bindingRegistry: Promise<SqliteBindingRegistry> | undefined;

  private sessionBrokerConfigPath = process.env[SESSION_BROKER_HOST_CONFIG_ENV]
    ? resolve(process.env[SESSION_BROKER_HOST_CONFIG_ENV]!)
    : undefined;

  protected brokerDeviceAcquisition: DaemonBrokerDeviceAcquisitionHandle | undefined;

  private managedExecutionReowner: ManagedExecutionReowner | undefined;

  private readonly generationStartedAt: number;

  private readonly processStartedAt: number;

  private readonly processGenerationToken: string | undefined;

  private readonly liveAcceptanceStartupSecret: string | undefined;

  private readonly passiveWorkPolicy: PassiveWorkPolicy;

  private idGenerator: IdGenerator;

  private databaseInitializer: DatabaseInitializer;

  private toolSelectionProfileProvenanceLoader: ToolSelectionProfileProvenanceLoader;

  private databaseHealthProbe: DatabaseHealthProbe;

  private startupFailureTracker: StartupFailureTracker;

  private recoverFromDatabaseHealthFailure: DatabaseHealthFailureRecovery;

  private lastDatabaseHealthFailure: string | undefined;

  private readonly stopManagedAdbServer: ManagedAdbServerShutdown;

  private observationStreamHealth: ObservationStreamHealth;

  protected deviceDataStreamServer: ReturnType<typeof getDeviceDataStreamServer> = null;

  protected readonly navigationGraphBridge = new NavigationGraphStreamBridge({
    server: () => this.deviceDataStreamServer,
    sessionIds: () => this.sessionManager.getAllSessions().map((session) => session.sessionId),
    defaultManager: () => NavigationGraphManager.getInstance(),
    managerForSession: (sessionId) => NavigationGraphManager.getInstanceForSession(sessionId),
  });

  protected unsubscribeAdbMissingDevice: (() => void) | null = null;

  private readonly deviceStateChangeNotifier: DeviceStateChangeNotifier;

  private options: DaemonOptions;

  private readonly acceptanceDiscoveryCapability = process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV];

  private shutdownInProgress: boolean = false;

  /** Redrives retained startup recorder descriptors when a device incarnation is assigned. */
  private recorderDeviceIncarnationListener?: (deviceId: string) => void;

  /** Session IDs whose normal callback emitted the daemon-shutdown reason. */
  private shutdownReleaseNotifications: Set<string> | null = null;

  /** Session IDs emitted by the shutdown fallback before their normal callback completed. */
  private shutdownFallbackReleaseNotifications: Set<string> | null = null;

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
    this.daemonState = retained.daemonState;
    this.httpServerFactory = retained.httpServerFactory;
    this.liveDaemonSessionIdProvider = retained.liveDaemonSessionIdProvider;
    this.avdManagerFactory = retained.avdManagerFactory;
    this.iosDeviceVerifier = retained.iosDeviceVerifier;
    this.bindingExclusionFactory = retained.bindingExclusionFactory;
    this.foreignCtrlProxyForwardEvidence = retained.foreignCtrlProxyForwardEvidence;
    installDefaultProvisionedDeviceTransportFence();
    this.startupCompletion = new Promise<void>((resolve, reject) => {
      this.resolveStartupCompletion = resolve;
      this.rejectStartupCompletion = reject;
    });
    // Startup can fail before the socket server exists or any request awaits it.
    void this.startupCompletion.then(
      () => {
        this.httpIngress.markStartupCompleted();
      },
      (error: unknown) => {
        logger.debug(`Daemon startup completion rejected: ${errorMessage(error)}`);
      },
    );
    this.options = { ...options };
    this.port = options.port || DEFAULT_DAEMON_PORT;
    // Prefer IPv4 loopback: Bun's fetch and Node's listen can disagree on "localhost" (::1 vs 127.0.0.1),
    // which surfaces as ConnectionRefused on the Unix-socket → Streamable HTTP MCP hop (common in Linux CI).
    this.host = options.host || "127.0.0.1";
    this.strictPort = options.strictPort ?? false;
    this.debug = options.debug || false;
    this.idGenerator = idGenerator;
    this.daemonSessionId = this.idGenerator.next();
    this.timer = timer;
    this.deviceStateChangeNotifier = createDeviceStateChangeNotifier({
      timer,
      invalidate: resetBootedDevicesResourceCache,
      notify: notifyBootedDeviceResourcesUpdated,
    });
    this.generationStartedAt = this.timer.now();
    this.processStartedAt = processBirthTime();
    this.processGenerationToken = processGenerationToken();
    this.incumbentOwnerGuard = incumbentOwnerGuard;
    this.liveAcceptanceStartupSecret = daemonLiveAcceptanceStartupSecret();
    // Even a malformed acceptance secret must not cause unsolicited simulator
    // launches. Capability validation remains strict in liveAcceptanceCapability.
    this.passiveWorkPolicy = new PassiveWorkPolicy(
      parsePassiveWorkSettings(process.env, DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV),
      (deviceId) =>
        this.sessionManager.getAllSessions().some((session) => session.assignedDevice === deviceId),
    );
    this.databaseInitializer = databaseInitializer;
    this.toolSelectionProfileProvenanceLoader = toolSelectionProfileProvenanceLoader;
    this.databaseHealthProbe = databaseHealthProbe;
    this.startupFailureTracker = startupFailureTracker;
    this.stopManagedAdbServer = managedAdbServerShutdown;
    this.recoverFromDatabaseHealthFailure =
      recoverFromDatabaseHealthFailure ??
      ((code, detail) =>
        exitAfterDatabaseHealthFailure(code, detail, {
          now: () => this.timer.now(),
          writeEmergency: (message) => writeEmergencyLog(message),
          writeExitRecord: () => this.selfExitRecorder.record("database-health"),
          cleanupDaemonFiles: () => {
            cleanupDaemonFilesSync(this.identity.getDaemonFileCleanupOptions());
          },
          closeLogger: () => logger.closeAfterFlush(),
          exit: (exitCode) => process.exit(exitCode),
        }));
    this.observationStreamHealth = new DefaultObservationStreamHealth({
      getServer: getDeviceDataStreamServer,
      stopServer: stopDeviceDataStreamSocketServer,
      startServer: async () => {
        await this.identity.startAuxiliarySocket("observation-stream", () =>
          startDeviceDataStreamSocketServer(this.timer),
        );
      },
      configureCallbacks: () => this.streams.configureDeviceDataStreamServer(),
    });
    this.deviceSessionRepository = deviceSessionRepository;
    this.sessionManager = new SessionManager(this.timer, this.deviceSessionRepository);
    this.sessionManager.attachDaemonSessionId(this.daemonSessionId);
    // Read when a recovery claims its row, so a peer that started after this daemon is seen. A
    // restart incumbent whose pid file this daemon replaced is not listed, so it is added while
    // it is still live: its rows and its terminal-release journal are not a dead daemon's (#11355).
    this.sessionManager.attachLiveDaemonSessionIds(() =>
      this.incumbentOwnerGuard.withLiveIncumbent(
        this.liveDaemonSessionIdProvider.collectLiveDaemonSessionIds(),
      ),
    );
    this.observerSessionRegistry = new ObserverSessionRegistry(
      this.timer,
      undefined,
      (sessionId) => {
        // An observer's per-session appearance config (#10976) dies with the observer.
        clearSessionAppearanceConfig(sessionId).catch((error: unknown) => {
          logger.warn(`[Appearance] Failed to drop config of observer ${sessionId}`, error);
        });
        // So do the viewer streams its registration admitted (#11076).
        ObserverReleaseBroadcaster.emit(sessionId);
      },
    );
    this.sessions.configureSessionLifecycleCallbacks();
    this.installedAppsRepository = installedAppsRepository ?? new InstalledAppsRepository();
    const recoveryConfiguration = parseDeviceRecoveryPolicy(recoveryPolicyEnvironment);
    for (const warning of recoveryConfiguration.warnings) {
      logger.warn(`[Daemon] ${warning}`);
    }
    logger.info(
      `[Daemon] Device recovery policy: onLoss=${recoveryConfiguration.policy.onLoss}, ` +
        `maxAttempts=${recoveryConfiguration.policy.maxAttempts}`,
    );
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

  private backgroundRegistryUpgrade: BackgroundBindingRegistryUpgrade | undefined;
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

  /** Build one request's MCP server from its headers (#4678 stateless, #11820). */
  private createRequestMcpServer(
    req: McpHttpRequestLike,
    scope: StatelessMcpRequestScope,
  ): ReturnType<typeof createStatelessMcpServer> {
    return createStatelessMcpServer(
      this.statelessMcpServerBase(),
      buildMcpRequestContext({ headers: req.headers }),
      scope,
    );
  }

  /** The daemon-wide options every request's MCP server is built with. */
  private statelessMcpServerBase(): StatelessMcpServerBase {
    return {
      iosDependencies: this.iosDoctorDependencies,
      debug: this.debug,
      acceptanceDiscoveryCapability: this.acceptanceDiscoveryCapability,
    };
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

      /** Installs (or clears) a socket server double whose members the shutdown path calls. */
      setSocketServer: (server: Partial<DaemonSocketServer> | null): void => {
        this.socketServer = server && daemonSocketServerDouble(server);
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
      deferredSessionRecoverySweeps: this.deferredSessionRecoverySweeps,
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
        this.socketBindCommitted = committed;
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
      bindingRegistry: () => daemon.bindingRegistry,
      setBindingRegistry: (value) => {
        daemon.bindingRegistry = value;
      },
      brokerDeviceAcquisition: () => daemon.brokerDeviceAcquisition,
      setBrokerDeviceAcquisition: (value) => (daemon.brokerDeviceAcquisition = value),
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
      bindingExclusionFactory: () => daemon.bindingExclusionFactory,
      foreignCtrlProxyForwardEvidence: () => daemon.foreignCtrlProxyForwardEvidence,
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
      initializeRecordingTeardownRedriveState: () => initializeRecordingTeardownRedriveState(),
      redriveUnconfirmedCaptureTeardowns: (...args) => redriveUnconfirmedCaptureTeardowns(...args),
      setStartupOrphanCaptures: (...args) => setStartupOrphanCaptures(...args),
      setVideoRecordingManagerDependencies: (...args) =>
        setVideoRecordingManagerDependencies(...args),
      enterDaemonProcess: (...args) => this.enterDaemonProcess(...args),
      startHttpIngress: (...args) => this.startHttpIngress(...args),
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
      enteredDaemonProcess: () => daemon.enteredDaemonProcess,
      setEnteredDaemonProcess: (value) => (daemon.enteredDaemonProcess = value),
      resolveStartupCompletion: () => daemon.resolveStartupCompletion,
      rejectStartupCompletion: () => daemon.rejectStartupCompletion,
      exitRecordFileSystem: () => daemon.exitRecordFileSystem,
      strictPort: () => daemon.strictPort,
      host: () => daemon.host,
      startupFailureTracker: () => daemon.startupFailureTracker,
      avdManagerFactory: () => daemon.avdManagerFactory,
      databaseInitializer: () => daemon.databaseInitializer,
      toolSelectionProfileProvenanceLoader: () => daemon.toolSelectionProfileProvenanceLoader,
      liveDaemonSessionIdProvider: () => daemon.liveDaemonSessionIdProvider,
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
      pidFileWritten: () => this.pidFileWritten,
      setPidFileWritten: (value) => (this.pidFileWritten = value),
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
    const daemon = this;
    return new DaemonMaintenance({
      services,
      identity,
      lifecycle,
      healthCheck: () => daemon.healthCheck,
      setHealthCheck: (value) => (daemon.healthCheck = value),
      observationStreamHealth: () => daemon.observationStreamHealth,
      setObservationStreamHealth: (health) => (this.observationStreamHealth = health),
      lastDatabaseHealthFailure: () => daemon.lastDatabaseHealthFailure,
      setLastDatabaseHealthFailure: (value) => (daemon.lastDatabaseHealthFailure = value),
      recoverFromDatabaseHealthFailure: () => daemon.recoverFromDatabaseHealthFailure,
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
      listActiveVideoRecordings: (...args) => listActiveVideoRecordings(...args),
      captureDisconnectCleanup: (deviceId, cohort) =>
        captureDisconnectCleanup(
          {
            services,
            forceDisconnectedDeviceGenerations: () => this.forceDisconnectedDeviceGenerations,
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
      forceDisconnectedDeviceIds: () => daemon.forceDisconnectedDeviceIds,
      confirmedDisconnectedDeviceIds: () => daemon.confirmedDisconnectedDeviceIds,
      deviceDisconnectMissIncarnations: () => daemon.deviceDisconnectMissIncarnations,
      offlineEpisodes: () => daemon.offlineEpisodes,
      offlineRecoveryAttemptedDeviceIds: () => daemon.offlineRecoveryAttemptedDeviceIds,
      setOfflineRecoveryAttemptedDeviceIds: (value) =>
        (daemon.offlineRecoveryAttemptedDeviceIds = value),
      offlineRecoveryAttemptedIncarnations: () => daemon.offlineRecoveryAttemptedIncarnations,
      setOfflineRecoveryAttemptedIncarnations: (value) =>
        (daemon.offlineRecoveryAttemptedIncarnations = value),
      forceDisconnectedDeviceGenerations: () => daemon.forceDisconnectedDeviceGenerations,
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
      stopManagedAdbServer: () => daemon.stopManagedAdbServer,
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
      iosDeviceVerifier: () => daemon.iosDeviceVerifier,
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
      databaseHealthProbe: () => daemon.databaseHealthProbe,
      options: () => daemon.options,
      daemonState: () => daemon.daemonState,
    };
  }
  private createDaemonIdentityState(): DaemonIdentityState {
    const daemon = this;
    return {
      port: () => daemon.port,
      setPort: (value) => (daemon.port = value),
      completeIdentityPublished: () => daemon.completeIdentityPublished,
      setCompleteIdentityPublished: (value) => (daemon.completeIdentityPublished = value),
      socketBindCommitted: () => daemon.socketBindCommitted,
      setSocketBindCommitted: (value) => (daemon.socketBindCommitted = value),
      incumbentOwnerGuard: () => daemon.incumbentOwnerGuard,
      daemonSessionId: () => daemon.daemonSessionId,
      generationStartedAt: () => daemon.generationStartedAt,
      processStartedAt: () => daemon.processStartedAt,
      processGenerationToken: () => daemon.processGenerationToken,
      liveAcceptanceStartupSecret: () => daemon.liveAcceptanceStartupSecret,
      acceptanceDiscoveryCapability: () => daemon.acceptanceDiscoveryCapability,
    };
  }
  private createDaemonLifecycleState(): DaemonLifecycleState {
    const daemon = this;
    return {
      socketServer: () => daemon.socketServer,
      setSocketServer: (value) => (daemon.socketServer = value),
      selfExitRecorder: () => daemon.selfExitRecorder,
      startupCompletion: () => daemon.startupCompletion,
      heartbeatMonitor: () => daemon.heartbeatMonitor,
      setHeartbeatMonitor: (value) => (daemon.heartbeatMonitor = value),
      navigationRetentionMonitor: () => daemon.navigationRetentionMonitor,
      setNavigationRetentionMonitor: (value) => (daemon.navigationRetentionMonitor = value),
      forwardLeaseIdleReleaser: () => daemon.forwardLeaseIdleReleaser,
      setForwardLeaseIdleReleaser: (value) => (daemon.forwardLeaseIdleReleaser = value),
      orphanWatchdog: () => daemon.orphanWatchdog,
      setOrphanWatchdog: (value) => (daemon.orphanWatchdog = value),
      deviceDisconnectMonitor: () => daemon.deviceDisconnectMonitor,
      setDeviceDisconnectMonitor: (value) => (daemon.deviceDisconnectMonitor = value),
      deferredSessionRecoverySweeps: () => daemon.deferredSessionRecoverySweeps,
      deviceDisconnectMisses: () => daemon.deviceDisconnectMisses,
      sessionBrokerConfigPath: () => daemon.sessionBrokerConfigPath,
      managedExecutionReowner: () => daemon.managedExecutionReowner,
      setManagedExecutionReowner: (value) => (daemon.managedExecutionReowner = value),
      deviceDataStreamServer: () => daemon.deviceDataStreamServer,
      setDeviceDataStreamServer: (value) => (daemon.deviceDataStreamServer = value),
      navigationGraphBridge: () => daemon.navigationGraphBridge,
      unsubscribeAdbMissingDevice: () => daemon.unsubscribeAdbMissingDevice,
      setUnsubscribeAdbMissingDevice: (value) => (daemon.unsubscribeAdbMissingDevice = value),
      shutdownInProgress: () => daemon.shutdownInProgress,
      setShutdownInProgress: (value) => (daemon.shutdownInProgress = value),
      recorderDeviceIncarnationListener: () => daemon.recorderDeviceIncarnationListener,
      setRecorderDeviceIncarnationListener: (value) =>
        (daemon.recorderDeviceIncarnationListener = value),
      shutdownReleaseNotifications: () => daemon.shutdownReleaseNotifications,
      setShutdownReleaseNotifications: (value) => (daemon.shutdownReleaseNotifications = value),
      shutdownFallbackReleaseNotifications: () => daemon.shutdownFallbackReleaseNotifications,
      setShutdownFallbackReleaseNotifications: (value) =>
        (daemon.shutdownFallbackReleaseNotifications = value),
      backgroundRegistryUpgrade: () => daemon.backgroundRegistryUpgrade,
      setBackgroundRegistryUpgrade: (value) => (daemon.backgroundRegistryUpgrade = value),
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
  private startHttpIngress(...args: Parameters<DaemonStartup["startHttpIngress"]>) {
    return this.startup.startHttpIngress(...args);
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
  await daemon.start();
}
