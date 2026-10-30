import type {
  DaemonCoreServices,
  DaemonIdentityState,
  DaemonLifecycleState,
} from "./DaemonCoreState";
import { forceStuckSessionRelease } from "../releaseSessionAndDevice";
import { logSinkStalledWithin, logger } from "../../utils/logger";
import { UnixSocketServer } from "../socketServer";
import {
  createDaemonHealthCheck,
  HOST_IO_STALL_MEMORY_MS,
  type HealthFailureKind,
} from "../daemonHealthCheck";
import { SessionHeartbeatMonitor } from "../SessionHeartbeatMonitor";
import { SingleFlightInterval } from "../SingleFlightInterval";
import { DEFAULT_SOCKET_PATH, SOCKET_PATH } from "../wire/constants";
import { DeviceForwardLeaseIdleReleaser } from "../deviceForwardLeaseIdleReleaser";
import {
  getAcceptedAuxSocketConnectionCount,
  getLiveAuxSocketConnectionCount,
} from "../socketServer/BaseSocketServer";
import { readDeviceLeaseActivity } from "../deviceLeaseActivity";
import { daemonDeviceLeaseActivitySources } from "../deviceLeaseActivitySources";
import {
  PrivateDaemonOrphanWatchdog,
  isHarnessPrivateDaemon,
  resolveLauncherPid,
  resolvePrivateDaemonOrphanIdleMs,
} from "../privateDaemonOrphanWatchdog";
import { PROCESS_ENTRY_PARENT_PID } from "../processEntry";
import { resolveCtrlProxyForwardLeaseIdleMs } from "../../features/observe/shared/ctrlProxyForwardLeaseOwnership";
import { PID_FILE_PATH } from "../wire/constants";
import { isProcessRunning } from "../daemonFiles";
import { getDatabase, getDatabasePath } from "../../db";
import { NavigationRetention } from "../../db/navigationRetention";
import { NavigationRetentionMonitor } from "../NavigationRetentionMonitor";
import { DefaultFileSystem } from "../../utils/filesystem/DefaultFileSystem";
import { getDaemonSocketPathsByName } from "../socketPaths";
import { AndroidCtrlProxyClient } from "../../features/observe/android";
import { FeatureFlagService } from "../../features/featureFlags/FeatureFlagService";
import { type ObservationStreamHealth } from "../ObservationStreamHealth";
import { type DatabaseHealthFailureRecovery } from "../daemonDependencies";
import type { DaemonSessions } from "./DaemonSessions";
import type { DaemonIdentity } from "./DaemonIdentity";
import type { DaemonStreams } from "./DaemonStreams";

export interface DaemonMaintenanceHost {
  services: Pick<
    DaemonCoreServices,
    | "httpIngress"
    | "mcpDispatcher"
    | "sessionManager"
    | "devicePool"
    | "timer"
    | "idGenerator"
    | "databaseHealthProbe"
    | "options"
  >;
  identity: Pick<DaemonIdentity, "recordControlSocketIdentity">;
  identityState: Pick<
    DaemonIdentityState,
    | "incumbentOwnerGuard"
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
    | "heartbeatMonitor"
    | "setHeartbeatMonitor"
    | "navigationRetentionMonitor"
    | "setNavigationRetentionMonitor"
    | "forwardLeaseIdleReleaser"
    | "setForwardLeaseIdleReleaser"
    | "orphanWatchdog"
    | "setOrphanWatchdog"
  >;
  healthCheck: () => SingleFlightInterval | null;
  setHealthCheck: (value: SingleFlightInterval | null) => void;
  observationStreamHealth: () => ObservationStreamHealth;
  setObservationStreamHealth: (health: ObservationStreamHealth) => void;
  lastDatabaseHealthFailure: () => string | undefined;
  setLastDatabaseHealthFailure: (value: string | undefined) => void;
  recoverFromDatabaseHealthFailure: () => DatabaseHealthFailureRecovery;
  hostIoStalled?: () => (() => boolean) | undefined;
  attemptRecovery: DaemonMaintenance["attemptRecovery"];
  sessionExecutionProbe: DaemonSessions["sessionExecutionProbe"];
  cancelAndReleaseSession: DaemonSessions["cancelAndReleaseSession"];
  republishIdentity: DaemonIdentity["republishIdentity"];
  configureDeviceDataStreamServer: DaemonStreams["configureDeviceDataStreamServer"];
}

/** Starts health and maintenance monitors and recovers unhealthy transports. */
export class DaemonMaintenance {
  constructor(private readonly host: DaemonMaintenanceHost) {}

