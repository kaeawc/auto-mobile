import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  const existing = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('video_recordings') WHERE name = 'capture_teardown_json'
  `.execute(db);
  if (existing.rows.length === 0) {
    await db.schema
      .alterTable("video_recordings")
      .addColumn("capture_teardown_json", "text")
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("video_recordings").dropColumn("capture_teardown_json").execute();
}
