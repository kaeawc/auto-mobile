import { createServer as createHttpServer, Server as HttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../server";
import { logger } from "../utils/logger";
import { MultiPlatformDeviceManager } from "../utils/deviceUtils";
import { UnixSocketServer } from "./socketServer";
import { SessionManager } from "./sessionManager";
import { SessionHeartbeatMonitor } from "./SessionHeartbeatMonitor";
import { SingleFlightInterval } from "./SingleFlightInterval";
import { DevicePool, type PooledDevice } from "./devicePool";
import { parseDeviceRecoveryPolicy } from "./poolConfig";
import { DaemonState } from "./daemonState";
import { DeviceSessionRegistry } from "./deviceSessionRegistry";
import {
  DEFAULT_DAEMON_PORT,
  SOCKET_PATH,
  MCP_STREAMABLE_PATH,
  DAEMON_SESSION_TOOL_BINDING_HEADER,
  DAEMON_CAPABILITY_PROFILE_HEADER,
  DAEMON_PORT_RANGE_START,
  DAEMON_PORT_RANGE_END,
} from "./constants";
import { DaemonOptions, PidFileData } from "./types";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PID_FILE_PATH, DAEMON_VERSION } from "./constants";
import { getCurrentBuildIdentity } from "./buildIdentity";
import { cleanupDaemonFiles, cleanupDaemonFilesSync, readPidFileDataSync } from "./daemonFiles";
import { executionTracker } from "../server/executionTracker";
import { SessionReleaseBroadcaster } from "../server/sessionReleaseBroadcast";
import {
  awaitInFlightMigrations,
  closeDatabase,
  getDatabasePath,
  getDbWriteBarrier,
} from "../db";
import { DatabaseInitializer, DefaultDatabaseInitializer } from "../db/DatabaseInitializer";
import { DatabaseHealthProbe, DefaultDatabaseHealthProbe } from "../db/DatabaseHealthProbe";
import { StartupFailureTracker, DefaultStartupFailureTracker } from "./DaemonStartupFailureTracker";
import { handleFatalDatabaseStartupFailure } from "./daemonStartupGuard";
import { runStartupPrologue } from "./startupPrologue";
import { createDaemonFatalProcessHandler } from "./daemonFatalHandler";
import { startupBenchmark } from "../utils/startupBenchmark";
import { startVideoRecordingSocketServer, stopVideoRecordingSocketServer } from "./videoRecordingSocketServer";
import { startTestRecordingSocketServer, stopTestRecordingSocketServer } from "./testRecordingSocketServer";
import { startDeviceSnapshotSocketServer, stopDeviceSnapshotSocketServer } from "./deviceSnapshotSocketServer";
import { startAppearanceSocketServer, stopAppearanceSocketServer } from "./appearanceSocketServer";
import { startPerformanceStreamSocketServer, stopPerformanceStreamSocketServer } from "./performanceStreamSocketServer";
import { startPerformancePushSocketServer, stopPerformancePushSocketServer } from "./performancePushSocketServer";
import { startDeviceDataStreamSocketServer, stopDeviceDataStreamSocketServer, getDeviceDataStreamServer } from "./deviceDataStreamSocketServer";
import { startFailuresStreamSocketServer, stopFailuresStreamSocketServer } from "./failuresStreamSocketServer";
import { startFailuresPushSocketServer, stopFailuresPushSocketServer } from "./failuresPushSocketServer";
import { startTelemetryPushSocketServer, stopTelemetryPushSocketServer } from "./telemetryPushSocketServer";
import { startWebRtcStreamSocketServer, stopWebRtcStreamSocketServer } from "./webrtcStreamSocketServer";
import { startVideoStreamSocketServer, stopVideoStreamSocketServer } from "./videoStreamSocketServer";
import { getDaemonSocketPathsByName } from "./socketPaths";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import {
  pushInitialObservationFramesForSubscriber,
  type ObservationStreamIosClient,
} from "./observationInitialFrame";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import {
  convertSummaryToStreamData,
  createNavigationGraphRequestHandler,
} from "./navigationGraphRequestHandler";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import type { InstalledAppsStore } from "../db/installedAppsRepository";
import { InstalledAppsRepository } from "../db/installedAppsRepository";
import { DeviceSessionRepository } from "../db/deviceSessionRepository";
import { DeviceSessionManager } from "../utils/DeviceSessionManager";
import { startAppearanceSyncScheduler, stopAppearanceSyncScheduler } from "../utils/appearance/AppearanceSyncScheduler";
import { startPerformanceMonitor, stopPerformanceMonitor, getPerformanceMonitor } from "../features/performance/PerformanceMonitor";
import { interruptVideoRecording, listActiveVideoRecordings, stopVideoRecording } from "../server/videoRecordingManager";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { IdGenerator, defaultIdGenerator } from "../utils/IdGenerator";
import { evaluateDeviceDisconnects } from "./disconnectMonitor";
import { describeUnknownError } from "../utils/describeUnknownError";
import { FeatureFlagService } from "../features/featureFlags/FeatureFlagService";
import { serverConfig } from "../utils/ServerConfig";
import { setDebugPerfEnabled } from "../utils/PerformanceTracker";
import {
  installProcessLifecycleHandlers,
  setFatalProcessHandler,
  setProcessShutdownHandler,
} from "../processLifecycle";
import type { BootedDevice } from "../models";
import {
  DAEMON_LAUNCH_CWD_ENV,
  safeProcessCwd,
  resolveStableDaemonWorkingDirectory,
} from "../utils/workingDirectory";
import { resolveAssetVersion, resolvePinnedVersion } from "../constants/release";
import {
  DefaultObservationStreamHealth,
  type ObservationStreamHealth,
} from "./ObservationStreamHealth";
import { onAdbMissingDevice } from "../utils/android-cmdline-tools/AdbDeviceHealth";
import { iosSimulatorCaptureHelperPool } from "../features/screen-stream";
import { runShutdownCleanupStages } from "../shutdownCleanup";

