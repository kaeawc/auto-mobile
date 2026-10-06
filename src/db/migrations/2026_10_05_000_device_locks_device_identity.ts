import { type Kysely, sql } from "kysely";

/**
 * Tag each remembered credential with the stable device identity it was learned
 * on (issue #10065).
 *
 * `device_locks` is keyed by adb serial, and emulator serials are port-based, so
 * a different AVD on the same port inherited the previous device's PIN. The new
 * nullable column holds a digest binding the AVD name (or serial for
 * non-emulators) to the credential it was learned with, so an older daemon's
 * upsert (which rewrites the credential but not this column) invalidates the tag;
 * a credential is replayed only when the digest matches. Existing rows keep
 * `NULL`: their provenance
 * is unknown, so they are never replayed and the next successful `pin` unlock
 * re-records them with an identity.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const existingColumn = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('device_locks') WHERE name = 'device_identity'
  `.execute(db);
  if (existingColumn.rows.length === 0) {
    await db.schema.alterTable("device_locks").addColumn("device_identity", "text").execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("device_locks").dropColumn("device_identity").execute();
}
