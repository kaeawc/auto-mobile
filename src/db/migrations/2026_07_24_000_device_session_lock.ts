import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * Remember how to unlock a device across a session (issue #4360).
 *
 * `lock_type` records the keyguard kind AutoMobile last observed
 * (`swipe`/`pin`/`password`/`pattern`/`none`); `lock_credential` records the
 * credential that unlocked a secure device so the boot path can re-unlock it
 * without asking again. The credential is stored as-is in the local
 * `~/.auto-mobile` DB — a single-user, on-disk automation store — so a locked
 * dev device does not have to be unlocked by hand every session.
 */
async function columnExists(db: Kysely<unknown>, tableName: string, columnName: string): Promise<boolean> {
  const result = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info(${tableName}) WHERE name = ${columnName}
  `.execute(db);
  return result.rows.length > 0;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await columnExists(db, "device_sessions", "lock_type"))) {
    await db.schema
      .alterTable("device_sessions")
      .addColumn("lock_type", "text")
      .execute();
  }
  if (!(await columnExists(db, "device_sessions", "lock_credential"))) {
    await db.schema
      .alterTable("device_sessions")
      .addColumn("lock_credential", "text")
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("device_sessions").dropColumn("lock_credential").execute();
  await db.schema.alterTable("device_sessions").dropColumn("lock_type").execute();
}
