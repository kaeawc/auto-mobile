import type { Kysely } from "kysely";

/** Opt-in identity links pin the authoritative request receipt until acknowledgement or expiry. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("session_broker_exports")
    .addColumn("prepare_id", "text", (column) => column.primaryKey())
    .addColumn("request_id", "text", (column) =>
      column.notNull().unique().references("session_broker_requests.request_id"),
    )
    .addColumn("request_digest", "text", (column) => column.notNull())
    .addColumn("created_at_ms", "integer", (column) => column.notNull())
    .addColumn("acknowledged_at_ms", "integer")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("session_broker_exports").execute();
}
