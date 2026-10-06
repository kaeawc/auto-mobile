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
import type { EVENT_TABLES } from "./eventTables";
import {
  createAmortizedRetentionState,
  runAmortizedRetentionGate,
  type AmortizedRetentionState,
} from "./retentionGate";

// Run the cleanup body at most once per this many inserts. Worst-case overshoot
// is bounded (cap + CLEANUP_CHECK_INTERVAL rows) and negligible against a 10k
// cap. Mirrors `eventRetention.CLEANUP_CHECK_INTERVAL`.
export const CLEANUP_CHECK_INTERVAL = 256;

// Tables this module can trim by row count. All have an `id` and a `timestamp`
// column (the trim's ordering keys). Kept as an explicit union — rather than a
// broad `keyof Database` — so `.select(["id", "timestamp"])` stays type-checked
// and callers can't point the helper at a table that lacks those columns.
// `tool_calls`/`crashes`/`anrs` (#6464) join the same union: `tool_calls.timestamp`
// is an ISO string like `performance_audit_results`, while `crashes`/`anrs.timestamp`
// are numeric like `test_executions` — the mixed-type precedent already established
// by this union's first two members.
export type RowCapTable =
  | "performance_audit_results"
  | "test_executions"
  | "failure_occurrences"
  | "tool_calls"
  | "crashes"
  | "anrs";

/**
 * Tables whose `timestamp` is stamped by the DEVICE (CtrlProxy / SDK events),
 * not by the daemon, and whose `id` is an autoincrement integer. A device clock
 * can sit behind rows already stored (emulator snapshot restore, host sleep), so
 * "keep the newest N" for these means the N most recently STORED rows, i.e. by
 * `id` (#10044). The other {@link RowCapTable}s are stamped by the daemon clock
 * (`tool_calls`/`test_executions`/`performance_audit_results`/`failure_occurrences`)
 * and keep timestamp ordering; `failure_occurrences.id` is a text UUID, so it
 * could not be ordered by insertion anyway.
 */
export type InsertionOrderedTable = Extract<RowCapTable, "crashes" | "anrs">;

function isInsertionOrderedTable(table: RowCapTable): table is InsertionOrderedTable {
  return table === "crashes" || table === "anrs";
}

/** Tables {@link pruneTableByInsertionOrder} can trim: any with an autoincrement integer `id`. */
export type InsertionOrderedPruneTable = InsertionOrderedTable | (typeof EVENT_TABLES)[number];

/**
 * Trim `table` to at most `maxRows` rows, keeping the most recently INSERTED by
 * `id` (the autoincrement primary key) and returning the number of rows deleted.
 *
 * Unlike {@link pruneTableByRowCap} this never consults a `timestamp`, so rows
 * from a device whose clock is behind the stored rows are not pruned right after
 * they are stored (#10044). Same cost profile as the timestamp form: a cheap
 * `count(*)` gates the `LIMIT 1 OFFSET maxRows-1` probe, which here walks the
 * primary key rather than a timestamp index. The threshold is the `maxRows`-th
 * newest `id`; deleting `id < threshold` leaves exactly `maxRows` rows, with no
 * tie-break needed because `id` is unique.
 */
export async function pruneTableByInsertionOrder(
  db: Kysely<Database>,
  table: InsertionOrderedPruneTable,
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
    .select("id")
    .orderBy("id", "desc")
    .limit(1)
    .offset(maxRows - 1)
    .executeTakeFirst();

  if (!threshold) {
    return 0;
  }

  const deleted = await db.deleteFrom(table).where("id", "<", threshold.id).executeTakeFirst();

  return Number(deleted.numDeletedRows ?? 0);
}

/**
 * Trim `table` to at most `maxRows` rows and return the number of rows deleted.
 *
 * Device-stamped tables ({@link InsertionOrderedTable}) keep the most recently
 * inserted rows by `id` (#10044). The daemon-stamped tables keep the newest by
 * (`timestamp` desc, `id` desc).
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
  if (isInsertionOrderedTable(table)) {
    return pruneTableByInsertionOrder(db, table, maxRows);
  }

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

/** @deprecated Alias of the shared {@link AmortizedRetentionState} (#6702). */
export type RowCapRetentionState = AmortizedRetentionState;

export const createRowCapRetentionState = createAmortizedRetentionState;

/**
 * Amortize a retention cleanup body across inserts.
 *
 * Delegates the counter/guard state machine to the shared
 * {@link runAmortizedRetentionGate} (#6702) — this wrapper only fixes
 * `inserted` at `1`, since these repos insert one capped row per call, so —
 * unlike the batched event repositories — there is no per-batch insert count
 * to thread through. `runCleanup` is expected to swallow its own errors;
 * errors it does not swallow propagate to the caller.
 *
 * `checkInterval` is injectable so unit tests can trip the gate without 256
 * calls.
 */
export async function runAmortizedRetention(
  state: RowCapRetentionState,
  runCleanup: () => Promise<void>,
  checkInterval: number = CLEANUP_CHECK_INTERVAL,
): Promise<void> {
  await runAmortizedRetentionGate(state, runCleanup, checkInterval);
}
