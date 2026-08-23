import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  const existingColumn = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('device_teardown_operations')
    WHERE name = 'owner_token'
  `.execute(db);

  if (existingColumn.rows.length === 0) {
    await db.schema
      .alterTable("device_teardown_operations")
      .addColumn("owner_token", "text", (column) => column.notNull().defaultTo(sql`''`))
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("device_teardown_operations").dropColumn("owner_token").execute();
}
