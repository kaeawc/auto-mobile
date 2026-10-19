import type { BunSqliteHandle } from "../../../db/bunSqliteDialect";

/** The handle this module opens and hands to the dialect. */
type RegistrySqliteHandle = BunSqliteHandle;

export function createRegistryDatabase(dbPath: string): RegistrySqliteHandle {
  // Resolved lazily, like database.ts, so importing this module never requires the Bun runtime.
  const { Database } = require("bun:sqlite") as {
    Database: new (path: string) => RegistrySqliteHandle;
  };
  // The shared driver still finalizes statements, rejects queued work and closes the handle.
  // Only this registry handle skips its close-time maintenance: both PRAGMAs can each wait a
  // fresh busy_timeout behind a peer writer, even after a failed open. SQLite's automatic WAL
  // checkpoints and durable FULL-sync commits suffice; explicit shutdown truncation is optional.
  class RegistryDatabase extends Database {
    override exec(sql: string): void {
      if (sql === "PRAGMA optimize;" || sql === "PRAGMA wal_checkpoint(TRUNCATE);") {
        return;
      }
      super.exec(sql);
    }
  }
  return new RegistryDatabase(dbPath);
}
