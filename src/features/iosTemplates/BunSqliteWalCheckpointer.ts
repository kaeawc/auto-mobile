import type { SqliteWalCheckpointer } from "./SimulatorCloneRelocator";

/** The slice of `bun:sqlite` a checkpoint needs. */
interface CheckpointDatabase {
  exec(sql: string): void;
  close(): void;
}
type CheckpointDatabaseConstructor = new (
  path: string,
  options: { create: boolean },
) => CheckpointDatabase;

/**
 * Checkpoints through `bun:sqlite`, which never invokes the `sqlite3` CLI that the simulator TCC
 * boundary reserves for `SimulatorTccSqliteClient`. The clone is shut down, so a lock held by
 * another process is a failure to report, not something to wait out.
 */
export class BunSqliteWalCheckpointer implements SqliteWalCheckpointer {
  async checkpoint(databasePath: string): Promise<void> {
    // Resolved lazily, like database.ts, so importing this module never requires the Bun runtime.
    const { Database } = require("bun:sqlite") as { Database: CheckpointDatabaseConstructor };
    const database = new Database(databasePath, { create: false });
    try {
      database.exec("PRAGMA busy_timeout = 0;");
      database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      database.close();
    }
  }
}
