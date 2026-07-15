#!/usr/bin/env bun
import { bootstrapEnvironment } from "./utils/envBootstrap";
import {
  DAEMON_LAUNCH_CWD_ENV,
  resolveDaemonLaunchWorkingDirectory,
  safeProcessCwd,
} from "./utils/workingDirectory";

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
import type { PlanExecutionLockScope } from "./utils/ServerConfig";
import {
  parseOutputReductionFlags,
  OUTPUT_REDUCTION_FLAG_SPECS,
  type OutputReductionFlags,
} from "./utils/outputReductionFlags";
import type { VideoRecordingConfigInput } from "./models";
import { getGlobalVersionOutput } from "./cli/versionFlag";
import { startupBenchmark } from "./utils/startupBenchmark";
import { getMcpServerVersion } from "./utils/mcpVersion";
import {
  SKIP_CTRL_PROXY_DOWNLOAD_ENV,
  SKIP_CTRL_PROXY_DOWNLOAD_FLAG,
  shouldSkipCtrlProxyDownload,
} from "./utils/ctrlProxyDownloadControl";
import { parseToolOutputsDirConfig } from "./utils/toolOutputArtifacts";
import {
  parseEventAllMarkersConfig,
  hasEventAllMarkersCliOverride,
  EVENT_ALL_MARKERS_FLAG,
} from "./utils/eventAllMarkers";
import {
  installProcessLifecycleHandlers,
  setFatalProcessHandler,
  setProcessShutdownHandler,
} from "./processLifecycle";

