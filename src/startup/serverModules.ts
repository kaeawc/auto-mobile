import { startupBenchmark } from "../utils/startupBenchmark";

type LoadedLogger = Awaited<typeof import("../utils/logger")>["logger"];

/**
 * Loads the heavy server modules lazily, so `--version`, `--help` and the daemon-free
 * entrypoints never pay for them. `onLoggerLoaded` runs as soon as the logger exists: a crash in
 * a later import is then still reported through it.
 */
export async function loadServerModules(onLoggerLoaded: (logger: LoadedLogger) => void) {
  const { createStdioServerTransport } = await import("../server/stdioServerTransport");
  const { OutputGatedTransport } = await import("../server/outputGatedTransport");
  const { createMcpServer, registerMcpTools } = await import("../server");
  const { createDaemonMcpProxy, createProxyMcpServer } = await import("../server/proxyServer");
  const { logger, LogLevel } = await import("../utils/logger");
  onLoggerLoaded(logger);
  const { runCliCommand, cliCommandSkipsServerBootstrap } = await import("../cli");
  const { runDaemonCommand } = await import("../daemon/manager");
  const { startDaemon } = await import("../daemon/daemon");
  const { guardDatabaseStartup } = await import("../daemon/daemonStartupGuard");
  const { DefaultDatabaseInitializer } = await import("../db/DatabaseInitializer");
  const videoRecordingSocketServer = await import("../daemon/videoRecordingSocketServer");
  const deviceGestureRecordingSocketServer =
    await import("../daemon/deviceGestureRecordingSocketServer");
  const deviceSnapshotSocketServer = await import("../daemon/deviceSnapshotSocketServer");
  const appearanceSocketServer = await import("../daemon/appearanceSocketServer");
  const webrtcStreamSocketServer = await import("../daemon/webrtcStreamSocketServer");
  const appearanceSyncScheduler = await import("../daemon/AppearanceSyncScheduler");
  const { FeatureFlagService } = await import("../features/featureFlags/FeatureFlagService");
  const { serverConfig } = await import("../utils/ServerConfig");
  const { AndroidCtrlProxyManager } = await import("../ctrlProxy/CtrlProxyManager");
  const { IosCtrlProxyBuilder } = await import("../ctrlProxy/IosCtrlProxyBuilder");
  const { IOSCtrlProxyManager } = await import("../ctrlProxy/IOSCtrlProxyManager");
  const { cleanupDaemonChildProcesses } = await import("../daemon/childProcessCleanup");
  const { stopManagedAdbServer } =
    await import("../utils/android-cmdline-tools/AdbServerLifecycle");
  startupBenchmark.endPhase("moduleImports");

  return {
    createStdioServerTransport,
    OutputGatedTransport,
    createMcpServer,
    registerMcpTools,
    createDaemonMcpProxy,
    createProxyMcpServer,
    logger,
    LogLevel,
    runCliCommand,
    cliCommandSkipsServerBootstrap,
    runDaemonCommand,
    startDaemon,
    guardDatabaseStartup,
    DefaultDatabaseInitializer,
    startVideoRecordingSocketServer: videoRecordingSocketServer.startVideoRecordingSocketServer,
    stopVideoRecordingSocketServer: videoRecordingSocketServer.stopVideoRecordingSocketServer,
    startDeviceGestureRecordingSocketServer:
      deviceGestureRecordingSocketServer.startDeviceGestureRecordingSocketServer,
    stopDeviceGestureRecordingSocketServer:
      deviceGestureRecordingSocketServer.stopDeviceGestureRecordingSocketServer,
    startDeviceSnapshotSocketServer: deviceSnapshotSocketServer.startDeviceSnapshotSocketServer,
    stopDeviceSnapshotSocketServer: deviceSnapshotSocketServer.stopDeviceSnapshotSocketServer,
    startAppearanceSocketServer: appearanceSocketServer.startAppearanceSocketServer,
    createDirectModeAppearanceDeviceSource:
      appearanceSocketServer.createDirectModeAppearanceDeviceSource,
    stopAppearanceSocketServer: appearanceSocketServer.stopAppearanceSocketServer,
    startWebRtcStreamSocketServer: webrtcStreamSocketServer.startWebRtcStreamSocketServer,
    stopWebRtcStreamSocketServer: webrtcStreamSocketServer.stopWebRtcStreamSocketServer,
    stopAppearanceSyncScheduler: appearanceSyncScheduler.stopAppearanceSyncScheduler,
    FeatureFlagService,
    serverConfig,
    AndroidCtrlProxyManager,
    IosCtrlProxyBuilder,
    IOSCtrlProxyManager,
    cleanupDaemonChildProcesses,
    stopManagedAdbServer,
  };
}

export type ServerModules = Awaited<ReturnType<typeof loadServerModules>>;
