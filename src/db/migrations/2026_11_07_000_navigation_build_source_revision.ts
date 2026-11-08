import { type Kysely, sql } from "kysely";

const COLUMNS = ["git_branch", "git_sha"] as const;

/**
 * App-declared git branch/sha per build key (#16954). Nullable display metadata:
 * the unique (app_id, version_code, content_hash) identity is unchanged.
 */
export async function up<DB>(db: Kysely<DB>): Promise<void> {
  const existing = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('navigation_build_keys')
  `.execute(db);
  const names = new Set(existing.rows.map((row) => row.name));
  for (const name of COLUMNS) {
    if (!names.has(name)) {
      await db.schema.alterTable("navigation_build_keys").addColumn(name, "text").execute();
    }
  }
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  for (const name of COLUMNS) {
    await db.schema.alterTable("navigation_build_keys").dropColumn(name).execute();
  }
}
