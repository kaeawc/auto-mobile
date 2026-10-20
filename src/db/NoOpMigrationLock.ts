import { type MigrationLock } from "./migrationLock";

/**
 * No-op lock for the single-opener default and in-memory test databases, where
 * no second process can share the connection. Keeps the migrator's DB-path-
 * agnostic callers unchanged.
 *
 * NOTE: this default provides NO cross-process protection — it is correct only
 * for `:memory:` DBs and the single-daemon path (already serialized by the
 * in-process mutex). Production DB openers must pass a {@link FileMigrationLock}
 * via {@link createFileMigrationLock}; `database.ts#startMigrations` does so.
 */
export class NoOpMigrationLock implements MigrationLock {
  async acquire(): Promise<void> {
    // Nothing to serialize.
  }

  async release(): Promise<void> {
    // No lock file to remove.
  }
}
