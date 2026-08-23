import { Kysely, sql } from "kysely";

/**
 * #2789 — make `failure_groups.signature` uniquely indexed and back-fill any
 * duplicate-signature rows that the original non-unique index allowed to
 * accumulate (the racy get-or-create in `recordFailure` could INSERT two groups
 * for one signature).
 *
 * ORDERING IS LOAD-BEARING. The migration connection runs with
 * `PRAGMA foreign_keys = ON` (`configureSqliteDatabase`, src/db/database.ts) and
 * these SQLite migrations are NOT wrapped in a DDL transaction by the migrator
 * (`SqliteAdapter.supportsTransactionalDdl === false`). `failure_occurrences`
 * and `failure_notifications` carry a CASCADE FK on `failure_occurrences.id` /
 * a plain `group_id`. So we MUST repoint children onto the keeper BEFORE
 * deleting loser groups — delete-first would CASCADE-wipe the occurrences we
 * mean to keep. We wrap the whole de-dup + index swap in ONE transaction so a
 * mid-way `CREATE UNIQUE INDEX` failure cannot leave losers already deleted.
 *
 * Keeper selection is a total order — `ORDER BY first_occurrence ASC, id ASC` —
 * so a same-millisecond burst (two groups tied on `first_occurrence`, the exact
 * scenario this bug produces) still collapses deterministically to one row and
 * `CREATE UNIQUE INDEX` cannot throw on a residual duplicate.
 *
 * Idempotent / safe on an empty DB so it survives #2785's destructive-recovery
 * replay (`resetDatabaseState` drops every table and re-runs all migrations):
 * with no duplicates the de-dup statements are no-ops and the index create uses
 * `IF NOT EXISTS`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // 1. Repoint occurrences from loser groups onto their signature's keeper —
    //    BEFORE any delete, so CASCADE cannot wipe them. A "loser" is any group
    //    that is not the keeper (earliest first_occurrence, min id tiebreak)
    //    for its signature.
    await sql`
      UPDATE failure_occurrences
      SET group_id = (
        SELECT k.id FROM failure_groups k
        WHERE k.signature = (
          SELECT g.signature FROM failure_groups g WHERE g.id = failure_occurrences.group_id
        )
        ORDER BY k.first_occurrence ASC, k.id ASC
        LIMIT 1
      )
      WHERE group_id IN (
        SELECT g.id FROM failure_groups g
        WHERE g.id <> (
          SELECT k.id FROM failure_groups k
          WHERE k.signature = g.signature
          ORDER BY k.first_occurrence ASC, k.id ASC
          LIMIT 1
        )
      )
    `.execute(trx);

    // 2. Repoint notifications the same way. `failure_notifications.group_id` is
    //    NOT a foreign key, so nothing cascades and nothing stops us — forget
    //    this and notifications silently strand on a deleted group id.
    await sql`
      UPDATE failure_notifications
      SET group_id = (
        SELECT k.id FROM failure_groups k
        WHERE k.signature = (
          SELECT g.signature FROM failure_groups g WHERE g.id = failure_notifications.group_id
        )
        ORDER BY k.first_occurrence ASC, k.id ASC
        LIMIT 1
      )
      WHERE group_id IN (
        SELECT g.id FROM failure_groups g
        WHERE g.id <> (
          SELECT k.id FROM failure_groups k
          WHERE k.signature = g.signature
          ORDER BY k.first_occurrence ASC, k.id ASC
          LIMIT 1
        )
      )
    `.execute(trx);

    // 3. Back-fill the keeper's aggregates (only for signatures that actually
    //    had duplicates). total_count is the SUM of the historical counts so we
    //    do not lose increments that predate retention pruning; last_occurrence
    //    is the MAX so a collapsed group is not sorted stale on the dashboard
    //    (getFailureGroups orders by last_occurrence); unique_sessions is
    //    DERIVED from the now-repointed occurrences via COUNT(DISTINCT), the
    //    same definition recordFailure uses post-fix (summing would double-count
    //    a session present in two duplicate groups).
    //
    //    Note: single-group signatures whose stored counts drifted from the
    //    lost-increment path (issue scenario #2, which does NOT create a second
    //    row) are intentionally left untouched. total_count deliberately
    //    preserves increments that predate retention pruning, so a blanket
    //    recompute of COUNT(*) from surviving occurrences would DESTROY
    //    legitimately-retained historical counts — the two cases are
    //    indistinguishable after the fact, so we heal only where a duplicate row
    //    already forces a merge.
    await sql`
      UPDATE failure_groups
      SET
        total_count = (
          SELECT COALESCE(SUM(g2.total_count), 0)
          FROM failure_groups g2
          WHERE g2.signature = failure_groups.signature
        ),
        last_occurrence = (
          SELECT MAX(g2.last_occurrence)
          FROM failure_groups g2
          WHERE g2.signature = failure_groups.signature
        ),
        unique_sessions = (
          SELECT COUNT(DISTINCT o.session_id)
          FROM failure_occurrences o
          WHERE o.group_id = failure_groups.id
        )
      WHERE
        (SELECT COUNT(*) FROM failure_groups d WHERE d.signature = failure_groups.signature) > 1
        AND id = (
          SELECT k.id FROM failure_groups k
          WHERE k.signature = failure_groups.signature
          ORDER BY k.first_occurrence ASC, k.id ASC
          LIMIT 1
        )
    `.execute(trx);

    // 4. Delete the losers. Children were repointed in steps 1-2, so CASCADE has
    //    nothing left to take.
    await sql`
      DELETE FROM failure_groups
      WHERE id <> (
        SELECT k.id FROM failure_groups k
        WHERE k.signature = failure_groups.signature
        ORDER BY k.first_occurrence ASC, k.id ASC
        LIMIT 1
      )
    `.execute(trx);

    // 5. Swap the plain signature index for a UNIQUE one, and add a composite
    //    index so the post-fix `COUNT(DISTINCT session_id)` recompute per event
    //    does not scan every occurrence in the group.
    await sql`DROP INDEX IF EXISTS idx_failure_groups_signature`.execute(trx);
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_failure_groups_signature
      ON failure_groups (signature)
    `.execute(trx);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_failure_occurrences_group_session
      ON failure_occurrences (group_id, session_id)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`DROP INDEX IF EXISTS idx_failure_occurrences_group_session`.execute(trx);
    await sql`DROP INDEX IF EXISTS idx_failure_groups_signature`.execute(trx);
    // Restore the original non-unique index.
    await sql`
      CREATE INDEX IF NOT EXISTS idx_failure_groups_signature
      ON failure_groups (signature)
    `.execute(trx);
  });
}
