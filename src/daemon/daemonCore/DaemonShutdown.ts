import { stopTemplateBuilds } from "../../features/iosTemplates/defaultSimulatorCreationService";
import type { DaemonCoreServices, DaemonLifecycleState } from "./DaemonCoreState";
import { getNativeHelperRegistry } from "../../utils/nativeHelpers/NativeHelperRegistry";
import { terminateActiveAdbProcesses } from "../../utils/android-cmdline-tools/AdbClient";
import {
  drainShutdownDatabaseWrites,
  interruptProvisioningForShutdown,
  settleShutdownMigrations,
} from "../shutdownSteps";
import { releaseDaemonTaskLeases } from "../tasks/daemonTaskManager";
import { logger } from "../../utils/logger";
import { defaultLocationRouteRegistry } from "../../features/utility/LocationRoutePlayer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { SessionHeartbeatMonitor } from "../SessionHeartbeatMonitor";
import { SingleFlightInterval } from "../SingleFlightInterval";
import { SESSION_RELEASE_DRAIN_TIMEOUT_MS } from "../constants";
import { DeviceForwardLeaseIdleReleaser } from "../deviceForwardLeaseIdleReleaser";
import { cleanupDaemonFilesSync } from "../daemonFiles";
import { SessionReleaseBroadcaster } from "../sessionReleaseBroadcast";
import { closeDatabase, refusedDatabaseAccessCountAfterShutdownClose } from "../../db";
import { NavigationRetentionMonitor } from "../NavigationRetentionMonitor";
import { createDaemonFatalProcessHandler } from "../daemonFatalHandler";
import { stopVideoRecordingSocketServer } from "../videoRecordingSocketServer";
import { stopDeviceGestureRecordingSocketServer } from "../deviceGestureRecordingSocketServer";
import { stopDeviceSnapshotSocketServer } from "../deviceSnapshotSocketServer";
import { stopAppearanceSocketServer } from "../appearanceSocketServer";
import { stopPerformanceStreamSocketServer } from "../performanceStreamSocketServer";
import { stopPerformancePushSocketServer } from "../performancePushSocketServer";
import { stopDeviceDataStreamSocketServer } from "../deviceDataStreamSocketServer";
import { stopFailuresStreamSocketServer } from "../failuresStreamSocketServer";
import { stopFailuresPushSocketServer } from "../failuresPushSocketServer";
import { stopTelemetryPushSocketServer } from "../telemetryPushSocketServer";
import { stopWebRtcStreamSocketServer } from "../webrtcStreamSocketServer";
import { stopVideoStreamSocketServer } from "../videoStreamSocketServer";
import { AndroidCtrlProxyClient } from "../../features/observe/android";
import { stopAppearanceSyncScheduler } from "../AppearanceSyncScheduler";
import { stopPerformanceMonitor } from "../../features/performance/PerformanceMonitor";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  installHangupShutdownHandler,
  installProcessLifecycleHandlers,
  setFatalProcessHandler,
  setProcessShutdownHandler,
} from "../../processLifecycle";
import { iosSimulatorCaptureHelperPool } from "../../features/screen-stream";
import {
  DAEMON_SHUTDOWN_STAGES,
  boundWithinStage,
  createShutdownDatabaseTail,
  runShutdownCleanupStages,
  shutdownStageFrom,
  type DaemonShutdownStageName,
  type ShutdownCleanupStage,
} from "../../shutdownCleanup";
import { cleanupDaemonChildProcesses } from "../childProcessCleanup";
import { type ManagedAdbServerShutdown } from "../daemonDependencies";
import type { DaemonBroker } from "./DaemonBroker";
import type { DaemonSessions } from "./DaemonSessions";
import type { DaemonIdentity } from "./DaemonIdentity";
import type { DaemonMaintenance } from "./DaemonMaintenance";

/** A `Daemon.stop()` stage with its deadline and database flag drawn from the stage table. */
function shutdownStage(
  name: DaemonShutdownStageName,
  waitingOn: string,
  run: ShutdownCleanupStage["run"],
): ShutdownCleanupStage {
  return shutdownStageFrom(DAEMON_SHUTDOWN_STAGES, name, waitingOn, run);
}

