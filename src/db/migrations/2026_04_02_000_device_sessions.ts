import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("device_sessions")
    .ifNotExists()
    .addColumn("session_uuid", "text", (col) => col.primaryKey())
    .addColumn("device_id", "text", (col) => col.notNull())
    .addColumn("platform", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("source", "text")
    .addColumn("autolock_enabled", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("mcp_session_id", "text")
    .addColumn("daemon_session_id", "text")
    .addColumn("created_at_ms", "integer", (col) => col.notNull())
    .addColumn("last_used_at_ms", "integer", (col) => col.notNull())
    .addColumn("expires_at_ms", "integer", (col) => col.notNull())
    .addColumn("released_at_ms", "integer")
    .addColumn("release_reason", "text")
    .addColumn("session_timeout_ms", "integer", (col) => col.notNull())
    .addColumn("heartbeat_timeout_ms", "integer", (col) => col.notNull())
    .addColumn("has_received_heartbeat", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_device_sessions_device_id")
    .ifNotExists()
    .on("device_sessions")
    .column("device_id")
    .execute();

  await db.schema
    .createIndex("idx_device_sessions_status")
    .ifNotExists()
    .on("device_sessions")
    .column("status")
    .execute();

  await db.schema
    .createIndex("idx_device_sessions_mcp_session")
    .ifNotExists()
    .on("device_sessions")
    .column("mcp_session_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("device_sessions").execute();
}
