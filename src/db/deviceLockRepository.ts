import { type Kysely, sql } from "kysely";
import { ensureMigrations, getDatabase } from "./database";
import type { Database } from "./types";
import { logger } from "../utils/logger";

/**
 * Persists how to unlock a device, keyed by `device_id` (issue #4360).
 *
 * Backs `wakeAndUnlock`'s learn-then-reuse of a credential. Device-keyed (not
 * session-keyed) so it works regardless of device-pool autolock and during boot,
 * neither of which has a `device_sessions` row. The credential is stored
 * plaintext in the local single-user DB.
 */
export class DeviceLockRepository {
  private db: Kysely<Database> | null;

  constructor(db?: Kysely<Database>) {
    this.db = db ?? null;
  }

  private async getDb(): Promise<Kysely<Database>> {
    if (this.db) {
      return this.db;
    }
    await ensureMigrations();
    return getDatabase();
  }

  /** The credential remembered for a device, or null when none is recorded. */
  async getCredential(deviceId: string): Promise<string | null> {
    const db = await this.getDb();
    const row = await db
      .selectFrom("device_locks")
      .select(["lock_credential"])
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    return row?.lock_credential ?? null;
  }

  /**
   * Remember how to unlock a device, upserting by `device_id`. Best-effort: a
   * failure is logged and swallowed so it never fails the unlock the caller
   * actually asked for.
   */
  async rememberLock(deviceId: string, lockType: string, credential: string | null): Promise<void> {
    try {
      const db = await this.getDb();
      // Use SQLite datetime('now') on both write paths so updated_at has one
      // canonical format matching the column default (and still refreshes on
      // update, which a bare column default would not do).
      const now = sql<string>`(datetime('now'))`;
      await db
        .insertInto("device_locks")
        .values({
          device_id: deviceId,
          lock_type: lockType,
          lock_credential: credential,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.column("device_id").doUpdateSet({
            lock_type: lockType,
            lock_credential: credential,
            updated_at: now,
          }),
        )
        .execute();
    } catch (error) {
      logger.warn(
        `[DeviceLockRepository] Failed to remember lock for device ${deviceId}: ${error}`,
      );
    }
  }
}
