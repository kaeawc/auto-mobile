import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  const existing = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('device_sessions') WHERE name = 'activity_seq'
  `.execute(db);
  if (existing.rows.length === 0) {
    await db.schema
      .alterTable("device_sessions")
      .addColumn("activity_seq", "integer", (col) => col.notNull().defaultTo(0))
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("device_sessions").dropColumn("activity_seq").execute();
}
