import { getDaemonStreamDeviceLifecycleEmitter } from "./streamDeviceLifecycleEvents";
import { installDefaultProvisionedDeviceTransportFence } from "../db/createDefaultProvisionedDeviceTransportFence";
import { isSessionReleasing } from "./sessionReleaseState";
import { releaseSessionAndDevice } from "./releaseSessionAndDevice";
import { ambientExecutionIdReader } from "../server/deviceExecutionBinding";
import { ObserverSessionRegistry } from "./observerSessionRegistry";
import { DefaultObservationInitialFrameCoordinator } from "./observationInitialFrameCoordinator";
import { republishOwnedIdentity } from "./identityRecovery";
import {
  createServer as createHttpServer,
  Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { ActionableError } from "../models/ActionableError";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../server";
import { createProductionCoreDeviceProbe } from "../utils/ios-cmdline-tools/CoreDeviceProbeHolder";
import { createIosDoctorDependencies } from "../doctor/checks/ios";
import { logger } from "../utils/logger";
import { defaultDisplayInventoryProvider } from "../devices/DisplayInventoryProvider";
import {
  defaultLocationRouteRegistry,
  registerLocationRouteSessionCleanup,
  stopLocationRouteForRemovedDevice,
} from "../features/utility/LocationRoutePlayer";
import { defaultMockLocationClearRegistry } from "../features/utility/MockLocationClear";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { IOSCtrlProxyManager } from "../ctrlProxy/IOSCtrlProxyManager";
import { AndroidOfflineProbeError } from "../utils/android-cmdline-tools/AndroidEmulatorClient";
import { MultiPlatformDeviceManager } from "../devices/deviceUtils";
import { UnixSocketServer } from "./socketServer";
import { SessionManager, type ActiveSessionExecutionQuery, type Session } from "./sessionManager";
import { createDefaultStreamSocketAuthenticator } from "./streamSocketAuth";
import { SessionHeartbeatMonitor } from "./SessionHeartbeatMonitor";
import { PassiveWorkPolicy, parsePassiveWorkSettings } from "./PassiveWorkPolicy";
import { SingleFlightInterval } from "./SingleFlightInterval";
import { DevicePool, type PooledDevice } from "./devicePool";
import { isDeviceSessionContinuityEnabled, parseDeviceRecoveryPolicy } from "./poolConfig";
import { deviceLossCancellationReason } from "./emulatorLossIncident";
import { DaemonState } from "./daemonState";
import { DeviceSessionRegistry } from "./deviceSessionRegistry";
import {
  DEFAULT_DAEMON_PORT,
  SOCKET_PATH,
  MCP_STREAMABLE_PATH,
  DAEMON_SESSION_TOOL_BINDING_HEADER,
  DAEMON_RELEASED_SESSION_HEADER,
  DAEMON_TOOL_SELECTION_PROFILE_HEADER,
  DAEMON_PORT_RANGE_START,
  DAEMON_PORT_RANGE_END,
  DAEMON_LAUNCH_LOG_PATH_ENV,
  ACCEPTANCE_DISCOVERY_CAPABILITY_ENV,
  SESSION_RELEASE_DRAIN_TIMEOUT_MS,
} from "./constants";
import { DaemonOptions, PidFileData, type AuxiliaryDaemonSocketName } from "./types";
import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { PID_FILE_PATH, DAEMON_VERSION } from "./constants";
import { getCurrentBuildIdentity } from "./buildIdentity";
import {
  cleanupDaemonFiles,
  cleanupDaemonFilesSync,
  PidFileLiveDaemonSessionIdProvider,
  readPidFileDataSync,
  isProcessRunning,
  type LiveDaemonSessionIdProvider,
  writePidFileDataAtomic,
} from "./daemonFiles";
import { IncumbentOwnerGuard } from "./incumbentOwnerGuard";
import {
  DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV,
  daemonLiveAcceptanceStartupSecret,
} from "./liveAcceptanceCapability";
import { currentDaemonProcessGenerationToken } from "./processGeneration";
import { executionTracker } from "../server/executionTracker";
import {
  DAEMON_HANDOFF_INTERRUPTED_MESSAGE,
  DaemonHandoffInterruptionError,
} from "./daemonHandoffInterruption";
import { SessionReleaseBroadcaster } from "../server/sessionReleaseBroadcast";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import {
  awaitInFlightMigrations,
  closeDatabase,
  getDatabase,
  getDatabasePath,
  getDbWriteBarrier,
} from "../db";
import { NavigationRetention } from "../db/navigationRetention";
import { NavigationRetentionMonitor } from "./NavigationRetentionMonitor";
import { DefaultFileSystem } from "../utils/filesystem/DefaultFileSystem";
import { DatabaseInitializer, DefaultDatabaseInitializer } from "../db/DatabaseInitializer";
import { DatabaseHealthProbe, DefaultDatabaseHealthProbe } from "../db/DatabaseHealthProbe";
import { StartupFailureTracker, DefaultStartupFailureTracker } from "./DaemonStartupFailureTracker";
import { handleFatalDatabaseStartupFailure } from "./daemonStartupGuard";
import { runStartupPrologue } from "./startupPrologue";
import { createDaemonFatalProcessHandler } from "./daemonFatalHandler";
import { startupBenchmark } from "../utils/startupBenchmark";
import {
  startVideoRecordingSocketServer,
  stopVideoRecordingSocketServer,
} from "./videoRecordingSocketServer";
import {
  startTestRecordingSocketServer,
  stopTestRecordingSocketServer,
} from "./testRecordingSocketServer";
import {
  startDeviceSnapshotSocketServer,
  stopDeviceSnapshotSocketServer,
} from "./deviceSnapshotSocketServer";
import { startAppearanceSocketServer, stopAppearanceSocketServer } from "./appearanceSocketServer";
import {
  startPerformanceStreamSocketServer,
  stopPerformanceStreamSocketServer,
} from "./performanceStreamSocketServer";
import {
  startPerformancePushSocketServer,
  stopPerformancePushSocketServer,
  getPerformancePushServer,
} from "./performancePushSocketServer";
import {
  startDeviceDataStreamSocketServer,
  stopDeviceDataStreamSocketServer,
  getDeviceDataStreamServer,
  type DeviceDataStreamSocketServer,
} from "./deviceDataStreamSocketServer";
import {
  OBSERVATION_BATCH_HEADROOM_MS,
  PER_DEVICE_OBSERVATION_TIMEOUT_MS,
  runObservationRequestBatch,
} from "./observationRequestBatch";
import {
  startFailuresStreamSocketServer,
  stopFailuresStreamSocketServer,
} from "./failuresStreamSocketServer";
import {
  startFailuresPushSocketServer,
  stopFailuresPushSocketServer,
  getFailuresPushServer,
} from "./failuresPushSocketServer";
import {
  startTelemetryPushSocketServer,
  stopTelemetryPushSocketServer,
  getTelemetryPushServer,
} from "./telemetryPushSocketServer";
import { createRegistryDeviceSessionResolver } from "./deviceSessionResolver";
import {
  startWebRtcStreamSocketServer,
  stopWebRtcStreamSocketServer,
} from "./webrtcStreamSocketServer";
import {
  startVideoStreamSocketServer,
  stopVideoStreamSocketServer,
} from "./videoStreamSocketServer";
import { getDaemonSocketPathsByName } from "./socketPaths";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import {
  pushInitialObservationFramesForSubscriber,
  type ObservationStreamIosClient,
} from "./observationInitialFrame";
import {
  LEGACY_PROVENANCE_SENTINEL,
  NavigationGraphManager,
} from "../features/navigation/NavigationGraphManager";
import {
  convertSummaryToStreamData,
  createNavigationGraphRequestHandler,
} from "./navigationGraphRequestHandler";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import type { InstalledAppsStore } from "../db/installedAppsRepository";
import { InstalledAppsRepository } from "../db/installedAppsRepository";
import { DeviceSessionRepository } from "../db/deviceSessionRepository";
import { EmulatorLossIncidentRepository } from "../db/emulatorLossIncidentRepository";
import { DeviceSessionManager } from "../devices/DeviceSessionManager";
import { IosCtrlProxyBuilder } from "../ctrlProxy/IosCtrlProxyBuilder";
import { initializeIosCtrlProxyAtStartup, selectIosStartupWarmupDevices } from "./iosStartupInit";
import { selectObservationStreamDevices } from "./observationInitialFrame";
import {
  startAppearanceSyncScheduler,
  syncAppearanceForDevice,
  stopAppearanceSyncScheduler,
} from "./AppearanceSyncScheduler";
import {
  startPerformanceMonitor,
  stopPerformanceMonitor,
  getPerformanceMonitor,
} from "../features/performance/PerformanceMonitor";
import {
  interruptVideoRecording,
  listActiveVideoRecordings,
  stopVideoRecording,
} from "../server/videoRecordingManager";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { IdGenerator, defaultIdGenerator } from "../utils/IdGenerator";
import { AndroidAvdProvenanceCache } from "../utils/AndroidAvdProvenanceCache";
import { AvdManagerService } from "../utils/android-cmdline-tools/AvdManagerService";
import type { AvdManager } from "../utils/android-cmdline-tools/interfaces/AvdManager";
import {
  evaluateDeviceDisconnects,
  pruneStaleOfflineRecoveryAttempts,
  recordingCandidateIncarnations,
  selectOfflineRecoveryCandidates,
  type DisconnectCandidateIncarnation,
} from "./disconnectMonitor";
import { MISSING_DEVICE_MISS_THRESHOLD } from "./missingDeviceLiveness";
import { describeUnknownError, errorMessage } from "../utils/describeUnknownError";
import { FeatureFlagService } from "../features/featureFlags/FeatureFlagService";
import { serverConfig } from "../utils/ServerConfig";
import { setDebugPerfEnabled } from "../utils/PerformanceTracker";
import {
  installProcessLifecycleHandlers,
  setFatalProcessHandler,
  setProcessShutdownHandler,
} from "../processLifecycle";
import type { BootedDevice, Platform } from "../models";
import {
  DAEMON_LAUNCH_CWD_ENV,
  safeProcessCwd,
  resolveStableDaemonWorkingDirectory,
  normalizeCoreSimulatorDeviceSetPathEnv,
} from "../utils/workingDirectory";
import { resolveAssetVersion, resolvePinnedVersion } from "../constants/release";
import {
  DefaultObservationStreamHealth,
  type ObservationStreamHealth,
} from "./ObservationStreamHealth";
import { onAdbMissingDevice } from "../utils/android-cmdline-tools/AdbDeviceHealth";
import { stopManagedAdbServer } from "../utils/android-cmdline-tools/AdbServerLifecycle";
import { iosSimulatorCaptureHelperPool } from "../features/screen-stream";
import { runShutdownCleanupStages } from "../shutdownCleanup";
import { cleanupDaemonChildProcesses } from "./childProcessCleanup";
import {
  defaultToolSelectionProfileRegistry,
  type ToolSelectionProfileProvenanceLoader,
} from "../server/toolSelectionProfileRegistry";

const HTTP_BODY_TIMEOUT_MS = 60_000;
const HTTP_BODY_MAX_BYTES = 256 * 1024 * 1024;
const HTTP_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;

type HttpBodyResult = { ok: true; body: string } | { ok: false; status: number; error: string };

const DEVICE_DISCONNECT_POLL_INTERVAL_MS = 5000;
const DEVICE_DISCONNECT_MISS_THRESHOLD = MISSING_DEVICE_MISS_THRESHOLD;
// Retain plan-time evidence while requiring two inactive observations before cleanup.
const PLAN_DEVICE_DISCONNECT_MISS_CAP = DEVICE_DISCONNECT_MISS_THRESHOLD - 2;
const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
// Upper bound on how long graceful shutdown waits for in-flight best-effort DB
// writes to quiesce before closing the connection (issue #2792). Best-effort
// writes are best-effort: if the bound elapses, shutdown proceeds anyway.
const DB_WRITE_DRAIN_TIMEOUT_MS = 1_000;
const DEVICE_CLEANUP_SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
const DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS = 1_000;

// Ceiling on awaiting an in-flight cold-start migration before closing the DB on
// shutdown (issue #3044). A SIGTERM arriving mid-startup-migration would otherwise
// let the detached migration connection's writes/checkpoint contend with the
// closing app connection (Windows busy_timeout stall). Bounded: a wedged migration
// cannot itself hang shutdown — the timeout wins and shutdown proceeds anyway.
const MIGRATION_SETTLE_TIMEOUT_MS = 5_000;

type HealthFailureKind = "http" | "socket" | "database" | "unknown";
type DatabaseHealthFailureRecovery = (code: number) => void | Promise<void>;
type ManagedAdbServerShutdown = () => Promise<void>;
type DeviceSessionRoutingTargets = {
  deviceDataStream: ReturnType<typeof getDeviceDataStreamServer>;
  performancePush: ReturnType<typeof getPerformancePushServer>;
  failuresPush: ReturnType<typeof getFailuresPushServer>;
  telemetryPush: ReturnType<typeof getTelemetryPushServer>;
};

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
 * Main daemon process
 *
 * Combines:
 * - MCP server in Streamable HTTP mode
 * - Unix socket server for CLI communication
 * - PID file management
 * - Graceful shutdown handling
 */
/** Completes the FUNNEL 2 refusal: "Refusing `<purpose>` on device '<serial>'". */
const STORAGE_WATCH_PURPOSE = "to watch stored values";

export type DaemonProcessBirthTimeProvider = () => number;
export type DaemonProcessGenerationTokenProvider = () => string | undefined;

/**
 * Captures a wall-clock approximation of this OS process's birth time, rather
 * than the later point at which daemon bootstrap constructs its generation.
 * `process.uptime()` is rooted at process creation, so it remains comparable to
 * the process-table birth timestamps read by DaemonManager.
 */
function defaultDaemonProcessBirthTime(): number {
  return Date.now() - Math.max(0, process.uptime() * 1_000);
}

interface CapturedDisconnectRecoveryOptions {
  deviceId: string;
  incidentId: string | undefined;
  pooledDevice: PooledDevice | null | undefined;
  sessionId: string | null | undefined;
  session: Session | null;
  forceGeneration: number | undefined;
  preparation?: ReturnType<DevicePool["prepareSessionPreservingRecovery"]>;
}

export class Daemon {
  // One probe lifetime shared by all MCP connections and daemon doctor calls.
  private readonly iosDoctorDependencies = createIosDoctorDependencies({
    coreDeviceProbe: createProductionCoreDeviceProbe(),
  });
  private httpServer: HttpServer | null = null;
  private httpServerClosePromise: Promise<void> | null = null;
  private socketServer: UnixSocketServer | null = null;
  private readonly startupCompletion: Promise<void>;
  private resolveStartupCompletion!: () => void;
  private rejectStartupCompletion!: (reason: unknown) => void;
  private transports: Map<string, StreamableHTTPServerTransport> = new Map();
  private readonly httpSessionIdleTimers = new Map<string, NodeJS.Timeout>();
  private readonly activeHttpRequests = new Map<string, number>();
  private acceptingHttpSessions = false;
  private port: number;
  private host: string;
  private readonly strictPort: boolean;
  private debug: boolean;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private heartbeatMonitor: SessionHeartbeatMonitor | null = null;
  private navigationRetentionMonitor: NavigationRetentionMonitor | null = null;
  private deviceDisconnectMonitor: SingleFlightInterval | null = null;
  private deferredSessionRecoverySweeps: Set<Promise<void>> = new Set();
  private pidFileWritten = false;
  private completeIdentityPublished = false;
  private socketBindCommitted = false;
  private readonly boundAuxSocketIdentities = new Map<string, { dev: number; ino: number }>();
  // Preserves a live incumbent daemon's PID record across our own early-owner
  // overwrite so the lock-less bind guard can (a) still see the live sibling on
  // an inconclusive probe and (b) restore its record if we refuse (issue #6232).
  private readonly incumbentOwnerGuard: IncumbentOwnerGuard;
  private deviceDisconnectMisses: Map<string, number> = new Map();
  private deviceDisconnectMissIncarnations: Map<string, DisconnectCandidateIncarnation> = new Map();
  private confirmedDisconnectedDeviceIds: Set<string> = new Set();
  private forceDisconnectedDeviceIds: Set<string> = new Set();
  private forceDisconnectedDeviceGenerations: Map<string, number> = new Map();
  // Serials that already had one bounded 'adb reconnect offline' this offline
  // episode (#7536). Pruned each sweep by pruneStaleOfflineRecoveryAttempts so
  // a later episode for the same serial gets a fresh attempt.
  private offlineRecoveryAttemptedDeviceIds: Set<string> = new Set();
  private offlineRecoveryAttemptedIncarnations = new Map<string, number | string>();
  private stoppingRecordings: Set<string> = new Set();
  private observerSessionRegistry: ObserverSessionRegistry;
  private sessionManager: SessionManager;
  private devicePool: DevicePool;
  private deviceSessionRegistry: DeviceSessionRegistry;
  private daemonSessionId: string;
  private installedAppsRepository: InstalledAppsStore;
  private deviceSessionRepository: DeviceSessionRepository;
  private timer: Timer;
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
  private readonly stopManagedAdbServer: ManagedAdbServerShutdown;
  private observationStreamHealth: ObservationStreamHealth;
  private readonly initialFrameCoordinators = new WeakMap<
    NonNullable<ReturnType<typeof getDeviceDataStreamServer>>,
    DefaultObservationInitialFrameCoordinator
  >();
  private deviceDataStreamServer: ReturnType<typeof getDeviceDataStreamServer> = null;
  private readonly navigationGraphListenerManagers = new WeakSet<NavigationGraphManager>();
  private readonly navigationGraphSeededStreamManagers = new WeakMap<
    DeviceDataStreamSocketServer,
    WeakSet<NavigationGraphManager>
  >();
  private unsubscribeAdbMissingDevice: (() => void) | null = null;
  private options: DaemonOptions;
  private readonly acceptanceDiscoveryCapability = process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV];
  private shutdownHandlersRegistered: boolean = false;
  private shutdownInProgress: boolean = false;
  private shutdownSessionReleasesDrained = true;
  /** Session IDs whose normal callback emitted the daemon-shutdown reason. */
  private shutdownReleaseNotifications: Set<string> | null = null;
  /** Session IDs emitted by the shutdown fallback before their normal callback completed. */
  private shutdownFallbackReleaseNotifications: Set<string> | null = null;
  /** Identities captured before concurrent shutdown release begins. */
  private shutdownSessionIds: string[] = [];
  /** Exposed for tests only: the in-flight or settled startup provenance warm. */
  private androidAvdProvenanceWarmPromise: Promise<unknown> | undefined;

  constructor(
    options: DaemonOptions = {},
    installedAppsRepository?: InstalledAppsStore,
    timer: Timer = defaultTimer,
    deviceSessionRepository: DeviceSessionRepository = new DeviceSessionRepository(
      undefined,
      timer,
    ),
    idGenerator: IdGenerator = defaultIdGenerator,
    databaseInitializer: DatabaseInitializer = new DefaultDatabaseInitializer(),
    startupFailureTracker: StartupFailureTracker = new DefaultStartupFailureTracker(),
    databaseHealthProbe: DatabaseHealthProbe = new DefaultDatabaseHealthProbe({ timer }),
    recoverFromDatabaseHealthFailure?: DatabaseHealthFailureRecovery,
    recoveryPolicyEnvironment: NodeJS.ProcessEnv = process.env,
    managedAdbServerShutdown: ManagedAdbServerShutdown = stopManagedAdbServer,
    toolSelectionProfileProvenanceLoader: ToolSelectionProfileProvenanceLoader = defaultToolSelectionProfileRegistry,
    private readonly httpServerFactory: () => HttpServer = () => createHttpServer(),
    processBirthTime: DaemonProcessBirthTimeProvider = defaultDaemonProcessBirthTime,
    processGenerationToken: DaemonProcessGenerationTokenProvider = currentDaemonProcessGenerationToken,
    private readonly liveDaemonSessionIdProvider: LiveDaemonSessionIdProvider = new PidFileLiveDaemonSessionIdProvider(),
    incumbentOwnerGuard: IncumbentOwnerGuard = new IncumbentOwnerGuard(),
    private readonly avdManagerFactory: () => Pick<AvdManager, "listDeviceImages"> = () =>
      new AvdManagerService(),
  ) {
    installDefaultProvisionedDeviceTransportFence();
    this.startupCompletion = new Promise<void>((resolve, reject) => {
      this.resolveStartupCompletion = resolve;
      this.rejectStartupCompletion = reject;
    });
    // Startup can fail before the socket server exists or any request awaits it.
    void this.startupCompletion.catch((error: unknown) => {
      logger.debug(`Daemon startup completion rejected: ${errorMessage(error)}`);
    });
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
      (async (code) => {
        cleanupDaemonFilesSync(this.getDaemonFileCleanupOptions());
        try {
          await logger.closeAfterFlush();
        } finally {
          process.exit(code);
        }
      });
    this.observationStreamHealth = new DefaultObservationStreamHealth({
      getServer: getDeviceDataStreamServer,
      stopServer: stopDeviceDataStreamSocketServer,
      startServer: async () => {
        await this.startAuxiliarySocket("observation-stream", () =>
          startDeviceDataStreamSocketServer(this.timer),
        );
      },
      configureCallbacks: () => this.configureDeviceDataStreamServer(),
    });
    this.deviceSessionRepository = deviceSessionRepository;
    this.sessionManager = new SessionManager(this.timer, this.deviceSessionRepository);
    this.observerSessionRegistry = new ObserverSessionRegistry(this.timer);
    this.configureSessionLifecycleCallbacks();
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
    this.devicePool = this.createDevicePool(
      recoveryConfiguration.policy,
      recoveryPolicyEnvironment,
    );
    executionTracker.setAutolockSessionResolver({
      autolockSessionForMcpSession: (mcpSessionId) =>
        this.devicePool.captureAutolockSessionForMcpSession(mcpSessionId),
    });
    // Initialize singleton for daemon state access
    DaemonState.getInstance().initialize(
      this.sessionManager,
      this.devicePool,
      this.deviceSessionRegistry,
      this.observerSessionRegistry,
    );

    this.applyRuntimeOptions(options);
    this.applyAccessibilityOptions(options);
    this.applyToolOutputOptions(options);
  }

  private createDevicePool(
    recoveryPolicy: ReturnType<typeof parseDeviceRecoveryPolicy>["policy"],
    recoveryPolicyEnvironment: NodeJS.ProcessEnv,
  ): DevicePool {
    return DevicePool.create({
      sessionManager: this.sessionManager,
      daemonSessionId: this.daemonSessionId,
      timer: this.timer,
      missingDeviceMisses: this.deviceDisconnectMisses,
      installedAppsRepository: this.installedAppsRepository,
      deviceSessionRepository: this.deviceSessionRepository,
      releaseSessionForDisconnectedDevice: (sessionId, _deviceId, releaseReason, shouldCommit) =>
        this.cancelAndReleaseSession(sessionId, releaseReason, false, undefined, shouldCommit, {
          deferFailureFallback: true,
        }),
      onDeviceReady: (deviceId) => this.onDeviceReadyForSessionRegistry(deviceId),
      recoveryPolicy: recoveryPolicy,
      onDeviceFramesInvalidated: (deviceId) => {
        // Full: pool callbacks signal new incarnations or untrusted runtime identity.
        this.deviceDataStreamServer?.invalidateDeviceFrames(deviceId);
        getDaemonStreamDeviceLifecycleEmitter().deviceIdentityChanged(deviceId);
      },
      onDeviceRemoved: (deviceId, platform) => {
        getDaemonStreamDeviceLifecycleEmitter().deviceRemoved(deviceId);
        stopLocationRouteForRemovedDevice(deviceId);
        defaultMockLocationClearRegistry.retireDevice(deviceId);
        defaultDisplayInventoryProvider.invalidate(deviceId);
        DeviceSessionManager.getInstance().clearExplicitDevicePin(deviceId);
        this.deviceSessionRegistry.onDeviceDisconnected(deviceId);
        // Full removal: prune AFTER epoch retirement, which also invalidates frames.
        this.deviceDataStreamServer?.removeDeviceFrames(deviceId);
        if (platform === "ios") {
          const manager = IOSCtrlProxyManager.getExistingInstance(deviceId);
          void manager?.suspendForDeviceRemoval().catch((error) => {
            logger.warn(
              `[Daemon] Failed to stop iOS CtrlProxy for removed device ${deviceId}: ${errorMessage(error)}`,
            );
          });
        }
      },
      emulatorLossIncidentStore: new EmulatorLossIncidentRepository(this.timer, this.idGenerator),
      ambientExecutionIdReader,
      cancelDeviceSessionExecutions: Object.assign(
        (sessionId: string, reason: string, options?: { excludeExecutionId?: string }) =>
          this.cancelAndDrainDeviceSessionExecutions(sessionId, reason, options),
        {
          cancelDeviceExecutions: (
            deviceId: string,
            reason: string,
            options?: { excludeExecutionId?: string },
          ) => this.cancelAndDrainDeviceExecutions(deviceId, reason, options),
        },
      ),
      idGenerator: this.idGenerator,
      deviceSessionContinuityEnabled: isDeviceSessionContinuityEnabled(recoveryPolicyEnvironment),
    });
  }

  private configureSessionLifecycleCallbacks(): void {
    registerLocationRouteSessionCleanup(this.sessionManager);
    this.sessionManager.onDeviceOwnershipChange((deviceId, frameInvalidation) => {
      // Generation only for unchanged-screen acquire/release; full for runtime-changing rebinds.
      if (frameInvalidation === "full") {
        this.deviceDataStreamServer?.invalidateDeviceFrames(deviceId);
      } else {
        this.deviceDataStreamServer?.invalidateInitialDeviceFrames(deviceId);
      }
    });
    this.sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
      this.hasActiveSessionExecution(sessionId, query),
    );
    this.sessionManager.onSessionCreated((session) => {
      NavigationGraphManager.clearReleasedSession(session.sessionId);
      this.setupNavigationGraphUpdateListener(
        NavigationGraphManager.getInstanceForSession(session.sessionId),
      );
      if (this.passiveWorkPolicy.allows("android", "appearance-sync", session.assignedDevice)) {
        const device = this.devicePool.getDevice(session.assignedDevice);
        if (device?.platform === "android") {
          void syncAppearanceForDevice({
            deviceId: device.id,
            name: device.id,
            platform: "android",
            incarnation: device.incarnation,
          });
        }
      }
    });
    // Register centralized cleanup for session-scoped state
    this.sessionManager.onSessionRelease((sessionId, deviceId) => {
      DeviceSessionManager.getInstance().clearExplicitDevicePin(deviceId);
      this.navigationGraphListenerManagers.delete(
        NavigationGraphManager.getInstanceForSession(sessionId),
      );
      NavigationGraphManager.releaseSession(sessionId);
      RealObserveScreen.clearCache(deviceId);
      defaultDisplayInventoryProvider.invalidate(deviceId);
      // Clear the per-device CtrlProxy client's binding to the released session
      // (#4984) so a nav/hierarchy event arriving before the next session binds the
      // still-connected device is never attributed to the ended session, and its
      // cached hierarchy detector (which retains the released session's manager) is
      // dropped. Central here so it covers EVERY release path — explicit, idle,
      // heartbeat, device-switch, and derived `${base}:${label}` sessions alike.
      AndroidCtrlProxyClient.getExistingInstance(deviceId)?.releaseSessionBinding(sessionId);
      IOSCtrlProxyClient.getExistingInstance(deviceId)?.releaseSessionBinding(sessionId);
    });
    // A rebind keeps the session live, but its navigation state was collected on
    // the old device and must not follow it to the new one.
    this.sessionManager.onSessionDeviceUnbound((sessionId, deviceId) => {
      DeviceSessionManager.getInstance().clearExplicitDevicePin(deviceId);
      const previousNavigationManager = NavigationGraphManager.getInstanceForSession(sessionId);
      NavigationGraphManager.resetSession(sessionId);
      this.navigationGraphListenerManagers.delete(previousNavigationManager);
      this.setupNavigationGraphUpdateListener(
        NavigationGraphManager.getInstanceForSession(sessionId),
      );
      RealObserveScreen.clearCache(deviceId);
      defaultDisplayInventoryProvider.invalidate(deviceId);
      AndroidCtrlProxyClient.getExistingInstance(deviceId)?.releaseSessionBinding(sessionId);
      IOSCtrlProxyClient.getExistingInstance(deviceId)?.releaseSessionBinding(sessionId);
    });
    // Emit a real "session released" signal so a connected DaemonMcpProxy clears
    // its remembered session binding the moment the daemon releases the session
    // (heartbeat / idle / plan), rather than guessing with the replay TTL. Fires
    // for every released key — base and derived `${base}:${label}` alike; the
    // proxy matches its bound (base) UUID by exact equality (issue #4610).
    this.sessionManager.onSessionRelease((sessionId, _deviceId, releaseReason, snapshot) => {
      if (this.shutdownFallbackReleaseNotifications?.has(sessionId)) {
        return;
      }
      if (releaseReason === "daemon-shutdown") {
        this.shutdownReleaseNotifications?.add(sessionId);
      }
      SessionReleaseBroadcaster.emit(sessionId, releaseReason, snapshot);
    });
  }

  private applyRuntimeOptions(options: DaemonOptions): void {
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

  private applyAccessibilityOptions(options: DaemonOptions): void {
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

  private applyToolOutputOptions(options: DaemonOptions): void {
    if (options.observeResultIncludeElements) {
      serverConfig.setObserveResultIncludeElementsEnabled(true);
    }
    if (options.toolResultsNoStructuredContent) {
      serverConfig.setToolResultsNoStructuredContentEnabled(true);
    }
    if (options.actionsDiffObserve) {
      serverConfig.setActionsDiffObserveEnabled(true);
    }
    if (options.actionsCompactMetadata) {
      serverConfig.setActionsCompactMetadataEnabled(true);
    }
    if (options.actionsNoObserve) {
      serverConfig.setActionsNoObserveEnabled(true);
    }
    if (options.toolOutputsDir) {
      serverConfig.setToolOutputsDir(options.toolOutputsDir);
    }
  }

  /**
   * Start the daemon
   */
  async start(): Promise<void> {
    try {
      await this.startUntilReady();
      this.resolveStartupCompletion();
    } catch (error) {
      this.rejectStartupCompletion(error);
      throw error;
    }
  }

  private async startUntilReady(): Promise<void> {
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
    this.setupShutdownHandlers();

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
          writeEarlyOwnerRecord: () => this.writeEarlyOwnerRecord(),
          initializeDatabase: () => this.initializeDatabase(),
        }),
      );

      this.warmAndroidAvdProvenanceCache();
      // iOS device-type profiles are memoized per SimCtlClient and populated inline
      // during its simulator inventory; there is no process-wide profile cache to warm.

      // Find an available port. In strict-port mode (issue #6260, restart's
      // atomic guard) we deliberately skip findAvailablePort()'s probe-then-
      // release preflight and its port+1..3 fallback: that preflight releases
      // its probe socket before this process actually binds, leaving a window
      // for a competitor to claim the canonical port and for the fallback to
      // paper over it with a "successful" restart on the wrong port. Leaving
      // `this.port` as the requested port makes the real `listen()` call below
      // (in startHttpServer) the single atomic bind-or-fail attempt.
      if (!this.strictPort) {
        this.port = await this.findAvailablePort(this.port);
      }

      // Start HTTP MCP server
      startupBenchmark.startPhase("httpServerStart");
      await this.startHttpServer();
      startupBenchmark.endPhase("httpServerStart");

      // Initialize device pool BEFORE starting socket server
      // This ensures clients connecting via socket will see initialized device pool
      // Wait up to 5 seconds - emulators should already be running
      logger.info("Initializing device pool...");
      startupBenchmark.startPhase("deviceDiscovery");
      await this.initializeDevicePoolWithTimeout(5000);
      startupBenchmark.endPhase("deviceDiscovery");

      try {
        await startupBenchmark.runPhase("sessionRehydration", () =>
          this.sessionManager.rehydratePersistedSessions(this.devicePool),
        );
      } catch (error) {
        logger.warn(`[Daemon] Session rehydration failed; continuing startup: ${error}`);
      }

      // Rehydrated sessions are now owned here and can safely warm their runners.
      await startupBenchmark.runPhase("iosServices", () => this.initializeIosServices());

      // Start Unix socket server AFTER device pool is ready
      logger.info(`Daemon host: "${this.host}", port: ${this.port}`);
      logger.info(`MCP_STREAMABLE_PATH: "${MCP_STREAMABLE_PATH}"`);
      const mcpEndpoint = `http://${this.host}:${this.port}${MCP_STREAMABLE_PATH}`;
      logger.info(`Creating UnixSocketServer with endpoint: "${mcpEndpoint}"`);
      this.socketServer = new UnixSocketServer(
        SOCKET_PATH,
        mcpEndpoint,
        undefined,
        undefined,
        FeatureFlagService.getInstance(),
        {
          identityStartedAt: this.generationStartedAt,
          processGenerationToken: this.processGenerationToken,
          startupOptions: this.options,
          onRepublishIdentity: () => this.republishIdentity(),
          startupCompletion: this.startupCompletion,
          pidFilePath: PID_FILE_PATH,
          sockets: getDaemonSocketPathsByName(),
          dbPath: getDatabasePath(),
          processStartedAt: this.processStartedAt,
          onRestartAccepted: () => {
            setImmediate(() => process.kill(process.pid, "SIGTERM"));
          },
          liveAcceptanceStartupSecret: this.liveAcceptanceStartupSecret,
          acceptanceDiscoveryCapability: this.acceptanceDiscoveryCapability,
        },
        this.idGenerator,
        // A hand-launched daemon (no startup lock) must refuse to unlink a live
        // sibling's socket; only a manager-launched, lock-protected daemon may
        // reclaim it (issue #6232). The owner-liveness check reads the CAPTURED
        // incumbent snapshot, not the PID file we already overwrote above, so an
        // inconclusive probe still sees the live sibling.
        {
          ownerLiveness: this.incumbentOwnerGuard.asSocketOwnerLiveness(),
        },
      );
      logger.info("Starting Unix socket server...");
      startupBenchmark.startPhase("socketServerStart");
      await this.socketServer.start();
      // We now hold the socket bind. Only past this point may this process's exit /
      // shutdown cleanup delete the shared socket/PID files: before it, the early
      // owner record (issue #2871) makes the `expectedPid` self-check pass even
      // though we do not own the socket, so a lock-less contender refused over a
      // live sibling (issue #6232) must NOT clean up on exit and brick the winner
      // (the #6140 failure mode via a bypassed launch). This authorizes cleanup
      // of the control socket and PID file; each aux bind is tracked separately.
      this.socketBindCommitted = true;
      startupBenchmark.endPhase("socketServerStart");
    } catch (error) {
      // Restore the live incumbent's record on any pre-bind failure in the
      // interval above (issue #6232). Guarded on the committed flag so a throw
      // after the bind is committed never rewrites the file this process now owns.
      if (!this.socketBindCommitted) {
        try {
          this.incumbentOwnerGuard.restoreIncumbentAfterRefusal();
        } catch (restoreError) {
          // Repairing a displaced PID record is best effort. The startup
          // failure remains the actionable diagnostic for the operator.
          logger.warn(
            `Failed to restore the incumbent daemon owner record after a refused start: ${restoreError}`,
          );
        }
      }
      throw error;
    }
    logger.info("Unix socket server started");

    startupBenchmark.startPhase("auxiliarySocketServerStart");
    await this.startAuxiliarySocket("video-recording", startVideoRecordingSocketServer);
    await this.startAuxiliarySocket("test-recording", startTestRecordingSocketServer);
    await this.startAuxiliarySocket("device-snapshot", startDeviceSnapshotSocketServer);
    await this.startAuxiliarySocket("appearance", startAppearanceSocketServer);
    await this.startAuxiliarySocket("performance-stream", startPerformanceStreamSocketServer);
    await this.startAuxiliarySocket("observation-stream", () =>
      startDeviceDataStreamSocketServer(this.timer),
    );
    this.configureDeviceDataStreamServer();
    await this.startAuxiliarySocket("performance-push", startPerformancePushSocketServer);
    this.setupDeviceSessionRouting();
    await this.startAuxiliarySocket("failures-stream", startFailuresStreamSocketServer);
    await this.startAuxiliarySocket("failures-push", startFailuresPushSocketServer);
    this.setupDeviceSessionRouting();
    await this.startAuxiliarySocket("telemetry-push", startTelemetryPushSocketServer);
    this.setupDeviceSessionRouting();
    await this.startAuxiliarySocket("webrtc-stream", startWebRtcStreamSocketServer);
    await this.startAuxiliarySocket("video-stream", startVideoStreamSocketServer);
    startupBenchmark.endPhase("auxiliarySocketServerStart");

    startAppearanceSyncScheduler({
      getTargets: () =>
        this.devicePool
          .getAllDevices()
          .filter(
            (device) =>
              device.platform === "android" &&
              this.passiveWorkPolicy.allows("android", "appearance-sync", device.id),
          )
          .map((device) => ({
            deviceId: device.id,
            name: device.id,
            platform: "android",
            incarnation: device.incarnation,
          })),
      isEnabled: () => this.passiveWorkPolicy.isAppearanceSyncEnabled(),
    });
    startPerformanceMonitor();
    this.startAdbMissingDeviceListener();
    this.startDeviceDisconnectMonitor();

    // Write PID file
    await this.writePidFile();
    this.completeIdentityPublished = true;

    // Verify DaemonState is initialized
    const isInitialized = DaemonState.getInstance().isInitialized();
    logger.info(
      `DaemonState initialized: ${isInitialized}, device count: ${this.devicePool.getTotalDeviceCount()}`,
    );

    // Start health check timer (every 30 seconds)
    this.startHealthCheckTimer();
    this.startHeartbeatMonitor();
    this.startNavigationRetentionMonitor();

    startupBenchmark.emit("daemon", {
      host: this.host,
      port: this.port,
      socketPath: SOCKET_PATH,
      deviceCount: this.devicePool.getTotalDeviceCount(),
      mcpHttpListenerBound: this.httpServer?.listening ?? false,
      daemonSocketListenerBound: this.socketServer?.isListening() ?? false,
    });

    logger.info(
      `Daemon started: PID ${process.pid}, socket ${SOCKET_PATH}, HTTP port ${this.port}`,
    );

    // Startup fully succeeded — DB brought up AND every startup DB-backed step
    // completed. Only now clear the crash-loop circuit breaker, so a permanent
    // failure in any later startup step (recorded before its fatal exit) isn't
    // erased by a preflight that merely got past migrations (issue #2784).
    this.startupFailureTracker.reset();
  }

  /**
   * Warm the process-wide Android AVD provenance cache at daemon startup so it
   * is populated, or at least in flight, before a client's first acquisition.
   * The acquisition response path remains a synchronous cache-only read and
   * never waits on or fails because of this best-effort scan.
   */
  private warmAndroidAvdProvenanceCache(): void {
    this.androidAvdProvenanceWarmPromise = Promise.resolve()
      .then(() =>
        AndroidAvdProvenanceCache.getInstance().getByName(this.avdManagerFactory(), this.timer),
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
    // Try preferred port first (faster path)
    if (await this.isPortAvailable(preferredPort)) {
      return preferredPort;
    }

    // If preferred port fails, try a few alternatives
    for (let i = 1; i <= 3; i++) {
      const port = preferredPort + i;
      if (port <= DAEMON_PORT_RANGE_END && (await this.isPortAvailable(port))) {
        return port;
      }
    }

    throw new Error(
      `No available ports in range ${DAEMON_PORT_RANGE_START}-${DAEMON_PORT_RANGE_END}`,
    );
  }

  /**
   * Check if a port is available
   */
  private async isPortAvailable(port: number): Promise<boolean> {
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

      testServer.listen(port, this.host, () => {
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
   * Start the HTTP MCP server (internal daemon transport, not exposed publicly)
   */
  private async startHttpServer(): Promise<void> {
    this.httpServer = this.httpServerFactory();
    this.httpServerClosePromise = null;
    this.acceptingHttpSessions = true;
    const allowedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];

    // Disable default timeouts on this loopback-only server. Node.js 18+ sets
    // requestTimeout to 300 000 ms (5 min), which kills Streamable HTTP
    // connections for long-running tool calls like executePlan. With the timeout
    // active the HTTP response is silently dropped after ~5 min, the
    // StreamableHTTPServerTransport fires onclose, and the MCP client never
    // receives the result — even when the tool completed successfully.
    this.httpServer.requestTimeout = 0;
    this.httpServer.headersTimeout = 0;
    this.httpServer.timeout = 0;

    const handleRequest = (req: IncomingMessage, res: ServerResponse): Promise<void> =>
      this.handleHttpRequest(req, res, allowedHosts);
    this.httpServer.on("request", (req, res) => {
      handleRequest(req, res).catch((error) => {
        logger.warn(`HTTP request callback failed: ${errorMessage(error)}`, error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end();
      });
    });

    // Start HTTP server
    return new Promise((resolve, reject) => {
      this.httpServer!.listen(this.port, this.host, () => {
        logger.info(`automobile:${this.host}:${this.port}${MCP_STREAMABLE_PATH}`);
        resolve();
      });

      this.httpServer!.on("error", (error: NodeJS.ErrnoException) => {
        if (this.strictPort && error.code === "EADDRINUSE") {
          // The authoritative guard (issue #6260): this listen() call is the
          // one atomic bind attempt in strict-port mode, so a genuine
          // EADDRINUSE here means another process holds the canonical port
          // RIGHT NOW — not a stale probe result. Fail loudly instead of the
          // caller (start()) ever falling back to a different port.
          reject(
            new ActionableError(
              `Port ${this.port} on ${this.host} is required for this daemon start but is ` +
                `already in use by another process. Refusing to fall back to a different port ` +
                `and risk a split-brain daemon (issue #6260) — find and stop whatever holds ` +
                `port ${this.port} and retry.`,
            ),
          );
          return;
        }
        logger.error(`HTTP server error: ${error}`);
        reject(error);
      });
    });
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    allowedHosts: string[],
  ): Promise<void> {
    // Check every path before parsing the URL or handling preflight requests.
    if (!req.headers.host || !allowedHosts.includes(req.headers.host) || req.headers.origin) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url!, `http://${req.headers.host}`);

    if (url.pathname === "/heartbeat") {
      return this.handleHeartbeatHttpRequest(req, res);
    }

    if (url.pathname === MCP_STREAMABLE_PATH) {
      return this.handleMcpHttpRequest(req, res, allowedHosts);
    } else {
      // 404 for unknown paths
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  private async handleHeartbeatHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const bodyResult = await this.readHttpBody(req);
    if (!bodyResult.ok) {
      this.respondToBodyReadFailure(res, bodyResult);
      return;
    }

    let payload: { sessionId?: string } | null = null;
    try {
      payload = JSON.parse(bodyResult.body);
    } catch (error) {
      // Invalid client JSON is expected; the 400 response fully describes the failure.
      logger.debug(`Invalid heartbeat JSON: ${error}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const sessionId = payload?.sessionId;
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing sessionId" }));
      return;
    }

    const session =
      this.sessionManager.getSession(sessionId) ??
      this.sessionManager.getReleasingSession(sessionId);
    if (session && isSessionReleasing(this.sessionManager, sessionId, session)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Session not found: ${sessionId}` }));
      return;
    }
    this.sessionManager.recordHeartbeat(sessionId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  private createHttpSessionContext(req: IncomingMessage): {
    sessionId?: string;
    initialSessionToolBinding?: string;
    initialReleasedSession?: string;
    initialToolSelectionProfile?: string;
  } {
    const boundSessionUuid = req.headers[DAEMON_SESSION_TOOL_BINDING_HEADER];
    const boundToolSelectionProfileUuid = req.headers[DAEMON_TOOL_SELECTION_PROFILE_HEADER];
    const sessionContext: {
      sessionId?: string;
      initialSessionToolBinding?: string;
      initialReleasedSession?: string;
      initialToolSelectionProfile?: string;
    } = {
      ...(typeof boundSessionUuid === "string" &&
      boundSessionUuid.trim().length > 0 &&
      !(
        typeof req.headers[DAEMON_RELEASED_SESSION_HEADER] === "string" &&
        req.headers[DAEMON_RELEASED_SESSION_HEADER].trim() === boundSessionUuid.trim()
      )
        ? { initialSessionToolBinding: boundSessionUuid }
        : {}),
      ...(typeof req.headers[DAEMON_RELEASED_SESSION_HEADER] === "string" &&
      req.headers[DAEMON_RELEASED_SESSION_HEADER].trim().length > 0
        ? { initialReleasedSession: req.headers[DAEMON_RELEASED_SESSION_HEADER] }
        : {}),
      ...(typeof boundToolSelectionProfileUuid === "string" &&
      boundToolSelectionProfileUuid.trim().length > 0
        ? { initialToolSelectionProfile: boundToolSelectionProfileUuid }
        : {}),
    };
    return sessionContext;
  }

  private async handleMcpHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    allowedHosts: string[],
  ): Promise<void> {
    if (!this.acceptingHttpSessions) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Daemon is shutting down" }));
      return;
    }

    // Get session ID from header
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let streamableTransport: StreamableHTTPServerTransport;
    let parsedBody: unknown;

    // Parse body for POST requests
    if (req.method === "POST") {
      const bodyResult = await this.readHttpBody(req);
      if (!bodyResult.ok) {
        this.respondToBodyReadFailure(res, bodyResult);
        return;
      }

      try {
        parsedBody = JSON.parse(bodyResult.body);
      } catch (error) {
        // Invalid client JSON is expected; the 400 response fully describes the failure.
        logger.debug(`Invalid MCP JSON: ${error}`);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
    }

    // Check if this is an initialization request
    const isInitializeRequest = this.isHttpInitializeRequest(parsedBody);
    const sendJsonRpcError = (message: string, error?: unknown) =>
      this.sendHttpJsonRpcError(res, parsedBody, message, error);

    // A request may have begun reading its body just before shutdown
    // quiesced the listener. Recheck admission before it can create or use
    // a transport after the shutdown session snapshot is taken.
    if (!this.acceptingHttpSessions) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Daemon is shutting down" }));
      return;
    }

    if (sessionId && this.transports.has(sessionId)) {
      // Use existing transport
      streamableTransport = this.transports.get(sessionId)!;
    } else if (isInitializeRequest || !sessionId) {
      // Create new transport for initialization or when no session ID
      const sessionContext = this.createHttpSessionContext(req);
      streamableTransport = new StreamableHTTPServerTransport({
        enableDnsRebindingProtection: true,
        allowedHosts,
        sessionIdGenerator: () => this.idGenerator.next(),
        onsessioninitialized: (newSessionId) => {
          if (!this.registerHttpTransport(newSessionId, streamableTransport)) {
            return;
          }
          sessionContext.sessionId = newSessionId;
          logger.info(`Streamable HTTP session initialized: ${newSessionId}`);
        },
      });

      // Create and connect MCP server
      let mcpServer;
      try {
        mcpServer = createMcpServer({
          iosDependencies: this.iosDoctorDependencies,
          debug: this.debug,
          sessionContext,
          daemonMode: true,
          acceptanceDiscoveryCapability: this.acceptanceDiscoveryCapability,
        });
      } catch (error) {
        logger.error("Failed to create MCP server:", error);
        sendJsonRpcError("Server error", error);
        return;
      }

      // Setup cleanup handlers
      this.configureHttpTransportCallbacks(streamableTransport);

      try {
        logger.info("Connecting MCP server to Streamable HTTP transport");
        await mcpServer.connect(streamableTransport);
        logger.info("MCP server connected to Streamable HTTP transport");
      } catch (error) {
        logger.error("MCP server connect failed:", error);
        sendJsonRpcError("Server error", error);
        return;
      }
    } else {
      // Invalid session
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    return this.dispatchMcpHttpRequest(req, res, streamableTransport, parsedBody, sendJsonRpcError);
  }

  private isHttpInitializeRequest(parsedBody: unknown): unknown {
    return (
      parsedBody &&
      typeof parsedBody === "object" &&
      true &&
      "method" in parsedBody &&
      parsedBody.method === "initialize"
    );
  }

  private sendHttpJsonRpcError(
    res: ServerResponse,
    parsedBody: unknown,
    message: string,
    error?: unknown,
  ): void {
    if (res.headersSent) {
      return;
    }
    const id =
      parsedBody && typeof parsedBody === "object" && "id" in parsedBody ? parsedBody.id : null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message,
          data: error instanceof Error ? error.message : undefined,
        },
      }),
    );
  }

  private async dispatchMcpHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    streamableTransport: StreamableHTTPServerTransport,
    parsedBody: unknown,
    sendJsonRpcError: (message: string, error?: unknown) => void,
  ): Promise<void> {
    // SSE keepalive: prevent the fetch() response stream from going idle
    // during long-running tool calls (e.g. executePlan at ~6-10 min).
    // Without traffic the client-side stream silently dies; the server
    // writes the result to a dead pipe and the client eventually times out.
    // SSE comment lines (`:`) are ignored by EventSourceParserStream.
    const keepaliveTimer =
      req.method === "POST"
        ? this.timer.setInterval(() => {
            if (res.headersSent && !res.writableEnded && !res.destroyed) {
              res.write(":keepalive\n\n");
            }
          }, SSE_KEEPALIVE_INTERVAL_MS)
        : undefined;

    const clearKeepalive = () => {
      if (keepaliveTimer) {
        this.timer.clearInterval(keepaliveTimer);
      }
    };
    res.on("close", clearKeepalive);
    res.on("finish", clearKeepalive);

    // Let the transport handle the request
    const activeSessionId = streamableTransport.sessionId;
    if (activeSessionId) {
      this.beginHttpRequest(activeSessionId);
    }
    try {
      await streamableTransport.handleRequest(req, res, parsedBody);
    } catch (error) {
      logger.error("Streamable HTTP request handling failed:", error);
      sendJsonRpcError("Server error", error);
    } finally {
      clearKeepalive();
      if (activeSessionId) {
        this.endHttpRequest(activeSessionId);
      }
    }
  }

  private configureHttpTransportCallbacks(
    streamableTransport: StreamableHTTPServerTransport,
  ): void {
    const handleClose = async (): Promise<void> => {
      if (streamableTransport.sessionId) {
        this.clearHttpSessionIdleTimer(streamableTransport.sessionId);
        this.activeHttpRequests.delete(streamableTransport.sessionId);
        const cancelled = await executionTracker.cancelSessionExecutions(
          streamableTransport.sessionId,
          this.shutdownInProgress
            ? new DaemonHandoffInterruptionError(DAEMON_HANDOFF_INTERRUPTED_MESSAGE)
            : "streamable_http_onclose",
        );
        this.transports.delete(streamableTransport.sessionId);
        logger.info(
          `Streamable HTTP session closed: ${streamableTransport.sessionId} (cancelled ${cancelled} executions)`,
        );
      }
    };
    streamableTransport.onclose = () => {
      handleClose().catch((error) => {
        logger.warn(`HTTP transport close callback failed: ${errorMessage(error)}`, error);
      });
    };
    const handleError = async (error: Error): Promise<void> => {
      if (streamableTransport.sessionId) {
        this.handleHttpTransportError(streamableTransport.sessionId, error);
      }
    };
    streamableTransport.onerror = (error) => {
      handleError(error).catch((callbackError) => {
        logger.warn(
          `HTTP transport error callback failed: ${errorMessage(callbackError)}`,
          callbackError,
        );
      });
    };
  }

  private registerHttpTransport(
    sessionId: string,
    transport: StreamableHTTPServerTransport,
  ): boolean {
    if (!this.acceptingHttpSessions) {
      void transport.close().catch((error) => {
        logger.warn(`Failed to close HTTP session ${sessionId} rejected during shutdown`, error);
      });
      return false;
    }
    this.transports.set(sessionId, transport);
    this.armHttpSessionIdleTimer(sessionId, transport);
    return true;
  }

  private handleHttpTransportError(sessionId: string, error: unknown): void {
    // The SDK also reports recoverable per-request failures here; keep the live session.
    logger.warn(
      `Streamable HTTP transport error for session ${sessionId}: ${describeUnknownError(error)}`,
    );
  }

  private clearHttpSessionIdleTimer(sessionId: string): void {
    const timer = this.httpSessionIdleTimers.get(sessionId);
    if (timer) {
      this.timer.clearTimeout(timer);
      this.httpSessionIdleTimers.delete(sessionId);
    }
  }

  private armHttpSessionIdleTimer(
    sessionId: string,
    transport: StreamableHTTPServerTransport,
  ): void {
    this.clearHttpSessionIdleTimer(sessionId);
    const timer = this.timer.setTimeout(() => {
      this.httpSessionIdleTimers.delete(sessionId);
      if (this.transports.get(sessionId) !== transport) {
        return;
      }
      if ((this.activeHttpRequests.get(sessionId) ?? 0) > 0) {
        this.armHttpSessionIdleTimer(sessionId, transport);
        return;
      }
      void transport.close().catch((error) => {
        logger.warn(`Failed to reap idle HTTP session ${sessionId}`, error);
        this.armHttpSessionIdleTimer(sessionId, transport);
      });
    }, HTTP_SESSION_IDLE_TIMEOUT_MS);
    this.httpSessionIdleTimers.set(sessionId, timer);
  }

  private beginHttpRequest(sessionId: string): void {
    this.clearHttpSessionIdleTimer(sessionId);
    this.activeHttpRequests.set(sessionId, (this.activeHttpRequests.get(sessionId) ?? 0) + 1);
  }

  private endHttpRequest(sessionId: string): void {
    const remaining = (this.activeHttpRequests.get(sessionId) ?? 1) - 1;
    if (remaining > 0) {
      this.activeHttpRequests.set(sessionId, remaining);
    } else {
      this.activeHttpRequests.delete(sessionId);
      const transport = this.transports.get(sessionId);
      if (transport) {
        this.armHttpSessionIdleTimer(sessionId, transport);
      }
    }
  }

  private readHttpBody(req: IncomingMessage): Promise<HttpBodyResult> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (result: HttpBodyResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        req.off("aborted", onAborted);
        req.off("close", onClose);
        resolve(result);
      };
      const onData = (chunk: Buffer | string): void => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > HTTP_BODY_MAX_BYTES) {
          finish({ ok: false, status: 413, error: "Request body too large" });
          req.destroy();
          return;
        }
        chunks.push(data);
      };
      const onEnd = (): void => finish({ ok: true, body: Buffer.concat(chunks).toString("utf8") });
      const onError = (error: Error): void => {
        logger.warn("HTTP request body read failed", error);
        finish({ ok: false, status: 400, error: "Request body read failed" });
      };
      const onAborted = (): void => finish({ ok: false, status: 400, error: "Request aborted" });
      const onClose = (): void => finish({ ok: false, status: 400, error: "Request closed" });
      const timeout = this.timer.setTimeout(() => {
        finish({ ok: false, status: 408, error: "Request body timed out" });
        req.destroy();
      }, HTTP_BODY_TIMEOUT_MS);
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      req.on("aborted", onAborted);
      req.on("close", onClose);
    });
  }

  private respondToBodyReadFailure(
    res: ServerResponse,
    result: Extract<HttpBodyResult, { ok: false }>,
  ): void {
    if (!res.destroyed) {
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.error }));
    }
  }

  private closeHttpListener(): Promise<void> {
    if (!this.httpServer) {
      return Promise.resolve();
    }
    this.httpServerClosePromise ??= new Promise<void>((resolve, reject) => {
      this.httpServer!.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        logger.info("HTTP server stopped");
        resolve();
      });
    });
    return this.httpServerClosePromise;
  }

  /**
   * Persist a PID-file record to disk (creating the directory as needed).
   * Shared by the early owner record and the final complete write.
   */
  private async persistPidFileData(pidData: PidFileData, signal?: AbortSignal): Promise<void> {
    await mkdir(dirname(PID_FILE_PATH), { recursive: true });
    signal?.throwIfAborted();
    await writePidFileDataAtomic(PID_FILE_PATH, pidData, signal);
    this.pidFileWritten = true;
  }

  /**
   * Publish this daemon's owned DB path in the PID file BEFORE the DB is opened.
   *
   * `Daemon.start()` opens and migrates the shared SQLite file (via
   * {@link initializeDatabase}) seconds before the full PID file is written (that
   * only happens after port selection and device discovery). Between those points
   * the daemon is live and visible to `ps`, but its `dbPath` is not yet recorded —
   * so the direct-mode DB-ownership guard (see {@link import("./directModeGuard")})
   * would see an owner with an unknown path and fail CLOSED, transiently refusing a
   * concurrent direct-mode launch even when it targets an ISOLATED `AUTOMOBILE_DB_PATH`.
   *
   * Recording the resolved `dbPath` (knowable via {@link getDatabasePath} WITHOUT
   * opening the DB) before {@link initializeDatabase} closes that window: any daemon
   * that has opened the DB now always exposes a resolvable `dbPath`, so a same-file
   * launch is still refused while an isolated-path launch is allowed. The remaining
   * TOCTOU (a daemon opening the DB immediately after the guard's check) is covered
   * by the migration cross-process lock (#2794). Issue #2871.
   *
   * The record is minimal by design (pid, daemonSessionId, dbPath, socketPath,
   * startedAt, processStartedAt, version).
   * Consumers that gate on daemon readiness — `status()`/`waitForReady()` — key on
   * the socket file plus `verifyDaemonConnection`, not on the PID file's `port`, so
   * a partial record written before the socket exists cannot make the daemon look
   * ready early. {@link writePidFile} overwrites it with the complete record.
   */
  private async writeEarlyOwnerRecord(): Promise<void> {
    const pidData: PidFileData = {
      pid: process.pid,
      daemonSessionId: this.daemonSessionId,
      socketPath: SOCKET_PATH,
      port: this.port,
      dbPath: getDatabasePath(),
      startedAt: this.generationStartedAt,
      processStartedAt: this.processStartedAt,
      ...(this.processGenerationToken === undefined
        ? {}
        : { processGenerationToken: this.processGenerationToken }),
      version: DAEMON_VERSION,
      launchLogPath: this.launchLogPath(),
      assetVersion: resolveAssetVersion(resolvePinnedVersion()),
      options: this.options,
    };
    // Snapshot any live incumbent BEFORE this overwrite clobbers its PID record,
    // so the lock-less bind guard can still see the live sibling and restore its
    // record on refusal instead of unlinking/orphaning it (issue #6232).
    this.incumbentOwnerGuard.captureIncumbentBeforeOverwrite();
    await this.persistPidFileData(pidData);
    this.incumbentOwnerGuard.recordContenderEarlyOwner(pidData);
    logger.info(`Early daemon owner record written to ${PID_FILE_PATH} (dbPath ${pidData.dbPath})`);
  }

  /**
   * Write PID file with daemon metadata
   */
  private async writePidFile(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const buildIdentity = getCurrentBuildIdentity();
    const pidData: PidFileData = {
      pid: process.pid,
      daemonSessionId: this.daemonSessionId,
      socketPath: SOCKET_PATH,
      sockets: getDaemonSocketPathsByName(),
      port: this.port,
      dbPath: getDatabasePath(),
      startedAt: this.generationStartedAt,
      processStartedAt: this.processStartedAt,
      ...(this.processGenerationToken === undefined
        ? {}
        : { processGenerationToken: this.processGenerationToken }),
      version: DAEMON_VERSION,
      launchLogPath: this.launchLogPath(),
      assetVersion: resolveAssetVersion(resolvePinnedVersion()),
      entryScript: buildIdentity.entryScript,
      buildId: buildIdentity.buildId,
      options: this.options,
    };

    await this.persistPidFileData(pidData, signal);
    signal?.throwIfAborted();
    logger.info(`PID file written to ${PID_FILE_PATH}`);
  }

  private republishIdentity(): Promise<boolean> {
    return republishOwnedIdentity(
      this.completeIdentityPublished,
      {
        pid: process.pid,
        startedAt: this.generationStartedAt,
        processGenerationToken: this.processGenerationToken,
      },
      {
        readRecord: () => readPidFileDataSync(),
        writeRecord: () => this.writePidFile(),
        isProcessRunning: (pid) => isProcessRunning(pid, { debugLog: logger.debug }),
      },
      getDaemonSocketPathsByName(),
    );
  }

  private launchLogPath(): string | null {
    const logPath = process.env[DAEMON_LAUNCH_LOG_PATH_ENV];
    return logPath && isAbsolute(logPath) ? logPath : null;
  }

  /**
   * Device-ready callback wired into {@link DevicePool}. Mints (or refreshes)
   * the device-session epoch for the connected device and preserves the
   * pre-existing input-cache eviction. The pool fires this on the refresh,
   * addDevice, and bind/autolock paths; startup-booted devices are minted
   * directly in {@link initializeDevicePool}. The mint is keyed on the pooled
   * device's monotonic `incarnation` — a repeat ready-signal for the same epoch
   * is idempotent, while a same-serial restart (new incarnation) mints a fresh
   * `deviceSessionUuid` (epic #5256).
   */
  private onDeviceReadyForSessionRegistry(deviceId: string): void {
    this.socketServer?.evictDeviceInputCache(deviceId);
    const pooled = this.devicePool.getDevice(deviceId);
    if (!pooled) {
      return;
    }
    if (pooled.platform === "ios") {
      const manager = IOSCtrlProxyManager.getExistingInstance(deviceId);
      void manager?.rearmAfterDeviceReappearance().catch((error) => {
        logger.warn(
          `[Daemon] Failed to rearm iOS CtrlProxy for ${deviceId}: ${errorMessage(error)}`,
        );
      });
    }
    this.deviceSessionRegistry.onDeviceConnected({
      deviceId: pooled.id,
      platform: pooled.platform,
      incarnation: pooled.incarnation,
    });
  }

  /**
   * Set up callback for observation stream to trigger device WebSocket connections.
   * When an IDE plugin subscribes to the observation stream, we need to ensure
   * the WebSocket connections to Android devices are established so that
   * hierarchy updates can flow continuously.
   */
  /**
   * Give every push socket server the serial↔`deviceSessionUuid` resolver so it can
   * stamp the epoch key on outgoing frames and route subscriptions on it, and wire
   * the registry's connect/disconnect transitions to `device_session_started` /
   * `device_session_ended` frames on the observation stream (epic #5256, item 3).
   */
  private getDeviceSessionRoutingTargets(): DeviceSessionRoutingTargets {
    return {
      deviceDataStream: getDeviceDataStreamServer(),
      performancePush: getPerformancePushServer(),
      failuresPush: getFailuresPushServer(),
      telemetryPush: getTelemetryPushServer(),
    };
  }

  private configureDeviceDataStreamServer(): void {
    // The stream singleton can be replaced by health recovery. Route it before
    // registering request callbacks so every handler observes the current epoch.
    this.setupDeviceSessionRouting();
    this.setupDeviceDataStreamCallback();
  }

  private setupDeviceSessionRouting(): void {
    // The pool's unresolved-identity quarantine is the second input: while it
    // holds for a serial, the registry record stays put but the resolver withholds
    // it in both directions and every push server drops that serial's frames, so a
    // possible replacement AVD's passive events cannot reach the previous AVD's
    // subscribers (#6863 review).
    const resolver = createRegistryDeviceSessionResolver(
      this.deviceSessionRegistry,
      this.devicePool,
    );
    const { deviceDataStream, performancePush, failuresPush, telemetryPush } =
      this.getDeviceSessionRoutingTargets();
    this.deviceDataStreamServer = deviceDataStream;
    deviceDataStream?.setDeviceSessionResolver(resolver);
    performancePush?.setDeviceSessionResolver(resolver);
    failuresPush?.setDeviceSessionResolver(resolver);
    telemetryPush?.setDeviceSessionResolver(resolver);

    if (deviceDataStream) {
      this.deviceSessionRegistry.setLifecycleListener({
        onSessionStarted: (record) => deviceDataStream.pushDeviceSessionStarted(record),
        onSessionEnded: (record, options) =>
          deviceDataStream.pushDeviceSessionEnded(record, options),
      });
    }
  }

  private logSkippedObservationStreamDevice(
    platform: "android" | "ios",
    deviceId: string,
    action: string,
  ): void {
    const optInEnv =
      platform === "android"
        ? "AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES"
        : "AUTOMOBILE_IOS_WARMUP_DEVICES";
    logger.info(
      `[Daemon] Skipping observation-stream ${action} for ${platform} device ${deviceId}: passive-work policy filtered it; set ${optInEnv} to opt in`,
    );
  }

  private getInitialFrameCoordinator(
    server: NonNullable<ReturnType<typeof getDeviceDataStreamServer>>,
  ) {
    let coordinator = this.initialFrameCoordinators.get(server);
    if (!coordinator) {
      coordinator = new DefaultObservationInitialFrameCoordinator(
        this.timer,
        undefined,
        (id) => server.getLiveFrameGeneration(id),
        (id) => server.getDeviceSessionUuid(id),
      );
      this.initialFrameCoordinators.set(server, coordinator);
    }
    return coordinator;
  }

  private setupDeviceDataStreamCallback(): void {
    const server = this.deviceDataStreamServer ?? getDeviceDataStreamServer();
    if (!server) {
      logger.warn("[Daemon] Observation stream server not available for callback setup");
      return;
    }

    const coordinator = this.getInitialFrameCoordinator(server);
    server.setOnSubscriberConnected((deviceId: string | null, subscriber) => {
      logger.info(
        `[Daemon] IDE plugin subscribed to observation stream (device: ${deviceId ?? "all"}), ensuring WebSocket connections...`,
      );

      // A stream subscription does not acquire devices. Initial frames can
      // connect a CtrlProxy client, so both platforms need passive-work scope.
      const pooledDevices = this.devicePool.getAllDevices();
      const allDevices = selectObservationStreamDevices(
        pooledDevices,
        this.passiveWorkPolicy,
        (device) => this.logSkippedObservationStreamDevice(device.platform, device.id, "connect"),
      );

      pushInitialObservationFramesForSubscriber(deviceId, allDevices, {
        streamServer: server,
        coordinator,
        subscriber,
        isDeviceAllowed: (id) => {
          const device = this.devicePool.getAllDevices().find((candidate) => candidate.id === id);
          return (
            !!device && this.passiveWorkPolicy.allows(device.platform, "observation-stream", id)
          );
        },
        androidClientFactory: (device) =>
          AndroidCtrlProxyClient.getInstance(device, defaultAdbClientFactory),
        iosClientFactory: (device) => this.createObservationStreamIosClient(device),
      }).catch((error) => {
        logger.warn(`[Daemon] Error pushing initial observation frame: ${error}`);
      });

      if (pooledDevices.length === 0) {
        logger.info("[Daemon] No devices in pool to connect");
      }
    });

    server.setOnScreenshotCadenceChanged((deviceId: string | null) => {
      const devices = this.devicePool
        .getAllDevices()
        .filter((device) => deviceId === null || device.id === deviceId);

      for (const device of devices) {
        if (device.platform === "android") {
          if (!this.passiveWorkPolicy.allows("android", "observation-stream", device.id)) {
            this.logSkippedObservationStreamDevice("android", device.id, "screenshot cadence");
            continue;
          }
          AndroidCtrlProxyClient.getExistingInstance(
            device.id,
          )?.refreshObservationStreamScreenshotCadence();
        } else if (device.platform === "ios") {
          if (!this.passiveWorkPolicy.allows("ios", "observation-stream", device.id)) {
            this.logSkippedObservationStreamDevice("ios", device.id, "screenshot cadence");
            continue;
          }
          IOSCtrlProxyClient.getExistingInstance(
            device.id,
          )?.refreshObservationStreamScreenshotCadence();
        }
      }
    });

    server.setOnHierarchyCadenceChanged((deviceId: string | null) => {
      const devices = this.devicePool
        .getAllDevices()
        .filter((device) => deviceId === null || device.id === deviceId);

      for (const device of devices) {
        if (device.platform === "android") {
          if (!this.passiveWorkPolicy.allows("android", "observation-stream", device.id)) {
            this.logSkippedObservationStreamDevice("android", device.id, "hierarchy cadence");
            continue;
          }
          AndroidCtrlProxyClient.getExistingInstance(
            device.id,
          )?.refreshObservationStreamHierarchyCadence();
        } else if (device.platform === "ios") {
          if (!this.passiveWorkPolicy.allows("ios", "observation-stream", device.id)) {
            this.logSkippedObservationStreamDevice("ios", device.id, "hierarchy cadence");
            continue;
          }
          const client = IOSCtrlProxyClient.getExistingInstance(device.id);
          if (!client) {
            continue;
          }

          const intervalMs = server.getHierarchyIntervalMsForDevice(device.id);
          void client
            .ensureConnected()
            .then((connected) => {
              if (connected) {
                client.refreshObservationStreamHierarchyCadence(intervalMs);
              }
            })
            .catch((error) => {
              logger.warn(
                `[Daemon] Failed to refresh iOS hierarchy cadence for ${device.id}: ${error}`,
              );
            });
        }
      }
    });

    // Register/release a device-side content observer for one key/value store so external writes
    // emit storage_update frames to the pane (issue #4709). Only Android exposes storage content
    // observers today; a storage pane is always device-scoped, so target the resolved device and
    // skip when no live CtrlProxy client exists. The device-side subscriptionId is deterministic
    // ("packageName:fileName"), so unsubscribe reconstructs it without daemon-side bookkeeping.
    server.setOnStorageSubscriptionRequested((request) =>
      this.applyStorageSubscriptionRequest(request),
    );

    server.setOnObservationRequested(async ({ deviceId, sessionUuid, signal }) => {
      const authenticator = createDefaultStreamSocketAuthenticator("observationStream", {
        allowObserverSessions: true,
      });
      const pooledDevices = deviceId
        ? [this.devicePool.getDevice(deviceId)].filter((device) => device !== null)
        : this.devicePool.getAllDevices();

      if (pooledDevices.length === 0) {
        throw new Error(
          deviceId ? `Device ${deviceId} is not available` : "No devices are available",
        );
      }

      if (signal.aborted) {
        throw new Error("Observation request was aborted");
      }

      const requestStart = this.timer.now();
      return runObservationRequestBatch(
        pooledDevices,
        async (pooledDevice, observationSignal) => {
          const bootedDevice: BootedDevice = {
            deviceId: pooledDevice.id,
            name: pooledDevice.name,
            platform: pooledDevice.platform,
            iosVersion: pooledDevice.iosVersion,
          };
          const observeScreen = new RealObserveScreen(bootedDevice);
          return observeScreen.execute({
            skipWaitForFresh: false,
            minTimestamp: requestStart,
            signal: observationSignal,
          });
        },
        {
          timer: this.timer,
          signal,
          assertDeviceActionable: (pooledDevice) => {
            this.devicePool.assertDeviceActionable(pooledDevice.id, "to observe");
            authenticator.authorize({ sessionUuid, deviceId: pooledDevice.id });
          },
        },
      );
    }, PER_DEVICE_OBSERVATION_TIMEOUT_MS + OBSERVATION_BATCH_HEADROOM_MS);

    logger.info("[Daemon] Observation stream callback configured");

    // Wire up navigation graph updates to stream to IDE plugins
    this.setupNavigationGraphStreamListener(server);
  }

  /**
   * Expand one storage (un)subscription to the devices it targets and apply it.
   *
   * FUNNEL 2 for every target the expansion produces. A request that scopes
   * itself to a serial is already refused at the socket server, but an
   * ALL-DEVICE request names no serial at all, so nothing there can preflight it
   * — and `deviceId === null` means every pooled Android device here. Gating each
   * expanded target is what stops the request from installing a content observer
   * on whichever replacement AVD now answers on a quarantined serial and still
   * acking success. The refusals are collected rather than thrown at the first
   * one, so a healthy device still gets its observer and the caller learns which
   * targets the request could not cover -- the same partial-completion shape the
   * all-device observation path uses
   * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
   *
   * Teardown is exempt, as it is at the socket server: refusing it would strand
   * the observer this daemon registered, and releasing one touches only
   * bookkeeping the quarantine does not question.
   */
  private async applyStorageSubscriptionRequest({
    deviceId,
    sessionUuid,
    packageName,
    fileName,
    subscribe,
  }: {
    deviceId: string | null;
    sessionUuid?: string;
    packageName: string;
    fileName: string;
    subscribe: boolean;
  }): Promise<void> {
    const devices = this.devicePool
      .getAllDevices()
      .filter((device) => deviceId === null || device.id === deviceId);
    const refusals: string[] = [];
    const authenticator = createDefaultStreamSocketAuthenticator("observationStream", {
      allowObserverSessions: true,
    });
    for (const device of devices) {
      if (device.platform !== "android") {
        continue;
      }
      try {
        authenticator.authorize({ sessionUuid, deviceId: device.id });
      } catch (error) {
        refusals.push(errorMessage(error));
        continue;
      }
      if (subscribe) {
        try {
          this.devicePool.assertDeviceActionable(device.id, STORAGE_WATCH_PURPOSE);
        } catch (error) {
          refusals.push(errorMessage(error));
          continue;
        }
      }
      const client = AndroidCtrlProxyClient.getExistingInstance(device.id);
      if (!client) {
        continue;
      }
      if (subscribe) {
        await client.subscribeStorage(packageName, fileName);
      } else {
        await client.unsubscribeStorage(`${packageName}:${fileName}`);
      }
    }
    if (refusals.length > 0) {
      throw new ActionableError(refusals.join("; "));
    }
  }

  private createObservationStreamIosClient(device: BootedDevice): ObservationStreamIosClient {
    const client = IOSCtrlProxyClient.getInstance(device);
    return {
      ensureConnected: async () => {
        const connected = await client.ensureConnected();
        const server = getDeviceDataStreamServer();
        if (connected && server) {
          client.refreshObservationStreamHierarchyCadence(
            server.getHierarchyIntervalMsForDevice(device.deviceId),
          );
        }
        return connected;
      },
      getLatestHierarchy: (...args) => client.getLatestHierarchy(...args),
      requestHierarchySyncWithoutObservationStreamPush: async (...args) => {
        const result = await client.requestHierarchySyncWithoutObservationStreamPush(...args);
        return result
          ? {
              hierarchy: result.hierarchy,
              ...(result.frameContext === undefined ? {} : { frameContext: result.frameContext }),
            }
          : null;
      },
      convertToViewHierarchyResult: (hierarchy) =>
        client.convertToViewHierarchyResult(hierarchy as never),
      recordInitialObservationStreamHierarchy: (hierarchy, captureSequence) =>
        client.recordInitialObservationStreamHierarchy(hierarchy, captureSequence),
      requestScreenshotWithoutObservationStreamPush: (...args) =>
        client.requestScreenshotWithoutObservationStreamPush(...args),
    };
  }

  /**
   * Set up listener for navigation graph changes.
   * When the navigation graph changes, push updates to all subscribed IDE plugins.
   */
  private setupNavigationGraphStreamListener(
    server: ReturnType<typeof getDeviceDataStreamServer>,
  ): void {
    if (!server) {
      return;
    }

    this.setupNavigationGraphUpdateListener(NavigationGraphManager.getInstance());
    for (const session of this.sessionManager.getAllSessions()) {
      this.setupNavigationGraphUpdateListener(
        NavigationGraphManager.getInstanceForSession(session.sessionId),
      );
    }

    // Requests retain the legacy unattributed graph behavior. Live graph changes
    // above are also wired to each active session manager, which is where tool
    // execution records navigation state.
    server.setOnNavigationGraphRequested(
      createNavigationGraphRequestHandler({
        exportGraphSummary: () => this.resolveUnscopedNavigationGraphManager().exportGraphSummary(),
        exportGraphSummaryForApp: (appId) =>
          this.resolveUnscopedNavigationGraphManager().exportGraphSummaryForApp(appId),
      }),
    );

    logger.info("[Daemon] Navigation graph stream listener configured");
  }

  private resolveUnscopedNavigationGraphManager(): NavigationGraphManager {
    const sessions = this.sessionManager.getAllSessions();
    return sessions.length === 1
      ? NavigationGraphManager.getInstanceForSession(sessions[0]!.sessionId)
      : NavigationGraphManager.getInstance();
  }

  private setupNavigationGraphUpdateListener(navGraphManager: NavigationGraphManager): void {
    const streamServer = this.deviceDataStreamServer;
    if (
      streamServer &&
      !this.navigationGraphSeededStreamManagers.get(streamServer)?.has(navGraphManager)
    ) {
      const seededManagers =
        this.navigationGraphSeededStreamManagers.get(streamServer) ??
        new WeakSet<NavigationGraphManager>();
      seededManagers.add(navGraphManager);
      this.navigationGraphSeededStreamManagers.set(streamServer, seededManagers);
      for (const context of navGraphManager.getBuildContexts()) {
        if (context.deviceId !== LEGACY_PROVENANCE_SENTINEL) {
          streamServer.pushBuildContextUpdate(context.deviceId, context.appId, {
            packageId: context.appId,
            versionCode: context.versionCode,
            ...(context.versionKey === undefined ? {} : { versionKey: context.versionKey }),
            contentHash: context.contentHash,
          });
        }
      }
    }
    if (this.navigationGraphListenerManagers.has(navGraphManager)) {
      return;
    }
    this.navigationGraphListenerManagers.add(navGraphManager);
    navGraphManager.setBuildContextUpdateListener(({ appId, deviceId, buildContext }) => {
      if (
        !this.navigationGraphListenerManagers.has(navGraphManager) ||
        deviceId === LEGACY_PROVENANCE_SENTINEL
      ) {
        return;
      }
      this.deviceDataStreamServer?.pushBuildContextUpdate(
        deviceId,
        appId,
        buildContext === null
          ? null
          : {
              packageId: appId,
              versionCode: buildContext.versionCode,
              ...(buildContext.versionKey === undefined
                ? {}
                : { versionKey: buildContext.versionKey }),
              contentHash: buildContext.contentHash,
            },
      );
    });
    navGraphManager.setGraphUpdateListener(async () => {
      logger.info("[Daemon] Navigation graph listener triggered, exporting summary...");
      try {
        const summary = await navGraphManager.exportGraphSummary();
        if (!this.navigationGraphListenerManagers.has(navGraphManager)) {
          logger.debug("[Daemon] Ignoring navigation update from a released or rebound session");
          return;
        }
        logger.info(
          `[Daemon] Got summary: appId=${summary.appId}, nodes=${summary.nodes.length}, edges=${summary.edges.length}`,
        );

        const streamData = convertSummaryToStreamData(summary);
        // Attribute the update to the device that owns this app's graph so panes
        // watching other devices are not cross-contaminated (epic #5256; #4837).
        const deviceId = navGraphManager.getDeviceIdForApp(summary.appId);
        this.deviceDataStreamServer?.pushNavigationGraphUpdate(streamData, deviceId);

        logger.info(
          `[Daemon] Pushed navigation graph update: ${summary.nodes.length} nodes, ${summary.edges.length} edges`,
        );
      } catch (error) {
        logger.warn(`[Daemon] Failed to push navigation graph update: ${error}`);
      }
    });
  }

  private checkHealthListeners(
    recordHealthCheckFailure: (kind: HealthFailureKind) => void,
  ): boolean {
    // Check if HTTP server is responsive
    if (!this.httpServer) {
      logger.warn("Health check failed: HTTP server not initialized");
      recordHealthCheckFailure("http");
      return false;
    }
    if (!this.httpServer.listening) {
      logger.warn("Health check failed: HTTP server not listening");
      recordHealthCheckFailure("http");
      return false;
    }
    // Check socket servers before probing shared dependencies; clients
    // can only subscribe to advertised streams while their socket paths exist.
    if (!this.socketServer || !this.socketServer.isListening()) {
      logger.warn("Health check failed: Socket server not listening");
      recordHealthCheckFailure("socket");
      return false;
    }
    if (!this.observationStreamHealth.isHealthy()) {
      logger.warn("Health check failed: Observation stream socket unavailable");
      recordHealthCheckFailure("socket");
      return false;
    }
    return true;
  }

  /**
   * Start periodic health checks
   */
  private startHealthCheckTimer(): void {
    const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
    const MAX_FAILED_CHECKS = 3; // Allow 3 consecutive failures before taking action
    let failedCheckCount = 0;
    let lastFailureKind: HealthFailureKind = "unknown";
    const recordHealthCheckFailure = (failureKind: HealthFailureKind): void => {
      // Recovery behavior depends on the failure kind, so only same-kind streaks
      // should reach a kind-specific recovery action.
      if (lastFailureKind !== failureKind) {
        failedCheckCount = 0;
      }
      lastFailureKind = failureKind;
      failedCheckCount++;
    };
    const resetHealthCheckFailures = (): void => {
      failedCheckCount = 0;
      lastFailureKind = "unknown";
    };

    const checkHealth = async (): Promise<void> => {
      try {
        if (this.checkHealthListeners(recordHealthCheckFailure)) {
          try {
            await this.databaseHealthProbe.check();
            // Health check passed
            resetHealthCheckFailures();
            logger.debug("Health check passed");
          } catch (error) {
            logger.warn(`Health check failed: Database probe failed: ${error}`);
            recordHealthCheckFailure("database");
          }
        }

        // If too many failures, attempt recovery
        if (failedCheckCount >= MAX_FAILED_CHECKS) {
          logger.error(`Health check failed ${failedCheckCount} times, attempting recovery...`);
          await this.attemptRecovery(lastFailureKind);
          resetHealthCheckFailures();
        }
      } catch (error) {
        logger.warn(`Health check error: ${error}`);
        recordHealthCheckFailure("unknown");
      }
    };
    this.healthCheckTimer = this.timer.setInterval(() => {
      // checkHealth logs failures and updates the failure counter internally.
      void checkHealth();
    }, HEALTH_CHECK_INTERVAL);

    // Keep timer alive even if there are no other references
    if (typeof (this.healthCheckTimer as { unref?: () => void }).unref === "function") {
      (this.healthCheckTimer as { unref: () => void }).unref();
    }
  }

  private stopHealthCheckTimer(): void {
    if (this.healthCheckTimer) {
      this.timer.clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Start periodic heartbeat checks to cancel stale sessions
   */
  private startHeartbeatMonitor(): void {
    this.heartbeatMonitor = new SessionHeartbeatMonitor(
      this.sessionManager,
      (sessionId) => this.hasActiveSessionExecution(sessionId),
      async (sessionId, reason) => {
        await this.cancelAndReleaseSession(sessionId, reason);
      },
      this.timer,
    );
    this.heartbeatMonitor.start();
  }

  /**
   * Start the periodic navigation-data retention pass (nav (app,build) Phase 3,
   * #4986). Bounds accumulated cross-build/device/session observation rows and
   * stale node screenshots. Best-effort: a failed pass is logged and swallowed,
   * and its writes are tracked by the DB write barrier drained on shutdown.
   */
  private startNavigationRetentionMonitor(): void {
    const fileSystem = new DefaultFileSystem();
    const retention = new NavigationRetention(getDatabase(), {}, (filePath) =>
      fileSystem.unlink(filePath),
    );
    this.navigationRetentionMonitor = new NavigationRetentionMonitor(retention, this.timer);
    this.navigationRetentionMonitor.start();
  }

  private hasActiveSessionExecution(
    sessionId: string,
    query?: ActiveSessionExecutionQuery,
  ): boolean {
    const executionSessionId =
      resolveToolSelectionBaseSessionUuid(sessionId, this.sessionManager) ?? sessionId;
    return (
      this.devicePool.isSessionRecoveryInFlight(sessionId) ||
      executionTracker.hasActiveSessionUuidExecutions(sessionId, query) ||
      executionTracker.hasActiveAutolockSessionExecutions(sessionId, query) ||
      (executionSessionId !== sessionId &&
        (executionTracker.hasActiveSessionUuidExecutions(executionSessionId, query) ||
          executionTracker.hasActiveAutolockSessionExecutions(executionSessionId, query)))
    );
  }

  private async tryRecoverCapturedDisconnectTarget(
    options: CapturedDisconnectRecoveryOptions,
  ): Promise<boolean> {
    const { deviceId, incidentId, pooledDevice, sessionId, session, forceGeneration, preparation } =
      options;
    if (!preparation) {
      if (
        sessionId &&
        (await this.devicePool.waitForSessionPreservingRecovery(sessionId, incidentId))
      ) {
        this.retireAdbServerResetDisconnectState(deviceId, forceGeneration);
        return true;
      }
      if (sessionId && this.devicePool.isSessionRecoveryInFlight(sessionId)) {
        await this.devicePool.finishEmulatorLossIncident(incidentId, "not-attempted");
        this.retireAdbServerResetDisconnectState(deviceId, forceGeneration);
        return true;
      }
    }
    if (!pooledDevice || !sessionId || !session) {
      return false;
    }
    this.devicePool.finishSessionPreservingRecoveryPreparation(preparation);
    const recovery = await this.devicePool.recoverSessionBoundDeviceAfterLoss(
      deviceId,
      incidentId,
      pooledDevice,
    );
    if (recovery === "not-attempted") {
      return false;
    }
    this.retireAdbServerResetDisconnectState(deviceId, forceGeneration);
    return true;
  }

  private async recordAndTryRecoverCapturedDisconnect(
    deviceId: string,
    pooledDevice: PooledDevice | null,
    assignmentCount: number,
    sessionId: string | null | undefined,
    session: Session | null,
    forceGeneration: number | undefined,
  ): Promise<{ incidentId: string | undefined; handled: boolean }> {
    if (await this.devicePool.isShutdownReservationHeld(deviceId)) {
      // killDevice owns intentional disappearance. Leave misses at the threshold
      // so the next poll rechecks the fence if shutdown fails and releases it.
      // Pool cleanup defers reserved/assigned devices and consumes idle markers.
      await this.devicePool.removeDisconnectedDevice(
        deviceId,
        true,
        undefined,
        pooledDevice ?? undefined,
      );
      return { incidentId: undefined, handled: true };
    }
    const preparation = this.devicePool.prepareSessionPreservingRecovery(
      deviceId,
      pooledDevice ?? undefined,
    );
    try {
      const incidentId = await this.devicePool.recordEmulatorLossIncident(
        deviceId,
        this.forceDisconnectedDeviceIds.has(deviceId)
          ? "adb-transport-failure"
          : "device-discovery-miss",
        undefined,
        "absent",
      );
      const staleDisconnect =
        (await this.shouldSkipStaleDisconnectCleanup(pooledDevice, deviceId, forceGeneration)) ||
        !this.isCapturedDisconnectTargetCurrent(
          deviceId,
          pooledDevice,
          assignmentCount,
          sessionId,
          session,
        );
      if (staleDisconnect) {
        await this.devicePool.finishEmulatorLossIncident(incidentId, "not-attempted");
        return { incidentId, handled: true };
      }
      const handled = await this.tryRecoverCapturedDisconnectTarget({
        deviceId,
        incidentId,
        pooledDevice,
        sessionId,
        session,
        forceGeneration,
        preparation,
      });
      return { incidentId, handled };
    } finally {
      this.devicePool.finishSessionPreservingRecoveryPreparation(preparation);
    }
  }

  private startDeviceDisconnectMonitor(
    deviceManager: Pick<
      MultiPlatformDeviceManager,
      "getBootedDevicesDetailed" | "getAndroidOfflineDeviceIds" | "recoverAndroidOfflineDevices"
    > = new MultiPlatformDeviceManager(),
    listRecordings: typeof listActiveVideoRecordings = listActiveVideoRecordings,
  ): void {
    if (this.deviceDisconnectMonitor) {
      return;
    }

    const discoverAndReconcile = async ({
      planActive,
      bypassAndroidDeviceListCache = false,
    }: {
      planActive: boolean;
      bypassAndroidDeviceListCache?: boolean;
    }) => {
      const discovery = await deviceManager.getBootedDevicesDetailed("either", {
        bypassAndroidDeviceListCache,
      });
      // Reconciliation can quarantine identity and cancel in-flight work. During
      // allocation, discovery supplies only presence evidence for miss counting.
      if (!planActive) {
        await this.devicePool.reconcileDiscoveryObservation(
          discovery.devices,
          "disconnect-monitor",
        );
      }
      return discovery;
    };

    this.deviceDisconnectMonitor = new SingleFlightInterval(
      this.timer,
      DEVICE_DISCONNECT_POLL_INTERVAL_MS,
      async () => {
        const planActive = serverConfig.isPlanExecutionActive();
        let adbServerResetCohort: readonly PooledDevice[] = [];
        try {
          this.startDeferredSessionRecoverySweep(planActive);

          let discovery = await discoverAndReconcile({ planActive });
          const bootedDevices = discovery.devices;
          let succeededPlatforms = discovery.succeededPlatforms;
          let bootedDeviceIds = new Set(bootedDevices.map((device) => device.deviceId));
          const activeRecordings = planActive ? [] : await listRecordings();

          const missingByDevice = new Map<string, string[]>();
          const { candidateDeviceIds, candidatePlatforms, candidateIncarnations } =
            this.collectDisconnectCandidates(activeRecordings);
          // Online-ness is otherwise binary: an in-session Android emulator
          // that dropped to ADB `offline` looks identical to one that is
          // fully gone, since bootedDeviceIds only ever contains `device`
          // -state serials. Ask only about candidates already missing from
          // that list, so a fully-healthy sweep never pays for this extra
          // `devices -l` probe (#7536).
          let offlineDeviceIds: Set<string> | undefined;
          try {
            if (!planActive) {
              const missingAndroidCandidateIds = this.findMissingAndroidCandidates(
                candidateDeviceIds,
                bootedDeviceIds,
                candidatePlatforms,
              );
              offlineDeviceIds =
                missingAndroidCandidateIds.size > 0
                  ? await deviceManager.getAndroidOfflineDeviceIds(missingAndroidCandidateIds)
                  : new Set<string>();
            }
          } catch (error) {
            if (!(error instanceof AndroidOfflineProbeError)) {
              throw error;
            }
            // Auxiliary probe failure supplies no evidence that an offline episode ended.
            logger.warn(
              `[DisconnectMonitor] Retaining offline recovery attempts: ${errorMessage(error)}`,
            );
          }
          if (!planActive) {
            const { dispatchTargets, offlineRecoveryTargets } = this.prepareOfflineRecovery(
              candidateDeviceIds,
              offlineDeviceIds,
              candidateIncarnations,
            );
            if (dispatchTargets.length > 0) {
              logger.warn(
                `[DisconnectMonitor] In-session device(s) ADB-offline (${offlineRecoveryTargets.join(", ")}); attempting bounded 'adb reconnect offline' recovery before miss-counting`,
              );
              // Global re-detect (adb has no per-serial reconnect target), one
              // shot per offline episode; failures are logged and swallowed
              // inside recoverAndroidOfflineDevices so a probe or recovery
              // hiccup here never blocks the miss-count/disconnect path below.
              await deviceManager.recoverAndroidOfflineDevices();
              // Reconnect may restore the transport during this await. Never use
              // the pre-recovery absence for miss counting or ADB-reset detection.
              discovery = await discoverAndReconcile({
                planActive,
                bypassAndroidDeviceListCache: true,
              });
              succeededPlatforms = discovery.succeededPlatforms;
              bootedDeviceIds = new Set(discovery.devices.map((device) => device.deviceId));
            }
          }

          const disconnectResult = evaluateDeviceDisconnects({
            deviceDisconnectMisses: this.deviceDisconnectMisses,
            confirmedDisconnectedDeviceIds: this.confirmedDisconnectedDeviceIds,
            bootedDeviceIds,
            candidateDeviceIds,
            succeededPlatforms,
            succeededSources: discovery.succeededSources,
            candidatePlatforms,
            candidateIncarnations,
            deviceDisconnectMissIncarnations: this.deviceDisconnectMissIncarnations,
            forceDisconnectedDeviceIds: this.forceDisconnectedDeviceIds,
          });

          if (disconnectResult.skippedAllDiscoveryFailed) {
            logger.warn(
              `[DisconnectMonitor] No platform discovery succeeded but ${candidateDeviceIds.size} tracked — skipping miss count`,
            );
            return;
          }

          this.logDisconnectMisses(disconnectResult, planActive, offlineDeviceIds, bootedDeviceIds);

          // Keep absence evidence current, but leave allocation's pool/session
          // state untouched. Two inactive ticks can confirm continued absence;
          // a booted device clears the evidence during evaluation.
          if (planActive) {
            logger.debug("[DisconnectMonitor] Deferring actions — plan execution active");
            return;
          }

          for (const deviceId of disconnectResult.disconnected) {
            missingByDevice.set(deviceId, []);
          }
          const detectedAdbServerResetCohort = getProcessWideAdbServerResetCohort(
            bootedDeviceIds,
            succeededPlatforms,
            this.forceDisconnectedDeviceIds,
            this.devicePool.getAllDevices(),
          );
          const adbServerResetDetachment =
            detectedAdbServerResetCohort.length > 0
              ? await this.devicePool.detachAdbServerResetCohort(detectedAdbServerResetCohort)
              : { devices: [], deferred: false };
          if (adbServerResetDetachment.deferred) {
            logger.info(
              "[DisconnectMonitor] Deferring process-wide ADB reset recovery until matching Android startup completes",
            );
            return;
          }
          adbServerResetCohort = adbServerResetDetachment.devices;
          const adbServerResetCohortByDeviceId = this.collectDisconnectedRecordings(
            adbServerResetCohort,
            missingByDevice,
            activeRecordings,
          );

          for (const [deviceId, recordingIds] of missingByDevice.entries()) {
            await this.cleanupDisconnectedDevice(
              deviceId,
              recordingIds,
              adbServerResetCohortByDeviceId,
            );
          }
        } catch (error) {
          logger.warn(`[Daemon] Device disconnect monitor failed: ${error}`);
        } finally {
          if (adbServerResetCohort.length > 0) {
            await this.devicePool.releaseAdbServerResetCohortReservations(adbServerResetCohort);
          }
        }
      },
    );
    this.deviceDisconnectMonitor.start();
  }

  private findMissingAndroidCandidates(
    candidateDeviceIds: Set<string>,
    bootedDeviceIds: Set<string>,
    candidatePlatforms: Map<string, "android" | "ios">,
  ): Set<string> {
    return new Set(
      [...candidateDeviceIds].filter(
        (deviceId) =>
          !bootedDeviceIds.has(deviceId) && candidatePlatforms.get(deviceId) === "android",
      ),
    );
  }

  private startDeferredSessionRecoverySweep(planActive: boolean): void {
    if (!planActive) {
      this.trackDeferredSessionRecoverySweep(
        this.devicePool.retryDueDeferredSessionRecoveries().catch((error) => {
          logger.warn(
            `[DisconnectMonitor] Deferred session recovery sweep failed: ${error}`,
            error,
          );
        }),
      );
    }
  }

  private collectDisconnectedRecordings(
    adbServerResetCohort: readonly PooledDevice[],
    missingByDevice: Map<string, string[]>,
    activeRecordings: Awaited<ReturnType<typeof listActiveVideoRecordings>>,
  ): Map<string, PooledDevice> {
    const processWideAdbServerReset = adbServerResetCohort.length > 0;
    const adbServerResetCohortByDeviceId = new Map(
      adbServerResetCohort.map((device) => [device.id, device]),
    );
    if (processWideAdbServerReset) {
      logger.warn(
        "[DisconnectMonitor] All AutoMobile-owned Android emulators disappeared together; " +
          "treating this as an ADB server reset and recovering by AVD name",
      );
      for (const device of adbServerResetCohort) {
        missingByDevice.set(device.id, []);
      }
    }

    for (const recording of activeRecordings) {
      if (missingByDevice.has(recording.deviceId)) {
        missingByDevice.get(recording.deviceId)!.push(recording.recordingId);
      }
    }
    return adbServerResetCohortByDeviceId;
  }

  private collectDisconnectCandidates(
    activeRecordings: Awaited<ReturnType<typeof listActiveVideoRecordings>>,
  ) {
    const candidateDeviceIds = new Set<string>();
    const candidatePlatforms = new Map<string, "android" | "ios">();
    const candidateIncarnations = recordingCandidateIncarnations(activeRecordings);
    for (const recording of activeRecordings) {
      candidateDeviceIds.add(recording.deviceId);
      candidatePlatforms.set(recording.deviceId, recording.platform);
    }
    for (const device of this.devicePool.getAllDevices()) {
      candidateDeviceIds.add(device.id);
      candidatePlatforms.set(device.id, device.platform);
      candidateIncarnations.set(device.id, device.incarnation);
    }
    for (const session of this.sessionManager.getAllSessions()) {
      candidateDeviceIds.add(session.assignedDevice);
      if (!candidatePlatforms.has(session.assignedDevice)) {
        candidatePlatforms.set(session.assignedDevice, session.platform);
      }
    }
    return { candidateDeviceIds, candidatePlatforms, candidateIncarnations };
  }

  private prepareOfflineRecovery(
    candidateDeviceIds: Set<string>,
    offlineDeviceIds: Set<string> | undefined,
    candidateIncarnations: ReturnType<typeof recordingCandidateIncarnations>,
  ) {
    this.offlineRecoveryAttemptedDeviceIds = pruneStaleOfflineRecoveryAttempts(
      this.offlineRecoveryAttemptedDeviceIds,
      candidateDeviceIds,
      offlineDeviceIds,
      this.offlineRecoveryAttemptedIncarnations,
      candidateIncarnations,
    );
    // A serial that is mid-provisionDevice/startDevice already has its
    // own bounded offline recovery: AndroidEmulatorClient's
    // fresh-provision readiness wait (maybeRecoverFreshOffline, #7054/
    // #7078) owns that serial's `adb reconnect offline` on its own 15s
    // threshold. Deferring to it here mirrors how the ADB-reset cohort
    // path (below) defers on the same in-flight-startup lease, so the
    // monitor never races a second reconnect against the readiness
    // wait's own dispatch.
    const inFlightStartupOfflineDeviceIds = new Set(
      [...(offlineDeviceIds ?? [])].filter((deviceId) =>
        this.devicePool.isDeviceLeasedForAndroidStartup(deviceId),
      ),
    );
    const offlineRecoveryTargets = selectOfflineRecoveryCandidates(
      offlineDeviceIds ?? new Set(),
      candidateDeviceIds,
      this.offlineRecoveryAttemptedDeviceIds,
      inFlightStartupOfflineDeviceIds,
    );
    const dispatchTargets = inFlightStartupOfflineDeviceIds.size > 0 ? [] : offlineRecoveryTargets;
    this.offlineRecoveryAttemptedDeviceIds = new Set([
      ...this.offlineRecoveryAttemptedDeviceIds,
      ...dispatchTargets,
    ]);
    this.offlineRecoveryAttemptedIncarnations = new Map(
      [...candidateIncarnations].filter(([deviceId]) =>
        this.offlineRecoveryAttemptedDeviceIds.has(deviceId),
      ),
    );
    return { dispatchTargets, offlineRecoveryTargets };
  }

  private logDisconnectMisses(
    disconnectResult: ReturnType<typeof evaluateDeviceDisconnects>,
    planActive: boolean,
    offlineDeviceIds: Set<string> | undefined,
    bootedDeviceIds: Set<string>,
  ): void {
    for (const { deviceId, misses: evaluatedMisses } of disconnectResult.missed) {
      const misses = planActive
        ? Math.min(evaluatedMisses, PLAN_DEVICE_DISCONNECT_MISS_CAP)
        : evaluatedMisses;
      if (planActive) {
        // Also lower pre-plan misses so a plan-driven restart gets the same grace.
        this.deviceDisconnectMisses.set(deviceId, misses);
      }
      const missState = offlineDeviceIds?.has(deviceId) ? "offline" : "absent";
      const message = `[DisconnectMonitor] Device ${deviceId} not in booted list (${missState}, miss ${misses}/${DEVICE_DISCONNECT_MISS_THRESHOLD}, booted=${bootedDeviceIds.size})`;
      if (planActive && evaluatedMisses > PLAN_DEVICE_DISCONNECT_MISS_CAP) {
        logger.debug(message);
      } else {
        logger.info(message);
      }
    }
  }

  private captureDisconnectCleanup(
    deviceId: string,
    adbServerResetCohortByDeviceId: Map<string, PooledDevice>,
  ) {
    const pooledDeviceAtDisconnect = this.devicePool.getDevice(deviceId);
    const assignmentCountAtDisconnect = pooledDeviceAtDisconnect?.assignmentCount;
    const sessionIdAtDisconnect =
      pooledDeviceAtDisconnect?.sessionId ?? this.sessionManager.getSessionForDevice(deviceId);
    const sessionAtDisconnect = sessionIdAtDisconnect
      ? this.sessionManager.getSession(sessionIdAtDisconnect)
      : null;
    const forceGenerationAtDisconnect = this.forceDisconnectedDeviceGenerations.get(deviceId);
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

  private confirmDisconnectedDeviceCleanup(
    deviceId: string,
    forceGenerationAtDisconnect: number | undefined,
  ): void {
    this.confirmedDisconnectedDeviceIds.add(deviceId);
    this.deviceDisconnectMisses.delete(deviceId);
    this.deviceDisconnectMissIncarnations.delete(deviceId);
    this.offlineRecoveryAttemptedDeviceIds.delete(deviceId);
    this.offlineRecoveryAttemptedIncarnations.delete(deviceId);
    if (this.forceDisconnectedDeviceGenerations.get(deviceId) === forceGenerationAtDisconnect) {
      this.forceDisconnectedDeviceIds.delete(deviceId);
      this.forceDisconnectedDeviceGenerations.delete(deviceId);
    }
  }

  private async cleanupDisconnectedDevice(
    deviceId: string,
    recordingIds: string[],
    adbServerResetCohortByDeviceId: Map<string, PooledDevice>,
  ): Promise<void> {
    const captured = this.captureDisconnectCleanup(deviceId, adbServerResetCohortByDeviceId);
    const { pooledDeviceAtDisconnect, forceGenerationAtDisconnect, adbServerResetTarget } =
      captured;
    if (
      !adbServerResetTarget &&
      (await this.shouldSkipStaleDisconnectCleanup(
        pooledDeviceAtDisconnect,
        deviceId,
        forceGenerationAtDisconnect,
      ))
    ) {
      return;
    }
    let deviceCleanupSucceeded = true;

    // Stop performance monitoring for this device
    getPerformanceMonitor().stopMonitoring(deviceId);

    for (const recordingId of recordingIds) {
      if (!(await this.stopRecordingAfterDeviceDisconnect(recordingId, deviceId))) {
        deviceCleanupSucceeded = false;
      }
    }

    if (
      !adbServerResetTarget &&
      (await this.shouldSkipStaleDisconnectCleanup(
        pooledDeviceAtDisconnect,
        deviceId,
        forceGenerationAtDisconnect,
      ))
    ) {
      return;
    }

    if (adbServerResetTarget) {
      if (
        await this.tryRecoverProcessWideAdbServerResetDevice(
          deviceId,
          adbServerResetTarget,
          forceGenerationAtDisconnect,
        )
      ) {
        return;
      }
    }

    return this.finishDisconnectedDeviceCleanup(deviceId, captured, deviceCleanupSucceeded);
  }

  private async finishDisconnectedDeviceCleanup(
    deviceId: string,
    captured: ReturnType<Daemon["captureDisconnectCleanup"]>,
    deviceCleanupSucceeded: boolean,
  ): Promise<void> {
    const {
      pooledDeviceAtDisconnect,
      assignmentCountAtDisconnect,
      sessionIdAtDisconnect,
      sessionAtDisconnect,
      forceGenerationAtDisconnect,
    } = captured;
    // Cancel active executions and release the session so the test fails
    // fast instead of waiting for the full MCP request timeout.
    const { incidentId, handled } = await this.recordAndTryRecoverCapturedDisconnect(
      deviceId,
      pooledDeviceAtDisconnect,
      assignmentCountAtDisconnect ?? 0,
      sessionIdAtDisconnect,
      sessionAtDisconnect,
      forceGenerationAtDisconnect,
    );
    if (handled) {
      return;
    }
    if (
      !this.isCapturedDisconnectTargetCurrent(
        deviceId,
        pooledDeviceAtDisconnect,
        assignmentCountAtDisconnect,
        sessionIdAtDisconnect,
        sessionAtDisconnect,
      )
    ) {
      await this.devicePool.finishEmulatorLossIncident(incidentId, "not-attempted");
      return;
    }
    if (sessionIdAtDisconnect && sessionAtDisconnect) {
      logger.warn(
        `[DisconnectMonitor] Device ${deviceId} confirmed disconnected after ${DEVICE_DISCONNECT_MISS_THRESHOLD} consecutive misses — cancelling session ${sessionIdAtDisconnect}`,
      );
      await this.cancelAndReleaseSession(
        sessionIdAtDisconnect,
        deviceLossCancellationReason(deviceId, incidentId),
        false,
        sessionAtDisconnect,
      );
    }

    if (
      !this.isCapturedDisconnectTargetCurrent(
        deviceId,
        pooledDeviceAtDisconnect,
        assignmentCountAtDisconnect,
      )
    ) {
      await this.devicePool.finishEmulatorLossIncident(incidentId, "not-attempted");
      return;
    }
    await this.devicePool.removeDisconnectedDevice(
      deviceId,
      true,
      incidentId,
      pooledDeviceAtDisconnect ?? undefined,
    );
    // Drop any per-device input caches so a device replaced under the same
    // serial does not inherit the previous one's cached API-level capability
    // (issue #3351): an API 31+/pre-31 mismatch mis-handles SHIFT/uppercase.
    // This fires only on a CONFIRMED disappearance; a fast same-serial restart
    // that never confirms is handled by the device-ready callback; the 5-min
    // idle close remains a fallback.
    if (this.devicePool.getDevice(deviceId)) {
      // removeDisconnectedDevice can synchronously recover a same-serial
      // Android emulator (reboot → re-add), which mints a fresh epoch. The
      // device is live again, so retiring here would delete that just-minted
      // epoch; skip the retire and let cleanup fail so the monitor retries.
      deviceCleanupSucceeded = false;
    } else {
      this.socketServer?.evictDeviceInputCache(deviceId);
    }
    if (deviceCleanupSucceeded) {
      this.confirmDisconnectedDeviceCleanup(deviceId, forceGenerationAtDisconnect);
    }
  }

  private trackDeferredSessionRecoverySweep(sweep: Promise<void>): void {
    this.deferredSessionRecoverySweeps.add(sweep);
    void sweep.then(
      () => this.deferredSessionRecoverySweeps.delete(sweep),
      () => this.deferredSessionRecoverySweeps.delete(sweep),
    );
  }

  private async tryRecoverProcessWideAdbServerResetDevice(
    deviceId: string,
    pooledDevice: PooledDevice,
    forceGenerationAtDisconnect: number | undefined,
  ): Promise<boolean> {
    try {
      return await this.recoverProcessWideAdbServerResetDevice(
        deviceId,
        pooledDevice,
        forceGenerationAtDisconnect,
      );
    } catch (error) {
      logger.warn(
        `[DisconnectMonitor] ADB-reset recovery failed for ${deviceId}; continuing cohort cleanup: ${error}`,
      );
      return false;
    }
  }

  private async recoverProcessWideAdbServerResetDevice(
    deviceId: string,
    pooledDevice: PooledDevice,
    forceGenerationAtDisconnect: number | undefined,
  ): Promise<boolean> {
    const recovered = await this.devicePool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      deviceId,
      pooledDevice,
    );
    if (!recovered) {
      this.retireAdbServerResetDisconnectState(deviceId, forceGenerationAtDisconnect);
      return false;
    }

    this.retireAdbServerResetDisconnectState(deviceId, forceGenerationAtDisconnect);
    return true;
  }

  private retireAdbServerResetDisconnectState(
    deviceId: string,
    forceGenerationAtDisconnect: number | undefined,
  ): void {
    this.socketServer?.evictDeviceInputCache(deviceId);
    this.deviceDisconnectMisses.delete(deviceId);
    this.deviceDisconnectMissIncarnations.delete(deviceId);
    this.confirmedDisconnectedDeviceIds.delete(deviceId);
    if (this.forceDisconnectedDeviceGenerations.get(deviceId) === forceGenerationAtDisconnect) {
      this.forceDisconnectedDeviceIds.delete(deviceId);
      this.forceDisconnectedDeviceGenerations.delete(deviceId);
    }
  }

  private async stopRecordingAfterDeviceDisconnect(
    recordingId: string,
    deviceId: string,
  ): Promise<boolean> {
    if (this.stoppingRecordings.has(recordingId)) {
      return false;
    }
    this.stoppingRecordings.add(recordingId);
    try {
      await stopVideoRecording(recordingId);
      logger.warn(
        `[Daemon] Stopped recording ${recordingId} after device ${deviceId} disconnected`,
      );
      return true;
    } catch (error) {
      logger.warn(
        `[Daemon] Failed to stop recording ${recordingId} after device ${deviceId} disconnected: ${error}`,
      );
      return await this.interruptRecordingAfterDeviceDisconnect(recordingId, deviceId);
    } finally {
      this.stoppingRecordings.delete(recordingId);
    }
  }

  private async interruptRecordingAfterDeviceDisconnect(
    recordingId: string,
    deviceId: string,
  ): Promise<boolean> {
    try {
      await interruptVideoRecording(recordingId);
      logger.warn(
        `[Daemon] Marked recording ${recordingId} interrupted after device ${deviceId} disconnected`,
      );
      return true;
    } catch (error) {
      logger.warn(
        `[Daemon] Failed to mark recording ${recordingId} interrupted after device ${deviceId} disconnected: ${error}`,
      );
      return false;
    }
  }

  private async shouldSkipStaleDisconnectCleanup(
    pooledDeviceAtDisconnect: PooledDevice | null,
    deviceId: string,
    forceGenerationAtDisconnect: number | undefined = this.forceDisconnectedDeviceGenerations.get(
      deviceId,
    ),
  ): Promise<boolean> {
    if (!pooledDeviceAtDisconnect) {
      if (!this.devicePool.getDevice(deviceId)) {
        return false;
      }
      this.deviceDisconnectMisses.delete(deviceId);
      this.deviceDisconnectMissIncarnations.delete(deviceId);
      this.confirmedDisconnectedDeviceIds.delete(deviceId);
      if (this.forceDisconnectedDeviceGenerations.get(deviceId) === forceGenerationAtDisconnect) {
        this.forceDisconnectedDeviceIds.delete(deviceId);
        this.forceDisconnectedDeviceGenerations.delete(deviceId);
      }
      logger.info(
        `[DisconnectMonitor] Skipping stale disconnect cleanup for recovered device ${deviceId}`,
      );
      return true;
    }
    const disconnectStatus =
      await this.devicePool.isCurrentDisconnectedDevice(pooledDeviceAtDisconnect);
    if (disconnectStatus === "current") {
      return false;
    }
    if (disconnectStatus === "unknown") {
      logger.warn(
        `[DisconnectMonitor] Retaining disconnect state for ${deviceId}: recovery verification was inconclusive`,
      );
      return true;
    }
    this.deviceDisconnectMisses.delete(deviceId);
    this.deviceDisconnectMissIncarnations.delete(deviceId);
    this.confirmedDisconnectedDeviceIds.delete(deviceId);
    if (this.forceDisconnectedDeviceGenerations.get(deviceId) === forceGenerationAtDisconnect) {
      this.forceDisconnectedDeviceIds.delete(deviceId);
      this.forceDisconnectedDeviceGenerations.delete(deviceId);
    }
    logger.info(
      `[DisconnectMonitor] Skipping stale disconnect cleanup for recovered device ${deviceId}`,
    );
    return true;
  }

  private isCapturedDisconnectTargetCurrent(
    deviceId: string,
    pooledDeviceAtDisconnect: PooledDevice | null,
    assignmentCountAtDisconnect: number | undefined,
    sessionIdAtDisconnect?: string | null,
    sessionAtDisconnect?: Session | null,
  ): boolean {
    if (pooledDeviceAtDisconnect) {
      if (
        this.devicePool.getDevice(deviceId) !== pooledDeviceAtDisconnect ||
        pooledDeviceAtDisconnect.assignmentCount !== assignmentCountAtDisconnect
      ) {
        return false;
      }
    } else if (this.devicePool.getDevice(deviceId)) {
      return false;
    }

    if (!sessionIdAtDisconnect) {
      return this.sessionManager.getSessionForDevice(deviceId) === null;
    }
    return (
      this.sessionManager.getSessionForDevice(deviceId) === sessionIdAtDisconnect &&
      this.sessionManager.getSession(sessionIdAtDisconnect) === sessionAtDisconnect
    );
  }

  private startAdbMissingDeviceListener(): void {
    if (this.unsubscribeAdbMissingDevice) {
      return;
    }

    this.unsubscribeAdbMissingDevice = onAdbMissingDevice((event) => {
      if (
        !this.devicePool.getDevice(event.deviceId) &&
        !this.sessionManager.getSessionForDevice(event.deviceId)
      ) {
        return;
      }
      logger.warn(
        `[Daemon] ADB reported tracked device ${event.deviceId} missing: ${event.message}`,
      );
      this.forceDisconnectedDeviceIds.add(event.deviceId);
      this.forceDisconnectedDeviceGenerations.set(
        event.deviceId,
        (this.forceDisconnectedDeviceGenerations.get(event.deviceId) ?? 0) + 1,
      );
    });
  }

  private async cancelAndReleaseSession(
    sessionId: string,
    releaseReason: string = "explicit-release",
    allowExpired: boolean = false,
    expectedSession?: Session,
    shouldCommit?: () => boolean,
    options?: { deferFailureFallback?: boolean },
  ): Promise<boolean> {
    const cancelled = await executionTracker.cancelSessionUuidExecutions(sessionId, releaseReason);
    // Early identity fence: discovery can replace a same-serial runtime while
    // execution cancellation is in flight. It is not the final one — the
    // session manager re-evaluates `shouldCommit` immediately before it
    // removes the session, after its own setup/restoration awaits (#7031).
    if (shouldCommit?.() === false) {
      return false;
    }
    // Capture the owner before release can remove it or hide it behind a
    // terminal fence. Pool lookup also covers expired sessions during shutdown.
    const assignedDeviceId =
      expectedSession?.assignedDevice ??
      this.devicePool.getAllDevices().find((device) => device.sessionId === sessionId)?.id ??
      null;
    let deviceId: string | null = null;
    let superseded = false;
    await releaseSessionAndDevice(
      this.sessionManager,
      this.devicePool,
      assignedDeviceId,
      sessionId,
      releaseReason,
      {
        ...options,
        release: async () => {
          if (expectedSession) {
            deviceId = await this.sessionManager.releaseSessionIfOwned(
              sessionId,
              expectedSession,
              expectedSession.assignedDevice,
              releaseReason,
            );
          } else if (shouldCommit) {
            const release = await this.sessionManager.releaseSessionUnlessSuperseded(
              sessionId,
              releaseReason,
              shouldCommit,
              allowExpired,
            );
            if (release.superseded) {
              logger.info(
                `Kept session ${sessionId}: a newer identity confirmation superseded its release (reason=${releaseReason})`,
              );
              superseded = true;
              return null;
            }
            deviceId = release.deviceId;
          } else {
            deviceId = await this.sessionManager.releaseSession(
              sessionId,
              releaseReason,
              allowExpired,
            );
          }
          // A completed persistence retry may return a device already idle or
          // reassigned. Do not issue a stale pool release or report it as freed.
          if (!this.isSessionDeviceAssigned(deviceId, sessionId)) {
            deviceId = null;
          }
          return deviceId;
        },
      },
    );
    if (superseded) {
      return false;
    }
    if (!deviceId || this.isSessionDeviceAssigned(deviceId, sessionId)) {
      logger.info(
        `Cancelled session ${sessionId} (${cancelled} executions); no device freed (reason=${releaseReason})`,
      );
      return false;
    }
    logger.info(
      `Cancelled session ${sessionId} (${cancelled} executions) and released device ${deviceId} ` +
        `(reason=${releaseReason})`,
    );
    return true;
  }

  private isSessionDeviceAssigned(deviceId: string | null, sessionId: string): boolean {
    return deviceId !== null && this.devicePool.getDevice(deviceId)?.sessionId === sessionId;
  }

  private async cancelAndDrainDeviceExecutions(
    deviceId: string,
    reason: string,
    options?: { excludeExecutionId?: string },
  ): Promise<number> {
    const cancelled = await executionTracker.cancelDeviceExecutions(deviceId, reason, options);
    if (cancelled === 0) {
      return 0;
    }
    const drained = await executionTracker.waitForDeviceExecutionsToEnd(
      deviceId,
      DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS,
      options,
    );
    if (!drained) {
      logger.warn(
        `[Daemon] Timed out after ${DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS}ms draining ` +
          `cancelled executions for device ${deviceId}`,
      );
    }
    return cancelled;
  }

  private async cancelAndDrainDeviceSessionExecutions(
    sessionId: string,
    reason: string,
    options?: { excludeExecutionId?: string },
  ): Promise<number> {
    const cancelled = await executionTracker.cancelDeviceSessionExecutions(
      sessionId,
      reason,
      options,
    );
    if (cancelled === 0) {
      return 0;
    }
    const drained = await executionTracker.waitForDeviceSessionExecutionsToEnd(
      sessionId,
      DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS,
      options,
    );
    if (!drained) {
      logger.warn(
        `[Daemon] Timed out after ${DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS}ms draining ` +
          `cancelled executions for device session ${sessionId}`,
      );
    }
    return cancelled;
  }

  /**
   * Attempt to recover daemon components
   */
  private async attemptRecovery(failureKind: HealthFailureKind = "unknown"): Promise<void> {
    try {
      logger.info("Attempting daemon recovery...");

      if (failureKind === "database") {
        logger.error(
          "Database health check failed repeatedly; exiting daemon for a clean restart.",
        );
        await this.recoverFromDatabaseHealthFailure(1);
        return;
      }

      // Try to restart socket server if it's not responding
      if (this.socketServer && !this.socketServer.isListening()) {
        logger.info("Restarting socket server...");
        try {
          await this.socketServer.close();
        } catch (error) {
          logger.warn(`Error closing socket server during recovery: ${error}`);
        }

        // Recreate socket server
        const mcpEndpoint = `http://${this.host}:${this.port}${MCP_STREAMABLE_PATH}`;
        this.socketServer = new UnixSocketServer(
          SOCKET_PATH,
          mcpEndpoint,
          undefined,
          undefined,
          FeatureFlagService.getInstance(),
          {
            identityStartedAt: this.generationStartedAt,
            processGenerationToken: this.processGenerationToken,
            startupOptions: this.options,
            onRepublishIdentity: () => this.republishIdentity(),
            startupCompletion: this.startupCompletion,
            pidFilePath: PID_FILE_PATH,
            sockets: getDaemonSocketPathsByName(),
            dbPath: getDatabasePath(),
            processStartedAt: this.processStartedAt,
            onRestartAccepted: () => {
              setImmediate(() => process.kill(process.pid, "SIGTERM"));
            },
            liveAcceptanceStartupSecret: this.liveAcceptanceStartupSecret,
            acceptanceDiscoveryCapability: this.acceptanceDiscoveryCapability,
          },
          this.idGenerator,
          // Recovery reuses the same ownership evidence as initial startup. A
          // replacement socket is never reclaimed merely because this daemon
          // previously held the namespace.
          { ownerLiveness: this.incumbentOwnerGuard.asSocketOwnerLiveness() },
        );
        try {
          await this.socketServer.start();
          logger.info("Socket server restarted successfully");
        } catch (error) {
          logger.error(`Failed to restart socket server: ${error}`);
        }
      }

      if (!this.observationStreamHealth.isHealthy()) {
        logger.info("Restarting observation stream socket server...");
        try {
          await this.observationStreamHealth.recover();
          // DefaultObservationStreamHealth recreates the device-data singleton.
          // Reinstall routing, lifecycle delivery, cadence, observation, and
          // navigation callbacks on that replacement.
          this.configureDeviceDataStreamServer();
          logger.info("Observation stream socket server restarted successfully");
        } catch (error) {
          logger.error(`Failed to restart observation stream socket server: ${error}`);
        }
      }
    } catch (error) {
      logger.error(`Recovery attempt failed: ${error}`);
    }
  }

  /**
   * Initialize device pool with timeout
   * Waits for device discovery with configurable timeout
   */
  private async initializeDevicePoolWithTimeout(timeoutMs: number): Promise<void> {
    const timedOut = Symbol("device pool initialization timeout");
    try {
      await raceWithDeadline(() => this.initializeDevicePool(), {
        timer: this.timer,
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
    const deviceCount = this.devicePool.getTotalDeviceCount();
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
   */
  private async initializeDevicePool(): Promise<void> {
    try {
      // Use the pool's refresh path instead of replacing entries directly. The
      // startup timeout does not cancel discovery, so this may run after a
      // session has claimed a device; refresh preserves that owner and its
      // incarnation when rediscovering the same device.
      const outcome = await this.devicePool.refreshDevicesWithOutcome();
      const bootedDevices = this.devicePool.getAllDevices();

      if (bootedDevices.length > 0) {
        // Mint a device-session epoch for every startup-booted device so
        // daemon/listDeviceSessions enumerates idle devices immediately, without
        // waiting for a first assignment/refresh. The refresh callback may have
        // minted these already; this is idempotent because the incarnation is
        // unchanged (epic #5256).
        for (const pooled of this.devicePool.getAllDevices()) {
          this.deviceSessionRegistry.onDeviceConnected({
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
   */
  private async initializeIosServices(): Promise<void> {
    // A live-acceptance daemon discovers a controlled target before it performs
    // any device mutation. Warming every already-booted simulator here would
    // launch CtrlProxy on unrelated devices before that authenticated selection.
    // The later, explicit acquisition path still initializes its chosen target.
    if (!this.passiveWorkPolicy.isIosPassiveWorkEnabled()) {
      logger.info("[Daemon] Skipping iOS CtrlProxy warm-up for live acceptance");
      return;
    }
    const iosDevices = selectIosStartupWarmupDevices(
      this.devicePool.getAllDevices(),
      this.passiveWorkPolicy,
    );
    if (iosDevices.length === 0) {
      logger.debug("[Daemon] No iOS devices to initialize CtrlProxy iOS for");
      return;
    }

    logger.info(`[Daemon] Initializing CtrlProxy iOS for ${iosDevices.length} iOS device(s)...`);
    const deviceSessionManager = DeviceSessionManager.getInstance();

    await initializeIosCtrlProxyAtStartup(
      iosDevices.map((device) => device.id),
      {
        timer: this.timer,
        // Per-device timeout to prevent hanging on unresponsive devices
        perDeviceTimeoutMs: 5000,
        pendingPrefetch: () => IosCtrlProxyBuilder.pendingPrefetch(),
        isShuttingDown: () => this.shutdownInProgress,
        verifyIosDevice: (deviceId, options) =>
          deviceSessionManager.verifyIosDevice(deviceId, options),
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
  private async initializeDatabase(): Promise<void> {
    try {
      // getDatabase() + await ensureMigrations(): a failed startup migration
      // rejects here (rather than swallowing on a detached promise).
      await this.databaseInitializer.initialize();
      // Reload durable tool-selection-profile provenance (issue #6225) so a
      // profile minted before this restart/upgrade is still recognized when a
      // client reaffirms it — without this, `setToolEnabled` would force it
      // through a re-mint. Never fatal: the loader already logs and swallows
      // its own failures (see PersistentToolSelectionProfileRegistry), leaving
      // the registry empty (the pre-#6225 behavior) rather than blocking the
      // FATAL database bring-up this method guards.
      await this.toolSelectionProfileProvenanceLoader.load();
      // Clear installed apps cache from previous daemon sessions
      await this.installedAppsRepository.clearOldDaemonSessions(this.daemonSessionId);
      // A discovery failure is intentionally startup-fatal through this method's
      // catch: treating it as an empty live set would let this daemon steal a
      // live peer's sessions, which is less safe than refusing startup.
      const liveDaemonSessionIds = new Set(
        this.liveDaemonSessionIdProvider.collectLiveDaemonSessionIds(),
      );
      const incumbentDaemonSessionId =
        this.incumbentOwnerGuard.capturedLiveIncumbentDaemonSessionId();
      if (incumbentDaemonSessionId !== undefined) {
        liveDaemonSessionIds.add(incumbentDaemonSessionId);
      }
      await this.deviceSessionRepository.markStaleActiveSessionsExpired(
        this.daemonSessionId,
        this.timer.now(),
        "daemon-restart",
        liveDaemonSessionIds,
      );
      logger.info(
        `[Daemon] Cleared old daemon session caches, current session: ${this.daemonSessionId}`,
      );
    } catch (error) {
      // Delegate to the shared startup guard so this path and the earlier
      // feature-flag DB touch (guarded in main() before start()) funnel through
      // the identical classify/record/backoff/rethrow circuit breaker.
      await handleFatalDatabaseStartupFailure(error, this.startupFailureTracker, this.timer);
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    if (this.shutdownHandlersRegistered) {
      return;
    }
    this.shutdownHandlersRegistered = true;
    installProcessLifecycleHandlers();

    const shutdown = async (signal: string) => {
      if (this.shutdownInProgress) {
        return;
      }
      this.shutdownInProgress = true;
      logger.info(`Received ${signal}, shutting down daemon...`);
      await this.stop();
    };

    setProcessShutdownHandler(shutdown);
    process.once("exit", () => {
      cleanupDaemonFilesSync(this.getDaemonFileCleanupOptions());
    });
    // Escaped throws in un-awaited callbacks/timers and floating rejections must
    // NOT crash the shared singleton daemon and wedge every session (issue #3408).
    // Log-then-continue; the offending tool call already failed on its own chain.
    setFatalProcessHandler(createDaemonFatalProcessHandler(logger));
  }

  /**
   * Stop the daemon gracefully
   */
  async stop(): Promise<void> {
    this.shutdownInProgress = true;
    logger.info("Stopping daemon...");
    await this.quiesceProvisioningIngress();
    await this.interruptProvisioningForShutdown();
    this.shutdownReleaseNotifications = new Set();
    this.shutdownFallbackReleaseNotifications = new Set();
    this.shutdownSessionIds = [];

    const heartbeatMonitor = this.heartbeatMonitor;
    this.heartbeatMonitor = null;
    const navigationRetentionMonitor = this.navigationRetentionMonitor;
    this.navigationRetentionMonitor = null;
    const deviceDisconnectMonitor = this.deviceDisconnectMonitor;
    this.deviceDisconnectMonitor = null;
    await runShutdownCleanupStages(
      [
        {
          // Quiesce new recording work and stop owned children before any
          // potentially blocking socket teardown consumes the shutdown budget.
          name: "active capture and iOS CtrlProxy children",
          run: cleanupDaemonChildProcesses,
        },
        {
          name: "health check timer",
          run: async () => {
            this.stopHealthCheckTimer();
            await this.databaseHealthProbe.dispose?.();
          },
        },
        {
          name: "location routes",
          run: () => defaultLocationRouteRegistry.stopAll(),
        },
        {
          name: "shutdown monitors",
          run: () =>
            this.drainShutdownMonitors(
              navigationRetentionMonitor,
              heartbeatMonitor,
              deviceDisconnectMonitor,
            ),
        },
        {
          name: "ADB missing-device subscription",
          run: () => {
            if (this.unsubscribeAdbMissingDevice) {
              this.unsubscribeAdbMissingDevice();
              this.unsubscribeAdbMissingDevice = null;
            }
          },
        },
        {
          // Stop the session cleanup interval before the DB drain below. It is the one
          // best-effort DB writer that fires on its own timer rather than an external
          // socket (which are all torn down here), so if left running it could route a
          // tracked `markReleased` write through a freshly-resolved, non-draining
          // barrier in the microtask window AFTER closeDatabase()'s resetDbWriteBarrier()
          // and hit the just-closed connection (issue #2912; #2792 safety window).
          name: "session cleanup timer",
          run: () => {
            this.sessionManager.stopCleanupTimer();
            this.observerSessionRegistry.dispose();
          },
        },
        { name: "video recording socket server", run: stopVideoRecordingSocketServer },
        { name: "test recording socket server", run: stopTestRecordingSocketServer },
        { name: "device snapshot socket server", run: stopDeviceSnapshotSocketServer },
        { name: "appearance socket server", run: stopAppearanceSocketServer },
        { name: "performance stream socket server", run: stopPerformanceStreamSocketServer },
        { name: "performance push socket server", run: stopPerformancePushSocketServer },
        { name: "device data stream socket server", run: stopDeviceDataStreamSocketServer },
        { name: "failures stream socket server", run: stopFailuresStreamSocketServer },
        { name: "failures push socket server", run: stopFailuresPushSocketServer },
        { name: "telemetry push socket server", run: stopTelemetryPushSocketServer },
        { name: "WebRTC stream socket server", run: stopWebRtcStreamSocketServer },
        { name: "video stream socket server", run: stopVideoStreamSocketServer },
        {
          name: "iOS simulator capture helper pool",
          run: () => iosSimulatorCaptureHelperPool.shutdown(),
        },
        { name: "appearance sync scheduler", run: stopAppearanceSyncScheduler },
        { name: "performance monitor", run: stopPerformanceMonitor },
        {
          name: "active HTTP sessions",
          run: () =>
            runShutdownCleanupStages(
              Array.from(this.transports, ([sessionId, streamableTransport]) => ({
                name: `Streamable HTTP session ${sessionId}`,
                run: () => streamableTransport.close(),
              })),
              (message, error) => logger.warn(message, error),
            ),
        },
        {
          name: "active HTTP session registry",
          run: () => this.clearHttpSessionRegistry(),
        },
        {
          name: "HTTP server",
          run: () => this.closeHttpListener(),
        },
        { name: "active device sessions", run: () => this.releaseActiveSessionsForShutdown() },
        {
          name: "pending device cleanups",
          run: async () => {
            await this.sessionManager.drainPendingDeviceCleanups(
              DEVICE_CLEANUP_SHUTDOWN_DRAIN_TIMEOUT_MS,
            );
          },
        },
        {
          // Session release broadcasts must be written while subscribed proxy
          // sockets are still connected; closing first degrades the exact
          // daemon-shutdown reason into session-not-found after reconnect.
          name: "Unix socket server",
          run: async () => {
            if (this.socketServer) {
              this.publishMissingShutdownReleaseNotifications();
              await this.socketServer.drainSessionReleaseNotifications();
              await this.socketServer.close();
            }
          },
        },
        { name: "managed ADB server", run: this.stopManagedAdbServer },
        {
          name: "database write drain",
          run: () => this.drainShutdownDatabaseWrites(),
        },
        {
          name: "in-flight migrations",
          run: () => this.settleShutdownMigrations(),
        },
        {
          name: "database",
          run: async () => {
            if (!this.shutdownSessionReleasesDrained) {
              logger.warn(
                "Skipping database close because a session terminal write is still in flight",
              );
              return;
            }
            await closeDatabase();
          },
        },
        {
          name: "logger",
          run: async () => {
            logger.info("Daemon stopped");
            await logger.closeAfterFlush();
          },
        },
        // Removed LAST, only once logging has fully flushed and closed: the pid
        // record is this daemon's ONLY externally-observable liveness signal, and
        // the detached process keeps holding the inherited launch-log fd through
        // every earlier stage above. Removing it any earlier opens a window where
        // a concurrent pruning sweep in another process reads "no daemon" while
        // this one is still alive and still writing, and unlinks a launch log out
        // from under it (issue #6194). The unconditional `process.once("exit", ...)`
        // cleanup remains as a safety net for shutdown paths that never reach here.
        { name: "daemon files", run: () => cleanupDaemonFiles(this.getDaemonFileCleanupOptions()) },
      ],
      (message, error) => logger.warn(message, error),
    );
  }

  private clearHttpSessionRegistry(): void {
    for (const sessionId of this.httpSessionIdleTimers.keys()) {
      this.clearHttpSessionIdleTimer(sessionId);
    }
    this.activeHttpRequests.clear();
    this.transports.clear();
  }

  private async drainShutdownDatabaseWrites(): Promise<void> {
    // Quiesce in-flight best-effort DB writes (fire-and-forget telemetry ingest,
    // background retention cleanup) BEFORE closing the connection, so a query
    // queued in Kysely's ConnectionMutex can't strand shutdown on an unsettled
    // promise (issue #2792). Bounded: a wedged write cannot itself hang shutdown.
    const drained = await getDbWriteBarrier().drain(DB_WRITE_DRAIN_TIMEOUT_MS);
    if (!drained) {
      logger.warn(
        `Timed out after ${DB_WRITE_DRAIN_TIMEOUT_MS}ms draining in-flight DB writes; closing database anyway`,
      );
    }
  }

  private async settleShutdownMigrations(): Promise<void> {
    // If a SIGTERM arrived mid cold-start migration, the detached migration
    // connection is still open and writing on its own connection (its writes are
    // NOT tracked by the write barrier drained above). Let it settle before
    // closeDatabase() destroys the app connection, so their WAL writes/checkpoint
    // can't contend and stall shutdown on busy_timeout (Windows; issue #3044).
    // Bounded so a wedged migration cannot itself hang shutdown.
    const migrationsSettled = await awaitInFlightMigrations(MIGRATION_SETTLE_TIMEOUT_MS);
    if (!migrationsSettled) {
      logger.warn(
        `Timed out after ${MIGRATION_SETTLE_TIMEOUT_MS}ms awaiting in-flight startup migration; closing database anyway`,
      );
    }
  }

  private async drainShutdownMonitors(
    navigationRetentionMonitor: typeof this.navigationRetentionMonitor,
    heartbeatMonitor: typeof this.heartbeatMonitor,
    deviceDisconnectMonitor: typeof this.deviceDisconnectMonitor,
  ): Promise<void> {
    // The navigation retention monitor's in-flight pass drains via the DB
    // write-barrier stage below; here we only cancel its next scheduled tick.
    navigationRetentionMonitor?.stop();
    const [heartbeatSettled, disconnectSettled] = await Promise.all([
      heartbeatMonitor ? heartbeatMonitor.stop().then(() => true) : true,
      deviceDisconnectMonitor ? deviceDisconnectMonitor.stop() : true,
    ]);
    if (!heartbeatSettled) {
      logger.warn("Session heartbeat monitor did not settle before daemon shutdown");
    }
    if (!disconnectSettled) {
      logger.warn("Device disconnect monitor did not settle before daemon shutdown");
    }
    const timedOut = Symbol("recovery sweep drain timeout");
    let sweepsSettled = true;
    try {
      await raceWithDeadline(Promise.allSettled(this.deferredSessionRecoverySweeps), {
        timer: this.timer,
        timeoutMs: DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS,
        label: "Recovery sweep drain",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      sweepsSettled = false;
    }
    if (!sweepsSettled) {
      logger.warn(
        `Timed out after ${DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS}ms draining deferred session recovery sweeps; continuing daemon shutdown`,
      );
    }
  }

  /**
   * Close every ingress before interrupting active provisioning. Without this
   * ordering, a request can begin after the cancellation sweep and reach
   * shutdown teardown without persisting its retryable handoff outcome.
   */
  private async quiesceProvisioningIngress(): Promise<void> {
    this.acceptingHttpSessions = false;
    // Start closing the listener now so it cannot admit a connection after the
    // transport snapshot. The later HTTP server stage awaits this close.
    void this.closeHttpListener().catch((error) => {
      logger.warn(`Failed to begin HTTP listener shutdown: ${errorMessage(error)}`, error);
    });
    const quiescing = this.socketServer?.quiesce();
    this.sessionManager.stopAcceptingSessionCreations();
    await quiescing;
  }

  private async interruptProvisioningForShutdown(): Promise<void> {
    const reason = new DaemonHandoffInterruptionError(DAEMON_HANDOFF_INTERRUPTED_MESSAGE);
    const cancelled = await executionTracker.cancelToolExecutions("provisionDevice", reason);
    if (cancelled === 0) {
      return;
    }
    const drained = await executionTracker.waitForToolExecutionsToEnd(
      "provisionDevice",
      DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS,
    );
    if (!drained) {
      logger.warn(
        `Timed out after ${DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS}ms persisting ${cancelled} interrupted provisionDevice operation(s) before daemon shutdown`,
      );
    }
  }

  private async releaseActiveSessionsForShutdown(): Promise<void> {
    const sessionIds = this.sessionManager.getAllKnownSessionIds();
    this.shutdownSessionIds = sessionIds;
    const releases = sessionIds.map(async (sessionId) => {
      await this.cancelAndReleaseSession(sessionId, "daemon-shutdown", true);
    });
    const reportFailures = (results: PromiseSettledResult<void>[]): void => {
      for (const [index, release] of results.entries()) {
        if (release.status === "rejected") {
          logger.warn(
            `[Daemon] Failed to release session ${sessionIds[index] ?? "unknown"} during shutdown: ${release.reason}`,
          );
        }
      }
    };
    const settled = Promise.allSettled(releases);
    await Promise.resolve();
    const drained = await this.sessionManager.drainReleasePromises(
      SESSION_RELEASE_DRAIN_TIMEOUT_MS,
      releases,
    );
    if (!drained) {
      this.shutdownSessionReleasesDrained = false;
      logger.warn(
        `Timed out after ${SESSION_RELEASE_DRAIN_TIMEOUT_MS}ms draining session releases; database will remain open`,
      );
      void settled.then(reportFailures);
      return;
    }
    reportFailures(await settled);
  }

  /**
   * Preserve a recovery signal when a pre-existing terminal release remains
   * blocked past the bounded persistence drain. Normal release callbacks win;
   * only snapshot identities that have not emitted anything receive this
   * daemon-shutdown fallback before notification sockets close.
   */
  private publishMissingShutdownReleaseNotifications(): void {
    const notified = this.shutdownReleaseNotifications;
    const fallbacks = this.shutdownFallbackReleaseNotifications;
    if (!(notified && fallbacks)) {
      return;
    }
    for (const sessionId of this.shutdownSessionIds) {
      if (notified.has(sessionId) || fallbacks.has(sessionId)) {
        continue;
      }
      fallbacks.add(sessionId);
      SessionReleaseBroadcaster.emit(sessionId, "daemon-shutdown");
    }
  }

  private async startAuxiliarySocket(
    name: AuxiliaryDaemonSocketName,
    start: () => Promise<unknown>,
  ): Promise<void> {
    await start();
    const socketPath = getDaemonSocketPathsByName()[name];
    try {
      const { dev, ino } = statSync(socketPath);
      this.boundAuxSocketIdentities.set(socketPath, { dev, ino });
    } catch (error) {
      // A bound path we cannot identify must not be unlinked by exit cleanup.
      logger.warn(`[Daemon] Cannot record ownership of auxiliary socket ${socketPath}: ${error}`);
    }
  }

  private getDaemonFileCleanupOptions(): {
    expectedPid?: number;
    socketBindCommitted: boolean;
    socketPaths: string[];
    socketFileIdentities: ReadonlyMap<string, { dev: number; ino: number }>;
  } {
    // Gate destructive cleanup on actually holding the socket bind. A lock-less
    // contender refused over a live sibling (issue #6232) has written its early
    // owner record (issue #2871) — so `pidFileWritten` is already true and the
    // `expectedPid` self-check would authorize deletion — yet it never bound the
    // socket. Threading `socketBindCommitted` through makes the cleanup a no-op
    // for that loser, so the live winner's socket/PID files survive its exit
    // (the #6140 brick, prevented here rather than reached). An aux bind can
    // still be refused after this control bind, so only recorded aux paths join
    // the cleanup list.
    const socketBindCommitted = this.socketBindCommitted;
    const socketPaths = socketBindCommitted
      ? [SOCKET_PATH, ...this.boundAuxSocketIdentities.keys()]
      : [];
    const socketFileIdentities = this.boundAuxSocketIdentities;
    if (this.pidFileWritten) {
      return { expectedPid: process.pid, socketBindCommitted, socketPaths, socketFileIdentities };
    }
    const pidData = readPidFileDataSync();
    return pidData && pidData.pid !== process.pid
      ? { expectedPid: process.pid, socketBindCommitted, socketPaths, socketFileIdentities }
      : { socketBindCommitted, socketPaths, socketFileIdentities };
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
}

/**
 * Start the daemon process
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<void> {
  const daemon = new Daemon(options);
  await daemon.start();
}
