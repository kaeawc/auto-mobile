import { setProcessShutdownHandler } from "../processLifecycle";
import { createStdioShutdownStages, runShutdownCleanupStages } from "../shutdownCleanup";
import { defaultTimer } from "../utils/SystemTimer";
import type { ServerModules } from "./serverModules";
import type { StdioRuntimeState } from "./startupContext";

/**
 * Installs the process shutdown handler for the stdio server: every stage draws a deadline from
 * STDIO_SHUTDOWN_STAGES, as the daemon's stages do from theirs.
 */
export function installStdioShutdownHandler(
  modules: ServerModules,
  state: StdioRuntimeState,
): void {
  const { logger } = modules;
  let shutdownCleanupFailed = false;
  setProcessShutdownHandler(
    async (signal) => {
      shutdownCleanupFailed = false;
      logger.info(`Received ${signal} signal, shutting down`);
      // Every stage draws a deadline from STDIO_SHUTDOWN_STAGES, as the daemon's stages do from
      // theirs: a wedged capture, adb or simulator teardown is abandoned with a warning instead
      // of holding the process to its limit, and the database closes only once nothing that may
      // still write is running (#11601).
      await runShutdownCleanupStages(
        createStdioShutdownStages({
          directModeActive: () => state.directModeActive,
          cleanupChildProcesses: () => modules.cleanupDaemonChildProcesses(),
          stopManagedAdbServer: () => modules.stopManagedAdbServer(),
          stopVideoRecordingSocketServer: () => modules.stopVideoRecordingSocketServer(),
          stopDeviceGestureRecordingSocketServer: () =>
            modules.stopDeviceGestureRecordingSocketServer(),
          stopDeviceSnapshotSocketServer: () => modules.stopDeviceSnapshotSocketServer(),
          stopAppearanceSocketServer: () => modules.stopAppearanceSocketServer(),
          stopWebRtcStreamSocketServer: () => modules.stopWebRtcStreamSocketServer(),
          stopAppearanceSyncScheduler: () => modules.stopAppearanceSyncScheduler(),
          cleanupPrefetchedApk: () => modules.AndroidCtrlProxyManager.cleanupPrefetchedApk(),
          // An owner-loss shutdown ends broker sessions as session_owner_exited (#12791).
          closeStdioProxy: () =>
            state.stdioProxy?.close({ executionOwnerLost: signal === "execution-owner-lost" }),
          // The database modules are loaded only in direct mode, which is the only caller.
          drainDatabaseWrites: async (timeoutMs) => {
            const { getDbWriteBarrier } = await import("../db/dbWriteBarrier");
            if (!(await getDbWriteBarrier().drain(timeoutMs))) {
              logger.warn(
                `Timed out after ${timeoutMs}ms draining in-flight DB writes; closing database anyway`,
              );
            }
          },
          settleMigrations: async (timeoutMs) => {
            const { awaitInFlightMigrations } = await import("../db/database");
            if (!(await awaitInFlightMigrations(timeoutMs))) {
              logger.warn(
                `Timed out after ${timeoutMs}ms awaiting in-flight startup migration; closing database anyway`,
              );
            }
          },
          closeDatabase: async () => {
            // The shutdown close: an in-flight tool call that outlives it is refused from here
            // on instead of lazily reopening the database behind the exiting process.
            const { closeDatabase } = await import("../db/database");
            await closeDatabase({ forShutdown: true });
          },
          refusedDatabaseAccessCount: async () => {
            const { refusedDatabaseAccessCountAfterShutdownClose } = await import("../db/database");
            return refusedDatabaseAccessCountAfterShutdownClose();
          },
          closeLogger: () => logger.closeAfterFlush(),
          warn: (message) => logger.warn(message),
        }),
        (message, error) => {
          shutdownCleanupFailed = true;
          logger.warn(message, error);
        },
        { timer: defaultTimer },
      );
    },
    async () => {
      await logger.closeAfterFlush();
      return shutdownCleanupFailed ? { exitCode: 1 } : undefined;
    },
  );
}
