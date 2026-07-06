/**
 * The two database-bringup steps that must run — in this exact order — at the
 * very front of {@link import("./daemon").Daemon.start}: publish the daemon's
 * owned DB path in the PID file, THEN open and migrate the shared SQLite DB.
 *
 * They live behind this interface so the ordering can be asserted directly with
 * fakes — no real PID-file write, no real DB, and none of `start()`'s process
 * side effects (lifecycle handlers, `process.chdir`) — per the #2871 stretch AC.
 */
export interface StartupPrologueSteps {
  /**
   * Publish this daemon's resolved DB path in the PID file BEFORE the DB is
   * opened, so the direct-mode ownership guard can distinguish a same-file
   * collision from an isolated-path launch during startup. Issue #2871.
   */
  writeEarlyOwnerRecord(): Promise<void>;
  /** Open the shared SQLite DB and await startup migrations. */
  initializeDatabase(): Promise<void>;
}

/**
 * Run the startup DB-bringup prologue in the fixed order the direct-mode
 * ownership guard depends on: the early owner record (which records `dbPath`)
 * MUST be persisted before {@link StartupPrologueSteps.initializeDatabase} opens
 * the DB. Otherwise a concurrent direct-mode launch could observe a live daemon
 * with an unknown owned path during the multi-second startup window and fail
 * closed even against an isolated `AUTOMOBILE_DB_PATH`. Issue #2871.
 */
export async function runStartupPrologue(steps: StartupPrologueSteps): Promise<void> {
  await steps.writeEarlyOwnerRecord();
  await steps.initializeDatabase();
}
