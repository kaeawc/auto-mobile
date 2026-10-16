import { sql, type Kysely } from "kysely";

/** Free-pool deletion is journaled on its exact row before native deletion. */
const COLUMNS = {
  deletion_owner_daemon_id: "text",
  deletion_owner_pid: "integer",
  deletion_owner_process_token: "text",
  deletion_started_at_ms: "integer",
  deletion_attempts: "integer",
  deletion_last_error: "text",
  deletion_next_attempt_at_ms: "integer",
} as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const [name, type] of Object.entries(COLUMNS)) {
    await sql`ALTER TABLE slot_free_devices ADD COLUMN ${sql.id(name)} ${sql.raw(type)}`.execute(
      db,
    );
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const name of Object.keys(COLUMNS).reverse()) {
    await sql`ALTER TABLE slot_free_devices DROP COLUMN ${sql.id(name)}`.execute(db);
  }
}
