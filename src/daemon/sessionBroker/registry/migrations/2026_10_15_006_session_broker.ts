import { sql, type Kysely } from "kysely";

/**
 * Session-only admission shares the physical assignment/journal database. Reservations and
 * ambiguous native work continue to count after a daemon exits; terminal request receipts
 * survive resource reuse so retrying an old request can never allocate a replacement session.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("session_broker_requests")
    .addColumn("request_id", "text", (column) => column.primaryKey())
    .addColumn("fingerprint", "text", (column) => column.notNull())
    .addColumn("parameters_json", "text", (column) => column.notNull())
    .addColumn("owner_json", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) =>
      column
        .notNull()
        .check(sql`state IN ('acquiring', 'active', 'releasing', 'released', 'failed')`),
    )
    .addColumn("resource_id", "text")
    .addColumn("session_id", "text", (column) => column.unique())
    .addColumn("error", "text")
    .addColumn("error_code", "text")
    .execute();

  await db.schema
    .createTable("session_broker_resources")
    .addColumn("allocation_index", "integer", (column) => column.primaryKey().autoIncrement())
    .addColumn("resource_id", "text", (column) => column.notNull().unique())
    .addColumn("scope_key", "text", (column) => column.notNull())
    .addColumn("profile_json", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) =>
      column
        .notNull()
        .check(
          sql`state IN ('reserved', 'active', 'idle', 'resetting', 'destroying', 'unknown', 'destroyed')`,
        ),
    )
    .addColumn("request_id", "text", (column) =>
      column.references("session_broker_requests.request_id"),
    )
    .addColumn("revision", "integer", (column) => column.notNull().check(sql`revision > 0`))
    .addColumn("idle_order", "integer", (column) => column.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("session_broker_resources").execute();
  await db.schema.dropTable("session_broker_requests").execute();
}
