import { type Kysely, sql } from "kysely";

/**
 * Remember how to unlock a device, keyed by device (issue #4360).
 *
 * A dedicated table rather than columns on `device_sessions`: a session row only
 * exists when device-pool autolock is enabled, and never during boot (which runs
 * before any session), so session-scoped storage cannot deliver
 * remember-then-reuse in the default config or at boot. `lock_credential` is
 * stored as-is in the local `~/.auto-mobile` DB — a single-user, on-disk
 * automation store — so a locked dev device does not have to be unlocked by hand
 * every session.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("device_locks")
    .ifNotExists()
    .addColumn("device_id", "text", (col) => col.primaryKey())
    .addColumn("lock_type", "text", (col) => col.notNull())
    .addColumn("lock_credential", "text")
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("device_locks").execute();
}