interface FatalLogger {
  error(...args: unknown[]): void;
  close(): void;
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
setFatalProcessHandler(event => {
  if (event.type === "uncaughtException") {
    logFatal("Uncaught exception", event.error);
    return;
  }
  logFatal("Unhandled rejection", event.reason);
});

interface ParseLogger {
  warn(message: string): void;
}

// Parse command line arguments
function parseArgs(log: ParseLogger): {
  cliMode: boolean;
  cliArgs: string[];
  daemonPort: number | undefined;
  /** Set only when `--host` is passed; otherwise Daemon uses its default (IPv4 loopback). */
  daemonHost: string | undefined;
  debugPerf: boolean;
  debug: boolean;
  uiPerfMode: boolean;
  memPerfAuditMode: boolean;
  a11yAuditMode: boolean;
  a11yLevel?: string;
  a11yFailureMode?: string;
  a11yMinSeverity?: string;
  a11yUseBaseline: boolean;
  predictiveUi: boolean;
  rawElementSearch: boolean;
  planExecutionLockScope: PlanExecutionLockScope;
  videoRecordingDefaults: VideoRecordingConfigInput;
  daemonMode: boolean;
  daemonCommand?: string;
  daemonArgs: string[];
  skipCtrlProxyDownload: boolean;
  embeddedSdk: boolean;
  networkMockable: boolean;
  dismissKeyboardAfterInput: boolean;
  eventAllMarkers: string[];
  eventAllMarkersCliOverride: boolean;
  mcpRecording: boolean;
  navigationScreenshots: boolean;
  noWaitForPollingOverhead: boolean;
  noProxy: boolean;
  noDaemon: boolean;
  noA11yIncludeNotImportantViews: boolean;
  noA11yReportViewIds: boolean;
  noA11yRetrieveInteractiveWindows: boolean;
  outputReduction: OutputReductionFlags;
  toolOutputsDir: string | undefined;
  } {
  const args = process.argv.slice(2);

  let daemonPort: number | undefined;
  let daemonHost: string | undefined;

  // Detect CLI mode based on command line flag
  const cliMode = args.includes("--cli");

  // Detect daemon mode (internal daemon process)
  const daemonMode = args.includes("--daemon-mode");

  // Detect no-proxy mode (skip daemon proxy, execute tools directly)
  // By default, MCP server proxies to daemon for stable device management
  // --direct is kept as an undocumented alias for backwards compatibility
  const noProxy = args.includes("--no-proxy") || args.includes("--direct");

  // Detect no-daemon mode (keep proxy architecture but disable daemon auto-start)
  const noDaemon = args.includes("--no-daemon");

  // Detect daemon management command
  const daemonCommandIndex = args.indexOf("--daemon");
  const daemonCommand =
    daemonCommandIndex >= 0 ? args[daemonCommandIndex + 1] : undefined;
  const daemonArgs =
    daemonCommandIndex >= 0 ? args.slice(daemonCommandIndex + 2) : [];

  // Detect debug-perf mode for performance timing and audit output
  const debugPerf =
    args.includes("--debug-perf") ||
    args.includes("--ui-perf-debug") ||
    process.env.AUTOMOBILE_DEBUG_PERF === "1";

  // Detect debug mode to enable debug tools (debugSearch, bugReport)
  const debug =
    args.includes("--debug") || process.env.AUTOMOBILE_DEBUG === "1";

  // UI performance mode is enabled by default (captures TTI, displayed metrics)
  // Use --no-ui-perf-mode to disable
  const uiPerfMode = !args.includes("--no-ui-perf-mode");

  // Detect memory performance audit mode
  const memPerfAuditMode = args.includes("--mem-perf-audit");

  // Detect accessibility audit mode
  const a11yAuditMode = args.includes("--accessibility-audit");
  let a11yLevel: string | undefined;
  let a11yFailureMode: string | undefined;
  let a11yMinSeverity: string | undefined;
  let a11yUseBaseline = false;
  const predictiveUi = args.includes("--predictive") || args.includes("--predictive-ui");
  const rawElementSearch = args.includes("--raw-element-search");
  const skipCtrlProxyDownload = shouldSkipCtrlProxyDownload(args);
  const embeddedSdk = args.includes("--embedded-sdk");
  const networkMockable = args.includes("--network-mockable");
  const dismissKeyboardAfterInput = args.includes("--dismiss-keyboard-after-input");
  const eventAllMarkers = parseEventAllMarkersConfig(args, process.env);
  const eventAllMarkersCliOverride = hasEventAllMarkersCliOverride(args);
  const mcpRecording = args.includes("--mcp-recording");
  const navigationScreenshots = !args.includes("--no-navigation-screenshots");
  const noWaitForPollingOverhead = args.includes("--no-waitfor-polling-overhead");
  const noA11yIncludeNotImportantViews = args.includes("--no-include-not-important-views");
  const noA11yReportViewIds = args.includes("--no-report-view-ids");
  const noA11yRetrieveInteractiveWindows = args.includes("--no-retrieve-interactive-windows");
  // Output-size reduction flags (issue #2756): each parses from CLI OR its
  // AUTOMOBILE_* env var, CLI winning via ||.
  const outputReduction = parseOutputReductionFlags(args, process.env);
  const toolOutputsDir = parseToolOutputsDirConfig(
    args,
    process.env,
    resolveDaemonLaunchWorkingDirectory()
  );
  let planExecutionLockScope: PlanExecutionLockScope = "session";
  const videoRecordingDefaults: VideoRecordingConfigInput = {};

  const parsePositiveNumber = (
    value: string | undefined,
    label: string,
    allowFloat: boolean
  ): number | undefined => {
    if (!value) {
      return undefined;
    }
    const parsed = allowFloat ? Number(value) : parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      log.warn(`Invalid ${label}: ${value}`);
      return undefined;
    }
    return allowFloat ? parsed : Math.round(parsed);
  };

  const allowedQualityPresets = new Set(["low", "medium", "high"]);
  const allowedFormats = new Set(["mp4"]);

  const applyQualityPreset = (value: string | undefined, source: string) => {
    if (!value) {
      return;
    }
    if (!allowedQualityPresets.has(value)) {
      log.warn(`Invalid video quality preset (${source}): ${value}`);
      return;
    }
    videoRecordingDefaults.qualityPreset = value;
  };

