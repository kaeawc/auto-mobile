#!/usr/bin/env bun
import "./runtime/reflectMetadata";
import { bootstrapEnvironment } from "./utils/envBootstrap";
import { DAEMON_LAUNCH_CWD_ENV, safeProcessCwd } from "./utils/workingDirectory";

// Run before any other imports that may resolve tool paths at module load time.
bootstrapEnvironment();

// Record the launch working directory before db/constants are imported. Those
// modules resolve relative env-overridden paths (AUTOMOBILE_DB_DIR/DB_PATH and the
// daemon socket/pid/lock paths) against AUTOMOBILE_DAEMON_LAUNCH_CWD. A directly
// launched daemon (--daemon-mode, not spawned by DaemonManager) otherwise only sets
// this inside Daemon.start(), which runs after it has chdir'd to a stable dir — too
// late, so paths would resolve against the wrong cwd. db/constants are pulled in via
// the dynamic import("./daemon/daemon") inside main(), so this body-level assignment
// runs first. ??= preserves a value inherited from DaemonManager-spawned daemons.
process.env[DAEMON_LAUNCH_CWD_ENV] ??= safeProcessCwd();

import type { DaemonOptions } from "./daemon/types";
import type { FeatureFlagKey } from "./features/featureFlags/FeatureFlagDefinitions";
import { OUTPUT_REDUCTION_FLAG_SPECS } from "./utils/outputReductionFlags";
import { getGlobalVersionOutput } from "./cli/versionFlag";
import { startupBenchmark } from "./utils/startupBenchmark";
import { getMcpServerVersion } from "./utils/mcpVersion";
import {
  SKIP_CTRL_PROXY_DOWNLOAD_ENV,
  SKIP_CTRL_PROXY_DOWNLOAD_FLAG,
} from "./utils/ctrlProxyDownloadControl";
import { prefetchVideoServerJar } from "./features/webrtc/videoServerJar";
import { ScreenCaptureHelperProvider } from "./features/screen-stream/ScreenCaptureHelperProvider";
import { WEBRTC_ENV } from "./features/webrtc/webrtcStreamingConfig";
import { EVENT_ALL_MARKERS_FLAG } from "./utils/eventAllMarkers";
import { parseArgs } from "./cli/parseArgs";
import {
  installProcessLifecycleHandlers,
  installStdinShutdownHandlers,
  setFatalProcessHandler,
  setProcessShutdownHandler,
} from "./processLifecycle";
import { runShutdownCleanupStages } from "./shutdownCleanup";
import { startStartupMaintenance } from "./utils/startupMaintenance";

interface FatalLogger {
  error(...args: unknown[]): void;
  closeAfterFlush(): Promise<void>;
}

let fatalLogger: FatalLogger | undefined;

function logFatal(label: string, error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (fatalLogger) {
    fatalLogger.error(`${label}: ${message}`);
  } else {
    // The file logger isn't loaded yet (crash during startup imports) — fall
    // back to stderr so the failure is never silently swallowed.
    console.error(`${label}: ${message}`);
  }
}

const versionOutput = getGlobalVersionOutput(process.argv.slice(2), getMcpServerVersion());
if (versionOutput !== undefined) {
  console.log(versionOutput);
  process.exit(0);
}

installProcessLifecycleHandlers();
setFatalProcessHandler((event) => {
  if (event.type === "uncaughtException") {
    logFatal("Uncaught exception", event.error);
    return;
  }
  logFatal("Unhandled rejection", event.reason);
});

