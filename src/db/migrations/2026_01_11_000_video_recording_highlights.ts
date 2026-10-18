import type { Kysely } from "kysely";
import { sql } from "kysely";

async function columnExists<DB>(
  db: Kysely<DB>,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const result = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info(${tableName}) WHERE name = ${columnName}
  `.execute(db);
  return result.rows.length > 0;
}

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  const exists = await columnExists(db, "video_recordings", "highlights_json");
  if (!exists) {
    await db.schema.alterTable("video_recordings").addColumn("highlights_json", "text").execute();
  }
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.alterTable("video_recordings").dropColumn("highlights_json").execute();
}
