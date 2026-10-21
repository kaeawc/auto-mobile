import type { Kysely } from "kysely";

/**
 * When a request receipt became terminal, so retention can prune it after its replay window.
 * Legacy terminal receipts stay null until the first retention pass stamps them, which gives each
 * one a full window from the upgrade rather than pruning it immediately.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("session_broker_requests")
    .addColumn("terminal_at_ms", "integer")
    .execute();
  await db.schema
    .createIndex("session_broker_requests_state_idx")
    .on("session_broker_requests")
    .column("state")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("session_broker_requests_state_idx").execute();
  await db.schema.alterTable("session_broker_requests").dropColumn("terminal_at_ms").execute();
}
