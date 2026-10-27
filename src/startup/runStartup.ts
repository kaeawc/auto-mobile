import { ENV, readEnvRaw } from "../config/env";
import { parseArgs } from "../cli/parseArgs";
import { isCliHelpInvocation } from "../cli/helpFlag";
import { terminateCliProcess } from "../cli/termination";
import {
  closeLoggerAfterCommittedResult,
  exitAfterSuccessfulDaemonCommand,
} from "../cli/daemonCommandExit";
import { daemonCommandSkipsServerBootstrap } from "../daemon/cli/daemonCommandRouting";
import { resolveSessionOwnerGenerationToken } from "../devices/sessionConfig";
import { configureToolSelectionCliDefaults } from "../features/toolSelection/SessionToolSelectionService";
import { startBackgroundDeviceWork } from "./backgroundPrefetch";
import {
  buildDaemonModeOptions,
  buildDaemonStartupOptions,
  eventAllMarkerOptions,
} from "./daemonLaunchOptions";
import {
  buildAccessibilityConfig,
  createFeatureFlagStartup,
  runDatabasePreflight,
} from "./featureFlagStartup";
import { applyServerConfigFromArgs } from "./serverConfigStartup";
import type { ServerModules } from "./serverModules";
import type { ParsedArgs, StdioRuntimeState } from "./startupContext";
import { logActiveDaemonFlags } from "./startupLogging";
import { runStdioServer } from "./stdioServer";

/**
 * Everything `main()` does once the server modules are loaded: parse the command line, route it to
 * the daemon, daemon-command, `--cli` or stdio-server path, and run that path's startup.
 */
export async function runStartup(
  modules: ServerModules,
  state: StdioRuntimeState,
  launchParentPid: number,
): Promise<void> {
  const { logger } = modules;
  const args = parseArgs(process.argv.slice(2), logger);
  if (args.invalidInvocation) {
    console.error(args.invalidInvocation);
    process.exit(1);
    return;
  }
  const ownerGenerationToken = await resolveOwnerGenerationToken(args);
  if (await runSkippedBootstrapDaemonCommand(args, modules)) {
    return;
  }
  if (await runSkippedBootstrapCliCommand(args, modules)) {
    return;
  }
  bootstrapServer(args, modules);

  const accessibilityConfig = buildAccessibilityConfig(args);
  await runDatabasePreflight(
    args,
    modules,
    createFeatureFlagStartup(args, modules, accessibilityConfig),
  );
  if (args.noWaitForPollingOverhead) {
    modules.serverConfig.setWaitForPollingOverheadEnabled(false);
    logger.info(
      "WaitFor polling overhead disabled (--no-waitfor-polling-overhead): back stack skipped during observe waitFor polling",
    );
  }
  logActiveDaemonFlags(args, logger);
  const markers = eventAllMarkerOptions(args);

  if (args.daemonMode) {
    await modules.startDaemon(buildDaemonModeOptions(args, markers));
    return;
  }
  if (args.daemonCommand) {
    await runDaemonCommandWithDefaults(args, args.daemonCommand, modules);
    return;
  }

  const daemonStartupOptions = buildDaemonStartupOptions(args, accessibilityConfig, markers);
  if (args.cliMode) {
    await runCliMode(args, modules, daemonStartupOptions);
    return;
  }
  await runStdioServer(args, modules, state, {
    launchParentPid,
    ownerGenerationToken,
    daemonStartupOptions,
  });
}

async function resolveOwnerGenerationToken(args: ParsedArgs): Promise<string | undefined> {
  const { sessionConfig } = args;
  if (
    args.cliMode ||
    args.daemonMode ||
    args.daemonRequested ||
    sessionConfig?.executionOwnerPid === undefined
  ) {
    return undefined;
  }
  const [{ isProcessRunning }, { defaultLockOwnerGenerationProbe }] = await Promise.all([
    import("../utils/processLiveness"),
    import("../daemon/lockOwnerGeneration"),
  ]);
  return resolveSessionOwnerGenerationToken(sessionConfig, {
    isProcessRunning: (pid) => isProcessRunning(pid),
    probe: defaultLockOwnerGenerationProbe,
  });
}

/**
 * An unknown daemon command prints usage; commands that only talk to an existing daemon (or print
 * usage) skip the server bootstrap: tool registration, startup maintenance and the CtrlProxy/video
 * prefetches (#11252). Returns true when the command was handled.
 */
