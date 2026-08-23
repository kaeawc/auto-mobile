import type { Kysely } from "kysely";

/**
 * `(last_seen_at, id)` eviction index for the navigation observation tables
 * (#5309, follow-up to #4986 Phase 3 retention).
 *
 * The size-cap eviction pass in `src/db/navigationRetention.ts`
 * (`collectOldestEvictable` → `buildOldestNodeEvictableQuery` /
 * `buildOldestEdgeEvictableQuery`) reads the `limit` oldest rows of
 * `navigation_node_observations` / `navigation_edge_observations`
 * `ORDER BY last_seen_at ASC, id ASC` — GLOBALLY across every build key (there is
 * no `build_key_id = ?` equality; app scope, when present, is a
 * `build_key_id IN (<app's build keys>)` filter, not an equality). Up to the
 * global cap of ~500k rows, the 6-hourly background pass full-scans and temp-sorts
 * these tables to satisfy that ordering.
 *
 * The ordering column is `last_seen_at`, so the index that removes the sort must
 * lead with `last_seen_at`. `(last_seen_at, id)` lets the planner read rows in
 * `last_seen_at ASC, id ASC` order straight from the index and stop at `limit` —
 * an index range scan instead of scan + temp B-tree sort — for all three query
 * shapes the pass issues:
 *   - global eviction (`appId === null`): covering index scan, no sort.
 *   - app-scoped eviction: index scan in `last_seen_at` order, `build_key_id IN`
 *     applied as a filter, no sort.
 *   - active-row exclusion (`protectedIds` non-empty): the outer ordering is still
 *     served by this index; the correlated `MAX(last_seen_at) WHERE build_key_id=?`
 *     subquery seeks via the retained single-column build index (below).
 *
 * A leading-`build_key_id` composite such as `(build_key_id, last_seen_at)` does
 * NOT remove the sort here: because the outer query orders by `last_seen_at`
 * across build keys (not within one), the planner would still emit
 * `USE TEMP B-TREE FOR ORDER BY`. See #5309 review; the planner test compiles the
 * real query builders and asserts the sort is gone.
 *
 * No DESC in the index columns: the eviction scan orders ASC (oldest-first), and
 * SQLite reads a plain ascending index in order; a plain composite suffices
 * (mirrors 2026_07_02_000_event_composite_indexes.ts). `id` is the tiebreaker the
 * query orders on, so including it keeps the global scan covering (no row lookup).
 *
 * Additive and forward-only. The #4986 single-column
 * `idx_navigation_<t>_observations_build (build_key_id)` is deliberately RETAINED:
 * it still seeks the correlated per-build-key `MAX(last_seen_at)` exclusion
 * subquery, and is not a prefix of this `(last_seen_at, id)` index.
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
      .createIndex(`idx_${table}_seen_id`)
      .ifNotExists()
      .on(table as never)
      .columns(["last_seen_at", "id"] as never[])
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await db.schema.dropIndex(`idx_${table}_seen_id`).ifExists().execute();
  }
}
