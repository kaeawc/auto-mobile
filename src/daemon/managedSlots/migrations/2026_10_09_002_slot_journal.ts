import { sql, type Kysely } from "kysely";

// #11179: journal of managed-slot work (create / replace / release) with the exact devices each
// entry acts on, so a restarted daemon can redrive accepted, unfinished work to convergence.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("slot_journal")
    .ifNotExists()
    .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
    .addColumn("scope_key", "text", (column) =>
      column.notNull().references("slot_scopes.scope_key"),
    )
    .addColumn("slot_index", "integer", (column) => column.notNull().check(sql`slot_index >= 0`))
    .addColumn("kind", "text", (column) =>
      column.notNull().check(sql`kind IN ('create', 'replace', 'release')`),
    )
    .addColumn("phase", "text", (column) =>
      column
        .notNull()
        .check(
          sql`phase IN ('intent', 'deleting', 'deleted', 'creating', 'created', 'committed', 'rolled_back')`,
        ),
    )
    .addColumn("platform", "text", (column) =>
      column.notNull().check(sql`platform IN ('android', 'ios')`),
    )
    .addColumn("from_generation", "integer", (column) => column.notNull())
    .addColumn("to_generation", "integer")
    .addColumn("binding_generation", "integer", (column) => column.notNull())
    .addColumn("binding_stable_device_id", "text")
    .addColumn("target_json", "text", (column) => column.notNull())
    .addColumn("owner_daemon_id", "text", (column) => column.notNull())
    .addColumn("owner_pid", "integer", (column) => column.notNull())
    .addColumn("owner_process_token", "text")
    .addColumn("attempts", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("last_error", "text")
    .addColumn("next_attempt_at_ms", "integer", (column) => column.notNull())
    .addColumn("created_at_ms", "integer", (column) => column.notNull())
    .addColumn("updated_at_ms", "integer", (column) => column.notNull())
    .execute();

  // At most one unfinished entry per slot.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS slot_journal_open_slot
    ON slot_journal (scope_key, slot_index)
    WHERE phase NOT IN ('committed', 'rolled_back')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS slot_journal_open_slot`.execute(db);
  await db.schema.dropTable("slot_journal").ifExists().execute();
}
