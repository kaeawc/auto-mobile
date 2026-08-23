import type { Kysely } from "kysely";

/**
 * Composite `(build_key_id, last_seen_at)` eviction index for the navigation
 * observation tables (#5309, follow-up to #4986 Phase 3 retention).
 *
 * The size-cap eviction pass in `src/db/navigationRetention.ts`
 * (`collectOldestEvictable` and the per-build-key oldest-row subqueries) walks
 * `navigation_node_observations` / `navigation_edge_observations` ordered by
 * `last_seen_at` within a `build_key_id` scope, up to the global cap of ~500k
 * rows. Every 6 hours the background pass full-scans and temp-sorts these tables.
 * The only pre-existing composite-eligible index is the single-column
 * `idx_navigation_<t>_observations_build (build_key_id)` from #4986, which seeks
 * on `build_key_id=?` but then scans every row for that key in unspecified order,
 * forcing a `USE TEMP B-TREE FOR ORDER BY` for the `last_seen_at` ordering.
 * `(build_key_id, last_seen_at)` lets the planner seek the build-key prefix and
 * read `last_seen_at` order straight from the index — an index range scan instead
 * of scan + sort. See the note at `navigationRetention.ts` `collectOldestEvictable`.
 *
 * No DESC in the index columns: the eviction scan orders `last_seen_at` ASC
 * (oldest-first), and SQLite reads a plain ascending index in order; a plain
 * composite suffices (mirrors 2026_07_02_000_event_composite_indexes.ts).
 *
 * Additive and forward-only. The standalone `idx_navigation_<t>_observations_build`
 * is now a left-prefix of this composite and functionally redundant, but it is
 * deliberately RETAINED to keep this migration purely additive (mirroring the
 * retained single-column indexes in 2026_07_02_000_event_composite_indexes.ts);
 * dropping it to cut per-insert write amplification is a separable follow-up.
 *
 * `.ifNotExists()` / `.ifExists()` so the migration survives #2785's
 * destructive-recovery replay (drop-all then replay every migration on an empty
 * DB) in unusual orders. Sorts after 2026_08_02_000_navigation_provenance.ts, so
 * both observation tables exist when it runs during a full replay.
 */
const TABLES = ["navigation_node_observations", "navigation_edge_observations"] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await db.schema
      .createIndex(`idx_${table}_build_seen`)
      .ifNotExists()
      .on(table as never)
      .columns(["build_key_id", "last_seen_at"] as never[])
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await db.schema.dropIndex(`idx_${table}_build_seen`).ifExists().execute();
  }
}