const DEVICE_DISCONNECT_POLL_INTERVAL_MS = 5000;
const DEVICE_DISCONNECT_MISS_THRESHOLD = 3;
const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
// Upper bound on how long graceful shutdown waits for in-flight best-effort DB
// writes to quiesce before closing the connection (issue #2792). Best-effort
// writes are best-effort: if the bound elapses, shutdown proceeds anyway.
const DB_WRITE_DRAIN_TIMEOUT_MS = 1_000;

// Ceiling on awaiting an in-flight cold-start migration before closing the DB on
// shutdown (issue #3044). A SIGTERM arriving mid-startup-migration would otherwise
// let the detached migration connection's writes/checkpoint contend with the
// closing app connection (Windows busy_timeout stall). Bounded: a wedged migration
// cannot itself hang shutdown — the timeout wins and shutdown proceeds anyway.
const MIGRATION_SETTLE_TIMEOUT_MS = 5_000;

type HealthFailureKind = "http" | "socket" | "database" | "unknown";
type DatabaseHealthFailureRecovery = (code: number) => void | Promise<void>;

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
  private httpServer: HttpServer | null = null;
  private httpServerClosePromise: Promise<void> | null = null;
  private socketServer: UnixSocketServer | null = null;
  private transports: Map<string, StreamableHTTPServerTransport> = new Map();
  private acceptingHttpSessions = false;
  private port: number;
  private host: string;
  private debug: boolean;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private heartbeatMonitor: SessionHeartbeatMonitor | null = null;
  private deviceDisconnectMonitor: SingleFlightInterval | null = null;
  private pidFileWritten = false;
  private deviceDisconnectMisses: Map<string, number> = new Map();
  private confirmedDisconnectedDeviceIds: Set<string> = new Set();
  private forceDisconnectedDeviceIds: Set<string> = new Set();
  private stoppingRecordings: Set<string> = new Set();
  private sessionManager: SessionManager;
  private devicePool: DevicePool;
  private deviceSessionRegistry: DeviceSessionRegistry;
  private daemonSessionId: string;
  private installedAppsRepository: InstalledAppsStore;
  private deviceSessionRepository: DeviceSessionRepository;
  private timer: Timer;
  private idGenerator: IdGenerator;
  private databaseInitializer: DatabaseInitializer;
  private databaseHealthProbe: DatabaseHealthProbe;
  private startupFailureTracker: StartupFailureTracker;
  private recoverFromDatabaseHealthFailure: DatabaseHealthFailureRecovery;
  private observationStreamHealth: ObservationStreamHealth;
  private unsubscribeAdbMissingDevice: (() => void) | null = null;
  private options: DaemonOptions;
  private shutdownHandlersRegistered: boolean = false;
  private shutdownInProgress: boolean = false;

  constructor(
    options: DaemonOptions = {},
    installedAppsRepository?: InstalledAppsStore,
    timer: Timer = defaultTimer,
    deviceSessionRepository: DeviceSessionRepository = new DeviceSessionRepository(),
    idGenerator: IdGenerator = defaultIdGenerator,
    databaseInitializer: DatabaseInitializer = new DefaultDatabaseInitializer(),
    startupFailureTracker: StartupFailureTracker = new DefaultStartupFailureTracker(),
    databaseHealthProbe: DatabaseHealthProbe = new DefaultDatabaseHealthProbe({ timer }),
    recoverFromDatabaseHealthFailure?: DatabaseHealthFailureRecovery,
    recoveryPolicyEnvironment: NodeJS.ProcessEnv = process.env,
  ) {
    this.options = { ...options };
    this.port = options.port || DEFAULT_DAEMON_PORT;
    // Prefer IPv4 loopback: Bun's fetch and Node's listen can disagree on "localhost" (::1 vs 127.0.0.1),
    // which surfaces as ConnectionRefused on the Unix-socket → Streamable HTTP MCP hop (common in Linux CI).
    this.host = options.host || "127.0.0.1";
    this.debug = options.debug || false;
    this.idGenerator = idGenerator;
    this.daemonSessionId = this.idGenerator.next();
    this.timer = timer;
    this.databaseInitializer = databaseInitializer;
    this.databaseHealthProbe = databaseHealthProbe;
    this.startupFailureTracker = startupFailureTracker;
    this.recoverFromDatabaseHealthFailure = recoverFromDatabaseHealthFailure ?? (async code => {
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
        await startDeviceDataStreamSocketServer(this.timer);
      },
      configureCallbacks: () => this.setupDeviceDataStreamCallback(),
    });
    this.deviceSessionRepository = deviceSessionRepository;
    this.sessionManager = new SessionManager(this.timer, this.deviceSessionRepository);
    // Register centralized cleanup for session-scoped state
    this.sessionManager.onSessionRelease((sessionId, deviceId) => {
      NavigationGraphManager.releaseSession(sessionId);
      RealObserveScreen.clearCache(deviceId);
      // Clear the per-device CtrlProxy client's binding to the released session
      // (#4984) so a nav/hierarchy event arriving before the next session binds the
      // still-connected device is never attributed to the ended session, and its
      // cached hierarchy detector (which retains the released session's manager) is
      // dropped. Central here so it covers EVERY release path — explicit, idle,
      // heartbeat, device-switch, and derived `${base}:${label}` sessions alike.
      AndroidCtrlProxyClient.getExistingInstance(deviceId)?.releaseSessionBinding(sessionId);
      IOSCtrlProxyClient.getExistingInstance(deviceId)?.releaseSessionBinding(sessionId);
    });
    // Emit a real "session released" signal so a connected DaemonMcpProxy clears
    // its remembered session binding the moment the daemon releases the session
    // (heartbeat / idle / plan), rather than guessing with the replay TTL. Fires
    // for every released key — base and derived `${base}:${label}` alike; the
    // proxy matches its bound (base) UUID by exact equality (issue #4610).
    this.sessionManager.onSessionRelease(sessionId => {
      SessionReleaseBroadcaster.emit(sessionId);
    });
    this.installedAppsRepository = installedAppsRepository ?? new InstalledAppsRepository();
    const recoveryConfiguration = parseDeviceRecoveryPolicy(recoveryPolicyEnvironment);
    for (const warning of recoveryConfiguration.warnings) {
      logger.warn(`[Daemon] ${warning}`);
    }
    logger.info(
      `[Daemon] Device recovery policy: onLoss=${recoveryConfiguration.policy.onLoss}, ` +
      `maxAttempts=${recoveryConfiguration.policy.maxAttempts}`
    );
    this.deviceSessionRegistry = new DeviceSessionRegistry(this.timer, this.idGenerator);
    this.devicePool = new DevicePool(
      this.sessionManager,
      this.daemonSessionId,
      this.timer,
      this.installedAppsRepository,
      undefined,
      undefined,
      this.deviceSessionRepository,
      undefined,
      (sessionId, _deviceId, releaseReason) => this.cancelAndReleaseSession(sessionId, releaseReason),
      deviceId => this.onDeviceReadyForSessionRegistry(deviceId),
      undefined,
      recoveryConfiguration.policy,
      deviceId => this.deviceSessionRegistry.onDeviceDisconnected(deviceId),
    );
    // Initialize singleton for daemon state access
    DaemonState.getInstance().initialize(
      this.sessionManager,
      this.devicePool,
      this.deviceSessionRegistry
    );

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
    if (options.observeResultIncludeElements) {
      serverConfig.setObserveResultIncludeElementsEnabled(true);
    }
    if (options.toolResultsNoStructuredContent) {
      serverConfig.setToolResultsNoStructuredContentEnabled(true);
    }
    if (options.actionsDiffObserve) {
      serverConfig.setActionsDiffObserveEnabled(true);
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
    // Mirror structured daemon logs to stdout/stderr capture as well. The
    // primary stable log is `<auto-mobile data dir>/logs/daemon.log` (defaults to
    // `~/.auto-mobile/logs/daemon.log`); the daemon manager also redirects
    // stdout/stderr to a per-start capture file in that same stable logs dir.
    logger.enableStdoutLogging();
    const stableWorkingDirectory = resolveStableDaemonWorkingDirectory();
    process.env[DAEMON_LAUNCH_CWD_ENV] ??= safeProcessCwd(stableWorkingDirectory);
    process.chdir(stableWorkingDirectory);

    logger.info("Starting AutoMobile daemon...");
    this.setupShutdownHandlers();

    // Publish the owned DB path in the PID file BEFORE opening the DB so the
    // direct-mode DB-ownership guard can tell a same-file collision from an
    // isolated-path launch during our own multi-second startup window, instead
    // of failing closed on an unknown path. The ordering lives behind
    // runStartupPrologue() so it can be asserted with fakes (issue #2871).
    await startupBenchmark.runPhase("daemonDatabaseInitialization", () =>
      runStartupPrologue({
        writeEarlyOwnerRecord: () => this.writeEarlyOwnerRecord(),
        initializeDatabase: () => this.initializeDatabase(),
      })
    );

    // Find an available port
    this.port = await this.findAvailablePort(this.port);

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

    // Initialize iOS CtrlProxy iOS connections for discovered iOS devices
    // This establishes WebSocket connections early so observe calls are fast
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
      FeatureFlagService.getInstance()
    );
    logger.info("Starting Unix socket server...");
    startupBenchmark.startPhase("socketServerStart");
    await this.socketServer.start();
    startupBenchmark.endPhase("socketServerStart");
    logger.info("Unix socket server started");

    startupBenchmark.startPhase("auxiliarySocketServerStart");
    await startVideoRecordingSocketServer();
    await startTestRecordingSocketServer();
    await startDeviceSnapshotSocketServer();
    await startAppearanceSocketServer();
    await startPerformanceStreamSocketServer();
    await startPerformancePushSocketServer();
    await startDeviceDataStreamSocketServer();
    await startFailuresStreamSocketServer();
    await startFailuresPushSocketServer();
    await startTelemetryPushSocketServer();
    await startWebRtcStreamSocketServer();
    await startVideoStreamSocketServer();
    startupBenchmark.endPhase("auxiliarySocketServerStart");

    // Wire up callback to establish WebSocket connections when IDE plugins subscribe
    this.setupDeviceDataStreamCallback();

    startAppearanceSyncScheduler();
    startPerformanceMonitor();
    this.startAdbMissingDeviceListener();
    this.startDeviceDisconnectMonitor();

    // Write PID file
    await this.writePidFile();

    // Verify DaemonState is initialized
    const isInitialized = DaemonState.getInstance().isInitialized();
    logger.info(`DaemonState initialized: ${isInitialized}, device count: ${this.devicePool.getTotalDeviceCount()}`);

    // Start health check timer (every 30 seconds)
    this.startHealthCheckTimer();
    this.startHeartbeatMonitor();

    startupBenchmark.emit("daemon", {
      host: this.host,
      port: this.port,
      socketPath: SOCKET_PATH,
      deviceCount: this.devicePool.getTotalDeviceCount(),
      mcpHttpListenerBound: this.httpServer?.listening ?? false,
      daemonSocketListenerBound: this.socketServer?.isListening() ?? false,
    });

    logger.info(
      `Daemon started: PID ${process.pid}, socket ${SOCKET_PATH}, HTTP port ${this.port}`
    );

    // Startup fully succeeded — DB brought up AND every startup DB-backed step
    // completed. Only now clear the crash-loop circuit breaker, so a permanent
    // failure in any later startup step (recorded before its fatal exit) isn't
    // erased by a preflight that merely got past migrations (issue #2784).
    this.startupFailureTracker.reset();
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
      if (port <= DAEMON_PORT_RANGE_END && await this.isPortAvailable(port)) {
        return port;
      }
    }

    throw new Error(
      `No available ports in range ${DAEMON_PORT_RANGE_START}-${DAEMON_PORT_RANGE_END}`
    );
  }

  /**
   * Check if a port is available
   */
  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise(resolve => {
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
    this.httpServer = createHttpServer();
    this.httpServerClosePromise = null;
    this.acceptingHttpSessions = true;

    // Disable default timeouts on this loopback-only server. Node.js 18+ sets
    // requestTimeout to 300 000 ms (5 min), which kills Streamable HTTP
    // connections for long-running tool calls like executePlan. With the timeout
    // active the HTTP response is silently dropped after ~5 min, the
    // StreamableHTTPServerTransport fires onclose, and the MCP client never
    // receives the result — even when the tool completed successfully.
    this.httpServer.requestTimeout = 0;
    this.httpServer.headersTimeout = 0;
    this.httpServer.timeout = 0;

    this.httpServer.on("request", async (req, res) => {
      // CORS headers for development
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS"
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, MCP-Session-Id"
      );

      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url!, `http://${req.headers.host}`);

      if (url.pathname === "/heartbeat") {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        let body = "";
        req.on("data", chunk => {
          body += chunk.toString();
        });

        await new Promise<void>(resolve => {
          req.on("end", resolve);
        });

        let payload: { sessionId?: string } | null = null;
        try {
          payload = JSON.parse(body);
        } catch {
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

        this.sessionManager.recordHeartbeat(sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (url.pathname === MCP_STREAMABLE_PATH) {
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
          let body = "";
          req.on("data", chunk => {
            body += chunk.toString();
          });

          await new Promise<void>(resolve => {
            req.on("end", resolve);
          });

          try {
            parsedBody = JSON.parse(body);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            return;
          }
        }

        // Check if this is an initialization request
        const isInitializeRequest =
          parsedBody &&
          typeof parsedBody === "object" &&
          true &&
          "method" in parsedBody &&
          parsedBody.method === "initialize";
        const sendJsonRpcError = (message: string, error?: unknown) => {
          if (res.headersSent) {
            return;
          }
          const id =
            parsedBody &&
            typeof parsedBody === "object" &&
            "id" in parsedBody
              ? parsedBody.id
              : null;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message,
              data: error instanceof Error ? error.message : undefined
            }
          }));
        };

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
          const boundSessionUuid = req.headers[DAEMON_SESSION_TOOL_BINDING_HEADER];
          const boundCapabilityProfileUuid = req.headers[DAEMON_CAPABILITY_PROFILE_HEADER];
          const sessionContext: {
            sessionId?: string;
            initialSessionToolBinding?: string;
            initialCapabilityToolProfile?: string;
          } = {
            ...(typeof boundSessionUuid === "string" && boundSessionUuid.trim().length > 0
              ? { initialSessionToolBinding: boundSessionUuid }
              : {}),
            ...(typeof boundCapabilityProfileUuid === "string" && boundCapabilityProfileUuid.trim().length > 0
              ? { initialCapabilityToolProfile: boundCapabilityProfileUuid }
              : {}),
          };
          streamableTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => this.idGenerator.next(),
            onsessioninitialized: newSessionId => {
              if (!this.registerHttpTransport(newSessionId, streamableTransport)) {
                return;
              }
              sessionContext.sessionId = newSessionId;
              logger.info(
                `Streamable HTTP session initialized: ${newSessionId}`
              );
            },
          });

          // Create and connect MCP server
          let mcpServer;
          try {
            mcpServer = createMcpServer({
              debug: this.debug,
              sessionContext,
              daemonMode: true
            });
          } catch (error) {
            logger.error("Failed to create MCP server:", error);
            sendJsonRpcError("Server error", error);
            return;
          }

          // Setup cleanup handlers
          streamableTransport.onclose = async () => {
            if (streamableTransport.sessionId) {
              const cancelled = await executionTracker.cancelSessionExecutions(
                streamableTransport.sessionId,
                "streamable_http_onclose"
              );
              this.transports.delete(streamableTransport.sessionId);
              logger.info(
                `Streamable HTTP session closed: ${streamableTransport.sessionId} (cancelled ${cancelled} executions)`
              );
            }
          };

          streamableTransport.onerror = async error => {
            if (streamableTransport.sessionId) {
              const detail = describeUnknownError(error);
              logger.error(
                `Streamable HTTP transport error for session ${streamableTransport.sessionId}: ${detail}`
              );
              await executionTracker.cancelSessionExecutions(
                streamableTransport.sessionId,
                `streamable_http_onerror: ${detail}`
              );
              this.transports.delete(streamableTransport.sessionId);
            }
          };

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

        // SSE keepalive: prevent the fetch() response stream from going idle
        // during long-running tool calls (e.g. executePlan at ~6-10 min).
        // Without traffic the client-side stream silently dies; the server
        // writes the result to a dead pipe and the client eventually times out.
        // SSE comment lines (`:`) are ignored by EventSourceParserStream.
        const keepaliveTimer = req.method === "POST"
          ? defaultTimer.setInterval(() => {
            if (res.headersSent && !res.writableEnded && !res.destroyed) {
              res.write(":keepalive\n\n");
            }
          }, SSE_KEEPALIVE_INTERVAL_MS)
          : undefined;

        const clearKeepalive = () => {
          if (keepaliveTimer) {defaultTimer.clearInterval(keepaliveTimer);}
        };
        res.on("close", clearKeepalive);
        res.on("finish", clearKeepalive);

        // Let the transport handle the request
        try {
          await streamableTransport.handleRequest(req, res, parsedBody);
        } catch (error) {
          logger.error("Streamable HTTP request handling failed:", error);
          sendJsonRpcError("Server error", error);
        } finally {
          clearKeepalive();
        }
      } else {
        // 404 for unknown paths
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    });

    // Start HTTP server
    return new Promise((resolve, reject) => {
      this.httpServer!.listen(this.port, this.host, () => {
        logger.info(
          `automobile:${this.host}:${this.port}${MCP_STREAMABLE_PATH}`
        );
        resolve();
      });

      this.httpServer!.on("error", error => {
        logger.error(`HTTP server error: ${error}`);
        reject(error);
      });
    });
  }

  private registerHttpTransport(
    sessionId: string,
    transport: StreamableHTTPServerTransport,
  ): boolean {
    if (!this.acceptingHttpSessions) {
      void transport.close().catch(error => {
        logger.warn(`Failed to close HTTP session ${sessionId} rejected during shutdown`, error);
      });
      return false;
    }
    this.transports.set(sessionId, transport);
    return true;
  }

  private closeHttpListener(): Promise<void> {
    if (!this.httpServer) {
      return Promise.resolve();
    }
    this.httpServerClosePromise ??= new Promise<void>((resolve, reject) => {
      this.httpServer!.close(error => {
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
  private async persistPidFileData(pidData: PidFileData): Promise<void> {
    await mkdir(dirname(PID_FILE_PATH), { recursive: true });
    await writeFile(PID_FILE_PATH, JSON.stringify(pidData, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
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
   * The record is minimal by design (pid, dbPath, socketPath, startedAt, version).
   * Consumers that gate on daemon readiness — `status()`/`waitForReady()` — key on
   * the socket file plus `verifyDaemonConnection`, not on the PID file's `port`, so
   * a partial record written before the socket exists cannot make the daemon look
   * ready early. {@link writePidFile} overwrites it with the complete record.
   */
  private async writeEarlyOwnerRecord(): Promise<void> {
    const pidData: PidFileData = {
      pid: process.pid,
      socketPath: SOCKET_PATH,
      port: this.port,
      dbPath: getDatabasePath(),
      startedAt: this.timer.now(),
      version: DAEMON_VERSION,
      assetVersion: resolveAssetVersion(resolvePinnedVersion()),
      options: this.options,
    };
    await this.persistPidFileData(pidData);
    logger.info(`Early daemon owner record written to ${PID_FILE_PATH} (dbPath ${pidData.dbPath})`);
  }

  /**
   * Write PID file with daemon metadata
   */
  private async writePidFile(): Promise<void> {
    const buildIdentity = getCurrentBuildIdentity();
    const pidData: PidFileData = {
      pid: process.pid,
      socketPath: SOCKET_PATH,
      sockets: getDaemonSocketPathsByName(),
      port: this.port,
      dbPath: getDatabasePath(),
      startedAt: this.timer.now(),
      version: DAEMON_VERSION,
      assetVersion: resolveAssetVersion(resolvePinnedVersion()),
      entryScript: buildIdentity.entryScript,
      buildId: buildIdentity.buildId,
      options: this.options,
    };

    await this.persistPidFileData(pidData);
    logger.info(`PID file written to ${PID_FILE_PATH}`);
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
  private setupDeviceDataStreamCallback(): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      logger.warn("[Daemon] Observation stream server not available for callback setup");
      return;
    }

    server.setOnSubscriberConnected((deviceId: string | null) => {
      logger.info(`[Daemon] IDE plugin subscribed to observation stream (device: ${deviceId ?? "all"}), ensuring WebSocket connections...`);

      const allDevices = this.devicePool.getAllDevices();

      pushInitialObservationFramesForSubscriber(deviceId, allDevices, {
        streamServer: server,
        androidClientFactory: device => AndroidCtrlProxyClient.getInstance(device, defaultAdbClientFactory),
        iosClientFactory: device => this.createObservationStreamIosClient(device),
      }).catch(error => {
        logger.warn(`[Daemon] Error pushing initial observation frame: ${error}`);
      });

      if (allDevices.length === 0) {
        logger.info("[Daemon] No devices in pool to connect");
      }
    });

    server.setOnScreenshotCadenceChanged((deviceId: string | null) => {
      const devices = this.devicePool.getAllDevices()
        .filter(device => deviceId === null || device.id === deviceId);

      for (const device of devices) {
        if (device.platform === "android") {
          AndroidCtrlProxyClient
            .getExistingInstance(device.id)
            ?.refreshObservationStreamScreenshotCadence();
        } else if (device.platform === "ios") {
          IOSCtrlProxyClient
            .getExistingInstance(device.id)
            ?.refreshObservationStreamScreenshotCadence();
        }
      }
    });

    server.setOnHierarchyCadenceChanged((deviceId: string | null) => {
      const devices = this.devicePool.getAllDevices()
        .filter(device => deviceId === null || device.id === deviceId);

      for (const device of devices) {
        if (device.platform === "android") {
          AndroidCtrlProxyClient
            .getExistingInstance(device.id)
            ?.refreshObservationStreamHierarchyCadence();
        } else if (device.platform === "ios") {
          const client = IOSCtrlProxyClient.getExistingInstance(device.id);
          if (!client) {
            continue;
          }

          const intervalMs = server.getHierarchyIntervalMsForDevice(device.id);
          void client.ensureConnected().then(connected => {
            if (connected) {
              client.refreshObservationStreamHierarchyCadence(intervalMs);
            }
          }).catch(error => {
            logger.warn(`[Daemon] Failed to refresh iOS hierarchy cadence for ${device.id}: ${error}`);
          });
        }
      }
    });

    server.setOnObservationRequested(async ({ deviceId, signal }) => {
      const pooledDevices = deviceId
        ? [this.devicePool.getDevice(deviceId)].filter(device => device !== null)
        : this.devicePool.getAllDevices();

      if (pooledDevices.length === 0) {
        throw new Error(deviceId ? `Device ${deviceId} is not available` : "No devices are available");
      }

      const requestStart = this.timer.now();
      const observations = [];
      for (const pooledDevice of pooledDevices) {
        if (signal.aborted) {
          throw new Error("Observation request was aborted");
        }

        const bootedDevice: BootedDevice = {
          deviceId: pooledDevice.id,
          name: pooledDevice.name,
          platform: pooledDevice.platform,
          iosVersion: pooledDevice.iosVersion,
        };
        const observeScreen = new RealObserveScreen(bootedDevice);
        const observation = await observeScreen.execute({
          skipWaitForFresh: false,
          minTimestamp: requestStart,
          signal,
        });
        observations.push({ deviceId: pooledDevice.id, observation });
      }

      return observations;
    });

    logger.info("[Daemon] Observation stream callback configured");

    // Wire up navigation graph updates to stream to IDE plugins
    this.setupNavigationGraphStreamListener(server);
  }

  private createObservationStreamIosClient(device: BootedDevice): ObservationStreamIosClient {
    const client = IOSCtrlProxyClient.getInstance(device);
    return {
      ensureConnected: async () => {
        const connected = await client.ensureConnected();
        const server = getDeviceDataStreamServer();
        if (connected && server) {
          client.refreshObservationStreamHierarchyCadence(
            server.getHierarchyIntervalMsForDevice(device.deviceId)
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
      convertToViewHierarchyResult: hierarchy =>
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
  private setupNavigationGraphStreamListener(server: ReturnType<typeof getDeviceDataStreamServer>): void {
    if (!server) {
      return;
    }

    const navGraphManager = NavigationGraphManager.getInstance();

    navGraphManager.setGraphUpdateListener(async () => {
      logger.info("[Daemon] Navigation graph listener triggered, exporting summary...");
      try {
        const summary = await navGraphManager.exportGraphSummary();
        logger.info(`[Daemon] Got summary: appId=${summary.appId}, nodes=${summary.nodes.length}, edges=${summary.edges.length}`);

        const streamData = convertSummaryToStreamData(summary);
        server.pushNavigationGraphUpdate(streamData);

        logger.info(`[Daemon] Pushed navigation graph update: ${summary.nodes.length} nodes, ${summary.edges.length} edges`);
      } catch (error) {
        logger.warn(`[Daemon] Failed to push navigation graph update: ${error}`);
      }
    });

    // Wire up on-demand navigation graph requests from IDE plugins. A failed export must NOT be
    // swallowed to null (issue #4918): the handler rethrows so the stream server's existing error
    // path surfaces a typed `error` frame, letting a stream-driven client distinguish "export
    // failed" from "no app / empty graph".
    server.setOnNavigationGraphRequested(createNavigationGraphRequestHandler(navGraphManager));

    logger.info("[Daemon] Navigation graph stream listener configured");
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

    this.healthCheckTimer = this.timer.setInterval(async () => {
      try {
        // Check if HTTP server is responsive
        if (!this.httpServer) {
          logger.warn("Health check failed: HTTP server not initialized");
          recordHealthCheckFailure("http");
        } else if (!this.httpServer.listening) {
          logger.warn("Health check failed: HTTP server not listening");
          recordHealthCheckFailure("http");
        } else {
          // Check socket servers before probing shared dependencies; clients
          // can only subscribe to advertised streams while their socket paths exist.
          if (!this.socketServer || !this.socketServer.isListening()) {
            logger.warn("Health check failed: Socket server not listening");
            recordHealthCheckFailure("socket");
          } else if (!this.observationStreamHealth.isHealthy()) {
            logger.warn("Health check failed: Observation stream socket unavailable");
            recordHealthCheckFailure("socket");
          } else {
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
      sessionId => executionTracker.hasActiveSessionUuidExecutions(sessionId),
      sessionId => this.cancelAndReleaseSession(sessionId),
      this.timer,
    );
    this.heartbeatMonitor.start();
  }

  private startDeviceDisconnectMonitor(): void {
    if (this.deviceDisconnectMonitor) {
      return;
    }

    const deviceManager = new MultiPlatformDeviceManager();

    this.deviceDisconnectMonitor = new SingleFlightInterval(this.timer, DEVICE_DISCONNECT_POLL_INTERVAL_MS, async () => {
      try {
        if (serverConfig.isPlanExecutionActive()) {
          logger.debug("[DisconnectMonitor] Skipping — plan execution active");
          return;
        }

        const discovery = await deviceManager.getBootedDevicesDetailed("either");
        const bootedDevices = discovery.devices;
        const succeededPlatforms = discovery.succeededPlatforms;
        const bootedDeviceIds = new Set(bootedDevices.map(device => device.deviceId));
        const activeRecordings = await listActiveVideoRecordings();

        const missingByDevice = new Map<string, string[]>();
        const candidateDeviceIds = new Set<string>();
        const candidatePlatforms = new Map<string, "android" | "ios">();
        const idleCandidateIds = new Set<string>();
        for (const recording of activeRecordings) {
          candidateDeviceIds.add(recording.deviceId);
          candidatePlatforms.set(recording.deviceId, recording.platform);
        }
        for (const device of this.devicePool.getAllDevices()) {
          candidateDeviceIds.add(device.id);
          candidatePlatforms.set(device.id, device.platform);
          if (device.status === "idle") {
            idleCandidateIds.add(device.id);
          }
        }
        for (const deviceId of this.sessionManager.getAssignedDevices()) {
          candidateDeviceIds.add(deviceId);
        }

        const disconnectResult = evaluateDeviceDisconnects({
          deviceDisconnectMisses: this.deviceDisconnectMisses,
          confirmedDisconnectedDeviceIds: this.confirmedDisconnectedDeviceIds,
          bootedDeviceIds,
          candidateDeviceIds,
          succeededPlatforms,
          candidatePlatforms,
          idleCandidateIds,
          forceDisconnectedDeviceIds: this.forceDisconnectedDeviceIds,
          missThreshold: DEVICE_DISCONNECT_MISS_THRESHOLD,
        });

        if (disconnectResult.skippedAdbUnreachable) {
          logger.warn(
            `[DisconnectMonitor] ADB returned 0 devices but ${candidateDeviceIds.size} tracked — skipping miss count (ADB likely unreachable)`
          );
          return;
        }

        for (const { deviceId, misses } of disconnectResult.missed) {
          logger.info(
            `[DisconnectMonitor] Device ${deviceId} not in booted list (miss ${misses}/${DEVICE_DISCONNECT_MISS_THRESHOLD}, booted=${bootedDeviceIds.size})`
          );
        }

        for (const deviceId of disconnectResult.disconnected) {
          missingByDevice.set(deviceId, []);
        }

        for (const recording of activeRecordings) {
          if (missingByDevice.has(recording.deviceId)) {
            missingByDevice.get(recording.deviceId)!.push(recording.recordingId);
          }
        }

        for (const [deviceId, recordingIds] of missingByDevice.entries()) {
          const pooledDeviceAtDisconnect = this.devicePool.getDevice(deviceId);
          if (await this.shouldSkipStaleDisconnectCleanup(pooledDeviceAtDisconnect, deviceId)) {
            continue;
          }
          let deviceCleanupSucceeded = true;

          // Stop performance monitoring for this device
          getPerformanceMonitor().stopMonitoring(deviceId);

          for (const recordingId of recordingIds) {
            if (this.stoppingRecordings.has(recordingId)) {
              deviceCleanupSucceeded = false;
              continue;
            }
            this.stoppingRecordings.add(recordingId);
            try {
              await stopVideoRecording(recordingId);
              logger.warn(
                `[Daemon] Stopped recording ${recordingId} after device ${deviceId} disconnected`
              );
            } catch (error) {
              logger.warn(
                `[Daemon] Failed to stop recording ${recordingId} after device ${deviceId} disconnected: ${error}`
              );
              try {
                await interruptVideoRecording(recordingId);
                logger.warn(
                  `[Daemon] Marked recording ${recordingId} interrupted after device ${deviceId} disconnected`
                );
              } catch (interruptError) {
                deviceCleanupSucceeded = false;
                logger.warn(
                  `[Daemon] Failed to mark recording ${recordingId} interrupted after device ${deviceId} disconnected: ${interruptError}`
                );
              }
            } finally {
              this.stoppingRecordings.delete(recordingId);
            }
          }

          if (await this.shouldSkipStaleDisconnectCleanup(pooledDeviceAtDisconnect, deviceId)) {
            continue;
          }

          // Cancel active executions and release the session so the test fails
          // fast instead of waiting for the full MCP request timeout.
          const sessionId = this.sessionManager.getSessionForDevice(deviceId);
          if (sessionId) {
            logger.warn(
              `[DisconnectMonitor] Device ${deviceId} confirmed disconnected after ${DEVICE_DISCONNECT_MISS_THRESHOLD} consecutive misses — cancelling session ${sessionId}`
            );
            await this.cancelAndReleaseSession(sessionId, `device-disconnected:${deviceId}`);
          }

          await this.devicePool.removeDisconnectedDevice(deviceId);
          // Drop any per-device input caches so a device replaced under the same
          // serial does not inherit the previous one's cached API-level capability
          // (issue #3351): an API 31+/pre-31 mismatch mis-handles SHIFT/uppercase.
          // This fires only on a CONFIRMED disappearance; a fast same-serial restart
          // that never confirms is handled by the device-ready callback; the 5-min
          // idle close remains a fallback.
          this.socketServer?.evictDeviceInputCache(deviceId);
          if (this.devicePool.getDevice(deviceId)) {
            // removeDisconnectedDevice can synchronously recover a same-serial
            // Android emulator (reboot → re-add), which mints a fresh epoch. The
            // device is live again, so retiring here would delete that just-minted
            // epoch; skip the retire and let cleanup fail so the monitor retries.
            deviceCleanupSucceeded = false;
          }
          if (deviceCleanupSucceeded) {
            this.confirmedDisconnectedDeviceIds.add(deviceId);
            this.deviceDisconnectMisses.delete(deviceId);
            this.forceDisconnectedDeviceIds.delete(deviceId);
          }
        }
      } catch (error) {
        logger.warn(`[Daemon] Device disconnect monitor failed: ${error}`);
      }
    });
    this.deviceDisconnectMonitor.start();
  }

  private async shouldSkipStaleDisconnectCleanup(
    pooledDeviceAtDisconnect: PooledDevice | null,
    deviceId: string
  ): Promise<boolean> {
    if (
      !pooledDeviceAtDisconnect ||
      await this.devicePool.isCurrentDisconnectedDevice(pooledDeviceAtDisconnect)
    ) {
      return false;
    }
    logger.info(
      `[DisconnectMonitor] Skipping stale disconnect cleanup for recovered device ${deviceId}`
    );
    return true;
  }

  private startAdbMissingDeviceListener(): void {
    if (this.unsubscribeAdbMissingDevice) {
      return;
    }

    this.unsubscribeAdbMissingDevice = onAdbMissingDevice(event => {
      if (!this.devicePool.getDevice(event.deviceId) && !this.sessionManager.getSessionForDevice(event.deviceId)) {
        return;
      }
      logger.warn(`[Daemon] ADB reported tracked device ${event.deviceId} missing: ${event.message}`);
      this.forceDisconnectedDeviceIds.add(event.deviceId);
      this.deviceDisconnectMisses.set(event.deviceId, DEVICE_DISCONNECT_MISS_THRESHOLD);
    });
  }

  private async cancelAndReleaseSession(sessionId: string, releaseReason: string = "explicit-release"): Promise<void> {
    const cancelled = await executionTracker.cancelSessionUuidExecutions(sessionId, releaseReason);
    const deviceId = await this.sessionManager.releaseSession(sessionId, releaseReason);
    if (deviceId) {
      await this.devicePool.releaseDevice(deviceId);
    }
    logger.info(
      `Cancelled session ${sessionId} (${cancelled} executions) and released device ${deviceId ?? "unknown"} ` +
      `(reason=${releaseReason})`
    );
  }

  /**
   * Attempt to recover daemon components
   */
  private async attemptRecovery(failureKind: HealthFailureKind = "unknown"): Promise<void> {
    try {
      logger.info("Attempting daemon recovery...");

      if (failureKind === "database") {
        logger.error("Database health check failed repeatedly; exiting daemon for a clean restart.");
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
          FeatureFlagService.getInstance()
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
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>(resolve => {
      timeoutHandle = this.timer.setTimeout(() => {
        logger.warn(`Device pool initialization timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
      if (typeof (timeoutHandle as { unref?: () => void }).unref === "function") {
        (timeoutHandle as { unref: () => void }).unref();
      }
    });

    const initPromise = this.initializeDevicePool();

    try {
      await Promise.race([initPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle !== undefined) {
        this.timer.clearTimeout(timeoutHandle);
      }
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
      await this.devicePool.refreshDevices();
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
        logger.info(`Device pool initialized with ${bootedDevices.length} devices: ${bootedDevices.map(device => device.id).join(", ")}`);
      } else {
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
    const allDevices = this.devicePool.getAllDevices();
    const iosDevices = allDevices.filter(device => device.platform === "ios");
    if (iosDevices.length === 0) {
      logger.debug("[Daemon] No iOS devices to initialize CtrlProxy iOS for");
      return;
    }

    logger.info(`[Daemon] Initializing CtrlProxy iOS for ${iosDevices.length} iOS device(s)...`);
    const deviceSessionManager = DeviceSessionManager.getInstance();

    // Per-device timeout to prevent hanging on unresponsive devices
    const PER_DEVICE_TIMEOUT_MS = 5000;

    for (const device of iosDevices) {
      try {
        logger.info(`[Daemon] Setting up CtrlProxy iOS for iOS device ${device.id}`);

        const timeoutPromise = new Promise<never>((_, reject) => {
          const timer = defaultTimer.setTimeout(() => {
            reject(new Error(`Timeout after ${PER_DEVICE_TIMEOUT_MS}ms`));
          }, PER_DEVICE_TIMEOUT_MS);
          // Allow process to exit even if this timer is pending
          if (typeof (timer as { unref?: () => void }).unref === "function") {
            (timer as { unref: () => void }).unref();
          }
        });

        await Promise.race([
          deviceSessionManager.verifyIosDevice(device.id, {
            skipCtrlProxyDownload: true  // Skip app download during startup, use cached version
          }),
          timeoutPromise
        ]);
        logger.info(`[Daemon] CtrlProxy iOS ready for iOS device ${device.id}`);
      } catch (error) {
        // Log but don't fail - service will be set up on first tool call if needed
        logger.warn(`[Daemon] Failed to initialize CtrlProxy iOS for ${device.id}: ${error}`);
      }
    }
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
      // Clear installed apps cache from previous daemon sessions
      await this.installedAppsRepository.clearOldDaemonSessions(this.daemonSessionId);
      await this.deviceSessionRepository.markStaleActiveSessionsExpired(
        this.daemonSessionId,
        this.timer.now(),
        "daemon-restart"
      );
      logger.info(`[Daemon] Cleared old daemon session caches, current session: ${this.daemonSessionId}`);
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
    logger.info("Stopping daemon...");

    const heartbeatMonitor = this.heartbeatMonitor;
    this.heartbeatMonitor = null;
    const deviceDisconnectMonitor = this.deviceDisconnectMonitor;
    this.deviceDisconnectMonitor = null;
    await runShutdownCleanupStages(
      [
        {
          name: "health check timer",
          run: () => this.stopHealthCheckTimer(),
        },
        {
          name: "shutdown monitors",
          run: async () => {
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
          },
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
          run: () => this.sessionManager.stopCleanupTimer(),
        },
        {
          name: "HTTP session admission",
          run: () => {
            this.acceptingHttpSessions = false;
            // Start closing the listener now so it cannot admit a connection
            // after the transport snapshot below. The later HTTP server stage
            // awaits this same close once active transports have been closed.
            void this.closeHttpListener().catch(() => {});
          },
        },
        {
          name: "Unix socket server",
          run: async () => {
            if (this.socketServer) {
              await this.socketServer.close();
            }
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
          run: () => runShutdownCleanupStages(
            Array.from(this.transports, ([sessionId, streamableTransport]) => ({
              name: `Streamable HTTP session ${sessionId}`,
              run: () => streamableTransport.close(),
            })),
            (message, error) => logger.warn(message, error),
          ),
        },
        { name: "active HTTP session registry", run: () => this.transports.clear() },
        {
          name: "HTTP server",
          run: () => this.closeHttpListener(),
        },
        { name: "daemon files", run: () => cleanupDaemonFiles(this.getDaemonFileCleanupOptions()) },
        {
          name: "database write drain",
          run: async () => {
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
          },
        },
        {
          name: "in-flight migrations",
          run: async () => {
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
          },
        },
        { name: "database", run: closeDatabase },
        {
          name: "logger",
          run: async () => {
            logger.info("Daemon stopped");
            await logger.closeAfterFlush();
          },
        },
      ],
      (message, error) => logger.warn(message, error),
    );
  }

  private getDaemonFileCleanupOptions(): { expectedPid?: number } {
    if (this.pidFileWritten) {
      return { expectedPid: process.pid };
    }
    const pidData = readPidFileDataSync();
    return pidData && pidData.pid !== process.pid ? { expectedPid: process.pid } : {};
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
