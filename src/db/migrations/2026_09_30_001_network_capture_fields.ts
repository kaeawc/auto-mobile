import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const [column, type] of [
    ["request_id", "text"],
    ["connection_id", "text"],
    ["direction", "text"],
    ["metadata_json", "text"],
    ["sequence_number", "integer"],
  ] as const) {
    const existing = await sql<{ name: string }>`
      SELECT name FROM pragma_table_info('network_events') WHERE name = ${column}
    `.execute(db);
    if (existing.rows.length === 0) {
      await db.schema.alterTable("network_events").addColumn(column, type).execute();
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const column of [
    "sequence_number",
    "metadata_json",
    "direction",
    "connection_id",
    "request_id",
  ] as const) {
    await db.schema.alterTable("network_events").dropColumn(column).execute();
  }
}