// Upper bound on how long graceful shutdown waits for in-flight best-effort DB
// writes to quiesce before closing the connection (issue #2792). Best-effort
// writes are best-effort: if the bound elapses, shutdown proceeds anyway.
const DB_WRITE_DRAIN_TIMEOUT_MS = 1_000;
const DEVICE_CLEANUP_SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
const DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS = 1_000;
// Bound on removing recorded CtrlProxy forwards and releasing forwarding leases at stop.
const CTRL_PROXY_FORWARD_RELEASE_SHUTDOWN_TIMEOUT_MS = 3_000;

// Ceiling on awaiting an in-flight cold-start migration before closing the DB on
// shutdown (issue #3044). A SIGTERM arriving mid-startup-migration would otherwise
// let the detached migration connection's writes/checkpoint contend with the
// closing app connection (Windows busy_timeout stall). Bounded: a wedged migration
// cannot itself hang shutdown — the timeout wins and shutdown proceeds anyway.
const MIGRATION_SETTLE_TIMEOUT_MS = 5_000;

export interface DaemonShutdownHost {
  services: Pick<
    DaemonCoreServices,
    | "httpIngress"
    | "mcpDispatcher"
    | "sessionManager"
    | "devicePool"
    | "timer"
    | "databaseHealthProbe"
  >;
  lifecycle: Pick<
    DaemonLifecycleState,
    | "socketServer"
    | "selfExitRecorder"
    | "heartbeatMonitor"
    | "setHeartbeatMonitor"
    | "navigationRetentionMonitor"
    | "setNavigationRetentionMonitor"
    | "forwardLeaseIdleReleaser"
    | "setForwardLeaseIdleReleaser"
    | "orphanWatchdog"
    | "setOrphanWatchdog"
    | "deviceDisconnectMonitor"
    | "setDeviceDisconnectMonitor"
    | "deferredSessionRecoverySweeps"
    | "unsubscribeAdbMissingDevice"
    | "setUnsubscribeAdbMissingDevice"
    | "shutdownInProgress"
    | "setShutdownInProgress"
    | "shutdownReleaseNotifications"
    | "setShutdownReleaseNotifications"
    | "shutdownFallbackReleaseNotifications"
    | "setShutdownFallbackReleaseNotifications"
  >;
  stopManagedAdbServer: () => ManagedAdbServerShutdown;
  removeHttpToken: () => void;
  stop: DaemonShutdown["stop"];
  getDaemonFileCleanupOptions: DaemonIdentity["getDaemonFileCleanupOptions"];
  closeManagedExecutionRelease: DaemonBroker["closeManagedExecutionRelease"];
  stopHealthCheckTimer: DaemonMaintenance["stopHealthCheckTimer"];
  stopSessionTimers: DaemonSessions["stopSessionTimers"];
  cleanupDaemonFilesForShutdown: DaemonIdentity["cleanupDaemonFilesForShutdown"];
  cancelAndReleaseSession: DaemonSessions["cancelAndReleaseSession"];
}

/** Runs bounded shutdown stages in order, preserving release notifications and database writes. */
export class DaemonShutdown {
  private shutdownHandlersRegistered: boolean = false;

  private shutdownSessionReleasesDrained = true;

  /** Identities captured before concurrent shutdown release begins. */
  private shutdownSessionIds: string[] = [];
  constructor(private readonly host: DaemonShutdownHost) {}

