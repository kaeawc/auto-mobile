import { type Kysely, sql } from "kysely";

const COLUMNS = [
  ["has_audio_track", "integer"],
  ["warnings_json", "text"],
] as const;

/** Persists a finalized recording's audio state and stop warnings (#15858). */
export async function up<DB>(db: Kysely<DB>): Promise<void> {
  const existing = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('video_recordings')
  `.execute(db);
  const names = new Set(existing.rows.map((row) => row.name));
  for (const [name, type] of COLUMNS) {
    if (!names.has(name)) {
      await db.schema.alterTable("video_recordings").addColumn(name, type).execute();
    }
  }
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  for (const [name] of COLUMNS) {
    await db.schema.alterTable("video_recordings").dropColumn(name).execute();
  }
}
