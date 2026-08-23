import { type Kysely, sql } from "kysely";

/**
 * Existing `provisionDevice` overrides predate the destructive `deleteDevice`
 * tool. Preserve those profiles without granting a new destructive capability;
 * callers must explicitly enable deleteDevice after this migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    insert into session_tool_overrides (
      session_uuid,
      tool_name,
      enabled,
      updated_at
    )
    select session_uuid, 'deleteDevice', 0, updated_at
    from session_tool_overrides
    where tool_name = 'provisionDevice'
    on conflict(session_uuid, tool_name) do nothing
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Preserve explicit post-migration choices; the created disabled row is safe to retain.
  void db;
}
