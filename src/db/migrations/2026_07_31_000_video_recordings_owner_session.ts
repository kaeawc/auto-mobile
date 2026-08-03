import { sql, type Kysely } from "kysely";

/**
 * Session-scope the video recording archive (issue #4752).
 *
 * Adds a nullable `owner_session_uuid` column recording the daemon session that
 * started a recording. The column is deliberately nullable: rows that predate
 * this migration have no known owner and keep a NULL owner. The read policy
 * (see `VideoRecordingRepository`) treats a NULL-owner row as legacy/unowned and
 * readable by any session, while a row with a non-null owner is only returned to
 * that owner — so this migration hardens new recordings without orphaning the
 * existing archive.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const existingColumn = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('video_recordings')
    WHERE name = 'owner_session_uuid'
  `.execute(db);

  if (existingColumn.rows.length === 0) {
    await db.schema
      .alterTable("video_recordings")
      .addColumn("owner_session_uuid", "text")
      .execute();
  }

  await db.schema
    .createIndex("idx_video_recordings_owner_session")
    .ifNotExists()
    .on("video_recordings")
    .column("owner_session_uuid")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_video_recordings_owner_session").execute();

  await db.schema
    .alterTable("video_recordings")
    .dropColumn("owner_session_uuid")
    .execute();
}
