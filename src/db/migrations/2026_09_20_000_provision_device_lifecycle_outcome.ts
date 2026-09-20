import { type Kysely, sql } from "kysely";

// #7377: persist the latest observable provisioning lifecycle state separately
// from the successful result. A request deadline may detach the caller while
// readiness or cleanup is still settling, so retries need a durable snapshot
// that cannot be mistaken for permission to create a duplicate device.
export async function up(db: Kysely<unknown>): Promise<void> {
  const existingColumn = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('provision_device_operations')
    WHERE name = 'lifecycle_json'
  `.execute(db);

  if (existingColumn.rows.length === 0) {
    await db.schema
      .alterTable("provision_device_operations")
      .addColumn("lifecycle_json", "text")
      .execute();
  }
  await db.schema
    .createTable("provisioned_device_transport_tombstones")
    .ifNotExists()
    .addColumn("device_id", "text", (column) => column.primaryKey())
    .addColumn("stable_id", "text", (column) => column.notNull())
    .addColumn("reason", "text", (column) => column.notNull())
    .addColumn("retired_at_ms", "integer", (column) => column.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("provisioned_device_transport_tombstones").ifExists().execute();
  await db.schema.alterTable("provision_device_operations").dropColumn("lifecycle_json").execute();
}
