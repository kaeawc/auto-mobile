import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("device_mutation_journal")
    .addColumn("sequence", "integer", (column) => column.primaryKey().autoIncrement())
    .addColumn("session_uuid", "text", (column) => column.notNull())
    .addColumn("device_id", "text", (column) => column.notNull())
    .addColumn("incarnation", "text", (column) => column.notNull())
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("mutation_key", "text", (column) => column.notNull())
    .addColumn("prior_value_json", "text", (column) => column.notNull())
    .addColumn("applied_at_ms", "integer", (column) => column.notNull())
    .addColumn("tool_name", "text", (column) => column.notNull())
    .addUniqueConstraint("device_mutation_original", [
      "session_uuid",
      "device_id",
      "incarnation",
      "kind",
      "mutation_key",
    ])
    .addCheckConstraint(
      "device_mutation_scope_nonempty",
      sql`
      length(trim(session_uuid)) > 0 AND length(trim(device_id)) > 0
      AND length(trim(incarnation)) > 0 AND length(trim(kind)) > 0
      AND length(trim(mutation_key)) > 0 AND length(trim(tool_name)) > 0
    `,
    )
    .execute();
  await db.schema
    .createTable("device_mutation_baselines")
    .addColumn("device_id", "text", (column) => column.notNull())
    .addColumn("incarnation", "text", (column) => column.notNull())
    .addColumn("baseline_json", "text", (column) => column.notNull())
    .addColumn("captured_at_ms", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("device_mutation_baseline_identity", ["device_id", "incarnation"])
    .addCheckConstraint(
      "device_mutation_baseline_nonempty",
      sql`
      length(trim(device_id)) > 0 AND length(trim(incarnation)) > 0
    `,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("device_mutation_baselines").ifExists().execute();
  await db.schema.dropTable("device_mutation_journal").ifExists().execute();
}
