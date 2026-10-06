import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { getDatabase } from "./database";
import type { Database } from "./types";
import { logger } from "../utils/logger";

/**
 * What `device_identity` stores: a digest of the device identity TOGETHER with the
 * lock type and credential it was learned with, not the bare identity. During a
 * mixed-version window an older daemon's upsert rewrites `lock_type` and
 * `lock_credential` but never touches `device_identity`; with a bare identity the
 * surviving tag would vouch for another AVD's PIN after an AVD swap (#10065).
 * Bound to the credential, an old writer's rewrite changes the inputs, the stored
 * digest no longer matches, and the row reads as "nothing recorded". (An old
 * writer storing the SAME credential still matches, which is harmless: that PIN
 * is the one that unlocks.) No migration is needed: the column is unreleased.
 */
function identityBinding(identity: string, lockType: string, credential: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify([identity, lockType, credential]))
    .digest("hex");
}

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

  // Migration gating is owned by startup (ensureMigrations) plus the app dialect
  // first-query gate (waitForMigrationsBeforeQuery, #6703); a repository helper
  // must NOT await ensureMigrations itself. Resolve the injected executor, else
  // the singleton, synchronously.
  private getDb(): Kysely<Database> {
    return this.db ?? getDatabase();
  }

  /**
   * The credential remembered for a device, or null when none is recorded or it
   * was not learned on `identity`. The adb serial alone is reused by different
   * devices (emulator ports), so a row with no recorded identity (written before
   * #10065), or an unknown `identity`, is never replayed (#10065).
   */
  async getCredential(deviceId: string, identity: string | undefined): Promise<string | null> {
    if (identity === undefined) {
      return null;
    }
    const db = await this.getDb();
    const row = await db
      .selectFrom("device_locks")
      .select(["lock_type", "lock_credential", "device_identity"])
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    if (!row?.device_identity) {
      return null;
    }
    const bound = identityBinding(identity, row.lock_type, row.lock_credential ?? null);
    return row.device_identity === bound ? (row.lock_credential ?? null) : null;
  }

  /**
   * Delete whatever is remembered for a serial. Best-effort like
   * {@link rememberLock}; used when the device behind the serial was replaced.
   */
  async forget(deviceId: string): Promise<void> {
    try {
      const db = await this.getDb();
      await db.deleteFrom("device_locks").where("device_id", "=", deviceId).execute();
    } catch (error) {
      logger.warn(`[DeviceLockRepository] Failed to forget lock for device ${deviceId}`, error);
    }
  }

  /**
   * Remember how to unlock a device, upserting by `device_id`. Best-effort: a
   * failure is logged and swallowed so it never fails the unlock the caller
   * actually asked for.
   */
  async rememberLock(
    deviceId: string,
    lockType: string,
    credential: string | null,
    identity: string | undefined,
  ): Promise<void> {
    try {
      const db = await this.getDb();
      // Use SQLite datetime('now') on both write paths so updated_at has one
      // canonical format matching the column default (and still refreshes on
      // update, which a bare column default would not do).
      const now = sql<string>`(datetime('now'))`;
      const binding =
        identity === undefined ? null : identityBinding(identity, lockType, credential);
      await db
        .insertInto("device_locks")
        .values({
          device_id: deviceId,
          lock_type: lockType,
          lock_credential: credential,
          device_identity: binding,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.column("device_id").doUpdateSet({
            lock_type: lockType,
            lock_credential: credential,
            device_identity: binding,
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
