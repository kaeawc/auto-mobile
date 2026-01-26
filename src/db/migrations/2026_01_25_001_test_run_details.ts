import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add error_message column to test_executions for storing failure details
  await db.schema
    .alterTable("test_executions")
    .addColumn("error_message", "text")
    .execute();

  // Add video_path for test recordings
  await db.schema
    .alterTable("test_executions")
    .addColumn("video_path", "text")
    .execute();

  // Add snapshot_path for test snapshots
  await db.schema
    .alterTable("test_executions")
    .addColumn("snapshot_path", "text")
    .execute();

  // Create test_execution_steps table for step-level data
  await db.schema
    .createTable("test_execution_steps")
    .addColumn("id", "integer", col => col.primaryKey().autoIncrement())
    .addColumn("execution_id", "integer", col =>
      col.notNull().references("test_executions.id").onDelete("cascade")
    )
    .addColumn("step_index", "integer", col => col.notNull())
    .addColumn("action", "text", col => col.notNull()) // Tool name or action type
    .addColumn("target", "text") // Element target description
    .addColumn("status", "text", col => col.notNull()) // completed, failed, skipped
    .addColumn("duration_ms", "integer", col => col.notNull())
    .addColumn("screen_name", "text") // Screen name when step was executed
    .addColumn("screenshot_path", "text") // Screenshot captured for this step
    .addColumn("error_message", "text") // Error message if step failed
    .addColumn("details_json", "text") // Additional step details as JSON
    .addColumn("created_at", "text", col =>
      col.notNull().defaultTo("datetime('now')")
    )
    .execute();

  await db.schema
    .createIndex("idx_test_execution_steps_execution")
    .on("test_execution_steps")
    .column("execution_id")
    .execute();

  // Create test_execution_screens table for screens visited during test
  await db.schema
    .createTable("test_execution_screens")
    .addColumn("id", "integer", col => col.primaryKey().autoIncrement())
    .addColumn("execution_id", "integer", col =>
      col.notNull().references("test_executions.id").onDelete("cascade")
    )
    .addColumn("screen_name", "text", col => col.notNull())
    .addColumn("visit_order", "integer", col => col.notNull())
    .addColumn("timestamp", "integer", col => col.notNull())
    .addColumn("created_at", "text", col =>
      col.notNull().defaultTo("datetime('now')")
    )
    .execute();

  await db.schema
    .createIndex("idx_test_execution_screens_execution")
    .on("test_execution_screens")
    .column("execution_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("test_execution_screens").execute();
  await db.schema.dropTable("test_execution_steps").execute();

  // Note: SQLite doesn't support DROP COLUMN, so we can't remove the added columns
  // In production, would need to recreate the table without these columns
}
