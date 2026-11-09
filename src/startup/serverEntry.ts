// Everything but the `--version` fast path (#17684): `src/index.ts` dynamically imports this module
// right after its leading guard/processEntry/reflectMetadata imports, so the wirings below still
// load before any module that can boot a device or drive CtrlProxy, in the order they always had.
import "../daemon/bootAdmissionWiring";
import "../daemon/ctrlProxyManagerHostWiring";
import { bootstrapEnvironment } from "../utils/envBootstrap";
import { resolveAutomobileLogSink, writeEmergencyLog } from "../utils/loggingConfig";
import { DAEMON_LAUNCH_CWD_ENV, safeProcessCwd } from "../utils/workingDirectory";

// Run before any other imports that may resolve tool paths at module load time.
bootstrapEnvironment();

// Record the launch working directory before db/constants are imported. Those
// modules resolve relative env-overridden paths (AUTOMOBILE_DB_DIR/DB_PATH and the
// daemon socket/pid/lock paths) against AUTOMOBILE_DAEMON_LAUNCH_CWD. A directly
// launched daemon (--daemon-mode, not spawned by DaemonManager) otherwise only sets
// this inside Daemon.start(), which runs after it has chdir'd to a stable dir — too
// late, so paths would resolve against the wrong cwd. db/constants are pulled in via
// the dynamic import("../daemon/daemon") in loadServerModules(), so this body-level
// assignment runs first. ??= preserves a value inherited from DaemonManager-spawned daemons.
process.env[DAEMON_LAUNCH_CWD_ENV] ??= safeProcessCwd();

import { startupBenchmark } from "../utils/startupBenchmark";
import { installProcessLifecycleHandlers, setFatalProcessHandler } from "../processLifecycle";
import { runEarlyEntrypoints } from "./earlyEntrypoints";
import { loadServerModules } from "./serverModules";
import { runStartup } from "./runStartup";
import type { StdioRuntimeState } from "./startupContext";
import { installStdioShutdownHandler } from "./stdioShutdown";

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

/** Run the server/CLI/daemon startup; `src/index.ts` calls this only as the process entrypoint. */
export function runServerEntry(): void {
  main().catch(async (err) => {
    logFatal("Fatal error in main()", err);
    await fatalLogger?.closeAfterFlush();
    // An incomplete-extraction startup failure exits with a distinct, recoverable
    // code (EX_TEMPFAIL) so a wrapper can re-extract and retry (issue #2833);
    // every other fatal keeps exit 1. Resolved lazily to match this file's
    // deferred-import startup pattern.
    const { resolveDaemonStartupExitCode } = await import("../daemon/daemonStartupGuard");
    process.exit(resolveDaemonStartupExitCode(err));
  });
}
