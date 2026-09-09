import { type Kysely, sql } from "kysely";

// #6652: without an expiry, `provision_device_operations` never sheds rows, so
// it grows one row per distinct operationId for the life of the database.
// Existing rows predate this column and get `expires_at_ms` defaulted to 0 --
// already-expired -- so the very next `begin()` call's prune sweep
// (`ProvisionDeviceOperationRepository.begin()`) reclaims the pre-existing
// backlog too, not just newly inserted rows.
export async function up(db: Kysely<unknown>): Promise<void> {
  const existingColumn = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('provision_device_operations')
    WHERE name = 'expires_at_ms'
  `.execute(db);

  if (existingColumn.rows.length === 0) {
    await db.schema
      .alterTable("provision_device_operations")
      .addColumn("expires_at_ms", "integer", (column) => column.notNull().defaultTo(0))
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("provision_device_operations").dropColumn("expires_at_ms").execute();
}
