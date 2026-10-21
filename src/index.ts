#!/usr/bin/env bun
// Runtime guard stays first so a non-Bun runtime gets a clear message instead of a bundle stack
// trace; processEntry must follow it immediately: captures the launcher pid before anything else runs (#11041).
import "./runtime/bunRuntimeGuard";
import "./daemon/processEntry";
import "./runtime/reflectMetadata";
import "./daemon/bootAdmissionWiring";
import "./daemon/ctrlProxyManagerHostWiring";
import { bootstrapEnvironment } from "./utils/envBootstrap";
import { resolveAutomobileLogSink, writeEmergencyLog } from "./utils/loggingConfig";
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

import { getGlobalVersionOutput, hasGlobalVersionFlag } from "./cli/versionFlag";
import { startupBenchmark } from "./utils/startupBenchmark";
import { getSettledMcpServerVersion } from "./utils/mcpVersion";
import { installProcessLifecycleHandlers, setFatalProcessHandler } from "./processLifecycle";
import { runEarlyEntrypoints } from "./startup/earlyEntrypoints";
import { loadServerModules } from "./startup/serverModules";
import { runStartup } from "./startup/runStartup";
import type { StdioRuntimeState } from "./startup/startupContext";
import { installStdioShutdownHandler } from "./startup/stdioShutdown";

interface FatalLogger {
  error(...args: unknown[]): void;
  closeAfterFlush(): Promise<void>;
}

let fatalLogger: FatalLogger | undefined;

function logFatal(label: string, error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (fatalLogger) {
    fatalLogger.error(`${label}: ${message}`);
    if (resolveAutomobileLogSink() === "file") {
      // Foreground CLI/MCP failures must remain visible even though the default
      // logger sink is a PID-scoped file that the invoking client cannot read.
      writeEmergencyLog(label, message);
    }
  } else {
    // The file logger isn't loaded yet (crash during startup imports) — fall
    // back to stderr so the failure is never silently swallowed.
    writeEmergencyLog(label, message);
  }
}

if (hasGlobalVersionFlag(process.argv.slice(2))) {
  const versionOutput = getGlobalVersionOutput(
    process.argv.slice(2),
    await getSettledMcpServerVersion(),
  );
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
  // Captured before any await (#11232): a launcher that dies during async startup would otherwise
  // leave `process.ppid` already re-parented to init, and the execution-owner watch never fires.
  const launchParentPid = process.ppid;
  startupBenchmark.mark("processEntry");
  startupBenchmark.startPhase("moduleImports");

  await runEarlyEntrypoints(process.argv.slice(2));
  const modules = await loadServerModules((logger) => {
    fatalLogger = logger;
  });
  const state: StdioRuntimeState = { stdioProxy: undefined, directModeActive: false };
  installStdioShutdownHandler(modules, state);

  try {
    await runStartup(modules, state, launchParentPid);
  } catch (err) {
    modules.logger.error("Error initializing server:", err);
    throw err;
  }
}

// Bun sets import.meta.main on the entrypoint module; under `module: ESNext`
// this type-checks without a suppression.
if (import.meta.main) {
  main().catch(async (err) => {
    logFatal("Fatal error in main()", err);
    await fatalLogger?.closeAfterFlush();
    // An incomplete-extraction startup failure exits with a distinct, recoverable
    // code (EX_TEMPFAIL) so a wrapper can re-extract and retry (issue #2833);
    // every other fatal keeps exit 1. Resolved lazily to match this file's
    // deferred-import startup pattern.
    const { resolveDaemonStartupExitCode } = await import("./daemon/daemonStartupGuard");
    process.exit(resolveDaemonStartupExitCode(err));
  });
}