async function main() {
  startupBenchmark.mark("processEntry");
  startupBenchmark.startPhase("moduleImports");

  const rawArgs = process.argv.slice(2);
  const bootDeviceIndex = rawArgs.indexOf("--boot-device");
  if (bootDeviceIndex >= 0) {
    // The daemon-free boot entrypoint must remain before every normal server
    // import and startup side effect: no database, daemon, CtrlProxy, or media
    // cache work is needed to launch and await a device.
    const { runBootDeviceCommand } = await import("./cli/bootDevice");
    startupBenchmark.endPhase("moduleImports");
    await runBootDeviceCommand(rawArgs.slice(bootDeviceIndex + 1));
    // Android launch owns a live emulator child; the one-shot caller only
    // needs the already-flushed JSON result, not that child as its own event
    // loop responsibility.
    process.exit(0);
  }

  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { createMcpServer } = await import("./server");
  const { createProxyMcpServer } = await import("./server/proxyServer");
  const { logger, LogLevel } = await import("./utils/logger");
  fatalLogger = logger;
  const { runCliCommand } = await import("./cli");
  const { runDaemonCommand } = await import("./daemon/manager");
  const { startDaemon } = await import("./daemon/daemon");
  const { guardDatabaseStartup } = await import("./daemon/daemonStartupGuard");
  const { DefaultDatabaseInitializer } = await import("./db/DatabaseInitializer");
  const videoRecordingSocketServer = await import("./daemon/videoRecordingSocketServer");
  const testRecordingSocketServer = await import("./daemon/testRecordingSocketServer");
  const deviceSnapshotSocketServer = await import("./daemon/deviceSnapshotSocketServer");
  const appearanceSocketServer = await import("./daemon/appearanceSocketServer");
  const webrtcStreamSocketServer = await import("./daemon/webrtcStreamSocketServer");
  const appearanceSyncScheduler = await import("./utils/appearance/AppearanceSyncScheduler");
  const { FeatureFlagService } = await import("./features/featureFlags/FeatureFlagService");
  const { serverConfig } = await import("./utils/ServerConfig");
  const { AndroidCtrlProxyManager } = await import("./utils/CtrlProxyManager");
  const { IOSCtrlProxyBuilder } = await import("./utils/IOSCtrlProxyBuilder");
  const { IOSCtrlProxyManager } = await import("./utils/IOSCtrlProxyManager");
  const { cleanupDaemonChildProcesses } = await import("./daemon/childProcessCleanup");
  const { stopManagedAdbServer } = await import("./utils/android-cmdline-tools/AdbServerLifecycle");
  startupBenchmark.endPhase("moduleImports");

  const { startVideoRecordingSocketServer, stopVideoRecordingSocketServer } =
    videoRecordingSocketServer;
  const { startTestRecordingSocketServer, stopTestRecordingSocketServer } =
    testRecordingSocketServer;
  const { startDeviceSnapshotSocketServer, stopDeviceSnapshotSocketServer } =
    deviceSnapshotSocketServer;
  const { startAppearanceSocketServer, stopAppearanceSocketServer } = appearanceSocketServer;
  const { startWebRtcStreamSocketServer, stopWebRtcStreamSocketServer } = webrtcStreamSocketServer;
  const { startAppearanceSyncScheduler, stopAppearanceSyncScheduler } = appearanceSyncScheduler;
  let stdioProxy: { close(): Promise<void> } | undefined;
  let directModeActive = false;
  let shutdownCleanupFailed = false;
  setProcessShutdownHandler(async (signal) => {
    shutdownCleanupFailed = false;
    logger.info(`Received ${signal} signal, shutting down`);
    await runShutdownCleanupStages(
      [
        {
          name: "direct-mode capture and iOS CtrlProxy children",
          run: async () => {
            if (directModeActive) {
              await cleanupDaemonChildProcesses();
            }
          },
        },
        {
          name: "direct-mode managed ADB server",
          run: async () => {
            if (directModeActive) {
              await stopManagedAdbServer();
            }
          },
        },
        { name: "video recording socket server", run: stopVideoRecordingSocketServer },
        { name: "test recording socket server", run: stopTestRecordingSocketServer },
        { name: "device snapshot socket server", run: stopDeviceSnapshotSocketServer },
        { name: "appearance socket server", run: stopAppearanceSocketServer },
        { name: "WebRTC stream socket server", run: stopWebRtcStreamSocketServer },
        { name: "appearance sync scheduler", run: stopAppearanceSyncScheduler },
        {
          name: "prefetched Android CtrlProxy APK",
          run: AndroidCtrlProxyManager.cleanupPrefetchedApk,
        },
        { name: "stdio proxy", run: async () => await stdioProxy?.close() },
        {
          name: "logger",
          run: async () => {
            await logger.closeAfterFlush();
          },
        },
      ],
      (message, error) => {
        shutdownCleanupFailed = true;
        logger.warn(message, error);
      },
    );
  }, async () => {
    await logger.closeAfterFlush();
    return shutdownCleanupFailed ? { exitCode: 1 } : undefined;
  });

  try {
    // Parse command line arguments
    const {
      cliMode,
      cliArgs,
      daemonPort,
      daemonHost,
      initialSessionUuid,
      debugPerf,
      debug,
      uiPerfMode,
      memPerfAuditMode,
      a11yAuditMode,
      a11yLevel,
      a11yFailureMode,
      a11yMinSeverity,
      a11yUseBaseline,
      predictiveUi,
      rawElementSearch,
      planExecutionLockScope,
      runnerReadinessTimeoutMs,
      videoRecordingDefaults,
      daemonMode,
      daemonCommand,
      daemonArgs,
      skipCtrlProxyDownload,
      embeddedSdk,
      networkMockable,
      dismissKeyboardAfterInput,
      eventAllMarkers,
      eventAllMarkersCliOverride,
      mcpRecording,
      navigationScreenshots,
      noWaitForPollingOverhead,
      noProxy,
      noDaemon,
      noA11yIncludeNotImportantViews,
      noA11yReportViewIds,
      noA11yRetrieveInteractiveWindows,
      noOcclusion,
      outputReduction,
      toolOutputsDir,
    } = parseArgs(process.argv.slice(2), logger);

    if (debug) {
      logger.setLogLevel(LogLevel.DEBUG);
    }

    serverConfig.setPlanExecutionLockScope(planExecutionLockScope);
    if (runnerReadinessTimeoutMs !== undefined) {
      serverConfig.setRunnerReadinessTimeoutMs(runnerReadinessTimeoutMs);
    }
    serverConfig.setVideoRecordingDefaults(videoRecordingDefaults);
    serverConfig.setToolOutputsDir(toolOutputsDir);
    serverConfig.setSkipCtrlProxyDownload(skipCtrlProxyDownload);
    serverConfig.setEmbeddedSdkEnabled(embeddedSdk);
    serverConfig.setNetworkMockableEnabled(networkMockable);
    serverConfig.setDismissKeyboardAfterInputEnabled(dismissKeyboardAfterInput);
    serverConfig.setEventAllMarkers(eventAllMarkers);
    // Reclaim artifacts leaked by previous daemons without gating stdio
    // readiness. The sweeps are best-effort maintenance, not a prerequisite for
    // serving a new client (issue #4581).
    startStartupMaintenance({
      platform: process.platform,
      startAndroidSweep: () => AndroidCtrlProxyManager.sweepStalePrefetchDirsOnStartup(),
      startIosReap: () => IOSCtrlProxyManager.startOrphanRunnerReapOnStartup(),
    });
    if (skipCtrlProxyDownload) {
      logger.info(
        `CtrlProxy downloads disabled (${SKIP_CTRL_PROXY_DOWNLOAD_FLAG} or ${SKIP_CTRL_PROXY_DOWNLOAD_ENV})`,
      );
      startupBenchmark.recordPhase("androidCtrlProxyPrefetch", 0);
    } else {
      // Start prefetching the accessibility service APK in the background
      // This runs asynchronously and will be ready when first device connects
      startupBenchmark.startPhase("androidCtrlProxyPrefetch");
      void AndroidCtrlProxyManager.prefetchApk().then(() => {
        startupBenchmark.endPhase("androidCtrlProxyPrefetch");
      });
    }

    // Start the iOS build prefetch asynchronously so it can be ready for first
    // use. Runner cleanup above is also asynchronous and bounded.
    if (process.platform === "darwin") {
      if (skipCtrlProxyDownload) {
        logger.info(
          `CtrlProxy iOS prefetch disabled (${SKIP_CTRL_PROXY_DOWNLOAD_FLAG} or ${SKIP_CTRL_PROXY_DOWNLOAD_ENV})`,
        );
        startupBenchmark.recordPhase("iosCtrlProxyPrefetch", 0);
      } else {
        startupBenchmark.startPhase("iosCtrlProxyPrefetch");
        void IOSCtrlProxyBuilder.prefetchBuild().then(() => {
          startupBenchmark.endPhase("iosCtrlProxyPrefetch");
        });
      }
    }

    // Warm the persistent-encoder jar cache in the background, but only when
    // WebRTC streaming is configured (AUTOMOBILE_WEBRTC_WHIP_ENDPOINT) — daemons
    // that never stream pull nothing. Non-blocking; reuses the provider's
    // single-flight so a first stream shares this download (#3835).
    void prefetchVideoServerJar();
    if (
      process.platform === "darwin" &&
      process.env[WEBRTC_ENV.WHIP_ENDPOINT]?.trim() &&
      !process.env.AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER &&
      !process.env.AUTO_MOBILE_IOS_SCREEN_CAPTURE_HELPER
    ) {
      void ScreenCaptureHelperProvider.getInstance()
        .ensure()
        .catch((error) => {
          logger.warn(
            `[SCREEN_CAPTURE_HELPER] Background prefetch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }

    const featureFlagService = FeatureFlagService.getInstance();

    const accessibilityConfig = a11yAuditMode
      ? {
          level: (a11yLevel as "A" | "AA" | "AAA" | undefined) || "AA",
          failureMode:
            (a11yFailureMode as "report" | "threshold" | "strict" | undefined) || "report",
          minSeverity:
            (a11yMinSeverity as "error" | "warning" | "info" | undefined) ||
            ((a11yFailureMode as "report" | "threshold" | "strict" | undefined) === "strict"
              ? "error"
              : "warning"),
          useBaseline: a11yUseBaseline,
        }
      : null;

    const cliOverrides: Array<
      [FeatureFlagKey, boolean, string, Record<string, unknown> | null | undefined]
    > = [
      ["debug", debug, "--debug"],
      ["debug-perf", debugPerf, "--debug-perf/--ui-perf-debug"],
      ["ui-perf-mode", uiPerfMode, "--ui-perf-mode"],
      ["mem-perf-audit", memPerfAuditMode, "--mem-perf-audit"],
      ["accessibility-audit", a11yAuditMode, "--accessibility-audit", accessibilityConfig],
      ["predictive-ui", predictiveUi, "--predictive/--predictive-ui"],
      ["raw-element-search", rawElementSearch, "--raw-element-search"],
      ["mcp-recording", mcpRecording, "--mcp-recording"],
      ...OUTPUT_REDUCTION_FLAG_SPECS.map(
        (spec) =>
          [spec.featureFlagKey, outputReduction[spec.field], spec.label, undefined] as [
            FeatureFlagKey,
            boolean,
            string,
            Record<string, unknown> | null | undefined,
          ],
      ),
    ];

    // All DB-touching feature-flag startup work: migration-gated initialize()
    // reads AND the CLI-override setFlag() writes. In --daemon-mode this runs
    // inside the circuit breaker (below) so a startup DB failure anywhere here —
    // including a write that fails on a read-only/full DB launched with --debug,
    // --mcp-recording, --no-navigation-screenshots — funnels through the same
    // classify/record/backoff/rethrow path instead of escaping to main().catch
    // and tight-respawning (issue #2784).
    const applyFeatureFlagStartup = async (): Promise<void> => {
      await featureFlagService.initialize();

      for (const [key, enabled, flagLabel, config] of cliOverrides) {
        if (!enabled) {
          continue;
        }
        await featureFlagService.setFlag(key, true, config);
        logger.info(`Feature flag enabled (${flagLabel})`);
      }

      if (!navigationScreenshots) {
        await featureFlagService.setFlag("navigation-screenshots", false);
        logger.info("Navigation screenshots disabled (--no-navigation-screenshots)");
      }
    };

    await startupBenchmark.runPhase("databasePreflight", async () => {
      if (daemonMode) {
        await guardDatabaseStartup(async () => {
          await new DefaultDatabaseInitializer().initialize();
          await applyFeatureFlagStartup();
        });
      } else {
        // Direct mode (--no-proxy/--direct) opens the shared SQLite DB in-process
        // with no cross-process lock. Refuse BEFORE the first DB touch (feature-flag
        // startup opens the DB and runs migrations) if a live daemon already owns
        // the SAME resolved DB file, to avoid two writers on one sqlite file
        // (SQLITE_BUSY stalls, competing migrations, aux-socket bind conflicts).
        // File-scoped, so an isolated AUTOMOBILE_DB_PATH still starts normally. #2795
        // The ordering (guard before the DB touch, only under noProxy) lives behind
        // runDirectModeStartup() so it can be unit-tested with fakes (issue #2871).
        const { runDirectModeStartup } = await import("./daemon/directModeStartup");
        await runDirectModeStartup({
          noProxy,
          assertDbOwnership: async () => {
            const { assertDirectModeDbOwnership, createDefaultDirectModeGuardDeps } =
              await import("./daemon/directModeGuard");
            assertDirectModeDbOwnership(createDefaultDirectModeGuardDeps());
          },
          applyFeatureFlagStartup,
        });
      }
    });

    if (noWaitForPollingOverhead) {
      serverConfig.setWaitForPollingOverheadEnabled(false);
      logger.info(
        "WaitFor polling overhead disabled (--no-waitfor-polling-overhead): screenshots and back stack skipped during observe waitFor polling",
      );
    }

    // Log-only echoes for daemon CLI flags whose side effects are applied
    // downstream via startDaemon(). Surfacing them at startup makes CI logs
    // grep-verifiable so a missing flag is visible without re-running.
    const silentDaemonFlags: Array<[boolean, string]> = [
      [
        !uiPerfMode,
        "UI perf mode disabled (--no-ui-perf-mode): skipping selection-state visual capture on taps and UI perf auditing",
      ],
      [embeddedSdk, "Embedded SDK tools enabled (--embedded-sdk)"],
      [
        dismissKeyboardAfterInput,
        "Dismiss keyboard after inputText enabled (--dismiss-keyboard-after-input)",
      ],
      [
        noA11yIncludeNotImportantViews,
        "Accessibility includeNotImportantViews disabled (--no-include-not-important-views)",
      ],
      [noA11yReportViewIds, "Accessibility reportViewIds disabled (--no-report-view-ids)"],
      [
        noA11yRetrieveInteractiveWindows,
        "Accessibility retrieveInteractiveWindows disabled (--no-retrieve-interactive-windows)",
      ],
      [noOcclusion, "Observe occlusion pass disabled (--no-occlusion)"],
    ];
    for (const [active, message] of silentDaemonFlags) {
      if (active) {
        logger.info(message);
      }
    }
    if (eventAllMarkers.length > 0) {
      logger.info(
        `inputText eventAll auto-promotion markers configured (--event-all-markers): ${JSON.stringify(eventAllMarkers)}`,
      );
    } else if (
      process.argv
        .slice(2)
        .some((a) => a === EVENT_ALL_MARKERS_FLAG || a.startsWith(`${EVENT_ALL_MARKERS_FLAG}=`))
    ) {
      logger.warn(
        `${EVENT_ALL_MARKERS_FLAG} was provided but resolved to no markers; inputText eventAll auto-promotion stays disabled`,
      );
    }

    const eventAllMarkerDaemonOptions: Pick<
      DaemonOptions,
      "eventAllMarkers" | "eventAllMarkersCliOverride"
    > =
      eventAllMarkers.length > 0 || eventAllMarkersCliOverride
        ? { eventAllMarkers, eventAllMarkersCliOverride }
        : {};

    if (daemonMode) {
      await startDaemon({
        port: daemonPort,
        ...(daemonHost !== undefined ? { host: daemonHost } : {}),
        debug,
        debugPerf,
        planExecutionLockScope,
        ...(runnerReadinessTimeoutMs !== undefined ? { runnerReadinessTimeoutMs } : {}),
        videoQualityPreset: videoRecordingDefaults.qualityPreset,
        videoTargetBitrateKbps: videoRecordingDefaults.targetBitrateKbps,
        videoMaxThroughputMbps: videoRecordingDefaults.maxThroughputMbps,
        videoFps: videoRecordingDefaults.fps,
        videoFormat: videoRecordingDefaults.format,
        videoMaxArchiveSizeMb: videoRecordingDefaults.maxArchiveSizeMb,
        toolOutputsDir,
        networkMockable,
        embeddedSdk,
        dismissKeyboardAfterInput,
        ...eventAllMarkerDaemonOptions,
        noUiPerfMode: !uiPerfMode,
        memPerfAudit: memPerfAuditMode,
        accessibilityAudit: a11yAuditMode,
        accessibilityLevel: a11yLevel,
        accessibilityFailureMode: a11yFailureMode,
        accessibilityMinSeverity: a11yMinSeverity,
        accessibilityUseBaseline: a11yUseBaseline,
        predictiveUi,
        rawElementSearch,
        skipCtrlProxyDownload,
        mcpRecording,
        noNavigationScreenshots: !navigationScreenshots,
        noWaitForPollingOverhead,
        noA11yIncludeNotImportantViews,
        noA11yReportViewIds,
        noA11yRetrieveInteractiveWindows,
        noOcclusion,
        // OutputReductionFlags field names match these DaemonOptions fields 1:1.
        ...outputReduction,
      });
      return;
    }

    if (daemonCommand) {
      await runDaemonCommand(daemonCommand, daemonArgs);
      // Exit explicitly after daemon command completes to prevent process from hanging
      // Same issue as CLI mode - event loop may have pending operations
      await logger.closeAfterFlush();
      process.exit(0);
    }

    // Single source of truth for the startup options handed to the daemon,
    // shared by BOTH transports (issue #4344 propagation audit). Threading the
    // full set into the `--cli` path too — not just
    // `{embeddedSdk, networkMockable}` — closes a gap where
    // output-reduction / observe-scope / a11y-audit / predictive flags requested
    // on the CLI transport never reached (or restarted) the daemon, while the
    // stdio proxy path relayed them. One object also means the two transports can
    // never drift apart again.
    const daemonStartupOptions: DaemonOptions = {
      debug,
      debugPerf,
      planExecutionLockScope,
      ...(runnerReadinessTimeoutMs !== undefined ? { runnerReadinessTimeoutMs } : {}),
      mcpRecording,
      videoQualityPreset: videoRecordingDefaults.qualityPreset,
      videoTargetBitrateKbps: videoRecordingDefaults.targetBitrateKbps,
      videoMaxThroughputMbps: videoRecordingDefaults.maxThroughputMbps,
      videoFps: videoRecordingDefaults.fps,
      videoFormat: videoRecordingDefaults.format,
      videoMaxArchiveSizeMb: videoRecordingDefaults.maxArchiveSizeMb,
      toolOutputsDir,
      networkMockable,
      embeddedSdk,
      dismissKeyboardAfterInput,
      ...eventAllMarkerDaemonOptions,
      noUiPerfMode: !uiPerfMode,
      memPerfAudit: memPerfAuditMode,
      accessibilityAudit: a11yAuditMode,
      accessibilityLevel: a11yLevel,
      accessibilityFailureMode: a11yFailureMode,
      accessibilityMinSeverity: a11yMinSeverity,
      accessibilityUseBaseline: a11yUseBaseline,
      predictiveUi,
      rawElementSearch,
      skipCtrlProxyDownload,
      noNavigationScreenshots: !navigationScreenshots,
      noWaitForPollingOverhead,
      noA11yIncludeNotImportantViews,
      noA11yReportViewIds,
      noA11yRetrieveInteractiveWindows,
      noOcclusion,
      // OutputReductionFlags field names match these DaemonOptions fields 1:1.
      ...outputReduction,
    };

    if (cliMode) {
      // Run in CLI mode
      logger.info("Running in CLI mode");
      // logger.enableStdoutLogging();
      await runCliCommand(cliArgs, daemonStartupOptions);
      // CRITICAL: Exit explicitly after CLI command completes to prevent process from hanging
      // The event loop may have pending operations (ADB connections, file descriptors) that
      // prevent Node.js from exiting naturally. Force exit with code 0 to ensure clean termination.
      await logger.closeAfterFlush();
      process.exit(0);
    } else {
      // In proxy mode (default), the MCP server proxies requests to the daemon
      // The daemon manages device state and tool execution
      // In no-proxy mode (--no-proxy flag), the MCP server executes tools directly
      const useProxyMode = !noProxy;
      directModeActive = !useProxyMode;

      if (useProxyMode) {
        logger.info("Starting MCP server in proxy mode (connecting to daemon)");
      } else {
        logger.info("Starting MCP server in direct mode (--no-proxy flag)");
        // Start auxiliary services only in direct mode
        await startVideoRecordingSocketServer();
        await startTestRecordingSocketServer();
        await startDeviceSnapshotSocketServer();
        await startAppearanceSocketServer();
        await startWebRtcStreamSocketServer();
        startAppearanceSyncScheduler();
      }

      // Detect when the MCP client disconnects (stdin closes / pipe breaks).
      // This uses the shared lifecycle handler so resources close before exit.
      installStdinShutdownHandlers();

      // Run as MCP server with STDIO transport
      const stdioTransport = new StdioServerTransport();
      let server;
      try {
        if (useProxyMode) {
          const { getDefaultSessionHeartbeatTimeoutMs } = await import("./daemon/sessionManager");
          const result = createProxyMcpServer({
            proxyConfig: {
              autoStartDaemon: !noDaemon,
              daemonOptions: daemonStartupOptions,
              initialSessionUuid,
              heartbeatTimeoutMs: getDefaultSessionHeartbeatTimeoutMs(),
            },
          });
          server = result.server;
          stdioProxy = result.proxy;
        } else {
          server = createMcpServer({ debug });
        }
      } catch (error) {
        logger.error("Failed to create MCP server:", error);
        throw error;
      }
      try {
        logger.info("Connecting MCP server to stdio transport");
        startupBenchmark.startPhase("serverListening");
        await server.connect(stdioTransport);
        startupBenchmark.endPhase("serverListening");
        logger.info("MCP server connected to stdio transport");
        logger.info(
          `AutoMobile MCP server running on stdio (${useProxyMode ? "proxy" : "direct"} mode)`,
        );
        startupBenchmark.emit("mcp-server", {
          transport: "stdio",
          mode: useProxyMode ? "proxy" : "direct",
        });
      } catch (error) {
        logger.error("MCP server connect failed:", error);
        throw error;
      }
    }
  } catch (err) {
    logger.error("Error initializing server:", err);
    throw err;
  }
}

// Bun sets import.meta.main on the entrypoint module; under `module: ESNext`
// this type-checks without a suppression.
if (import.meta.main) {
  main().catch(async (err) => {
    console.error("Fatal error in main():", err);
    fatalLogger?.error("Fatal error in main():", err);
    await fatalLogger?.closeAfterFlush();
    // An incomplete-extraction startup failure exits with a distinct, recoverable
    // code (EX_TEMPFAIL) so a wrapper can re-extract and retry (issue #2833);
    // every other fatal keeps exit 1. Resolved lazily to match this file's
    // deferred-import startup pattern.
    const { resolveDaemonStartupExitCode } = await import("./daemon/daemonStartupGuard");
    process.exit(resolveDaemonStartupExitCode(err));
  });
}
