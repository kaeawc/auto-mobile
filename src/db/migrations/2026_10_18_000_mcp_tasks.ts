import type { Kysely } from "kysely";

// #4668: durable MCP Tasks extension state. A task belongs to the session key that
// created it; rows outlive a daemon restart so a restarted daemon can still answer
// tasks/get, and a row a previous daemon instance left `working` is failed on recovery.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("mcp_tasks")
    .ifNotExists()
    .addColumn("task_id", "text", (column) => column.primaryKey())
    .addColumn("owner_key", "text", (column) => column.notNull())
    .addColumn("tool_name", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("status_message", "text")
    .addColumn("instance_id", "text", (column) => column.notNull())
    .addColumn("poll_interval_ms", "integer", (column) => column.notNull())
    .addColumn("retention_ms", "integer", (column) => column.notNull())
    .addColumn("created_at_ms", "integer", (column) => column.notNull())
    .addColumn("last_updated_at_ms", "integer", (column) => column.notNull())
    .addColumn("terminal_at_ms", "integer")
    .addColumn("expires_at_ms", "integer")
    .addColumn("input_requests_json", "text")
    .addColumn("result_json", "text")
    .addColumn("error_json", "text")
    .execute();
  await db.schema
    .createIndex("idx_mcp_tasks_expires_at")
    .ifNotExists()
    .on("mcp_tasks")
    .column("expires_at_ms")
    .execute();
  await db.schema
    .createIndex("idx_mcp_tasks_status_instance")
    .ifNotExists()
    .on("mcp_tasks")
    .columns(["status", "instance_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("mcp_tasks").ifExists().execute();
}
