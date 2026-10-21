import { sql, type Kysely } from "kysely";

/** Legacy receipts keep their conservative nonretryable interpretation when this is null. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("session_broker_requests")
    .addColumn("retryable", "integer", (column) => column.check(sql`retryable IN (0, 1)`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("session_broker_requests").dropColumn("retryable").execute();
}
