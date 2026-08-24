import type { FatalProcessEvent, FatalProcessHandler } from "../processLifecycle";
import { describeUnknownError } from "../utils/describeUnknownError";

/** Minimal logger surface the daemon fatal handler needs (satisfied by `logger`). */
export interface FatalHandlerLogger {
  error(message: string, ...args: any[]): void;
}

/**
 * Build the daemon's process-level fatal-event handler.
 *
 * The daemon is a long-lived singleton shared across every MCP client/session.
 * A throw that escapes an un-awaited callback/timer (e.g. an emulator
 * child-process `on("data"|"exit")` handler in `AndroidEmulatorClient`) or a
 * floating promise rejection surfaces here as `uncaughtException` /
 * `unhandledRejection` rather than on any awaited tool chain. The offending tool
 * call has already failed on its own path, so tearing down the process would
 * only wedge every OTHER connected session.
 *
 * We therefore log with full context and keep the daemon alive (issue #3408),
 * following the repo's log-then-continue convention for genuinely-unexpected
 * background failures. This is intentionally scoped to daemon mode; short-lived
 * CLI/proxy processes keep their own fail-fast handler (`src/index.ts`).
 */
export function createDaemonFatalProcessHandler(logger: FatalHandlerLogger): FatalProcessHandler {
  return (event: FatalProcessEvent) => {
    if (event.type === "uncaughtException") {
      logger.error(
        `[daemon] uncaughtException in background task; keeping daemon alive: ${describeUnknownError(event.error)}`,
        event.error,
      );
      return;
    }
    logger.error(
      `[daemon] unhandledRejection in background task; keeping daemon alive: ${describeUnknownError(event.reason)}`,
      event.reason,
    );
  };
}