  const applyFormat = (value: string | undefined, source: string) => {
    if (!value) {
      return;
    }
    if (!allowedFormats.has(value)) {
      log.warn(`Invalid video format (${source}): ${value}`);
      return;
    }
    videoRecordingDefaults.format = value;
  };

  // @deprecated AUTO_MOBILE_VIDEO_* - use AUTOMOBILE_VIDEO_* instead
  applyQualityPreset(
    process.env.AUTOMOBILE_VIDEO_QUALITY_PRESET ??
      process.env.AUTO_MOBILE_VIDEO_QUALITY_PRESET,
    "env"
  );
  const envTargetBitrate = process.env.AUTOMOBILE_VIDEO_TARGET_BITRATE_KBPS ??
    process.env.AUTO_MOBILE_VIDEO_TARGET_BITRATE_KBPS;
  const envMaxThroughput = process.env.AUTOMOBILE_VIDEO_MAX_THROUGHPUT_MBPS ??
    process.env.AUTO_MOBILE_VIDEO_MAX_THROUGHPUT_MBPS;
  const envFps = process.env.AUTOMOBILE_VIDEO_FPS ??
    process.env.AUTO_MOBILE_VIDEO_FPS;
  const envArchiveMb = process.env.AUTOMOBILE_VIDEO_MAX_ARCHIVE_MB ??
    process.env.AUTO_MOBILE_VIDEO_MAX_ARCHIVE_MB;
  const envFormat = process.env.AUTOMOBILE_VIDEO_FORMAT ??
    process.env.AUTO_MOBILE_VIDEO_FORMAT;

  const parsedTargetBitrate = parsePositiveNumber(envTargetBitrate, "video target bitrate", false);
  if (parsedTargetBitrate !== undefined) {
    videoRecordingDefaults.targetBitrateKbps = parsedTargetBitrate;
  }

  const parsedMaxThroughput = parsePositiveNumber(envMaxThroughput, "video max throughput", true);
  if (parsedMaxThroughput !== undefined) {
    videoRecordingDefaults.maxThroughputMbps = parsedMaxThroughput;
  }

  const parsedFps = parsePositiveNumber(envFps, "video fps", false);
  if (parsedFps !== undefined) {
    videoRecordingDefaults.fps = parsedFps;
  }

  const parsedArchive = parsePositiveNumber(envArchiveMb, "video max archive size", true);
  if (parsedArchive !== undefined) {
    videoRecordingDefaults.maxArchiveSizeMb = parsedArchive;
  }

  applyFormat(envFormat, "env");

  // Extract CLI-specific arguments (everything after --cli)
  const cliIndex = args.indexOf("--cli");
  const cliArgs = cliMode ? args.slice(cliIndex + 1) : [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Skip CLI mode arguments
    if (arg === "--cli") {
      break;
    }

    if (arg === "--port") {
      const port = parseInt(args[i + 1], 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        daemonPort = port;
        i++; // Skip the port argument
      } else {
        log.warn(`Invalid port: ${args[i + 1]}`);
        i++; // Skip the invalid argument
      }
    } else if (arg === "--host") {
      const host = args[i + 1];
      if (host && !host.startsWith("--")) {
        daemonHost = host;
        i++; // Skip the host argument
      } else {
        log.warn(`Invalid host: ${host}`);
        i++; // Skip the invalid argument
      }
    } else if (arg === "--a11y-level") {
      // Accessibility audit options
      a11yLevel = args[i + 1];
      i++;
    } else if (arg === "--a11y-failure-mode") {
      a11yFailureMode = args[i + 1];
      i++;
    } else if (arg === "--a11y-min-severity") {
      a11yMinSeverity = args[i + 1];
      i++;
    } else if (arg === "--a11y-use-baseline") {
      a11yUseBaseline = true;
    } else if (arg === "--plan-execution-lock-scope") {
      const scope = args[i + 1];
      if (scope === "global" || scope === "session") {
        planExecutionLockScope = scope;
      } else {
        log.warn(`Invalid plan execution lock scope: ${scope}. Using default: ${planExecutionLockScope}`);
      }
      i++;
    } else if (arg === "--video-quality" || arg === "--video-quality-preset") {
      const qualityPreset = args[i + 1];
      applyQualityPreset(qualityPreset, "cli");
      i++;
    } else if (arg === "--video-target-bitrate-kbps") {
      const parsed = parsePositiveNumber(args[i + 1], "video target bitrate", false);
      if (parsed !== undefined) {
        videoRecordingDefaults.targetBitrateKbps = parsed;
      }
      i++;
    } else if (arg === "--video-max-throughput-mbps") {
      const parsed = parsePositiveNumber(args[i + 1], "video max throughput", true);
      if (parsed !== undefined) {
        videoRecordingDefaults.maxThroughputMbps = parsed;
      }
      i++;
    } else if (arg === "--video-fps") {
      const parsed = parsePositiveNumber(args[i + 1], "video fps", false);
      if (parsed !== undefined) {
        videoRecordingDefaults.fps = parsed;
      }
      i++;
    } else if (arg === "--video-format") {
      const format = args[i + 1];
      applyFormat(format, "cli");
      i++;
    } else if (arg === "--video-archive-size-mb") {
      const parsed = parsePositiveNumber(args[i + 1], "video max archive size", true);
      if (parsed !== undefined) {
        videoRecordingDefaults.maxArchiveSizeMb = parsed;
      }
      i++;
    }
  }

