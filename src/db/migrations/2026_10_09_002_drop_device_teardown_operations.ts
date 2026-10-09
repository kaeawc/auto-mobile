import { type Kysely, sql } from "kysely";

// #11097: deleteDevice no longer takes an operationId, so the durable
// replay/idempotency rows keyed by it have no reader. Safe teardown comes from
// the lifecycle lease and the ownership re-check under the assignment mutex.
// Forward-only: the earlier migrations that created and extended this table
// stay untouched.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("device_teardown_operations").ifExists().execute();
}

// Recreates the final pre-#11097 shape (2026_08_22_003 plus the owner_token
// column from 2026_08_23_000) so a rollback leaves the schema the earlier
// `down` migrations expect.
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("device_teardown_operations")
    .ifNotExists()
    .addColumn("operation_id", "text", (column) => column.primaryKey())
    .addColumn("request_fingerprint", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("result_json", "text")
    .addColumn("expires_at_ms", "integer", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("updated_at", "text", (column) => column.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("owner_token", "text", (column) => column.notNull().defaultTo(sql`''`))
    .execute();
}