async function runSkippedBootstrapDaemonCommand(
  args: ParsedArgs,
  modules: ServerModules,
): Promise<boolean> {
  const { daemonCommand, daemonArgs } = args;
  if (args.daemonRequested && daemonCommand === undefined) {
    const { printUnknownDaemonCommand } = await import("../daemon/cli/runDaemonCommand");
    printUnknownDaemonCommand(undefined);
    return true;
  }
  if (daemonCommand && daemonCommandSkipsServerBootstrap(daemonCommand)) {
    await modules.runDaemonCommand(daemonCommand, daemonArgs, { namespaceEnv: process.env });
    await exitAfterSuccessfulDaemonCommand(modules.logger, process);
    return true;
  }
  return false;
}

/**
 * A `--cli doctor` invocation that only prints its usage or rejects its flags skips the server
 * bootstrap, as usage-only daemon commands do (#11252), so it starts no maintenance or CtrlProxy
 * prefetch (#14533). It needs no daemon startup options. Returns true when the command was handled.
 */
async function runSkippedBootstrapCliCommand(
  args: ParsedArgs,
  modules: ServerModules,
): Promise<boolean> {
  if (!args.cliMode || !modules.cliCommandSkipsServerBootstrap(args.cliArgs)) {
    return false;
  }
  await runCliMode(args, modules, undefined);
  return true;
}

function bootstrapServer(args: ParsedArgs, modules: ServerModules): void {
  // Startup defaults are daemon-wide policy. Per-connection profiles still
  // layer over them, while environment and launch flags seed the shared
  // fallback before a client profile has been materialized.
  configureToolSelectionCliDefaults(args.enabledTools, args.disabledTools);
  // Validate exact startup names before daemon/direct listeners can publish
  // readiness. createMcpServer repeats this registration for direct embedded
  // consumers, but daemon mode creates MCP servers lazily on first request.
  modules.registerMcpTools(args.daemonMode);
  applyServerConfigFromArgs(args, modules);
  startBackgroundDeviceWork(
    modules,
    args.skipCtrlProxyDownload,
    isCliHelpInvocation(args.cliMode, args.cliArgs),
  );
}

async function runDaemonCommandWithDefaults(
  args: ParsedArgs,
  daemonCommand: string,
  modules: ServerModules,
): Promise<void> {
  const { enabledTools, disabledTools } = args;
  const hasEnabledToolDefaults =
    enabledTools.length > 0 || readEnvRaw(ENV.ENABLED_TOOLS) !== undefined;
  const hasDisabledToolDefaults =
    disabledTools.length > 0 || readEnvRaw(ENV.DISABLED_TOOLS) !== undefined;
  const hasStartupToolDefaults = hasEnabledToolDefaults || hasDisabledToolDefaults;
  await modules.runDaemonCommand(daemonCommand, args.daemonArgs, {
    namespaceEnv: process.env,
    ...(hasStartupToolDefaults
      ? {
          startupToolDefaults: {
            ...(hasEnabledToolDefaults ? { enabledTools } : {}),
            ...(hasDisabledToolDefaults ? { disabledTools } : {}),
          },
        }
      : {}),
  });
  // Exit explicitly after daemon command completes to prevent process from hanging
  // Same issue as CLI mode - event loop may have pending operations
  await exitAfterSuccessfulDaemonCommand(modules.logger, process);
}

async function runCliMode(
  args: ParsedArgs,
  modules: ServerModules,
  daemonStartupOptions: Parameters<ServerModules["runCliCommand"]>[1],
): Promise<void> {
  const { logger } = modules;
  logger.info("Running in CLI mode");
  const termination = await modules.runCliCommand(args.cliArgs, daemonStartupOptions);
  // CRITICAL: Exit explicitly after CLI command completes to prevent process from hanging
  // The event loop may have pending operations (ADB connections, file descriptors) that
  // prevent Node.js from exiting naturally. Force exit with code 0 to ensure clean termination.
  await closeLoggerAfterCommittedResult(logger);
  if (termination) {
    // A failed bounded repair has already reported its complete structured
    // result and waited for destructive lifecycle cleanup. Its abandoned
    // read-only diagnostic work may still own sockets, so this executable
    // boundary must not wait for the event loop to become empty.
    terminateCliProcess(termination, {
      terminate: (exitCode) => process.exit(exitCode),
    });
    return;
  }
  process.exit(process.exitCode ?? 0);
}
