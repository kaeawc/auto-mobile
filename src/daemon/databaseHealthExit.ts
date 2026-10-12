export interface DatabaseHealthExitDeps {
  now(): number;
  /** Synchronous last-resort diagnostic; production passes writeEmergencyLog. */
  writeEmergency(message: string): void;
  /** Removes this daemon's pid and socket files. */
  cleanupDaemonFiles(): void;
  /** Bounded flush-and-close of the async logger. */
  closeLogger(): Promise<void>;
  exit(code: number): void;
}

/** Text of the diagnostic, exported so the test pins it. */
export function databaseHealthExitMessage(
  code: number,
  detail: string | undefined,
  atMs: number,
): string {
  const reason = `${new Date(atMs).toISOString()} [ERROR] [Daemon] exiting with code ${code}: database health check failed repeatedly`;
  return detail === undefined
    ? reason
    : `${reason}; last failure: ${detail.replace(/[\r\n]/g, " ")}`;
}

export async function exitAfterDatabaseHealthFailure(
  code: number,
  detail: string | undefined,
  deps: DatabaseHealthExitDeps,
): Promise<void> {
  try {
    deps.writeEmergency(databaseHealthExitMessage(code, detail, deps.now()));
  } catch (error) {
    // Emergency writes are the last-resort sink; the async logger may be stalled, so nothing else can report this failure.
    void error;
  }
  deps.cleanupDaemonFiles();
  try {
    await deps.closeLogger();
  } finally {
    deps.exit(code);
  }
}
