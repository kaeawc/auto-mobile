import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const column of ["recorded_panel_json", "display_transitions_json"] as const) {
    const existing = await sql<{ name: string }>`
      SELECT name FROM pragma_table_info('video_recordings') WHERE name = ${column}
    `.execute(db);
    if (existing.rows.length === 0) {
      await db.schema.alterTable("video_recordings").addColumn(column, "text").execute();
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("video_recordings").dropColumn("display_transitions_json").execute();
  await db.schema.alterTable("video_recordings").dropColumn("recorded_panel_json").execute();
}
