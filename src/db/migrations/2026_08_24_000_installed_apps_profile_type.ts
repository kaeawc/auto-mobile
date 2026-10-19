import { sql, type Kysely } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  const existingColumn = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('installed_apps') WHERE name = 'profile_type'
  `.execute(db);

  if (existingColumn.rows.length === 0) {
    await db.schema.alterTable("installed_apps").addColumn("profile_type", "text").execute();
  }
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.alterTable("installed_apps").dropColumn("profile_type").execute();
}
