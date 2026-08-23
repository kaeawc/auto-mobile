import type { Kysely } from "kysely";
import type { Database } from "./types";
import { getDatabase } from "./database";
import {
  pruneEventTableByCount,
  type EventRetentionState,
  type EventTableName,
} from "./eventRetention";

export type { EventRetentionState, EventTableName } from "./eventRetention";

/**
 * Resolve the Kysely handle for an event-repository call: a caller-supplied
 * handle always wins (tests inject an in-memory DB and must never resolve the
 * real file-backed database), otherwise fall back to the shared process
 * database. Extracted from the six event repositories, which each carried a
 * byte-identical copy (issue #3516).
 */
export function getDb(db?: Kysely<Database>): Kysely<Database> {
  return db ?? (getDatabase() as unknown as Kysely<Database>);
}

/** A fresh, isolated retention counter for one event repository. */
export function createEventRetentionState(): EventRetentionState {
  return { cleanupInProgress: false, insertsSinceCleanup: 0 };
}

/**
 * Parameterized retention wrapper shared by the six event repositories, whose
 * per-table `cleanupIfNeeded` copies differed only by a table-name literal
 * (issue #3516). Each repo binds its own table name + retention state and
 * delegates here. Undefined `maxRows` / `checkInterval` / `inserted` fall
 * through to `pruneEventTableByCount`'s defaults, preserving prior behavior.
 */
export async function cleanupEventTable(
  table: EventTableName,
  state: EventRetentionState,
  db?: Kysely<Database>,
  maxRows?: number,
  checkInterval?: number,
  inserted?: number,
): Promise<void> {
  await pruneEventTableByCount(db, table, state, maxRows, checkInterval, inserted);
}
