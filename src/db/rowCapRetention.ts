// Amortized row-cap retention (#3435/#3436/#3440).
//
// The event tables share `pruneEventTableByCount` (see `eventRetention.ts`),
// but the audit / failure-analytics / test-execution repositories each have a
// bespoke cleanup body (orphan-group sweep, age-based delete) that does not fit
// that generic helper. What they DO share is two concerns this module owns:
//   1. an offset-probe cleanup must not run on every insert, and
//   2. the "keep the newest N rows" trim itself.
// Historically each repo ran an unconditional `LIMIT 1 OFFSET 9999` index walk
// on the hot write path — the exact offset-probe pattern known to be ~57x
// slower than a `count(*)` gate (#2799). `runAmortizedRetention` amortizes the
// cleanup so the scan fires at most once per `checkInterval` inserts, and
// `pruneTableByRowCap` centralizes the trim (including the #3137 id-tiebreak
// invariant) so it is not hand-copied per repo.

import type { Kysely } from "kysely";
import type { Database } from "./types";

// Run the cleanup body at most once per this many inserts. Worst-case overshoot
// is bounded (cap + CLEANUP_CHECK_INTERVAL rows) and negligible against a 10k
// cap. Mirrors `eventRetention.CLEANUP_CHECK_INTERVAL`.
export const CLEANUP_CHECK_INTERVAL = 256;

// Tables this module can trim by row count. All have an `id` and a `timestamp`
// column (the trim's ordering keys). Kept as an explicit union — rather than a
// broad `keyof Database` — so `.select(["id", "timestamp"])` stays type-checked
// and callers can't point the helper at a table that lacks those columns.
export type RowCapTable = "performance_audit_results" | "test_executions" | "failure_occurrences";

/**
 * Trim `table` to at most `maxRows` rows, keeping the newest by
 * (`timestamp` desc, `id` desc) and returning the number of rows deleted.
 *
 * A cheap `count(*)` gates the expensive `LIMIT 1 OFFSET maxRows-1` threshold
 * probe, so the index walk only runs when actually over cap. The delete breaks
 * cutoff-timestamp ties on the monotonic `id` (#3137), trimming to *exactly*
 * `maxRows` rows and deterministically pruning same-timestamp rows — a burst of
 * same-instant rows at the cutoff can never retain more than `maxRows`.
 */
export async function pruneTableByRowCap(
  db: Kysely<Database>,
  table: RowCapTable,
  maxRows: number,
): Promise<number> {
  const count = await db
    .selectFrom(table)
    .select(db.fn.countAll().as("count"))
    .executeTakeFirstOrThrow();

  if (Number(count.count) <= maxRows) {
    return 0;
  }

  const threshold = await db
    .selectFrom(table)
    .select(["id", "timestamp"])
    .orderBy("timestamp", "desc")
    .orderBy("id", "desc")
    .limit(1)
    .offset(maxRows - 1)
    .executeTakeFirst();

  if (!threshold) {
    return 0;
  }

  const deleted = await db
    .deleteFrom(table)
    .where((eb) =>
      eb.or([
        eb("timestamp", "<", threshold.timestamp),
        eb.and([eb("timestamp", "=", threshold.timestamp), eb("id", "<", threshold.id)]),
      ]),
    )
    .executeTakeFirst();

  return Number(deleted.numDeletedRows ?? 0);
}

export interface RowCapRetentionState {
  cleanupInProgress: boolean;
  insertsSinceCleanup: number;
}

export function createRowCapRetentionState(): RowCapRetentionState {
  return { cleanupInProgress: false, insertsSinceCleanup: 0 };
}

/**
 * Amortize a retention cleanup body across inserts.
 *
 * The counter is bumped synchronously on every call so cleanup still fires
 * deterministically every `checkInterval` inserts without putting the scan on
 * the hot path. When the gate trips, `runCleanup` runs behind an in-progress
 * guard that drops overlapping calls (the next insert will re-arm the gate).
 * `runCleanup` is expected to swallow its own errors; this wrapper only manages
 * the amortization counter and the guard.
 *
 * `checkInterval` is injectable so unit tests can trip the gate without 256
 * calls. (These repos insert one capped row per call, so — unlike the batched
 * event repositories — there is no per-batch insert count to thread through.)
 */
export async function runAmortizedRetention(
  state: RowCapRetentionState,
  runCleanup: () => Promise<void>,
  checkInterval: number = CLEANUP_CHECK_INTERVAL,
): Promise<void> {
  state.insertsSinceCleanup += 1;
  if (state.insertsSinceCleanup < checkInterval) {
    return;
  }
  state.insertsSinceCleanup = 0;

  if (state.cleanupInProgress) {
    return;
  }
  state.cleanupInProgress = true;
  try {
    await runCleanup();
  } finally {
    state.cleanupInProgress = false;
  }
}
