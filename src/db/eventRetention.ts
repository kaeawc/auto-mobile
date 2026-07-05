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

export type EventTableName = typeof EVENT_TABLES[number];

export interface EventRetentionState {
  cleanupInProgress: boolean;
  insertsSinceCleanup: number;
}

export async function pruneEventTableByCount(
  db: Kysely<Database> | undefined,
  table: EventTableName,
  state: EventRetentionState,
  maxRows: number = RETENTION_MAX_ROWS,
  checkInterval: number = CLEANUP_CHECK_INTERVAL
): Promise<void> {
  // The counter is bumped synchronously on every call, so retention still fires
  // deterministically every N inserts without putting a scan on the hot path.
  if (++state.insertsSinceCleanup < checkInterval) {
    return;
  }
  state.insertsSinceCleanup = 0;

  if (state.cleanupInProgress) {return;}
  state.cleanupInProgress = true;
  try {
    const resolvedDb = db ?? (getDatabase() as unknown as Kysely<Database>);
    const count = await resolvedDb
      .selectFrom(table)
      .select(resolvedDb.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();

    if (Number(count.count) > maxRows) {
      const cutoff = await resolvedDb
        .selectFrom(table)
        .select("timestamp")
        .orderBy("timestamp", "desc")
        .offset(maxRows)
        .limit(1)
        .executeTakeFirst();

      if (cutoff) {
        await resolvedDb
          .deleteFrom(table)
          .where("timestamp", "<", cutoff.timestamp)
          .execute();
      }
    }
  } catch (error) {
    logger.warn(`${table} retention cleanup failed: ${error}`, error);
  } finally {
    state.cleanupInProgress = false;
  }
}
