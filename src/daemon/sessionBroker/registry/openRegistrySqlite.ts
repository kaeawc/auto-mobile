import { SQLITE_BUSY_TIMEOUT_MS } from "../../../db/database";

/**
 * bun:sqlite waits for a busy lock synchronously, blocking this daemon's event loop (heartbeat
 * lease handling included). A busy write waits one nominal 250ms busy_timeout, with no dialect retry or
 * backoff. Opening a migrated WAL registry uses reads only and never waits for a peer writer.
 * An open that must migrate can wait one timeout at BEGIN IMMEDIATE (or the first initialization
 * PRAGMA/bookkeeping write for a new file); failure closes without further lock waits. Close skips
 * optimize/checkpoint maintenance and adds no busy_timeout wait. SQLite's sleep granularity plus
 * statement, filesystem and error-handling overhead mean these are not hard wall-clock deadlines;
 * waiting for another opener's migration file lock yields asynchronously. A healthy
 * peer's few short statements and FULL-sync commit (one fsync) have room to finish, while a slow
 * disk or prolonged lock yields a retryable refusal after one short wait, matching the app DB's
 * per-attempt timeout. Callers retry after yielding the event loop. Two connections in
 * one process cannot release each other's lock during this synchronous wait; waiting longer only
 * stalls them. A single uncontended connection never waits. Keep transactions short (#12104).
 */
export const BINDING_REGISTRY_BUSY_TIMEOUT_MS = Math.min(250, SQLITE_BUSY_TIMEOUT_MS);

/** The slice of a bun:sqlite handle this module touches before handing it to the dialect. */
interface RegistrySqliteHandle {
  exec(sql: string): void;
  close(): void;
}

export function openRegistrySqlite(dbPath: string): RegistrySqliteHandle {
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
  const sqliteDb = new RegistryDatabase(dbPath);
  try {
    sqliteDb.exec(`PRAGMA busy_timeout = ${BINDING_REGISTRY_BUSY_TIMEOUT_MS};`);
    sqliteDb.exec("PRAGMA journal_mode = WAL;");
    // Assignment authority must survive power loss; writes are rare, so pay for the fsync.
    sqliteDb.exec("PRAGMA synchronous = FULL;");
    sqliteDb.exec("PRAGMA foreign_keys = ON;");
  } catch (error) {
    sqliteDb.close();
    throw error;
  }
  return sqliteDb;
}
