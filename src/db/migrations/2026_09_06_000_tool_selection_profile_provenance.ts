import { type Kysely, sql } from "kysely";

/**
 * Durable provenance for daemon-minted tool-selection profiles (issue #6225,
 * follow-up to #6148/#6213).
 *
 * `ToolSelectionProfileRegistry` (`src/server/toolSelectionProfileRegistry.ts`)
 * is the sole signal `setToolEnabled` trusts to tell "a crypto-random profile
 * uuid this daemon process itself minted via
 * `createAndBindToolSelectionProfile`" apart from a fabricated or
 * merely-echoed-header value. Before this migration that signal lived only in
 * an in-memory `Set`, so a daemon restart/upgrade lost every minted profile: a
 * client reaffirming its still-valid profile failed the provenance check and
 * had to re-mint. This table lets the registry reload its membership at
 * startup so a legitimately-minted profile survives a restart, while a value
 * that was never minted is still rejected (it was never written here either).
 *
 * `profile_uuid` alone is the primary key: the table is a pure membership set,
 * no other field is ever read back to decide provenance (parity with the
 * in-memory `Set<string>` it backs). `created_at` is kept for observability
 * only (e.g. a future eviction pass), matching the unpruned-growth tradeoff
 * already accepted for `session_tool_overrides` (one entry per anonymous
 * `setToolEnabled` call across the daemon's life).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("tool_selection_profile_provenance")
    .ifNotExists()
    .addColumn("profile_uuid", "text", (col) => col.primaryKey())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("tool_selection_profile_provenance").ifExists().execute();
}