  /**
   * Setup graceful shutdown handlers
   */
  setupShutdownHandlers(): void {
    if (this.shutdownHandlersRegistered) {
      return;
    }
    this.shutdownHandlersRegistered = true;
    installProcessLifecycleHandlers();
    // A terminal-attached daemon must clean up on hangup like on SIGTERM (#11156).
    installHangupShutdownHandler();

    const shutdown = async (signal: string) => {
      this.host.lifecycle.selfExitRecorder().markCleanStop();
      if (this.host.lifecycle.shutdownInProgress()) {
        return;
      }
      this.host.lifecycle.setShutdownInProgress(true);
      logger.info(`Received ${signal}, shutting down daemon...`);
      await this.host.stop();
    };

    setProcessShutdownHandler(shutdown);
    process.once("exit", () => {
      this.host.lifecycle.selfExitRecorder().record("unexpected-exit");
      cleanupDaemonFilesSync(this.host.getDaemonFileCleanupOptions());
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
    this.host.lifecycle.setShutdownInProgress(true);
    logger.info("Stopping daemon...");
    // Every stage draws its deadline from DAEMON_SHUTDOWN_STAGES, whose budgets sum to less
    // than the process limit: a wedged stage is abandoned with a warning and the stages that
    // protect user state (session release and its daemon-shutdown notification, the database
    // close, the pid/socket file removal) still run (#11601). The order is unchanged.
    await runShutdownCleanupStages(
      [
        ...this.shutdownQuiesceStages(),
        ...this.shutdownStreamAndTransportStages(),
        ...this.shutdownSessionAndStateStages(),
      ],
      (message, error) => logger.warn(message, error),
      { timer: this.host.services.timer() },
    );
  }

  /** Stop admitting work, then stop the daemon's own children, timers and monitors. */
  private shutdownQuiesceStages(): ShutdownCleanupStage[] {
    // Detached from the daemon by the snapshot stage, then stopped by the stages after it.
    const handoff: {
      heartbeatMonitor: SessionHeartbeatMonitor | null;
      navigationRetentionMonitor: NavigationRetentionMonitor | null;
      deviceDisconnectMonitor: SingleFlightInterval | null;
      forwardLeaseIdleReleaser: DeviceForwardLeaseIdleReleaser | null;
    } = {
      heartbeatMonitor: null,
      navigationRetentionMonitor: null,
      deviceDisconnectMonitor: null,
      forwardLeaseIdleReleaser: null,
    };
    return [
      shutdownStage(
        "provisioning ingress quiesce",
        "in-flight control-socket request handlers",
        () => this.quiesceProvisioningIngress(),
      ),
      shutdownStage(
        "provisioning interruption",
        "interrupted provisionDevice calls persisting their handoff",
        (stage) =>
          Promise.all([
            stopTemplateBuilds(),
            interruptProvisioningForShutdown(
              boundWithinStage(stage, DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS),
            ),
          ]).then(() => undefined),
      ),
      shutdownStage("shutdown release snapshot", "nothing (synchronous)", () => {
        this.host.lifecycle.setShutdownReleaseNotifications(new Set());
        this.host.lifecycle.setShutdownFallbackReleaseNotifications(new Set());
        this.shutdownSessionIds = [];
        handoff.heartbeatMonitor = this.host.lifecycle.heartbeatMonitor();
        this.host.lifecycle.setHeartbeatMonitor(null);
        handoff.navigationRetentionMonitor = this.host.lifecycle.navigationRetentionMonitor();
        this.host.lifecycle.setNavigationRetentionMonitor(null);
        handoff.deviceDisconnectMonitor = this.host.lifecycle.deviceDisconnectMonitor();
        this.host.lifecycle.setDeviceDisconnectMonitor(null);
        this.host.lifecycle.orphanWatchdog()?.stop();
        this.host.lifecycle.setOrphanWatchdog(null);
        handoff.forwardLeaseIdleReleaser = this.host.lifecycle.forwardLeaseIdleReleaser();
        this.host.lifecycle.setForwardLeaseIdleReleaser(null);
      }),
      shutdownStage(
        "forward lease idle releaser",
        "an in-flight idle forward-lease sweep (adb forward removal)",
        async () => {
          await handoff.forwardLeaseIdleReleaser?.stop();
        },
      ),
      shutdownStage(
        // A shutdown release keeps the execution owner: the rehydrated session awaits its
        // owner (#11177).
        "managed execution release",
        "the journal redrive loop stop and the binding registry close",
        () => this.host.closeManagedExecutionRelease(),
      ),
      shutdownStage(
        // Quiesce new recording work and stop owned children before any
        // potentially blocking socket teardown consumes the shutdown budget.
        "active capture and iOS CtrlProxy children",
        "recording stop/finalize and iOS CtrlProxy child exit",
        () => cleanupDaemonChildProcesses(),
      ),
      shutdownStage("health check timer", "the database health probe", async () => {
        await this.host.stopHealthCheckTimer();
        await this.host.services.databaseHealthProbe().dispose?.();
      }),
      shutdownStage("location routes", "nothing (synchronous)", () =>
        defaultLocationRouteRegistry.stopAll(),
      ),
      shutdownStage(
        "shutdown monitors",
        "the heartbeat and disconnect monitors and deferred recovery sweeps",
        (stage) =>
          this.drainShutdownMonitors(
            handoff.navigationRetentionMonitor,
            handoff.heartbeatMonitor,
            handoff.deviceDisconnectMonitor,
            boundWithinStage(stage, DEVICE_LOSS_EXECUTION_DRAIN_TIMEOUT_MS),
          ),
      ),
      shutdownStage("ADB missing-device subscription", "nothing (synchronous)", () =>
        this.unsubscribeAdbMissing(),
      ),
      shutdownStage(
        // Stop the session cleanup interval before the DB drain below. It is the one
        // best-effort DB writer that fires on its own timer rather than an external
        // socket (which are all torn down here), so if left running it could route a
        // tracked `markReleased` write through a freshly-resolved, non-draining
        // barrier in the microtask window AFTER closeDatabase()'s resetDbWriteBarrier()
        // and hit the just-closed connection (issue #2912; #2792 safety window).
        "session cleanup timer",
        "nothing (synchronous)",
        () => this.host.stopSessionTimers(),
      ),
    ];
  }

  /** Close the auxiliary socket servers, the stream servers and the HTTP transports. */
  private shutdownStreamAndTransportStages(): ShutdownCleanupStage[] {
    return [
      shutdownStage("video recording socket server", "its connections closing", () =>
        stopVideoRecordingSocketServer(),
      ),
      shutdownStage("device gesture recording socket server", "its connections closing", () =>
        stopDeviceGestureRecordingSocketServer(),
      ),
      shutdownStage("device snapshot socket server", "its connections closing", () =>
        stopDeviceSnapshotSocketServer(),
      ),
      shutdownStage("appearance socket server", "its connections closing", () =>
        stopAppearanceSocketServer(),
      ),
      shutdownStage("performance stream socket server", "its connections closing", () =>
        stopPerformanceStreamSocketServer(),
      ),
      shutdownStage("performance push socket server", "its connections closing", () =>
        stopPerformancePushSocketServer(),
      ),
      shutdownStage("device data stream socket server", "its connections closing", () =>
        stopDeviceDataStreamSocketServer(),
      ),
      shutdownStage("failures stream socket server", "its connections closing", () =>
        stopFailuresStreamSocketServer(),
      ),
      shutdownStage("failures push socket server", "its connections closing", () =>
        stopFailuresPushSocketServer(),
      ),
      shutdownStage("telemetry push socket server", "its connections closing", () =>
        stopTelemetryPushSocketServer(),
      ),
      shutdownStage(
        "WebRTC stream socket server",
        "WebRTC stream teardown (encoder stop, adb forward removal)",
        () => stopWebRtcStreamSocketServer(),
      ),
      shutdownStage(
        "video stream socket server",
        "capture source stop (encoder stop, adb forward removal)",
        () => stopVideoStreamSocketServer(),
      ),
      shutdownStage(
        "iOS simulator capture helper pool",
        "simulator capture helper processes exiting",
        () => iosSimulatorCaptureHelperPool.shutdown(),
      ),
      shutdownStage(
        "native helper registry",
        "tracked helper processes exiting",
        async (context) => {
          await getNativeHelperRegistry().shutdown({
            timer: this.host.services.timer(),
            graceMs: Math.min(500, Math.max(0, (context.remainingMs() - 1) / 2)),
          });
        },
      ),
      // Includes in-flight one-shot execs as well as long-lived adb spawn children.
      // Request-serving stages have stopped; terminating remaining one-shots at shutdown is intended.
      shutdownStage("host adb children", "host adb children exiting", async (context) => {
        await terminateActiveAdbProcesses({
          timer: this.host.services.timer(),
          graceMs: Math.min(500, Math.max(0, (context.remainingMs() - 1) / 2)),
        });
      }),
      shutdownStage("appearance sync scheduler", "an in-flight appearance sync", () =>
        stopAppearanceSyncScheduler(),
      ),
      shutdownStage("performance monitor", "an in-flight performance sample", () =>
        stopPerformanceMonitor(),
      ),
      shutdownStage("active HTTP sessions", "streamable HTTP transports closing", () =>
        // No deadline per transport: one that wedges is covered by this stage's deadline, which
        // also marks the stage as still running for the database stage.
        runShutdownCleanupStages(
          [
            ...this.host.services
              .httpIngress()
              .inFlightRequests()
              .map(({ requestScopeId, close }) => ({
                name: `Streamable HTTP request ${requestScopeId}`,
                run: close,
              })),
            ...this.host.services
              .mcpDispatcher()
              .inFlightForwards()
              .map(({ requestScopeId, close }) => ({
                name: `In-process MCP forward ${requestScopeId}`,
                run: close,
              })),
          ],
          (message, error) => logger.warn(message, error),
        ),
      ),
      shutdownStage("active HTTP session registry", "nothing (synchronous)", () =>
        this.clearHttpSessionRegistry(),
      ),
      shutdownStage("HTTP server", "open HTTP connections closing", () =>
        this.host.services.httpIngress().closeListener(),
      ),
    ];
  }

  /**
   * Release sessions, tell their clients, then close the database, the logger and the daemon
   * files. These protect user state; the budget table keeps their share whatever came before.
   */
  private shutdownSessionAndStateStages(): ShutdownCleanupStage[] {
    // Abandoned is not cancelled: the connection stays open while an abandoned stage that may
    // write is still running, and closes late if those stragglers finish in time (#11601).
    const databaseTail = createShutdownDatabaseTail({
      // The shutdown close: late work is refused from here on instead of reopening it.
      closeDatabase: () => closeDatabase({ forShutdown: true }),
      refusedAccessCount: () => refusedDatabaseAccessCountAfterShutdownClose(),
      drainWrites: (timeoutMs) => drainShutdownDatabaseWrites(timeoutMs),
      keepOpenReason: () =>
        this.shutdownSessionReleasesDrained
          ? undefined
          : "a session terminal write is still in flight",
      warn: (message) => logger.warn(message),
    });
    return [
      shutdownStage(
        "active device sessions",
        "session release teardown and terminal-row persistence",
        (stage) =>
          this.releaseActiveSessionsForShutdown(
            boundWithinStage(stage, SESSION_RELEASE_DRAIN_TIMEOUT_MS),
          ),
      ),
      shutdownStage(
        // Session release broadcasts must be written while subscribed proxy
        // sockets are still connected; closing first degrades the exact
        // daemon-shutdown reason into session-not-found after reconnect.
        // Runs right after session release, before the device-cleanup and
        // forward-release drains, so a wedged stage behind it cannot push the
        // daemon-shutdown notification past the 9 s process limit (#11156).
        "Unix socket server",
        "release notification writes and in-flight request handlers",
        async () => {
          if (this.host.lifecycle.socketServer()) {
            this.publishMissingShutdownReleaseNotifications();
            await this.host.lifecycle.socketServer()!.drainSessionReleaseNotifications();
            await this.host.lifecycle.socketServer()!.close();
          }
        },
      ),
      shutdownStage(
        "pending device cleanups",
        "per-device cleanup registered by released sessions",
        async (stage) => {
          await this.host.services
            .sessionManager()
            .drainPendingDeviceCleanups(
              boundWithinStage(stage, DEVICE_CLEANUP_SHUTDOWN_DRAIN_TIMEOUT_MS),
            );
        },
      ),
      shutdownStage("CtrlProxy forwarding leases", "adb forward removal", (stage) =>
        this.releaseForwardLeases(
          boundWithinStage(stage, CTRL_PROXY_FORWARD_RELEASE_SHUTDOWN_TIMEOUT_MS),
        ),
      ),
      shutdownStage("device allocation claims", "device claim release", () =>
        this.host.services.devicePool().releaseDeviceClaimsForShutdown(),
      ),
      shutdownStage("managed ADB server", "adb kill-server", () =>
        this.host.stopManagedAdbServer()(),
      ),
      shutdownStage(
        // Abandoned is not cancelled. With every later stage's share still reserved, give the
        // stragglers (a recording finalizer, a capture stop, a slow release) what is left of
        // the budget before the database closes and the process exits.
        "abandoned stage settle",
        "earlier stages that passed their deadline",
        (stage) => databaseTail.settle(stage),
      ),
      shutdownStage("database write drain", "in-flight best-effort database writes", (stage) =>
        drainShutdownDatabaseWrites(boundWithinStage(stage, DB_WRITE_DRAIN_TIMEOUT_MS)),
      ),
      shutdownStage("in-flight migrations", "a cold-start migration still running", (stage) =>
        settleShutdownMigrations(boundWithinStage(stage, MIGRATION_SETTLE_TIMEOUT_MS)),
      ),
      shutdownStage("database", "the database connection closing", (stage) =>
        databaseTail.close(stage),
      ),
      shutdownStage(
        // The three database stages above rarely use their share. Hand it to any stage still
        // running, so a shutdown that finishes all its work inside the limit is a clean one.
        "late abandoned stage settle",
        "earlier stages that passed their deadline",
        (stage) => databaseTail.lateSettle(stage),
      ),
      shutdownStage("logger", "the log file flush", async () => {
        logger.info("Daemon stopped");
        await logger.closeAfterFlush();
      }),
      // Removed LAST, only once logging has fully flushed and closed: the pid
      // record is this daemon's ONLY externally-observable liveness signal, and
      // the detached process keeps holding the inherited launch-log fd through
      // every earlier stage above. Removing it any earlier opens a window where
      // a concurrent pruning sweep in another process reads "no daemon" while
      // this one is still alive and still writing, and unlinks a launch log out
      // from under it (issue #6194). The unconditional `process.once("exit", ...)`
      // cleanup remains as a safety net for shutdown paths that never reach here.
      shutdownStage("daemon files", "pid, socket and token file removal", async () => {
        this.host.removeHttpToken();
        await this.host.cleanupDaemonFilesForShutdown();
      }),
    ];
  }

  private unsubscribeAdbMissing(): void {
    this.host.lifecycle.unsubscribeAdbMissingDevice()?.();
    this.host.lifecycle.setUnsubscribeAdbMissingDevice(null);
  }

  /** Remove the forwards this daemon recorded and release its forwarding leases, bounded. */
  private releaseForwardLeases(timeoutMs: number): Promise<void> {
    return AndroidCtrlProxyClient.releaseForwardLeasesForShutdown(
      this.host.services.timer(),
      timeoutMs,
    );
  }

  private clearHttpSessionRegistry(): void {
    this.host.services.httpIngress().clearSessions();
  }

  private async drainShutdownMonitors(
    navigationRetentionMonitor: NavigationRetentionMonitor | null,
    heartbeatMonitor: SessionHeartbeatMonitor | null,
    deviceDisconnectMonitor: SingleFlightInterval | null,
    sweepDrainTimeoutMs: number,
  ): Promise<void> {
    // The navigation retention monitor's in-flight pass drains via the DB
    // write-barrier stage below; here we only cancel its next scheduled tick.
    navigationRetentionMonitor?.stop();
    releaseDaemonTaskLeases(); // running MCP tasks stop renewing their leases (#4668)
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
      await raceWithDeadline(
        Promise.allSettled(this.host.lifecycle.deferredSessionRecoverySweeps()),
        {
          timer: this.host.services.timer(),
          timeoutMs: sweepDrainTimeoutMs,
          label: "Recovery sweep drain",
          timeoutError: () => timedOut,
        },
      );
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      sweepsSettled = false;
    }
    if (!sweepsSettled) {
      logger.warn(
        `Timed out after ${sweepDrainTimeoutMs}ms draining deferred session recovery sweeps; continuing daemon shutdown`,
      );
    }
  }

  /**
   * Close every ingress before interrupting active provisioning. Without this
   * ordering, a request can begin after the cancellation sweep and reach
   * shutdown teardown without persisting its retryable handoff outcome.
   */
  async quiesceProvisioningIngress(): Promise<void> {
    this.host.services.httpIngress().stopAccepting();
    // No forward reaches the MCP server from here on: the in-process gate HTTP's 503 was.
    this.host.services.mcpDispatcher().stopAccepting();
    this.host.services.httpIngress().abortPendingAdmissions();
    // Start closing the listener now so it cannot admit a connection after the
    // transport snapshot. The later HTTP server stage awaits this close.
    void this.host.services
      .httpIngress()
      .closeListener()
      .catch((error) => {
        logger.warn(`Failed to begin HTTP listener shutdown: ${errorMessage(error)}`, error);
      });
    const quiescing = this.host.lifecycle.socketServer()?.quiesce();
    this.host.services.sessionManager().stopAcceptingSessionCreations();
    await quiescing;
  }

  private async releaseActiveSessionsForShutdown(drainTimeoutMs: number): Promise<void> {
    const sessionIds = this.host.services.sessionManager().getAllKnownSessionIds();
    this.shutdownSessionIds = sessionIds;
    const releases = sessionIds.map(async (sessionId) => {
      await this.host.cancelAndReleaseSession(sessionId, "daemon-shutdown", { allowExpired: true });
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
    const drained = await this.host.services
      .sessionManager()
      .drainReleasePromises(drainTimeoutMs, releases);
    if (!drained) {
      this.shutdownSessionReleasesDrained = false;
      logger.warn(
        `Timed out after ${drainTimeoutMs}ms draining session releases; database will remain open`,
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
    const notified = this.host.lifecycle.shutdownReleaseNotifications();
    const fallbacks = this.host.lifecycle.shutdownFallbackReleaseNotifications();
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

  get testHooks() {
    return {
      markShutdownInProgress: (): void => {
        this.host.lifecycle.setShutdownInProgress(true);
      },
      quiesceProvisioningIngress: (): Promise<void> => this.quiesceProvisioningIngress(),
    } as const;
  }
}