  /**
   * Start periodic health checks
   */
  startHealthCheckTimer(): void {
    this.host.setHealthCheck(
      createDaemonHealthCheck({
        timer: this.host.services.timer(),
        httpServer: () => this.host.services.httpIngress().server,
        socketServerListening: () => this.host.lifecycle.socketServer()?.isListening() ?? false,
        observationStreamHealthy: () => this.host.observationStreamHealth().isHealthy(),
        // The production recovery retries through startAuxiliarySocket, which keeps a live
        // holder as a warning and clears degradation/records ownership after a successful bind.
        retryDegradedObservationStream: () => this.host.observationStreamHealth().recover(),
        onObservationStreamRestored: () => this.host.republishIdentity(),
        databaseHealthProbe: () => this.host.services.databaseHealthProbe(),
        onDatabaseFailureChanged: (message) => {
          this.host.setLastDatabaseHealthFailure(message);
        },
        recover: (kind) => this.host.attemptRecovery(kind),
        hostIoStalled:
          this.host.hostIoStalled?.() ?? (() => logSinkStalledWithin(HOST_IO_STALL_MEMORY_MS)),
      }),
    );
    this.host.healthCheck()!.start();
  }

  async stopHealthCheckTimer(): Promise<void> {
    const healthCheck = this.host.healthCheck();
    this.host.setHealthCheck(null);
    await healthCheck?.stop();
  }

  /**
   * Start periodic heartbeat checks to cancel stale sessions
   */
  startHeartbeatMonitor(): void {
    // Owners can reconnect only now that the control socket accepts connections.
    this.host.services.sessionManager().startRehydratedOwnerWindows();
    this.host.lifecycle.setHeartbeatMonitor(
      new SessionHeartbeatMonitor(
        this.host.services.sessionManager(),
        // Only control calls keep a stale session (#11322): a read admitted after the owner went
        // quiet is answered, but it is not the owner's liveness and must not hold the device.
        this.host.sessionExecutionProbe({ excludeReads: true }),
        async (sessionId, reason) => {
          // A call still in flight (a read never keeps the session; a control call only until its
          // veto runs out) learns why it was cancelled: the typed terminal refusal, not a generic
          // abort (#11322). That includes a call that reached the session through autolock (#11400).
          await this.host.cancelAndReleaseSession(sessionId, reason, {
            cutCallsLearnRelease: true,
          });
        },
        this.host.services.timer(),
        {
          // A reap stuck past its deadline frees the device; the session stays fenced (#10963).
          forceStuckRelease: (sessionId) =>
            forceStuckSessionRelease(
              this.host.services.sessionManager(),
              this.host.services.devicePool(),
              sessionId,
            ),
        },
      ),
    );
    this.host.lifecycle.heartbeatMonitor()!.start();
  }

  /**
   * Start the periodic navigation-data retention pass (nav (app,build) Phase 3,
   * #4986). Bounds accumulated cross-build/device/session observation rows and
   * stale node screenshots. Best-effort: a failed pass is logged and swallowed,
   * and its writes are tracked by the DB write barrier drained on shutdown.
   */
  startNavigationRetentionMonitor(): void {
    const fileSystem = new DefaultFileSystem();
    const retention = new NavigationRetention(
      getDatabase(),
      {},
      { removeScreenshotFile: (filePath) => fileSystem.unlink(filePath) },
    );
    this.host.lifecycle.setNavigationRetentionMonitor(
      new NavigationRetentionMonitor(retention, this.host.services.timer()),
    );
    this.host.lifecycle.navigationRetentionMonitor()!.start();
  }

  /** Give up idle devices' CtrlProxy forwarding leases (#10497). */
  startForwardLeaseIdleReleaser(): void {
    const activitySources = daemonDeviceLeaseActivitySources((deviceId) =>
      this.host.services.sessionManager().getSessionForDevice(deviceId),
    );
    this.host.lifecycle.setForwardLeaseIdleReleaser(
      new DeviceForwardLeaseIdleReleaser(
        {
          heldDeviceIds: () => AndroidCtrlProxyClient.getForwardLeaseHeldDeviceIds(),
          activity: (deviceId) => readDeviceLeaseActivity(activitySources, deviceId),
          release: (deviceId) => AndroidCtrlProxyClient.releaseIdleForwardLease(deviceId),
        },
        resolveCtrlProxyForwardLeaseIdleMs(),
        this.host.services.timer(),
      ),
    );
    this.host.lifecycle.forwardLeaseIdleReleaser()!.start();
  }

  /** Stop a private daemon that outlived its launcher with nothing using it (#10497). */
  startPrivateDaemonOrphanWatchdog(): void {
    if (process.platform === "win32" || !isHarnessPrivateDaemon(SOCKET_PATH, DEFAULT_SOCKET_PATH)) {
      return;
    }
    // Captured at process entry, not here: the launcher may have exited by now (#11041).
    const launcherPid = resolveLauncherPid(PROCESS_ENTRY_PARENT_PID);
    this.host.lifecycle.setOrphanWatchdog(
      new PrivateDaemonOrphanWatchdog(
        {
          parentPid: () => process.ppid,
          launcherPid: () => launcherPid,
          launcherIsExplicit: () => launcherPid !== PROCESS_ENTRY_PARENT_PID,
          isProcessRunning: (pid) => isProcessRunning(pid),
          clientCount: () =>
            (this.host.lifecycle.socketServer()?.getClientConnectionCount() ?? 0) +
            getLiveAuxSocketConnectionCount() +
            this.host.services.httpIngress().openRequestCount,
          clientActivityCount: () =>
            (this.host.lifecycle.socketServer()?.getAcceptedClientConnectionCount() ?? 0) +
            getAcceptedAuxSocketConnectionCount() +
            this.host.services.httpIngress().requestsSeenCount,
          liveSessionCount: () => this.host.services.sessionManager().getAllSessions().length,
          shutdown: () => {
            this.host.lifecycle.selfExitRecorder().record("orphan-watchdog");
            setImmediate(() => process.kill(process.pid, "SIGTERM"));
          },
        },
        resolvePrivateDaemonOrphanIdleMs(),
        this.host.services.timer(),
      ),
    );
    this.host.lifecycle.orphanWatchdog()!.start();
  }

