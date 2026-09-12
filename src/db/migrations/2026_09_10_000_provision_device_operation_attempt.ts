import { type Kysely, sql } from "kysely";

// Fence every mutation of a `provision_device_operations` row to the attempt
// that owns it. Without it, `complete()`/`fail()`/`markDeviceCreationStarted()`
// match on `operation_id` alone, so a wedged attempt whose row was legitimately
// reclaimed (expiry sweep, or a retry after a failure) stamps its stale result
// over the replacement attempt's row. Pre-existing rows default to the empty
// token: no live attempt can present it, so their first `begin()` claims them.
export async function up(db: Kysely<unknown>): Promise<void> {
  const existingColumn = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('provision_device_operations')
    WHERE name = 'attempt_id'
  `.execute(db);

  if (existingColumn.rows.length === 0) {
    await db.schema
      .alterTable("provision_device_operations")
      .addColumn("attempt_id", "text", (column) => column.notNull().defaultTo(""))
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("provision_device_operations").dropColumn("attempt_id").execute();
}
