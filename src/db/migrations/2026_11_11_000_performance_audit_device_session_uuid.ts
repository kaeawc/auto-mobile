import { type Kysely, sql } from "kysely";

/**
 * The device epoch (`deviceSessionUuid`) an audit ran against (#17030), so audit
 * history can be scoped to one boot of a reused serial. Nullable: rows recorded
 * before this column, or with no live epoch, carry none.
 */
export async function up<DB>(db: Kysely<DB>): Promise<void> {
  const existing = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('performance_audit_results')
  `.execute(db);
  if (!existing.rows.some((row) => row.name === "device_session_uuid")) {
    await db.schema
      .alterTable("performance_audit_results")
      .addColumn("device_session_uuid", "text")
      .execute();
  }
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema
    .alterTable("performance_audit_results")
    .dropColumn("device_session_uuid")
    .execute();
}
