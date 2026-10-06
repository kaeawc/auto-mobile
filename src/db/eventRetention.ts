import type { Kysely } from "kysely";
import type { Database } from "./types";
import type { EVENT_TABLES } from "./eventTables";
import { getDatabase } from "./database";
import { logger } from "../utils/logger";
import { pruneTableByInsertionOrder } from "./rowCapRetention";
import { runAmortizedRetentionGate, type AmortizedRetentionState } from "./retentionGate";

export const RETENTION_MAX_ROWS = 10_000;

// Amortize the retention scan (#2799): run the count(*) gate at most once per
// this many inserts instead of on every insert. Worst-case overshoot is bounded
// (cap + CLEANUP_CHECK_INTERVAL rows) and negligible against the 10k cap.
export const CLEANUP_CHECK_INTERVAL = 256;

export type EventTableName = (typeof EVENT_TABLES)[number];

/** @deprecated Alias of the shared {@link AmortizedRetentionState} (#6702). */
export type EventRetentionState = AmortizedRetentionState;

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
  // The counter/guard state machine is shared with rowCapRetention.ts (#6702);
  // this wrapper owns only the event-specific cleanup body and its
  // logging-and-swallowing error policy (CLAUDE.md convention #2).
  await runAmortizedRetentionGate(
    state,
    async () => {
      try {
        // Keep the most recently INSERTED maxRows rows, ordered by the
        // autoincrement `id` and never by the device-supplied `timestamp`
        // (#10044): a device whose clock is behind the stored rows would
        // otherwise have every event it just sent pruned. Same count(*)-gated
        // offset probe and exact-maxRows trim as the earlier timestamp form
        // (#3137), served by the primary key.
        await pruneTableByInsertionOrder(db ?? getDatabase(), table, maxRows);
      } catch (error) {
        logger.warn(`${table} retention cleanup failed: ${error}`, error);
      }
    },
    checkInterval,
    inserted,
  );
}
