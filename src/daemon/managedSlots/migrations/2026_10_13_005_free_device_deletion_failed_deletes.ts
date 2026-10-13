import { sql, type Kysely } from "kysely";

/** Separate native delete failures from blocked free-pool redrives. NULL legacy values read as zero. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE slot_free_devices ADD COLUMN deletion_failed_deletes integer`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE slot_free_devices DROP COLUMN deletion_failed_deletes`.execute(db);
}
