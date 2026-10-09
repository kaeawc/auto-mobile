import { type Kysely, sql } from "kysely";

// #11065: provisionDevice no longer takes an operationId, so the durable
// replay/idempotency rows keyed by it have no reader. Concurrent provisions of
// the same exact device are serialized by the in-process lifecycle lease and
// ownership refusals instead. Forward-only: the earlier migrations that created
// and extended this table stay untouched.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("provision_device_operations").ifExists().execute();
}

// Recreates the final pre-#11065 shape (2026_08_22_000 plus the expiry,
// attempt-fence and lifecycle columns) so a rollback leaves the schema the
// earlier `down` migrations expect.
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("provision_device_operations")
    .ifNotExists()
    .addColumn("operation_id", "text", (column) => column.primaryKey())
    .addColumn("request_fingerprint", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("result_json", "text")
    .addColumn("error_code", "text")
    .addColumn("error_message", "text")
    .addColumn("creation_started", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("created_at", "text", (column) => column.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("updated_at", "text", (column) => column.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("expires_at_ms", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("attempt_id", "text", (column) => column.notNull().defaultTo(""))
    .addColumn("lifecycle_json", "text")
    .execute();
}