  /**
   * Attempt to recover daemon components
   */
  async attemptRecovery(failureKind: HealthFailureKind = "unknown"): Promise<void> {
    try {
      logger.info("Attempting daemon recovery...");

      if (failureKind === "database") {
        logger.error(
          "Database health check failed repeatedly; exiting daemon for a clean restart.",
        );
        await this.host.recoverFromDatabaseHealthFailure()(
          1,
          this.host.lastDatabaseHealthFailure(),
        );
        return;
      }

      // Try to restart socket server if it's not responding
      if (
        this.host.lifecycle.socketServer() &&
        !this.host.lifecycle.socketServer()!.isListening()
      ) {
        logger.info("Restarting socket server...");
        try {
          await this.host.lifecycle.socketServer()!.close();
        } catch (error) {
          logger.warn(`Error closing socket server during recovery: ${error}`);
        }

        // Recreate socket server
        this.host.lifecycle.setSocketServer(
          new UnixSocketServer(
            SOCKET_PATH,
            undefined,
            undefined,
            FeatureFlagService.getInstance(),
            {
              identityStartedAt: this.host.identityState.generationStartedAt(),
              processGenerationToken: this.host.identityState.processGenerationToken(),
              startupOptions: this.host.services.options(),
              onRepublishIdentity: () => this.host.republishIdentity(),
              startupCompletion: this.host.lifecycle.startupCompletion(),
              pidFilePath: PID_FILE_PATH,
              sockets: getDaemonSocketPathsByName(),
              dbPath: getDatabasePath(),
              processStartedAt: this.host.identityState.processStartedAt(),
              onRestartAccepted: () => {
                setImmediate(() => process.kill(process.pid, "SIGTERM"));
              },
              liveAcceptanceStartupSecret: this.host.identityState.liveAcceptanceStartupSecret(),
              acceptanceDiscoveryCapability:
                this.host.identityState.acceptanceDiscoveryCapability(),
              mcpDispatcher: this.host.services.mcpDispatcher(),
            },
            this.host.services.idGenerator(),
            // Recovery reuses the same ownership evidence as initial startup. A
            // replacement socket is never reclaimed merely because this daemon
            // previously held the namespace.
            {
              ownerLiveness: this.host.identityState.incumbentOwnerGuard().asSocketOwnerLiveness(),
            },
          ),
        );
        try {
          await this.host.lifecycle.socketServer()!.start();
          this.host.identity.recordControlSocketIdentity();
          logger.info("Socket server restarted successfully");
        } catch (error) {
          logger.error(`Failed to restart socket server: ${error}`);
        }
      }

      if (!this.host.observationStreamHealth().isHealthy()) {
        logger.info("Restarting observation stream socket server...");
        try {
          await this.host.observationStreamHealth().recover();
          // DefaultObservationStreamHealth recreates the device-data singleton.
          // Reinstall routing, lifecycle delivery, cadence, observation, and
          // navigation callbacks on that replacement.
          this.host.configureDeviceDataStreamServer();
          const healthy = this.host.observationStreamHealth().isHealthy();
          const log = healthy ? logger.info : logger.warn;
          log(
            healthy
              ? "Observation stream socket server restarted successfully"
              : "Observation stream socket server remains unavailable after recovery",
          );
        } catch (error) {
          logger.error(`Failed to restart observation stream socket server: ${error}`);
        }
      }
    } catch (error) {
      logger.error(`Recovery attempt failed: ${error}`);
    }
  }

  get testHooks() {
    return {
      observationStreamHealth: (): ObservationStreamHealth => this.host.observationStreamHealth(),
      setObservationStreamHealth: (health: ObservationStreamHealth): void => {
        this.host.setObservationStreamHealth(health);
      },
      healthCheck: (): SingleFlightInterval | null => this.host.healthCheck(),
      lastDatabaseHealthFailure: (): string | undefined => this.host.lastDatabaseHealthFailure(),
      startHealthCheckTimer: (): void => this.startHealthCheckTimer(),
      stopHealthCheckTimer: (): Promise<void> => this.stopHealthCheckTimer(),
    } as const;
  }
}
