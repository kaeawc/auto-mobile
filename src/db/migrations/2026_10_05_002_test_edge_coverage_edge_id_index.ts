import type { Kysely } from "kysely";

/**
 * Index test edge coverage by edge_id for navigation retention probes and edge
 * foreign-key cascades. The existing unique index starts with session_id, so it
 * cannot efficiently serve lookups by edge_id alone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("idx_test_edge_coverage_edge")
    .ifNotExists()
    .on("test_edge_coverage")
    .column("edge_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_test_edge_coverage_edge").ifExists().execute();
}
