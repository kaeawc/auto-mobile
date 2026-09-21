import { errorMessage } from "../utils/describeUnknownError";

/** Minimal logger contract for the completed daemon-command executable boundary. */
export interface CompletedDaemonCommandLogger {
  closeAfterFlush(): Promise<void>;
  warn(message: string): void;
}

/** Injectable process boundary keeps the shutdown outcome unit-testable. */
export interface DaemonCommandProcessTerminator {
  exit(exitCode: number): void;
}

/**
 * Exit a daemon command that has already completed successfully.
 *
 * A late write from detached best-effort startup work can make logger teardown
 * reject after the command has committed. That teardown error must be visible,
 * but cannot turn the command result into a failure.
 */
export async function exitAfterSuccessfulDaemonCommand(
  logger: CompletedDaemonCommandLogger,
  terminator: DaemonCommandProcessTerminator,
): Promise<void> {
  try {
    await logger.closeAfterFlush();
  } catch (error) {
    logger.warn(
      `Daemon command completed successfully, but logger teardown failed; exiting 0: ${errorMessage(error)}`,
    );
  }
  terminator.exit(0);
}
