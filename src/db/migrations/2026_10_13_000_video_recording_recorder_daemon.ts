import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  const existing = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('video_recordings') WHERE name = 'recorder_daemon_session_id'
  `.execute(db);
  if (existing.rows.length === 0) {
    await db.schema
      .alterTable("video_recordings")
      .addColumn("recorder_daemon_session_id", "text")
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("video_recordings").dropColumn("recorder_daemon_session_id").execute();
}
