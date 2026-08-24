import type { Kysely } from "kysely";
import type { Database } from "./types";
import type { EVENT_TABLES } from "./eventTables";
import { getDatabase } from "./database";
import { logger } from "../utils/logger";

export const RETENTION_MAX_ROWS = 10_000;

// Amortize the retention scan (#2799): run the count(*) gate at most once per
// this many inserts instead of on every insert. Worst-case overshoot is bounded
// (cap + CLEANUP_CHECK_INTERVAL rows) and negligible against the 10k cap.
export const CLEANUP_CHECK_INTERVAL = 256;

export type EventTableName = (typeof EVENT_TABLES)[number];

export interface EventRetentionState {
  cleanupInProgress: boolean;
  insertsSinceCleanup: number;
}

export async function pruneEventTableByCount(
  db: Kysely<Database> | undefined,
  table: EventTableName,
  state: EventRetentionState,
  maxRows: number = RETENTION_MAX_ROWS,
  checkInterval: number = CLEANUP_CHECK_INTERVAL,
  // Number of rows just inserted. A batched multi-row INSERT (#3138) advances
  // the amortization counter by the whole batch so retention still fires roughly
  // every `checkInterval` rows rather than every `checkInterval` batches.
  inserted: number = 1,
): Promise<void> {
  // The counter is bumped synchronously on every call, so retention still fires
  // deterministically every N inserts without putting a scan on the hot path.
  state.insertsSinceCleanup += inserted;
  if (state.insertsSinceCleanup < checkInterval) {
    return;
  }
  state.insertsSinceCleanup = 0;

  if (state.cleanupInProgress) {
    return;
  }
  state.cleanupInProgress = true;
  try {
    const resolvedDb = db ?? (getDatabase() as unknown as Kysely<Database>);
    const count = await resolvedDb
      .selectFrom(table)
      .select(resolvedDb.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();

    if (Number(count.count) > maxRows) {
      // Canonical retention idiom (#3137): pick the Nth-newest row as the
      // threshold (offset maxRows - 1) and delete everything strictly older,
      // breaking cutoff-timestamp ties on the monotonic `id`. This trims to
      // *exactly* maxRows rows and deterministically prunes same-timestamp rows,
      // unlike the prior `offset(maxRows)` + `timestamp < cutoff` form, which
      // retained maxRows + 1 rows and could never remove rows equal to the
      // cutoff timestamp (a burst of same-millisecond events at the cutoff could
      // retain more than maxRows).
      const threshold = await resolvedDb
        .selectFrom(table)
        .select(["id", "timestamp"])
        .orderBy("timestamp", "desc")
        .orderBy("id", "desc")
        .limit(1)
        .offset(maxRows - 1)
        .executeTakeFirst();

      if (threshold) {
        await resolvedDb
          .deleteFrom(table)
          .where((eb) =>
            eb.or([
              eb("timestamp", "<", threshold.timestamp),
              eb.and([eb("timestamp", "=", threshold.timestamp), eb("id", "<", threshold.id)]),
            ]),
          )
          .execute();
      }
    }
  } catch (error) {
    logger.warn(`${table} retention cleanup failed: ${error}`, error);
  } finally {
    state.cleanupInProgress = false;
  }
}