  return {
    cliMode,
    cliArgs,
    daemonPort,
    daemonHost,
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
    outputReduction,
    toolOutputsDir,
  };
}

async function main() {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { createMcpServer } = await import("./server");
  const { createProxyMcpServer } = await import("./server/proxyServer");
  const { logger } = await import("./utils/logger");
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

  startupBenchmark.mark("processEntry");

  const { startVideoRecordingSocketServer, stopVideoRecordingSocketServer } = videoRecordingSocketServer;
  const { startTestRecordingSocketServer, stopTestRecordingSocketServer } = testRecordingSocketServer;
  const { startDeviceSnapshotSocketServer, stopDeviceSnapshotSocketServer } = deviceSnapshotSocketServer;
  const { startAppearanceSocketServer, stopAppearanceSocketServer } = appearanceSocketServer;
  const { startWebRtcStreamSocketServer, stopWebRtcStreamSocketServer } = webrtcStreamSocketServer;
  const { startAppearanceSyncScheduler, stopAppearanceSyncScheduler } = appearanceSyncScheduler;
  setProcessShutdownHandler(async signal => {
    logger.info(`Received ${signal} signal, shutting down`);
    await stopVideoRecordingSocketServer();
    await stopTestRecordingSocketServer();
    await stopDeviceSnapshotSocketServer();
    await stopAppearanceSocketServer();
    await stopWebRtcStreamSocketServer();
    stopAppearanceSyncScheduler();
    await AndroidCtrlProxyManager.cleanupPrefetchedApk();
    logger.close();
  });

  try {
    // Parse command line arguments
    const {
      cliMode,
      cliArgs,
      daemonPort,
      daemonHost,
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
      outputReduction,
      toolOutputsDir,
    } = parseArgs(logger);

    serverConfig.setPlanExecutionLockScope(planExecutionLockScope);
    serverConfig.setVideoRecordingDefaults(videoRecordingDefaults);
    serverConfig.setToolOutputsDir(toolOutputsDir);
    serverConfig.setSkipCtrlProxyDownload(skipCtrlProxyDownload);
    serverConfig.setEmbeddedSdkEnabled(embeddedSdk);
    serverConfig.setNetworkMockableEnabled(networkMockable);
    serverConfig.setDismissKeyboardAfterInputEnabled(dismissKeyboardAfterInput);
    serverConfig.setEventAllMarkers(eventAllMarkers);
    if (skipCtrlProxyDownload) {
      logger.info(`CtrlProxy downloads disabled (${SKIP_CTRL_PROXY_DOWNLOAD_FLAG} or ${SKIP_CTRL_PROXY_DOWNLOAD_ENV})`);
    } else {
      // Start prefetching the accessibility service APK in the background
      // This runs asynchronously and will be ready when first device connects
      AndroidCtrlProxyManager.prefetchApk();
    }

    // Reap orphaned iOS runners before the daemon accepts iOS work, then start
    // the build prefetch asynchronously so it can be ready for first use.
    if (process.platform === "darwin") {
      await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup();
      if (skipCtrlProxyDownload) {
        logger.info(`CtrlProxy iOS prefetch disabled (${SKIP_CTRL_PROXY_DOWNLOAD_FLAG} or ${SKIP_CTRL_PROXY_DOWNLOAD_ENV})`);
      } else {
        IOSCtrlProxyBuilder.prefetchBuild();
      }
    }

    const featureFlagService = FeatureFlagService.getInstance();

    const accessibilityConfig = a11yAuditMode
      ? {
        level: (a11yLevel as "A" | "AA" | "AAA" | undefined) || "AA",
        failureMode: (a11yFailureMode as "report" | "threshold" | "strict" | undefined) || "report",
        minSeverity: (a11yMinSeverity as "error" | "warning" | "info" | undefined) ||
            ((a11yFailureMode as "report" | "threshold" | "strict" | undefined) === "strict" ? "error" : "warning"),
        useBaseline: a11yUseBaseline,
      }
      : null;

    const cliOverrides: Array<[FeatureFlagKey, boolean, string, Record<string, unknown> | null | undefined]> = [
      ["debug", debug, "--debug"],
      ["debug-perf", debugPerf, "--debug-perf/--ui-perf-debug"],
      ["ui-perf-mode", uiPerfMode, "--ui-perf-mode"],
      ["mem-perf-audit", memPerfAuditMode, "--mem-perf-audit"],
      ["accessibility-audit", a11yAuditMode, "--accessibility-audit", accessibilityConfig],
      ["predictive-ui", predictiveUi, "--predictive/--predictive-ui"],
      ["raw-element-search", rawElementSearch, "--raw-element-search"],
      ["mcp-recording", mcpRecording, "--mcp-recording"],
      ...OUTPUT_REDUCTION_FLAG_SPECS.map(
        spec =>
          [spec.featureFlagKey, outputReduction[spec.field], spec.label, undefined] as [
            FeatureFlagKey,
            boolean,
            string,
            Record<string, unknown> | null | undefined
          ]
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

    if (noWaitForPollingOverhead) {
      serverConfig.setWaitForPollingOverheadEnabled(false);
      logger.info("WaitFor polling overhead disabled (--no-waitfor-polling-overhead): screenshots and back stack skipped during observe waitFor polling");
    }

    // Log-only echoes for daemon CLI flags whose side effects are applied
    // downstream via startDaemon(). Surfacing them at startup makes CI logs
    // grep-verifiable so a missing flag is visible without re-running.
    const silentDaemonFlags: Array<[boolean, string]> = [
      [!uiPerfMode, "UI perf mode disabled (--no-ui-perf-mode): skipping selection-state visual capture on taps and UI perf auditing"],
      [embeddedSdk, "Embedded SDK tools enabled (--embedded-sdk)"],
      [dismissKeyboardAfterInput, "Dismiss keyboard after inputText enabled (--dismiss-keyboard-after-input)"],
      [noA11yIncludeNotImportantViews, "Accessibility includeNotImportantViews disabled (--no-include-not-important-views)"],
      [noA11yReportViewIds, "Accessibility reportViewIds disabled (--no-report-view-ids)"],
      [noA11yRetrieveInteractiveWindows, "Accessibility retrieveInteractiveWindows disabled (--no-retrieve-interactive-windows)"],
    ];
    for (const [active, message] of silentDaemonFlags) {
      if (active) {
        logger.info(message);
      }
    }
    if (eventAllMarkers.length > 0) {
      logger.info(`inputText eventAll auto-promotion markers configured (--event-all-markers): ${JSON.stringify(eventAllMarkers)}`);
    } else if (process.argv.slice(2).some(a => a === EVENT_ALL_MARKERS_FLAG || a.startsWith(`${EVENT_ALL_MARKERS_FLAG}=`))) {
      logger.warn(`${EVENT_ALL_MARKERS_FLAG} was provided but resolved to no markers; inputText eventAll auto-promotion stays disabled`);
    }

    const eventAllMarkerDaemonOptions: Pick<DaemonOptions, "eventAllMarkers" | "eventAllMarkersCliOverride"> =
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
        // OutputReductionFlags field names match these DaemonOptions fields 1:1.
        ...outputReduction,
      });
      return;
    }

    if (daemonCommand) {
      await runDaemonCommand(daemonCommand, daemonArgs);
      // Exit explicitly after daemon command completes to prevent process from hanging
      // Same issue as CLI mode - event loop may have pending operations
      logger.close();
      process.exit(0);
    }

    if (cliMode) {
      // Run in CLI mode
      logger.info("Running in CLI mode");
      // logger.enableStdoutLogging();
      await runCliCommand(cliArgs);
      // CRITICAL: Exit explicitly after CLI command completes to prevent process from hanging
      // The event loop may have pending operations (ADB connections, file descriptors) that
      // prevent Node.js from exiting naturally. Force exit with code 0 to ensure clean termination.
      logger.close();
      process.exit(0);
    } else {
      // In proxy mode (default), the MCP server proxies requests to the daemon
      // The daemon manages device state and tool execution
      // In no-proxy mode (--no-proxy flag), the MCP server executes tools directly
      const useProxyMode = !noProxy;

      // Construct daemon options from CLI args to pass when auto-starting daemon
      const proxyDaemonOptions: DaemonOptions = {
        debug,
        debugPerf,
        planExecutionLockScope,
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
        // OutputReductionFlags field names match these DaemonOptions fields 1:1.
        ...outputReduction,
      };

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
      // Without this, the bun process stays alive indefinitely as an orphan
      // when the client (Claude Code, Cursor, etc.) exits or crashes.
      const shutdownOnStdinClose = () => {
        logger.info("stdin closed — MCP client disconnected, shutting down");
        logger.close();
        process.exit(0);
      };
      process.stdin.on("end", shutdownOnStdinClose);
      process.stdin.on("error", shutdownOnStdinClose);
      process.stdin.on("close", shutdownOnStdinClose);

      // Run as MCP server with STDIO transport
      const stdioTransport = new StdioServerTransport();
      let server;
      let stdioProxy: ReturnType<typeof createProxyMcpServer>["proxy"] | undefined;
      try {
        if (useProxyMode) {
          const result = createProxyMcpServer({
            proxyConfig: { autoStartDaemon: !noDaemon, daemonOptions: proxyDaemonOptions }
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
        logger.info(`AutoMobile MCP server running on stdio (${useProxyMode ? "proxy" : "direct"} mode)`);
        startupBenchmark.emit("mcp-server", { transport: "stdio", mode: useProxyMode ? "proxy" : "direct" });

        // Register cleanup for proxy mode
        if (stdioProxy) {
          const cleanupProxy = async () => {
            await stdioProxy!.close();
          };
          process.on("beforeExit", cleanupProxy);
        }
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

main().catch(async err => {
  console.error("Fatal error in main():", err);
  fatalLogger?.error("Fatal error in main():", err);
  fatalLogger?.close();
  // An incomplete-extraction startup failure exits with a distinct, recoverable
  // code (EX_TEMPFAIL) so a wrapper can re-extract and retry (issue #2833);
  // every other fatal keeps exit 1. Resolved lazily to match this file's
  // deferred-import startup pattern.
  const { resolveDaemonStartupExitCode } = await import("./daemon/daemonStartupGuard");
  process.exit(resolveDaemonStartupExitCode(err));
});
