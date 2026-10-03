import { errorMessage } from "../utils/describeUnknownError";

/** Minimal logger contract for the completed daemon-command executable boundary. */
export interface CompletedDaemonCommandLogger {
  closeAfterFlush(): Promise<void>;
  flush(): Promise<void>;
  warn(message: string): void;
}

/** Injectable process boundary keeps the shutdown outcome unit-testable. */
export interface DaemonCommandProcessTerminator {
  exit(exitCode: number): void;
}

/**
 * Close the logger after the command result has already been committed.
 *
 * A late write from detached best-effort startup work can make logger teardown
 * reject after the command has committed. That teardown error must be visible,
 * but cannot turn the command result into a failure.
 */
export async function closeLoggerAfterCommittedResult(
  logger: CompletedDaemonCommandLogger,
): Promise<void> {
  try {
    await logger.closeAfterFlush();
  } catch (error) {
    logger.warn(
      `Daemon command completed successfully, but logger teardown failed; exiting 0: ${errorMessage(error)}`,
    );
    await logger.flush();
  }
}

/** Exit a daemon command that has already completed successfully. */
export async function exitAfterSuccessfulDaemonCommand(
  logger: CompletedDaemonCommandLogger,
  terminator: DaemonCommandProcessTerminator,
): Promise<void> {
  await closeLoggerAfterCommittedResult(logger);
  terminator.exit(0);
}
