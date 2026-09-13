import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database, InstalledApp as DbInstalledApp, NewInstalledApp } from "./types";

export interface InstalledAppsStore {
  getCacheVerifiedAt(deviceId: string): Promise<number | null>;
  getProfileCacheVerifiedAt(deviceId: string, userId: number): Promise<number | null>;
  listInstalledApps(deviceId: string): Promise<DbInstalledApp[]>;
  replaceInstalledApps(deviceId: string, apps: NewInstalledApp[]): Promise<void>;
  upsertInstalledApp(
    deviceId: string,
    userId: number,
    packageName: string,
    isSystem: boolean,
    timestampMs: number,
  ): Promise<void>;
  removeInstalledApp(deviceId: string, userId: number, packageName: string): Promise<void>;
  removeInstalledAppForDevice(deviceId: string, packageName: string): Promise<void>;
  markDeviceStale(deviceId: string): Promise<void>;
  markProfileStale(deviceId: string, userId: number): Promise<void>;
  touchDevice(deviceId: string, timestampMs: number): Promise<void>;
  clearDeviceSession(deviceId: string): Promise<void>;
  clearOldDaemonSessions(currentDaemonSessionId: string): Promise<void>;
  setSessionTracking(
    daemonSessionId: string,
    deviceId: string,
    deviceSessionStart: number,
  ): Promise<void>;
}

export class InstalledAppsRepository implements InstalledAppsStore {
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
   * Point in time from which the device's WHOLE cached row set is known
   * verified, i.e. the MINIMUM `last_verified_at` across its rows.
   *
   * A full rebuild (`replaceInstalledApps`) stamps every row with the same
   * timestamp, so min == max there. Single-row writes do not: `upsertInstalledApp`
   * is driven by CtrlProxy package broadcasts and touches exactly one
   * (device, user, package) row. Taking the MAXIMUM would let one such write
   * make an otherwise hours-old row set look freshly verified, so its TTL
   * would be extended and stale rows served (issue #6639). The minimum is the
   * only aggregate that describes the row set a cache read actually returns.
   */
  async getCacheVerifiedAt(deviceId: string): Promise<number | null> {
    const db = await this.getDb();
    const row = await db
      .selectFrom("installed_apps")
      .select(db.fn.min<number>("last_verified_at").as("last_verified_at"))
      .where("device_id", "=", deviceId)
      .executeTakeFirst();

    if (!row || row.last_verified_at === null || row.last_verified_at === undefined) {
      return null;
    }

    return Number(row.last_verified_at);
  }

  /** Per-profile counterpart of {@link getCacheVerifiedAt} (same MIN semantics). */
  async getProfileCacheVerifiedAt(deviceId: string, userId: number): Promise<number | null> {
    const db = await this.getDb();
    const row = await db
      .selectFrom("installed_apps")
      .select(db.fn.min<number>("last_verified_at").as("last_verified_at"))
      .where("device_id", "=", deviceId)
      .where("user_id", "=", userId)
      .executeTakeFirst();

    if (!row || row.last_verified_at === null || row.last_verified_at === undefined) {
      return null;
    }

    return Number(row.last_verified_at);
  }

  async listInstalledApps(deviceId: string): Promise<DbInstalledApp[]> {
    const db = await this.getDb();
    return db.selectFrom("installed_apps").selectAll().where("device_id", "=", deviceId).execute();
  }

  async replaceInstalledApps(deviceId: string, apps: NewInstalledApp[]): Promise<void> {
    const db = await this.getDb();
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom("installed_apps").where("device_id", "=", deviceId).execute();

      if (apps.length > 0) {
        await trx.insertInto("installed_apps").values(apps).execute();
      }
    });
  }

  /**
   * Patches a single (device, user, package) row from a CtrlProxy package
   * broadcast. This verifies only the row it touches — device-wide freshness
   * is read with {@link getCacheVerifiedAt}, which is deliberately a MINIMUM so
   * this write cannot vouch for rows it never looked at (issue #6639).
   */
  async upsertInstalledApp(
    deviceId: string,
    userId: number,
    packageName: string,
    isSystem: boolean,
    timestampMs: number,
  ): Promise<void> {
    const db = await this.getDb();
    const row: NewInstalledApp = {
      device_id: deviceId,
      user_id: userId,
      package_name: packageName,
      is_system: isSystem ? 1 : 0,
      installed_at: timestampMs,
      last_verified_at: timestampMs,
    };

    await db
      .insertInto("installed_apps")
      .values(row)
      .onConflict((oc) =>
        oc.columns(["device_id", "user_id", "package_name"]).doUpdateSet({
          is_system: row.is_system,
          last_verified_at: row.last_verified_at,
        }),
      )
      .execute();
  }

  async removeInstalledApp(deviceId: string, userId: number, packageName: string): Promise<void> {
    const db = await this.getDb();
    await db
      .deleteFrom("installed_apps")
      .where("device_id", "=", deviceId)
      .where("user_id", "=", userId)
      .where("package_name", "=", packageName)
      .execute();
  }

  async removeInstalledAppForDevice(deviceId: string, packageName: string): Promise<void> {
    const db = await this.getDb();
    await db
      .deleteFrom("installed_apps")
      .where("device_id", "=", deviceId)
      .where("package_name", "=", packageName)
      .execute();
  }

  async markDeviceStale(deviceId: string): Promise<void> {
    const db = await this.getDb();
    await db
      .updateTable("installed_apps")
      .set({ last_verified_at: 0 })
      .where("device_id", "=", deviceId)
      .execute();
  }

  async markProfileStale(deviceId: string, userId: number): Promise<void> {
    const db = await this.getDb();
    await db
      .updateTable("installed_apps")
      .set({ last_verified_at: 0 })
      .where("device_id", "=", deviceId)
      .where("user_id", "=", userId)
      .execute();
  }

  async touchDevice(deviceId: string, timestampMs: number): Promise<void> {
    const db = await this.getDb();
    await db
      .updateTable("installed_apps")
      .set({ last_verified_at: timestampMs })
      .where("device_id", "=", deviceId)
      .execute();
  }

  async clearDeviceSession(deviceId: string): Promise<void> {
    const db = await this.getDb();
    await db.deleteFrom("installed_apps").where("device_id", "=", deviceId).execute();
  }

  async clearOldDaemonSessions(currentDaemonSessionId: string): Promise<void> {
    const db = await this.getDb();
    await db
      .deleteFrom("installed_apps")
      .where("daemon_session_id", "is not", null)
      .where("daemon_session_id", "!=", currentDaemonSessionId)
      .execute();
  }

  async setSessionTracking(
    daemonSessionId: string,
    deviceId: string,
    deviceSessionStart: number,
  ): Promise<void> {
    const db = await this.getDb();
    await db
      .updateTable("installed_apps")
      .set({
        daemon_session_id: daemonSessionId,
        device_session_start: deviceSessionStart,
      })
      .where("device_id", "=", deviceId)
      .where("daemon_session_id", "is", null)
      .execute();
  }
}
