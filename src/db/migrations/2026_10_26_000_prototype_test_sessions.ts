import type { Kysely } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema
    .createTable("prototype_test_sessions")
    .ifNotExists()
    .addColumn("test_session_id", "text", (c) => c.primaryKey())
    .addColumn("prototype_id", "text", (c) => c.notNull())
    .addColumn("device_id", "text", (c) => c.notNull())
    .addColumn("session_uuid", "text")
    .addColumn("cohort", "text")
    .addColumn("goal", "text")
    .addColumn("start_screen", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("started_at_ms", "integer", (c) => c.notNull())
    .addColumn("ended_at_ms", "integer")
    .addColumn("ended_reason", "text")
    .addColumn("dropped_count", "integer", (c) => c.notNull().defaultTo(0))
    .execute();
  await db.schema
    .createTable("prototype_test_session_steps")
    .ifNotExists()
    .addColumn("test_session_id", "text", (c) =>
      c.notNull().references("prototype_test_sessions.test_session_id").onDelete("cascade"),
    )
    .addColumn("seq", "integer", (c) => c.notNull())
    .addColumn("event_sequence", "integer", (c) => c.notNull())
    .addColumn("at_ms", "integer", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("name", "text")
    .addColumn("screen", "text", (c) => c.notNull())
    .addColumn("detail_json", "text", (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("idx_prototype_test_session_steps_seq")
    .ifNotExists()
    .on("prototype_test_session_steps")
    .columns(["test_session_id", "seq"])
    .unique()
    .execute();
  await db.schema
    .createIndex("idx_prototype_test_sessions_active")
    .ifNotExists()
    .on("prototype_test_sessions")
    .columns(["device_id", "prototype_id", "status"])
    .execute();
}
export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.dropTable("prototype_test_session_steps").ifExists().execute();
  await db.schema.dropTable("prototype_test_sessions").ifExists().execute();
}
